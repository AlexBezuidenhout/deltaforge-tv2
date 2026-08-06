'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ExactCloseSources, normalizeOfficialClose, normalizePythClose,
} = require('../borg/equity-options/exact-close-sources');

const expected = { symbol: 'SPY', tradeDate: '2026-08-06',
  pythFeedSymbol: 'Equity.US.SPY/USD' };

test('exact close adapters reject mislabeled proxy prices', () => {
  const pyth = normalizePythClose({ symbol: 'SPY', trade_date: '2026-08-06',
    source_kind: 'PYTH_RTDS_LAST_TICK_CONTROL', pyth_feed_symbol: expected.pythFeedSymbol,
    close: 700, source_ts: '2026-08-06T20:00:00Z', evidence_id: 'p' }, expected);
  assert.equal(pyth.valid, false);
  const official = normalizeOfficialClose({ symbol: 'SPY', trade_date: '2026-08-06',
    source: 'IBKR_CONSOLIDATED_LAST_CONTROL', close: 700,
    source_ts: '2026-08-06T20:00:00Z', evidence_id: 'o' }, expected);
  assert.equal(official.valid, false);
});

test('exact close client accepts only matching source/date/symbol evidence', async () => {
  const bodies = [
    { symbol: 'SPY', trade_date: '2026-08-06',
      source_kind: 'PYTH_FINAL_REGULAR_SESSION_1M_CANDLE_CLOSE',
      pyth_feed_symbol: expected.pythFeedSymbol, close: '700.10',
      source_ts: '2026-08-06T20:00:00Z', evidence_id: 'pyth-proof' },
    { symbol: 'SPY', trade_date: '2026-08-06', source: 'OFFICIAL_PRIMARY_LISTING_CLOSE',
      close: '700.00', source_ts: '2026-08-06T20:00:00Z', evidence_id: 'sip-proof' },
  ];
  const client = new ExactCloseSources({
    pythTemplate: 'https://source.test/pyth/{symbol}/{date}',
    officialTemplate: 'https://source.test/official/{symbol}/{date}',
    fetchImpl: async () => ({ ok: true, status: 200,
      text: async () => JSON.stringify(bodies.shift()) }),
  });
  const pair = await client.dailyPair(expected);
  assert.equal(pair.ready, true);
  assert.equal(pair.pyth.close, 700.1);
  assert.equal(pair.official.close, 700);
});
