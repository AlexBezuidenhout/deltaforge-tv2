/**
 * BORG recon — Hyperliquid all-mids reference network.
 *
 * Uses the public event-driven allMids WebSocket for every configured coin.
 * HYPE consumes this as its primary price source; Binance-listed assets use it
 * only as an independent reference network. No credentials or order methods
 * exist in this adapter.
 */
'use strict';

const WebSocket = require('ws');

const WS_URL = 'wss://api.hyperliquid.xyz/ws';
const EWMA_LAMBDA = Math.exp(-1 / 60);

class HyperliquidRecon {
  constructor(onGap, coins = [], options = {}) {
    this.onGap = onGap || (() => {});
    this.coins = [...new Set(coins.filter(Boolean))];
    this.wal = options.wal || null;
    this.onMarketEvent = options.onMarketEvent || (() => {});
    this.byCoin = new Map(this.coins.map((coin) => [coin, {
      price: null, priceAt: 0, _bar: null, _bars: [], _history: [],
      _ewmaVar: null, _lastClose: null, _closedSec: 0,
    }]));
    this.ws = null;
    this.lastMsgAt = 0;
    this.connectionEpoch = 0;
    this.frameSequence = 0;
    this.touchRows = [];
    this.tradeRows = [];
    this._reconnectDelay = 1000;
    this._reconnectTimer = null;
    this._pingTimer = null;
    this._closed = false;
    this._staleWarned = false;
  }

  start() {
    this._closed = false;
    if (!this.coins.length || this.ws || this._reconnectTimer) return;
    this._connect();
  }

  _connect() {
    if (this._closed || !this.coins.length) return;
    let ws;
    try {
      ws = new WebSocket(WS_URL);
    } catch (err) {
      this.onGap('hyperliquid', `ws construct failed: ${err.message}`);
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.on('open', () => {
      if (ws !== this.ws) return;
      this.connectionEpoch += 1;
      this.frameSequence = 0;
      this._reconnectDelay = 1000;
      this.lastMsgAt = Date.now();
      ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'allMids' } }));
      for (const coin of this.coins) {
        // BBO includes displayed size and is sufficient to test the current
        // $10 research stake. Trades make fill/adverse-selection analysis
        // possible without the much larger full-depth storage footprint.
        ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'bbo', coin } }));
        ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin } }));
      }
      this._pingTimer = setInterval(() => {
        if (this.ws === ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ method: 'ping' }));
        }
      }, 30000);
    });
    ws.on('message', (raw) => { if (ws === this.ws) this._onMessage(raw); });
    ws.on('close', () => {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
      if (this._closed || ws !== this.ws) return;
      this.ws = null;
      this.onGap('hyperliquid', 'ws closed — reconnecting');
      this._scheduleReconnect();
    });
    ws.on('error', () => { /* close follows */ });
  }

  _scheduleReconnect() {
    if (this._closed || this._reconnectTimer) return;
    const delay = this._reconnectDelay;
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, 30000);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, delay);
  }

  _onMessage(raw) {
    const receiveWallMs = Date.now();
    const receiveMonoNs = process.hrtime.bigint().toString();
    this.frameSequence += 1;
    const provenance = this.wal?.append(raw, {
      channel: 'hyperliquid_ws', receiveWallMs, receiveMonoNs,
      connectionEpoch: this.connectionEpoch,
    }) || { event_sequence: this.frameSequence, event_id: null };
    let message;
    try { message = JSON.parse(raw); } catch (_) { return; }
    if (message.channel === 'pong' || message.channel === 'subscriptionResponse') {
      this.lastMsgAt = receiveWallMs;
      return;
    }
    if (message.channel === 'bbo') {
      const data = message.data || {};
      const state = this.byCoin.get(data.coin);
      if (!state) return;
      const bid = data.bbo?.[0] || null;
      const ask = data.bbo?.[1] || null;
      const bestBid = bid ? parseFloat(bid.px) : null;
      const bidSize = bid ? parseFloat(bid.sz) : null;
      const bestAsk = ask ? parseFloat(ask.px) : null;
      const askSize = ask ? parseFloat(ask.sz) : null;
      this.lastMsgAt = receiveWallMs;
      this.touchRows.push({
        source: 'hyperliquid', product: data.coin, asset: null,
        sourceMs: Number(data.time) || null, receivedAt: receiveWallMs, receiveMonoNs,
        bestBid: Number.isFinite(bestBid) ? bestBid : null,
        bidSize: Number.isFinite(bidSize) ? bidSize : null,
        bestAsk: Number.isFinite(bestAsk) ? bestAsk : null,
        askSize: Number.isFinite(askSize) ? askSize : null,
        connectionEpoch: this.connectionEpoch,
        eventSequence: provenance.event_sequence || this.frameSequence,
        walEventId: provenance.event_id || null,
      });
      try {
        this.onMarketEvent({
          source: 'hyperliquid', coin: data.coin, eventType: 'bbo',
          sourceMs: Number(data.time) || null, receiveWallMs, receiveMonoNs,
          connectionEpoch: this.connectionEpoch,
          eventSequence: provenance.event_sequence || this.frameSequence,
          walEventId: provenance.event_id || null,
        });
      } catch (err) {
        this.onGap('hyperliquid', `event callback failed: ${err.message}`);
      }
      return;
    }
    if (message.channel === 'trades') {
      const trades = Array.isArray(message.data) ? message.data : [];
      this.lastMsgAt = receiveWallMs;
      for (const trade of trades) {
        if (!this.byCoin.has(trade.coin)) continue;
        const price = parseFloat(trade.px);
        const size = parseFloat(trade.sz);
        if (!(price > 0)) continue;
        this.tradeRows.push({
          dedupKey: `hyperliquid:${trade.coin}:${trade.time}:${trade.tid}`,
          source: 'hyperliquid', product: trade.coin, asset: null,
          sourceMs: Number(trade.time) || null, receivedAt: receiveWallMs, receiveMonoNs,
          price, size: Number.isFinite(size) ? size : null, side: trade.side || null,
          connectionEpoch: this.connectionEpoch,
          eventSequence: provenance.event_sequence || this.frameSequence,
          walEventId: provenance.event_id || null,
        });
      }
      if (trades.length) {
        const last = trades[trades.length - 1];
        try {
          this.onMarketEvent({
            source: 'hyperliquid', coin: last.coin, eventType: 'trades',
            sourceMs: Number(last.time) || null, receiveWallMs, receiveMonoNs,
            connectionEpoch: this.connectionEpoch,
            eventSequence: provenance.event_sequence || this.frameSequence,
            walEventId: provenance.event_id || null,
          });
        } catch (err) {
          this.onGap('hyperliquid', `event callback failed: ${err.message}`);
        }
      }
      return;
    }
    if (message.channel !== 'allMids' || !message.data?.mids) return;
    this.lastMsgAt = receiveWallMs;
    const sec = Math.floor(receiveWallMs / 1000);
    for (const coin of this.coins) {
      const price = parseFloat(message.data.mids[coin]);
      const state = this.byCoin.get(coin);
      if (!state || !(price > 0)) continue;
      state.price = price;
      state.priceAt = receiveWallMs;
      if (!state._bar || state._bar.sec !== sec) {
        this._rollBar(state, coin, sec);
        state._bar = {
          sec, open: price, high: price, low: price, close: price,
          n: 0, buyVol: 0, sellVol: 0,
        };
      }
      state._bar.high = Math.max(state._bar.high, price);
      state._bar.low = Math.min(state._bar.low, price);
      state._bar.close = price;
      try {
        this.onMarketEvent({
          source: 'hyperliquid', coin, eventType: 'allMids', sourceMs: null,
          receiveWallMs, receiveMonoNs, connectionEpoch: this.connectionEpoch,
          eventSequence: provenance.event_sequence || this.frameSequence,
          walEventId: provenance.event_id || null,
        });
      } catch (err) {
        this.onGap('hyperliquid', `event callback failed: ${err.message}`);
      }
    }
    if (this._staleWarned) {
      this._staleWarned = false;
      this.onGap('hyperliquid', 'feed recovered');
    }
  }

  _rollBar(state, coin, newSec) {
    const bar = state._bar;
    if (!bar || bar.sec === newSec || bar.sec <= state._closedSec) return;
    state._closedSec = bar.sec;
    bar.symbol = `${coin}-HL`;
    state._bars.push(bar);
    state._history.push(bar);
    if (state._history.length > 600) state._history.shift();
    if (state._lastClose != null && bar.close > 0 && state._lastClose > 0) {
      const ret = Math.log(bar.close / state._lastClose);
      state._ewmaVar = state._ewmaVar == null
        ? ret * ret
        : EWMA_LAMBDA * state._ewmaVar + (1 - EWMA_LAMBDA) * ret * ret;
    }
    state._lastClose = bar.close;
  }

  drainBars() {
    const out = [];
    for (const state of this.byCoin.values()) {
      out.push(...state._bars);
      state._bars = [];
    }
    return out;
  }

  drainExternalRows() {
    const rows = { touches: this.touchRows, trades: this.tradeRows };
    this.touchRows = [];
    this.tradeRows = [];
    return rows;
  }

  getSigma5m(coin) {
    const state = this.byCoin.get(coin);
    if (!state || state._ewmaVar == null) return null;
    return Math.sqrt(state._ewmaVar * 300);
  }

  getPrice(coin) { return this.byCoin.get(coin)?.price ?? null; }

  getMicro(coin, lookbackSec = 10) {
    const state = this.byCoin.get(coin);
    if (!state) return null;
    const bars = [...state._history, ...(state._bar ? [state._bar] : [])];
    const latest = bars[bars.length - 1];
    if (!latest) return null;
    const targetSec = latest.sec - Math.max(2, Math.trunc(lookbackSec));
    const first = [...bars].reverse().find((bar) => bar.sec <= targetSec) ||
      (latest.sec - bars[0].sec >= lookbackSec - 1 ? bars[0] : null);
    if (!first || latest.sec - first.sec > lookbackSec + 2 || !(first.open > 0) || !(latest.close > 0)) return null;
    return {
      lookbackSec,
      returnBps: 10000 * Math.log(latest.close / first.open),
      flowImbalance: null,
      depthImbalance: null,
      trades: 0,
      volume: 0,
      lastClose: latest.close,
      lastBarSec: latest.sec,
    };
  }

  freshPrice(coin, maxAgeMs = 3000) {
    const state = this.byCoin.get(coin);
    if (!state || !state.priceAt) return null;
    return Date.now() - state.priceAt <= maxAgeMs ? state.price : null;
  }

  checkStale(maxAgeMs = 30000) {
    if (!this.coins.length) return false;
    const stale = !this.lastMsgAt || Date.now() - this.lastMsgAt > maxAgeMs;
    if (stale && !this._staleWarned) {
      this._staleWarned = true;
      this.onGap('hyperliquid', `no allMids for >${Math.round(maxAgeMs / 1000)}s`);
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
    return this.coins.length > 0 && (!this.lastMsgAt || Date.now() - this.lastMsgAt > maxAgeMs);
  }

  stop() {
    this._closed = true;
    clearTimeout(this._reconnectTimer);
    clearInterval(this._pingTimer);
    this._reconnectTimer = null;
    this._pingTimer = null;
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch (_) {}
  }
}

module.exports = HyperliquidRecon;
