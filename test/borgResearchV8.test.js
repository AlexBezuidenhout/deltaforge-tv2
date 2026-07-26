'use strict';

const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const makeV8 = require('../borg/shadow/research-v8');

const {
  CrossHorizonNestedLock,
  MarketPriorCalibrationResidual,
  MultiVenueCusumBreak,
  RangeThresholdPartitionLock,
  STRATEGY_NAMES,
  bootstrapTerminalProbabilities,
  multiLevelOfi,
  quarticityProfile,
  queueFlow,
  wilsonInterval,
} = makeV8._test;

const engine = {
  sequence: 0,
  _coid(strategy) {
    this.sequence += 1;
    return `test-${strategy}-${this.sequence}`;
  },
};

function book(bid, ask, size = 100, at = Date.now(), extra = []) {
  return {
    bids: [[bid, size], ...extra.map((row) => [row[0], row[1]])],
    asks: [[ask, size], ...extra.map((row) => [row[2], row[3]])],
    at,
    sourceAt: at - 1,
    src: 'ws',
  };
}

function context(overrides = {}) {
  const now = overrides.now || Date.parse('2026-07-26T13:00:00.000Z');
  return {
    now,
    market: {
      id: 1,
      asset: 'btc',
      market_type: 'direction_5m',
      positive_label: 'UP',
      negative_label: 'DOWN',
      resolution_source: 'polymarket_crypto_5m',
      window_end: new Date(now + 90000),
    },
    tteSec: 90,
    upBook: book(0.19, 0.20, 100, now),
    downBook: book(0.79, 0.80, 100, now),
    upMid: 0.195,
    btc: 101,
    ref: 100,
    resolverRef: 100,
    resolverRefSource: 'chainlink_rtds_nearest_3s',
    sigma: 0.005,
    volatility: { robustSigma5m: 0.004, rmsSigma5m: 0.006 },
    rtdsChainlink: 101,
    rtdsChainlinkAgeMs: 10,
    venuePrice: 101,
    venueStale: false,
    hyperPrice: 101,
    hyperStale: false,
    triggerEvent: null,
    ...overrides,
  };
}

test('V8 registers exactly ten unique paper strategies and no live-order path', () => {
  const strategies = makeV8();
  assert.equal(strategies.length, 10);
  assert.deepEqual(strategies.map((strategy) => strategy.name), STRATEGY_NAMES);
  assert.equal(new Set(STRATEGY_NAMES).size, 10);
  assert.ok(strategies.every((strategy) => ['event', 'sampled'].includes(strategy.cadence)));
  const source = fs.readFileSync(require.resolve('../borg/shadow/research-v8'), 'utf8');
  assert.doesNotMatch(source,
    /createAndPostOrder|process\.env\.(?:PRIVATE_KEY|POLYMARKET_PRIVATE_KEY)|@polymarket\/clob-client|require\(['"]ethers['"]\)/i);
});

test('queue hazard separates depletion from refill instead of using static imbalance', () => {
  const previous = { bid: 0.49, bidSize: 10, ask: 0.51, askSize: 20 };
  const depleted = queueFlow(previous,
    { bid: 0.50, bidSize: 14, ask: 0.51, askSize: 5 });
  assert.ok(depleted.pressure > depleted.adverse);
  const refilled = queueFlow(previous,
    { bid: 0.48, bidSize: 4, ask: 0.50, askSize: 30 });
  assert.ok(refilled.adverse > refilled.pressure);
});

test('multi-level OFI includes deeper queues rather than duplicating top OFI', () => {
  const previous = book(0.49, 0.51, 10, 1, [
    [0.48, 10, 0.52, 10],
    [0.47, 10, 0.53, 10],
  ]);
  const current = book(0.49, 0.51, 10, 2, [
    [0.48, 40, 0.52, 3],
    [0.47, 30, 0.53, 4],
  ]);
  const profile = multiLevelOfi(previous, current, 3);
  assert.equal(profile.levels, 3);
  assert.ok(profile.value > 0);
  assert.ok(profile.depth > 0);
});

test('quarticity creates an ordered non-zero volatility confidence interval', () => {
  const rows = [];
  let price = 100;
  const base = Date.parse('2026-07-26T12:00:00.000Z');
  for (let index = 0; index < 121; index += 1) {
    price *= Math.exp((index % 5 - 2) * 0.00002);
    rows.push({ second: Math.floor(base / 1000) + index,
      at: base + index * 1000, price });
  }
  const profile = quarticityProfile(rows);
  assert.equal(profile.observations, 120);
  assert.ok(profile.realizedQuarticity > 0);
  assert.ok(profile.sigmaLower5m > 0);
  assert.ok(profile.sigmaUpper5m >= profile.sigmaLower5m);
});

test('block bootstrap is deterministic and reports Wilson model uncertainty', () => {
  const returns = Array.from({ length: 360 }, (_, index) =>
    (index % 7 - 3) * 0.00001);
  const options = {
    returns,
    spots: [101],
    refs: [100],
    horizonSec: 120,
    paths: 256,
    seed: 'fixed-test',
  };
  const first = bootstrapTerminalProbabilities(options);
  const second = bootstrapTerminalProbabilities(options);
  assert.deepEqual(first, second);
  assert.ok(first.lower >= 0 && first.upper <= 1);
  assert.ok(first.lower <= first.upper);
  assert.equal(first.paths, 256);
  assert.ok(wilsonInterval(50, 100).lower < 0.5);
  assert.ok(wilsonInterval(50, 100).upper > 0.5);
});

test('H64 waits for a warmed CUSUM before emitting a bounded shadow intent', () => {
  const strategy = new MultiVenueCusumBreak();
  const base = Date.parse('2026-07-26T12:00:00.000Z');
  let actions = [];
  for (let index = 0; index < 34; index += 1) {
    const now = base + index * 1000;
    const price = 100 * Math.exp((index % 2 ? 1 : -1) * 0.000005);
    actions = strategy.evaluate(context({
      now,
      market: { ...context().market, id: 64,
        window_end: new Date(now + 90000) },
      btc: price,
      rtdsChainlink: price,
      venuePrice: price,
      hyperPrice: price,
    }), engine);
    assert.equal(actions.length, 0);
  }
  const now = base + 34000;
  actions = strategy.evaluate(context({
    now,
    market: { ...context().market, id: 64,
      window_end: new Date(now + 90000) },
    btc: 101,
    rtdsChainlink: 101,
    venuePrice: 101,
    hyperPrice: 101,
  }), engine);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].features.paper_only, true);
  assert.equal(actions[0].features.mechanism_family, 'multivenue_page_cusum');
  assert.ok(actions[0].price > 0 && actions[0].price < 1);
});

test('H66 emits equal-share three-leg intents only for the exact partition identity', () => {
  const strategy = new RangeThresholdPartitionLock();
  const now = Date.parse('2026-07-26T13:00:00.000Z');
  const shared = {
    now,
    tteSec: 600,
    btc: 105,
    ref: null,
    resolverRef: null,
    upBook: book(0.09, 0.10, 100, now),
    downBook: book(0.09, 0.10, 100, now),
  };
  assert.equal(strategy.evaluate(context({
    ...shared,
    market: {
      id: 660,
      asset: 'btc',
      market_type: 'range_daily',
      lower_bound: 100,
      upper_bound: 110,
      positive_label: 'YES',
      negative_label: 'NO',
      window_end: new Date(now + 600000),
      resolution_source: 'chainlink',
    },
    lowerBound: 100,
    upperBound: 110,
  }), engine).length, 0);
  assert.equal(strategy.evaluate(context({
    ...shared,
    market: {
      id: 661,
      asset: 'btc',
      market_type: 'threshold_daily',
      strike: 100,
      positive_label: 'YES',
      negative_label: 'NO',
      window_end: new Date(now + 600000),
      resolution_source: 'chainlink',
    },
    strike: 100,
  }), engine).length, 0);
  const actions = strategy.evaluate(context({
    ...shared,
    market: {
      id: 662,
      asset: 'btc',
      market_type: 'threshold_daily',
      strike: 110,
      positive_label: 'YES',
      negative_label: 'NO',
      window_end: new Date(now + 600000),
      resolution_source: 'chainlink',
    },
    strike: 110,
  }), engine);
  assert.equal(actions.length, 3);
  assert.equal(new Set(actions.map((action) => action.groupId)).size, 1);
  assert.ok(actions.every((action) => action.features.paper_only));
  assert.ok(actions.every((action) => action.features.non_atomic_leg_risk));
});

test('H72 proves the same-expiry nested two-leg payoff from trusted boundaries', () => {
  const strategy = new CrossHorizonNestedLock();
  const now = Date.parse('2026-07-26T13:00:00.000Z');
  const end = new Date(now + 90000);
  const cheap = {
    now,
    tteSec: 90,
    upBook: book(0.19, 0.20, 100, now),
    downBook: book(0.19, 0.20, 100, now),
    resolverRefSource: 'chainlink_rtds_nearest_3s',
  };
  assert.equal(strategy.evaluate(context({
    ...cheap,
    market: {
      id: 720,
      asset: 'btc',
      market_type: 'direction_5m',
      positive_label: 'UP',
      negative_label: 'DOWN',
      window_end: end,
      resolution_source: 'polymarket_crypto_5m',
    },
    resolverRef: 100,
  }), engine).length, 0);
  const actions = strategy.evaluate(context({
    ...cheap,
    market: {
      id: 721,
      asset: 'btc',
      market_type: 'direction_15m',
      positive_label: 'UP',
      negative_label: 'DOWN',
      window_end: end,
      resolution_source: 'chainlink_rtds_15m',
    },
    resolverRef: 110,
  }), engine);
  assert.equal(actions.length, 2);
  assert.equal(actions[0].features.group_guaranteed_payout, 1);
  assert.equal(actions[0].features.true_arbitrage_claim, false);
});

test('H73 uses only the frozen pre-cutoff calibration interval', () => {
  const strategy = new MarketPriorCalibrationResidual();
  const now = Date.parse('2026-07-26T13:10:00.000Z');
  const actions = strategy.evaluate(context({
    now,
    market: {
      ...context().market,
      id: 730,
      asset: 'btc',
      window_end: new Date(now + 120000),
    },
    tteSec: 120,
    upBook: book(0.39, 0.40, 100, now),
    downBook: book(0.59, 0.60, 100, now),
    upMid: 0.395,
  }), engine);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].features.calibration_fit_used_pnl, false);
  assert.equal(actions[0].features.calibration_data_cutoff,
    '2026-07-26T13:00:00.000Z');
});
