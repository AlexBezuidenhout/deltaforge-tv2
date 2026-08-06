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
const {
  pool, migrateEdgeExecution, migrateStructural, insertRows, logEvent,
} = require('../recon/db');
const {
  buildConditionGraph, evaluateCandidate, STRUCTURAL_UNIVERSE_VERSION,
} = require('./condition-graph');
const { buildPhysicalSportsCandidates } = require('./physical-event-graph');
const { buildExpandedPhysicalCandidates } = require('./physical-event-graph-v2');
const {
  attributionEvent, attributionRow, passiveTransitionStage, structuralEvaluationStage,
} = require('../research/execution-attribution');
const {
  createPassiveQuoteState, proposePassiveQuotes, updatePassiveQuoteState,
} = require('./passive-entry');
const { ORDERED_STRIKE_EXPERIMENT_ID, structuralExperimentId } = require('./experiment');

const GAMMA = 'https://gamma-api.polymarket.com';
const MAX_CANDIDATES = Math.max(4, Number(process.env.STRUCTURAL_MAX_CANDIDATES || 24));
const MAX_TOKENS = Math.max(8, Number(process.env.STRUCTURAL_MAX_TOKENS || 96));
const MAX_CATALOG_CANDIDATES = Math.max(MAX_CANDIDATES,
  Number(process.env.STRUCTURAL_MAX_CATALOG_CANDIDATES || 20_000));
const REFRESH_MS = Math.max(60_000, Number(process.env.STRUCTURAL_REFRESH_MS || 300_000));
const TARGET_NOTIONAL_USD = Math.max(1, Number(process.env.STRUCTURAL_TARGET_NOTIONAL_USD || 10));
const MIN_CAPACITY_PROFIT_USD = Math.max(0, Number(process.env.STRUCTURAL_MIN_CAPACITY_PROFIT_USD || 0.05));
const STALE_MS = Math.max(250, Number(process.env.STRUCTURAL_STALE_MS || 2000));
const NEGATIVE_SAMPLE_MS = Math.max(1000, Number(process.env.STRUCTURAL_NEGATIVE_SAMPLE_MS || 60_000));
const POSITIVE_SAMPLE_MS = Math.max(25, Number(process.env.STRUCTURAL_POSITIVE_SAMPLE_MS || 1000));
const PASSIVE_TIMEOUT_MS = Math.max(60_000,
  Number(process.env.STRUCTURAL_PASSIVE_TIMEOUT_MS || 60 * 60_000));
const EVENT_PAGES = Math.max(1, Math.min(20, Number(process.env.STRUCTURAL_EVENT_PAGES || 20)));
const SPORTS_EVENT_PAGES = Math.max(1, Math.min(10,
  Number(process.env.STRUCTURAL_SPORTS_EVENT_PAGES || 5)));
const GAMMA_CONCURRENCY = Math.max(1, Math.min(10,
  Number(process.env.STRUCTURAL_GAMMA_CONCURRENCY || 4)));
const GAMMA_TIMEOUT_MS = Math.max(5_000,
  Number(process.env.STRUCTURAL_GAMMA_TIMEOUT_MS || 30_000));
const GAMMA_MAX_ATTEMPTS = Math.max(1, Math.min(6,
  Number(process.env.STRUCTURAL_GAMMA_MAX_ATTEMPTS || 4)));
const LATENCY_PROFILES_MS = String(process.env.STRUCTURAL_LATENCY_PROFILES_MS || '20,50,100,250,500')
  .split(',').map(Number).filter((value) => Number.isInteger(value) && value >= 0 && value <= 5000);
const PROCESS_STARTED_AT = new Date().toISOString();
const RUN_ID = `structural:${os.hostname()}:${PROCESS_STARTED_AT}:${process.pid}`;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function passiveFillAdvanced(next, previous) {
  const nextShares = Number(next?.passiveFilledShares);
  const previousShares = Number(previous?.passiveFilledShares);
  return (Number.isFinite(nextShares) ? nextShares : 0)
    > (Number.isFinite(previousShares) ? previousShares : 0) + 1e-9;
}

async function concurrentMap(items, width, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

async function fetchEventPage(params, options = {}) {
  const url = new URL(`${GAMMA}/events`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const fetchImpl = options.fetchImpl || fetch;
  const sleep = options.sleep || wait;
  const timeoutMs = Math.max(1, Number(options.timeoutMs || GAMMA_TIMEOUT_MS));
  const maxAttempts = Math.max(1, Math.min(6,
    Number(options.maxAttempts || GAMMA_MAX_ATTEMPTS)));
  const baseDelayMs = Math.max(1, Number(options.baseDelayMs || 500));
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      const body = await response.text();
      if (!response.ok) {
        const error = new Error(`Gamma HTTP ${response.status}: ${body.slice(0, 160)}`);
        error.status = response.status;
        const retrySeconds = parseFloat(response.headers?.get?.('retry-after'));
        error.retryAfterMs = Number.isFinite(retrySeconds)
          ? Math.max(0, retrySeconds * 1000) : null;
        throw error;
      }
      return JSON.parse(body);
    } catch (error) {
      const timedOut = error?.name === 'AbortError';
      lastError = timedOut
        ? Object.assign(new Error(`Gamma request timed out after ${timeoutMs}ms: ${url}`), {
          code: 'ETIMEDOUT',
        })
        : error;
      const retryable = timedOut || error?.status === 429
        || error?.status >= 500 || error?.status == null;
      if (!retryable || attempt + 1 >= maxAttempts) throw lastError;
      const retryDelayMs = Math.min(10_000,
        error?.retryAfterMs ?? baseDelayMs * (2 ** attempt));
      await sleep(retryDelayMs);
    } finally { clearTimeout(timeout); }
  }
  throw lastError;
}

async function fetchEvents(options = {}) {
  const now = Date.now();
  const common = {
    active: 'true', closed: 'false', limit: '100',
    end_date_min: new Date(now - 3600_000).toISOString(),
    end_date_max: new Date(now + 365 * 86_400_000).toISOString(),
  };
  const requests = [];
  const eventPages = Math.max(1, Math.min(20, Number(options.eventPages || EVENT_PAGES)));
  const sportsEventPages = Math.max(1, Math.min(10,
    Number(options.sportsEventPages || SPORTS_EVENT_PAGES)));
  for (let page = 0; page < eventPages; page += 1) {
    const offset = String(page * 100);
    requests.push({ ...common, offset, order: 'endDate', ascending: 'true' });
    requests.push({ ...common, offset, order: 'volume24hr', ascending: 'false' });
  }
  // Explicit sports universe: broad ranking alone can crowd short-lived game
  // ladders out with political/crypto volume. Tag 1 is Polymarket's Sports
  // taxonomy. End-time and volume panels are both frozen infrastructure views.
  for (let page = 0; page < sportsEventPages; page += 1) {
    const offset = String(page * 100);
    requests.push({ ...common, tag_id: '1', offset, order: 'endDate', ascending: 'true' });
    requests.push({ ...common, tag_id: '1', offset,
      order: 'volume24hr', ascending: 'false' });
  }
  const pages = await concurrentMap(requests,
    Math.max(1, Math.min(10, Number(options.concurrency || GAMMA_CONCURRENCY))),
    (params) => fetchEventPage(params, options));
  return [...new Map(pages.flat().map((event) => [String(event.id || event.slug), event])).values()];
}

function candidatePriority(candidate) {
  const structural = candidate.structureType === 'binary_complement' ? 1 : 0;
  const end = Number.isFinite(Date.parse(candidate.endDate)) ? Date.parse(candidate.endDate) : Number.MAX_SAFE_INTEGER;
  return [structural, end, candidate.legs.length];
}

function structuralFailureReasons(item) {
  const checks = [
    ['passProof', 'PAYOFF_PROOF'],
    ['passRuleCertification', 'RULE_CERTIFICATION'],
    ['passStale', 'FRESHNESS'],
    ['passQuotes', 'EXECUTABLE_QUOTES'],
    ['passFeeSchedule', 'FEE_SCHEDULE'],
    ['passVenueMinimum', 'VENUE_MINIMUM'],
    ['passFees2x', 'DOUBLE_COST_EDGE'],
    ['passFok', 'FULL_DEPTH_FOK'],
    ['passCapacity', 'CAPACITY'],
    ['passOrphanRisk', 'NONATOMIC_ORPHAN_RISK'],
  ];
  return checks.filter(([key]) => item?.[key] !== true).map(([, label]) => label);
}

/**
 * Full evaluations remain append-before-process in the decision WAL. The hot
 * SQL row already has typed columns for every economic and execution gate, so
 * repeating complete books, fill walks, terminal states and leg documents in
 * JSONB only creates TOAST bloat. Keep content-addressed joins and summaries.
 */
function compactEvaluationDetail(item) {
  return {
    format: 'structural-hot-detail-v1',
    experimentId: item.experimentId,
    dedupKey: item.dedupKey,
    candidateId: item.candidateId,
    trigger: {
      token: item.triggerToken,
      sourceMs: item.triggerSourceMs,
      receivedAt: item.triggerReceivedAt,
      walEventId: item.triggerWalEventId,
      latencyMs: item.latencyMs,
      reactionUs: item.reactionUs,
    },
    proof: {
      payoffProofHash: item.payoffProofHash,
      ruleCertificationHash: item.ruleCertificationHash,
      relationType: item.payoffRelationType,
      ruleChecks: item.ruleCertificationChecks,
    },
    execution: item.executionOptimization ? {
      shares: item.executionOptimization.shares,
      cashRequired: item.executionOptimization.cashRequired,
      guaranteedProfit: item.executionOptimization.guaranteedProfit,
      worstOrphanUnwindPnl: item.executionOptimization.worstOrphanUnwindPnl,
      orphanUnwindAvailable: item.orphanUnwindAvailable,
      orphanReserveUsd: item.orphanReserveUsd,
      orphanSafeProfit2xUsd: item.orphanSafeProfit2xUsd,
      capacityLimitedBy: item.executionOptimization.capacityLimitedBy,
    } : null,
    bregman: item.bregman ? {
      divergence: item.bregman.divergence,
      dualGap: item.bregman.dualGap,
      iterations: item.bregman.iterations,
      converged: item.bregman.converged,
    } : null,
    atomic: item.atomic === true,
    failureReasons: structuralFailureReasons(item),
    canonicalPayload: 'structural-scanner decision WAL',
  };
}

function passiveQuoteRow(state, latencyMs) {
  return [
    state.quoteId, state.experimentId, state.candidateId, state.structureType,
    state.passiveLegIndex, state.passiveToken, state.passiveOutcome,
    state.quotedAt, state.expiresAt, state.filledAt || null, state.closedAt || null,
    state.status, latencyMs, state.quotePrice, state.shares,
    state.queueAheadShares, state.cashRequired, state.stressedProfit,
    state.orphanReserveUsd, state.orphanSafeProfitUsd,
    state.hedgeCost2xUsd ?? null, state.totalCost2xUsd ?? null,
    state.lockedPnl2xUsd ?? null, state.orphanUnwindPnl2xUsd ?? null,
    state.observations, state.payoffProofHash, state.ruleCertificationHash,
    true, true, 'B', 'C',
    JSON.stringify({
      fillModel: state.fillModel,
      feeModel: state.feeModel,
      makerFeeMode: state.makerFeeMode,
      queue: state.queue || null,
      passiveFilledShares: state.passiveFilledShares ?? 0,
      hedgedShares: state.hedgedShares ?? 0,
      hedgeFullDepth: state.hedgeFullDepth ?? null,
      runId: state.runId || null,
      warning: 'Paper post-only quote; only public prints consume the frozen displayed queue ahead. Cancellations receive no queue credit. Authenticated queue position and cancel acknowledgement are unavailable.',
    }),
  ];
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
    'sports_exact00_over05_floor', 'complete_mutually_exclusive_set',
    'sports_exact_score_match_result_floor',
    'sports_exact_score_btts_floor', 'sports_exact_score_first_scorer_floor',
    'sports_total_ladder', 'sports_spread_ladder',
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
  // Retire the previous panel only after the replacement catalog is durable.
  // A slow or failed 20k-row refresh must not expose a false all-inactive gap.
  await pool.query(`
    UPDATE borg_structural_candidates
       SET active=false
     WHERE active=true
       AND NOT (candidate_id=ANY($1::text[]))
  `, [[...active]]);
}

async function main() {
  await migrateStructural(); await migrateEdgeExecution();
  const abandoned = await pool.query(`
    UPDATE borg_structural_passive_quotes
       SET status='ABANDONED_PROCESS_RESTART',closed_at=now(),updated_at=now(),
           detail=detail||jsonb_build_object(
             'terminationReason','COLLECTOR_PROCESS_RESTART',
             'closedByRunId',$1::text
           )
     WHERE status='RESTING'
     RETURNING quote_id
  `, [RUN_ID]);
  if (abandoned.rowCount > 0) {
    await logEvent('WARN', 'structural_scanner',
      `closed ${abandoned.rowCount} stale passive paper quotes from a prior process`, {
        runId: RUN_ID,
        abandonedQuotes: abandoned.rowCount,
      });
  }
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
  // SQL needs only the latest materialized state for each quote. The WAL
  // below retains every transition; keyed coalescing prevents one INSERT ...
  // ON CONFLICT batch from trying to update the same primary key twice.
  const passiveBuffer = new Map();
  const attributionBuffer = [];
  const passiveStates = new Map();
  const lastStored = new Map();
  let successfulFlushes = 0;
  let persistenceErrors = 0;
  let lastPersistedAt = null;
  let lastPersistenceErrorAt = null;
  let stopping = false;
  const pendingEvaluations = new Set();
  const recordAttribution = (event) => {
    wal.append(JSON.stringify({ type: 'paper_execution_attribution', ...event }), {
      channel: 'paper-execution-attribution', sourceMs: Date.parse(event.observedAt),
    });
    attributionBuffer.push(event);
    if (attributionBuffer.length > 20_000) attributionBuffer.shift();
  };
  const recordPassiveState = (state, latencyMs, transition, sourceMs = null) => {
    wal.append(JSON.stringify({
      type: 'structural_passive_quote',
      transition,
      observedAt: Date.now(),
      state,
    }), {
      channel: 'structural-passive-decision',
      sourceMs,
    });
    passiveBuffer.set(state.quoteId, passiveQuoteRow(state, latencyMs));
    const stage = passiveTransitionStage(transition, state);
    if (stage) recordAttribution(attributionEvent({
      experimentId: state.experimentId || structuralExperimentId(state.structureType),
      opportunityId: state.quoteId,
      instrumentGroupId: state.candidateId,
      observedAt: Date.now(), stage, latencyMs, quantity: state.shares,
      conservativePnlUsd: state.lockedPnl2xUsd ?? state.orphanUnwindPnl2xUsd
        ?? state.orphanSafeProfitUsd,
      dataQualityGrade: 'B', executionFidelityGrade: 'C',
      detailIdentity: `${transition}:${state.status}:${state.observations || 0}`,
      detail: {
        transition, status: state.status, passiveFilledShares: state.passiveFilledShares ?? 0,
        hedgedShares: state.hedgedShares ?? 0, paperPostOnly: true,
      },
    }));
  };

  const clob = new ClobMultiplex((token) => tokenMarket.get(String(token)) || null, {
    shardCount: Number(process.env.STRUCTURAL_CLOB_SHARDS || 2),
    wal,
    emitTradeEvents: true,
    onMarketEvent: (event) => {
      if (stopping) return;
      const linked = byToken.get(String(event.assetId)) || [];
      for (const candidate of linked) {
        for (const latencyMs of LATENCY_PROFILES_MS) {
          const timer = setTimeout(() => {
            pendingEvaluations.delete(timer);
            if (stopping) return;
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
              experimentId: structuralExperimentId(candidate.structureType),
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
            if (shouldStore) {
              lastStored.set(storageKey, { signature, at: evaluatedAt });
              wal.append(JSON.stringify(durable), {
                channel: 'structural-decision', sourceMs: event.sourceMs,
                connectionEpoch: event.connectionEpoch, connectionShard: event.connectionShard,
              });
              buffer.push(durable);
              if (buffer.length > 20_000) buffer.shift();
              recordAttribution(attributionEvent({
                experimentId: durable.experimentId,
                opportunityId: durable.dedupKey,
                instrumentGroupId: candidate.candidateId,
                observedAt: evaluatedAt,
                stage: structuralEvaluationStage(evaluation), latencyMs,
                quantity: evaluation.targetShares,
                conservativePnlUsd: evaluation.orphanSafeProfit2xUsd,
                dataQualityGrade: evaluation.passStale && evaluation.passQuotes ? 'A' : 'F',
                executionFidelityGrade: 'B',
                detailIdentity: durable.dedupKey,
                detail: {
                  passProof: evaluation.passProof,
                  passRuleCertification: evaluation.passRuleCertification,
                  passStale: evaluation.passStale, passFok: evaluation.passFok,
                  passFees2x: evaluation.passFees2x,
                  passOrphanRisk: evaluation.passOrphanRisk,
                  qualified: evaluation.qualified, publicDisplayedDepthOnly: true,
                },
              }));
            }

            const passiveKey = `${candidate.candidateId}:${latencyMs}`;
            const currentPassive = passiveStates.get(passiveKey);
            if (currentPassive) {
              const updated = updatePassiveQuoteState(
                currentPassive,
                candidate,
                { get: (token) => clob.getBook(token) },
                evaluatedAt,
                {
                  staleMs: STALE_MS,
                  prints: String(event.assetId) === currentPassive.passiveToken
                    ? clob.printsSince(
                      currentPassive.passiveToken,
                      currentPassive.queue?.lastPrintAtMs || currentPassive.quotedAtMs,
                    ) : [],
                },
              );
              passiveStates.set(passiveKey, updated);
              const fillChanged = passiveFillAdvanced(updated, currentPassive);
              if (fillChanged || updated.status !== currentPassive.status) {
                recordPassiveState(
                  updated,
                  latencyMs,
                  fillChanged && updated.status === 'RESTING'
                    ? 'PARTIAL_FILL_HEDGED' : updated.status,
                  event.sourceMs,
                );
              }
              if (updated.status !== 'RESTING') {
                passiveStates.delete(passiveKey);
              }
            } else {
              const proposal = proposePassiveQuotes(
                candidate,
                { get: (token) => clob.getBook(token) },
                evaluatedAt,
                {
                  staleMs: STALE_MS,
                  targetNotionalUsd: TARGET_NOTIONAL_USD,
                  minCapacityProfitUsd: MIN_CAPACITY_PROFIT_USD,
                },
              ).find((row) => row.eligible);
              if (proposal) {
                const state = createPassiveQuoteState(proposal, evaluatedAt, {
                  timeoutMs: PASSIVE_TIMEOUT_MS,
                });
                state.runId = RUN_ID;
                state.experimentId = structuralExperimentId(candidate.structureType);
                recordPassiveState(state, latencyMs, 'PLACED', event.sourceMs);
                passiveStates.set(passiveKey, state);
              }
            }
          }, latencyMs);
          pendingEvaluations.add(timer);
          timer.unref?.();
        }
      }
    },
  });

  const refresh = async () => {
    const events = await fetchEvents();
    const graph = [
      ...buildConditionGraph(events),
      ...buildPhysicalSportsCandidates(events),
      ...buildExpandedPhysicalCandidates(events),
    ];
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
        gammaConcurrency: GAMMA_CONCURRENCY,
        gammaTimeoutMs: GAMMA_TIMEOUT_MS,
        gammaMaxAttempts: GAMMA_MAX_ATTEMPTS,
        panelByType: Object.fromEntries([...candidates.values()].reduce((map, candidate) => {
          map.set(candidate.structureType, (map.get(candidate.structureType) || 0) + 1); return map;
        }, new Map())),
        uncertifiedCatalog: catalog.filter((candidate) => !candidate.ruleCertification?.valid).length,
      });
  };

  const flush = async () => {
    if (!buffer.length && !passiveBuffer.size && !attributionBuffer.length) return;
    const rows = buffer.splice(0, 2000);
    const attribution = attributionBuffer.splice(0, 2000);
    const passiveEntries = [...passiveBuffer.entries()].slice(0, 2000);
    for (const [quoteId] of passiveEntries) passiveBuffer.delete(quoteId);
    const passiveRows = passiveEntries.map(([, row]) => row);
    try {
      for (const item of rows) {
        await pool.query(`
          INSERT INTO borg_structural_evaluations (
            dedup_key, experiment_id, evaluated_at, candidate_id, trigger_token, trigger_source_ts,
            trigger_received_at, trigger_wal_event_id, latency_ms, reaction_us,
            structure_type, guaranteed_min_payout, cost_per_bundle, fees_2x_per_bundle,
            residual_2x_per_bundle, target_notional_usd, target_shares,
            displayed_bundle_shares, displayed_notional_usd, displayed_profit_2x_usd,
            pass_proof, payoff_proof_hash, pass_rule_certification, rule_certification_hash,
            pass_stale, pass_quotes, pass_fees_2x, pass_fok, pass_capacity,
            pass_orphan_risk, orphan_loss_stress_usd, orphan_unwind_available,
            orphan_reserve_usd, orphan_safe_profit_2x_usd,
            economic_candidate, qualified, detail)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37::jsonb)
          ON CONFLICT (dedup_key,evaluated_at) DO NOTHING
        `, [
          item.dedupKey, item.experimentId, item.evaluatedAt, item.candidateId, item.triggerToken,
          item.triggerSourceMs == null ? null : new Date(item.triggerSourceMs),
          new Date(item.triggerReceivedAt), item.triggerWalEventId, item.latencyMs, item.reactionUs,
          item.structureType, item.guaranteedMinPayout, item.costPerBundle,
          item.fees2xPerBundle, item.residual2xPerBundle, item.targetNotionalUsd,
          item.targetShares, item.displayedBundleShares, item.displayedNotionalUsd,
          item.displayedProfit2xUsd, item.passProof, item.payoffProofHash,
          item.passRuleCertification, item.ruleCertificationHash,
          item.passStale, item.passQuotes, item.passFees2x,
          item.passFok, item.passCapacity, item.passOrphanRisk, item.orphanLossStressUsd,
          item.orphanUnwindAvailable, item.orphanReserveUsd, item.orphanSafeProfit2xUsd,
          item.economicCandidate, item.qualified, JSON.stringify(compactEvaluationDetail(item)),
        ]);
      }
      if (passiveRows.length) {
        await insertRows('borg_structural_passive_quotes', [
          'quote_id', 'experiment_id', 'candidate_id', 'structure_type', 'passive_leg_index',
          'passive_token', 'passive_outcome', 'quoted_at', 'expires_at',
          'filled_at', 'closed_at', 'status', 'latency_ms', 'quote_price',
          'shares', 'queue_ahead_shares', 'proposed_cash_required',
          'proposed_stressed_profit', 'proposed_orphan_reserve_usd',
          'proposed_orphan_safe_profit_usd', 'hedge_cost_2x_usd',
          'total_cost_2x_usd', 'locked_pnl_2x_usd',
          'orphan_unwind_pnl_2x_usd', 'observations', 'payoff_proof_hash',
          'rule_certification_hash', 'paper_only', 'post_only',
          'data_quality_grade', 'execution_fidelity_grade', 'detail',
        ], passiveRows, `ON CONFLICT (quote_id) DO UPDATE SET
          filled_at=EXCLUDED.filled_at,closed_at=EXCLUDED.closed_at,
          status=EXCLUDED.status,hedge_cost_2x_usd=EXCLUDED.hedge_cost_2x_usd,
          total_cost_2x_usd=EXCLUDED.total_cost_2x_usd,
          locked_pnl_2x_usd=EXCLUDED.locked_pnl_2x_usd,
          orphan_unwind_pnl_2x_usd=EXCLUDED.orphan_unwind_pnl_2x_usd,
          observations=EXCLUDED.observations,detail=EXCLUDED.detail,
          updated_at=now()`);
      }
      if (attribution.length) await insertRows('borg_execution_attribution', [
        'attribution_id', 'experiment_id', 'opportunity_id', 'instrument_group_id',
        'observed_at', 'stage', 'latency_ms', 'quantity', 'conservative_pnl_usd',
        'data_quality_grade', 'execution_fidelity_grade', 'paper_only', 'detail',
      ], attribution.map(attributionRow), 'ON CONFLICT (attribution_id) DO NOTHING');
      successfulFlushes += 1;
      lastPersistedAt = new Date().toISOString();
    } catch (error) {
      buffer.unshift(...rows);
      attributionBuffer.unshift(...attribution);
      for (const [quoteId, row] of passiveEntries) {
        // A newer transition may have arrived while SQL was in flight. Never
        // replace it with the older failed materialization.
        if (!passiveBuffer.has(quoteId)) passiveBuffer.set(quoteId, row);
      }
      persistenceErrors += 1;
      lastPersistenceErrorAt = new Date().toISOString();
      await logEvent('ERROR', 'structural_scanner', `async persistence failed; WAL retained: ${error.message}`);
    }
  };

  await refresh();
  await clob.connect();
  const sweepPassiveQuotes = () => {
    const now = Date.now();
    for (const [key, state] of passiveStates) {
      const candidate = candidates.get(state.candidateId);
      const updated = updatePassiveQuoteState(
        state,
        candidate,
        { get: (token) => clob.getBook(token) },
        now,
        {
          staleMs: STALE_MS,
          prints: clob.printsSince(
            state.passiveToken,
            state.queue?.lastPrintAtMs || state.quotedAtMs,
          ),
        },
      );
      passiveStates.set(key, updated);
      const fillChanged = passiveFillAdvanced(updated, state);
      if (fillChanged || updated.status !== state.status) {
        recordPassiveState(
          updated,
          Number(key.split(':').at(-1)),
          fillChanged && updated.status === 'RESTING'
            ? 'PARTIAL_FILL_HEDGED' : updated.status,
        );
      }
      if (updated.status !== 'RESTING') {
        passiveStates.delete(key);
      }
    }
  };
  const timers = [
    setInterval(() => refresh().catch((error) => logEvent('ERROR', 'structural_scanner', error.message)), REFRESH_MS),
    setInterval(() => flush().catch(() => {}), 1000),
    setInterval(sweepPassiveQuotes, 1000),
    setInterval(() => clob.flushEvents().catch(() => {}), 5000),
    setInterval(() => clob.checkStale(), 30_000),
    setInterval(() => pool.query(`
      INSERT INTO system_heartbeats (component, beat_at, meta)
      VALUES ('structural_scanner',now(),$1::jsonb)
      ON CONFLICT (component) DO UPDATE SET beat_at=now(), meta=EXCLUDED.meta
    `, [JSON.stringify({ pid: process.pid, host: os.hostname(), runId: RUN_ID,
      processStartedAt: PROCESS_STARTED_AT,
      collectionEpochId: process.env.BORG_COLLECTION_EPOCH_ID || 'structural-unmarked',
      candidates: candidates.size,
      catalogCandidates: catalogSize, tokens: byToken.size, queued: buffer.length,
      passiveQueued: passiveBuffer.size, passiveResting: passiveStates.size,
      attributionQueued: attributionBuffer.length,
      successfulFlushes, persistenceErrors, lastPersistedAt, lastPersistenceErrorAt,
      paperOnly: true, walletLoaded: false, allMarket: true, sportsTagId: 1,
      sportsEventPages: SPORTS_EVENT_PAGES, universeVersion: STRUCTURAL_UNIVERSE_VERSION,
      orderedStrikeExperimentId: ORDERED_STRIKE_EXPERIMENT_ID,
      gammaConcurrency: GAMMA_CONCURRENCY, gammaTimeoutMs: GAMMA_TIMEOUT_MS,
      gammaMaxAttempts: GAMMA_MAX_ATTEMPTS,
      negativeSampleMs: NEGATIVE_SAMPLE_MS, positiveSampleMs: POSITIVE_SAMPLE_MS,
      passiveTimeoutMs: PASSIVE_TIMEOUT_MS,
      latencyProfilesMs: LATENCY_PROFILES_MS })]).catch(() => {}), 10_000),
  ];

  const shutdown = async (signal) => {
    stopping = true;
    for (const timer of pendingEvaluations) clearTimeout(timer);
    pendingEvaluations.clear();
    timers.forEach(clearInterval);
    const closedAt = new Date().toISOString();
    for (const [key, state] of passiveStates) {
      const stopped = {
        ...state,
        status: state.passiveFilledShares > 1e-9
          ? 'CANCELLED_PARTIAL_HEDGED_PROCESS_STOP' : 'CANCELLED_UNFILLED_PROCESS_STOP',
        closedAt,
      };
      recordPassiveState(stopped, Number(key.split(':').at(-1)), stopped.status);
    }
    passiveStates.clear();
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

module.exports = {
  boundedCatalog, boundedPanel, compactEvaluationDetail, concurrentMap,
  fetchEventPage, fetchEvents, passiveFillAdvanced, passiveQuoteRow,
  structuralFailureReasons,
};
