'use strict';

const { PARKED_STATUSES } = require('./strategy-policy');

const RUNTIME_STALE_AFTER_SEC = 130;

// These are research priorities, not performance rankings or live-capital
// recommendations. They make the operator's current, pre-registered work queue
// explicit without changing any strategy rule.
const PRIORITY_RESEARCH = Object.freeze({
  FWD_H24_hourly_flow_breakout_v1: { rank: 3, tier: 'PRIORITY' },
  FWD_H40_directional_entropy_breakout_v1: { rank: 4, tier: 'PRIORITY' },
  H43_resolution_boundary_buffer: { rank: 5, tier: 'PRIORITY' },
  FWD_H44_hourly_midwindow_reversal_v1: { rank: 6, tier: 'PRIORITY' },
  FWD_H38_passive_flow_divergence_v1: { rank: 7, tier: 'PRIORITY' },
  H54_dynamic_ofi_resolver_confirm: { rank: 8, tier: 'WATCH' },
  H60_bipower_jump_envelope: { rank: 9, tier: 'WATCH' },
  H75_4h_dynamic_liquidity_leadlag: { rank: 10, tier: 'WATCH' },
});

const PREMISES = Object.freeze({
  A_maker: 'Quote passively on both sides and retain the spread when uninformed flow crosses the book.',
  A2_maker_capped: 'Use the original passive maker rule with tighter inventory sizing to test whether capacity, rather than adverse selection, caused the loss.',
  D_consistency: 'Use agreement among price and resolver features as a diagnostic of signal reliability.',
  F_yield: 'Harvest high-probability binary carry when the remaining payout appears larger than execution and resolution risk.',
  G_late_arb: 'Enter late in a crypto window after a large CEX move appears to make the terminal direction unusually certain.',
  Vasili: 'Buy near-certain late-window favorites and rely on a high hit rate to overcome occasional full binary losses.',
  MAIN_V2_resolver_quorum: 'Trade only when multiple resolver-aware references agree with MAIN’s directional forecast.',
  MAIN_V3_robust_source_envelope: 'Price the binary across a conservative envelope of spot and resolver sources, then trade only edge that survives the worst plausible source.',
  MAIN_V4_warm_vol_temporal_consensus: 'Require warmed volatility and agreement across several recent observations before accepting MAIN’s directional signal.',
  T240_four_state_residual_v1: 'At four minutes to expiry, model the joint state of price direction and market quote, then trade only the residual not already reflected in the token.',
  H1_pair_arb_2x: 'Buy a complementary YES/NO bundle only when its executable cost remains below the guaranteed $1 payout after doubled fees.',
  H2_cex_impulse_lag__sampled: 'Test whether a ten-second CEX impulse predicts a lagged Polymarket move when evaluated on the sampled clock.',
  H2_cex_impulse_lag__event: 'Test the same ten-second CEX impulse on causal market events rather than repeated timer samples.',
  H3_flow_confirmed__sampled: 'Follow CEX direction when aggressor flow and depth agree, evaluated on the sampled clock.',
  H3_flow_confirmed__event: 'Follow CEX direction when aggressor flow and depth agree, evaluated only on causal events.',
  H4_btc_leads_alts: 'Trade a still-flat altcoin market after BTC has moved first and historically related assets have not yet caught up.',
  H5_vol_expansion: 'Follow price direction when realized volatility expands into a continuation regime.',
  H6_phi_overreaction__sampled: 'Fade a Polymarket move that overshoots the Phi-model fair value on sampled observations.',
  H6_phi_overreaction__event: 'Fade the same apparent Phi-model overshoot on causal order-book events.',
  H7_btc_oracle_confirm: 'Trade only when BTC’s CEX move agrees with an independent oracle-basis control.',
  H8_informed_maker: 'Place a one-sided passive quote only when the model’s fair value gives enough room for queue risk and adverse selection.',
  H9_dual_book_microprice: 'Use joint UP/DOWN queue pressure as a microprice signal when it agrees with a resolver-safe CEX move.',
  H10_theta_lag: 'Exploit a token quote that appears slow to reflect digital-option time decay as expiry approaches.',
  H11_liquidity_vacuum: 'Follow repricing when near-touch ask liquidity is withdrawn before the displayed token price moves.',
  H12_cross_venue_consensus: 'Trade only when Binance and Coinbase independently agree on the broad-market move.',
  H13_idiosyncratic_impulse: 'Trade the asset-specific component of a CEX move after subtracting its rolling exposure to peer crypto moves.',
  H14_robust_volscore: 'Compare binary-implied volatility with robust realized volatility and trade unusually large residuals.',
  H15_jump_adjusted_sigma: 'Separate one-off jumps from persistent volatility so a contaminated sigma estimate does not distort binary fair value.',
  H16_cross_asset_volscore: 'Trade cross-asset dispersion between binary-implied and robust realized volatility.',
  H17_opening_basis_consensus: 'Measure each venue from the market-window open and trade only when Binance and Coinbase agree.',
  H18_adaptive_beta_lag: 'Estimate rolling BTC beta and trade an altcoin that has not yet reflected the predicted BTC-led move.',
  H19_clob_only_jump_fade: 'Fade a coherent Polymarket book jump that is unsupported by CEX and Phi-model information.',
  H20_cross_venue_basis_reversion: 'Trade a Polymarket opening-basis residual expected to converge toward a resolver proxy.',
  H21_complement_desync: 'Exploit temporary disagreement between the separately quoted UP and DOWN books.',
  H22_hourly_resolver_dislocation: 'Use an hourly Binance resolver move to identify an executable token quote that has not caught up.',
  H23_hourly_crossvenue_confirmation: 'Require Coinbase to confirm the hourly Binance move before trading the Polymarket quote.',
  H24_hourly_flow_breakout: 'Follow an hourly opening-range breakout only when CEX aggressor flow confirms it.',
  H25_horizon_vol_surface: 'Trade inconsistency between five-minute and hourly binary-implied volatility.',
  H26_nested_threshold_bundle: 'Buy a bundle across nested thresholds when deterministic payoff ordering proves a lock.',
  H27_disjoint_bucket_bundle: 'Buy a bundle across mutually exclusive ranges when payoff algebra proves a lock.',
  H28_threshold_resolver_close: 'Trade a daily threshold quote that is inconsistent with the resolver source near close.',
  H29_range_resolver_close: 'Trade a daily range quote that is inconsistent with resolver distance near close.',
  H30_threshold_ladder_residual: 'Detect one stale strike by projecting neighboring same-event thresholds onto a monotone ladder.',
  H31_hourly_crossasset_residual: 'Trade an hourly asset probability residual after removing the broad cross-asset CEX move.',
  H32_opening_gap_repair: 'Trade the first seconds of a window when resolver-open repricing appears incomplete.',
  H33_signed_semivariance: 'Use downside/upside realized-variance asymmetry that a symmetric binary sigma omits.',
  H34_flow_absorption_reversal: 'Fade aggressive CEX flow when substantial volume produces little spot progress.',
  H35_depth_convexity_breakout: 'Follow the direction with a shallow order-book path when depth convexity implies easier repricing.',
  H36_sweep_replenishment_reversal: 'Fade a token sweep when displayed depth rapidly replenishes behind it.',
  H37_spread_shock_reversion: 'Trade spread normalization when terminal fair value remains stable during a temporary liquidity shock.',
  H38_passive_flow_divergence: 'Follow the apparent passive-information side when price moves against reported aggressor flow.',
  H39_autocorrelation_regime: 'Use causal one-second return dependence to choose continuation or fade.',
  H40_directional_entropy_breakout: 'Follow price discovery when recent return signs have unusually low entropy and persistent direction.',
  H41_crossasset_dispersion_reversion: 'Trade five-minute cross-sectional dispersion when asset moves begin converging.',
  H42_book_trade_disagreement: 'Trade the replenished book when recent prints point the other way but terminal fair value agrees with the book.',
  H43_resolution_boundary_buffer: 'Enter near expiry only when a conservative fair-value lower bound clears the executable ask, volatility, resolver uncertainty, slippage and doubled fees.',
  H44_hourly_midwindow_reversal: 'Fade an hourly mid-window displacement only when aggressor flow confirms exhaustion and reversal.',
  H45_threshold_distance_velocity: 'Trade a daily threshold probability that lags a sustained change in strike distance.',
  H46_range_boundary_migration: 'Trade a daily range bucket after a confirmed resolver-source boundary crossing has not been fully repriced.',
  H47_network_binance_transport_arb: 'Measure whether direct Binance events lead Polymarket’s relayed Binance transport enough to create executable edge.',
  H48_network_chainlink_resolver_basis: 'Use a fresh Chainlink resolver move that leads the Binance-derived token fair value.',
  H49_network_coinbase_chainlink_quorum: 'Trade when Coinbase and Chainlink agree that Binance is the outlier.',
  H50_network_hyperliquid_chainlink_arb: 'Trade only when Hyperliquid and Chainlink agree before the Polymarket token reprices.',
  H51_network_four_feed_median_arb: 'Use a robust four-feed median to reject one bad venue and trade a lagging token quote.',
  H52_hourly_neareven_favorite_v1: 'Buy the near-even favorite under the original routing rule, which accidentally sent most observations to five-minute markets.',
  H52_15m_neareven_favorite_v2: 'Re-test the near-even favorite idea on an explicitly routed fifteen-minute market population.',
  H53_5m_neareven_favorite_live_v1: 'Preserve the accidental H52 five-minute rule exactly under a fresh identity and test whether its discovery profit replicates.',
  H54_dynamic_ofi_resolver_confirm: 'Use depth-normalized order-flow imbalance only when fresh resolver and secondary-venue prices confirm the direction.',
  H55_ofi_guarded_passive_maker: 'Provide one-sided passive liquidity only when conservative fair value is positive and order-flow imbalance is not adverse; cancel when toxicity appears.',
  H56_hawkes_excitation_continuation: 'Follow clustered, self-exciting trade arrivals only when fresh resolver evidence confirms continuation.',
  H57_adaptive_venue_leader_residual: 'Learn the causal venue leader online and trade only when its Wilson-bounded lead relationship predicts a residual in the token.',
  H58_resolver_event_stale_quote: 'Trade only when a fresh resolver event occurs after the displayed Polymarket quote and the quote remains stale after doubled costs.',
  H59_resolver_cross_persistence: 'Require a resolver boundary crossing to persist across three distinct ticks and receive secondary-venue confirmation before trading the stale token.',
  H60_bipower_jump_envelope: 'Price the binary across both total and jump-robust bipower volatility, accepting only edge that survives the full uncertainty envelope.',
  H61_vol_regime_envelope: 'Price across short- and long-horizon volatility regimes and trade only the conservative overlap.',
  H62_threshold_isotonic_residual: 'Project same-event threshold prices onto a monotone curve and trade only residuals that also agree with analytic resolver-distance fair value.',
  H63_range_simplex_residual: 'Project disjoint range probabilities onto a valid simplex and trade overpriced residuals only when analytic resolver-distance pricing agrees.',
  H64_multivenue_cusum_break: 'Detect a statistically abrupt shift in a robust multi-venue spot consensus, then trade only a token ask that still fails the conservative terminal-value hurdle.',
  H65_kalman_latent_consensus: 'Fuse independently timestamped Binance, Chainlink, Coinbase and Hyperliquid observations into an uncertainty-bounded latent spot before pricing the binary.',
  H66_range_threshold_partition_lock: 'Test exact range-plus-threshold payoff partitions after synchronized depth, doubled fees and non-atomic orphan risk.',
  H67_queue_depletion_hazard: 'Estimate whether the selected token queue is depleting before it refills, instead of treating a static imbalance as durable liquidity.',
  H68_multilevel_ofi_impact: 'Learn the causal next-event impact of five-level order flow and use it only to time terminally supported entries.',
  H69_quarticity_confidence_envelope: 'Use realized quarticity to attach estimator uncertainty to short-horizon volatility and accept only binary edge that survives the full sigma interval.',
  H70_stationary_block_bootstrap_digital: 'Price a T-120 binary from centered empirical return blocks so skew, tails and short dependence are not forced into a Gaussian Phi model.',
  H71_token_elasticity_residual: 'Learn each market’s own causal logit response to resolver distance and trade only a statistically exceptional quote residual supported by terminal fair value.',
  H72_crosshorizon_nested_lock: 'Test the nested payoff identity between same-expiry five- and fifteen-minute Chainlink contracts with different trusted opening boundaries.',
  H73_market_prior_calibration_residual: 'Apply a pre-cutoff Wilson-bounded calibration map at T-120 and trade only deviations that survive executable asks and doubled fees.',
  H74_markov_regime_residual: 'Trade only when a four-hour three-state Markov model has an identifiable transition row and creates incremental executable edge beyond the unshifted market-aware fair value.',
  H75_4h_dynamic_liquidity_leadlag: 'Select the current cross-asset price-discovery leader from two stable two-hour halves, then trade a liquidity-confirmed one-minute target underresponse only when it creates incremental edge.',
  ETH_G_late_exact_forward_v1: 'Re-run the exact ETH late-window rule under a fresh evidence clock, with realistic executable arrival and fee stress.',
  ETH_late_taker: 'Take late-window ETH quotes when CEX movement appears to clear the terminal payoff hurdle.',
  ETH_late_maker: 'Quote the same ETH late-window view passively with back-of-queue fill accounting.',
});

const FORWARD_SOURCE = Object.freeze({
  FWD_H24_hourly_flow_breakout_v1: 'H24_hourly_flow_breakout',
  FWD_H40_directional_entropy_breakout_v1: 'H40_directional_entropy_breakout',
  FWD_H44_hourly_midwindow_reversal_v1: 'H44_hourly_midwindow_reversal',
  FWD_H38_passive_flow_divergence_v1: 'H38_passive_flow_divergence',
  FWD_H15_jump_adjusted_sigma_v1: 'H15_jump_adjusted_sigma',
  FWD_H45_threshold_distance_velocity_v1: 'H45_threshold_distance_velocity',
  FWD_H46_range_boundary_migration_v1: 'H46_range_boundary_migration',
  FWD_H20_cross_venue_basis_reversion_v1: 'H20_cross_venue_basis_reversion',
  FWD_H7_btc_oracle_confirm_v1: 'H7_btc_oracle_confirm',
  FWD_H1_pair_arb_2x_v1: 'H1_pair_arb_2x',
});

const PRIOR_OUTCOMES = Object.freeze({
  H58_resolver_event_stale_quote: 'The causal audit invalidated the premise: all inspected books were newer than the Chainlink source event even though they arrived locally just before the delayed RTDS packet.',
  H59_resolver_cross_persistence: 'The complete result was weak and unstable, the second chronological half was negative, and most apparent profit depended on BTC. A new mechanism is required rather than a threshold edit.',
  H43_resolution_boundary_buffer: 'The historical point estimate was fragile: removing the best day erased the profit, and the clean epoch has not yet supplied enough new fills.',
  FWD_H24_hourly_flow_breakout_v1: 'The original broad H24 cohort was negative. A later capital-normalized diagnostic subset looked positive, so this unchanged successor tests replication without reusing those rows.',
  FWD_H40_directional_entropy_breakout_v1: 'The original rule produced a small positive diagnostic cohort but too few independent markets; its first forward observations were negative.',
  FWD_H44_hourly_midwindow_reversal_v1: 'Most discovery profit was concentrated in one UTC day, and the full same-name history was near flat. This unchanged successor tests whether the effect repeats.',
  FWD_H38_passive_flow_divergence_v1: 'The discovery cohort had a positive total but a negative second chronological half. The successor must resolve that instability.',
  FWD_H15_jump_adjusted_sigma_v1: 'The discovery cohort’s second chronological half was negative; jump adjustment may remain a feature even if the standalone trade fails.',
  FWD_H45_threshold_distance_velocity_v1: 'The original rule was retained as a feature rather than promoted; this is an exploratory unchanged forward identity.',
  FWD_H46_range_boundary_migration_v1: 'The original sample was effectively absent, so this successor is an opportunity-rate test rather than evidence of profit.',
  FWD_H20_cross_venue_basis_reversion_v1: 'The original broad cohort was negative; this unchanged clone is an exploratory falsification arm, not a rescue by tuning.',
  FWD_H7_btc_oracle_confirm_v1: 'The original rule produced no qualifying executable sample; this clone measures whether the opportunity exists in the new data epoch.',
  FWD_H1_pair_arb_2x_v1: 'The original complement scanner found no repeatable fee-safe executable lock; this clone keeps the identity test alive under the new epoch.',
  H52_hourly_neareven_favorite_v1: 'The profitable-looking discovery was misrouted: 95 of 105 observations were five-minute, not hourly, and the forward five-minute preservation failed.',
  H52_15m_neareven_favorite_v2: 'The pre-registered early-kill fired after more than 100 independent markets with non-positive doubled-cost mean P&L.',
  H53_5m_neareven_favorite_live_v1: 'More than 1,300 fresh markets were materially negative at doubled costs in both chronological halves; live execution was disabled.',
  G_late_arb: 'The frozen evaluation failed to reproduce the profitable pilot and became materially negative after doubled executable costs.',
  MAIN_V2_resolver_quorum: 'The frozen forward cohort was materially negative with its clustered interval below zero.',
  MAIN_V3_robust_source_envelope: 'The conservative source envelope reduced false certainty but did not produce positive executable expectancy.',
  MAIN_V4_warm_vol_temporal_consensus: 'Warm-volatility and temporal agreement did not repair MAIN’s negative forward economics.',
  H74_markov_regime_residual: 'The 30-day development prior was negative across BTC, ETH, SOL and XRP. H74 is retained as a strict forward falsification arm, not a promising backtest.',
  H75_4h_dynamic_liquidity_leadlag: 'The only encouraging development cell was ETH over three minutes (23 episodes, +2.645 bps), but its Wilson interval included chance and no Polymarket execution costs were available. All four asset arms remain in the fresh test.',
});

function humanizeStrategyName(strategy) {
  return String(strategy || 'unknown strategy')
    .replace(/^FWD_/, '')
    .replace(/__+/g, ' ')
    .replace(/_/g, ' ')
    .replace(/\bv(\d+)\b/gi, 'V$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function premiseFor(strategy) {
  if (PREMISES[strategy]) return PREMISES[strategy];
  const source = FORWARD_SOURCE[strategy];
  if (source && PREMISES[source]) return PREMISES[source];
  return `Test whether ${humanizeStrategyName(strategy).toLowerCase()} creates repeatable executable edge after fees, slippage and realistic fills.`;
}

function finiteDate(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function lifecycleFor(input = {}, nowMs = Date.now()) {
  const trialStatus = String(input.trialStatus || '').toUpperCase();
  const runtimeUpdatedMs = finiteDate(input.runtimeUpdatedAt);
  const runtimeAgeSec = runtimeUpdatedMs == null
    ? null
    : Math.max(0, Math.round((nowMs - runtimeUpdatedMs) / 1000));
  const runtimeFresh = runtimeAgeSec != null && runtimeAgeSec <= RUNTIME_STALE_AFTER_SEC;

  if (input.liveActive === true) {
    return {
      lifecycle: 'LIVE',
      lifecycleRank: 0,
      runtimeAgeSec,
      active: true,
      reason: 'Authenticated real-money executor is enabled and its heartbeat is fresh.',
    };
  }

  if (PARKED_STATUSES.has(trialStatus)) {
    return {
      lifecycle: 'DEAD',
      lifecycleRank: 5,
      runtimeAgeSec,
      active: false,
      reason: input.trialStatusReason || `The exact specification is non-promotable (${trialStatus || 'governance decision'}).`,
    };
  }

  if (input.runtimePresent && !runtimeFresh) {
    return {
      lifecycle: 'STALE',
      lifecycleRank: 3,
      runtimeAgeSec,
      active: false,
      reason: runtimeAgeSec == null
        ? 'The strategy is registered in a collector run but has no runtime heartbeat.'
        : `The strategy runtime heartbeat is ${runtimeAgeSec}s old; the active limit is ${RUNTIME_STALE_AFTER_SEC}s.`,
    };
  }

  if (runtimeFresh) {
    const evaluations = Number(input.evaluations || 0);
    const actions = Number(input.actions || 0);
    const activity = evaluations === 0
      ? 'The process is healthy and waiting for an eligible market type.'
      : actions === 0
        ? `The process is healthy; ${evaluations} evaluations have produced no qualifying order under the frozen rule.`
        : `The process is healthy; ${evaluations} evaluations have produced ${actions} paper order intents in this collector run.`;
    return {
      lifecycle: 'TESTING',
      lifecycleRank: 1,
      runtimeAgeSec,
      active: true,
      reason: activity,
    };
  }

  return {
    lifecycle: 'PAUSED',
    lifecycleRank: 4,
    runtimeAgeSec,
    active: false,
    reason: trialStatus === 'COLLECTING'
      ? 'A frozen trial exists, but this strategy is not registered in the active collector run.'
      : 'The strategy is retained for historical inspection but is not in the active collector run.',
  };
}

function dossierFor(strategy, context = {}) {
  const priority = PRIORITY_RESEARCH[strategy] || null;
  const sourceStrategy = FORWARD_SOURCE[strategy] || null;
  const lifecycle = lifecycleFor(context, context.nowMs);
  const trialStatus = String(context.trialStatus || '').toUpperCase();
  const terminal = PARKED_STATUSES.has(trialStatus);
  const priorOutcome = PRIOR_OUTCOMES[strategy] || null;
  const design = sourceStrategy
    ? 'Prospective identity-only clone: source thresholds, assets, sizing and execution model are unchanged; discovery rows are excluded.'
    : /^H7[4-5]_/.test(strategy)
      ? 'New H74–H75 minute-horizon mechanism frozen after a development-tape falsification; all development rows are excluded and thresholds cannot be tuned from the forward cohort.'
      : /^H6[4-9]_/.test(strategy) || /^H7[0-3]_/.test(strategy)
      ? 'New H64–H73 mechanism frozen before its forward results existed; thresholds are provisional and cannot be tuned from this cohort.'
      : /^H5[4-9]_/.test(strategy) || /^H6[0-3]_/.test(strategy)
      ? 'New mechanism frozen before H54–H63 results existed; thresholds are provisional and cannot be tuned from this cohort.'
      : strategy === 'H43_resolution_boundary_buffer'
        ? 'Original resolver-boundary rule relaunched unchanged; no threshold or sizing edits.'
        : 'Exact recorded specification; any material rule change requires a new strategy ID and fresh evidence clock.';

  return {
    strategy,
    displayName: humanizeStrategyName(strategy),
    premise: premiseFor(strategy),
    lifecycle: lifecycle.lifecycle,
    lifecycleRank: lifecycle.lifecycleRank,
    lifecycleReason: lifecycle.reason,
    runtimeAgeSec: lifecycle.runtimeAgeSec,
    active: lifecycle.active,
    priorityTier: priority?.tier || (terminal ? 'CONTROL' : 'STANDARD'),
    priorityRank: priority?.rank ?? 999,
    recommended: !!priority,
    sourceStrategy,
    design,
    priorOutcome,
    outcome: terminal
      ? (context.trialStatusReason || priorOutcome || 'The exact specification is non-promotable under the research governance policy.')
      : 'No pass or profitability decision yet. The current paper cohort remains provisional until its pre-registered evidence requirements are met.',
    interpretation: terminal
      ? '“Dead” applies to this exact tradable rule. Its raw features may still be reused in a separately registered mechanism.'
      : 'Positive interim P&L is diagnostic only; it is not a live-capital signal and must survive fresh sample, cost, latency, concentration and clustered-confidence tests.',
  };
}

module.exports = {
  FORWARD_SOURCE,
  PARKED_STATUSES,
  PREMISES,
  PRIORITY_RESEARCH,
  PRIOR_OUTCOMES,
  RUNTIME_STALE_AFTER_SEC,
  dossierFor,
  humanizeStrategyName,
  lifecycleFor,
  premiseFor,
};
