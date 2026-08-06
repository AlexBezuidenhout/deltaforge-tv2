/**
 * Polymarket Real-Time Data Socket (RTDS) crypto reference feeds.
 *
 * Chainlink is resolver-risk telemetry. The parallel Binance topic is a
 * separately transported copy of Binance prices used to measure network-path
 * latency; it is not treated as an independent economic venue. Every raw frame
 * is WAL'd before parsing; extracted rows retain source and local clocks.
 */
'use strict';

const WebSocket = require('ws');

const WS_URL = 'wss://ws-live-data.polymarket.com';
// RTDS publishes more symbols than the four originally documented by
// Polymarket. Keep the default explicit and auditable, but do not use it as a
// parser allow-list: the collector's asset_config is the authority. This lets
// newly observed resolver symbols be captured without pretending that an
// unrelated symbol is a configured trading asset.
const DEFAULT_ASSETS = Object.freeze([
  'btc', 'eth', 'sol', 'xrp', 'bnb', 'doge', 'hype', 'zec',
]);
const ASSET_ALIASES = Object.freeze({
  bitcoin: 'btc',
  ethereum: 'eth',
  solana: 'sol',
  ripple: 'xrp',
  dogecoin: 'doge',
  binancecoin: 'bnb',
  hyperliquid: 'hype',
  zcash: 'zec',
});
const HISTORY_RETENTION_MS = 20 * 60 * 1000;

function epochMs(value) {
  if (value == null) return null;
  const n = Number(value);
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeAsset(symbol, allowedAssets = DEFAULT_ASSETS) {
  const value = String(symbol || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!value) return null;
  const allowed = new Set(Array.from(allowedAssets || []).map((asset) =>
    String(asset || '').toLowerCase()).filter(Boolean));
  for (const [name, asset] of Object.entries(ASSET_ALIASES)) {
    if (value.startsWith(name) && allowed.has(asset)) return asset;
  }
  return [...allowed]
    .sort((left, right) => right.length - left.length)
    .find((asset) => value === asset || value.startsWith(`${asset}usd`)) || null;
}

/**
 * A quote is only fresh when both its transport arrival and source timestamp
 * are fresh. Receive-only checks silently bless delayed/replayed resolver
 * frames after a reconnect, which is exactly when boundary strategies are
 * most exposed to false evidence.
 */
function tickAgeMs(tick, now = Date.now()) {
  if (!tick || !Number.isFinite(Number(tick.receiveWallMs)) ||
      !Number.isFinite(Number(tick.sourceMs))) return Infinity;
  const receiveAge = Math.max(0, now - Number(tick.receiveWallMs));
  const sourceAge = Math.max(0, now - Number(tick.sourceMs));
  return Math.max(receiveAge, sourceAge);
}

class RtdsRecon {
  constructor(onGap, options = {}) {
    this.onGap = onGap || (() => {});
    this.wal = options.wal || null;
    this.onMarketEvent = options.onMarketEvent || (() => {});
    this.onConnectionGap = options.onConnectionGap || (() => {});
    this.transportPath = Number.isInteger(options.transportPath) ? options.transportPath : 0;
    this.assets = new Set((options.assets || DEFAULT_ASSETS)
      .map((asset) => String(asset || '').toLowerCase().trim())
      .filter(Boolean));
    this.ws = null;
    this.lastFrameAt = 0;
    // Backward-compatible name: this is now the last accepted economic data
    // tick, not merely the last PONG/control frame.
    this.lastMsgAt = 0;
    this.connectionEpoch = 0;
    this.connectionGaps = 0;
    this.lastConnectionGapAt = null;
    this.frameSequence = 0;
    this.frameCount = 0;
    this.frameBytes = 0;
    this.startedAt = Date.now();
    this.latest = new Map();
    this.history = new Map();
    this.rows = [];
    this._closed = false;
    this._reconnectDelay = 1000;
    this._reconnectTimer = null;
    this._pingTimer = null;
  }

  connect() {
    if (!this.assets.size) return Promise.resolve(true);
    return new Promise((resolve) => {
      let ws;
      try {
        ws = new WebSocket(WS_URL);
      } catch (err) {
        this.onGap('rtds', `ws construct failed: ${err.message}`);
        this._scheduleReconnect();
        return resolve(false);
      }
      this.ws = ws;
      const timeout = setTimeout(() => {
        try { ws.terminate(); } catch (_) {}
        resolve(false);
      }, 15000);
      ws.on('open', () => {
        if (ws !== this.ws) return;
        clearTimeout(timeout);
        this._reconnectDelay = 1000;
        this.connectionEpoch += 1;
        this.frameSequence = 0;
        this.lastFrameAt = Date.now();
        this.lastMsgAt = 0;
        ws.send(JSON.stringify({
          action: 'subscribe',
          subscriptions: [
            { topic: 'crypto_prices_chainlink', type: '*', filters: '' },
            { topic: 'crypto_prices', type: 'update' },
          ],
        }));
        this._pingTimer = setInterval(() => {
          this._sendHeartbeat(ws);
        }, 5000);
        resolve(true);
      });
      ws.on('message', (raw) => { if (ws === this.ws) this._onMessage(raw); });
      ws.on('close', (code, reason) => {
        clearTimeout(timeout);
        clearInterval(this._pingTimer);
        if (this._closed || ws !== this.ws) return;
        const detail = {
          reason: 'ws_close',
          code,
          closeReason: reason?.toString() || null,
          lastDataAgeMs: this.lastMsgAt ? Date.now() - this.lastMsgAt : null,
          lastFrameAgeMs: this.lastFrameAt ? Date.now() - this.lastFrameAt : null,
        };
        this._recordConnectionGap(detail);
        this.onGap('rtds', `RTDS socket closed (${code}) — reconnecting`);
        this._scheduleReconnect();
      });
      ws.on('error', () => { /* close follows */ });
    });
  }

  _scheduleReconnect() {
    if (this._closed || this._reconnectTimer) return;
    const delay = this._reconnectDelay;
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, 30000);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect().then((ok) => { if (!ok) this._scheduleReconnect(); }).catch(() => this._scheduleReconnect());
    }, delay);
  }

  _sendHeartbeat(socket) {
    if (this.ws !== socket || socket?.readyState !== WebSocket.OPEN) return false;
    // RTDS is a different protocol from the CLOB market channel. Polymarket's
    // current official real-time-data-client sends the lowercase text frame
    // `ping` every five seconds; uppercase CLOB-style PINGs caused long-lived
    // RTDS sockets to stop receiving economic updates before closing 1006.
    socket.send('ping');
    return true;
  }

  _recordConnectionGap(detail = {}) {
    // Construction/open failures are startup availability failures rather
    // than interruptions in an established evidence stream. Once OPEN has
    // created an epoch, however, every close or forced reconnect creates an
    // unobservable interval and must remain visible for the lifetime of this
    // collector run.
    if (this.connectionEpoch <= 0) return false;
    const at = new Date().toISOString();
    const record = {
      type: 'connection_gap',
      source: 'polymarket_rtds',
      at,
      connectionEpoch: this.connectionEpoch,
      transportPath: this.transportPath,
      ...detail,
    };
    // Append the control event before mutating in-memory state. A WAL failure
    // is intentionally allowed to throw: continuing without a durable record
    // would make the research cohort look cleaner than it was.
    this.wal?.append(JSON.stringify(record), {
      channel: 'control',
      connectionEpoch: this.connectionEpoch,
      connectionShard: this.transportPath,
    });
    this.connectionGaps += 1;
    this.lastConnectionGapAt = at;
    // Never let evaluators consume a pre-disconnect quote after reconnect.
    // Historical rows remain available for explicitly timestamped analysis;
    // only the current-state cache is invalidated.
    this.latest.clear();
    this.lastFrameAt = 0;
    this.lastMsgAt = 0;
    this.onConnectionGap({
      transportPath: this.transportPath,
      at,
      detail,
    });
    return true;
  }

  health(now = Date.now()) {
    return {
      connected: this.ws?.readyState === WebSocket.OPEN,
      transportPath: this.transportPath,
      connectionEpoch: this.connectionEpoch,
      connectionGaps: this.connectionGaps,
      lastConnectionGapAt: this.lastConnectionGapAt,
      lastMessageAgeMs: this.lastMsgAt > 0 ? Math.max(0, now - this.lastMsgAt) : null,
      lastFrameAgeMs: this.lastFrameAt > 0 ? Math.max(0, now - this.lastFrameAt) : null,
      assetFreshness: Object.fromEntries([...this.assets].map((asset) => {
        const tick = this.latest.get(`chainlink:${asset}`);
        const ageMs = tickAgeMs(tick, now);
        return [asset, {
          ageMs: Number.isFinite(ageMs) ? ageMs : null,
          receiveAgeMs: tick ? Math.max(0, now - tick.receiveWallMs) : null,
          sourceAgeMs: tick?.sourceMs != null ? Math.max(0, now - tick.sourceMs) : null,
        }];
      })),
      frames: this.frameCount,
      frameBytes: this.frameBytes,
      framesPerSecond: this.startedAt < now
        ? this.frameCount / ((now - this.startedAt) / 1000)
        : 0,
    };
  }

  _onMessage(raw) {
    const receiveWallMs = Date.now();
    const receiveMonoNs = process.hrtime.bigint().toString();
    this.frameSequence += 1;
    this.frameCount += 1;
    this.frameBytes += Buffer.byteLength(raw);
    const provenance = this.wal?.append(raw, {
      channel: 'crypto_prices_rtds', receiveWallMs, receiveMonoNs,
      connectionEpoch: this.connectionEpoch,
      connectionShard: this.transportPath,
    }) || {
      event_id: null, event_sequence: this.frameSequence,
      receive_wall_timestamp_ms: receiveWallMs, receive_monotonic_ns: receiveMonoNs,
      connection_epoch: this.connectionEpoch,
    };
    this.lastFrameAt = receiveWallMs;
    if (raw.toString().trim().toLowerCase() === 'pong') return;
    let message;
    try { message = JSON.parse(raw); } catch (_) { return; }
    if (!['crypto_prices_chainlink', 'crypto_prices'].includes(message.topic)) return;
    let payload = message.payload;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch (_) { return; }
    }
    for (const tick of Array.isArray(payload) ? payload : [payload]) {
      if (!tick || typeof tick !== 'object') continue;
      const asset = normalizeAsset(tick.symbol, this.assets);
      const value = parseFloat(tick.value ?? tick.price);
      if (!asset || !this.assets.has(asset) || !(value > 0)) continue;
      const sourceMs = epochMs(tick.timestamp ?? message.timestamp);
      const sourceKey = message.topic === 'crypto_prices_chainlink' ? 'chainlink' : 'binance';
      const row = {
        source: `${sourceKey}_rtds`, symbol: String(tick.symbol), asset,
        sourceMs, receiveWallMs, receiveMonoNs, value,
        connectionEpoch: this.connectionEpoch,
        eventSequence: provenance.event_sequence || this.frameSequence,
        walEventId: provenance.event_id || null,
        raw: {
          topic: message.topic, type: message.type, payload: tick,
          transportPath: this.transportPath,
        },
      };
      const key = `${sourceKey}:${asset}`;
      this.latest.set(key, row);
      this.lastMsgAt = receiveWallMs;
      const history = this.history.get(key) || [];
      history.push({
        at: sourceMs || receiveWallMs,
        receiveWallMs,
        value,
      });
      // Keep enough resolver history to recover the exact opening reference
      // after a mid-window collector restart. Four assets × two feeds ×
      // roughly one tick/second is small compared with the raw WAL.
      const cutoff = (sourceMs || receiveWallMs) - HISTORY_RETENTION_MS;
      while (history.length && history[0].at < cutoff) history.shift();
      this.history.set(key, history);
      this.rows.push(row);
      if (this.rows.length > 100000) this.rows.splice(0, 50000);
      try { this.onMarketEvent(row); } catch (err) {
        this.onGap('rtds', `event callback failed: ${err.message}`);
      }
    }
  }

  getPrice(asset, maxAgeMs = 10000, source = 'chainlink') {
    const tick = this.latest.get(`${source}:${asset}`);
    if (!this.isTickFresh(tick, maxAgeMs)) return null;
    return tick.value;
  }

  isTickFresh(tick, maxAgeMs = 10000, now = Date.now()) {
    return tickAgeMs(tick, now) <= maxAgeMs;
  }

  getBinancePrice(asset, maxAgeMs = 10000) {
    return this.getPrice(asset, maxAgeMs, 'binance');
  }

  getAgeMs(asset, source = 'chainlink') {
    const tick = this.latest.get(`${source}:${asset}`);
    const age = tickAgeMs(tick);
    return Number.isFinite(age) ? age : null;
  }

  getPriceAtMs(asset, targetMs, toleranceMs = 3000, source = 'chainlink') {
    const target = Number(targetMs);
    const tolerance = Math.max(0, Number(toleranceMs) || 0);
    if (!Number.isFinite(target)) return null;
    const rows = this.history.get(`${source}:${asset}`) || [];
    let best = null;
    let bestDistance = Infinity;
    for (const row of rows) {
      const distance = Math.abs(row.at - target);
      if (distance <= tolerance && distance < bestDistance) {
        best = row;
        bestDistance = distance;
      }
    }
    return best?.value ?? null;
  }

  getMicro(asset, source = 'chainlink', lookbackSec = 10) {
    const rows = this.history.get(`${source}:${asset}`) || [];
    const latest = rows[rows.length - 1];
    if (!latest) return null;
    const target = latest.at - Math.max(2, lookbackSec) * 1000;
    const first = [...rows].reverse().find((row) => row.at <= target);
    if (!first || latest.at - first.at > (lookbackSec + 2) * 1000 || !(first.value > 0)) return null;
    return {
      lookbackSec,
      returnBps: 10000 * Math.log(latest.value / first.value),
      firstPrice: first.value,
      lastPrice: latest.value,
      firstAt: first.at,
      lastAt: latest.at,
    };
  }

  getDivergence(asset, venuePrice, maxAgeMs = 10000) {
    const tick = this.latest.get(`chainlink:${asset}`);
    const chainlink = this.getPrice(asset, maxAgeMs);
    const venue = Number(venuePrice);
    if (!tick || !(chainlink > 0) || !(venue > 0)) return null;
    return {
      chainlink, venue,
      signed: venue - chainlink,
      absBps: Math.abs(venue - chainlink) / chainlink * 10000,
      chainlinkSourceMs: tick.sourceMs,
      chainlinkReceiveMs: tick.receiveWallMs,
      ageMs: tickAgeMs(tick),
    };
  }

  drainRows() {
    const rows = this.rows;
    this.rows = [];
    return rows;
  }

  restoreRows(rows) {
    this.rows = rows.concat(this.rows);
    if (this.rows.length > 100000) this.rows.length = 100000;
  }

  checkStale(maxAgeMs = 15000) {
    const now = Date.now();
    const staleAssets = [...this.assets].filter((asset) =>
      !this.isTickFresh(this.latest.get(`chainlink:${asset}`), maxAgeMs, now));
    const stale = staleAssets.length > 0;
    if (stale && !this._reconnectTimer) {
      this._recordConnectionGap({
        reason: 'stale_timeout',
        maxAgeMs,
        staleAssets,
        lastDataAgeMs: this.lastMsgAt ? now - this.lastMsgAt : null,
        lastFrameAgeMs: this.lastFrameAt ? now - this.lastFrameAt : null,
      });
      this.onGap('rtds', `Chainlink economic feed stale for ${staleAssets.join(',')} ` +
        `>${Math.round(maxAgeMs / 1000)}s — forcing reconnect`);
      const dead = this.ws;
      this.ws = null;
      try { dead?.terminate(); } catch (_) {}
      this._scheduleReconnect();
    }
    return stale;
  }

  close() {
    this._closed = true;
    clearTimeout(this._reconnectTimer);
    clearInterval(this._pingTimer);
    const ws = this.ws;
    this.ws = null; // reject already-queued frames before the WAL is sealed
    try { ws?.close(); } catch (_) {}
  }
}

module.exports = RtdsRecon;
module.exports.normalizeAsset = normalizeAsset;
module.exports.tickAgeMs = tickAgeMs;
module.exports.DEFAULT_ASSETS = DEFAULT_ASSETS;
