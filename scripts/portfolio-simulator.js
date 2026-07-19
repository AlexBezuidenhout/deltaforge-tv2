#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const { simulatePortfolio } = require('../borg/research/portfolio-simulator');

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const requestedPhase = arg('--phase', 'all').toLowerCase();
  if (!['all', 'pilot', 'eval'].includes(requestedPhase)) throw new Error('--phase must be all, pilot, or eval');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows } = await client.query(`
      SELECT o.id, o.strategy, o.phase, o.market_id, o.token, o.ts, o.available_at,
             o.source_event_id, o.features, s.filled, s.fill_ts, s.fill_price, s.fill_size,
             s.pnl_gross, s.pnl_1x, s.pnl_2x, s.detail, s.data_quality_grade,
             s.execution_fidelity_grade, s.fidelity_level,
             m.window_end, m.resolved_at
      FROM borg_shadow_orders o
      JOIN borg_shadow_scores s ON s.order_id=o.id
      JOIN borg_markets m ON m.id=o.market_id
      WHERE o.action='place' AND o.experiment_id IS NOT NULL
        AND COALESCE(o.features->>'research_capital_version','')='500usd-v1'
        AND ($1='all' OR o.phase=$1)
      ORDER BY COALESCE(s.fill_ts,o.available_at,o.ts), o.id`, [requestedPhase]);

    const phases = requestedPhase === 'all' ? ['pilot', 'eval'] : [requestedPhase];
    const output = {
      format: 'borg-shared-portfolio-report-v1',
      createdAt: new Date().toISOString(),
      warning: 'Paper/shadow scenario only. Pilot and evaluation cohorts are simulated separately and never pooled. No result authorizes live trading.',
      cohorts: {},
    };
    for (const phase of phases) {
      const records = rows.filter((row) => row.phase === phase).map((row) => ({
        orderId: String(row.id), strategy: row.strategy, marketId: String(row.market_id),
        token: row.token, ts: row.ts, availableAt: row.available_at,
        sourceEventId: row.source_event_id, filled: row.filled,
        fillTs: row.fill_ts, fillPrice: row.fill_price, fillSize: row.fill_size,
        pnlGross: row.pnl_gross, pnl1x: row.pnl_1x, pnl2x: row.pnl_2x,
        detail: row.detail, capacityAtArrival: row.detail?.capacity_at_arrival,
        capacityKey: row.detail?.clob_event_sequence != null
          ? `${row.market_id}:${row.token}:${row.detail.clob_connection_epoch}:${row.detail.clob_event_sequence}`
          : null,
        groupId: row.features?.group_id,
        windowEnd: row.window_end, resolvedAt: row.resolved_at,
      }));
      output.cohorts[phase] = simulatePortfolio(records);
    }
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
