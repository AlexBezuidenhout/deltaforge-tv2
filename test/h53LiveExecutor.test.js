'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EXPERIMENT_ID,
  MAX_ORDER_USD,
  MIN_VENUE_SHARES,
  STRATEGY,
  candidateNotional,
  isExpectedFakNonFill,
  parseMarketBuyFill,
  runWithConcurrency,
  takerFee,
  validateCandidate,
  validateExecutionInfo,
  venueUnits,
} = require('../borg/live/h53-executor');

function candidate(now = Date.now(), overrides = {}) {
  return {
    strategy: STRATEGY,
    experiment_id: EXPERIMENT_ID,
    action: 'place',
    side: 'BUY',
    token: 'UP',
    token_id: 'token-up',
    market_type: 'direction_5m',
    asset: 'btc',
    available_at: new Date(now - 50),
    window_end: new Date(now + 120_000),
    tte_sec: 180,
    price: '0.55',
    size: String(MAX_ORDER_USD / 0.55),
    features: { frozen_fair_favorite: 0.675, depth_participation: 0.20 },
    ...overrides,
  };
}

test('H53 live guard accepts only the exact frozen feasible intent', () => {
  const now = Date.now();
  const row = candidate(now);
  assert.equal(validateCandidate(row, now), null);
  assert.ok(Math.abs(candidateNotional(row) - MAX_ORDER_USD) < 1e-9);
});

test('H53 live guard refuses population, threshold, age and size drift', () => {
  const now = Date.now();
  assert.equal(validateCandidate(candidate(now, { market_type: 'direction_15m' }), now), 'wrong_market_type');
  assert.equal(validateCandidate(candidate(now, { price: '0.61' }), now), 'outside_frozen_price');
  assert.equal(validateCandidate(candidate(now, { tte_sec: 59 }), now), 'outside_frozen_tte');
  assert.equal(validateCandidate(candidate(now, { available_at: new Date(now - 2501) }), now), 'stale_signal');
  assert.equal(validateCandidate(candidate(now, { size: String(MIN_VENUE_SHARES - 0.01) }), now), 'venue_minimum');
  assert.equal(validateCandidate(candidate(now, {
    size: '10', features: { frozen_fair_favorite: 0.675, depth_participation: 0.25 },
  }), now), 'wrong_depth_participation');
});

test('H53 never inflates a depth-capped shadow order to the $10 ceiling', () => {
  const now = Date.now();
  const row = candidate(now, { size: '5.25' });
  assert.equal(validateCandidate(row, now), null);
  assert.equal(candidateNotional(row), 2.8875);
});

test('CLOB fixed-six amounts and normalized decimals reconcile identically', () => {
  assert.equal(venueUnits('18.25'), 18.25);
  assert.equal(venueUnits('18250000'), 18.25);
});

test('an exact-price FAK miss is an expected non-fill, not a system error', () => {
  assert.equal(isExpectedFakNonFill(new Error(
    'no orders found to match with FAK order. FAK orders are partially filled or killed if no match is found.'
  )), true);
  assert.equal(isExpectedFakNonFill(new Error('authentication failed')), false);
});

test('market-buy receipt uses actual quote spend and shares, never the worst limit', () => {
  const fill = parseMarketBuyFill({
    makingAmount: '6.029999',
    takingAmount: '11.523772',
  }, 6.032, 0.58, { feeRate: 0.07, feeExponent: 1 });

  assert.equal(fill.status, 'MATCHED');
  assert.equal(fill.matchedNotional, 6.029999);
  assert.equal(fill.matchedShares, 11.523772);
  assert.ok(Math.abs(fill.averageFillPrice - 0.5232660798912023) < 1e-12);
  assert.ok(Math.abs(fill.feePaid - 0.20122935430654912) < 1e-12);
  assert.ok(fill.averageFillPrice < 0.58);
  assert.ok(Math.abs(fill.economicCost - (fill.matchedNotional + fill.feePaid)) < 1e-12);
});

test('fixed-six CLOB receipt amounts produce the same fill economics', () => {
  const normalized = parseMarketBuyFill(
    { makingAmount: '6.029999', takingAmount: '11.523772' }, 6.032, 0.58,
  );
  const fixedSix = parseMarketBuyFill(
    { makingAmount: '6029999', takingAmount: '11523772' }, 6.032, 0.58,
  );
  assert.deepEqual(fixedSix, normalized);
});

test('fill invariants reject overspend and execution above the signed cap', () => {
  assert.throws(() => parseMarketBuyFill(
    { makingAmount: '10.01', takingAmount: '20' }, 10, 0.55,
  ), /fill_invariant_overspend/);
  assert.throws(() => parseMarketBuyFill(
    { makingAmount: '6', takingAmount: '10' }, 6, 0.58,
  ), /fill_invariant_price_breach/);
});

test('dynamic venue metadata cannot silently make the frozen fee hurdle dearer', () => {
  const row = candidate();
  const valid = {
    tokenVerified: true,
    tickSize: '0.001',
    acceptingOrders: true,
    minOrderSize: 5,
    feeRate: 0.07,
    feeExponent: 1,
  };
  assert.equal(validateExecutionInfo(row, valid), null);
  assert.equal(validateExecutionInfo(row, { ...valid, feeRate: 0.08 }), 'fee_schedule_exceeds_frozen_model');
  assert.equal(validateExecutionInfo(row, { ...valid, minOrderSize: 25 }), 'venue_minimum_dynamic');
  assert.equal(validateExecutionInfo(row, { ...valid, tokenVerified: false }), 'market_metadata_unverified');
  assert.ok(takerFee(20, 0.5, 0.07, 1) > 0);
});

test('independent markets are processed concurrently but respect the cap', async () => {
  let active = 0;
  let maxActive = 0;
  const seen = [];
  await runWithConcurrency([1, 2, 3, 4, 5, 6], 3, async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    seen.push(value);
    active -= 1;
  });
  assert.equal(maxActive, 3);
  assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
});

test('one concurrent candidate failure does not abandon the remaining markets', async () => {
  const seen = [];
  await assert.rejects(() => runWithConcurrency([1, 2, 3, 4], 2, async (value) => {
    seen.push(value);
    if (value === 2) throw new Error('candidate failed');
  }), /1 concurrent H53 candidate/);
  assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4]);
});
