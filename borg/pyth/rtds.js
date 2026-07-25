'use strict';

const WebSocket = require('ws');

const RTDS_URL = 'wss://ws-live-data.polymarket.com';
// Official equity_prices universe.  These are Pyth-backed finance symbols,
// not the separate crypto_prices / crypto_prices_chainlink topics.
const EQUITY_PRICE_SYMBOLS = new Set([
  'AAPL', 'TSLA', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'NFLX', 'PLTR',
  'OPEN', 'RKLB', 'ABNB', 'COIN', 'HOOD',
  'QQQ', 'SPY', 'EWY', 'VXX',
  'EURUSD', 'GBPUSD', 'USDCAD', 'USDJPY', 'USDKRW',
  'XAUUSD', 'XAGUSD', 'WTI', 'CC', 'NGD',
]);
const MARKET_TO_FEED_SYMBOL = Object.freeze({ NG: 'NGD' });
const FEED_TO_MARKET_SYMBOL = Object.freeze({ NGD: 'NG' });
// The public RTDS endpoint currently stops delivering live updates when more
// than 15 equity subscriptions are requested on one socket. Keep a hard bound
// here and let the collector prioritize markets whose resolver window is open.
const MAX_EQUITY_SUBSCRIPTIONS = 15;

function finite(value, fallback = null) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function epochMs(value) {
  const numeric = finite(value);
  if (numeric != null) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function feedSymbolForMarket(symbol) {
  const normalized = String(symbol || '').trim().toUpperCase();
  return MARKET_TO_FEED_SYMBOL[normalized] || normalized;
}

function marketSymbolForFeed(symbol) {
  const normalized = String(symbol || '').trim().toUpperCase();
  return FEED_TO_MARKET_SYMBOL[normalized] || normalized;
}

function isSupportedMarketSymbol(symbol) {
  return EQUITY_PRICE_SYMBOLS.has(feedSymbolForMarket(symbol));
}

function boundedMarketSymbols(symbols) {
  const selected = [];
  const seen = new Set();
  for (const value of symbols || []) {
    const symbol = String(value || '').trim().toUpperCase();
    if (!symbol || seen.has(symbol) || !isSupportedMarketSymbol(symbol)) continue;
    seen.add(symbol);
    selected.push(symbol);
    if (selected.length >= MAX_EQUITY_SUBSCRIPTIONS) break;
  }
  return selected;
}

function normalizeUpdate(row, historical, envelope = {}) {
  if (!row || typeof row !== 'object') return null;
  const { symbolFallback = null, ...provenance } = envelope;
  const symbol = marketSymbolForFeed(row.symbol || row.ticker || symbolFallback);
  const value = finite(row.full_accuracy_value ?? row.fullAccuracyValue ?? row.value ?? row.price);
  if (!symbol || !(value > 0)) return null;
  return {
    symbol,
    value,
    sourceMs: epochMs(row.timestamp ?? row.source_timestamp ?? row.sourceTimestamp),
    providerReceivedMs: epochMs(row.received_at ?? row.receivedAt),
    carriedForward: row.is_carried_forward === true || row.isCarriedForward === true,
    historical,
    raw: row,
    ...provenance,
  };
}

/** Parse both RTDS equity_prices snapshots and live updates. */
function parseFrame(raw, envelope = {}) {
  let message;
  try {
    message = raw && typeof raw === 'object' && !Buffer.isBuffer(raw)
      ? raw : JSON.parse(typeof raw === 'string' ? raw : raw.toString());
  }
  catch (_) { return []; }
  const topic = String(message?.topic || message?.channel || '');
  if (topic && topic !== 'equity_prices') return [];
  const payload = message?.data ?? message?.payload ?? message;
  const messageType = String(message?.type || message?.event || '').toLowerCase();
  const payloadType = String(payload?.type || '').toLowerCase();
  // RTDS sends the initial history as type=subscribe with the symbol on the
  // parent payload and [{timestamp,value}] children.  It is historical state,
  // never a live trigger.
  const explicitSnapshot = messageType === 'snapshot' || messageType === 'subscribe'
    || payloadType === 'snapshot' || payloadType === 'subscribe';
  const symbolFallback = payload?.symbol || payload?.ticker || message?.symbol || message?.ticker;
  const rows = Array.isArray(payload) ? payload
    : Array.isArray(payload?.data) ? payload.data
      : Array.isArray(payload?.history) ? payload.history
        : Array.isArray(payload?.prices) ? payload.prices
          : [payload];
  return rows.map((row) => normalizeUpdate(row, explicitSnapshot || rows.length > 1, {
    ...envelope, symbolFallback,
  }))
    .filter(Boolean);
}

class PythRtds {
  constructor(options = {}) {
    this.url = options.url || RTDS_URL;
    this.symbols = new Set(boundedMarketSymbols(options.symbols));
    this.wal = options.wal || null;
    this.onTick = options.onTick || (() => {});
    this.onStatus = options.onStatus || (() => {});
    this.ws = null;
    this.connectionEpoch = 0;
    this.closed = false;
    this.reconnectDelay = 1000;
    this.reconnectTimer = null;
    this.keepaliveTimer = null;
    this.lastMessageAt = 0;
    this.lastPongAt = 0;
    this.lastPingAt = 0;
    this.awaitingPongSince = 0;
    this.latest = new Map();
    this.metrics = {
      rawFrames: 0, ticks: 0, historicalTicks: 0, parseErrors: 0,
      controlFrames: 0, textPings: 0, protocolPings: 0, protocolPongs: 0,
    };
  }

  setSymbols(symbols) {
    const next = new Set(boundedMarketSymbols(symbols));
    const changed = next.size !== this.symbols.size || [...next].some((value) => !this.symbols.has(value));
    this.symbols = next;
    if (changed && this.ws?.readyState === WebSocket.OPEN) {
      // Reconnect so a changed bounded set replaces the prior subscription;
      // repeated subscribe messages on this endpoint are not reliably additive.
      const socket = this.ws;
      this.ws = null;
      this.stopKeepalive();
      try { socket.close(); } catch (_) {}
      this.scheduleReconnect();
    }
  }

  subscribe() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // RTDS accepts multiple subscriptions in one request. Sending one request
    // per symbol in a tight loop can leave the socket connected but with only
    // empty acknowledgement frames, so make each desired symbol part of one
    // atomic subscription message.
    const subscriptions = [...this.symbols]
      .map(feedSymbolForMarket)
      .filter((symbol) => EQUITY_PRICE_SYMBOLS.has(symbol))
      .map((symbol) => ({
        topic: 'equity_prices', type: '*', filters: JSON.stringify({ symbol }),
      }));
    if (!subscriptions.length) return;
    this.ws.send(JSON.stringify({ action: 'subscribe', subscriptions }));
  }

  startKeepalive(socket) {
    this.stopKeepalive();
    // RTDS documents a text PING every five seconds.  A WebSocket control
    // ping additionally detects a half-open TCP path without confusing a
    // quiet/closed underlying market with a dead transport.
    this.keepaliveTimer = setInterval(() => {
      if (socket !== this.ws || socket.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      if (this.awaitingPongSince && now - this.awaitingPongSince > 15_000) {
        try { socket.terminate(); } catch (_) {}
        return;
      }
      try {
        socket.send('PING');
        this.metrics.textPings += 1;
        socket.ping();
        this.metrics.protocolPings += 1;
        this.lastPingAt = now;
        if (!this.awaitingPongSince) this.awaitingPongSince = now;
      } catch (_) {
        try { socket.terminate(); } catch (_) {}
      }
    }, 5_000);
    this.keepaliveTimer.unref?.();
  }

  stopKeepalive() {
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  connect() {
    return new Promise((resolve) => {
      let socket;
      try { socket = new WebSocket(this.url); } catch (_) { this.scheduleReconnect(); resolve(false); return; }
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
        this.lastMessageAt = Date.now();
        this.lastPongAt = Date.now();
        this.awaitingPongSince = 0;
        this.subscribe();
        this.startKeepalive(socket);
        this.onStatus('OPEN', { connectionEpoch: this.connectionEpoch });
        resolve(true);
      });
      socket.on('message', (raw) => { if (socket === this.ws) this.onMessage(raw); });
      socket.on('pong', () => {
        if (socket !== this.ws) return;
        this.lastPongAt = Date.now();
        this.awaitingPongSince = 0;
        this.metrics.protocolPongs += 1;
      });
      socket.on('close', () => {
        clearTimeout(timeout);
        if (socket !== this.ws || this.closed) return;
        this.stopKeepalive();
        this.onStatus('CLOSED', { connectionEpoch: this.connectionEpoch });
        this.scheduleReconnect();
      });
      socket.on('error', () => { /* close follows */ });
    });
  }

  onMessage(raw) {
    const receiveWallMs = Date.now();
    const receiveMonoNs = process.hrtime.bigint().toString();
    const provenance = this.wal?.append(raw, {
      channel: 'equity_prices', receiveWallMs, receiveMonoNs,
      connectionEpoch: this.connectionEpoch,
    }) || { event_sequence: null, event_id: null };
    this.metrics.rawFrames += 1;
    this.lastMessageAt = receiveWallMs;
    const rawText = raw?.toString?.().trim?.() || '';
    if (!rawText || rawText.toUpperCase() === 'PONG') {
      this.metrics.controlFrames += 1;
      return;
    }
    let message;
    try { message = JSON.parse(rawText); }
    catch (_) {
      this.metrics.parseErrors += 1;
      return;
    }
    const rows = parseFrame(message, {
      receiveWallMs, receiveMonoNs, connectionEpoch: this.connectionEpoch,
      eventSequence: provenance.event_sequence, walEventId: provenance.event_id,
    });
    if (!rows.length) this.metrics.controlFrames += 1;
    for (const row of rows) {
      if (!this.symbols.has(row.symbol)) continue;
      this.metrics.ticks += 1;
      if (row.historical) this.metrics.historicalTicks += 1;
      if (!row.historical) this.latest.set(row.symbol, row);
      this.onTick(row);
    }
  }

  scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(30_000, delay * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().then((ok) => { if (!ok) this.scheduleReconnect(); })
        .catch(() => this.scheduleReconnect());
    }, delay);
  }

  checkStale() {
    if (this.ws && this.ws.readyState !== WebSocket.OPEN
        && this.ws.readyState !== WebSocket.CONNECTING) {
      const socket = this.ws;
      this.ws = null;
      this.stopKeepalive();
      try { socket?.terminate(); } catch (_) {}
      this.scheduleReconnect();
    }
  }

  health() {
    return {
      connected: this.ws?.readyState === WebSocket.OPEN,
      connectionEpoch: this.connectionEpoch,
      lastMessageAt: this.lastMessageAt || null,
      lastPongAt: this.lastPongAt || null,
      symbols: [...this.symbols],
      feedSymbols: [...this.symbols].map(feedSymbolForMarket),
      metrics: { ...this.metrics },
    };
  }

  close() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.stopKeepalive();
    const socket = this.ws;
    this.ws = null;
    try { socket?.close(); } catch (_) {}
  }
}

module.exports = {
  boundedMarketSymbols, EQUITY_PRICE_SYMBOLS, MAX_EQUITY_SUBSCRIPTIONS, PythRtds,
  RTDS_URL, epochMs, feedSymbolForMarket, finite, isSupportedMarketSymbol,
  marketSymbolForFeed, normalizeUpdate, parseFrame,
};
