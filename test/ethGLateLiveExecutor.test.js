'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  EXPERIMENT_ID,
  MANIFEST_HASH,
  MAX_ORDER_USD,
  MIN_VENUE_SHARES,
  STRATEGY,
  STRATEGY_VERSION,
  fetchGeoblock,
  geoblockAllowsTrading,
  geoBypassConfigured,
  pilotNotional,
  sourceNotional,
  tokenProbability,
  validateCandidate,
  validateExecutionInfo,
} = require('../borg/live/eth-g-late-executor');

function candidate(now = Date.now(), overrides = {}) {
  const base = {
    id: 1,
    strategy: STRATEGY,
    experiment_id: EXPERIMENT_ID,
    manifest_hash: MANIFEST_HASH,
    strategy_version: STRATEGY_VERSION,
    action: 'place',
    side: 'BUY',
    token: 'DOWN',
    token_id: 'down-token',
    condition_id: 'condition',
    market_id: 10,
    market_type: 'direction_5m',
    asset: 'eth',
    positive_label: 'UP',
    negative_label: 'DOWN',
    accepting_orders: true,
    available_at: new Date(now - 50),
    window_end: new Date(now + 40_000),
    tte_sec: 40,
    price: '0.75',
    size: String(10 / 0.75),
    features: {
      note: 'fresh_forward_only=true phi=0.900 ask=0.750 edge=0.150',
      phi_fair: 0.10,
      book_src: 'ws',
      book_age_ms: 20,
      venue_stale: false,
      resolution_source: 'polymarket_crypto_5m',
      up_ba: 0.26,
      down_ba: 0.75,
    },
  };
  return {
    ...base,
    ...overrides,
    features: { ...base.features, ...(overrides.features || {}) },
  };
}

test('ETH G-late live guard accepts only the exact frozen forward intent', () => {
  const now = Date.now();
  const row = candidate(now);
  assert.equal(validateCandidate(row, now), null);
  assert.ok(Math.abs(sourceNotional(row) - 10) < 1e-6);
  assert.ok(Math.abs(tokenProbability(row) - 0.9) < 1e-9);
});

test('ETH G-late live guard refuses cohort, manifest, age and threshold drift', () => {
  const now = Date.now();
  assert.equal(validateCandidate(candidate(now, { asset: 'btc' }), now), 'wrong_asset');
  assert.equal(validateCandidate(candidate(now, { manifest_hash: 'wrong' }), now), 'wrong_manifest_hash');
  assert.equal(validateCandidate(candidate(now, { strategy_version: 'v2' }), now), 'wrong_strategy_version');
  assert.equal(validateCandidate(candidate(now, { tte_sec: 76 }), now), 'outside_frozen_tte');
  assert.equal(validateCandidate(candidate(now, { price: 0.97 }), now), 'outside_frozen_price');
  assert.equal(validateCandidate(candidate(now, {
    available_at: new Date(now - 2501),
  }), now), 'stale_signal');
  assert.equal(validateCandidate(candidate(now, {
    features: { phi_fair: 0.13 },
  }), now), 'outside_frozen_phi');
  assert.equal(validateCandidate(candidate(now, {
    price: 0.86,
    size: String(10 / 0.86),
    features: { down_ba: 0.86 },
  }), now), 'outside_frozen_edge');
});

test('ETH G-late live guard requires the exact websocket ask and source attestation', () => {
  const now = Date.now();
  assert.equal(validateCandidate(candidate(now, {
    features: { note: 'missing attestation' },
  }), now), 'missing_forward_attestation');
  assert.equal(validateCandidate(candidate(now, {
    features: { book_src: 'gamma' },
  }), now), 'wrong_book_source');
  assert.equal(validateCandidate(candidate(now, {
    features: { book_age_ms: 501 },
  }), now), 'stale_book');
  assert.equal(validateCandidate(candidate(now, {
    features: { down_ba: 0.74 },
  }), now), 'signal_ask_mismatch');
});

test('live pilot buys venue-minimum shares without inheriting the $10 research stake', () => {
  const row = candidate();
  assert.equal(pilotNotional(row), 3.75);
  assert.equal(pilotNotional(candidate(Date.now(), {
    price: 0.94,
    features: { down_ba: 0.94, phi_fair: 0.01 },
  })), 4.70);
  assert.equal(pilotNotional(row, { minOrderSize: MIN_VENUE_SHARES + 1 }), 4.50);
  assert.equal(pilotNotional(candidate(Date.now(), {
    price: 0.94,
    features: { down_ba: 0.94, phi_fair: 0.01 },
  }), { minOrderSize: 6 }), null);
  assert.ok(pilotNotional(row) <= MAX_ORDER_USD);
});

test('dynamic metadata may not exceed the frozen fee model or canary cap', () => {
  const row = candidate();
  const valid = {
    tokenVerified: true,
    tickSize: '0.01',
    acceptingOrders: true,
    minOrderSize: 5,
    feeRate: 0.07,
    feeExponent: 1,
  };
  assert.equal(validateExecutionInfo(row, valid), null);
  assert.equal(validateExecutionInfo(row, {
    ...valid,
    feeRate: 0.08,
  }), 'fee_schedule_exceeds_frozen_model');
  assert.equal(validateExecutionInfo(row, {
    ...valid,
    minOrderSize: 7,
  }), 'venue_minimum_exceeds_canary_cap');
  assert.equal(validateExecutionInfo(row, {
    ...valid,
    tokenVerified: false,
  }), 'market_metadata_unverified');
});

test('geographic eligibility fails closed on blocked, missing, and malformed reads', async () => {
  assert.equal(geoblockAllowsTrading({ blocked: false }), true);
  assert.equal(geoblockAllowsTrading({ blocked: true }), false);
  assert.equal(geoblockAllowsTrading(null), false);
  assert.equal(geoBypassConfigured({}), false);
  assert.equal(geoBypassConfigured({ CLOB_PROXY_URL: 'https://relay.invalid' }), true);
  assert.equal(geoBypassConfigured({ POLYMARKET_GEO_TOKEN: 'token' }), true);

  const allowed = await fetchGeoblock(async () => ({
    ok: true,
    json: async () => ({ blocked: false, country: 'XX', region: 'Y' }),
  }));
  assert.deepEqual({
    blocked: allowed.blocked,
    country: allowed.country,
    region: allowed.region,
  }, { blocked: false, country: 'XX', region: 'Y' });

  await assert.rejects(() => fetchGeoblock(async () => ({
    ok: true,
    json: async () => ({ country: 'XX' }),
  })), /geoblock_invalid_payload/);
});
