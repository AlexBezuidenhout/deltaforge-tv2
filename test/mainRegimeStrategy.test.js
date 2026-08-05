'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const makeStrategies = require('../borg/shadow/main-regime');
const { ExperimentRegistry, readExperimentManifests } =
  require('../borg/research/experiment-registry');

const { CHALLENGER_NAME, CONTROL_NAME } = makeStrategies._test;

function engine() {
  return {
    sequence: 0,
    _coid(name) {
      this.sequence += 1;
      return `${name}-${this.sequence}`;
    },
  };
}

function book(bid = 0.49, ask = 0.51, size = 1000) {
  return {
    bids: [[bid, size], [bid - 0.01, size]],
    asks: [[ask, size], [ask + 0.01, size]],
    at: Date.now(),
  };
}

function context(index, overrides = {}) {
  return {
    now: 1_800_000_000_000 + index * 1000,
    market: {
      id: overrides.marketId || `main-regime-${index}`,
      asset: 'btc',
      market_type: 'direction_5m',
      positive_label: 'UP',
      negative_label: 'DOWN',
    },
    tteSec: 400,
    btc: 100 + index * 0.01,
    ref: 100,
    sigma: 0.003,
    phiFair: 0.90,
    gammaUp: 0.50,
    upMid: 0.50,
    micro30: { returnBps: 8 },
    micro60: { returnBps: 10 },
    upBook: book(),
    downBook: book(),
    ...overrides,
  };
}

function warm(strategy, runtime) {
  for (let index = 0; index < 35; index += 1) {
    strategy.evaluate(context(index, { marketId: 'warmup', tteSec: 400 }), runtime);
  }
}

test('matched MAIN control and regime residual are keyless paper intents', () => {
  const [control, challenger] = makeStrategies();
  const controlEngine = engine();
  const challengerEngine = engine();
  warm(control, controlEngine);
  warm(challenger, challengerEngine);
  const target = context(50, { marketId: 'target', tteSec: 120, btc: 100.50 });
  const controlActions = control.evaluate(target, controlEngine);
  const challengerActions = challenger.evaluate(target, challengerEngine);
  assert.equal(control.name, CONTROL_NAME);
  assert.equal(challenger.name, CHALLENGER_NAME);
  assert.equal(controlActions.length, 1);
  assert.equal(challengerActions.length, 1);
  assert.equal(controlActions[0].token, challengerActions[0].token);
  assert.equal(challengerActions[0].features.paper_only, true);
  assert.equal(challengerActions[0].features.live_order_path, false);
  assert.equal(challengerActions[0].features.market_mode, 'DIRECTIONAL_IMPULSE');
  assert.ok(challengerActions[0].features.residual_edge_after_2x_fees_and_tick > 0);
});

test('regime experiment is frozen, matched and paper-only', () => {
  const registry = new ExperimentRegistry(readExperimentManifests());
  const control = registry.resolve(CONTROL_NAME);
  const challenger = registry.resolve(CHALLENGER_NAME);
  assert.equal(control.experimentId, 'main-regime-residual-v1');
  assert.equal(challenger.experimentId, 'main-regime-residual-v1');
  assert.equal(control.arm, 'unchanged_control');
  assert.equal(challenger.arm, 'directional_impulse_residual');
  assert.equal(control.minIndependentMarkets, 300);
  assert.equal(challenger.minDays, 14);
});
