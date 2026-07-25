/**
 * BORG shadow-execution engine — the evaluation harness of EVAL_PROTOCOL.md §1.
 *
 * Strategies log the exact order they WOULD place (side, price, size, full
 * feature vector, displayed size ahead of us at that level); the offline
 * scorer (score.js) later replays the recorded tape to decide fills. This
 * process places NO orders — it has no keys, no signing code, no execution
 * path, by construction.
 *
 * PILOT PHASE: strategy parameters live in strategies.js and are NOT frozen.
 * Per EVAL_PROTOCOL.md §3, everything logged before a tagged parameter-freeze
 * commit is a discarded pilot — it tunes the machinery, it is not evidence.
 * Rows are stamped phase='pilot' until the freeze flips a strategy to 'eval'.
 *
 * Phase is PER-STRATEGY: G_late_arb froze on its n=308 CONFIRM (2026-07-13,
 * this commit); newer strategies (e.g. Vasili) are still tuning and stay
 * 'pilot'. A single global flip would mislabel their rows as evidence.
 *
 * Halt rule (§7): if the Binance feed or the active book is stale, strategies
 * are paused, open shadow quotes are cancelled, and the pause is logged so
 * those windows can be excluded from scoring.
 */
const {
  RESEARCH_CAPITAL_VERSION,
  STARTING_BANKROLL_USD,
  RISK_PER_TRADE_PCT,
  TARGET_STAKE_USD,
} = require('../research/capital-policy');
const {
  EXECUTION_MODEL_VERSION,
  createOrderIntent,
} = require('../research/contracts');

const PHASES = {
  G_late_arb: 'eval',
  // Frozen by borg/experiments/main-v2-resolver-quorum-v1.json. This fallback
  // keeps isolated/unit-test engines correctly labelled when no registry is
  // injected; production still takes its version/hash from the manifest.
  MAIN_V2_resolver_quorum: 'eval',
  MAIN_V3_robust_source_envelope: 'eval',
  MAIN_V4_warm_vol_temporal_consensus: 'eval',
  // Fresh forward-only split. Asset selection was post-hoc; no historical
  // ETH row counts as evidence for these names. Parameters are frozen in the
  // 2026-07-14 three-candidate commit and must not change before the n=500 read.
  ETH_late_taker: 'eval',
  ETH_late_maker: 'eval',
  ETH_G_late_exact_forward_v1: 'eval',
}; // param-freeze commits add entries here
const PHASE = 'pilot'; // default for strategies not yet frozen

// Strategies mirrored live by borg/live/executor.js. Their 'place' rows are
// flushed to the DB immediately instead of on the 5s batch cadence: the
// executor refuses signals older than 5s, and batch delay alone was burning
// that whole budget (7 of 21 mirror attempts on 2026-07-13 died SKIPPED_STALE
// before the fresh-signal window ever reached the executor).
const LIVE_MIRRORED = new Set([
  'G_late_arb',
  'H53_5m_neareven_favorite_live_v1',
]);

class ShadowEngine {
  constructor({
    clob, insertRows, logEvent, strategies, experimentRegistry = null, decisionWal = null,
    collectionEpochId = process.env.BORG_COLLECTION_EPOCH_ID || 'legacy-unmarked',
    collectorRunId = process.env.BORG_COLLECTOR_RUN_ID || null,
  }) {
    this.clob = clob;
    this.insertRows = insertRows;
    this.logEvent = logEvent;
    this.strategies = strategies;
    this._strategyByName = new Map(strategies.map((strategy) => [strategy.name, strategy]));
    this.experimentRegistry = experimentRegistry;
    // Canonical decisions are appended synchronously before asynchronous DB
    // batching. PostgreSQL is the query/index layer, not the sole evidence.
    this.decisionWal = decisionWal;
    this.collectionEpochId = collectionEpochId;
    this.collectorRunId = collectorRunId;
    this.buf = [];
    this._haltedByAsset = new Map(); // keyed by asset:market; isolates one damaged book
    this._coidSeq = 0;
    this._runId = Date.now().toString(36);
    this.counters = { orders: 0, dropped: 0 };
    const startedAt = new Date();
    this._runtime = new Map(strategies.map((strategy) => [strategy.name, {
      strategy: strategy.name,
      cadence: strategy.cadence || 'sampled',
      marketTypes: strategy.marketTypes || ['direction_5m'],
      startedAt,
      lastEvaluatedAt: null,
      evaluations: 0,
      haltedEvaluations: 0,
      actions: 0,
      errors: 0,
      lastActionAt: null,
    }]));
  }

  _coid(strategy) {
    this._coidSeq += 1;
    return `${this._runId}-${strategy}-${this._coidSeq}`;
  }

  /**
   * Called from the collector's 1s tick ONCE PER ACTIVE MARKET with the same
   * snapshot values being recorded — shadow decisions and recon data cannot
   * diverge. ctx: { now, market, tteSec, upBook, downBook, upMid, phiFair,
   * sigma, btc, ref, gammaUp, feedStale, prints, upTokenId }
   * Halt rule (§7) is per-asset: a dead HYPE feed pauses HYPE quoting only.
   */
  tick(ctx, cadence = 'sampled') {
    const asset = ctx.market?.asset || 'btc';
    const marketType = ctx.market?.market_type || 'direction_5m';
    const haltKey = `${asset}:${ctx.market?.id ?? 'unknown'}`;
    // Quiet hourly/daily books can be unchanged for many seconds. Their
    // round-robin REST backup validates every token within ~16s, so 30s is a
    // conservative missing-state threshold. The latency-sensitive 5m cohort
    // retains its original 15s rule.
    const maxBookAgeMs = marketType === 'direction_5m' ? 15000 : 30000;
    const stale =
      ctx.feedStale === true ||
      !ctx.upBook || ctx.now - ctx.upBook.at > maxBookAgeMs ||
      !ctx.downBook || ctx.now - ctx.downBook.at > maxBookAgeMs;
    if (stale !== (this._haltedByAsset.get(haltKey) || false)) {
      this._haltedByAsset.set(haltKey, stale);
      this.logEvent(stale ? 'WARN' : 'INFO', 'shadow',
        stale ? `[${asset}:${marketType}] feeds stale — strategies paused (§7, window excluded)`
              : `[${asset}:${marketType}] feeds recovered — strategies resumed`);
    }
    this.halted = stale; // per-tick view for _features / strategies

    const features = this._features(ctx, cadence);
    for (const strat of this.strategies) {
      if ((strat.cadence || 'sampled') !== cadence) continue;
      // Legacy H1-H21 were designed and frozen against five-minute direction
      // contracts. New market families are opt-in so a wider collector cannot
      // silently change an old strategy's population.
      const allowedTypes = strat.marketTypes || ['direction_5m'];
      if (!allowedTypes.includes(marketType)) continue;
      const runtime = this._runtime.get(strat.name);
      runtime.evaluations += 1;
      runtime.lastEvaluatedAt = new Date(ctx.now);
      if (this.halted) runtime.haltedEvaluations += 1;
      let actions;
      try {
        actions = this.halted ? strat.onHalt(ctx) : strat.evaluate(ctx, this);
      } catch (err) {
        runtime.errors += 1;
        this.logEvent('ERROR', 'shadow', `${strat.name} threw: ${err.message}`);
        continue;
      }
      const actionList = actions || [];
      runtime.actions += actionList.length;
      if (actionList.length) runtime.lastActionAt = new Date(ctx.now);
      for (const a of actionList) this._record(strat.name, ctx, a, features);
    }
  }

  runtimeStatus() {
    return [...this._runtime.values()].map((row) => ({
      ...row,
      diagnostics: this._strategyByName.get(row.strategy)?.diagnostics?.() ?? null,
    }));
  }

  _features(ctx, cadence = 'sampled') {
    const top = (book, side) => book?.[side]?.[0] || [null, null];
    const [upBb, upBbSz] = top(ctx.upBook, 'bids');
    const [upBa, upBaSz] = top(ctx.upBook, 'asks');
    const [dnBb, dnBbSz] = top(ctx.downBook, 'bids');
    const [dnBa, dnBaSz] = top(ctx.downBook, 'asks');
    return {
      asset: ctx.market?.asset ?? 'btc',
      market_type: ctx.market?.market_type ?? 'direction_5m',
      timeframe_sec: ctx.market?.timeframe_sec ?? 300,
      event_id: ctx.market?.event_id ?? null,
      event_slug: ctx.market?.event_slug ?? null,
      strike: ctx.strike ?? null,
      lower_bound: ctx.lowerBound ?? null,
      upper_bound: ctx.upperBound ?? null,
      positive_label: ctx.market?.positive_label ?? 'UP',
      negative_label: ctx.market?.negative_label ?? 'DOWN',
      resolution_source: ctx.market?.resolution_source ?? null,
      information_cadence: cadence,
      trigger_source: ctx.triggerEvent?.source ?? (cadence === 'sampled' ? 'timer_1s' : null),
      trigger_event_type: ctx.triggerEvent?.eventType ?? null,
      trigger_source_ts: ctx.triggerEvent?.sourceMs ?? null,
      trigger_receive_wall_ms: ctx.triggerEvent?.receiveWallMs ?? null,
      trigger_receive_monotonic_ns: ctx.triggerEvent?.receiveMonoNs ?? null,
      trigger_connection_epoch: ctx.triggerEvent?.connectionEpoch ?? null,
      trigger_event_sequence: ctx.triggerEvent?.eventSequence ?? null,
      trigger_wal_event_id: ctx.triggerEvent?.walEventId ?? null,
      decision_delay_ms: ctx.triggerEvent?.receiveWallMs != null
        ? Math.max(0, ctx.now - ctx.triggerEvent.receiveWallMs)
        : 0,
      collection_epoch_id: this.collectionEpochId,
      collector_run_id: this.collectorRunId,
      research_capital_version: RESEARCH_CAPITAL_VERSION,
      research_starting_bankroll_usd: STARTING_BANKROLL_USD,
      research_risk_per_trade_pct: RISK_PER_TRADE_PCT,
      research_target_stake_usd: TARGET_STAKE_USD,
      phi_fair: ctx.phiFair, model_fair_positive: ctx.modelFairPositive,
      sigma: ctx.sigma, btc: ctx.btc, ref: ctx.ref, cex_ref: ctx.cexRef,
      gamma_up: ctx.gammaUp,
      cex_ret_10s_bps: ctx.micro10?.returnBps ?? null,
      cex_ret_30s_bps: ctx.micro30?.returnBps ?? null,
      cex_flow_10s: ctx.micro10?.flowImbalance ?? null,
      cex_flow_30s: ctx.micro30?.flowImbalance ?? null,
      cex_depth_imb: ctx.micro10?.depthImbalance ?? null,
      cex_trades_10s: ctx.micro10?.trades ?? null,
      robust_sigma_5m: ctx.volatility?.robustSigma5m ?? null,
      rms_sigma_5m: ctx.volatility?.rmsSigma5m ?? null,
      sigma_ewma_to_robust: ctx.volatility?.ewmaToRobust ?? null,
      max_return_variance_share: ctx.volatility?.maxVarianceShare ?? null,
      vol_observations: ctx.volatility?.observations ?? null,
      oracle_price: ctx.oraclePrice ?? null,
      oracle_ref: ctx.oracleRef ?? null,
      rtds_chainlink: ctx.rtdsChainlink ?? null,
      rtds_chainlink_ret_10s_bps: ctx.rtdsChainlink10?.returnBps ?? null,
      rtds_chainlink_ret_30s_bps: ctx.rtdsChainlink30?.returnBps ?? null,
      rtds_binance: ctx.rtdsBinance ?? null,
      rtds_binance_ret_10s_bps: ctx.rtdsBinance10?.returnBps ?? null,
      rtds_binance_ret_30s_bps: ctx.rtdsBinance30?.returnBps ?? null,
      rtds_binance_age_ms: ctx.rtdsBinanceAgeMs ?? null,
      resolver_divergence_bps: ctx.resolverDivergence?.absBps ?? null,
      resolver_divergence_signed: ctx.resolverDivergence?.signed ?? null,
      resolver_tick_age_ms: ctx.resolverDivergence?.ageMs ?? null,
      venue_price: ctx.venuePrice ?? null,
      venue_ret_10s_bps: ctx.venue10?.returnBps ?? null,
      venue_ret_30s_bps: ctx.venue30?.returnBps ?? null,
      venue_stale: ctx.venueStale ?? null,
      hyperliquid_price: ctx.hyperPrice ?? null,
      hyperliquid_ret_10s_bps: ctx.hyper10?.returnBps ?? null,
      hyperliquid_ret_30s_bps: ctx.hyper30?.returnBps ?? null,
      hyperliquid_stale: ctx.hyperStale ?? null,
      up_bb: upBb, up_bb_sz: upBbSz, up_ba: upBa, up_ba_sz: upBaSz,
      down_bb: dnBb, down_bb_sz: dnBbSz, down_ba: dnBa, down_ba_sz: dnBaSz,
      book_src: ctx.upBook?.src ?? null, book_age_ms: ctx.upBook ? ctx.now - ctx.upBook.at : null,
      halted: this.halted,
    };
  }

  /** Displayed size resting at exactly `price` on `side` of `book` — our queue-ahead. */
  static queueAhead(book, side, price) {
    if (!book?.[side]) return 0;
    for (const [p, s] of book[side]) {
      if (Math.abs(p - price) < 1e-9) return s;
    }
    return 0;
  }

  _record(strategy, ctx, a, features) {
    // a: {action:'place'|'cancel', side, token, price, size, kind:'maker'|'taker', coid, note}
    const binding = this.experimentRegistry?.resolve(strategy) || null;
    const phase = binding?.phase || PHASES[strategy] || PHASE;
    const sourceEventId = features.trigger_wal_event_id
      || (features.trigger_source && features.trigger_event_sequence != null
        ? `${features.trigger_source}:${features.trigger_event_sequence}`
        : null);
    const executionModel = a.executionModel || (a.kind === 'maker' ? 'maker_queue_v1' : 'latency_1s');
    const now = new Date(ctx.now);
    const intent = createOrderIntent({
      strategy,
      strategyVersion: binding?.strategyVersion || 'pilot-unversioned',
      experimentId: binding?.experimentId || null,
      manifestHash: binding?.manifestHash || null,
      trialFamily: binding?.family || null,
      arm: binding?.arm || 'baseline',
      action: a.action,
      marketId: a.marketId ?? ctx.market?.id,
      token: a.token ?? null,
      side: a.side ?? null,
      orderKind: a.kind ?? null,
      price: a.price ?? null,
      size: a.size ?? null,
      decisionAt: now,
      availableAt: now,
      sourceEventId,
      executionModelVersion: EXECUTION_MODEL_VERSION,
      latencyProfile: executionModel,
      metadata: { clientOrderId: a.coid || null, groupId: a.groupId || null, phase },
    });
    const storedFeatures = a.action === 'cancel'
      ? {
          note: a.note ?? undefined,
          research_capital_version: RESEARCH_CAPITAL_VERSION,
          research_starting_bankroll_usd: STARTING_BANKROLL_USD,
          research_risk_per_trade_pct: RISK_PER_TRADE_PCT,
          research_target_stake_usd: TARGET_STAKE_USD,
          collection_epoch_id: this.collectionEpochId,
          collector_run_id: this.collectorRunId,
        }
      : {
          ...features,
          ...(a.features || {}),
          note: a.note ?? undefined,
          execution_model: executionModel,
          group_id: a.groupId ?? undefined,
          thesis_version: a.thesisVersion ?? undefined,
          experiment_id: binding?.experimentId ?? null,
          manifest_hash: binding?.manifestHash ?? null,
          intent_contract_version: intent.contractVersion,
        };
    const row = [
      now, strategy, phase,
      a.marketId ?? ctx.market?.id ?? null, a.tteSec ?? ctx.tteSec ?? null,
      a.action, a.side ?? null, a.token ?? null, a.price ?? null, a.size ?? null,
      a.kind ?? null, a.queueAhead ?? null, a.coid,
      JSON.stringify(storedFeatures),
      intent.intentId, intent.experimentId, intent.manifestHash,
      new Date(intent.decisionAt), new Date(intent.availableAt), intent.sourceEventId,
      intent.strategyVersion, intent.executionModelVersion, intent.latencyProfile,
      intent.trialFamily, intent.arm,
    ];
    if (this.decisionWal) {
      this.decisionWal.append(JSON.stringify({
        type: 'order_intent', intent, phase,
        tte_sec: a.tteSec ?? ctx.tteSec ?? null,
        queue_ahead: a.queueAhead ?? null,
        client_order_id: a.coid || null,
        features: storedFeatures,
      }), {
        channel: 'shadow-decision',
        sourceMs: now.getTime(),
        connectionEpoch: features.trigger_connection_epoch || 0,
      });
    }
    this.buf.push(row);
    if (this.buf.length > 5000) { this.buf.shift(); this.counters.dropped += 1; }
    if (a.action === 'place' && LIVE_MIRRORED.has(strategy)) {
      // fire-and-forget: flush() splices the buffer, so racing the 5s timer
      // is safe — whichever runs first takes the rows
      this.flush().catch(() => {});
    }
  }

  /** Flush on the collector's 5s cadence. The WAL is authoritative on failure. */
  async flush() {
    const rows = this.buf.splice(0);
    if (!rows.length) return 0;
    try {
      const n = await this.insertRows('borg_shadow_orders', [
        'ts', 'strategy', 'phase', 'market_id', 'tte_sec',
        'action', 'side', 'token', 'price', 'size',
        'order_kind', 'queue_ahead', 'client_order_id', 'features',
        'intent_id', 'experiment_id', 'manifest_hash', 'decision_at', 'available_at',
        'source_event_id', 'strategy_version', 'execution_model_version',
        'latency_profile', 'trial_family', 'arm',
      ], rows);
      this.counters.orders += n;
      return n;
    } catch (err) {
      // Retain a bounded retry queue. The durable WAL remains recoverable if
      // the process exits or sustained failure exceeds the memory bound.
      this.buf.unshift(...rows);
      if (this.buf.length > 5000) {
        const overflow = this.buf.length - 5000;
        this.buf.splice(0, overflow);
        this.counters.dropped += overflow;
      }
      await this.logEvent('ERROR', 'shadow', `order flush failed (${rows.length} retained for retry): ${err.message}`);
      return 0;
    }
  }
}

module.exports = ShadowEngine;
