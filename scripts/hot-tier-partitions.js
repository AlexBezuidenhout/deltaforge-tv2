#!/usr/bin/env node
'use strict';

/**
 * Daily PostgreSQL partitions for replayable, high-rate research projections.
 *
 * Immutable source frames and strategy decisions live in the append-before-
 * process WAL. These tables are the bounded SQL query tier. The one-time
 * migration is intentionally destructive and therefore requires a fresh,
 * checksum-matching off-host database snapshot receipt. Routine retention
 * drops only complete daily partitions covered by a fresh raw-WAL receipt.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const DAY_MS = 86_400_000;
const MIGRATION_CONFIRM = 'verified-offhost-snapshot';
const PARTITION_LOCK = 'deltaforge-hot-partitions-v1';
const DEFAULT_SNAPSHOT_RECEIPT = '/var/lib/deltaforge/offhost-snapshot.receipt';
const DEFAULT_ARCHIVE_RECEIPT = '/var/lib/deltaforge/offhost-archive.receipt';
const DEFAULT_SNAPSHOT_ROOT = '/var/lib/deltaforge/db-snapshots';

const SPECS = Object.freeze([
  {
    table: 'borg_clob_touch', time: 'ts', id: 'id', keepDays: 0,
    indexes: [
      ['borg_clob_touch_market_asset_ts', '(market_id,asset_id,ts)'],
      ['borg_clob_touch_ts_brin', 'USING BRIN (ts)'],
    ],
  },
  {
    table: 'borg_clob_events', time: 'ts', id: 'id', keepDays: 0,
    indexes: [['borg_clob_events_market_ts', '(market_id,ts)']],
  },
  {
    table: 'borg_book_snaps', time: 'ts', id: 'id', keepDays: 1,
    indexes: [
      ['borg_book_snaps_market_ts', '(market_id,ts)'],
      ['borg_book_snaps_ts_brin', 'USING BRIN (ts)'],
    ],
  },
  {
    table: 'borg_external_book_touch', time: 'received_at', id: 'id', keepDays: 0,
    indexes: [
      ['borg_external_book_touch_source_product_ts', '(source,product,received_at)'],
      ['borg_external_book_touch_received_brin', 'USING BRIN (received_at)'],
    ],
  },
  {
    table: 'borg_external_trades', time: 'received_at', id: 'id', keepDays: 1,
    parentUnique: [
      ['borg_external_trades_dedup_received_uq', '(dedup_key,received_at)'],
    ],
    indexes: [
      ['borg_external_trades_source_product_ts', '(source,product,received_at)'],
      ['borg_external_trades_received_brin', 'USING BRIN (received_at)'],
    ],
  },
  {
    table: 'borg_structural_evaluations', time: 'evaluated_at', id: 'id', keepDays: 1,
    parentUnique: [
      ['borg_structural_evaluations_dedup_evaluated_uq', '(dedup_key,evaluated_at)'],
    ],
    retain: {
      table: 'borg_structural_evaluations_retained',
      // "economic_candidate" is a pre-orphan arithmetic diagnostic and was
      // true for tens of thousands of non-executable v10 cells. Only a fully
      // qualified payoff/rule/depth/orphan result warrants permanent SQL
      // retention; every diagnostic remains in WAL and the verified snapshot.
      predicate: 'qualified',
      conflict: 'dedup_key',
    },
    foreignKeys: [
      'FOREIGN KEY (candidate_id) REFERENCES borg_structural_candidates(candidate_id)',
    ],
    indexes: [
      ['borg_structural_evaluations_candidate_ts', '(candidate_id,evaluated_at DESC)'],
      ['borg_structural_evaluations_positive',
        '(evaluated_at DESC) WHERE economic_candidate OR qualified'],
      ['borg_structural_evaluations_evaluated_brin', 'USING BRIN (evaluated_at)'],
    ],
  },
  {
    table: 'borg_deribit_option_touch', time: 'sample_at', id: 'id', keepDays: 1,
    parentUnique: [
      ['borg_deribit_option_touch_instrument_name_sample_at_key',
        '(instrument_name,sample_at)'],
    ],
    indexes: [
      ['borg_deribit_option_touch_surface_time',
        '(currency,expiration_at,strike,sample_at DESC)'],
      ['borg_deribit_option_touch_sample_brin', 'USING BRIN (sample_at)'],
    ],
  },
  {
    table: 'borg_option_shadow_marks', time: 'observed_at', id: 'id', keepDays: 1,
    preMigrate: [
      `ALTER TABLE borg_option_shadow_marks ADD COLUMN IF NOT EXISTS experiment_id TEXT
       NOT NULL DEFAULT 'options-implied-binary-v1'`,
    ],
    parentUnique: [
      ['borg_option_shadow_marks_dedup_observed_uq', '(dedup_key,observed_at)'],
    ],
    retain: {
      table: 'borg_option_shadow_marks_retained',
      predicate: 'executable',
      conflict: 'dedup_key',
    },
    indexes: [
      ['borg_option_shadow_marks_market_time', '(market_id,observed_at DESC)'],
      ['borg_option_shadow_marks_experiment_time', '(experiment_id,observed_at DESC)'],
      ['borg_option_shadow_marks_positive', '(observed_at DESC) WHERE executable'],
    ],
  },
  {
    table: 'cv_book_snapshots', time: 'observed_at', id: 'id', keepDays: 0,
    indexes: [
      ['cv_book_snapshots_match_time', '(match_id,observed_at DESC)'],
      ['cv_book_snapshots_observed_id', '(observed_at,id)'],
    ],
  },
  {
    table: 'cv_opportunities', time: 'observed_at', keepDays: 0,
    parentUnique: [
      ['cv_opportunities_id_observed_uq', '(opportunity_id,observed_at)'],
    ],
    retain: {
      table: 'cv_opportunities_retained',
      // Contract identity lives in cv_contract_matches. Retaining every quote
      // for an approved pair would recreate a high-rate history table; keep
      // only the sparse observations that were also executable economics.
      predicate: 'economic',
      conflict: 'opportunity_id',
    },
    indexes: [
      ['cv_opportunities_match_time', '(match_id,observed_at DESC)'],
      ['cv_opportunities_observed_id', '(observed_at,opportunity_id)'],
      ['cv_opportunities_economic_time', '(observed_at DESC) WHERE economic'],
    ],
  },
  {
    table: 'cv_basis_samples', time: 'observed_at', keepDays: 1,
    parentUnique: [
      ['cv_basis_samples_id_observed_uq', '(sample_id,observed_at)'],
    ],
    retain: {
      table: 'cv_basis_samples_retained',
      predicate: 'entry_economic',
      conflict: 'sample_id',
    },
    indexes: [
      ['cv_basis_samples_pair_time', '(match_id,direction,quantity,observed_at)'],
      ['cv_basis_samples_observed_id', '(observed_at,sample_id)'],
      ['cv_basis_samples_entry_time', '(observed_at DESC) WHERE entry_economic'],
    ],
  },
]);

function qid(value) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(String(value))) throw new Error(`unsafe identifier: ${value}`);
  return `"${String(value).replaceAll('"', '""')}"`;
}

function qualifiedIdentifier(value) {
  return String(value).split('.').map(qid).join('.');
}

function literal(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function readReceipt(file) {
  const content = fs.readFileSync(file, 'utf8');
  return Object.fromEntries(content.split(/\r?\n/).filter((line) => line.includes('='))
    .map((line) => {
      const split = line.indexOf('=');
      return [line.slice(0, split), line.slice(split + 1)];
    }));
}

function receiptAgeSeconds(receipt, nowMs = Date.now()) {
  const completed = Date.parse(receipt?.completed_at || '');
  return Number.isFinite(completed) ? Math.max(0, (nowMs - completed) / 1000) : Infinity;
}

function listFiles(root, suffix) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? listFiles(target, suffix)
      : entry.isFile() && entry.name.endsWith(suffix) ? [target] : [];
  });
}

function latestSnapshot(root = DEFAULT_SNAPSHOT_ROOT) {
  return listFiles(root, '.dump')
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0] || null;
}

function sidecarSha(file) {
  const sidecar = `${file}.sha256`;
  if (!fs.existsSync(sidecar)) throw new Error(`snapshot checksum sidecar missing: ${sidecar}`);
  const value = fs.readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error(`invalid snapshot checksum: ${sidecar}`);
  return value.toLowerCase();
}

function verifyMigrationAuthority(options = {}) {
  if (process.env.DELTAFORGE_PARTITION_MIGRATION_CONFIRM !== MIGRATION_CONFIRM) {
    throw new Error(`set DELTAFORGE_PARTITION_MIGRATION_CONFIRM=${MIGRATION_CONFIRM}`);
  }
  const receiptFile = options.snapshotReceipt || DEFAULT_SNAPSHOT_RECEIPT;
  const receipt = readReceipt(receiptFile);
  if (receipt.format !== 'deltaforge-offhost-receipt-v1'
      || receipt.scope !== 'database-snapshots') {
    throw new Error('off-host snapshot receipt is missing or invalid');
  }
  if (receiptAgeSeconds(receipt) > 6 * 3600) throw new Error('off-host snapshot receipt is stale');
  const snapshot = latestSnapshot(options.snapshotRoot || DEFAULT_SNAPSHOT_ROOT);
  if (!snapshot) throw new Error('no local verified database snapshot exists');
  const expected = sidecarSha(snapshot);
  if (String(receipt.latest_sha256 || '').toLowerCase() !== expected) {
    throw new Error('off-host receipt does not match the latest local snapshot checksum');
  }
  let profile = null;
  let rawAuthority = null;
  if (path.basename(snapshot).startsWith('deltaforge-bounded-')) {
    const profileFile = `${snapshot}.profile`;
    profile = readReceipt(profileFile);
    if (profile.format !== 'deltaforge-db-snapshot-profile-v1'
        || profile.profile !== 'replayable-hot-tier-excluded-v1') {
      throw new Error('bounded snapshot profile is missing or invalid');
    }
    const requiredRawCutoff = Number(profile.required_raw_source_cutoff_epoch);
    if (!Number.isInteger(requiredRawCutoff) || requiredRawCutoff <= 0) {
      throw new Error('bounded snapshot has no valid raw-source cutoff');
    }
    rawAuthority = verifyRetentionAuthority({
      archiveReceipt: options.archiveReceipt || DEFAULT_ARCHIVE_RECEIPT,
    });
    if (rawAuthority.sourceCutoffEpoch < requiredRawCutoff) {
      throw new Error('raw off-host receipt does not cover the bounded snapshot exclusions');
    }
  }
  return {
    receiptFile, receipt, snapshot, sha256: expected, profile, rawAuthority,
  };
}

function verifyRetentionAuthority(options = {}) {
  const receipt = readReceipt(options.archiveReceipt || DEFAULT_ARCHIVE_RECEIPT);
  if (receipt.format !== 'deltaforge-offhost-receipt-v1'
      || receipt.scope !== 'raw-wal-and-db-archive') {
    throw new Error('off-host raw archive receipt is missing or invalid');
  }
  if (receiptAgeSeconds(receipt) > 3 * 3600) throw new Error('off-host raw archive receipt is stale');
  const sourceCutoffEpoch = Number(receipt.source_cutoff_epoch);
  if (!Number.isInteger(sourceCutoffEpoch) || sourceCutoffEpoch <= 0) {
    throw new Error('off-host raw archive receipt has no source cutoff');
  }
  if (!receipt.latest_file || receipt.latest_file === 'none') {
    throw new Error('off-host raw archive receipt contains no immutable object');
  }
  return { receipt, sourceCutoffEpoch };
}

function utcDay(value = Date.now()) {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function dayStamp(ms) {
  return new Date(ms).toISOString().slice(0, 10).replaceAll('-', '');
}

function partitionName(spec, dayMs) {
  return `${spec.table}_p${dayStamp(dayMs)}`;
}

async function createRetainedTable(client, spec) {
  if (!spec.retain) return;
  const table = qid(spec.retain.table);
  await client.query(`CREATE TABLE IF NOT EXISTS ${table}
    (LIKE ${qid(spec.table)} INCLUDING DEFAULTS INCLUDING STORAGE INCLUDING COMMENTS)`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${qid(`${spec.retain.table}_${spec.retain.conflict}_key`)}
    ON ${table} (${qid(spec.retain.conflict)})`);
}

async function preserveRetainedRows(client, spec) {
  if (!spec.retain) return 0;
  await createRetainedTable(client, spec);
  const result = await client.query(`
    INSERT INTO ${qid(spec.retain.table)}
    SELECT * FROM ${qid(spec.table)} WHERE ${spec.retain.predicate}
    ON CONFLICT (${qid(spec.retain.conflict)}) DO NOTHING`);
  return result.rowCount;
}

async function createPartition(client, spec, dayMs) {
  const child = partitionName(spec, dayMs);
  const from = new Date(dayMs).toISOString();
  const to = new Date(dayMs + DAY_MS).toISOString();
  await client.query(`CREATE TABLE IF NOT EXISTS ${qid(child)}
    PARTITION OF ${qid(spec.table)}
    FOR VALUES FROM ('${from}') TO ('${to}')`);
}

async function ensurePartitions(client, spec, options = {}) {
  const base = utcDay(options.nowMs);
  const pastDays = Number.isInteger(options.pastDays) ? options.pastDays : 1;
  const futureDays = Number.isInteger(options.futureDays) ? options.futureDays : 7;
  for (let offset = -pastDays; offset <= futureDays; offset += 1) {
    await createPartition(client, spec, base + offset * DAY_MS);
  }
}

async function parentIndexes(client, spec) {
  if (spec.id) {
    await client.query(`CREATE INDEX ${qid(`${spec.table}_id_idx`)}
      ON ${qid(spec.table)} (${qid(spec.id)})`);
  }
  for (const [name, definition] of spec.indexes || []) {
    await client.query(`CREATE INDEX ${qid(name)} ON ${qid(spec.table)} ${definition}`);
  }
  for (const [name, definition] of spec.parentUnique || []) {
    await client.query(`CREATE UNIQUE INDEX ${qid(name)} ON ${qid(spec.table)} ${definition}`);
  }
  for (let index = 0; index < (spec.foreignKeys || []).length; index += 1) {
    await client.query(`ALTER TABLE ${qid(spec.table)}
      ADD CONSTRAINT ${qid(`${spec.table}_partition_fk_${index + 1}`)}
      ${spec.foreignKeys[index]}`);
  }
}

async function migrateTable(pool, spec, options = {}) {
  const client = await pool.connect();
  const legacy = `${spec.table}_unpartitioned_v11`;
  let sequence = null;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='0'");
    const { rows } = await client.query(`
      SELECT c.relkind
        FROM pg_class c
       WHERE c.oid=to_regclass($1)`, [`public.${spec.table}`]);
    if (!rows.length) {
      await client.query('ROLLBACK');
      return { table: spec.table, status: 'MISSING' };
    }
    for (const statement of spec.preMigrate || []) await client.query(statement);
    if (rows[0].relkind === 'p') {
      await ensurePartitions(client, spec, options);
      await createRetainedTable(client, spec);
      await client.query('COMMIT');
      return { table: spec.table, status: 'ALREADY_PARTITIONED' };
    }
    if (rows[0].relkind !== 'r') throw new Error(`${spec.table} is not an ordinary table`);
    if (spec.id) {
      const sequenceResult = await client.query(
        'SELECT pg_get_serial_sequence($1,$2) sequence',
        [`public.${spec.table}`, spec.id],
      );
      sequence = sequenceResult.rows[0]?.sequence || null;
    }
    await client.query(`LOCK TABLE ${qid(spec.table)} IN ACCESS EXCLUSIVE MODE`);
    await preserveRetainedRows(client, spec);
    if (options.truncate !== true) {
      const nonempty = await client.query(`SELECT 1 FROM ${qid(spec.table)} LIMIT 1`);
      if (nonempty.rowCount) throw new Error(`${spec.table} is non-empty; --truncate is required`);
    } else {
      await client.query(`TRUNCATE TABLE ${qid(spec.table)}`);
    }
    if (sequence) {
      await client.query(`ALTER SEQUENCE ${qualifiedIdentifier(sequence)} OWNED BY NONE`);
    }
    await client.query(`ALTER TABLE ${qid(spec.table)} RENAME TO ${qid(legacy)}`);
    await client.query(`CREATE TABLE ${qid(spec.table)}
      (LIKE ${qid(legacy)} INCLUDING DEFAULTS INCLUDING STORAGE INCLUDING COMMENTS)
      PARTITION BY RANGE (${qid(spec.time)})`);
    await client.query(`DROP TABLE ${qid(legacy)}`);
    if (sequence) {
      await client.query(`ALTER SEQUENCE ${qualifiedIdentifier(sequence)}
        OWNED BY ${qid(spec.table)}.${qid(spec.id)}`);
      await client.query(`ALTER TABLE ${qid(spec.table)} ALTER COLUMN ${qid(spec.id)}
        SET DEFAULT nextval(${literal(sequence)}::regclass)`);
    }
    await parentIndexes(client, spec);
    await ensurePartitions(client, spec, options);
    await createRetainedTable(client, spec);
    await client.query('COMMIT');
    return { table: spec.table, status: 'MIGRATED' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw Object.assign(error, { table: spec.table });
  } finally {
    client.release();
  }
}

async function dropOldPartitions(client, spec, authority, options = {}) {
  const base = utcDay(options.nowMs);
  const keepFrom = base - spec.keepDays * DAY_MS;
  const prefix = `${spec.table}_p`;
  const { rows } = await client.query(`
    SELECT child.relname child
      FROM pg_inherits i
      JOIN pg_class parent ON parent.oid=i.inhparent
      JOIN pg_class child ON child.oid=i.inhrelid
     WHERE parent.oid=to_regclass($1)
  `, [`public.${spec.table}`]);
  const dropped = [];
  for (const row of rows) {
    if (!row.child.startsWith(prefix)) continue;
    const stamp = row.child.slice(prefix.length);
    if (!/^\d{8}$/.test(stamp)) continue;
    const dayMs = Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8));
    const endEpoch = (dayMs + DAY_MS) / 1000;
    if (dayMs >= keepFrom || endEpoch > authority.sourceCutoffEpoch) continue;
    if (spec.retain) {
      await client.query(`
        INSERT INTO ${qid(spec.retain.table)}
        SELECT * FROM ${qid(row.child)} WHERE ${spec.retain.predicate}
        ON CONFLICT (${qid(spec.retain.conflict)}) DO NOTHING`);
    }
    await client.query(`DROP TABLE ${qid(row.child)}`);
    dropped.push(row.child);
  }
  return dropped;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const args = new Set(process.argv.slice(2));
  const migrate = args.has('--migrate');
  const ensure = args.has('--ensure') || migrate;
  const dropOld = args.has('--drop-old');
  if (!migrate && !ensure && !dropOld) {
    throw new Error('use --migrate, --ensure and/or --drop-old');
  }
  const local = /(?:localhost|127\.0\.0\.1|\/deltaforge)/i.test(process.env.DATABASE_URL);
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: local ? false : { rejectUnauthorized: false },
    max: 2,
  });
  const report = {
    format: 'deltaforge-hot-tier-partitions-v1',
    checkedAt: new Date().toISOString(),
    migrate, ensure, dropOld, tables: [], dropped: [], errors: [],
  };
  let locked = false;
  try {
    const { rows } = await pool.query(
      'SELECT pg_try_advisory_lock(hashtext($1)) acquired', [PARTITION_LOCK]);
    locked = rows[0]?.acquired === true;
    if (!locked) {
      report.status = 'SKIPPED_LOCKED';
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    if (migrate) report.migrationAuthority = verifyMigrationAuthority();
    const authority = dropOld ? verifyRetentionAuthority() : null;
    for (const spec of SPECS) {
      try {
        if (migrate) {
          report.tables.push(await migrateTable(pool, spec, {
            truncate: args.has('--truncate'), futureDays: 7, pastDays: 1,
          }));
        } else if (ensure) {
          const client = await pool.connect();
          try {
            await ensurePartitions(client, spec);
            await createRetainedTable(client, spec);
            report.tables.push({ table: spec.table, status: 'ENSURED' });
          } finally { client.release(); }
        }
        if (dropOld) {
          const client = await pool.connect();
          try {
            report.dropped.push(...await dropOldPartitions(client, spec, authority));
          } finally { client.release(); }
        }
      } catch (error) {
        report.errors.push({ table: spec.table, error: error.message });
        if (migrate) break;
      }
    }
    report.status = report.errors.length ? 'DEGRADED' : 'PASS';
    // Avoid leaking the operator's local iCloud path through API/log output.
    if (report.migrationAuthority) {
      report.migrationAuthority = {
        snapshot: path.basename(report.migrationAuthority.snapshot),
        sha256: report.migrationAuthority.sha256,
        receiptCompletedAt: report.migrationAuthority.receipt.completed_at,
      };
    }
    await pool.query(`
      INSERT INTO system_heartbeats(component,beat_at,meta)
      VALUES ('hot_partition_manager',now(),$1::jsonb)
      ON CONFLICT(component) DO UPDATE SET beat_at=now(),meta=EXCLUDED.meta
    `, [JSON.stringify({
      format: report.format,
      status: report.status,
      checkedAt: report.checkedAt,
      migrated: report.tables.filter((row) => row.status === 'MIGRATED').length,
      ensured: report.tables.filter((row) => row.status === 'ENSURED').length,
      droppedPartitions: report.dropped.length,
      errorCount: report.errors.length,
      paperDataOnly: true,
    })]).catch(() => {});
    console.log(JSON.stringify(report, null, 2));
    if (report.errors.length) process.exitCode = 1;
  } finally {
    if (locked) {
      await pool.query('SELECT pg_advisory_unlock(hashtext($1))', [PARTITION_LOCK]).catch(() => {});
    }
    await pool.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

module.exports = {
  DAY_MS, MIGRATION_CONFIRM, PARTITION_LOCK, SPECS,
  dayStamp, partitionName, readReceipt, receiptAgeSeconds,
  verifyMigrationAuthority, verifyRetentionAuthority,
};
