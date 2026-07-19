#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const {
  clusterSignFlipPValue,
  clusteredBootstrap,
  wilsonInterval,
} = require('../borg/research/statistics');

const EXPERIMENTS = Object.freeze({
  'flow-late-absorption-boundary-v2': {
    evidenceStart: '2026-07-18T13:36:24.615Z',
    strategyVersion: 'public-flow-cost-confirmed-v2',
  },
  'flow-late-absorption-boundary-v3': {
    evidenceStart: '2026-07-18T16:43:31.757Z',
    strategyVersion: 'public-flow-cost-confirmed-v3',
  },
});
const requestedExperiment = process.argv.find((arg) => arg.startsWith('--experiment='))?.split('=')[1]
  || 'flow-late-absorption-boundary-v3';
const experiment = EXPERIMENTS[requestedExperiment];
if (!experiment) throw new Error(`Unknown Flow boundary experiment: ${requestedExperiment}`);
const EVIDENCE_START = experiment.evidenceStart;
const ORDER_DELAYS_MS = Object.freeze([50, 100, 250, 500]);
const PRIMARY_DELAY_MS = 250;

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 4) {
  const parsed = finite(value);
  return parsed == null ? null : +parsed.toFixed(digits);
}

function normalizeOutcome(value) {
  return String(value || '').trim().toUpperCase();
}

function firstSourceAttemptPerMarket(rows) {
  const attempts = new Map();
  for (const row of rows) {
    if (!row.filled || attempts.has(String(row.condition_id))) continue;
    const availableMs = new Date(row.available_at).getTime();
    const boundaryMs = new Date(row.window_end).getTime();
    const tteSeconds = (boundaryMs - availableMs) / 1000;
    if (!(tteSeconds > 0 && tteSeconds <= 10)) continue;
    attempts.set(String(row.condition_id), { ...row, tteSeconds });
  }
  return [...attempts.values()].sort((left, right) =>
    new Date(left.available_at) - new Date(right.available_at));
}

function evaluateAttempt(row, delayMs) {
  const state = row.markouts?.order_latency?.[`${delayMs}ms`] || null;
  const outcome = normalizeOutcome(row.outcome);
  const resolved = outcome === 'UP' || outcome === 'DOWN';
  const filled = Boolean(state?.filled);
  const shares = finite(state?.fill_size);
  const notional = finite(state?.notional);
  const entryFee = finite(state?.entry_fee);
  const complete = filled && [shares, notional, entryFee].every((value) => value != null);
  const won = complete && resolved
    ? normalizeOutcome(row.target_outcome) === outcome : null;
  const gross = !resolved ? null : complete ? (won ? shares : 0) - notional : 0;
  return {
    condition_id: String(row.condition_id),
    slug: row.slug,
    day: new Date(row.available_at).toISOString().slice(0, 10),
    available_at: row.available_at,
    tte_seconds: row.tteSeconds,
    delay_ms: delayMs,
    arrival_present: state != null,
    arrival_reason: state?.reason || 'missing_persisted_arrival_state',
    resolved,
    filled: complete,
    won,
    shares: complete ? shares : 0,
    notional: complete ? notional : 0,
    entry_fee: complete ? entryFee : 0,
    pnl_1x: gross == null ? null : gross - entryFee,
    pnl_2x: gross == null ? null : gross - 2 * entryFee,
  };
}

function summarizeAttempts(attempts, delayMs) {
  const evaluated = attempts.map((row) => evaluateAttempt(row, delayMs));
  const resolved = evaluated.filter((row) => row.resolved);
  const resolvedFills = resolved.filter((row) => row.filled);
  const split = Math.floor(resolved.length / 2);
  const halves = [resolved.slice(0, split), resolved.slice(split)].map((rows) => ({
    markets: rows.length,
    fills: rows.filter((row) => row.filled).length,
    pnl1x: rows.reduce((sum, row) => sum + (row.pnl_1x || 0), 0),
    pnl2x: rows.reduce((sum, row) => sum + (row.pnl_2x || 0), 0),
  }));
  const pnl1x = resolved.reduce((sum, row) => sum + (row.pnl_1x || 0), 0);
  const pnl2x = resolved.reduce((sum, row) => sum + (row.pnl_2x || 0), 0);
  const marketCi = clusteredBootstrap(resolved, 'condition_id', 'pnl_2x');
  const dayCi = clusteredBootstrap(resolved, 'day', 'pnl_2x');
  const marketP = clusterSignFlipPValue(resolved, 'condition_id', 'pnl_2x');
  const dayP = clusterSignFlipPValue(resolved, 'day', 'pnl_2x');
  const wins = resolvedFills.filter((row) => row.won).length;
  const arrivalCoverage = attempts.length
    ? evaluated.filter((row) => row.arrival_present).length / attempts.length : 0;
  const calendarDays = new Set(resolved.map((row) => row.day)).size;
  return {
    delayMs,
    independentSourceMarkets: attempts.length,
    resolvedMarkets: resolved.length,
    calendarDays,
    persistedArrivalCoverage: arrivalCoverage,
    arrivalFills: evaluated.filter((row) => row.filled).length,
    resolvedFills: resolvedFills.length,
    wins,
    winRate: resolvedFills.length ? wins / resolvedFills.length : null,
    wilson95: wilsonInterval(wins, resolvedFills.length),
    turnover: resolvedFills.reduce((sum, row) => sum + row.notional, 0),
    pnl1x,
    pnl2x,
    chronologicalHalves: halves,
    marketClustered2x: marketCi,
    dayClustered2x: dayCi,
    conservativeOneSidedP: Math.max(marketP, dayP),
    rejectionReasons: Object.fromEntries([...evaluated.reduce((map, row) => {
      if (!row.filled) map.set(row.arrival_reason, (map.get(row.arrival_reason) || 0) + 1);
      return map;
    }, new Map())].sort((left, right) => right[1] - left[1])),
    rows: evaluated,
  };
}

function serialize(summary) {
  const value = {
    ...summary,
    persistedArrivalCoverage: round(summary.persistedArrivalCoverage),
    winRate: round(summary.winRate),
    wilson95: summary.wilson95.map((item) => round(item)),
    turnover: round(summary.turnover, 2),
    pnl1x: round(summary.pnl1x, 2),
    pnl2x: round(summary.pnl2x, 2),
    chronologicalHalves: summary.chronologicalHalves.map((half) => ({
      ...half, pnl1x: round(half.pnl1x, 2), pnl2x: round(half.pnl2x, 2),
    })),
    marketClustered2x: {
      clusters: summary.marketClustered2x.clusters,
      ci95: summary.marketClustered2x.ci.map((item) => round(item)),
    },
    dayClustered2x: {
      clusters: summary.dayClustered2x.clusters,
      ci95: summary.dayClustered2x.ci.map((item) => round(item)),
    },
    conservativeOneSidedP: round(summary.conservativeOneSidedP, 6),
  };
  delete value.rows;
  value.passesFrozenRule = value.delayMs === PRIMARY_DELAY_MS
    && value.resolvedMarkets >= 300
    && value.calendarDays >= 30
    && value.persistedArrivalCoverage >= 0.9
    && value.pnl2x > 0
    && value.chronologicalHalves.every((half) => half.pnl2x > 0)
    && value.marketClustered2x.ci95[0] > 0
    && value.dayClustered2x.ci95[0] > 0
    && value.conservativeOneSidedP <= 0.05;
  return value;
}

function poolConfig() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const local = /(?:localhost|127\.0\.0\.1|\/deltaforge)/i.test(connectionString);
  return { connectionString, ssl: local ? false : { rejectUnauthorized: false }, max: 2 };
}

async function main() {
  const pool = new Pool(poolConfig());
  try {
    const { rows } = await pool.query(`
      SELECT s.id,s.condition_id,s.available_at,s.target_outcome,sc.filled,sc.markouts,
             b.slug,b.window_end,b.outcome
        FROM pm_flow_signals s
        JOIN pm_flow_scores sc ON sc.signal_id=s.id
        JOIN borg_markets b ON b.condition_id=s.condition_id
       WHERE s.available_at >= $1
         AND s.features->>'strategy_version'=$2
         AND s.arm='absorption_reversal_v2' AND s.latency_ms=500
       ORDER BY s.available_at,s.id`, [EVIDENCE_START, experiment.strategyVersion]);
    const attempts = firstSourceAttemptPerMarket(rows);
    const delays = ORDER_DELAYS_MS.map((delayMs) => serialize(summarizeAttempts(attempts, delayMs)));
    const output = {
      format: 'flow-late-boundary-forward-report-v2',
      generatedAt: new Date().toISOString(),
      experimentId: requestedExperiment,
      evidenceStart: EVIDENCE_START,
      primaryDelayMs: PRIMARY_DELAY_MS,
      warning: 'Forward paper evidence only. The 0-10s rule was post-selected; V3 also resets for the venue minimum-order-size correction. Controls cannot replace the pre-registered 250ms primary result.',
      delays,
    };
    if (process.argv.includes('--json')) console.log(JSON.stringify(output, null, 2));
    else {
      console.log(`FLOW LATE-BOUNDARY FORWARD — ${output.generatedAt}`);
      console.log(output.warning);
      console.table(delays.map((delay) => ({
        delay_ms: delay.delayMs,
        source_markets: delay.independentSourceMarkets,
        resolved: delay.resolvedMarkets,
        fills: delay.resolvedFills,
        wins: delay.wins,
        pnl_1x: delay.pnl1x,
        pnl_2x: delay.pnl2x,
        arrival_coverage: delay.persistedArrivalCoverage,
        market_ci_low_2x: delay.marketClustered2x.ci95[0],
        day_ci_low_2x: delay.dayClustered2x.ci95[0],
        passes: delay.passesFrozenRule,
      })));
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

module.exports = {
  EVIDENCE_START,
  evaluateAttempt,
  firstSourceAttemptPerMarket,
  normalizeOutcome,
  summarizeAttempts,
};
