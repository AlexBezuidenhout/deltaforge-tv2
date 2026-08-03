#!/usr/bin/env node
'use strict';

/**
 * Verified off-host archive for immutable raw research objects.
 *
 * This uploader is intentionally outside every feed/order hot path. It hashes
 * each closed object, uploads it to an S3-compatible store, verifies remote
 * size plus SHA-256 metadata, and only then publishes the standard retention
 * receipt consumed by the hot-tier jobs. Open .ndjson segments are excluded.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} = require('@aws-sdk/client-s3');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DEFAULT_STATE_ROOT = '/var/lib/deltaforge/object-store-archive';
const DEFAULT_RAW_RECEIPT = '/var/lib/deltaforge/offhost-archive.receipt';
const DEFAULT_SNAPSHOT_RECEIPT = '/var/lib/deltaforge/offhost-snapshot.receipt';
const DEFAULT_MULTIPART_THRESHOLD = 4 * 1024 * 1024 * 1024;
const DEFAULT_PART_SIZE = 64 * 1024 * 1024;
const CLOSED_RAW_SUFFIXES = Object.freeze([
  '.ndjson.gz', '.tar.gz', '.manifest.json',
]);

function bool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function positiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function safeRelative(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`file is outside archive root: ${file}`);
  }
  return relative.split(path.sep).join('/');
}

function objectKey(prefix, namespace, relative) {
  const parts = [prefix, namespace, relative]
    .flatMap((value) => String(value || '').split('/'))
    .filter((value) => value && value !== '.');
  if (parts.some((value) => value === '..')) throw new Error('unsafe object key');
  return parts.join('/');
}

function statIfPresent(file) {
  try {
    return fs.statSync(file);
  } catch (error) {
    // Retention can remove an already-receipted immutable object between the
    // directory read and this stat. A traversal is re-scanned before issuing
    // a new receipt, so a vanished source is omission, never evidence.
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const output = [];
  const visit = (directory) => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) output.push(target);
    }
  };
  visit(root);
  return output;
}

function eligibleRawFiles(root, cutoffMs) {
  return walkFiles(root).filter((file) => {
    if (!CLOSED_RAW_SUFFIXES.some((suffix) => file.endsWith(suffix))) return false;
    const stat = statIfPresent(file);
    return stat != null && stat.mtimeMs <= cutoffMs;
  }).sort();
}

function latestSnapshotFiles(root, cutoffMs) {
  const dumps = walkFiles(root).flatMap((file) => {
    if (!file.endsWith('.dump')) return [];
    const stat = statIfPresent(file);
    return stat && stat.mtimeMs <= cutoffMs ? [{ file, mtimeMs: stat.mtimeMs }] : [];
  }).sort((left, right) => right.mtimeMs - left.mtimeMs);
  const dump = dumps[0]?.file;
  if (!dump) return { dump: null, files: [] };
  const checksum = `${dump}.sha256`;
  const checksumStat = statIfPresent(checksum);
  if (!checksumStat || checksumStat.mtimeMs > cutoffMs) {
    return { dump, files: [], ready: false };
  }
  const companions = [checksum, `${dump}.profile`]
    .filter((file) => {
      const stat = statIfPresent(file);
      return stat != null && stat.mtimeMs <= cutoffMs;
    });
  return { dump, files: [dump, ...companions], ready: true };
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(file);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function loadState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.format === 'deltaforge-object-store-state-v1') return parsed;
  } catch (_) {}
  return { format: 'deltaforge-object-store-state-v1', objects: {} };
}

function writeAtomic(file, contents, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(temporary, contents, { mode });
  fs.renameSync(temporary, file);
}

function saveState(file, state) {
  state.updatedAt = new Date().toISOString();
  writeAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
}

function metadataFor(sha256, stat) {
  return {
    sha256,
    source_mtime_ms: String(Math.floor(stat.mtimeMs)),
    archive_format: 'deltaforge-immutable-v1',
  };
}

async function headMatches(client, bucket, key, stat, sha256) {
  try {
    const remote = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return Number(remote.ContentLength) === stat.size
      && String(remote.Metadata?.sha256 || '').toLowerCase() === sha256.toLowerCase();
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404
      || ['NotFound', 'NoSuchKey'].includes(error?.name)) return false;
    throw error;
  }
}

async function multipartUpload(client, bucket, key, file, stat, metadata, options = {}) {
  const partSize = positiveInt(options.partSize, DEFAULT_PART_SIZE);
  const created = await client.send(new CreateMultipartUploadCommand({
    Bucket: bucket, Key: key, Metadata: metadata,
    ContentType: 'application/octet-stream',
  }));
  const uploadId = created.UploadId;
  if (!uploadId) throw new Error(`multipart upload did not return UploadId for ${key}`);
  const parts = [];
  const handle = await fs.promises.open(file, 'r');
  try {
    let offset = 0;
    let partNumber = 1;
    while (offset < stat.size) {
      const length = Math.min(partSize, stat.size - offset);
      const body = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(body, 0, length, offset);
      if (bytesRead !== length) throw new Error(`short read for ${file} at ${offset}`);
      const uploaded = await client.send(new UploadPartCommand({
        Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber,
        Body: body, ContentLength: length,
      }));
      if (!uploaded.ETag) throw new Error(`multipart part ${partNumber} has no ETag`);
      parts.push({ ETag: uploaded.ETag, PartNumber: partNumber });
      offset += length;
      partNumber += 1;
    }
    await client.send(new CompleteMultipartUploadCommand({
      Bucket: bucket, Key: key, UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    }));
  } catch (error) {
    await client.send(new AbortMultipartUploadCommand({
      Bucket: bucket, Key: key, UploadId: uploadId,
    })).catch(() => {});
    throw error;
  } finally {
    await handle.close();
  }
}

async function uploadFile(client, bucket, key, file, stat, sha256, options = {}) {
  const metadata = metadataFor(sha256, stat);
  const threshold = positiveInt(options.multipartThreshold, DEFAULT_MULTIPART_THRESHOLD);
  if (stat.size >= threshold) {
    await multipartUpload(client, bucket, key, file, stat, metadata, options);
  } else {
    await client.send(new PutObjectCommand({
      Bucket: bucket, Key: key, Body: fs.createReadStream(file),
      ContentLength: stat.size, ContentType: 'application/octet-stream',
      Metadata: metadata,
    }));
  }
  if (!await headMatches(client, bucket, key, stat, sha256)) {
    throw new Error(`remote verification failed after upload: s3://${bucket}/${key}`);
  }
}

function stateKey(namespace, relative) {
  return `${namespace}:${relative}`;
}

function stateMatches(entry, stat, key) {
  return entry?.verified === true && entry.key === key
    && entry.size === stat.size && entry.mtimeMs === Math.floor(stat.mtimeMs)
    && /^[a-f0-9]{64}$/.test(String(entry.sha256 || ''));
}

async function ensureArchived({
  client, bucket, prefix, namespace, root, file, state, options,
}) {
  const relative = safeRelative(root, file);
  const key = objectKey(prefix, namespace, relative);
  const stat = fs.statSync(file);
  const id = stateKey(namespace, relative);
  if (stateMatches(state.objects[id], stat, key)) return { ...state.objects[id], cached: true };
  const sha256 = await sha256File(file);
  let uploaded = false;
  if (!await headMatches(client, bucket, key, stat, sha256)) {
    await uploadFile(client, bucket, key, file, stat, sha256, options);
    uploaded = true;
  }
  const entry = {
    namespace, relative, key, size: stat.size,
    mtimeMs: Math.floor(stat.mtimeMs), sha256, verified: true,
    verifiedAt: new Date().toISOString(),
  };
  state.objects[id] = entry;
  return { ...entry, uploaded, cached: false };
}

function receiptText({ scope, cutoffMs, destination, latest }) {
  const lines = [
    'format=deltaforge-offhost-receipt-v1',
    `scope=${scope}`,
    `completed_at=${new Date().toISOString()}`,
    `source_cutoff_epoch=${Math.floor(cutoffMs / 1000)}`,
    `destination=${destination}`,
    `latest_file=${latest?.key || 'none'}`,
  ];
  if (latest) {
    lines.push(`latest_size=${latest.size}`);
    lines.push(`latest_sha256=${latest.sha256}`);
  }
  return `${lines.join('\n')}\n`;
}

function createClient(env = process.env) {
  if (!env.ARCHIVE_S3_BUCKET) throw new Error('ARCHIVE_S3_BUCKET is required');
  const hasAccess = Boolean(env.ARCHIVE_S3_ACCESS_KEY_ID);
  const hasSecret = Boolean(env.ARCHIVE_S3_SECRET_ACCESS_KEY);
  if (hasAccess !== hasSecret) {
    throw new Error('ARCHIVE_S3_ACCESS_KEY_ID and ARCHIVE_S3_SECRET_ACCESS_KEY must be set together');
  }
  return new S3Client({
    region: env.ARCHIVE_S3_REGION || 'auto',
    endpoint: env.ARCHIVE_S3_ENDPOINT || undefined,
    forcePathStyle: bool(env.ARCHIVE_S3_FORCE_PATH_STYLE),
    credentials: hasAccess ? {
      accessKeyId: env.ARCHIVE_S3_ACCESS_KEY_ID,
      secretAccessKey: env.ARCHIVE_S3_SECRET_ACCESS_KEY,
    } : undefined,
  });
}

async function archiveGroup({
  files, namespace, root, context,
}) {
  const results = [];
  for (const file of files) {
    if (Date.now() >= context.deadlineAt || context.newObjects >= context.maxFiles) break;
    const stat = fs.statSync(file);
    const relative = safeRelative(root, file);
    const key = objectKey(context.prefix, namespace, relative);
    const existing = context.state.objects[stateKey(namespace, relative)];
    if (!stateMatches(existing, stat, key)) context.newObjects += 1;
    const result = await ensureArchived({
      ...context, namespace, root, file, options: context,
    });
    results.push(result);
    if (!result.cached) saveState(context.stateFile, context.state);
  }
  const complete = files.every((file) => {
    const stat = fs.statSync(file);
    const relative = safeRelative(root, file);
    const key = objectKey(context.prefix, namespace, relative);
    return stateMatches(context.state.objects[stateKey(namespace, relative)], stat, key);
  });
  return { complete, results, total: files.length };
}

async function main(options = {}) {
  const env = options.env || process.env;
  const client = options.client || createClient(env);
  const bucket = env.ARCHIVE_S3_BUCKET;
  const prefix = env.ARCHIVE_S3_PREFIX || 'deltaforge/dublin';
  const stateRoot = env.ARCHIVE_S3_STATE_ROOT || DEFAULT_STATE_ROOT;
  const stateFile = path.join(stateRoot, 'state.json');
  const cutoffMs = Date.now() - positiveInt(env.ARCHIVE_S3_CUTOFF_SECONDS, 300) * 1000;
  const context = {
    client, bucket, prefix, stateFile, state: loadState(stateFile),
    deadlineAt: Date.now() + positiveInt(env.ARCHIVE_S3_MAX_RUNTIME_MS, 12 * 60_000),
    maxFiles: positiveInt(env.ARCHIVE_S3_MAX_FILES_PER_RUN, 1000),
    newObjects: 0,
    multipartThreshold: positiveInt(env.ARCHIVE_S3_MULTIPART_THRESHOLD_BYTES,
      DEFAULT_MULTIPART_THRESHOLD),
    partSize: positiveInt(env.ARCHIVE_S3_PART_SIZE_BYTES, DEFAULT_PART_SIZE),
  };
  const walRoot = env.BORG_WAL_DIR || '/var/lib/deltaforge/wal/borg';
  const archiveRoot = env.BORG_ARCHIVE_DIR || '/var/lib/deltaforge/archive/borg-raw';
  const snapshotRoot = env.DELTAFORGE_DB_SNAPSHOT_DIR || '/var/lib/deltaforge/db-snapshots';
  const wal = await archiveGroup({
    files: eligibleRawFiles(walRoot, cutoffMs), namespace: 'wal', root: walRoot, context,
  });
  const databaseArchive = await archiveGroup({
    files: eligibleRawFiles(archiveRoot, cutoffMs),
    namespace: 'database-archive', root: archiveRoot, context,
  });

  const rawEntries = [...wal.results, ...databaseArchive.results];
  const rawComplete = wal.complete && databaseArchive.complete;
  if (rawComplete) {
    const latest = rawEntries.sort((left, right) => right.mtimeMs - left.mtimeMs)[0] || null;
    writeAtomic(env.BORG_OFFHOST_ARCHIVE_RECEIPT || DEFAULT_RAW_RECEIPT,
      receiptText({
        scope: 'raw-wal-and-db-archive', cutoffMs,
        destination: `s3://${bucket}/${prefix}`, latest,
      }), 0o644);
  }

  const snapshots = latestSnapshotFiles(snapshotRoot, cutoffMs);
  const snapshot = await archiveGroup({
    files: snapshots.files, namespace: 'database-snapshots',
    root: snapshotRoot, context,
  });
  let snapshotVerified = false;
  let latestSnapshot = null;
  if (snapshots.dump && snapshots.ready && snapshot.complete) {
    const relative = safeRelative(snapshotRoot, snapshots.dump);
    latestSnapshot = context.state.objects[stateKey('database-snapshots', relative)];
    const sidecar = `${snapshots.dump}.sha256`;
    const expected = fs.existsSync(sidecar)
      ? fs.readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0].toLowerCase() : null;
    snapshotVerified = /^[a-f0-9]{64}$/.test(expected || '')
      && expected === latestSnapshot?.sha256;
    if (snapshotVerified) {
      writeAtomic(env.BORG_OFFHOST_SNAPSHOT_RECEIPT || DEFAULT_SNAPSHOT_RECEIPT,
        receiptText({
          scope: 'database-snapshots', cutoffMs,
          destination: `s3://${bucket}/${prefix}`, latest: latestSnapshot,
        }), 0o644);
    }
  }

  saveState(stateFile, context.state);
  const report = {
    format: 'deltaforge-object-store-archive-v1',
    checkedAt: new Date().toISOString(),
    cutoffAt: new Date(cutoffMs).toISOString(),
    destination: `s3://${bucket}/${prefix}`,
    raw: {
      complete: rawComplete, walFiles: wal.total,
      databaseArchiveFiles: databaseArchive.total,
    },
    snapshot: {
      present: Boolean(snapshots.dump), complete: snapshot.complete,
      checksumVerified: snapshotVerified,
      latest: latestSnapshot?.key || null,
    },
    processedThisRun: wal.results.length + databaseArchive.results.length + snapshot.results.length,
    newObjectsThisRun: context.newObjects,
    receiptPublished: rawComplete,
  };
  writeAtomic(path.join(stateRoot, 'last-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!rawComplete) process.exitCode = 2;
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

module.exports = {
  archiveGroup, eligibleRawFiles, headMatches, latestSnapshotFiles,
  loadState, main, metadataFor, objectKey, positiveInt, receiptText,
  safeRelative, sha256File, statIfPresent, stateMatches, writeAtomic,
};
