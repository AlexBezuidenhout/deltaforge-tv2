'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createOrderIntent, stableStringify } = require('../borg/research/contracts');
const { ExperimentRegistry, readExperimentManifests } = require('../borg/research/experiment-registry');

test('canonical OrderIntent is deterministic and keeps token prices on the 0-1 scale', () => {
  const base = {
    strategy: 'H2_cex_impulse_lag__event',
    strategyVersion: 'v1',
    experimentId: 'cadence-h2-h3-h6-v2-500usd',
    marketId: 42,
    action: 'place',
    token: 'UP',
    side: 'BUY',
    price: '0.61',
    size: '12.5',
    decisionAt: '2026-07-15T12:00:00.000Z',
    availableAt: '2026-07-15T12:00:00.025Z',
  };
  const first = createOrderIntent({ ...base, metadata: { z: 2, a: 1 } });
  const second = createOrderIntent({ ...base, metadata: { a: 1, z: 2 } });
  assert.equal(first.intentId, second.intentId);
  assert.equal(first.price, 0.61);
  assert.equal(first.size, 12.5);
  assert.equal(stableStringify({ z: 2, a: 1 }), '{"a":1,"z":2}');
  assert.throws(() => createOrderIntent({ ...base, price: 60000 }), /price/);
  assert.throws(() => createOrderIntent({ ...base, availableAt: '2026-07-15T11:59:59Z' }), /precede/);
});

test('experiment registry resolves frozen cadence arms and legacy research families', () => {
  const manifests = readExperimentManifests();
  const registry = new ExperimentRegistry(manifests);
  const eventArm = registry.resolve('H2_cex_impulse_lag__event');
  assert.equal(eventArm.experimentId, 'cadence-h2-h3-h6-v2-500usd');
  assert.equal(eventArm.arm, 'event');
  assert.equal(eventArm.minIndependentMarkets, 300);
  assert.equal(eventArm.minDays, 14);

  const late = registry.resolve('G_late_arb');
  assert.equal(late.phase, 'eval');
  assert.equal(late.family, 'late_window');

  const network = registry.resolve('H51_network_four_feed_median_arb');
  assert.equal(network.experimentId, 'research-v5-h32-h51-v1');
  assert.equal(network.family, 'cross_network_arbitrage');

  const h43 = registry.resolve('H43_resolution_boundary_buffer');
  assert.equal(h43.experimentId, 'research-h43-forward-v1');
  assert.equal(h43.phase, 'eval');
  assert.equal(h43.primaryMetric, 'net_pnl_2x_clustered_by_market_day');
  assert.equal(h43.minIndependentMarkets, 300);

  const h45 = registry.resolve('H45_threshold_distance_velocity');
  assert.equal(h45.experimentId, 'research-h45-forward-v1');
  assert.equal(h45.phase, 'eval');
  assert.equal(h45.arm, 'unchanged_30s_velocity');
  assert.equal(h45.minIndependentMarkets, 300);

  const crossVenue = registry.resolve('crossvenue_rule_aware_convergence_v5');
  assert.equal(crossVenue.experimentId, 'crossvenue-rule-aware-convergence-v5');
  assert.equal(crossVenue.phase, 'eval');

  const exactCrossVenue = registry.resolve('crossvenue_exact_rule_convergence_v6');
  assert.equal(exactCrossVenue.experimentId, 'crossvenue-exact-rule-convergence-v6');
  assert.equal(exactCrossVenue.arm, 'five_share_one_percent_one_hour');
  assert.equal(exactCrossVenue.minIndependentMarkets, 300);

  const h26 = registry.resolve('H26_nested_threshold_bundle');
  assert.equal(h26.experimentId, 'research-daily-structural-universe-v2');
  assert.equal(h26.phase, 'pilot');
  assert.equal(h26.minIndependentMarkets, 300);

  const t240 = registry.resolve('T240_four_state_residual_v1');
  assert.equal(t240.experimentId, 't240-four-state-residual-v1');
  assert.equal(t240.phase, 'eval');
  assert.equal(t240.primaryMetric, 'net_pnl_2x');
  assert.equal(t240.minIndependentMarkets, 300);
  assert.equal(t240.minDays, 14);

  const mainV3 = registry.resolve('MAIN_V3_robust_source_envelope');
  assert.equal(mainV3.experimentId, 'main-v3-robust-source-envelope-v1');
  assert.equal(mainV3.phase, 'eval');
  assert.equal(mainV3.primaryMetric, 'net_pnl_2x');
  assert.equal(mainV3.minIndependentMarkets, 500);

  const mainV4 = registry.resolve('MAIN_V4_warm_vol_temporal_consensus');
  assert.equal(mainV4.experimentId, 'main-v4-warm-vol-temporal-consensus-v1');
  assert.equal(mainV4.phase, 'eval');
  assert.equal(mainV4.primaryMetric, 'net_pnl_2x');
  assert.equal(mainV4.minIndependentMarkets, 500);

  const h54 = registry.resolve('H54_dynamic_ofi_resolver_confirm');
  assert.equal(h54.experimentId, 'research-v7-h54-h63-paper-v1');
  assert.equal(h54.phase, 'eval');
  assert.equal(h54.minIndependentMarkets, 300);
  assert.equal(h54.minDays, 14);

  const h63 = registry.resolve('H63_range_simplex_residual');
  assert.equal(h63.experimentId, 'research-v7-h54-h63-paper-v1');
  assert.equal(h63.phase, 'eval');
  assert.equal(h63.minDays, 30);
});
