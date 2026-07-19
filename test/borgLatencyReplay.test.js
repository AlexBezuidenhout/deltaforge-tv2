'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { clustered, summarize } = require('../scripts/borg-latency-replay');

test('latency replay reports market clusters and never counts F-grade PnL', () => {
  const rows = [
    { marketId: 'm1', day: '2026-07-15', pnl1x: 1, pnl2x: 0.8, dataQualityGrade: 'A', filled: true },
    { marketId: 'm2', day: '2026-07-15', pnl1x: -0.5, pnl2x: -0.7, dataQualityGrade: 'B', filled: true },
    { marketId: 'm3', day: '2026-07-16', pnl1x: 100, pnl2x: 100, dataQualityGrade: 'F', filled: true },
  ];
  const report = summarize(rows, { name: '250ms', latencyMs: 250 });
  assert.equal(report.intended_signals, 3);
  assert.equal(report.replayable, 2);
  assert.equal(report.pnl_1x, 0.5);
  assert.equal(report.quality_grades.F, 1);
  assert.equal(report.market_clustered.clusters, 2);
  assert.equal(clustered(rows.slice(0, 2), (row) => row.marketId).mean_pnl_per_signal, 0.25);
});
