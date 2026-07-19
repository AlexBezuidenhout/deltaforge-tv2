'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const makeV6 = require('../borg/shadow/research-v6');

const { predictFourState, stateFor, T240FourStateResidual } = makeV6._test;

test('four-state residual uses frozen probability-scale coefficients', () => {
  assert.equal(stateFor(1, true), 0);
  assert.equal(stateFor(1, false), 1);
  assert.equal(stateFor(-1, true), 2);
  assert.equal(stateFor(-1, false), 3);
  for (let state = 0; state < 4; state += 1) {
    const probability = predictFourState(0.55, state);
    assert.ok(probability > 0 && probability < 1);
  }
});

test('T-240 arm benchmarks against ask and caps stake by displayed capacity', () => {
  const strategy = new T240FourStateResidual();
  const engine = { _coid: () => 'test-coid' };
  const base = Date.parse('2026-07-16T13:00:00Z');
  const market = { id: 7, asset: 'btc', positive_label: 'UP', negative_label: 'DOWN' };
  const book = (bid, ask, askSize) => ({ bids: [[bid, 100]], asks: [[ask, askSize]], at: base });
  strategy.evaluate({ now: base - 61_000, market, btc: 100, tteSec: 299,
    upBook: book(0.49, 0.5, 100), downBook: book(0.49, 0.5, 100) }, engine);
  const actions = strategy.evaluate({ now: base, market, btc: 101, tteSec: 240,
    upBook: book(0.40, 0.41, 10), downBook: book(0.58, 0.59, 10) }, engine);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].price, 0.59);
  assert.ok(actions[0].size <= 2); // 20% of ten displayed shares
  assert.ok(actions[0].features.edge_2x_per_share >= 0.01);
  assert.equal(strategy.evaluate({ now: base + 1, market, btc: 101, tteSec: 239,
    upBook: book(0.40, 0.41, 10), downBook: book(0.58, 0.59, 10) }, engine).length, 0);
});
