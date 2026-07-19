'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const makeMainV4Strategies = require('../borg/shadow/main-v4');
const {
  MainV4WarmVolTemporalConsensus,
  STRATEGY_NAME,
  TOKEN_TICK,
  conservativeVolatility,
  temporalConsensus,
} = makeMainV4Strategies._test;

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
      id: 'btc-main-v4-window', asset: 'btc', market_type: 'direction_5m',
      positive_label: 'UP', negative_label: 'DOWN',
    },
    tteSec: 120,
    btc: 101,
    ref: 100,
    sigma: 0.006,
    volatility: {
      observations: 120,
      ewmaSigma5m: 0.006,
      rmsSigma5m: 0.012,
      robustSigma5m: 0.009,
    },
    venueStale: false,
    micro10: { returnBps: 5 },
    micro30: { returnBps: 8 },
    venue10: { returnBps: 4 },
    venue30: { returnBps: 7 },
    rtdsChainlink10: { returnBps: 2 },
    rtdsChainlink30: { returnBps: 3 },
    resolverDivergence: { ageMs: 250, signed: 1, absBps: 1 },
    ...books(),
    ...overrides,
  };
}

test('Main V4 waits for a warm profile and prices with the largest causal sigma', () => {
  const ctx = context();
  const vol = conservativeVolatility(ctx);
  const consensus = temporalConsensus(ctx);
  const actions = new MainV4WarmVolTemporalConsensus().evaluate(ctx, engine());
  assert.equal(actions.length, 1);
  assert.equal(actions[0].features.conservative_sigma_5m, 0.012);
  assert.equal(actions[0].features.temporal_consensus_sign, 1);
  assert.equal(consensus.sign, 1);
  assert.equal(actions[0].token, 'UP');
  assert.equal(actions[0].features.conservative_sigma_5m, vol.sigma5m);
  assert.ok(actions[0].features.edge_after_2x_fees >= TOKEN_TICK);
  assert.ok(actions[0].price * actions[0].size <= 10 + 1e-12);
});

test('Main V4 supports a temporally persistent DOWN envelope', () => {
  const negative = {
    micro10: { returnBps: -5 }, micro30: { returnBps: -8 },
    venue10: { returnBps: -4 }, venue30: { returnBps: -7 },
    rtdsChainlink10: { returnBps: -2 }, rtdsChainlink30: { returnBps: -3 },
  };
  const actions = new MainV4WarmVolTemporalConsensus().evaluate(context({
    market: {
      id: 'eth-main-v4-down', asset: 'eth', market_type: 'direction_5m',
      positive_label: 'UP', negative_label: 'DOWN',
    },
    btc: 99,
    resolverDivergence: { ageMs: 250, signed: -1, absBps: 1 },
    ...negative,
    ...books(0.55, 0.40),
  }), engine());
  assert.equal(actions.length, 1);
  assert.equal(actions[0].token, 'DOWN');
  assert.equal(actions[0].features.temporal_consensus_sign, -1);
});

test('Main V4 abstains on cold volatility, temporal disagreement and stale resolver data', () => {
  const cases = [
    context({ volatility: { observations: 59, rmsSigma5m: 0.012, robustSigma5m: 0.009 } }),
    context({ venue30: { returnBps: -7 } }),
    context({ volatility: { observations: 120, rmsSigma5m: null, robustSigma5m: 0.009 } }),
    context({ resolverDivergence: { ageMs: 3001, signed: 1, absBps: 1 } }),
    context({ resolverDivergence: { ageMs: 250, signed: -1, absBps: 1 } }),
  ];
  for (const candidate of cases) {
    assert.equal(new MainV4WarmVolTemporalConsensus().evaluate(candidate, engine()).length, 0);
  }
});

test('Main V4 registers as a forward-only paper strategy', () => {
  const strategies = makeMainV4Strategies();
  assert.equal(strategies.length, 1);
  assert.equal(strategies[0].name, STRATEGY_NAME);
  assert.equal(typeof strategies[0].evaluate, 'function');
  assert.equal('createAndPostOrder' in strategies[0], false);
});
