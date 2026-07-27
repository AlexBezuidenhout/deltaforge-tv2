const test = require('node:test');
const assert = require('node:assert/strict');

const makeStrategies = require('../borg/shadow/strategies');
const {
  BtcLeadsAlts,
  CadenceExperimentArm,
  CexImpulseLag,
  CrossVenueConsensus,
  DualBookMicroprice,
  FlowConfirmedLag,
  InformedOneSidedMaker,
  IdiosyncraticImpulse,
  LiquidityVacuumContinuation,
  OracleConfirmedBtc,
  PhiOverreactionFade,
  StructuralPairArb,
  ThetaLagConvergence,
  VolExpansionContinuation,
  edgeAfterCosts,
  feePerShare,
  cadenceArm,
} = makeStrategies._test;

function engine() {
  return { seq: 0, _coid(name) { this.seq += 1; return `${name}-${this.seq}`; } };
}

function ctx(overrides = {}) {
  const now = Date.now();
  return {
    now,
    market: { id: 'eth-window-1', asset: 'eth' },
    tteSec: 120,
    phiFair: 0.80,
    upMid: 0.60,
    gammaUp: 0.60,
    btc: 100.01,
    ref: 100,
    sigma: 0.01,
    micro10: { returnBps: 5, flowImbalance: 0.50, depthImbalance: 0.30, trades: 100 },
    micro30: { returnBps: 6, flowImbalance: 0.40, depthImbalance: 0.30, trades: 250 },
    upBook: { bids: [[0.50, 20]], asks: [[0.55, 20]], at: now },
    downBook: { bids: [[0.44, 20]], asks: [[0.45, 20]], at: now },
    oraclePrice: 200.06,
    oracleRef: 200,
    ...overrides,
  };
}

test('research portfolio registers the H1-H75 strategies', () => {
  const names = makeStrategies().map((strategy) => strategy.name);
  const research = names.filter((name) => /^H\d+_/.test(name));
  assert.deepEqual(research, [
    'H1_pair_arb_2x',
    'H2_cex_impulse_lag__sampled',
    'H2_cex_impulse_lag__event',
    'H3_flow_confirmed__sampled',
    'H3_flow_confirmed__event',
    'H4_btc_leads_alts',
    'H5_vol_expansion',
    'H6_phi_overreaction__sampled',
    'H6_phi_overreaction__event',
    'H7_btc_oracle_confirm',
    'H8_informed_maker',
    'H9_dual_book_microprice',
    'H10_theta_lag',
    'H11_liquidity_vacuum',
    'H12_cross_venue_consensus',
    'H13_idiosyncratic_impulse',
    'H14_robust_volscore',
    'H15_jump_adjusted_sigma',
    'H16_cross_asset_volscore',
    'H17_opening_basis_consensus',
    'H18_adaptive_beta_lag',
    'H19_clob_only_jump_fade',
    'H20_cross_venue_basis_reversion',
    'H21_complement_desync',
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
    'H32_opening_gap_repair',
    'H33_signed_semivariance',
    'H34_flow_absorption_reversal',
    'H35_depth_convexity_breakout',
    'H36_sweep_replenishment_reversal',
    'H37_spread_shock_reversion',
    'H38_passive_flow_divergence',
    'H39_autocorrelation_regime',
    'H40_directional_entropy_breakout',
    'H41_crossasset_dispersion_reversion',
    'H42_book_trade_disagreement',
    'H43_resolution_boundary_buffer',
    'H44_hourly_midwindow_reversal',
    'H45_threshold_distance_velocity',
    'H46_range_boundary_migration',
    'H47_network_binance_transport_arb',
    'H48_network_chainlink_resolver_basis',
    'H49_network_coinbase_chainlink_quorum',
    'H50_network_hyperliquid_chainlink_arb',
    'H51_network_four_feed_median_arb',
    'H52_15m_neareven_favorite_v2',
    'H53_5m_neareven_favorite_live_v1',
    'H54_dynamic_ofi_resolver_confirm',
    'H55_ofi_guarded_passive_maker',
    'H56_hawkes_excitation_continuation',
    'H57_adaptive_venue_leader_residual',
    'H58_resolver_event_stale_quote',
    'H59_resolver_cross_persistence',
    'H60_bipower_jump_envelope',
    'H61_vol_regime_envelope',
    'H62_threshold_isotonic_residual',
    'H63_range_simplex_residual',
    'H64_multivenue_cusum_break',
    'H65_kalman_latent_consensus',
    'H66_range_threshold_partition_lock',
    'H67_queue_depletion_hazard',
    'H68_multilevel_ofi_impact',
    'H69_quarticity_confidence_envelope',
    'H70_stationary_block_bootstrap_digital',
    'H71_token_elasticity_residual',
    'H72_crosshorizon_nested_lock',
    'H73_market_prior_calibration_residual',
    'H74_markov_regime_residual',
    'H75_4h_dynamic_liquidity_leadlag',
    'H58_source_causal_residual_v2',
  ]);
});

test('cadence split assigns each market to one arm with identical order latency', () => {
  let marketId = 'cadence-0';
  while (cadenceArm(marketId, 'H2_cex_impulse_lag') !== 'event') {
    marketId = `cadence-${parseInt(marketId.split('-')[1]) + 1}`;
  }
  const event = new CadenceExperimentArm(CexImpulseLag, 'event');
  const sampled = new CadenceExperimentArm(CexImpulseLag, 'sampled');
  const input = ctx({ market: { id: marketId, asset: 'eth' } });
  const eventActions = event.evaluate(input, engine());
  const sampledActions = sampled.evaluate(input, engine());
  assert.equal(eventActions.length, 1);
  assert.equal(sampledActions.length, 0);
  assert.equal(eventActions[0].executionModel, 'event_order_250ms');
  assert.match(eventActions[0].note, /target_independent_markets=300/);
});

test('fee-safe pair arb only fires when the pair survives 2x taker costs', () => {
  const bot = new StructuralPairArb();
  const e = engine();
  const good = bot.evaluate(ctx({
    market: { id: 'pair-good', asset: 'btc' },
    upBook: { asks: [[0.45, 10]], bids: [[0.44, 10]] },
    downBook: { asks: [[0.45, 10]], bids: [[0.44, 10]] },
  }), e);
  assert.equal(good.length, 2);
  assert.equal(good[0].groupId, good[1].groupId);
  assert.ok(good.every((action) => action.executionModel === 'latency_1s'));
  assert.ok(1 - 0.45 - 0.45 - feePerShare(0.45, 2) * 2 >= 0.01);

  const bad = new StructuralPairArb().evaluate(ctx({
    market: { id: 'pair-bad', asset: 'btc' },
    upBook: { asks: [[0.50, 10]], bids: [[0.49, 10]] },
    downBook: { asks: [[0.50, 10]], bids: [[0.49, 10]] },
  }), e);
  assert.equal(bad.length, 0);
});

test('CEX impulse lag requires stressed executable edge', () => {
  const e = engine();
  const bot = new CexImpulseLag();
  const actions = bot.evaluate(ctx({ market: { id: 'impulse', asset: 'eth' } }), e);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].token, 'UP');
  assert.ok(edgeAfterCosts(0.80, 0.55, 2) >= 0.03);

  const noEdge = new CexImpulseLag().evaluate(ctx({
    market: { id: 'impulse-no-edge', asset: 'eth' },
    phiFair: 0.60,
    upBook: { bids: [[0.56, 20]], asks: [[0.57, 20]] },
  }), e);
  assert.equal(noEdge.length, 0);
});

test('flow strategy requires return, aggressor flow and depth to agree', () => {
  const e = engine();
  assert.equal(new FlowConfirmedLag().evaluate(ctx({ market: { id: 'flow-good', asset: 'sol' } }), e).length, 1);
  assert.equal(new FlowConfirmedLag().evaluate(ctx({
    market: { id: 'flow-bad', asset: 'sol' },
    micro10: { returnBps: 5, flowImbalance: -0.50, depthImbalance: 0.30, trades: 100 },
  }), e).length, 0);
});

test('BTC lead strategy acts only while the target itself remains flat', () => {
  const e = engine();
  const bot = new BtcLeadsAlts();
  bot.evaluate(ctx({
    market: { id: 'btc-control', asset: 'btc' },
    micro10: { returnBps: 6, flowImbalance: 0.2, depthImbalance: 0.1 },
  }), e);
  const action = bot.evaluate(ctx({
    market: { id: 'eth-lag', asset: 'eth' },
    micro10: { returnBps: 1, flowImbalance: 0.1, depthImbalance: 0.1 },
    upBook: { bids: [[0.49, 20]], asks: [[0.50, 20]] },
  }), e);
  assert.equal(action.length, 1);
  assert.equal(action[0].token, 'UP');

  const moved = new BtcLeadsAlts();
  moved.evaluate(ctx({ market: { id: 'btc-2', asset: 'btc' }, micro10: { returnBps: 6 } }), e);
  assert.equal(moved.evaluate(ctx({
    market: { id: 'eth-moved', asset: 'eth' },
    micro10: { returnBps: 4 },
  }), e).length, 0);
});

test('vol expansion strategy uses a causal warm baseline', () => {
  const e = engine();
  const bot = new VolExpansionContinuation();
  for (let i = 0; i < 60; i++) {
    assert.equal(bot.evaluate(ctx({ market: { id: `warm-${i}`, asset: 'bnb' }, sigma: 0.01 }), e).length, 0);
  }
  const actions = bot.evaluate(ctx({
    market: { id: 'vol-break', asset: 'bnb' },
    sigma: 0.016,
  }), e);
  assert.equal(actions.length, 1);
});

test('overreaction fade buys the model-cheap opposite side on retracement', () => {
  const actions = new PhiOverreactionFade().evaluate(ctx({
    market: { id: 'fade', asset: 'eth' },
    phiFair: 0.60,
    gammaUp: 0.80,
    micro10: { returnBps: -2, flowImbalance: -0.2, depthImbalance: -0.1 },
    downBook: { bids: [[0.29, 20]], asks: [[0.30, 20]] },
  }), engine());
  assert.equal(actions.length, 1);
  assert.equal(actions[0].token, 'DOWN');
});

test('oracle confirmation requires BTC and control oracle moves to agree', () => {
  const e = engine();
  const good = new OracleConfirmedBtc().evaluate(ctx({
    market: { id: 'oracle-good', asset: 'btc' },
    tteSec: 90,
    btc: 100.03,
    ref: 100,
    oraclePrice: 200.06,
    oracleRef: 200,
  }), e);
  assert.equal(good.length, 1);

  const disagree = new OracleConfirmedBtc().evaluate(ctx({
    market: { id: 'oracle-bad', asset: 'btc' },
    tteSec: 90,
    btc: 100.03,
    ref: 100,
    oraclePrice: 199.94,
    oracleRef: 200,
  }), e);
  assert.equal(disagree.length, 0);
});

test('informed maker joins the bid and cancels when confirmation vanishes', () => {
  const e = engine();
  const bot = new InformedOneSidedMaker();
  const placed = bot.evaluate(ctx({ market: { id: 'maker', asset: 'eth' } }), e);
  assert.equal(placed.length, 1);
  assert.equal(placed[0].kind, 'maker');
  assert.equal(placed[0].price, 0.50);
  assert.equal(placed[0].queueAhead, 20);

  const cancelled = bot.evaluate(ctx({
    market: { id: 'maker', asset: 'eth' },
    micro10: { returnBps: 1, flowImbalance: 0, depthImbalance: 0 },
  }), e);
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].action, 'cancel');
});

test('dual-book microprice requires complementary queue pressure and a reliable open move', () => {
  const actions = new DualBookMicroprice().evaluate(ctx({
    market: { id: 'dual-pressure', asset: 'btc' },
    btc: 100.10,
    upBook: { bids: [[0.50, 100]], asks: [[0.55, 10]] },
    downBook: { bids: [[0.44, 10]], asks: [[0.45, 100]] },
  }), engine());
  assert.equal(actions.length, 1);
  assert.equal(actions[0].token, 'UP');
  assert.equal(actions[0].executionModel, 'latency_1s');
  assert.ok(actions[0].size * actions[0].price <= 10 + 1e-9);
  assert.ok(actions[0].size <= 10 * 0.20 + 1e-9);

  const noisyBasis = new DualBookMicroprice().evaluate(ctx({
    market: { id: 'dual-no-basis', asset: 'btc' },
    btc: 100.02,
    upBook: { bids: [[0.50, 100]], asks: [[0.55, 10]] },
    downBook: { bids: [[0.44, 10]], asks: [[0.45, 100]] },
  }), engine());
  assert.equal(noisyBasis.length, 0);
});

test('theta-lag pilot isolates probability decay from spot and sigma changes', () => {
  const bot = new ThetaLagConvergence();
  const e = engine();
  const now = Date.now();
  assert.equal(bot.evaluate(ctx({
    now, market: { id: 'theta', asset: 'eth' }, tteSec: 170,
    phiFair: 0.65, upMid: 0.55, btc: 100.10, sigma: 0.01,
  }), e).length, 0);
  const actions = bot.evaluate(ctx({
    now: now + 11000, market: { id: 'theta', asset: 'eth' }, tteSec: 159,
    phiFair: 0.71, upMid: 0.56, btc: 100.105, sigma: 0.0102,
  }), e);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].token, 'UP');
});

test('liquidity-vacuum pilot requires ask withdrawal while bid depth survives', () => {
  const bot = new LiquidityVacuumContinuation();
  const e = engine();
  const now = Date.now();
  const oldBook = {
    bids: [[0.50, 100], [0.49, 100]],
    asks: [[0.55, 100], [0.56, 100], [0.57, 100]],
  };
  assert.equal(bot.evaluate(ctx({ now, market: { id: 'vacuum', asset: 'eth' }, btc: 100.10, upBook: oldBook }), e).length, 0);
  const actions = bot.evaluate(ctx({
    now: now + 6000, market: { id: 'vacuum', asset: 'eth' }, btc: 100.10,
    upBook: { bids: [[0.50, 100], [0.49, 100]], asks: [[0.55, 15], [0.56, 15], [0.57, 15]] },
  }), e);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].token, 'UP');
});

test('cross-venue pilot abstains unless Binance and Coinbase agree', () => {
  const good = new CrossVenueConsensus().evaluate(ctx({
    market: { id: 'venue-good', asset: 'btc' }, btc: 100.10,
    venueStale: false, venue10: { returnBps: 4.2 },
    micro10: { returnBps: 5, flowImbalance: 0.2, depthImbalance: 0.1 },
  }), engine());
  assert.equal(good.length, 1);

  const stale = new CrossVenueConsensus().evaluate(ctx({
    market: { id: 'venue-stale', asset: 'btc' }, btc: 100.10,
    venueStale: true, venue10: { returnBps: 4.2 },
    micro10: { returnBps: 5 },
  }), engine());
  assert.equal(stale.length, 0);
});

test('idiosyncratic impulse subtracts a fresh peer median from the target move', () => {
  const bot = new IdiosyncraticImpulse();
  const e = engine();
  const now = Date.now();
  for (const asset of ['btc', 'sol', 'bnb', 'doge', 'xrp']) {
    bot.evaluate(ctx({
      now, market: { id: `leader-${asset}`, asset },
      micro10: { returnBps: 0.5, flowImbalance: null, depthImbalance: null },
    }), e);
  }
  const actions = bot.evaluate(ctx({
    now: now + 500, market: { id: 'breadth-target', asset: 'eth' },
    btc: 100.10,
    micro10: { returnBps: 5, flowImbalance: null, depthImbalance: null },
  }), e);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].token, 'UP');
});
