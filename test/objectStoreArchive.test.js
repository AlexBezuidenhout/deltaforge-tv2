'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  eligibleRawFiles, latestSnapshotFiles, objectKey, receiptText,
  safeRelative, stateMatches,
} = require('../scripts/object-store-archive');

test('object-store archive includes only closed immutable raw objects before cutoff', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'df-object-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'source'));
  const closed = path.join(root, 'source', 'one.ndjson.gz');
  const manifest = path.join(root, 'source', 'one.manifest.json');
  const open = path.join(root, 'source', 'active.ndjson');
  fs.writeFileSync(closed, 'closed');
  fs.writeFileSync(manifest, '{}');
  fs.writeFileSync(open, 'open');
  const old = new Date(Date.now() - 10_000);
  fs.utimesSync(closed, old, old);
  fs.utimesSync(manifest, old, old);
  fs.utimesSync(open, old, old);
  assert.deepEqual(eligibleRawFiles(root, Date.now() - 1000), [manifest, closed].sort());
});

test('a file removed during archive enumeration is skipped instead of killing liveness', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'df-object-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const closed = path.join(root, 'rotated.ndjson.gz');
  fs.writeFileSync(closed, 'closed');
  const old = new Date(Date.now() - 10_000);
  fs.utimesSync(closed, old, old);

  const originalStat = fs.statSync;
  let intercepted = false;
  fs.statSync = function racingStat(file, ...args) {
    if (file === closed && !intercepted) {
      intercepted = true;
      fs.unlinkSync(closed);
    }
    return originalStat.call(fs, file, ...args);
  };
  try {
    assert.deepEqual(eligibleRawFiles(root, Date.now() - 1000), []);
  } finally {
    fs.statSync = originalStat;
  }
});

test('snapshot selection keeps only the newest eligible dump and its sidecars', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'df-snapshot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const old = path.join(root, 'old.dump');
  const latest = path.join(root, 'latest.dump');
  for (const file of [old, latest, `${latest}.sha256`, `${latest}.profile`]) {
    fs.writeFileSync(file, file);
  }
  fs.utimesSync(old, new Date(1000), new Date(1000));
  for (const file of [latest, `${latest}.sha256`, `${latest}.profile`]) {
    fs.utimesSync(file, new Date(2000), new Date(2000));
  }
  const selected = latestSnapshotFiles(root, 3000);
  assert.equal(selected.dump, latest);
  assert.deepEqual(new Set(selected.files), new Set([
    latest, `${latest}.sha256`, `${latest}.profile`,
  ]));
});

test('archive keys and receipts are traversal-safe and retain standard authority fields', () => {
  assert.equal(objectKey('deltaforge/dublin', 'wal', 'btc/one.ndjson.gz'),
    'deltaforge/dublin/wal/btc/one.ndjson.gz');
  assert.throws(() => objectKey('prefix', 'wal', '../secret'), /unsafe/);
  assert.throws(() => safeRelative('/safe/root', '/safe/other/file'), /outside/);
  const receipt = receiptText({
    scope: 'raw-wal-and-db-archive',
    cutoffMs: 1_800_000,
    destination: 's3://bucket/prefix',
    latest: { key: 'wal/a.gz', size: 12, sha256: 'a'.repeat(64) },
  });
  assert.match(receipt, /format=deltaforge-offhost-receipt-v1/);
  assert.match(receipt, /source_cutoff_epoch=1800/);
  assert.match(receipt, /latest_sha256=a{64}/);
});

test('local archive state is valid only for the exact immutable stat and key', () => {
  const entry = {
    verified: true, key: 'prefix/wal/a', size: 10, mtimeMs: 1000,
    sha256: 'b'.repeat(64),
  };
  assert.equal(stateMatches(entry, { size: 10, mtimeMs: 1000.9 }, 'prefix/wal/a'), true);
  assert.equal(stateMatches(entry, { size: 11, mtimeMs: 1000.9 }, 'prefix/wal/a'), false);
});
