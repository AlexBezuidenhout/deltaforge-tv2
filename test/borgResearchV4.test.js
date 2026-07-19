const test = require('node:test');
const assert = require('node:assert/strict');

const makeV4Strategies = require('../borg/shadow/research-v4');
const {
  DisjointBucketBundle,
  HorizonVolSurface,
  HourlyCrossAssetResidual,
  HourlyCrossVenueConfirmation,
  HourlyFlowBreakout,
  HourlyResolverDislocation,
  NestedThresholdBundle,
  RangeResolverClose,
  ThresholdLadderResidual,
  ThresholdResolverClose,
} = makeV4Strategies._test;

function engine() {
  return { seq: 0, _coid(name) { this.seq += 1; return `${name}-${this.seq}`; } };
}

function books(mid = 0.55, spread = 0.02, size = 100) {
  return {
    upMid: mid,
    upBook: { bids: [[mid - spread / 2, size]], asks: [[mid + spread / 2, size]], at: Date.now() },
    downBook: { bids: [[1 - mid - spread / 2, size]], asks: [[1 - mid + spread / 2, size]], at: Date.now() },
  };
}

function ctx(overrides = {}) {
  const now = Date.now();
  return {
    now,
    market: {
      id: 'hourly-btc', asset: 'btc', market_type: 'direction_1h',
      event_id: 'hour-event', positive_label: 'UP', negative_label: 'DOWN',
    },
    tteSec: 600,
    btc: 100.2,
    cexRef: 100,
    ref: 100,
    sigma: 0.01,
    modelFairPositive: 0.80,
    phiFair: 0.80,
    micro10: { returnBps: 3, flowImbalance: 0.4, depthImbalance: 0.3 },
    micro30: { returnBps: 3.5 },
    venue30: { returnBps: 3.3 },
    venueStale: false,
    volatility: { robustSigma5m: 0.01 },
    ...books(),
    ...overrides,
  };
}

function yesNoCtx({ id, eventId, type, strike = null, lower = null, upper = null, fair = 0.8, mid = 0.55 }) {
  return ctx({
    market: { id, asset: 'btc', market_type: type, event_id: eventId, positive_label: 'YES', negative_label: 'NO' },
    strike, lowerBound: lower, upperBound: upper,
    modelFairPositive: fair, phiFair: fair,
    ...books(mid),
  });
}

test('v4 registers ten multi-horizon shadow pilots with explicit market routing', () => {
  const strategies = makeV4Strategies();
  assert.deepEqual(strategies.map((strategy) => strategy.name), [
    'H22_hourly_resolver_dislocation',
    'H23_hourly_crossvenue_confirmation',
    'H24_hourly_flow_breakout',
    'H25_horizon_vol_surface',
    'H26_nested_threshold_bundle',
    'H27_disjoint_bucket_bundle',
    'H28_threshold_resolver_close',
    'H29_range_resolver_close',
    'H30_threshold_ladder_residual',
    'H31_hourly_crossasset_residual',
  ]);
  assert.ok(strategies.every((strategy) => Array.isArray(strategy.marketTypes)));
});

test('hourly direct-resolver, cross-venue and flow mechanisms all enforce 2x-cost executable edge', () => {
  assert.equal(new HourlyResolverDislocation().evaluate(ctx(), engine()).length, 1);
  assert.equal(new HourlyCrossVenueConfirmation().evaluate(ctx(), engine()).length, 1);
  assert.equal(new HourlyFlowBreakout().evaluate(ctx(), engine()).length, 1);
  assert.equal(new HourlyCrossVenueConfirmation().evaluate(ctx({ venue30: { returnBps: -3.3 } }), engine()).length, 0);
});

test('horizon surface only acts on an hourly sigma outlier after a causal five-minute anchor', () => {
  const bot = new HorizonVolSurface();
  const e = engine();
  const now = Date.now();
  bot.evaluate(ctx({
    now,
    market: { id: 'five', asset: 'btc', market_type: 'direction_5m', positive_label: 'UP', negative_label: 'DOWN' },
    tteSec: 120, btc: 100.1, ref: 100, ...books(0.60),
  }), e);
  const actions = bot.evaluate(ctx({
    now: now + 1000,
    market: { id: 'hour', asset: 'btc', market_type: 'direction_1h', positive_label: 'UP', negative_label: 'DOWN' },
    tteSec: 600, btc: 100.5, ref: 100, modelFairPositive: 0.80, ...books(0.55),
  }), e);
  assert.equal(actions.length, 1);
});

test('nested thresholds produce an equal-share two-leg bundle with total stake capped at $10', () => {
  const bot = new NestedThresholdBundle();
  const e = engine();
  const low = yesNoCtx({ id: 'low', eventId: 'thresholds', type: 'threshold_daily', strike: 90 });
  const high = yesNoCtx({ id: 'high', eventId: 'thresholds', type: 'threshold_daily', strike: 110 });
  low.upBook.asks[0][0] = 0.45;
  high.downBook.asks[0][0] = 0.45;
  assert.equal(bot.evaluate(low, e).length, 0);
  const actions = bot.evaluate(high, e);
  assert.equal(actions.length, 2);
  assert.equal(actions[0].groupId, actions[1].groupId);
  assert.equal(actions[0].size, actions[1].size);
  assert.ok(actions[0].size * (actions[0].price + actions[1].price) <= 10.000001);
  assert.deepEqual(actions.map((action) => action.token), ['YES', 'NO']);
});

test('mutually exclusive ranges produce the exact NO+NO minimum-payout bundle', () => {
  const bot = new DisjointBucketBundle();
  const e = engine();
  const left = yesNoCtx({ id: 'left', eventId: 'ranges', type: 'range_daily', lower: 90, upper: 100 });
  const right = yesNoCtx({ id: 'right', eventId: 'ranges', type: 'range_daily', lower: 100, upper: 110 });
  left.downBook.asks[0][0] = 0.45;
  right.downBook.asks[0][0] = 0.45;
  bot.evaluate(left, e);
  const actions = bot.evaluate(right, e);
  assert.equal(actions.length, 2);
  assert.ok(actions.every((action) => action.token === 'NO'));
});

test('daily close and ladder pilots use YES/NO labels and remain near-resolution only', () => {
  const threshold = yesNoCtx({ id: 'threshold-close', eventId: 't-close', type: 'threshold_daily', strike: 100 });
  threshold.tteSec = 180;
  assert.equal(new ThresholdResolverClose().evaluate(threshold, engine())[0].token, 'YES');
  assert.equal(new ThresholdResolverClose().evaluate({ ...threshold, tteSec: 600 }, engine()).length, 0);

  const range = yesNoCtx({ id: 'range-close', eventId: 'r-close', type: 'range_daily', lower: 100, upper: 110 });
  range.tteSec = 180;
  assert.equal(new RangeResolverClose().evaluate(range, engine())[0].token, 'YES');

  const ladder = new ThresholdLadderResidual();
  const e = engine();
  ladder.evaluate(yesNoCtx({ id: 'l1', eventId: 'ladder', type: 'threshold_daily', strike: 90, fair: 0.56, mid: 0.55 }), e);
  ladder.evaluate(yesNoCtx({ id: 'l2', eventId: 'ladder', type: 'threshold_daily', strike: 100, fair: 0.56, mid: 0.55 }), e);
  const actions = ladder.evaluate(yesNoCtx({ id: 'l3', eventId: 'ladder', type: 'threshold_daily', strike: 110, fair: 0.80, mid: 0.55 }), e);
  assert.equal(actions.length, 1);
});

test('cross-asset hourly residual waits for three fresh peers', () => {
  const bot = new HourlyCrossAssetResidual();
  const e = engine();
  for (const asset of ['btc', 'eth', 'sol']) {
    assert.equal(bot.evaluate(ctx({
      market: { id: `peer-${asset}`, asset, market_type: 'direction_1h', positive_label: 'UP', negative_label: 'DOWN' },
      modelFairPositive: 0.56, ...books(0.55), micro30: { returnBps: 3 },
    }), e).length, 0);
  }
  const actions = bot.evaluate(ctx({
    market: { id: 'target-xrp', asset: 'xrp', market_type: 'direction_1h', positive_label: 'UP', negative_label: 'DOWN' },
    modelFairPositive: 0.80, ...books(0.55), micro30: { returnBps: 3 },
  }), e);
  assert.equal(actions.length, 1);
});
