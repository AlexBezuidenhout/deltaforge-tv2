'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  groupIndependentSweeps,
  markoutPnl,
  summarizeExperiment,
} = require('../scripts/flow-evidence-report');

function row(overrides = {}) {
  return {
    score_id: 1,
    trigger_key: 'trigger-1',
    condition_id: 'market-1',
    available_at: '2026-07-18T00:00:00Z',
    arm: 'absorption_reversal_v2',
    latency_ms: 500,
    filled: true,
    entry_price: '0.50',
    fill_size: '10',
    data_quality_grade: 'A',
    markouts: {
      '1s': { pnl: { gross: 1, entryFee: 0.1, exitFee: 0.1 } },
      '2s': { pnl: { gross: 1, entryFee: 0.1, exitFee: 0.1 } },
      '5s': { pnl: { gross: 1, entryFee: 0.1, exitFee: 0.1 } },
      '10s': { pnl: { gross: 1, entryFee: 0.1, exitFee: 0.1 } },
    },
    ...overrides,
  };
}

test('flow report parses numeric strings and doubles both taker fees for stress', () => {
  const value = row();
  assert.equal(markoutPnl(value, 5, 1), 0.8);
  assert.equal(markoutPnl(value, 5, 2), 0.6);
  const [sweep] = groupIndependentSweeps([value], 5);
  assert.equal(sweep.entry_notional, 5);
});

test('no-fill signals count as independent zero-PnL sweeps, while F rows are excluded', () => {
  const rows = [
    row(),
    row({ score_id: 2, trigger_key: 'trigger-2', filled: false, entry_price: null, fill_size: null }),
    row({ score_id: 3, trigger_key: 'trigger-3', data_quality_grade: 'F' }),
  ];
  const sweeps = groupIndependentSweeps(rows, 5);
  assert.equal(sweeps.length, 2);
  assert.equal(sweeps.filter((value) => value.filled).length, 1);
  assert.equal(sweeps.reduce((sum, value) => sum + value.pnl_1x, 0), 0.8);
});

test('experiment report applies one family-wise correction across every registered cell', () => {
  const rows = [
    row(),
    row({ score_id: 2, trigger_key: 'trigger-2', condition_id: 'market-2', available_at: '2026-07-19T00:00:00Z' }),
  ];
  const report = summarizeExperiment(rows);
  assert.equal(report.familyWiseTests, 4);
  assert.equal(report.primaryCells.length, 1);
  assert.equal(report.primaryCells[0].independentSweeps, 2);
  assert.equal(report.primaryCells[0].passesFrozenRule, false);
});
