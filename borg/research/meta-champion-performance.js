'use strict';

/**
 * Frozen source universe for the paper-only champion selector. The list is
 * intentionally limited to sampled, single-market hypotheses. Multi-leg
 * locks, passive makers and event-cadence strategies need different execution
 * semantics and cannot safely be copied by a generic allocator.
 */
const SOURCE_STRATEGIES = Object.freeze([
  'MAIN_VIDEO_PARITY_V1__taker250',
  'ETH_G_late_exact_forward_v1',
  'FWD_H24_hourly_flow_breakout_v1',
  'FWD_H40_directional_entropy_breakout_v1',
  'FWD_H44_hourly_midwindow_reversal_v1',
  'FWD_H38_passive_flow_divergence_v1',
  'FWD_H15_jump_adjusted_sigma_v1',
  'FWD_H45_threshold_distance_velocity_v1',
  'FWD_H46_range_boundary_migration_v1',
  'FWD_H20_cross_venue_basis_reversion_v1',
  'FWD_H7_btc_oracle_confirm_v1',
  'H56_hawkes_excitation_continuation',
  'H60_bipower_jump_envelope',
  'H61_vol_regime_envelope',
  'H62_threshold_isotonic_residual',
  'H63_range_simplex_residual',
  'H64_multivenue_cusum_break',
  'H65_kalman_latent_consensus',
  'H69_quarticity_confidence_envelope',
  'H70_stationary_block_bootstrap_digital',
  'H71_token_elasticity_residual',
  'H73_market_prior_calibration_residual',
  'H74_markov_regime_residual',
  'H75_4h_dynamic_liquidity_leadlag',
]);

const PERFORMANCE_CONFIG = Object.freeze({
  rollingMarkets: 40,
  recentMarkets: 10,
  minimumResolvedMarkets: 20,
  minimumWinStreak: 3,
  minimumMarketNotionalUsd: 1,
  // One-sided 80% lower bound. This is an allocation guard, not a claim of
  // significance; the meta-strategy's own promotion test remains 95%,
  // multiple-testing corrected and requires >=300 independent markets.
  lowerBoundZ: 1.2815515655446004,
});

function finite(value, fallback = null) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function finiteTime(value) {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function mean(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function sampleStandardDeviation(values, average = mean(values)) {
  if (values.length < 2 || average == null) return null;
  const variance = values.reduce(
    (sum, value) => sum + ((value - average) ** 2),
    0,
  ) / (values.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

function aggregateIndependentMarkets(rows, sourceSet, config) {
  const grouped = new Map();
  for (const row of rows || []) {
    const strategy = String(row.strategy || '');
    if (!sourceSet.has(strategy)) continue;
    const marketId = row.market_id ?? row.marketId;
    const pnl2x = finite(row.pnl_2x ?? row.pnl2x);
    const entryCash = finite(row.entry_cash ?? row.entryCash);
    const outcomeAt = finiteTime(
      row.outcome_at ?? row.outcomeAt ?? row.scored_at ?? row.scoredAt,
    );
    if (marketId == null || pnl2x == null || !(entryCash > 0) || outcomeAt == null) continue;
    const key = `${strategy}\u0000${marketId}`;
    const current = grouped.get(key) || {
      strategy,
      marketId: String(marketId),
      pnl2x: 0,
      entryCash: 0,
      fills: 0,
      outcomeAt: 0,
    };
    current.pnl2x += pnl2x;
    current.entryCash += entryCash;
    current.fills += Math.max(1, Math.trunc(finite(row.fills, 1)));
    current.outcomeAt = Math.max(current.outcomeAt, outcomeAt);
    grouped.set(key, current);
  }
  return [...grouped.values()]
    .filter((row) => row.entryCash >= config.minimumMarketNotionalUsd)
    .map((row) => ({ ...row, return2x: row.pnl2x / row.entryCash }));
}

function summarizeSource(strategy, markets, config) {
  const ordered = [...markets]
    .sort((left, right) =>
      left.outcomeAt - right.outcomeAt || left.marketId.localeCompare(right.marketId))
    .slice(-config.rollingMarkets);
  const returns = ordered.map((row) => row.return2x);
  const averageReturn2x = mean(returns);
  const standardDeviation = sampleStandardDeviation(returns, averageReturn2x);
  const standardError = standardDeviation == null
    ? null
    : standardDeviation / Math.sqrt(returns.length);
  const lowerBoundReturn2x = averageReturn2x == null || standardError == null
    ? null
    : averageReturn2x - config.lowerBoundZ * standardError;
  const recent = returns.slice(-config.recentMarkets);
  const split = Math.floor(returns.length / 2);
  const firstHalfReturn2x = mean(returns.slice(0, split));
  const secondHalfReturn2x = mean(returns.slice(split));
  let winStreak = 0;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    if (!(ordered[index].pnl2x > 0)) break;
    winStreak += 1;
  }

  const reasons = [];
  if (ordered.length < config.minimumResolvedMarkets) reasons.push('minimum_resolved_markets');
  if (recent.length < config.recentMarkets) reasons.push('minimum_recent_markets');
  if (winStreak < config.minimumWinStreak) reasons.push('winning_streak');
  if (!(mean(recent) > 0)) reasons.push('recent_return');
  if (!(firstHalfReturn2x > 0)) reasons.push('first_half_return');
  if (!(secondHalfReturn2x > 0)) reasons.push('second_half_return');
  if (!(lowerBoundReturn2x > 0)) reasons.push('conservative_lower_bound');

  return {
    strategy,
    independentMarkets: ordered.length,
    wins: ordered.filter((row) => row.pnl2x > 0).length,
    winRate: ordered.length
      ? ordered.filter((row) => row.pnl2x > 0).length / ordered.length
      : null,
    winStreak,
    totalPnl2x: ordered.reduce((sum, row) => sum + row.pnl2x, 0),
    totalEntryCash: ordered.reduce((sum, row) => sum + row.entryCash, 0),
    averageReturn2x,
    recentReturn2x: mean(recent),
    firstHalfReturn2x,
    secondHalfReturn2x,
    standardError,
    lowerBoundReturn2x,
    score: lowerBoundReturn2x,
    latestOutcomeAt: ordered.at(-1)?.outcomeAt ?? null,
    latestMarketId: ordered.at(-1)?.marketId ?? null,
    qualifies: reasons.length === 0,
    ineligibilityReasons: reasons,
  };
}

function buildPerformanceSnapshot(
  rows,
  {
    sourceStrategies = SOURCE_STRATEGIES,
    config = PERFORMANCE_CONFIG,
    asOfMs = Date.now(),
  } = {},
) {
  const mergedConfig = { ...PERFORMANCE_CONFIG, ...config };
  const sourceSet = new Set(sourceStrategies);
  const independent = aggregateIndependentMarkets(rows, sourceSet, mergedConfig);
  const bySource = new Map(sourceStrategies.map((strategy) => [strategy, []]));
  for (const row of independent) bySource.get(row.strategy)?.push(row);
  const summaries = sourceStrategies.map((strategy) =>
    summarizeSource(strategy, bySource.get(strategy) || [], mergedConfig));
  const ranked = summaries
    .filter((summary) => summary.qualifies)
    .sort((left, right) =>
      right.score - left.score
      || right.recentReturn2x - left.recentReturn2x
      || left.strategy.localeCompare(right.strategy));
  const fingerprint = independent
    .sort((left, right) =>
      left.strategy.localeCompare(right.strategy)
      || left.outcomeAt - right.outcomeAt
      || left.marketId.localeCompare(right.marketId))
    .map((row) =>
      `${row.strategy}:${row.marketId}:${row.outcomeAt}:${row.pnl2x.toFixed(8)}:${row.entryCash.toFixed(8)}`)
    .join('|');
  return {
    asOfMs,
    config: mergedConfig,
    fingerprint,
    byStrategy: new Map(summaries.map((summary) => [summary.strategy, summary])),
    ranked,
  };
}

async function loadPerformanceRows(pool, {
  sourceStrategies = SOURCE_STRATEGIES,
  epochId,
  epochStartedAt,
  asOf = new Date(),
} = {}) {
  if (!sourceStrategies.length) return [];
  const { rows } = await pool.query(`
    WITH current_trials AS (
      SELECT DISTINCT ON (strategy)
             strategy,experiment_id,status,evidence_started_at
        FROM borg_trial_ledger
       WHERE strategy = ANY($1::text[])
       ORDER BY strategy,frozen_at DESC,id DESC
    ),
    per_market AS (
      SELECT o.strategy,o.market_id,
             MAX(s.scored_at) AS outcome_at,
             SUM(s.pnl_2x)::double precision AS pnl_2x,
             SUM(s.fill_price * s.fill_size)::double precision AS entry_cash,
             COUNT(*)::int AS fills
        FROM borg_shadow_orders o
        JOIN borg_shadow_scores s ON s.order_id=o.id
        JOIN current_trials t
          ON t.strategy=o.strategy
         AND t.experiment_id=o.experiment_id
       WHERE o.strategy = ANY($1::text[])
         AND t.status='COLLECTING'
         AND o.action='place'
         AND o.order_kind='taker'
         AND o.side='BUY'
         AND s.filled=true
         AND s.data_quality_grade IN ('A','B')
         AND s.execution_fidelity_grade IN ('A','B')
         AND o.features->>'collection_epoch_id'=$2
         AND COALESCE(o.available_at,o.ts)
             >= GREATEST($3::timestamptz,t.evidence_started_at)
         AND s.scored_at <= $4::timestamptz
       GROUP BY o.strategy,o.market_id
    ),
    ranked AS (
      SELECT per_market.*,
             ROW_NUMBER() OVER (
               PARTITION BY strategy
               ORDER BY outcome_at DESC,market_id DESC
             ) AS recency_rank
        FROM per_market
    )
    SELECT strategy,market_id,outcome_at,pnl_2x,entry_cash,fills
      FROM ranked
     WHERE recency_rank <= $5
     ORDER BY strategy,outcome_at,market_id
  `, [
    sourceStrategies,
    epochId,
    epochStartedAt,
    asOf,
    PERFORMANCE_CONFIG.rollingMarkets,
  ]);
  return rows;
}

module.exports = {
  PERFORMANCE_CONFIG,
  SOURCE_STRATEGIES,
  aggregateIndependentMarkets,
  buildPerformanceSnapshot,
  finite,
  loadPerformanceRows,
  summarizeSource,
};
