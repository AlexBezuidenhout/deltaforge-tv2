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
const { buildArchiveTargets, selectSurfaceInstruments } = require('./surface-universe');

const DERIBIT_HTTP = 'https://www.deribit.com/api/v2';
const DERIBIT_WS = 'wss://www.deribit.com/ws/api/v2';
const CURRENCIES = String(process.env.OPTIONS_CURRENCIES || 'BTC,ETH')
  .split(',').map((value) => value.trim().toUpperCase()).filter(Boolean);
const REFRESH_MS = Math.max(60_000, Number(process.env.OPTIONS_REFRESH_MS || 300_000));
const DB_SAMPLE_MS = Math.max(250, Number(process.env.OPTIONS_DB_SAMPLE_MS || 1000));
const MARK_SAMPLE_MS = Math.max(100, Number(process.env.OPTIONS_MARK_SAMPLE_MS || 1000));
const MAX_INSTRUMENTS = Math.max(8, Number(process.env.OPTIONS_MAX_INSTRUMENTS || 160));
const TARGET_BUDGET_USD = Math.max(1, Number(process.env.OPTIONS_TARGET_BUDGET_USD || 10));
const HEDGE_COST_BPS = Math.max(0, Number(process.env.OPTIONS_HEDGE_COST_BPS || 5));
const RESOLVER_UNCERTAINTY_BPS = Math.max(0,
  Number(process.env.OPTIONS_RESOLVER_UNCERTAINTY_BPS || 3));
const MIN_TTE_SEC = Math.max(30, Number(process.env.OPTIONS_MIN_TTE_SEC || 300));
const MAX_TTE_SEC = Math.max(MIN_TTE_SEC, Number(process.env.OPTIONS_MAX_TTE_SEC || 604800));
const SURFACE_MAX_AGE_MS = Math.max(500, Number(process.env.OPTIONS_SURFACE_MAX_AGE_MS || 3000));
const POLY_BOOK_MAX_AGE_MS = Math.max(100, Number(process.env.OPTIONS_POLY_BOOK_MAX_AGE_MS || 500));
const ARCHIVE_HORIZONS_HOURS = Object.freeze([24, 168]);

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

function classifyExecutionBarrier({
  valuation, optimized, freshBook, book, bookAgeMs, chainlinkAgeMs,
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
  if (!(chainlinkAgeMs != null && chainlinkAgeMs <= 3000)) return 'CHAINLINK_PRICE_STALE';
  if (!feesKnown) return 'UNKNOWN_POLYMARKET_FEE_SCHEDULE';
  if (!(minimumOrderSize > 0)) return 'UNKNOWN_VENUE_MINIMUM_SIZE';
  if (!optimized) return 'NO_POSITIVE_DEPTH_WALK_AFTER_2X_COSTS';
  return null;
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

async function loadTargets() {
  const { rows } = await pool.query(`
    SELECT id,condition_id,slug,asset,strike,window_end,up_token_id,down_token_id,raw
      FROM borg_markets
     WHERE market_type='threshold_daily'
       AND lower(asset)=ANY($1::text[])
       AND accepting_orders IS NOT FALSE
       AND strike IS NOT NULL
       AND window_end > now() + ($2::int * interval '1 second')
       AND window_end <= now() + ($3::int * interval '1 second')
     ORDER BY window_end,asset,strike
  `, [CURRENCIES.map((value) => value.toLowerCase()), MIN_TTE_SEC, MAX_TTE_SEC]);
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
      minimumOrderSize: finite(raw.orderMinSize ?? raw.minimum_order_size
        ?? raw.min_order_size),
      fees,
    };
  }).filter((row) => Number.isSafeInteger(row.id) && row.strike > 1
    && row.targetExpiryMs > Date.now() && row.yesToken && row.noToken);
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
    this.targetByToken = new Map();
    this.instrumentByName = new Map();
    this.subscribed = new Set();
    this.latestTick = new Map();
    this.touchBuffer = new Map();
    this.markBuffer = new Map();
    this.lastEventAt = 0;
    this.lastMarkAt = 0;
    this.metrics = {
      rawFrames: 0, tickerEvents: 0, storedTouches: 0, shadowMarks: 0,
      parseErrors: 0, refreshErrors: 0, clobTriggers: 0, deribitTriggers: 0,
      executableMarks: 0, executionBarriers: {}, surfaceFidelity: {},
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
    const chainlink = this.rtds.getPrice(target.asset, 3000, 'chainlink');
    const chainlinkAgeMs = this.rtds.getAgeMs(target.asset, 'chainlink');
    if (!(chainlink > 1)) return;
    const basisCenterBps = (chainlink / spot - 1) * 10_000;
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
      spot: chainlink, strike: target.strike, annualizedVol: valuation.surface.markIv,
      secondsToExpiry: tteSec,
    });
    if (!midpointFair) return;
    for (const side of ['YES', 'NO']) {
      const token = side === 'YES' ? target.yesToken : target.noToken;
      const book = this.clob.getBook(token);
      const ask = finite(book?.asks?.[0]?.[0]);
      const askSize = finite(book?.asks?.[0]?.[1]);
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
        tokenShares: optimized.shares, outcome: side, spot: chainlink,
        strike: target.strike, annualizedVol: valuation.surface.markIv,
        secondsToExpiry: tteSec, hedgeBase: hedge.hedgeBase,
      }) : null;
      const fullSurface = ['A', 'B'].includes(valuation.fidelity);
      const freshBook = bookAgeMs != null && bookAgeMs <= POLY_BOOK_MAX_AGE_MS;
      const executable = Boolean(optimized && fullSurface && freshBook
        && chainlinkAgeMs != null && chainlinkAgeMs <= 3000 && target.fees.known);
      const executionBarrier = classifyExecutionBarrier({
        valuation, optimized, freshBook, book, bookAgeMs, chainlinkAgeMs,
        feesKnown: target.fees.known, minimumOrderSize,
      });
      const grade = executable ? 'A' : valuation.fidelity === 'D' || !target.fees.known
        ? 'D' : freshBook ? 'B' : 'C';
      const bucket = Math.floor(now / MARK_SAMPLE_MS) * MARK_SAMPLE_MS;
      const dedupKey = `${this.runId}:${target.id}:${side}:${bucket}`;
      this.markBuffer.set(dedupKey, {
        dedupKey, observedAt: now, marketId: target.id,
        conditionId: target.conditionId, asset: target.asset, strike: target.strike,
        targetExpiryMs: target.targetExpiryMs, triggerSource, side,
        polyAsk: ask, polyAskSize: askSize, modelFair: fair,
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
          runId: this.runId, paperOnly: true, walletLoaded: false,
          tteSec, spot, chainlink, chainlinkAgeMs, basisCenterBps,
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
    const [targets, instrumentPages, indexRows] = await Promise.all([
      loadTargets(), Promise.all(CURRENCIES.map(fetchInstruments)),
      Promise.all(CURRENCIES.map(fetchIndexPrice)),
    ]);
    const archiveTargets = buildArchiveTargets(new Map(indexRows), CURRENCIES, {
      horizonsHours: ARCHIVE_HORIZONS_HOURS,
    });
    const selection = selectSurfaceInstruments(instrumentPages.flat(), [...targets, ...archiveTargets], {
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
    if (this.networkStarted && this.targetByToken.size && !this.clobStarted) {
      this.clobStarted = true;
      await this.clob.connect();
    }
    if (this.clobStarted) this.clob.subscribe([...this.targetByToken.keys()]);
    await logEvent('INFO', 'options',
      `surface universe refreshed: ${targets.length} thresholds, ${selection.instruments.length} options, ${this.targetByToken.size} Polymarket tokens`, {
        runId: this.runId, currencies: CURRENCIES, archiveTargets, selection,
      });
  }

  async flush() {
    const touches = [...this.touchBuffer.values()];
    const marks = [...this.markBuffer.values()];
    this.touchBuffer.clear(); this.markBuffer.clear();
    try {
      if (touches.length) {
        await insertRows('borg_deribit_option_touch', [
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
        this.metrics.storedTouches += touches.length;
      }
      if (marks.length) {
        // Coalesced shadow decisions are durable before PostgreSQL sees them.
        // Raw venue events remain sufficient to reconstruct the unsampled
        // path; this WAL is the immutable record of the actual sampled policy.
        for (const row of marks) this.decisionWal.append(JSON.stringify({
          type: 'options_shadow_mark', ...row,
        }), { channel: 'shadow-mark', receiveWallMs: row.observedAt });
        await insertRows('borg_option_shadow_marks', [
          'dedup_key', 'observed_at', 'market_id', 'condition_id', 'asset', 'strike',
          'target_expiry_at', 'trigger_source', 'side', 'poly_ask', 'poly_ask_size',
          'model_fair', 'fair_lower', 'fair_upper', 'fee_rate', 'fee_per_share_2x',
          'edge_lower_2x', 'target_shares', 'expected_profit_lower_usd', 'hedge_base',
          'hedge_cost_stress_usd', 'net_edge_stress_usd', 'residual_cvar95_usd',
          'surface_fidelity', 'data_quality_grade', 'executable', 'detail',
        ], marks.map((row) => [
          row.dedupKey, new Date(row.observedAt), row.marketId, row.conditionId,
          row.asset, row.strike, new Date(row.targetExpiryMs), row.triggerSource,
          row.side, row.polyAsk, row.polyAskSize, row.modelFair, row.fairLower,
          row.fairUpper, row.feeRate, row.fee2x, row.edgeLower2x,
          row.targetShares, row.expectedProfitLowerUsd, row.hedgeBase,
          row.hedgeCostStressUsd, row.netEdgeStressUsd, row.residualCvar95Usd,
          row.surfaceFidelity, row.dataQualityGrade, row.executable,
          JSON.stringify(row.detail),
        ]), 'ON CONFLICT (dedup_key) DO NOTHING');
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
      for (const row of touches) this.touchBuffer.set(`${row.instrumentName}:${row.sampleAt}`, row);
      for (const row of marks) this.markBuffer.set(row.dedupKey, row);
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
      targetBudgetUsd: TARGET_BUDGET_USD,
      archiveAnchors: this.archiveTargets,
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
      targets: this.targets.length, options: this.instrumentByName.size,
      archiveAnchors: this.archiveTargets.length,
      clobStarted: this.clobStarted,
      polyTokens: this.targetByToken.size, lastEventAt: this.lastEventAt || null,
      lastMarkAt: this.lastMarkAt || null,
      shadowMarks: this.metrics.shadowMarks,
      executableMarks: this.metrics.executableMarks,
      surfaceFidelity: this.metrics.surfaceFidelity,
      executionBarriers: this.metrics.executionBarriers,
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
    await this.flush().catch(() => {});
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
  OptionsObserver, classifyExecutionBarrier, feeMetadata, fetchIndexPrice, loadTargets,
};
