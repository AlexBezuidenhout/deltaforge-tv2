'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const makeV7 = require('../borg/shadow/research-v7');

const {
  DynamicOfiResolverConfirm,
  RangeSimplexResidual,
  ResolverCrossPersistence,
  ResolverEventStaleQuote,
  STRATEGY_NAMES,
  ThresholdIsotonicResidual,
  bipowerProfile,
  certifiedDisjointRanges,
  fairEnvelope,
  isotonicNonIncreasing,
  projectSimplex,
  topOfi,
  wilsonLower,
} = makeV7._test;

const engine = { _coid: (strategy) => `test-${strategy}` };

function book(bid, ask, size = 100, at = Date.now()) {
  return {
    bids: [[bid, size]],
    asks: [[ask, size]],
    at,
    sourceAt: at - 1,
    src: 'ws',
  };
}

function directionContext(overrides = {}) {
  const now = overrides.now || Date.parse('2026-07-26T02:00:00.000Z');
  return {
    now,
    market: {
      id: 1,
      asset: 'btc',
      market_type: 'direction_5m',
      positive_label: 'UP',
      negative_label: 'DOWN',
      resolution_source: 'polymarket_crypto_5m',
    },
    tteSec: 90,
    upBook: book(0.20, 0.21, 100, now - 100),
    downBook: book(0.78, 0.79, 100, now - 100),
    upTokenId: 'up',
    downTokenId: 'down',
    btc: 101,
    ref: 100,
    resolverRef: 100,
    resolverRefSource: 'chainlink_rtds_nearest_3s',
    sigma: 0.005,
    volatility: { robustSigma5m: 0.004, rmsSigma5m: 0.006 },
    rtdsChainlink: 101,
    rtdsChainlinkAgeMs: 20,
    rtdsChainlink10: { returnBps: 3 },
    venuePrice: 101,
    venueStale: false,
    hyperPrice: 101,
    hyperStale: false,
    micro10: { returnBps: 3 },
    triggerEvent: {
      source: 'chainlink_rtds',
      sourceMs: now - 20,
      receiveWallMs: now - 20,
      eventSequence: 1,
    },
    ...overrides,
  };
}

function probabilityBooks(probability, now) {
  return {
    upBook: book(probability - 0.01, probability + 0.01, 100, now),
    downBook: book(0.99 - probability, 1.01 - probability, 100, now),
    upMid: probability,
  };
}

test('V7 registers exactly ten unique paper-only strategy identities', () => {
  const strategies = makeV7();
  assert.equal(strategies.length, 10);
  assert.deepEqual(strategies.map((strategy) => strategy.name), STRATEGY_NAMES);
  assert.equal(new Set(STRATEGY_NAMES).size, 10);
  assert.ok(strategies.every((strategy) => ['event', 'sampled'].includes(strategy.cadence)));
  const source = require('node:fs').readFileSync(require.resolve('../borg/shadow/research-v7'), 'utf8');
  assert.doesNotMatch(source, /createAndPostOrder|privateKey/i);
});

test('dynamic OFI follows the signed Cont-Kukanov-Stoikov top-level definition', () => {
  const previous = { bid: 0.49, bidSize: 10, ask: 0.51, askSize: 12 };
  assert.equal(topOfi(previous,
    { bid: 0.50, bidSize: 15, ask: 0.51, askSize: 9 }), 18);
  assert.equal(topOfi(previous,
    { bid: 0.48, bidSize: 8, ask: 0.52, askSize: 14 }), 2);
});

test('conservative fair envelope fails closed on missing resolver age and spans refs/sigmas', () => {
  const ctx = directionContext({
    rtdsChainlink: 1000,
    rtdsChainlinkAgeMs: null,
    venueStale: true,
    hyperStale: true,
  });
  const envelope = fairEnvelope(ctx);
  assert.deepEqual(envelope.spots, [101]);
  assert.deepEqual(envelope.refs, [100, 100]);
  assert.ok(envelope.lower <= envelope.upper);
  assert.ok(envelope.lower >= 0 && envelope.upper <= 1);
});

test('H54 waits for dynamic OFI persistence and emits only a bounded shadow intent', () => {
  const strategy = new DynamicOfiResolverConfirm();
  const base = Date.parse('2026-07-26T02:00:00.000Z');
  let actions = [];
  for (let index = 0; index < 4; index += 1) {
    const now = base + index * 400;
    actions = strategy.evaluate(directionContext({
      now,
      triggerEvent: { source: 'clob', sourceMs: now, receiveWallMs: now },
      upBook: {
        bids: [[0.20, 100 + index * 100]],
        asks: [[0.21, 100]],
        at: now,
        sourceAt: now - 1,
        src: 'ws',
      },
      downBook: book(0.78, 0.79, 100, now),
    }), engine);
  }
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, 'place');
  assert.equal(actions[0].kind, 'taker');
  assert.equal(actions[0].features.paper_only, true);
  assert.ok(actions[0].price > 0 && actions[0].price < 1);
  assert.ok(actions[0].size <= 20);
});

test('adaptive leader gate requires a statistically non-trivial Wilson lower bound', () => {
  assert.ok(wilsonLower(25, 30) > 0.50);
  assert.ok(wilsonLower(20, 30) < 0.50);
  assert.equal(wilsonLower(0, 0), 0);
});

test('H58 requires a fresh Chainlink event and a quote that predates it', () => {
  const strategy = new ResolverEventStaleQuote();
  const now = Date.parse('2026-07-26T02:00:00.000Z');
  const valid = directionContext({
    now,
    upBook: book(0.20, 0.21, 100, now - 100),
    downBook: book(0.78, 0.79, 100, now - 100),
    triggerEvent: {
      source: 'chainlink_rtds',
      sourceMs: now - 20,
      receiveWallMs: now - 20,
    },
  });
  const actions = strategy.evaluate(valid, engine);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].features.mechanism_family, 'resolver_event_to_clob_transfer');

  const rejected = new ResolverEventStaleQuote().evaluate(directionContext({
    now,
    upBook: book(0.20, 0.21, 100, now - 5),
    downBook: book(0.78, 0.79, 100, now - 5),
    triggerEvent: {
      source: 'chainlink_rtds',
      sourceMs: now - 20,
      receiveWallMs: now - 20,
    },
  }), engine);
  assert.equal(rejected.length, 0);

  const untrustedBoundary = new ResolverEventStaleQuote().evaluate(directionContext({
    now,
    resolverRefSource: 'mainnet_push_control',
    upBook: book(0.20, 0.21, 100, now - 100),
    downBook: book(0.78, 0.79, 100, now - 100),
    triggerEvent: {
      source: 'chainlink_rtds',
      sourceMs: now - 20,
      receiveWallMs: now - 20,
    },
  }), engine);
  assert.equal(untrustedBoundary.length, 0);
});

test('H59 requires three distinct resolver ticks over at least 500ms', () => {
  const strategy = new ResolverCrossPersistence();
  const base = Date.parse('2026-07-26T02:00:00.000Z');
  assert.equal(strategy.evaluate(directionContext({
    now: base,
    triggerEvent: { source: 'chainlink_rtds', sourceMs: base, receiveWallMs: base },
  }), engine).length, 0);
  assert.equal(strategy.evaluate(directionContext({
    now: base + 300,
    triggerEvent: { source: 'chainlink_rtds', sourceMs: base + 300, receiveWallMs: base + 300 },
  }), engine).length, 0);
  const actions = strategy.evaluate(directionContext({
    now: base + 600,
    triggerEvent: { source: 'chainlink_rtds', sourceMs: base + 600, receiveWallMs: base + 600 },
  }), engine);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].features.resolver_confirming_ticks, 3);
});

test('bipower profile separates a jump from continuous variation', () => {
  const base = Date.parse('2026-07-26T02:00:00.000Z');
  const rows = [];
  let price = 100;
  for (let index = 0; index < 80; index += 1) {
    price *= Math.exp(index === 50 ? 0.01 : (index % 2 ? 0.0001 : -0.0001));
    rows.push({ second: Math.floor(base / 1000) + index, at: base + index * 1000, price });
  }
  const profile = bipowerProfile(rows);
  assert.ok(profile.jumpVariance > 0);
  assert.ok(profile.jumpShare > 0.5);
  assert.ok(profile.totalSigma5m > profile.continuousSigma5m);
});

test('isotonic and simplex projections enforce their probability constraints', () => {
  const isotonic = isotonicNonIncreasing([0.2, 0.8, 0.1]);
  assert.deepEqual(isotonic.map((value) => +value.toFixed(3)), [0.5, 0.5, 0.1]);
  const simplex = projectSimplex([0.6, 0.5, 0.4]);
  assert.ok(Math.abs(simplex.reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
  assert.ok(simplex.every((value) => value >= 0));
  assert.equal(certifiedDisjointRanges([
    { lower: 0, upper: 1 },
    { lower: 1, upper: 2 },
    { lower: 2, upper: 3 },
  ]).valid, true);
  assert.equal(certifiedDisjointRanges([
    { lower: 0, upper: 2 },
    { lower: 1, upper: 3 },
    { lower: 3, upper: 4 },
  ]).valid, false);
});

test('H62 buys the cheap opposite token only when isotonic and analytic fair agree', () => {
  const strategy = new ThresholdIsotonicResidual();
  const now = Date.parse('2026-07-26T02:00:00.000Z');
  const makeCtx = (id, strike, probability, modelFairPositive) => ({
    now,
    market: {
      id,
      event_id: 'threshold-event',
      market_type: 'threshold_daily',
      positive_label: 'YES',
      negative_label: 'NO',
    },
    strike,
    tteSec: 1800,
    modelFairPositive,
    ...probabilityBooks(probability, now),
  });
  strategy.evaluate(makeCtx(1, 100, 0.2, 0.2), engine);
  strategy.evaluate(makeCtx(2, 200, 0.8, 0.2), engine);
  strategy.evaluate(makeCtx(3, 300, 0.1, 0.1), engine);
  const actions = strategy.evaluate(makeCtx(2, 200, 0.8, 0.2), engine);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].token, 'NO');
  assert.equal(actions[0].features.true_arbitrage, false);
});

test('H63 only trades the overpriced side of a certified disjoint range family', () => {
  const strategy = new RangeSimplexResidual();
  const now = Date.parse('2026-07-26T02:00:00.000Z');
  const makeCtx = (id, lowerBound, upperBound) => ({
    now,
    market: {
      id,
      event_id: 'range-event',
      market_type: 'range_daily',
      positive_label: 'YES',
      negative_label: 'NO',
    },
    lowerBound,
    upperBound,
    tteSec: 1800,
    modelFairPositive: 0.10,
    ...probabilityBooks(0.50, now),
  });
  assert.equal(strategy.evaluate(makeCtx(1, 0, 1), engine).length, 0);
  assert.equal(strategy.evaluate(makeCtx(2, 1, 2), engine).length, 0);
  const actions = strategy.evaluate(makeCtx(3, 2, 3), engine);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].token, 'NO');
  assert.equal(actions[0].features.ranges_disjoint_certified, true);
  assert.equal(actions[0].features.partition_exhaustive, false);
});
