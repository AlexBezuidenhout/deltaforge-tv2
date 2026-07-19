/**
 * Public Polymarket flow laboratory (paper-only).
 *
 * Two deliberately distinct sources are retained:
 *  - the global Data API scan discovers completed trades across all markets;
 *    its second-resolution timestamps make it unsuitable for sub-second fills;
 *  - market-channel sockets capture event-time books and completed trade prints
 *    for a bounded, high-liquidity panel used by the causal scalp experiment.
 *
 * There is intentionally no wallet, signer, CLOB order client, private channel,
 * or create/post order method in this process.
 */
'use strict';

const crypto = require('crypto');
const os = require('os');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const WebSocket = require('ws');
const { pool, migrateFlow, insertRows, logEvent } = require('../recon/db');
const RawWal = require('../recon/wal');
const {
  CHALLENGER_STRATEGY_VERSION,
  FEE_MODEL_VERSION,
  MARKOUT_HORIZONS_MS,
  STRATEGY_VERSION,
  evaluateCostConfirmedEntry,
  evaluatePublicSweep,
  roundTripPnl,
} = require('./strategy');
const {
  BOUNDARY_EXPERIMENT_ID,
  BOUNDARY_ORDER_TRANSIT_MS,
  BOUNDARY_SOURCE_ARM,
  BOUNDARY_SOURCE_LATENCY_MS,
  boundarySourceState,
  hasConnectionGap,
  latestCausalTouch,
  paperArrivalState,
} = require('./boundary-canary');

const DATA_API = 'https://data-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';
const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const REALTIME_MARKETS = Math.max(2, Math.min(12, Number(process.env.FLOW_REALTIME_MARKETS || 4)));
const SOCKET_SHARDS = Math.max(1, Math.min(4, Number(process.env.FLOW_CLOB_SHARDS || 2)));
// Data API trades have second-resolution source timestamps. Polling this
// discovery-only plane faster than two seconds adds no causal information and
// previously allowed slow 10,000-row requests to overlap until Cloudflare
// returned 408/429. The latency-sensitive experiment remains CLOB WebSocket
// driven.
const GLOBAL_POLL_MS = Math.max(1000, Number(process.env.FLOW_GLOBAL_POLL_MS || 2000));
const DATA_TRADE_PAGE_SIZE = Math.max(100, Math.min(1000,
  Number(process.env.FLOW_DATA_TRADE_PAGE_SIZE || 500)));
const DATA_TRADE_MAX_PAGES = Math.max(1, Math.min(10,
  Number(process.env.FLOW_DATA_TRADE_MAX_PAGES || 4)));
const ORDER_TRANSIT_PROFILES_MS = Object.freeze([50, 100, 250, 500]);
const UNIVERSE_REFRESH_MS = Math.max(30000, Number(process.env.FLOW_UNIVERSE_REFRESH_MS || 60000));
// V1 is retained in the database as the blind post-sweep control. It is
// structurally negative at every arm/latency and is disabled by default so the
// forward V2 cohort does not spend storage re-proving the same spread cost.
const FLOW_V1_CONTROL_ENABLED = process.env.FLOW_V1_CONTROL_ENABLED === 'true';
const RUN_ID = `flow:${os.hostname()}:${new Date().toISOString()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function epochMs(value) {
  if (value == null) return null;
  const n = Number(value);
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseArray(value) {
  if (Array.isArray(value)) return value.map(String);
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch (_) {
    return [];
  }
}

function normLevels(levels) {
  if (!Array.isArray(levels)) return [];
  return levels
    .map((level) => Array.isArray(level)
      ? [finite(level[0]), finite(level[1])]
      : [finite(level.price), finite(level.size)])
    .filter(([price, size]) => price != null && size != null && size > 0);
}

function hash(parts) {
  return crypto.createHash('sha256').update(parts.map((value) => value ?? '').join('|')).digest('hex');
}

function dataTradesUrl(limit, offset = 0) {
  const url = new URL(`${DATA_API}/trades`);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('takerOnly', 'true');
  return url.toString();
}

async function collectRecentTradePages(fetchPage, {
  sinceSec,
  pageSize = DATA_TRADE_PAGE_SIZE,
  maxPages = DATA_TRADE_MAX_PAGES,
} = {}) {
  const cutoff = Number.isFinite(Number(sinceSec)) ? Number(sinceSec) : 0;
  const collected = [];
  let pages = 0;
  let oldestSec = null;
  let saturated = false;
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const page = await fetchPage(pageIndex * pageSize, pageSize);
    if (!Array.isArray(page)) throw new Error('Data API trades response is not an array');
    pages += 1;
    const timestamps = page.map((trade) => Math.floor((epochMs(trade?.timestamp) || 0) / 1000))
      .filter((timestamp) => timestamp > 0);
    if (timestamps.length) {
      const pageOldest = Math.min(...timestamps);
      oldestSec = oldestSec == null ? pageOldest : Math.min(oldestSec, pageOldest);
    }
    collected.push(...page);
    if (page.length < pageSize || (oldestSec != null && oldestSec <= cutoff)) break;
    if (pageIndex === maxPages - 1) saturated = true;
  }
  return {
    trades: collected.filter((trade) => {
      const timestamp = Math.floor((epochMs(trade?.timestamp) || 0) / 1000);
      return timestamp >= cutoff;
    }),
    pages,
    oldestSec,
    saturated,
  };
}

function makeNonOverlappingTask(fn, onSkip = () => {}) {
  let pending = false;
  return async function run() {
    if (pending) {
      onSkip();
      return false;
    }
    pending = true;
    try {
      await fn();
      return true;
    } finally {
      pending = false;
    }
  };
}

function latestSourceWindow(trades, lookbackSec) {
  const stamped = (Array.isArray(trades) ? trades : []).map((trade) => ({
    trade,
    timestampSec: Math.floor((epochMs(trade?.timestamp) || 0) / 1000),
  })).filter((row) => row.timestampSec > 0);
  if (!stamped.length) return { trades: [], latestSourceSec: null };
  const latestSourceSec = Math.max(...stamped.map((row) => row.timestampSec));
  return {
    trades: stamped.filter((row) => row.timestampSec >= latestSourceSec - lookbackSec)
      .map((row) => row.trade),
    latestSourceSec,
  };
}

function sourceCursorCutoff(cursorSec) {
  const cursor = finite(cursorSec);
  return cursor != null && cursor > 0 ? Math.max(0, Math.floor(cursor) - 2) : 0;
}

async function fetchText(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, timeoutMs = 10000) {
  return JSON.parse(await fetchText(url, timeoutMs));
}

async function concurrentMap(items, width, fn) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  return output;
}

class FlowSocket {
  constructor(shard, wal, onFrame, onConnection) {
    this.shard = shard;
    this.wal = wal;
    this.onFrame = onFrame;
    this.onConnection = onConnection;
    this.desired = new Set();
    this.active = new Set();
    this.ws = null;
    this.closed = false;
    this.connectionEpoch = 0;
    this.eventSequence = 0;
    this.reconnectMs = 2000;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.lastMessageAt = 0;
  }

  setAssets(assetIds) {
    const next = new Set(assetIds.filter(Boolean).map(String));
    const add = [...next].filter((id) => !this.active.has(id));
    const remove = [...this.active].filter((id) => !next.has(id));
    this.desired = next;
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (!this.active.size && next.size) {
      this._sendInitial();
      return;
    }
    if (add.length) this._sendChange('subscribe', add);
    if (remove.length) this._sendChange('unsubscribe', remove);
  }

  connect() {
    if (this.closed) return;
    const ws = new WebSocket(WS_URL);
    this.ws = ws;
    ws.on('open', () => {
      if (ws !== this.ws) return;
      this.connectionEpoch += 1;
      this.eventSequence = 0;
      this.reconnectMs = 2000;
      this.lastMessageAt = Date.now();
      this.active.clear();
      if (this.desired.size) this._sendInitial();
      this.onConnection(this, 'open', { assets: this.desired.size });
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('PING');
      }, 8000);
    });
    ws.on('message', (buffer) => this._message(ws, buffer));
    ws.on('error', (error) => this.onConnection(this, 'error', { message: error.message }));
    ws.on('close', (code, reason) => {
      if (ws !== this.ws) return;
      clearInterval(this.pingTimer);
      this.active.clear();
      this.onConnection(this, 'close', { code, reason: reason?.toString() || null });
      if (!this.closed) this._scheduleReconnect();
    });
  }

  _sendInitial() {
    const ids = [...this.desired];
    if (!ids.length) return;
    this.ws.send(JSON.stringify({ type: 'market', assets_ids: ids, custom_feature_enabled: true }));
    this.active = new Set(ids);
  }

  _sendChange(operation, ids) {
    this.ws.send(JSON.stringify({ operation, assets_ids: ids, custom_feature_enabled: true }));
    for (const id of ids) {
      if (operation === 'subscribe') this.active.add(id);
      else this.active.delete(id);
    }
  }

  _message(ws, buffer) {
    // A final frame can already be queued when shutdown closes the WAL. Drop
    // it once the socket has entered the terminal state instead of appending
    // to a sealed segment and crashing during a supervised restart.
    if (this.closed || ws !== this.ws) return;
    const receiveWallMs = Date.now();
    const receiveMonoNs = process.hrtime.bigint().toString();
    this.eventSequence += 1;
    const provenance = this.wal.append(buffer, {
      channel: 'market', receiveWallMs, receiveMonoNs,
      connectionEpoch: this.connectionEpoch, connectionShard: this.shard,
    });
    this.lastMessageAt = receiveWallMs;
    if (buffer.toString() === 'PONG') return;
    let parsed;
    try { parsed = JSON.parse(buffer); } catch (_) { return; }
    for (const event of Array.isArray(parsed) ? parsed : [parsed]) {
      this.onFrame(event, { ...provenance, shard: this.shard });
    }
  }

  _scheduleReconnect() {
    if (this.reconnectTimer || this.closed) return;
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, 30000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  checkStale() {
    if (this.lastMessageAt && Date.now() - this.lastMessageAt > 45000) {
      this.onConnection(this, 'stale', { age_ms: Date.now() - this.lastMessageAt });
      this.lastMessageAt = Date.now();
      this.ws?.terminate();
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    this.ws?.close();
  }
}

class FlowCollector {
  constructor() {
    const walOptions = {
      root: process.env.BORG_WAL_DIR,
      mirrorRoot: process.env.BORG_WAL_MIRROR_DIR || null,
      minFreeGb: Number(process.env.BORG_WAL_MIN_FREE_GB || 10),
      collectionEpochId: process.env.BORG_COLLECTION_EPOCH_ID || 'flow-unmarked',
      collectorRunId: RUN_ID,
    };
    this.wal = {
      clob: new RawWal('polymarket-flow-clob', walOptions),
      global: new RawWal('polymarket-global-trades', walOptions),
      boundary: new RawWal('polymarket-flow-boundary-intents', walOptions),
    };
    this.sockets = Array.from({ length: SOCKET_SHARDS }, (_, shard) => new FlowSocket(
      shard, this.wal.clob,
      (event, provenance) => this.onClobEvent(event, provenance),
      (socket, event, detail) => this.onConnection(socket, event, detail),
    ));
    this.markets = new Map();
    this.tokenMarkets = new Map();
    this.books = new Map();
    this.touchHistory = new Map();
    this.connectionEvents = [];
    this.touchBuffer = [];
    this.lastTouchKey = new Map();
    this.lastPeriodicTouch = new Map();
    // The global Data API can trail wall time by minutes. Bootstrap from its
    // bounded latest sample, then advance an API-source cursor; never initialize
    // this cursor from the local clock.
    this.globalCursorSec = 0;
    this.globalSeen = new Map();
    this.lastGlobalResponseAt = 0;
    this.lastGlobalSaturationLogAt = 0;
    this.running = false;
    this.timers = [];
    this.boundaryTimers = new Set();
    this.boundaryConditions = new Set();
    this.writeChain = Promise.resolve();
    this.counters = {
      globalTrades: 0, realtimeTrades: 0, eligibleSweeps: 0, signals: 0,
      scored: 0, filled: 0, errors: 0, scheduledSkips: 0, globalCoverageGaps: 0,
      boundarySourceArmed: 0, boundaryReady: 0, boundaryRejected: 0,
      startedAt: new Date().toISOString(),
    };
  }

  async start() {
    await migrateFlow();
    await this.refreshUniverse();
    for (const socket of this.sockets) socket.connect();
    this.running = true;
    // Complete the initial REST pass before arming its timer. Previously the
    // first interval could overlap this call while a large response was still
    // in flight.
    await this.scanGlobalTrades();
    this._every(() => this.scanGlobalTrades(), GLOBAL_POLL_MS);
    this._every(() => this.flushTouches(), 500);
    this._every(() => this.persistBookHeartbeats(), 1000);
    this._every(() => this.scorePending(), 2000);
    this._every(() => this.refreshUniverse(), UNIVERSE_REFRESH_MS);
    this._every(() => this.health(), 10000);
    this._every(() => this.heartbeat(), 60000);
    await logEvent('INFO', 'flow', 'public-flow paper collector started', {
      paper_only: true, live_order_path: 'absent', strategy_version: CHALLENGER_STRATEGY_VERSION,
      retired_control_version: STRATEGY_VERSION, v1_control_enabled: FLOW_V1_CONTROL_ENABLED,
      realtime_markets: REALTIME_MARKETS, shards: SOCKET_SHARDS,
      global_poll_ms: GLOBAL_POLL_MS, data_trade_page_size: DATA_TRADE_PAGE_SIZE,
      data_trade_max_pages: DATA_TRADE_MAX_PAGES,
      boundary_intent_stream: BOUNDARY_EXPERIMENT_ID,
    });
    await this.heartbeat();
  }

  _every(fn, interval) {
    const run = makeNonOverlappingTask(
      () => fn.call(this),
      () => { this.counters.scheduledSkips += 1; },
    );
    const timer = setInterval(() => run().catch((error) => this.error(error)), interval);
    this.timers.push(timer);
  }

  async fetchRecentTrades(sinceSec) {
    return collectRecentTradePages(
      (offset, limit) => fetchJson(dataTradesUrl(limit, offset), 10000),
      { sinceSec, pageSize: DATA_TRADE_PAGE_SIZE, maxPages: DATA_TRADE_MAX_PAGES },
    );
  }

  async refreshUniverse() {
    // The Gamma `order=volume_24hr` response can be grouped rather than globally
    // ranked and selected inactive-looking long-dated markets in a live probe.
    // Drive the socket panel from actual recent public flow, then ask the CLOB
    // market endpoint for the authoritative active flag, complementary tokens,
    // and current taker fee coefficient.
    const end = Math.floor(Date.now() / 1000) + 1;
    const recent = await this.fetchRecentTrades(0);
    const sourceWindow = latestSourceWindow(recent.trades, 90);
    const recentTrades = sourceWindow.trades;
    const activity = new Map();
    for (const trade of Array.isArray(recentTrades) ? recentTrades : []) {
      if (!trade.conditionId) continue;
      let aggregate = activity.get(trade.conditionId);
      if (!aggregate) {
        aggregate = {
          conditionId: trade.conditionId, recentTradeCount: 0, recentNotional: 0,
          latest: 0, title: trade.title || null, slug: trade.slug || null,
          eventSlug: trade.eventSlug || null,
        };
        activity.set(trade.conditionId, aggregate);
      }
      aggregate.recentTradeCount += 1;
      aggregate.recentNotional += (finite(trade.price) || 0) * (finite(trade.size) || 0);
      aggregate.latest = Math.max(aggregate.latest, epochMs(trade.timestamp) || 0);
    }
    const ranked = [...activity.values()]
      .sort((a, b) => b.recentTradeCount - a.recentTradeCount
        || b.recentNotional - a.recentNotional || b.latest - a.latest)
      .slice(0, Math.max(REALTIME_MARKETS * 5, 40));
    const resolved = await concurrentMap(ranked, 6, async (candidate) => {
      try {
        const raw = await fetchJson(`${CLOB_API}/markets/${candidate.conditionId}`, 10000);
        const tokens = Array.isArray(raw.tokens) ? raw.tokens : [];
        const tokenIds = tokens.map((token) => String(token.token_id || '')).filter(Boolean);
        const outcomes = tokens.map((token) => String(token.outcome || ''));
        if (!raw.active || raw.closed || !raw.accepting_orders || !raw.enable_order_book
          || tokenIds.length !== 2 || outcomes.length !== 2) return null;
        const feeBps = finite(raw.taker_base_fee);
        return {
          ...candidate, raw, gammaId: null,
          slug: raw.market_slug || candidate.slug,
          question: raw.question || candidate.title,
          tokenIds, outcomes, liquidity: null, volume24h: null,
          feesEnabled: feeBps != null && feeBps > 0,
          feeRate: Math.max(0, (feeBps || 0) / 10000),
          minimumOrderSize: Math.max(0, finite(raw.minimum_order_size)
            ?? finite(raw.min_order_size) ?? 0),
        };
      } catch (error) {
        await logEvent('WARN', 'flow', `CLOB market lookup failed for ${candidate.conditionId}: ${error.message}`);
        return null;
      }
    });
    const usable = resolved.filter(Boolean).slice(0, REALTIME_MARKETS);
    if (!usable.length) throw new Error('recent-flow universe produced no active binary order-book markets');

    // Resolver boundaries come from the dedicated crypto-market collector,
    // not from a title parser or the display API. A market without this join
    // remains observable Flow data but cannot create a boundary canary intent.
    const { rows: boundaryRows } = await pool.query(`
      SELECT DISTINCT ON (condition_id) condition_id,id,window_end
        FROM borg_markets
       WHERE condition_id=ANY($1::text[])
       ORDER BY condition_id,window_end DESC`, [usable.map((market) => market.conditionId)]);
    const boundaries = new Map(boundaryRows.map((row) => [String(row.condition_id), row]));
    for (const market of usable) {
      const boundary = boundaries.get(String(market.conditionId));
      market.borgMarketId = boundary?.id == null ? null : Number(boundary.id);
      market.boundaryAt = boundary?.window_end ? new Date(boundary.window_end).getTime() : null;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE pm_flow_markets SET selected_realtime=false');
      for (const market of usable) {
        await client.query(`
          INSERT INTO pm_flow_markets (
            condition_id,gamma_id,slug,question,event_slug,outcomes,token_ids,liquidity,volume_24h,
            fees_enabled,fee_rate,recent_trade_count,recent_notional,
            active,selected_realtime,raw,refreshed_at)
          VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13,true,true,$14::jsonb,now())
          ON CONFLICT (condition_id) DO UPDATE SET
            gamma_id=EXCLUDED.gamma_id,slug=EXCLUDED.slug,question=EXCLUDED.question,
            event_slug=EXCLUDED.event_slug,outcomes=EXCLUDED.outcomes,token_ids=EXCLUDED.token_ids,
            liquidity=EXCLUDED.liquidity,volume_24h=EXCLUDED.volume_24h,
            fees_enabled=EXCLUDED.fees_enabled,fee_rate=EXCLUDED.fee_rate,
            recent_trade_count=EXCLUDED.recent_trade_count,recent_notional=EXCLUDED.recent_notional,
            active=true,selected_realtime=true,raw=EXCLUDED.raw,refreshed_at=now()`,
          [market.conditionId, market.gammaId, market.slug, market.question, market.eventSlug,
            JSON.stringify(market.outcomes), JSON.stringify(market.tokenIds), market.liquidity,
            market.volume24h, market.feesEnabled, market.feeRate,
            market.recentTradeCount, market.recentNotional, JSON.stringify(market.raw)],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    this.markets = new Map(usable.map((market) => [market.conditionId, market]));
    this.tokenMarkets.clear();
    usable.forEach((market, index) => {
      market.tokenIds.forEach((tokenId) => this.tokenMarkets.set(tokenId, market));
      market.shard = index % SOCKET_SHARDS;
    });
    for (let shard = 0; shard < this.sockets.length; shard += 1) {
      const ids = usable.filter((market) => market.shard === shard).flatMap((market) => market.tokenIds);
      this.sockets[shard].setAssets(ids);
    }
    await logEvent('INFO', 'flow', `realtime panel refreshed (${usable.length} markets, ${usable.length * 2} tokens)`, {
      selection: 'top active binary order-book markets in the bounded latest-trade sample, client-filtered to 90 seconds',
      global_scan_scope: 'bounded paginated Data API sample; CLOB socket panel is the causal experiment tape',
      data_api_pages: recent.pages, data_api_sample_saturated: recent.saturated,
      data_api_latest_source_sec: sourceWindow.latestSourceSec,
      data_api_source_lag_ms: sourceWindow.latestSourceSec == null
        ? null : Math.max(0, Date.now() - sourceWindow.latestSourceSec * 1000),
    });
  }

  onConnection(socket, event, detail) {
    const level = event === 'open' ? 'INFO' : 'WARN';
    const observedAt = Date.now();
    this.connectionEvents.push({ at: observedAt, shard: socket.shard, epoch: socket.connectionEpoch, event });
    const cutoff = observedAt - 30_000;
    while (this.connectionEvents.length && this.connectionEvents[0].at < cutoff) {
      this.connectionEvents.shift();
    }
    pool.query(`INSERT INTO pm_flow_connection_events
      (observed_at,connection_shard,connection_epoch,event,detail)
      VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [new Date(observedAt), socket.shard, socket.connectionEpoch, event,
      JSON.stringify(detail || {})]).catch((error) => this.error(error));
    logEvent(level, 'flow', `CLOB shard ${socket.shard} ${event}`, detail);
  }

  onClobEvent(event, provenance) {
    if (!event || typeof event !== 'object') return;
    const type = event.event_type || event.type || 'unknown';
    const assetId = String(event.asset_id || '');
    if (!assetId || !this.tokenMarkets.has(assetId)) return;
    if (type === 'book') {
      const bids = normLevels(event.bids || event.buys).sort((a, b) => b[0] - a[0]);
      const asks = normLevels(event.asks || event.sells).sort((a, b) => a[0] - b[0]);
      this.books.set(assetId, {
        bids, asks, at: provenance.receive_wall_timestamp_ms, sourceAt: epochMs(event.timestamp),
        hash: event.hash || null, shard: provenance.shard,
        connectionEpoch: provenance.connection_epoch,
      });
      this.recordTouch(assetId, type, provenance, event);
      return;
    }
    if (type === 'price_change') {
      const changes = Array.isArray(event.price_changes)
        ? event.price_changes : Array.isArray(event.changes) ? event.changes : [event];
      const touched = new Set();
      for (const change of changes) {
        const changedAsset = String(change.asset_id || assetId);
        this.applyDelta(changedAsset, change, provenance, event);
        touched.add(changedAsset);
      }
      for (const changedAsset of touched) this.recordTouch(changedAsset, type, provenance, event);
      return;
    }
    if (type === 'last_trade_price') this.onRealtimeTrade(event, provenance);
  }

  applyDelta(assetId, change, provenance, parent) {
    const book = this.books.get(assetId);
    if (!book) return;
    const price = finite(change.price);
    const size = finite(change.size);
    const side = /buy|bid/i.test(change.side || '') ? 'bids'
      : /sell|ask/i.test(change.side || '') ? 'asks' : null;
    if (price == null || size == null || !side) return;
    const levels = book[side].filter(([levelPrice]) => levelPrice !== price);
    if (size > 0) levels.push([price, size]);
    levels.sort((a, b) => side === 'bids' ? b[0] - a[0] : a[0] - b[0]);
    book[side] = levels;
    book.at = provenance.receive_wall_timestamp_ms;
    book.sourceAt = epochMs(parent.timestamp ?? change.timestamp) || book.sourceAt;
    book.hash = parent.hash ?? change.hash ?? book.hash;
  }

  recordTouch(assetId, eventType, provenance, event = {}) {
    const book = this.books.get(assetId);
    const market = this.tokenMarkets.get(assetId);
    if (!book || !market) return;
    const touch = {
      observedAt: provenance.receive_wall_timestamp_ms || Date.now(),
      sourceAt: epochMs(event.timestamp) || book.sourceAt,
      conditionId: market.conditionId, assetId,
      bestBid: book.bids?.[0]?.[0] ?? null, bidSize: book.bids?.[0]?.[1] ?? null,
      bestAsk: book.asks?.[0]?.[0] ?? null, askSize: book.asks?.[0]?.[1] ?? null,
      connectionEpoch: provenance.connection_epoch ?? book.connectionEpoch,
      connectionShard: provenance.shard ?? book.shard,
      eventSequence: provenance.event_sequence || null,
      walEventId: provenance.event_id || null, bookHash: event.hash || book.hash || null,
      eventType,
    };
    const key = [touch.bestBid, touch.bidSize, touch.bestAsk, touch.askSize].join('|');
    if (eventType !== 'state_heartbeat' && this.lastTouchKey.get(assetId) === key) return;
    this.lastTouchKey.set(assetId, key);
    this.touchBuffer.push(touch);
    let history = this.touchHistory.get(assetId);
    if (!history) { history = []; this.touchHistory.set(assetId, history); }
    history.push(touch);
    const cutoff = Date.now() - 15000;
    while (history.length && history[0].observedAt < cutoff) history.shift();
  }

  persistBookHeartbeats() {
    const now = Date.now();
    for (const [assetId, book] of this.books) {
      if (now - book.at > 5000 || now - (this.lastPeriodicTouch.get(assetId) || 0) < 1000) continue;
      this.lastPeriodicTouch.set(assetId, now);
      this.recordTouch(assetId, 'state_heartbeat', {
        receive_wall_timestamp_ms: now, connection_epoch: book.connectionEpoch,
        shard: book.shard, event_sequence: null, event_id: null,
      }, { timestamp: book.sourceAt, hash: book.hash });
    }
  }

  async flushTouches() {
    if (!this.touchBuffer.length) return;
    const rows = this.touchBuffer.splice(0, this.touchBuffer.length);
    try {
      await insertRows('pm_flow_touches', [
        'observed_at','source_ts','condition_id','asset_id','best_bid','bid_size','best_ask','ask_size',
        'connection_epoch','connection_shard','event_sequence','wal_event_id','book_hash','event_type',
      ], rows.map((touch) => [
        new Date(touch.observedAt), touch.sourceAt ? new Date(touch.sourceAt) : null,
        touch.conditionId, touch.assetId, touch.bestBid, touch.bidSize, touch.bestAsk, touch.askSize,
        touch.connectionEpoch, touch.connectionShard, touch.eventSequence, touch.walEventId,
        touch.bookHash, touch.eventType,
      ]));
    } catch (error) {
      this.touchBuffer = rows.concat(this.touchBuffer).slice(-100000);
      throw error;
    }
  }

  onRealtimeTrade(event, provenance) {
    const assetId = String(event.asset_id || '');
    const market = this.tokenMarkets.get(assetId);
    if (!market) return;
    const price = finite(event.price);
    const size = finite(event.size);
    if (price == null || size == null || size <= 0) return;
    const observedAt = provenance.receive_wall_timestamp_ms || Date.now();
    const sourceAt = epochMs(event.timestamp);
    const outcomeIndex = market.tokenIds.indexOf(assetId);
    const transactionHash = event.transaction_hash || event.transactionHash || null;
    const dedupKey = transactionHash
      ? hash([transactionHash, assetId, event.side, price, size, sourceAt])
      : hash(['ws', provenance.event_id, assetId, event.side, price, size]);
    const history = this.touchHistory.get(assetId) || [];
    const preTouch = [...history].reverse().find((touch) =>
      touch.observedAt <= observedAt && observedAt - touch.observedAt <= 2000) || null;
    const opposite = market.tokenIds.find((tokenId) => tokenId !== assetId);
    const result = evaluatePublicSweep({
      trade: { assetId, side: event.side, price, size, outcome: market.outcomes[outcomeIndex] },
      market, triggerBook: this.books.get(assetId), oppositeBook: this.books.get(opposite),
      preTouch, nowMs: observedAt, includeControls: FLOW_V1_CONTROL_ENABLED, includeChallengers: true,
    });
    this.counters.realtimeTrades += 1;
    if (result.eligible) {
      this.counters.eligibleSweeps += 1;
      this.counters.signals += result.signals.length;
      for (const signal of result.signals) {
        this.scheduleBoundaryIntent({
          dedupKey, signalDecisionMs: observedAt, signal: {
            ...signal,
            conditionId: market.conditionId,
            feeRate: market.feeRate,
          }, market,
        });
      }
    }
    this.writeChain = this.writeChain
      .then(() => this.persistRealtimeTrade({
        dedupKey, observedAt, sourceAt, assetId, market, event, provenance,
        price, size, transactionHash, result,
      }))
      .catch((error) => this.error(error));
  }

  _scheduleBoundaryTimer(atMs, fn) {
    const timer = setTimeout(async () => {
      this.boundaryTimers.delete(timer);
      try { await fn(); } catch (error) { await this.error(error); }
    }, Math.max(0, atMs - Date.now()));
    this.boundaryTimers.add(timer);
    return timer;
  }

  scheduleBoundaryIntent({ dedupKey, signalDecisionMs, signal, market }) {
    if (signal.arm !== BOUNDARY_SOURCE_ARM || signal.latencyMs !== BOUNDARY_SOURCE_LATENCY_MS
      || signal.features?.strategy_version !== CHALLENGER_STRATEGY_VERSION) return;
    const availableMs = new Date(signal.availableAt).getTime();
    if (!Number.isFinite(availableMs)) return;
    this._scheduleBoundaryTimer(availableMs, () => this.evaluateBoundaryIntent({
      dedupKey, signalDecisionMs, availableMs, signal, market,
    }));
  }

  async evaluateBoundaryIntent({ dedupKey, signalDecisionMs, availableMs, signal, market }) {
    const boundaryMs = Number.isFinite(market?.boundaryAt) ? market.boundaryAt : null;
    const decisionTouch = latestCausalTouch(this.touchHistory.get(signal.targetAssetId), availableMs);
    const decisionGap = decisionTouch == null || hasConnectionGap(this.connectionEvents, {
      fromMs: signalDecisionMs,
      toMs: availableMs,
      shard: decisionTouch?.connectionShard,
    });
    const source = boundarySourceState({
      signal, signalDecisionMs, availableMs, boundaryMs, touch: decisionTouch,
      connectionGap: decisionGap,
    });
    if (!source.armed || this.boundaryConditions.has(String(market.conditionId))) return;

    // One source attempt per market is the pre-registered independence unit.
    // Reserve in memory before the asynchronous DB insert so two public prints
    // in the same event-loop turn cannot both schedule an order arrival.
    this.boundaryConditions.add(String(market.conditionId));
    this.counters.boundarySourceArmed += 1;
    const intendedArrivalMs = availableMs + BOUNDARY_ORDER_TRANSIT_MS;
    const intentRecord = {
      kind: 'SOURCE_ARMED', experiment_id: BOUNDARY_EXPERIMENT_ID,
      trigger_key: dedupKey, ...source,
      order_latency_ms: BOUNDARY_ORDER_TRANSIT_MS,
      intended_arrival_at: new Date(intendedArrivalMs).toISOString(),
    };
    this.wal.boundary.append(JSON.stringify(intentRecord), {
      channel: 'boundary_intent', receiveWallMs: Date.now(),
    });

    const reservation = pool.query(`
      INSERT INTO pm_flow_boundary_intents (
        experiment_id,trigger_key,condition_id,borg_market_id,token_id,target_outcome,
        signal_decision_at,signal_available_at,boundary_at,tte_ms,
        decision_observed_at,decision_state_age_ms,decision_bid,decision_bid_size,
        decision_ask,decision_ask_size,decision_connection_epoch,decision_connection_shard,
        confirmation,order_latency_ms,intended_arrival_at,minimum_order_size,
        target_stake_usd,max_touch_participation,fee_rate,status,reason,detail)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
              $19::jsonb,$20,$21,$22,$23,$24,$25,'AWAITING_ARRIVAL','source_signal_armed',$26::jsonb)
      ON CONFLICT (experiment_id,condition_id) DO NOTHING RETURNING id`, [
      BOUNDARY_EXPERIMENT_ID, dedupKey, market.conditionId, market.borgMarketId,
      signal.targetAssetId, signal.targetOutcome, new Date(signalDecisionMs), new Date(availableMs),
      new Date(boundaryMs), Math.round(source.tte_ms), source.observed_at,
      Math.round(source.state_age_ms), source.best_bid, source.bid_size, source.best_ask,
      source.ask_size, source.connection_epoch, source.connection_shard,
      JSON.stringify(source.confirmation || {}), BOUNDARY_ORDER_TRANSIT_MS,
      new Date(intendedArrivalMs), source.minimum_order_size, source.target_stake_usd,
      source.max_touch_participation, source.fee_rate, JSON.stringify({
        strategy_version: CHALLENGER_STRATEGY_VERSION,
        collection_epoch_id: process.env.BORG_COLLECTION_EPOCH_ID || 'flow-unmarked',
      }),
    ]);

    this._scheduleBoundaryTimer(intendedArrivalMs, async () => {
      // Capture the last touch at/before the intended arrival, even if the JS
      // callback itself runs late. This prevents a post-arrival update from
      // leaking backwards into the execution simulation.
      const capturedAt = Date.now();
      const arrivalTouch = latestCausalTouch(this.touchHistory.get(signal.targetAssetId), intendedArrivalMs);
      const arrivalGap = arrivalTouch == null || hasConnectionGap(this.connectionEvents, {
        fromMs: signalDecisionMs,
        toMs: intendedArrivalMs,
        shard: arrivalTouch?.connectionShard,
      });
      const arrival = paperArrivalState({
        availableMs, boundaryMs, delayMs: BOUNDARY_ORDER_TRANSIT_MS,
        observedAt: arrivalTouch?.observedAt == null ? null : new Date(arrivalTouch.observedAt),
        bestBid: arrivalTouch?.bestBid, bidSize: arrivalTouch?.bidSize,
        bestAsk: arrivalTouch?.bestAsk, askSize: arrivalTouch?.askSize,
        feeRate: signal.feeRate, targetStake: signal.features?.target_stake_usd,
        touchParticipation: signal.features?.max_touch_participation,
        minimumOrderSize: signal.features?.minimum_order_size,
        sourceArmed: true, connectionGap: arrivalGap,
      });
      const reserved = await reservation;
      if (!reserved.rows.length) return;
      const intentId = reserved.rows[0].id;
      const status = arrival.filled ? 'READY' : 'REJECTED';
      if (arrival.filled) this.counters.boundaryReady += 1;
      else this.counters.boundaryRejected += 1;
      const arrivalRecord = {
        kind: status, intent_id: intentId, experiment_id: BOUNDARY_EXPERIMENT_ID,
        condition_id: market.conditionId, captured_at: new Date(capturedAt).toISOString(), ...arrival,
      };
      this.wal.boundary.append(JSON.stringify(arrivalRecord), {
        channel: 'boundary_arrival', receiveWallMs: capturedAt,
      });
      await pool.query(`
        UPDATE pm_flow_boundary_intents SET
          arrival_captured_at=$2,arrival_scheduler_lag_ms=$3,arrival_observed_at=$4,
          arrival_state_age_ms=$5,arrival_bid=$6,arrival_bid_size=$7,
          arrival_ask=$8,arrival_ask_size=$9,arrival_connection_epoch=$10,
          arrival_connection_shard=$11,requested_size=$12,requested_notional=$13,
          entry_fee=$14,data_quality_grade=$15,status=$16,reason=$17,detail=detail||$18::jsonb,
          updated_at=now()
        WHERE id=$1`, [
        intentId, new Date(capturedAt), Math.max(0, Math.round(capturedAt - intendedArrivalMs)),
        arrival.observed_at, arrival.state_age_ms, arrival.best_bid, arrival.bid_capacity,
        arrival.best_ask, arrival.ask_capacity, arrivalTouch?.connectionEpoch ?? null,
        arrivalTouch?.connectionShard ?? null, arrival.fill_size || null,
        arrival.notional || null, arrival.entry_fee || null,
        arrival.filled && arrival.state_age_ms <= 500 ? 'A' : arrival.filled ? 'B' : 'F',
        status, arrival.reason, JSON.stringify({ arrival }),
      ]);
      if (arrival.filled) await pool.query(`SELECT pg_notify('flow_boundary_ready',$1)`, [String(intentId)]);
    });
  }

  async persistRealtimeTrade(record) {
    const { rows } = await pool.query(`
      INSERT INTO pm_flow_trades (
        dedup_key,source,observed_at,source_ts,source_latency_ms,condition_id,asset_id,outcome,
        side,price,size,notional,tx_hash,wallet,connection_epoch,connection_shard,event_sequence,
        wal_event_id,data_quality_grade,raw)
      VALUES ($1,'clob_ws',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL,$13,$14,$15,$16,$17,$18::jsonb)
      ON CONFLICT (dedup_key) DO NOTHING RETURNING id`, [
      record.dedupKey, new Date(record.observedAt), record.sourceAt ? new Date(record.sourceAt) : null,
      record.sourceAt ? Math.max(0, record.observedAt - record.sourceAt) : null,
      record.market.conditionId, record.assetId,
      record.market.outcomes[record.market.tokenIds.indexOf(record.assetId)] || null,
      record.event.side || null, record.price, record.size, record.price * record.size,
      record.transactionHash, record.provenance.connection_epoch, record.provenance.shard,
      record.provenance.event_sequence, record.provenance.event_id,
      record.result.eligible ? 'A' : 'B', JSON.stringify(record.event),
    ]);
    if (!rows.length || !record.result.eligible) return;
    const triggerId = rows[0].id;
    await insertRows('pm_flow_signals', [
      'trigger_key','trigger_trade_id','decision_at','condition_id','trigger_asset_id','target_asset_id',
      'target_outcome','arm','latency_ms','available_at','entry_limit','requested_size','fee_rate',
      'data_quality_grade','features','status',
    ], record.result.signals.map((signal) => [
      record.dedupKey, triggerId, new Date(record.observedAt), record.market.conditionId,
      record.assetId, signal.targetAssetId, signal.targetOutcome, signal.arm, signal.latencyMs,
      signal.availableAt, signal.entryLimit, signal.requestedSize, record.market.feeRate,
      signal.dataQualityGrade, JSON.stringify(signal.features), 'PENDING',
    ]), 'ON CONFLICT (trigger_key,arm,latency_ms) DO NOTHING');
  }

  async scanGlobalTrades() {
    const end = Math.floor(Date.now() / 1000) + 1;
    // Advance in API source time. A wall-clock floor would discard every row
    // whenever this eventually-consistent endpoint trails the VPS clock.
    const start = sourceCursorCutoff(this.globalCursorSec);
    const recent = await this.fetchRecentTrades(start);
    const receivedAt = Date.now();
    this.lastGlobalResponseAt = receivedAt;
    const trades = recent.trades;
    if (!Array.isArray(trades) || !trades.length) return;
    let maxTimestamp = this.globalCursorSec;
    const entries = trades.map((trade) => {
      const sourceAt = epochMs(trade.timestamp);
      maxTimestamp = Math.max(maxTimestamp, Math.floor((sourceAt || 0) / 1000));
      const price = finite(trade.price);
      const size = finite(trade.size);
      const dedupKey = hash([
        trade.transactionHash, trade.asset, trade.proxyWallet, trade.side,
        price, size, trade.timestamp,
      ]);
      return { dedupKey, sourceAt, trade, row: [
        dedupKey, 'global_data_api', new Date(receivedAt), sourceAt ? new Date(sourceAt) : null,
        sourceAt ? Math.max(0, receivedAt - sourceAt) : null, trade.conditionId || null,
        String(trade.asset || ''), trade.outcome || null, trade.side || null, price, size,
        (price || 0) * (size || 0), trade.transactionHash || null, trade.proxyWallet || null,
        null, null, null, null, 'D', JSON.stringify(trade),
      ] };
    }).filter((entry) => entry.row[8] && entry.row[9] != null && entry.row[10] != null && entry.row[6]);
    const uniqueEntries = [];
    for (const entry of entries) {
      if (this.globalSeen.has(entry.dedupKey)) continue;
      this.globalSeen.set(entry.dedupKey, entry.sourceAt || receivedAt);
      uniqueEntries.push(entry);
    }
    const seenCutoff = receivedAt - 10 * 60 * 1000;
    for (const [key, seenAt] of this.globalSeen) {
      if (seenAt < seenCutoff) this.globalSeen.delete(key);
    }
    // Persist exact newly observed trade objects, not the repeatedly overlapping
    // HTTP page. This keeps an immutable replay source while avoiding tens of
    // gigabytes/day of duplicated trailing-window JSON.
    let provenance = { event_id: null };
    if (uniqueEntries.length) {
      provenance = this.wal.global.append(JSON.stringify({
        request: {
          start, end, received_at_ms: receivedAt, returned: trades.length,
          pages: recent.pages, page_size: DATA_TRADE_PAGE_SIZE, saturated: recent.saturated,
        },
        trades: uniqueEntries.map((entry) => entry.trade),
      }), {
        channel: 'data-api-trades-deduped', receiveWallMs: receivedAt,
        receiveMonoNs: process.hrtime.bigint().toString(),
      });
    }
    const rows = uniqueEntries.map((entry) => {
      entry.row[17] = provenance.event_id;
      return entry.row;
    });
    const inserted = await insertRows('pm_flow_trades', [
      'dedup_key','source','observed_at','source_ts','source_latency_ms','condition_id','asset_id',
      'outcome','side','price','size','notional','tx_hash','wallet','connection_epoch',
      'connection_shard','event_sequence','wal_event_id','data_quality_grade','raw',
    ], rows, 'ON CONFLICT (dedup_key) DO NOTHING');
    this.counters.globalTrades += inserted;
    this.globalCursorSec = Math.max(this.globalCursorSec, maxTimestamp);
    if (recent.saturated) {
      this.counters.globalCoverageGaps += 1;
      if (receivedAt - this.lastGlobalSaturationLogAt >= 60000) {
        this.lastGlobalSaturationLogAt = receivedAt;
        await logEvent('WARN', 'flow', 'bounded global trade sample did not reach the prior cursor', {
          start, end, pages: recent.pages, page_size: DATA_TRADE_PAGE_SIZE,
          oldest_sec: recent.oldestSec,
          interpretation: 'global discovery tape may have a gap; realtime CLOB experiment panel is unaffected',
        });
      }
    }
  }

  async scorePending() {
    const { rows } = await pool.query(`
      SELECT s.*,
        e.observed_at e_at,e.best_bid e_bid,e.bid_size e_bid_size,
        e.best_ask e_ask,e.ask_size e_ask_size,e.connection_shard e_shard,
        m1.observed_at m1_at,m1.best_bid m1_bid,m1.bid_size m1_bid_size,
        m2.observed_at m2_at,m2.best_bid m2_bid,m2.bid_size m2_bid_size,
        m5.observed_at m5_at,m5.best_bid m5_bid,m5.bid_size m5_bid_size,
        m10.observed_at m10_at,m10.best_bid m10_bid,m10.bid_size m10_bid_size,
        bm.window_end boundary_at,
        a50.observed_at a50_at,a50.best_bid a50_bid,a50.bid_size a50_bid_size,
        a50.best_ask a50_ask,a50.ask_size a50_ask_size,a50.connection_shard a50_shard,
        a100.observed_at a100_at,a100.best_bid a100_bid,a100.bid_size a100_bid_size,
        a100.best_ask a100_ask,a100.ask_size a100_ask_size,a100.connection_shard a100_shard,
        a250.observed_at a250_at,a250.best_bid a250_bid,a250.bid_size a250_bid_size,
        a250.best_ask a250_ask,a250.ask_size a250_ask_size,a250.connection_shard a250_shard,
        a500.observed_at a500_at,a500.best_bid a500_bid,a500.bid_size a500_bid_size,
        a500.best_ask a500_ask,a500.ask_size a500_ask_size,a500.connection_shard a500_shard,
        EXISTS (SELECT 1 FROM pm_flow_connection_events g
          WHERE g.event IN ('close','error','stale')
            AND g.connection_shard=e.connection_shard
            AND g.observed_at BETWEEN s.decision_at AND s.available_at) entry_connection_gap,
        EXISTS (SELECT 1 FROM pm_flow_connection_events g
          WHERE g.event IN ('close','error','stale')
            AND g.connection_shard=e.connection_shard
            AND g.observed_at BETWEEN s.decision_at AND s.available_at + interval '10 seconds') markout_connection_gap,
        EXISTS (SELECT 1 FROM pm_flow_connection_events g
          WHERE g.event IN ('close','error','stale') AND g.connection_shard=a50.connection_shard
            AND g.observed_at BETWEEN s.decision_at AND s.available_at + interval '50 milliseconds') a50_gap,
        EXISTS (SELECT 1 FROM pm_flow_connection_events g
          WHERE g.event IN ('close','error','stale') AND g.connection_shard=a100.connection_shard
            AND g.observed_at BETWEEN s.decision_at AND s.available_at + interval '100 milliseconds') a100_gap,
        EXISTS (SELECT 1 FROM pm_flow_connection_events g
          WHERE g.event IN ('close','error','stale') AND g.connection_shard=a250.connection_shard
            AND g.observed_at BETWEEN s.decision_at AND s.available_at + interval '250 milliseconds') a250_gap,
        EXISTS (SELECT 1 FROM pm_flow_connection_events g
          WHERE g.event IN ('close','error','stale') AND g.connection_shard=a500.connection_shard
            AND g.observed_at BETWEEN s.decision_at AND s.available_at + interval '500 milliseconds') a500_gap
      FROM pm_flow_signals s
      LEFT JOIN LATERAL (SELECT * FROM pm_flow_touches t WHERE t.asset_id=s.target_asset_id
        AND t.observed_at<=s.available_at ORDER BY t.observed_at DESC LIMIT 1) e ON true
      LEFT JOIN LATERAL (SELECT * FROM pm_flow_touches t WHERE t.asset_id=s.target_asset_id
        AND t.observed_at<=s.available_at+interval '1 second' ORDER BY t.observed_at DESC LIMIT 1) m1 ON true
      LEFT JOIN LATERAL (SELECT * FROM pm_flow_touches t WHERE t.asset_id=s.target_asset_id
        AND t.observed_at<=s.available_at+interval '2 seconds' ORDER BY t.observed_at DESC LIMIT 1) m2 ON true
      LEFT JOIN LATERAL (SELECT * FROM pm_flow_touches t WHERE t.asset_id=s.target_asset_id
        AND t.observed_at<=s.available_at+interval '5 seconds' ORDER BY t.observed_at DESC LIMIT 1) m5 ON true
      LEFT JOIN LATERAL (SELECT * FROM pm_flow_touches t WHERE t.asset_id=s.target_asset_id
        AND t.observed_at<=s.available_at+interval '10 seconds' ORDER BY t.observed_at DESC LIMIT 1) m10 ON true
      LEFT JOIN LATERAL (SELECT window_end FROM borg_markets b WHERE b.condition_id=s.condition_id
        ORDER BY b.window_end DESC LIMIT 1) bm ON true
      LEFT JOIN LATERAL (SELECT * FROM pm_flow_touches t WHERE t.asset_id=s.target_asset_id
        AND s.arm='absorption_reversal_v2' AND s.latency_ms=500
        AND t.observed_at<=s.available_at+interval '50 milliseconds'
        ORDER BY t.observed_at DESC LIMIT 1) a50 ON true
      LEFT JOIN LATERAL (SELECT * FROM pm_flow_touches t WHERE t.asset_id=s.target_asset_id
        AND s.arm='absorption_reversal_v2' AND s.latency_ms=500
        AND t.observed_at<=s.available_at+interval '100 milliseconds'
        ORDER BY t.observed_at DESC LIMIT 1) a100 ON true
      LEFT JOIN LATERAL (SELECT * FROM pm_flow_touches t WHERE t.asset_id=s.target_asset_id
        AND s.arm='absorption_reversal_v2' AND s.latency_ms=500
        AND t.observed_at<=s.available_at+interval '250 milliseconds'
        ORDER BY t.observed_at DESC LIMIT 1) a250 ON true
      LEFT JOIN LATERAL (SELECT * FROM pm_flow_touches t WHERE t.asset_id=s.target_asset_id
        AND s.arm='absorption_reversal_v2' AND s.latency_ms=500
        AND t.observed_at<=s.available_at+interval '500 milliseconds'
        ORDER BY t.observed_at DESC LIMIT 1) a500 ON true
      WHERE s.status='PENDING' AND s.available_at < now()-interval '12 seconds'
      ORDER BY s.id LIMIT 250`);
    if (!rows.length) return;
    const scoreRows = [];
    const scoredIds = [];
    for (const signal of rows) {
      const availableMs = new Date(signal.available_at).getTime();
      const entryAt = signal.e_at ? new Date(signal.e_at).getTime() : null;
      const entryAge = entryAt == null ? Infinity : availableMs - entryAt;
      const entryAsk = finite(signal.e_ask);
      const entryBid = finite(signal.e_bid);
      const entryBidSize = finite(signal.e_bid_size);
      const entryCapacity = finite(signal.e_ask_size);
      const deferredDecision = signal.features?.entry_filter === 'cost_confirmed_followthrough_v2';
      const confirmation = deferredDecision ? evaluateCostConfirmedEntry({
        features: signal.features,
        entryBid,
        bidSize: entryBidSize,
        entryAsk,
        askSize: entryCapacity,
        feeRate: signal.fee_rate,
      }) : { eligible: true, reason: 'v1_fixed_limit_control' };
      const quoteSurvived = !signal.entry_connection_gap && entryAge >= 0 && entryAge <= 1500
        && entryAsk != null && confirmation.eligible
        && (deferredDecision || entryAsk <= finite(signal.entry_limit) + 1e-9);
      const targetStake = finite(signal.features?.target_stake_usd) || 10;
      const touchParticipation = finite(signal.features?.max_touch_participation) || 0.20;
      const minimumOrderSize = Math.max(0, finite(signal.features?.minimum_order_size) || 0);
      const dynamicSize = deferredDecision && entryAsk > 0 && entryCapacity > 0
        ? Math.min(targetStake / entryAsk, entryCapacity * touchParticipation)
        : finite(signal.requested_size);
      const fillSize = quoteSurvived && entryCapacity > 0 && dynamicSize > 0
        && (minimumOrderSize <= 0 || dynamicSize + 1e-9 >= minimumOrderSize)
        && dynamicSize * entryAsk >= 1
        ? Math.min(dynamicSize, entryCapacity) : 0;
      const filled = fillSize > 0;
      const orderLatency = {};
      if (deferredDecision && signal.arm === 'absorption_reversal_v2' && signal.latency_ms === 500) {
        const parsedBoundary = signal.boundary_at ? new Date(signal.boundary_at).getTime() : null;
        for (const delayMs of ORDER_TRANSIT_PROFILES_MS) {
          const prefix = `a${delayMs}`;
          orderLatency[`${delayMs}ms`] = paperArrivalState({
            availableMs,
            boundaryMs: Number.isFinite(parsedBoundary) ? parsedBoundary : null,
            delayMs,
            observedAt: signal[`${prefix}_at`],
            bestBid: signal[`${prefix}_bid`],
            bidSize: signal[`${prefix}_bid_size`],
            bestAsk: signal[`${prefix}_ask`],
            askSize: signal[`${prefix}_ask_size`],
            feeRate: signal.fee_rate,
            targetStake,
            touchParticipation,
            minimumOrderSize,
            sourceArmed: filled,
            connectionGap: signal[`${prefix}_gap`],
          });
        }
      }
      const marks = {};
      let allFresh = true;
      let allVeryFresh = entryAge <= 500;
      for (const horizon of MARKOUT_HORIZONS_MS) {
        const prefix = `m${horizon / 1000}`;
        const markAt = signal[`${prefix}_at`] ? new Date(signal[`${prefix}_at`]).getTime() : null;
        const targetAt = availableMs + horizon;
        const age = markAt == null ? Infinity : targetAt - markAt;
        const bid = finite(signal[`${prefix}_bid`]);
        const bidSize = finite(signal[`${prefix}_bid_size`]);
        const liquid = filled && age >= 0 && age <= 1500 && bid != null && bidSize >= fillSize;
        const pnl = liquid ? roundTripPnl({
          shares: fillSize, entryPrice: entryAsk, exitPrice: bid, feeRate: signal.fee_rate,
        }) : null;
        marks[`${horizon / 1000}s`] = {
          target_at: new Date(targetAt).toISOString(), observed_at: markAt ? new Date(markAt).toISOString() : null,
          state_age_ms: Number.isFinite(age) ? age : null, exit_bid: bid, exit_capacity: bidSize,
          full_exit_supported: liquid, pnl,
        };
        allFresh = allFresh && (!filled || liquid);
        allVeryFresh = allVeryFresh && (!filled || (liquid && age <= 500));
      }
      const quality = signal.markout_connection_gap || entryAge > 1500 || !allFresh
        ? 'F' : allVeryFresh ? 'A' : 'B';
      scoreRows.push([
        signal.id, filled, filled ? new Date(entryAt) : null, filled ? entryAsk : null,
        filled ? fillSize : null,
        marks['1s'].pnl?.net ?? null, marks['2s'].pnl?.net ?? null,
        marks['5s'].pnl?.net ?? null, marks['10s'].pnl?.net ?? null,
        JSON.stringify({
          ...marks, quote_survived: quoteSurvived, entry_state_age_ms: Number.isFinite(entryAge) ? entryAge : null,
          entry_capacity: entryCapacity, connection_gap: signal.markout_connection_gap,
          entry_connection_gap: signal.entry_connection_gap,
          markout_connection_gap: signal.markout_connection_gap,
          order_latency: orderLatency,
          arm: signal.arm, latency_ms: signal.latency_ms,
          strategy_version: signal.features?.strategy_version || STRATEGY_VERSION,
          deferred_decision: deferredDecision, confirmation,
        }), quality, quality === 'F' ? 'F' : quality, 'L3', FEE_MODEL_VERSION,
      ]);
      scoredIds.push(signal.id);
      this.counters.scored += 1;
      if (filled) this.counters.filled += 1;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const columns = [
        'signal_id','filled','entry_at','entry_price','fill_size','pnl_1s','pnl_2s','pnl_5s','pnl_10s',
        'markouts','data_quality_grade','execution_fidelity_grade','fidelity_level','fee_model_version',
      ];
      const parameters = [];
      const tuples = scoreRows.map((row) => `(${row.map((value) => {
        parameters.push(value); return `$${parameters.length}`;
      }).join(',')})`);
      await client.query(`INSERT INTO pm_flow_scores (${columns.join(',')}) VALUES ${tuples.join(',')}
        ON CONFLICT (signal_id) DO NOTHING`, parameters);
      await client.query(`UPDATE pm_flow_signals SET status='SCORED' WHERE id=ANY($1::bigint[])`, [scoredIds]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  health() {
    for (const socket of this.sockets) socket.checkStale();
  }

  async heartbeat() {
    await logEvent('INFO', 'flow_heartbeat', 'public-flow paper collector alive', {
      ...this.counters,
      runId: RUN_ID,
      collectionEpochId: process.env.BORG_COLLECTION_EPOCH_ID || 'flow-unmarked',
      uptimeMin: Math.round((Date.now() - new Date(this.counters.startedAt).getTime()) / 60000),
      selectedMarkets: this.markets.size,
      activeSockets: this.sockets.filter((socket) => socket.ws?.readyState === WebSocket.OPEN).length,
      lastSocketMessageAt: this.sockets.map((socket) => socket.lastMessageAt || null),
      lastGlobalResponseAt: this.lastGlobalResponseAt || null,
      memoryMb: Object.fromEntries(Object.entries(process.memoryUsage())
        .map(([key, bytes]) => [key, Math.round(bytes / 1024 / 1024)])),
      wal: {
        clob: this.wal.clob.health(), global: this.wal.global.health(),
        boundary: this.wal.boundary.health(),
      },
      paper_only: true,
    });
  }

  async error(error) {
    this.counters.errors += 1;
    console.error('[flow]', error);
    await logEvent('ERROR', 'flow', error.message, { stack: error.stack?.split('\n').slice(0, 5) });
  }

  async close() {
    this.running = false;
    this.timers.forEach(clearInterval);
    this.boundaryTimers.forEach(clearTimeout);
    this.boundaryTimers.clear();
    this.sockets.forEach((socket) => socket.close());
    await this.writeChain;
    await this.flushTouches().catch((error) => this.error(error));
    await Promise.all([this.wal.clob.close(), this.wal.global.close(), this.wal.boundary.close()]);
    await pool.end();
  }
}

if (require.main === module) {
  const collector = new FlowCollector();
  collector.start().catch(async (error) => {
    await collector.error(error);
    await collector.close();
    process.exit(1);
  });
  const shutdown = () => collector.close().finally(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = {
  FlowCollector,
  FlowSocket,
  ORDER_TRANSIT_PROFILES_MS,
  RUN_ID,
  collectRecentTradePages,
  dataTradesUrl,
  epochMs,
  latestSourceWindow,
  makeNonOverlappingTask,
  normLevels,
  paperArrivalState,
  parseArray,
  sourceCursorCutoff,
};
