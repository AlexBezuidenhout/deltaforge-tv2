'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { score, summarize } = require('../scripts/options-surface-report');

test('surface report scores terminal token and hedge PnL without using claimed fair value', () => {
  const row = score({
    market_id: 1, observed_at: '2026-07-18T00:00:00Z', event_id: 'event',
    side: 'YES', outcome: 'YES', target_shares: '10', hedge_base: '-0.01',
    binance_close: '110', hedge_cost_stress_usd: '0.05',
    detail: {
      chainlink: 100,
      optimized: { fill: { gross: 4, fees: 0.1 } },
      hedge: { hedgeBase: -0.01 },
    },
  });
  assert.equal(row.tokenPnl2x, 5.9);
  assert.ok(Math.abs(row.hedgePnl + 0.1) < 1e-12);
  assert.ok(Math.abs(row.pnl2x - 5.75) < 1e-12);
});

test('surface summary keeps chronological halves and cluster counts explicit', () => {
  const rows = [1, 2, 3, 4].map((value) => ({
    pnl2x: value, won: true, hedgeScored: true,
    observed_at: `2026-07-1${value}T00:00:00Z`, eventKey: `e${value}`, dayKey: `d${value}`,
  }));
  const result = summarize(rows);
  assert.equal(result.pnl2xUsd, 10);
  assert.equal(result.firstHalfPnl2xUsd, 3);
  assert.equal(result.secondHalfPnl2xUsd, 7);
  assert.equal(result.eventClusteredMeanCi95.clusters, 4);
});
