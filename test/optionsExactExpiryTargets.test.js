'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  selectExactExpiryThresholds, selectSurfaceBracketedThresholds,
} = require('../borg/options/target-universe');
const {
  fetchThresholdEvents, listedCallExpiries, resolverFeed,
  syncPolymarketSubscriptions,
} = require('../borg/options/collector');

function event(expiry) {
  return {
    id: 'event-1',
    slug: 'bitcoin-above-on-expiry',
    title: 'Bitcoin above ___ on July 24, 4AM ET?',
    endDate: new Date(expiry).toISOString(),
    description: 'This market resolves from the Close price for the BTC/USDT 1 hour candle on Binance.',
    markets: [{
      id: 'market-1',
      slug: 'bitcoin-above-65000-on-expiry',
      conditionId: 'condition-1',
      question: 'Bitcoin above 65,000 on July 24, 4AM ET?',
      groupItemTitle: '65,000',
      endDate: new Date(expiry).toISOString(),
      outcomes: JSON.stringify(['Yes', 'No']),
      clobTokenIds: JSON.stringify(['yes-token', 'no-token']),
      acceptingOrders: true,
      closed: false,
    }],
  };
}

function minuteCloseEvent(expiry) {
  const value = event(expiry);
  value.description = 'This market resolves from the final Close price for the BTC/USDT 1 minute candle on Binance.';
  return value;
}

function call(expiry) {
  return {
    instrument_name: 'BTC-24JUL26-65000-C',
    base_currency: 'BTC',
    expiration_timestamp: expiry,
    strike: 65000,
    option_type: 'call',
  };
}

test('exact-expiry expansion keeps every rule-certified strike only at a listed expiry', () => {
  const now = Date.UTC(2026, 6, 23, 8);
  const expiry = now + 86_400_000;
  const selected = selectExactExpiryThresholds([event(expiry)], [call(expiry)], {
    nowMs: now, minTteMs: 300_000, maxTteMs: 7 * 86_400_000,
    currencies: ['BTC', 'ETH'],
  });
  assert.equal(selected.records.length, 1);
  assert.equal(selected.records[0].resolution_source, 'binance_1h_close');
  assert.equal(selected.records[0].timeframe_sec, 3600);
  assert.equal(
    selected.records[0].raw._optionsExactExpiry.resolverCertification.valid,
    true,
  );

  const nonExact = selectExactExpiryThresholds(
    [event(expiry + 3_600_000)], [call(expiry)],
    { nowMs: now, maxTteMs: 7 * 86_400_000, currencies: ['BTC'] },
  );
  assert.equal(nonExact.records.length, 0);
  assert.equal(nonExact.rejected.NO_LISTED_EXACT_EXPIRY, 1);
});

test('target resolver feed follows the certified contract source and never substitutes', () => {
  assert.equal(resolverFeed('binance_1h_close'), 'binance');
  assert.equal(resolverFeed('chainlink_rtds_15m'), 'chainlink');
  assert.equal(resolverFeed('coinbase'), null);
  assert.equal(resolverFeed('unknown'), null);
});

test('Polymarket targets are installed before the initial socket connection', () => {
  const calls = [];
  const clob = { subscribe: (tokenIds) => calls.push(tokenIds) };
  const targets = new Map([
    ['yes-token', { id: 1 }],
    ['no-token', { id: 1 }],
  ]);
  assert.equal(syncPolymarketSubscriptions(clob, targets), 2);
  assert.deepEqual(calls, [['yes-token', 'no-token']]);
});

test('daily thresholds use bounded term interpolation but never expiry extrapolation', () => {
  const now = Date.UTC(2026, 6, 23, 8);
  const lower = now + 24 * 3_600_000;
  const upper = now + 48 * 3_600_000;
  const between = now + 36 * 3_600_000;
  const selected = selectSurfaceBracketedThresholds(
    [event(between)],
    [call(lower), { ...call(upper), instrument_name: 'BTC-UPPER-65000-C' }],
    { nowMs: now, maxTteMs: 7 * 86_400_000, currencies: ['BTC'] },
  );
  assert.equal(selected.records.length, 1);
  assert.equal(
    selected.records[0].raw._optionsSurfaceTarget.surfaceMode,
    'TERM_INTERPOLATED',
  );
  assert.equal(
    selected.records[0].raw._optionsSurfaceTarget.lowerDeribitExpiryMs,
    lower,
  );
  assert.equal(
    selected.records[0].raw._optionsSurfaceTarget.upperDeribitExpiryMs,
    upper,
  );
  assert.equal(selected.records[0].raw._optionsSurfaceTarget.extrapolationAllowed, false);

  const extrapolated = selectSurfaceBracketedThresholds(
    [event(lower - 3_600_000)],
    [call(lower), { ...call(upper), instrument_name: 'BTC-UPPER-65000-C' }],
    { nowMs: now, maxTteMs: 7 * 86_400_000, currencies: ['BTC'] },
  );
  assert.equal(extrapolated.records.length, 0);
  assert.equal(extrapolated.rejected.NO_LISTED_TERM_BRACKET, 1);
});

test('daily threshold selection preserves a certified one-minute resolver interval', () => {
  const now = Date.UTC(2026, 6, 23, 8);
  const lower = now + 24 * 3_600_000;
  const upper = now + 48 * 3_600_000;
  const expiry = now + 36 * 3_600_000;
  const selected = selectSurfaceBracketedThresholds(
    [minuteCloseEvent(expiry)],
    [call(lower), { ...call(upper), instrument_name: 'BTC-UPPER-65000-C' }],
    { nowMs: now, maxTteMs: 7 * 86_400_000, currencies: ['BTC'] },
  );
  assert.equal(selected.records.length, 1);
  assert.equal(selected.records[0].resolution_source, 'binance_1m_close');
  assert.equal(selected.records[0].timeframe_sec, 60);
  assert.equal(
    selected.records[0].window_start.getTime(),
    expiry - 60_000,
  );
  assert.equal(
    selected.records[0].raw._optionsSurfaceTarget.resolverCertification.valid,
    true,
  );
});

test('Gamma discovery queries the listed expiry directly instead of a capped broad page', async () => {
  const now = Date.UTC(2026, 6, 23, 8);
  const expiry = now + 86_400_000;
  assert.deepEqual(listedCallExpiries([call(expiry)], now), [expiry]);
  const seen = [];
  const rows = await fetchThresholdEvents([expiry], {
    fetcher: async (url) => {
      seen.push(new URL(url));
      return [event(expiry)];
    },
  });
  assert.equal(rows.length, 1);
  assert.equal(seen.length, 1);
  assert.equal(
    Date.parse(seen[0].searchParams.get('end_date_min')),
    expiry - 1000,
  );
  assert.equal(
    Date.parse(seen[0].searchParams.get('end_date_max')),
    expiry + 1000,
  );
  assert.equal(seen[0].searchParams.get('limit'), '100');
});

test('surface discovery queries every adjacent listed-expiry bracket', async () => {
  const first = Date.UTC(2026, 6, 24, 8);
  const second = Date.UTC(2026, 6, 25, 8);
  const third = Date.UTC(2026, 6, 26, 8);
  const seen = [];
  await fetchThresholdEvents([first, second, third], {
    bracketed: true,
    fetcher: async (url) => {
      seen.push(new URL(url));
      return [];
    },
  });
  assert.equal(seen.length, 2);
  assert.equal(Date.parse(seen[0].searchParams.get('end_date_min')), first - 1000);
  assert.equal(Date.parse(seen[0].searchParams.get('end_date_max')), second + 1000);
  assert.equal(Date.parse(seen[1].searchParams.get('end_date_min')), second - 1000);
  assert.equal(Date.parse(seen[1].searchParams.get('end_date_max')), third + 1000);
});
