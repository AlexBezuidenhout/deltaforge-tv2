'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  aggregateIndependentMarkets,
  summarizeTrial,
  usesDoubledCosts,
} = require('../scripts/promotion-report');

test('promotion metrics recognize named 2x clustered objectives', () => {
  assert.equal(usesDoubledCosts('net_pnl_2x'), true);
  assert.equal(usesDoubledCosts('net_pnl_2x_clustered_by_market_day'), true);
  assert.equal(usesDoubledCosts('net_pnl_1x'), false);
});

test('promotion summary clusters by market and UTC day and splits independent markets', () => {
  const rows = [
    { market_id: 1, available_at: '2026-07-18T00:00:00Z', pnl_1x: 100, pnl_2x: 1, data_quality_grade: 'A', execution_fidelity_grade: 'B', asset: 'btc' },
    { market_id: 1, available_at: '2026-07-18T00:00:01Z', pnl_1x: 100, pnl_2x: 2, data_quality_grade: 'A', execution_fidelity_grade: 'B', asset: 'btc' },
    { market_id: 2, available_at: '2026-07-19T00:00:00Z', pnl_1x: 100, pnl_2x: 3, data_quality_grade: 'B', execution_fidelity_grade: 'B', asset: 'eth' },
    { market_id: 2, available_at: '2026-07-19T00:00:01Z', pnl_1x: 100, pnl_2x: 4, data_quality_grade: 'B', execution_fidelity_grade: 'B', asset: 'eth' },
  ];
  const markets = aggregateIndependentMarkets(rows);
  assert.deepEqual(markets.map((row) => row.pnl2x), [3, 7]);

  const summary = summarizeTrial({
    experiment_id: 'test', strategy: 'test', family: 'test', variant: 'baseline',
    phase: 'eval', status: 'COLLECTING', primary_metric: 'net_pnl_2x_clustered_by_market_day',
    min_independent_markets: 300, min_days: 14,
  }, rows, [
    { market_id: 1, latency_ms: 100, pnl_2x: 1, data_quality_grade: 'A', execution_fidelity_grade: 'B' },
    { market_id: 1, latency_ms: 250, pnl_2x: 1, data_quality_grade: 'A', execution_fidelity_grade: 'B' },
    { market_id: 1, latency_ms: 500, pnl_2x: 1, data_quality_grade: 'A', execution_fidelity_grade: 'B' },
  ]);
  assert.equal(summary.pnl2x, 10);
  assert.equal(summary.marketClusters, 2);
  assert.equal(summary.dayClusters, 2);
  assert.equal(summary.firstHalfPnl2x, 3);
  assert.equal(summary.secondHalfPnl2x, 7);
  assert.equal(summary.latencyProfiles.pass, true);
});
