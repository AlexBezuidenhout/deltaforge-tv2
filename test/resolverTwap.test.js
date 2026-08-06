'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { boundaryRecord, nearestTick } = require('../borg/resolver-twap/collector');
const { e18Decimal, parseTwapFrame } = require('../borg/resolver-twap/rtds');
const { SERIES, normalizeZecTwapMarket } = require('../borg/resolver-twap/universe');

test('Chainlink TWAP parser preserves exact E18 value and all three clocks', () => {
  assert.equal(e18Decimal('123456789012345678901'), '123.456789012345678901');
  const tick = parseTwapFrame({
    topic: 'crypto_prices_twap_thirty', type: 'update', timestamp: 1786000000100,
    payload: { symbol: 'zec/usd', window_s: 30,
      full_accuracy_value: '123456789012345678901', timestamp: 1786000000000 },
  }, { receiveWallMs: 1786000000120, receiveMonoNs: '99', transportPath: 1 });
  assert.equal(tick.exactValue, '123.456789012345678901');
  assert.equal(tick.sourceMs, 1786000000000);
  assert.equal(tick.publisherMs, 1786000000100);
  assert.equal(tick.receiveWallMs, 1786000000120);
  assert.equal(parseTwapFrame({ ...tick.raw, topic: 'crypto_prices' }), null);
});

test('ZEC market certification requires the exact resolver window', () => {
  const start = 1786000000 - (1786000000 % 300);
  const raw = { id: '1', conditionId: 'c', slug: `zec-updown-5m-${start}`,
    question: 'Zcash Up or Down', outcomes: '["Up","Down"]',
    clobTokenIds: '["up","down"]', active: true, closed: false,
    acceptingOrders: true, orderMinSize: '5', feesEnabled: false,
    description: 'Resolved using the Chainlink 30 second TWAP for ZEC/USD.' };
  const row = normalizeZecTwapMarket(raw, SERIES[0], start);
  assert.equal(row.certified, true);
  assert.equal(row.twapWindowSeconds, 30);
  assert.equal(normalizeZecTwapMarket({ ...raw,
    description: 'Resolved using spot ZEC/USD.' }, SERIES[0], start).certified, false);
});

test('boundary records use nearest exact-source tick and fail closed when stale', () => {
  const start = Date.parse('2026-08-06T12:00:00Z');
  const market = { id: 1, conditionId: 'c', slug: 's', windowStart: new Date(start),
    windowEnd: new Date(start + 300_000), twapWindowSeconds: 30,
    resolutionSource: 'chainlink_twap_30s' };
  const tick = { sourceMs: start + 100, receiveWallMs: start + 120,
    exactValue: '123.45', source: 'chainlink_twap_30s', windowSeconds: 30,
    publisherMs: start + 110, walEventId: 'wal', transportPath: 0 };
  const match = nearestTick([tick], start, 30, 3000);
  const valid = boundaryRecord(market, 'OPEN', match, start + 500);
  assert.equal(valid.eligible, true);
  const absent = boundaryRecord(market, 'OPEN', null, start + 500);
  assert.equal(absent.eligible, false);
  assert.equal(absent.reason, 'NO_EXACT_TWAP_WITHIN_TOLERANCE');
});
