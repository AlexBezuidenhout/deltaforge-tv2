#!/usr/bin/env node
'use strict';

/**
 * Recover sealed-but-uncompressed WAL segments left by interrupted collectors.
 *
 * `--prepare` is non-destructive:
 *   - validates every plain `.ndjson` segment;
 *   - writes a checksum-verified `.ndjson.gz` beside every segment containing
 *     events; and
 *   - packs header-only restart debris into one exact tar.gz bundle.
 *
 * `--finalize` removes a plain segment only after a fresh off-host receipt
 * covers its verified gzip or recovery bundle. This keeps crash recovery
 * fail-closed without publishing hundreds of thousands of empty files.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const fsp = fs.promises;
const DEFAULT_ROOT = process.env.BORG_WAL_DIR || '/var/lib/deltaforge/wal/borg';
const DEFAULT_RECEIPT = '/var/lib/deltaforge/offhost-archive.receipt';
const RECEIPT_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const SMALL_SEGMENT_BYTES = 64 * 1024;
const OPEN_RECOVERY_CONFIRM = 'collectors-drained';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function safeRelative(root, file) {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes('\0')) {
    throw new Error(`unsafe WAL path: ${file}`);
  }
  return relative;
}

async function syncDirectory(dir) {
  let handle;
  try {
    handle = await fsp.open(dir, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code)) throw error;
  } finally {
    if (handle) await handle.close();
  }
}

async function atomicWrite(file, bytes) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  let handle;
  try {
    handle = await fsp.open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fsp.unlink(temporary).catch(() => {});
    throw error;
  }
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const input = fs.createReadStream(file);
  for await (const chunk of input) hash.update(chunk);
  return hash.digest('hex');
}

async function hashGunzip(file) {
  const hash = crypto.createHash('sha256');
  const input = fs.createReadStream(file).pipe(zlib.createGunzip());
  for await (const chunk of input) hash.update(chunk);
  return hash.digest('hex');
}

function validateLines(lines, file, endsWithNewline) {
  let header = null;
  let rows = 0;
  let invalidLines = 0;
  let invalidBytes = 0;
  let truncatedTailBytes = 0;
  const finalContentIndex = lines.reduce(
    (answer, line, index) => line.trim() ? index : answer,
    -1,
  );
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      if (!header) throw new Error(`${file}: invalid WAL header: ${error.message}`);
      const bytes = Buffer.byteLength(line);
      invalidLines += 1;
      invalidBytes += bytes;
      if (index === finalContentIndex && !endsWithNewline) truncatedTailBytes = bytes;
      continue;
    }
    if (!header) {
      if (!parsed?._borg_wal || !String(parsed._borg_wal.format || '').startsWith('borg-event-wal-')) {
        throw new Error(`${file}: missing WAL header`);
      }
      header = parsed._borg_wal;
    } else {
      rows += 1;
    }
  }
  if (!header) throw new Error(`${file}: empty WAL segment`);
  return { header, rows, invalidLines, invalidBytes, truncatedTailBytes };
}

async function inspectSegment(file, stat = null) {
  const metadata = stat || await fsp.stat(file);
  if (metadata.size <= SMALL_SEGMENT_BYTES) {
    const bytes = await fsp.readFile(file);
    return {
      ...validateLines(
        bytes.toString('utf8').split(/\r?\n/),
        file,
        bytes.length > 0 && bytes[bytes.length - 1] === 0x0a,
      ),
      bytes: metadata.size,
      mtimeMs: metadata.mtimeMs,
      sha256: sha256(bytes),
    };
  }

  const hash = crypto.createHash('sha256');
  const input = fs.createReadStream(file);
  input.on('data', (chunk) => hash.update(chunk));
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let header = null;
  let rows = 0;
  let invalidLines = 0;
  let invalidBytes = 0;
  let finalContentWasInvalid = false;
  let finalInvalidBytes = 0;
  for await (const line of lines) {
    if (!line.trim()) continue;
    finalContentWasInvalid = false;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      if (!header) throw new Error(`${file}: invalid WAL header: ${error.message}`);
      finalInvalidBytes = Buffer.byteLength(line);
      invalidLines += 1;
      invalidBytes += finalInvalidBytes;
      finalContentWasInvalid = true;
      continue;
    }
    if (!header) {
      if (!parsed?._borg_wal || !String(parsed._borg_wal.format || '').startsWith('borg-event-wal-')) {
        throw new Error(`${file}: missing WAL header`);
      }
      header = parsed._borg_wal;
    } else {
      rows += 1;
    }
  }
  if (!header) throw new Error(`${file}: empty WAL segment`);
  let truncatedTailBytes = 0;
  if (finalContentWasInvalid) {
    const handle = await fsp.open(file, 'r');
    const tail = Buffer.alloc(1);
    try {
      await handle.read(tail, 0, 1, Math.max(0, metadata.size - 1));
    } finally {
      await handle.close();
    }
    if (tail[0] !== 0x0a) truncatedTailBytes = finalInvalidBytes;
  }
  return {
    header,
    rows,
    invalidLines,
    invalidBytes,
    truncatedTailBytes,
    bytes: metadata.size,
    mtimeMs: metadata.mtimeMs,
    sha256: hash.digest('hex'),
  };
}

async function* filesBelow(root) {
  let directory;
  try {
    directory = await fsp.opendir(root);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for await (const entry of directory) {
    if (entry.name === '_recovery' || entry.name.startsWith('.recovery-')) continue;
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) yield* filesBelow(file);
    else if (entry.isFile() && entry.name.endsWith('.ndjson')) yield file;
  }
}

async function* openFilesBelow(root) {
  let directory;
  try {
    directory = await fsp.opendir(root);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for await (const entry of directory) {
    if (entry.name === '_recovery' || entry.name.startsWith('.recovery-')) continue;
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) yield* openFilesBelow(file);
    else if (entry.isFile() && entry.name.endsWith('.open')) yield file;
  }
}

async function recoverOrphanOpenSegments(root, options = {}) {
  if (options.confirm !== OPEN_RECOVERY_CONFIRM) {
    throw new Error(`orphan .open recovery requires confirmation: ${OPEN_RECOVERY_CONFIRM}`);
  }
  const minimumAgeMs = options.minimumAgeMs ?? 60_000;
  const recovered = [];
  for await (const file of openFilesBelow(root)) {
    const stat = await fsp.stat(file);
    if (Date.now() - stat.mtimeMs < minimumAgeMs) {
      throw new Error(`refusing recently modified open WAL segment: ${file}`);
    }
    const target = file.replace(/\.open$/, '.recovered.ndjson');
    try {
      await fsp.access(target, fs.constants.F_OK);
      throw new Error(`orphan WAL recovery target already exists: ${target}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await fsp.rename(file, target);
    await syncDirectory(path.dirname(file));
    recovered.push({
      from: safeRelative(root, file),
      path: safeRelative(root, target),
      bytes: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }
  return recovered;
}

async function compressVerified(file, expectedRawSha = null) {
  const gzipFile = `${file}.gz`;
  const rawSha = expectedRawSha || await hashFile(file);
  try {
    await fsp.access(gzipFile, fs.constants.R_OK);
    const [verifiedRaw, gzipSha, stat] = await Promise.all([
      hashGunzip(gzipFile),
      hashFile(gzipFile),
      fsp.stat(gzipFile),
    ]);
    if (verifiedRaw !== rawSha) throw new Error(`existing gzip differs from ${file}`);
    return { file: gzipFile, rawSha256: rawSha, gzipSha256: gzipSha, gzipBytes: stat.size };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const temporary = `${gzipFile}.${process.pid}.${Date.now()}.tmp`;
  const sourceHash = crypto.createHash('sha256');
  const tap = new Transform({
    transform(chunk, _encoding, callback) {
      sourceHash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      fs.createReadStream(file),
      tap,
      zlib.createGzip({ level: 6 }),
      fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
    );
    const handle = await fsp.open(temporary, 'r');
    await handle.sync();
    await handle.close();
    const streamedRawSha = sourceHash.digest('hex');
    if (streamedRawSha !== rawSha) throw new Error(`source changed during compression: ${file}`);
    const verifiedRaw = await hashGunzip(temporary);
    if (verifiedRaw !== rawSha) throw new Error(`gzip verification failed: ${file}`);
    await fsp.rename(temporary, gzipFile);
    await syncDirectory(path.dirname(gzipFile));
    const [gzipSha, stat] = await Promise.all([hashFile(gzipFile), fsp.stat(gzipFile)]);
    return { file: gzipFile, rawSha256: rawSha, gzipSha256: gzipSha, gzipBytes: stat.size };
  } catch (error) {
    await fsp.unlink(temporary).catch(() => {});
    throw error;
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', options.countLines ? 'pipe' : 'ignore', 'pipe'] });
    let stderr = '';
    let lines = 0;
    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        for (const byte of chunk) if (byte === 0x0a) lines += 1;
      });
    }
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 8192) stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ lines });
      else reject(new Error(`${command} exited ${code}: ${stderr.trim()}`));
    });
  });
}

async function createHeaderBundle(root, recoveryDir, members, inventorySha) {
  if (!members.length) return null;
  const stem = `header-only-${inventorySha.slice(0, 20)}`;
  const bundle = path.join(recoveryDir, `${stem}.tar.gz`);
  const listFile = path.join(recoveryDir, `.${stem}.${process.pid}.files`);
  const temporary = `${bundle}.${process.pid}.tmp`;
  await fsp.mkdir(recoveryDir, { recursive: true });
  await fsp.writeFile(listFile, Buffer.from(`${members.map((row) => row.path).join('\0')}\0`), {
    mode: 0o600,
    flag: 'wx',
  });
  try {
    try {
      await fsp.access(bundle, fs.constants.R_OK);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await run('tar', [
        '--create', '--gzip', '--file', temporary, '--no-recursion',
        '--directory', root, '--null', '--files-from', listFile,
      ]);
      const handle = await fsp.open(temporary, 'r');
      await handle.sync();
      await handle.close();
      await fsp.rename(temporary, bundle);
      await syncDirectory(path.dirname(bundle));
    }
    const listed = await run('tar', ['--list', '--gzip', '--file', bundle], { countLines: true });
    if (listed.lines !== members.length) {
      throw new Error(`recovery bundle contains ${listed.lines} files; expected ${members.length}`);
    }
    const [archiveSha256, stat] = await Promise.all([hashFile(bundle), fsp.stat(bundle)]);
    return {
      file: safeRelative(root, bundle),
      archive_sha256: archiveSha256,
      compressed_bytes: stat.size,
      member_count: members.length,
      source_bytes: members.reduce((sum, row) => sum + row.bytes, 0),
      source_max_mtime_ms: members.reduce(
        (maximum, row) => Math.max(maximum, row.mtimeMs),
        0,
      ),
    };
  } finally {
    await fsp.unlink(listFile).catch(() => {});
    await fsp.unlink(temporary).catch(() => {});
  }
}

function inventoryHash(rows) {
  const hash = crypto.createHash('sha256');
  for (const row of [...rows].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(row.path);
    hash.update('\0');
    hash.update(String(row.bytes));
    hash.update('\0');
    hash.update(row.sha256);
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function prepare(root, options = {}) {
  const startedAt = new Date().toISOString();
  const recoveredOpen = options.recoverOpen
    ? await recoverOrphanOpenSegments(root, {
      confirm: options.openRecoveryConfirm,
      minimumAgeMs: options.openMinimumAgeMs,
    })
    : [];
  const headers = [];
  const eventSources = [];
  let scanned = 0;
  for await (const file of filesBelow(root)) {
    const stat = await fsp.stat(file);
    const inspected = await inspectSegment(file, stat);
    const record = {
      path: safeRelative(root, file),
      bytes: inspected.bytes,
      mtimeMs: inspected.mtimeMs,
      sha256: inspected.sha256,
      rows: inspected.rows,
      invalidLines: inspected.invalidLines,
      invalidBytes: inspected.invalidBytes,
      truncatedTailBytes: inspected.truncatedTailBytes,
    };
    if (inspected.rows === 0 && inspected.invalidLines === 0) headers.push(record);
    else eventSources.push(record);
    scanned += 1;
    if (scanned % 25_000 === 0) {
      process.stderr.write(`validated ${scanned} plain WAL segments\n`);
    }
  }

  const recoveryDir = path.join(root, '_recovery', new Date().toISOString().slice(0, 10));
  const headerInventorySha = inventoryHash(headers);
  const eventInventorySha = inventoryHash(eventSources);
  const eventSegments = [];
  for (let index = 0; index < eventSources.length; index += 1) {
    const source = eventSources[index];
    const compressed = await compressVerified(path.join(root, source.path), source.sha256);
    eventSegments.push({
      ...source,
      gzip_path: safeRelative(root, compressed.file),
      gzip_sha256: compressed.gzipSha256,
      gzip_bytes: compressed.gzipBytes,
    });
    process.stderr.write(`verified event WAL ${index + 1}/${eventSources.length}\n`);
  }
  const headerBundle = await createHeaderBundle(root, recoveryDir, headers, headerInventorySha);
  const aggregateHash = crypto.createHash('sha256')
    .update(headerInventorySha).update(eventInventorySha).digest('hex');
  const manifestFile = path.join(recoveryDir, `wal-recovery-${aggregateHash.slice(0, 20)}.manifest.json`);
  const manifest = {
    format: 'deltaforge-wal-recovery-v1',
    prepared_at: new Date().toISOString(),
    started_at: startedAt,
    root,
    recovered_open_segments: recoveredOpen,
    plain_segments: scanned,
    plain_bytes: [...headers, ...eventSources].reduce((sum, row) => sum + row.bytes, 0),
    header_only_segments: headers.length,
    header_only_inventory_sha256: headerInventorySha,
    header_bundle: headerBundle,
    event_segments: eventSegments,
  };
  await atomicWrite(manifestFile, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  return { manifest: manifestFile, ...manifest };
}

function readReceipt(file) {
  const values = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const split = line.indexOf('=');
    if (split > 0) values[line.slice(0, split)] = line.slice(split + 1);
  }
  const completedAt = Date.parse(values.completed_at || '');
  const cutoff = Number(values.source_cutoff_epoch);
  if (values.format !== 'deltaforge-offhost-receipt-v1'
      || values.scope !== 'raw-wal-and-db-archive'
      || values.latest_file === 'none'
      || !Number.isFinite(completedAt)
      || Date.now() - completedAt > RECEIPT_MAX_AGE_MS
      || !Number.isInteger(cutoff)
      || cutoff <= 0) {
    throw new Error(`off-host receipt is missing, stale, or invalid: ${file}`);
  }
  return { ...values, completedAt, cutoff };
}

async function listRecoveryManifests(root) {
  const recoveryRoot = path.join(root, '_recovery');
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && entry.name.endsWith('.manifest.json')) out.push(file);
    }
  }
  await walk(recoveryRoot);
  return out.sort();
}

async function bundleMembers(root, manifest, manifestFile, receiptCutoffMs) {
  if (!manifest.header_bundle) return new Set();
  const bundle = path.join(root, manifest.header_bundle.file);
  const [bundleStat, manifestStat, bundleSha] = await Promise.all([
    fsp.stat(bundle),
    fsp.stat(manifestFile),
    hashFile(bundle),
  ]);
  if (bundleStat.mtimeMs > receiptCutoffMs || manifestStat.mtimeMs > receiptCutoffMs) return new Set();
  if (bundleSha !== manifest.header_bundle.archive_sha256) {
    throw new Error(`recovery bundle checksum mismatch: ${bundle}`);
  }
  const members = new Set();
  await new Promise((resolve, reject) => {
    const child = spawn('tar', ['--list', '--gzip', '--file', bundle], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    let stderr = '';
    lines.on('line', (line) => members.add(line.replace(/^\.\//, '')));
    child.stderr.on('data', (chunk) => { if (stderr.length < 8192) stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => code === 0
      ? resolve()
      : reject(new Error(`tar list exited ${code}: ${stderr.trim()}`)));
  });
  if (members.size !== manifest.header_bundle.member_count) {
    throw new Error(`recovery bundle member mismatch: ${bundle}`);
  }
  return members;
}

async function finalize(root, receiptFile) {
  const receipt = readReceipt(receiptFile);
  const receiptCutoffMs = receipt.cutoff * 1000;
  const headerCoverage = new Set();
  const eventCoverage = new Map();
  const manifestFiles = await listRecoveryManifests(root);
  for (const manifestFile of manifestFiles) {
    const manifest = JSON.parse(await fsp.readFile(manifestFile, 'utf8'));
    if (manifest.format !== 'deltaforge-wal-recovery-v1') continue;
    const members = await bundleMembers(root, manifest, manifestFile, receiptCutoffMs);
    for (const member of members) headerCoverage.add(member);
    const manifestStat = await fsp.stat(manifestFile);
    if (manifestStat.mtimeMs <= receiptCutoffMs) {
      for (const segment of manifest.event_segments || []) eventCoverage.set(segment.path, segment);
    }
  }

  let removed = 0;
  let removedBytes = 0;
  let skipped = 0;
  for await (const file of filesBelow(root)) {
    const relative = safeRelative(root, file);
    const stat = await fsp.stat(file);
    if (stat.mtimeMs > receiptCutoffMs) {
      skipped += 1;
      continue;
    }
    if (headerCoverage.has(relative)) {
      await fsp.unlink(file);
      removed += 1;
      removedBytes += stat.size;
      continue;
    }
    const expected = eventCoverage.get(relative);
    if (!expected) {
      skipped += 1;
      continue;
    }
    const gzipFile = path.join(root, expected.gzip_path);
    const gzipStat = await fsp.stat(gzipFile);
    if (gzipStat.mtimeMs > receiptCutoffMs) {
      skipped += 1;
      continue;
    }
    const [rawSha, gzipSha, verifiedRaw] = await Promise.all([
      hashFile(file),
      hashFile(gzipFile),
      hashGunzip(gzipFile),
    ]);
    if (rawSha !== expected.sha256
        || verifiedRaw !== expected.sha256
        || gzipSha !== expected.gzip_sha256) {
      throw new Error(`refusing to remove unverified WAL segment: ${file}`);
    }
    await fsp.unlink(file);
    removed += 1;
    removedBytes += stat.size;
  }
  return {
    receipt: receiptFile,
    receipt_cutoff: new Date(receiptCutoffMs).toISOString(),
    removed_segments: removed,
    removed_bytes: removedBytes,
    skipped_segments: skipped,
  };
}

async function main() {
  const root = path.resolve(arg('--root', DEFAULT_ROOT));
  const wantsPrepare = process.argv.includes('--prepare');
  const wantsFinalize = process.argv.includes('--finalize');
  if (wantsPrepare === wantsFinalize) {
    throw new Error('choose exactly one of --prepare or --finalize');
  }
  const result = wantsPrepare
    ? await prepare(root, {
      recoverOpen: process.argv.includes('--recover-open'),
      openRecoveryConfirm: process.env.DELTAFORGE_WAL_OPEN_RECOVERY_CONFIRM,
    })
    : await finalize(root, path.resolve(arg('--receipt', DEFAULT_RECEIPT)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  compressVerified,
  finalize,
  inspectSegment,
  prepare,
  readReceipt,
  recoverOrphanOpenSegments,
};
