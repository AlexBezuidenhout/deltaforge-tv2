'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const makeStrategies = require('../borg/shadow/main-video-parity');
const {
  CONFIG,
  MAKER_NAME,
  MainVideoParity,
  TAKER_NAME,
  feePerShare,
} = makeStrategies._test;
const { ExperimentRegistry, readExperimentManifests } =
  require('../borg/research/experiment-registry');

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

function context(overrides = {}) {
  const upBook = book();
  const downBook = book();
  return {
    now: Date.now(),
    market: {
      id: 'video-btc-1',
      asset: 'btc',
      market_type: 'direction_5m',
      positive_label: 'UP',
      negative_label: 'DOWN',
    },
    tteSec: 120,
    btc: 100.1,
    ref: 100,
    sigma: 0.003,
    phiFair: 0.75,
    gammaUp: 0.50,
    upMid: 0.50,
    micro30: { returnBps: 8 },
    micro60: { returnBps: 10 },
    upBook,
    downBook,
    ...overrides,
  };
}

test('video-parity taker emits one executable, stressed, paper-only intent', () => {
  const strategy = new MainVideoParity({ executionArm: 'taker250' });
  const actions = strategy.evaluate(context(), engine());
  assert.equal(strategy.name, TAKER_NAME);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, 'taker');
  assert.equal(actions[0].executionModel, 'event_order_250ms');
  assert.equal(actions[0].features.paper_only, true);
  assert.equal(actions[0].features.hold_to_resolution, true);
  assert.ok(actions[0].features.edge_after_2x_fees_and_tick >= CONFIG.gate2Floor);
  assert.ok(actions[0].features.touch_participation <= CONFIG.maxTouchParticipation + 1e-12);
  assert.ok(actions[0].price * actions[0].size <= 10 + 1e-12);
  assert.equal(strategy.evaluate(context(), engine()).length, 0, 'one intent per market');
});

test('post-only arm never crosses the ask and remains a separate frozen arm', () => {
  const strategy = new MainVideoParity({ executionArm: 'postonly' });
  const ctx = context();
  const [action] = strategy.evaluate(ctx, engine());
  assert.equal(strategy.name, MAKER_NAME);
  assert.equal(action.kind, 'maker');
  assert.equal(action.executionModel, 'maker_queue_v1');
  assert.ok(action.price < ctx.upBook.asks[0][0]);
  assert.ok(action.price * action.size <= 10 + 1e-12);
});

test('honest fee and tick stress reject a raw midpoint divergence with no executable edge', () => {
  const expensive = book(0.64, 0.66, 1000);
  const actions = new MainVideoParity({ executionArm: 'taker250' }).evaluate(context({
    phiFair: 0.65,
    upMid: 0.65,
    gammaUp: 0.65,
    upBook: expensive,
    downBook: book(0.34, 0.36, 1000),
  }), engine());
  assert.equal(actions.length, 0);
  assert.ok(feePerShare(0.5, 2) > 0.03);
});

test('video-parity registry is paper-only and requires a fresh 300-market read', () => {
  const registry = new ExperimentRegistry(readExperimentManifests());
  for (const name of [TAKER_NAME, MAKER_NAME]) {
    const binding = registry.resolve(name);
    assert.equal(binding.experimentId, 'main-video-parity-v1');
    assert.equal(binding.phase, 'eval');
    assert.equal(binding.minIndependentMarkets, 300);
    assert.equal(binding.minDays, 14);
  }
});
