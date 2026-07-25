'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeLane } = require('../borg/research/resolver-boundary-portfolio');

test('boundary portfolio does not pass before the independent-market and day minimums', () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({
    marketKey: `m${index}`, observedAt: `2026-07-${String(1 + (index % 2)).padStart(2, '0')}T00:00:00Z`,
    dayKey: `2026-07-${String(1 + (index % 2)).padStart(2, '0')}`,
    executable: true, won: true, pnl2x: 1,
  }));
  const summary = summarizeLane(rows, { minimumMarkets: 300, minimumDays: 14 });
  assert.equal(summary.pnl2x, 20);
  assert.equal(summary.passesMechanicalRead, false);
});

test('calibration-only resolver probes cannot contribute promotion PnL', () => {
  const summary = summarizeLane([{
    marketKey: 'pyth-1', observedAt: '2026-07-21T00:00:00Z', dayKey: '2026-07-21',
    executable: true, won: true, pnl2x: 100, promotionEligible: false,
  }], { minimumMarkets: 1, minimumDays: 1 });
  assert.equal(summary.blockedObservations, 1);
  assert.equal(summary.terminalScored, 0);
  assert.equal(summary.pnl2x, 0);
  assert.equal(summary.passesMechanicalRead, false);
});
