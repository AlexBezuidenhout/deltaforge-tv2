'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  classifyExecutionState,
  simulateWalArrivalTouch,
} = require('../borg/research/arrival-state');
const { summarize } = require('../scripts/wal-execution-replay');

const order = {
  price: 0.55,
  size: 10,
  features: { decision_delay_ms: '25' },
};
const arrival = new Date('2026-08-04T12:00:01.250Z');
const tape = {
  ts: '2026-08-04T12:00:01.100Z',
  source_ts: '2026-08-04T12:00:01.090Z',
  best_ask: '0.54',
  ask_size: '8',
  receive_monotonic_ns: '123456789',
  connection_epoch: 4,
  connection_shard: 2,
  event_sequence: '99',
  wal_event_id: 'wal-99',
  connection_gap: false,
};

test('WAL arrival replay fills only displayed size from causal A-grade state', () => {
  const result = simulateWalArrivalTouch({ order, tape, arrival, latencyMs: 1250 });
  assert.equal(result.filled, true);
  assert.equal(result.fillPrice, 0.54);
  assert.equal(result.fillSize, 8);
  assert.equal(result.detail.partial, true);
  assert.equal(result.detail.data_quality_grade, 'A');
  assert.equal(result.executionState, 'ELIGIBLE_FILL');
  assert.equal(result.detail.wal_event_id, 'wal-99');
});

test('missing tape and missing provenance are not reported as genuine non-fills', () => {
  const missing = simulateWalArrivalTouch({ order, tape: null, arrival, latencyMs: 1250 });
  assert.equal(missing.executionState, 'UNSCOREABLE_TAPE');
  const noWal = simulateWalArrivalTouch({
    order, tape: { ...tape, wal_event_id: null }, arrival, latencyMs: 1250,
  });
  assert.equal(noWal.filled, false);
  assert.equal(noWal.executionState, 'UNSCOREABLE_PROVENANCE');
  assert.equal(noWal.detail.data_quality_grade, 'F');
});

test('valid quote rejection is a proved non-fill', () => {
  const result = simulateWalArrivalTouch({
    order, tape: { ...tape, best_ask: '0.60' }, arrival, latencyMs: 1250,
  });
  assert.equal(result.filled, false);
  assert.equal(result.executionState, 'PROVEN_NONFILL');
  assert.equal(classifyExecutionState(result), 'PROVEN_NONFILL');
});

test('replay report separates missing evidence from non-fills and excludes its PnL', () => {
  const report = summarize([
    { latencyMs: 250, executionState: 'ELIGIBLE_FILL', dataQualityGrade: 'A', executionFidelityGrade: 'A', pnl1x: 1, pnl2x: 0.8 },
    { latencyMs: 250, executionState: 'PROVEN_NONFILL', dataQualityGrade: 'B', executionFidelityGrade: 'B', pnl1x: 0, pnl2x: 0 },
    { latencyMs: 250, executionState: 'UNSCOREABLE_TAPE', dataQualityGrade: 'F', executionFidelityGrade: 'F', pnl1x: 100, pnl2x: 100 },
  ])[0];
  assert.equal(report.intents, 3);
  assert.equal(report.eligibleFills, 1);
  assert.equal(report.provenNonfills, 1);
  assert.equal(report.unscoreable, 1);
  assert.equal(report.pnl1x, 1);
});
