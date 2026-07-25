'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ETH_G_LATE_EXACT_CFG,
  EthGLateExactForward,
} = require('../borg/shadow/eth-g-late-forward');

function engine() {
  return { sequence: 0, _coid(name) { this.sequence += 1; return `${name}-${this.sequence}`; } };
}

function context(overrides = {}) {
  return {
    market: { id: 'eth-5m-1', asset: 'eth', market_type: 'direction_5m' },
    tteSec: 60,
    phiFair: 0.93,
    upBook: { asks: [[0.82, 100]], bids: [[0.81, 100]] },
    downBook: { asks: [[0.19, 100]], bids: [[0.18, 100]] },
    ...overrides,
  };
}

test('fresh ETH arm preserves the exact original G thresholds and paper intent', () => {
  assert.deepEqual(ETH_G_LATE_EXACT_CFG, {
    tteMax: 75, tteMin: 5, minPhiCert: 0.88, minEdgeCents: 0.05,
    minAsk: 0.55, maxAsk: 0.96, stakeUsd: 10,
  });
  const actions = new EthGLateExactForward().evaluate(context(), engine());
  assert.equal(actions.length, 1);
  assert.equal(actions[0].token, 'UP');
  assert.equal(actions[0].kind, 'taker');
  assert.equal(actions[0].price, 0.82);
  assert.match(actions[0].note, /fresh_forward_only=true/);
});

test('fresh ETH arm rejects non-ETH, weak edge, and duplicate market-side orders', () => {
  assert.equal(new EthGLateExactForward().evaluate(context({
    market: { id: 'btc-5m-1', asset: 'btc', market_type: 'direction_5m' },
  }), engine()).length, 0);
  assert.equal(new EthGLateExactForward().evaluate(context({
    upBook: { asks: [[0.90, 100]], bids: [[0.89, 100]] },
  }), engine()).length, 0);
  const strategy = new EthGLateExactForward();
  assert.equal(strategy.evaluate(context(), engine()).length, 1);
  assert.equal(strategy.evaluate(context(), engine()).length, 0);
});
