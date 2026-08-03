'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const {
  assertDiskReserve,
  batchHash,
  compactStagedBatch,
  diskFreeBytes,
  envelopeFor,
  latestVerifiedBatch,
  receiptFile,
  selectVerifiedRawObjects,
  sourceFromRelative,
  stageRawRecords,
} = require('../borg/research/parquet-lake');
const { runParquetQuery } = require('../borg/research/parquet-query');

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function segment(root, source, date, name, rows) {
  const relative = `${source}/${date}/${name}.ndjson.gz`;
  const file = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [
    { _borg_wal: { format: 'borg-event-wal-v2', source, opened_at: `${date}T10:00:00.000Z`, collection_epoch_id: 'test-epoch' } },
    ...rows,
  ].map((row) => JSON.stringify(row)).join('\n') + '\n';
  const packed = zlib.gzipSync(lines);
  fs.writeFileSync(file, packed);
  return {
    id: `wal:${relative}`,
    namespace: 'wal', relative, source, file,
    size: packed.length, mtimeMs: Date.parse(`${date}T10:10:00.000Z`), sha256: digest(packed),
  };
}

test('verified raw selection excludes unverified and already compacted objects', () => {
  const good = {
    namespace: 'wal', verified: true,
    relative: 'binance/2026-08-03/a.ndjson.gz',
    size: 100, mtimeMs: 1000, sha256: 'a'.repeat(64),
  };
  const raw = {
    format: 'deltaforge-google-drive-state-v1',
    objects: {
      good,
      unverified: { ...good, relative: 'binance/2026-08-03/b.ndjson.gz', verified: false },
      done: { ...good, relative: 'coinbase/2026-08-03/c.ndjson.gz', sha256: 'c'.repeat(64) },
    },
  };
  const lake = { sources: { done: { batchHash: 'x' } } };
  const selected = selectVerifiedRawObjects(raw, lake, { maxFiles: 10, maxBytes: 1000 });
  assert.deepEqual(selected.records.map((row) => row.id), ['good']);
});

test('envelope preserves clocks, provenance and token/native values only inside raw JSON', () => {
  const record = {
    relative: 'binance/2026-08-03/a.ndjson.gz', sha256: 'a'.repeat(64), mtimeMs: 0,
  };
  const header = { _borg_wal: { opened_at: '2026-08-03T10:00:00.000Z', collection_epoch_id: 'epoch' } };
  const row = {
    source_timestamp_ms: 1785751200123,
    receive_wall_timestamp_ms: 1785751200223,
    receive_monotonic_ns: '1234567890123456', event_sequence: 42,
    connection_epoch: 3, price: '60000.1', token_price: '0.42',
  };
  const envelope = envelopeFor(row, header, record, 1);
  assert.equal(envelope.eventDate, '2026-08-03');
  assert.equal(envelope.receiveMonotonicNs, '1234567890123456');
  assert.equal(envelope.sequenceId, '42');
  assert.equal(envelope.collectionEpochId, 'epoch');
  assert.equal(JSON.parse(envelope.eventJson).token_price, '0.42');
});

test('unsafe segment paths are rejected', () => {
  assert.equal(sourceFromRelative('binance/2026-08-03/a.ndjson.gz').source, 'binance');
  assert.throws(() => sourceFromRelative('../secrets/2026-08-03/a.ndjson.gz'));
  assert.throws(() => sourceFromRelative('bad/source/a.ndjson.gz'));
});

test('compaction refuses to consume the configured disk reserve', () => {
  const free = diskFreeBytes(os.tmpdir());
  assert.ok(free > 0);
  assert.throws(() => assertDiskReserve(os.tmpdir(), Number.MAX_SAFE_INTEGER),
    /below the .* byte reserve/);
});

test('receipt stays inside the service-owned state directory and can recover the latest checkpoint', () => {
  assert.equal(receiptFile({}, '/var/lib/deltaforge/parquet-lake'),
    '/var/lib/deltaforge/parquet-lake/receipt');
  assert.equal(latestVerifiedBatch({ batches: {
    older: { verified: true, verifiedAt: '2026-08-03T10:00:00.000Z', sourceFiles: 1 },
    failed: { verified: false, verifiedAt: '2026-08-03T12:00:00.000Z' },
    latest: { verified: true, verifiedAt: '2026-08-03T11:00:00.000Z', sourceFiles: 2 },
  } }).batchHash, 'latest');
});

test('staging uses one bounded files-from transfer before per-file SHA verification', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'df-parquet-stage-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source');
  const stageRoot = path.join(root, 'stage');
  const records = [
    segment(sourceRoot, 'binance', '2026-08-03', 'a', [{ source_timestamp_ms: 1785751200000 }]),
    segment(sourceRoot, 'coinbase', '2026-08-03', 'b', [{ source_timestamp_ms: 1785751200001 }]),
  ];
  const calls = [];
  const rclone = async (args) => {
    calls.push(args);
    assert.equal(args[0], 'copy');
    const target = args[2];
    for (const record of records) {
      const destination = path.join(target, ...record.relative.split('/'));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(record.file, destination);
    }
  };
  const staged = await stageRawRecords(records, {
    remote: 'drive', prefix: 'VPS Data', configFile: '/tmp/rclone.conf',
    rclone, stageRoot, env: {},
  });
  assert.equal(calls.length, 1);
  assert.equal(staged.length, 2);
});

test('DuckDB compactor writes queryable ZSTD Parquet with causal clock coverage', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'df-parquet-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const raw = path.join(root, 'raw');
  const hot = path.join(root, 'hot');
  const stage = path.join(root, 'stage');
  const first = segment(raw, 'binance', '2026-08-03', 'a', [{
    event_type: 'bookTicker', source_timestamp_ms: 1785751200000,
    receive_wall_timestamp_ms: 1785751200010, receive_monotonic_ns: '10',
    event_sequence: 1, connection_epoch: 1, collection_epoch_id: 'epoch', bid: '60000', ask: '60001',
  }]);
  const second = segment(raw, 'binance', '2026-08-03', 'b', [{
    event_type: 'trade', source_timestamp_ms: 1785751260000,
    receive_wall_timestamp_ms: 1785751260011, receive_monotonic_ns: '11',
    event_sequence: 2, connection_epoch: 1, collection_epoch_id: 'epoch', price: '60000.5',
  }]);
  const hash = batchHash([first, second]);
  const batch = await compactStagedBatch([first, second], { hotRoot: hot, stageRoot: stage, batchHash: hash });
  assert.equal(batch.sourceRows, 2);
  assert.equal(batch.outputs.length, 1);
  assert.equal(batch.outputs[0].compression, 'ZSTD');
  const query = await runParquetQuery('clock-audit', { root: hot, source: 'binance' });
  assert.equal(query.rows.length, 1);
  assert.equal(Number(query.rows[0].events), 2);
  assert.equal(query.rows[0].source_clock_pct, 100);
  assert.equal(query.rows[0].sequence_pct, 100);
});
