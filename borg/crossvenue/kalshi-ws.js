'use strict';

/**
 * Authenticated, market-data-only Kalshi WebSocket adapter.
 *
 * The authentication key is used solely for the WebSocket handshake. This
 * module exposes no order, portfolio, cancel, or mutation method. Every raw
 * frame is appended to the caller's WAL before the in-memory book is changed.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const WebSocket = require('ws');
const { normalizeKalshiBook } = require('./strategy');

const WS_PATH = '/trade-api/ws/v2';
const DEFAULT_URL = 'wss://external-api-ws.kalshi.com/trade-api/ws/v2';

function finite(value, fallback = null) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function signHandshake(timestamp, keyPem) {
  return crypto.sign('sha256', Buffer.from(`${timestamp}GET${WS_PATH}`), {
    key: keyPem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString('base64');
}

function setLevel(levels, price, delta) {
  const parsedPrice = finite(price);
  const parsedDelta = finite(delta);
  if (!(parsedPrice > 0 && parsedPrice < 1) || parsedDelta == null) return false;
  const current = levels.get(parsedPrice) || 0;
  const next = current + parsedDelta;
  if (next > 1e-9) levels.set(parsedPrice, next);
  else levels.delete(parsedPrice);
  return true;
}

function levelsMap(rows) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const price = finite(row?.[0]);
    const size = finite(row?.[1]);
    if (price > 0 && price < 1 && size > 0) map.set(price, size);
  }
  return map;
}

function normalizedBooks(state) {
  return normalizeKalshiBook({ orderbook_fp: {
    yes_dollars: [...state.yes.entries()],
    no_dollars: [...state.no.entries()],
  } });
}

class KalshiReadOnlyFeed {
  constructor(options = {}) {
    this.keyId = options.keyId || process.env.KALSHI_READONLY_KEY_ID || null;
    this.keyPath = options.keyPath || process.env.KALSHI_READONLY_KEY_PATH || null;
    this.url = options.url || process.env.KALSHI_READONLY_WS_URL || DEFAULT_URL;
    this.wal = options.wal || null;
    this.onBook = typeof options.onBook === 'function' ? options.onBook : () => {};
    this.onError = typeof options.onError === 'function' ? options.onError : () => {};
    this.tickers = new Set();
    this.books = new Map();
    this.sequenceBySid = new Map();
    this.socket = null;
    this.closed = false;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.reconnectAttempt = 0;
    this.requestId = 1;
    this.lastMessageAt = 0;
    this.metrics = {
      connections: 0, reconnects: 0, messages: 0, snapshots: 0,
      deltas: 0, sequenceGaps: 0, parseErrors: 0, lastError: null,
    };
  }

  configured() {
    return Boolean(this.keyId && this.keyPath && fs.existsSync(this.keyPath));
  }

  transport() {
    return this.configured() ? 'authenticated_readonly_ws' : 'public_batch_rest';
  }

  setTickers(tickers) {
    const next = new Set((tickers || []).map(String).filter(Boolean));
    const changed = next.size !== this.tickers.size || [...next].some((ticker) => !this.tickers.has(ticker));
    this.tickers = next;
    for (const ticker of this.books.keys()) if (!next.has(ticker)) this.books.delete(ticker);
    if (changed && this.socket) this.reconnect('ticker_set_changed');
  }

  connect(tickers = null) {
    if (tickers) this.setTickers(tickers);
    this.closed = false;
    if (!this.configured() || !this.tickers.size || this.socket) return false;
    let keyPem;
    try { keyPem = fs.readFileSync(this.keyPath); } catch (error) {
      this.fail(error); return false;
    }
    const timestamp = String(Date.now());
    let signature;
    try { signature = signHandshake(timestamp, keyPem); } catch (error) {
      this.fail(error); return false;
    }
    const socket = new WebSocket(this.url, {
      headers: {
        'KALSHI-ACCESS-KEY': this.keyId,
        'KALSHI-ACCESS-SIGNATURE': signature,
        'KALSHI-ACCESS-TIMESTAMP': timestamp,
      },
    });
    this.socket = socket;
    socket.isAlive = true;
    socket.on('open', () => {
      this.metrics.connections += 1;
      this.reconnectAttempt = 0;
      this.sequenceBySid.clear();
      this.books.clear();
      socket.send(JSON.stringify({
        id: this.requestId++, cmd: 'subscribe',
        params: { channels: ['orderbook_delta'], market_tickers: [...this.tickers] },
      }));
      this.startPing();
    });
    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('message', (raw) => this.handleFrame(raw));
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      this.stopPing();
      if (!this.closed) this.scheduleReconnect();
    });
    return true;
  }

  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (!socket.isAlive) { socket.terminate(); return; }
      socket.isAlive = false;
      socket.ping();
    }, 15_000);
  }

  stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.closed || !this.configured() || !this.tickers.size) return;
    const delay = Math.min(30_000, 500 * Math.pow(2, this.reconnectAttempt++));
    this.metrics.reconnects += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  reconnect() {
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.terminate();
    this.scheduleReconnect();
  }

  fail(error) {
    this.metrics.lastError = error?.message || String(error);
    this.onError(error instanceof Error ? error : new Error(String(error)));
  }

  handleFrame(rawFrame) {
    const receivedAt = Date.now();
    const raw = Buffer.isBuffer(rawFrame) ? rawFrame.toString('utf8') : String(rawFrame);
    let frame;
    try { frame = JSON.parse(raw); } catch (error) {
      this.metrics.parseErrors += 1; this.fail(error); return;
    }
    const sourceMs = finite(frame?.msg?.ts_ms);
    const provenance = this.wal?.append(raw, {
      channel: frame.type || 'unknown', sourceMs: sourceMs || receivedAt,
      receiveWallMs: receivedAt, receiveMonoNs: process.hrtime.bigint().toString(),
      connectionEpoch: this.metrics.connections,
    }) || {};
    this.lastMessageAt = receivedAt;
    this.metrics.messages += 1;
    if (frame.type === 'error') {
      this.fail(new Error(`Kalshi WS ${frame?.msg?.code || ''}: ${frame?.msg?.msg || 'unknown error'}`));
      return;
    }
    if (!['orderbook_snapshot', 'orderbook_delta'].includes(frame.type)) return;
    const ticker = String(frame?.msg?.market_ticker || '');
    const sid = String(frame.sid ?? '');
    const sequence = finite(frame.seq);
    if (!ticker || !sid || sequence == null || !this.tickers.has(ticker)) return;
    const previous = this.sequenceBySid.get(sid);
    if (frame.type === 'orderbook_delta' && previous != null && sequence !== previous + 1) {
      this.metrics.sequenceGaps += 1;
      this.books.delete(ticker);
      this.reconnect('sequence_gap');
      return;
    }
    this.sequenceBySid.set(sid, sequence);
    if (frame.type === 'orderbook_snapshot') {
      this.books.set(ticker, {
        yes: levelsMap(frame.msg.yes_dollars_fp || frame.msg.yes_dollars),
        no: levelsMap(frame.msg.no_dollars_fp || frame.msg.no_dollars),
      });
      this.metrics.snapshots += 1;
    } else {
      const state = this.books.get(ticker);
      if (!state) { this.metrics.sequenceGaps += 1; this.reconnect('delta_before_snapshot'); return; }
      const side = String(frame.msg.side || '').toLowerCase();
      const levels = side === 'yes' ? state.yes : side === 'no' ? state.no : null;
      if (!levels || !setLevel(levels, frame.msg.price_dollars, frame.msg.delta_fp ?? frame.msg.delta)) return;
      this.metrics.deltas += 1;
    }
    const state = this.books.get(ticker);
    if (!state) return;
    this.onBook({
      ticker,
      books: normalizedBooks(state),
      receivedAt,
      sourceMs,
      latencyMs: sourceMs == null ? null : Math.max(0, receivedAt - sourceMs),
      walEventId: provenance.event_id || null,
      sequence,
      transport: 'authenticated_readonly_ws',
    });
  }

  healthy(staleMs = 5000) {
    return this.configured() && this.socket?.readyState === WebSocket.OPEN
      && this.lastMessageAt > 0 && Date.now() - this.lastMessageAt <= staleMs;
  }

  health() {
    return {
      configured: this.configured(), connected: this.socket?.readyState === WebSocket.OPEN,
      healthy: this.healthy(), tickers: this.tickers.size, books: this.books.size,
      lastMessageAt: this.lastMessageAt || null, transport: this.transport(), ...this.metrics,
    };
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopPing();
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.terminate();
  }
}

module.exports = {
  DEFAULT_URL,
  KalshiReadOnlyFeed,
  WS_PATH,
  levelsMap,
  normalizedBooks,
  setLevel,
  signHandshake,
};
