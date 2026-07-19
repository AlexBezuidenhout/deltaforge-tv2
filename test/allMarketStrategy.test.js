'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  advanceQueue,
  costConfirmedTaker,
  createQueueState,
  dataQuality,
  evaluateL2Predictor,
  makerQuote,
  markoutPnl,
  microstructure,
  walkAsk,
  walkBid,
} = require('../borg/allmarket/strategy');
const {
  inferCategory,
  normalizeMarket,
  selectRealtimePanel,
} = require('../borg/allmarket/universe');

const book = {
  bids: [[0.49, 90], [0.48, 100]],
  asks: [[0.51, 10], [0.52, 100]],
};

test('microprice uses opposite queue weights on the token 0-1 scale', () => {
  const view = microstructure(book);
  assert.equal(view.midpoint, 0.5);
  assert.equal(+view.microprice.toFixed(4), 0.508);
  assert.equal(+view.imbalance.toFixed(2), 0.8);
});

test('L2 predictor is causal and mechanism-thresholded', () => {
  const signal = evaluateL2Predictor(book, { tickSize: 0.01 });
  assert.equal(signal.qualified, true);
  assert.equal(signal.direction, 'UP');
  assert.equal(evaluateL2Predictor({ bids: [[0.49, 50]], asks: [[0.51, 50]] }).reason, 'WEAK_IMBALANCE');
});

test('cost-confirmed taker rejects an imbalance whose predicted move cannot cover costs', () => {
  const predictor = evaluateL2Predictor(book, { tickSize: 0.01 });
  const result = costConfirmedTaker({ predictor, arrivalBook: book, feeRate: 0.07, tickSize: 0.01 });
  assert.equal(result.qualified, false);
  assert.equal(result.reason, 'COST_HURDLE');
  assert.ok(result.hurdle > result.predictedMove);
});

test('maker quote remains post-only and pessimistically joins a queue', () => {
  const quote = makerQuote({ book, requestedShares: 20, minimumQualifyingSize: 20, tickSize: 0.01 });
  assert.equal(quote.qualified, true);
  assert.equal(quote.price, 0.5);
  assert.equal(quote.improved, true);
  assert.equal(quote.queueAhead, 20);
  assert.ok(quote.price < book.asks[0][0]);
});

test('maker queue advances only on prints and requires volume through our own size', () => {
  const state = createQueueState({ qualified: true, price: 0.49, size: 10, queueAhead: 20 }, 1000);
  advanceQueue(state, [[1001, 0.50, 100], [1002, 0.49, 19], [1003, 0.49, 10]]);
  assert.equal(state.filled, false);
  advanceQueue(state, [[1004, 0.48, 1]]);
  assert.equal(state.filled, true);
  assert.equal(state.fillAtMs, 1004);
});

test('maker queue records conservative partial fills', () => {
  const state = createQueueState({ qualified: true, price: 0.49, size: 5, queueAhead: 20 }, 1000);
  advanceQueue(state, [[1001, 0.49, 22]]);
  assert.equal(state.filled, false);
  assert.equal(state.filledShares, 2);
});

test('full-depth executable markout refuses unsupported size', () => {
  const exitBook = { bids: [[0.52, 5], [0.51, 5]] };
  assert.equal(walkBid(exitBook, 11), null);
  assert.equal(+walkBid(exitBook, 10).toFixed(3), 0.515);
  assert.equal(+walkAsk({ asks: [[0.51, 5], [0.52, 5]] }, 10).toFixed(3), 0.515);
  const pnl = markoutPnl({ entryPrice: 0.50, exitPrice: 0.515, shares: 10, entryKind: 'maker', feeRate: 0.04 });
  assert.ok(pnl < 0.15 && pnl > 0);
});

test('data-quality grades make stale and connection-gap events ineligible', () => {
  assert.equal(dataQuality({ stateAgeMs: 20 }), 'A');
  assert.equal(dataQuality({ stateAgeMs: 600 }), 'B');
  assert.equal(dataQuality({ stateAgeMs: 2500 }), 'F');
  assert.equal(dataQuality({ stateAgeMs: 20, connectionGap: true }), 'F');
});

test('market normalization parses DECIMAL strings and category metadata', () => {
  const market = normalizeMarket({
    id: '1', conditionId: '0xabc', question: 'Will BTC be above $100k?',
    outcomes: '["Yes","No"]', clobTokenIds: '["yes","no"]',
    outcomePrices: '["0.40","0.60"]', liquidity: '123.45', volume24hr: '999.5',
    active: true, closed: false, acceptingOrders: true,
    orderPriceMinTickSize: '0.01', orderMinSize: '5', feesEnabled: true,
    feeSchedule: { rate: '0.07', rebateRate: '0.20' },
  }, { total_daily_rate: '12', rewards_min_size: '20', rewards_max_spread: '4.5' });
  assert.equal(market.category, 'crypto');
  assert.equal(market.prices[0], 0.4);
  assert.equal(market.feeRate, 0.07);
  assert.equal(market.feeExponent, 1);
  assert.equal(market.rewardsMinSize, 20);
  assert.equal(inferCategory({ feeType: 'sports_fees_v2' }), 'sports');
  assert.equal(normalizeMarket({
    conditionId: '0xfee', outcomes: '["Yes","No"]', clobTokenIds: '["a","b"]',
    active: true, closed: false, acceptingOrders: true, feesEnabled: true,
  }).feeRate, 0.07);
});

test('panel selection is category-balanced, capital-bounded and catalyst-guarded', () => {
  const now = Date.parse('2026-07-16T12:00:00Z');
  const base = {
    active: true, closed: false, acceptingOrders: true, outcomes: ['Yes', 'No'],
    tokenIds: ['a', 'b'], prices: [0.5, 0.5], orderMinSize: 5,
    rewardsMinSize: 20, rewardsDailyRate: 10, volume24h: 1000,
    endDate: '2026-07-20T00:00:00Z',
  };
  const rows = [
    { ...base, conditionId: 'sports1', category: 'sports' },
    { ...base, conditionId: 'sports2', category: 'sports', rewardsDailyRate: 100 },
    { ...base, conditionId: 'crypto1', category: 'crypto' },
    { ...base, conditionId: 'soon', category: 'other', endDate: '2026-07-16T13:00:00Z' },
    { ...base, conditionId: 'too_big', category: 'other', rewardsMinSize: 200 },
  ];
  const panel = selectRealtimePanel(rows, { nowMs: now, maxMarkets: 2, maxCapitalPerMarket: 50, catalystGuardHours: 6 });
  assert.deepEqual(new Set(panel.map((row) => row.category)), new Set(['crypto', 'sports']));
  assert.equal(panel.some((row) => row.conditionId === 'soon'), false);
  assert.equal(panel.some((row) => row.conditionId === 'too_big'), false);
});

test('all-market collector has no wallet, signer, authenticated order, or live submission dependency', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'borg', 'allmarket', 'collector.js'), 'utf8');
  assert.doesNotMatch(source, /createAndPostOrder|createOrder|postOrder|ClobClient|PRIVATE_KEY|ethers/);
  assert.match(source, /paperOnly: true/);
  assert.match(source, /walletLoaded: false/);
  assert.match(source, /persistDerivedEvents: false/);
});
