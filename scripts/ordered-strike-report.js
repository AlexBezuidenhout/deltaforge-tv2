#!/usr/bin/env node
'use strict';

require('dotenv').config();

const { createResearchPool } = require('./lib/research-pool');
const { clusteredBootstrap } = require('../borg/research/statistics');
const {
  ORDERED_STRIKE_EVIDENCE_START,
  ORDERED_STRIKE_EXPERIMENT_ID,
} = require('../borg/structural/experiment');

function finite(value, fallback = null) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function summarizePassive(rows) {
  const normalized = rows.map((row) => ({
    ...row,
    pnl2x: finite(row.locked_pnl_2x_usd),
    filled: row.filled_at != null,
    closed: row.closed_at != null,
    candidateKey: String(row.candidate_id),
    dayKey: new Date(row.quoted_at).toISOString().slice(0, 10),
  }));
  const scored = normalized.filter((row) => row.closed && row.pnl2x != null);
  const ordered = [...scored].sort((left, right) =>
    new Date(left.quoted_at) - new Date(right.quoted_at));
  const split = Math.floor(ordered.length / 2);
  const sum = (items) => items.reduce((total, row) => total + row.pnl2x, 0);
  const days = new Set(ordered.map((row) => row.dayKey));
  return {
    quotes: normalized.length,
    closedQuotes: scored.length,
    fills: normalized.filter((row) => row.filled).length,
    independentCandidates: new Set(normalized.map((row) => row.candidateKey)).size,
    calendarDays: days.size,
    pnl2xUsd: sum(ordered),
    firstHalfPnl2xUsd: sum(ordered.slice(0, split)),
    secondHalfPnl2xUsd: sum(ordered.slice(split)),
    positiveClosedQuotes: scored.filter((row) => row.pnl2x > 0).length,
    negativeClosedQuotes: scored.filter((row) => row.pnl2x < 0).length,
    orphanFills: normalized.filter((row) => String(row.status).includes('ORPHAN')).length,
    candidateClusteredMeanCi95: clusteredBootstrap(scored, 'candidateKey', 'pnl2x', {
      iterations: 4000,
    }),
    dayClusteredMeanCi95: clusteredBootstrap(scored, 'dayKey', 'pnl2x', {
      iterations: 4000,
    }),
  };
}

async function buildReport(pool) {
  const [trialResult, catalogResult, evaluationResult, passiveResult] = await Promise.all([
    pool.query(`SELECT * FROM borg_trial_ledger
      WHERE experiment_id=$1 ORDER BY registered_at DESC LIMIT 1`,
    [ORDERED_STRIKE_EXPERIMENT_ID]),
    pool.query(`SELECT count(*)::int candidates,
                       count(*) FILTER (WHERE active)::int active_candidates,
                       count(*) FILTER (WHERE rule_certified)::int rule_certified,
                       max(refreshed_at) latest
                  FROM borg_structural_candidates
                 WHERE structure_type='nested_threshold'`),
    pool.query(`SELECT latency_ms,count(*)::int evaluations,
                       count(DISTINCT candidate_id)::int independent_candidates,
                       count(DISTINCT (evaluated_at AT TIME ZONE 'UTC')::date)::int calendar_days,
                       count(*) FILTER (WHERE pass_proof)::int payoff_proved,
                       count(*) FILTER (WHERE pass_rule_certification)::int rule_certified,
                       count(*) FILTER (WHERE economic_candidate)::int arithmetic_economic,
                       count(*) FILTER (WHERE qualified)::int orphan_safe_qualified,
                       max(displayed_profit_2x_usd)::float max_displayed_profit_2x,
                       max(orphan_safe_profit_2x_usd)::float max_orphan_safe_profit_2x,
                       max(evaluated_at) latest
                  FROM borg_structural_evaluations
                 WHERE experiment_id=$1 AND evaluated_at >= $2
                 GROUP BY latency_ms ORDER BY latency_ms`,
    [ORDERED_STRIKE_EXPERIMENT_ID, ORDERED_STRIKE_EVIDENCE_START]),
    pool.query(`SELECT candidate_id,quoted_at,filled_at,closed_at,status,latency_ms,
                       shares::float,locked_pnl_2x_usd::float,
                       orphan_unwind_pnl_2x_usd::float,
                       data_quality_grade,execution_fidelity_grade
                  FROM borg_structural_passive_quotes
                 WHERE experiment_id=$1 AND quoted_at >= $2
                 ORDER BY quoted_at,quote_id`,
    [ORDERED_STRIKE_EXPERIMENT_ID, ORDERED_STRIKE_EVIDENCE_START]),
  ]);
  const passive = summarizePassive(passiveResult.rows);
  const lowerBounds = [
    passive.candidateClusteredMeanCi95.ci[0],
    passive.dayClusteredMeanCi95.ci[0],
  ];
  const promotionReady = passive.independentCandidates >= 300
    && passive.calendarDays >= 30
    && passive.firstHalfPnl2xUsd > 0
    && passive.secondHalfPnl2xUsd > 0
    && lowerBounds.every((value) => value != null && value > 0);
  return {
    generatedAt: new Date().toISOString(),
    experimentId: ORDERED_STRIKE_EXPERIMENT_ID,
    evidenceStartedAt: ORDERED_STRIKE_EVIDENCE_START,
    paperOnly: true,
    liveOrderPath: false,
    trial: trialResult.rows[0] || null,
    catalog: catalogResult.rows[0] || null,
    takerControl: {
      rows: evaluationResult.rows,
      warning: 'Displayed profits are opportunity diagnostics, not portfolio PnL; no atomic two-leg acknowledgement is simulated.',
    },
    passive,
    promotionReady,
    verdict: promotionReady ? 'APPLY_AUTHENTICATED_FILL_PILOT_REVIEW'
      : passive.quotes ? 'FRESH_FORWARD_TRIAL_INCOMPLETE' : 'NO_FRESH_QUALIFYING_QUOTES',
    caveats: [
      'Only nested-threshold rows created after the V1 evidence clock are included.',
      'A payoff proof removes terminal directional risk only after both legs fill; leg risk remains non-atomic.',
      'Paper queue position is C-grade until an authenticated user stream supplies real fills and cancel acknowledgements.',
      'Do not lower the proof, fee, depth, orphan-reserve or sample gates to create activity.',
    ],
  };
}

async function main() {
  const pool = createResearchPool({ applicationName: 'ordered-strike-report' });
  try {
    console.log(JSON.stringify(await buildReport(pool), null, 2));
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

module.exports = { buildReport, summarizePassive };
