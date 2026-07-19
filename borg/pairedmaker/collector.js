#!/usr/bin/env node
'use strict';

/**
 * Complementary-outcome paired-maker laboratory.
 *
 * PAPER/SHADOW ONLY. This process imports only public market-data adapters.
 * Raw frames and simulated decisions enter a durable local WAL before
 * asynchronous PostgreSQL persistence; PostgreSQL is never in the event path.
 */

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const ClobMultiplex = require('../recon/clob-multiplex');
const RawWal = require('../recon/wal');
const {
  insertRows, logEvent, migrateAllMarket, migratePairedMaker, pool,
} = require('../recon/db');
const { syncExperimentRegistry } = require('../research/experiment-registry');
const { discoverUniverse } = require('../allmarket/universe');
const { finite } = require('../allmarket/strategy');
const { pairedMarketPhase, selectPairedPanel } = require('./universe');
const {
  accrueModeledReward,
  acknowledgeCancels,
  buildInitialPairQuotes,
  buildRepairQuote,
  closeCycle,
  consumeMakerPrints,
  createPairCycle,
  installRepairQuote,
  liquidateOrphan,
  mergeCompleteSets,
  orphanPosition,
  pairBookView,
  requestCancel,
  settleOrphanAtResolution,
} = require('./strategy');

const EXPERIMENT_ID = 'paired-complete-set-maker-v3-rewards';
const STRATEGY = 'PMM_wallet_mechanism_v3_reward_aware';
const RUN_ID = `pairedmaker:${os.hostname()}:${new Date().toISOString()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
const ARMS = Object.freeze([
  Object.freeze({ name: 'reward_pregame_repair_60s', marketPhase: 'PREGAME', minPairEdge: 0.01, repairTimeoutMs: 60_000 }),
  Object.freeze({ name: 'reward_pregame_repair_300s', marketPhase: 'PREGAME', minPairEdge: 0.01, repairTimeoutMs: 300_000 }),
  Object.freeze({ name: 'reward_live_repair_60s_control', marketPhase: 'LIVE_OR_POST_START', minPairEdge: 0.01, repairTimeoutMs: 60_000 }),
]);
const TARGET_PAIR_USD = 25;
const MAX_RESERVED_USD_PER_ARM = 250;
const MAX_MARKETS = Math.max(1, Math.min(12, Number(process.env.PAIRED_MAKER_MAX_MARKETS || 6)));
const REFRESH_MS = Math.max(60_000, Number(process.env.PAIRED_MAKER_REFRESH_MS || 300_000));
const STALE_MS = Math.max(250, Number(process.env.PAIRED_MAKER_STALE_MS || 750));
const MAX_BOOK_SKEW_MS = Math.max(50, Number(process.env.PAIRED_MAKER_MAX_BOOK_SKEW_MS || 250));
const CANCEL_ACK_MS = 50;
const INITIAL_QUOTE_LIFETIME_MS = 900_000;
const RESTART_COOLDOWN_MS = 5_000;
const OBSERVATION_INTERVAL_MS = 1_000;
const REWARD_EVALUATION_INTERVAL_MS = 1_000;
const RESOLUTION_POLL_MS = 15_000;
const PERSIST_LIMIT = 100_000;

const MARKET_COLUMNS = [
  'condition_id', 'gamma_id', 'event_id', 'event_slug', 'slug', 'question', 'category', 'end_date',
  'outcomes', 'token_ids', 'tick_size', 'order_min_size', 'liquidity', 'volume_24h', 'fee_rate',
  'fee_exponent', 'fee_taker_only', 'rewards_daily_rate', 'rewards_min_size',
  'rewards_max_spread', 'rewards_start_at', 'rewards_end_at', 'game_start_at',
  'selected_realtime', 'selection_score', 'selection_reason', 'active', 'refreshed_at',
];
const OBSERVATION_COLUMNS = [
  'observed_at', 'source_ts', 'condition_id', 'best_bid_sum', 'best_ask_sum', 'midpoint_sum',
  'gross_pair_edge', 'book_skew_ms', 'max_state_age_ms', 'one_cent_eligible', 'two_cent_eligible',
  'data_quality_grade', 'source_event_id', 'reaction_us', 'detail',
];
const EVENT_COLUMNS = [
  'event_id', 'cycle_id', 'observed_at', 'event_type', 'condition_id', 'asset_id', 'outcome',
  'price', 'size', 'source_event_id', 'status', 'detail',
];
const CYCLE_COLUMNS = [
  'cycle_id', 'run_id', 'experiment_id', 'strategy', 'arm', 'condition_id', 'opened_at',
  'first_fill_at', 'closed_at', 'status', 'target_shares', 'min_pair_edge', 'initial_pair_cost',
  'leg0_asset_id', 'leg0_outcome', 'leg0_quote_price', 'leg0_filled_shares',
  'leg0_residual_shares', 'leg0_residual_cost', 'leg1_asset_id', 'leg1_outcome',
  'leg1_quote_price', 'leg1_filled_shares', 'leg1_residual_shares', 'leg1_residual_cost',
  'merged_shares', 'locked_pnl', 'orphan_exit_price', 'orphan_exit_proceeds',
  'orphan_exit_fees', 'orphan_pnl', 'total_pnl', 'data_quality_grade',
  'execution_fidelity_grade', 'reward_daily_rate', 'reward_min_size', 'reward_max_spread',
  'reward_qualified_ms', 'reward_own_score_seconds', 'reward_competitor_upper_score_seconds',
  'modeled_reward_accrual', 'modeled_reward_adjusted_pnl', 'detail', 'updated_at',
];
const CYCLE_CONFLICT = `ON CONFLICT (cycle_id) DO UPDATE SET
  first_fill_at=EXCLUDED.first_fill_at,closed_at=EXCLUDED.closed_at,status=EXCLUDED.status,
  leg0_filled_shares=EXCLUDED.leg0_filled_shares,leg0_residual_shares=EXCLUDED.leg0_residual_shares,
  leg0_residual_cost=EXCLUDED.leg0_residual_cost,leg1_filled_shares=EXCLUDED.leg1_filled_shares,
  leg1_residual_shares=EXCLUDED.leg1_residual_shares,leg1_residual_cost=EXCLUDED.leg1_residual_cost,
  merged_shares=EXCLUDED.merged_shares,locked_pnl=EXCLUDED.locked_pnl,
  orphan_exit_price=EXCLUDED.orphan_exit_price,orphan_exit_proceeds=EXCLUDED.orphan_exit_proceeds,
  orphan_exit_fees=EXCLUDED.orphan_exit_fees,orphan_pnl=EXCLUDED.orphan_pnl,
  total_pnl=EXCLUDED.total_pnl,data_quality_grade=EXCLUDED.data_quality_grade,
  execution_fidelity_grade=EXCLUDED.execution_fidelity_grade,
  reward_qualified_ms=EXCLUDED.reward_qualified_ms,
  reward_own_score_seconds=EXCLUDED.reward_own_score_seconds,
  reward_competitor_upper_score_seconds=EXCLUDED.reward_competitor_upper_score_seconds,
  modeled_reward_accrual=EXCLUDED.modeled_reward_accrual,
  modeled_reward_adjusted_pnl=EXCLUDED.modeled_reward_adjusted_pnl,
  detail=EXCLUDED.detail,
  updated_at=EXCLUDED.updated_at`;

function iso(ms) { return new Date(ms); }
function json(value) { return JSON.stringify(value ?? {}); }
function cycleKey(conditionId, arm) { return `${conditionId}\u0000${arm}`; }
function reactionUs(receiveMonoNs) {
  try { return Number(process.hrtime.bigint() - BigInt(receiveMonoNs)) / 1000; } catch (_) { return null; }
}
function boundedPush(buffer, row, metrics) {
  buffer.push(row);
  if (buffer.length > PERSIST_LIMIT) {
    buffer.splice(0, Math.ceil(PERSIST_LIMIT / 10));
    metrics.persistenceDrops += 1;
  }
}
function lastRowsByKey(rows, keyFn) {
  const map = new Map();
  for (const row of rows) map.set(keyFn(row), row);
  return [...map.values()];
}
function pairGrade(pair) {
  if (!pair?.qualified) return 'F';
  const maxAge = Math.max(...pair.agesMs);
  return maxAge <= 250 && pair.bookSkewMs <= 100 ? 'A' : 'B';
}

function cycleRow(cycle) {
  const detail = {
    paperOnly: true,
    walletLoaded: false,
    liveOrderPath: false,
    repairTimeoutMs: cycle.repairTimeoutMs,
    initialQuoteLifetimeMs: cycle.initialQuoteLifetimeMs,
    cancelAckMs: cycle.cancelAckMs,
    cancelReason: cycle.cancelReason,
    postCancelAction: cycle.postCancelAction,
    lastRepairFailure: cycle.lastRepairFailure || null,
    lastExitFailure: cycle.lastExitFailure || null,
    executionEvents: cycle.executionEvents,
    rewardModel: {
      version: 'public-l2-conservative-share-v1',
      realizedOrClaimed: false,
      dailyRate: cycle.rewardDailyRate,
      minimumSize: cycle.rewardMinSize,
      maximumSpreadCents: cycle.rewardMaxSpread,
      qualifiedMs: cycle.rewardQualifiedMs,
      ownScoreSeconds: cycle.rewardOwnScoreSeconds,
      competitorUpperScoreSeconds: cycle.rewardCompetitorUpperScoreSeconds,
      modeledAccrual: cycle.modeledRewardAccrual,
    },
    makerFees: cycle.legs.map((leg) => leg.makerFees),
    activeQuotes: cycle.legs.map((leg) => leg.quote?.active ? {
      kind: leg.quote.kind, price: leg.quote.price, size: leg.quote.size,
      filledShares: leg.quote.accountedShares,
      remainingAhead: leg.quote.queue.remainingAhead,
    } : null),
  };
  return [
    cycle.cycleId, cycle.runId, cycle.experimentId, cycle.strategy, cycle.arm, cycle.conditionId,
    iso(cycle.openedAtMs), cycle.firstFillAtMs ? iso(cycle.firstFillAtMs) : null,
    cycle.closedAtMs ? iso(cycle.closedAtMs) : null, cycle.status, cycle.targetShares,
    cycle.minPairEdge, cycle.initialPairCost,
    cycle.legs[0].assetId, cycle.legs[0].outcome, cycle.legs[0].initialQuotePrice,
    cycle.legs[0].totalMakerFilled, cycle.legs[0].shares, cycle.legs[0].cost,
    cycle.legs[1].assetId, cycle.legs[1].outcome, cycle.legs[1].initialQuotePrice,
    cycle.legs[1].totalMakerFilled, cycle.legs[1].shares, cycle.legs[1].cost,
    cycle.mergedShares, cycle.lockedPnl, cycle.orphanExitPrice, cycle.orphanExitProceeds,
    cycle.orphanExitFees, cycle.orphanPnl, cycle.totalPnl, cycle.dataQualityGrade,
    cycle.executionFidelityGrade, cycle.rewardDailyRate, cycle.rewardMinSize,
    cycle.rewardMaxSpread, cycle.rewardQualifiedMs, cycle.rewardOwnScoreSeconds,
    cycle.rewardCompetitorUpperScoreSeconds, cycle.modeledRewardAccrual,
    cycle.totalPnl == null ? null : cycle.totalPnl + cycle.modeledRewardAccrual,
    json(detail), new Date(),
  ];
}

class PairedMakerLab {
  constructor() {
    this.markets = new Map();
    this.tokenMeta = new Map();
    this.cycles = new Map();
    this.lastSequence = new Map();
    this.lastObservationAt = new Map();
    this.lastStartAt = new Map();
    this.buffers = { observations: [], events: [], cycles: [] };
    this.flushing = false;
    this.refreshing = false;
    this.resolving = false;
    this.stopping = false;
    this.timers = [];
    this.metrics = {
      events: 0, pairObservations: 0, eligibleOneCent: 0, eligibleTwoCent: 0,
      cycleEvaluations: 0, cyclesStarted: 0, makerFillEvents: 0, makerFilledShares: 0,
      mergedShares: 0, completedCycles: 0, noFillCycles: 0, orphanExits: 0,
      modeledRewardAccrual: 0, rewardQualifiedMs: 0, resolutionSettlements: 0,
      openOrphanInterruptions: 0, discardedSequence: 0, persistenceDrops: 0,
      universeScanned: 0, reactionUsMax: 0, reactionUsSum: 0, reactionCount: 0,
      lastEventAt: null, lastCycleAt: null,
    };
    const walOptions = {
      root: process.env.BORG_WAL_DIR,
      mirrorRoot: process.env.BORG_WAL_MIRROR_DIR || null,
      minFreeGb: Number(process.env.BORG_WAL_MIN_FREE_GB || 10),
      collectionEpochId: process.env.BORG_COLLECTION_EPOCH_ID || 'paired-maker-unmarked',
      collectorRunId: RUN_ID,
    };
    this.marketWal = new RawWal('paired-maker-clob', walOptions);
    this.decisionWal = new RawWal('paired-maker-decisions', walOptions);
    this.clob = new ClobMultiplex(
      (assetId) => this.tokenMeta.get(String(assetId))?.conditionId || null,
      {
        shardCount: Number(process.env.PAIRED_MAKER_CLOB_SHARDS || 1),
        wal: this.marketWal,
        persistDerivedEvents: false,
        emitTradeEvents: true,
        maxPrintAssets: MAX_MARKETS * 2 + 10,
        onMarketEvent: (event) => this.onMarketEvent(event),
      },
    );
  }

  async start() {
    await migrateAllMarket();
    await migratePairedMaker();
    await syncExperimentRegistry(pool);
    const interrupted = await pool.query(`
      UPDATE pmm_cycles
         SET closed_at=now(),status='INTERRUPTED_UNSCORED',total_pnl=NULL,
             detail=detail || '{"interrupted_without_recovery":true}'::jsonb,updated_at=now()
       WHERE closed_at IS NULL
    `);
    if (interrupted.rowCount) {
      await logEvent('WARN', 'paired_maker_lab', 'prior open cycles marked interrupted and excluded from realized PnL', {
        cycles: interrupted.rowCount,
      });
    }
    await pool.query(`
      INSERT INTO pmm_runtime
        (run_id,experiment_id,started_at,host,pid,paper_only,wallet_loaded,status,metrics)
      VALUES ($1,$2,now(),$3,$4,true,false,'STARTING',$5::jsonb)
    `, [RUN_ID, EXPERIMENT_ID, os.hostname(), process.pid, json({ arms: ARMS })]);
    await this.refreshUniverse();
    await this.clob.connect();
    this.timers = [
      setInterval(() => this.flush().catch((error) => this.recordError('flush', error)), 250),
      setInterval(() => this.manageCycles(), 50),
      setInterval(() => this.resolveCompletedMarkets().catch((error) => this.recordError('resolution', error)), RESOLUTION_POLL_MS),
      setInterval(() => this.refreshUniverse().catch((error) => this.recordError('universe', error)), REFRESH_MS),
      setInterval(() => this.clob.checkStale(), 10_000),
      setInterval(() => this.heartbeat().catch(() => {}), 10_000),
    ];
    await this.heartbeat('RUNNING');
    await logEvent('INFO', 'paired_maker_lab', 'paired complete-set paper engine started', {
      runId: RUN_ID, markets: this.markets.size, tokens: this.tokenMeta.size,
      arms: ARMS, targetPairUsd: TARGET_PAIR_USD,
      maxReservedUsdPerArm: MAX_RESERVED_USD_PER_ARM,
      walletLoaded: false, liveOrderPath: false,
    });
  }

  recordError(scope, error) {
    logEvent('ERROR', 'paired_maker_lab', `${scope}: ${error.message}`).catch(() => {});
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

  booksFor(market) {
    return market.tokenIds.map((assetId) => this.clob.getBook(String(assetId)));
  }

  onMarketEvent(event) {
    if (this.stopping || !this.sequenceAccepted(event)) return;
    const meta = this.tokenMeta.get(String(event.assetId));
    const market = meta && this.markets.get(meta.conditionId);
    if (!meta || !market || !event.book) return;
    const now = event.receiveWallMs || Date.now();
    const reaction = reactionUs(event.receiveMonoNs);
    this.metrics.events += 1;
    this.metrics.lastEventAt = now;
    if (reaction != null) {
      this.metrics.reactionUsMax = Math.max(this.metrics.reactionUsMax, reaction);
      this.metrics.reactionUsSum += reaction;
      this.metrics.reactionCount += 1;
    }
    if (event.eventType === 'tick_size_change') {
      const nextTick = finite(event.book.tickSize);
      if (nextTick && Math.abs(nextTick - market.tickSize) > 1e-12) {
        market.tickSize = nextTick;
        for (const cycle of [...this.cycles.values()]) {
          if (cycle.conditionId !== market.conditionId || cycle.status === 'CANCEL_PENDING'
            || !cycle.legs.some((leg) => leg.quote?.active)) continue;
          const action = orphanPosition(cycle) ? 'REPAIR' : 'CLOSE_NO_FILL';
          this.requestCycleCancel(cycle, 'TICK_SIZE_CHANGE', action, now);
          this.saveCycle(cycle);
        }
      }
      this.manageMarketCycles(market.conditionId, now);
      return;
    }
    if (event.eventType === 'last_trade_price') {
      this.processPrint(event, market, meta);
    } else {
      this.captureObservation(event, market, reaction);
      this.maybeStartCycles(event, market);
    }
    this.manageMarketCycles(market.conditionId, now);
  }

  captureObservation(event, market, reaction) {
    const now = event.receiveWallMs || Date.now();
    if (now - (this.lastObservationAt.get(market.conditionId) || 0) < OBSERVATION_INTERVAL_MS) return;
    const books = this.booksFor(market);
    const pair = pairBookView(books, { nowMs: now, staleMs: STALE_MS, maxBookSkewMs: MAX_BOOK_SKEW_MS });
    if (!pair.views) return;
    this.lastObservationAt.set(market.conditionId, now);
    const grade = pairGrade(pair);
    const bidSum = pair.bestBidSum ?? pair.views.reduce((sum, view) => sum + view.bid, 0);
    const askSum = pair.bestAskSum ?? pair.views.reduce((sum, view) => sum + view.ask, 0);
    const midpointSum = pair.midpointSum ?? pair.views.reduce((sum, view) => sum + view.midpoint, 0);
    const oneCentEligible = pair.qualified && bidSum <= 0.99 + 1e-9;
    const twoCentEligible = pair.qualified && bidSum <= 0.98 + 1e-9;
    const ages = pair.agesMs || books.map((book) => now - (finite(book?.at) || 0));
    boundedPush(this.buffers.observations, [
      iso(now), event.sourceMs ? iso(event.sourceMs) : null, market.conditionId,
      bidSum, askSum, midpointSum, 1 - bidSum, pair.bookSkewMs ?? null,
      ages.length ? Math.max(...ages) : null, oneCentEligible, twoCentEligible, grade,
      event.walEventId || null, reaction, json({ reason: pair.reason, tokenPricesOnly: true }),
    ], this.metrics);
    this.metrics.pairObservations += 1;
    if (oneCentEligible) this.metrics.eligibleOneCent += 1;
    if (twoCentEligible) this.metrics.eligibleTwoCent += 1;
  }

  maybeStartCycles(event, market) {
    const now = event.receiveWallMs || Date.now();
    const books = this.booksFor(market);
    const marketPhase = pairedMarketPhase(market, now);
    for (const arm of ARMS) {
      const key = cycleKey(market.conditionId, arm.name);
      const armAlreadyReserved = [...this.cycles.values()].some((cycle) => cycle.arm === arm.name);
      if (arm.marketPhase !== marketPhase || armAlreadyReserved || this.cycles.has(key)
        || now - (this.lastStartAt.get(key) || 0) < RESTART_COOLDOWN_MS) continue;
      this.metrics.cycleEvaluations += 1;
      const proposal = buildInitialPairQuotes({
        market, books, minPairEdge: arm.minPairEdge, targetPairUsd: TARGET_PAIR_USD,
        minimumShares: market.rewardsMinSize,
        maxReservedUsd: MAX_RESERVED_USD_PER_ARM,
        nowMs: now, staleMs: STALE_MS, maxBookSkewMs: MAX_BOOK_SKEW_MS,
      });
      if (!proposal.qualified) continue;
      const metas = market.tokenIds.map((assetId, index) => ({
        conditionId: market.conditionId, assetId: String(assetId), outcome: market.outcomes[index],
      }));
      const cycle = createPairCycle({
        cycleId: `pmm:${Date.now()}:${crypto.randomUUID()}`,
        runId: RUN_ID, experimentId: EXPERIMENT_ID, strategy: STRATEGY,
        arm: arm.name, market, metas, proposal, placedAtMs: now,
        initialQuoteLifetimeMs: Math.min(
          INITIAL_QUOTE_LIFETIME_MS,
          Math.max(30_000, (Date.parse(market.endDate) || now + INITIAL_QUOTE_LIFETIME_MS + 60_000) - now - 60_000),
        ),
        repairTimeoutMs: arm.repairTimeoutMs, cancelAckMs: CANCEL_ACK_MS,
      });
      cycle.dataQualityGrade = pairGrade(proposal);
      this.cycles.set(key, cycle);
      this.lastStartAt.set(key, now);
      this.metrics.cyclesStarted += 1;
      this.metrics.lastCycleAt = now;
      cycle.legs.forEach((leg) => this.writeEvent(cycle, 'PLACE_INITIAL', {
        observedAt: now, assetId: leg.assetId, outcome: leg.outcome,
        price: leg.quote.price, size: leg.quote.size, sourceEventId: event.walEventId,
        status: 'RESTING', detail: {
          postOnly: true, queueAhead: leg.quote.queue.queueAheadInitial,
          pairCost: proposal.pairCost, minPairEdge: arm.minPairEdge,
          grossLockedPnlIfFilled: proposal.grossLockedPnlIfFilled,
          rewardModel: {
            realizedOrClaimed: false,
            dailyRate: cycle.rewardDailyRate,
            minimumSize: cycle.rewardMinSize,
            maximumSpreadCents: cycle.rewardMaxSpread,
          },
          marketPhase,
        },
      }));
      this.saveCycle(cycle);
    }
  }

  processPrint(event, market, meta) {
    const prints = this.clob.printsSince(String(event.assetId), 0);
    for (const cycle of [...this.cycles.values()]) {
      if (cycle.conditionId !== market.conditionId) continue;
      const legIndex = cycle.legs.findIndex((leg) => leg.assetId === String(event.assetId));
      if (legIndex < 0 || !cycle.legs[legIndex].quote?.active) continue;
      const quote = cycle.legs[legIndex].quote;
      const fill = consumeMakerPrints(cycle, legIndex, prints, event.receiveWallMs || Date.now());
      if (!(fill.filledShares > 0)) continue;
      this.metrics.makerFillEvents += 1;
      this.metrics.makerFilledShares += fill.filledShares;
      this.writeEvent(cycle, 'MAKER_FILL', {
        observedAt: fill.fillAtMs, assetId: meta.assetId, outcome: meta.outcome,
        price: fill.fillPrice, size: fill.filledShares, sourceEventId: event.walEventId,
        status: cycle.status, detail: {
          quoteKind: fill.quoteKind, queueAheadInitial: quote.queue.queueAheadInitial,
          printedVolume: quote.queue.tradedThrough, makerFee: fill.fillFee,
        },
      });
      const merged = mergeCompleteSets(cycle);
      if (merged.mergedShares > 0) {
        this.metrics.mergedShares += merged.mergedShares;
        this.writeEvent(cycle, 'MERGE_COMPLETE_SET', {
          observedAt: event.receiveWallMs || Date.now(), price: 1, size: merged.mergedShares,
          sourceEventId: event.walEventId, status: cycle.status,
          detail: { allocatedCost: merged.allocatedCost, lockedPnl: merged.lockedPnl },
        });
      }
      if (cycle.status === 'QUOTING_BOTH') {
        this.requestCycleCancel(cycle, 'FIRST_MAKER_FILL', 'REPAIR', event.receiveWallMs || Date.now());
      } else if (cycle.status === 'REPAIRING' && !orphanPosition(cycle)) {
        if (cycle.legs.some((leg) => leg.quote?.active)) {
          this.requestCycleCancel(cycle, 'REPAIR_FILLED', 'CLOSE_LOCKED', event.receiveWallMs || Date.now());
        } else {
          this.finishCycle(cycle, 'LOCKED_COMPLETE_SET', event.receiveWallMs || Date.now());
        }
      }
      this.saveCycle(cycle);
    }
  }

  requestCycleCancel(cycle, reason, action, now) {
    const result = requestCancel(cycle, reason, action, now);
    for (const item of result.requested) {
      const leg = cycle.legs[item.legIndex];
      this.writeEvent(cycle, 'CANCEL_REQUEST', {
        observedAt: now, assetId: leg.assetId, outcome: leg.outcome,
        price: item.quote.price, size: Math.max(0, item.quote.size - item.quote.accountedShares),
        status: reason, detail: { postCancelAction: action, effectiveAtMs: result.effectiveAtMs },
      });
    }
  }

  manageCycles() {
    if (this.stopping) return;
    const now = Date.now();
    for (const cycle of [...this.cycles.values()]) this.manageCycle(cycle, now);
  }

  manageMarketCycles(conditionId, now) {
    for (const cycle of [...this.cycles.values()]) {
      if (cycle.conditionId === conditionId) this.manageCycle(cycle, now);
    }
  }

  manageCycle(cycle, now) {
    if (cycle.closedAtMs) return;
    if (now - (cycle.lastRewardEvaluationAtMs || cycle.openedAtMs) >= REWARD_EVALUATION_INTERVAL_MS) {
      cycle.lastRewardEvaluationAtMs = now;
      const reward = accrueModeledReward(cycle, this.booksFor(cycle.market), {
        nowMs: now, staleMs: STALE_MS, maxBookSkewMs: MAX_BOOK_SKEW_MS,
      });
      if (reward.accrued > 0) {
        this.metrics.modeledRewardAccrual += reward.accrued;
        this.metrics.rewardQualifiedMs += reward.elapsedMs;
      }
      // Keep the modeled incentive mark observable without placing PostgreSQL
      // in the quote/fill path. It remains separate from total_pnl.
      this.saveCycle(cycle);
    }
    if (cycle.status === 'QUOTING_BOTH'
      && now - cycle.openedAtMs >= cycle.initialQuoteLifetimeMs) {
      this.requestCycleCancel(cycle, 'INITIAL_GTD_EXPIRED', 'CLOSE_NO_FILL', now);
      this.saveCycle(cycle);
      return;
    }
    if (cycle.status === 'CANCEL_PENDING') {
      const result = acknowledgeCancels(cycle, now);
      for (const item of result.acknowledged) {
        const leg = cycle.legs[item.legIndex];
        this.writeEvent(cycle, 'CANCEL_ACK', {
          observedAt: now, assetId: leg.assetId, outcome: leg.outcome,
          price: item.quote.price, size: Math.max(0, item.quote.size - item.quote.accountedShares),
          status: cycle.cancelReason, detail: { postCancelAction: result.postCancelAction },
        });
      }
      if (!result.complete) return;
      const merged = mergeCompleteSets(cycle);
      if (merged.mergedShares > 0) {
        this.metrics.mergedShares += merged.mergedShares;
        this.writeEvent(cycle, 'MERGE_COMPLETE_SET', {
          observedAt: now, price: 1, size: merged.mergedShares, status: cycle.cancelReason,
          detail: { allocatedCost: merged.allocatedCost, lockedPnl: merged.lockedPnl },
        });
      }
      const orphan = orphanPosition(cycle);
      if (result.postCancelAction === 'EXIT') {
        if (orphan) this.tryExit(cycle, now);
        else this.finishCycle(cycle, 'LOCKED_DURING_EXIT_CANCEL', now);
      } else if (result.postCancelAction === 'CLOSE_LOCKED') {
        if (orphan) this.tryExit(cycle, now);
        else this.finishCycle(cycle, 'LOCKED_COMPLETE_SET', now);
      } else if (orphan) {
        this.tryPlaceRepair(cycle, now);
      } else if (cycle.mergedShares > 0) {
        this.finishCycle(cycle, 'LOCKED_PARTIAL_COMPLETE_SET', now);
      } else {
        this.finishCycle(cycle, 'NO_FILL', now);
      }
      return;
    }
    if ((cycle.status === 'REPAIRING' || cycle.status === 'WAIT_REPAIR_BOOK')
      && cycle.firstFillAtMs && now - cycle.firstFillAtMs >= cycle.repairTimeoutMs) {
      if (cycle.legs.some((leg) => leg.quote?.active)) {
        this.requestCycleCancel(cycle, 'REPAIR_TIMEOUT', 'EXIT', now);
        this.saveCycle(cycle);
      } else {
        this.tryExit(cycle, now);
      }
      return;
    }
    if (cycle.status === 'WAIT_REPAIR_BOOK') this.tryPlaceRepair(cycle, now);
    if (cycle.status === 'EXIT_PENDING') this.tryExit(cycle, now);
  }

  async resolveCompletedMarkets() {
    if (this.resolving || this.stopping) return;
    const now = Date.now();
    const candidates = [...this.cycles.values()].filter((cycle) => {
      if (!orphanPosition(cycle)) return false;
      const endMs = Date.parse(cycle.market?.endDate);
      return Number.isFinite(endMs) && now >= endMs;
    });
    if (!candidates.length) return;
    this.resolving = true;
    try {
      const byCondition = new Map(candidates.map((cycle) => [cycle.conditionId, cycle]));
      for (const conditionId of byCondition.keys()) {
        const response = await fetch(`https://clob.polymarket.com/markets/${encodeURIComponent(conditionId)}`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) continue;
        const payload = await response.json();
        const winner = (payload?.tokens || []).find((token) => token?.winner === true);
        if (!winner?.token_id) continue;
        for (const cycle of [...this.cycles.values()]) {
          if (cycle.conditionId !== conditionId || !orphanPosition(cycle)) continue;
          cycle.legs.forEach((leg) => { if (leg.quote) leg.quote.active = false; });
          const settlement = settleOrphanAtResolution(cycle, winner.token_id);
          if (!settlement.settled) continue;
          this.metrics.resolutionSettlements += 1;
          this.writeEvent(cycle, 'ORPHAN_RESOLUTION', {
            observedAt: now, assetId: settlement.assetId, outcome: settlement.outcome,
            price: settlement.payoutPrice, size: settlement.shares,
            status: settlement.reason,
            detail: { proceeds: settlement.proceeds, orphanPnl: settlement.pnl, source: 'public_clob_market_winner' },
          });
          this.finishCycle(cycle, 'MARKET_RESOLVED_ORPHAN', now);
        }
      }
    } finally {
      this.resolving = false;
    }
  }

  tryPlaceRepair(cycle, now) {
    const proposal = buildRepairQuote({
      cycle, books: this.booksFor(cycle.market), nowMs: now,
      staleMs: STALE_MS, maxBookSkewMs: MAX_BOOK_SKEW_MS,
    });
    if (!proposal.qualified) {
      cycle.lastRepairFailure = proposal.reason;
      if (['ORPHAN_BELOW_ORDER_MINIMUM', 'REPAIR_BREAKS_EDGE', 'NO_POST_ONLY_PRICE'].includes(proposal.reason)) {
        cycle.status = 'EXIT_PENDING';
        this.tryExit(cycle, now);
      } else {
        cycle.status = 'WAIT_REPAIR_BOOK';
        this.saveCycle(cycle);
      }
      return;
    }
    const placed = installRepairQuote(cycle, proposal, now);
    cycle.lastRepairFailure = null;
    const leg = cycle.legs[placed.legIndex];
    this.writeEvent(cycle, 'PLACE_REPAIR', {
      observedAt: now, assetId: placed.assetId, outcome: leg.outcome,
      price: placed.quote.price, size: placed.quote.size, status: 'RESTING',
      detail: {
        postOnly: true, queueAhead: placed.quote.queue.queueAheadInitial,
        orphanAverageCost: proposal.orphan.averageCost, preservedPairEdge: cycle.minPairEdge,
      },
    });
    this.saveCycle(cycle);
  }

  tryExit(cycle, now) {
    cycle.status = 'EXIT_PENDING';
    const result = liquidateOrphan(cycle, this.booksFor(cycle.market), {
      nowMs: now, staleMs: STALE_MS, adverseTicks: 1,
    });
    if (!result.filled) {
      if (cycle.lastExitFailure !== result.reason) {
        cycle.lastExitFailure = result.reason;
        this.writeEvent(cycle, 'ORPHAN_EXIT_DEFERRED', {
          observedAt: now, assetId: result.orphan?.assetId, outcome: result.orphan?.outcome,
          size: result.orphan?.shares, status: result.reason,
          detail: { fabricatedFill: false },
        });
      }
      this.saveCycle(cycle);
      return;
    }
    cycle.lastExitFailure = null;
    this.metrics.orphanExits += 1;
    this.writeEvent(cycle, 'ORPHAN_EXIT', {
      observedAt: now, assetId: result.assetId, outcome: result.outcome,
      price: result.exitPrice, size: result.shares, status: result.reason,
      detail: {
        fullDepthVwap: result.depthVwap, adverseTicks: result.adverseTicks,
        takerFee: result.fee, proceeds: result.proceeds, orphanPnl: result.pnl,
      },
    });
    this.finishCycle(cycle, 'ORPHAN_LIQUIDATED', now);
  }

  finishCycle(cycle, status, now) {
    if (cycle.closedAtMs) return;
    closeCycle(cycle, status, now);
    this.metrics.completedCycles += 1;
    if (status === 'NO_FILL') this.metrics.noFillCycles += 1;
    this.metrics.lastCycleAt = now;
    this.writeEvent(cycle, 'CYCLE_CLOSE', {
      observedAt: now, status, detail: {
        mergedShares: cycle.mergedShares, lockedPnl: cycle.lockedPnl,
        orphanPnl: cycle.orphanPnl, totalPnl: cycle.totalPnl,
        realized: cycle.totalPnl != null,
      },
    });
    this.saveCycle(cycle);
    this.cycles.delete(cycleKey(cycle.conditionId, cycle.arm));
  }

  writeEvent(cycle, type, values = {}) {
    const eventId = `pmm-event:${Date.now()}:${crypto.randomUUID()}`;
    const observedAt = values.observedAt || Date.now();
    const durable = {
      type: 'paired_maker_paper_event', eventId, cycleId: cycle.cycleId,
      runId: RUN_ID, experimentId: EXPERIMENT_ID, strategy: STRATEGY, arm: cycle.arm,
      eventType: type, conditionId: cycle.conditionId, ...values,
      observedAt: new Date(observedAt).toISOString(), paperOnly: true,
      walletLoaded: false, liveOrderPath: false,
    };
    this.decisionWal.append(json(durable), { channel: 'paired-maker-event', sourceMs: observedAt });
    boundedPush(this.buffers.events, [
      eventId, cycle.cycleId, iso(observedAt), type, cycle.conditionId,
      values.assetId == null ? null : String(values.assetId), values.outcome || null,
      values.price ?? null, values.size ?? null, values.sourceEventId || null,
      values.status || null, json(values.detail),
    ], this.metrics);
  }

  saveCycle(cycle) {
    boundedPush(this.buffers.cycles, cycleRow(cycle), this.metrics);
  }

  async persistMarkets(panel) {
    await pool.query('UPDATE pmm_markets SET selected_realtime=false WHERE selected_realtime=true');
    const rows = panel.map((market) => [
      market.conditionId, market.gammaId, market.eventId, market.eventSlug, market.slug,
      market.question, market.category, market.endDate ? new Date(market.endDate) : null,
      json(market.outcomes), json(market.tokenIds), finite(market.tickSize) || 0.01,
      finite(market.orderMinSize) || 5, finite(market.liquidity) || 0,
      finite(market.volume24h) || 0, finite(market.feeRate) || 0,
      finite(market.feeExponent) || 1, market.feeTakerOnly !== false,
      finite(market.rewardsDailyRate) || 0, finite(market.rewardsMinSize) || 0,
      finite(market.rewardsMaxSpread) || 0,
      market.rewardsStartDate ? new Date(market.rewardsStartDate) : null,
      market.rewardsEndDate ? new Date(market.rewardsEndDate) : null,
      market.gameStartTime ? new Date(market.gameStartTime) : null,
      true, market.selectionScore,
      market.selectionReason, true, new Date(),
    ]);
    if (rows.length) await insertRows('pmm_markets', MARKET_COLUMNS, rows, `ON CONFLICT (condition_id) DO UPDATE SET
      gamma_id=EXCLUDED.gamma_id,event_id=EXCLUDED.event_id,event_slug=EXCLUDED.event_slug,
      slug=EXCLUDED.slug,question=EXCLUDED.question,category=EXCLUDED.category,end_date=EXCLUDED.end_date,
      outcomes=EXCLUDED.outcomes,token_ids=EXCLUDED.token_ids,tick_size=EXCLUDED.tick_size,
      order_min_size=EXCLUDED.order_min_size,liquidity=EXCLUDED.liquidity,volume_24h=EXCLUDED.volume_24h,
      fee_rate=EXCLUDED.fee_rate,fee_exponent=EXCLUDED.fee_exponent,
      fee_taker_only=EXCLUDED.fee_taker_only,rewards_daily_rate=EXCLUDED.rewards_daily_rate,
      rewards_min_size=EXCLUDED.rewards_min_size,rewards_max_spread=EXCLUDED.rewards_max_spread,
      rewards_start_at=EXCLUDED.rewards_start_at,rewards_end_at=EXCLUDED.rewards_end_at,
      game_start_at=EXCLUDED.game_start_at,
      selected_realtime=true,selection_score=EXCLUDED.selection_score,
      selection_reason=EXCLUDED.selection_reason,active=true,refreshed_at=EXCLUDED.refreshed_at`);
  }

  async refreshUniverse() {
    if (this.refreshing || this.stopping) return;
    this.refreshing = true;
    try {
      const universe = await discoverUniverse({
        rewardPages: Number(process.env.PAIRED_MAKER_REWARD_PAGES || 8),
        rewardFetchLimit: Number(process.env.PAIRED_MAKER_REWARD_FETCH_LIMIT || 120),
        gammaPages: Number(process.env.PAIRED_MAKER_GAMMA_PAGES || 20),
        gammaWindows: Number(process.env.PAIRED_MAKER_GAMMA_WINDOWS || 10),
      });
      const panel = selectPairedPanel(universe, {
        maxMarkets: MAX_MARKETS, minTteSec: 600, preferredTteDays: 14,
        targetPairUsd: TARGET_PAIR_USD, maxReservedUsd: MAX_RESERVED_USD_PER_ARM,
        minPairEdge: 0.01, rewardOnly: true, requireKnownGameStart: true,
      });
      this.metrics.universeScanned = universe.length;
      const nextMarkets = new Map(panel.map((market) => [market.conditionId, market]));
      for (const cycle of this.cycles.values()) nextMarkets.set(cycle.conditionId, cycle.market);
      this.markets = nextMarkets;
      this.tokenMeta.clear();
      for (const market of this.markets.values()) {
        market.tokenIds.forEach((assetId, index) => this.tokenMeta.set(String(assetId), {
          conditionId: market.conditionId, assetId: String(assetId), outcome: market.outcomes[index], market,
        }));
      }
      await this.persistMarkets(panel);
      this.clob.subscribe([...this.tokenMeta.keys()]);
      await logEvent('INFO', 'paired_maker_lab', 'paired-maker universe refreshed', {
        scanned: universe.length, selected: panel.length, retainedForOpenCycles: this.markets.size - panel.length,
        categories: [...new Set(panel.map((market) => market.category))],
        phases: [...new Set(panel.map((market) => market.marketPhase))],
        totalDailyRewardPool: panel.reduce((sum, market) => sum + (finite(market.rewardsDailyRate) || 0), 0),
      });
    } finally {
      this.refreshing = false;
    }
  }

  async flush() {
    if (this.flushing) return;
    this.flushing = true;
    const batches = {
      observations: this.buffers.observations.splice(0, 5000),
      events: this.buffers.events.splice(0, 5000),
      cycles: this.buffers.cycles.splice(0, 5000),
    };
    const cycles = lastRowsByKey(batches.cycles, (row) => row[0]);
    try {
      if (batches.observations.length) await insertRows('pmm_pair_observations', OBSERVATION_COLUMNS, batches.observations);
      if (batches.events.length) await insertRows('pmm_events', EVENT_COLUMNS, batches.events, 'ON CONFLICT (event_id) DO NOTHING');
      if (cycles.length) await insertRows('pmm_cycles', CYCLE_COLUMNS, cycles, CYCLE_CONFLICT);
    } catch (error) {
      for (const key of Object.keys(batches)) this.buffers[key].unshift(...batches[key]);
      throw error;
    } finally {
      this.flushing = false;
    }
  }

  async heartbeat(status = 'RUNNING') {
    const queued = Object.values(this.buffers).reduce((sum, rows) => sum + rows.length, 0);
    const openOrphans = [...this.cycles.values()].filter((cycle) => orphanPosition(cycle)).length;
    const meanReactionUs = this.metrics.reactionCount
      ? this.metrics.reactionUsSum / this.metrics.reactionCount : null;
    const meta = {
      runId: RUN_ID, experimentId: EXPERIMENT_ID, pid: process.pid, host: os.hostname(),
      paperOnly: true, walletLoaded: false, liveOrderPath: false, databaseInHotPath: false,
      targetPairUsd: TARGET_PAIR_USD, maxReservedUsdPerArm: MAX_RESERVED_USD_PER_ARM,
      startingBankrollUsd: 500, arms: ARMS,
      rewardAccounting: 'MODELED_PUBLIC_L2_NOT_REALIZED_OR_CLAIMED',
      selectedMarkets: this.markets.size, subscribedTokens: this.tokenMeta.size,
      openCycles: this.cycles.size, openOrphans, reactionUsMean: meanReactionUs,
      wal: { market: this.marketWal.health(), decisions: this.decisionWal.health() },
      ...this.metrics,
    };
    await Promise.all([
      pool.query(`
        UPDATE pmm_runtime SET status=$2,selected_markets=$3,subscribed_tokens=$4,
          open_cycles=$5,events=$6,pair_observations=$7,eligible_one_cent=$8,
          eligible_two_cent=$9,maker_fills=$10,completed_cycles=$11,orphan_exits=$12,
          persistence_queue=$13,last_event_at=$14,last_cycle_at=$15,updated_at=now(),metrics=$16::jsonb
        WHERE run_id=$1
      `, [RUN_ID, status, this.markets.size, this.tokenMeta.size, this.cycles.size,
        this.metrics.events, this.metrics.pairObservations, this.metrics.eligibleOneCent,
        this.metrics.eligibleTwoCent, this.metrics.makerFillEvents, this.metrics.completedCycles,
        this.metrics.orphanExits, queued, this.metrics.lastEventAt ? iso(this.metrics.lastEventAt) : null,
        this.metrics.lastCycleAt ? iso(this.metrics.lastCycleAt) : null, json(meta)]),
      pool.query(`
        INSERT INTO system_heartbeats (component,beat_at,meta)
        VALUES ('paired_maker_lab',now(),$1::jsonb)
        ON CONFLICT (component) DO UPDATE SET beat_at=now(),meta=EXCLUDED.meta
      `, [json(meta)]),
    ]);
  }

  async stop(signal) {
    if (this.stopping) return;
    this.stopping = true;
    this.timers.forEach(clearInterval);
    const now = Date.now();
    for (const cycle of [...this.cycles.values()]) {
      cycle.legs.forEach((leg) => { if (leg.quote) leg.quote.active = false; });
      mergeCompleteSets(cycle);
      if (orphanPosition(cycle)) {
        const result = liquidateOrphan(cycle, this.booksFor(cycle.market), {
          nowMs: now, staleMs: STALE_MS, adverseTicks: 1,
        });
        if (result.filled) this.finishCycle(cycle, 'STOP_ORPHAN_LIQUIDATED', now);
        else {
          this.metrics.openOrphanInterruptions += 1;
          closeCycle(cycle, 'STOPPED_OPEN_ORPHAN_UNSCORED', now);
          this.writeEvent(cycle, 'CYCLE_CLOSE', {
            observedAt: now, status: cycle.status,
            detail: { realized: false, exitFailure: result.reason, totalPnl: null },
          });
          this.saveCycle(cycle);
          this.cycles.delete(cycleKey(cycle.conditionId, cycle.arm));
        }
      } else {
        this.finishCycle(cycle, cycle.mergedShares > 0 ? 'STOP_LOCKED' : 'STOP_NO_FILL', now);
      }
    }
    await this.flush().catch(() => {});
    await this.heartbeat('STOPPED').catch(() => {});
    await pool.query('UPDATE pmm_runtime SET stopped_at=now(),status=$2 WHERE run_id=$1', [RUN_ID, 'STOPPED']).catch(() => {});
    this.clob.close();
    await Promise.all([this.marketWal.close(), this.decisionWal.close()]).catch(() => {});
    await pool.end().catch(() => {});
    console.log(`[paired_maker_lab] stopped by ${signal}`);
  }
}

async function main() {
  const lab = new PairedMakerLab();
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
  ARMS,
  EXPERIMENT_ID,
  PairedMakerLab,
  RUN_ID,
  STRATEGY,
  cycleRow,
  lastRowsByKey,
  pairGrade,
};
