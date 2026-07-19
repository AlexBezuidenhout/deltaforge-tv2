'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  feedSymbolForMarket, isSupportedMarketSymbol, parseFrame,
} = require('../borg/pyth/rtds');
const {
  checkpointCrossings, executableMarkout, resolverSide, sizePaperEntry,
} = require('../borg/pyth/strategy');
const { normalizeCandidate } = require('../borg/pyth/universe');
const fs = require('node:fs');
const path = require('node:path');

function candidateFixture(overrides = {}) {
  const event = {
    id: 'event-1', slug: 'wti-up-or-down-on-july-20-2026', active: true, closed: false,
    title: 'WTI Up or Down on July 20?',
    description: 'This market resolves using the Pyth WTI price feed and the specified close candle.',
    startDate: '2026-07-20T13:30:00Z', endDate: '2026-07-20T21:00:00Z',
    markets: [{
      id: 'market-1', conditionId: 'condition-1', slug: 'wti-up-or-down-on-july-20-2026',
      question: 'WTI Up or Down on July 20?', outcomes: '["Up","Down"]',
      clobTokenIds: '["up-token","down-token"]', orderMinSize: '5',
      feesEnabled: false, acceptingOrders: true, active: true, closed: false,
    }],
    ...overrides,
  };
  const endpoint = {
    slug: 'wti-up-or-down-on-july-20-2026', symbol: 'WTI', priceToBeat: 112.57042,
    timestamp: 1775509140000, eventStartTime: '2026-07-20T13:30:00Z',
    endDate: '2026-07-20T21:00:00Z',
  };
  return { event, endpoint };
}

test('RTDS parser preserves source/provider/local clocks and carried-forward flag', () => {
  const [row] = parseFrame(JSON.stringify({
    topic: 'equity_prices', type: 'update', data: {
      symbol: 'wti', value: 112.57, full_accuracy_value: '112.57042000',
      timestamp: 1775509140000, received_at: 1775509140040, is_carried_forward: true,
    },
  }), { receiveWallMs: 1775509140060, receiveMonoNs: '123', connectionEpoch: 2, eventSequence: 9 });
  assert.equal(row.symbol, 'WTI');
  assert.equal(row.value, 112.57042);
  assert.equal(row.sourceMs, 1775509140000);
  assert.equal(row.providerReceivedMs, 1775509140040);
  assert.equal(row.receiveWallMs, 1775509140060);
  assert.equal(row.carriedForward, true);
  assert.equal(row.historical, false);
});

test('RTDS snapshot rows are marked historical and cannot be confused with live ticks', () => {
  const rows = parseFrame(JSON.stringify({
    topic: 'equity_prices', type: 'snapshot', data: [
      { symbol: 'WTI', value: 110, timestamp: 1000 },
      { symbol: 'WTI', value: 111, timestamp: 2000 },
    ],
  }));
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.historical));
});

test('RTDS official subscribe snapshot inherits its parent symbol', () => {
  const rows = parseFrame(JSON.stringify({
    topic: 'equity_prices', type: 'subscribe', payload: {
      symbol: 'aapl', data: [{ timestamp: 1000, value: 200.5 }],
    },
  }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, 'AAPL');
  assert.equal(rows[0].historical, true);
});

test('Pyth market aliases use only supported official equity-price symbols', () => {
  assert.equal(feedSymbolForMarket('NG'), 'NGD');
  assert.equal(isSupportedMarketSymbol('NG'), true);
  assert.equal(isSupportedMarketSymbol('USDMXN'), false);
  const [row] = parseFrame(JSON.stringify({
    topic: 'equity_prices', type: 'update', payload: {
      symbol: 'NGD', value: 3.1, timestamp: 1000,
    },
  }));
  assert.equal(row.symbol, 'NG');
});

test('Pyth universe accepts only exact, endpoint-bound, Pyth-settled Up/Down rules', () => {
  const { event, endpoint } = candidateFixture();
  const row = normalizeCandidate(event, endpoint);
  assert.equal(row.certified, true);
  assert.equal(row.symbol, 'WTI');
  assert.equal(row.boundary, 112.57042);
  assert.match(row.ruleHash, /^[a-f0-9]{64}$/);

  const binance = structuredClone(event);
  binance.description = 'This market resolves using Binance prices.';
  const rejected = normalizeCandidate(binance, endpoint);
  assert.equal(rejected.certified, false);
  assert.ok(rejected.failures.includes('NOT_EXPLICITLY_PYTH_RESOLVED'));
});

test('paper entry walks displayed ask depth and includes fees within budget', () => {
  const entry = sizePaperEntry({
    asks: [[0.4, 10], [0.42, 20]], budgetUsd: 10, minimumOrderSize: 5,
    feeRate: 0.07, feeExponent: 1,
  });
  assert.equal(entry.executable, true);
  assert.ok(entry.shares > 20);
  assert.ok(entry.total <= 10 + 1e-8);
  assert.ok(entry.fee > 0);
  assert.ok(entry.vwap > 0.4);
});

test('paper markout requires complete bid depth and charges an exit fee', () => {
  const scored = executableMarkout({
    bids: [[0.45, 30]], shares: 20, entryTotal: 8.5, feeRate: 0.07, feeExponent: 1,
  });
  assert.equal(scored.scored, true);
  assert.ok(scored.exitFee > 0);
  assert.equal(scored.pnl, scored.netProceeds - 8.5);
  const unscored = executableMarkout({
    bids: [[0.45, 2]], shares: 20, entryTotal: 8.5, feeRate: 0.07, feeExponent: 1,
  });
  assert.equal(unscored.reason, 'INSUFFICIENT_BID_DEPTH');
});

test('checkpoints fire only when crossed live and resolver side is deterministic', () => {
  assert.deepEqual(checkpointCrossings(null, 20, [300, 120, 60, 30, 10]), []);
  assert.deepEqual(checkpointCrossings(61, 29, [300, 120, 60, 30, 10]), [60, 30]);
  assert.deepEqual(checkpointCrossings(29, 31, [30]), []);
  assert.equal(resolverSide(112.6, 112.57), 'UP');
  assert.equal(resolverSide(112.5, 112.57), 'DOWN');
  assert.equal(resolverSide(112.57, 112.57), 'TIE');
});

test('resolver observer has no wallet or order-submission dependency', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'borg', 'pyth', 'collector.js'), 'utf8');
  assert.doesNotMatch(source, /createAndPostOrder|ClobClient|privateKey|new\s+Wallet|submitOrder|process\.env\.(PRIVATE|POLYMARKET)/i,
    'paper-only observer must not import or reference a wallet/order path');
});
