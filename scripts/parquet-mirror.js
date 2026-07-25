#!/usr/bin/env node
/**
 * Convert immutable BORG gzip-NDJSON archive/WAL segments to immutable
 * Parquet files on an off-host mounted volume.
 *
 * Usage:
 *   BORG_PARQUET_MIRROR_DIR=/Volumes/research-archive \
 *     node scripts/parquet-mirror.js
 *
 * A source-content change at the same relative path is a hard failure, making
 * accidental mutable datasets visible. Reproducible output may be atomically
 * rewritten only to upgrade its declared compression codec.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const parquet = require('@dsnp/parquetjs');

const fsp = fs.promises;
const DEFAULT_COMPRESSION = 'GZIP';
const SUPPORTED_COMPRESSION = new Set(['GZIP', 'SNAPPY', 'BROTLI']);

class InvalidSegmentError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'InvalidSegmentError';
    this.code = 'BORG_INVALID_SEGMENT';
  }
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function positiveInt(value, fallback = Infinity) {
  const parsed = parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function enabled(value, fallback = false) {
  if (value == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function compressionCodec(value = process.env.BORG_PARQUET_COMPRESSION) {
  const codec = String(value || DEFAULT_COMPRESSION).trim().toUpperCase();
  if (!SUPPORTED_COMPRESSION.has(codec)) {
    throw new Error(`unsupported Parquet compression codec: ${codec}`);
  }
  return codec;
}

function isCloudPlaceholderError(error) {
  return ['EDEADLK', 'EBUSY', 'EAGAIN', 'ETIMEDOUT'].includes(error?.code);
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

async function fileExists(file) {
  try {
    await fsp.access(file, fs.constants.F_OK);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function explicitFilesByRoot(content, roots) {
  const result = new Map(roots.map((root) => [root, []]));
  const seen = new Set();
  for (const entry of content.split(/\r?\n/).filter(Boolean)) {
    const file = path.resolve(entry);
    if (seen.has(file) || !file.endsWith('.ndjson.gz')) continue;
    const root = roots.find((candidate) => {
      const relative = path.relative(candidate, file);
      return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative);
    });
    if (!root) throw new Error(`Parquet input is outside an allowed immutable root: ${file}`);
    result.get(root).push(file);
    seen.add(file);
  }
  return result;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function decodeSegment(packed) {
  let plain;
  try {
    plain = zlib.gunzipSync(packed).toString('utf8');
  } catch (error) {
    throw new InvalidSegmentError(`gzip integrity failure: ${error.message}`, { cause: error });
  }
  const sourceLines = plain.split('\n').filter(Boolean);
  const decoded = [];
  for (let index = 0; index < sourceLines.length; index += 1) {
    try {
      decoded.push(JSON.parse(sourceLines[index]));
    } catch (error) {
      throw new InvalidSegmentError(
        `invalid NDJSON at line ${index + 1}: ${error.message}`,
        { cause: error },
      );
    }
  }
  const header = decoded.shift() || {};
  if (!header._borg_archive && !header._borg_wal) {
    throw new InvalidSegmentError('unknown BORG segment header');
  }
  return { header, rows: decoded };
}

function isTimestampField(key, values) {
  if (!/(^ts$|timestamp|_at$|_ts$)/i.test(key)) return false;
  return values.every((value) => typeof value === 'string' && Number.isFinite(Date.parse(value)));
}

function schemaFor(rows, options = {}) {
  const compression = compressionCodec(options.compression);
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))].sort();
  const definitions = {};
  const converters = {};
  for (const key of keys) {
    const values = rows.map((row) => row[key]).filter((value) => value != null);
    if (values.length && values.every((value) => typeof value === 'boolean')) {
      definitions[key] = { type: 'BOOLEAN', optional: true, compression };
      converters[key] = (value) => value;
    } else if (values.length && values.every((value) => typeof value === 'number' && Number.isFinite(value)) &&
               !/(^id$|_id$|sequence|monotonic)/i.test(key)) {
      definitions[key] = { type: 'DOUBLE', optional: true, compression };
      converters[key] = (value) => value;
    } else if (values.length && isTimestampField(key, values)) {
      definitions[key] = { type: 'TIMESTAMP_MILLIS', optional: true, compression };
      converters[key] = (value) => new Date(value);
    } else {
      definitions[key] = { type: 'UTF8', optional: true, compression };
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

async function recordInvalidSource(sourceFile, sourceRoot, mirrorRoot, error) {
  const packed = await fsp.readFile(sourceFile);
  const stat = await fsp.stat(sourceFile);
  const relative = path.relative(sourceRoot, sourceFile);
  const namespace = path.basename(sourceRoot);
  const report = path.join(mirrorRoot, '_invalid', namespace, `${relative}.invalid.json`);
  let prior = null;
  try {
    prior = JSON.parse(await fsp.readFile(report, 'utf8'));
  } catch (readError) {
    if (readError.code !== 'ENOENT' && !/Unexpected end of JSON input/.test(readError.message)) {
      throw readError;
    }
  }
  const sourceHash = sha256(packed);
  if (prior && prior.source_sha256 !== sourceHash) {
    throw new Error(`immutable invalid-source collision at ${relative}`);
  }
  if (!prior) {
    await atomicJson(report, {
      format: 'borg-parquet-invalid-source-v1',
      detected_at: new Date().toISOString(),
      source: canonicalSource(sourceFile, sourceRoot),
      source_sha256: sourceHash,
      source_bytes: stat.size,
      source_mtime_ms: stat.mtimeMs,
      error: error.message,
    });
  }
  return { status: 'invalid_source', output: report, rows: 0 };
}

function outputFiles(sourceFile, sourceRoot, mirrorRoot) {
  const relative = path.relative(sourceRoot, sourceFile).replace(/\.ndjson\.gz$/, '.parquet');
  const namespace = path.basename(sourceRoot);
  const output = path.join(mirrorRoot, namespace, relative);
  return { relative, output, manifestFile: `${output}.manifest.json` };
}

function canonicalSource(sourceFile, sourceRoot) {
  const base = process.env.BORG_PARQUET_CANONICAL_BASE;
  if (!base) return sourceFile;
  return path.join(path.resolve(base), path.basename(sourceRoot), path.relative(sourceRoot, sourceFile));
}

async function fastExistingResult(sourceFile, sourceRoot, mirrorRoot) {
  const { output, manifestFile } = outputFiles(sourceFile, sourceRoot, mirrorRoot);
  const compression = compressionCodec();
  try {
    const [prior, stat] = await Promise.all([
      fsp.readFile(manifestFile, 'utf8').then(JSON.parse),
      fsp.stat(sourceFile),
      fsp.access(output, fs.constants.R_OK),
    ]);
    if (prior.compression === compression
      && Number(prior.source_bytes) === stat.size
      && Math.abs(Number(prior.source_mtime_ms) - stat.mtimeMs) < 1) {
      return { status: 'verified_existing', output, rows: prior.row_count };
    }
  } catch (err) {
    if (err.code !== 'ENOENT' && !/Unexpected end of JSON input/.test(err.message)) throw err;
  }
  return null;
}

async function convertFile(sourceFile, sourceRoot, mirrorRoot) {
  const fast = await fastExistingResult(sourceFile, sourceRoot, mirrorRoot);
  if (fast) return fast;
  const sourceStat = await fsp.stat(sourceFile);
  const packed = await fsp.readFile(sourceFile);
  const sourceSha256 = sha256(packed);
  const compression = compressionCodec();
  const { relative, output, manifestFile } = outputFiles(sourceFile, sourceRoot, mirrorRoot);
  try {
    const prior = JSON.parse(await fsp.readFile(manifestFile, 'utf8'));
    if (prior.source_sha256 !== sourceSha256) {
      throw new Error(`immutable source collision at ${relative}`);
    }
    if (prior.compression === compression) {
      await fsp.access(output, fs.constants.R_OK);
      if (Number(prior.source_bytes) !== sourceStat.size
        || Math.abs(Number(prior.source_mtime_ms) - sourceStat.mtimeMs) >= 1) {
        await atomicJson(manifestFile, {
          ...prior,
          source_bytes: sourceStat.size,
          source_mtime_ms: sourceStat.mtimeMs,
        });
      }
      return { status: 'verified_existing', output, rows: prior.row_count };
    }
  } catch (err) {
    if (err.code !== 'ENOENT' && !/Unexpected end of JSON input/.test(err.message)) throw err;
  }

  const { header, rows } = decodeSegment(packed);
  if (!rows.length) return { status: 'empty', output, rows: 0 };
  const { schema, definitions, converters } = schemaFor(rows, { compression });
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
    format: 'borg-parquet-mirror-v2',
    created_at: new Date().toISOString(),
    host: os.hostname(),
    compression,
    source: canonicalSource(sourceFile, sourceRoot),
    source_header: header,
    source_sha256: sourceSha256,
    source_bytes: sourceStat.size,
    source_mtime_ms: sourceStat.mtimeMs,
    parquet_sha256: sha256(parquetBytes),
    parquet_bytes: parquetBytes.length,
    parquet_to_source_ratio: sourceStat.size > 0
      ? parquetBytes.length / sourceStat.size : null,
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
  const inputList = arg('--file-list') || process.env.BORG_PARQUET_INPUT_LIST;
  const explicit = inputList
    ? explicitFilesByRoot(await fsp.readFile(inputList, 'utf8'), roots)
    : null;
  const maxFiles = positiveInt(arg('--max-files') || process.env.BORG_PARQUET_MAX_FILES);
  const existingOnly = process.argv.includes('--existing-only')
    || enabled(process.env.BORG_PARQUET_EXISTING_ONLY);
  const results = [];
  let workFiles = 0;
  let pending = 0;
  let deferredCloudPlaceholders = 0;
  let notMaterialized = 0;
  for (const root of roots) {
    const files = explicit ? explicit.get(root) : await filesBelow(root);
    // Newly mirrored objects are still resident on the Mac. Process newest
    // first so iCloud eviction of an old, already archived object cannot starve
    // the current evidence epoch.
    files.sort((left, right) => right.localeCompare(left));
    for (const file of files) {
      try {
        const fast = await fastExistingResult(file, root, path.resolve(mirror));
        if (fast) {
          results.push(fast);
        } else if (existingOnly) {
          const output = outputFiles(file, root, path.resolve(mirror));
          const [hasParquet, hasManifest] = await Promise.all([
            fileExists(output.output),
            fileExists(output.manifestFile),
          ]);
          if (!hasParquet || !hasManifest) {
            notMaterialized += 1;
            continue;
          }
          if (workFiles < maxFiles) {
            results.push(await convertFile(file, root, path.resolve(mirror)));
            workFiles += 1;
          } else {
            pending += 1;
          }
        } else if (workFiles < maxFiles) {
          results.push(await convertFile(file, root, path.resolve(mirror)));
          workFiles += 1;
        } else {
          pending += 1;
        }
      } catch (error) {
        if (isCloudPlaceholderError(error)) {
          deferredCloudPlaceholders += 1;
        } else if (error?.code === 'BORG_INVALID_SEGMENT') {
          results.push(await recordInvalidSource(file, root, path.resolve(mirror), error));
          workFiles += 1;
        } else {
          throw error;
        }
      }
    }
  }
  const summary = {
    files: results.length,
    created: results.filter((row) => row.status === 'created').length,
    verified_existing: results.filter((row) => row.status.startsWith('verified_existing')).length,
    invalid_source: results.filter((row) => row.status === 'invalid_source').length,
    pending,
    not_materialized: notMaterialized,
    deferred_cloud_placeholders: deferredCloudPlaceholders,
    max_work_files: Number.isFinite(maxFiles) ? maxFiles : null,
    existing_only: existingOnly,
    input_mode: explicit ? 'explicit_new_files' : 'historical_scan',
    rows: results.reduce((sum, row) => sum + row.rows, 0),
    mirror: path.resolve(mirror),
  };
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) main().catch((err) => { console.error(err.message); process.exit(1); });

module.exports = {
  DEFAULT_COMPRESSION, InvalidSegmentError, canonicalSource, compressionCodec,
  convertFile, decodeSegment, enabled, fileExists,
  fastExistingResult, explicitFilesByRoot, isCloudPlaceholderError,
  outputFiles, positiveInt, recordInvalidSource, schemaFor,
};
