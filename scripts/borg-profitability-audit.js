#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const serviceEnv = process.env.TV2_ENV_FILE || '/etc/deltaforge/tv2.env';
if (!process.env.DATABASE_URL && fs.existsSync(serviceEnv)) {
  require('dotenv').config({ path: serviceEnv });
}
const { createResearchPool } = require('./lib/research-pool');
const {
  clusterSignFlipPValue,
  clusteredBootstrap,
  holmAdjust,
  wilsonInterval,
} = require('../borg/research/statistics');
const {
  promotionEligibleRow,
  summarizeConcentration,
} = require('../borg/research/promotion-policy');
const {
  RESEARCH_CAPITAL_VERSION,
} = require('../borg/research/capital-policy');

const HORIZONS = Object.freeze([
  ['6h', 6 * 60 * 60 * 1000],
  ['24h', 24 * 60 * 60 * 1000],
  ['3d', 3 * 24 * 60 * 60 * 1000],
  ['7d', 7 * 24 * 60 * 60 * 1000],
]);

function number(value, fallback = 0) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 2) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? +parsed.toFixed(digits) : null;
}

function utcDay(value) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
}

function aggregateMarkets(rows) {
  const markets = new Map();
  for (const row of rows) {
    if (row.market_id == null) continue;
    const key = String(row.market_id);
    const existing = markets.get(key) || {
      marketId: key,
      firstAt: row.available_at,
      pnl1x: 0,
      pnl2x: 0,
    };
    if (new Date(row.available_at) < new Date(existing.firstAt)) {
      existing.firstAt = row.available_at;
    }
    existing.pnl1x += number(row.pnl_1x);
    existing.pnl2x += number(row.pnl_2x);
    markets.set(key, existing);
  }
  return [...markets.values()]
    .sort((left, right) => new Date(left.firstAt) - new Date(right.firstAt));
}

function horizonMetrics(rows, now = new Date()) {
  const nowMs = now.getTime();
  return Object.fromEntries(HORIZONS.map(([label, durationMs]) => {
    const cohort = rows.filter((row) => {
      const at = new Date(row.available_at).getTime();
      return Number.isFinite(at) && at >= nowMs - durationMs && at <= nowMs;
    });
    return [label, {
      fills: cohort.length,
      markets: new Set(cohort.map((row) => String(row.market_id))).size,
      pnl1x: round(cohort.reduce((sum, row) => sum + number(row.pnl_1x), 0)),
      pnl2x: round(cohort.reduce((sum, row) => sum + number(row.pnl_2x), 0)),
    }];
  }));
}

function summarizeArm(rows, trial = null, now = new Date(), { scope = 'current' } = {}) {
  const filled = rows.filter((row) => row.filled === true);
  const eligible = filled.filter(promotionEligibleRow);
  const markets = aggregateMarkets(eligible);
  const midpoint = Math.floor(markets.length / 2);
  const wins = eligible.filter((row) => number(row.pnl_1x) > 0).length;
  const marketCi = clusteredBootstrap(eligible, 'market_id', 'pnl_2x');
  const dayCi = clusteredBootstrap(eligible, (row) => utcDay(row.available_at), 'pnl_2x');
  const marketP = clusterSignFlipPValue(eligible, 'market_id', 'pnl_2x');
  const dayP = clusterSignFlipPValue(eligible, (row) => utcDay(row.available_at), 'pnl_2x');
  const pnl2x = eligible.reduce((sum, row) => sum + number(row.pnl_2x), 0);
  const status = trial?.status || 'UNREGISTERED';
  let interpretation = 'NEGATIVE_OR_ZERO_DIAGNOSTIC';
  if (scope === 'diagnostic' && pnl2x > 0) {
    interpretation = 'POSITIVE_DIAGNOSTIC_REQUIRES_NEW_FROZEN_TRIAL';
  } else if (status === 'COLLECTING' && trial?.phase === 'eval') {
    interpretation = pnl2x > 0
      ? 'CURRENT_FORWARD_LEAD_UNVALIDATED'
      : 'CURRENT_FORWARD_NO_POSITIVE_EDGE';
  } else if (pnl2x > 0) {
    interpretation = 'POSITIVE_DIAGNOSTIC_REQUIRES_NEW_FROZEN_TRIAL';
  }
  return {
    strategy: rows[0]?.strategy || trial?.strategy || null,
    phase: rows[0]?.phase || trial?.phase || null,
    trialStatus: status,
    statusReason: trial?.status_reason || null,
    rawFills: filled.length,
    rawPnl1x: round(filled.reduce((sum, row) => sum + number(row.pnl_1x), 0)),
    rawPnl2x: round(filled.reduce((sum, row) => sum + number(row.pnl_2x), 0)),
    eligibleFills: eligible.length,
    independentMarkets: markets.length,
    calendarDays: new Set(eligible.map((row) => utcDay(row.available_at))).size,
    wins,
    winRate: eligible.length ? round(wins / eligible.length, 4) : null,
    winWilson95: wilsonInterval(wins, eligible.length).map((value) => round(value, 4)),
    pnl1x: round(eligible.reduce((sum, row) => sum + number(row.pnl_1x), 0)),
    pnl2x: round(pnl2x),
    firstHalfPnl2x: round(markets.slice(0, midpoint)
      .reduce((sum, row) => sum + row.pnl2x, 0)),
    secondHalfPnl2x: round(markets.slice(midpoint)
      .reduce((sum, row) => sum + row.pnl2x, 0)),
    marketClusteredMeanCi95: marketCi.ci.map((value) => round(value, 4)),
    dayClusteredMeanCi95: dayCi.ci.map((value) => round(value, 4)),
    conservativeOneSidedP: round(Math.max(marketP, dayP), 6),
    horizons: horizonMetrics(eligible, now),
    concentration: summarizeConcentration(eligible),
    firstAt: eligible[0]?.available_at || null,
    latest: eligible.at(-1)?.available_at || null,
    interpretation,
  };
}

function isCurrentTrialRow(row, trial, evidenceEpoch = null) {
  if (!row || !trial) return false;
  const availableAt = new Date(row.available_at).getTime();
  const evidenceStartedAt = new Date(trial.evidence_started_at).getTime();
  const epochStartedAt = evidenceEpoch
    ? new Date(evidenceEpoch.startedAt).getTime()
    : evidenceStartedAt;
  return row.strategy === trial.strategy
    && row.experiment_id === trial.experiment_id
    && String(row.arm || 'baseline') === String(trial.variant || 'baseline')
    && row.phase === trial.phase
    && (!evidenceEpoch || row.collection_epoch_id === evidenceEpoch.id)
    && Number.isFinite(availableAt)
    && Number.isFinite(evidenceStartedAt)
    && Number.isFinite(epochStartedAt)
    && availableAt >= Math.max(evidenceStartedAt, epochStartedAt);
}

function money(value) {
  const parsed = number(value);
  return `${parsed < 0 ? '-' : '+'}$${Math.abs(parsed).toFixed(2)}`;
}

function markdown(report) {
  const lines = [
    `# BORG profitability audit — ${report.generatedAt}`,
    '',
    `Cohort: \`${report.researchCapitalVersion}\`. Displayed P&L uses only fills with both data-quality and execution-fidelity grades A/B. Current-trial horizons are based on signal availability time. Arms reuse markets and capital, so they must not be summed.`,
    '',
    `Holm family-wise correction covers ${report.multipleTestingArms} strategy/phase arms. No row is a live-profitability claim.`,
    '',
    '| Strategy | Phase | Governance | Historical diagnostic 2× | Current trial n / markets / days | Current 1× | Current 2× | 6h | 24h | 3d | 7d | Current halves 2× | Holm p | Read |',
    '|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|',
  ];
  for (const row of report.arms) {
    const current = row.currentTrial;
    lines.push(`| \`${row.strategy}\` | ${row.phase} | ${current.trialStatus} | ${money(row.pnl2x)} | ${current.eligibleFills} / ${current.independentMarkets} / ${current.calendarDays} | ${money(current.pnl1x)} | ${money(current.pnl2x)} | ${money(current.horizons['6h'].pnl1x)} (${current.horizons['6h'].fills}) | ${money(current.horizons['24h'].pnl1x)} (${current.horizons['24h'].fills}) | ${money(current.horizons['3d'].pnl1x)} (${current.horizons['3d'].fills}) | ${money(current.horizons['7d'].pnl1x)} (${current.horizons['7d'].fills}) | ${money(current.firstHalfPnl2x)} / ${money(current.secondHalfPnl2x)} | ${current.holmAdjustedP.toFixed(4)} | ${current.interpretation} |`);
  }
  return `${lines.join('\n')}\n`;
}

async function buildReport(pool, { now = new Date() } = {}) {
  const [{ rows }, { rows: trialRows }, trialCount, { rows: epochRows }] = await Promise.all([
    pool.query(`
      SELECT o.strategy,o.phase,o.market_id,o.available_at,
             o.experiment_id,COALESCE(o.arm,'baseline') arm,
             o.features->>'collection_epoch_id' collection_epoch_id,
             COALESCE(m.asset,'unknown') asset,
             s.filled,s.pnl_1x::float8 pnl_1x,s.pnl_2x::float8 pnl_2x,
             COALESCE(s.data_quality_grade,'F') data_quality_grade,
             COALESCE(s.execution_fidelity_grade,'F') execution_fidelity_grade
        FROM borg_shadow_orders o
        JOIN borg_shadow_scores s ON s.order_id=o.id
        LEFT JOIN borg_markets m ON m.id=o.market_id
       WHERE o.action='place'
         AND o.features->>'research_capital_version'=$1
       ORDER BY o.strategy,o.phase,o.available_at,o.id`,
    [RESEARCH_CAPITAL_VERSION]),
    pool.query(`
      SELECT DISTINCT ON (strategy)
             strategy,phase,status,status_reason,experiment_id,variant,
             frozen_at,evidence_started_at
        FROM borg_trial_ledger
       ORDER BY strategy,frozen_at DESC,id DESC`),
    pool.query(`SELECT count(*)::int trials FROM borg_trial_ledger`),
    pool.query(`
      SELECT r.epoch_id id,e.started_at
        FROM borg_collector_runs r
        JOIN borg_collection_epochs e ON e.epoch_id=r.epoch_id
       WHERE r.status='RUNNING'
       ORDER BY r.started_at DESC
       LIMIT 1`),
  ]);
  const evidenceEpoch = epochRows[0] ? {
    id: epochRows[0].id,
    startedAt: new Date(epochRows[0].started_at).toISOString(),
  } : null;
  const latestTrial = new Map(trialRows.map((row) => [row.strategy, row]));
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.strategy}\u0000${row.phase}`;
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  for (const trial of trialRows) {
    const key = `${trial.strategy}\u0000${trial.phase}`;
    if (!groups.has(key)) groups.set(key, []);
  }
  const arms = [...groups.entries()].map(([key, group]) => {
    const [strategy, phase] = key.split('\u0000');
    const trial = latestTrial.get(strategy) || {
      strategy, phase, status: 'UNREGISTERED', variant: 'baseline',
    };
    const diagnostic = summarizeArm(group, trial, now, { scope: 'diagnostic' });
    const currentRows = group.filter((row) =>
      isCurrentTrialRow(row, trial, evidenceEpoch));
    diagnostic.currentTrial = summarizeArm(currentRows, trial, now);
    return diagnostic;
  });
  const diagnosticAdjusted = holmAdjust(arms.map((row) => row.conservativeOneSidedP));
  const currentAdjusted = holmAdjust(arms.map((row) =>
    row.currentTrial.conservativeOneSidedP));
  arms.forEach((row, index) => {
    row.holmAdjustedP = round(diagnosticAdjusted[index], 6);
    row.currentTrial.holmAdjustedP = round(currentAdjusted[index], 6);
  });
  arms.sort((left, right) => right.pnl2x - left.pnl2x);
  return {
    format: 'borg-profitability-audit-v1',
    generatedAt: now.toISOString(),
    researchCapitalVersion: RESEARCH_CAPITAL_VERSION,
    registeredTrials: parseInt(trialCount.rows[0]?.trials, 10) || 0,
    multipleTestingArms: arms.length,
    evidenceEpoch,
    accounting: 'Joint A/B data-and-execution fills; 1x and doubled-cost 2x PnL; entry-time horizons.',
    warning: 'Arms overlap in markets, tape and hypothetical capital. Never add arm PnL into a portfolio total.',
    arms,
  };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error(`DATABASE_URL is missing; set it in .env or ${serviceEnv}`);
  }
  const pool = createResearchPool({ applicationName: 'borg-profitability-audit' });
  try {
    const report = await buildReport(pool);
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      process.stdout.write(markdown(report));
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = {
  aggregateMarkets,
  buildReport,
  horizonMetrics,
  isCurrentTrialRow,
  markdown,
  summarizeArm,
};
