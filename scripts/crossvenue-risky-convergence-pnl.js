#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const serviceEnv = process.env.TV2_ENV_FILE || '/etc/deltaforge/tv2.env';
if (!process.env.DATABASE_URL && fs.existsSync(serviceEnv)) {
  require('dotenv').config({ path: serviceEnv });
}
const { Pool } = require('pg');
const {
  CURRENT_CROSSVENUE_EXPERIMENT_ID,
} = require('../borg/crossvenue/experiment');

const HARD_MISMATCHES = new Set([
  'NUMERIC_OR_THRESHOLD_MISMATCH',
  'OUTCOME_PARTICIPANT_MISMATCH',
  'OUTCOME_PREDICATE_MISMATCH',
  'THRESHOLD_OPERATOR_MISMATCH',
  'OBSERVATION_TIME_MISMATCH',
  'MARKET_DIMENSION_MISMATCH',
  'SPORT_MISMATCH',
]);

const HORIZONS = Object.freeze([
  { label: '5m', ms: 5 * 60_000 },
  { label: '30m', ms: 30 * 60_000 },
  { label: '1h', ms: 60 * 60_000 },
  { label: '6h', ms: 6 * 60 * 60_000 },
  { label: '24h', ms: 24 * 60 * 60_000 },
]);

const TARGETS = Object.freeze([
  { label: 'TIMEOUT_ONLY', roi: null },
  { label: 'FIRST_BREAK_EVEN', roi: 0 },
  { label: 'TAKE_0_5PCT', roi: 0.005 },
  { label: 'TAKE_1PCT', roi: 0.01 },
]);

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function finite(value, fallback = null) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 4) {
  const parsed = finite(value);
  return parsed == null ? null : +parsed.toFixed(digits);
}

function mismatchClass(reasons) {
  const rows = Array.isArray(reasons) ? reasons.map(String) : [];
  if (rows.some((reason) => HARD_MISMATCHES.has(reason))) return 'HARD_MISMATCH';
  return rows.length ? 'SOFT_MISMATCH_ONLY' : 'NO_RECORDED_MISMATCH';
}

function edgeBucket(row) {
  const cost = finite(row.entry_total_cost);
  const edge = finite(row.terminal_locked_profit);
  const roi = cost > 0 && edge != null ? edge / cost : null;
  if (roi == null) return 'UNKNOWN';
  if (roi < 0.01) return '<1%';
  if (roi < 0.03) return '1-3%';
  if (roi < 0.10) return '3-10%';
  return '>=10%';
}

function classifyReplayRow(row) {
  const entryAt = Date.parse(row.entry_at);
  const coverageAt = Date.parse(row.coverage_last_at);
  const targetAt = Date.parse(row.target_exit_at);
  const timeoutAt = Date.parse(row.timeout_exit_at);
  const horizonMs = finite(row.horizon_ms, 0);
  const deadline = entryAt + horizonMs;
  const mature = Number.isFinite(coverageAt) && coverageAt >= deadline;
  const targetPnl = finite(row.target_exit_proceeds) == null
    ? null : finite(row.target_exit_proceeds) - finite(row.entry_total_cost, 0);
  const timeoutPnl = finite(row.timeout_exit_proceeds) == null
    ? null : finite(row.timeout_exit_proceeds) - finite(row.entry_total_cost, 0);
  let status = 'RIGHT_CENSORED';
  let exitAt = null;
  let pnl = null;
  if (Number.isFinite(targetAt)) {
    status = 'TARGET_EXIT';
    exitAt = targetAt;
    pnl = targetPnl;
  } else if (mature && Number.isFinite(timeoutAt)) {
    status = 'TIMEOUT_EXIT';
    exitAt = timeoutAt;
    pnl = timeoutPnl;
  } else if (mature) {
    status = 'NO_EXECUTABLE_TIMEOUT_EXIT';
  }
  const mismatchReasons = Array.isArray(row.mismatch_reasons)
    ? row.mismatch_reasons : [];
  return {
    ...row,
    entryAt,
    deadline,
    coverageAt: Number.isFinite(coverageAt) ? coverageAt : null,
    exitAt,
    mature,
    status,
    pnl,
    holdMs: exitAt == null ? null : Math.max(0, exitAt - entryAt),
    mismatchClass: mismatchClass(mismatchReasons),
    edgeBucket: edgeBucket(row),
    entryCost: finite(row.entry_total_cost, 0),
  };
}

function median(values) {
  const rows = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!rows.length) return null;
  const middle = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2;
}

function maxConcurrentCapital(rows) {
  const events = [];
  for (const row of rows) {
    const endAt = row.exitAt ?? row.coverageAt;
    if (!Number.isFinite(row.entryAt) || !Number.isFinite(endAt)
      || !(row.entryCost > 0)) continue;
    events.push([row.entryAt, row.entryCost]);
    events.push([Math.max(row.entryAt, endAt), -row.entryCost]);
  }
  events.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let current = 0;
  let maximum = 0;
  for (const [, delta] of events) {
    current += delta;
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

function summarize(rows) {
  const ordered = [...rows].sort((left, right) => left.entryAt - right.entryAt);
  const realized = ordered.filter((row) => Number.isFinite(row.pnl));
  const midpoint = Math.floor(realized.length / 2);
  const pnl = realized.map((row) => row.pnl);
  const totalPnl = pnl.reduce((sum, value) => sum + value, 0);
  const deployed = realized.reduce((sum, row) => sum + row.entryCost, 0);
  return {
    entries: ordered.length,
    pairs: new Set(ordered.map((row) => row.match_id)).size,
    calendarDays: new Set(ordered.map((row) =>
      new Date(row.entryAt).toISOString().slice(0, 10))).size,
    targetExits: ordered.filter((row) => row.status === 'TARGET_EXIT').length,
    timeoutExits: ordered.filter((row) => row.status === 'TIMEOUT_EXIT').length,
    rightCensored: ordered.filter((row) => row.status === 'RIGHT_CENSORED').length,
    noExecutableTimeoutExit: ordered.filter((row) =>
      row.status === 'NO_EXECUTABLE_TIMEOUT_EXIT').length,
    realized: realized.length,
    wins: realized.filter((row) => row.pnl > 0).length,
    losses: realized.filter((row) => row.pnl < 0).length,
    pnlUsd: round(totalPnl),
    meanPnlUsd: realized.length ? round(totalPnl / realized.length) : null,
    medianPnlUsd: round(median(pnl)),
    worstPnlUsd: realized.length ? round(Math.min(...pnl)) : null,
    bestPnlUsd: realized.length ? round(Math.max(...pnl)) : null,
    realizedRoiPct: deployed > 0 ? round(100 * totalPnl / deployed) : null,
    meanHoldMinutes: realized.length
      ? round(realized.reduce((sum, row) => sum + row.holdMs, 0)
        / realized.length / 60_000, 2) : null,
    firstHalfPnlUsd: round(realized.slice(0, midpoint)
      .reduce((sum, row) => sum + row.pnl, 0)),
    secondHalfPnlUsd: round(realized.slice(midpoint)
      .reduce((sum, row) => sum + row.pnl, 0)),
    maxConcurrentCapitalUsd: round(maxConcurrentCapital(ordered)),
  };
}

function groupSummary(rows, keys) {
  const groups = new Map();
  for (const row of rows) {
    const key = keys.map((field) => row[field]).join('\u0000');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()].map(([key, values]) => {
    const labels = key.split('\u0000');
    return {
      ...Object.fromEntries(keys.map((field, index) => [field, labels[index]])),
      ...summarize(values),
    };
  });
}

function sqlGrid() {
  const rows = [];
  for (const horizon of HORIZONS) {
    for (const target of TARGETS) {
      rows.push(`('${horizon.label}',${horizon.ms},'${target.label}',`
        + `${target.roi == null ? 'NULL' : target.roi})`);
    }
  }
  return rows.join(',\n');
}

async function queryReplay(pool, { days, experimentId }) {
  const { rows } = await pool.query(`
    WITH entries AS (
      SELECT DISTINCT ON (
               b.match_id,b.direction,(b.observed_at AT TIME ZONE 'UTC')::date
             )
             b.match_id,b.direction,b.quantity,b.observed_at entry_at,
             b.entry_total_cost::float8,b.terminal_locked_profit::float8,
             b.poly_entry_vwap::float8,b.kalshi_entry_vwap::float8,
             b.poly_entry_fee::float8,b.kalshi_entry_fee::float8,
             m.match_score::float8,m.paper_eval_score_at_approval::float8,
             m.mismatch_reasons,m.poly_question,m.kalshi_title,
             m.end_delta_hours::float8,m.metadata
        FROM cv_basis_samples b
        JOIN cv_contract_matches m USING(match_id)
       WHERE b.experiment_id=$1
         AND b.observed_at >= now()-($2||' days')::interval
         AND b.synchronized=true
         AND b.paper_entry_eligible=true
         AND b.books_fresh=true
         AND b.full_entry_depth=true
         AND b.data_quality_grade IN ('A','B')
         AND b.execution_fidelity_grade IN ('A','B')
       ORDER BY b.match_id,b.direction,
                (b.observed_at AT TIME ZONE 'UTC')::date,b.observed_at
    ),
    grid(horizon_label,horizon_ms,target_label,target_roi) AS (
      VALUES ${sqlGrid()}
    )
    SELECT e.*,g.*,
           coverage.last_at coverage_last_at,
           target.observed_at target_exit_at,
           target.net_liquidation_proceeds::float8 target_exit_proceeds,
           timeout.observed_at timeout_exit_at,
           timeout.net_liquidation_proceeds::float8 timeout_exit_proceeds
      FROM entries e
      CROSS JOIN grid g
      LEFT JOIN LATERAL (
        SELECT max(s.observed_at) last_at
          FROM cv_basis_samples s
         WHERE s.experiment_id=$1
           AND s.match_id=e.match_id AND s.direction=e.direction
           AND s.quantity=e.quantity AND s.observed_at>e.entry_at
      ) coverage ON true
      LEFT JOIN LATERAL (
        SELECT s.observed_at,s.net_liquidation_proceeds
          FROM cv_basis_samples s
         WHERE g.target_roi IS NOT NULL
           AND s.experiment_id=$1
           AND s.match_id=e.match_id AND s.direction=e.direction
           AND s.quantity=e.quantity
           AND s.observed_at>e.entry_at
           AND s.observed_at<=e.entry_at
             +(g.horizon_ms||' milliseconds')::interval
           AND s.synchronized=true AND s.books_fresh=true
           AND s.full_exit_depth=true
           AND s.data_quality_grade IN ('A','B')
           AND s.execution_fidelity_grade IN ('A','B')
           AND s.net_liquidation_proceeds
             >= e.entry_total_cost*(1+g.target_roi)
         ORDER BY s.observed_at
         LIMIT 1
      ) target ON true
      LEFT JOIN LATERAL (
        SELECT s.observed_at,s.net_liquidation_proceeds
          FROM cv_basis_samples s
         WHERE s.experiment_id=$1
           AND s.match_id=e.match_id AND s.direction=e.direction
           AND s.quantity=e.quantity
           AND s.observed_at>=e.entry_at
             +(g.horizon_ms||' milliseconds')::interval
           AND s.observed_at<=e.entry_at
             +(g.horizon_ms+60000||' milliseconds')::interval
           AND s.synchronized=true AND s.books_fresh=true
           AND s.full_exit_depth=true
           AND s.data_quality_grade IN ('A','B')
           AND s.execution_fidelity_grade IN ('A','B')
         ORDER BY s.observed_at
         LIMIT 1
      ) timeout ON true
     ORDER BY e.entry_at,e.match_id,e.direction,g.horizon_ms,g.target_label
  `, [experimentId, days]);
  return rows.map(classifyReplayRow);
}

function markdown(report) {
  const lines = [
    '# Cross-venue risky convergence PnL replay',
    '',
    `Generated ${report.generatedAt}. Window ${report.requestedDays} days; actual coverage ${report.coverage.firstAt || 'n/a'} to ${report.coverage.lastAt || 'n/a'}.`,
    '',
    'Paper-only synchronized L2 replay. Entry and liquidation VWAPs include both venue taker fees. Unmatured positions are right-censored, never credited as zero-PnL wins.',
    '',
    '| Match class | Horizon | Exit rule | Entries | Realized | Target | Censored | PnL | ROI | Halves | Mean hold |',
    '|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const row of report.byMismatchClass) {
    lines.push(`| ${row.mismatchClass} | ${row.horizon_label} | ${row.target_label} | ${row.entries} | ${row.realized} | ${row.targetExits} | ${row.rightCensored} | ${row.pnlUsd == null ? '—' : `$${row.pnlUsd.toFixed(2)}`} | ${row.realizedRoiPct == null ? '—' : `${row.realizedRoiPct.toFixed(2)}%`} | ${row.firstHalfPnlUsd}/${row.secondHalfPnlUsd} | ${row.meanHoldMinutes ?? '—'}m |`);
  }
  lines.push(
    '',
    'Interpretation: HARD_MISMATCH rows are contaminated directional controls, not hedged convergence. NO_RECORDED_MISMATCH and SOFT_MISMATCH_ONLY remain risky until exact rules and settlement behavior are independently validated.',
    '',
  );
  return lines.join('\n');
}

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write(
      'Usage: node scripts/crossvenue-risky-convergence-pnl.js '
      + '[--days=30] [--experiment=<id>] [--json]\n',
    );
    return;
  }
  if (!process.env.DATABASE_URL) {
    throw new Error(`DATABASE_URL is missing; set it in .env or ${serviceEnv}`);
  }
  const days = Math.max(1, Math.min(365, parseInt(arg('days', '30'), 10) || 30));
  const experimentId = arg('experiment', CURRENT_CROSSVENUE_EXPERIMENT_ID);
  const local = /(?:localhost|127\.0\.0\.1|\/deltaforge)/i.test(process.env.DATABASE_URL);
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: local ? false : { rejectUnauthorized: false },
    max: 2,
  });
  try {
    const rows = await queryReplay(pool, { days, experimentId });
    const entries = new Map();
    for (const row of rows) {
      const key = `${row.match_id}:${row.direction}:${row.entry_at}`;
      if (!entries.has(key)) entries.set(key, row);
    }
    const entryRows = [...entries.values()].sort((left, right) =>
      left.entryAt - right.entryAt);
    const report = {
      format: 'crossvenue-risky-convergence-pnl-v1',
      generatedAt: new Date().toISOString(),
      requestedDays: days,
      experimentId,
      paperOnly: true,
      liveOrderPath: false,
      accounting: 'first eligible entry per match-direction-UTC-day; synchronized A/B L2; both entry and exit taker fees; 60-second timeout execution allowance',
      coverage: {
        entries: entryRows.length,
        pairs: new Set(entryRows.map((row) => row.match_id)).size,
        firstAt: entryRows[0]?.entry_at || null,
        lastAt: entryRows.at(-1)?.entry_at || null,
        hardMismatchEntries: entryRows.filter((row) =>
          row.mismatchClass === 'HARD_MISMATCH').length,
        comparableEntries: entryRows.filter((row) =>
          row.mismatchClass !== 'HARD_MISMATCH').length,
      },
      byMismatchClass: groupSummary(rows, [
        'mismatchClass', 'horizon_label', 'target_label',
      ]).sort((left, right) =>
        left.mismatchClass.localeCompare(right.mismatchClass)
        || HORIZONS.findIndex((row) => row.label === left.horizon_label)
          - HORIZONS.findIndex((row) => row.label === right.horizon_label)
        || TARGETS.findIndex((row) => row.label === left.target_label)
          - TARGETS.findIndex((row) => row.label === right.target_label)),
      byDirection: groupSummary(rows, [
        'mismatchClass', 'direction', 'horizon_label', 'target_label',
      ]),
      byInitialEdge: groupSummary(rows, [
        'mismatchClass', 'edgeBucket', 'horizon_label', 'target_label',
      ]),
      entryDiagnostics: entryRows.map((row) => ({
        entryAt: row.entry_at,
        matchId: row.match_id,
        direction: row.direction,
        mismatchClass: row.mismatchClass,
        mismatchReasons: row.mismatch_reasons,
        matchScore: round(row.match_score),
        entryCostUsd: round(row.entryCost),
        parityControlProfitUsd: round(row.terminal_locked_profit),
        parityControlRoiPct: row.entryCost > 0
          ? round(100 * finite(row.terminal_locked_profit, 0) / row.entryCost) : null,
        polyQuestion: row.poly_question,
        kalshiTitle: row.kalshi_title,
      })),
      warnings: [
        'This is an exploratory grid over four exits and five horizons; the best cell is selected in sample and is not forward evidence.',
        'A similarity-approved pair is not a terminal identity. HARD_MISMATCH rows are directional controls and cannot support a convergence claim.',
        'Both-leg fills are assumed from synchronized displayed depth; cross-venue execution remains non-atomic.',
        'Coverage shorter than a requested horizon produces right-censoring rather than an invented terminal loss or zero.',
        'At least 300 fresh comparable pair-direction-days and 30 days are required before promotion.',
      ],
    };
    process.stdout.write(process.argv.includes('--json')
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${markdown(report)}\n`);
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
  HARD_MISMATCHES,
  classifyReplayRow,
  edgeBucket,
  groupSummary,
  maxConcurrentCapital,
  median,
  mismatchClass,
  summarize,
};
