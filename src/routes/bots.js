/**
 * /api/bots — the unified, AUTO-DISCOVERING bot registry (2026-07-13).
 *
 * One endpoint the dashboard renders as a card grid. Design rule: adding a
 * bot or shadow strategy must require ZERO frontend work — paper bots are
 * enumerated here once, BORG strategies are discovered from
 * borg_shadow_orders (any strategy that has ever placed an order appears;
 * anything quiet >24h is listed as dormant/retired automatically).
 *
 * Experiment progress (pre-registered reads) is reported per bot so the
 * operator can see every ticking clock in one place.
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../models/db');
const { authMiddleware } = require('../middleware/auth');
const { buildPortfolioPolicy } = require('../bot/PortfolioRiskPolicy');
const {
  RESEARCH_CAPITAL_VERSION,
  STARTING_BANKROLL_USD,
  TARGET_STAKE_USD,
} = require('../../borg/research/capital-policy');

// Pre-registered experiment targets. Key = strategy/bot id.
// BORG core reads exclude hype by registration (judged separately).
const EXPERIMENTS = {
  G_late_arb: { label: 'frozen eval only · 500 fills + 14d · CI > 0', target: 500 },
  Vasili: { label: 'n=300 read: prediction = accuracy high, profit ~0', target: 300 },
  ETH_late_taker: { label: 'fresh ETH taker arm · adjusted CI + 2× costs', target: 500 },
  ETH_late_maker: { label: 'fresh ETH maker arm · back-of-queue fills', target: 500 },
  MAIN_V2_resolver_quorum: { label: 'frozen forward eval · 500 markets + 14d · adjusted CI > 0 at 2× costs', target: 500 },
  MAIN_V3_robust_source_envelope: { label: 'fresh robust-source eval · 500 markets + 14d · adjusted CI > 0 at 2× costs', target: 500 },
  MAIN_V4_warm_vol_temporal_consensus: { label: 'fresh warm-vol temporal eval · 500 markets + 14d · adjusted CI > 0 at 2× costs', target: 500 },
};

// New mechanism-diverse research portfolio. These names are active shadow
// pilots, not live candidates: pilot fills validate machinery only and the
// 500-fill/14-day evidence clock starts at a future parameter-freeze commit.
const RESEARCH_PILOTS = Object.freeze({
  H1_pair_arb_2x: 'two-leg complement identity · positive after 2× taker fees',
  H2_cex_impulse_lag__sampled: 'randomized sampled arm · 10s CEX impulse',
  H2_cex_impulse_lag__event: 'randomized event arm · 10s CEX impulse',
  H3_flow_confirmed__sampled: 'randomized sampled arm · CEX flow + depth',
  H3_flow_confirmed__event: 'randomized event arm · CEX flow + depth',
  H4_btc_leads_alts: 'BTC price-discovery lead into still-flat altcoins',
  H5_vol_expansion: 'volatility-regime expansion + continuation',
  H6_phi_overreaction__sampled: 'randomized sampled arm · CLOB overshoot fade',
  H6_phi_overreaction__event: 'randomized event arm · CLOB overshoot fade',
  H7_btc_oracle_confirm: 'BTC CEX + control-oracle basis agreement',
  H8_informed_maker: 'one-sided informed maker · back-of-queue scoring',
  H9_dual_book_microprice: 'UP/DOWN queue pressure agrees with resolver-safe CEX move',
  H10_theta_lag: 'digital-option time decay moves Φ before the token',
  H11_liquidity_vacuum: 'near-touch ask withdrawal before repricing',
  H12_cross_venue_consensus: 'Binance + Coinbase broad-market agreement',
  H13_idiosyncratic_impulse: 'asset-specific CEX move after subtracting peer beta',
  H14_robust_volscore: 'binary-implied sigma vs robust realized sigma (Barclays transfer)',
  H15_jump_adjusted_sigma: 'one-jump EWMA contamination vs persistent volatility',
  H16_cross_asset_volscore: 'cross-asset implied/robust volatility dispersion',
  H17_opening_basis_consensus: 'Binance + Coinbase agreement from each window open',
  H18_adaptive_beta_lag: 'rolling BTC beta predicts lagging alt catch-up',
  H19_clob_only_jump_fade: 'coherent CLOB jump unsupported by CEX/Phi information',
  H20_cross_venue_basis_reversion: 'opening-basis convergence toward a resolver proxy',
  H21_complement_desync: 'UP/DOWN complement books temporarily disagree',
  H22_hourly_resolver_dislocation: 'hourly Binance resolver move leads the executable token',
  H23_hourly_crossvenue_confirmation: 'hourly Binance move confirmed independently by Coinbase',
  H24_hourly_flow_breakout: 'hourly opening-range continuation with aggressor-flow confirmation',
  H25_horizon_vol_surface: 'five-minute versus hourly digital-implied volatility term structure',
  H26_nested_threshold_bundle: 'structural YES(low) + NO(high) nested-threshold bundle',
  H27_disjoint_bucket_bundle: 'structural NO + NO bundle across mutually exclusive buckets',
  H28_threshold_resolver_close: 'last-five-minute Binance-close threshold dislocation',
  H29_range_resolver_close: 'last-five-minute Binance-close range dislocation',
  H30_threshold_ladder_residual: 'single stale strike versus its same-event threshold neighbours',
  H31_hourly_crossasset_residual: 'hourly cross-asset probability residual after broad CEX movement',
  H32_opening_gap_repair: 'first-45-second resolver-open repricing gap',
  H33_signed_semivariance: 'signed realized-variance asymmetry versus symmetric digital sigma',
  H34_flow_absorption_reversal: 'aggressive CEX flow absorbed without spot progress',
  H35_depth_convexity_breakout: 'static depth slope exposes a shallow directional path',
  H36_sweep_replenishment_reversal: 'fade a token sweep after visible depth replenishment',
  H37_spread_shock_reversion: 'spread shock closes while terminal fair stays stable',
  H38_passive_flow_divergence: 'price moves against aggressor flow; follow passive information',
  H39_autocorrelation_regime: 'causal one-second serial dependence selects follow versus fade',
  H40_directional_entropy_breakout: 'low return-sign entropy identifies persistent discovery',
  H41_crossasset_dispersion_reversion: 'five-minute cross-sectional dispersion begins converging',
  H42_book_trade_disagreement: 'recent prints disagree with replenished book and terminal fair',
  H43_resolution_boundary_buffer: 'near-resolution entry clears volatility and resolver uncertainty',
  H44_hourly_midwindow_reversal: 'hourly displacement reverses with confirming aggressor flow',
  H45_threshold_distance_velocity: 'threshold probability lags sustained strike-distance velocity',
  H46_range_boundary_migration: 'daily bucket reprices after a confirmed boundary crossing',
  H47_network_binance_transport_arb: 'direct Binance leads Polymarket RTDS Binance transport',
  H48_network_chainlink_resolver_basis: 'Chainlink resolver network leads the Binance-derived fair',
  H49_network_coinbase_chainlink_quorum: 'Coinbase and Chainlink quorum versus a Binance outlier',
  H50_network_hyperliquid_chainlink_arb: 'Hyperliquid and Chainlink consensus before token repricing',
  H51_network_four_feed_median_arb: 'robust four-network median rejects one bad feed',
  FWD_H24_hourly_flow_breakout_v1: 'fresh unchanged H24 replication · discovery PnL excluded',
  FWD_H40_directional_entropy_breakout_v1: 'fresh unchanged H40 replication · discovery PnL excluded',
  FWD_H44_hourly_midwindow_reversal_v1: 'fresh unchanged H44 replication · discovery PnL excluded',
  FWD_H38_passive_flow_divergence_v1: 'fresh unchanged H38 replication · discovery PnL excluded',
  FWD_H15_jump_adjusted_sigma_v1: 'fresh unchanged H15 replication · discovery PnL excluded',
  FWD_H45_threshold_distance_velocity_v1: 'fresh unchanged H45 exploratory replication · discovery PnL excluded',
  FWD_H46_range_boundary_migration_v1: 'fresh unchanged H46 exploratory replication · discovery PnL excluded',
  FWD_H20_cross_venue_basis_reversion_v1: 'fresh unchanged H20 exploratory replication · discovery PnL excluded',
  FWD_H7_btc_oracle_confirm_v1: 'fresh unchanged H7 exploratory replication · discovery PnL excluded',
  FWD_H1_pair_arb_2x_v1: 'fresh unchanged H1 complement-lock replication · discovery PnL excluded',
});
const CAPACITY_SIZED_PILOTS = new Set([
  'H9_dual_book_microprice', 'H10_theta_lag', 'H11_liquidity_vacuum',
  'H12_cross_venue_consensus', 'H13_idiosyncratic_impulse',
  'H14_robust_volscore', 'H15_jump_adjusted_sigma', 'H16_cross_asset_volscore',
  'H17_opening_basis_consensus', 'H18_adaptive_beta_lag',
  'H19_clob_only_jump_fade', 'H20_cross_venue_basis_reversion',
  'H21_complement_desync',
  'H22_hourly_resolver_dislocation', 'H23_hourly_crossvenue_confirmation',
  'H24_hourly_flow_breakout', 'H25_horizon_vol_surface',
  'H26_nested_threshold_bundle', 'H27_disjoint_bucket_bundle',
  'H28_threshold_resolver_close', 'H29_range_resolver_close',
  'H30_threshold_ladder_residual', 'H31_hourly_crossasset_residual',
  'H32_opening_gap_repair', 'H33_signed_semivariance',
  'H34_flow_absorption_reversal', 'H35_depth_convexity_breakout',
  'H36_sweep_replenishment_reversal', 'H37_spread_shock_reversion',
  'H38_passive_flow_divergence', 'H39_autocorrelation_regime',
  'H40_directional_entropy_breakout', 'H41_crossasset_dispersion_reversion',
  'H42_book_trade_disagreement', 'H43_resolution_boundary_buffer',
  'H44_hourly_midwindow_reversal', 'H45_threshold_distance_velocity',
  'H46_range_boundary_migration', 'H47_network_binance_transport_arb',
  'H48_network_chainlink_resolver_basis', 'H49_network_coinbase_chainlink_quorum',
  'H50_network_hyperliquid_chainlink_arb', 'H51_network_four_feed_median_arb',
  'FWD_H24_hourly_flow_breakout_v1', 'FWD_H40_directional_entropy_breakout_v1',
  'FWD_H44_hourly_midwindow_reversal_v1', 'FWD_H38_passive_flow_divergence_v1',
  'FWD_H15_jump_adjusted_sigma_v1', 'FWD_H45_threshold_distance_velocity_v1',
  'FWD_H46_range_boundary_migration_v1', 'FWD_H20_cross_venue_basis_reversion_v1',
  'FWD_H7_btc_oracle_confirm_v1', 'FWD_H1_pair_arb_2x_v1',
]);
const INDEPENDENT_EVENT_PILOTS = new Set([
  'H22_hourly_resolver_dislocation', 'H23_hourly_crossvenue_confirmation',
  'H24_hourly_flow_breakout', 'H25_horizon_vol_surface',
  'H26_nested_threshold_bundle', 'H27_disjoint_bucket_bundle',
  'H28_threshold_resolver_close', 'H29_range_resolver_close',
  'H30_threshold_ladder_residual', 'H31_hourly_crossasset_residual',
  'H32_opening_gap_repair', 'H33_signed_semivariance',
  'H34_flow_absorption_reversal', 'H35_depth_convexity_breakout',
  'H36_sweep_replenishment_reversal', 'H37_spread_shock_reversion',
  'H38_passive_flow_divergence', 'H39_autocorrelation_regime',
  'H40_directional_entropy_breakout', 'H41_crossasset_dispersion_reversion',
  'H42_book_trade_disagreement', 'H43_resolution_boundary_buffer',
  'H44_hourly_midwindow_reversal', 'H45_threshold_distance_velocity',
  'H46_range_boundary_migration', 'H47_network_binance_transport_arb',
  'H48_network_chainlink_resolver_basis', 'H49_network_coinbase_chainlink_quorum',
  'H50_network_hyperliquid_chainlink_arb', 'H51_network_four_feed_median_arb',
  'FWD_H24_hourly_flow_breakout_v1', 'FWD_H40_directional_entropy_breakout_v1',
  'FWD_H44_hourly_midwindow_reversal_v1', 'FWD_H38_passive_flow_divergence_v1',
  'FWD_H15_jump_adjusted_sigma_v1', 'FWD_H45_threshold_distance_velocity_v1',
  'FWD_H46_range_boundary_migration_v1', 'FWD_H20_cross_venue_basis_reversion_v1',
  'FWD_H7_btc_oracle_confirm_v1', 'FWD_H1_pair_arb_2x_v1',
]);
for (const strategy of Object.keys(RESEARCH_PILOTS)) {
  const cadenceSplit = /__(sampled|event)$/.test(strategy);
  const independentEventPilot = INDEPENDENT_EVENT_PILOTS.has(strategy);
  EXPERIMENTS[strategy] = {
    label: cadenceSplit
      ? 'PILOT split · 300 independent signaled markets per arm · clustered CI'
      : independentEventPilot
        ? 'PILOT · 300 independent market events + 14d · clustered CI'
        : 'PILOT activity · resets at freeze · then 500 fills + 14d eval',
    target: cadenceSplit || independentEventPilot ? 300 : 500,
  };
}

router.get('/', authMiddleware, async (req, res) => {
  try {
    const q = (sql, params = []) => pool.query(sql, params).then((r) => r.rows).catch(() => []);

    const [
      settings, mainStrict, georgeRes, shadowStrategies, strategyRuntime, glaHeartbeat, glaLiveToday,
      collectorHeartbeat, runtimeHeartbeats, currentTrials,
    ] = await Promise.all([
      q(`SELECT paper_trading, paper_balance, george_paper_balance, exits_hold_only_mode,
                george_own_signal_enabled, george_resurrection_enabled, live_gla_enabled, live_gla_baseline_usdc,
                candidate_portfolio_enabled, portfolio_bankroll_usdc, main_exec_honest_anchor,
                main_legacy_execution_enabled, paper_risk_epoch_anchor, paper_risk_limits_enabled
         FROM bot_settings WHERE user_id = $1`, [req.userId]),
      q(`SELECT count(*) FILTER (WHERE status='closed') closed,
                count(*) FILTER (WHERE status='closed' AND pnl>0) wins,
                COALESCE(sum(pnl) FILTER (WHERE status='closed' AND ABS(pnl)<100000),0) pnl,
                count(*) FILTER (WHERE status='closed'
                  AND closed_at>=now()-interval '6 hours')::int closed_6h,
                COALESCE(sum(pnl) FILTER (WHERE status='closed'
                  AND ABS(pnl)<100000
                  AND closed_at>=now()-interval '6 hours'),0)::float pnl_6h,
                count(*) FILTER (WHERE status='closed'
                  AND closed_at>=now()-interval '24 hours')::int closed_24h,
                COALESCE(sum(pnl) FILTER (WHERE status='closed'
                  AND ABS(pnl)<100000
                  AND closed_at>=now()-interval '24 hours'),0)::float pnl_24h,
                count(*) FILTER (WHERE status='closed'
                  AND closed_at>=now()-interval '3 days')::int closed_3d,
                COALESCE(sum(pnl) FILTER (WHERE status='closed'
                  AND ABS(pnl)<100000
                  AND closed_at>=now()-interval '3 days'),0)::float pnl_3d,
                max(created_at) last_order_at
         FROM trades
         WHERE user_id=$1
           AND created_at >= COALESCE(
             (SELECT main_exec_honest_anchor FROM bot_settings WHERE user_id=$1), now())`, [req.userId]),
      q(`SELECT count(*) FILTER (WHERE status='closed') closed,
                count(*) FILTER (WHERE status='closed' AND pnl>0) wins,
                COALESCE(sum(pnl) FILTER (WHERE status='closed'),0) pnl,
                count(*) FILTER (WHERE status='closed'
                  AND closed_at>=now()-interval '6 hours')::int closed_6h,
                COALESCE(sum(pnl) FILTER (WHERE status='closed'
                  AND closed_at>=now()-interval '6 hours'),0)::float pnl_6h,
                count(*) FILTER (WHERE status='closed'
                  AND closed_at>=now()-interval '24 hours')::int closed_24h,
                COALESCE(sum(pnl) FILTER (WHERE status='closed'
                  AND closed_at>=now()-interval '24 hours'),0)::float pnl_24h,
                count(*) FILTER (WHERE status='closed'
                  AND closed_at>=now()-interval '3 days')::int closed_3d,
                COALESCE(sum(pnl) FILTER (WHERE status='closed'
                  AND closed_at>=now()-interval '3 days'),0)::float pnl_3d,
                max(created_at) last_order_at
         FROM george_trades WHERE user_id=$1 AND entry_mode='resurrection'`, [req.userId]),
      // AUTO-DISCOVERY: every strategy that ever placed a shadow order.
      q(`SELECT o.strategy,
                max(o.ts) last_order_at,
                count(*) FILTER (WHERE s.filled) fills,
                count(DISTINCT o.market_id) independent_markets,
                count(*) FILTER (WHERE s.filled AND m.asset <> 'hype') core_fills,
                count(*) FILTER (WHERE s.filled AND s.pnl_1x > 0) wins,
                COALESCE(sum(s.pnl_1x) FILTER (WHERE s.filled), 0) pnl,
                count(*) FILTER (WHERE s.filled AND o.phase = 'eval' AND m.asset <> 'hype') eval_core_fills,
                count(*) FILTER (WHERE s.filled AND o.phase = 'eval' AND m.asset <> 'hype' AND s.pnl_1x > 0) eval_core_wins,
                COALESCE(sum(s.pnl_1x) FILTER (WHERE s.filled AND o.phase = 'eval' AND m.asset <> 'hype'), 0) eval_core_pnl,
                count(*) FILTER (WHERE s.filled AND o.phase='eval' AND m.asset<>'hype'
                  AND COALESCE(o.available_at,o.ts)>=now()-interval '6 hours')::int eval_core_fills_6h,
                count(DISTINCT o.market_id) FILTER (WHERE s.filled AND o.phase='eval'
                  AND m.asset<>'hype'
                  AND COALESCE(o.available_at,o.ts)>=now()-interval '6 hours')::int eval_core_markets_6h,
                COALESCE(sum(s.pnl_1x) FILTER (WHERE s.filled AND o.phase='eval'
                  AND m.asset<>'hype'
                  AND COALESCE(o.available_at,o.ts)>=now()-interval '6 hours'),0)::float eval_core_pnl_6h,
                count(*) FILTER (WHERE s.filled AND o.phase='eval' AND m.asset<>'hype'
                  AND COALESCE(o.available_at,o.ts)>=now()-interval '24 hours')::int eval_core_fills_24h,
                count(DISTINCT o.market_id) FILTER (WHERE s.filled AND o.phase='eval'
                  AND m.asset<>'hype'
                  AND COALESCE(o.available_at,o.ts)>=now()-interval '24 hours')::int eval_core_markets_24h,
                COALESCE(sum(s.pnl_1x) FILTER (WHERE s.filled AND o.phase='eval'
                  AND m.asset<>'hype'
                  AND COALESCE(o.available_at,o.ts)>=now()-interval '24 hours'),0)::float eval_core_pnl_24h,
                count(*) FILTER (WHERE s.filled AND o.phase='eval' AND m.asset<>'hype'
                  AND COALESCE(o.available_at,o.ts)>=now()-interval '3 days')::int eval_core_fills_3d,
                count(DISTINCT o.market_id) FILTER (WHERE s.filled AND o.phase='eval'
                  AND m.asset<>'hype'
                  AND COALESCE(o.available_at,o.ts)>=now()-interval '3 days')::int eval_core_markets_3d,
                COALESCE(sum(s.pnl_1x) FILTER (WHERE s.filled AND o.phase='eval'
                  AND m.asset<>'hype'
                  AND COALESCE(o.available_at,o.ts)>=now()-interval '3 days'),0)::float eval_core_pnl_3d,
                max(o.ts) FILTER (WHERE o.features->>'research_capital_version' = $1) capital_last_order_at,
                count(*) FILTER (WHERE s.filled AND o.features->>'research_capital_version' = $1) capital_fills,
                count(DISTINCT o.market_id) FILTER (WHERE o.features->>'research_capital_version' = $1) capital_independent_markets,
                count(DISTINCT COALESCE(m.event_id, m.id::text))
                  FILTER (WHERE o.features->>'research_capital_version' = $1) capital_independent_events,
                count(*) FILTER (WHERE s.filled AND m.asset <> 'hype' AND o.features->>'research_capital_version' = $1) capital_core_fills,
                count(*) FILTER (WHERE s.filled AND s.pnl_1x > 0 AND o.features->>'research_capital_version' = $1) capital_wins,
                COALESCE(sum(s.pnl_1x) FILTER (WHERE s.filled AND o.features->>'research_capital_version' = $1), 0) capital_pnl,
                count(*) FILTER (WHERE s.filled
                  AND o.features->>'research_capital_version'=$1
                  AND COALESCE(o.available_at,o.ts)>=now()-interval '6 hours')::int capital_fills_6h,
                count(DISTINCT o.market_id) FILTER (WHERE s.filled
                  AND o.features->>'research_capital_version'=$1
                  AND COALESCE(o.available_at,o.ts)>=now()-interval '6 hours')::int capital_markets_6h,
                COALESCE(sum(s.pnl_1x) FILTER (WHERE s.filled
                  AND o.features->>'research_capital_version'=$1
                  AND COALESCE(o.available_at,o.ts)>=now()-interval '6 hours'),0)::float capital_pnl_6h,
                count(*) FILTER (WHERE s.filled
                  AND o.features->>'research_capital_version'=$1
                  AND COALESCE(o.available_at,o.ts)>=now()-interval '24 hours')::int capital_fills_24h,
                count(DISTINCT o.market_id) FILTER (WHERE s.filled
                  AND o.features->>'research_capital_version'=$1
                  AND COALESCE(o.available_at,o.ts)>=now()-interval '24 hours')::int capital_markets_24h,
                COALESCE(sum(s.pnl_1x) FILTER (WHERE s.filled
                  AND o.features->>'research_capital_version'=$1
                  AND COALESCE(o.available_at,o.ts)>=now()-interval '24 hours'),0)::float capital_pnl_24h,
                count(*) FILTER (WHERE s.filled
                  AND o.features->>'research_capital_version'=$1
                  AND COALESCE(o.available_at,o.ts)>=now()-interval '3 days')::int capital_fills_3d,
                count(DISTINCT o.market_id) FILTER (WHERE s.filled
                  AND o.features->>'research_capital_version'=$1
                  AND COALESCE(o.available_at,o.ts)>=now()-interval '3 days')::int capital_markets_3d,
                COALESCE(sum(s.pnl_1x) FILTER (WHERE s.filled
                  AND o.features->>'research_capital_version'=$1
                  AND COALESCE(o.available_at,o.ts)>=now()-interval '3 days'),0)::float capital_pnl_3d
         FROM borg_shadow_orders o
         LEFT JOIN borg_shadow_scores s ON s.order_id = o.id
         LEFT JOIN borg_markets m ON m.id = o.market_id
         WHERE o.action = 'place'
         GROUP BY 1 ORDER BY max(o.ts) DESC`, [RESEARCH_CAPITAL_VERSION]),
      q(`WITH latest AS (
           SELECT run_id FROM borg_collector_runs
            WHERE status='RUNNING' ORDER BY started_at DESC LIMIT 1
         )
         SELECT r.*, EXTRACT(EPOCH FROM now() - r.updated_at)::int age_sec
           FROM borg_strategy_runtime r JOIN latest l ON l.run_id=r.collector_run_id
          ORDER BY r.strategy`),
      q(`SELECT beat_at, EXTRACT(EPOCH FROM now() - beat_at)::int age_sec, meta
         FROM system_heartbeats WHERE component = 'gla_live'`),
      q(`SELECT count(*) FILTER (WHERE NOT dry_run AND status = 'PLACED') live_orders,
                COALESCE(sum(price*size) FILTER (WHERE NOT dry_run AND status = 'PLACED'), 0) live_spend,
                count(*) FILTER (WHERE status = 'ERROR') errors
         FROM gla_live_orders WHERE ts > date_trunc('day', now())`),
      q(`SELECT ts, EXTRACT(EPOCH FROM now() - ts)::int age_sec, message, data
         FROM borg_events WHERE source='heartbeat' ORDER BY ts DESC LIMIT 1`),
      q(`SELECT component, beat_at, EXTRACT(EPOCH FROM now() - beat_at)::int age_sec, meta
         FROM system_heartbeats WHERE component IN ('main_bot', 'george_bot')`),
      q(`WITH latest AS (
           SELECT DISTINCT ON (strategy) id,experiment_id,strategy,variant,family,phase,status,
                  status_reason,primary_metric,min_independent_markets,min_days,
                  frozen_at,evidence_started_at
             FROM borg_trial_ledger
            ORDER BY strategy,frozen_at DESC,id DESC
         ),
         active_epoch AS (
           SELECT r.epoch_id,e.started_at AS epoch_started_at
             FROM borg_collector_runs r
             JOIN borg_collection_epochs e ON e.epoch_id=r.epoch_id
            WHERE r.status='RUNNING'
            ORDER BY r.started_at DESC
            LIMIT 1
         )
         SELECT l.*,
                count(o.id) FILTER (WHERE o.action='place')::int intended_signals,
                count(DISTINCT o.market_id) FILTER (WHERE o.action='place')::int independent_markets,
                count(DISTINCT COALESCE(m.event_id,m.id::text)) FILTER (WHERE o.action='place')::int independent_events,
                count(DISTINCT (o.available_at AT TIME ZONE 'UTC')::date) FILTER (WHERE o.action='place')::int calendar_days,
                count(s.order_id) FILTER (WHERE o.action='place' AND s.filled)::int fills,
                count(s.order_id) FILTER (WHERE o.action='place' AND s.filled AND s.pnl_1x>0)::int wins,
                COALESCE(sum(s.pnl_1x) FILTER (WHERE o.action='place' AND s.filled),0)::float pnl_1x,
                COALESCE(sum(s.pnl_2x) FILTER (WHERE o.action='place' AND s.filled),0)::float pnl_2x,
                count(s.order_id) FILTER (WHERE o.action='place' AND s.filled
                  AND o.available_at>=now()-interval '6 hours')::int fills_6h,
                count(DISTINCT o.market_id) FILTER (WHERE o.action='place' AND s.filled
                  AND o.available_at>=now()-interval '6 hours')::int markets_6h,
                COALESCE(sum(s.pnl_1x) FILTER (WHERE o.action='place' AND s.filled
                  AND o.available_at>=now()-interval '6 hours'),0)::float pnl_1x_6h,
                COALESCE(sum(s.pnl_2x) FILTER (WHERE o.action='place' AND s.filled
                  AND o.available_at>=now()-interval '6 hours'),0)::float pnl_2x_6h,
                count(s.order_id) FILTER (WHERE o.action='place' AND s.filled
                  AND o.available_at>=now()-interval '24 hours')::int fills_24h,
                count(DISTINCT o.market_id) FILTER (WHERE o.action='place' AND s.filled
                  AND o.available_at>=now()-interval '24 hours')::int markets_24h,
                COALESCE(sum(s.pnl_1x) FILTER (WHERE o.action='place' AND s.filled
                  AND o.available_at>=now()-interval '24 hours'),0)::float pnl_1x_24h,
                COALESCE(sum(s.pnl_2x) FILTER (WHERE o.action='place' AND s.filled
                  AND o.available_at>=now()-interval '24 hours'),0)::float pnl_2x_24h,
                count(s.order_id) FILTER (WHERE o.action='place' AND s.filled
                  AND o.available_at>=now()-interval '3 days')::int fills_3d,
                count(DISTINCT o.market_id) FILTER (WHERE o.action='place' AND s.filled
                  AND o.available_at>=now()-interval '3 days')::int markets_3d,
                COALESCE(sum(s.pnl_1x) FILTER (WHERE o.action='place' AND s.filled
                  AND o.available_at>=now()-interval '3 days'),0)::float pnl_1x_3d,
                COALESCE(sum(s.pnl_2x) FILTER (WHERE o.action='place' AND s.filled
                  AND o.available_at>=now()-interval '3 days'),0)::float pnl_2x_3d,
                max(o.available_at) FILTER (WHERE o.action='place') last_signal_at
           FROM latest l
           LEFT JOIN active_epoch ae ON true
           LEFT JOIN borg_shadow_orders o
             ON o.experiment_id=l.experiment_id AND o.strategy=l.strategy
            AND COALESCE(o.arm,'baseline')=l.variant AND o.phase=l.phase
            AND o.available_at>=GREATEST(l.evidence_started_at,ae.epoch_started_at)
            AND o.features->>'collection_epoch_id'=ae.epoch_id
           LEFT JOIN borg_shadow_scores s ON s.order_id=o.id
            AND s.data_quality_grade IN ('A','B')
            AND s.execution_fidelity_grade IN ('A','B')
           LEFT JOIN borg_markets m ON m.id=o.market_id
          GROUP BY l.id,l.experiment_id,l.strategy,l.variant,l.family,l.phase,l.status,
                   l.status_reason,l.primary_metric,l.min_independent_markets,l.min_days,
                   l.frozen_at,l.evidence_started_at`),
    ]);

    const st = settings[0] || {};
    const bm = req.app.locals.botManager;
    const mainStatus = bm?.getBotStatus?.(req.userId) || null;
    const georgeStatus = bm?.getGeorgeBotStatus?.(req.userId) || null;
    const runtimeBeat = Object.fromEntries(runtimeHeartbeats.map((row) => [row.component, row]));
    const shadowRuntime = Object.fromEntries(strategyRuntime.map((row) => [row.strategy, row]));
    const currentTrial = Object.fromEntries(currentTrials.map((row) => [row.strategy, row]));

    const bots = [];

    // ── MAIN ──
    const ms = mainStrict[0] || {};
    bots.push({
      id: 'main', name: 'MAIN · LEGACY CONTROL', kind: 'paper',
      // mode drives the LIVE/PAPER badge — derived from the actual flag, never
      // hardcoded, so if paper_trading is ever flipped the UI turns red.
      mode: st.paper_trading === false ? 'live' : 'paper',
      subtitle: st.main_legacy_execution_enabled === true
        ? 'legacy paper execution explicitly enabled · not supported for promotion'
        : 'quote-relative heuristic retired from paper execution · telemetry control for MAIN V2',
      running: !!mainStatus?.botRunning || !!mainStatus?.isRunning,
      activity: {
        label: 'signal evaluator',
        lastAt: runtimeBeat.main_bot?.beat_at || null,
        lastOrderAt: ms.last_order_at || null,
      },
      risk: {
        dailyLossHalted: !!mainStatus?.dailyLossHalted,
        drawdownCooldownUntil: mainStatus?.drawdownCooldownUntil || null,
        paperRiskEpochAnchor: mainStatus?.paperRiskEpochAnchor || st.paper_risk_epoch_anchor || null,
        enabledInPaper: mainStatus?.paperRiskLimitsEnabled ?? st.paper_risk_limits_enabled === true,
      },
      // MAIN shares the same $500 promotion envelope as both ETH arms. Its
      // legacy paper_balance is deliberately not presented as available capital.
      balance: null,
      stats: {
        n: parseInt(ms.closed) || 0,
        wins: parseInt(ms.wins) || 0,
        winRate: ms.closed > 0 ? +((100 * ms.wins) / ms.closed).toFixed(1) : null,
        pnl: +parseFloat(ms.pnl || 0).toFixed(2),
        horizons: {
          h6: { n: parseInt(ms.closed_6h, 10) || 0, markets: null,
            pnl1x: +parseFloat(ms.pnl_6h || 0).toFixed(2), pnl2x: null },
          h24: { n: parseInt(ms.closed_24h, 10) || 0, markets: null,
            pnl1x: +parseFloat(ms.pnl_24h || 0).toFixed(2), pnl2x: null },
          d3: { n: parseInt(ms.closed_3d, 10) || 0, markets: null,
            pnl1x: +parseFloat(ms.pnl_3d || 0).toFixed(2), pnl2x: null },
        },
        window: 'fresh executable-fill cohort',
      },
      experiment: {
        label: 'fresh executable fills · adjusted CI + 2× costs',
        n: parseInt(ms.closed) || 0, target: 500,
      },
      settingsHint: { page: 'settings', note: 'Settings tab' },
    });

    // ── GEORGE ──
    const gr = georgeRes[0] || {};
    bots.push({
      id: 'george', name: 'GEORGE', kind: 'paper',
      mode: 'paper',
      subtitle: 'legacy source retired · RTDS successors H48/H49',
      running: !!georgeStatus?.isRunning,
      activity: {
        label: 'Chainlink evaluator',
        lastAt: runtimeBeat.george_bot?.beat_at || null,
        lastOrderAt: gr.last_order_at || null,
      },
      balance: parseFloat(st.george_paper_balance) || null,
      stats: {
        n: parseInt(gr.closed) || 0,
        wins: parseInt(gr.wins) || 0,
        winRate: gr.closed > 0 ? +((100 * gr.wins) / gr.closed).toFixed(1) : null,
        pnl: +parseFloat(gr.pnl || 0).toFixed(2),
        horizons: {
          h6: { n: parseInt(gr.closed_6h, 10) || 0, markets: null,
            pnl1x: +parseFloat(gr.pnl_6h || 0).toFixed(2), pnl2x: null },
          h24: { n: parseInt(gr.closed_24h, 10) || 0, markets: null,
            pnl1x: +parseFloat(gr.pnl_24h || 0).toFixed(2), pnl2x: null },
          d3: { n: parseInt(gr.closed_3d, 10) || 0, markets: null,
            pnl1x: +parseFloat(gr.pnl_3d || 0).toFixed(2), pnl2x: null },
        },
        window: 'resurrection cohort',
      },
      experiment: {
        label: 'retired invalid source · telemetry only',
        n: parseInt(gr.closed) || 0, target: null,
      },
      settingsHint: { page: 'george', note: 'George tab' },
    });

    // ── BORG strategies (auto-discovered) ──
    // G_late_arb live status is PROVEN, not assumed: the live executor beats
    // system_heartbeats('gla_live') every 10s and deletes the row on any
    // refusal/kill exit. LIVE badge = flag on + fresh heartbeat + not dry-run.
    const fs = require('fs');
    const glaStamp = fs.existsSync(require('path').join(__dirname, '../../borg/live/VERDICT_CONFIRMED'));
    const glaHb = glaHeartbeat[0];
    const glaAlive = glaHb && glaHb.age_sec != null && glaHb.age_sec < 120;
    const glaDry = glaHb?.meta?.dry === true;
    const glaPaper = glaAlive && glaDry;
    const glaLive = st.live_gla_enabled === true && glaAlive && !glaDry;
    const gt = glaLiveToday[0] || {};

    // GROUND-TRUTH BALANCE for the LIVE card: a live bot never shows a
    // simulated number. Read the real proxy-wallet USDC from Polygon; take a
    // P&L baseline at first funded observation (live pnl = wallet − baseline).
    // Re-baseline after a manual deposit: set live_gla_baseline_usdc to NULL.
    let glaWallet = null; let glaLivePnl = null;
    if (!glaPaper && st.live_gla_enabled === true && (glaAlive || glaStamp)) {
      try {
        const acct = JSON.parse(fs.readFileSync(
          require('path').join(require('os').homedir(), '.deltaforge-live/active-account.json'), 'utf8'));
        if (acct.funderAddress) {
          const { getLiveBalance, getPositionsValue } = require('../services/polygonBalance');
          const [cash, pos] = await Promise.all([
            getLiveBalance(acct), getPositionsValue(acct.funderAddress)]);
          // Equity = spendable cash + open-position value. Cash alone lies:
          // in-flight stake and payouts awaiting Polymarket's auto-redemption
          // (lags resolution by minutes) once showed −$50 on a flat book.
          glaWallet = cash ? {
            ...cash,
            positionsUsd: pos ? pos.usd : null,
            usd: pos ? +(cash.usd + pos.usd).toFixed(2) : cash.usd,
            cashUsd: cash.usd,
          } : null;
          const baseline = st.live_gla_baseline_usdc != null ? parseFloat(st.live_gla_baseline_usdc) : null;
          if (glaWallet && baseline == null && glaWallet.usd > 0 && !req.readOnly) {
            await q(`UPDATE bot_settings SET live_gla_baseline_usdc = $1 WHERE user_id = $2`,
              [glaWallet.usd, req.userId]);
            glaLivePnl = 0;
          } else if (glaWallet && baseline == null) {
            // A read-only dashboard must not establish accounting state.
            glaLivePnl = null;
          } else if (glaWallet && baseline != null) {
            glaLivePnl = +(glaWallet.usd - baseline).toFixed(2);
          }
        }
      } catch (_) { /* card falls back to no balance — never a fake one */ }
    }
    // Registered strategies must have cards before their first qualifying
    // order; otherwise a genuinely quiet fresh pilot is invisible.
    for (const strategy of [
      ...strategyRuntime.map((row) => row.strategy),
      ...currentTrials.map((row) => row.strategy),
      'ETH_late_taker', 'ETH_late_maker', ...Object.keys(RESEARCH_PILOTS),
    ]) {
      if (!shadowStrategies.some((row) => row.strategy === strategy)) {
        shadowStrategies.push({
          strategy, last_order_at: null, fills: 0, core_fills: 0, wins: 0, pnl: 0,
          independent_markets: 0,
          eval_core_fills: 0, eval_core_wins: 0, eval_core_pnl: 0,
          capital_last_order_at: null, capital_fills: 0, capital_core_fills: 0,
          capital_wins: 0, capital_pnl: 0, capital_independent_markets: 0,
          capital_independent_events: 0,
          registered_only: true,
        });
      }
    }
    const collectorAlive = collectorHeartbeat[0]?.age_sec != null
      && collectorHeartbeat[0].age_sec < 130;
    for (const row of shadowStrategies) {
      const exp = EXPERIMENTS[row.strategy];
      const isGla = row.strategy === 'G_late_arb';
      const isMainV2 = row.strategy === 'MAIN_V2_resolver_quorum';
      const isMainV3 = row.strategy === 'MAIN_V3_robust_source_envelope';
      const isMainV4 = row.strategy === 'MAIN_V4_warm_vol_temporal_consensus';
      const isPortfolioArm = row.strategy === 'ETH_late_taker' || row.strategy === 'ETH_late_maker';
      const isResearchPilot = Object.hasOwn(RESEARCH_PILOTS, row.strategy);
      const runtime = shadowRuntime[row.strategy] || null;
      const trial = currentTrial[row.strategy] || null;
      const trialCollecting = !trial || trial.status === 'COLLECTING';
      const waitingForCurrentCohort = trial
        ? (parseInt(trial.intended_signals, 10) || 0) === 0
        : !isGla && !row.capital_last_order_at;
      // G has a large profitable pilot followed by a negative frozen eval.
      // Never pool them on the operator card: that was making a losing current
      // cohort look safely profitable. HYPE is also excluded because neither
      // the original verdict nor the live mirror's current population covers it.
      const scoredFills = trial
        ? parseInt(trial.fills, 10) || 0
        : isGla ? parseInt(row.eval_core_fills) || 0 : parseInt(row.capital_fills) || 0;
      const scoredWins = trial
        ? parseInt(trial.wins, 10) || 0
        : isGla ? parseInt(row.eval_core_wins) || 0 : parseInt(row.capital_wins) || 0;
      const scoredPnl = trial
        ? parseFloat(trial.pnl_1x || 0)
        : isGla ? parseFloat(row.eval_core_pnl || 0) : parseFloat(row.capital_pnl || 0);
      const scoredPnl2x = trial ? parseFloat(trial.pnl_2x || 0) : null;
      const scopedHorizons = Object.fromEntries([
        ['h6', '6h'], ['h24', '24h'], ['d3', '3d'],
      ].map(([key, suffix]) => {
        const prefix = trial ? '' : isGla ? 'eval_core_' : 'capital_';
        return [key, {
          n: parseInt(trial
            ? trial[`fills_${suffix}`]
            : row[`${prefix}fills_${suffix}`], 10) || 0,
          markets: parseInt(trial
            ? trial[`markets_${suffix}`]
            : row[`${prefix}markets_${suffix}`], 10) || 0,
          pnl1x: +parseFloat(trial
            ? trial[`pnl_1x_${suffix}`] || 0
            : row[`${prefix}pnl_${suffix}`] || 0).toFixed(2),
          pnl2x: trial
            ? +parseFloat(trial[`pnl_2x_${suffix}`] || 0).toFixed(2)
            : null,
        }];
      }));
      // Runtime registration, not recent historical activity, defines whether
      // a shadow strategy is running. Quiet strategies can go >2h without a
      // valid signal; retired Vasili/A/A2 rows can remain recent after removal.
      const registeredNow = runtime
        ? runtime.age_sec != null && runtime.age_sec < 130
        : (isGla || isPortfolioArm || isResearchPilot);
      const active = registeredNow && collectorAlive;
      const glaMode = glaLive ? 'live'
        : glaPaper ? 'paper'
        : (st.live_gla_enabled === true && glaStamp) ? 'live-down'
        : (st.live_gla_enabled === true) ? 'armed' : 'shadow';
      bots.push({
        id: `borg:${row.strategy}`,
        name: isMainV4 ? 'MAIN V4 · WARM VOL + TEMPORAL CONSENSUS'
          : isMainV3 ? 'MAIN V3 · ROBUST SOURCE ENVELOPE'
          : isMainV2 ? 'MAIN V2 · RESOLVER QUORUM' : row.strategy,
        kind: 'shadow',
        mode: isGla && active ? glaMode : (isPortfolioArm && active ? 'paper' : 'shadow'),
        ...(isGla && glaLive ? { liveToday: {
          orders: parseInt(gt.live_orders) || 0,
          spend: +parseFloat(gt.live_spend || 0).toFixed(2),
          errors: parseInt(gt.errors) || 0,
        } } : {}),
        ...(isGla && ['live', 'live-down'].includes(glaMode) && glaWallet ? {
          liveWallet: { usd: glaWallet.usd, cash: glaWallet.cashUsd, positions: glaWallet.positionsUsd, stale: glaWallet.stale === true },
          livePnl: glaLivePnl,
        } : {}),
        subtitle: trial && !trialCollecting
          ? `${String(trial.status).replaceAll('_', ' ')} · ${trial.status_reason || 'frozen governance disposition'} · telemetry/control only · no live path`
          : trial?.phase === 'eval' && ['H43_resolution_boundary_buffer', 'H45_threshold_distance_velocity'].includes(row.strategy)
          ? `FROZEN FRESH EVAL · unchanged mechanism · discovery rows excluded · 300 independent markets + 14d · market/day clustered lower bounds · 2× costs · no live path${waitingForCurrentCohort ? ' · waiting for first qualifying signal' : ''}`
          : isMainV4
          ? `FRESH FORWARD PAPER SHADOW · 60-observation warmup · 10s/30s Binance/Coinbase/Chainlink consensus · max causal sigma · actual ask · 2× fees + one-tick hurdle · $${TARGET_STAKE_USD} max · no live path${waitingForCurrentCohort ? ' · waiting for first qualifying signal' : ''}`
          : isMainV3
          ? `FRESH FORWARD PAPER SHADOW · least-favourable Binance/Coinbase/Chainlink fair · resolver-lag veto · actual ask · 2× fees + one-tick hurdle · $${TARGET_STAKE_USD} max · no live path${waitingForCurrentCohort ? ' · waiting for first qualifying signal' : ''}`
          : isMainV2
          ? `FROZEN FORWARD PAPER SHADOW · resolver-aware event strategy · actual book · 2× cost gate · $${TARGET_STAKE_USD} max · no live path${waitingForCurrentCohort ? ' · waiting for first qualifying signal' : ''}`
          : isResearchPilot
          ? `SHADOW ${trial?.phase === 'eval' ? 'EVAL' : 'PILOT'} · ${RESEARCH_PILOTS[row.strategy]} · ${CAPACITY_SIZED_PILOTS.has(row.strategy) ? '$1–$10 capacity-sized, ≤20% touch' : '$10 max'} · $500 sizing notional · no live path${waitingForCurrentCohort ? ' · waiting for first qualifying signal' : ''}`
          : isPortfolioArm
          ? row.strategy === 'ETH_late_taker'
            ? `PAPER LIVE · candidate 2/3 · ETH late continuation · actual ask · $${TARGET_STAKE_USD} · $500 cohort${waitingForCurrentCohort ? ' · no qualifying signal yet' : ''}`
            : `PAPER LIVE · candidate 3/3 · ETH late continuation · back-of-queue maker · $${TARGET_STAKE_USD} · $500 cohort${waitingForCurrentCohort ? ' · no qualifying signal yet' : ''}`
          : isGla && glaLive
          ? '🔴 LIVE — real money · mirrors frozen shadow pilot · $10/leg'
          : isGla && glaPaper
          ? 'PAPER LIVE · dry-run mirror · frozen eval core only (pilot excluded)'
          : isGla && glaMode === 'live-down'
          ? '⚠ LIVE ENABLED BUT EXECUTOR DOWN — check gla-live.log'
          : isGla && glaMode === 'armed'
          ? 'ARMED for live — waiting on n=300 verdict CONFIRM'
          : active
          ? 'BORG shadow · tape-scored fills · params frozen (pre-registered)'
          : 'retired / dormant',
        running: active,
        runtime: runtime ? {
          registered: true,
          cadence: runtime.cadence,
          marketTypes: runtime.market_types,
          evaluations: parseInt(runtime.evaluations) || 0,
          haltedEvaluations: parseInt(runtime.halted_evaluations) || 0,
          actions: parseInt(runtime.actions) || 0,
          errors: parseInt(runtime.errors) || 0,
          lastEvaluatedAt: runtime.last_evaluated_at || null,
          collectorRunId: runtime.collector_run_id,
          collectionEpochId: runtime.epoch_id,
        } : { registered: false },
        activity: {
          label: isGla && glaPaper ? 'paper executor' : 'collector evaluator',
          lastAt: isGla && glaAlive ? glaHb?.beat_at : (runtime?.updated_at || collectorHeartbeat[0]?.ts),
          lastEvaluatedAt: runtime?.last_evaluated_at || null,
          lastOrderAt: isGla ? (row.last_order_at || null) : (row.capital_last_order_at || null),
        },
        // LIVE bots show the REAL on-chain wallet (or nothing) — never a
        // simulated number. Shadow strategies get a virtual paper account:
        // $500 base + current-capital-cohort tape-scored P&L.
        balance: isPortfolioArm
          ? null // both arms share the single $500 envelope shown above the cards
          : (isGla && ['live', 'live-down'].includes(glaMode))
          ? (glaWallet ? glaWallet.usd : null)
          : active ? +(STARTING_BANKROLL_USD + scoredPnl).toFixed(2) : null,
        stats: (isGla && glaLive) ? {
          n: parseInt(gt.live_orders) || 0,
          wins: null, winRate: null,
          pnl: glaLivePnl,
          horizons: null,
          window: glaLivePnl == null ? 'live session (unfunded — deposit to start)' : 'live session · wallet-based',
        } : {
          n: scoredFills,
          wins: scoredWins,
          winRate: scoredFills > 0 ? +((100 * scoredWins) / scoredFills).toFixed(1) : null,
          pnl: +scoredPnl.toFixed(2),
          horizons: scopedHorizons,
          window: trial ? `${trial.experiment_id} · ${trial.phase} · 1× P&L; 2× ${Number(scoredPnl2x || 0).toFixed(2)}`
            : isGla ? 'frozen eval core · pilot excluded'
            : isMainV4 ? 'fresh V4 eval only · all V3/discovery rows excluded'
            : isMainV3 ? 'fresh V3 eval only · all V2/discovery rows excluded'
            : isMainV2 ? 'fresh frozen eval only · all legacy/H49 rows excluded'
            : isResearchPilot ? 'pilot machinery only · not evidence'
            : 'all scored fills',
        },
        experiment: (active || isPortfolioArm) && (trial || exp) ? {
          label: trial
            ? `${trial.status} · ${trial.phase} · ${trial.primary_metric} · ${trial.calendar_days || 0}/${trial.min_days} UTC days`
            : exp.label,
          n: trial
            ? (parseInt(trial.independent_events, 10) || parseInt(trial.independent_markets, 10) || 0)
            : isGla ? scoredFills
            // Pilot rows are intentionally phase='pilot', so an eval-only
            // counter is always zero even while the card's scored n grows.
            // Display machinery activity here; the label makes clear that a
            // later parameter freeze resets the evidence clock to zero.
            : isResearchPilot
              ? (/__(sampled|event)$/.test(row.strategy) || INDEPENDENT_EVENT_PILOTS.has(row.strategy)
                ? (parseInt(INDEPENDENT_EVENT_PILOTS.has(row.strategy)
                  ? row.capital_independent_events : row.capital_independent_markets) || 0)
                : scoredFills)
            : (parseInt(row.capital_core_fills) || 0),
          target: trial ? parseInt(trial.min_independent_markets, 10) : exp.target,
        } : null,
        settingsHint: { page: 'borg', note: 'BORG tab (read-only: pilot params live in code)' },
      });
    }

    const portfolioPolicy = buildPortfolioPolicy(st.portfolio_bankroll_usdc || 500);
    const paperRiskLimitsEnabled = st.paper_risk_limits_enabled === true;
    res.json({
      bots,
      portfolio: {
        ...portfolioPolicy,
        riskLimitsEnabled: paperRiskLimitsEnabled,
        concurrencyAndExposureEnforced: paperRiskLimitsEnabled,
        researchCapitalVersion: RESEARCH_CAPITAL_VERSION,
        mode: paperRiskLimitsEnabled ? 'paper-validation-risk-limited' : 'paper-research-unbounded',
        liveReady: false,
        walletConflict: glaLive,
        promotionTargetFreshFills: 500,
        promotionMinDays: 14,
        note: !paperRiskLimitsEnabled
          ? 'The $500 value is a sizing notional only. Paper loss, balance, drawdown, concurrency, exposure and cooldown cutoffs are disabled; execution-validity checks remain.'
          : glaLive
          ? 'Existing G_late_arb live executor is outside this paper envelope and currently shares the wallet.'
          : 'Shared wallet envelope; no candidate is auto-promoted to live.',
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Drill-down history for a bot card. Shadow strategies: last scored fills.
// G_late_arb additionally returns the LIVE order audit trail (1:1 with
// shadow ids) so live-vs-shadow is reconcilable at a glance.
router.get('/:id/history', authMiddleware, async (req, res) => {
  try {
    const q = (sql, params = []) => pool.query(sql, params).then((r) => r.rows).catch(() => []);
    const id = String(req.params.id || '');
    const out = { id, sections: [] };
    if (id.startsWith('borg:')) {
      const strategy = id.slice(5);
      if (strategy === 'G_late_arb') {
        const live = await q(`
          SELECT g.ts, g.token, g.price, g.size, g.status, g.dry_run, left(g.error, 90) error,
                 m.asset, to_char(m.window_end, 'HH24:MI') window_end
          FROM gla_live_orders g
          LEFT JOIN borg_shadow_orders o ON o.id = g.shadow_order_id
          LEFT JOIN borg_markets m ON m.id = o.market_id
          ORDER BY g.id DESC LIMIT 60`);
        out.sections.push({ title: 'MIRROR AUDIT TRAIL (historical live + current dry-run)', kind: 'live', rows: live });
      }
      const evalOnly = strategy === 'G_late_arb';
      const fills = await q(`
        SELECT o.ts, m.asset, o.token, o.price, o.size, s.pnl_1x,
               CASE WHEN m.outcome = o.token THEN 'WIN' ELSE 'LOSS' END result
        FROM borg_shadow_orders o
        JOIN borg_shadow_scores s ON s.order_id = o.id AND s.filled
        LEFT JOIN borg_markets m ON m.id = o.market_id
        WHERE o.strategy = $1 AND o.action = 'place'
          ${evalOnly ? "AND o.phase = 'eval' AND m.asset <> 'hype'" : ''}
          ${evalOnly ? '' : "AND o.features->>'research_capital_version' = $2"}
        ORDER BY o.ts DESC LIMIT 80`, evalOnly
        ? [strategy]
        : [strategy, RESEARCH_CAPITAL_VERSION]);
      out.sections.push({
        title: evalOnly ? 'FROZEN EVAL CORE FILLS (pilot + HYPE excluded)' : 'SHADOW FILLS (tape-scored control)',
        kind: 'shadow', rows: fills,
      });
    } else if (id === 'main') {
      out.sections.push({ title: 'FRESH EXECUTABLE-FILL COHORT', kind: 'trades', rows: await q(`
        SELECT created_at ts, asset, direction, entry_price, trade_size amount, pnl, status, close_reason
        FROM trades
        WHERE user_id = $1
          AND created_at >= COALESCE(
            (SELECT main_exec_honest_anchor FROM bot_settings WHERE user_id=$1), now())
        ORDER BY id DESC LIMIT 80`, [req.userId]) });
    } else if (id === 'george') {
      out.sections.push({ title: 'RECENT TRADES', kind: 'trades', rows: await q(`
        SELECT created_at ts, asset, direction, entry_price, trade_size amount, pnl, status, entry_mode close_reason
        FROM george_trades WHERE user_id = $1 ORDER BY id DESC LIMIT 80`, [req.userId]) });
    }
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
