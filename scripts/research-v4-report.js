#!/usr/bin/env node
/**
 * Forward-only H22-H31 pilot report.
 *
 * This is deliberately not a backtest: the hourly/threshold/range CLOB tape
 * did not exist before the v4 deployment. It reports independent market-event
 * coverage, pessimistically scored fills, 1x/2x costs, and non-atomic bundle
 * leg risk from newly collected data only.
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
});

const number = (value) => {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const integer = (value) => {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
};

async function main() {
  const { rows: strategies } = await pool.query(`
    SELECT o.strategy,
           count(*) FILTER (WHERE o.action='place') AS orders,
           count(*) FILTER (WHERE s.filled) AS fills,
           count(DISTINCT COALESCE(m.event_id, m.id::text)) AS independent_events,
           count(DISTINCT o.market_id) AS independent_contracts,
           COALESCE(sum(s.pnl_1x) FILTER (WHERE s.filled), 0) AS pnl_1x,
           COALESCE(sum(s.pnl_2x) FILTER (WHERE s.filled), 0) AS pnl_2x,
           COALESCE(avg(s.pnl_1x) FILTER (WHERE s.filled), 0) AS mean_pnl_1x,
           min(o.ts) AS first_signal,
           max(o.ts) AS last_signal
    FROM borg_shadow_orders o
    LEFT JOIN borg_shadow_scores s ON s.order_id=o.id
    LEFT JOIN borg_markets m ON m.id=o.market_id
    WHERE o.strategy ~ '^H(2[2-9]|3[01])_' AND o.phase='pilot'
      AND o.features->>'research_capital_version'='500usd-v1'
    GROUP BY o.strategy
    ORDER BY o.strategy`);

  const { rows: bundles } = await pool.query(`
    WITH grouped AS (
      SELECT o.strategy, o.features->>'group_id' AS group_id,
             count(*) AS legs,
             count(*) FILTER (WHERE s.filled) AS filled_legs,
             COALESCE(sum(s.pnl_1x) FILTER (WHERE s.filled), 0) AS pnl_1x,
             COALESCE(sum(s.pnl_2x) FILTER (WHERE s.filled), 0) AS pnl_2x
      FROM borg_shadow_orders o
      LEFT JOIN borg_shadow_scores s ON s.order_id=o.id
      WHERE o.strategy IN ('H26_nested_threshold_bundle','H27_disjoint_bucket_bundle')
        AND o.action='place' AND o.phase='pilot'
        AND o.features->>'research_capital_version'='500usd-v1'
        AND o.features->>'group_id' IS NOT NULL
      GROUP BY o.strategy, o.features->>'group_id'
    )
    SELECT strategy, count(*) AS groups,
           count(*) FILTER (WHERE filled_legs=legs) AS complete_groups,
           count(*) FILTER (WHERE filled_legs>0 AND filled_legs<legs) AS orphan_groups,
           count(*) FILTER (WHERE filled_legs=0) AS unfilled_groups,
           COALESCE(sum(pnl_1x),0) AS pnl_1x,
           COALESCE(sum(pnl_2x),0) AS pnl_2x
    FROM grouped GROUP BY strategy ORDER BY strategy`);

  const { rows: universe } = await pool.query(`
    SELECT market_type, asset, count(*) AS contracts,
           count(*) FILTER (WHERE outcome IS NOT NULL) AS resolved,
           min(discovered_at) AS first_seen, max(discovered_at) AS last_seen
    FROM borg_markets
    WHERE market_type IN ('direction_1h','threshold_daily','range_daily')
    GROUP BY market_type, asset ORDER BY market_type, asset`);

  const output = {
    generated_at: new Date().toISOString(),
    evidence_status: 'forward-only pilot; not a backtest and not promotion evidence',
    strategies: strategies.map((row) => ({
      strategy: row.strategy,
      orders: integer(row.orders), fills: integer(row.fills),
      independent_events: integer(row.independent_events),
      independent_contracts: integer(row.independent_contracts),
      fill_rate_pct: integer(row.orders) ? +(100 * integer(row.fills) / integer(row.orders)).toFixed(1) : 0,
      pnl_1x: +number(row.pnl_1x).toFixed(4),
      pnl_2x: +number(row.pnl_2x).toFixed(4),
      mean_pnl_1x: +number(row.mean_pnl_1x).toFixed(4),
      first_signal: row.first_signal, last_signal: row.last_signal,
    })),
    structural_bundles: bundles.map((row) => ({
      strategy: row.strategy,
      groups: integer(row.groups), complete_groups: integer(row.complete_groups),
      orphan_groups: integer(row.orphan_groups), unfilled_groups: integer(row.unfilled_groups),
      pnl_1x: +number(row.pnl_1x).toFixed(4), pnl_2x: +number(row.pnl_2x).toFixed(4),
    })),
    collected_universe: universe.map((row) => ({
      market_type: row.market_type, asset: row.asset,
      contracts: integer(row.contracts), resolved: integer(row.resolved),
      first_seen: row.first_seen, last_seen: row.last_seen,
    })),
  };

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`H22-H31 RESEARCH V4 — ${output.evidence_status}`);
    console.table(output.strategies);
    console.log('Structural bundle execution (orphan groups expose leg risk):');
    console.table(output.structural_bundles);
    console.log('Collected generic-market universe:');
    console.table(output.collected_universe);
    if (!output.strategies.length) {
      console.log('No v4 signals yet. Zero is the honest result until a pre-registered condition occurs.');
    }
  }
  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end().catch(() => {});
  process.exit(1);
});
