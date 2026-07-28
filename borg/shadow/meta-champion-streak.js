'use strict';

const { TARGET_STAKE_USD } = require('../research/capital-policy');
const {
  PERFORMANCE_CONFIG,
  SOURCE_STRATEGIES,
  buildPerformanceSnapshot,
} = require('../research/meta-champion-performance');

const STRATEGY_NAME = 'META_CHAMPION_STREAK_V1';
const STRATEGY_VERSION = 'meta-champion-streak-v1';
const MARKET_TYPES = Object.freeze([
  'direction_5m',
  'direction_15m',
  'direction_1h',
  'threshold_daily',
  'range_daily',
]);
const SELECTOR_CONFIG = Object.freeze({
  ...PERFORMANCE_CONFIG,
  confirmationSnapshots: 2,
  minimumDwellMs: 30 * 60 * 1000,
  // At a 50-cent binary, a one-cent quote move is approximately two percent
  // of entry capital. A challenger must clear that material difference.
  switchMarginReturn2x: 0.02,
  snapshotMaxAgeMs: 150 * 1000,
  maximumTouchParticipation: 0.20,
  maximumStakeUsd: TARGET_STAKE_USD,
  minimumOrderNotionalUsd: 1,
  firedMarketMemory: 5000,
});

function compactSummary(summary) {
  if (!summary) return null;
  return {
    strategy: summary.strategy,
    independentMarkets: summary.independentMarkets,
    wins: summary.wins,
    winRate: summary.winRate,
    winStreak: summary.winStreak,
    totalPnl2x: summary.totalPnl2x,
    averageReturn2x: summary.averageReturn2x,
    recentReturn2x: summary.recentReturn2x,
    lowerBoundReturn2x: summary.lowerBoundReturn2x,
    latestOutcomeAt: summary.latestOutcomeAt == null
      ? null
      : new Date(summary.latestOutcomeAt).toISOString(),
    qualifies: summary.qualifies,
    ineligibilityReasons: summary.ineligibilityReasons,
  };
}

class MetaChampionStreak {
  constructor({
    sourceStrategies = SOURCE_STRATEGIES,
    config = {},
  } = {}) {
    this.name = STRATEGY_NAME;
    this.cadence = 'sampled';
    this.marketTypes = [...MARKET_TYPES];
    this.isMetaStrategy = true;
    this.sourceStrategies = [...sourceStrategies];
    this.cfg = { ...SELECTOR_CONFIG, ...config };
    this._snapshot = buildPerformanceSnapshot([], {
      sourceStrategies: this.sourceStrategies,
      config: this.cfg,
      asOfMs: 0,
    });
    this._snapshotLoadedAtMs = 0;
    this._leader = null;
    this._leaderSinceMs = null;
    this._pending = null;
    this._firedMarkets = new Set();
    this._lastReason = 'performance_snapshot_not_loaded';
    this._counts = {
      evaluations: 0,
      mirrored: 0,
      noLeader: 0,
      staleSnapshot: 0,
      sourceNoAction: 0,
      unsafeSourceAction: 0,
      duplicateMarket: 0,
      sourceSwitches: 0,
    };
  }

  onHalt() {
    this._lastReason = 'feed_halt';
    return [];
  }

  /**
   * Called by the collector after a read-only DB snapshot. Repeated polling of
   * identical evidence never counts as a second confirmation.
   */
  updatePerformanceRows(rows, {
    asOfMs = Date.now(),
    loadedAtMs = Date.now(),
  } = {}) {
    const next = buildPerformanceSnapshot(rows, {
      sourceStrategies: this.sourceStrategies,
      config: this.cfg,
      asOfMs,
    });
    this._snapshotLoadedAtMs = loadedAtMs;
    const changed = next.fingerprint !== this._snapshot.fingerprint;
    this._snapshot = next;
    if (changed) this._updateSelection(asOfMs);
    return {
      changed,
      leader: this._leader,
      eligible: next.ranked.map((summary) => summary.strategy),
    };
  }

  _candidateEvidence(summary) {
    return summary
      ? `${summary.strategy}:${summary.independentMarkets}:${summary.latestOutcomeAt}:${summary.totalPnl2x.toFixed(8)}`
      : null;
  }

  _confirmCandidate(candidate, nowMs) {
    if (!candidate) {
      this._pending = null;
      return false;
    }
    const evidence = this._candidateEvidence(candidate);
    if (this._pending?.strategy !== candidate.strategy) {
      this._pending = {
        strategy: candidate.strategy,
        confirmations: 1,
        lastEvidence: evidence,
      };
      return false;
    }
    if (this._pending.lastEvidence !== evidence) {
      this._pending.confirmations += 1;
      this._pending.lastEvidence = evidence;
    }
    if (this._pending.confirmations < this.cfg.confirmationSnapshots) return false;
    const previous = this._leader;
    this._leader = candidate.strategy;
    this._leaderSinceMs = nowMs;
    this._pending = null;
    if (previous && previous !== this._leader) this._counts.sourceSwitches += 1;
    return true;
  }

  _updateSelection(nowMs) {
    const incumbent = this._leader
      ? this._snapshot.byStrategy.get(this._leader)
      : null;
    if (this._leader && !incumbent?.qualifies) {
      // A newly scored loss breaks a winning streak immediately. Continuing
      // to follow it would violate the strategy's stated mechanism.
      this._leader = null;
      this._leaderSinceMs = null;
      this._pending = null;
    }

    const candidate = this._snapshot.ranked[0] || null;
    if (!this._leader) {
      this._confirmCandidate(candidate, nowMs);
      this._lastReason = this._leader
        ? 'leader_activated'
        : (candidate ? 'leader_confirmation_pending' : 'no_qualifying_source');
      return;
    }

    const current = this._snapshot.byStrategy.get(this._leader);
    if (!candidate || candidate.strategy === this._leader) {
      this._pending = null;
      this._lastReason = 'leader_retained';
      return;
    }
    if (nowMs - this._leaderSinceMs < this.cfg.minimumDwellMs) {
      this._pending = null;
      this._lastReason = 'minimum_dwell';
      return;
    }
    if (!(candidate.score >= current.score + this.cfg.switchMarginReturn2x)) {
      this._pending = null;
      this._lastReason = 'challenger_margin';
      return;
    }
    this._confirmCandidate(candidate, nowMs);
    this._lastReason = this._leader === candidate.strategy
      ? 'leader_switched'
      : 'switch_confirmation_pending';
  }

  _rememberMarket(marketId) {
    this._firedMarkets.add(String(marketId));
    if (this._firedMarkets.size > this.cfg.firedMarketMemory) {
      this._firedMarkets.delete(this._firedMarkets.values().next().value);
    }
  }

  evaluate(ctx, engine) {
    this._counts.evaluations += 1;
    if (ctx.now - this._snapshotLoadedAtMs > this.cfg.snapshotMaxAgeMs) {
      this._counts.staleSnapshot += 1;
      this._lastReason = 'performance_snapshot_stale';
      return [];
    }
    if (!this._leader) {
      this._counts.noLeader += 1;
      this._lastReason = this._pending
        ? 'leader_confirmation_pending'
        : 'no_qualifying_source';
      return [];
    }

    const sourceActions = engine.sourceActionsForTick(this._leader);
    if (sourceActions.length === 0) {
      this._counts.sourceNoAction += 1;
      this._lastReason = 'leader_had_no_same_tick_action';
      return [];
    }
    const source = sourceActions.length === 1 ? sourceActions[0] : null;
    const marketId = source?.marketId ?? ctx.market?.id;
    const sameMarket = marketId != null && String(marketId) === String(ctx.market?.id);
    const safe = source
      && source.action === 'place'
      && source.side === 'BUY'
      && source.kind === 'taker'
      && !source.groupId
      && sameMarket
      && source.token != null
      && Number.isFinite(parseFloat(source.price))
      && parseFloat(source.price) > 0
      && parseFloat(source.price) < 1
      && Number.isFinite(parseFloat(source.size))
      && parseFloat(source.size) > 0
      && Number.isFinite(parseFloat(source.queueAhead))
      && parseFloat(source.queueAhead) > 0;
    if (!safe) {
      this._counts.unsafeSourceAction += 1;
      this._lastReason = sourceActions.length > 1
        ? 'multi_leg_source_rejected'
        : 'unsafe_source_action';
      return [];
    }
    if (this._firedMarkets.has(String(marketId))) {
      this._counts.duplicateMarket += 1;
      this._lastReason = 'one_meta_order_per_market';
      return [];
    }

    const price = parseFloat(source.price);
    const displayedTouch = parseFloat(source.queueAhead);
    const size = Math.min(
      parseFloat(source.size),
      this.cfg.maximumStakeUsd / price,
      displayedTouch * this.cfg.maximumTouchParticipation,
    );
    if (!(size > 0) || size * price < this.cfg.minimumOrderNotionalUsd) {
      this._counts.unsafeSourceAction += 1;
      this._lastReason = 'insufficient_executable_capacity';
      return [];
    }

    const performance = this._snapshot.byStrategy.get(this._leader);
    this._rememberMarket(marketId);
    this._counts.mirrored += 1;
    this._lastReason = 'mirrored_leader_action';
    return [{
      action: 'place',
      side: 'BUY',
      token: source.token,
      price,
      size,
      kind: 'taker',
      coid: engine._coid(this.name),
      queueAhead: displayedTouch,
      executionModel: 'latency_1s',
      thesisVersion: STRATEGY_VERSION,
      note: `meta_source=${this._leader} streak=${performance.winStreak} n=${performance.independentMarkets} lcb2x=${performance.lowerBoundReturn2x.toFixed(4)}`,
      features: {
        paper_only: true,
        dynamic_meta_strategy: true,
        meta_source_strategy: this._leader,
        meta_source_independent_markets: performance.independentMarkets,
        meta_source_win_streak: performance.winStreak,
        meta_source_win_rate: performance.winRate,
        meta_source_recent_return_2x: performance.recentReturn2x,
        meta_source_lower_bound_return_2x: performance.lowerBoundReturn2x,
        meta_performance_as_of: new Date(this._snapshot.asOfMs).toISOString(),
        meta_leader_since: new Date(this._leaderSinceMs).toISOString(),
        meta_selector_version: STRATEGY_VERSION,
        source_client_order_id: source.coid ?? null,
      },
    }];
  }

  diagnostics() {
    const leader = this._leader
      ? this._snapshot.byStrategy.get(this._leader)
      : null;
    return {
      paperOnly: true,
      selectorVersion: STRATEGY_VERSION,
      sourceUniverse: this.sourceStrategies,
      selectionConfig: {
        rollingMarkets: this.cfg.rollingMarkets,
        recentMarkets: this.cfg.recentMarkets,
        minimumResolvedMarkets: this.cfg.minimumResolvedMarkets,
        minimumWinStreak: this.cfg.minimumWinStreak,
        confirmationSnapshots: this.cfg.confirmationSnapshots,
        minimumDwellMs: this.cfg.minimumDwellMs,
        switchMarginReturn2x: this.cfg.switchMarginReturn2x,
        maximumStakeUsd: this.cfg.maximumStakeUsd,
      },
      performanceAsOf: this._snapshot.asOfMs
        ? new Date(this._snapshot.asOfMs).toISOString()
        : null,
      performanceLoadedAt: this._snapshotLoadedAtMs
        ? new Date(this._snapshotLoadedAtMs).toISOString()
        : null,
      leader: compactSummary(leader),
      leaderSince: this._leaderSinceMs
        ? new Date(this._leaderSinceMs).toISOString()
        : null,
      pending: this._pending,
      eligibleSources: this._snapshot.ranked.map(compactSummary),
      lastReason: this._lastReason,
      outcomes: { ...this._counts },
    };
  }
}

function makeMetaChampionStreakStrategies() {
  return [new MetaChampionStreak()];
}

module.exports = makeMetaChampionStreakStrategies;
module.exports._test = {
  MARKET_TYPES,
  SELECTOR_CONFIG,
  STRATEGY_NAME,
  STRATEGY_VERSION,
  MetaChampionStreak,
  compactSummary,
};
