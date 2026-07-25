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

const EXPERIMENT_ID = 'promising-paper-forward-2026-07-25-v1';
const MANIFEST = require('../borg/experiments/promising-paper-forward-2026-07-25-v1.json');
const CONTINUING = Object.freeze([
  'H43_resolution_boundary_buffer',
  'ETH_G_late_exact_forward_v1',
]);
const FORWARD = Object.freeze(MANIFEST.strategy_bindings.map((row) => row.strategy));
const ACTIVE = Object.freeze([...CONTINUING, ...FORWARD]);

function number(value, fallback = 0) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function integer(value) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value) {
  const parsed = number(value);
  return `${parsed < 0 ? '-' : '+'}$${Math.abs(parsed).toFixed(2)}`;
}

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function buildReport(pool, since = MANIFEST.evidence_started_at, now = new Date()) {
  const startedAt = new Date(since);
  if (!Number.isFinite(startedAt.getTime())) throw new Error(`Invalid --since value: ${since}`);
  const [{ rows: runtimeRows }, { rows: resultRows }, { rows: collectorRows }] = await Promise.all([
    pool.query(`
      WITH latest AS (
        SELECT run_id,epoch_id,started_at
          FROM borg_collector_runs
         WHERE status='RUNNING'
         ORDER BY started_at DESC
         LIMIT 1
      )
      SELECT r.strategy,r.cadence,r.market_types,r.evaluations,
             r.halted_evaluations,r.actions,r.errors,r.last_evaluated_at,
             r.last_action_at,r.updated_at,l.epoch_id,l.started_at run_started_at
        FROM borg_strategy_runtime r
        JOIN latest l ON l.run_id=r.collector_run_id
       WHERE r.strategy=ANY($1::text[])
       ORDER BY r.strategy
    `, [ACTIVE]),
    pool.query(`
      SELECT o.strategy,
             count(*) FILTER (WHERE o.action='place')::int intended,
             count(s.order_id) FILTER (WHERE o.action='place')::int scored,
             count(s.order_id) FILTER (WHERE o.action='place' AND s.filled)::int fills,
             count(s.order_id) FILTER (WHERE o.action='place' AND NOT s.filled)::int nonfills,
             count(s.order_id) FILTER (
               WHERE o.action='place' AND s.filled
                 AND s.data_quality_grade IN ('A','B')
                 AND s.execution_fidelity_grade IN ('A','B')
             )::int eligible_fills,
             count(DISTINCT o.market_id) FILTER (
               WHERE o.action='place' AND s.filled
                 AND s.data_quality_grade IN ('A','B')
                 AND s.execution_fidelity_grade IN ('A','B')
             )::int eligible_markets,
             COALESCE(sum(s.pnl_1x) FILTER (
               WHERE o.action='place' AND s.filled
                 AND s.data_quality_grade IN ('A','B')
                 AND s.execution_fidelity_grade IN ('A','B')
             ),0)::float8 pnl_1x,
             COALESCE(sum(s.pnl_2x) FILTER (
               WHERE o.action='place' AND s.filled
                 AND s.data_quality_grade IN ('A','B')
                 AND s.execution_fidelity_grade IN ('A','B')
             ),0)::float8 pnl_2x,
             max(o.available_at) FILTER (WHERE o.action='place') last_intent_at,
             max(s.scored_at) FILTER (WHERE o.action='place') last_scored_at
        FROM borg_shadow_orders o
        LEFT JOIN borg_shadow_scores s ON s.order_id=o.id
       WHERE o.strategy=ANY($1::text[])
         AND COALESCE(o.available_at,o.ts)>=$2
         AND COALESCE(o.available_at,o.ts)<=$3
       GROUP BY o.strategy
       ORDER BY o.strategy
    `, [ACTIVE, startedAt, now]),
    pool.query(`
      SELECT r.run_id,r.epoch_id,r.started_at,r.status,r.code_version,
             EXTRACT(EPOCH FROM $1::timestamptz-r.started_at)::float8 run_age_sec
        FROM borg_collector_runs r
       WHERE r.status='RUNNING'
       ORDER BY r.started_at DESC
       LIMIT 1
    `, [now]),
  ]);

  const runtime = new Map(runtimeRows.map((row) => [row.strategy, row]));
  const results = new Map(resultRows.map((row) => [row.strategy, row]));
  const strategies = ACTIVE.map((strategy) => {
    const run = runtime.get(strategy);
    const result = results.get(strategy) || {};
    const intended = integer(result.intended);
    const scored = integer(result.scored);
    return {
      strategy,
      cohort: FORWARD.includes(strategy) ? EXPERIMENT_ID : 'continuing-frozen-arm',
      active: Boolean(run),
      cadence: run?.cadence || null,
      marketTypes: run?.market_types || [],
      evaluations: integer(run?.evaluations),
      haltedEvaluations: integer(run?.halted_evaluations),
      actions: integer(run?.actions),
      errors: integer(run?.errors),
      lastEvaluatedAt: run?.last_evaluated_at || null,
      intended,
      scored,
      pendingScore: Math.max(0, intended - scored),
      fills: integer(result.fills),
      nonfills: integer(result.nonfills),
      eligibleFills: integer(result.eligible_fills),
      eligibleMarkets: integer(result.eligible_markets),
      pnl1x: number(result.pnl_1x),
      pnl2x: number(result.pnl_2x),
      lastIntentAt: result.last_intent_at || null,
      lastScoredAt: result.last_scored_at || null,
    };
  });

  return {
    format: 'promising-paper-forward-checkpoint-v1',
    experimentId: EXPERIMENT_ID,
    paperOnly: true,
    liveOrderPath: 'disabled',
    since: startedAt.toISOString(),
    generatedAt: now.toISOString(),
    elapsedHours: +((now - startedAt) / 3600000).toFixed(3),
    collector: collectorRows[0] || null,
    activeCount: strategies.filter((row) => row.active).length,
    expectedActiveCount: ACTIVE.length,
    strategies,
    warning: 'Arms share markets, tape, liquidity and hypothetical capital. Do not sum their PnL.',
  };
}

function markdown(report) {
  const lines = [
    `# Promising paper-forward checkpoint`,
    '',
    `Generated ${report.generatedAt}; cohort start ${report.since} (${report.elapsedHours} hours).`,
    `Paper only; live order path disabled. Runtime ${report.activeCount}/${report.expectedActiveCount} active.`,
    '',
    '| Strategy | Runtime | Evaluations | Intents | Scored | Fills | A/B fills | 1x PnL | 2x PnL |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const row of report.strategies) {
    lines.push(`| ${row.strategy} | ${row.active ? 'ACTIVE' : 'MISSING'} | ${row.evaluations} | ${row.intended} | ${row.scored} | ${row.fills} | ${row.eligibleFills} | ${money(row.pnl1x)} | ${money(row.pnl2x)} |`);
  }
  lines.push(
    '',
    `Warning: ${report.warning}`,
    '',
    'A six-hour result is an operational checkpoint, not a profitability verdict. The frozen promotion read remains 300 independent markets and 14 days.',
    '',
  );
  return lines.join('\n');
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error(`DATABASE_URL is missing; set it in .env or ${serviceEnv}`);
  }
  const local = /(?:localhost|127\.0\.0\.1|\/deltaforge)/i.test(process.env.DATABASE_URL);
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: local ? false : { rejectUnauthorized: false },
    max: 2,
  });
  try {
    const report = await buildReport(pool, arg('since', MANIFEST.evidence_started_at));
    process.stdout.write(process.argv.includes('--json')
      ? `${JSON.stringify(report, null, 2)}\n`
      : markdown(report));
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

module.exports = { ACTIVE, EXPERIMENT_ID, FORWARD, buildReport, markdown };
