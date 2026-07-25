'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { archiveTable, safeArchiveCutoff } = require('../borg/shadow/archive');

test('scheduled archive bounds each table without deleting unarchived backlog', async (t) => {
  const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-bounded-archive-'));
  t.after(() => fs.rmSync(archiveDir, { recursive: true, force: true }));
  let source = Array.from({ length: 5 }, (_, index) => ({
    id: String(index + 1),
    ts: new Date(`2026-07-16T00:00:0${index}.000Z`),
    price: 0.50 + index / 100,
  }));
  const pool = {
    async query(sql, params) {
      if (sql.startsWith('SELECT t.*')) return { rows: source.slice(0, params[1]) };
      if (sql.startsWith('DELETE FROM')) {
        const ids = new Set(params[0].map(String));
        const before = source.length;
        source = source.filter((row) => !ids.has(String(row.id)));
        return { rowCount: before - source.length };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };

  const result = await archiveTable(
    pool,
    'borg_taker_trades',
    new Date('2026-07-16T01:00:00.000Z'),
    { archiveDir, minFreeGb: 0, batchSize: 2, maxBatches: 2 },
  );
  assert.equal(result.rows, 4);
  assert.equal(result.files, 2);
  assert.equal(result.batch_limit_reached, true);
  assert.deepEqual(source.map((row) => row.id), ['5']);
});

test('flow archive leaves trigger trades referenced by retained signals', async () => {
  let selectSql = '';
  const pool = {
    async query(sql) {
      selectSql = sql;
      return { rows: [] };
    },
  };

  const result = await archiveTable(
    pool,
    'pm_flow_trades',
    new Date('2026-07-16T01:00:00.000Z'),
    { minFreeGb: 0, batchSize: 2, maxBatches: 1 },
  );

  assert.equal(result.rows, 0);
  assert.match(selectSql, /NOT EXISTS \(SELECT 1 FROM pm_flow_signals/);
  assert.match(selectSql, /s\.trigger_trade_id=t\.id/);
});

test('bigint tape archives in indexed append order while retaining the timestamp cutoff', async () => {
  let selectSql = '';
  const pool = {
    async query(sql) {
      selectSql = sql;
      return { rows: [] };
    },
  };

  await archiveTable(
    pool,
    'borg_taker_trades',
    new Date('2026-07-16T01:00:00.000Z'),
    { minFreeGb: 0, batchSize: 5000, maxBatches: 1 },
  );

  assert.match(selectSql, /WHERE t\.ts < \$1/);
  assert.match(selectSql, /ORDER BY t\.id LIMIT \$2/);
  assert.doesNotMatch(selectSql, /ORDER BY t\.ts/);
});

test('archive cutoff never deletes tape needed by the oldest unscored order', async () => {
  const pool = {
    query: async () => ({ rows: [{
      db_now: '2026-07-20T12:00:00.000Z',
      oldest: '2026-07-19T18:00:00.000Z',
    }] }),
  };
  const safety = await safeArchiveCutoff(pool, { hotRetentionHours: 6 });
  // Six-hour retention would permit 06:00, but the unscored order needs an
  // extra hour of pre-order tape, so 17:00 is the less aggressive cutoff.
  assert.equal(safety.rollingCutoff.toISOString(), '2026-07-20T06:00:00.000Z');
  assert.equal(safety.unscoredCutoff.toISOString(), '2026-07-19T17:00:00.000Z');
  assert.equal(safety.cutoff.toISOString(), '2026-07-19T17:00:00.000Z');
});
