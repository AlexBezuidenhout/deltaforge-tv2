#!/usr/bin/env node
'use strict';

/**
 * Public, paper-only Deribit option-surface collector and Polymarket binary
 * valuation observer. Raw Deribit/CLOB/RTDS frames are WAL-appended before
 * parsing. Signal state stays in memory; compact persistence is asynchronous.
 * This process has no wallet, API key, signer, authenticated venue channel, or
 * order-submission dependency.
 */

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const ClobMultiplex = require('../recon/clob-multiplex');
const RtdsRecon = require('../recon/rtds');
const RawWal = require('../recon/wal');
const {
  insertRows, logEvent, migrateOptions, pool,
} = require('../recon/db');
const {
  deltaHedgeForBinary, digitalCashFair, optimizeBinaryEntry,
  priceBinaryFromSurface, quantifyResidualRisk,
} = require('./digital-pricer');
const { feePerShare } = require('../structural/bregman');
const {
  buildArchiveTargets, normalizeInstrument, selectSurfaceInstruments,
} = require('./surface-universe');
const {
  TARGET_UNIVERSE_VERSION, selectSurfaceBracketedThresholds,
} = require('./target-universe');

const DERIBIT_HTTP = 'https://www.deribit.com/api/v2';
const DERIBIT_WS = 'wss://www.deribit.com/ws/api/v2';
const GAMMA = 'https://gamma-api.polymarket.com';
const OPTIONS_EXPERIMENT_ID = 'options-daily-threshold-surface-residual-v3';
const CURRENCIES = String(process.env.OPTIONS_CURRENCIES || 'BTC,ETH')
  .split(',').map((value) => value.trim().toUpperCase()).filter(Boolean);
const REFRESH_MS = Math.max(60_000, Number(process.env.OPTIONS_REFRESH_MS || 300_000));
const DB_SAMPLE_MS = Math.max(250, Number(process.env.OPTIONS_DB_SAMPLE_MS || 5000));
const MARK_SAMPLE_MS = Math.max(100, Number(process.env.OPTIONS_MARK_SAMPLE_MS || 5000));
const EXECUTABLE_MARK_SAMPLE_MS = Math.max(100,
  Number(process.env.OPTIONS_EXECUTABLE_MARK_SAMPLE_MS || 250));
const MAX_INSTRUMENTS = Math.max(8, Number(process.env.OPTIONS_MAX_INSTRUMENTS || 160));
const TARGET_BUDGET_USD = Math.max(1, Number(process.env.OPTIONS_TARGET_BUDGET_USD || 10));
const HEDGE_COST_BPS = Math.max(0, Number(process.env.OPTIONS_HEDGE_COST_BPS || 5));
const RESOLVER_UNCERTAINTY_BPS = Math.max(0,
  Number(process.env.OPTIONS_RESOLVER_UNCERTAINTY_BPS || 3));
const MIN_TTE_SEC = Math.max(30, Number(process.env.OPTIONS_MIN_TTE_SEC || 300));
const MAX_TTE_SEC = Math.max(MIN_TTE_SEC, Number(process.env.OPTIONS_MAX_TTE_SEC || 604800));
const SURFACE_MAX_AGE_MS = Math.max(500, Number(process.env.OPTIONS_SURFACE_MAX_AGE_MS || 3000));
const POLY_BOOK_MAX_AGE_MS = Math.max(100, Number(process.env.OPTIONS_POLY_BOOK_MAX_AGE_MS || 500));
const DB_FLUSH_MAX_ATTEMPTS = Math.max(1,
  Number(process.env.OPTIONS_DB_FLUSH_MAX_ATTEMPTS || 4));
const DB_FLUSH_RETRY_BASE_MS = Math.max(5,
  Number(process.env.OPTIONS_DB_FLUSH_RETRY_BASE_MS || 25));
const ARCHIVE_HORIZONS_HOURS = Object.freeze([24, 168]);

const RETRYABLE_DB_CODES = new Set([
  '40P01', // deadlock_detected
  '40001', // serialization_failure
  '55P03', // lock_not_available / lock timeout
]);
const DECISION_WAL_APPENDED = Symbol('decisionWalAppended');

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function epochMs(value) {
  const numeric = finite(value);
  if (numeric != null) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRetryableDbError(error) {
  return RETRYABLE_DB_CODES.has(String(error?.code || ''))
    || /deadlock detected|could not serialize|lock timeout/i.test(String(error?.message || ''));
}

async function retryTransientDb(action, options = {}) {
  const maxAttempts = Math.max(1, Number(options.maxAttempts || DB_FLUSH_MAX_ATTEMPTS));
  const baseDelayMs = Math.max(0, Number(options.baseDelayMs ?? DB_FLUSH_RETRY_BASE_MS));
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await action(attempt);
    } catch (error) {
      if (!isRetryableDbError(error) || attempt >= maxAttempts) throw error;
      options.onRetry?.(error, attempt);
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * (2 ** (attempt - 1))));
    }
  }
  return null;
}

function classifyExecutionBarrier({
  valuation, optimized, freshBook, book, bookAgeMs, resolverAgeMs, chainlinkAgeMs,
  feesKnown, minimumOrderSize,
}) {
  if (!valuation) return 'NO_SURFACE_VALUATION';
  if (!valuation.ivIntervalComplete) return 'INCOMPLETE_BID_ASK_IV_INTERVAL';
  if (!['A', 'B'].includes(valuation.fidelity)) {
    return `UNSUPPORTED_${String(valuation.surface?.mode || 'SURFACE_EXTRAPOLATION')}`;
  }
  if (!book) return 'POLYMARKET_BOOK_UNAVAILABLE';
  if (!freshBook) return bookAgeMs == null
    ? 'POLYMARKET_BOOK_UNTIMESTAMPED' : 'POLYMARKET_BOOK_STALE';
  const referenceAgeMs = resolverAgeMs ?? chainlinkAgeMs;
  if (!(referenceAgeMs != null && referenceAgeMs <= 3000)) return 'RESOLVER_PRICE_STALE';
  if (!feesKnown) return 'UNKNOWN_POLYMARKET_FEE_SCHEDULE';
  if (!(minimumOrderSize > 0)) return 'UNKNOWN_VENUE_MINIMUM_SIZE';
  if (!optimized) return 'NO_POSITIVE_DEPTH_WALK_AFTER_2X_COSTS';
  return null;
}

function syncPolymarketSubscriptions(clob, targetByToken) {
  const tokenIds = [...targetByToken.keys()];
  // ClobRecon retains this desired set while disconnected and sends it as the
  // first application message on open. This must run before the initial
  // connect; otherwise empty sockets only exchange heartbeats and every option
  // mark is incorrectly classified as lacking an executable Polymarket book.
  clob.subscribe(tokenIds);
  return tokenIds.length;
}

async function fetchJson(url, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 160)}`);
    return JSON.parse(body);
  } finally { clearTimeout(timeout); }
}

function feeMetadata(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const schedule = value.feeSchedule || value.fee_schedule || {};
  const enabled = value.feesEnabled === true || value.fees_enabled === true
    || finite(schedule.rate ?? value.fee_rate) > 0;
  const rate = enabled ? finite(schedule.rate ?? value.fee_rate) : 0;
  const exponent = enabled ? finite(schedule.exponent) : 1;
  return {
    enabled,
    rate,
    exponent,
    known: !enabled || (rate != null && rate >= 0 && exponent != null && exponent > 0),
  };
}

function resolverFeed(resolutionSource) {
  const source = String(resolutionSource || '').toLowerCase();
  if (source.startsWith('binance')) return 'binance';
  if (source.includes('chainlink')) return 'chainlink';
  return null;
}

async function loadTargets() {
  const { rows } = await pool.query(`
    SELECT id,condition_id,slug,asset,strike,window_end,up_token_id,down_token_id,
           resolution_source,raw
      FROM borg_markets
     WHERE market_type='threshold_daily'
       AND lower(asset)=ANY($1::text[])
       AND accepting_orders=true
       AND raw->'_optionsSurfaceTarget'->>'universeVersion'=$2
       AND strike IS NOT NULL
       AND window_end > now() + ($3::int * interval '1 second')
       AND window_end <= now() + ($4::int * interval '1 second')
     ORDER BY window_end,asset,strike
  `, [
    CURRENCIES.map((value) => value.toLowerCase()),
    TARGET_UNIVERSE_VERSION,
    MIN_TTE_SEC,
    MAX_TTE_SEC,
  ]);
  return rows.map((row) => {
    const raw = row.raw && typeof row.raw === 'object' ? row.raw : {};
    const fees = feeMetadata(raw);
    return {
      id: parseInt(row.id, 10),
      conditionId: row.condition_id,
      slug: row.slug,
      asset: String(row.asset).toLowerCase(),
      currency: String(row.asset).toUpperCase(),
      strike: finite(row.strike),
      targetExpiryMs: new Date(row.window_end).getTime(),
      yesToken: row.up_token_id == null ? null : String(row.up_token_id),
      noToken: row.down_token_id == null ? null : String(row.down_token_id),
      resolutionSource: row.resolution_source || null,
      resolverFeed: resolverFeed(row.resolution_source),
      minimumOrderSize: finite(raw.orderMinSize ?? raw.minimum_order_size
        ?? raw.min_order_size),
      fees,
      surfaceTarget: raw._optionsSurfaceTarget || null,
    };
  }).filter((row) => Number.isSafeInteger(row.id) && row.strike > 1
    && row.targetExpiryMs > Date.now() && row.yesToken && row.noToken
    && row.resolverFeed);
}

function listedCallExpiries(rawInstruments, nowMs = Date.now()) {
  const maximum = nowMs + MAX_TTE_SEC * 1000;
  const minimum = nowMs + MIN_TTE_SEC * 1000;
  return [...new Set((Array.isArray(rawInstruments) ? rawInstruments : [])
    .map(normalizeInstrument)
    .filter((row) => row && row.optionType === 'call'
      && CURRENCIES.includes(row.currency)
      && row.expirationMs >= minimum && row.expirationMs <= maximum)
    .map((row) => row.expirationMs))].sort((left, right) => left - right);
}

async function fetchThresholdEvents(expiries, options = {}) {
  const fetcher = options.fetcher || fetchJson;
  const uniqueExpiries = [...new Set((expiries || []).map(finite)
    .filter((value) => value > 0))].sort((left, right) => left - right);
  const windows = options.bracketed === true
    ? uniqueExpiries.slice(0, -1).map((lower, index) => ({
      lower: lower - 1000,
      upper: uniqueExpiries[index + 1] + 1000,
    }))
    : uniqueExpiries.map((expiryMs) => ({
      lower: expiryMs - 1000,
      upper: expiryMs + 1000,
    }));
  const pages = await Promise.all(windows.map(async ({ lower, upper }) => {
    const url = new URL(`${GAMMA}/events`);
    const params = {
      tag_id: '21', active: 'true', closed: 'false', limit: '100',
      // Gamma caps a broad query at 100 rows. Querying each actually listed
      // Deribit boundary directly prevents nearer hourly events from crowding
      // the exact-expiry target out of the response.
      end_date_min: new Date(lower).toISOString(),
      end_date_max: new Date(upper).toISOString(),
      order: 'endDate', ascending: 'true',
    };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const rows = await fetcher(url);
    if (!Array.isArray(rows)) throw new Error('Gamma threshold response is not an array');
    return rows;
  }));
  return [...new Map(pages.flat()
    .map((event) => [String(event?.id || event?.slug || ''), event])
    .filter(([key]) => key)).values()];
}

async function persistExactExpiryTargets(records) {
  if (!records.length) return;
  await insertRows('borg_markets', [
    'slug', 'asset', 'gamma_id', 'condition_id', 'question',
    'window_start', 'window_end', 'up_token_id', 'down_token_id',
    'market_type', 'timeframe_sec', 'event_id', 'event_slug', 'strike',
    'lower_bound', 'upper_bound', 'positive_label', 'negative_label',
    'positive_outcome_index', 'negative_outcome_index', 'resolution_source',
    'accepting_orders', 'raw',
  ], records.map((record) => [
    record.slug, record.asset, record.gamma_id, record.condition_id, record.question,
    record.window_start, record.window_end, record.up_token_id, record.down_token_id,
    record.market_type, record.timeframe_sec, record.event_id, record.event_slug,
    record.strike, record.lower_bound, record.upper_bound,
    record.positive_label, record.negative_label,
    record.positive_outcome_index, record.negative_outcome_index,
    record.resolution_source, record.accepting_orders, JSON.stringify(record.raw),
  ]), `ON CONFLICT (slug) DO UPDATE SET
    asset=EXCLUDED.asset,gamma_id=EXCLUDED.gamma_id,
    condition_id=EXCLUDED.condition_id,question=EXCLUDED.question,
    window_start=EXCLUDED.window_start,window_end=EXCLUDED.window_end,
    up_token_id=EXCLUDED.up_token_id,down_token_id=EXCLUDED.down_token_id,
    market_type=EXCLUDED.market_type,timeframe_sec=EXCLUDED.timeframe_sec,
    event_id=EXCLUDED.event_id,event_slug=EXCLUDED.event_slug,
    strike=EXCLUDED.strike,positive_label=EXCLUDED.positive_label,
    negative_label=EXCLUDED.negative_label,
    positive_outcome_index=EXCLUDED.positive_outcome_index,
    negative_outcome_index=EXCLUDED.negative_outcome_index,
    resolution_source=EXCLUDED.resolution_source,
    accepting_orders=EXCLUDED.accepting_orders,raw=EXCLUDED.raw`);
}

async function fetchInstruments(currency) {
  const url = new URL(`${DERIBIT_HTTP}/public/get_instruments`);
  url.searchParams.set('currency', currency);
  url.searchParams.set('kind', 'option');
  url.searchParams.set('expired', 'false');
  const payload = await fetchJson(url);
  if (!Array.isArray(payload.result)) throw new Error(`Deribit ${currency} instrument response missing result`);
  return payload.result;
}

async function fetchIndexPrice(currency) {
  const url = new URL(`${DERIBIT_HTTP}/public/get_index_price`);
  url.searchParams.set('index_name', `${String(currency).toLowerCase()}_usd`);
  const payload = await fetchJson(url);
  const price = finite(payload?.result?.index_price);
  if (!(price > 0)) throw new Error(`Deribit ${currency} index response missing index_price`);
  return [String(currency).toUpperCase(), price];
}

class OptionsObserver {
  constructor() {
    this.runId = `options_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;
    this.startedAt = new Date();
    this.deribitWal = new RawWal('deribit-options', {
      root: process.env.BORG_WAL_DIR,
      mirrorRoot: process.env.BORG_WAL_MIRROR_DIR || null,
      minFreeGb: Number(process.env.BORG_WAL_MIN_FREE_GB || 20),
      collectorRunId: this.runId,
    });
    this.polyWal = new RawWal('options-polymarket-clob', {
      root: process.env.BORG_WAL_DIR,
      mirrorRoot: process.env.BORG_WAL_MIRROR_DIR || null,
      minFreeGb: Number(process.env.BORG_WAL_MIN_FREE_GB || 20),
      collectorRunId: this.runId,
    });
    this.rtdsWal = new RawWal('options-rtds-chainlink', {
      root: process.env.BORG_WAL_DIR,
      mirrorRoot: process.env.BORG_WAL_MIRROR_DIR || null,
      minFreeGb: Number(process.env.BORG_WAL_MIN_FREE_GB || 20),
      collectorRunId: this.runId,
    });
    this.decisionWal = new RawWal('options-decisions', {
      root: process.env.BORG_WAL_DIR,
      mirrorRoot: process.env.BORG_WAL_MIRROR_DIR || null,
      minFreeGb: Number(process.env.BORG_WAL_MIN_FREE_GB || 20),
      collectorRunId: this.runId,
    });
    this.ws = null;
    this.networkStarted = false;
    this.clobStarted = false;
    this.connectionEpoch = 0;
    this.rpcId = 0;
    this.reconnectDelay = 1000;
    this.reconnectTimer = null;
    this.closed = false;
    this.targets = [];
    this.archiveTargets = [];
    this.exactExpirySummary = {
      universeVersion: TARGET_UNIVERSE_VERSION, records: 0, rejected: {},
    };
    this.targetByToken = new Map();
    this.instrumentByName = new Map();
    this.subscribed = new Set();
    this.latestTick = new Map();
    this.touchBuffer = new Map();
    this.markBuffer = new Map();
    this.flushPromise = null;
    this.lastEventAt = 0;
    this.lastMarkAt = 0;
    this.metrics = {
      rawFrames: 0, tickerEvents: 0, storedTouches: 0, shadowMarks: 0,
      parseErrors: 0, refreshErrors: 0, clobTriggers: 0, deribitTriggers: 0,
      executableMarks: 0, executionBarriers: {}, surfaceFidelity: {},
      flushRetries: 0, persistenceErrors: 0,
    };
    this.clob = new ClobMultiplex((token) => this.targetByToken.get(String(token))?.id || null, {
      shardCount: Number(process.env.OPTIONS_CLOB_SHARDS || 2),
      wal: this.polyWal,
      onMarketEvent: (event) => {
        const target = this.targetByToken.get(String(event.assetId));
        if (!target) return;
        this.metrics.clobTriggers += 1;
        this.evaluateTarget(target, 'POLYMARKET_CLOB');
      },
    });
    this.rtds = new RtdsRecon((source, message) => logEvent('WARN', 'options', `${source}: ${message}`), {
      assets: CURRENCIES.map((value) => value.toLowerCase()),
      wal: this.rtdsWal,
      onMarketEvent: (event) => {
        for (const target of this.targets.filter((row) => row.asset === event.asset)) {
          this.evaluateTarget(target, 'CHAINLINK_RTDS');
        }
      },
    });
  }

  send(method, params) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.rpcId += 1;
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', id: this.rpcId, method, params }));
    return true;
  }

  changeSubscriptions(nextNames) {
    const next = new Set(nextNames);
    const removed = [...this.subscribed].filter((name) => !next.has(name));
    const added = [...next].filter((name) => !this.subscribed.has(name));
    const chunks = (rows) => Array.from({ length: Math.ceil(rows.length / 50) },
      (_value, index) => rows.slice(index * 50, index * 50 + 50));
    for (const chunk of chunks(removed)) this.send('public/unsubscribe', {
      channels: chunk.map((name) => `ticker.${name}.100ms`),
    });
    for (const chunk of chunks(added)) this.send('public/subscribe', {
      channels: chunk.map((name) => `ticker.${name}.100ms`),
    });
    this.subscribed = next;
  }

  connectDeribit() {
    return new Promise((resolve) => {
      let socket;
      try { socket = new WebSocket(DERIBIT_WS); } catch (error) {
        this.scheduleReconnect(); resolve(false); return;
      }
      this.ws = socket;
      const timeout = setTimeout(() => {
        try { socket.terminate(); } catch (_) {}
        resolve(false);
      }, 15_000);
      socket.on('open', () => {
        if (socket !== this.ws) return;
        clearTimeout(timeout);
        this.connectionEpoch += 1;
        this.reconnectDelay = 1000;
        this.lastEventAt = Date.now();
        const names = [...this.instrumentByName.keys()];
        this.subscribed.clear();
        this.changeSubscriptions(names);
        resolve(true);
      });
      socket.on('message', (raw) => { if (socket === this.ws) this.onDeribitMessage(raw); });
      socket.on('close', () => {
        clearTimeout(timeout);
        if (socket !== this.ws || this.closed) return;
        this.scheduleReconnect();
      });
      socket.on('error', () => { /* close follows */ });
    });
  }

  scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(30_000, delay * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectDeribit().then((ok) => { if (!ok) this.scheduleReconnect(); })
        .catch(() => this.scheduleReconnect());
    }, delay);
  }

  onDeribitMessage(raw) {
    const receiveWallMs = Date.now();
    const receiveMonoNs = process.hrtime.bigint().toString();
    const provenance = this.deribitWal.append(raw, {
      channel: 'public-option-ticker', receiveWallMs, receiveMonoNs,
      connectionEpoch: this.connectionEpoch,
    });
    this.metrics.rawFrames += 1;
    this.lastEventAt = receiveWallMs;
    let message;
    try { message = JSON.parse(raw); } catch (_) { this.metrics.parseErrors += 1; return; }
    const channel = message?.params?.channel;
    const data = message?.params?.data;
    if (!channel?.startsWith('ticker.') || !data?.instrument_name) return;
    const instrument = this.instrumentByName.get(String(data.instrument_name));
    if (!instrument) return;
    const greeks = data.greeks || {};
    const row = {
      sampleAt: Math.floor(receiveWallMs / DB_SAMPLE_MS) * DB_SAMPLE_MS,
      sourceMs: epochMs(data.timestamp), receiveWallMs, receiveMonoNs,
      instrumentName: instrument.instrumentName, currency: instrument.currency,
      optionType: instrument.optionType, strike: instrument.strike,
      expirationMs: instrument.expirationMs,
      bestBidPrice: finite(data.best_bid_price), bestAskPrice: finite(data.best_ask_price),
      markPrice: finite(data.mark_price), bidIv: finite(data.bid_iv),
      askIv: finite(data.ask_iv), markIv: finite(data.mark_iv),
      underlyingPrice: finite(data.underlying_price), indexPrice: finite(data.index_price),
      openInterest: finite(data.open_interest), delta: finite(greeks.delta),
      gamma: finite(greeks.gamma), vega: finite(greeks.vega), theta: finite(greeks.theta),
      connectionEpoch: this.connectionEpoch,
      eventSequence: provenance.event_sequence,
      walEventId: provenance.event_id,
    };
    this.latestTick.set(row.instrumentName, row);
    this.touchBuffer.set(`${row.instrumentName}:${row.sampleAt}`, row);
    this.metrics.tickerEvents += 1;
    this.metrics.deribitTriggers += 1;
    for (const target of this.targets.filter((entry) => entry.currency === row.currency)) {
      this.evaluateTarget(target, 'DERIBIT_OPTION');
    }
  }

  evaluateTarget(target, triggerSource) {
    const now = Date.now();
    const tteSec = (target.targetExpiryMs - now) / 1000;
    if (!(tteSec >= MIN_TTE_SEC && tteSec <= MAX_TTE_SEC)) return;
    const rows = [...this.latestTick.values()].filter((row) => row.currency === target.currency
      && now - row.receiveWallMs <= SURFACE_MAX_AGE_MS);
    if (rows.length < 2) return;
    const spotRows = rows.map((row) => row.underlyingPrice ?? row.indexPrice).filter((value) => value > 1);
    if (!spotRows.length) return;
    const spot = spotRows.sort((left, right) => left - right)[Math.floor(spotRows.length / 2)];
    const resolverPrice = this.rtds.getPrice(target.asset, 3000, target.resolverFeed);
    const resolverAgeMs = this.rtds.getAgeMs(target.asset, target.resolverFeed);
    if (!(resolverPrice > 1)) return;
    const basisCenterBps = (resolverPrice / spot - 1) * 10_000;
    const valuation = priceBinaryFromSurface({
      rows: rows.map((row) => ({
        expiryMs: row.expirationMs, strike: row.strike,
        bidIv: row.bidIv, askIv: row.askIv, markIv: row.markIv,
      })),
      spot, strike: target.strike, targetExpiryMs: target.targetExpiryMs, nowMs: now,
      basisBpsInterval: [basisCenterBps - RESOLVER_UNCERTAINTY_BPS,
        basisCenterBps + RESOLVER_UNCERTAINTY_BPS],
    });
    if (!valuation) return;
    const midpointFair = digitalCashFair({
      spot: resolverPrice, strike: target.strike, annualizedVol: valuation.surface.markIv,
      secondsToExpiry: tteSec,
    });
    if (!midpointFair) return;
    for (const side of ['YES', 'NO']) {
      const token = side === 'YES' ? target.yesToken : target.noToken;
      const book = this.clob.getBook(token);
      const bid = finite(book?.bids?.[0]?.[0]);
      const ask = finite(book?.asks?.[0]?.[0]);
      const askSize = finite(book?.asks?.[0]?.[1]);
      const marketMid = bid != null && ask != null ? (bid + ask) / 2 : null;
      const bookAgeMs = book?.at == null ? null : Math.max(0, now - book.at);
      const minimumOrderSize = finite(book?.minOrderSize) ?? target.minimumOrderSize;
      const fair = side === 'YES' ? valuation.fairYes : 1 - valuation.fairYes;
      const fairLower = side === 'YES' ? valuation.fairYesLower : 1 - valuation.fairYesUpper;
      const fairUpper = side === 'YES' ? valuation.fairYesUpper : 1 - valuation.fairYesLower;
      const fee2x = target.fees.known && ask > 0
        ? feePerShare(ask, target.fees.rate, target.fees.exponent, 2) : null;
      const hedgeCostPerShare = Math.abs(midpointFair.delta) * spot * HEDGE_COST_BPS / 10_000;
      const optimized = target.fees.known && minimumOrderSize > 0 && Array.isArray(book?.asks)
        ? optimizeBinaryEntry({
          asks: book.asks, fairLower, budgetUsd: TARGET_BUDGET_USD,
          minimumOrderSize, feeRate: target.fees.rate,
          feeExponent: target.fees.exponent, feeMultiplier: 2, hedgeCostPerShare,
        }) : null;
      const hedge = optimized ? deltaHedgeForBinary({
        tokenShares: optimized.shares, outcome: side,
        deltaPerShare: midpointFair.delta, spot, quantityStep: 0.001,
      }) : null;
      const risk = optimized && hedge ? quantifyResidualRisk({
        tokenShares: optimized.shares, outcome: side, spot: resolverPrice,
        strike: target.strike, annualizedVol: valuation.surface.markIv,
        secondsToExpiry: tteSec, hedgeBase: hedge.hedgeBase,
      }) : null;
      const fullSurface = ['A', 'B'].includes(valuation.fidelity);
      const freshBook = bookAgeMs != null && bookAgeMs <= POLY_BOOK_MAX_AGE_MS;
      const executable = Boolean(optimized && fullSurface && freshBook
        && resolverAgeMs != null && resolverAgeMs <= 3000 && target.fees.known);
      const executionBarrier = classifyExecutionBarrier({
        valuation, optimized, freshBook, book, bookAgeMs,
        resolverAgeMs,
        feesKnown: target.fees.known, minimumOrderSize,
      });
      const grade = executable ? 'A' : valuation.fidelity === 'D' || !target.fees.known
        ? 'D' : freshBook ? 'B' : 'C';
      // Sparse diagnostic marks are enough when a target cannot clear its
      // execution gates. Preserve high-rate marks only for genuinely
      // executable states; every upstream raw frame remains in the WAL.
      const markSampleMs = executable ? EXECUTABLE_MARK_SAMPLE_MS : MARK_SAMPLE_MS;
      const bucket = Math.floor(now / markSampleMs) * markSampleMs;
      const dedupKey = `${this.runId}:${target.id}:${side}:${bucket}`;
      this.markBuffer.set(dedupKey, {
        dedupKey, observedAt: now, marketId: target.id,
        conditionId: target.conditionId, asset: target.asset, strike: target.strike,
        targetExpiryMs: target.targetExpiryMs, triggerSource, side,
        targetSurfaceMode: target.surfaceTarget?.surfaceMode || null,
        lowerAnchorExpiryMs: target.surfaceTarget?.lowerDeribitExpiryMs || null,
        upperAnchorExpiryMs: target.surfaceTarget?.upperDeribitExpiryMs || null,
        polyAsk: ask, polyAskSize: askSize, modelFair: fair,
        marketMid,
        surfaceResidual: marketMid == null ? null : fair - marketMid,
        fairLower, fairUpper, feeRate: target.fees.rate, fee2x,
        edgeLower2x: ask != null && fee2x != null ? fairLower - ask - fee2x : null,
        targetShares: optimized?.shares ?? null,
        expectedProfitLowerUsd: optimized?.expectedProfitLower ?? null,
        hedgeBase: hedge?.hedgeBase ?? null,
        hedgeCostStressUsd: optimized?.hedgeCostStress ?? null,
        netEdgeStressUsd: optimized?.expectedProfitLower ?? null,
        residualCvar95Usd: risk?.cvar95LossUsd ?? null,
        surfaceFidelity: valuation.fidelity, dataQualityGrade: grade, executable,
        detail: {
          runId: this.runId, experimentId: OPTIONS_EXPERIMENT_ID,
          targetUniverseVersion: TARGET_UNIVERSE_VERSION,
          surfaceTarget: target.surfaceTarget,
          paperOnly: true, walletLoaded: false,
          tteSec, spot, resolverPrice, resolverAgeMs,
          resolverFeed: target.resolverFeed,
          resolutionSource: target.resolutionSource,
          // Backward-compatible diagnostic key; it is null when the contract
          // settles from Binance rather than Chainlink.
          chainlink: target.resolverFeed === 'chainlink' ? resolverPrice : null,
          chainlinkAgeMs: target.resolverFeed === 'chainlink' ? resolverAgeMs : null,
          basisCenterBps,
          resolverUncertaintyBps: RESOLVER_UNCERTAINTY_BPS,
          surface: valuation.surface, ivIntervalComplete: valuation.ivIntervalComplete,
          executionBarrier,
          bookAgeMs, minimumOrderSize, fees: target.fees,
          targetBudgetUsd: TARGET_BUDGET_USD, hedgeCostBps: HEDGE_COST_BPS,
          optimized, hedge,
          residualRisk: risk ? {
            worstLossUsd: risk.worstLossUsd, cvar95LossUsd: risk.cvar95LossUsd,
          } : null,
        },
      });
      this.lastMarkAt = now;
    }
  }

  async persistInstruments(rows) {
    await insertRows('borg_deribit_instruments', [
      'instrument_name', 'currency', 'option_type', 'strike', 'expiration_at',
      'contract_size', 'tick_size', 'maker_commission', 'taker_commission',
      'settlement_period', 'raw', 'refreshed_at',
    ], rows.map((row) => [
      row.instrumentName, row.currency, row.optionType, row.strike,
      new Date(row.expirationMs), row.contractSize, row.tickSize,
      row.makerCommission, row.takerCommission, row.settlementPeriod,
      JSON.stringify(row.raw), new Date(),
    ]), `ON CONFLICT (instrument_name) DO UPDATE SET
      strike=EXCLUDED.strike,expiration_at=EXCLUDED.expiration_at,
      contract_size=EXCLUDED.contract_size,tick_size=EXCLUDED.tick_size,
      maker_commission=EXCLUDED.maker_commission,taker_commission=EXCLUDED.taker_commission,
      settlement_period=EXCLUDED.settlement_period,raw=EXCLUDED.raw,
      refreshed_at=EXCLUDED.refreshed_at`);
  }

  async refreshUniverse() {
    const refreshAt = Date.now();
    const [instrumentPages, indexRows] = await Promise.all([
      Promise.all(CURRENCIES.map(fetchInstruments)),
      Promise.all(CURRENCIES.map(fetchIndexPrice)),
    ]);
    const rawInstruments = instrumentPages.flat();
    const listedExpiries = listedCallExpiries(rawInstruments, refreshAt);
    const thresholdEvents = await fetchThresholdEvents(listedExpiries, { bracketed: true });
    const surfaceTargets = selectSurfaceBracketedThresholds(thresholdEvents, rawInstruments, {
      nowMs: refreshAt,
      minTteMs: MIN_TTE_SEC * 1000,
      maxTteMs: MAX_TTE_SEC * 1000,
      currencies: CURRENCIES,
    });
    await persistExactExpiryTargets(surfaceTargets.records);
    this.exactExpirySummary = {
      universeVersion: surfaceTargets.universeVersion,
      queriedExpiries: listedExpiries.map((value) => new Date(value).toISOString()),
      fetchedEvents: thresholdEvents.length,
      records: surfaceTargets.records.length,
      exactExpiryRecords: surfaceTargets.records.filter((record) =>
        record.raw?._optionsSurfaceTarget?.surfaceMode === 'EXACT_EXPIRY').length,
      termInterpolatedRecords: surfaceTargets.records.filter((record) =>
        record.raw?._optionsSurfaceTarget?.surfaceMode === 'TERM_INTERPOLATED').length,
      rejected: surfaceTargets.rejected,
      listedExpiryCounts: Object.fromEntries(Object.entries(surfaceTargets.listedExpiries)
        .map(([currency, values]) => [currency, values.length])),
    };
    const targets = await loadTargets();
    const archiveTargets = buildArchiveTargets(new Map(indexRows), CURRENCIES, {
      horizonsHours: ARCHIVE_HORIZONS_HOURS,
    });
    const selection = selectSurfaceInstruments(rawInstruments, [...targets, ...archiveTargets], {
      maxInstruments: MAX_INSTRUMENTS, strikesPerSide: 2,
    });
    await this.persistInstruments(selection.instruments);
    this.targets = targets;
    this.archiveTargets = archiveTargets;
    this.targetByToken = new Map(targets.flatMap((target) => [
      [target.yesToken, target], [target.noToken, target],
    ]));
    this.instrumentByName = new Map(selection.instruments
      .map((row) => [row.instrumentName, row]));
    this.changeSubscriptions([...this.instrumentByName.keys()]);
    syncPolymarketSubscriptions(this.clob, this.targetByToken);
    if (this.networkStarted && this.targetByToken.size && !this.clobStarted) {
      this.clobStarted = true;
      await this.clob.connect();
    }
    await logEvent('INFO', 'options',
      `surface universe refreshed: ${targets.length} thresholds, ${selection.instruments.length} options, ${this.targetByToken.size} Polymarket tokens`, {
        runId: this.runId, experimentId: OPTIONS_EXPERIMENT_ID,
        currencies: CURRENCIES, archiveTargets,
        exactExpiry: this.exactExpirySummary, selection,
      });
  }

  flush() {
    // A one-second timer can fire again while PostgreSQL is slowed by hot-tier
    // maintenance. Concurrent ON CONFLICT batches containing the same sampled
    // keys deadlock each other inside the unique index. One in-flight flush,
    // plus deterministic key order, removes that cycle without putting SQL in
    // the market-data hot path.
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = this.flushBuffered()
      .finally(() => { this.flushPromise = null; });
    return this.flushPromise;
  }

  async flushBuffered() {
    const touches = [...this.touchBuffer.values()]
      .sort((left, right) => left.instrumentName.localeCompare(right.instrumentName)
        || left.sampleAt - right.sampleAt);
    const marks = [...this.markBuffer.values()]
      .sort((left, right) => left.dedupKey.localeCompare(right.dedupKey));
    this.touchBuffer.clear(); this.markBuffer.clear();
    try {
      // Coalesced shadow decisions are durable before PostgreSQL sees them.
      // Append exactly once even when the idempotent SQL batch is retried.
      for (const row of marks) {
        if (row[DECISION_WAL_APPENDED]) continue;
        this.decisionWal.append(JSON.stringify({
          type: 'options_shadow_mark', ...row,
        }), { channel: 'shadow-mark', receiveWallMs: row.observedAt });
        row[DECISION_WAL_APPENDED] = true;
      }

      await retryTransientDb(async () => {
        if (touches.length) await insertRows('borg_deribit_option_touch', [
          'sample_at', 'source_ts', 'received_at', 'receive_monotonic_ns',
          'instrument_name', 'currency', 'option_type', 'strike', 'expiration_at',
          'best_bid_price', 'best_ask_price', 'mark_price', 'bid_iv', 'ask_iv', 'mark_iv',
          'underlying_price', 'index_price', 'open_interest', 'delta', 'gamma', 'vega', 'theta',
          'connection_epoch', 'event_sequence', 'wal_event_id',
        ], touches.map((row) => [
          new Date(row.sampleAt), row.sourceMs == null ? null : new Date(row.sourceMs),
          new Date(row.receiveWallMs), row.receiveMonoNs, row.instrumentName,
          row.currency, row.optionType, row.strike, new Date(row.expirationMs),
          row.bestBidPrice, row.bestAskPrice, row.markPrice, row.bidIv, row.askIv,
          row.markIv, row.underlyingPrice, row.indexPrice, row.openInterest,
          row.delta, row.gamma, row.vega, row.theta, row.connectionEpoch,
          row.eventSequence, row.walEventId,
        ]), `ON CONFLICT (instrument_name,sample_at) DO UPDATE SET
          source_ts=EXCLUDED.source_ts,received_at=EXCLUDED.received_at,
          receive_monotonic_ns=EXCLUDED.receive_monotonic_ns,
          best_bid_price=EXCLUDED.best_bid_price,best_ask_price=EXCLUDED.best_ask_price,
          mark_price=EXCLUDED.mark_price,bid_iv=EXCLUDED.bid_iv,ask_iv=EXCLUDED.ask_iv,
          mark_iv=EXCLUDED.mark_iv,underlying_price=EXCLUDED.underlying_price,
          index_price=EXCLUDED.index_price,open_interest=EXCLUDED.open_interest,
          delta=EXCLUDED.delta,gamma=EXCLUDED.gamma,vega=EXCLUDED.vega,theta=EXCLUDED.theta,
          connection_epoch=EXCLUDED.connection_epoch,event_sequence=EXCLUDED.event_sequence,
          wal_event_id=EXCLUDED.wal_event_id`);
        if (marks.length) await insertRows('borg_option_shadow_marks', [
          'dedup_key', 'experiment_id', 'observed_at',
          'market_id', 'condition_id', 'asset', 'strike',
          'target_expiry_at', 'target_surface_mode',
          'lower_anchor_expiry_at', 'upper_anchor_expiry_at',
          'trigger_source', 'side', 'poly_ask', 'poly_ask_size',
          'model_fair', 'market_mid', 'surface_residual',
          'fair_lower', 'fair_upper', 'fee_rate', 'fee_per_share_2x',
          'edge_lower_2x', 'target_shares', 'expected_profit_lower_usd', 'hedge_base',
          'hedge_cost_stress_usd', 'net_edge_stress_usd', 'residual_cvar95_usd',
          'surface_fidelity', 'data_quality_grade', 'executable', 'detail',
        ], marks.map((row) => [
          row.dedupKey, OPTIONS_EXPERIMENT_ID, new Date(row.observedAt),
          row.marketId, row.conditionId,
          row.asset, row.strike, new Date(row.targetExpiryMs), row.targetSurfaceMode,
          row.lowerAnchorExpiryMs ? new Date(row.lowerAnchorExpiryMs) : null,
          row.upperAnchorExpiryMs ? new Date(row.upperAnchorExpiryMs) : null,
          row.triggerSource,
          row.side, row.polyAsk, row.polyAskSize, row.modelFair,
          row.marketMid, row.surfaceResidual, row.fairLower,
          row.fairUpper, row.feeRate, row.fee2x, row.edgeLower2x,
          row.targetShares, row.expectedProfitLowerUsd, row.hedgeBase,
          row.hedgeCostStressUsd, row.netEdgeStressUsd, row.residualCvar95Usd,
          row.surfaceFidelity, row.dataQualityGrade, row.executable,
          JSON.stringify(row.detail),
        ]), 'ON CONFLICT (dedup_key,observed_at) DO NOTHING');
      }, {
        onRetry: () => { this.metrics.flushRetries += 1; },
      });

      this.metrics.storedTouches += touches.length;
      if (marks.length) {
        this.metrics.shadowMarks += marks.length;
        for (const row of marks) {
          this.metrics.surfaceFidelity[row.surfaceFidelity] =
            (this.metrics.surfaceFidelity[row.surfaceFidelity] || 0) + 1;
          if (row.executable) this.metrics.executableMarks += 1;
          else {
            const barrier = row.detail?.executionBarrier || 'UNKNOWN';
            this.metrics.executionBarriers[barrier] =
              (this.metrics.executionBarriers[barrier] || 0) + 1;
          }
        }
      }
    } catch (error) {
      this.metrics.persistenceErrors += 1;
      // Preserve any newer coalesced row which arrived while SQL was blocked;
      // otherwise restore the failed batch for the next bounded retry cycle.
      for (const row of touches) {
        const key = `${row.instrumentName}:${row.sampleAt}`;
        if (!this.touchBuffer.has(key)) this.touchBuffer.set(key, row);
      }
      for (const row of marks) {
        if (!this.markBuffer.has(row.dedupKey)) this.markBuffer.set(row.dedupKey, row);
      }
      throw error;
    }
  }

  async heartbeat() {
    const metrics = {
      ...this.metrics,
      deribitWal: this.deribitWal.health(),
      polyWal: this.polyWal.health(),
      rtdsWal: this.rtdsWal.health(),
      decisionWal: this.decisionWal.health(),
      surfaceMaxAgeMs: SURFACE_MAX_AGE_MS,
      polyBookMaxAgeMs: POLY_BOOK_MAX_AGE_MS,
      dbSampleMs: DB_SAMPLE_MS,
      markSampleMs: MARK_SAMPLE_MS,
      executableMarkSampleMs: EXECUTABLE_MARK_SAMPLE_MS,
      targetBudgetUsd: TARGET_BUDGET_USD,
      archiveAnchors: this.archiveTargets,
      exactExpiry: this.exactExpirySummary,
      clobStarted: this.clobStarted,
    };
    await pool.query(`
      INSERT INTO borg_options_runtime (
        run_id,started_at,host,pid,paper_only,wallet_loaded,status,targets,
        subscribed_instruments,subscribed_poly_tokens,raw_frames,ticker_events,
        stored_touches,shadow_marks,persistence_queue,last_event_at,last_mark_at,metrics)
      VALUES ($1,$2,$3,$4,true,false,'RUNNING',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
      ON CONFLICT (run_id) DO UPDATE SET
        status='RUNNING',targets=EXCLUDED.targets,
        subscribed_instruments=EXCLUDED.subscribed_instruments,
        subscribed_poly_tokens=EXCLUDED.subscribed_poly_tokens,
        raw_frames=EXCLUDED.raw_frames,ticker_events=EXCLUDED.ticker_events,
        stored_touches=EXCLUDED.stored_touches,shadow_marks=EXCLUDED.shadow_marks,
        persistence_queue=EXCLUDED.persistence_queue,last_event_at=EXCLUDED.last_event_at,
        last_mark_at=EXCLUDED.last_mark_at,metrics=EXCLUDED.metrics,updated_at=now()
    `, [
      this.runId, this.startedAt, os.hostname(), process.pid, this.targets.length,
      this.instrumentByName.size, this.targetByToken.size, this.metrics.rawFrames,
      this.metrics.tickerEvents, this.metrics.storedTouches, this.metrics.shadowMarks,
      this.touchBuffer.size + this.markBuffer.size,
      this.lastEventAt ? new Date(this.lastEventAt) : null,
      this.lastMarkAt ? new Date(this.lastMarkAt) : null,
      JSON.stringify(metrics),
    ]);
    await pool.query(`
      INSERT INTO system_heartbeats (component,beat_at,meta)
      VALUES ('options_surface',now(),$1::jsonb)
      ON CONFLICT (component) DO UPDATE SET beat_at=now(),meta=EXCLUDED.meta
    `, [JSON.stringify({
      runId: this.runId, paperOnly: true, walletLoaded: false,
      processStartedAt: this.startedAt.toISOString(),
      collectionEpochId: process.env.BORG_COLLECTION_EPOCH_ID || 'options-unmarked',
      targets: this.targets.length, options: this.instrumentByName.size,
      archiveAnchors: this.archiveTargets.length,
      exactExpiry: this.exactExpirySummary,
      clobStarted: this.clobStarted,
      polyTokens: this.targetByToken.size, lastEventAt: this.lastEventAt || null,
      lastMarkAt: this.lastMarkAt || null,
      shadowMarks: this.metrics.shadowMarks,
      executableMarks: this.metrics.executableMarks,
      parseErrors: this.metrics.parseErrors,
      refreshErrors: this.metrics.refreshErrors,
      flushRetries: this.metrics.flushRetries,
      persistenceErrors: this.metrics.persistenceErrors,
      persistenceQueue: this.touchBuffer.size + this.markBuffer.size,
      surfaceFidelity: this.metrics.surfaceFidelity,
      executionBarriers: this.metrics.executionBarriers,
      wal: {
        deribit: this.deribitWal.health(), polymarket: this.polyWal.health(),
        chainlink: this.rtdsWal.health(), decisions: this.decisionWal.health(),
      },
    })]);
  }

  async start() {
    await migrateOptions();
    await this.refreshUniverse();
    this.networkStarted = true;
    const connections = [this.connectDeribit(), this.rtds.connect()];
    if (this.targetByToken.size) {
      this.clobStarted = true;
      connections.push(this.clob.connect());
    }
    await Promise.all(connections);
    await this.heartbeat();
    this.timers = [
      setInterval(() => this.flush().catch((error) => logEvent('ERROR', 'options', `flush: ${error.message}`)), 1000),
      setInterval(() => this.refreshUniverse().catch((error) => {
        this.metrics.refreshErrors += 1;
        return logEvent('ERROR', 'options', `refresh: ${error.message}`);
      }), REFRESH_MS),
      setInterval(() => this.heartbeat().catch((error) => logEvent('ERROR', 'options', `heartbeat: ${error.message}`)), 10_000),
      setInterval(() => {
        this.clob.checkStale(); this.rtds.checkStale();
        if (this.lastEventAt && Date.now() - this.lastEventAt > 30_000) {
          const dead = this.ws; this.ws = null;
          try { dead?.terminate(); } catch (_) {}
          this.scheduleReconnect();
        }
      }, 10_000),
      setInterval(() => this.clob.flushEvents().catch(() => {}), 5000),
    ];
    await logEvent('INFO', 'options', `paper option-surface observer running as ${this.runId}`);
  }

  async stop(signal) {
    if (this.closed) return;
    this.closed = true;
    (this.timers || []).forEach(clearInterval);
    clearTimeout(this.reconnectTimer);
    const socket = this.ws; this.ws = null;
    try { socket?.close(); } catch (_) {}
    this.clob.close(); this.rtds.close();
    // The socket is closed above, so two passes drain a batch that may have
    // accumulated while an already-running flush was completing.
    await this.flush().catch(() => {});
    if (this.touchBuffer.size || this.markBuffer.size) await this.flush().catch(() => {});
    await pool.query(`UPDATE borg_options_runtime SET status='STOPPED',stopped_at=now(),updated_at=now()
      WHERE run_id=$1`, [this.runId]).catch(() => {});
    await Promise.all([
      this.deribitWal.close(), this.polyWal.close(), this.rtdsWal.close(),
      this.decisionWal.close(),
    ]).catch(() => {});
    await pool.end().catch(() => {});
    console.log(`[options] stopped by ${signal}`);
  }
}

async function main() {
  const observer = new OptionsObserver();
  process.once('SIGTERM', () => observer.stop('SIGTERM').then(() => process.exit(0)));
  process.once('SIGINT', () => observer.stop('SIGINT').then(() => process.exit(0)));
  await observer.start();
}

if (require.main === module) main().catch(async (error) => {
  console.error(error.stack || error.message);
  await pool.end().catch(() => {});
  process.exit(1);
});

module.exports = {
  DB_SAMPLE_MS, EXECUTABLE_MARK_SAMPLE_MS, MARK_SAMPLE_MS,
  OptionsObserver, classifyExecutionBarrier, feeMetadata, fetchIndexPrice,
  fetchThresholdEvents, isRetryableDbError, listedCallExpiries, loadTargets,
  resolverFeed, retryTransientDb, syncPolymarketSubscriptions,
};
