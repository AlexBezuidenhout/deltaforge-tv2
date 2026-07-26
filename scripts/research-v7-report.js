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

const MANIFEST = require('../borg/experiments/research-v7-h54-h63-paper-v1.json');
const STRATEGIES = Object.freeze(MANIFEST.strategy_bindings.map((row) => row.strategy));

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
  if (!Number.isFinite(startedAt.getTime())) throw new Error(`Invalid --since: ${since}`);
  const [{ rows: runtimeRows }, { rows: resultRows }, { rows: latencyRows }] =
    await Promise.all([
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
               r.last_action_at,r.diagnostics,r.updated_at,
               l.run_id,l.epoch_id,l.started_at run_started_at
          FROM borg_strategy_runtime r
          JOIN latest l ON l.run_id=r.collector_run_id
         WHERE r.strategy=ANY($1::text[])
         ORDER BY r.strategy
      `, [STRATEGIES]),
      pool.query(`
        WITH raw AS (
          SELECT o.id,o.strategy,o.market_id,o.available_at,o.price,o.size,
                 s.filled,s.fill_price,s.fill_size,s.pnl_1x,s.pnl_2x,
                 s.data_quality_grade,s.execution_fidelity_grade,
                 s.fill_ts,s.detail
            FROM borg_shadow_orders o
            LEFT JOIN borg_shadow_scores s ON s.order_id=o.id
           WHERE o.strategy=ANY($1::text[])
             AND o.action='place'
             AND COALESCE(o.available_at,o.ts)>=$2
             AND COALESCE(o.available_at,o.ts)<=$3
        ), base AS (
          SELECT raw.*,
                 CASE WHEN filled THEN
                   count(*) FILTER (WHERE filled) OVER (
                     PARTITION BY strategy
                     ORDER BY COALESCE(fill_ts,available_at),id
                     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                   )
                 END fill_rank,
                 count(*) FILTER (WHERE filled) OVER (
                   PARTITION BY strategy
                 ) fill_count
            FROM raw
        )
        SELECT strategy,
               count(*)::int intended,
               count(*) FILTER (WHERE filled IS NOT NULL)::int scored,
               count(*) FILTER (WHERE filled)::int fills,
               count(*) FILTER (WHERE filled=false)::int nonfills,
               count(DISTINCT market_id) FILTER (WHERE filled)::int filled_markets,
               count(*) FILTER (
                 WHERE filled
                   AND data_quality_grade IN ('A','B')
                   AND execution_fidelity_grade IN ('A','B')
               )::int eligible_fills,
               count(DISTINCT market_id) FILTER (
                 WHERE filled
                   AND data_quality_grade IN ('A','B')
                   AND execution_fidelity_grade IN ('A','B')
               )::int eligible_markets,
               count(*) FILTER (WHERE filled AND pnl_2x>0)::int wins_2x,
               COALESCE(sum(pnl_1x) FILTER (
                 WHERE filled
                   AND data_quality_grade IN ('A','B')
                   AND execution_fidelity_grade IN ('A','B')
               ),0)::float8 pnl_1x,
               COALESCE(sum(pnl_2x) FILTER (
                 WHERE filled
                   AND data_quality_grade IN ('A','B')
                   AND execution_fidelity_grade IN ('A','B')
               ),0)::float8 pnl_2x,
               COALESCE(sum(pnl_2x) FILTER (
                 WHERE filled AND fill_rank<=ceil(fill_count/2.0)
                   AND data_quality_grade IN ('A','B')
                   AND execution_fidelity_grade IN ('A','B')
               ),0)::float8 first_half_pnl_2x,
               COALESCE(sum(pnl_2x) FILTER (
                 WHERE filled AND fill_rank>ceil(fill_count/2.0)
                   AND data_quality_grade IN ('A','B')
                   AND execution_fidelity_grade IN ('A','B')
               ),0)::float8 second_half_pnl_2x,
               COALESCE(avg(fill_price*fill_size) FILTER (WHERE filled),0)::float8 avg_fill_notional,
               count(*) FILTER (
                 WHERE detail->>'quote_survived'='false'
               )::int vanished_quotes,
               max(available_at) latest_intent
          FROM base
         GROUP BY strategy
         ORDER BY strategy
      `, [STRATEGIES, startedAt, now]),
      pool.query(`
        SELECT o.strategy,l.latency_ms,
               count(*) FILTER (WHERE l.filled)::int fills,
               COALESCE(sum(l.pnl_2x) FILTER (
                 WHERE l.filled
                   AND l.data_quality_grade IN ('A','B')
                   AND l.execution_fidelity_grade IN ('A','B')
               ),0)::float8 pnl_2x
          FROM borg_shadow_latency_scores l
          JOIN borg_shadow_orders o ON o.id=l.order_id
         WHERE o.strategy=ANY($1::text[])
           AND COALESCE(o.available_at,o.ts)>=$2
           AND COALESCE(o.available_at,o.ts)<=$3
           AND l.latency_ms IN (100,250,500)
         GROUP BY o.strategy,l.latency_ms
         ORDER BY o.strategy,l.latency_ms
      `, [STRATEGIES, startedAt, now]),
    ]);

  const runtime = new Map(runtimeRows.map((row) => [row.strategy, row]));
  const results = new Map(resultRows.map((row) => [row.strategy, row]));
  const latency = new Map();
  for (const row of latencyRows) {
    if (!latency.has(row.strategy)) latency.set(row.strategy, {});
    latency.get(row.strategy)[row.latency_ms] = {
      fills: integer(row.fills),
      pnl2x: number(row.pnl_2x),
    };
  }
  const binding = new Map(MANIFEST.strategy_bindings.map((row) => [row.strategy, row]));
  const strategies = STRATEGIES.map((strategy) => {
    const run = runtime.get(strategy);
    const result = results.get(strategy) || {};
    const fills = integer(result.fills);
    return {
      strategy,
      mechanismFamily: binding.get(strategy)?.family || null,
      active: Boolean(run),
      cadence: run?.cadence || null,
      marketTypes: run?.market_types || [],
      evaluations: integer(run?.evaluations),
      haltedEvaluations: integer(run?.halted_evaluations),
      actions: integer(run?.actions),
      errors: integer(run?.errors),
      lastEvaluatedAt: run?.last_evaluated_at || null,
      intended: integer(result.intended),
      scored: integer(result.scored),
      fills,
      nonfills: integer(result.nonfills),
      filledMarkets: integer(result.filled_markets),
      eligibleFills: integer(result.eligible_fills),
      eligibleMarkets: integer(result.eligible_markets),
      winRate2xPct: fills ? +(100 * integer(result.wins_2x) / fills).toFixed(1) : null,
      pnl1x: number(result.pnl_1x),
      pnl2x: number(result.pnl_2x),
      firstHalfPnl2x: number(result.first_half_pnl_2x),
      secondHalfPnl2x: number(result.second_half_pnl_2x),
      avgFillNotional: number(result.avg_fill_notional),
      vanishedQuotes: integer(result.vanished_quotes),
      latestIntent: result.latest_intent || null,
      latency: latency.get(strategy) || {},
    };
  });
  return {
    format: 'research-v7-forward-report-v1',
    experimentId: MANIFEST.experiment_id,
    paperOnly: true,
    liveOrderPath: 'disabled',
    since: startedAt.toISOString(),
    generatedAt: now.toISOString(),
    activeCount: strategies.filter((row) => row.active).length,
    expectedActiveCount: STRATEGIES.length,
    strategies,
    interpretation: [
      'A/B-quality fills and 2x-cost PnL are the primary descriptive view.',
      'No profitability verdict is valid before the frozen independent-market, duration, split-half, clustered-confidence and multiple-testing requirements pass.',
      'Strategy PnL cannot be summed because arms share markets, liquidity and a hypothetical bankroll.',
    ],
  };
}

function markdown(report) {
  const lines = [
    '# H54-H63 paper-forward checkpoint',
    '',
    `Generated ${report.generatedAt}; evidence start ${report.since}.`,
    `Runtime ${report.activeCount}/${report.expectedActiveCount}; paper only; live order path disabled.`,
    '',
    '| Strategy | Active | Evaluations | Intents | Fills | A/B markets | Win 2x | PnL 1x | PnL 2x | Half 1 | Half 2 |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const row of report.strategies) {
    lines.push(`| ${row.strategy} | ${row.active ? 'YES' : 'NO'} | ${row.evaluations} | ${row.intended} | ${row.fills} | ${row.eligibleMarkets} | ${row.winRate2xPct == null ? '—' : `${row.winRate2xPct}%`} | ${money(row.pnl1x)} | ${money(row.pnl2x)} | ${money(row.firstHalfPnl2x)} | ${money(row.secondHalfPnl2x)} |`);
  }
  lines.push('', ...report.interpretation.map((line) => `- ${line}`), '');
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

module.exports = { MANIFEST, STRATEGIES, buildReport, markdown };
