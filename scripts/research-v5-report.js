#!/usr/bin/env node
/** Forward-only H32-H51 activity, execution-fidelity and network coverage. */
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
           count(*) AS orders,
           count(*) FILTER (WHERE s.filled) AS fills,
           count(DISTINCT COALESCE(m.event_id, m.id::text)) AS independent_events,
           COALESCE(sum(s.pnl_1x) FILTER (WHERE s.filled),0) AS pnl_1x,
           COALESCE(sum(s.pnl_2x) FILTER (WHERE s.filled),0) AS pnl_2x,
           count(*) FILTER (WHERE s.detail->>'data_quality_grade'='F') AS f_grade,
           count(*) FILTER (WHERE s.detail->>'quote_survived'='false') AS vanished,
           min(o.ts) AS first_signal, max(o.ts) AS last_signal
    FROM borg_shadow_orders o
    LEFT JOIN borg_shadow_scores s ON s.order_id=o.id
    LEFT JOIN borg_markets m ON m.id=o.market_id
    WHERE o.action='place' AND o.phase='pilot'
      AND o.strategy ~ '^H(3[2-9]|4[0-9]|5[01])_'
      AND o.features->>'research_capital_version'='500usd-v1'
    GROUP BY o.strategy ORDER BY o.strategy`);

  const { rows: networks } = await pool.query(`
    SELECT network, asset, observations, last_seen FROM (
      SELECT source AS network, asset, count(*) AS observations, max(received_at) AS last_seen
      FROM borg_rtds_ticks WHERE received_at > now() - interval '2 hours'
      GROUP BY source, asset
      UNION ALL
      SELECT 'coinbase' AS network, asset, count(*) AS observations, max(ts) AS last_seen
      FROM borg_coinbase_1s WHERE ts > now() - interval '2 hours'
      GROUP BY asset
      UNION ALL
      SELECT 'hyperliquid' AS network, lower(replace(symbol,'-HL','')) AS asset,
             count(*) AS observations, max(ts) AS last_seen
      FROM borg_binance_1s WHERE symbol LIKE '%-HL' AND ts > now() - interval '2 hours'
      GROUP BY symbol
    ) coverage ORDER BY network, asset`);

  const output = {
    generated_at: new Date().toISOString(),
    evidence_status: 'forward-only pilot; machinery activity, not profitability evidence',
    strategies: strategies.map((row) => ({
      strategy: row.strategy,
      orders: integer(row.orders), fills: integer(row.fills),
      independent_events: integer(row.independent_events),
      fill_rate_pct: integer(row.orders) ? +(100 * integer(row.fills) / integer(row.orders)).toFixed(1) : 0,
      pnl_1x: +number(row.pnl_1x).toFixed(4), pnl_2x: +number(row.pnl_2x).toFixed(4),
      f_grade: integer(row.f_grade), vanished_quotes: integer(row.vanished),
      first_signal: row.first_signal, last_signal: row.last_signal,
    })),
    network_coverage_2h: networks.map((row) => ({
      network: row.network, asset: row.asset,
      observations: integer(row.observations), last_seen: row.last_seen,
    })),
  };

  if (process.argv.includes('--json')) console.log(JSON.stringify(output, null, 2));
  else {
    console.log(`H32-H51 RESEARCH V5 — ${output.evidence_status}`);
    console.table(output.strategies);
    console.log('Required network coverage, trailing two hours:');
    console.table(output.network_coverage_2h);
    if (!output.strategies.length) console.log('No v5 signals yet; zero is correct until a registered condition occurs.');
  }
  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end().catch(() => {});
  process.exit(1);
});
