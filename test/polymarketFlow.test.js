'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CHALLENGER_LATENCY_PROFILES_MS,
  CHALLENGER_STRATEGY_VERSION,
  LATENCY_PROFILES_MS,
  evaluateCostConfirmedEntry,
  evaluatePublicSweep,
  roundTripPnl,
  takerFee,
} = require('../borg/flow/strategy');

const market = {
  conditionId: 'condition-1',
  tokenIds: ['YES_TOKEN', 'NO_TOKEN'],
  outcomes: ['Yes', 'No'],
  minimumOrderSize: '5',
};

function book(bid, bidSize, ask, askSize, at = 1_000_000) {
  return { bids: [[bid, bidSize]], asks: [[ask, askSize]], at };
}

test('a public BUY sweep creates continuation and fade controls at every latency', () => {
  const result = evaluatePublicSweep({
    trade: { assetId: 'YES_TOKEN', side: 'BUY', price: 0.51, size: 20, outcome: 'Yes' },
    market,
    triggerBook: book(0.50, 100, 0.52, 100),
    oppositeBook: book(0.47, 100, 0.49, 100),
    preTouch: { bestBid: 0.49, bidSize: 50, bestAsk: 0.50, askSize: 20 },
    nowMs: 1_000_000,
    includeChallengers: false,
  });
  assert.equal(result.eligible, true);
  assert.equal(result.signals.length, LATENCY_PROFILES_MS.length * 2);
  const continuation = result.signals.find((signal) => signal.arm === 'continuation');
  const fade = result.signals.find((signal) => signal.arm === 'fade_control');
  assert.equal(continuation.targetAssetId, 'YES_TOKEN');
  assert.equal(fade.targetAssetId, 'NO_TOKEN');
  assert.ok(continuation.requestedSize * continuation.entryLimit <= 10 + 1e-9);
});

test('a public SELL sweep expresses continuation through the complement', () => {
  const result = evaluatePublicSweep({
    trade: { assetId: 'YES_TOKEN', side: 'SELL', price: 0.48, size: 25, outcome: 'Yes' },
    market,
    triggerBook: book(0.47, 100, 0.49, 100),
    oppositeBook: book(0.50, 100, 0.52, 100),
    preTouch: { bestBid: 0.49, bidSize: 20, bestAsk: 0.51, askSize: 50 },
    nowMs: 1_000_000,
    includeChallengers: false,
  });
  assert.equal(result.eligible, true);
  assert.equal(result.signals.find((signal) => signal.arm === 'continuation').targetAssetId, 'NO_TOKEN');
  assert.equal(result.signals.find((signal) => signal.arm === 'fade_control').targetAssetId, 'YES_TOKEN');
});

test('V3 schedules venue-minimum-aware cost-confirmed controls without reusing old evidence', () => {
  const result = evaluatePublicSweep({
    trade: { assetId: 'YES_TOKEN', side: 'BUY', price: 0.58, size: 20, outcome: 'Yes' },
    market,
    triggerBook: book(0.50, 100, 0.52, 50),
    oppositeBook: book(0.47, 100, 0.49, 50),
    preTouch: { bestBid: 0.49, bidSize: 50, bestAsk: 0.50, askSize: 20 },
    nowMs: 1_000_000,
    includeControls: false,
  });
  assert.equal(result.eligible, true);
  assert.equal(result.signals.length, CHALLENGER_LATENCY_PROFILES_MS.length * 2);
  for (const signal of result.signals) {
    assert.equal(signal.features.strategy_version, CHALLENGER_STRATEGY_VERSION);
    assert.equal(signal.features.deferred_decision, true);
    assert.equal(signal.entryLimit, 0.99);
    assert.equal(signal.features.minimum_order_size, 5);
  }
});

test('cost confirmation requires one tick, supportive queue and full cost coverage', () => {
  const features = {
    decision_target_bid: 0.50,
    decision_target_ask: 0.52,
    sweep_displacement_per_share: 0.08,
  };
  const eligible = evaluateCostConfirmedEntry({
    features, entryBid: 0.51, bidSize: 100, entryAsk: 0.53, askSize: 50, feeRate: 0.07,
  });
  assert.equal(eligible.eligible, true);
  assert.ok(eligible.roundTripCostPerShare <= features.sweep_displacement_per_share);
  assert.equal(evaluateCostConfirmedEntry({
    features, entryBid: 0.505, bidSize: 100, entryAsk: 0.53, askSize: 50, feeRate: 0.07,
  }).reason, 'no_one_tick_followthrough');
  assert.equal(evaluateCostConfirmedEntry({
    features, entryBid: 0.51, bidSize: 10, entryAsk: 0.53, askSize: 50, feeRate: 0.07,
  }).reason, 'ask_queue_dominates');
  assert.equal(evaluateCostConfirmedEntry({
    features: { ...features, sweep_displacement_per_share: 0.01 },
    entryBid: 0.51, bidSize: 100, entryAsk: 0.53, askSize: 50, feeRate: 0.07,
  }).reason, 'sweep_does_not_cover_roundtrip_cost');
});

test('small or non-consuming trades do not manufacture a sweep signal', () => {
  const base = {
    market, triggerBook: book(0.50, 100, 0.52, 100),
    oppositeBook: book(0.47, 100, 0.49, 100),
    preTouch: { bestBid: 0.49, bidSize: 50, bestAsk: 0.50, askSize: 20 },
    nowMs: 1_000_000,
  };
  assert.equal(evaluatePublicSweep({
    ...base, trade: { assetId: 'YES_TOKEN', side: 'BUY', price: 0.50, size: 5 },
  }).eligible, false);
  assert.equal(evaluatePublicSweep({
    ...base, trade: { assetId: 'YES_TOKEN', side: 'BUY', price: 0.50, size: 19 },
  }).eligible, false);
});

test('round-trip markout charges exact entry and exit token fees', () => {
  const result = roundTripPnl({ shares: 20, entryPrice: 0.50, exitPrice: 0.52, feeRate: 0.07 });
  assert.ok(Math.abs(result.gross - 0.4) < 1e-12);
  assert.equal(result.entryFee, takerFee(20, 0.50, 0.07));
  assert.equal(result.exitFee, takerFee(20, 0.52, 0.07));
  assert.ok(result.net < 0.4);
});

test('collector has no live order or wallet dependency', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'borg', 'flow', 'collector.js'), 'utf8');
  for (const forbidden of ['createAndPostOrder', 'postOrder(', 'private_key', 'POLYMARKET_PRIVATE_KEY']) {
    assert.equal(source.includes(forbidden), false, `collector must not contain ${forbidden}`);
  }
});
