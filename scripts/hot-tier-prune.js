#!/usr/bin/env node
'use strict';

/**
 * Bound PostgreSQL's derived recent-query tier without touching immutable WAL.
 *
 * Full-fidelity all-market and flow events are appended to RawWal before they
 * are processed. These SQL tables exist for dashboards and near-term scoring,
 * so retaining every derived touch indefinitely only duplicates the WAL and
 * can stop collection when the VPS reserve is reached.
 */
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const { verifyRetentionAuthority } = require('./hot-tier-partitions');

function positiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const BATCH_ROWS = positiveInt(process.env.DELTAFORGE_HOT_PRUNE_BATCH_ROWS, 20000);
const MAX_BATCHES = positiveInt(process.env.DELTAFORGE_HOT_PRUNE_MAX_BATCHES, 4);
const RETENTION_LOCK = 'deltaforge-raw-retention-v1';
const specs = [
  {
    // Full-rate Coinbase/Hyperliquid frames are immutable in the source WAL.
    // SQL is the normalized replay/dashboard tier, not a second permanent copy.
    table: 'borg_external_book_touch', timeColumn: 'received_at',
    keepHours: positiveInt(process.env.EXTERNAL_BOOK_SQL_HOT_HOURS, 24),
  },
  {
    table: 'borg_external_trades', timeColumn: 'received_at',
    keepHours: positiveInt(process.env.EXTERNAL_TRADE_SQL_HOT_HOURS, 24),
  },
  {
    // Preserve every rare positive/proved cell in SQL. Negative high-rate
    // evaluations are replayable from structural-decision WAL segments.
    table: 'borg_structural_evaluations', timeColumn: 'evaluated_at',
    keepHours: positiveInt(process.env.STRUCTURAL_SQL_HOT_HOURS, 24),
    predicate: 'NOT (t.economic_candidate OR t.qualified)',
  },
  {
    table: 'am_book_touches', timeColumn: 'observed_at',
    keepHours: positiveInt(process.env.ALLMARKET_SQL_HOT_HOURS, 6),
    // This relation has several execution/research indexes and is currently
    // above 10 GB. Four 5k batches per five-minute run still exceed the
    // incoming row rate without monopolizing PostgreSQL for 15 seconds.
    batchRows: positiveInt(process.env.ALLMARKET_HOT_PRUNE_BATCH_ROWS, 5000),
    // am_book_touches_observed_id makes this deterministic even after repeated
    // deletion leaves a sparse/bloated heap that is expensive to BRIN-recheck.
    orderByTime: true,
  },
  {
    table: 'pm_flow_touches', timeColumn: 'observed_at',
    keepHours: positiveInt(process.env.FLOW_SQL_HOT_HOURS, 6),
  },
  {
    table: 'pm_flow_trades', timeColumn: 'observed_at',
    keepHours: positiveInt(process.env.FLOW_TRADE_SQL_HOT_HOURS, 24),
    // Each delete performs FK checks against the retained signal attribution
    // rows. Keep this batch deliberately smaller than high-volume touch tables.
    batchRows: positiveInt(process.env.FLOW_TRADE_HOT_PRUNE_BATCH_ROWS, 2000),
    // Unlike the touch table, this relation has a btree on observed_at. Use it
    // to avoid scanning the entire 24-hour hot set by primary key.
    orderByTime: true,
    predicate: 'NOT EXISTS (SELECT 1 FROM pm_flow_signals s WHERE s.trigger_trade_id=t.id)',
  },
  {
    table: 'pmm_pair_observations', timeColumn: 'observed_at',
    keepHours: positiveInt(process.env.PAIRED_MAKER_SQL_HOT_HOURS, 24),
  },
  {
    // Full-rate option frames are immutable in the Deribit WAL. PostgreSQL is
    // a compact replay/dashboard tier and therefore needs only a rolling view.
    table: 'borg_deribit_option_touch', timeColumn: 'sample_at',
    keepHours: positiveInt(process.env.OPTIONS_SQL_HOT_HOURS, 24),
    orderByTime: true,
  },
  {
    // Preserve every executable forward observation; prune only diagnostics
    // that are reproducible from venue and decision WALs.
    table: 'borg_option_shadow_marks', timeColumn: 'observed_at',
    keepHours: positiveInt(process.env.OPTIONS_MARK_SQL_HOT_HOURS, 24),
    orderByTime: true,
    predicate: 't.executable=false',
  },
  {
    // Exact full-rate Pyth ticks remain in the immutable RTDS WAL. Signal,
    // arrival, markout and terminal rows are retained; only sampled hot ticks
    // roll out of PostgreSQL.
    table: 'borg_pyth_ticks', timeColumn: 'received_at',
    keepHours: positiveInt(process.env.PYTH_SQL_HOT_HOURS, 24),
    orderByTime: true,
  },
  {
    // The complete synchronized snapshot and decision payloads are appended
    // to the cross-venue WAL before these dashboard rows are buffered. Keep a
    // short normalized SQL window; compact independent relation/convergence
    // ledgers and Parquet are the research history, not millions of repeated
    // quote states.
    table: 'cv_book_snapshots', timeColumn: 'observed_at',
    keepHours: positiveInt(process.env.CROSSVENUE_BOOK_SQL_HOT_HOURS, 24),
    orderByTime: true,
  },
  {
    table: 'cv_opportunities', timeColumn: 'observed_at', idColumn: 'opportunity_id',
    keepHours: positiveInt(process.env.CROSSVENUE_OPPORTUNITY_SQL_HOT_HOURS, 24),
    // JSONB opportunity rows can carry external TOAST values. Smaller commits
    // keep the maintenance worker below its fixed 15-second statement budget
    // even when an old bloated index page must be revisited.
    batchRows: positiveInt(process.env.CROSSVENUE_OPPORTUNITY_HOT_PRUNE_BATCH_ROWS, 5000),
    orderByTime: true,
  },
  {
    // Basis samples support the longest capital-release horizon directly in
    // PostgreSQL. Thirty days is deliberate and independent of headline PnL;
    // older samples remain replayable from the immutable decision WAL.
    table: 'cv_basis_samples', timeColumn: 'observed_at', idColumn: 'sample_id',
    keepHours: positiveInt(process.env.CROSSVENUE_BASIS_SQL_HOT_HOURS, 24 * 30),
    orderByTime: true,
  },
];

function deleteSql(spec) {
  const extra = spec.predicate ? ` AND ${spec.predicate}` : '';
  const idColumn = spec.idColumn || 'id';
  const order = spec.orderByTime ? `ORDER BY t.${spec.timeColumn}, t.${idColumn}` : '';
  return `
    WITH doomed AS (
      SELECT t.${idColumn} AS row_id FROM ${spec.table} t
       WHERE t.${spec.timeColumn} < $1${extra}
       -- BRIN-backed touch tables deliberately need no ordering: sorting the
       -- sparse eligible pages of a bloated relation can exhaust the 15-second
       -- maintenance budget. Selected btree-backed tables opt into causal time
       -- order where it is efficient and useful.
       ${order}
       LIMIT $2
       FOR UPDATE SKIP LOCKED
    ), deleted AS (
      DELETE FROM ${spec.table} t USING doomed d
       WHERE t.${idColumn}=d.row_id
       RETURNING 1
    )
    SELECT count(*)::int AS n FROM deleted
  `;
}

async function pruneTable(pool, spec) {
  const cutoff = new Date(Date.now() - spec.keepHours * 60 * 60 * 1000);
  const batchRows = spec.batchRows || BATCH_ROWS;
  let deleted = 0;
  let batches = 0;
  while (batches < MAX_BATCHES) {
    batches += 1;
    const client = await pool.connect();
    let count = 0;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='250ms'");
      await client.query("SET LOCAL statement_timeout='15s'");
      const { rows } = await client.query(deleteSql(spec), [cutoff, batchRows]);
      count = parseInt(rows[0]?.n, 10) || 0;
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    deleted += count;
    if (count < batchRows) break;
  }
  return {
    table: spec.table, cutoff: cutoff.toISOString(), keepHours: spec.keepHours,
    batchRows, deleted, batches,
  };
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 1,
  });
  const report = {
    format: 'deltaforge-hot-tier-prune-v1',
    checkedAt: new Date().toISOString(),
    batchRows: BATCH_ROWS,
    maxBatches: MAX_BATCHES,
    tables: [],
    errors: [],
  };
  let locked = false;
  try {
    const { rows } = await pool.query('SELECT pg_try_advisory_lock(hashtext($1)) acquired', [RETENTION_LOCK]);
    locked = rows[0]?.acquired === true;
    if (!locked) {
      report.status = 'SKIPPED_LOCKED';
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    const authority = verifyRetentionAuthority();
    report.archiveAuthority = {
      completedAt: authority.receipt.completed_at,
      sourceCutoffEpoch: authority.sourceCutoffEpoch,
    };
    for (const spec of specs) {
      try {
        const { rows: relation } = await pool.query(`
          SELECT c.oid::regclass relation,c.relkind
            FROM pg_class c WHERE c.oid=to_regclass($1)`, [`public.${spec.table}`]);
        if (!relation[0]?.relation) continue;
        if (relation[0].relkind === 'p') {
          report.tables.push({
            table: spec.table,
            status: 'SKIPPED_PARTITIONED',
            reason: 'daily partition retention owns this table',
          });
          continue;
        }
        report.tables.push(await pruneTable(pool, spec));
      } catch (error) {
        report.errors.push({ table: spec.table, error: error.message });
      }
    }
    report.status = report.errors.length ? 'DEGRADED' : 'PASS';
    console.log(JSON.stringify(report, null, 2));
    if (report.errors.length) process.exitCode = 1;
  } finally {
    if (locked) await pool.query('SELECT pg_advisory_unlock(hashtext($1))', [RETENTION_LOCK]).catch(() => {});
    await pool.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

module.exports = { deleteSql, positiveInt, RETENTION_LOCK, specs };
