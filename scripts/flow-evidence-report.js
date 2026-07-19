#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const {
  clusterSignFlipPValue,
  clusteredBootstrap,
  holmAdjust,
} = require('../borg/research/statistics');
const { CHALLENGER_STRATEGY_VERSION } = require('../borg/flow/strategy');

const STRATEGY_VERSION = CHALLENGER_STRATEGY_VERSION;
const HORIZONS_SECONDS = Object.freeze([1, 2, 5, 10]);

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 4) {
  const parsed = finite(value);
  return parsed == null ? null : +parsed.toFixed(digits);
}

function utcDay(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

function markoutPnl(row, horizonSeconds, costMultiple = 1) {
  if (!row.filled || !['A', 'B'].includes(row.data_quality_grade)) return 0;
  const mark = row.markouts?.[`${horizonSeconds}s`]?.pnl;
  const gross = finite(mark?.gross);
  const entryFee = finite(mark?.entryFee);
  const exitFee = finite(mark?.exitFee);
  if ([gross, entryFee, exitFee].some((value) => value == null)) return null;
  return gross - costMultiple * (entryFee + exitFee);
}

function groupIndependentSweeps(rows, horizonSeconds) {
  const sweeps = new Map();
  for (const row of rows) {
    if (!['A', 'B'].includes(row.data_quality_grade)) continue;
    const pnl1x = markoutPnl(row, horizonSeconds, 1);
    const pnl2x = markoutPnl(row, horizonSeconds, 2);
    if (pnl1x == null || pnl2x == null) continue;
    const key = String(row.trigger_key);
    const prior = sweeps.get(key) || {
      trigger_key: key,
      condition_id: String(row.condition_id),
      available_at: row.available_at,
      day: utcDay(row.available_at),
      question: row.question || row.slug || row.condition_id,
      filled: false,
      entry_notional: 0,
      pnl_1x: 0,
      pnl_2x: 0,
    };
    if (new Date(row.available_at) < new Date(prior.available_at)) {
      prior.available_at = row.available_at;
      prior.day = utcDay(row.available_at);
    }
    prior.filled = prior.filled || Boolean(row.filled);
    prior.entry_notional += row.filled
      ? (finite(row.entry_price) || 0) * (finite(row.fill_size) || 0) : 0;
    prior.pnl_1x += pnl1x;
    prior.pnl_2x += pnl2x;
    sweeps.set(key, prior);
  }
  return [...sweeps.values()].sort((left, right) =>
    new Date(left.available_at) - new Date(right.available_at));
}

function aggregateBy(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = String(keyFn(row) || 'unknown');
    const group = groups.get(key) || { key, sweeps: 0, fills: 0, pnl1x: 0, pnl2x: 0 };
    group.sweeps += 1;
    group.fills += row.filled ? 1 : 0;
    group.pnl1x += row.pnl_1x;
    group.pnl2x += row.pnl_2x;
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => right.pnl1x - left.pnl1x);
}

function summarizeCell(rows, horizonSeconds) {
  const scored = rows.filter((row) => row.score_id != null);
  const qualityRows = scored.filter((row) => ['A', 'B'].includes(row.data_quality_grade));
  const sweeps = groupIndependentSweeps(scored, horizonSeconds);
  const fills = sweeps.filter((row) => row.filled);
  const pnl1x = sweeps.reduce((sum, row) => sum + row.pnl_1x, 0);
  const pnl2x = sweeps.reduce((sum, row) => sum + row.pnl_2x, 0);
  const entryNotional = sweeps.reduce((sum, row) => sum + row.entry_notional, 0);
  const split = Math.floor(sweeps.length / 2);
  const halves = [sweeps.slice(0, split), sweeps.slice(split)].map((half) => ({
    sweeps: half.length,
    fills: half.filter((row) => row.filled).length,
    pnl1x: half.reduce((sum, row) => sum + row.pnl_1x, 0),
    pnl2x: half.reduce((sum, row) => sum + row.pnl_2x, 0),
  }));
  const marketBootstrap1x = clusteredBootstrap(sweeps, 'condition_id', 'pnl_1x');
  const dayBootstrap1x = clusteredBootstrap(sweeps, 'day', 'pnl_1x');
  const marketBootstrap2x = clusteredBootstrap(sweeps, 'condition_id', 'pnl_2x');
  const dayBootstrap2x = clusteredBootstrap(sweeps, 'day', 'pnl_2x');
  const marketP = clusterSignFlipPValue(sweeps, 'condition_id', 'pnl_1x');
  const dayP = clusterSignFlipPValue(sweeps, 'day', 'pnl_1x');
  const byCondition = aggregateBy(sweeps, (row) => row.condition_id);
  const byDay = aggregateBy(sweeps, (row) => row.day);
  const bestCondition = byCondition[0] || null;
  return {
    signals: rows.length,
    scored: scored.length,
    qualityCoverage: scored.length ? qualityRows.length / scored.length : 0,
    independentSweeps: sweeps.length,
    fills: fills.length,
    fillRate: sweeps.length ? fills.length / sweeps.length : 0,
    calendarDays: new Set(sweeps.map((row) => row.day).filter(Boolean)).size,
    pnl1x,
    pnl2x,
    entryNotional,
    returnOnTurnover1x: entryNotional ? pnl1x / entryNotional : null,
    returnOnTurnover2x: entryNotional ? pnl2x / entryNotional : null,
    meanPerSweep1x: sweeps.length ? pnl1x / sweeps.length : null,
    meanPerFill1x: fills.length ? pnl1x / fills.length : null,
    chronologicalHalves: halves,
    marketClustered1x: marketBootstrap1x,
    dayClustered1x: dayBootstrap1x,
    marketClustered2x: marketBootstrap2x,
    dayClustered2x: dayBootstrap2x,
    conservativeOneSidedP: Math.max(marketP, dayP),
    bestCondition: bestCondition ? {
      ...bestCondition,
      shareOfPositivePnl1x: pnl1x > 0 ? bestCondition.pnl1x / pnl1x : null,
      pnlWithoutBestCondition1x: pnl1x - bestCondition.pnl1x,
    } : null,
    byDay,
  };
}

function serializeCell(cell) {
  const ci = (result) => result.ci.map((value) => round(value));
  return {
    ...cell,
    qualityCoverage: round(cell.qualityCoverage),
    fillRate: round(cell.fillRate),
    pnl1x: round(cell.pnl1x, 2),
    pnl2x: round(cell.pnl2x, 2),
    entryNotional: round(cell.entryNotional, 2),
    returnOnTurnover1x: round(cell.returnOnTurnover1x),
    returnOnTurnover2x: round(cell.returnOnTurnover2x),
    meanPerSweep1x: round(cell.meanPerSweep1x, 6),
    meanPerFill1x: round(cell.meanPerFill1x),
    chronologicalHalves: cell.chronologicalHalves.map((half) => ({
      ...half, pnl1x: round(half.pnl1x, 2), pnl2x: round(half.pnl2x, 2),
    })),
    marketClustered1x: { clusters: cell.marketClustered1x.clusters, ci95: ci(cell.marketClustered1x) },
    dayClustered1x: { clusters: cell.dayClustered1x.clusters, ci95: ci(cell.dayClustered1x) },
    marketClustered2x: { clusters: cell.marketClustered2x.clusters, ci95: ci(cell.marketClustered2x) },
    dayClustered2x: { clusters: cell.dayClustered2x.clusters, ci95: ci(cell.dayClustered2x) },
    conservativeOneSidedP: round(cell.conservativeOneSidedP, 6),
    bestCondition: cell.bestCondition ? {
      ...cell.bestCondition,
      pnl1x: round(cell.bestCondition.pnl1x, 2),
      pnl2x: round(cell.bestCondition.pnl2x, 2),
      shareOfPositivePnl1x: round(cell.bestCondition.shareOfPositivePnl1x),
      pnlWithoutBestCondition1x: round(cell.bestCondition.pnlWithoutBestCondition1x, 2),
    } : null,
    byDay: cell.byDay.map((day) => ({
      ...day, pnl1x: round(day.pnl1x, 2), pnl2x: round(day.pnl2x, 2),
    })),
  };
}

function summarizeExperiment(rows) {
  const cells = [];
  const cellKeys = [...new Set(rows.map((row) => `${row.arm}|${row.latency_ms}`))].sort();
  for (const cellKey of cellKeys) {
    const [arm, latency] = cellKey.split('|');
    const subset = rows.filter((row) => row.arm === arm && String(row.latency_ms) === latency);
    for (const horizonSeconds of HORIZONS_SECONDS) {
      const summary = summarizeCell(subset, horizonSeconds);
      cells.push({ arm, latencyMs: parseInt(latency, 10), horizonSeconds, ...summary });
    }
  }
  const adjusted = holmAdjust(cells.map((cell) => cell.conservativeOneSidedP));
  const serialized = cells.map((cell, index) => {
    const value = serializeCell(cell);
    value.holmAdjustedP = round(adjusted[index], 6);
    value.passesFrozenRule = value.independentSweeps >= 300
      && value.calendarDays >= 30
      && value.qualityCoverage >= 0.9
      && value.pnl1x > 0
      && value.pnl2x > 0
      && value.chronologicalHalves.every((half) => half.pnl1x > 0 && half.pnl2x > 0)
      && value.marketClustered1x.ci95[0] > 0
      && value.dayClustered1x.ci95[0] > 0
      && value.marketClustered2x.ci95[0] > 0
      && value.dayClustered2x.ci95[0] > 0
      && value.holmAdjustedP <= 0.05;
    return value;
  });
  return {
    format: 'flow-evidence-report-v1',
    generatedAt: new Date().toISOString(),
    strategyVersion: STRATEGY_VERSION,
    familyWiseTests: serialized.length,
    primaryMetric: '5-second executable-bid markout after exact round-trip taker fees',
    stressMetric: 'same markout with entry and exit fees doubled',
    warning: 'Arms, latencies and horizons share triggers and capital; never sum them as a portfolio.',
    frozenRule: '>=300 independent sweeps/cell, >=30 days, both chronological halves positive at 1x and 2x costs, market/day clustered lower bounds >0, Holm-adjusted p<=0.05.',
    cells: serialized,
    primaryCells: serialized.filter((cell) => cell.horizonSeconds === 5),
  };
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
      SELECT s.id AS score_id,s.trigger_key,s.condition_id,s.available_at,s.arm,s.latency_ms,
             sc.filled,sc.entry_price,sc.fill_size,sc.markouts,sc.data_quality_grade,
             m.question,m.slug
        FROM pm_flow_signals s
        JOIN pm_flow_scores sc ON sc.signal_id=s.id
        LEFT JOIN pm_flow_markets m ON m.condition_id=s.condition_id
       WHERE s.features->>'strategy_version'=$1
       ORDER BY s.available_at,s.id`, [STRATEGY_VERSION]);
    const output = summarizeExperiment(rows);
    if (process.argv.includes('--json')) console.log(JSON.stringify(output, null, 2));
    else {
      console.log(`FLOW ${STRATEGY_VERSION} EVIDENCE — ${output.generatedAt}`);
      console.log(output.warning);
      console.table(output.primaryCells.map((cell) => ({
        arm: cell.arm,
        latency_ms: cell.latencyMs,
        sweeps: cell.independentSweeps,
        fills: cell.fills,
        days: cell.calendarDays,
        pnl_1x: cell.pnl1x,
        pnl_2x: cell.pnl2x,
        half_1_1x: cell.chronologicalHalves[0].pnl1x,
        half_2_1x: cell.chronologicalHalves[1].pnl1x,
        market_ci_low_1x: cell.marketClustered1x.ci95[0],
        day_ci_low_1x: cell.dayClustered1x.ci95[0],
        holm_p: cell.holmAdjustedP,
        passes: cell.passesFrozenRule,
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
  groupIndependentSweeps,
  markoutPnl,
  summarizeCell,
  summarizeExperiment,
  utcDay,
};
