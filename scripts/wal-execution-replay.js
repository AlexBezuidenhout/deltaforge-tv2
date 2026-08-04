#!/usr/bin/env node
'use strict';

const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { pool, migrate } = require('../borg/recon/db');
const {
  WAL_REPLAY_LATENCIES_MS,
  persistWalExecutionReplays,
} = require('../borg/research/execution-replay');
const { WAL_ARRIVAL_REPLAY_VERSION } = require('../borg/research/arrival-state');

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function profiles() {
  return String(arg('--profiles', WAL_REPLAY_LATENCIES_MS.join(',')))
    .split(',').map((value) => parseInt(value, 10))
    .filter((value) => Number.isInteger(value) && value > 0 && value <= 10_000);
}

function summarize(rows) {
  const byLatency = new Map();
  for (const row of rows) {
    const bucket = byLatency.get(row.latencyMs) || {
      latencyMs: row.latencyMs, intents: 0, eligibleFills: 0,
      provenNonfills: 0, unscoreable: 0, lowQuality: 0, pnl1x: 0, pnl2x: 0,
    };
    bucket.intents += 1;
    if (row.executionState === 'ELIGIBLE_FILL') bucket.eligibleFills += 1;
    else if (row.executionState === 'PROVEN_NONFILL') bucket.provenNonfills += 1;
    else if (row.executionState === 'LOW_QUALITY') bucket.lowQuality += 1;
    else bucket.unscoreable += 1;
    if (['A', 'B'].includes(row.dataQualityGrade)
        && ['A', 'B'].includes(row.executionFidelityGrade)) {
      bucket.pnl1x += row.pnl1x;
      bucket.pnl2x += row.pnl2x;
    }
    byLatency.set(row.latencyMs, bucket);
  }
  return [...byLatency.values()].sort((left, right) => left.latencyMs - right.latencyMs);
}

async function main() {
  const latencyProfiles = profiles();
  if (!latencyProfiles.length) throw new Error('at least one valid --profiles latency is required');
  const persist = process.argv.includes('--persist');
  const strategy = arg('--strategy');
  const epoch = arg('--epoch');
  const since = arg('--since');
  await migrate();
  const conditions = ["o.action='place'", "o.order_kind='taker'", 'm.outcome IS NOT NULL'];
  const params = [];
  if (strategy) { params.push(strategy); conditions.push(`o.strategy=$${params.length}`); }
  if (epoch) {
    params.push(epoch);
    conditions.push(`o.features->>'collection_epoch_id'=$${params.length}`);
  }
  if (since) {
    const parsed = new Date(since);
    if (Number.isNaN(parsed.getTime())) throw new Error('--since must be an ISO timestamp');
    params.push(parsed);
    conditions.push(`COALESCE(o.available_at,o.ts)>=$${params.length}`);
  }
  const { rows: orders } = await pool.query(`
    SELECT o.*,m.outcome,m.up_token_id,m.down_token_id,
           m.positive_label,m.negative_label
      FROM borg_shadow_orders o
      JOIN borg_markets m ON m.id=o.market_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY o.id
  `, params);
  const replays = [];
  let inserted = 0;
  for (const order of orders) {
    const result = await persistWalExecutionReplays(pool, order, {
      latencies: latencyProfiles, persist,
    });
    inserted += result.inserted;
    replays.push(...result.rows);
  }
  console.log(JSON.stringify({
    format: 'borg-wal-execution-replay-report-v1',
    replayVersion: WAL_ARRIVAL_REPLAY_VERSION,
    generatedAt: new Date().toISOString(),
    immutablePersistence: persist,
    filters: { strategy: strategy || null, epoch: epoch || null, since: since || null },
    intendedOrders: orders.length,
    inserted,
    profiles: summarize(replays),
    caveat: 'Execution replay only. It changes neither strategy signals nor frozen primary paper scores; F/low-quality rows contribute no PnL.',
  }, null, 2));
  await pool.end();
}

if (require.main === module) main().catch(async (error) => {
  console.error(error.stack || error.message);
  await pool.end().catch(() => {});
  process.exit(1);
});

module.exports = { profiles, summarize };
