'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { DuckDBInstance } = require('@duckdb/node-api');
const { sha256, stableStringify } = require('./contracts');
const { lfDelimitedLines } = require('./strict-ndjson');
const {
  parseCombinedReport,
  remoteTarget,
  safeRemoteName,
  safeRemotePath,
  validateRcloneConfig,
} = require('../../scripts/google-drive-archive');
const { sha256File, writeAtomic } = require('../../scripts/object-store-archive');

const DATASET_VERSION = 'event-envelope-v1';
const STATE_FORMAT = 'deltaforge-parquet-lake-state-v1';
const DEFAULT_STATE_ROOT = '/var/lib/deltaforge/parquet-lake';
const DEFAULT_HOT_ROOT = '/var/lib/deltaforge/parquet-hot';
const DEFAULT_STAGE_ROOT = '/var/lib/deltaforge/parquet-stage';
const DEFAULT_RECEIPT_NAME = 'receipt';
const DEFAULT_RAW_STATE = '/var/lib/deltaforge/google-drive-archive/state.json';
const DEFAULT_CONFIG = '/var/lib/deltaforge/google-drive-archive/rclone.conf';
const DEFAULT_PREFIX = 'VPS Data';
const DEFAULT_MAX_FILES = 250;
const DEFAULT_MAX_BYTES = 2 * 1024 ** 3;
const DEFAULT_HOT_BYTES = 10 * 1024 ** 3;
const DEFAULT_MIN_FREE_BYTES = 15 * 1024 ** 3;
const DEFAULT_EXPANSION_RESERVE_MULTIPLIER = 24;
const INVALID_WAL_SEGMENT = 'INVALID_WAL_SEGMENT';

const SOURCE_TIME_FIELDS = Object.freeze([
  'source_timestamp_ms', 'source_timestamp', 'source_ts', 'exchange_timestamp',
  'exchange_ts', 'event_timestamp', 'event_ts', 'trade_timestamp', 'trade_ts',
  'published_at', 'round_updated_at', 'ts', 'timestamp',
]);
const RECEIVE_TIME_FIELDS = Object.freeze([
  'receive_wall_timestamp_ms', 'receive_wall_timestamp', 'received_at',
  'local_received_at', 'ingested_at', 'observed_at',
]);
const MONOTONIC_FIELDS = Object.freeze([
  'receive_monotonic_ns', 'receive_monotonic_timestamp', 'monotonic_ns',
  'received_monotonic_ns',
]);
const SEQUENCE_FIELDS = Object.freeze([
  'event_sequence', 'sequence_id', 'sequence', 'seq', 'update_id',
  'last_update_id',
]);
const CONNECTION_FIELDS = Object.freeze([
  'connection_epoch', 'connection_id', 'connection_run_id',
]);
const COLLECTION_FIELDS = Object.freeze([
  'collection_epoch_id', 'collector_run_id', 'run_id', 'epoch_id',
]);
const TYPE_FIELDS = Object.freeze(['event_type', 'type', 'kind', 'channel', 'event']);

function positiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function diskFreeBytes(root) {
  const stat = fs.statfsSync(root);
  return Number(stat.bavail) * Number(stat.bsize);
}

function assertDiskReserve(root, minFreeBytes, context = 'Parquet compaction') {
  const free = diskFreeBytes(root);
  const required = positiveInt(minFreeBytes, DEFAULT_MIN_FREE_BYTES);
  if (free < required) {
    throw new Error(`${context}: ${free} free bytes is below the ${required} byte reserve`);
  }
  return free;
}

function firstPresent(object, fields) {
  for (const field of fields) {
    if (object?.[field] !== undefined && object[field] !== null && object[field] !== '') {
      return object[field];
    }
  }
  return null;
}

function timeMilliseconds(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' || /^-?\d+(?:\.\d+)?$/.test(String(value))) {
    let number = Number(value);
    if (!Number.isFinite(number)) return null;
    if (Math.abs(number) < 1e11) number *= 1000;
    return Number.isFinite(number) ? Math.trunc(number) : null;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function safeScalar(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value);
}

function sourceFromRelative(relative) {
  const normalized = String(relative || '').replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.includes('../') || normalized.includes('/..')) {
    throw new Error(`unsafe WAL relative path: ${relative}`);
  }
  const [source, date, file, ...extra] = normalized.split('/');
  if (extra.length || !/^[a-z0-9][a-z0-9-]*$/.test(source || '')
      || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')
      || !/^[A-Za-z0-9._-]+\.ndjson\.gz$/.test(file || '')) {
    throw new Error(`unexpected WAL relative path: ${relative}`);
  }
  return { source, pathDate: date, file };
}

function segmentFallbackMs(record, header) {
  const opened = header?._borg_wal?.opened_at || header?._borg_archive?.created_at;
  const parsed = timeMilliseconds(opened);
  if (parsed != null) return parsed;
  const match = sourceFromRelative(record.relative).file.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/,
  );
  if (match) return Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
  return Number(record.mtimeMs) || null;
}

function envelopeFor(row, header, record, rowIndex) {
  const sourceRaw = firstPresent(row, SOURCE_TIME_FIELDS);
  const receiveRaw = firstPresent(row, RECEIVE_TIME_FIELDS);
  const sourceMs = timeMilliseconds(sourceRaw);
  const receiveMs = timeMilliseconds(receiveRaw);
  const partitionMs = receiveMs ?? sourceMs ?? segmentFallbackMs(record, header);
  if (!Number.isFinite(partitionMs)) throw new Error(`${record.relative}: no usable event/segment time`);
  const partition = new Date(partitionMs);
  const source = sourceFromRelative(record.relative).source;
  return {
    datasetVersion: DATASET_VERSION,
    source,
    eventDate: partition.toISOString().slice(0, 10),
    eventHour: partition.getUTCHours(),
    sourceSegment: record.relative,
    sourceSegmentSha256: record.sha256,
    sourceSegmentRow: BigInt(rowIndex),
    eventType: safeScalar(firstPresent(row, TYPE_FIELDS)),
    sourceTime: sourceRaw == null ? null : safeScalar(sourceRaw),
    sourceTimeMs: sourceMs == null ? null : BigInt(sourceMs),
    receiveWallTime: receiveRaw == null ? null : safeScalar(receiveRaw),
    receiveWallTimeMs: receiveMs == null ? null : BigInt(receiveMs),
    receiveMonotonicNs: safeScalar(firstPresent(row, MONOTONIC_FIELDS)),
    sequenceId: safeScalar(firstPresent(row, SEQUENCE_FIELDS)),
    connectionEpoch: safeScalar(firstPresent(row, CONNECTION_FIELDS)),
    collectionEpochId: safeScalar(firstPresent(row, COLLECTION_FIELDS)
      ?? header?._borg_wal?.collection_epoch_id
      ?? header?._borg_archive?.collection_epoch_id),
    eventJson: JSON.stringify(row),
    segmentHeaderJson: JSON.stringify(header),
  };
}

function emptyLakeState() {
  return { format: STATE_FORMAT, sources: {}, rejectedSources: {}, batches: {} };
}

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function loadLakeState(file) {
  const state = loadJson(file, emptyLakeState());
  if (state?.format !== STATE_FORMAT) throw new Error(`unsupported Parquet lake state: ${state?.format}`);
  state.sources ||= {};
  state.rejectedSources ||= {};
  state.batches ||= {};
  return state;
}

function receiptFile(env, stateRoot) {
  return path.resolve(env.PARQUET_LAKE_RECEIPT || path.join(stateRoot, DEFAULT_RECEIPT_NAME));
}

function latestVerifiedBatch(state) {
  const rows = Object.entries(state?.batches || {})
    .filter(([, batch]) => batch?.verified === true)
    .sort((left, right) => String(right[1].verifiedAt || '')
      .localeCompare(String(left[1].verifiedAt || '')));
  if (!rows.length) return null;
  const [batchHashValue, batch] = rows[0];
  return { batchHash: batchHashValue, ...batch };
}

function normalizeSources(value) {
  if (!value) return null;
  const values = Array.isArray(value) ? value : String(value).split(',');
  const sources = values.map((source) => String(source).trim()).filter(Boolean);
  for (const source of sources) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(source)) throw new Error(`unsafe source: ${source}`);
  }
  return new Set(sources);
}

function selectVerifiedRawObjects(rawState, lakeState, options = {}) {
  if (rawState?.format !== 'deltaforge-google-drive-state-v1') {
    throw new Error('verified Google Drive raw state is unavailable or unsupported');
  }
  const sources = normalizeSources(options.sources);
  const maxFiles = positiveInt(options.maxFiles, DEFAULT_MAX_FILES);
  const maxBytes = positiveInt(options.maxBytes, DEFAULT_MAX_BYTES);
  const cutoffMs = Number.isFinite(Number(options.cutoffMs)) ? Number(options.cutoffMs) : Infinity;
  const candidates = [];
  for (const [id, entry] of Object.entries(rawState.objects || {})) {
    if (entry.namespace !== 'wal' || entry.verified !== true) continue;
    if (!String(entry.relative || '').endsWith('.ndjson.gz')) continue;
    if (!/^[a-f0-9]{64}$/.test(String(entry.sha256 || ''))) continue;
    if (lakeState.sources[id]) continue;
    const rejected = lakeState.rejectedSources?.[id];
    // Rejections are content-addressed. A changed upstream object must be
    // reconsidered rather than inheriting an old verdict for the same key.
    if (rejected?.sha256 === entry.sha256) continue;
    const parsed = sourceFromRelative(entry.relative);
    if (sources && !sources.has(parsed.source)) continue;
    if (Number(entry.mtimeMs) > cutoffMs) continue;
    candidates.push({
      id,
      namespace: 'wal',
      relative: entry.relative,
      source: parsed.source,
      size: Number(entry.size),
      mtimeMs: Number(entry.mtimeMs),
      sha256: entry.sha256,
    });
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || left.relative.localeCompare(right.relative));
  const selected = [];
  let bytes = 0;
  for (const record of candidates) {
    if (selected.length >= maxFiles) break;
    if (selected.length && bytes + record.size > maxBytes) break;
    selected.push(record);
    bytes += record.size;
  }
  return { records: selected, bytes, remaining: Math.max(0, candidates.length - selected.length) };
}

function batchHash(records) {
  if (!records.length) throw new Error('cannot hash an empty Parquet batch');
  const identity = records.map((record) => ({
    id: record.id, relative: record.relative, sha256: record.sha256, size: record.size,
  })).sort((left, right) => left.id.localeCompare(right.id));
  return sha256(stableStringify({ dataset: DATASET_VERSION, inputs: identity })).slice(0, 32);
}

async function verifyStagedRecord(record) {
  const stat = await fs.promises.stat(record.file);
  if (stat.size !== record.size) throw new Error(`${record.relative}: staged size mismatch`);
  const digest = await sha256File(record.file);
  if (digest !== record.sha256) throw new Error(`${record.relative}: staged SHA-256 mismatch`);
  return true;
}

function invalidWalSegmentError(record, reason, details = {}) {
  const safeReason = String(reason || 'invalid WAL segment')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 500);
  const error = new Error(`${record.relative}: ${safeReason}`);
  error.code = INVALID_WAL_SEGMENT;
  error.recordId = record.id;
  error.relative = record.relative;
  error.sourceSha256 = record.sha256;
  for (const [key, value] of Object.entries(details)) error[key] = value;
  return error;
}

async function streamSegment(record, onRow) {
  const input = fs.createReadStream(record.file).pipe(zlib.createGunzip());
  let header = null;
  let rowIndex = 0;
  let physicalLine = 0;
  try {
    for await (const line of lfDelimitedLines(input)) {
      physicalLine += 1;
      if (!line.trim()) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch (error) {
        throw invalidWalSegmentError(
          record,
          `invalid NDJSON physical line ${physicalLine}: ${error.message}`,
          { physicalLine },
        );
      }
      if (!header) {
        if (!parsed._borg_wal && !parsed._borg_archive) {
          throw invalidWalSegmentError(record, 'missing BORG WAL/archive header', { physicalLine });
        }
        header = parsed;
        continue;
      }
      rowIndex += 1;
      await onRow(envelopeFor(parsed, header, record, rowIndex));
    }
  } catch (error) {
    if (error?.code === INVALID_WAL_SEGMENT) throw error;
    if (error?.code === 'Z_DATA_ERROR' || error?.code === 'Z_BUF_ERROR') {
      throw invalidWalSegmentError(record, `invalid gzip stream: ${error.message}`);
    }
    throw error;
  }
  if (!header) throw invalidWalSegmentError(record, 'empty segment');
  return { header, rows: rowIndex };
}

function quarantineRawSource(lakeState, record, error, rejectedAt = new Date().toISOString()) {
  if (error?.code !== INVALID_WAL_SEGMENT || error.recordId !== record.id) {
    throw new Error('only an identified INVALID_WAL_SEGMENT may be quarantined');
  }
  lakeState.rejectedSources ||= {};
  const rejection = {
    relative: record.relative,
    sha256: record.sha256,
    bytes: record.size,
    rejectedAt,
    code: error.code,
    reason: String(error.message).slice(0, 600),
    physicalLine: Number.isInteger(error.physicalLine) ? error.physicalLine : null,
  };
  lakeState.rejectedSources[record.id] = rejection;
  lakeState.updatedAt = rejectedAt;
  return { id: record.id, ...rejection };
}

function appendNullable(appender, method, value) {
  if (value === null || value === undefined) appender.appendNull();
  else appender[method](value);
}

function appendEnvelope(appender, row) {
  appender.appendVarchar(row.datasetVersion);
  appender.appendVarchar(row.source);
  appender.appendVarchar(row.eventDate);
  appender.appendInteger(row.eventHour);
  appender.appendVarchar(row.sourceSegment);
  appender.appendVarchar(row.sourceSegmentSha256);
  appender.appendBigInt(row.sourceSegmentRow);
  appendNullable(appender, 'appendVarchar', row.eventType);
  appendNullable(appender, 'appendVarchar', row.sourceTime);
  appendNullable(appender, 'appendBigInt', row.sourceTimeMs);
  appendNullable(appender, 'appendVarchar', row.receiveWallTime);
  appendNullable(appender, 'appendBigInt', row.receiveWallTimeMs);
  appendNullable(appender, 'appendVarchar', row.receiveMonotonicNs);
  appendNullable(appender, 'appendVarchar', row.sequenceId);
  appendNullable(appender, 'appendVarchar', row.connectionEpoch);
  appendNullable(appender, 'appendVarchar', row.collectionEpochId);
  appender.appendVarchar(row.eventJson);
  appender.appendVarchar(row.segmentHeaderJson);
  appender.endRow();
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function outputRelative(source, date, hour, hash) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(source)) throw new Error(`unsafe source: ${source}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`unsafe date: ${date}`);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error(`unsafe hour: ${hour}`);
  if (!/^[a-f0-9]{32}$/.test(hash)) throw new Error(`unsafe batch hash: ${hash}`);
  return path.posix.join(
    DATASET_VERSION,
    `source=${source}`,
    `date=${date}`,
    `hour=${String(hour).padStart(2, '0')}`,
    `part-${hash}.parquet`,
  );
}

async function scalar(connection, sql) {
  const reader = await connection.runAndReadAll(sql);
  return reader.getRowsJson()[0]?.[0] ?? null;
}

async function parquetCodec(connection, file) {
  const reader = await connection.runAndReadAll(
    `SELECT DISTINCT compression FROM parquet_metadata(${sqlLiteral(file)}) ORDER BY 1`,
  );
  return reader.getRowsJson().map((row) => String(row[0]).toUpperCase());
}

async function compactStagedBatch(records, options = {}) {
  if (!records.length) throw new Error('compactStagedBatch requires source records');
  const hotRoot = path.resolve(options.hotRoot || DEFAULT_HOT_ROOT);
  const stageRoot = path.resolve(options.stageRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'df-parquet-stage-')));
  const hash = options.batchHash || batchHash(records);
  const databaseFile = path.join(stageRoot, `${hash}.duckdb`);
  const minFreeBytes = positiveInt(options.minFreeBytes, DEFAULT_MIN_FREE_BYTES);
  await fs.promises.mkdir(stageRoot, { recursive: true });
  await fs.promises.mkdir(hotRoot, { recursive: true });
  const instance = await DuckDBInstance.create(databaseFile, { threads: String(positiveInt(options.threads, 1)) });
  const connection = await instance.connect();
  const partitions = new Set();
  const inputs = [];
  let totalRows = 0;
  try {
    await connection.run("SET memory_limit='1GB'");
    await connection.run("SET max_temp_directory_size='4GB'");
    await connection.run('SET autoinstall_known_extensions=false');
    await connection.run('SET allow_community_extensions=false');
    await connection.run(`CREATE TABLE events (
      dataset_version VARCHAR NOT NULL,
      source VARCHAR NOT NULL,
      event_date VARCHAR NOT NULL,
      event_hour INTEGER NOT NULL,
      source_segment VARCHAR NOT NULL,
      source_segment_sha256 VARCHAR NOT NULL,
      source_segment_row BIGINT NOT NULL,
      event_type VARCHAR,
      source_time VARCHAR,
      source_time_ms BIGINT,
      receive_wall_time VARCHAR,
      receive_wall_time_ms BIGINT,
      receive_monotonic_ns VARCHAR,
      sequence_id VARCHAR,
      connection_epoch VARCHAR,
      collection_epoch_id VARCHAR,
      event_json VARCHAR NOT NULL,
      segment_header_json VARCHAR NOT NULL
    )`);
    const appender = await connection.createAppender('events');
    try {
      for (const record of [...records].sort((a, b) => a.relative.localeCompare(b.relative))) {
        assertDiskReserve(stageRoot, minFreeBytes, `before ${record.relative}`);
        const result = await streamSegment(record, async (row) => {
          appendEnvelope(appender, row);
          partitions.add(`${row.source}\t${row.eventDate}\t${row.eventHour}`);
          totalRows += 1;
          if (totalRows % 100000 === 0) appender.flushSync();
        });
        inputs.push({
          id: record.id,
          relative: record.relative,
          sha256: record.sha256,
          bytes: record.size,
          rows: result.rows,
          header: result.header,
        });
      }
    } finally {
      appender.closeSync();
    }

    const outputs = [];
    for (const key of [...partitions].sort()) {
      assertDiskReserve(stageRoot, minFreeBytes, `before Parquet partition ${key}`);
      const [source, date, rawHour] = key.split('\t');
      const hour = Number(rawHour);
      const relative = outputRelative(source, date, hour, hash);
      const output = path.join(hotRoot, ...relative.split('/'));
      await fs.promises.mkdir(path.dirname(output), { recursive: true });
      const count = Number(await scalar(connection,
        `SELECT count(*) FROM events WHERE source=${sqlLiteral(source)} AND event_date=${sqlLiteral(date)} AND event_hour=${hour}`));
      if (!fs.existsSync(output)) {
        const temp = `${output}.${process.pid}.tmp`;
        await connection.run(`COPY (
          SELECT * EXCLUDE (source, event_date, event_hour)
          FROM events
          WHERE source=${sqlLiteral(source)} AND event_date=${sqlLiteral(date)} AND event_hour=${hour}
          ORDER BY source_segment, source_segment_row
        ) TO ${sqlLiteral(temp)} (
          FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 100000
        )`);
        await fs.promises.rename(temp, output);
      }
      const codecs = await parquetCodec(connection, output);
      if (!codecs.length || codecs.some((codec) => codec !== 'ZSTD')) {
        throw new Error(`${relative}: expected only ZSTD Parquet pages; found ${codecs.join(',')}`);
      }
      const stat = await fs.promises.stat(output);
      outputs.push({
        relative,
        source,
        date,
        hour,
        rows: count,
        bytes: stat.size,
        sha256: await sha256File(output),
        compression: 'ZSTD',
      });
    }

    const manifest = {
      format: 'deltaforge-parquet-batch-manifest-v1',
      datasetVersion: DATASET_VERSION,
      batchHash: hash,
      deterministicIdentity: sha256(stableStringify(inputs.map((row) => ({
        id: row.id, relative: row.relative, sha256: row.sha256, bytes: row.bytes,
      })))).slice(0, 32),
      sourceFiles: inputs,
      sourceRows: totalRows,
      outputs,
      schema: {
        clocks: ['source_time_ms', 'receive_wall_time_ms', 'receive_monotonic_ns'],
        provenance: ['sequence_id', 'connection_epoch', 'collection_epoch_id'],
        rawPayload: 'event_json',
        rawAuthority: 'source_segment + source_segment_sha256',
      },
      compression: 'ZSTD',
      duckdbVersion: (await scalar(connection, 'SELECT version()')),
    };
    const manifestRelative = path.posix.join(DATASET_VERSION, '_manifests', `${hash}.json`);
    const manifestFile = path.join(hotRoot, ...manifestRelative.split('/'));
    await fs.promises.mkdir(path.dirname(manifestFile), { recursive: true });
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    if (fs.existsSync(manifestFile)) {
      const prior = fs.readFileSync(manifestFile, 'utf8');
      if (prior !== text) throw new Error(`immutable Parquet manifest collision: ${manifestRelative}`);
    } else {
      writeAtomic(manifestFile, text, 0o600);
    }
    return {
      batchHash: hash,
      sourceFiles: inputs.length,
      sourceRows: totalRows,
      outputs,
      manifest: {
        relative: manifestRelative,
        bytes: fs.statSync(manifestFile).size,
        sha256: await sha256File(manifestFile),
      },
    };
  } finally {
    connection.closeSync();
    try { fs.rmSync(databaseFile, { force: true }); } catch (_) {}
    try { fs.rmSync(`${databaseFile}.wal`, { force: true }); } catch (_) {}
  }
}

function runCommand(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) return resolve({ code, stdout, stderr });
      reject(new Error(`${binary} exited ${code ?? signal}: ${stderr.trim().slice(-1200)}`));
    });
  });
}

function rcloneCommon(env, configFile) {
  return [
    '--config', configFile,
    '--transfers', String(positiveInt(env.PARQUET_RCLONE_TRANSFERS, 2)),
    '--checkers', String(positiveInt(env.PARQUET_RCLONE_CHECKERS, 4)),
    '--tpslimit', String(positiveInt(env.GDRIVE_TPS_LIMIT, 8)),
    '--tpslimit-burst', String(positiveInt(env.GDRIVE_TPS_BURST, 8)),
    '--contimeout', env.GDRIVE_CONNECT_TIMEOUT || '30s',
    '--timeout', env.GDRIVE_IO_TIMEOUT || '5m',
    '--retries', String(positiveInt(env.GDRIVE_RETRIES, 3)),
  ];
}

async function stageRawRecords(records, options) {
  const { remote, prefix, configFile, rclone, stageRoot, env } = options;
  const rawRoot = path.join(stageRoot, 'raw');
  const listFile = path.join(stageRoot, 'raw.files');
  await fs.promises.mkdir(rawRoot, { recursive: true });
  writeFileList(listFile, records.map((record) => record.relative));
  await rclone([
    'copy', remoteTarget(remote, prefix, 'wal'), rawRoot,
    '--files-from-raw', listFile,
    '--checksum', '--fast-list',
    ...rcloneCommon(env, configFile),
  ]);
  const staged = [];
  for (const record of records) {
    const file = path.join(rawRoot, ...record.relative.split('/'));
    const stagedRecord = { ...record, file };
    await verifyStagedRecord(stagedRecord);
    staged.push(stagedRecord);
  }
  return staged;
}

function writeFileList(file, values) {
  for (const value of values) {
    if (value.includes('\n') || value.includes('\r')) throw new Error('newline in Parquet file list');
  }
  fs.writeFileSync(file, `${values.join('\n')}\n`, { mode: 0o600 });
}

async function uploadBatch(batch, options) {
  const { hotRoot, remote, prefix, configFile, rclone, env, workRoot } = options;
  const relatives = [...batch.outputs.map((row) => row.relative), batch.manifest.relative];
  const list = path.join(workRoot, 'parquet.files');
  const combined = path.join(workRoot, 'parquet.combined');
  writeFileList(list, relatives);
  const destination = remoteTarget(remote, prefix, 'parquet');
  const common = rcloneCommon(env, configFile);
  await rclone(['mkdir', destination, ...common]);
  await rclone([
    'copy', hotRoot, destination,
    '--files-from-raw', list,
    '--immutable', '--checksum', '--fast-list',
    ...common,
  ]);
  await rclone([
    'check', hotRoot, destination,
    '--files-from-raw', list,
    '--one-way', '--checksum', '--combined', combined, '--fast-list',
    ...common,
  ]);
  parseCombinedReport(fs.readFileSync(combined, 'utf8'), relatives.length);
  return { destination: 'Google Drive/VPS Data/parquet', verified: relatives.length };
}

function receiptText(batch, pending, options = {}) {
  const parquetFiles = (batch.outputs || [])
    .filter((output) => String(output.relative || '').endsWith('.parquet')).length;
  return [
    'format=deltaforge-parquet-lake-receipt-v1',
    `completed_at=${new Date().toISOString()}`,
    `dataset=${DATASET_VERSION}`,
    `latest_batch=${batch.batchHash}`,
    `source_files=${batch.sourceFiles}`,
    `source_rows=${batch.sourceRows}`,
    `parquet_files=${parquetFiles}`,
    `pending_source_files=${pending}`,
    `rejected_source_files_total=${Number(options.rejectedSourceFilesTotal) || 0}`,
    'compression=ZSTD',
    'destination=Google Drive/VPS Data/parquet',
    'remote_verification=google-drive-md5-via-rclone-check',
    '',
  ].join('\n');
}

function outputRecords(batch) {
  return [...batch.outputs, batch.manifest].map((output) => ({
    ...output,
    remotePath: `VPS Data/parquet/${output.relative}`,
    verified: true,
  }));
}

function totalFilesBelow(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...totalFilesBelow(full));
    else files.push(full);
  }
  return files;
}

function pruneHotParquet(hotRoot, lakeState, maxBytes = DEFAULT_HOT_BYTES) {
  const files = totalFilesBelow(path.join(hotRoot, DATASET_VERSION))
    .filter((file) => file.endsWith('.parquet'))
    .map((file) => ({ file, stat: fs.statSync(file) }));
  let bytes = files.reduce((sum, row) => sum + row.stat.size, 0);
  if (bytes <= maxBytes) return { removed: 0, bytes };
  const verifiedByRelative = new Set(Object.values(lakeState.batches || {})
    .filter((batch) => batch.verified)
    .flatMap((batch) => batch.outputs || [])
    .map((output) => output.relative));
  let removed = 0;
  for (const row of files.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs)) {
    if (bytes <= maxBytes) break;
    const relative = path.relative(hotRoot, row.file).split(path.sep).join('/');
    if (!verifiedByRelative.has(relative)) continue;
    fs.unlinkSync(row.file);
    bytes -= row.stat.size;
    removed += 1;
  }
  return { removed, bytes };
}

async function compactFromGoogle(options = {}) {
  const env = options.env || process.env;
  const stateRoot = path.resolve(env.PARQUET_LAKE_STATE_ROOT || DEFAULT_STATE_ROOT);
  const hotRoot = path.resolve(env.PARQUET_HOT_ROOT || DEFAULT_HOT_ROOT);
  const stageBase = path.resolve(env.PARQUET_STAGE_ROOT || DEFAULT_STAGE_ROOT);
  const stateFile = path.join(stateRoot, 'state.json');
  const rawStateFile = env.GDRIVE_ARCHIVE_STATE_FILE || DEFAULT_RAW_STATE;
  const configFile = env.GDRIVE_RCLONE_CONFIG || DEFAULT_CONFIG;
  const remote = safeRemoteName(env.GDRIVE_RCLONE_REMOTE || 'deltaforge-gdrive');
  const prefix = safeRemotePath(env.GDRIVE_PREFIX || DEFAULT_PREFIX);
  const rcloneBinary = env.GDRIVE_RCLONE_BINARY || '/usr/local/bin/rclone';
  validateRcloneConfig(configFile, remote);
  if (!fs.existsSync(rcloneBinary)) throw new Error(`rclone is missing: ${rcloneBinary}`);
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.mkdirSync(hotRoot, { recursive: true });
  fs.mkdirSync(stageBase, { recursive: true });
  const rawState = loadJson(rawStateFile, null);
  const lakeState = loadLakeState(stateFile);
  const selection = selectVerifiedRawObjects(rawState, lakeState, {
    sources: options.sources || env.PARQUET_SOURCES,
    maxFiles: options.maxFiles || env.PARQUET_MAX_FILES,
    maxBytes: options.maxBytes || env.PARQUET_MAX_BYTES,
    cutoffMs: options.cutoffMs || Date.now() - positiveInt(env.PARQUET_CUTOFF_SECONDS, 600) * 1000,
  });
  if (!selection.records.length) {
    // The state checkpoint is written only after remote rclone verification.
    // A prior process can therefore be safely resumed here if it verified and
    // checkpointed a batch but died while publishing the liveness receipt.
    const prior = latestVerifiedBatch(lakeState);
    if (prior) {
      writeAtomic(receiptFile(env, stateRoot), receiptText(prior, selection.remaining, {
        rejectedSourceFilesTotal: Object.keys(lakeState.rejectedSources || {}).length,
      }), 0o644);
    }
    const report = {
      format: 'deltaforge-parquet-lake-run-v1',
      status: prior ? 'verified_no_new_batch' : 'nothing_to_compact',
      latestVerifiedBatch: prior?.batchHash || null,
      pending: selection.remaining,
      rejectedSourceFilesTotal: Object.keys(lakeState.rejectedSources || {}).length,
    };
    writeAtomic(path.join(stateRoot, 'last-report.json'), `${JSON.stringify(report, null, 2)}\n`, 0o600);
    return report;
  }
  const minFreeBytes = positiveInt(env.PARQUET_MIN_FREE_BYTES, DEFAULT_MIN_FREE_BYTES);
  const expansionMultiplier = positiveInt(
    env.PARQUET_EXPANSION_RESERVE_MULTIPLIER,
    DEFAULT_EXPANSION_RESERVE_MULTIPLIER,
  );
  const freeBefore = assertDiskReserve(stageBase, minFreeBytes, 'before raw staging');
  const projectedWorkingBytes = selection.bytes * expansionMultiplier;
  if (freeBefore - projectedWorkingBytes < minFreeBytes) {
    throw new Error(`Parquet batch preflight: ${selection.bytes} compressed bytes require a ${projectedWorkingBytes} byte expansion reserve, leaving less than ${minFreeBytes} bytes free`);
  }
  const selectionHash = batchHash(selection.records);
  const workRoot = fs.mkdtempSync(path.join(stageBase, `${selectionHash}-`));
  const runRclone = options.rclone || ((args) => runCommand(rcloneBinary, args, { env }));
  try {
    const staged = await stageRawRecords(selection.records, {
      remote, prefix, configFile, rclone: runRclone, stageRoot: workRoot, env,
    });
    let compactable = staged;
    const rejected = [];
    let batch = null;
    while (compactable.length) {
      const candidateHash = batchHash(compactable);
      try {
        batch = await compactStagedBatch(compactable, {
          hotRoot, stageRoot: workRoot, batchHash: candidateHash,
          threads: env.PARQUET_DUCKDB_THREADS || 1,
          minFreeBytes,
        });
        break;
      } catch (error) {
        if (error?.code !== INVALID_WAL_SEGMENT) throw error;
        const invalid = compactable.find((record) => record.id === error.recordId);
        if (!invalid) throw error;
        rejected.push(quarantineRawSource(lakeState, invalid, error));
        // Persist the evidence exclusion immediately. A crash must not erase
        // the explicit rejection and retry the same deterministic bad bytes.
        writeAtomic(stateFile, `${JSON.stringify(lakeState, null, 2)}\n`, 0o600);
        compactable = compactable.filter((record) => record.id !== invalid.id);
      }
    }
    if (!batch) {
      const prior = latestVerifiedBatch(lakeState);
      if (prior) {
        writeAtomic(receiptFile(env, stateRoot), receiptText(prior, selection.remaining, {
          rejectedSourceFilesTotal: Object.keys(lakeState.rejectedSources || {}).length,
        }), 0o644);
      }
      const report = {
        format: 'deltaforge-parquet-lake-run-v1',
        status: 'source_rejections_only',
        latestVerifiedBatch: prior?.batchHash || null,
        selectedSourceFiles: selection.records.length,
        rejectedSourceFiles: rejected.length,
        rejected,
        rejectedSourceFilesTotal: Object.keys(lakeState.rejectedSources || {}).length,
        pendingSourceFiles: selection.remaining,
      };
      writeAtomic(path.join(stateRoot, 'last-report.json'), `${JSON.stringify(report, null, 2)}\n`, 0o600);
      return report;
    }
    const hash = batch.batchHash;
    const remoteResult = await uploadBatch(batch, {
      hotRoot, remote, prefix, configFile, rclone: runRclone, env, workRoot,
    });
    const compactedAt = new Date().toISOString();
    for (const record of compactable) {
      lakeState.sources[record.id] = {
        batchHash: hash,
        relative: record.relative,
        sha256: record.sha256,
        bytes: record.size,
        compactedAt,
      };
    }
    lakeState.batches[hash] = {
      verified: true,
      verifiedAt: compactedAt,
      sourceFiles: batch.sourceFiles,
      sourceRows: batch.sourceRows,
      outputs: outputRecords(batch),
      destination: remoteResult.destination,
    };
    lakeState.updatedAt = compactedAt;
    writeAtomic(stateFile, `${JSON.stringify(lakeState, null, 2)}\n`, 0o600);
    writeAtomic(receiptFile(env, stateRoot),
      receiptText(batch, selection.remaining, {
        rejectedSourceFilesTotal: Object.keys(lakeState.rejectedSources || {}).length,
      }), 0o644);
    const prune = pruneHotParquet(hotRoot, lakeState,
      positiveInt(env.PARQUET_HOT_MAX_BYTES, DEFAULT_HOT_BYTES));
    const report = {
      format: 'deltaforge-parquet-lake-run-v1',
      status: 'verified',
      batchHash: hash,
      selectedSourceFiles: selection.records.length,
      selectedCompressedBytes: selection.bytes,
      compactedSourceFiles: compactable.length,
      compactedCompressedBytes: compactable.reduce((sum, row) => sum + row.size, 0),
      rejectedSourceFiles: rejected.length,
      rejected,
      rejectedSourceFilesTotal: Object.keys(lakeState.rejectedSources || {}).length,
      sourceRows: batch.sourceRows,
      parquetFiles: batch.outputs.length,
      parquetBytes: batch.outputs.reduce((sum, row) => sum + row.bytes, 0),
      pendingSourceFiles: selection.remaining,
      remote: remoteResult,
      hotPrune: prune,
    };
    writeAtomic(path.join(stateRoot, 'last-report.json'), `${JSON.stringify(report, null, 2)}\n`, 0o600);
    return report;
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

function dateRange(from, to) {
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)
      || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) {
    throw new Error('hydrate dates must be YYYY-MM-DD with from <= to');
  }
  const values = [];
  for (let cursor = start.getTime(); cursor <= end.getTime(); cursor += 86400000) {
    values.push(new Date(cursor).toISOString().slice(0, 10));
  }
  if (values.length > 31) throw new Error('one hydrate request is limited to 31 days');
  return new Set(values);
}

async function hydrateParquet(options = {}) {
  const env = options.env || process.env;
  const source = String(options.source || '').trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(source)) throw new Error('hydrate source is required and must be safe');
  const dates = dateRange(options.from, options.to);
  const stateRoot = path.resolve(env.PARQUET_LAKE_STATE_ROOT || DEFAULT_STATE_ROOT);
  const hotRoot = path.resolve(env.PARQUET_HOT_ROOT || DEFAULT_HOT_ROOT);
  const lakeState = loadLakeState(path.join(stateRoot, 'state.json'));
  const configFile = env.GDRIVE_RCLONE_CONFIG || DEFAULT_CONFIG;
  const remote = safeRemoteName(env.GDRIVE_RCLONE_REMOTE || 'deltaforge-gdrive');
  const prefix = safeRemotePath(env.GDRIVE_PREFIX || DEFAULT_PREFIX);
  const rcloneBinary = env.GDRIVE_RCLONE_BINARY || '/usr/local/bin/rclone';
  validateRcloneConfig(configFile, remote);
  const rclone = options.rclone || ((args) => runCommand(rcloneBinary, args, { env }));
  const outputs = Object.values(lakeState.batches).flatMap((batch) => batch.verified ? batch.outputs || [] : [])
    .filter((output) => output.relative?.endsWith('.parquet')
      && output.source === source && dates.has(output.date));
  const maxBytes = positiveInt(options.maxBytes || env.PARQUET_HYDRATE_MAX_BYTES, 5 * 1024 ** 3);
  let hydrated = 0;
  let bytes = 0;
  for (const output of outputs.sort((a, b) => a.relative.localeCompare(b.relative))) {
    if (bytes + output.bytes > maxBytes) break;
    const file = path.join(hotRoot, ...output.relative.split('/'));
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) {
      await rclone([
        'copyto', remoteTarget(remote, prefix, 'parquet', output.relative), file,
        ...rcloneCommon(env, configFile),
      ]);
    }
    const digest = await sha256File(file);
    if (digest !== output.sha256 || fs.statSync(file).size !== output.bytes) {
      fs.rmSync(file, { force: true });
      throw new Error(`hydrated Parquet verification failed: ${output.relative}`);
    }
    hydrated += 1;
    bytes += output.bytes;
  }
  return { source, dates: [...dates], eligible: outputs.length, hydrated, bytes, hotRoot };
}

module.exports = {
  DATASET_VERSION,
  DEFAULT_EXPANSION_RESERVE_MULTIPLIER,
  DEFAULT_HOT_ROOT,
  DEFAULT_MIN_FREE_BYTES,
  INVALID_WAL_SEGMENT,
  STATE_FORMAT,
  assertDiskReserve,
  batchHash,
  compactFromGoogle,
  compactStagedBatch,
  dateRange,
  diskFreeBytes,
  envelopeFor,
  hydrateParquet,
  lfDelimitedLines,
  loadLakeState,
  latestVerifiedBatch,
  normalizeSources,
  outputRelative,
  parquetCodec,
  pruneHotParquet,
  quarantineRawSource,
  receiptFile,
  receiptText,
  selectVerifiedRawObjects,
  sourceFromRelative,
  stageRawRecords,
  streamSegment,
  timeMilliseconds,
  verifyStagedRecord,
};
