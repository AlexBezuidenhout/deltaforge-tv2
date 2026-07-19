'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const makeMainV3Strategies = require('../borg/shadow/main-v3');
const {
  MainV3RobustSourceEnvelope,
  STRATEGY_NAME,
  TOKEN_TICK,
  sourceEnvelope,
} = makeMainV3Strategies._test;

function engine() {
  return { sequence: 0, _coid(name) { this.sequence += 1; return `${name}-${this.sequence}`; } };
}

function books(positiveAsk = 0.40, negativeAsk = 0.55, size = 100) {
  return {
    upBook: { bids: [[positiveAsk - 0.02, size]], asks: [[positiveAsk, size]], at: Date.now() },
    downBook: { bids: [[negativeAsk - 0.02, size]], asks: [[negativeAsk, size]], at: Date.now() },
  };
}

function context(overrides = {}) {
  return {
    now: Date.now(),
    market: {
      id: 'btc-main-v3-window', asset: 'btc', market_type: 'direction_5m',
      positive_label: 'UP', negative_label: 'DOWN',
    },
    tteSec: 120,
    btc: 101,
    ref: 100,
    sigma: 0.01,
    venueStale: false,
    micro10: { returnBps: 5 },
    venue10: { returnBps: 4 },
    rtdsChainlink10: { returnBps: 2 },
    resolverDivergence: { ageMs: 250, signed: 1, absBps: 1 },
    ...books(),
    ...overrides,
  };
}

test('Main V3 buys only from the least-favourable source probability', () => {
  const ctx = context();
  const envelope = sourceEnvelope(ctx);
  const strategy = new MainV3RobustSourceEnvelope();
  const actions = strategy.evaluate(ctx, engine());
  assert.equal(strategy.name, STRATEGY_NAME);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].token, 'UP');
  assert.equal(actions[0].features.robust_probability, envelope.fairUpLow);
  assert.ok(actions[0].features.edge_after_2x_fees >= TOKEN_TICK);
  assert.ok(actions[0].features.touch_participation <= 0.20 + 1e-12);
  assert.ok(actions[0].price > 0 && actions[0].price < 1);
  assert.ok(actions[0].price * actions[0].size <= 10 + 1e-12);
  assert.equal(strategy.evaluate(ctx, engine()).length, 0, 'one intent per market');
});

test('Main V3 supports a robust DOWN envelope without mixing price scales', () => {
  const actions = new MainV3RobustSourceEnvelope().evaluate(context({
    market: {
      id: 'eth-main-v3-down', asset: 'eth', market_type: 'direction_5m',
      positive_label: 'UP', negative_label: 'DOWN',
    },
    btc: 99,
    micro10: { returnBps: -5 },
    venue10: { returnBps: -4 },
    rtdsChainlink10: { returnBps: -2 },
    resolverDivergence: { ageMs: 250, signed: -1, absBps: 1 },
    ...books(0.55, 0.40),
  }), engine());
  assert.equal(actions.length, 1);
  assert.equal(actions[0].token, 'DOWN');
  assert.ok(actions[0].features.robust_probability > 0 && actions[0].features.robust_probability < 1);
});

test('Main V3 abstains on source disagreement, resolver lead, stale data or no robust edge', () => {
  const cases = [
    context({ venue10: { returnBps: -4 } }),
    context({ resolverDivergence: { ageMs: 250, signed: -1, absBps: 1 } }),
    context({ resolverDivergence: { ageMs: 3001, signed: 1, absBps: 1 } }),
    context({ ...books(0.94, 0.94) }),
  ];
  for (const candidate of cases) {
    assert.equal(new MainV3RobustSourceEnvelope().evaluate(candidate, engine()).length, 0);
  }
});
