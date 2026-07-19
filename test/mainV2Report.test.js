'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeLegacy, summarizeShadow } = require('../scripts/main-v2-report');

test('Main V2 report parses PostgreSQL DECIMAL strings before arithmetic', () => {
  const legacy = summarizeLegacy([
    { market_id: 1, pnl: '2.50', trade_size: '10.00' },
    { market_id: 2, pnl: '-1.25', trade_size: '10.00' },
  ]);
  assert.equal(legacy.netPnl, 1.25);
  assert.equal(legacy.returnOnStakedCapital, 0.0625);

  const shadow = summarizeShadow([
    {
      market_id: 1, scored_at: new Date(), available_at: new Date('2026-07-16T00:00:00Z'),
      data_quality_grade: 'A', filled: true, pnl_1x: '1.50', pnl_2x: '1.00',
    },
    {
      market_id: 2, scored_at: new Date(), available_at: new Date('2026-07-16T00:01:00Z'),
      data_quality_grade: 'A', filled: true, pnl_1x: '-0.25', pnl_2x: '-0.50',
    },
  ]);
  assert.equal(shadow.pnl1x, 1.25);
  assert.equal(shadow.pnl2x, 0.5);
  assert.equal(shadow.firstHalfPnl2x, 1);
  assert.equal(shadow.secondHalfPnl2x, -0.5);
});
