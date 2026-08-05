#!/usr/bin/env node
'use strict';

/**
 * Polymarket XTracker public-information laboratory.
 *
 * PAPER ONLY. The process consumes Polymarket's public resolver-aligned social
 * tracker, captures linked public CLOB books and emits only simulated terminal
 * holds when a post count irreversibly crosses a certified range boundary.
 * It imports no wallet, signer, authenticated CLOB client or order function.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const ClobMultiplex = require('../recon/clob-multiplex');
const RawWal = require('../recon/wal');
const {
  pool, migratePublicInfo, insertRows, logEvent,
} = require('../recon/db');
const { syncExperimentRegistry } = require('../research/experiment-registry');
const { dataQuality, microstructure } = require('../allmarket/strategy');
const { normalizeMarket } = require('../allmarket/universe');
const { paperBarrierFill } = require('./strategy');
const {
  GAMMA_BASE,
  XTRACKER_BASE,
  barrierTransition,
  certifyTrackingEvent,
  eventSlugFromMarketLink,
  fetchRawJson,
  normalizePost,
  parseCountRange,
  trackingWindow,
} = require('./xtracker');

const EXPERIMENT_ID = 'xtracker-resolver-count-barrier-v1';
const STRATEGY = 'N01_xtracker_count_barrier_v1';
const CODE_RELEASE_ID = process.env.DELTAFORGE_PUBLIC_INFO_RELEASE_ID
  || path.basename(fs.realpathSync(process.cwd()));
const RUN_ID = `public-info:${os.hostname()}:${new Date().toISOString()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
const COLLECTION_EPOCH_ID = process.env.BORG_COLLECTION_EPOCH_ID || 'public-info-unmarked';
const ALLOWED_PLATFORMS = new Set(String(process.env.PUBLIC_INFO_PLATFORMS || 'TRUTH_SOCIAL')
  .split(',').map((value) => value.trim().toUpperCase()).filter(Boolean));
const POLL_MS = Math.max(5_000, Number(process.env.PUBLIC_INFO_POLL_MS || 15_000));
const METADATA_REFRESH_MS = Math.max(POLL_MS, Number(process.env.PUBLIC_INFO_METADATA_REFRESH_MS || 60_000));
const TOUCH_MIN_INTERVAL_MS = Math.max(50, Number(process.env.PUBLIC_INFO_TOUCH_MIN_INTERVAL_MS || 250));
const MAX_ACTIVE_TRACKINGS = Math.max(1, Number(process.env.PUBLIC_INFO_MAX_ACTIVE_TRACKINGS || 8));
const MAX_MARKETS = Math.max(2, Number(process.env.PUBLIC_INFO_MAX_MARKETS || 80));
const TARGET_USD = Math.max(1, Number(process.env.PUBLIC_INFO_TARGET_USD || 10));
const SOURCE_RISK_RESERVE = Math.max(0, Number(process.env.PUBLIC_INFO_SOURCE_RISK_RESERVE || 0.01));
const LATENCY_PROFILES_MS = String(process.env.PUBLIC_INFO_LATENCY_PROFILES_MS || '100,250,500')
  .split(',').map(Number).filter((value) => Number.isInteger(value) && value >= 0 && value <= 5000);
const USER_AGENT = process.env.PUBLIC_INFO_USER_AGENT || 'DeltaForge-Public-Research/1.0';
const CLOB_BASE = 'https://clob.polymarket.com';

const TOUCH_COLUMNS = [
  'observed_at', 'source_ts', 'tracking_id', 'condition_id', 'asset_id', 'outcome',
  'best_bid', 'bid_size', 'best_ask', 'ask_size', 'state_age_ms', 'reaction_us',
  'data_quality_grade', 'event_type', 'connection_epoch', 'connection_shard',
  'event_sequence', 'wal_event_id', 'book_hash',
];

function json(value) { return JSON.stringify(value ?? {}); }
function iso(ms) { return new Date(ms); }
function reactionUs(receiveMonoNs) {
  try { return Number(process.hrtime.bigint() - BigInt(receiveMonoNs)) / 1000; } catch (_) { return null; }
}

function boundedPush(rows, row, metrics, limit = 100_000) {
  rows.push(row);
  if (rows.length > limit) {
    rows.splice(0, Math.ceil(limit / 10));
    metrics.persistenceDrops += 1;
  }
}

function sameBounds(left, right) {
  return left?.lower === right?.lower && left?.upper === right?.upper;
}

function normalizeBookSnapshot(payload, receivedAt = Date.now()) {
  const levels = (rows, descending) => (Array.isArray(rows) ? rows : [])
    .map((row) => [parseFloat(row?.price ?? row?.[0]), parseFloat(row?.size ?? row?.[1])])
    .filter(([price, size]) => Number.isFinite(price) && price > 0 && price < 1
      && Number.isFinite(size) && size > 0)
    .sort((left, right) => descending ? right[0] - left[0] : left[0] - right[0]);
  return {
    bids: levels(payload?.bids, true),
    asks: levels(payload?.asks, false),
    at: receivedAt,
    sourceAt: Number.isFinite(Date.parse(payload?.timestamp)) ? Date.parse(payload.timestamp) : null,
    src: 'rest_execution_confirmation',
    hash: payload?.hash || null,
  };
}

class PublicInfoCollector {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || global.fetch;
    this.startedAt = Date.now();
    this.sources = new Map();
    this.trackings = new Map();
    this.marketsByTracking = new Map();
    this.tokenMeta = new Map();
    this.postsBySource = new Map();
    this.trackingCounts = new Map();
    this.sourceImportCursor = new Map();
    this.sourceLastSync = new Map();
    this.initializedSources = new Set();
    this.lastSequence = new Map();
    this.lastTouchAt = new Map();
    this.pendingDecisions = new Set();
    this.buffers = { touches: [] };
    this.timers = [];
    this.decisionTimers = new Set();
    this.flushing = false;
    this.refreshing = false;
    this.stopping = false;
    this.metrics = {
      sourcePolls: 0,
      sourcePollErrors: 0,
      publicEvents: 0,
      duplicateEvents: 0,
      bookEvents: 0,
      lastSourceEventAt: null,
      lastBookEventAt: null,
      transitions: 0,
      paperIntents: 0,
      qualifiedIntents: 0,
      staleBookDecisions: 0,
      uncertifiedMarkets: 0,
      discardedSequence: 0,
      persistenceDrops: 0,
      collectionEpochId: COLLECTION_EPOCH_ID,
    };

    const walOptions = {
      root: process.env.BORG_WAL_DIR,
      mirrorRoot: process.env.BORG_WAL_MIRROR_DIR || null,
      minFreeGb: Number(process.env.BORG_WAL_MIN_FREE_GB || 10),
      collectionEpochId: COLLECTION_EPOCH_ID,
      collectorRunId: RUN_ID,
    };
    this.rawWal = new RawWal('public-info-xtracker', walOptions);
    this.eventWal = new RawWal('public-info-events', walOptions);
    this.bookWal = new RawWal('public-info-clob', walOptions);
    this.decisionWal = new RawWal('public-info-decisions', walOptions);
    this.clob = new ClobMultiplex(
      (assetId) => this.tokenMeta.get(String(assetId))?.conditionId || null,
      {
        shardCount: Number(process.env.PUBLIC_INFO_CLOB_SHARDS || 2),
        wal: this.bookWal,
        persistDerivedEvents: false,
        emitTradeEvents: false,
        maxPrintAssets: MAX_MARKETS * 2 + 20,
        onMarketEvent: (event) => this.onMarketEvent(event),
      },
    );
  }

  async start() {
    await migratePublicInfo();
    await syncExperimentRegistry(pool);
    await pool.query(`
      INSERT INTO borg_public_runtime
        (run_id,experiment_id,started_at,host,pid,status,paper_only,wallet_loaded,metrics)
      VALUES ($1,$2,now(),$3,$4,'STARTING',true,false,$5::jsonb)
    `, [RUN_ID, EXPERIMENT_ID, os.hostname(), process.pid, json({
      codeReleaseId: CODE_RELEASE_ID,
      platforms: [...ALLOWED_PLATFORMS], latencyProfilesMs: LATENCY_PROFILES_MS,
    })]);
    await this.refreshSources();
    await this.clob.connect();
    this.timers = [
      setInterval(() => this.pollChangedSources().catch((error) => this.recordError('poll', error)), POLL_MS),
      setInterval(() => this.refreshSources().catch((error) => this.recordError('refresh', error)), METADATA_REFRESH_MS),
      setInterval(() => this.flush().catch((error) => this.recordError('flush', error)), 250),
      setInterval(() => this.clob.checkStale(), 10_000),
      setInterval(() => this.heartbeat().catch(() => {}), 10_000),
    ];
    await this.heartbeat('RUNNING');
    await logEvent('INFO', 'public_info', 'XTracker resolver-state paper collector started', {
      runId: RUN_ID,
      paperOnly: true,
      liveOrderPath: false,
      platforms: [...ALLOWED_PLATFORMS],
      sources: this.sources.size,
      activeTrackings: this.trackings.size,
      subscribedTokens: this.tokenMeta.size,
    });
  }

  recordError(scope, error) {
    this.metrics.sourcePollErrors += 1;
    return logEvent('ERROR', 'public_info', `${scope}: ${error.message}`, {
      runId: RUN_ID, paperOnly: true,
    });
  }

  async request(url, channel) {
    return fetchRawJson(url, {
      fetchImpl: this.fetchImpl,
      wal: this.rawWal,
      channel,
      userAgent: USER_AGENT,
    });
  }

  activeTrackingRows(user) {
    const now = Date.now();
    return (Array.isArray(user?.trackings) ? user.trackings : [])
      .filter((tracking) => tracking?.isActive === true && trackingWindow(tracking)
        && Date.parse(tracking.endDate) >= now - 5 * 60_000
        && eventSlugFromMarketLink(tracking.marketLink))
      .sort((left, right) => Date.parse(left.endDate) - Date.parse(right.endDate))
      .slice(0, MAX_ACTIVE_TRACKINGS);
  }

  async persistSources(users, trackings) {
    if (users.length) {
      await insertRows('borg_public_sources', [
        'source_id', 'provider', 'platform', 'handle', 'display_name', 'verified',
        'source_updated_at', 'last_observed_at', 'raw',
      ], users.map((user) => [
        String(user.id), 'polymarket_xtracker', String(user.platform), String(user.handle),
        user.name || null, user.verified === true, user.updatedAt || user.lastSync || null,
        new Date(), json(user),
      ]), `ON CONFLICT (source_id) DO UPDATE SET
        platform=EXCLUDED.platform,handle=EXCLUDED.handle,display_name=EXCLUDED.display_name,
        verified=EXCLUDED.verified,source_updated_at=EXCLUDED.source_updated_at,
        last_observed_at=EXCLUDED.last_observed_at,raw=EXCLUDED.raw`);
    }
    if (trackings.length) {
      await insertRows('borg_public_trackings', [
        'tracking_id', 'source_id', 'title', 'event_slug', 'market_link', 'starts_at',
        'ends_at', 'is_active', 'source_created_at', 'source_updated_at',
        'last_observed_at', 'raw',
      ], trackings.map(({ user, tracking }) => [
        String(tracking.id), String(user.id), tracking.title,
        eventSlugFromMarketLink(tracking.marketLink), tracking.marketLink,
        tracking.startDate, tracking.endDate, tracking.isActive === true,
        tracking.createdAt || null, tracking.updatedAt || null, new Date(), json(tracking),
      ]), `ON CONFLICT (tracking_id) DO UPDATE SET
        title=EXCLUDED.title,event_slug=EXCLUDED.event_slug,market_link=EXCLUDED.market_link,
        starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at,is_active=EXCLUDED.is_active,
        source_updated_at=EXCLUDED.source_updated_at,last_observed_at=EXCLUDED.last_observed_at,
        raw=EXCLUDED.raw`);
    }
  }

  async refreshSources() {
    if (this.refreshing || this.stopping) return;
    this.refreshing = true;
    try {
      const response = await this.request(`${XTRACKER_BASE}/users?includeInactive=false`, 'xtracker-users');
      const users = (Array.isArray(response.data) ? response.data : [])
        .filter((user) => ALLOWED_PLATFORMS.has(String(user?.platform || '').toUpperCase()));
      const rows = users.flatMap((user) => this.activeTrackingRows(user)
        .map((tracking) => ({ user, tracking })));
      await this.persistSources(users, rows);
      this.sources = new Map(users.map((user) => [String(user.id), user]));
      this.trackings = new Map(rows.map(({ user, tracking }) => [String(tracking.id), {
        ...tracking, sourceId: String(user.id), platform: String(user.platform), handle: String(user.handle),
      }]));
      await this.refreshMarkets();
      await this.pollChangedSources(true, users);
    } finally {
      this.refreshing = false;
    }
  }

  async refreshMarkets() {
    const marketRows = [];
    const nextMarketsByTracking = new Map();
    const nextTokenMeta = new Map();
    let selectedMarkets = 0;
    for (const tracking of this.trackings.values()) {
      if (selectedMarkets >= MAX_MARKETS) break;
      const slug = eventSlugFromMarketLink(tracking.marketLink);
      if (!slug) continue;
      const response = await this.request(`${GAMMA_BASE}/events/slug/${encodeURIComponent(slug)}`, 'gamma-event');
      const event = response.data;
      const certificate = certifyTrackingEvent(tracking, event);
      const entries = [];
      for (const rawMarket of Array.isArray(event?.markets) ? event.markets : []) {
        if (selectedMarkets >= MAX_MARKETS) break;
        const bounds = parseCountRange(rawMarket);
        const market = normalizeMarket(rawMarket);
        if (!bounds || !market) continue;
        selectedMarkets += 1;
        market.outcomes.forEach((outcome, tokenIndex) => {
          const meta = {
            trackingId: String(tracking.id),
            sourceId: String(tracking.sourceId),
            eventSlug: slug,
            conditionId: market.conditionId,
            gammaId: market.gammaId,
            question: market.question,
            groupLabel: bounds.label,
            bounds,
            outcome: String(outcome),
            assetId: String(market.tokenIds[tokenIndex]),
            tokenIndex,
            tickSize: market.tickSize,
            minimumOrderSize: market.orderMinSize,
            feesEnabled: market.feesEnabled,
            feeRate: market.feeRate,
            feeExponent: market.feeExponent,
            ruleCertified: certificate.certified,
            ruleHash: certificate.ruleHash,
            ruleReasons: certificate.reasons,
            active: rawMarket.active !== false && rawMarket.closed !== true,
            acceptingOrders: rawMarket.acceptingOrders !== false && rawMarket.accepting_orders !== false,
          };
          entries.push(meta);
          marketRows.push([
            meta.trackingId, meta.conditionId, meta.gammaId, meta.eventSlug, meta.question,
            meta.groupLabel, bounds.lower, bounds.upper, meta.outcome, meta.assetId,
            tokenIndex, meta.tickSize, meta.minimumOrderSize, meta.feesEnabled,
            meta.feeRate, meta.feeExponent, meta.ruleCertified, meta.ruleHash,
            meta.active, meta.acceptingOrders, new Date(), json({
              market: rawMarket, certificate: certificate.ruleDocument,
              certificationReasons: certificate.reasons,
            }),
          ]);
          if (meta.active && meta.acceptingOrders) nextTokenMeta.set(meta.assetId, meta);
        });
        if (!certificate.certified) this.metrics.uncertifiedMarkets += 1;
      }
      nextMarketsByTracking.set(String(tracking.id), entries);
    }
    if (marketRows.length) {
      await insertRows('borg_public_markets', [
        'tracking_id', 'condition_id', 'gamma_id', 'event_slug', 'question',
        'group_label', 'lower_bound', 'upper_bound', 'outcome', 'asset_id',
        'token_index', 'tick_size', 'minimum_order_size', 'fees_enabled',
        'fee_rate', 'fee_exponent', 'rule_certified', 'rule_hash', 'active',
        'accepting_orders', 'refreshed_at', 'raw',
      ], marketRows, `ON CONFLICT (tracking_id,asset_id) DO UPDATE SET
        question=EXCLUDED.question,group_label=EXCLUDED.group_label,
        lower_bound=EXCLUDED.lower_bound,upper_bound=EXCLUDED.upper_bound,
        tick_size=EXCLUDED.tick_size,minimum_order_size=EXCLUDED.minimum_order_size,
        fees_enabled=EXCLUDED.fees_enabled,fee_rate=EXCLUDED.fee_rate,
        fee_exponent=EXCLUDED.fee_exponent,rule_certified=EXCLUDED.rule_certified,
        rule_hash=EXCLUDED.rule_hash,active=EXCLUDED.active,
        accepting_orders=EXCLUDED.accepting_orders,refreshed_at=EXCLUDED.refreshed_at,
        raw=EXCLUDED.raw`);
    }
    this.marketsByTracking = nextMarketsByTracking;
    this.tokenMeta = nextTokenMeta;
    this.clob.subscribe([...this.tokenMeta.keys()]);
    this.recomputeTrackingCounts();
  }

  recomputeTrackingCounts() {
    for (const tracking of this.trackings.values()) {
      const window = trackingWindow(tracking);
      const posts = this.postsBySource.get(String(tracking.sourceId));
      const count = window && posts
        ? [...posts.values()].filter((post) => {
          const at = post.sourceTimestamp.getTime();
          return at >= window.startsAt && at <= window.endsAt;
        }).length : 0;
      this.trackingCounts.set(String(tracking.id), count);
    }
  }

  async pollChangedSources(force = false, freshUsers = null) {
    if (this.stopping) return;
    this.metrics.sourcePolls += 1;
    let users = freshUsers;
    if (!Array.isArray(users)) {
      const response = await this.request(`${XTRACKER_BASE}/users?includeInactive=false`, 'xtracker-users-poll');
      users = (Array.isArray(response.data) ? response.data : [])
        .filter((user) => ALLOWED_PLATFORMS.has(String(user?.platform || '').toUpperCase()));
      for (const user of users) this.sources.set(String(user.id), user);
    }
    for (const user of users) {
      const sourceId = String(user.id);
      const previousSync = this.sourceLastSync.get(sourceId);
      const nextSync = Date.parse(user.lastSync || user.updatedAt);
      if (!force && Number.isFinite(nextSync) && previousSync === nextSync) continue;
      const trackings = [...this.trackings.values()].filter((tracking) => tracking.sourceId === sourceId);
      if (!trackings.length) continue;
      await this.pollPosts(user, trackings);
      if (Number.isFinite(nextSync)) this.sourceLastSync.set(sourceId, nextSync);
    }
  }

  async pollPosts(user, trackings) {
    const sourceId = String(user.id);
    const earliest = Math.min(...trackings.map((tracking) => Date.parse(tracking.startDate)));
    const latest = Math.max(Date.now(), ...trackings.map((tracking) => Date.parse(tracking.endDate)));
    const url = new URL(`${XTRACKER_BASE}/users/${encodeURIComponent(user.handle)}/posts`);
    url.searchParams.set('platform', user.platform);
    url.searchParams.set('startDate', new Date(earliest).toISOString());
    url.searchParams.set('endDate', new Date(latest).toISOString());
    const response = await this.request(url.toString(), `xtracker-posts:${user.platform}:${user.handle}`);
    const rawPosts = Array.isArray(response.data) ? response.data : [];
    const known = this.postsBySource.get(sourceId) || new Map();
    this.postsBySource.set(sourceId, known);
    const cursor = this.sourceImportCursor.get(sourceId) ?? -Infinity;
    const bootstrap = !this.initializedSources.has(sourceId);
    const normalized = rawPosts.map((post) => normalizePost(post, user, response)).filter(Boolean)
      .sort((left, right) => left.sourceTimestamp - right.sourceTimestamp);
    const unseen = normalized.filter((post) => !known.has(post.sourceEventId));

    for (const post of unseen) {
      const normalizedEnvelope = this.eventWal.append(json({
        type: 'public_source_event', provider: post.provider,
        sourceEventId: post.sourceEventId, platformEventId: post.platformEventId,
        sourceId: post.sourceId, platform: post.platform, actorHandle: post.actorHandle,
        sourceTimestamp: post.sourceTimestamp.toISOString(),
        upstreamObservedAt: post.upstreamObservedAt?.toISOString() || null,
        contentHash: post.contentHash, contentHtml: post.contentHtml,
        contentText: post.contentText, metrics: post.metrics,
      }), {
        channel: 'normalized-post',
        sourceMs: post.sourceTimestamp.getTime(),
        receiveWallMs: post.receivedAt.getTime(),
        receiveMonoNs: post.receiveMonotonicNs,
      });
      post.normalizedWalEventId = normalizedEnvelope.event_id;
      known.set(post.sourceEventId, post);
      const importedMs = post.upstreamObservedAt?.getTime();
      const causal = !bootstrap && Number.isFinite(importedMs) && importedMs > cursor;
      this.applyPostToTrackings(post, trackings, causal);
      this.metrics.publicEvents += 1;
      this.metrics.lastSourceEventAt = post.receivedAt.getTime();
    }
    this.metrics.duplicateEvents += Math.max(0, normalized.length - unseen.length);
    if (unseen.length) await this.persistEvents(unseen);
    const maxImported = normalized.reduce((max, post) => Math.max(
      max, post.upstreamObservedAt?.getTime() || -Infinity,
    ), cursor);
    this.sourceImportCursor.set(sourceId, maxImported);
    this.initializedSources.add(sourceId);
    if (bootstrap) this.recomputeTrackingCounts();
  }

  async persistEvents(events) {
    await insertRows('borg_public_events', [
      'provider', 'source_event_id', 'platform_event_id', 'source_id', 'platform',
      'actor_handle', 'source_timestamp', 'upstream_observed_at', 'received_at',
      'receive_monotonic_ns', 'tracker_lag_ms', 'local_poll_lag_ms', 'content_hash',
      'content_html', 'content_text', 'metrics', 'raw', 'raw_wal_event_id',
      'normalized_wal_event_id',
    ], events.map((post) => [
      post.provider, post.sourceEventId, post.platformEventId, post.sourceId,
      post.platform, post.actorHandle, post.sourceTimestamp, post.upstreamObservedAt,
      post.receivedAt, post.receiveMonotonicNs, post.trackerLagMs, post.localPollLagMs,
      post.contentHash, post.contentHtml, post.contentText, json(post.metrics),
      json(post.raw), post.rawWalEventId, post.normalizedWalEventId,
    ]), 'ON CONFLICT (provider,source_event_id) DO NOTHING');
  }

  applyPostToTrackings(post, trackings, causal) {
    const sourceAt = post.sourceTimestamp.getTime();
    for (const tracking of trackings) {
      const window = trackingWindow(tracking);
      if (!window || sourceAt < window.startsAt || sourceAt > window.endsAt) continue;
      const trackingId = String(tracking.id);
      const priorCount = this.trackingCounts.get(trackingId) || 0;
      const currentCount = priorCount + 1;
      this.trackingCounts.set(trackingId, currentCount);
      if (!causal) continue;
      const markets = this.marketsByTracking.get(trackingId) || [];
      const conditions = new Map();
      for (const meta of markets) {
        if (!conditions.has(meta.conditionId)) conditions.set(meta.conditionId, meta);
      }
      for (const representative of conditions.values()) {
        const transition = barrierTransition(priorCount, currentCount, representative.bounds);
        if (!transition) continue;
        const target = markets.find((meta) => meta.conditionId === representative.conditionId
          && meta.outcome.toLowerCase() === transition.outcome.toLowerCase());
        if (!target || !target.ruleCertified || !target.active || !target.acceptingOrders) continue;
        this.metrics.transitions += 1;
        for (const latencyMs of LATENCY_PROFILES_MS) {
          this.scheduleDecision({
            target, tracking, transition, post, priorCount, currentCount, latencyMs,
          });
        }
      }
    }
  }

  scheduleDecision(context) {
    const key = [EXPERIMENT_ID, context.target.trackingId, context.target.conditionId,
      context.target.assetId, context.transition.kind, context.currentCount, context.latencyMs].join(':');
    if (this.pendingDecisions.has(key)) return;
    this.pendingDecisions.add(key);
    const timer = setTimeout(() => {
      this.decisionTimers.delete(timer);
      this.evaluateDecision(key, context).catch((error) => this.recordError('decision', error));
    }, context.latencyMs);
    this.decisionTimers.add(timer);
  }

  async evaluateDecision(dedupKey, context) {
    if (this.stopping) return;
    const { target, tracking, transition, post, priorCount, currentCount, latencyMs } = context;
    let book = null;
    let bookFetchError = null;
    const bookRequestStartedAt = Date.now();
    try {
      const response = await fetchRawJson(
        `${CLOB_BASE}/book?token_id=${encodeURIComponent(target.assetId)}`,
        {
          fetchImpl: this.fetchImpl,
          wal: this.bookWal,
          channel: 'execution-book',
          userAgent: USER_AGENT,
        },
      );
      book = normalizeBookSnapshot(response.data, response.receiveWallMs);
    } catch (error) {
      bookFetchError = error.message;
    }
    const stateAgeMs = book
      ? Math.max(0, book.at - (book.sourceAt || book.at)) : Infinity;
    const grade = dataQuality({ stateAgeMs, stateSource: 'rest' });
    const fill = grade === 'F'
      ? { qualified: false, filled: false, reason: 'STALE_OR_MISSING_BOOK' }
      : paperBarrierFill({
        book,
        minimumOrderSize: target.minimumOrderSize,
        targetUsd: TARGET_USD,
        tickSize: target.tickSize,
        feeRate: target.feesEnabled ? target.feeRate : 0,
        feeExponent: target.feeExponent,
        sourceRiskReserve: SOURCE_RISK_RESERVE,
      });
    if (grade === 'F') this.metrics.staleBookDecisions += 1;
    const decisionAt = new Date();
    const intentId = `public-info:${crypto.createHash('sha256').update(dedupKey).digest('hex').slice(0, 32)}`;
    const detail = {
      paperOnly: true,
      liveOrderPath: false,
      collectionEpochId: COLLECTION_EPOCH_ID,
      codeReleaseId: CODE_RELEASE_ID,
      ruleHash: target.ruleHash,
      ruleReasons: target.ruleReasons,
      groupLabel: target.groupLabel,
      targetUsd: TARGET_USD,
      trackerLagMs: post.trackerLagMs,
      localPollLagMs: post.localPollLagMs,
      stateAgeMs: Number.isFinite(stateAgeMs) ? stateAgeMs : null,
      bookHash: book?.hash || null,
      bookSource: book?.src || null,
      bookRequestMs: Date.now() - bookRequestStartedAt,
      bookFetchError,
      nominalEdgePerShare: fill.nominalEdgePerShare ?? null,
      stressedEdgePerShare: fill.stressedEdgePerShare ?? null,
    };
    const decisionEnvelope = this.decisionWal.append(json({
      type: 'resolver_barrier_paper_intent', intentId, dedupKey,
      experimentId: EXPERIMENT_ID, strategy: STRATEGY,
      trackingId: target.trackingId, conditionId: target.conditionId,
      assetId: target.assetId, guaranteedOutcome: transition.outcome,
      barrierKind: transition.kind, priorCount, currentCount,
      lowerBound: target.bounds.lower, upperBound: target.bounds.upper,
      latencyMs, fill, grade, detail,
    }), { channel: 'paper-intent', sourceMs: post.sourceTimestamp.getTime() });
    detail.decisionWalEventId = decisionEnvelope.event_id;
    await pool.query(`
      INSERT INTO borg_public_paper_intents (
        intent_id,dedup_key,run_id,experiment_id,strategy,tracking_id,condition_id,
        asset_id,guaranteed_outcome,barrier_kind,prior_count,current_count,
        lower_bound,upper_bound,trigger_source_event_id,trigger_source_at,
        trigger_upstream_at,decision_at,latency_ms,requested_shares,filled,
        average_fill_price,displayed_shares,fee_2x_per_share,tick_stress_per_share,
        source_risk_reserve_per_share,nominal_terminal_pnl_usd,
        stressed_terminal_pnl_usd,qualified,reason,data_quality_grade,
        execution_fidelity_grade,paper_only,detail
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
        $20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,true,$33::jsonb
      ) ON CONFLICT (dedup_key) DO NOTHING
    `, [
      intentId, dedupKey, RUN_ID, EXPERIMENT_ID, STRATEGY, target.trackingId,
      target.conditionId, target.assetId, transition.outcome, transition.kind,
      priorCount, currentCount, target.bounds.lower, target.bounds.upper,
      post.sourceEventId, post.sourceTimestamp, post.upstreamObservedAt, decisionAt,
      latencyMs, fill.requestedShares ?? null, fill.filled === true,
      fill.averageFillPrice ?? null, fill.displayedShares ?? null,
      fill.fee2xPerShare ?? null, fill.tickStressPerShare ?? target.tickSize,
      fill.sourceRiskReservePerShare ?? SOURCE_RISK_RESERVE,
      fill.nominalTerminalPnlUsd ?? null, fill.stressedTerminalPnlUsd ?? null,
      fill.qualified === true, fill.reason, grade, 'B', json(detail),
    ]);
    this.metrics.paperIntents += 1;
    if (fill.qualified) this.metrics.qualifiedIntents += 1;
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
    if (this.stopping || !this.sequenceAccepted(event) || event.eventType === 'last_trade_price') return;
    const meta = this.tokenMeta.get(String(event.assetId));
    if (!meta || !event.book) return;
    const view = microstructure(event.book);
    if (!view) return;
    const observedAt = event.receiveWallMs || Date.now();
    const sourceAge = event.sourceMs == null ? observedAt - event.book.at : observedAt - event.sourceMs;
    const grade = dataQuality({ stateAgeMs: sourceAge, stateSource: 'event' });
    const prior = this.lastTouchAt.get(meta.assetId) || 0;
    this.metrics.bookEvents += 1;
    this.metrics.lastBookEventAt = observedAt;
    if (observedAt - prior < TOUCH_MIN_INTERVAL_MS) return;
    this.lastTouchAt.set(meta.assetId, observedAt);
    boundedPush(this.buffers.touches, [
      iso(observedAt), event.sourceMs ? iso(event.sourceMs) : null,
      meta.trackingId, meta.conditionId, meta.assetId, meta.outcome,
      view.bid, view.bidSize, view.ask, view.askSize, sourceAge,
      reactionUs(event.receiveMonoNs), grade, event.eventType,
      event.connectionEpoch || 0, event.connectionShard || 0,
      event.eventSequence || null, event.walEventId || null, event.book.hash || null,
    ], this.metrics);
  }

  async flush() {
    if (this.flushing || !this.buffers.touches.length) return;
    this.flushing = true;
    const rows = this.buffers.touches.splice(0, 5_000);
    try {
      await insertRows('borg_public_market_touches', TOUCH_COLUMNS, rows);
    } catch (error) {
      this.buffers.touches.unshift(...rows);
      throw error;
    } finally {
      this.flushing = false;
    }
  }

  async heartbeat(status = 'RUNNING') {
    const marketCount = new Set([...this.tokenMeta.values()].map((meta) => meta.conditionId)).size;
    const meta = {
      runId: RUN_ID,
      experimentId: EXPERIMENT_ID,
      strategy: STRATEGY,
      status,
      pid: process.pid,
      host: os.hostname(),
      paperOnly: true,
      walletLoaded: false,
      liveOrderPath: false,
      collectionEpochId: COLLECTION_EPOCH_ID,
      codeReleaseId: CODE_RELEASE_ID,
      providers: {
        polymarketXtracker: 'ENABLED_PUBLIC_RESOLVER_API',
        truthSocialDirect: 'BLOCKED_TERMS_NO_AUTOMATION',
        xOfficial: process.env.X_BEARER_TOKEN ? 'CREDENTIAL_PRESENT_NOT_USED_BY_THIS_LANE' : 'BLOCKED_CREDENTIALS',
      },
      platforms: [...ALLOWED_PLATFORMS],
      sourceCount: this.sources.size,
      activeTrackings: this.trackings.size,
      subscribedMarkets: marketCount,
      subscribedTokens: this.tokenMeta.size,
      trackingCounts: Object.fromEntries(this.trackingCounts),
      latencyProfilesMs: LATENCY_PROFILES_MS,
      targetUsd: TARGET_USD,
      sourceRiskReservePerShare: SOURCE_RISK_RESERVE,
      persistenceQueue: this.buffers.touches.length,
      clob: this.clob.health(),
      wal: {
        raw: this.rawWal.health(),
        events: this.eventWal.health(),
        books: this.bookWal.health(),
        decisions: this.decisionWal.health(),
      },
      ...this.metrics,
    };
    await Promise.all([
      pool.query(`
        UPDATE borg_public_runtime SET status=$2,sources=$3,active_trackings=$4,
          subscribed_markets=$5,subscribed_tokens=$6,public_events=$7,book_events=$8,
          paper_intents=$9,qualified_intents=$10,persistence_queue=$11,
          last_source_event_at=$12,last_book_event_at=$13,updated_at=now(),metrics=$14::jsonb
        WHERE run_id=$1
      `, [RUN_ID, status, this.sources.size, this.trackings.size, marketCount,
        this.tokenMeta.size, this.metrics.publicEvents, this.metrics.bookEvents,
        this.metrics.paperIntents, this.metrics.qualifiedIntents,
        this.buffers.touches.length,
        this.metrics.lastSourceEventAt ? iso(this.metrics.lastSourceEventAt) : null,
        this.metrics.lastBookEventAt ? iso(this.metrics.lastBookEventAt) : null,
        json(meta)]),
      pool.query(`
        INSERT INTO system_heartbeats (component,beat_at,meta)
        VALUES ('public_info_collector',now(),$1::jsonb)
        ON CONFLICT (component) DO UPDATE SET beat_at=now(),meta=EXCLUDED.meta
      `, [json(meta)]),
    ]);
  }

  async stop(signal) {
    if (this.stopping) return;
    this.stopping = true;
    this.timers.forEach(clearInterval);
    this.decisionTimers.forEach(clearTimeout);
    await this.flush().catch(() => {});
    await pool.query(`UPDATE borg_public_runtime SET status='STOPPED',stopped_at=now(),updated_at=now()
      WHERE run_id=$1`, [RUN_ID]).catch(() => {});
    await pool.query(`DELETE FROM system_heartbeats WHERE component='public_info_collector'`).catch(() => {});
    this.clob.close();
    await Promise.all([
      this.rawWal.close(), this.eventWal.close(), this.bookWal.close(), this.decisionWal.close(),
    ]).catch(() => {});
    await pool.end().catch(() => {});
    console.log(`[public_info] stopped by ${signal}`);
  }
}

async function main() {
  const collector = new PublicInfoCollector();
  process.once('SIGTERM', () => collector.stop('SIGTERM').finally(() => process.exit(0)));
  process.once('SIGINT', () => collector.stop('SIGINT').finally(() => process.exit(0)));
  await collector.start();
}

if (require.main === module) main().catch(async (error) => {
  console.error(error.stack || error.message);
  await pool.end().catch(() => {});
  process.exit(1);
});

module.exports = {
  CODE_RELEASE_ID,
  EXPERIMENT_ID,
  PublicInfoCollector,
  RUN_ID,
  STRATEGY,
  normalizeBookSnapshot,
  sameBounds,
};
