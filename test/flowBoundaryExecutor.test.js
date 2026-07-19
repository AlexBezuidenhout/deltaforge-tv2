'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_ORDER_USD,
  validateIntent,
  venueShares,
} = require('../borg/live/flow-boundary-executor');
const { BOUNDARY_EXPERIMENT_ID } = require('../borg/flow/boundary-canary');

function intent(now = Date.now()) {
  return {
    experiment_id: BOUNDARY_EXPERIMENT_ID,
    status: 'READY',
    intended_arrival_at: new Date(now - 20),
    boundary_at: new Date(now + 2_000),
    arrival_ask: '0.50',
    requested_notional: String(MAX_ORDER_USD),
    requested_size: '20',
    minimum_order_size: '5',
  };
}

test('fresh venue-feasible intent passes the independent live-canary guard', () => {
  const now = Date.now();
  assert.equal(validateIntent(intent(now), now), null);
});

test('live fill parser handles both decimal shares and CLOB fixed-6 wire amounts', () => {
  assert.equal(venueShares('19.25'), 19.25);
  assert.equal(venueShares('19250000'), 19.25);
});

test('canary refuses stale, post-boundary, oversized and sub-minimum intents', () => {
  const now = Date.now();
  assert.equal(validateIntent({
    ...intent(now), intended_arrival_at: new Date(now - 751),
  }, now), 'stale_intent');
  assert.equal(validateIntent({
    ...intent(now), boundary_at: new Date(now + 149),
  }, now), 'insufficient_boundary_buffer');
  assert.equal(validateIntent({
    ...intent(now), requested_notional: '10.01',
  }, now), 'invalid_notional');
  assert.equal(validateIntent({
    ...intent(now), requested_size: '4.99',
  }, now), 'below_venue_minimum_size');
});
