'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { archiveTable, verifyArchive, writeArchiveBatch } = require('./archive');

function sampleRows() {
  return [
    { id: '11', ts: new Date('2026-07-14T12:00:00.000Z'), price: 0.42, raw: { source: 'ws' } },
    { id: '12', ts: new Date('2026-07-14T12:00:01.000Z'), price: 0.43, raw: { source: 'rest' } },
  ];
}

test('archive batch is deterministic, gzip-verifiable, and preserves JSON values', async (t) => {
  const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), 'borg-archive-'));
  t.after(() => fs.rm(archiveDir, { recursive: true, force: true }));
  const cutoff = new Date('2026-07-14T14:00:00.000Z');
  const first = await writeArchiveBatch('borg_clob_events', sampleRows(), cutoff, { archiveDir, minFreeGb: 0 });
  const second = await writeArchiveBatch('borg_clob_events', sampleRows(), cutoff, { archiveDir, minFreeGb: 0 });
  assert.equal(first.file, second.file);
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.row_count, 2);
  await verifyArchive(first.file, { table: 'borg_clob_events', row_count: 2, sha256: first.sha256 });
});

test('archiveTable deletes only after a verified archive exists', async (t) => {
  const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), 'borg-archive-'));
  t.after(() => fs.rm(archiveDir, { recursive: true, force: true }));
  let rows = sampleRows();
  let archiveExistedAtDelete = false;
  const pool = {
    async query(sql, params) {
      if (sql.startsWith('SELECT t.*')) return { rows: rows.slice(0, params[1]) };
      if (sql.startsWith('DELETE')) {
        const files = await fs.readdir(path.join(archiveDir, 'borg_clob_events', '2026-07-14'));
        archiveExistedAtDelete = files.some((file) => file.endsWith('.ndjson.gz'));
        const ids = new Set(params[0]);
        const before = rows.length;
        rows = rows.filter((row) => !ids.has(String(row.id)));
        return { rowCount: before - rows.length };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  const result = await archiveTable(pool, 'borg_clob_events', new Date('2026-07-14T14:00:00.000Z'), {
    archiveDir,
    minFreeGb: 0,
    batchSize: 5000,
  });
  assert.equal(result.rows, 2);
  assert.equal(rows.length, 0);
  assert.equal(archiveExistedAtDelete, true);
});
