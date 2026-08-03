/**
 * Durable raw-tape archive for BORG.
 *
 * The Neon database is intentionally only a short rolling buffer. Before a
 * raw row is removed from Postgres, it is written to an atomic, verified gzip
 * NDJSON batch on the collector's durable hot tier. A crash after rename but
 * before DELETE is safe: the deterministic filename is found and verified on
 * the next pass, then those exact rows are deleted.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const zlib = require('zlib');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const fsp = fs.promises;

const TABLES = Object.freeze({
  // CLOB events/touches and one-second book projections are intentionally
  // absent. Their source frames are already append-before-process WAL data;
  // daily PostgreSQL partitions provide the bounded query tier. Archiving
  // those rows again created a circular disk failure in which duplicate gzip
  // output consumed the reserve needed to run the archiver.
  borg_taker_trades: { key: 'id', keyType: 'bigint', time: 'ts' },
  borg_binance_1s: { key: 'symbol_ts', keyType: 'composite', time: 'ts' },
  borg_coinbase_1s: { key: 'product_ts', keyType: 'composite', time: 'ts' },
  borg_rtds_ticks: { key: 'id', keyType: 'bigint', time: 'received_at' },
  // Flow signals retain an FK to their trigger trade for reproducible feature
  // attribution. Referenced trades are the small query tier; archive/prune only
  // the unreferenced public tape. Without this predicate the same verified
  // batch is retried forever and DELETE correctly fails on the FK.
  pm_flow_trades: {
    key: 'id', keyType: 'bigint', time: 'observed_at',
    // Most old ids are intentionally retained because a signal references
    // them. Walking the primary key therefore scans a large protected prefix
    // before finding an archivable row. Use the existing observed_at index,
    // then id for deterministic ties, so LIMIT remains bounded under load.
    archiveOrder: 'time_id',
    predicate: 'NOT EXISTS (SELECT 1 FROM pm_flow_signals s WHERE s.trigger_trade_id=t.id)',
  },
  pm_flow_touches: { key: 'id', keyType: 'bigint', time: 'observed_at' },
  pm_flow_connection_events: { key: 'id', keyType: 'bigint', time: 'observed_at' },
});

const DEFAULT_ARCHIVE_DIR = path.join(os.homedir(), '.deltaforge-archive', 'borg-raw');
const FORMAT = 'borg-raw-ndjson-v1';

function envPositiveNumber(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function iso(value) {
  return new Date(value).toISOString();
}

function safeStamp(value) {
  return iso(value).replace(/[:.]/g, '-');
}

function encodeRows(rows) {
  return Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

async function availableBytes(archiveDir) {
  await fsp.mkdir(archiveDir, { recursive: true });
  const stat = await fsp.statfs(archiveDir);
  return Number(stat.bavail) * Number(stat.bsize);
}

async function syncDirectory(dir) {
  // APFS supports fsync on directories. Keep the archive usable on filesystems
  // that do not by treating EINVAL/ENOTSUP as a portability limitation.
  let handle;
  try {
    handle = await fsp.open(dir, 'r');
    await handle.sync();
  } catch (err) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(err.code)) throw err;
  } finally {
    if (handle) await handle.close();
  }
}

async function atomicWrite(file, bytes) {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  let handle;
  try {
    handle = await fsp.open(tmp, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(tmp, file);
    await syncDirectory(dir);
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

async function verifyArchive(file, expected) {
  const packed = await fsp.readFile(file);
  const plain = await gunzip(packed);
  const newline = plain.indexOf(0x0a);
  if (newline < 0) throw new Error(`archive has no metadata line: ${file}`);
  const header = JSON.parse(plain.subarray(0, newline).toString('utf8'))._borg_archive;
  const rowsBytes = plain.subarray(newline + 1);
  const sha256 = crypto.createHash('sha256').update(rowsBytes).digest('hex');
  if (!header || header.format !== FORMAT || header.table !== expected.table ||
      header.row_count !== expected.row_count || header.sha256 !== expected.sha256 ||
      sha256 !== expected.sha256) {
    throw new Error(`archive verification failed: ${file}`);
  }
  return { compressed_bytes: packed.length, uncompressed_bytes: plain.length };
}

async function writeArchiveBatch(table, rows, cutoff, options = {}) {
  if (!TABLES[table]) throw new Error(`refusing unknown archive table: ${table}`);
  if (!rows.length) return null;

  const archiveDir = options.archiveDir || process.env.BORG_ARCHIVE_DIR || DEFAULT_ARCHIVE_DIR;
  const minFreeBytes = (options.minFreeGb ?? envPositiveNumber('BORG_ARCHIVE_MIN_FREE_GB', 10)) * 1024 ** 3;
  const rowsBytes = encodeRows(rows);
  const sha256 = crypto.createHash('sha256').update(rowsBytes).digest('hex');
  const timeColumn = TABLES[table].time;
  // Bigint-backed tape is selected in append order so PostgreSQL can use the
  // primary key instead of sorting the full retention backlog. Late source
  // timestamps can therefore be slightly out of order; derive the true batch
  // bounds rather than assuming row order is chronological.
  const timestamps = rows.map((row) => new Date(row[timeColumn]).getTime());
  const firstTs = iso(Math.min(...timestamps));
  const lastTs = iso(Math.max(...timestamps));
  const header = {
    _borg_archive: {
      format: FORMAT,
      table,
      row_count: rows.length,
      first_ts: firstTs,
      last_ts: lastTs,
      cutoff: iso(cutoff),
      sha256,
      archived_at: new Date().toISOString(),
    },
  };
  const plain = Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), rowsBytes]);
  const packed = await gzip(plain, { level: 6 });

  const free = await availableBytes(archiveDir);
  if (free - packed.length < minFreeBytes) {
    throw new Error(
      `archive disk reserve breached: ${(free / 1024 ** 3).toFixed(1)} GiB free, ` +
      `${(minFreeBytes / 1024 ** 3).toFixed(1)} GiB required; database rows were NOT pruned`,
    );
  }

  const dayDir = path.join(archiveDir, table, firstTs.slice(0, 10));
  const filename = `${safeStamp(firstTs)}__${safeStamp(lastTs)}__${sha256.slice(0, 16)}.ndjson.gz`;
  const file = path.join(dayDir, filename);
  try {
    await fsp.access(file, fs.constants.R_OK);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    await atomicWrite(file, packed);
  }

  const verified = await verifyArchive(file, { table, row_count: rows.length, sha256 });
  return { file, sha256, row_count: rows.length, first_ts: firstTs, last_ts: lastTs, ...verified };
}

async function selectBatch(pool, table, cutoff, batchSize) {
  const time = TABLES[table].time;
  const predicate = TABLES[table].predicate ? ` AND ${TABLES[table].predicate}` : '';
  // The timestamp-only ORDER BY previously forced a tens-of-millions-of-rows
  // sort for borg_clob_touch despite LIMIT 5000. Bigint ids are append-only,
  // deterministic, and indexed, while the timestamp predicate still enforces
  // the exact safe retention cutoff.
  const order = TABLES[table].archiveOrder === 'time_id' ? `t.${time}, t.id`
    : TABLES[table].keyType === 'bigint' ? 't.id'
    : TABLES[table].key === 'symbol_ts' ? `t.${time}, t.symbol`
    : TABLES[table].key === 'product_ts' ? `t.${time}, t.product`
    : `t.${time}, t.id`;
  const { rows } = await pool.query(
    `SELECT t.* FROM ${table} t
      WHERE t.${time} < $1${predicate}
      ORDER BY ${order} LIMIT $2`,
    [cutoff, batchSize],
  );
  return rows;
}

async function deleteExactBatch(pool, table, rows) {
  if (TABLES[table].key === 'symbol_ts') {
    const symbols = rows.map((row) => row.symbol);
    const timestamps = rows.map((row) => row.ts);
    return pool.query(
      `DELETE FROM ${table} t USING unnest($1::text[], $2::timestamptz[]) AS k(symbol, ts)
       WHERE t.symbol = k.symbol AND t.ts = k.ts`,
      [symbols, timestamps],
    );
  }
  if (TABLES[table].key === 'product_ts') {
    const products = rows.map((row) => row.product);
    const timestamps = rows.map((row) => row.ts);
    return pool.query(
      `DELETE FROM ${table} t USING unnest($1::text[], $2::timestamptz[]) AS k(product, ts)
       WHERE t.product = k.product AND t.ts = k.ts`,
      [products, timestamps],
    );
  }
  return pool.query(`DELETE FROM ${table} WHERE id = ANY($1::bigint[])`, [rows.map((row) => String(row.id))]);
}

async function archiveTable(pool, table, cutoff, options = {}) {
  const batchSize = options.batchSize ?? Math.floor(envPositiveNumber('BORG_ARCHIVE_BATCH_ROWS', 5000));
  const maxBatches = Number.isFinite(options.maxBatches) && options.maxBatches > 0
    ? Math.floor(options.maxBatches)
    : null;
  const totals = {
    table, rows: 0, files: 0, compressed_bytes: 0, first_ts: null, last_ts: null,
    batch_limit_reached: false, duration_limit_reached: false,
  };
  while (true) {
    if (Number.isFinite(options.deadlineAt) && Date.now() >= options.deadlineAt) {
      totals.duration_limit_reached = true;
      break;
    }
    if (maxBatches != null && totals.files >= maxBatches) {
      totals.batch_limit_reached = true;
      break;
    }
    const rows = await selectBatch(pool, table, cutoff, batchSize);
    if (!rows.length) break;
    const saved = await writeArchiveBatch(table, rows, cutoff, options);
    const deleted = await deleteExactBatch(pool, table, rows);
    if (deleted.rowCount !== rows.length) {
      throw new Error(
        `${table}: archived ${rows.length} rows but exact DELETE removed ${deleted.rowCount}; ` +
        'archive is safe, investigate concurrent pruning',
      );
    }
    totals.rows += rows.length;
    totals.files += 1;
    totals.compressed_bytes += saved.compressed_bytes;
    totals.first_ts ||= saved.first_ts;
    totals.last_ts = saved.last_ts;
  }
  return totals;
}

async function atomicWriteJson(file, value) {
  await atomicWrite(file, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
}

async function archiveAndPrune(pool, cutoff, options = {}) {
  const archiveDir = options.archiveDir || process.env.BORG_ARCHIVE_DIR || DEFAULT_ARCHIVE_DIR;
  const startedAt = new Date().toISOString();
  const results = [];
  const errors = [];
  const preferred = Array.isArray(options.tableOrder)
    ? options.tableOrder.filter((table) => TABLES[table]) : [];
  const tables = [...new Set([...preferred, ...Object.keys(TABLES)])];
  for (const table of tables) {
    if (Number.isFinite(options.deadlineAt) && Date.now() >= options.deadlineAt) break;
    try {
      results.push(await archiveTable(pool, table, cutoff, {
        ...options,
        archiveDir,
        maxBatches: options.maxBatchesByTable?.[table] ?? options.maxBatchesPerTable,
      }));
    } catch (err) {
      errors.push({ table, error: err.message });
      console.warn(`archive/prune ${table} refused: ${err.message}`);
    }
  }
  const free = await availableBytes(archiveDir).catch(() => null);
  const state = {
    format: FORMAT,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    cutoff: iso(cutoff),
    archive_dir: archiveDir,
    free_bytes: free,
    duration_limit_reached: results.some((row) => row.duration_limit_reached),
    results,
    errors,
  };
  await atomicWriteJson(path.join(archiveDir, 'archive-state.json'), state);
  return state;
}

async function safeArchiveCutoff(pool, options = {}) {
  const { rows } = await pool.query(
    `SELECT now() AS db_now, MIN(o.ts) AS oldest FROM borg_shadow_orders o
     LEFT JOIN borg_shadow_scores s ON s.order_id = o.id
     WHERE o.action='place' AND s.order_id IS NULL`);
  const dbNow = new Date(rows[0].db_now);
  const configuredHours = Number(options.hotRetentionHours
    ?? process.env.BORG_DB_HOT_RETENTION_HOURS ?? 24);
  const hotRetentionHours = Number.isFinite(configuredHours) && configuredHours >= 2
    ? configuredHours : 24;
  const rollingCutoff = new Date(dbNow.getTime() - hotRetentionHours * 60 * 60 * 1000);
  const unscoredCutoff = rows[0]?.oldest
    ? new Date(new Date(rows[0].oldest).getTime() - 60 * 60 * 1000)
    : rollingCutoff;
  return {
    cutoff: unscoredCutoff < rollingCutoff ? unscoredCutoff : rollingCutoff,
    dbNow, rollingCutoff, unscoredCutoff, hotRetentionHours,
    oldestUnscoredAt: rows[0]?.oldest || null,
  };
}

module.exports = {
  DEFAULT_ARCHIVE_DIR,
  FORMAT,
  TABLES,
  archiveAndPrune,
  archiveTable,
  encodeRows,
  safeArchiveCutoff,
  verifyArchive,
  writeArchiveBatch,
};
