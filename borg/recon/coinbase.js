/**
 * Independent Coinbase Exchange ticker feed used as a resolver-proxy control.
 *
 * Polymarket's crypto markets resolve from a Chainlink Data Stream, which is
 * an aggregate rather than a Binance print. Coinbase is not the resolver and
 * must never be labelled as such; it is a second, independent liquid venue.
 * Agreement between Binance and Coinbase is therefore a testable proxy for a
 * broad-market move, while disagreement is a reason for H12 to abstain.
 *
 * Public market data only. There are no credentials or order methods here.
 */
'use strict';

const WebSocket = require('ws');

const WS_URL = 'wss://ws-feed.exchange.coinbase.com';

class ProductState {
  constructor(asset, product) {
    this.asset = asset;
    this.product = product;
    this.price = null;
    this.bestBid = null;
    this.bestAsk = null;
    this.priceAt = 0;
    this.history = [];
    this.rows = [];
    this.lastPersistedSec = 0;
    this.bids = new Map();
    this.asks = new Map();
    this.touchRows = [];
    this.tradeRows = [];
    this.lastTouchKey = null;
  }
}

class CoinbaseRecon {
  constructor(onGap, products = {}, options = {}) {
    this.onGap = onGap || (() => {});
    this.wal = options.wal || null;
    this.onMarketEvent = options.onMarketEvent || (() => {});
    this.products = Object.values(products);
    this.byAsset = new Map();
    this.byProduct = new Map();
    for (const [asset, product] of Object.entries(products)) {
      const st = new ProductState(asset, product);
      this.byAsset.set(asset, st);
      this.byProduct.set(product, st);
    }
    this.ws = null;
    this.lastMsgAt = 0;
    this._reconnectDelay = 1000;
    this._reconnectTimer = null;
    this._closed = false;
    this._staleWarned = false;
    this.connectionEpoch = 0;
    this.frameSequence = 0;
  }

  connect() {
    if (!this.products.length) return Promise.resolve(true);
    return new Promise((resolve) => {
      let ws;
      try {
        ws = new WebSocket(WS_URL);
      } catch (err) {
        this.onGap('coinbase', `ws construct failed: ${err.message}`);
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
          type: 'subscribe',
          product_ids: this.products,
          // level2_batch is the public 50ms batched depth stream. Ticker keeps
          // the trade tape and an independent top-of-book cross-check.
          channels: ['ticker', 'level2_batch', 'heartbeat'],
        }));
        resolve(true);
      });
      ws.on('message', (buf) => { if (ws === this.ws) this._onMessage(buf); });
      ws.on('close', () => {
        clearTimeout(timeout);
        if (this._closed || ws !== this.ws) return;
        this.onGap('coinbase', 'ws closed — reconnecting');
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
      this.connect().then((ok) => { if (!ok) this._scheduleReconnect(); });
    }, delay);
  }

  _onMessage(buf) {
    const receivedAt = Date.now();
    const receiveMonoNs = process.hrtime.bigint().toString();
    this.frameSequence += 1;
    const provenance = this.wal?.append(buf, {
      channel: 'exchange_ws', receiveWallMs: receivedAt, receiveMonoNs,
      connectionEpoch: this.connectionEpoch,
    }) || { event_sequence: this.frameSequence, event_id: null };
    let msg;
    try { msg = JSON.parse(buf); } catch (_) { return; }
    if (msg.type === 'heartbeat' || msg.type === 'subscriptions') {
      this.lastMsgAt = receivedAt;
      return;
    }
    const st = this.byProduct.get(msg.product_id);
    if (!st) return;
    if (msg.type === 'snapshot' || msg.type === 'l2update') {
      const sourceMs = Number.isFinite(Date.parse(msg.time)) ? Date.parse(msg.time) : receivedAt;
      if (msg.type === 'snapshot') {
        st.bids = new Map((msg.bids || []).map(([price, size]) => [String(price), parseFloat(size)]));
        st.asks = new Map((msg.asks || []).map(([price, size]) => [String(price), parseFloat(size)]));
      } else {
        for (const [side, price, sizeRaw] of msg.changes || []) {
          const book = side === 'buy' ? st.bids : st.asks;
          const size = parseFloat(sizeRaw);
          if (Number.isFinite(size) && size > 0) book.set(String(price), size);
          else book.delete(String(price));
        }
      }
      this._queueTouch(st, {
        sourceMs, receivedAt, receiveMonoNs,
        connectionEpoch: this.connectionEpoch,
        eventSequence: provenance.event_sequence || this.frameSequence,
        walEventId: provenance.event_id || null,
      });
      this.lastMsgAt = receivedAt;
      try {
        this.onMarketEvent({
          source: 'coinbase', asset: st.asset, product: st.product, eventType: msg.type,
          sourceMs, receiveWallMs: receivedAt, receiveMonoNs,
          connectionEpoch: this.connectionEpoch,
          eventSequence: provenance.event_sequence || this.frameSequence,
          walEventId: provenance.event_id || null,
        });
      } catch (err) {
        this.onGap('coinbase', `event callback failed: ${err.message}`);
      }
      return;
    }
    if (msg.type !== 'ticker') return;
    const price = parseFloat(msg.price);
    if (!(price > 0)) return;
    const at = Number.isFinite(Date.parse(msg.time)) ? Date.parse(msg.time) : Date.now();
    st.price = price;
    st.bestBid = parseFloat(msg.best_bid);
    st.bestAsk = parseFloat(msg.best_ask);
    st.priceAt = receivedAt;
    this.lastMsgAt = receivedAt;
    this._queueTouch(st, {
      sourceMs: at, receivedAt, receiveMonoNs,
      connectionEpoch: this.connectionEpoch,
      eventSequence: provenance.event_sequence || this.frameSequence,
      walEventId: provenance.event_id || null,
      tickerOnly: true,
    });
    const tradeId = msg.trade_id == null ? null : String(msg.trade_id);
    const tradeSize = parseFloat(msg.last_size);
    if (tradeId && Number.isFinite(tradeSize) && tradeSize >= 0) {
      st.tradeRows.push({
        dedupKey: `coinbase:${st.product}:${tradeId}`,
        source: 'coinbase', product: st.product, asset: st.asset,
        sourceMs: at, receivedAt, receiveMonoNs, price, size: tradeSize,
        side: msg.side || null, connectionEpoch: this.connectionEpoch,
        eventSequence: provenance.event_sequence || this.frameSequence,
        walEventId: provenance.event_id || null,
      });
    }
    if (this._staleWarned) {
      this._staleWarned = false;
      this.onGap('coinbase', 'feed recovered');
    }

    st.history.push({ at, price });
    const cutoff = at - 120000;
    while (st.history.length && st.history[0].at < cutoff) st.history.shift();

    const sec = Math.floor(at / 1000);
    if (sec > st.lastPersistedSec) {
      st.lastPersistedSec = sec;
      st.rows.push({
        product: st.product, asset: st.asset, sec, price,
        bestBid: Number.isFinite(st.bestBid) ? st.bestBid : null,
        bestAsk: Number.isFinite(st.bestAsk) ? st.bestAsk : null,
      });
    }
    try {
      this.onMarketEvent({
        source: 'coinbase', asset: st.asset, product: st.product, eventType: 'ticker',
        sourceMs: at, receiveWallMs: receivedAt, receiveMonoNs,
        connectionEpoch: this.connectionEpoch,
        eventSequence: provenance.event_sequence || this.frameSequence,
        walEventId: provenance.event_id || null,
      });
    } catch (err) {
      this.onGap('coinbase', `event callback failed: ${err.message}`);
    }
  }

  getPrice(asset) { return this.byAsset.get(asset)?.price ?? null; }

  _queueTouch(st, provenance) {
    let bestBid = st.bestBid;
    let bidSize = null;
    let bestAsk = st.bestAsk;
    let askSize = null;
    if (!provenance.tickerOnly || st.bids.size || st.asks.size) {
      bestBid = null; bestAsk = null;
      for (const [priceRaw, size] of st.bids) {
        const price = parseFloat(priceRaw);
        if (Number.isFinite(price) && (bestBid == null || price > bestBid)) {
          bestBid = price; bidSize = size;
        }
      }
      for (const [priceRaw, size] of st.asks) {
        const price = parseFloat(priceRaw);
        if (Number.isFinite(price) && (bestAsk == null || price < bestAsk)) {
          bestAsk = price; askSize = size;
        }
      }
      st.bestBid = bestBid;
      st.bestAsk = bestAsk;
    }
    const key = [bestBid, bidSize, bestAsk, askSize].join(':');
    if (key === st.lastTouchKey || (bestBid == null && bestAsk == null)) return;
    st.lastTouchKey = key;
    st.touchRows.push({
      source: 'coinbase', product: st.product, asset: st.asset,
      sourceMs: provenance.sourceMs, receivedAt: provenance.receivedAt,
      receiveMonoNs: provenance.receiveMonoNs,
      bestBid, bidSize, bestAsk, askSize,
      connectionEpoch: provenance.connectionEpoch,
      eventSequence: provenance.eventSequence,
      walEventId: provenance.walEventId,
    });
  }

  getMicro(asset, lookbackSec = 10) {
    const st = this.byAsset.get(asset);
    if (!st || st.history.length < 2) return null;
    const last = st.history[st.history.length - 1];
    const target = last.at - Math.max(2, lookbackSec) * 1000;
    let first = null;
    for (let i = st.history.length - 2; i >= 0; i--) {
      first = st.history[i];
      if (first.at <= target) break;
    }
    if (!first || last.at - first.at < lookbackSec * 800 || !(first.price > 0)) return null;
    return {
      lookbackSec,
      returnBps: 10000 * Math.log(last.price / first.price),
      firstPrice: first.price,
      lastPrice: last.price,
      firstAt: first.at,
      lastAt: last.at,
    };
  }

  drainRows() {
    const out = [];
    for (const st of this.byAsset.values()) {
      out.push(...st.rows);
      st.rows = [];
    }
    return out;
  }

  drainExternalRows() {
    const touches = [];
    const trades = [];
    for (const st of this.byAsset.values()) {
      touches.push(...st.touchRows);
      trades.push(...st.tradeRows);
      st.touchRows = [];
      st.tradeRows = [];
    }
    return { touches, trades };
  }

  assetStale(asset, maxAgeMs = 10000) {
    const st = this.byAsset.get(asset);
    return !st || !st.priceAt || Date.now() - st.priceAt > maxAgeMs;
  }

  checkStale(maxAgeMs = 30000) {
    if (!this.products.length) return false;
    const stale = !this.lastMsgAt || Date.now() - this.lastMsgAt > maxAgeMs;
    if (stale && !this._staleWarned) {
      this._staleWarned = true;
      this.onGap('coinbase', `feed silent >${Math.round(maxAgeMs / 1000)}s — H12 abstaining`);
    }
    if (stale && !this._reconnectTimer) {
      const dead = this.ws;
      this.ws = null;
      try { dead?.terminate(); } catch (_) {}
      this._scheduleReconnect();
    }
    return stale;
  }

  isStale(maxAgeMs = 10000) {
    return this.products.length > 0 && (!this.lastMsgAt || Date.now() - this.lastMsgAt > maxAgeMs);
  }

  stop() {
    this._closed = true;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    const ws = this.ws;
    this.ws = null; // reject already-queued frames before the WAL is sealed
    try { ws?.close(); } catch (_) {}
  }
}

module.exports = CoinbaseRecon;
