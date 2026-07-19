#!/usr/bin/env node
'use strict';

/**
 * Event-driven, paper-only structural payoff scanner.
 *
 * The process has no wallet imports, signer, CLOB client, or order method. It
 * records economically positive identities and separately grades atomicity,
 * stale legs, 2x costs, per-leg FOK depth, capacity, and orphan-leg risk.
 */

const os = require('node:os');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const ClobMultiplex = require('../recon/clob-multiplex');
const RawWal = require('../recon/wal');
const { pool, migrateStructural, insertRows, logEvent } = require('../recon/db');
const {
  buildConditionGraph, evaluateCandidate, STRUCTURAL_UNIVERSE_VERSION,
} = require('./condition-graph');

const GAMMA = 'https://gamma-api.polymarket.com';
const MAX_CANDIDATES = Math.max(4, Number(process.env.STRUCTURAL_MAX_CANDIDATES || 24));
const MAX_TOKENS = Math.max(8, Number(process.env.STRUCTURAL_MAX_TOKENS || 96));
const MAX_CATALOG_CANDIDATES = Math.max(MAX_CANDIDATES,
  Number(process.env.STRUCTURAL_MAX_CATALOG_CANDIDATES || 20_000));
const REFRESH_MS = Math.max(60_000, Number(process.env.STRUCTURAL_REFRESH_MS || 300_000));
const TARGET_NOTIONAL_USD = Math.max(1, Number(process.env.STRUCTURAL_TARGET_NOTIONAL_USD || 10));
const MIN_CAPACITY_PROFIT_USD = Math.max(0, Number(process.env.STRUCTURAL_MIN_CAPACITY_PROFIT_USD || 0.05));
const STALE_MS = Math.max(250, Number(process.env.STRUCTURAL_STALE_MS || 2000));
const NEGATIVE_SAMPLE_MS = Math.max(1000, Number(process.env.STRUCTURAL_NEGATIVE_SAMPLE_MS || 5000));
const POSITIVE_SAMPLE_MS = Math.max(25, Number(process.env.STRUCTURAL_POSITIVE_SAMPLE_MS || 100));
const EVENT_PAGES = Math.max(1, Math.min(20, Number(process.env.STRUCTURAL_EVENT_PAGES || 20)));
const SPORTS_EVENT_PAGES = Math.max(1, Math.min(10,
  Number(process.env.STRUCTURAL_SPORTS_EVENT_PAGES || 5)));
const LATENCY_PROFILES_MS = String(process.env.STRUCTURAL_LATENCY_PROFILES_MS || '20,50,100,250,500')
  .split(',').map(Number).filter((value) => Number.isInteger(value) && value >= 0 && value <= 5000);

async function fetchEventPage(params) {
  const url = new URL(`${GAMMA}/events`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Gamma HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timeout); }
}

async function fetchEvents() {
  const now = Date.now();
  const common = {
    active: 'true', closed: 'false', limit: '100',
    end_date_min: new Date(now - 3600_000).toISOString(),
    end_date_max: new Date(now + 365 * 86_400_000).toISOString(),
  };
  const requests = [];
  for (let page = 0; page < EVENT_PAGES; page += 1) {
    const offset = String(page * 100);
    requests.push(fetchEventPage({ ...common, offset, order: 'endDate', ascending: 'true' }));
    requests.push(fetchEventPage({
      active: 'true', closed: 'false', limit: '100', offset,
      order: 'volume24hr', ascending: 'false',
    }));
  }
  // Explicit sports universe: broad ranking alone can crowd short-lived game
  // ladders out with political/crypto volume. Tag 1 is Polymarket's Sports
  // taxonomy. End-time and volume panels are both frozen infrastructure views.
  for (let page = 0; page < SPORTS_EVENT_PAGES; page += 1) {
    const offset = String(page * 100);
    requests.push(fetchEventPage({ ...common, tag_id: '1', offset, order: 'endDate', ascending: 'true' }));
    requests.push(fetchEventPage({
      active: 'true', closed: 'false', tag_id: '1', limit: '100', offset,
      order: 'volume24hr', ascending: 'false',
    }));
  }
  const pages = await Promise.all(requests);
  return [...new Map(pages.flat().map((event) => [String(event.id || event.slug), event])).values()];
}

function candidatePriority(candidate) {
  const structural = candidate.structureType === 'binary_complement' ? 1 : 0;
  const end = Number.isFinite(Date.parse(candidate.endDate)) ? Date.parse(candidate.endDate) : Number.MAX_SAFE_INTEGER;
  return [structural, end, candidate.legs.length];
}

function boundedPanel(candidates) {
  const sorted = [...candidates].sort((left, right) => {
    const a = candidatePriority(left); const b = candidatePriority(right);
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || left.candidateId.localeCompare(right.candidateId);
  });
  // Round-robin structure families so a near-dated threshold ladder cannot
  // crowd complete event sets or complement controls out of a bounded socket
  // budget. Selection is deterministic and independent of observed PnL.
  const typeOrder = [
    'complete_mutually_exclusive_set', 'sports_total_ladder', 'sports_spread_ladder',
    'nested_threshold', 'disjoint_ranges', 'binary_complement',
  ];
  const groups = new Map(typeOrder.map((type) => [type, sorted.filter((candidate) =>
    candidate.structureType === type && candidate.ruleCertification?.valid === true)]));
  const selected = [];
  const tokens = new Set();
  let advanced = true;
  while (selected.length < MAX_CANDIDATES && advanced) {
    advanced = false;
    for (const type of typeOrder) {
      const group = groups.get(type);
      while (group.length) {
        const candidate = group.shift();
        const next = candidate.legs.map((entry) => entry.tokenId).filter((token) => !tokens.has(token));
        if (tokens.size + next.length > MAX_TOKENS) continue;
        selected.push(candidate);
        next.forEach((token) => tokens.add(token));
        advanced = true;
        break;
      }
      if (selected.length >= MAX_CANDIDATES) break;
    }
  }
  return selected;
}

function boundedCatalog(graph, panel) {
  const active = new Set(panel.map((candidate) => candidate.candidateId));
  const ordered = [...graph].sort((left, right) => {
    const leftActive = active.has(left.candidateId) ? 0 : 1;
    const rightActive = active.has(right.candidateId) ? 0 : 1;
    const leftControl = left.structureType === 'binary_complement' ? 1 : 0;
    const rightControl = right.structureType === 'binary_complement' ? 1 : 0;
    const a = candidatePriority(left); const b = candidatePriority(right);
    return leftActive - rightActive || leftControl - rightControl
      || a[1] - b[1] || a[2] - b[2] || left.candidateId.localeCompare(right.candidateId);
  });
  return ordered.slice(0, MAX_CATALOG_CANDIDATES);
}

const CANDIDATE_COLUMNS = [
  'candidate_id', 'structure_type', 'event_id', 'event_slug', 'event_title',
  'end_date', 'complete', 'atomic', 'guaranteed_min_payout', 'states',
  'payoff_vector', 'payoff_proof', 'rule_certification_hash', 'rule_certified',
  'legs', 'universe_id', 'universe_class',
  'active', 'refreshed_at',
];

async function persistCandidates(catalog, panel) {
  const ruleDocuments = [...new Map(catalog.flatMap((candidate) => candidate.ruleDocuments || [])
    .map((item) => [item.ruleHash, item])).values()];
  await insertRows('borg_structural_rule_snapshots', [
    'rule_hash', 'event_id', 'gamma_id', 'condition_id', 'rule_document',
  ], ruleDocuments.map((item) => [
    item.ruleHash, item.eventId, item.gammaId, item.conditionId,
    JSON.stringify(item.document),
  ]), 'ON CONFLICT (rule_hash) DO NOTHING');
  await pool.query('UPDATE borg_structural_candidates SET active=false WHERE active=true');
  const active = new Set(panel.map((candidate) => candidate.candidateId));
  const now = new Date();
  const rows = catalog.map((candidate) => [
      candidate.candidateId, candidate.structureType, candidate.eventId,
      candidate.eventSlug, candidate.eventTitle, candidate.endDate,
      candidate.complete, candidate.atomic, candidate.guaranteedMinPayout,
      JSON.stringify(candidate.states), JSON.stringify(candidate.payoffVector),
      JSON.stringify(candidate.payoffProof),
      candidate.ruleCertification?.certificationHash || null,
      candidate.ruleCertification?.valid === true,
      JSON.stringify(candidate.legs),
      candidate.universeId, candidate.universeClass,
      active.has(candidate.candidateId), now,
  ]);
  await insertRows('borg_structural_candidates', CANDIDATE_COLUMNS, rows,
    `ON CONFLICT (candidate_id) DO UPDATE SET
      event_title=EXCLUDED.event_title,end_date=EXCLUDED.end_date,
      complete=EXCLUDED.complete,atomic=EXCLUDED.atomic,
      guaranteed_min_payout=EXCLUDED.guaranteed_min_payout,
      states=EXCLUDED.states,payoff_vector=EXCLUDED.payoff_vector,
      payoff_proof=EXCLUDED.payoff_proof,
      rule_certification_hash=EXCLUDED.rule_certification_hash,
      rule_certified=EXCLUDED.rule_certified,legs=EXCLUDED.legs,
      universe_id=EXCLUDED.universe_id,universe_class=EXCLUDED.universe_class,
      active=EXCLUDED.active,refreshed_at=EXCLUDED.refreshed_at`);
}

async function main() {
  await migrateStructural();
  const wal = new RawWal('structural-scanner', {
    root: process.env.BORG_WAL_DIR,
    mirrorRoot: process.env.BORG_WAL_MIRROR_DIR || null,
    minFreeGb: Number(process.env.BORG_WAL_MIN_FREE_GB || 20),
  });
  let candidates = new Map();
  let catalogSize = 0;
  let byToken = new Map();
  let tokenMarket = new Map();
  const buffer = [];
  const lastStored = new Map();

  const clob = new ClobMultiplex((token) => tokenMarket.get(String(token)) || null, {
    shardCount: Number(process.env.STRUCTURAL_CLOB_SHARDS || 2),
    wal,
    onMarketEvent: (event) => {
      const linked = byToken.get(String(event.assetId)) || [];
      for (const candidate of linked) {
        for (const latencyMs of LATENCY_PROFILES_MS) {
          setTimeout(() => {
            const evaluatedAt = Date.now();
            const evaluation = evaluateCandidate(candidate, {
              get: (token) => clob.getBook(token),
            }, evaluatedAt, {
              staleMs: STALE_MS,
              targetNotionalUsd: TARGET_NOTIONAL_USD,
              minCapacityProfitUsd: MIN_CAPACITY_PROFIT_USD,
            });
            let reactionUs = null;
            try { reactionUs = Number(process.hrtime.bigint() - BigInt(event.receiveMonoNs)) / 1000; } catch (_) {}
            const durable = {
              type: 'structural_evaluation', ...evaluation,
              dedupKey: [candidate.candidateId, event.assetId, latencyMs,
                event.connectionEpoch || 0, event.eventSequence || event.receiveWallMs || evaluatedAt].join(':'),
              triggerToken: event.assetId,
              triggerSourceMs: event.sourceMs || null,
              triggerReceivedAt: event.receiveWallMs || evaluatedAt,
              triggerWalEventId: event.walEventId || null,
              latencyMs, reactionUs,
            };
            const storageKey = `${candidate.candidateId}:${latencyMs}`;
            const previous = lastStored.get(storageKey);
            const signature = [evaluation.passStale, evaluation.passQuotes, evaluation.passFees2x,
              evaluation.passFok, evaluation.passCapacity, evaluation.passOrphanRisk].join('|');
            const minimumInterval = evaluation.economicCandidate ? POSITIVE_SAMPLE_MS : NEGATIVE_SAMPLE_MS;
            const shouldStore = !previous || previous.signature !== signature
              || evaluatedAt - previous.at >= minimumInterval;
            if (!shouldStore) return;
            lastStored.set(storageKey, { signature, at: evaluatedAt });
            wal.append(JSON.stringify(durable), {
              channel: 'structural-decision', sourceMs: event.sourceMs,
              connectionEpoch: event.connectionEpoch, connectionShard: event.connectionShard,
            });
            buffer.push(durable);
            if (buffer.length > 20_000) buffer.shift();
          }, latencyMs).unref?.();
        }
      }
    },
  });

  const refresh = async () => {
    const graph = buildConditionGraph(await fetchEvents());
    const panel = boundedPanel(graph);
    const catalog = boundedCatalog(graph, panel);
    await persistCandidates(catalog, panel);
    catalogSize = catalog.length;
    candidates = new Map(panel.map((candidate) => [candidate.candidateId, candidate]));
    byToken = new Map(); tokenMarket = new Map();
    for (const candidate of panel) {
      for (const entry of candidate.legs) {
        const list = byToken.get(entry.tokenId) || [];
        list.push(candidate); byToken.set(entry.tokenId, list);
        const parsedId = Number(entry.gammaId);
        tokenMarket.set(entry.tokenId, Number.isSafeInteger(parsedId) ? parsedId : null);
      }
    }
    clob.subscribe([...byToken.keys()]);
    await logEvent('INFO', 'structural_scanner',
      `condition graph refreshed: ${graph.length} identities, ${candidates.size} subscribed, ${byToken.size} tokens`, {
        graph: graph.length, catalog: catalog.length, panel: candidates.size, tokens: byToken.size,
        maxCandidates: MAX_CANDIDATES, maxTokens: MAX_TOKENS,
        maxCatalogCandidates: MAX_CATALOG_CANDIDATES,
        sportsEventPages: SPORTS_EVENT_PAGES,
        panelByType: Object.fromEntries([...candidates.values()].reduce((map, candidate) => {
          map.set(candidate.structureType, (map.get(candidate.structureType) || 0) + 1); return map;
        }, new Map())),
        uncertifiedCatalog: catalog.filter((candidate) => !candidate.ruleCertification?.valid).length,
      });
  };

  const flush = async () => {
    if (!buffer.length) return;
    const rows = buffer.splice(0, 2000);
    try {
      for (const item of rows) {
        await pool.query(`
          INSERT INTO borg_structural_evaluations (
            dedup_key, evaluated_at, candidate_id, trigger_token, trigger_source_ts,
            trigger_received_at, trigger_wal_event_id, latency_ms, reaction_us,
            structure_type, guaranteed_min_payout, cost_per_bundle, fees_2x_per_bundle,
            residual_2x_per_bundle, target_notional_usd, target_shares,
            displayed_bundle_shares, displayed_notional_usd, displayed_profit_2x_usd,
            pass_proof, payoff_proof_hash, pass_rule_certification, rule_certification_hash,
            pass_stale, pass_quotes, pass_fees_2x, pass_fok, pass_capacity,
            pass_orphan_risk, orphan_loss_stress_usd, economic_candidate, qualified, detail)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33::jsonb)
          ON CONFLICT (dedup_key) DO NOTHING
        `, [
          item.dedupKey, item.evaluatedAt, item.candidateId, item.triggerToken,
          item.triggerSourceMs == null ? null : new Date(item.triggerSourceMs),
          new Date(item.triggerReceivedAt), item.triggerWalEventId, item.latencyMs, item.reactionUs,
          item.structureType, item.guaranteedMinPayout, item.costPerBundle,
          item.fees2xPerBundle, item.residual2xPerBundle, item.targetNotionalUsd,
          item.targetShares, item.displayedBundleShares, item.displayedNotionalUsd,
          item.displayedProfit2xUsd, item.passProof, item.payoffProofHash,
          item.passRuleCertification, item.ruleCertificationHash,
          item.passStale, item.passQuotes, item.passFees2x,
          item.passFok, item.passCapacity, item.passOrphanRisk, item.orphanLossStressUsd,
          item.economicCandidate, item.qualified, JSON.stringify(item),
        ]);
      }
    } catch (error) {
      buffer.unshift(...rows);
      await logEvent('ERROR', 'structural_scanner', `async persistence failed; WAL retained: ${error.message}`);
    }
  };

  await refresh();
  await clob.connect();
  const timers = [
    setInterval(() => refresh().catch((error) => logEvent('ERROR', 'structural_scanner', error.message)), REFRESH_MS),
    setInterval(() => flush().catch(() => {}), 1000),
    setInterval(() => clob.flushEvents().catch(() => {}), 5000),
    setInterval(() => clob.checkStale(), 30_000),
    setInterval(() => pool.query(`
      INSERT INTO system_heartbeats (component, beat_at, meta)
      VALUES ('structural_scanner',now(),$1::jsonb)
      ON CONFLICT (component) DO UPDATE SET beat_at=now(), meta=EXCLUDED.meta
    `, [JSON.stringify({ pid: process.pid, host: os.hostname(), candidates: candidates.size,
      catalogCandidates: catalogSize, tokens: byToken.size, queued: buffer.length,
      paperOnly: true, walletLoaded: false, allMarket: true, sportsTagId: 1,
      sportsEventPages: SPORTS_EVENT_PAGES, universeVersion: STRUCTURAL_UNIVERSE_VERSION,
      latencyProfilesMs: LATENCY_PROFILES_MS })]).catch(() => {}), 10_000),
  ];

  const shutdown = async (signal) => {
    timers.forEach(clearInterval);
    await flush().catch(() => {});
    clob.close();
    await wal.close().catch(() => {});
    await pool.end().catch(() => {});
    console.log(`[structural_scanner] stopped by ${signal}`);
    process.exit(0);
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) main().catch(async (error) => {
  console.error(error.stack || error.message);
  await pool.end().catch(() => {});
  process.exit(1);
});

module.exports = { boundedCatalog, boundedPanel, fetchEvents };
