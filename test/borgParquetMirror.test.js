'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const parquet = require('@dsnp/parquetjs');
const { writeArchiveBatch } = require('../borg/shadow/archive');
const {
  DEFAULT_COMPRESSION, canonicalSource, compressionCodec, convertFile,
  decodeSegment, enabled, explicitFilesByRoot, fileExists,
  isCloudPlaceholderError, recordInvalidSource,
} = require('../scripts/parquet-mirror');

test('iCloud placeholder stalls are deferred without masking real errors', () => {
  assert.equal(isCloudPlaceholderError({ code: 'EDEADLK' }), true);
  assert.equal(isCloudPlaceholderError({ code: 'EAGAIN' }), true);
  assert.equal(isCloudPlaceholderError({ code: 'EIO' }), false);
});

test('Parquet derivatives use an explicit supported compression codec', () => {
  assert.equal(compressionCodec(), DEFAULT_COMPRESSION);
  assert.equal(compressionCodec('snappy'), 'SNAPPY');
  assert.throws(() => compressionCodec('uncompressed'), /unsupported/);
  assert.equal(enabled('true'), true);
  assert.equal(enabled('0'), false);
});

test('existing-only compaction can distinguish materialized derivatives', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-parquet-exists-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const existing = path.join(root, 'existing.parquet');
  fs.writeFileSync(existing, 'derivative');
  assert.equal(await fileExists(existing), true);
  assert.equal(await fileExists(path.join(root, 'missing.parquet')), false);
});

test('explicit Parquet input is deduplicated and confined to immutable roots', () => {
  const wal = path.resolve('/archive/wal');
  const rows = explicitFilesByRoot([
    '/archive/wal/binance/one.ndjson.gz',
    '/archive/wal/binance/one.ndjson.gz',
    '/archive/wal/binance/ignored.manifest.json',
  ].join('\n'), [wal]);
  assert.deepEqual(rows.get(wal), ['/archive/wal/binance/one.ndjson.gz']);
  assert.throws(
    () => explicitFilesByRoot('/outside/two.ndjson.gz\n', [wal]),
    /outside an allowed immutable root/,
  );
});

test('temporary APFS inputs retain their canonical archive identity', () => {
  const previous = process.env.BORG_PARQUET_CANONICAL_BASE;
  process.env.BORG_PARQUET_CANONICAL_BASE = '/icloud/Dublin-VPS';
  try {
    assert.equal(
      canonicalSource('/tmp/pull/wal/binance/one.ndjson.gz', '/tmp/pull/wal'),
      '/icloud/Dublin-VPS/wal/binance/one.ndjson.gz',
    );
  } finally {
    if (previous == null) delete process.env.BORG_PARQUET_CANONICAL_BASE;
    else process.env.BORG_PARQUET_CANONICAL_BASE = previous;
  }
});

test('corrupt immutable segments receive a durable audit record', async (t) => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-parquet-invalid-source-'));
  const mirror = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-parquet-invalid-mirror-'));
  t.after(() => {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(mirror, { recursive: true, force: true });
  });
  const file = path.join(source, 'truncated.ndjson.gz');
  fs.writeFileSync(file, Buffer.from('not-a-valid-gzip'));
  assert.throws(
    () => decodeSegment(fs.readFileSync(file)),
    (error) => error.code === 'BORG_INVALID_SEGMENT' && /gzip integrity failure/.test(error.message),
  );
  let failure;
  try {
    decodeSegment(fs.readFileSync(file));
  } catch (error) {
    failure = error;
  }
  const result = await recordInvalidSource(file, source, mirror, failure);
  assert.equal(result.status, 'invalid_source');
  const report = JSON.parse(fs.readFileSync(result.output, 'utf8'));
  assert.equal(report.format, 'borg-parquet-invalid-source-v1');
  assert.equal(report.source_bytes, 16);
  assert.match(report.error, /gzip integrity failure/);
});

test('immutable parquet mirror preserves row count and refuses source collisions', async (t) => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-parquet-source-'));
  const mirror = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-parquet-mirror-'));
  t.after(() => {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(mirror, { recursive: true, force: true });
  });
  const saved = await writeArchiveBatch('borg_taker_trades', [
    { id: '1', ts: '2026-07-15T12:00:00.000Z', price: 0.5, raw: { event: 'trade' } },
    { id: '2', ts: '2026-07-15T12:00:00.100Z', price: 0.51, raw: { event: 'trade' } },
  ], new Date('2026-07-15T13:00:00.000Z'), { archiveDir: source, minFreeGb: 0 });
  const first = await convertFile(saved.file, source, mirror);
  assert.equal(first.status, 'created');
  const manifest = JSON.parse(fs.readFileSync(`${first.output}.manifest.json`, 'utf8'));
  assert.equal(manifest.format, 'borg-parquet-mirror-v2');
  assert.equal(manifest.compression, DEFAULT_COMPRESSION);
  assert.ok(Object.values(manifest.schema).every(
    (definition) => definition.compression === DEFAULT_COMPRESSION,
  ));
  const reader = await parquet.ParquetReader.openFile(first.output);
  const cursor = reader.getCursor();
  const rows = [];
  let row;
  while ((row = await cursor.next())) rows.push(row);
  await reader.close();
  assert.equal(rows.length, 2);
  assert.equal(rows[1].price, 0.51);
  const second = await convertFile(saved.file, source, mirror);
  assert.equal(second.status, 'verified_existing');
});
