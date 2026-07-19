#!/usr/bin/env node
'use strict';

/**
 * Live-data Polymarket/Kalshi cross-venue laboratory.
 *
 * PAPER ONLY. This process imports no wallet, signer, authenticated trading
 * client, or order-posting function. Polymarket books are streamed over the
 * public CLOB WebSocket. Kalshi books use public REST until an eligible,
 * read-only authenticated WebSocket deployment is explicitly configured.
 */

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const ClobMultiplex = require('../recon/clob-multiplex');
const RawWal = require('../recon/wal');
const { KalshiReadOnlyFeed } = require('./kalshi-ws');
const { MakerLab } = require('./maker-lab');
const { pool, migrateCrossVenue, insertRows, logEvent } = require('../recon/db');
const { STARTING_BANKROLL_USD } = require('../research/capital-policy');
const {
  KALSHI, candidateId, discoverCrossVenue, fetchJson, isRejectedIdentity,
  loadManualIdentityReviews, selectMonitoredCandidates,
} = require('./universe');
const { compileCrossVenueRelation } = require('./payoff-relations');
const {
  relationEpisodeId, updateRelationEpisode,
} = require('./relation-episodes');
const {
  evaluateBasisPair, finite, normalizeKalshiBook, optimizePair,
} = require('./strategy');
const {
  appendHistory, cloneBooks, selectSynchronizedBooks,
} = require('./synchronizer');

const RUN_ID = `crossvenue:${os.hostname()}:${new Date().toISOString()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
const EXPERIMENT_ID = 'crossvenue-certified-convergence-v3';
const REFRESH_MS = Math.max(300_000, Number(process.env.CROSSVENUE_REFRESH_MS || 900_000));
const KALSHI_POLL_MS = Math.max(1000, Number(process.env.CROSSVENUE_KALSHI_POLL_MS || 2000));
const MAX_MONITORED = Math.max(1, Math.min(60, Number(process.env.CROSSVENUE_MAX_MONITORED || 12)));
const HOT_MONITORED = Math.max(1, Math.min(MAX_MONITORED, Number(process.env.CROSSVENUE_HOT_MONITORED || 6)));
const BROAD_POLL_MS = Math.max(10_000, Number(process.env.CROSSVENUE_BROAD_POLL_MS || 30_000));
const MAX_CANDIDATES = Math.max(MAX_MONITORED, Number(process.env.CROSSVENUE_MAX_CANDIDATES || 250));
const DIAGNOSTIC_CONTROLS = Math.max(0, Math.min(MAX_MONITORED,
  Number(process.env.CROSSVENUE_DIAGNOSTIC_CONTROLS || 4)));
const STALE_MS = Math.max(KALSHI_POLL_MS, Number(process.env.CROSSVENUE_STALE_MS || 5000));
const POLY_FEED_STALE_MS = Math.max(10_000, Number(process.env.CROSSVENUE_POLY_FEED_STALE_MS || 20_000));
const EVALUATION_THROTTLE_MS = Math.max(100, Number(process.env.CROSSVENUE_EVALUATION_THROTTLE_MS || 500));
const MAX_PAIR_SKEW_MS = Math.max(10, Number(process.env.CROSSVENUE_MAX_PAIR_SKEW_MS || 250));
const SYNC_HOLDBACK_MS = Math.max(0, Number(process.env.CROSSVENUE_SYNC_HOLDBACK_MS || 250));
const BOOK_HISTORY_MS = Math.max(10_000, Number(process.env.CROSSVENUE_BOOK_HISTORY_MS || 30_000));
const CONTROL_CAPTURE_MS = Math.max(5000, Number(process.env.CROSSVENUE_CONTROL_CAPTURE_MS || 30_000));
const QUANTITIES = String(process.env.CROSSVENUE_QUANTITIES || '1,5,10,25,50,100')
  .split(',').map(Number).filter((value) => value > 0 && value <= 250);
const BASIS_QUANTITY = Math.max(1, Math.min(250, Number(process.env.CROSSVENUE_BASIS_QUANTITY || 5)));
const TOTAL_CAPITAL_USD = Math.max(1,
  Number(process.env.CROSSVENUE_TOTAL_CAPITAL_USD || STARTING_BANKROLL_USD));
const CAPITAL_PER_VENUE_USD = Math.max(1,
  Number(process.env.CROSSVENUE_CAPITAL_PER_VENUE_USD || TOTAL_CAPITAL_USD / 2));
const MAX_OPTIMIZED_QUANTITY = Math.max(1,
  Number(process.env.CROSSVENUE_MAX_OPTIMIZED_QUANTITY || 10_000));

const MATCH_COLUMNS = [
  'match_id', 'poly_condition_id', 'poly_gamma_id', 'poly_question',
  'poly_yes_token', 'poly_no_token', 'kalshi_ticker', 'kalshi_event_ticker',
  'kalshi_title', 'match_score', 'title_similarity', 'identity_status',
  'identity_approved', 'identity_snapshot_hash', 'identity_certification',
  'relation_type', 'relation_approved', 'relation_status',
  'relation_proof', 'relation_resolution_audit', 'state_evidence',
  'approval_source', 'resolution_audit', 'mismatch_reasons',
  'end_delta_hours', 'monitored', 'active', 'metadata', 'refreshed_at',
];
const SNAPSHOT_COLUMNS = [
  'observed_at', 'match_id', 'trigger_venue', 'poly_book_at', 'kalshi_book_at',
  'poly_age_ms', 'kalshi_age_ms', 'pair_skew_ms',
  'poly_yes_bid', 'poly_yes_bid_size', 'poly_yes_ask', 'poly_yes_ask_size',
  'poly_no_bid', 'poly_no_bid_size', 'poly_no_ask', 'poly_no_ask_size',
  'kalshi_yes_bid', 'kalshi_yes_bid_size', 'kalshi_yes_ask', 'kalshi_yes_ask_size',
  'kalshi_no_bid', 'kalshi_no_bid_size', 'kalshi_no_ask', 'kalshi_no_ask_size',
  'data_quality_grade', 'execution_fidelity_grade', 'book_signature',
  'experiment_id', 'synchronized', 'causal_cut_at', 'detail',
];
const OPPORTUNITY_COLUMNS = [
  'opportunity_id', 'observed_at', 'match_id', 'episode_id', 'direction',
  'quantity', 'poly_outcome', 'kalshi_outcome', 'poly_vwap', 'kalshi_vwap',
  'poly_fee', 'kalshi_fee', 'total_cost', 'locked_profit_after_both_fills',
  'stressed_profit', 'indicative_economic', 'economic', 'identity_approved',
  'relation_type', 'relation_approved', 'guaranteed_min_payout_per_share',
  'payoff_proof_hash', 'books_fresh', 'full_depth',
  'atomic', 'lockable_after_both_fills', 'status', 'data_quality_grade',
  'execution_fidelity_grade', 'experiment_id', 'synchronized', 'detail',
];
const RELATION_EPISODE_COLUMNS = [
  'episode_id', 'experiment_id', 'match_id', 'relation_id', 'direction', 'payoff_proof_hash',
  'state_active_from', 'first_observed_at', 'last_observed_at',
  'first_economic_at', 'last_economic_at', 'disappeared_at', 'closed_at',
  'lifecycle_status', 'observations', 'economic_observations',
  'disappearances', 'reappearances', 'max_quantity', 'max_total_cost',
  'max_raw_profit', 'max_stressed_profit', 'worst_orphan_unwind_pnl',
  'orphan_stress_loss_observations', 'orphan_unwind_unavailable_observations',
  'first_opportunity_id', 'last_opportunity_id', 'last_data_quality_grade',
  'last_execution_fidelity_grade', 'detail',
];
const MAKER_EPISODE_COLUMNS = [
  'episode_id', 'match_id', 'direction', 'started_at', 'ended_at', 'status',
  'poly_quote', 'kalshi_quote', 'poly_filled_at', 'kalshi_filled_at',
  'requotes', 'observations', 'stale_observations',
  'locked_margin', 'orphan_leg', 'orphan_unwind_pnl', 'fees',
  'experiment_id', 'detail',
];
const BASIS_COLUMNS = [
  'sample_id', 'observed_at', 'match_id', 'direction', 'quantity',
  'poly_outcome', 'kalshi_outcome', 'poly_entry_vwap', 'kalshi_entry_vwap',
  'poly_exit_vwap', 'kalshi_exit_vwap', 'poly_entry_fee', 'kalshi_entry_fee',
  'poly_exit_fee', 'kalshi_exit_fee', 'entry_total_cost',
  'gross_liquidation_proceeds', 'net_liquidation_proceeds',
  'terminal_locked_profit', 'immediate_round_trip_pnl', 'indicative_entry_economic',
  'entry_economic', 'identity_approved', 'relation_type', 'relation_approved',
  'guaranteed_min_payout_per_share', 'payoff_proof_hash',
  'books_fresh', 'full_entry_depth', 'full_exit_depth',
  'data_quality_grade', 'execution_fidelity_grade', 'book_signature',
  'experiment_id', 'synchronized', 'detail',
];

function json(value) { return JSON.stringify(value ?? {}); }
function iso(ms) { return new Date(ms); }

function top(book) {
  const bid = finite(book?.bids?.[0]?.[0]); const bidSize = finite(book?.bids?.[0]?.[1]);
  const ask = finite(book?.asks?.[0]?.[0]); const askSize = finite(book?.asks?.[0]?.[1]);
  return { bid, bidSize, ask, askSize };
}

function signature(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function episodeRow(episode) {
  return [
    episode.episodeId, episode.experimentId || EXPERIMENT_ID,
    episode.matchId, episode.relationId, episode.direction,
    episode.payoffProofHash, episode.stateActiveFrom, episode.firstObservedAt,
    episode.lastObservedAt, episode.firstEconomicAt, episode.lastEconomicAt,
    episode.disappearedAt, episode.closedAt, episode.lifecycleStatus,
    episode.observations, episode.economicObservations, episode.disappearances,
    episode.reappearances, episode.maxQuantity, episode.maxTotalCost,
    episode.maxRawProfit, episode.maxStressedProfit, episode.worstOrphanUnwindPnl,
    episode.orphanStressLossObservations, episode.orphanUnwindUnavailableObservations,
    episode.firstOpportunityId, episode.lastOpportunityId,
    episode.lastDataQualityGrade, episode.lastExecutionFidelityGrade,
    json(episode.detail),
  ];
}

function episodeFromDb(row) {
  return {
    episodeId: row.episode_id, experimentId: row.experiment_id,
    matchId: row.match_id, relationId: row.relation_id,
    direction: row.direction, payoffProofHash: row.payoff_proof_hash,
    stateActiveFrom: row.state_active_from, firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at, firstEconomicAt: row.first_economic_at,
    lastEconomicAt: row.last_economic_at, disappearedAt: row.disappeared_at,
    closedAt: row.closed_at, lifecycleStatus: row.lifecycle_status,
    observations: parseInt(row.observations, 10) || 0,
    economicObservations: parseInt(row.economic_observations, 10) || 0,
    disappearances: parseInt(row.disappearances, 10) || 0,
    reappearances: parseInt(row.reappearances, 10) || 0,
    maxQuantity: finite(row.max_quantity), maxTotalCost: finite(row.max_total_cost),
    maxRawProfit: finite(row.max_raw_profit), maxStressedProfit: finite(row.max_stressed_profit),
    worstOrphanUnwindPnl: finite(row.worst_orphan_unwind_pnl),
    orphanStressLossObservations: parseInt(row.orphan_stress_loss_observations, 10) || 0,
    orphanUnwindUnavailableObservations: parseInt(row.orphan_unwind_unavailable_observations, 10) || 0,
    firstOpportunityId: row.first_opportunity_id, lastOpportunityId: row.last_opportunity_id,
    lastDataQualityGrade: row.last_data_quality_grade,
    lastExecutionFidelityGrade: row.last_execution_fidelity_grade,
    detail: row.detail || {},
  };
}

class CrossVenueLab {
  constructor() {
    this.startedAt = Date.now();
    this.matches = new Map();
    this.tokenMatches = new Map();
    this.kalshiBooks = new Map();
    this.polyBookHistory = new Map();
    this.kalshiBookHistory = new Map();
    this.pendingEvaluations = new Map();
    this.lastEvaluationAt = new Map();
    this.lastSignature = new Map();
    this.lastControlAt = new Map();
    this.episodes = new Map();
    this.relationEpisodes = new Map();
    this.buffers = { snapshots: [], opportunities: [], basis: [], makerEpisodes: [], relationEpisodes: new Map() };
    this.makerLab = new MakerLab({
      orphanTimeoutMs: Number(process.env.CROSSVENUE_MAKER_ORPHAN_TIMEOUT_MS || 600_000),
      onEpisode: (row) => {
        this.decisionWal.append(json({ channel: 'maker-episode', ...row }),
          { channel: 'maker-episode', sourceMs: Date.now() });
        this.buffers.makerEpisodes.push([
          row.episodeId, row.matchId, row.direction, iso(row.startedAt), iso(row.endedAt),
          row.status, row.polyQuote, row.kalshiQuote,
          row.polyFilledAt ? iso(row.polyFilledAt) : null,
          row.kalshiFilledAt ? iso(row.kalshiFilledAt) : null,
          row.requotes, row.observations, row.staleObservations,
          row.lockedMargin, row.orphanLeg, row.orphanUnwindPnl, row.fees,
          EXPERIMENT_ID, json(row.detail),
        ]);
        this.metrics.makerEpisodes = (this.metrics.makerEpisodes || 0) + 1;
        if (row.status === 'LOCKED') {
          this.metrics.makerLocked = (this.metrics.makerLocked || 0) + 1;
        }
      },
    });
    this.flushing = false; this.refreshing = false; this.polling = false; this.stopping = false;
    this.timers = [];
    this.metrics = {
      polyMarkets: 0, kalshiMarkets: 0, candidates: 0, approvedMatches: 0,
      pendingCandidates: 0, reviewedRejected: 0, monitoredMatches: 0,
      snapshots: 0, evaluations: 0, economicLeads: 0,
      lockableNonatomic: 0, basisSamples: 0, kalshiPolls: 0, kalshiBatchRequests: 0,
      kalshiErrors: 0, polyEvents: 0, diagnosticControls: 0,
      kalshiWsEvents: 0, kalshiWsFallbacks: 0,
      synchronizedSnapshots: 0, synchronizationRejects: 0,
      lastMarketAt: null, lastEvaluationAt: null,
    };
    const walOptions = {
      root: process.env.BORG_WAL_DIR,
      mirrorRoot: process.env.BORG_WAL_MIRROR_DIR || null,
      collectionEpochId: process.env.BORG_COLLECTION_EPOCH_ID,
      collectorRunId: RUN_ID,
    };
    this.kalshiWal = new RawWal('crossvenue-kalshi', walOptions);
    this.polyWal = new RawWal('crossvenue-poly', walOptions);
    this.decisionWal = new RawWal('crossvenue-decisions', walOptions);
    this.kalshiFeed = new KalshiReadOnlyFeed({
      wal: this.kalshiWal,
      onBook: (state) => this.onKalshiWsBook(state),
      onError: (error) => this.recordError('kalshi_readonly_ws', error),
    });
    this.clob = new ClobMultiplex((assetId) => {
      const matchId = this.tokenMatches.get(String(assetId))?.values().next().value;
      return matchId ? this.matches.get(matchId)?.poly.conditionId : null;
    }, {
      shardCount: Number(process.env.CROSSVENUE_POLY_SHARDS || 2),
      wal: this.polyWal,
      persistDerivedEvents: false,
      emitTradeEvents: false,
      onMarketEvent: (event) => this.onPolyEvent(event),
    });
  }

  async start() {
    await migrateCrossVenue();
    await this.syncFrozenRelationReviews();
    await this.loadRelationEpisodes();
    await pool.query(`
      INSERT INTO cv_runtime (run_id,started_at,host,pid,paper_only,wallet_loaded,status,metrics,experiment_id)
      VALUES ($1,now(),$2,$3,true,false,'STARTING',$4::jsonb,$5)
    `, [RUN_ID, os.hostname(), process.pid, json({
      kalshiTransport: this.kalshiFeed.transport(),
      kalshiWsConfigured: this.kalshiFeed.configured(), quantities: QUANTITIES,
    }), EXPERIMENT_ID]);
    const cachedMatches = await this.loadCachedMatches();
    if (!cachedMatches) await this.refreshUniverse();
    // The frozen identity file is loaded at process start. Opening an empty
    // market-channel socket only creates an abnormal-close reconnect loop, so
    // connect only when an approved/pending pair or bounded diagnostic control
    // supplied token IDs.
    if (this.tokenMatches.size > 0) await this.clob.connect();
    this.kalshiFeed.connect([...new Set([...this.matches.values()].map((match) => match.kalshi.ticker))]);
    await this.pollKalshi('hot');
    await this.pollKalshi('broad');
    this.timers = [
      setInterval(() => this.pollKalshi('hot').catch((error) => this.recordError('kalshi_hot_poll', error)), KALSHI_POLL_MS),
      setInterval(() => this.pollKalshi('broad').catch((error) => this.recordError('kalshi_broad_poll', error)), BROAD_POLL_MS),
      setInterval(() => this.flush().catch((error) => this.recordError('flush', error)), 250),
      setInterval(() => this.refreshUniverse().catch((error) => this.recordError('universe', error)), REFRESH_MS),
      setInterval(() => this.clob.checkStale(), 10_000),
      setInterval(() => this.heartbeat().catch(() => {}), 10_000),
    ];
    await this.heartbeat('RUNNING');
    await logEvent('INFO', 'crossvenue_lab', 'paper-only Polymarket/Kalshi collector started', {
      runId: RUN_ID, candidates: this.metrics.candidates, monitored: this.matches.size,
      approved: this.metrics.approvedMatches, walletLoaded: false, liveOrderPath: false,
      kalshiTransport: this.kalshiFeed.transport(),
      kalshiWsConfigured: this.kalshiFeed.configured(),
      experimentId: EXPERIMENT_ID, maxPairSkewMs: MAX_PAIR_SKEW_MS,
    });
    if (cachedMatches) {
      this.refreshUniverse().catch((error) => this.recordError('background_universe', error));
    }
  }

  recordError(scope, error) {
    logEvent('ERROR', 'crossvenue_lab', `${scope}: ${error.message}`).catch(() => {});
  }

  async syncFrozenRelationReviews() {
    // V2 approvals were not bound to content-addressed venue rules. They remain
    // historical evidence but cannot leak into the V3 evidence clock.
    await pool.query(`UPDATE cv_contract_matches
      SET identity_approved=false,
          relation_approved=false,
          relation_status=CASE WHEN relation_status IN ('MANUALLY_APPROVED','PENDING_STATE')
            THEN 'REQUIRES_RULE_HASH_REVIEW' ELSE relation_status END
      WHERE COALESCE((identity_certification->>'valid')::boolean,false)=false`);
    const reviews = loadManualIdentityReviews().relations;
    for (const review of reviews) {
      const relation = compileCrossVenueRelation(review);
      const matchId = candidateId(review.polyConditionId, review.kalshiTicker);
      const { rows } = await pool.query(`SELECT identity_certification
        FROM cv_contract_matches WHERE match_id=$1`, [matchId]);
      const certification = rows[0]?.identity_certification || null;
      const approved = relation.relationApproved && certification?.valid === true;
      const status = approved ? relation.relationStatus
        : relation.relationApproved ? 'REQUIRES_RULE_HASH_REVIEW' : relation.relationStatus;
      const activeTimes = [relation.activeFrom, certification?.activeFrom]
        .map((value) => Date.parse(value)).filter(Number.isFinite);
      const certifiedRelation = {
        ...relation, relationApproved: approved, relationStatus: status,
        activeFrom: activeTimes.length ? new Date(Math.max(...activeTimes)).toISOString() : null,
        identityCertification: certification,
      };
      await pool.query(`UPDATE cv_contract_matches
        SET relation_type=$2,relation_approved=$3,relation_status=$4,
            relation_proof=$5::jsonb,relation_resolution_audit=$6::jsonb,
            state_evidence=$7::jsonb,approval_source=CASE WHEN $3
              THEN 'frozen_payoff_relation_review' ELSE approval_source END,
            refreshed_at=now()
        WHERE match_id=$1`, [
        matchId, relation.relationType, approved, status,
        json(certifiedRelation), json(relation.resolutionAudit), json(relation.stateEvidence),
      ]);
    }
  }

  async loadRelationEpisodes() {
    const { rows } = await pool.query(`
      SELECT * FROM cv_relation_episodes
       WHERE closed_at IS NULL AND experiment_id=$1
       ORDER BY first_observed_at`, [EXPERIMENT_ID]);
    this.relationEpisodes = new Map(rows.map((row) => {
      const episode = episodeFromDb(row);
      return [episode.episodeId, episode];
    }));
  }

  queueRelationEpisode(episode) {
    if (!episode) return;
    this.relationEpisodes.set(episode.episodeId, episode);
    this.buffers.relationEpisodes.set(episode.episodeId, episode);
  }

  relationEpisodeFor(match, direction) {
    const relation = match?.relationProof;
    if (!match?.relationApproved || !relation?.id) return null;
    return relationEpisodeId({
      matchId: match.matchId,
      relationId: relation.id,
      direction,
      activeFrom: relation.activeFrom,
      experimentId: EXPERIMENT_ID,
    });
  }

  observeRelationEpisode(match, direction, now, context = {}) {
    const relation = match?.relationProof;
    if (!match?.relationApproved || !relation?.id) return null;
    const episodeId = this.relationEpisodeFor(match, direction);
    const previous = this.relationEpisodes.get(episodeId) || null;
    const next = updateRelationEpisode(previous, {
      episodeId,
      matchId: match.matchId,
      relationId: relation.id,
      direction,
      activeFrom: relation.activeFrom,
      experimentId: EXPERIMENT_ID,
      relationApproved: true,
      payoffProofHash: context.payoffProofHash || null,
      observedAt: new Date(now),
      ...context,
    });
    this.queueRelationEpisode(next);
    return next;
  }

  installMonitoredMatches(matches) {
    this.matches = new Map(matches.map((match) => [match.matchId, match]));
    this.tokenMatches = new Map();
    for (const match of matches) {
      for (const token of [match.poly.yesToken, match.poly.noToken]) {
        if (!this.tokenMatches.has(token)) this.tokenMatches.set(token, new Set());
        this.tokenMatches.get(token).add(match.matchId);
      }
    }
    for (const matchId of this.polyBookHistory.keys()) {
      if (!this.matches.has(matchId)) this.polyBookHistory.delete(matchId);
    }
    const activeTickers = new Set(matches.map((match) => match.kalshi.ticker));
    for (const ticker of this.kalshiBookHistory.keys()) {
      if (!activeTickers.has(ticker)) this.kalshiBookHistory.delete(ticker);
    }
    this.clob.subscribe([...this.tokenMatches.keys()]);
    this.kalshiFeed.setTickers([...new Set(matches.map((match) => match.kalshi.ticker))]);
  }

  recordPolyState(match, triggerEvent = null) {
    const yes = this.clob.getBook(match?.poly?.yesToken);
    const no = this.clob.getBook(match?.poly?.noToken);
    if (!yes || !no) return null;
    const yesAt = finite(yes.at); const noAt = finite(no.at);
    if (yesAt == null || noAt == null) return null;
    const state = {
      receivedAt: Math.max(yesAt, noAt),
      oldestLegAt: Math.min(yesAt, noAt),
      sourceMs: Math.max(finite(yes.sourceAt, 0), finite(no.sourceAt, 0)) || null,
      books: cloneBooks({ YES: yes, NO: no }),
      yesAt, noAt,
      yesSourceMs: finite(yes.sourceAt), noSourceMs: finite(no.sourceAt),
      connectionEpoch: triggerEvent?.connectionEpoch ?? null,
      connectionShard: triggerEvent?.connectionShard ?? null,
      eventSequence: triggerEvent?.eventSequence ?? null,
      walEventId: triggerEvent?.walEventId ?? null,
      transport: 'public_clob_ws',
    };
    const history = this.polyBookHistory.get(match.matchId) || [];
    appendHistory(history, state, { nowMs: Date.now(), maxAgeMs: BOOK_HISTORY_MS });
    this.polyBookHistory.set(match.matchId, history);
    return state;
  }

  recordKalshiState(ticker, state) {
    if (!ticker || !state?.books || !Number.isFinite(finite(state.receivedAt))) return null;
    const history = this.kalshiBookHistory.get(String(ticker)) || [];
    appendHistory(history, { ...state, books: cloneBooks(state.books) }, {
      nowMs: Date.now(), maxAgeMs: BOOK_HISTORY_MS,
    });
    this.kalshiBookHistory.set(String(ticker), history);
    return state;
  }

  queueEvaluation(matchId, triggerVenue) {
    const pending = this.pendingEvaluations.get(matchId);
    if (pending) {
      pending.triggerVenue = triggerVenue;
      return;
    }
    const record = { triggerVenue, timer: null };
    record.timer = setTimeout(() => {
      this.pendingEvaluations.delete(matchId);
      this.evaluateMatch(matchId, record.triggerVenue);
    }, SYNC_HOLDBACK_MS);
    record.timer.unref?.();
    this.pendingEvaluations.set(matchId, record);
  }

  async loadCachedMatches() {
    const [matchesResult, priorRuntime] = await Promise.all([
      pool.query(`SELECT * FROM cv_contract_matches WHERE active=true
        ORDER BY relation_approved DESC,identity_approved DESC,match_score DESC,refreshed_at DESC LIMIT $1`, [MAX_CANDIDATES]),
      pool.query(`SELECT poly_markets,kalshi_markets FROM cv_runtime
        WHERE run_id<>$1 ORDER BY started_at DESC LIMIT 1`, [RUN_ID]),
    ]);
    if (!matchesResult.rows.length) return 0;
    const candidates = matchesResult.rows.map((row) => {
      const metadata = row.metadata || {}; const poly = metadata.poly || {}; const kalshi = metadata.kalshi || {};
      return {
        matchId: row.match_id, score: finite(row.match_score, 0),
        titleSimilarity: finite(row.title_similarity, 0), identityStatus: row.identity_status,
        identityApproved: row.identity_approved === true, approvalSource: row.approval_source,
        identityCertification: row.identity_certification || null,
        identitySnapshotHash: row.identity_snapshot_hash || null,
        resolutionAudit: row.resolution_audit, mismatches: row.mismatch_reasons || [],
        relationType: row.relation_type || 'UNREVIEWED',
        relationApproved: row.relation_approved === true,
        relationStatus: row.relation_status || 'PENDING_REVIEW',
        relationProof: row.relation_proof ? {
          ...row.relation_proof,
          relationApproved: row.relation_approved === true,
          relationStatus: row.relation_status || 'PENDING_REVIEW',
        } : null,
        relationResolutionAudit: row.relation_resolution_audit || null,
        stateEvidence: row.state_evidence || null,
        endDeltaHours: finite(row.end_delta_hours), ...(metadata.audit || {}),
        poly: {
          ...poly, conditionId: row.poly_condition_id, gammaId: row.poly_gamma_id,
          question: row.poly_question, yesToken: row.poly_yes_token, noToken: row.poly_no_token,
        },
        kalshi: {
          ...kalshi, ticker: row.kalshi_ticker, eventTicker: row.kalshi_event_ticker,
          title: row.kalshi_title,
        },
      };
    });
    const selection = selectMonitoredCandidates(candidates, MAX_MONITORED, DIAGNOSTIC_CONTROLS);
    const monitoredIds = selection.monitored.map((match) => match.matchId);
    await pool.query('UPDATE cv_contract_matches SET monitored=(match_id=ANY($1::text[])) WHERE active=true',
      [monitoredIds]);
    this.installMonitoredMatches(selection.monitored);
    const prior = priorRuntime.rows[0] || {};
    this.metrics.polyMarkets = Number(prior.poly_markets || 0);
    this.metrics.kalshiMarkets = Number(prior.kalshi_markets || 0);
    this.metrics.candidates = candidates.length;
    this.metrics.pendingCandidates = candidates.filter((row) =>
      !row.relationApproved && !isRejectedIdentity(row)).length;
    this.metrics.reviewedRejected = candidates.filter(isRejectedIdentity).length;
    this.metrics.approvedMatches = candidates.filter((row) => row.relationApproved).length;
    this.metrics.monitoredMatches = selection.monitored.length;
    this.metrics.diagnosticControls = selection.diagnosticControls;
    await logEvent('INFO', 'crossvenue_lab', 'loaded cached cross-venue universe for fast startup', {
      candidates: candidates.length, monitored: selection.monitored.length,
      diagnosticControls: selection.diagnosticControls,
    });
    return selection.monitored.length;
  }

  async refreshUniverse() {
    if (this.refreshing || this.stopping) return;
    this.refreshing = true;
    try {
      const universe = await discoverCrossVenue({
        kalshiPages: Number(process.env.CROSSVENUE_KALSHI_PAGES || 20),
        gammaPages: Number(process.env.CROSSVENUE_GAMMA_PAGES || 20),
        gammaWindows: Number(process.env.CROSSVENUE_GAMMA_WINDOWS || 10),
        maxCandidates: MAX_CANDIDATES, maxMonitored: MAX_MONITORED,
        rejectedControlLimit: DIAGNOSTIC_CONTROLS,
        structuredMonitored: Number(process.env.CROSSVENUE_STRUCTURED_MONITORED || 8),
        onCryptoError: (series, error) => this.recordError(`kalshi_crypto_${series}`, error),
      });
      const monitored = new Set(universe.monitored.map((match) => match.matchId));
      await pool.query('UPDATE cv_contract_matches SET monitored=false,active=false');
      const ruleRows = [...new Map(universe.candidates.flatMap((match) => {
        const certification = match.identityCertification;
        if (!certification) return [];
        return [
          [certification.polyRuleHash, 'POLYMARKET', match.poly.conditionId, certification.polymarket],
          [certification.kalshiRuleHash, 'KALSHI', match.kalshi.ticker, certification.kalshi],
        ];
      }).filter((row) => row[0]).map((row) => [row[0], row])).values()];
      await insertRows('cv_rule_snapshots', [
        'rule_hash', 'venue', 'contract_id', 'rule_document',
      ], ruleRows.map(([ruleHash, venue, contractId, document]) => [
        ruleHash, venue, contractId, json(document),
      ]), 'ON CONFLICT (rule_hash) DO NOTHING');
      const rows = universe.candidates.map((match) => [
        match.matchId, match.poly.conditionId, match.poly.gammaId, match.poly.question,
        match.poly.yesToken, match.poly.noToken, match.kalshi.ticker,
        match.kalshi.eventTicker, match.kalshi.title, match.score, match.titleSimilarity,
        match.identityStatus, match.identityApproved,
        match.identityCertification?.snapshotHash || null,
        match.identityCertification ? json(match.identityCertification) : null,
        match.relationType || 'UNREVIEWED', match.relationApproved === true,
        match.relationStatus || 'PENDING_REVIEW',
        match.relationProof ? json(match.relationProof) : null,
        match.relationResolutionAudit ? json(match.relationResolutionAudit) : null,
        match.stateEvidence ? json(match.stateEvidence) : null,
        match.approvalSource,
        match.resolutionAudit ? json(match.resolutionAudit) : null, json(match.mismatches),
        match.endDeltaHours, monitored.has(match.matchId), true,
        json({
          poly: {
            eventTitle: match.poly.eventTitle, description: match.poly.description,
            resolutionSource: match.poly.resolutionSource, resolvedBy: match.poly.resolvedBy,
            endDate: match.poly.endDate,
            category: match.poly.category, tickSize: match.poly.tickSize,
            orderMinSize: match.poly.orderMinSize,
            feeRate: match.poly.feeRate, feeExponent: match.poly.feeExponent,
            liquidity: match.poly.liquidity, volume24h: match.poly.volume24h,
          },
          kalshi: {
            eventTicker: match.kalshi.eventTicker, seriesTicker: match.kalshi.seriesTicker,
            subtitle: match.kalshi.subtitle, yesSubTitle: match.kalshi.yesSubTitle,
            noSubTitle: match.kalshi.noSubTitle, rulesPrimary: match.kalshi.rulesPrimary,
            rulesSecondary: match.kalshi.rulesSecondary, closeTime: match.kalshi.closeTime,
            expectedExpirationTime: match.kalshi.expectedExpirationTime,
            latestExpirationTime: match.kalshi.latestExpirationTime,
            canCloseEarly: match.kalshi.canCloseEarly, provisional: match.kalshi.provisional,
            liquidity: match.kalshi.liquidity, volume24h: match.kalshi.volume24h,
          },
          audit: {
            polyNumbers: match.polyNumbers, kalshiNumbers: match.kalshiNumbers,
            polyDomains: match.polyDomains, kalshiDomains: match.kalshiDomains,
            polyPredicate: match.polyPredicate, kalshiPredicate: match.kalshiPredicate,
          },
          structured: match.structuredEvidence || null,
        }), new Date(),
      ]);
      await insertRows('cv_contract_matches', MATCH_COLUMNS, rows, `ON CONFLICT (match_id) DO UPDATE SET
        poly_question=EXCLUDED.poly_question,kalshi_title=EXCLUDED.kalshi_title,
        match_score=EXCLUDED.match_score,title_similarity=EXCLUDED.title_similarity,
        identity_status=EXCLUDED.identity_status,identity_approved=EXCLUDED.identity_approved,
        identity_snapshot_hash=EXCLUDED.identity_snapshot_hash,
        identity_certification=EXCLUDED.identity_certification,
        relation_type=EXCLUDED.relation_type,relation_approved=EXCLUDED.relation_approved,
        relation_status=EXCLUDED.relation_status,relation_proof=EXCLUDED.relation_proof,
        relation_resolution_audit=EXCLUDED.relation_resolution_audit,
        state_evidence=EXCLUDED.state_evidence,
        approval_source=EXCLUDED.approval_source,resolution_audit=EXCLUDED.resolution_audit,
        mismatch_reasons=EXCLUDED.mismatch_reasons,end_delta_hours=EXCLUDED.end_delta_hours,
        monitored=EXCLUDED.monitored,active=true,metadata=EXCLUDED.metadata,refreshed_at=EXCLUDED.refreshed_at`);
      this.installMonitoredMatches(universe.monitored);
      this.metrics.polyMarkets = universe.polyCount;
      this.metrics.kalshiMarkets = universe.kalshiCount;
      this.metrics.kalshiCryptoMarkets = universe.kalshiCryptoCount;
      this.metrics.structuredCandidates = universe.structuredCount;
      this.metrics.candidates = universe.candidates.length;
      this.metrics.pendingCandidates = universe.pendingCount;
      this.metrics.reviewedRejected = universe.reviewedRejectedCount;
      this.metrics.diagnosticControls = universe.diagnosticControls;
      this.metrics.approvedMatches = universe.candidates.filter((match) => match.relationApproved).length;
      this.metrics.monitoredMatches = universe.monitored.length;
      await logEvent('INFO', 'crossvenue_lab', 'cross-venue universe refreshed', {
        polymarket: universe.polyCount, kalshi: universe.kalshiCount,
        candidates: universe.candidates.length, pending: universe.pendingCount,
        reviewedRejected: universe.reviewedRejectedCount, monitored: universe.monitored.length,
        diagnosticControls: universe.diagnosticControls, approved: this.metrics.approvedMatches,
      });
    } finally { this.refreshing = false; }
  }

  onPolyEvent(event) {
    if (this.stopping || !event?.assetId || !event?.book) return;
    this.metrics.polyEvents += 1; this.metrics.lastMarketAt = Date.now();
    for (const matchId of this.tokenMatches.get(String(event.assetId)) || []) {
      const match = this.matches.get(matchId);
      if (!match || !this.recordPolyState(match, event)) continue;
      this.queueEvaluation(matchId, 'POLYMARKET');
    }
  }

  async fetchKalshiBooks(tickers) {
    const requestStartedAt = Date.now(); const receiveMonoNs = process.hrtime.bigint();
    const url = new URL(`${KALSHI}/markets/orderbooks`);
    for (const ticker of tickers) url.searchParams.append('tickers', ticker);
    const result = await fetchJson(url);
    const receivedAt = Date.now();
    const provenance = this.kalshiWal.append(result.raw, {
      channel: 'orderbooks_batch_rest', sourceMs: receivedAt,
      receiveWallMs: receivedAt, receiveMonoNs: receiveMonoNs.toString(),
    });
    return new Map((result.payload?.orderbooks || []).map((payload) => [String(payload.ticker), {
      books: normalizeKalshiBook(payload), receivedAt,
      requestStartedAt, latencyMs: result.latencyMs,
      walEventId: provenance.event_id,
      sourceMs: null,
      transport: 'public_batch_rest',
    }]));
  }

  onKalshiWsBook(state) {
    if (this.stopping || !state?.ticker || !state?.books) return;
    this.kalshiBooks.set(state.ticker, state);
    this.recordKalshiState(state.ticker, state);
    this.metrics.kalshiWsEvents += 1;
    this.metrics.lastMarketAt = state.receivedAt || Date.now();
    for (const match of this.matches.values()) {
      if (match.kalshi.ticker === state.ticker) this.queueEvaluation(match.matchId, 'KALSHI_WS');
    }
  }

  async pollKalshi(tier = 'hot') {
    if (this.polling || this.stopping || !this.matches.size) return;
    if (this.kalshiFeed.healthy(STALE_MS)) return;
    if (this.kalshiFeed.configured()) this.metrics.kalshiWsFallbacks += 1;
    this.polling = true;
    try {
      const ranked = [...this.matches.values()];
      const selected = tier === 'broad' ? ranked.slice(HOT_MONITORED) : ranked.slice(0, HOT_MONITORED);
      const tickers = [...new Set(selected.map((match) => match.kalshi.ticker))];
      if (!tickers.length) return;
      const states = await this.fetchKalshiBooks(tickers);
      this.metrics.kalshiBatchRequests += 1;
      for (const ticker of tickers) {
        const state = states.get(ticker);
        if (!state) { this.metrics.kalshiErrors += 1; continue; }
        this.metrics.kalshiPolls += 1; this.metrics.lastMarketAt = Date.now();
        this.kalshiBooks.set(ticker, state);
        this.recordKalshiState(ticker, state);
        for (const match of this.matches.values()) {
          if (match.kalshi.ticker === ticker) this.queueEvaluation(match.matchId, 'KALSHI');
        }
      }
    } finally { this.polling = false; }
  }

  episodeFor(match, row, now) {
    if (!row.economic) return null;
    const relationEpisode = this.relationEpisodeFor(match, row.direction);
    if (relationEpisode) return relationEpisode;
    const matchId = match.matchId;
    const key = `${matchId}:${row.direction}`;
    const prior = this.episodes.get(key);
    if (prior && now - prior.lastAt <= 30_000) { prior.lastAt = now; return prior.id; }
    const next = { id: `episode:${matchId}:${row.direction}:${now}`, lastAt: now };
    this.episodes.set(key, next); return next.id;
  }

  evaluateMatch(matchId, triggerVenue) {
    const now = Date.now();
    if (now - (this.lastEvaluationAt.get(matchId) || 0) < EVALUATION_THROTTLE_MS) return;
    const match = this.matches.get(matchId);
    if (!match) return;
    const synchronized = selectSynchronizedBooks({
      polyHistory: this.polyBookHistory.get(matchId),
      kalshiHistory: this.kalshiBookHistory.get(match.kalshi.ticker),
      cutoffAt: now, maxSkewMs: MAX_PAIR_SKEW_MS,
      maxAgeMs: Math.max(STALE_MS, POLY_FEED_STALE_MS),
    });
    const polyState = synchronized.poly;
    const kalshiState = synchronized.kalshi;
    if (!polyState?.books || !kalshiState?.books) return;
    const polyBooks = polyState.books;
    const polyBookAt = polyState.receivedAt;
    const polyAgeMs = synchronized.polyAgeMs;
    const polyFeedAgeMs = Math.max(0, now - finite(this.clob.lastWsMsgAt, 0));
    const kalshiAgeMs = synchronized.kalshiAgeMs;
    const pairSkewMs = synchronized.pairSkewMs;
    // A quiet WebSocket book remains current when the connection heartbeat is
    // healthy. Book-change age is retained for diagnostics but must not turn a
    // genuinely unchanged market into a stale observation.
    const booksFresh = synchronized.synchronized
      && polyFeedAgeMs <= POLY_FEED_STALE_MS && kalshiAgeMs <= STALE_MS;
    const wsSourceStamped = kalshiState.transport === 'authenticated_readonly_ws'
      && kalshiState.sourceMs != null;
    // REST has no exchange-side source timestamp and can never earn grade A.
    const quality = !booksFresh ? 'F'
      : wsSourceStamped && kalshiState.latencyMs <= 250 ? 'A'
        : kalshiState.latencyMs == null || kalshiState.latencyMs <= 1000 ? 'B' : 'C';
    // A fresh synchronized book can grade A as data, but non-atomic paper
    // execution remains at most B fidelity.
    const fidelity = !booksFresh ? 'F' : quality === 'C' ? 'C' : 'B';
    const parts = [EXPERIMENT_ID, synchronized.synchronized, synchronized.reason,
      top(polyBooks.YES), top(polyBooks.NO), top(kalshiState.books.YES), top(kalshiState.books.NO)];
    const bookSignature = signature(parts);
    const same = this.lastSignature.get(matchId) === bookSignature;
    const controlDue = now - (this.lastControlAt.get(matchId) || 0) >= CONTROL_CAPTURE_MS;
    if (same && !controlDue) return;
    this.lastEvaluationAt.set(matchId, now); this.lastSignature.set(matchId, bookSignature);
    if (controlDue) this.lastControlAt.set(matchId, now);

    const pYes = top(polyBooks.YES); const pNo = top(polyBooks.NO);
    const kYes = top(kalshiState.books.YES); const kNo = top(kalshiState.books.NO);
    this.makerLab.observe(matchId, match, {
      poly: { YES: pYes, NO: pNo }, kalshi: { YES: kYes, NO: kNo },
    }, { synchronized: synchronized.synchronized, booksFresh, now });
    this.buffers.snapshots.push([
      iso(now), matchId, triggerVenue, iso(polyBookAt), iso(kalshiState.receivedAt),
      polyAgeMs, kalshiAgeMs, pairSkewMs,
      pYes.bid, pYes.bidSize, pYes.ask, pYes.askSize,
      pNo.bid, pNo.bidSize, pNo.ask, pNo.askSize,
      kYes.bid, kYes.bidSize, kYes.ask, kYes.askSize,
      kNo.bid, kNo.bidSize, kNo.ask, kNo.askSize,
      quality, fidelity, bookSignature,
      EXPERIMENT_ID, synchronized.synchronized, iso(synchronized.cutoffAt),
      json({ kalshiTransport: kalshiState.transport || 'public_batch_rest',
        kalshiLatencyMs: kalshiState.latencyMs, kalshiSourceMs: kalshiState.sourceMs,
        kalshiReceiveMs: kalshiState.receivedAt, kalshiSequence: kalshiState.sequence,
        kalshiWalEventId: kalshiState.walEventId, polyFeedAgeMs,
        experimentId: EXPERIMENT_ID,
        synchronization: {
          valid: synchronized.synchronized, reason: synchronized.reason,
          maxPairSkewMs: MAX_PAIR_SKEW_MS, holdbackMs: SYNC_HOLDBACK_MS,
          pairSkewMs, causalCutAt: new Date(synchronized.cutoffAt).toISOString(),
          polyReceivedAt: new Date(polyState.receivedAt).toISOString(),
          kalshiReceivedAt: new Date(kalshiState.receivedAt).toISOString(),
          polyOldestLegAt: polyState.oldestLegAt
            ? new Date(polyState.oldestLegAt).toISOString() : null,
          polySourceMs: polyState.sourceMs || null,
          kalshiSourceMs: kalshiState.sourceMs || null,
          sourceSkewMs: polyState.sourceMs != null && kalshiState.sourceMs != null
            ? Math.abs(polyState.sourceMs - kalshiState.sourceMs) : null,
        },
        identitySnapshotHash: match.identitySnapshotHash
          || match.identityCertification?.snapshotHash || null }),
    ]);
    this.metrics.snapshots += 1;
    if (synchronized.synchronized) this.metrics.synchronizedSnapshots += 1;
    else this.metrics.synchronizationRejects += 1;

    const basisRows = evaluateBasisPair({
      quantity: Math.max(BASIS_QUANTITY, finite(match.poly.orderMinSize, 5)),
      polyBooks, kalshiBooks: kalshiState.books,
      polyFeeRate: match.poly.feeRate, polyFeeExponent: match.poly.feeExponent,
      kalshiFeeMultiplier: 1, identityApproved: match.identityApproved,
      payoffRelation: match.relationProof, booksFresh,
    });
    for (const basis of basisRows) {
      const sampleId = `cvbasis:${now}:${crypto.randomUUID()}`;
      const durable = {
        sampleId, observedAt: iso(now).toISOString(), matchId, ...basis,
        dataQualityGrade: quality, executionFidelityGrade: fidelity,
        triggerVenue, bookSignature, experimentId: EXPERIMENT_ID,
        synchronized: synchronized.synchronized,
      };
      this.decisionWal.append(json(durable), { channel: 'basis-sample', sourceMs: now });
      this.buffers.basis.push([
        sampleId, iso(now), matchId, basis.direction, basis.quantity,
        basis.polyOutcome, basis.kalshiOutcome, basis.polyEntryVwap, basis.kalshiEntryVwap,
        basis.polyExitVwap, basis.kalshiExitVwap, basis.polyEntryFee, basis.kalshiEntryFee,
        basis.polyExitFee, basis.kalshiExitFee, basis.entryTotalCost,
        basis.grossLiquidationProceeds, basis.netLiquidationProceeds,
        basis.terminalLockedProfit, basis.immediateRoundTripPnl,
        basis.indicativeEntryEconomic, basis.entryEconomic, match.identityApproved,
        basis.relationType, basis.relationApproved, basis.guaranteedMinPayoutPerShare,
        basis.payoffProofHash, booksFresh, basis.fullEntryDepth, basis.fullExitDepth,
        quality, fidelity, bookSignature, EXPERIMENT_ID, synchronized.synchronized,
        json({ triggerVenue, kalshiTransport: kalshiState.transport || 'public_batch_rest',
          kalshiSourceMs: kalshiState.sourceMs, entryFills: basis.entryFills, exitFills: basis.exitFills,
          synchronizationReason: synchronized.reason, pairSkewMs,
          identitySnapshotHash: match.identityCertification?.snapshotHash || null,
          payoutAssumption: basis.relationApproved
            ? 'DETERMINISTIC_PAYOFF_PROOF' : 'UNPROVEN_PARITY_CONTROL',
          interpretation: 'Entry at two asks; early liquidation at two bids; all four taker fees charged.' }),
      ]);
      this.metrics.basisSamples += 1;
    }

    const results = optimizePair({
      quantities: QUANTITIES, polyBooks, kalshiBooks: kalshiState.books,
      minQuantity: Math.max(1, finite(match.poly.orderMinSize, 5)),
      maxQuantity: MAX_OPTIMIZED_QUANTITY,
      totalCapitalUsd: TOTAL_CAPITAL_USD,
      polyCapitalUsd: CAPITAL_PER_VENUE_USD,
      kalshiCapitalUsd: CAPITAL_PER_VENUE_USD,
      polyFeeRate: match.poly.feeRate, polyFeeExponent: match.poly.feeExponent,
      kalshiFeeMultiplier: 1, polyTick: match.poly.tickSize, kalshiTick: 0.01,
      identityApproved: match.identityApproved, payoffRelation: match.relationProof, booksFresh,
    });
    const observedRelationDirections = new Set();
    for (const row of results) {
      const opportunityId = `cvop:${now}:${crypto.randomUUID()}`;
      const episodeId = this.episodeFor(match, row, now);
      const durable = {
        opportunityId, observedAt: iso(now).toISOString(), matchId, episodeId,
        ...row, dataQualityGrade: quality, executionFidelityGrade: fidelity,
        atomic: false, triggerVenue, bookSignature, experimentId: EXPERIMENT_ID,
        synchronized: synchronized.synchronized,
      };
      this.decisionWal.append(json(durable), { channel: 'paper-opportunity', sourceMs: now });
      this.buffers.opportunities.push([
        opportunityId, iso(now), matchId, episodeId, row.direction, row.quantity,
        row.polyOutcome, row.kalshiOutcome, row.polyVwap, row.kalshiVwap,
        row.polyFee, row.kalshiFee, row.totalCost, row.lockedProfitAfterBothFills,
        row.stressedProfit, row.indicativeEconomic, row.economic, match.identityApproved,
        row.relationType, row.relationApproved, row.guaranteedMinPayoutPerShare,
        row.payoffProofHash, booksFresh, true,
        false, row.lockableAfterBothFills, row.status, quality, fidelity,
        EXPERIMENT_ID, synchronized.synchronized,
        json({ triggerVenue, bookSignature,
          kalshiTransport: kalshiState.transport || 'public_batch_rest',
          kalshiSourceMs: kalshiState.sourceMs, fills: row.fills,
          model: 'DETERMINISTIC_PAYOFF_RELATION_V1',
          payoutAssumption: row.payoutAssumption,
          relationId: match.relationProof?.id || null,
          relationStatus: match.relationStatus || 'PENDING_REVIEW',
          relationAudit: match.relationResolutionAudit || null,
          stateEvidence: match.stateEvidence || null,
          experimentId: EXPERIMENT_ID,
          synchronizationReason: synchronized.reason, pairSkewMs,
          identityCertification: match.identityCertification || null,
          diagnosticControl: ['REJECTED', 'MANUALLY_REJECTED'].includes(match.identityStatus),
          sizing: {
            method: row.sizingMethod, objective: row.optimizationObjective,
            totalCapitalUsd: TOTAL_CAPITAL_USD, capitalPerVenueUsd: CAPITAL_PER_VENUE_USD,
            capitalRequiredUsd: row.totalCost, polyCashRequiredUsd: row.polyCashRequired,
            kalshiCashRequiredUsd: row.kalshiCashRequired,
            rawRoiPct: row.rawRoiPct, stressedRoiPct: row.stressedRoiPct,
            availableDepthShares: row.availableDepthShares,
            affordableCapacityShares: row.affordableCapacityShares,
            capacityLimitedBy: row.capacityLimitedBy,
          },
          legRisk: {
            maxUnhedgedLossUsd: row.maxUnhedgedLossUsd,
            polyOnlyImmediateUnwindPnl: row.polyOnlyImmediateUnwindPnl,
            kalshiOnlyImmediateUnwindPnl: row.kalshiOnlyImmediateUnwindPnl,
            worstImmediateUnwindPnl: row.worstImmediateOrphanUnwindPnl,
            immediateUnwindAvailable: row.immediateOrphanUnwindAvailable,
            edgeHeadroomPerShare: row.terminalEdgeHeadroomPerShare,
          },
          warning: 'A deterministic minimum payout applies only after the frozen relation and every state gate are approved; both venue legs remain non-atomic.' }),
      ]);
      this.metrics.evaluations += 1;
      if (row.economic) this.metrics.economicLeads += 1;
      if (row.lockableAfterBothFills) this.metrics.lockableNonatomic += 1;
      if (booksFresh && match.relationApproved && row.relationApproved) {
        observedRelationDirections.add(row.direction);
        this.observeRelationEpisode(match, row.direction, now, {
          economic: row.economic,
          opportunityId,
          quantity: row.quantity,
          totalCost: row.totalCost,
          rawProfit: row.lockedProfitAfterBothFills,
          stressedProfit: row.stressedProfit,
          worstOrphanUnwindPnl: row.worstImmediateOrphanUnwindPnl,
          orphanUnwindAvailable: row.immediateOrphanUnwindAvailable,
          payoffProofHash: row.payoffProofHash,
          dataQualityGrade: quality,
          executionFidelityGrade: fidelity,
          bookSignature,
          triggerVenue,
          status: row.status,
          reason: row.economic ? 'EXECUTABLE_STRESSED_EDGE' : 'RELATION_ACTIVE_NO_STRESSED_EDGE',
        });
      }
    }
    // A proved relation remains an independent forward event even when the
    // minimum executable quantity cannot walk both books. Persist that absence
    // so only retaining the best/fillable quote cannot bias opportunity rate.
    for (const bundle of match.relationProof?.validBundles || []) {
      if (!booksFresh || !match.relationApproved || observedRelationDirections.has(bundle.direction)) continue;
      this.observeRelationEpisode(match, bundle.direction, now, {
        economic: false,
        payoffProofHash: bundle.payoffProof?.proofHash || null,
        dataQualityGrade: quality,
        executionFidelityGrade: fidelity,
        bookSignature,
        triggerVenue,
        status: 'NO_FULL_DEPTH',
        reason: 'APPROVED_RELATION_BUT_NO_EXECUTABLE_BUNDLE_AT_MINIMUM_SIZE',
      });
    }
    this.metrics.lastEvaluationAt = now;
  }

  async flush() {
    if (this.flushing) return;
    this.flushing = true;
    const snapshots = this.buffers.snapshots.splice(0, 2000);
    const opportunities = this.buffers.opportunities.splice(0, 2000);
    const basis = this.buffers.basis.splice(0, 2000);
    const makerEpisodes = this.buffers.makerEpisodes.splice(0, 2000);
    const relationEpisodes = [...this.buffers.relationEpisodes.values()];
    this.buffers.relationEpisodes.clear();
    try {
      if (snapshots.length) await insertRows('cv_book_snapshots', SNAPSHOT_COLUMNS, snapshots);
      if (opportunities.length) await insertRows('cv_opportunities', OPPORTUNITY_COLUMNS, opportunities,
        'ON CONFLICT (opportunity_id) DO NOTHING');
      if (basis.length) await insertRows('cv_basis_samples', BASIS_COLUMNS, basis,
        'ON CONFLICT (sample_id) DO NOTHING');
      if (makerEpisodes.length) await insertRows('cv_maker_episodes', MAKER_EPISODE_COLUMNS,
        makerEpisodes, 'ON CONFLICT (episode_id) DO NOTHING');
      if (relationEpisodes.length) await insertRows(
        'cv_relation_episodes', RELATION_EPISODE_COLUMNS,
        relationEpisodes.map(episodeRow),
        `ON CONFLICT (episode_id) DO UPDATE SET
          last_observed_at=EXCLUDED.last_observed_at,
          first_economic_at=EXCLUDED.first_economic_at,
          last_economic_at=EXCLUDED.last_economic_at,
          disappeared_at=EXCLUDED.disappeared_at,
          closed_at=EXCLUDED.closed_at,
          lifecycle_status=EXCLUDED.lifecycle_status,
          observations=EXCLUDED.observations,
          economic_observations=EXCLUDED.economic_observations,
          disappearances=EXCLUDED.disappearances,
          reappearances=EXCLUDED.reappearances,
          max_quantity=EXCLUDED.max_quantity,
          max_total_cost=EXCLUDED.max_total_cost,
          max_raw_profit=EXCLUDED.max_raw_profit,
          max_stressed_profit=EXCLUDED.max_stressed_profit,
          worst_orphan_unwind_pnl=EXCLUDED.worst_orphan_unwind_pnl,
          orphan_stress_loss_observations=EXCLUDED.orphan_stress_loss_observations,
          orphan_unwind_unavailable_observations=EXCLUDED.orphan_unwind_unavailable_observations,
          first_opportunity_id=EXCLUDED.first_opportunity_id,
          last_opportunity_id=EXCLUDED.last_opportunity_id,
          last_data_quality_grade=EXCLUDED.last_data_quality_grade,
          last_execution_fidelity_grade=EXCLUDED.last_execution_fidelity_grade,
          detail=EXCLUDED.detail`,
      );
    } catch (error) {
      this.buffers.snapshots.unshift(...snapshots);
      this.buffers.opportunities.unshift(...opportunities);
      this.buffers.basis.unshift(...basis);
      this.buffers.makerEpisodes.unshift(...makerEpisodes);
      for (const episode of relationEpisodes) {
        if (!this.buffers.relationEpisodes.has(episode.episodeId)) {
          this.buffers.relationEpisodes.set(episode.episodeId, episode);
        }
      }
      throw error;
    } finally { this.flushing = false; }
  }

  async heartbeat(status = 'RUNNING') {
    const queued = this.buffers.snapshots.length + this.buffers.opportunities.length
      + this.buffers.basis.length + this.buffers.relationEpisodes.size;
    const relationLifecycle = [...this.relationEpisodes.values()].reduce((counts, episode) => {
      counts[episode.lifecycleStatus] = (counts[episode.lifecycleStatus] || 0) + 1; return counts;
    }, {});
    const metrics = {
      ...this.metrics, runId: RUN_ID, paperOnly: true, walletLoaded: false,
      liveOrderPath: false, kalshiTransport: this.kalshiFeed.transport(),
      experimentId: EXPERIMENT_ID,
      kalshiFeed: this.kalshiFeed.health(), kalshiRestFallbackPollMs: KALSHI_POLL_MS,
      broadPollMs: BROAD_POLL_MS,
      hotMonitored: Math.min(HOT_MONITORED, this.metrics.monitoredMatches),
      polyFeedStaleMs: POLY_FEED_STALE_MS,
      synchronization: {
        maxPairSkewMs: MAX_PAIR_SKEW_MS,
        holdbackMs: SYNC_HOLDBACK_MS,
        historyMs: BOOK_HISTORY_MS,
        pendingEvaluations: this.pendingEvaluations.size,
      },
      quantities: QUANTITIES, basisQuantity: BASIS_QUANTITY,
      totalCapitalUsd: TOTAL_CAPITAL_USD, capitalPerVenueUsd: CAPITAL_PER_VENUE_USD,
      sizingMethod: 'EQUAL_PAYOUT_DEPTH_BANKROLL_OPTIMIZED',
      relationEvents: this.relationEpisodes.size,
      relationLifecycle,
      diagnosticControlLimit: DIAGNOSTIC_CONTROLS,
      jurisdictionBlock: 'DUBLIN_HOST_DO_NOT_TRADE_KALSHI',
      wal: {
        kalshi: this.kalshiWal.health(), polymarket: this.polyWal.health(),
        decisions: this.decisionWal.health(),
      },
    };
    await Promise.all([
      pool.query(`UPDATE cv_runtime SET status=$2,poly_markets=$3,kalshi_markets=$4,
        candidates=$5,approved_matches=$6,monitored_matches=$7,snapshots=$8,evaluations=$9,
        economic_leads=$10,lockable_nonatomic=$11,persistence_queue=$12,last_market_at=$13,
        last_evaluation_at=$14,updated_at=now(),metrics=$15::jsonb WHERE run_id=$1`,
      [RUN_ID, status, this.metrics.polyMarkets, this.metrics.kalshiMarkets,
        this.metrics.candidates, this.metrics.approvedMatches, this.metrics.monitoredMatches,
        this.metrics.snapshots, this.metrics.evaluations, this.metrics.economicLeads,
        this.metrics.lockableNonatomic, queued,
        this.metrics.lastMarketAt ? iso(this.metrics.lastMarketAt) : null,
        this.metrics.lastEvaluationAt ? iso(this.metrics.lastEvaluationAt) : null, json(metrics)]),
      pool.query(`INSERT INTO system_heartbeats (component,beat_at,meta)
        VALUES ('crossvenue_lab',now(),$1::jsonb)
        ON CONFLICT (component) DO UPDATE SET beat_at=now(),meta=EXCLUDED.meta`, [json(metrics)]),
    ]);
  }

  async stop(signal) {
    if (this.stopping) return;
    this.stopping = true; this.timers.forEach(clearInterval);
    for (const pending of this.pendingEvaluations.values()) clearTimeout(pending.timer);
    this.pendingEvaluations.clear();
    this.makerLab.drain(Date.now());
    await this.flush().catch(() => {}); await this.heartbeat('STOPPED').catch(() => {});
    await pool.query('UPDATE cv_runtime SET stopped_at=now(),status=$2 WHERE run_id=$1', [RUN_ID, 'STOPPED']).catch(() => {});
    this.clob.close();
    this.kalshiFeed.close();
    await Promise.all([this.kalshiWal.close(), this.polyWal.close(), this.decisionWal.close()]).catch(() => {});
    await pool.end().catch(() => {});
    console.log(`[crossvenue_lab] stopped by ${signal}`);
  }
}

async function main() {
  const lab = new CrossVenueLab();
  process.once('SIGTERM', () => lab.stop('SIGTERM').finally(() => process.exit(0)));
  process.once('SIGINT', () => lab.stop('SIGINT').finally(() => process.exit(0)));
  await lab.start();
}

if (require.main === module) main().catch(async (error) => {
  console.error(error.stack || error.message); await pool.end().catch(() => {}); process.exit(1);
});

module.exports = {
  BASIS_QUANTITY, BROAD_POLL_MS, CAPITAL_PER_VENUE_USD, CrossVenueLab,
  DIAGNOSTIC_CONTROLS, HOT_MONITORED, KALSHI_POLL_MS, MAX_MONITORED,
  POLY_FEED_STALE_MS, QUANTITIES, RUN_ID, TOTAL_CAPITAL_USD,
  BOOK_HISTORY_MS, EXPERIMENT_ID, MAX_PAIR_SKEW_MS, SYNC_HOLDBACK_MS,
};
