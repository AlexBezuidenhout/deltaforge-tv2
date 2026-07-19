'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const makeMainV2Strategies = require('../borg/shadow/main-v2');
const { MainV2ResolverQuorum, STRATEGY_NAME } = makeMainV2Strategies._test;

function engine() {
  return { sequence: 0, _coid(name) { this.sequence += 1; return `${name}-${this.sequence}`; } };
}

function books(positiveAsk = 0.40, negativeAsk = 0.40, size = 100) {
  return {
    upBook: {
      bids: [[positiveAsk - 0.02, size]],
      asks: [[positiveAsk, size]],
      at: Date.now(),
    },
    downBook: {
      bids: [[negativeAsk - 0.02, size]],
      asks: [[negativeAsk, size]],
      at: Date.now(),
    },
  };
}

function context(overrides = {}) {
  return {
    now: Date.now(),
    market: {
      id: 'btc-main-v2-window',
      asset: 'btc',
      market_type: 'direction_5m',
      positive_label: 'UP',
      negative_label: 'DOWN',
    },
    tteSec: 120,
    btc: 100,
    ref: 100,
    sigma: 0.005,
    venueStale: false,
    micro10: { returnBps: 1 },
    venue10: { returnBps: 5 },
    rtdsChainlink10: { returnBps: 5 },
    resolverDivergence: { ageMs: 250, absBps: 1 },
    ...books(),
    ...overrides,
  };
}

test('Main V2 emits one resolver-quorum event intent with honest capacity', () => {
  const strategy = new MainV2ResolverQuorum();
  const first = strategy.evaluate(context(), engine());
  assert.equal(strategy.name, STRATEGY_NAME);
  assert.equal(first.length, 1);
  assert.equal(first[0].token, 'UP');
  assert.equal(first[0].executionModel, 'event_order_250ms');
  assert.equal(first[0].features.hold_to_resolution, true);
  assert.ok(first[0].features.edge_after_2x_fees >= 0.02);
  assert.ok(first[0].features.touch_participation <= 0.20 + 1e-12);
  assert.ok(first[0].price * first[0].size <= 10 + 1e-12);
  assert.equal(strategy.evaluate(context(), engine()).length, 0, 'one decision per independent market');
});

test('Main V2 supports a negative quorum without mixing token and spot scales', () => {
  const action = new MainV2ResolverQuorum().evaluate(context({
    market: {
      id: 'eth-main-v2-down', asset: 'eth', market_type: 'direction_5m',
      positive_label: 'UP', negative_label: 'DOWN',
    },
    micro10: { returnBps: -1 },
    venue10: { returnBps: -5 },
    rtdsChainlink10: { returnBps: -5 },
  }), engine());
  assert.equal(action.length, 1);
  assert.equal(action[0].token, 'DOWN');
  assert.ok(action[0].price > 0 && action[0].price < 1);
  assert.ok(action[0].features.model_probability > 0 && action[0].features.model_probability < 1);
});

test('Main V2 rejects stale resolver ticks, late entries and source disagreement', () => {
  const cases = [
    context({ resolverDivergence: { ageMs: 3001 } }),
    context({ tteSec: 59 }),
    context({ venue10: { returnBps: 5 }, rtdsChainlink10: { returnBps: -5 } }),
    context({ venue10: { returnBps: 5 }, rtdsChainlink10: { returnBps: 8 } }),
  ];
  for (const candidate of cases) {
    assert.equal(new MainV2ResolverQuorum().evaluate(candidate, engine()).length, 0);
  }
});
