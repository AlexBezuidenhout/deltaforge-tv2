#!/usr/bin/env node
'use strict';

/**
 * Verified, direct VPS -> Google Drive archive transport.
 *
 * The rclone remote must use Google's `drive.file` scope. That scope lets the
 * uploader read and modify only objects it created, rather than the rest of the
 * operator's Drive. Closed immutable raw objects are copied with `--immutable`,
 * verified with Google Drive's MD5 metadata through `rclone check`, recorded in
 * a SHA-256 manifest, and only then covered by the standard off-host receipts.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  eligibleRawFiles,
  latestSnapshotFiles,
  safeRelative,
  sha256File,
  statIfPresent,
  writeAtomic,
} = require('./object-store-archive');

const DEFAULT_CONFIG = '/etc/deltaforge/rclone.conf';
const DEFAULT_STATE_ROOT = '/var/lib/deltaforge/google-drive-archive';
const DEFAULT_RAW_RECEIPT = '/var/lib/deltaforge/offhost-archive.receipt';
const DEFAULT_SNAPSHOT_RECEIPT = '/var/lib/deltaforge/offhost-snapshot.receipt';
const DEFAULT_PREFIX = 'VPS Data';
const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024 * 1024;

function positiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function safeRemoteName(value) {
  const remote = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(remote)) {
    throw new Error('GDRIVE_RCLONE_REMOTE must contain only letters, digits, _ or -');
  }
  return remote;
}

function safeRemotePath(value) {
  const segments = String(value || '').split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (!segments.length || segments.some((segment) =>
    segment === '.' || segment === '..' || segment.includes(':'))) {
    throw new Error(`unsafe Google Drive archive path: ${value}`);
  }
  return segments.join('/');
}

function remoteTarget(remote, ...parts) {
  const suffix = safeRemotePath(parts.filter(Boolean).join('/'));
  return `${safeRemoteName(remote)}:${suffix}`;
}

function parseIniSection(contents, wanted) {
  let current = null;
  const values = {};
  for (const rawLine of String(contents || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      current = section[1];
      continue;
    }
    if (current !== wanted) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return values;
}

function validateRcloneConfig(file, remote) {
  if (!fs.existsSync(file)) throw new Error(`rclone config is missing: ${file}`);
  const values = parseIniSection(fs.readFileSync(file, 'utf8'), remote);
  if (values.type !== 'drive') throw new Error(`${remote} is not a Google Drive remote`);
  if (values.scope !== 'drive.file') {
    throw new Error(`${remote} must use least-privilege scope drive.file`);
  }
  if (!values.token) throw new Error(`${remote} has no OAuth token`);
  return { type: values.type, scope: values.scope };
}

function loadState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state?.format === 'deltaforge-google-drive-state-v1') return state;
  } catch (_) {}
  return { format: 'deltaforge-google-drive-state-v1', objects: {} };
}

function saveState(file, state) {
  state.updatedAt = new Date().toISOString();
  writeAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
}

function recordId(namespace, relative) {
  return `${namespace}:${relative}`;
}

function stateMatches(entry, record, destination) {
  return entry?.verified === true
    && entry.destination === destination
    && entry.relative === record.relative
    && entry.size === record.size
    && entry.mtimeMs === record.mtimeMs
    && /^[a-f0-9]{64}$/.test(String(entry.sha256 || ''));
}

function backlogSummary(records, state, destination, nowMs = Date.now()) {
  const pending = records.filter((record) =>
    !stateMatches(state.objects?.[record.id], record, destination));
  const oldestMtimeMs = pending.reduce((oldest, record) =>
    Math.min(oldest, Number(record.mtimeMs) || Infinity), Infinity);
  return {
    pendingFiles: pending.length,
    pendingBytes: pending.reduce((sum, record) => sum + (Number(record.size) || 0), 0),
    oldestPendingAt: Number.isFinite(oldestMtimeMs)
      ? new Date(oldestMtimeMs).toISOString() : null,
    oldestPendingAgeSec: Number.isFinite(oldestMtimeMs)
      ? Math.max(0, (nowMs - oldestMtimeMs) / 1000) : 0,
  };
}

function recordsFor(root, namespace, files, destination) {
  return files.flatMap((file) => {
    const stat = statIfPresent(file);
    if (!stat) return [];
    const relative = safeRelative(root, file);
    return [{
      id: recordId(namespace, relative),
      namespace,
      root,
      file,
      relative,
      remotePath: `${destination}/${namespace}/${relative}`,
      size: stat.size,
      mtimeMs: Math.floor(stat.mtimeMs),
    }];
  });
}

function selectBatch(records, maxFiles = DEFAULT_MAX_FILES, maxBytes = DEFAULT_MAX_BYTES) {
  const selected = [];
  let bytes = 0;
  for (const record of records) {
    if (selected.length >= maxFiles) break;
    if (selected.length && bytes + record.size > maxBytes) break;
    selected.push(record);
    bytes += record.size;
  }
  return { records: selected, bytes };
}

function writeFileList(file, records) {
  for (const record of records) {
    if (record.relative.includes('\n') || record.relative.includes('\r')) {
      throw new Error(`newline is not allowed in archive path: ${record.relative}`);
    }
  }
  fs.writeFileSync(file, records.map((record) => record.relative).join('\n') + '\n', {
    mode: 0o600,
  });
}

function parseCombinedReport(contents, expected) {
  const lines = String(contents || '').split(/\r?\n/).filter(Boolean);
  const matches = lines.filter((line) => line.startsWith('= '));
  const failures = lines.filter((line) => !line.startsWith('= '));
  if (failures.length || matches.length !== expected) {
    throw new Error(
      `remote verification mismatch: ${matches.length}/${expected} matched`
      + (failures.length ? `; ${failures.slice(0, 3).join(' | ')}` : ''),
    );
  }
  return matches.length;
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
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (options.echo !== false) process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (options.echo !== false) process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) return resolve({ code, stdout, stderr });
      const error = new Error(
        `${binary} exited ${code ?? signal}: ${stderr.trim().slice(-1000)}`,
      );
      error.code = code;
      error.signal = signal;
      reject(error);
    });
  });
}

function rcloneCommon(env, configFile) {
  return [
    '--config', configFile,
    '--transfers', String(positiveInt(env.GDRIVE_TRANSFERS, 2)),
    '--checkers', String(positiveInt(env.GDRIVE_CHECKERS, 4)),
    '--drive-chunk-size', env.GDRIVE_CHUNK_SIZE || '64Mi',
    '--tpslimit', String(positiveInt(env.GDRIVE_TPS_LIMIT, 8)),
    '--tpslimit-burst', String(positiveInt(env.GDRIVE_TPS_BURST, 8)),
    '--contimeout', env.GDRIVE_CONNECT_TIMEOUT || '30s',
    '--timeout', env.GDRIVE_IO_TIMEOUT || '5m',
    '--retries', String(positiveInt(env.GDRIVE_RETRIES, 3)),
    '--low-level-retries', String(positiveInt(env.GDRIVE_LOW_LEVEL_RETRIES, 10)),
    '--retries-sleep', env.GDRIVE_RETRIES_SLEEP || '30s',
  ];
}

function archiveReportFile(env = process.env) {
  const stateRoot = env.GDRIVE_ARCHIVE_STATE_ROOT || DEFAULT_STATE_ROOT;
  return path.join(stateRoot, 'last-report.json');
}

function writeArchiveFailureReport(error, env = process.env) {
  const report = {
    format: 'deltaforge-google-drive-archive-v1',
    status: 'failed',
    failedAt: new Date().toISOString(),
    errorCode: error?.code || null,
    error: String(error?.message || error || 'unknown Google Drive archive failure').slice(0, 500),
  };
  try {
    writeAtomic(archiveReportFile(env), `${JSON.stringify(report, null, 2)}\n`);
  } catch (writeError) {
    console.error(`unable to persist Google Drive failure report: ${writeError.message}`);
  }
  return report;
}

async function ensureRemoteDirectory({
  destination, configFile, rclone, env,
}) {
  await rclone([
    'mkdir', destination,
    ...rcloneCommon(env, configFile),
  ]);
}

async function copyAndVerifyBatch({
  batch, namespace, root, remote, prefix, configFile, rclone, env, workRoot,
}) {
  if (!batch.length) return { verified: 0 };
  const listFile = path.join(workRoot, `${namespace}.files`);
  const combinedFile = path.join(workRoot, `${namespace}.combined`);
  writeFileList(listFile, batch);
  const destination = remoteTarget(remote, prefix, namespace);
  const common = rcloneCommon(env, configFile);
  await ensureRemoteDirectory({
    destination, configFile, rclone, env,
  });
  await rclone([
    'copy', root, destination,
    '--files-from-raw', listFile,
    '--immutable',
    '--checksum',
    '--fast-list',
    '--stats', '30s',
    '--stats-one-line-date',
    ...common,
  ]);
  await rclone([
    'check', root, destination,
    '--files-from-raw', listFile,
    '--one-way',
    '--checksum',
    '--combined', combinedFile,
    '--fast-list',
    ...common,
  ]);
  const verified = parseCombinedReport(fs.readFileSync(combinedFile, 'utf8'), batch.length);
  return { verified };
}

async function hashVerifiedBatch(batch, destination, state, concurrency = 2) {
  const queue = [...batch];
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length) {
      const record = queue.shift();
      const sha256 = await sha256File(record.file);
      const stat = fs.statSync(record.file);
      if (stat.size !== record.size || Math.floor(stat.mtimeMs) !== record.mtimeMs) {
        throw new Error(`immutable source changed during verification: ${record.file}`);
      }
      state.objects[record.id] = {
        namespace: record.namespace,
        relative: record.relative,
        remotePath: record.remotePath,
        destination,
        size: record.size,
        mtimeMs: record.mtimeMs,
        sha256,
        verified: true,
        verifiedAt: new Date().toISOString(),
        remoteVerification: 'google-drive-md5-via-rclone-check',
      };
    }
  });
  await Promise.all(workers);
}

function manifestDocument({ cutoffMs, destination, records, state }) {
  return {
    format: 'deltaforge-google-drive-manifest-v1',
    createdAt: new Date().toISOString(),
    sourceCutoffEpoch: Math.floor(cutoffMs / 1000),
    destination,
    verification: 'google-drive-md5-via-rclone-check',
    objects: records.map((record) => {
      const entry = state.objects[record.id];
      if (!stateMatches(entry, record, destination)) {
        throw new Error(`manifest contains unverified object: ${record.id}`);
      }
      return {
        namespace: record.namespace,
        relative: record.relative,
        remotePath: entry.remotePath,
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        sha256: entry.sha256,
        verifiedAt: entry.verifiedAt,
      };
    }),
  };
}

function timestampName(cutoffMs) {
  return new Date(cutoffMs).toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
}

async function publishManifest({
  document, kind, stateRoot, remote, prefix, configFile, rclone, env, workRoot,
}) {
  const safeKind = String(kind || '').replace(/[^a-z0-9_-]/gi, '');
  if (!safeKind) throw new Error('manifest kind is required');
  const name = `${timestampName(document.sourceCutoffEpoch * 1000)}.${safeKind}.manifest.json`;
  const localDirectory = path.join(stateRoot, 'manifests');
  const localFile = path.join(localDirectory, name);
  fs.mkdirSync(localDirectory, { recursive: true });
  writeAtomic(localFile, `${JSON.stringify(document, null, 2)}\n`);
  const sha256 = await sha256File(localFile);
  const listFile = path.join(workRoot, 'manifest.files');
  const combinedFile = path.join(workRoot, 'manifest.combined');
  writeFileList(listFile, [{
    relative: name,
  }]);
  const destination = remoteTarget(remote, prefix, 'manifests');
  const common = rcloneCommon(env, configFile);
  await ensureRemoteDirectory({
    destination, configFile, rclone, env,
  });
  await rclone([
    'copy', localDirectory, destination,
    '--files-from-raw', listFile,
    '--immutable',
    '--checksum',
    ...common,
  ]);
  await rclone([
    'check', localDirectory, destination,
    '--files-from-raw', listFile,
    '--one-way',
    '--checksum',
    '--combined', combinedFile,
    ...common,
  ]);
  parseCombinedReport(fs.readFileSync(combinedFile, 'utf8'), 1);
  return {
    relative: `manifests/${name}`,
    remotePath: `${safeRemotePath(prefix)}/manifests/${name}`,
    size: fs.statSync(localFile).size,
    sha256,
  };
}

function latestRecord(records, state) {
  if (!records.length) return null;
  const record = [...records].sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
  const entry = state.objects[record.id];
  return {
    key: entry.remotePath,
    size: entry.size,
    sha256: entry.sha256,
  };
}

function receiptText({
  scope, cutoffMs, destination, account, latest, manifest,
}) {
  if (!latest) throw new Error(`cannot publish ${scope} receipt without an immutable object`);
  const lines = [
    'format=deltaforge-offhost-receipt-v1',
    `scope=${scope}`,
    `completed_at=${new Date().toISOString()}`,
    `source_cutoff_epoch=${Math.floor(cutoffMs / 1000)}`,
    `destination=${destination}`,
    `account=${account}`,
    'remote_verification=google-drive-md5-via-rclone-check',
    `latest_file=${latest.key}`,
    `latest_size=${latest.size}`,
    `latest_sha256=${latest.sha256}`,
    `manifest_file=${manifest.remotePath}`,
    `manifest_size=${manifest.size}`,
    `manifest_sha256=${manifest.sha256}`,
  ];
  return `${lines.join('\n')}\n`;
}

async function main(options = {}) {
  const env = options.env || process.env;
  const remote = safeRemoteName(env.GDRIVE_RCLONE_REMOTE || 'deltaforge-gdrive');
  const prefix = safeRemotePath(env.GDRIVE_ARCHIVE_PREFIX || DEFAULT_PREFIX);
  const account = String(env.GDRIVE_ACCOUNT_LABEL || '').trim();
  if (!account) throw new Error('GDRIVE_ACCOUNT_LABEL is required');
  const configFile = env.GDRIVE_RCLONE_CONFIG || DEFAULT_CONFIG;
  validateRcloneConfig(configFile, remote);
  const rcloneBinary = env.GDRIVE_RCLONE_BINARY || '/usr/local/bin/rclone';
  if (!fs.existsSync(rcloneBinary)) throw new Error(`rclone is missing: ${rcloneBinary}`);
  const destination = `gdrive://${account}/${prefix}`;
  const stateRoot = env.GDRIVE_ARCHIVE_STATE_ROOT || DEFAULT_STATE_ROOT;
  const stateFile = path.join(stateRoot, 'state.json');
  const state = loadState(stateFile);
  const cutoffMs = Date.now() - positiveInt(env.GDRIVE_CUTOFF_SECONDS, 300) * 1000;
  const walRoot = env.BORG_WAL_DIR || '/var/lib/deltaforge/wal/borg';
  const archiveRoot = env.BORG_ARCHIVE_DIR || '/var/lib/deltaforge/archive/borg-raw';
  const snapshotRoot = env.DELTAFORGE_DB_SNAPSHOT_DIR || '/var/lib/deltaforge/db-snapshots';
  const maxFiles = positiveInt(env.GDRIVE_MAX_FILES_PER_RUN, DEFAULT_MAX_FILES);
  const maxBytes = positiveInt(env.GDRIVE_MAX_BYTES_PER_RUN, DEFAULT_MAX_BYTES);
  const allRecords = [
    ...recordsFor(walRoot, 'wal', eligibleRawFiles(walRoot, cutoffMs), destination),
    ...recordsFor(
      archiveRoot,
      'database-archive',
      eligibleRawFiles(archiveRoot, cutoffMs),
      destination,
    ),
  ];
  const snapshotSelection = latestSnapshotFiles(snapshotRoot, cutoffMs);
  const snapshotRecords = recordsFor(
    snapshotRoot,
    'database-snapshots',
    snapshotSelection.files,
    destination,
  );
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deltaforge-gdrive-'));
  const runRclone = options.rclone || ((args) =>
    runCommand(rcloneBinary, args, { env }));
  const report = {
    format: 'deltaforge-google-drive-archive-v1',
    status: 'verified',
    checkedAt: new Date().toISOString(),
    cutoffAt: new Date(cutoffMs).toISOString(),
    destination,
    selectedRawFiles: allRecords.length,
    selectedSnapshotFiles: snapshotRecords.length,
    transferredFiles: 0,
    transferredBytes: 0,
    receiptPublished: false,
    snapshotReceiptPublished: false,
  };
  try {
    const pendingRaw = allRecords.filter((record) =>
      !stateMatches(state.objects[record.id], record, destination));
    const pendingSnapshot = snapshotRecords.filter((record) =>
      !stateMatches(state.objects[record.id], record, destination));
    const pending = [...pendingRaw, ...pendingSnapshot];
    const batchSelection = selectBatch(pending, maxFiles, maxBytes);
    const byGroup = new Map();
    for (const record of batchSelection.records) {
      const key = `${record.namespace}\0${record.root}`;
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(record);
    }
    for (const [key, batch] of byGroup) {
      const [namespace, root] = key.split('\0');
      await copyAndVerifyBatch({
        batch, namespace, root, remote, prefix, configFile,
        rclone: runRclone, env, workRoot,
      });
      await hashVerifiedBatch(
        batch,
        destination,
        state,
        positiveInt(env.GDRIVE_HASH_WORKERS, 2),
      );
      saveState(stateFile, state);
      report.transferredFiles += batch.length;
      report.transferredBytes += batch.reduce((total, record) => total + record.size, 0);
    }

    const rawRescan = [
      ...recordsFor(walRoot, 'wal', eligibleRawFiles(walRoot, cutoffMs), destination),
      ...recordsFor(
        archiveRoot,
        'database-archive',
        eligibleRawFiles(archiveRoot, cutoffMs),
        destination,
      ),
    ];
    const rawComplete = rawRescan.length === allRecords.length
      && rawRescan.every((record) =>
        stateMatches(state.objects[record.id], record, destination));
    report.rawBacklog = backlogSummary(rawRescan, state, destination);
    report.rawComplete = rawComplete;
    if (rawComplete && rawRescan.length) {
      const document = manifestDocument({
        cutoffMs, destination, records: rawRescan, state,
      });
      const manifest = await publishManifest({
        document, kind: 'raw', stateRoot, remote, prefix, configFile,
        rclone: runRclone, env, workRoot,
      });
      writeAtomic(env.BORG_OFFHOST_ARCHIVE_RECEIPT || DEFAULT_RAW_RECEIPT,
        receiptText({
          scope: 'raw-wal-and-db-archive',
          cutoffMs,
          destination,
          account,
          latest: latestRecord(rawRescan, state),
          manifest,
        }), 0o644);
      report.receiptPublished = true;
      report.manifest = manifest.remotePath;
    }

    const snapshotComplete = snapshotSelection.dump
      && snapshotSelection.ready
      && snapshotRecords.every((record) =>
        stateMatches(state.objects[record.id], record, destination));
    report.snapshotComplete = Boolean(snapshotComplete);
    if (snapshotComplete) {
      const dumpRecord = snapshotRecords.find((record) =>
        record.file === snapshotSelection.dump);
      const dumpEntry = dumpRecord && state.objects[dumpRecord.id];
      const expected = fs.readFileSync(`${snapshotSelection.dump}.sha256`, 'utf8')
        .trim().split(/\s+/)[0].toLowerCase();
      if (!dumpEntry || expected !== dumpEntry.sha256) {
        throw new Error('verified Drive snapshot does not match its SHA-256 sidecar');
      }
      const document = manifestDocument({
        cutoffMs, destination, records: snapshotRecords, state,
      });
      const manifest = await publishManifest({
        document, kind: 'snapshot', stateRoot, remote, prefix, configFile,
        rclone: runRclone, env, workRoot,
      });
      writeAtomic(env.BORG_OFFHOST_SNAPSHOT_RECEIPT || DEFAULT_SNAPSHOT_RECEIPT,
        receiptText({
          scope: 'database-snapshots',
          cutoffMs,
          destination,
          account,
          latest: latestRecord([dumpRecord], state),
          manifest,
        }), 0o644);
      report.snapshotReceiptPublished = true;
      report.snapshotManifest = manifest.remotePath;
    }

    saveState(stateFile, state);
    writeAtomic(path.join(stateRoot, 'last-report.json'),
      `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    return report;
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    writeArchiveFailureReport(error, process.env);
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = {
  backlogSummary,
  archiveReportFile,
  loadState,
  main,
  manifestDocument,
  parseCombinedReport,
  parseIniSection,
  positiveInt,
  receiptText,
  recordsFor,
  remoteTarget,
  safeRemoteName,
  safeRemotePath,
  selectBatch,
  stateMatches,
  validateRcloneConfig,
  writeArchiveFailureReport,
  writeFileList,
};
