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
  EXACT_RULE_FORWARD_PROTOCOL,
} = require('../borg/crossvenue/experiment');
const {
  clusteredBootstrap,
  clusterSignFlipPValue,
} = require('../borg/research/statistics');

function finite(value, fallback = null) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 4) {
  const parsed = finite(value);
  return parsed == null ? null : +parsed.toFixed(digits);
}

function classifyForwardRow(row) {
  const entryAt = Date.parse(row.entry_at);
  const deadline = entryAt + EXACT_RULE_FORWARD_PROTOCOL.maxHoldMs;
  const coverageAt = Date.parse(row.coverage_last_at);
  const targetAt = Date.parse(row.target_exit_at);
  const timeoutAt = Date.parse(row.timeout_exit_at);
  const mature = Number.isFinite(coverageAt) && coverageAt >= deadline;
  const entryCost = finite(row.entry_total_cost, 0);
  const quantity = finite(row.quantity, 0);
  let status = 'RIGHT_CENSORED';
  let exitAt = null;
  let pnl = null;
  let exitFees = 0;
  let executions = 0;
  if (Number.isFinite(targetAt)) {
    status = 'TARGET_EXIT';
    exitAt = targetAt;
    pnl = finite(row.target_exit_proceeds) - entryCost;
    exitFees = finite(row.target_poly_exit_fee, 0) + finite(row.target_kalshi_exit_fee, 0);
    executions = 2;
  } else if (mature && Number.isFinite(timeoutAt)) {
    status = 'TIMEOUT_EXIT';
    exitAt = timeoutAt;
    pnl = finite(row.timeout_exit_proceeds) - entryCost;
    exitFees = finite(row.timeout_poly_exit_fee, 0) + finite(row.timeout_kalshi_exit_fee, 0);
    executions = 2;
  } else if (row.identity_approved === true && row.terminal_payout != null) {
    status = 'CERTIFIED_TERMINAL_FALLBACK';
    exitAt = Date.parse(row.settled_at);
    pnl = finite(row.terminal_payout) - entryCost;
    executions = 1;
  } else if (mature) {
    status = 'NO_EXECUTABLE_TIMEOUT_EXIT';
  }
  const entryFees = finite(row.poly_entry_fee, 0) + finite(row.kalshi_entry_fee, 0);
  const duplicatedFees = Number.isFinite(pnl) ? entryFees + exitFees : null;
  const tickStress = Number.isFinite(pnl)
    ? quantity * (finite(row.poly_tick, 0.01) + finite(row.kalshi_tick, 0.01))
      * executions : null;
  return {
    ...row,
    entryAt,
    exitAt: Number.isFinite(exitAt) ? exitAt : null,
    mature,
    status,
    entryCost,
    pnl,
    pnl2xFeesOneTick: Number.isFinite(pnl)
      ? pnl - duplicatedFees - tickStress : null,
    holdMs: Number.isFinite(exitAt) ? Math.max(0, exitAt - entryAt) : null,
  };
}

function summarize(rows) {
  const realized = rows.filter((row) => Number.isFinite(row.pnl));
  const pnl = realized.reduce((sum, row) => sum + row.pnl, 0);
  const stress = realized.reduce((sum, row) => sum + row.pnl2xFeesOneTick, 0);
  const ordered = [...realized].sort((left, right) => left.entryAt - right.entryAt);
  const half = Math.floor(ordered.length / 2);
  const inferenceRows = realized.map((row) => ({
    market: row.match_id,
    day: new Date(row.entryAt).toISOString().slice(0, 10),
    pnl: row.pnl2xFeesOneTick,
  }));
  const marketBootstrap = clusteredBootstrap(
    inferenceRows,
    'market',
    'pnl',
    { iterations: 4000, seed: 0x6c5a1201 },
  );
  const dayBootstrap = clusteredBootstrap(
    inferenceRows,
    'day',
    'pnl',
    { iterations: 4000, seed: 0x6c5a1202 },
  );
  const marketP = clusterSignFlipPValue(
    inferenceRows,
    'market',
    'pnl',
    { iterations: 10000, seed: 0x6c5a1203 },
  );
  const dayP = clusterSignFlipPValue(
    inferenceRows,
    'day',
    'pnl',
    { iterations: 10000, seed: 0x6c5a1204 },
  );
  return {
    entries: rows.length,
    realized: realized.length,
    pairs: new Set(rows.map((row) => row.match_id)).size,
    pairDirectionDays: new Set(rows.map((row) =>
      `${row.match_id}:${row.direction}:${new Date(row.entryAt).toISOString().slice(0, 10)}`)).size,
    calendarDays: new Set(rows.map((row) =>
      new Date(row.entryAt).toISOString().slice(0, 10))).size,
    targetExits: rows.filter((row) => row.status === 'TARGET_EXIT').length,
    timeoutExits: rows.filter((row) => row.status === 'TIMEOUT_EXIT').length,
    certifiedTerminalFallbacks: rows.filter((row) =>
      row.status === 'CERTIFIED_TERMINAL_FALLBACK').length,
    censored: rows.filter((row) => row.status === 'RIGHT_CENSORED').length,
    noExecutableTimeoutExit: rows.filter((row) =>
      row.status === 'NO_EXECUTABLE_TIMEOUT_EXIT').length,
    wins: realized.filter((row) => row.pnl > 0).length,
    losses: realized.filter((row) => row.pnl < 0).length,
    pnlUsd: round(pnl),
    pnl2xFeesOneTickUsd: round(stress),
    firstHalfStressPnlUsd: round(ordered.slice(0, half)
      .reduce((sum, row) => sum + row.pnl2xFeesOneTick, 0)),
    secondHalfStressPnlUsd: round(ordered.slice(half)
      .reduce((sum, row) => sum + row.pnl2xFeesOneTick, 0)),
    marketClusteredMeanCi95Usd: marketBootstrap.ci.map((value) => round(value)),
    dayClusteredMeanCi95Usd: dayBootstrap.ci.map((value) => round(value)),
    marketClusters: marketBootstrap.clusters,
    dayClusters: dayBootstrap.clusters,
    conservativeOneSidedP: round(Math.max(marketP, dayP), 8),
    meanHoldMinutes: realized.length ? round(realized.reduce((sum, row) =>
      sum + row.holdMs, 0) / realized.length / 60_000, 2) : null,
  };
}

async function queryForward(pool, days) {
  const { rows } = await pool.query(`
    WITH entries AS (
      SELECT DISTINCT ON (
               b.match_id,b.direction,(b.observed_at AT TIME ZONE 'UTC')::date
             )
             b.*,
             COALESCE(b.exact_rule_key,b.detail->>'exactRuleKey') entry_exact_rule_key,
             COALESCE((b.detail->>'polyTick')::float8,0.01) poly_tick,
             COALESCE((b.detail->>'kalshiTick')::float8,0.01) kalshi_tick,
             s.poly_outcome,s.kalshi_result,
             GREATEST(s.poly_resolved_at,s.kalshi_settled_at) settled_at,
             CASE
               WHEN b.identity_approved
               AND lower(s.poly_outcome) IN ('yes','no')
                AND lower(s.kalshi_result) IN ('yes','no')
               THEN b.quantity * (
                 CASE WHEN lower(s.poly_outcome)=lower(b.poly_outcome)
                      THEN 1 ELSE 0 END
                 + CASE WHEN lower(s.kalshi_result)=lower(b.kalshi_outcome)
                        THEN 1 ELSE 0 END
               )
               ELSE NULL
             END::float8 terminal_payout
        FROM cv_basis_samples b
        LEFT JOIN cv_settlements s USING(match_id)
       WHERE b.experiment_id=$1
         AND b.observed_at >= now()-($2::int * interval '1 day')
         AND b.quantity=$3
         AND b.synchronized AND b.books_fresh AND b.full_entry_depth
         AND (b.paper_entry_eligible OR b.entry_economic)
         AND b.data_quality_grade IN ('A','B')
         AND b.execution_fidelity_grade IN ('A','B')
         AND b.exact_rule_key IS NOT NULL
         AND b.exact_rule_eligible AND NOT b.hard_mismatch
         AND COALESCE((b.detail->'kalshiFeeSchedule'->>'supported')::boolean,false)
       ORDER BY b.match_id,b.direction,
                (b.observed_at AT TIME ZONE 'UTC')::date,b.observed_at
    )
    SELECT e.*,
           coverage.last_at coverage_last_at,
           target.observed_at target_exit_at,
           target.net_liquidation_proceeds::float8 target_exit_proceeds,
           target.poly_exit_fee::float8 target_poly_exit_fee,
           target.kalshi_exit_fee::float8 target_kalshi_exit_fee,
           timeout.observed_at timeout_exit_at,
           timeout.net_liquidation_proceeds::float8 timeout_exit_proceeds,
           timeout.poly_exit_fee::float8 timeout_poly_exit_fee,
           timeout.kalshi_exit_fee::float8 timeout_kalshi_exit_fee
      FROM entries e
      LEFT JOIN LATERAL (
        SELECT max(x.observed_at) last_at
          FROM cv_basis_samples x
         WHERE x.experiment_id=$1 AND x.match_id=e.match_id
           AND x.direction=e.direction AND x.quantity=e.quantity
           AND x.observed_at>e.observed_at
           AND x.exact_rule_key=e.entry_exact_rule_key
           AND x.exact_rule_eligible AND NOT x.hard_mismatch
      ) coverage ON true
      LEFT JOIN LATERAL (
        SELECT x.observed_at,x.net_liquidation_proceeds,
               x.poly_exit_fee,x.kalshi_exit_fee
          FROM cv_basis_samples x
         WHERE x.experiment_id=$1 AND x.match_id=e.match_id
           AND x.direction=e.direction AND x.quantity=e.quantity
           AND x.observed_at>e.observed_at
           AND x.observed_at<=e.observed_at
             + ($4::bigint * interval '1 millisecond')
           AND x.synchronized AND x.books_fresh AND x.full_exit_depth
           AND x.data_quality_grade IN ('A','B')
           AND x.execution_fidelity_grade IN ('A','B')
           AND x.exact_rule_key=e.entry_exact_rule_key
           AND x.exact_rule_eligible AND NOT x.hard_mismatch
           AND x.net_liquidation_proceeds
             >= e.entry_total_cost*(1+$5)
         ORDER BY x.observed_at LIMIT 1
      ) target ON true
      LEFT JOIN LATERAL (
        SELECT x.observed_at,x.net_liquidation_proceeds,
               x.poly_exit_fee,x.kalshi_exit_fee
          FROM cv_basis_samples x
         WHERE x.experiment_id=$1 AND x.match_id=e.match_id
           AND x.direction=e.direction AND x.quantity=e.quantity
           AND x.observed_at>=e.observed_at
             + ($4::bigint * interval '1 millisecond')
           AND x.observed_at<=e.observed_at
             + (($4::bigint+60000) * interval '1 millisecond')
           AND x.synchronized AND x.books_fresh AND x.full_exit_depth
           AND x.data_quality_grade IN ('A','B')
           AND x.execution_fidelity_grade IN ('A','B')
           AND x.exact_rule_key=e.entry_exact_rule_key
           AND x.exact_rule_eligible AND NOT x.hard_mismatch
         ORDER BY x.observed_at LIMIT 1
      ) timeout ON true
     ORDER BY e.observed_at,e.match_id,e.direction
  `, [
    EXACT_RULE_FORWARD_PROTOCOL.experimentId,
    days,
    EXACT_RULE_FORWARD_PROTOCOL.quantity,
    EXACT_RULE_FORWARD_PROTOCOL.maxHoldMs,
    EXACT_RULE_FORWARD_PROTOCOL.targetNetRoi,
  ]);
  return rows.map((row) => classifyForwardRow({
    ...row,
    entry_at: row.observed_at,
  }));
}

async function queryDepth(pool, days) {
  const { rows } = await pool.query(`
    SELECT quantity::float8,reason,count(*)::int observations,
           count(*) FILTER (WHERE full_entry_depth)::int full_entry_depth,
           count(*) FILTER (WHERE full_exit_depth)::int full_exit_depth,
           count(DISTINCT match_id)::int pairs
      FROM cv_depth_replays
     WHERE experiment_id=$1
       AND observed_at>=now()-($2::int * interval '1 day')
       AND exact_rule_eligible AND NOT hard_mismatch
     GROUP BY quantity,reason
     ORDER BY quantity,reason
  `, [EXACT_RULE_FORWARD_PROTOCOL.experimentId, days]);
  return rows;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error(`DATABASE_URL is missing; set it in .env or ${serviceEnv}`);
  }
  const rawDays = process.argv.find((value) => value.startsWith('--days='))?.split('=')[1];
  const days = Math.max(1, Math.min(365, parseInt(rawDays || '30', 10) || 30));
  const local = /(?:localhost|127\.0\.0\.1|\/deltaforge)/i.test(process.env.DATABASE_URL);
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: local ? false : { rejectUnauthorized: false },
    max: 2,
  });
  try {
    const [rows, depth] = await Promise.all([
      queryForward(pool, days),
      queryDepth(pool, days),
    ]);
    const summary = summarize(rows);
    const directions = [...new Set(rows.map((row) => row.direction))].sort();
    const byDirection = Object.fromEntries(directions.map((direction) => [
      direction,
      summarize(rows.filter((row) => row.direction === direction)),
    ]));
    // The two opposite-side arms are both inspected. Bonferroni is explicit
    // and conservative here; a profitable-looking direction cannot inherit an
    // unadjusted p-value after the other arm was also observed.
    const multipleTestingAdjustedP = Math.min(
      1,
      summary.conservativeOneSidedP * Math.max(1, directions.length),
    );
    const marketLower = summary.marketClusteredMeanCi95Usd[0];
    const dayLower = summary.dayClusteredMeanCi95Usd[0];
    const report = {
      format: 'crossvenue-exact-rule-forward-v1',
      generatedAt: new Date().toISOString(),
      paperOnly: true,
      liveOrderPath: false,
      protocol: EXACT_RULE_FORWARD_PROTOCOL,
      requestedDays: days,
      summary: {
        ...summary,
        multipleTestingFamily: directions,
        multipleTestingMethod: 'BONFERRONI_OVER_OBSERVED_DIRECTION_ARMS',
        multipleTestingAdjustedP: round(multipleTestingAdjustedP, 8),
      },
      promotionReady: summary.pairDirectionDays >= EXACT_RULE_FORWARD_PROTOCOL.minimumFreshUnits
        && summary.calendarDays >= EXACT_RULE_FORWARD_PROTOCOL.minimumCalendarDays
        && summary.pnl2xFeesOneTickUsd > 0
        && summary.firstHalfStressPnlUsd > 0
        && summary.secondHalfStressPnlUsd > 0
        && marketLower != null && marketLower > 0
        && dayLower != null && dayLower > 0
        && multipleTestingAdjustedP <= 0.05,
      byDirection,
      depth,
      entries: rows.map((row) => ({
        entryAt: row.observed_at,
        matchId: row.match_id,
        exactRuleKey: row.exact_rule_key,
        direction: row.direction,
        status: row.status,
        pnlUsd: round(row.pnl),
        pnl2xFeesOneTickUsd: round(row.pnl2xFeesOneTick),
        holdMinutes: row.holdMs == null ? null : round(row.holdMs / 60_000, 2),
      })),
      warnings: [
        'This is risky convergence, not an atomic or legally risk-free trade.',
        'The 1% target is provisional because it was inspected in the prior contaminated discovery grid.',
        'No V5 or earlier row is included.',
        'No-exit and right-censored entries are never credited as wins.',
      ],
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
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
  classifyForwardRow,
  queryDepth,
  queryForward,
  summarize,
};
