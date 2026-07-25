'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  selectExactExpiryThresholds,
} = require('../borg/options/target-universe');
const {
  fetchThresholdEvents, listedCallExpiries, resolverFeed,
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
