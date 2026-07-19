'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const makeV5Strategies = require('../borg/shadow/research-v5');
const {
  BinanceTransportArbitrage,
  ChainlinkResolverBasisArbitrage,
  CoinbaseChainlinkQuorumArbitrage,
  DepthConvexityBreakout,
  FourNetworkMedianArbitrage,
  HyperliquidChainlinkArbitrage,
  OpeningGapRepair,
  PassiveFlowDivergence,
  RangeBoundaryMigration,
  ResolutionBoundaryBuffer,
  ThresholdDistanceVelocity,
} = makeV5Strategies._test;

function engine() {
  return { seq: 0, _coid(name) { this.seq += 1; return `${name}-${this.seq}`; } };
}

function books(mid = 0.45, spread = 0.02, size = 100) {
  const down = 1 - mid;
  return {
    upMid: mid,
    upBook: {
      bids: [[mid - spread / 2, size], [mid - 0.02, size]],
      asks: [[mid + spread / 2, size], [mid + 0.02, size], [mid + 0.03, size]],
      at: Date.now(),
    },
    downBook: {
      bids: [[down - spread / 2, size], [down - 0.02, size]],
      asks: [[down + spread / 2, size], [down + 0.02, size], [down + 0.03, size]],
      at: Date.now(),
    },
  };
}

function ctx(overrides = {}) {
  return {
    now: Date.now(),
    market: {
      id: 'btc-five', asset: 'btc', market_type: 'direction_5m',
      positive_label: 'UP', negative_label: 'DOWN',
    },
    tteSec: 120,
    btc: 100.5,
    ref: 100,
    sigma: 0.005,
    phiFair: 0.80,
    modelFairPositive: 0.80,
    micro10: { returnBps: 4, flowImbalance: 0.4, depthImbalance: 0.3 },
    micro30: { returnBps: 5, flowImbalance: 0.4, depthImbalance: 0.3 },
    venue10: { returnBps: 5 },
    venue30: { returnBps: 5 },
    venueStale: false,
    rtdsChainlink10: { returnBps: 5 },
    rtdsChainlink30: { returnBps: 5 },
    rtdsBinance10: { returnBps: 0 },
    rtdsBinanceAgeMs: 100,
    hyper10: { returnBps: 5 },
    hyper30: { returnBps: 5 },
    hyperStale: false,
    resolverDivergence: { absBps: 2 },
    ...books(),
    ...overrides,
  };
}

test('v5 registers twenty distinct pilots and exactly five cross-network event strategies', () => {
  const strategies = makeV5Strategies();
  assert.equal(strategies.length, 20);
  assert.equal(new Set(strategies.map((strategy) => strategy.name)).size, 20);
  assert.deepEqual(strategies.slice(-5).map((strategy) => strategy.name), [
    'H47_network_binance_transport_arb',
    'H48_network_chainlink_resolver_basis',
    'H49_network_coinbase_chainlink_quorum',
    'H50_network_hyperliquid_chainlink_arb',
    'H51_network_four_feed_median_arb',
  ]);
  assert.ok(strategies.slice(-5).every((strategy) => strategy.cadence === 'event'));
  assert.ok(strategies.every((strategy) => Array.isArray(strategy.marketTypes)));
});

test('opening-gap and passive-flow mechanisms produce capacity-capped 2x-fee taker intents', () => {
  const opening = new OpeningGapRepair().evaluate(ctx({ tteSec: 280, ...books(0.35) }), engine());
  assert.equal(opening.length, 1);
  assert.equal(opening[0].kind, 'taker');
  assert.ok(opening[0].price * opening[0].size <= 10.000001);
  const passive = new PassiveFlowDivergence().evaluate(ctx({
    micro10: { returnBps: 4, flowImbalance: -0.5 },
    ...books(0.40),
  }), engine());
  assert.equal(passive.length, 1);
  assert.equal(passive[0].token, 'UP');
});

test('depth-convexity pilot requires a shallow ask path and deep confirming bid', () => {
  const shaped = books(0.40);
  shaped.upBook.asks = [[0.41, 20], [0.42, 2], [0.43, 100], [0.44, 100], [0.45, 100]];
  shaped.upBook.bids = [[0.39, 100], [0.38, 100], [0.37, 100]];
  const actions = new DepthConvexityBreakout().evaluate(ctx({ ...shaped }), engine());
  assert.equal(actions.length, 1);
  assert.equal(actions[0].token, 'UP');
});

test('resolution buffer rejects ordinary noise and accepts only a volatility-cleared boundary', () => {
  const bot = new ResolutionBoundaryBuffer();
  assert.equal(bot.evaluate(ctx({
    market: { id: 'weak', asset: 'btc', market_type: 'direction_5m', positive_label: 'UP', negative_label: 'DOWN' },
    tteSec: 60, btc: 100.05, sigma: 0.005,
  }), engine()).length, 0);
  const strong = bot.evaluate(ctx({
    market: { id: 'strong', asset: 'btc', market_type: 'direction_5m', positive_label: 'UP', negative_label: 'DOWN' },
    tteSec: 60, btc: 100.5, sigma: 0.0003, phiFair: 0.999,
    ...books(0.88),
  }), engine());
  assert.equal(strong.length, 1);
  const diagnostics = bot.diagnostics();
  assert.equal(diagnostics.frozenRule, 'research-h43-forward-v1');
  assert.equal(diagnostics.outcomes.BELOW_FROZEN_VOLATILITY_BUFFER, 1);
  assert.equal(diagnostics.outcomes.ACTION_EMITTED, 1);
});

test('threshold velocity and range migration are causal multi-tick strategies', () => {
  const e = engine(); const now = Date.now();
  const threshold = new ThresholdDistanceVelocity();
  const thresholdMarket = { id: 'threshold', asset: 'btc', market_type: 'threshold_daily', positive_label: 'YES', negative_label: 'NO' };
  assert.equal(threshold.evaluate(ctx({ now, market: thresholdMarket, strike: 100, btc: 100, tteSec: 700 }), e).length, 0);
  const thresholdActions = threshold.evaluate(ctx({
    now: now + 31000, market: thresholdMarket, strike: 100, btc: 100.2, tteSec: 669,
    ...books(0.40),
  }), e);
  assert.equal(thresholdActions.length, 1);

  const range = new RangeBoundaryMigration();
  const rangeMarket = { id: 'range', asset: 'btc', market_type: 'range_daily', positive_label: 'YES', negative_label: 'NO' };
  assert.equal(range.evaluate(ctx({ now, market: rangeMarket, lowerBound: 100, upperBound: 110, btc: 99.9, tteSec: 700 }), e).length, 0);
  const rangeActions = range.evaluate(ctx({
    now: now + 21000, market: rangeMarket, lowerBound: 100, upperBound: 110,
    btc: 100.2, tteSec: 679, micro10: { returnBps: 2, flowImbalance: 0.2 },
    ...books(0.40),
  }), e);
  assert.equal(rangeActions.length, 1);
  assert.equal(rangeActions[0].token, 'YES');
});

test('all five network-arbitrage mechanisms use event-tape fills and declare non-atomic hedge risk', () => {
  const e = engine();
  const cases = [
    [new BinanceTransportArbitrage(), ctx({ micro10: { returnBps: 5 }, rtdsBinance10: { returnBps: 1 } })],
    [new ChainlinkResolverBasisArbitrage(), ctx({ micro10: { returnBps: 1 }, rtdsChainlink10: { returnBps: 5 } })],
    [new CoinbaseChainlinkQuorumArbitrage(), ctx({
      micro10: { returnBps: 1 }, venue10: { returnBps: 5 }, rtdsChainlink10: { returnBps: 5 },
    })],
    [new HyperliquidChainlinkArbitrage(), ctx({
      micro10: { returnBps: 1 }, hyper10: { returnBps: 5 }, rtdsChainlink10: { returnBps: 5 }, ...books(0.30),
    })],
    [new FourNetworkMedianArbitrage(), ctx({
      micro30: { returnBps: 1 }, venue30: { returnBps: 5 }, hyper30: { returnBps: 5 },
      rtdsChainlink30: { returnBps: 5 }, ...books(0.30),
    })],
  ];
  for (const [strategy, context] of cases) {
    const actions = strategy.evaluate(context, e);
    assert.equal(actions.length, 1, strategy.name);
    assert.equal(actions[0].executionModel, 'event_order_250ms');
    assert.equal(actions[0].features.cross_network_arbitrage, true);
    assert.equal(actions[0].features.atomic_external_hedge, false);
  }
});
