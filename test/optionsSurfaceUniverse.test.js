'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildArchiveTargets, expiryAnchors, selectSurfaceInstruments, strikeAnchors,
} = require('../borg/options/surface-universe');

function instrument(expirationMs, strike, optionType = 'call', currency = 'BTC') {
  return {
    instrument_name: `${currency}-${expirationMs}-${strike}-${optionType[0].toUpperCase()}`,
    base_currency: currency,
    expiration_timestamp: expirationMs,
    strike,
    option_type: optionType,
  };
}

test('expiry anchors bracket the target and retain two tenors when extrapolating', () => {
  assert.deepEqual(expiryAnchors([100, 200, 300], 250), [200, 300]);
  assert.deepEqual(expiryAnchors([100, 200, 300], 50), [100, 200]);
  assert.deepEqual(expiryAnchors([100, 200, 300], 350), [200, 300]);
});

test('strike anchors retain executable interpolation neighbours on both sides', () => {
  const rows = [80, 90, 100, 110, 120].map((strike) => ({ strike, instrumentName: String(strike) }));
  assert.deepEqual(strikeAnchors(rows, 105, 2).map((row) => row.strike), [90, 100, 110, 120]);
});

test('surface universe selects calls around both expiry and strike without put duplication', () => {
  const now = 1_000_000;
  const expiries = [now + 10_000, now + 20_000, now + 30_000];
  const raw = expiries.flatMap((expiry) => [80, 90, 100, 110, 120]
    .flatMap((strike) => [instrument(expiry, strike), instrument(expiry, strike, 'put')]));
  const result = selectSurfaceInstruments(raw, [{
    id: 7, asset: 'btc', strike: 105, windowEndMs: now + 15_000,
  }], { nowMs: now, maxInstruments: 20, strikesPerSide: 2 });
  assert.equal(result.instruments.length, 8);
  assert.ok(result.instruments.every((row) => row.optionType === 'call'));
  assert.deepEqual([...new Set(result.instruments.map((row) => row.expirationMs))], expiries.slice(0, 2));
  assert.equal(result.coverage[0].retained, true);
});

test('archive anchors keep ATM one-day and seven-day surfaces without a Polymarket target', () => {
  const now = 1_000_000;
  const rows = buildArchiveTargets(new Map([['BTC', '65000'], ['ETH', '3200']]), ['BTC', 'ETH'], {
    nowMs: now, horizonsHours: [24, 168],
  });
  assert.deepEqual(rows.map((row) => [row.id, row.strike, row.targetExpiryMs]), [
    ['archive:BTC:24h', 65000, now + 24 * 3_600_000],
    ['archive:BTC:168h', 65000, now + 168 * 3_600_000],
    ['archive:ETH:24h', 3200, now + 24 * 3_600_000],
    ['archive:ETH:168h', 3200, now + 168 * 3_600_000],
  ]);
  assert.ok(rows.every((row) => row.archiveOnly));
});
