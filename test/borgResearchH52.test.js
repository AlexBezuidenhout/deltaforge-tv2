'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const makeH52 = require('../borg/shadow/research-h52');

const {
  FifteenMinNearEvenFavorite, FAIR_FAVORITE_PROBABILITY, MARKET_TYPE, feePerShare,
} = makeH52._test;

const engine = { _coid: () => 'test-coid' };
const book = (bid, ask, askSize = 100) => ({ bids: [[bid, 100]], asks: [[ask, askSize]] });

function ctxFor(overrides = {}) {
  return {
    now: Date.parse('2026-07-18T15:00:00Z'),
    market: {
      id: 11, asset: 'btc', market_type: MARKET_TYPE,
      positive_label: 'UP', negative_label: 'DOWN',
    },
    tteSec: 180,
    upBook: book(0.54, 0.55),
    downBook: book(0.45, 0.47),
    ...overrides,
  };
}

test('H52v2 buys the favorite once inside the frozen band and holds', () => {
  const strategy = new FifteenMinNearEvenFavorite();
  const actions = strategy.evaluate(ctxFor(), engine);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].token, 'UP');
  assert.equal(actions[0].side, 'BUY');
  assert.equal(actions[0].price, 0.55);
  const expectedEdge = FAIR_FAVORITE_PROBABILITY - 0.55 - feePerShare(0.55);
  assert.ok(Math.abs(actions[0].features.edge_2x_per_share - expectedEdge) < 1e-12);
  assert.equal(strategy.evaluate(ctxFor(), engine).length, 0, 'once per market');
});

test('H52v2 hard-refuses any market that is not direction_15m (v1 defect regression)', () => {
  const strategy = new FifteenMinNearEvenFavorite();
  assert.equal(strategy.evaluate(ctxFor({
    market: { id: 21, asset: 'btc', market_type: 'direction_5m', positive_label: 'UP', negative_label: 'DOWN' },
  }), engine).length, 0, '5m market must be refused even if dispatch leaks');
  assert.equal(strategy.evaluate(ctxFor({
    market: { id: 22, asset: 'btc', market_type: 'direction_1h', positive_label: 'UP', negative_label: 'DOWN' },
  }), engine).length, 0, 'true 1h market is outside the frozen v2 universe');
  assert.equal(strategy.evaluate(ctxFor({
    market: { id: 23, asset: 'btc', positive_label: 'UP', negative_label: 'DOWN' },
  }), engine).length, 0, 'missing market_type must be refused, never defaulted');
});

test('H52v2 buys DOWN when the favorite is the negative token', () => {
  const strategy = new FifteenMinNearEvenFavorite();
  const actions = strategy.evaluate(ctxFor({
    market: { id: 12, asset: 'eth', market_type: MARKET_TYPE, positive_label: 'UP', negative_label: 'DOWN' },
    upBook: book(0.40, 0.42),
    downBook: book(0.57, 0.59),
  }), engine);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].token, 'DOWN');
  assert.equal(actions[0].price, 0.59);
});

test('H52v2 skips outside the ask band, the tte window, unsupported assets and one-sided books', () => {
  const strategy = new FifteenMinNearEvenFavorite();
  const marketFor = (id, asset = 'btc') => ({
    id, asset, market_type: MARKET_TYPE, positive_label: 'UP', negative_label: 'DOWN',
  });
  assert.equal(strategy.evaluate(ctxFor({
    market: marketFor(13), upBook: book(0.63, 0.65),
  }), engine).length, 0, 'favorite ask above band');
  assert.equal(strategy.evaluate(ctxFor({
    market: marketFor(14), tteSec: 400,
  }), engine).length, 0, 'too early');
  assert.equal(strategy.evaluate(ctxFor({
    market: marketFor(15), tteSec: 30,
  }), engine).length, 0, 'too late');
  assert.equal(strategy.evaluate(ctxFor({
    market: marketFor(16, 'doge'),
  }), engine).length, 0, 'asset outside 15m set');
  assert.equal(strategy.evaluate(ctxFor({
    market: marketFor(17), downBook: { bids: [], asks: [] },
  }), engine).length, 0, 'missing opposite book');
  assert.equal(strategy.evaluate(ctxFor({
    market: marketFor(18), upBook: book(0.54, 0.55), downBook: book(0.53, 0.55),
  }), engine).length, 0, 'equal asks have no favorite');
});
