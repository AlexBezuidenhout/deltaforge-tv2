'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const parquet = require('@dsnp/parquetjs');
const { writeArchiveBatch } = require('../borg/shadow/archive');
const { convertFile } = require('../scripts/parquet-mirror');

test('immutable parquet mirror preserves row count and refuses source collisions', async (t) => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-parquet-source-'));
  const mirror = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-parquet-mirror-'));
  t.after(() => {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(mirror, { recursive: true, force: true });
  });
  const saved = await writeArchiveBatch('borg_clob_events', [
    { id: '1', ts: '2026-07-15T12:00:00.000Z', price: 0.5, raw: { event: 'book' } },
    { id: '2', ts: '2026-07-15T12:00:00.100Z', price: 0.51, raw: { event: 'price_change' } },
  ], new Date('2026-07-15T13:00:00.000Z'), { archiveDir: source, minFreeGb: 0 });
  const first = await convertFile(saved.file, source, mirror);
  assert.equal(first.status, 'created');
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
