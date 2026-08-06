const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assetFromTitle,
  numericLabel,
  rangeLabel,
  resolutionSource,
  selectResearchMarkets,
} = require('../borg/recon/research-universe');

function market(id, label, end) {
  return {
    id: String(id), slug: `market-${id}`, question: `Question ${label}`,
    groupItemTitle: label, endDate: end, conditionId: `condition-${id}`,
    outcomes: '["Yes", "No"]', clobTokenIds: `["yes-${id}", "no-${id}"]`,
    acceptingOrders: true, closed: false,
  };
}

function hourlyEvent(id, hourStart, assetTitle = 'Bitcoin') {
  const end = new Date(hourStart + 3600_000).toISOString();
  return {
    id: `hour-${id}`, slug: `hour-event-${id}`, title: `${assetTitle} Up or Down - test`, endDate: end,
    markets: [{
      ...market(`hour-${id}`, '', end),
      outcomes: '["Up", "Down"]', clobTokenIds: `["up-hour-${id}", "down-hour-${id}"]`,
    }],
  };
}

test('numeric and range labels parse token-scale strikes without BTC/token-price mixing', () => {
  assert.equal(numericLabel('$66,000'), 66000);
  assert.equal(numericLabel('1pt10'), 1.1);
  assert.deepEqual(rangeLabel('64,000-66,000'), { lower: 64000, upper: 66000 });
  assert.deepEqual(rangeLabel('<58,000'), { lower: null, upper: 58000 });
  assert.deepEqual(rangeLabel('>72,000'), { lower: 72000, upper: null });
});

test('research universe recognizes ZEC and distinguishes Chainlink TWAP from spot', () => {
  assert.equal(assetFromTitle('Zcash Up or Down - August 6'), 'zec');
  assert.equal(assetFromTitle('ZEC Up or Down - August 6'), 'zec');
  assert.equal(resolutionSource(null, {
    resolutionSource: 'https://data.chain.link/streams/zec-usd-twap-30s-streams',
  }, 'direction_5m'), 'chainlink_twap_30s');
  assert.equal(resolutionSource(null, {
    description: 'This resolves using the Chainlink TWAP of the 60 seconds before expiry.',
  }, 'direction_15m'), 'chainlink_twap_60s');
  assert.equal(resolutionSource(null, {
    resolutionSource: 'https://data.chain.link/streams/zec-usd',
  }, 'direction_15m'), 'chainlink_rtds_15m');
});

test('bounded universe selects current+next hourly and the frozen wider near-spot daily panel', () => {
  const now = Date.UTC(2026, 6, 15, 12, 30);
  const dailyEnd = new Date(now + 20 * 3600_000).toISOString();
  const events = [
    hourlyEvent('current', now - 30 * 60_000),
    hourlyEvent('next', now + 30 * 60_000),
    {
      id: 'threshold-event', slug: 'threshold-event', title: 'Bitcoin above ___ on test?',
      startDate: new Date(now - 24 * 3600_000).toISOString(), endDate: dailyEnd,
      markets: [80, 90, 100, 110, 120].map((strike, index) => market(`t${index}`, String(strike), dailyEnd)),
    },
    {
      id: 'range-event', slug: 'range-event', title: 'Bitcoin price on test?',
      startDate: new Date(now - 24 * 3600_000).toISOString(), endDate: dailyEnd,
      markets: ['<90', '90-100', '100-110', '>110'].map((label, index) => market(`r${index}`, label, dailyEnd)),
    },
  ];
  const result = selectResearchMarkets(events, { btc: 103 }, now, {
    hourlyAssets: ['btc'], dailyAssets: ['btc'], dailyAsset: 'btc',
  });
  const byType = Object.groupBy(result.selected, (row) => row.market_type);
  assert.equal(byType.direction_1h.length, 2);
  assert.deepEqual(byType.threshold_daily.map((row) => row.strike).sort((a, b) => a - b), [80, 90, 100, 110, 120]);
  assert.equal(byType.range_daily.length, 4);
  assert.ok(byType.range_daily.some((row) => row.lower_bound === 100 && row.upper_bound === 110));
  assert.deepEqual(result.meta.selectedDailyAssets, ['btc']);
  assert.equal(result.meta.universeVersion, 'daily-structural-universe-v2');
});

test('daily panel covers every configured asset with spot and fails closed without spot', () => {
  const now = Date.UTC(2026, 6, 15, 12, 30);
  const end = new Date(now + 20 * 3600_000).toISOString();
  const thresholdEvent = (id, title) => ({
    id, slug: id, title: `${title} above ___ on test?`, endDate: end,
    markets: [90, 100, 110].map((strike, index) => market(`${id}-${index}`, String(strike), end)),
  });
  const result = selectResearchMarkets([
    thresholdEvent('btc-threshold', 'Bitcoin'),
    thresholdEvent('eth-threshold', 'Ethereum'),
    thresholdEvent('sol-threshold', 'Solana'),
  ], { btc: 100, eth: 100 }, now, {
    hourlyAssets: [], dailyAssets: ['btc', 'eth', 'sol'],
  });
  assert.deepEqual([...new Set(result.selected.map((row) => row.asset))].sort(), ['btc', 'eth']);
  assert.deepEqual(result.meta.skippedMissingSpot, ['sol']);
});
