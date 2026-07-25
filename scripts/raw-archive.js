#!/usr/bin/env node
'use strict';

/**
 * Dedicated verified raw-tape archiver for the VPS hot tier.
 *
 * Scoring and archiving are deliberately separate jobs. Every non-WAL database
 * row is gzip-written, fsynced, hash-verified and only then deleted. High-rate
 * CLOB projections are already represented by append-before-process WAL and
 * are retained with daily partitions, avoiding a duplicate-archive disk
 * deadlock. Off-host retention remains fail-closed behind its receipt.
 */
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const { archiveAndPrune, safeArchiveCutoff } = require('../borg/shadow/archive');

const RETENTION_LOCK = 'deltaforge-raw-retention-v1';

function positiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function poolConfig() {
  const connectionString = process.env.DATABASE_URL;
  const local = /(?:localhost|127\.0\.0\.1|\/deltaforge)/i.test(connectionString || '');
  return { connectionString, ssl: local ? false : { rejectUnauthorized: false }, max: 1 };
}

async function writeHeartbeat(pool, meta) {
  await pool.query(`
    INSERT INTO system_heartbeats(component,beat_at,meta)
    VALUES ('raw_archiver',now(),$1::jsonb)
    ON CONFLICT(component) DO UPDATE SET beat_at=now(),meta=EXCLUDED.meta`,
  [JSON.stringify(meta)]).catch(() => {});
}

async function main() {
  const pool = new Pool(poolConfig());
  const startedAt = Date.now();
  let locked = false;
  const base = {
    format: 'deltaforge-raw-archiver-v1', startedAt: new Date(startedAt).toISOString(),
    paperDataOnly: true, deletesOnlyAfterVerifiedArchive: true,
  };
  try {
    // Maintenance must yield to the event collectors and schema checks. A
    // blocked archive batch fails quickly and is retried by the next timer.
    await pool.query("SET lock_timeout = '2s'");
    await pool.query("SET statement_timeout = '45s'");
    const { rows } = await pool.query(
      'SELECT pg_try_advisory_lock(hashtext($1)) acquired', [RETENTION_LOCK]);
    locked = rows[0]?.acquired === true;
    if (!locked) {
      const report = { ...base, status: 'SKIPPED_LOCKED', durationMs: Date.now() - startedAt };
      await writeHeartbeat(pool, report);
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    const safety = await safeArchiveCutoff(pool);
    const defaultMax = positiveInt(process.env.BORG_ARCHIVE_DEFAULT_MAX_BATCHES, 4);
    const maxRuntimeMs = positiveInt(process.env.BORG_ARCHIVE_MAX_RUNTIME_MS, 120000);
    const state = await archiveAndPrune(pool, safety.cutoff, {
      deadlineAt: startedAt + maxRuntimeMs,
      maxBatchesPerTable: defaultMax,
    });
    const archivedRows = state.results.reduce((sum, row) => sum + row.rows, 0);
    const files = state.results.reduce((sum, row) => sum + row.files, 0);
    const report = {
      ...base, status: state.errors.length ? 'DEGRADED' : 'PASS',
      cutoff: safety.cutoff.toISOString(), oldestUnscoredAt: safety.oldestUnscoredAt,
      hotRetentionHours: safety.hotRetentionHours, archivedRows, files,
      compressedBytes: state.results.reduce((sum, row) => sum + row.compressed_bytes, 0),
      freeBytes: state.free_bytes, errors: state.errors,
      durationLimitReached: state.duration_limit_reached,
      tables: state.results.map((row) => ({
        table: row.table, rows: row.rows, files: row.files,
        batchLimitReached: row.batch_limit_reached,
        durationLimitReached: row.duration_limit_reached,
      })),
      durationMs: Date.now() - startedAt,
    };
    await writeHeartbeat(pool, report);
    console.log(JSON.stringify(report, null, 2));
    if (state.errors.length) process.exitCode = 1;
  } finally {
    if (locked) {
      await pool.query('SELECT pg_advisory_unlock(hashtext($1))', [RETENTION_LOCK]).catch(() => {});
    }
    await pool.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

module.exports = { RETENTION_LOCK, positiveInt };
