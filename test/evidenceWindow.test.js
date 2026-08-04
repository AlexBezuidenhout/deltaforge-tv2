'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildEvidenceWindowReport, normalizedRow } = require('../borg/research/evidence-window');

test('window rows parse every PostgreSQL numeric and preserve execution categories', () => {
  assert.deepEqual(normalizedRow({
    strategy: 'H43', intents: '4', replayed: '3', eligible_fills: '1',
    proven_nonfills: '1', unscoreable: '1', low_quality: '0',
    independent_markets: '1', pnl_1x: '1.25', pnl_2x: '1.10',
  }), {
    strategy: 'H43', intents: 4, replayed: 3, eligibleFills: 1,
    provenNonfills: 1, unscoreable: 1, lowQuality: 0,
    independentMarkets: 1, pnl1x: 1.25, pnl2x: 1.1,
    firstIntentAt: null, lastIntentAt: null,
  });
});

test('6h and 24h reports bind to the running epoch and immutable WAL replay', async () => {
  let calls = 0;
  const db = { query: async (sql) => {
    calls += 1;
    if (sql.includes('FROM borg_collector_runs')) return { rows: [{
      run_id: 'run', epoch_id: 'epoch', epoch_started_at: '2026-08-04T00:00:00Z',
      code_version: 'release', reason: 'test',
    }] };
    assert.match(sql, /borg-wal-arrival-v3/);
    return { rows: [] };
  } };
  const report = await buildEvidenceWindowReport(db, {
    now: '2026-08-04T12:00:00Z', horizons: [24, 6],
  });
  assert.equal(calls, 3);
  assert.deepEqual(report.windows.map((row) => row.hours), [6, 24]);
  assert.match(report.executionAuthority, /borg-wal-arrival-v3/);
  assert.equal(report.epoch.id, 'epoch');
});
