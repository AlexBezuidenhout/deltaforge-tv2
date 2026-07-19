#!/usr/bin/env node
/**
 * Convert immutable BORG gzip-NDJSON archive/WAL segments to immutable
 * Parquet files on an off-host mounted volume.
 *
 * Usage:
 *   BORG_PARQUET_MIRROR_DIR=/Volumes/research-archive \
 *     node scripts/parquet-mirror.js
 *
 * Existing output is never overwritten. A source-content change at the same
 * relative path is a hard failure, making accidental mutable datasets visible.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const parquet = require('@dsnp/parquetjs');

const fsp = fs.promises;

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function filesBelow(root) {
  const out = [];
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch (err) {
    if (err.code === 'ENOENT') return out;
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...await filesBelow(full));
    else if (entry.name.endsWith('.ndjson.gz')) out.push(full);
  }
  return out;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function decodeSegment(packed) {
  const plain = zlib.gunzipSync(packed).toString('utf8');
  const lines = plain.split('\n').filter(Boolean).map(JSON.parse);
  const header = lines.shift() || {};
  if (!header._borg_archive && !header._borg_wal) throw new Error('unknown BORG segment header');
  return { header, rows: lines };
}

function isTimestampField(key, values) {
  if (!/(^ts$|timestamp|_at$|_ts$)/i.test(key)) return false;
  return values.every((value) => typeof value === 'string' && Number.isFinite(Date.parse(value)));
}

function schemaFor(rows) {
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))].sort();
  const definitions = {};
  const converters = {};
  for (const key of keys) {
    const values = rows.map((row) => row[key]).filter((value) => value != null);
    if (values.length && values.every((value) => typeof value === 'boolean')) {
      definitions[key] = { type: 'BOOLEAN', optional: true };
      converters[key] = (value) => value;
    } else if (values.length && values.every((value) => typeof value === 'number' && Number.isFinite(value)) &&
               !/(^id$|_id$|sequence|monotonic)/i.test(key)) {
      definitions[key] = { type: 'DOUBLE', optional: true };
      converters[key] = (value) => value;
    } else if (values.length && isTimestampField(key, values)) {
      definitions[key] = { type: 'TIMESTAMP_MILLIS', optional: true };
      converters[key] = (value) => new Date(value);
    } else {
      definitions[key] = { type: 'UTF8', optional: true };
      converters[key] = (value) => typeof value === 'string' ? value : JSON.stringify(value);
    }
  }
  return { schema: new parquet.ParquetSchema(definitions), definitions, converters };
}

async function atomicJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await fsp.rename(temp, file);
}

async function convertFile(sourceFile, sourceRoot, mirrorRoot) {
  const packed = await fsp.readFile(sourceFile);
  const sourceSha256 = sha256(packed);
  const relative = path.relative(sourceRoot, sourceFile).replace(/\.ndjson\.gz$/, '.parquet');
  const namespace = path.basename(sourceRoot);
  const output = path.join(mirrorRoot, namespace, relative);
  const manifestFile = `${output}.manifest.json`;
  try {
    const prior = JSON.parse(await fsp.readFile(manifestFile, 'utf8'));
    if (prior.source_sha256 !== sourceSha256) {
      throw new Error(`immutable source collision at ${relative}`);
    }
    await fsp.access(output, fs.constants.R_OK);
    return { status: 'verified_existing', output, rows: prior.row_count };
  } catch (err) {
    if (err.code !== 'ENOENT' && !/Unexpected end of JSON input/.test(err.message)) throw err;
  }

  const { header, rows } = decodeSegment(packed);
  if (!rows.length) return { status: 'empty', output, rows: 0 };
  const { schema, definitions, converters } = schemaFor(rows);
  await fsp.mkdir(path.dirname(output), { recursive: true });
  const temp = `${output}.${process.pid}.${Date.now()}.tmp`;
  const writer = await parquet.ParquetWriter.openFile(schema, temp);
  writer.setRowGroupSize(8192);
  try {
    for (const row of rows) {
      const encoded = {};
      for (const [key, convert] of Object.entries(converters)) {
        if (row[key] != null) encoded[key] = convert(row[key]);
      }
      await writer.appendRow(encoded);
    }
  } finally {
    await writer.close();
  }
  await fsp.rename(temp, output);
  const parquetBytes = await fsp.readFile(output);
  const manifest = {
    format: 'borg-parquet-mirror-v1',
    created_at: new Date().toISOString(),
    host: os.hostname(),
    source: sourceFile,
    source_header: header,
    source_sha256: sourceSha256,
    parquet_sha256: sha256(parquetBytes),
    parquet_bytes: parquetBytes.length,
    row_count: rows.length,
    schema: definitions,
  };
  await atomicJson(manifestFile, manifest);
  return { status: 'created', output, rows: rows.length };
}

async function main() {
  const mirror = arg('--mirror') || process.env.BORG_PARQUET_MIRROR_DIR;
  if (!mirror) throw new Error('BORG_PARQUET_MIRROR_DIR (off-host mounted path) is required');
  const roots = (arg('--source') ? [arg('--source')] : [
    process.env.BORG_ARCHIVE_DIR || path.join(os.homedir(), '.deltaforge-archive', 'borg-raw'),
    process.env.BORG_WAL_DIR || path.join(os.homedir(), '.deltaforge-wal', 'borg'),
  ]).map((root) => path.resolve(root));
  const results = [];
  for (const root of roots) {
    for (const file of await filesBelow(root)) results.push(await convertFile(file, root, path.resolve(mirror)));
  }
  const summary = {
    files: results.length,
    created: results.filter((row) => row.status === 'created').length,
    verified_existing: results.filter((row) => row.status === 'verified_existing').length,
    rows: results.reduce((sum, row) => sum + row.rows, 0),
    mirror: path.resolve(mirror),
  };
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) main().catch((err) => { console.error(err.message); process.exit(1); });

module.exports = { convertFile, decodeSegment, schemaFor };
