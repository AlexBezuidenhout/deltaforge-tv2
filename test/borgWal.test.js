'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');
const RawWal = require('../borg/recon/wal');

function filesBelow(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...filesBelow(full));
    else out.push(full);
  }
  return out;
}

test('raw WAL records provenance before processing and seals verified gzip segments', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-wal-'));
  const mirror = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-wal-mirror-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(mirror, { recursive: true, force: true });
  });

  const wal = new RawWal('binance-test', {
    root,
    mirrorRoot: mirror,
    collectionEpochId: 'test-epoch-v1',
    collectorRunId: 'test-run-1',
    minFreeGb: 0,
    syncEveryMs: 0,
    rotateBytes: 1024 * 1024,
  });
  const provenance = wal.append(Buffer.from('{"p":"123.45"}'), {
    channel: 'btcusdt@aggTrade',
    sourceMs: 1770000000123,
    receiveWallMs: 1770000000129,
    receiveMonoNs: '123456789',
    connectionEpoch: 7,
  });
  const health = wal.health(1770000001129);
  assert.equal(health.source, 'binance-test');
  assert.equal(health.collectionEpochId, 'test-epoch-v1');
  assert.equal(health.collectorRunId, 'test-run-1');
  assert.equal(health.records, 1);
  assert.equal(health.lastAppendAt, '2026-02-02T02:40:00.129Z');
  assert.equal(health.mirrorConfigured, true);
  assert.ok(health.freeGb >= 0);
  await wal.close();
  await wal.close();

  assert.equal(provenance.source_timestamp_ms, 1770000000123);
  assert.equal(provenance.connection_epoch, 7);
  assert.equal(provenance.collection_epoch_id, 'test-epoch-v1');
  assert.equal(provenance.collector_run_id, 'test-run-1');
  const packed = filesBelow(root).filter((file) => file.endsWith('.ndjson.gz'));
  assert.equal(packed.length, 1);
  const lines = zlib.gunzipSync(fs.readFileSync(packed[0])).toString('utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines[0]._borg_wal.format, 'borg-event-wal-v2');
  assert.equal(lines[0]._borg_wal.collection_epoch_id, 'test-epoch-v1');
  assert.deepEqual(lines[1], provenance);
  assert.equal(lines[1].raw, '{"p":"123.45"}');

  const mirrored = filesBelow(mirror).filter((file) => file.endsWith('.ndjson.gz'));
  assert.equal(mirrored.length, 1);
  assert.deepEqual(fs.readFileSync(mirrored[0]), fs.readFileSync(packed[0]));
  assert.throws(() => wal.append('{}'), /closed/);
});

test('raw WAL rotates without dropping the triggering record', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-wal-rotate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wal = new RawWal('clob-test', {
    root,
    minFreeGb: 0,
    rotateBytes: 450,
    rotateMs: 60_000,
  });
  for (let i = 0; i < 5; i++) wal.append(JSON.stringify({ i, pad: 'x'.repeat(90) }));
  await wal.close();
  const packed = filesBelow(root).filter((file) => file.endsWith('.ndjson.gz'));
  assert.ok(packed.length > 1);
  const records = packed.flatMap((file) => zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')
    .trim().split('\n').slice(1).map(JSON.parse));
  assert.deepEqual(records.map((row) => JSON.parse(row.raw).i), [0, 1, 2, 3, 4]);
});
