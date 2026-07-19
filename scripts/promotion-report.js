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

function round(value, digits = 4) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? +parsed.toFixed(digits) : null;
}

function usesDoubledCosts(primaryMetric) {
  return /(?:^|_)pnl_2x(?:_|$)/.test(String(primaryMetric || ''));
}

function utcDay(value) {
  const time = new Date(value);
  return Number.isFinite(time.getTime()) ? time.toISOString().slice(0, 10) : null;
}

function aggregateIndependentMarkets(rows) {
  const markets = new Map();
  for (const row of rows) {
    if (row.market_id == null) continue;
    const key = String(row.market_id);
    const prior = markets.get(key) || {
      marketId: key,
      firstAt: row.available_at,
      pnl1x: 0,
      pnl2x: 0,
    };
    if (new Date(row.available_at) < new Date(prior.firstAt)) prior.firstAt = row.available_at;
    prior.pnl1x += parseFloat(row.pnl_1x) || 0;
    prior.pnl2x += parseFloat(row.pnl_2x) || 0;
    markets.set(key, prior);
  }
  return [...markets.values()].sort((left, right) => new Date(left.firstAt) - new Date(right.firstAt));
}

function summarizeTrial(trial, rows) {
  const validRows = rows.filter((row) => row.data_quality_grade !== 'F');
  const independentMarkets = new Set(validRows.map((row) => String(row.market_id))).size;
  const days = new Set(validRows.map((row) => new Date(row.available_at).toISOString().slice(0, 10))).size;
  const metricField = usesDoubledCosts(trial.primary_metric) ? 'pnl_2x' : 'pnl_1x';
  // Market/window and UTC-day dependence are both decision-relevant. Report
  // both clusterings and use the less favourable p-value/lower bound for the
  // promotion read. Treating repeated signals or one busy day as independent
  // observations would materially overstate precision.
  const marketClustered = clusteredBootstrap(validRows, 'market_id', metricField);
  const dayClustered = clusteredBootstrap(validRows, (row) => utcDay(row.available_at), metricField);
  const marketP = clusterSignFlipPValue(validRows, 'market_id', metricField);
  const dayP = clusterSignFlipPValue(validRows, (row) => utcDay(row.available_at), metricField);
  const rawP = Math.max(marketP, dayP);
  const pnl1x = validRows.reduce((sum, row) => sum + (parseFloat(row.pnl_1x) || 0), 0);
  const pnl2x = validRows.reduce((sum, row) => sum + (parseFloat(row.pnl_2x) || 0), 0);
  const ordered = aggregateIndependentMarkets(validRows);
  const split = Math.floor(ordered.length / 2);
  const firstHalfPnl1x = ordered.slice(0, split).reduce((sum, row) => sum + row.pnl1x, 0);
  const secondHalfPnl1x = ordered.slice(split).reduce((sum, row) => sum + row.pnl1x, 0);
  const firstHalfPnl2x = ordered.slice(0, split).reduce((sum, row) => sum + row.pnl2x, 0);
  const secondHalfPnl2x = ordered.slice(split).reduce((sum, row) => sum + row.pnl2x, 0);
  const byAsset = {};
  for (const asset of [...new Set(validRows.map((row) => row.asset || 'unknown'))].sort()) {
    const subset = validRows.filter((row) => (row.asset || 'unknown') === asset);
    byAsset[asset] = {
      signals: subset.length,
      independentMarkets: new Set(subset.map((row) => String(row.market_id))).size,
      pnl1x: round(subset.reduce((sum, row) => sum + (parseFloat(row.pnl_1x) || 0), 0), 2),
      pnl2x: round(subset.reduce((sum, row) => sum + (parseFloat(row.pnl_2x) || 0), 0), 2),
    };
  }
  const qualityCoverage = rows.length ? validRows.length / rows.length : 0;
  return {
    experimentId: trial.experiment_id,
    strategy: trial.strategy,
    family: trial.family,
    variant: trial.variant,
    phase: trial.phase,
    trialStatus: trial.status,
    statusReason: trial.status_reason || null,
    primaryMetric: trial.primary_metric,
    intendedSignals: rows.length,
    independentMarkets,
    calendarDays: days,
    minimumIndependentMarkets: parseInt(trial.min_independent_markets, 10),
    minimumDays: parseInt(trial.min_days, 10),
    qualityCoverage: round(qualityCoverage),
    pnl1x: round(pnl1x, 2),
    pnl2x: round(pnl2x, 2),
    meanPnlPerSignal: round(marketClustered.mean),
    marketClusters: marketClustered.clusters,
    dayClusters: dayClustered.clusters,
    marketClusteredCi95: marketClustered.ci.map((value) => round(value)),
    dayClusteredCi95: dayClustered.ci.map((value) => round(value)),
    firstHalfPnl1x: round(firstHalfPnl1x, 2),
    secondHalfPnl1x: round(secondHalfPnl1x, 2),
    firstHalfPnl2x: round(firstHalfPnl2x, 2),
    secondHalfPnl2x: round(secondHalfPnl2x, 2),
    byAsset,
    marketClusteredOneSidedP: round(marketP, 6),
    dayClusteredOneSidedP: round(dayP, 6),
    conservativeOneSidedP: round(rawP, 6),
    _rawP: rawP,
  };
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows: trials } = await client.query(`
      SELECT * FROM borg_trial_ledger ORDER BY family, strategy, variant`);
    const summaries = [];
    for (const trial of trials) {
      const { rows } = await client.query(`
        SELECT o.market_id, o.available_at, COALESCE(m.asset,'unknown') AS asset,
               COALESCE(s.pnl_1x,0)::float8 AS pnl_1x,
               COALESCE(s.pnl_2x,0)::float8 AS pnl_2x,
               COALESCE(s.data_quality_grade,'F') AS data_quality_grade,
               COALESCE(s.execution_fidelity_grade,'F') AS execution_fidelity_grade
        FROM borg_shadow_orders o
        JOIN borg_shadow_scores s ON s.order_id=o.id
        JOIN borg_markets m ON m.id=o.market_id
        WHERE o.experiment_id=$1 AND o.strategy=$2 AND COALESCE(o.arm,'baseline')=$3
          AND o.phase=$4 AND o.available_at >= $5
        ORDER BY o.available_at, o.id`,
      [trial.experiment_id, trial.strategy, trial.variant, trial.phase, trial.evidence_started_at]);
      summaries.push(summarizeTrial(trial, rows));
    }

    const adjusted = holmAdjust(summaries.map((summary) => summary._rawP));
    for (let index = 0; index < summaries.length; index += 1) {
      const summary = summaries[index];
      summary.holmAdjustedP = round(adjusted[index], 6);
      const enoughSample = summary.independentMarkets >= summary.minimumIndependentMarkets
        && summary.calendarDays >= summary.minimumDays;
      const firstHalfPrimary = usesDoubledCosts(summary.primaryMetric)
        ? summary.firstHalfPnl2x : summary.firstHalfPnl1x;
      const secondHalfPrimary = usesDoubledCosts(summary.primaryMetric)
        ? summary.secondHalfPnl2x : summary.secondHalfPnl1x;
      const evidencePass = summary.qualityCoverage >= 0.9
        && summary.marketClusteredCi95[0] > 0
        && summary.dayClusteredCi95[0] > 0
        && summary.pnl2x > 0
        && firstHalfPrimary > 0
        && secondHalfPrimary > 0
        && adjusted[index] <= 0.05;
      summary.verdict = summary.trialStatus !== 'COLLECTING' ? summary.trialStatus
        : summary.phase !== 'eval' ? 'PILOT_NOT_EVIDENCE'
        : !enoughSample ? 'INSUFFICIENT_SAMPLE'
          : evidencePass ? 'ELIGIBLE_FOR_TINY_CANARY_REVIEW' : 'REJECTED_OR_NO_DEMONSTRATED_EDGE';
      delete summary._rawP;
    }
    const output = {
      format: 'borg-promotion-report-v1',
      createdAt: new Date().toISOString(),
      multipleTesting: `Holm family-wise correction across ${summaries.length} registered strategy arms`,
      rule: 'No automatic live promotion. An eligible result permits human review of a separately capped canary only.',
      zeroEdgeDisclosure: 'If confidence intervals include zero, the measured edge is treated as unproven even when headline PnL is positive.',
      trials: summaries,
    };
    console.log(JSON.stringify(output, null, 2));
    await client.query('ROLLBACK');
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message); process.exit(1);
});

module.exports = {
  aggregateIndependentMarkets,
  summarizeTrial,
  usesDoubledCosts,
  utcDay,
};
