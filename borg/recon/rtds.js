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
const SUPPORTED = ['btc', 'eth', 'sol', 'xrp'];
const HISTORY_RETENTION_MS = 20 * 60 * 1000;

function epochMs(value) {
  if (value == null) return null;
  const n = Number(value);
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeAsset(symbol) {
  const value = String(symbol || '').toLowerCase().replace(/[^a-z]/g, '');
  if (value.includes('bitcoin')) return 'btc';
  if (value.includes('ethereum')) return 'eth';
  return SUPPORTED.find((asset) => value.startsWith(asset)) || null;
}

class RtdsRecon {
  constructor(onGap, options = {}) {
    this.onGap = onGap || (() => {});
    this.wal = options.wal || null;
    this.onMarketEvent = options.onMarketEvent || (() => {});
    this.assets = new Set((options.assets || SUPPORTED).filter((asset) => SUPPORTED.includes(asset)));
    this.ws = null;
    this.lastMsgAt = 0;
    this.connectionEpoch = 0;
    this.frameSequence = 0;
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
        this.lastMsgAt = Date.now();
        ws.send(JSON.stringify({
          action: 'subscribe',
          subscriptions: [
            { topic: 'crypto_prices_chainlink', type: '*', filters: '' },
            { topic: 'crypto_prices', type: 'update' },
          ],
        }));
        this._pingTimer = setInterval(() => {
          if (this.ws === ws && ws.readyState === WebSocket.OPEN) ws.send('PING');
        }, 5000);
        resolve(true);
      });
      ws.on('message', (raw) => { if (ws === this.ws) this._onMessage(raw); });
      ws.on('close', () => {
        clearTimeout(timeout);
        clearInterval(this._pingTimer);
        if (this._closed || ws !== this.ws) return;
        this.onGap('rtds', 'Chainlink socket closed — reconnecting');
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

  _onMessage(raw) {
    const receiveWallMs = Date.now();
    const receiveMonoNs = process.hrtime.bigint().toString();
    this.frameSequence += 1;
    const provenance = this.wal?.append(raw, {
      channel: 'crypto_prices_rtds', receiveWallMs, receiveMonoNs,
      connectionEpoch: this.connectionEpoch,
    }) || {
      event_id: null, event_sequence: this.frameSequence,
      receive_wall_timestamp_ms: receiveWallMs, receive_monotonic_ns: receiveMonoNs,
      connection_epoch: this.connectionEpoch,
    };
    this.lastMsgAt = receiveWallMs;
    if (raw.toString() === 'PONG') return;
    let message;
    try { message = JSON.parse(raw); } catch (_) { return; }
    if (!['crypto_prices_chainlink', 'crypto_prices'].includes(message.topic)) return;
    let payload = message.payload;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch (_) { return; }
    }
    for (const tick of Array.isArray(payload) ? payload : [payload]) {
      if (!tick || typeof tick !== 'object') continue;
      const asset = normalizeAsset(tick.symbol);
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
        raw: { topic: message.topic, type: message.type, payload: tick },
      };
      const key = `${sourceKey}:${asset}`;
      this.latest.set(key, row);
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
    if (!tick || Date.now() - tick.receiveWallMs > maxAgeMs) return null;
    return tick.value;
  }

  getBinancePrice(asset, maxAgeMs = 10000) {
    return this.getPrice(asset, maxAgeMs, 'binance');
  }

  getAgeMs(asset, source = 'chainlink') {
    const tick = this.latest.get(`${source}:${asset}`);
    return tick ? Math.max(0, Date.now() - tick.receiveWallMs) : null;
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
      ageMs: Date.now() - tick.receiveWallMs,
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
    const stale = !this.lastMsgAt || Date.now() - this.lastMsgAt > maxAgeMs;
    if (stale && !this._reconnectTimer) {
      this.onGap('rtds', `Chainlink socket silent >${Math.round(maxAgeMs / 1000)}s — forcing reconnect`);
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
