#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { createResearchPool } = require('./lib/research-pool');
const {
  clusterSignFlipPValue,
  clusteredBootstrap,
  holmAdjust,
} = require('../borg/research/statistics');
const { assessEvidenceEpoch } = require('../borg/research/evidence-epoch');
const { simulatePortfolio } = require('../borg/research/portfolio-simulator');
const {
  evaluatePromotion,
  promotionEligibleRow,
  summarizeConcentration,
  summarizeLatencyProfiles,
} = require('../borg/research/promotion-policy');

function round(value, digits = 4) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? +parsed.toFixed(digits) : null;
}

function finite(value, fallback = null) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function usesDoubledCosts(primaryMetric) {
  return /(?:^|_)pnl_2x(?:_|$)/.test(String(primaryMetric || ''));
}

function utcDay(value) {
  const time = new Date(value);
  return Number.isFinite(time.getTime()) ? time.toISOString().slice(0, 10) : null;
}

function trialKey(trial) {
  return [trial.experiment_id, trial.strategy, trial.variant, trial.phase].join('::');
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

function summarizeTrial(trial, rows, latencyRows = []) {
  const validRows = rows.filter(promotionEligibleRow);
  const independentMarkets = new Set(validRows.filter((row) => row.market_id != null)
    .map((row) => String(row.market_id))).size;
  const days = new Set(validRows.map((row) => new Date(row.available_at).toISOString().slice(0, 10))).size;
  // Promotion is always evaluated at doubled costs. A legacy manifest's
  // display metric may remain 1x, but it cannot weaken the desk-wide gate.
  const metricField = 'pnl_2x';
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
    latencyProfiles: summarizeLatencyProfiles(latencyRows),
    concentration: summarizeConcentration(validRows),
    marketClusteredOneSidedP: round(marketP, 6),
    dayClusteredOneSidedP: round(dayP, 6),
    conservativeOneSidedP: round(rawP, 6),
    _rawP: rawP,
    _trialKey: trialKey(trial),
  };
}

async function main() {
  const pool = createResearchPool({ applicationName: 'promotion-report' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const evidenceEpoch = await assessEvidenceEpoch(client);
    const evidenceCutoff = evidenceEpoch.epoch?.startedAt || new Date(0).toISOString();
    const evidenceEpochId = evidenceEpoch.epoch?.id || '__NO_ACTIVE_EPOCH__';
    const { rows: trials } = await client.query(`
      SELECT * FROM borg_trial_ledger ORDER BY family, strategy, variant`);
    const summaries = [];
    const rowsByTrial = new Map();
    for (const trial of trials) {
      const { rows } = await client.query(`
        SELECT o.id AS order_id,o.market_id,o.available_at,o.latency_profile,
               o.price AS intended_price,o.size AS intended_size,o.token,o.features,
               COALESCE(m.asset,'unknown') AS asset,m.window_end,m.resolved_at,
               s.filled,s.fill_ts,s.fill_price,s.fill_size,s.detail,
               COALESCE(s.pnl_1x,0)::float8 AS pnl_1x,
               COALESCE(s.pnl_2x,0)::float8 AS pnl_2x,
               COALESCE(s.data_quality_grade,'F') AS data_quality_grade,
               COALESCE(s.execution_fidelity_grade,'F') AS execution_fidelity_grade
        FROM borg_shadow_orders o
        JOIN borg_shadow_scores s ON s.order_id=o.id
        JOIN borg_markets m ON m.id=o.market_id
        WHERE o.experiment_id=$1 AND o.strategy=$2 AND COALESCE(o.arm,'baseline')=$3
          AND o.phase=$4 AND o.available_at >= GREATEST($5::timestamptz,$6::timestamptz)
          AND o.features->>'collection_epoch_id'=$7
        ORDER BY o.available_at, o.id`,
      [trial.experiment_id, trial.strategy, trial.variant, trial.phase,
        trial.evidence_started_at, evidenceCutoff, evidenceEpochId]);
      const { rows: latencyRows } = await client.query(`
        SELECT l.order_id,o.market_id,o.available_at,l.latency_ms,
               l.pnl_1x::float8 AS pnl_1x,l.pnl_2x::float8 AS pnl_2x,
               l.data_quality_grade,l.execution_fidelity_grade
          FROM borg_shadow_latency_scores l
          JOIN borg_shadow_orders o ON o.id=l.order_id
         WHERE o.experiment_id=$1 AND o.strategy=$2 AND COALESCE(o.arm,'baseline')=$3
           AND o.phase=$4 AND o.available_at >= GREATEST($5::timestamptz,$6::timestamptz)
           AND o.features->>'collection_epoch_id'=$7
         ORDER BY o.available_at,o.id,l.latency_ms`,
      [trial.experiment_id, trial.strategy, trial.variant, trial.phase,
        trial.evidence_started_at, evidenceCutoff, evidenceEpochId]);
      rowsByTrial.set(trialKey(trial), { trial, rows, latencyRows });
      summaries.push(summarizeTrial(trial, rows, latencyRows));
    }

    const portfolioRecords = [];
    for (const { trial, rows } of rowsByTrial.values()) {
      if (trial.status !== 'COLLECTING' || trial.phase !== 'eval') continue;
      const strategy = trialKey(trial);
      for (const row of rows.filter(promotionEligibleRow)) {
        portfolioRecords.push({
          orderId: row.order_id,
          strategy,
          marketId: row.market_id,
          token: row.token,
          filled: row.filled === true,
          fillTs: row.fill_ts || row.available_at,
          availableAt: row.available_at,
          fillPrice: row.fill_price,
          fillSize: row.fill_size,
          // Drive both cash evolution and attribution with the conservative
          // doubled-cost result. This prevents a profitable 1x path from
          // admitting trades that a 2x-cost bankroll could not fund.
          pnl1x: row.pnl_2x,
          pnl2x: row.pnl_2x,
          settleAt: row.resolved_at || row.window_end,
          capacityAtArrival: row.detail?.capacity_at_arrival,
          detail: row.detail,
        });
      }
    }
    const sharedPortfolio = simulatePortfolio(portfolioRecords, { startingBankroll: 500 });
    const admittedByStrategy = sharedPortfolio.decisions
      .filter((decision) => decision.accepted)
      .reduce((out, decision) => {
        out[decision.strategy] = (out[decision.strategy] || 0) + 1;
        return out;
      }, {});
    const adjusted = holmAdjust(summaries.map((summary) => summary._rawP));
    for (let index = 0; index < summaries.length; index += 1) {
      const summary = summaries[index];
      summary.holmAdjustedP = round(adjusted[index], 6);
      const shared500 = {
        admittedOrders: admittedByStrategy[summary._trialKey] || 0,
        pnl2x: finite(sharedPortfolio.pnlByStrategy[summary._trialKey], 0),
      };
      shared500.pass = shared500.admittedOrders > 0 && shared500.pnl2x > 0;
      const decision = evaluatePromotion(summary, {
        holmAdjustedP: adjusted[index],
        evidenceEpoch,
        shared500,
      });
      summary.verdict = decision.verdict;
      summary.promotionGates = decision.gates;
      summary.shared500 = decision.shared500;
      summary.canaryContract = decision.canaryContract;
      delete summary._rawP;
      delete summary._trialKey;
    }
    const output = {
      format: 'borg-promotion-report-v2',
      createdAt: new Date().toISOString(),
      multipleTesting: `Holm family-wise correction across ${summaries.length} registered strategy arms`,
      evidenceEpoch,
      sharedPortfolio500DoubledCosts: {
        ...sharedPortfolio,
        decisions: undefined,
        interpretation: 'All collecting eval arms compete chronologically for one shared $500 bankroll; cash evolves using doubled-cost PnL.',
      },
      rule: 'No automatic live promotion. Every mechanical gate must pass before human review of a 50-fill $1-$2 authenticated canary.',
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
