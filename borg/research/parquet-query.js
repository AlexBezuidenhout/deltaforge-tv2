'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DuckDBInstance } = require('@duckdb/node-api');
const { DATASET_VERSION, DEFAULT_HOT_ROOT } = require('./parquet-lake');

const COMMANDS = new Set(['sources', 'coverage', 'clock-audit', 'sample']);

function safeRoot(value) {
  const root = path.resolve(value || DEFAULT_HOT_ROOT);
  if (!path.isAbsolute(root) || root === path.parse(root).root) throw new Error('unsafe Parquet dataset root');
  return root;
}

function safeSource(value) {
  if (value == null || value === '') return null;
  const source = String(value);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(source)) throw new Error(`unsafe source: ${value}`);
  return source;
}

function safeDate(value, field) {
  if (value == null || value === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw new Error(`${field} must be YYYY-MM-DD`);
  return String(value);
}

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function parquetGlob(root) {
  return path.join(root, DATASET_VERSION, 'source=*', 'date=*', 'hour=*', '*.parquet');
}

function filters(options = {}) {
  const clauses = [];
  const source = safeSource(options.source);
  const from = safeDate(options.from, 'from');
  const to = safeDate(options.to, 'to');
  if (source) clauses.push(`source=${quote(source)}`);
  if (from) clauses.push(`date >= ${quote(from)}`);
  if (to) clauses.push(`date <= ${quote(to)}`);
  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

function querySql(command, root, options = {}) {
  if (!COMMANDS.has(command)) throw new Error(`unsupported Parquet query command: ${command}`);
  const glob = parquetGlob(safeRoot(root));
  const source = `read_parquet(${quote(glob)}, hive_partitioning=true, union_by_name=true)`;
  const where = filters(options);
  if (command === 'sources') {
    return `SELECT source, count(*)::BIGINT AS events, min(date) AS first_date, max(date) AS last_date
      FROM ${source} ${where} GROUP BY source ORDER BY source`;
  }
  if (command === 'coverage') {
    return `SELECT source, date, count(*)::BIGINT AS events,
      min(receive_wall_time_ms) AS first_receive_ms,
      max(receive_wall_time_ms) AS last_receive_ms,
      count(source_time_ms)::BIGINT AS source_clock_events,
      count(receive_monotonic_ns)::BIGINT AS monotonic_events,
      count(sequence_id)::BIGINT AS sequenced_events,
      count(connection_epoch)::BIGINT AS connection_epoch_events,
      count(collection_epoch_id)::BIGINT AS collection_epoch_events
      FROM ${source} ${where} GROUP BY source, date ORDER BY date, source`;
  }
  if (command === 'clock-audit') {
    return `SELECT source,
      count(*)::BIGINT AS events,
      round(100.0*count(source_time_ms)/count(*), 2) AS source_clock_pct,
      round(100.0*count(receive_wall_time_ms)/count(*), 2) AS receive_clock_pct,
      round(100.0*count(receive_monotonic_ns)/count(*), 2) AS monotonic_pct,
      round(100.0*count(sequence_id)/count(*), 2) AS sequence_pct,
      round(100.0*count(connection_epoch)/count(*), 2) AS connection_epoch_pct,
      round(100.0*count(collection_epoch_id)/count(*), 2) AS collection_epoch_pct
      FROM ${source} ${where} GROUP BY source ORDER BY source`;
  }
  const limit = Math.max(1, Math.min(1000, parseInt(options.limit, 10) || 20));
  return `SELECT source, date, hour, source_segment, source_segment_row, event_type,
      source_time_ms, receive_wall_time_ms, receive_monotonic_ns, sequence_id,
      connection_epoch, collection_epoch_id, event_json
      FROM ${source} ${where}
      ORDER BY receive_wall_time_ms NULLS LAST, source_segment, source_segment_row
      LIMIT ${limit}`;
}

async function runParquetQuery(command, options = {}) {
  const root = safeRoot(options.root || process.env.PARQUET_HOT_ROOT || DEFAULT_HOT_ROOT);
  const glob = parquetGlob(root);
  const parent = path.join(root, DATASET_VERSION);
  if (!fs.existsSync(parent)) throw new Error(`Parquet dataset is missing: ${parent}`);
  const instance = await DuckDBInstance.create(':memory:', { threads: String(options.threads || 2) });
  const connection = await instance.connect();
  try {
    await connection.run("SET memory_limit='2GB'");
    await connection.run("SET max_temp_directory_size='4GB'");
    await connection.run('SET autoinstall_known_extensions=false');
    await connection.run('SET allow_community_extensions=false');
    await connection.run(`SET allowed_directories=[${quote(parent)}]`);
    const reader = await connection.runAndReadAll(querySql(command, root, options));
    return {
      format: 'deltaforge-parquet-query-v1',
      command,
      root,
      glob,
      columns: reader.columnNames(),
      rows: reader.getRowObjectsJson(),
    };
  } finally {
    connection.closeSync();
  }
}

module.exports = {
  COMMANDS,
  filters,
  parquetGlob,
  querySql,
  runParquetQuery,
  safeDate,
  safeRoot,
  safeSource,
};
