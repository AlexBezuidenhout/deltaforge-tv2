#!/usr/bin/env node
'use strict';

const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { createResearchPool } = require('./lib/research-pool');

const {
  OPTIONS_EVIDENCE_START: MANIFEST_EVIDENCE_START,
  OPTIONS_EXPERIMENT_ID,
  OPTIONS_STRATEGY,
} = require('../borg/options/experiment');

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function quantile(values, probability) {
  if (!values.length) return null;
  const rows = [...values].sort((left, right) => left - right);
  const index = (rows.length - 1) * probability;
  const lower = Math.floor(index); const upper = Math.ceil(index);
  return rows[lower] + (rows[upper] - rows[lower]) * (index - lower);
}

function deterministicRandom(seed = 0x6d2b79f5) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function clusteredMeanInterval(rows, key, iterations = 4000) {
  const groups = new Map();
  for (const row of rows) {
    const group = groups.get(row[key]) || [];
    group.push(row); groups.set(row[key], group);
  }
  const clusters = [...groups.values()];
  if (clusters.length < 2) return { lower: null, upper: null, clusters: clusters.length };
  const random = deterministicRandom();
  const means = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sampled = [];
    for (let index = 0; index < clusters.length; index += 1) {
      sampled.push(...clusters[Math.floor(random() * clusters.length)]);
    }
    means.push(sampled.reduce((sum, row) => sum + row.pnl2x, 0) / sampled.length);
  }
  return {
    lower: quantile(means, 0.025), upper: quantile(means, 0.975),
    clusters: clusters.length,
  };
}

function score(row) {
  const detail = row.detail && typeof row.detail === 'object' ? row.detail : {};
  const optimized = detail.optimized || {};
  const hedge = detail.hedge || {};
  const shares = finite(row.target_shares);
  const gross = finite(optimized?.fill?.gross);
  const entryFees2x = finite(optimized?.fill?.fees);
  const entrySpot = finite(detail.resolverPrice ?? detail.chainlink);
  const exitSpot = finite(row.binance_close);
  const hedgeBase = finite(hedge.hedgeBase ?? row.hedge_base);
  if (!(shares > 0) || gross == null || entryFees2x == null
    || !['YES', 'NO'].includes(String(row.outcome).toUpperCase())) return null;
  const won = String(row.outcome).toUpperCase() === String(row.side).toUpperCase();
  const tokenPnl2x = (won ? shares : 0) - gross - entryFees2x;
  const hedgePnl = entrySpot > 0 && exitSpot > 0 && hedgeBase != null
    ? hedgeBase * (exitSpot - entrySpot) : null;
  const hedgeCostStress = finite(row.hedge_cost_stress_usd) ?? 0;
  return {
    ...row,
    won,
    tokenPnl2x,
    hedgePnl,
    pnl2x: hedgePnl == null ? tokenPnl2x - hedgeCostStress
      : tokenPnl2x + hedgePnl - hedgeCostStress,
    hedgeScored: hedgePnl != null,
    eventKey: row.event_id || `market:${row.market_id}`,
    dayKey: new Date(row.observed_at).toISOString().slice(0, 10),
  };
}

function summarize(rows) {
  const ordered = [...rows].sort((left, right) => new Date(left.observed_at) - new Date(right.observed_at));
  const split = Math.floor(ordered.length / 2);
  const total = ordered.reduce((sum, row) => sum + row.pnl2x, 0);
  return {
    n: ordered.length,
    wins: ordered.filter((row) => row.won).length,
    pnl2xUsd: total,
    meanPnl2xUsd: ordered.length ? total / ordered.length : null,
    firstHalfPnl2xUsd: ordered.slice(0, split).reduce((sum, row) => sum + row.pnl2x, 0),
    secondHalfPnl2xUsd: ordered.slice(split).reduce((sum, row) => sum + row.pnl2x, 0),
    hedgeScored: ordered.filter((row) => row.hedgeScored).length,
    eventClusteredMeanCi95: clusteredMeanInterval(ordered, 'eventKey'),
    dayClusteredMeanCi95: clusteredMeanInterval(ordered, 'dayKey'),
  };
}

async function buildReport(pool) {
  const [{ rows: trialRows }, { rows: collectionRows }] = await Promise.all([
    pool.query(`
      SELECT experiment_id,strategy,status,evidence_started_at,
             min_independent_markets,min_days,manifest_hash
        FROM borg_trial_ledger
       WHERE experiment_id=$1
         AND strategy=$2
       ORDER BY registered_at DESC LIMIT 1`,
    [OPTIONS_EXPERIMENT_ID, OPTIONS_STRATEGY]),
    pool.query(`
      SELECT r.epoch_id,e.started_at,e.code_version,e.data_contract_version
        FROM borg_collector_runs r
        JOIN borg_collection_epochs e USING(epoch_id)
       WHERE r.status='RUNNING' ORDER BY r.started_at DESC LIMIT 1`),
  ]);
  const trial = trialRows[0] || null;
  const collection = collectionRows[0] || null;
  // Registry time may conservatively lag the manifest freeze during deployment.
  // The infrastructure epoch is also an evidence boundary: pre-repair rows from
  // the same strategy identifier may never leak into a post-repair cohort.
  const evidenceStart = new Date(Math.max(
    Date.parse(MANIFEST_EVIDENCE_START),
    trial?.evidence_started_at ? new Date(trial.evidence_started_at).getTime() : 0,
    collection?.started_at ? new Date(collection.started_at).getTime() : 0,
  )).toISOString();
  const { rows: runtime } = await pool.query(`
    SELECT * FROM borg_options_runtime ORDER BY updated_at DESC LIMIT 1`);
  const runtimeRow = runtime[0] || null;
  // The raw touch table contains millions of append-only surface ticks per
  // day. Counting it for a dashboard report is both redundant and capable of
  // timing out ingestion. The collector's durable runtime ledger already
  // records exact persisted-touch and subscribed-instrument counters for this
  // run, so use that bounded source instead.
  const capture = runtimeRow ? {
    touches: finite(runtimeRow.stored_touches)
      ?? finite(runtimeRow.metrics?.storedTouches) ?? 0,
    instruments: finite(runtimeRow.subscribed_instruments) ?? 0,
    first_at: runtimeRow.started_at || null,
    last_at: runtimeRow.last_event_at || runtimeRow.metrics?.lastEventAt || null,
    source: 'borg_options_runtime durable counters; no raw-table count scan',
  } : null;
  const { rows: diagnosticRows } = await pool.query(`
    SELECT surface_fidelity,
           COALESCE(detail->'surface'->>'mode','UNKNOWN') surface_mode,
           COALESCE(detail->>'executionBarrier',
                    CASE WHEN executable THEN 'EXECUTABLE' ELSE 'LEGACY_UNCLASSIFIED' END) barrier,
           count(*)::int observations,
           count(DISTINCT market_id)::int markets,
           count(*) FILTER (WHERE executable)::int executable_observations,
           count(*) FILTER (WHERE detail->'optimized' IS NOT NULL
                              AND detail->'optimized' <> 'null'::jsonb)::int positive_depth_walks,
           max(observed_at) latest
      FROM borg_option_shadow_marks
     WHERE observed_at >= $1 AND experiment_id=$2
     GROUP BY surface_fidelity,surface_mode,barrier
     ORDER BY observations DESC,surface_fidelity,surface_mode,barrier`,
  [evidenceStart, OPTIONS_EXPERIMENT_ID]);
  // Frozen policy: one first executable intent per independent market. Later
  // observations cannot replace an earlier loss and both sides cannot stack.
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (s.market_id)
           s.*,m.outcome,m.binance_close,m.event_id,m.slug
      FROM borg_option_shadow_marks s
      JOIN borg_markets m ON m.id=s.market_id
     WHERE s.observed_at >= $1 AND s.experiment_id=$2 AND s.executable=true
     ORDER BY s.market_id,s.observed_at,s.id`,
  [evidenceStart, OPTIONS_EXPERIMENT_ID]);
  const scored = rows.map(score).filter(Boolean);
  return {
    generatedAt: new Date().toISOString(),
    evidenceStartedAt: evidenceStart,
    collectionEpoch: collection,
    trial,
    policy: 'first executable exact-expiry A-fidelity surface signal per market; no stacking or best-in-hindsight replacement',
    runtime: runtimeRow,
    capture,
    evidenceProduction: {
      diagnostics: diagnosticRows,
      interpretation: diagnosticRows.some((row) => row.surface_fidelity === 'A')
        ? 'At least one exact-expiry A-fidelity surface cohort is present; executable rows still require every book, resolver, fee, minimum-size and positive-depth constraint.'
        : 'No exact-expiry A-fidelity surface exists for the observed targets. Term interpolation and C/D marks are diagnostic collection, not executable evidence and are excluded from PnL.',
    },
    pendingOrUnscorable: rows.length - scored.length,
    overall: summarize(scored),
    byAsset: Object.fromEntries([...new Set(scored.map((row) => row.asset))]
      .map((asset) => [asset, summarize(scored.filter((row) => row.asset === asset))])),
    verdict: scored.length < 300
      ? 'INSUFFICIENT_FORWARD_EVIDENCE'
      : 'APPLY_FROZEN_PROMOTION_TESTS',
    caveats: [
      'The database had no historical full Deribit strike/expiry surface; prior DVOL proxy rows are excluded.',
      'A missing hedge close uses token PnL minus hedge-cost stress and is not a fully scored hedged trade.',
      'Paper taker marks use causal displayed depth but do not prove authenticated FOK acknowledgement.',
      'Do not annualize or promote before 300 independent markets and 30 calendar days.',
    ],
  };
}

async function main() {
  const pool = createResearchPool({ applicationName: 'options-surface-report' });
  try {
    const report = await buildReport(pool);
    if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else {
      console.log('Options-implied binary forward report');
      console.log(JSON.stringify(report, null, 2));
    }
  } finally { await pool.end(); }
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message); process.exit(1);
});

module.exports = { buildReport, clusteredMeanInterval, score, summarize };
