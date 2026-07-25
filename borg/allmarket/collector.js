#!/usr/bin/env node
'use strict';

/**
 * All-market pre-trade L2 and passive-making laboratory.
 *
 * PAPER/SHADOW ONLY. This process deliberately imports no wallet, signer,
 * authenticated CLOB client, or order-posting function. Public market frames
 * are appended to a local WAL before ClobRecon parses them. Decisions and
 * simulated executions are appended to a second WAL and persisted to
 * PostgreSQL asynchronously; PostgreSQL is never in the event hot path.
 */

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const ClobMultiplex = require('../recon/clob-multiplex');
const RawWal = require('../recon/wal');
const {
  pool, migrateAllMarket, insertRows, logEvent,
} = require('../recon/db');
const { syncExperimentRegistry } = require('../research/experiment-registry');
const capital = require('../research/capital-policy');
const {
  NEGLECTED_PANEL_VERSION,
  discoverUniverse,
  neglectedPanelHash,
  selectNeglectedPanel,
  selectRealtimePanel,
} = require('./universe');
const {
  advanceQueue, clampPrice, costConfirmedTaker, createQueueState,
  dataQuality, evaluateL2Predictor, finite, makerQuote, markoutPnl,
  microstructure, walkAsk, walkBid,
} = require('./strategy');

const EXPERIMENT_ID = 'allmarket-l2-maker-v2';
const RUN_ID = `allmarket:${os.hostname()}:${new Date().toISOString()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
const LATENCY_PROFILES_MS = String(process.env.ALLMARKET_LATENCY_PROFILES_MS || '20,50,100,250,500')
  .split(',').map(Number).filter((value) => Number.isInteger(value) && value >= 0 && value <= 5000);
const MAX_MARKETS = Math.max(2, Number(process.env.ALLMARKET_MAX_MARKETS || 10));
const MAX_CAPITAL_PER_MARKET = Math.max(5, Number(process.env.ALLMARKET_MAX_CAPITAL_PER_MARKET || 50));
const CATALYST_GUARD_HOURS = Math.max(0, Number(process.env.ALLMARKET_CATALYST_GUARD_HOURS || 6));
const NO_FAIR_FEED_GUARD_HOURS = Math.max(CATALYST_GUARD_HOURS,
  Number(process.env.ALLMARKET_NO_FAIR_FEED_GUARD_HOURS || 24));
const PANEL_MODE = String(process.env.ALLMARKET_PANEL_MODE || 'legacy').toLowerCase();
// A neglected panel is frozen for the evidence epoch. Rebuilding the complete
// 80k+ Gamma universe every five minutes adds API load without changing panel
// membership; thirty minutes is sufficient metadata refresh cadence.
const REFRESH_MS = Math.max(60_000, Number(process.env.ALLMARKET_REFRESH_MS
  || (PANEL_MODE === 'neglected' ? 1_800_000 : 300_000)));
const UNIVERSE_MAX_STALE_MS = Math.max(REFRESH_MS * 3,
  Number(process.env.ALLMARKET_UNIVERSE_MAX_STALE_MS || 7_200_000));
const STALE_MS = Math.max(100, Number(process.env.ALLMARKET_STALE_MS || 750));
const MAKER_QUOTE_LIFETIME_MS = Math.max(1000, Number(process.env.ALLMARKET_MAKER_QUOTE_LIFETIME_MS || 30_000));
const PERSIST_LIMIT = Math.max(10_000, Number(process.env.ALLMARKET_PERSIST_LIMIT || 100_000));
const PERSIST_MARKETS = Math.max(MAX_MARKETS, Number(process.env.ALLMARKET_PERSIST_MARKETS || 5000));
// The append-before-process WAL is the full-fidelity replay source. PostgreSQL
// is only the recent-query hot tier, so persist at most one derived touch per
// token per interval. Strategy evaluation remains event-driven and unchanged.
const SQL_TOUCH_MIN_INTERVAL_MS = Math.max(20,
  Number(process.env.ALLMARKET_SQL_TOUCH_MIN_INTERVAL_MS || 100));
const STRATEGY_SIGNALS_ENABLED = process.env.ALLMARKET_STRATEGY_SIGNALS_ENABLED !== 'false';
const COLLECTION_EPOCH_ID = process.env.BORG_COLLECTION_EPOCH_ID || 'allmarket-unmarked';

const TOUCH_COLUMNS = [
  'observed_at', 'source_ts', 'condition_id', 'asset_id', 'outcome',
  'best_bid', 'bid_size', 'best_ask', 'ask_size', 'midpoint', 'microprice',
  'imbalance', 'spread', 'state_age_ms', 'reaction_us', 'data_quality_grade',
  'event_type', 'connection_epoch', 'connection_shard', 'event_sequence',
  'wal_event_id', 'book_hash',
];
const INTENT_COLUMNS = [
  'intent_id', 'run_id', 'experiment_id', 'strategy', 'arm', 'action',
  'parent_intent_id', 'decision_at', 'available_at', 'condition_id', 'asset_id',
  'outcome', 'side', 'order_kind', 'post_only', 'price', 'size', 'latency_ms',
  'queue_ahead', 'source_event_id', 'reaction_us', 'data_quality_grade',
  'status', 'features',
];
const SCORE_COLUMNS = [
  'intent_id', 'filled', 'fill_at', 'fill_price', 'fill_size', 'fill_reason',
  'queue_ahead_initial', 'printed_volume', 'mark_1s', 'mark_5s', 'mark_30s',
  'pnl_1s', 'pnl_5s', 'pnl_30s', 'rebate_estimate', 'reward_estimate',
  'data_quality_grade', 'execution_fidelity_grade', 'fidelity_level',
  'simulator_version', 'fee_model_version', 'detail', 'scored_at',
];
const MARKET_COLUMNS = [
  'condition_id', 'gamma_id', 'event_id', 'event_slug', 'slug', 'question', 'category', 'end_date',
  'outcomes', 'token_ids', 'tick_size', 'order_min_size', 'liquidity', 'volume_24h', 'fees_enabled',
  'fee_rate', 'fee_exponent', 'fee_taker_only', 'rebate_rate', 'rewards_daily_rate',
  'rewards_min_size', 'rewards_max_spread', 'toxicity_5s_per_share', 'selection_score',
  'selection_reason', 'selected_realtime', 'active', 'accepting_orders', 'raw', 'refreshed_at',
];
const SCORE_CONFLICT = `ON CONFLICT (intent_id) DO UPDATE SET
  filled=EXCLUDED.filled, fill_at=COALESCE(EXCLUDED.fill_at,am_execution_scores.fill_at),
  fill_price=COALESCE(EXCLUDED.fill_price,am_execution_scores.fill_price),
  fill_size=COALESCE(EXCLUDED.fill_size,am_execution_scores.fill_size),
  fill_reason=COALESCE(EXCLUDED.fill_reason,am_execution_scores.fill_reason),
  queue_ahead_initial=COALESCE(EXCLUDED.queue_ahead_initial,am_execution_scores.queue_ahead_initial),
  printed_volume=COALESCE(EXCLUDED.printed_volume,am_execution_scores.printed_volume),
  mark_1s=COALESCE(EXCLUDED.mark_1s,am_execution_scores.mark_1s),
  mark_5s=COALESCE(EXCLUDED.mark_5s,am_execution_scores.mark_5s),
  mark_30s=COALESCE(EXCLUDED.mark_30s,am_execution_scores.mark_30s),
  pnl_1s=COALESCE(EXCLUDED.pnl_1s,am_execution_scores.pnl_1s),
  pnl_5s=COALESCE(EXCLUDED.pnl_5s,am_execution_scores.pnl_5s),
  pnl_30s=COALESCE(EXCLUDED.pnl_30s,am_execution_scores.pnl_30s),
  data_quality_grade=EXCLUDED.data_quality_grade,
  execution_fidelity_grade=EXCLUDED.execution_fidelity_grade,
  detail=am_execution_scores.detail || EXCLUDED.detail, scored_at=EXCLUDED.scored_at`;

function reactionUs(receiveMonoNs) {
  try { return Number(process.hrtime.bigint() - BigInt(receiveMonoNs)) / 1000; } catch (_) { return null; }
}

function iso(ms) { return new Date(ms); }

function json(value) { return JSON.stringify(value ?? {}); }

function intentId(prefix = 'intent') {
  return `${prefix}:${Date.now()}:${crypto.randomUUID()}`;
}

function boundedPush(buffer, row, metrics) {
  buffer.push(row);
  if (buffer.length > PERSIST_LIMIT) {
    buffer.splice(0, Math.ceil(PERSIST_LIMIT / 10));
    metrics.persistenceDrops += 1;
  }
}

function lastRowsByKey(rows, keyFn) {
  const unique = new Map();
  for (const row of rows) unique.set(keyFn(row), row);
  return [...unique.values()];
}

function mergeJson(left, right) {
  try {
    const a = typeof left === 'string' ? JSON.parse(left) : (left || {});
    const b = typeof right === 'string' ? JSON.parse(right) : (right || {});
    return JSON.stringify({ ...a, ...b });
  } catch (_) {
    return right ?? left;
  }
}

function coalesceScoreRows(rows) {
  const unique = new Map();
  for (const row of rows) {
    const prior = unique.get(row[0]);
    if (!prior) {
      unique.set(row[0], [...row]);
      continue;
    }
    for (let index = 1; index < row.length; index += 1) {
      if (index === 21) prior[index] = mergeJson(prior[index], row[index]);
      else if (row[index] != null) prior[index] = row[index];
    }
  }
  return [...unique.values()];
}

function percentile(values, probability) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * probability))];
}

function isTransientUniverseError(error) {
  const code = String(error?.code || '').toUpperCase();
  const name = String(error?.name || '').toUpperCase();
  const message = String(error?.message || error || '').toLowerCase();
  return name === 'ABORTERROR'
    || ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENETUNREACH'].includes(code)
    || /(?:operation was aborted|timed? ?out|fetch failed|socket hang up)/.test(message);
}

function universeRefreshSeverity({
  error, selectedMarkets, consecutiveTimeouts, lastSuccessAt, now = Date.now(),
  maxStaleMs = UNIVERSE_MAX_STALE_MS,
}) {
  const lastSuccessMs = Number(lastSuccessAt);
  const staleMs = Number.isFinite(lastSuccessMs) ? Math.max(0, now - lastSuccessMs) : Infinity;
  return isTransientUniverseError(error)
    && Number(selectedMarkets) > 0
    && Number(consecutiveTimeouts) < 3
    && staleMs <= maxStaleMs
    ? 'WARN'
    : 'ERROR';
}

class AllMarketLab {
  constructor() {
    this.startedAt = Date.now();
    this.markets = new Map();
    this.tokenMeta = new Map();
    this.openQuotes = new Map();
    this.inventory = new Map();
    this.lastPredictor = new Map();
    this.lastSqlTouchAt = new Map();
    this.lastSequence = new Map();
    this.pendingMarkouts = new Map();
    this.panelHash = null;
    this.panelMembershipCount = 0;
    this.reactionSamplesUs = [];
    this.buffers = { touches: [], intents: [], scores: [], inventory: [] };
    this.flushing = false;
    this.refreshing = false;
    this.stopping = false;
    this.timers = [];
    this.metrics = {
      events: 0, discardedStale: 0, discardedSequence: 0, decisions: 0,
      fills: 0, partialFills: 0, persistenceDrops: 0, predictorTriggers: 0,
      costConfirmed: 0, lastEventAt: null, lastDecisionAt: null,
      lastUniverseRefreshAt: null, lastUniverseRefreshAttemptAt: null,
      universeRefreshTimeouts: 0, consecutiveUniverseRefreshTimeouts: 0,
      universeRefreshFailures: 0,
      reactionUsMax: 0, reactionUsSum: 0, reactionCount: 0,
      universeScanned: 0, universePersisted: 0,
      sqlTouchesPersisted: 0, sqlTouchesSampledOut: 0,
    };

    const walOptions = {
      root: process.env.BORG_WAL_DIR,
      mirrorRoot: process.env.BORG_WAL_MIRROR_DIR || null,
      minFreeGb: Number(process.env.BORG_WAL_MIN_FREE_GB || 10),
      collectionEpochId: process.env.BORG_COLLECTION_EPOCH_ID || 'allmarket-unmarked',
      collectorRunId: RUN_ID,
    };
    this.marketWal = new RawWal('allmarket-clob', walOptions);
    this.decisionWal = new RawWal('allmarket-decisions', walOptions);
    this.clob = new ClobMultiplex((assetId) => this.tokenMeta.get(String(assetId))?.conditionId || null, {
      shardCount: Number(process.env.ALLMARKET_CLOB_SHARDS || 2),
      wal: this.marketWal,
      persistDerivedEvents: false,
      emitTradeEvents: true,
      maxPrintAssets: MAX_MARKETS * 2 + 40,
      onMarketEvent: (event) => this.onMarketEvent(event),
    });
  }

  async start() {
    // The TV2 application owns the base schema. This independent service only
    // applies its additive namespace and never reacquires broad legacy locks.
    await migrateAllMarket();
    await syncExperimentRegistry(pool);
    await pool.query(`
      INSERT INTO am_runtime (run_id,started_at,host,pid,paper_only,wallet_loaded,status,metrics)
      VALUES ($1,now(),$2,$3,true,false,'STARTING',$4::jsonb)
    `, [RUN_ID, os.hostname(), process.pid, json({ latencyProfilesMs: LATENCY_PROFILES_MS })]);
    await this.refreshUniverse();
    await this.clob.connect();
    this.timers = [
      setInterval(() => this.flush().catch((error) => this.recordError('flush', error)), 250),
      setInterval(() => this.scoreMarkouts(), 20),
      setInterval(() => this.expireQuotes(), 250),
      setInterval(() => this.refreshUniverse()
        .catch((error) => this.recordUniverseRefreshFailure(error)), REFRESH_MS),
      setInterval(() => this.clob.checkStale(), 10_000),
      setInterval(() => this.heartbeat().catch(() => {}), 10_000),
    ];
    await this.heartbeat('RUNNING');
    await logEvent('INFO', 'allmarket_lab', 'paper-only all-market engine started', {
      runId: RUN_ID, markets: this.markets.size, tokens: this.tokenMeta.size,
      latencyProfilesMs: LATENCY_PROFILES_MS, walletLoaded: false, liveOrderPath: false,
      strategySignalsEnabled: STRATEGY_SIGNALS_ENABLED,
      panelMode: PANEL_MODE, panelHash: this.panelHash,
    });
  }

  recordError(scope, error) {
    logEvent('ERROR', 'allmarket_lab', `${scope}: ${error.message}`).catch(() => {});
  }

  recordUniverseRefreshFailure(error) {
    const transient = isTransientUniverseError(error);
    if (transient) {
      this.metrics.universeRefreshTimeouts += 1;
      this.metrics.consecutiveUniverseRefreshTimeouts += 1;
    } else {
      this.metrics.universeRefreshFailures += 1;
    }
    const level = universeRefreshSeverity({
      error,
      selectedMarkets: this.markets.size,
      consecutiveTimeouts: this.metrics.consecutiveUniverseRefreshTimeouts,
      lastSuccessAt: this.metrics.lastUniverseRefreshAt,
      maxStaleMs: UNIVERSE_MAX_STALE_MS,
    });
    return logEvent(level, 'allmarket_lab', `universe refresh retained current panel: ${error.message}`, {
      transient,
      selectedMarkets: this.markets.size,
      consecutiveTimeouts: this.metrics.consecutiveUniverseRefreshTimeouts,
      lastSuccessAt: this.metrics.lastUniverseRefreshAt
        ? new Date(this.metrics.lastUniverseRefreshAt).toISOString() : null,
      maxStaleMs: UNIVERSE_MAX_STALE_MS,
    });
  }

  sequenceAccepted(event) {
    const key = `${event.connectionShard || 0}:${event.connectionEpoch || 0}:${event.assetId}`;
    const sequence = Number(event.eventSequence);
    if (!Number.isFinite(sequence)) return true;
    const previous = this.lastSequence.get(key);
    if (previous != null && sequence <= previous) {
      this.metrics.discardedSequence += 1;
      return false;
    }
    this.lastSequence.set(key, sequence);
    return true;
  }

  onMarketEvent(event) {
    if (this.stopping || !this.sequenceAccepted(event)) return;
    const meta = this.tokenMeta.get(String(event.assetId));
    if (!meta || !event.book) return;
    const now = event.receiveWallMs || Date.now();
    const sourceAge = event.sourceMs == null ? now - event.book.at : now - event.sourceMs;
    const grade = dataQuality({ stateAgeMs: sourceAge, stateSource: 'event' });
    this.metrics.events += 1;
    this.metrics.lastEventAt = now;
    const reaction = reactionUs(event.receiveMonoNs);
    if (reaction != null) {
      this.metrics.reactionUsMax = Math.max(this.metrics.reactionUsMax, reaction);
      this.metrics.reactionUsSum += reaction; this.metrics.reactionCount += 1;
    }
    if (sourceAge > STALE_MS || grade === 'F') this.metrics.discardedStale += 1;
    if (reaction != null && event.eventType !== 'book' && grade !== 'F') {
      this.reactionSamplesUs.push(reaction);
      if (this.reactionSamplesUs.length > 2000) this.reactionSamplesUs.shift();
    }

    if (event.eventType === 'tick_size_change') {
      const nextTick = finite(event.book.tickSize);
      const market = this.markets.get(meta.conditionId);
      if (market && nextTick && Math.abs(nextTick - market.tickSize) > 1e-12) {
        const existing = this.openQuotes.get(String(event.assetId));
        if (existing) this.cancelQuote(existing, 'TICK_SIZE_CHANGE');
        market.tickSize = nextTick;
        meta.market.tickSize = nextTick;
      }
    }

    if (event.eventType !== 'last_trade_price') {
      this.captureTouch(event, meta, sourceAge, grade, reaction);
      if (!STRATEGY_SIGNALS_ENABLED) return;
      this.refreshMakerQuote(event, meta, grade);
      if (grade !== 'F' && sourceAge <= STALE_MS) this.triggerPredictor(event, meta, grade);
    } else if (STRATEGY_SIGNALS_ENABLED) {
      this.advanceMakerFill(event, meta);
    }
  }

  captureTouch(event, meta, stateAgeMs, grade, reaction) {
    const view = microstructure(event.book);
    if (!view) return;
    const observedAt = event.receiveWallMs || Date.now();
    const assetId = String(event.assetId);
    const previous = this.lastSqlTouchAt.get(assetId) || 0;
    if (observedAt - previous < SQL_TOUCH_MIN_INTERVAL_MS) {
      this.metrics.sqlTouchesSampledOut += 1;
      return;
    }
    this.lastSqlTouchAt.set(assetId, observedAt);
    this.metrics.sqlTouchesPersisted += 1;
    boundedPush(this.buffers.touches, [
      iso(observedAt), event.sourceMs ? iso(event.sourceMs) : null,
      meta.conditionId, assetId, meta.outcome,
      view.bid, view.bidSize, view.ask, view.askSize, view.midpoint, view.microprice,
      view.imbalance, view.spread, stateAgeMs, reaction, grade, event.eventType,
      event.connectionEpoch || 0, event.connectionShard || 0, event.eventSequence || null,
      event.walEventId || null, event.book.hash || null,
    ], this.metrics);
  }

  inventoryNotional(meta, book) {
    const item = this.inventory.get(String(meta.assetId));
    const view = microstructure(book);
    return item && view ? item.shares * view.midpoint : 0;
  }

  refreshMakerQuote(event, meta, grade) {
    const market = this.markets.get(meta.conditionId);
    const existing = this.openQuotes.get(String(meta.assetId));
    if (!market || grade === 'F') {
      if (existing) this.cancelQuote(existing, 'DATA_QUALITY');
      return;
    }
    const inventoryLimit = capital.STARTING_BANKROLL_USD * capital.MAX_GROSS_EXPOSURE_PCT;
    if (this.inventoryNotional(meta, event.book) >= inventoryLimit) {
      if (existing) this.cancelQuote(existing, 'INVENTORY_CAPACITY');
      return;
    }
    const view = microstructure(event.book);
    if (!view) return;
    const qualifyingSize = Math.max(market.orderMinSize || 5,
      market.rewardsDailyRate > 0 ? market.rewardsMinSize || 0 : 0);
    const targetShares = Math.max(qualifyingSize, capital.TARGET_STAKE_USD / view.bid);
    if (targetShares * view.bid > MAX_CAPITAL_PER_MARKET + 1e-9) {
      if (existing) this.cancelQuote(existing, 'CAPACITY');
      return;
    }
    const quote = makerQuote({
      book: event.book, tickSize: market.tickSize, requestedShares: targetShares,
      minimumQualifyingSize: qualifyingSize,
    });
    if (!quote.qualified) {
      if (existing) this.cancelQuote(existing, quote.reason);
      return;
    }
    const rewardDistanceCents = Math.abs(quote.price - quote.fair) * 100;
    const rewardEligible = market.rewardsDailyRate > 0
      && rewardDistanceCents <= market.rewardsMaxSpread + 1e-9
      && quote.size >= market.rewardsMinSize;
    if (existing && Math.abs(existing.price - quote.price) <= 1e-9
      && Date.now() - existing.placedAt < MAKER_QUOTE_LIFETIME_MS) return;
    if (existing) this.cancelQuote(existing, 'REQUOTE');

    const strategy = rewardEligible ? 'AM_reward_passive_maker_v1' : 'AM_passive_maker_v1';
    const placedAt = Date.now();
    const record = {
      intentId: intentId('maker'), strategy, arm: 'event_20_50ms', meta, market,
      price: quote.price, size: quote.size, placedAt, grade, rewardEligible,
      rewardDistanceCents, queue: createQueueState(quote, placedAt),
      sourceEventId: event.walEventId || null,
    };
    this.openQuotes.set(String(meta.assetId), record);
    this.writeIntent(record, {
      action: 'PLACE', side: 'BUY', orderKind: 'maker', postOnly: true,
      price: quote.price, size: quote.size, latencyMs: 0, queueAhead: quote.queueAhead,
      sourceEventId: event.walEventId, reaction: reactionUs(event.receiveMonoNs), grade,
      status: 'RESTING', features: {
        quoteFair: quote.fair, spread: quote.view.spread, improved: quote.improved,
        rewardEligible, rewardDistanceCents, rewardsDailyRate: market.rewardsDailyRate,
        rewardsMinSize: market.rewardsMinSize, rewardsMaxSpread: market.rewardsMaxSpread,
        feeSource: market.feeSource, feeRate: market.feeRate, feeExponent: market.feeExponent,
        capitalPolicy: capital.RESEARCH_CAPITAL_VERSION,
      },
    });
  }

  advanceMakerFill(event) {
    const quote = this.openQuotes.get(String(event.assetId));
    if (!quote) return;
    const before = quote.queue.filledShares;
    advanceQueue(quote.queue, this.clob.printsSince(String(event.assetId), quote.queue.lastPrintAtMs));
    if (quote.queue.filledShares > before && !quote.queue.filled) this.metrics.partialFills += 1;
    if (!quote.queue.filled) return;
    this.openQuotes.delete(String(event.assetId));
    this.finalizeQuote(quote, quote.queue.size, 'PRINT_THROUGH_FULL');
  }

  expireQuotes() {
    const now = Date.now();
    for (const quote of this.openQuotes.values()) {
      if (now - quote.placedAt >= MAKER_QUOTE_LIFETIME_MS) this.cancelQuote(quote, 'GTD_EXPIRED');
    }
  }

  cancelQuote(quote, reason) {
    if (this.openQuotes.get(String(quote.meta.assetId)) !== quote) return;
    this.openQuotes.delete(String(quote.meta.assetId));
    const cancel = { ...quote, intentId: intentId('cancel') };
    this.writeIntent(cancel, {
      action: 'CANCEL', parentIntentId: quote.intentId, side: 'BUY', orderKind: 'maker',
      postOnly: true, price: quote.price, size: Math.max(0, quote.size - quote.queue.filledShares),
      latencyMs: 0, queueAhead: quote.queue.remainingAhead, sourceEventId: quote.sourceEventId,
      reaction: null, grade: quote.grade, status: reason, features: { cancelReason: reason },
    });
    this.finalizeQuote(quote, quote.queue.filledShares,
      quote.queue.filledShares > 0 ? 'PRINT_THROUGH_PARTIAL' : `NO_FILL_${reason}`);
  }

  finalizeQuote(quote, shares, reason) {
    if (!(shares > 0)) {
      this.writeScore(quote, { filled: false, fillReason: reason, fillSize: 0 });
      return;
    }
    const fillAt = quote.queue.fillAtMs || quote.queue.lastPrintAtMs || Date.now();
    this.metrics.fills += 1;
    const prior = this.inventory.get(String(quote.meta.assetId)) || { shares: 0, cost: 0 };
    const updated = { shares: prior.shares + shares, cost: prior.cost + shares * quote.price };
    this.inventory.set(String(quote.meta.assetId), updated);
    boundedPush(this.buffers.inventory, [
      RUN_ID, quote.meta.conditionId, String(quote.meta.assetId), quote.meta.outcome,
      updated.shares, updated.cost, new Date(), json({ paperOnly: true, strategy: quote.strategy }),
    ], this.metrics);
    this.writeScore(quote, {
      filled: true, fillAt, fillPrice: quote.price, fillSize: shares, fillReason: reason,
      queueAheadInitial: quote.queue.queueAheadInitial, printedVolume: quote.queue.tradedThrough,
    });
    this.pendingMarkouts.set(quote.intentId, {
      intentId: quote.intentId, meta: quote.meta, market: quote.market, strategy: quote.strategy,
      fillAt, fillPrice: quote.price, shares, entryKind: 'maker', grade: quote.grade,
      done: new Set(), baseDetail: { fillReason: reason, rewardEligible: quote.rewardEligible },
    });
  }

  triggerPredictor(event, meta, grade) {
    const signal = evaluateL2Predictor(event.book, { tickSize: meta.market.tickSize });
    if (!signal.qualified || signal.direction !== 'UP') return;
    const now = event.receiveWallMs || Date.now();
    if (now - (this.lastPredictor.get(String(event.assetId)) || 0) < 1000) return;
    this.lastPredictor.set(String(event.assetId), now);
    this.metrics.predictorTriggers += 1;
    for (const latencyMs of LATENCY_PROFILES_MS) {
      const frozen = {
        event, meta, grade, signal: { ...signal }, decisionAt: now,
        sourceEventId: event.walEventId || null,
      };
      setTimeout(() => this.evaluateArrival(frozen, latencyMs), latencyMs).unref?.();
    }
  }

  evaluateArrival(frozen, latencyMs) {
    if (this.stopping) return;
    const { event, meta, grade, signal, decisionAt, sourceEventId } = frozen;
    const market = this.markets.get(meta.conditionId);
    const book = this.clob.getBook(String(meta.assetId));
    if (!market || !book) return;
    const availableAt = Date.now();
    const age = availableAt - book.at;
    const arrivalGrade = dataQuality({ stateAgeMs: age });
    const targetShares = Math.max(market.orderMinSize || 5, capital.TARGET_STAKE_USD / signal.ask);
    const executable = walkAsk(book, targetShares);
    const conservativeEntry = executable == null ? null
      : clampPrice(executable + market.tickSize, market.tickSize);
    const control = {
      intentId: intentId('l2-control'), strategy: 'AM_L2_predictor_control_v1',
      arm: `latency_${latencyMs}ms`, meta, market, grade: arrivalGrade, entryKind: 'taker',
    };
    const common = {
      action: 'PLACE', side: 'BUY', orderKind: 'taker', postOnly: false,
      price: conservativeEntry, size: targetShares, latencyMs, queueAhead: null,
      sourceEventId, reaction: reactionUs(event.receiveMonoNs), grade: arrivalGrade,
      status: conservativeEntry == null || arrivalGrade === 'F' ? 'NO_FILL' : 'FILLED_PAPER',
      decisionAt,
      features: {
        decisionAt: new Date(decisionAt).toISOString(), observedLatencyMs: availableAt - decisionAt,
        arrivalStateAgeMs: age, predictor: signal, fullDepthEntryVwap: executable,
        pessimisticTicks: 1, capitalPolicy: capital.RESEARCH_CAPITAL_VERSION,
        feeSource: market.feeSource, feeRate: market.feeRate, feeExponent: market.feeExponent,
      },
    };
    this.writeIntent(control, common, availableAt);
    if (conservativeEntry == null || arrivalGrade === 'F') {
      this.writeScore(control, { filled: false, fillReason: conservativeEntry == null ? 'INSUFFICIENT_DEPTH' : 'STALE_ARRIVAL', fillSize: 0 });
    } else {
      this.metrics.fills += 1;
      this.writeScore(control, {
        filled: true, fillAt: availableAt, fillPrice: conservativeEntry,
        fillSize: targetShares, fillReason: 'FULL_DEPTH_PLUS_ONE_TICK',
      });
      this.pendingMarkouts.set(control.intentId, {
        intentId: control.intentId, meta, market, strategy: control.strategy,
        fillAt: availableAt, fillPrice: conservativeEntry, shares: targetShares,
        entryKind: 'taker', grade: arrivalGrade, done: new Set(),
        baseDetail: { latencyMs, diagnosticControl: true },
      });
    }

    const hurdle = costConfirmedTaker({
      predictor: signal, arrivalBook: book, feeRate: market.feeRate,
      feeExponent: market.feeExponent, tickSize: market.tickSize,
    });
    const economic = {
      intentId: intentId('l2-cost'), strategy: 'AM_L2_cost_confirmed_taker_v1',
      arm: `latency_${latencyMs}ms`, meta, market, grade: arrivalGrade, entryKind: 'taker',
    };
    this.writeIntent(economic, {
      ...common, price: conservativeEntry,
      status: hurdle.qualified && conservativeEntry != null && arrivalGrade !== 'F'
        ? 'FILLED_PAPER' : `SKIP_${hurdle.reason}`,
      features: { ...common.features, costHurdle: hurdle },
    }, availableAt);
    if (!hurdle.qualified || conservativeEntry == null || arrivalGrade === 'F') {
      this.writeScore(economic, { filled: false, fillReason: `SKIP_${hurdle.reason}`, fillSize: 0 });
      return;
    }
    this.metrics.costConfirmed += 1; this.metrics.fills += 1;
    this.writeScore(economic, {
      filled: true, fillAt: availableAt, fillPrice: conservativeEntry,
      fillSize: targetShares, fillReason: 'COST_CONFIRMED_FULL_DEPTH_PLUS_ONE_TICK',
    });
    this.pendingMarkouts.set(economic.intentId, {
      intentId: economic.intentId, meta, market, strategy: economic.strategy,
      fillAt: availableAt, fillPrice: conservativeEntry, shares: targetShares,
      entryKind: 'taker', grade: arrivalGrade, done: new Set(),
      baseDetail: { latencyMs, costHurdle: hurdle },
    });
  }

  scoreMarkouts() {
    const now = Date.now();
    for (const tracker of this.pendingMarkouts.values()) {
      const elapsed = now - tracker.fillAt;
      for (const [name, horizon] of [['1s', 1000], ['5s', 5000], ['30s', 30000]]) {
        if (elapsed < horizon || tracker.done.has(name)) continue;
        tracker.done.add(name);
        const book = this.clob.getBook(String(tracker.meta.assetId));
        const age = book ? now - book.at : Infinity;
        const mark = book && age <= STALE_MS ? walkBid(book, tracker.shares) : null;
        const pnl = mark == null ? null : markoutPnl({
          entryPrice: tracker.fillPrice, exitPrice: mark, shares: tracker.shares,
          entryKind: tracker.entryKind, feeRate: tracker.market.feeRate,
          feeExponent: tracker.market.feeExponent, feeTakerOnly: tracker.market.feeTakerOnly,
        });
        this.writeScore(tracker, {
          filled: true, fillAt: tracker.fillAt, fillPrice: tracker.fillPrice,
          fillSize: tracker.shares, [`mark${name}`]: mark, [`pnl${name}`]: pnl,
          detail: { [`stateAge${name}Ms`]: Number.isFinite(age) ? age : null },
        });
      }
      if (tracker.done.size === 3) this.pendingMarkouts.delete(tracker.intentId);
    }
  }

  writeIntent(record, values, availableAt = Date.now()) {
    const now = Date.now();
    const decisionAt = Number(values.decisionAt || now);
    const durable = {
      type: 'paper_order_intent', intentId: record.intentId, runId: RUN_ID,
      experimentId: EXPERIMENT_ID, strategy: record.strategy, arm: record.arm,
      conditionId: record.meta.conditionId, assetId: String(record.meta.assetId),
      outcome: record.meta.outcome, decisionAt: new Date(decisionAt).toISOString(),
      availableAt: new Date(availableAt).toISOString(), ...values,
      paperOnly: true, walletLoaded: false, liveOrderPath: false,
    };
    this.decisionWal.append(json(durable), { channel: 'paper-intent', sourceMs: now });
    boundedPush(this.buffers.intents, [
      record.intentId, RUN_ID, EXPERIMENT_ID, record.strategy, record.arm,
      values.action, values.parentIntentId || null, iso(decisionAt), iso(availableAt),
      record.meta.conditionId, String(record.meta.assetId), record.meta.outcome,
      values.side, values.orderKind, values.postOnly, values.price, values.size,
      values.latencyMs, values.queueAhead, values.sourceEventId || null,
      values.reaction, values.grade, values.status, json(values.features),
    ], this.metrics);
    this.metrics.decisions += 1; this.metrics.lastDecisionAt = now;
  }

  writeScore(record, values) {
    const detail = { ...(record.baseDetail || {}), ...(values.detail || {}) };
    const row = [
      record.intentId, values.filled === true, values.fillAt ? iso(values.fillAt) : null,
      values.fillPrice ?? null, values.fillSize ?? null, values.fillReason || null,
      values.queueAheadInitial ?? null, values.printedVolume ?? null,
      values.mark1s ?? null, values.mark5s ?? null, values.mark30s ?? null,
      values.pnl1s ?? null, values.pnl5s ?? null, values.pnl30s ?? null,
      null, null, record.grade || 'F',
      record.entryKind === 'maker' || record.strategy?.includes('maker') ? 'B' : 'B',
      'paper_l2', 'allmarket-queue-v1', 'gamma-fee-schedule-or-conservative-v1', json(detail), new Date(),
    ];
    this.decisionWal.append(json({
      type: 'paper_execution_score', intentId: record.intentId, strategy: record.strategy,
      ...values, detail, paperOnly: true,
    }), { channel: 'paper-score', sourceMs: Date.now() });
    boundedPush(this.buffers.scores, row, this.metrics);
  }

  async loadToxicity() {
    const { rows } = await pool.query(`
      SELECT i.condition_id,
             AVG(GREATEST(0,-s.pnl_5s) / NULLIF(s.fill_size,0)) AS toxicity
        FROM am_execution_scores s JOIN am_order_intents i USING (intent_id)
       WHERE s.filled=true AND s.pnl_5s IS NOT NULL
         AND i.strategy IN ('AM_passive_maker_v1','AM_reward_passive_maker_v1')
       GROUP BY i.condition_id
    `);
    return new Map(rows.map((row) => [String(row.condition_id), finite(row.toxicity, 0)]));
  }

  async frozenNeglectedPanel(universe) {
    if (!COLLECTION_EPOCH_ID || COLLECTION_EPOCH_ID.endsWith('-unmarked')) {
      throw new Error('neglected panel mode requires a marked BORG_COLLECTION_EPOCH_ID');
    }
    const existing = await pool.query(`
      SELECT panel_hash,condition_id,panel_rank,selection_reason,metadata
        FROM am_panel_memberships
       WHERE collection_epoch_id=$1 AND panel_version=$2
       ORDER BY panel_rank`, [COLLECTION_EPOCH_ID, NEGLECTED_PANEL_VERSION]);
    const universeById = new Map(universe.map((market) => [market.conditionId, market]));
    if (existing.rows.length) {
      const hashes = new Set(existing.rows.map((row) => String(row.panel_hash)));
      if (hashes.size !== 1) throw new Error('frozen neglected panel has inconsistent hashes');
      this.panelHash = [...hashes][0];
      this.panelMembershipCount = existing.rows.length;
      return existing.rows.map((row) => {
        const market = universeById.get(String(row.condition_id));
        return market ? {
          ...market,
          selectionReason: row.selection_reason,
          selectionScore: MAX_MARKETS - Number(row.panel_rank),
        } : null;
      }).filter(Boolean);
    }

    const selected = selectNeglectedPanel(universe, {
      maxMarkets: MAX_MARKETS,
      maxCapitalPerMarket: MAX_CAPITAL_PER_MARKET,
      catalystGuardHours: CATALYST_GUARD_HOURS,
      noFairFeedGuardHours: NO_FAIR_FEED_GUARD_HOURS,
      fairFeedCategories: String(process.env.ALLMARKET_FAIR_FEED_CATEGORIES || '').split(',').filter(Boolean),
    });
    const hash = neglectedPanelHash(selected);
    await insertRows('am_panel_memberships', [
      'collection_epoch_id', 'panel_version', 'panel_hash', 'condition_id',
      'panel_rank', 'selection_reason', 'metadata',
    ], selected.map((market, index) => [
      COLLECTION_EPOCH_ID, NEGLECTED_PANEL_VERSION, hash, market.conditionId,
      index, market.selectionReason, json({
        category: market.category,
        eventId: market.eventId,
        eventGroupSize: market.eventGroupSize,
        minimumCaptureCapital: market.minimumCaptureCapital,
        pnlIndependentSelection: true,
      }),
    ]), 'ON CONFLICT (collection_epoch_id,panel_version,condition_id) DO NOTHING');
    this.panelHash = hash;
    this.panelMembershipCount = selected.length;
    return selected;
  }

  async refreshUniverse() {
    if (this.refreshing || this.stopping) return;
    this.refreshing = true;
    this.metrics.lastUniverseRefreshAttemptAt = Date.now();
    try {
      const [universe, toxicity] = await Promise.all([
        discoverUniverse({
          rewardPages: Number(process.env.ALLMARKET_REWARD_PAGES || 24),
          rewardFetchLimit: Number(process.env.ALLMARKET_REWARD_FETCH_LIMIT || 300),
          maxRewardMinSize: Number(process.env.ALLMARKET_MAX_REWARD_MIN_SIZE || 100),
          gammaPages: Number(process.env.ALLMARKET_GAMMA_PAGES || 20),
          gammaWindows: Number(process.env.ALLMARKET_GAMMA_WINDOWS || 10),
        }),
        PANEL_MODE === 'neglected' ? Promise.resolve(new Map()) : this.loadToxicity(),
      ]);
      const panel = PANEL_MODE === 'neglected'
        ? await this.frozenNeglectedPanel(universe)
        : selectRealtimePanel(universe, {
          maxMarkets: MAX_MARKETS, maxCapitalPerMarket: MAX_CAPITAL_PER_MARKET,
          catalystGuardHours: CATALYST_GUARD_HOURS,
          noFairFeedGuardHours: NO_FAIR_FEED_GUARD_HOURS,
          fairFeedCategories: String(process.env.ALLMARKET_FAIR_FEED_CATEGORIES || '').split(',').filter(Boolean),
          toxicity,
        });
      this.metrics.universeScanned = universe.length;
      const selected = new Set(panel.map((market) => market.conditionId));
      const persistedUniverse = [...universe].sort((left, right) =>
        Number(selected.has(right.conditionId)) - Number(selected.has(left.conditionId))
        || (right.rewardsDailyRate / Math.max(1, right.rewardsMinSize || right.orderMinSize || 1))
          - (left.rewardsDailyRate / Math.max(1, left.rewardsMinSize || left.orderMinSize || 1))
        || right.volume24h - left.volume24h
        || right.liquidity - left.liquidity
        || left.conditionId.localeCompare(right.conditionId)).slice(0, PERSIST_MARKETS);
      this.metrics.universePersisted = persistedUniverse.length;
      await pool.query('UPDATE am_markets SET selected_realtime=false WHERE selected_realtime=true');
      const marketRows = persistedUniverse.map((market) => {
        const chosen = panel.find((item) => item.conditionId === market.conditionId);
        return [
          market.conditionId, market.gammaId, market.eventId, market.eventSlug, market.slug,
          market.question, market.category, market.endDate, json(market.outcomes), json(market.tokenIds),
          market.tickSize, market.orderMinSize, market.liquidity, market.volume24h,
          market.feesEnabled, market.feeRate, market.feeExponent, market.feeTakerOnly,
          market.rebateRate, market.rewardsDailyRate, market.rewardsMinSize,
          market.rewardsMaxSpread, finite(toxicity.get(market.conditionId)) || 0,
          chosen?.selectionScore ?? null, chosen?.selectionReason ?? null,
          selected.has(market.conditionId), market.active, market.acceptingOrders,
          selected.has(market.conditionId) ? json(market.raw) : null,
          new Date(),
        ];
      });
      await insertRows('am_markets', MARKET_COLUMNS, marketRows, `ON CONFLICT (condition_id) DO UPDATE SET
        question=EXCLUDED.question,category=EXCLUDED.category,end_date=EXCLUDED.end_date,
        outcomes=EXCLUDED.outcomes,token_ids=EXCLUDED.token_ids,tick_size=EXCLUDED.tick_size,
        order_min_size=EXCLUDED.order_min_size,liquidity=EXCLUDED.liquidity,
        volume_24h=EXCLUDED.volume_24h,fees_enabled=EXCLUDED.fees_enabled,
        fee_rate=EXCLUDED.fee_rate,fee_exponent=EXCLUDED.fee_exponent,
        fee_taker_only=EXCLUDED.fee_taker_only,rebate_rate=EXCLUDED.rebate_rate,
        rewards_daily_rate=EXCLUDED.rewards_daily_rate,rewards_min_size=EXCLUDED.rewards_min_size,
        rewards_max_spread=EXCLUDED.rewards_max_spread,
        toxicity_5s_per_share=EXCLUDED.toxicity_5s_per_share,
        selection_score=EXCLUDED.selection_score,selection_reason=EXCLUDED.selection_reason,
        selected_realtime=EXCLUDED.selected_realtime,active=EXCLUDED.active,
        accepting_orders=EXCLUDED.accepting_orders,raw=EXCLUDED.raw,refreshed_at=EXCLUDED.refreshed_at`);
      this.markets = new Map(panel.map((market) => [market.conditionId, market]));
      this.tokenMeta = new Map();
      for (const market of panel) market.tokenIds.forEach((assetId, index) => {
        this.tokenMeta.set(String(assetId), {
          assetId: String(assetId), conditionId: market.conditionId,
          outcome: market.outcomes[index], market,
        });
      });
      for (const [assetId, quote] of this.openQuotes) {
        if (!this.tokenMeta.has(assetId)) this.cancelQuote(quote, 'UNIVERSE_ROTATION');
      }
      this.clob.subscribe([...this.tokenMeta.keys()]);
      this.metrics.lastUniverseRefreshAt = Date.now();
      this.metrics.consecutiveUniverseRefreshTimeouts = 0;
      await logEvent('INFO', 'allmarket_lab', 'universe refreshed', {
        scanned: universe.length, selected: panel.length, tokens: this.tokenMeta.size,
        categories: [...new Set(panel.map((market) => market.category))],
        panelMode: PANEL_MODE,
        panelVersion: PANEL_MODE === 'neglected' ? NEGLECTED_PANEL_VERSION : null,
        panelHash: this.panelHash,
        frozenMemberships: this.panelMembershipCount,
      });
    } finally { this.refreshing = false; }
  }

  async flush() {
    if (this.flushing) return;
    this.flushing = true;
    const batches = {
      touches: this.buffers.touches.splice(0, 5000),
      intents: this.buffers.intents.splice(0, 2000),
      scores: this.buffers.scores.splice(0, 2000),
      inventory: this.buffers.inventory.splice(0, 1000),
    };
    const scoreRows = coalesceScoreRows(batches.scores);
    const inventoryRows = lastRowsByKey(batches.inventory,
      (row) => `${row[0]}\u0000${row[1]}\u0000${row[2]}`);
    try {
      if (batches.touches.length) await insertRows('am_book_touches', TOUCH_COLUMNS, batches.touches);
      if (batches.intents.length) await insertRows('am_order_intents', INTENT_COLUMNS, batches.intents, 'ON CONFLICT (intent_id) DO NOTHING');
      if (scoreRows.length) await insertRows('am_execution_scores', SCORE_COLUMNS, scoreRows, SCORE_CONFLICT);
      if (inventoryRows.length) await insertRows('am_inventory', [
        'run_id', 'condition_id', 'asset_id', 'outcome', 'shares', 'cost', 'updated_at', 'detail',
      ], inventoryRows, `ON CONFLICT (run_id,condition_id,asset_id) DO UPDATE SET
        shares=EXCLUDED.shares,cost=EXCLUDED.cost,updated_at=EXCLUDED.updated_at,detail=EXCLUDED.detail`);
    } catch (error) {
      for (const key of Object.keys(batches)) this.buffers[key].unshift(...batches[key]);
      throw error;
    } finally { this.flushing = false; }
  }

  async heartbeat(status = 'RUNNING') {
    const queued = Object.values(this.buffers).reduce((sum, rows) => sum + rows.length, 0);
    const meanReactionUs = this.metrics.reactionCount
      ? this.metrics.reactionUsSum / this.metrics.reactionCount : null;
    const reactionP50Us = percentile(this.reactionSamplesUs, 0.50);
    const reactionP95Us = percentile(this.reactionSamplesUs, 0.95);
    const meta = {
      runId: RUN_ID, pid: process.pid, host: os.hostname(), paperOnly: true,
      processStartedAt: new Date(this.startedAt).toISOString(),
      walletLoaded: false, liveOrderPath: false, selectedMarkets: this.markets.size,
      subscribedTokens: this.tokenMeta.size, openQuotes: this.openQuotes.size,
      pendingMarkouts: this.pendingMarkouts.size, latencyProfilesMs: LATENCY_PROFILES_MS,
      strategySignalsEnabled: STRATEGY_SIGNALS_ENABLED,
      collectionEpochId: COLLECTION_EPOCH_ID,
      panelMode: PANEL_MODE,
      panelVersion: PANEL_MODE === 'neglected' ? NEGLECTED_PANEL_VERSION : null,
      panelHash: this.panelHash,
      panelMembershipCount: this.panelMembershipCount,
      reactionUsMean: meanReactionUs, reactionUsMax: this.metrics.reactionUsMax,
      reactionUsP50: reactionP50Us, reactionUsP95: reactionP95Us,
      reactionTargetMet: reactionP95Us == null ? null : reactionP95Us <= 50_000,
      sqlTouchMinIntervalMs: SQL_TOUCH_MIN_INTERVAL_MS,
      universeRefreshMs: REFRESH_MS,
      universeMaxStaleMs: UNIVERSE_MAX_STALE_MS,
      wal: { market: this.marketWal.health(), decisions: this.decisionWal.health() },
      ...this.metrics,
    };
    await Promise.all([
      pool.query(`
        UPDATE am_runtime SET status=$2,selected_markets=$3,subscribed_tokens=$4,
          events=$5,discarded_stale=$6,discarded_sequence=$7,decisions=$8,fills=$9,
          persistence_queue=$10,last_event_at=$11,last_decision_at=$12,updated_at=now(),metrics=$13::jsonb
        WHERE run_id=$1
      `, [RUN_ID, status, this.markets.size, this.tokenMeta.size, this.metrics.events,
        this.metrics.discardedStale, this.metrics.discardedSequence, this.metrics.decisions,
        this.metrics.fills, queued, this.metrics.lastEventAt ? iso(this.metrics.lastEventAt) : null,
        this.metrics.lastDecisionAt ? iso(this.metrics.lastDecisionAt) : null, json(meta)]),
      pool.query(`
        INSERT INTO system_heartbeats (component,beat_at,meta)
        VALUES ('allmarket_lab',now(),$1::jsonb)
        ON CONFLICT (component) DO UPDATE SET beat_at=now(),meta=EXCLUDED.meta
      `, [json(meta)]),
    ]);
  }

  async stop(signal) {
    if (this.stopping) return;
    this.stopping = true;
    this.timers.forEach(clearInterval);
    for (const quote of [...this.openQuotes.values()]) this.cancelQuote(quote, 'PROCESS_STOP');
    await this.flush().catch(() => {});
    await this.heartbeat('STOPPED').catch(() => {});
    await pool.query('UPDATE am_runtime SET stopped_at=now(),status=$2 WHERE run_id=$1', [RUN_ID, 'STOPPED']).catch(() => {});
    this.clob.close();
    await Promise.all([this.marketWal.close(), this.decisionWal.close()]).catch(() => {});
    await pool.end().catch(() => {});
    console.log(`[allmarket_lab] stopped by ${signal}`);
  }
}

async function main() {
  const lab = new AllMarketLab();
  process.once('SIGTERM', () => lab.stop('SIGTERM').finally(() => process.exit(0)));
  process.once('SIGINT', () => lab.stop('SIGINT').finally(() => process.exit(0)));
  await lab.start();
}

if (require.main === module) main().catch(async (error) => {
  console.error(error.stack || error.message);
  await pool.end().catch(() => {});
  process.exit(1);
});

module.exports = {
  AllMarketLab, LATENCY_PROFILES_MS, RUN_ID, coalesceScoreRows,
  isTransientUniverseError, lastRowsByKey, universeRefreshSeverity,
};
