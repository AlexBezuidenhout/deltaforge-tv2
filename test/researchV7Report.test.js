'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MANIFEST, STRATEGIES, markdown } = require('../scripts/research-v7-report');

test('V7 report is bound to the exact ten frozen paper-only strategies', () => {
  assert.equal(MANIFEST.paper_only, true);
  assert.equal(MANIFEST.live_order_path, 'disabled');
  assert.equal(STRATEGIES.length, 10);
  assert.equal(new Set(STRATEGIES).size, 10);
  assert.ok(STRATEGIES.every((strategy) => /^H(?:5[4-9]|6[0-3])_/.test(strategy)));
});

test('V7 report labels zero activity honestly and never sums strategy PnL', () => {
  const output = markdown({
    generatedAt: '2026-07-26T02:00:00.000Z',
    since: MANIFEST.evidence_started_at,
    activeCount: 0,
    expectedActiveCount: 10,
    strategies: STRATEGIES.map((strategy) => ({
      strategy,
      active: false,
      evaluations: 0,
      intended: 0,
      fills: 0,
      eligibleMarkets: 0,
      winRate2xPct: null,
      pnl1x: 0,
      pnl2x: 0,
      firstHalfPnl2x: 0,
      secondHalfPnl2x: 0,
    })),
    interpretation: [
      'No profitability verdict is valid before the frozen requirements pass.',
      'Strategy PnL cannot be summed.',
    ],
  });
  assert.match(output, /paper only; live order path disabled/i);
  assert.match(output, /No profitability verdict/i);
  assert.match(output, /cannot be summed/i);
  assert.doesNotMatch(output, /total pnl/i);
});
