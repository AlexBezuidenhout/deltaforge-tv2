'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  boundarySourceState,
  hasConnectionGap,
  latestCausalTouch,
} = require('../borg/flow/boundary-canary');

function signal(minimumOrderSize = 5) {
  return {
    conditionId: 'condition-1',
    targetAssetId: 'NO_TOKEN',
    targetOutcome: 'No',
    feeRate: '0.0156',
    features: {
      decision_target_bid: '0.47',
      decision_target_ask: '0.49',
      sweep_displacement_per_share: '0.08',
      target_stake_usd: '10',
      max_touch_participation: '0.20',
      minimum_order_size: String(minimumOrderSize),
    },
  };
}

test('causal touch lookup never uses a post-arrival book update', () => {
  const touches = [
    { observedAt: 1_100, bestAsk: 0.51 },
    { observedAt: 1_249, bestAsk: 0.52 },
    { observedAt: 1_251, bestAsk: 0.01 },
  ];
  assert.equal(latestCausalTouch(touches, 1_250).bestAsk, 0.52);
});

test('source arm requires strict final-ten-second timing and venue-minimum capacity', () => {
  const touch = {
    observedAt: 1_490, bestBid: '0.48', bidSize: '100', bestAsk: '0.50', askSize: '100',
    connectionEpoch: 2, connectionShard: 0,
  };
  const armed = boundarySourceState({
    signal: signal(), signalDecisionMs: 1_000, availableMs: 1_500,
    boundaryMs: 11_000, touch, connectionGap: false,
  });
  assert.equal(armed.armed, true);
  assert.equal(armed.source_size, 20);
  assert.equal(armed.tte_ms, 9_500);

  const tooThin = boundarySourceState({
    signal: signal(), signalDecisionMs: 1_000, availableMs: 1_500,
    boundaryMs: 11_000, touch: { ...touch, askSize: '20' }, connectionGap: false,
  });
  assert.equal(tooThin.armed, false);
  assert.equal(tooThin.reason, 'below_venue_minimum_size');

  const atBoundary = boundarySourceState({
    signal: signal(), signalDecisionMs: 1_000, availableMs: 1_500,
    boundaryMs: 1_500, touch, connectionGap: false,
  });
  assert.equal(atBoundary.reason, 'outside_final_10s_window');
});

test('connection-gap test is shard-scoped and inclusive of the decision interval', () => {
  const events = [
    { at: 1_200, shard: 1, event: 'close' },
    { at: 1_300, shard: 0, event: 'open' },
    { at: 1_400, shard: 0, event: 'stale' },
  ];
  assert.equal(hasConnectionGap(events, { fromMs: 1_000, toMs: 1_350, shard: 0 }), false);
  assert.equal(hasConnectionGap(events, { fromMs: 1_000, toMs: 1_450, shard: 0 }), true);
});
