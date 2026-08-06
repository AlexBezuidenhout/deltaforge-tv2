'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildResearchEventsUrl,
  resolverRtdsSource,
  usesChainlinkResolver,
} = require('../borg/recon/markets');

test('Gamma research discovery uses its validated order name and frozen seven-day horizon', () => {
  const now = Date.UTC(2026, 6, 16, 21, 0, 0);
  const url = buildResearchEventsUrl(now);

  assert.equal(url.pathname, '/events');
  assert.equal(url.searchParams.get('order'), 'endDate');
  assert.equal(url.searchParams.get('end_date_min'), '2026-07-16T19:00:00.000Z');
  assert.equal(url.searchParams.get('end_date_max'), '2026-07-23T21:00:00.000Z');
});

test('resolver typing includes documented 5m and explicit 15m Chainlink markets', () => {
  assert.equal(usesChainlinkResolver({
    market_type: 'direction_5m',
    resolution_source: 'polymarket_crypto_5m',
  }), true);
  assert.equal(usesChainlinkResolver({
    market_type: 'direction_15m',
    resolution_source: 'chainlink_rtds_15m',
  }), true);
  assert.equal(usesChainlinkResolver({
    market_type: 'direction_1h',
    resolution_source: 'binance_1h_candle',
  }), false);
});

test('resolver feed identity fails closed for TWAP contracts', () => {
  assert.equal(resolverRtdsSource({
    market_type: 'direction_5m', resolution_source: 'chainlink_twap_30s',
  }), null);
  assert.equal(resolverRtdsSource({
    market_type: 'direction_15m', resolution_source: 'chainlink_twap_60s',
  }), null);
  assert.equal(resolverRtdsSource({
    market_type: 'direction_5m', resolution_source: 'polymarket_crypto_5m',
  }), 'chainlink');
});
