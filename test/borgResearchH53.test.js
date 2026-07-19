'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const makeH53 = require('../borg/shadow/research-h53');

const {
  DEPTH_PARTICIPATION,
  FAIR_FAVORITE_PROBABILITY,
  FiveMinuteNearEvenFavorite,
  MARKET_TYPE,
  STRATEGY,
  feePerShare,
} = makeH53._test;

const engine = { _coid: () => 'h53-test-coid' };
const book = (bid, ask, askSize = 100) => ({ bids: [[bid, 100]], asks: [[ask, askSize]] });

function ctxFor(overrides = {}) {
  return {
    now: Date.parse('2026-07-18T20:45:00Z'),
    market: {
      id: 53, asset: 'btc', market_type: MARKET_TYPE,
      positive_label: 'UP', negative_label: 'DOWN',
    },
    tteSec: 180,
    upBook: book(0.54, 0.55),
    downBook: book(0.45, 0.47),
    ...overrides,
  };
}

test('H53 preserves the accidental H52 v1 constants and exact 5m decision', () => {
  const strategy = new FiveMinuteNearEvenFavorite();
  const [action] = strategy.evaluate(ctxFor(), engine);
  assert.equal(strategy.name, STRATEGY);
  assert.equal(FAIR_FAVORITE_PROBABILITY, 0.675);
  assert.equal(action.token, 'UP');
  assert.equal(action.side, 'BUY');
  assert.equal(action.price, 0.55);
  assert.equal(action.size, 10 / 0.55);
  assert.equal(action.executionModel, 'latency_1s');
  assert.equal(action.features.source_strategy, 'H52_hourly_neareven_favorite_v1');
  const expected = 0.675 - 0.55 - feePerShare(0.55);
  assert.ok(Math.abs(action.features.edge_2x_per_share - expected) < 1e-12);
  assert.equal(strategy.evaluate(ctxFor(), engine).length, 0, 'one decision per market');
});

test('H53 uses the original 20% displayed-touch sizing without live-size inflation', () => {
  const strategy = new FiveMinuteNearEvenFavorite();
  const [action] = strategy.evaluate(ctxFor({
    market: { id: 54, asset: 'eth', market_type: MARKET_TYPE, positive_label: 'UP', negative_label: 'DOWN' },
    upBook: book(0.54, 0.55, 12),
  }), engine);
  assert.equal(action.size, 12 * DEPTH_PARTICIPATION);
  assert.ok(Math.abs(action.price * action.size - 1.32) < 1e-12);
});

test('H53 cannot leak into 15m/hourly markets and keeps the original bands', () => {
  const strategyFor = () => new FiveMinuteNearEvenFavorite();
  const market = (id, type = MARKET_TYPE, asset = 'btc') => ({
    id, asset, market_type: type, positive_label: 'UP', negative_label: 'DOWN',
  });
  assert.equal(strategyFor().evaluate(ctxFor({ market: market(60, 'direction_15m') }), engine).length, 0);
  assert.equal(strategyFor().evaluate(ctxFor({ market: market(61, 'direction_1h') }), engine).length, 0);
  assert.equal(strategyFor().evaluate(ctxFor({ market: market(62), tteSec: 59 }), engine).length, 0);
  assert.equal(strategyFor().evaluate(ctxFor({ market: market(63), tteSec: 301 }), engine).length, 0);
  assert.equal(strategyFor().evaluate(ctxFor({
    market: market(64), upBook: book(0.60, 0.61),
  }), engine).length, 0);
  assert.equal(strategyFor().evaluate(ctxFor({ market: market(65, MARKET_TYPE, 'doge') }), engine).length, 0);
});
