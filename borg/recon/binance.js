/**
 * BORG recon — Binance multi-symbol feed.
 * One combined WS stream carrying aggTrade + bookTicker + depth10@100ms for
 * every configured symbol; per-symbol 1s bars, EWMA σ, and fresh-price state.
 *
 * Reconnect contract (hardened 2026-07-12 after an 11h silent-feed outage):
 *  - connect() always settles (resolves true on open, false on timeout).
 *  - _scheduleReconnect() is idempotent; the chain cannot die.
 *  - checkStale() must be called on a timer; after ~5 min of continuous
 *    staleness the process exit(1)s so launchd replaces it (a wedged process
 *    has failed every in-process reconnect while a fresh one connects in 2s).
 */
const WebSocket = require('ws');

const EWMA_LAMBDA = Math.exp(-1 / 60); // 60s time constant on 1s returns

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

class SymbolState {
  constructor(symbol) {
    this.symbol = symbol;
    this.price = null;
    this.priceAt = 0;
    this.bestBid = null;
    this.bestAsk = null;
    this.depthImb = null;
    this._bar = null;
    this._bars = [];
    // `_bars` is the persistence drain buffer and is emptied every five
    // seconds. Keep a separate bounded history so shadow strategies can use
    // genuinely pre-decision CEX microstructure without querying Postgres in
    // the one-second collector loop.
    this._history = [];
    this._ewmaVar = null;
    this._lastClose = null;
    this._closedSec = 0;
  }
}

class BinanceRecon {
  constructor(onGap, symbols = ['BTCUSDT'], options = {}) {
    this.ws = null;
    this.onGap = onGap || (() => {});
    this.wal = options.wal || null;
    this.onMarketEvent = options.onMarketEvent || (() => {});
    this.symbols = symbols;
    this.bySymbol = new Map(symbols.map((s) => [s, new SymbolState(s)]));
    this.lastMsgAt = 0;
    this._reconnectDelay = 1000;
    this._reconnectTimer = null;
    this._closed = false;
    this.connectionEpoch = 0;
    this.frameSequence = 0;
  }

  _streamUrl() {
    const streams = this.symbols
      .map((s) => s.toLowerCase())
      .flatMap((s) => [`${s}@aggTrade`, `${s}@bookTicker`, `${s}@depth10@100ms`]);
    return `wss://stream.binance.com:9443/stream?streams=${streams.join('/')}`;
  }

  /** Resolves true on open, false on timeout (retry continues in background). */
  connect() {
    return new Promise((resolve) => {
      let ws;
      try {
        ws = new WebSocket(this._streamUrl());
      } catch (err) {
        this.onGap('binance', `ws construct failed: ${err.message}`);
        this._scheduleReconnect();
        return resolve(false);
      }
      this.ws = ws;
      const to = setTimeout(() => {
        try { ws.terminate(); } catch (_) {}
        resolve(false);
      }, 15000);
      ws.on('open', () => {
        if (ws !== this.ws) return;
        clearTimeout(to);
        this._reconnectDelay = 1000;
        this.connectionEpoch += 1;
        this.frameSequence = 0;
        this.lastMsgAt = Date.now(); // grace period before staleness fires
        resolve(true);
      });
      ws.on('message', (buf) => { if (ws === this.ws) this._onMessage(buf); });
      ws.on('close', () => {
        clearTimeout(to);
        if (ws !== this.ws) return;
        this.onGap('binance', 'ws closed — reconnecting');
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

  /** Watchdog + escalation — see class docblock. */
  checkStale(maxAgeMs = 30000) {
    if (this.lastMsgAt && Date.now() - this.lastMsgAt <= maxAgeMs) {
      this._staleChecks = 0;
      return false;
    }
    this._staleChecks = (this._staleChecks || 0) + 1;
    if (this._staleChecks >= 10) {
      this.onGap('binance', `feed silent through ${this._staleChecks} watchdog cycles — exiting for supervisor restart`);
      setTimeout(() => process.exit(1), 2000);
      this._staleChecks = -1e9;
      return true;
    }
    if (!this._reconnectTimer) {
      this.onGap('binance', `ws silent >${Math.round(maxAgeMs / 1000)}s — forcing reconnect`);
      const dead = this.ws;
      this.ws = null;
      try { dead?.terminate(); } catch (_) {}
      this._scheduleReconnect();
    }
    return true;
  }

  _onMessage(buf) {
    const receiveWallMs = Date.now();
    const receiveMonoNs = process.hrtime.bigint().toString();
    this.frameSequence += 1;
    const provenance = this.wal?.append(buf, {
      channel: 'combined_stream', receiveWallMs, receiveMonoNs,
      connectionEpoch: this.connectionEpoch,
    }) || {
      event_id: null, event_sequence: this.frameSequence,
      receive_wall_timestamp_ms: receiveWallMs, receive_monotonic_ns: receiveMonoNs,
      connection_epoch: this.connectionEpoch,
    };
    this.lastMsgAt = receiveWallMs;
    let msg;
    try { msg = JSON.parse(buf); } catch (_) { return; }
    const d = msg.data;
    if (!d || !msg.stream) return;
    const [symLower, kind] = msg.stream.split('@');
    const st = this.bySymbol.get(symLower.toUpperCase());
    if (!st) return;

    if (kind === 'aggTrade') {
      const p = parseFloat(d.p);
      const q = parseFloat(d.q);
      if (!Number.isFinite(p)) return;
      st.price = p;
      st.priceAt = receiveWallMs;
      const sec = Math.floor(d.T / 1000);
      if (!st._bar || st._bar.sec !== sec) {
        this._rollBar(st, sec);
        st._bar = { sec, open: p, high: p, low: p, close: p, n: 0, buyVol: 0, sellVol: 0 };
      }
      const b = st._bar;
      b.high = Math.max(b.high, p);
      b.low = Math.min(b.low, p);
      b.close = p;
      b.n += 1;
      if (d.m) b.sellVol += q; else b.buyVol += q;
    } else if (kind === 'bookTicker') {
      st.bestBid = parseFloat(d.b);
      st.bestAsk = parseFloat(d.a);
    } else if (kind === 'depth10') {
      let bidSum = 0, askSum = 0;
      for (const [, q] of d.bids || []) bidSum += parseFloat(q);
      for (const [, q] of d.asks || []) askSum += parseFloat(q);
      st.depthImb = bidSum + askSum > 0 ? (bidSum - askSum) / (bidSum + askSum) : null;
    }
    try {
      this.onMarketEvent({
        source: 'binance', symbol: st.symbol, eventType: kind,
        sourceMs: Number(d.T || d.E) || null,
        receiveWallMs, receiveMonoNs,
        connectionEpoch: this.connectionEpoch,
        eventSequence: provenance.event_sequence || this.frameSequence,
        walEventId: provenance.event_id || null,
      });
    } catch (err) {
      this.onGap('binance', `event callback failed: ${err.message}`);
    }
  }

  _rollBar(st, newSec) {
    const b = st._bar;
    if (!b || b.sec === newSec || b.sec <= st._closedSec) return;
    st._closedSec = b.sec;
    b.bestBid = st.bestBid;
    b.bestAsk = st.bestAsk;
    b.depthImb = st.depthImb;
    b.symbol = st.symbol;
    st._bars.push(b);
    st._history.push(b);
    if (st._history.length > 600) st._history.shift();
    if (st._lastClose != null && b.close > 0 && st._lastClose > 0) {
      const r = Math.log(b.close / st._lastClose);
      st._ewmaVar = st._ewmaVar == null
        ? r * r
        : EWMA_LAMBDA * st._ewmaVar + (1 - EWMA_LAMBDA) * r * r;
    }
    st._lastClose = b.close;
  }

  /** Completed 1s bars for ALL symbols since last drain (each row has .symbol). */
  drainBars() {
    const out = [];
    for (const st of this.bySymbol.values()) {
      out.push(...st._bars);
      st._bars = [];
    }
    return out;
  }

  getSigma5m(symbol) {
    const st = this.bySymbol.get(symbol);
    if (!st || st._ewmaVar == null) return null;
    return Math.sqrt(st._ewmaVar * 300);
  }

  /**
   * Causal volatility profile from completed one-second bars.
   *
   * `robustSigma5m` is a median-absolute-deviation estimate. Unlike the EWMA
   * and ordinary RMS measures, one isolated jump cannot dominate it. This is
   * the exact distinction needed by the Barclays-inspired H14-H16 pilots:
   * compare the market's expected terminal variance with persistent realized
   * variation, while retaining the jump contribution as an explicit feature
   * (`maxVarianceShare`) rather than silently deleting it.
   */
  getVolatilityProfile(symbol, lookbackSec = 120) {
    const st = this.bySymbol.get(symbol);
    const n = Math.max(20, Math.trunc(lookbackSec));
    if (!st || st._history.length < Math.min(n, 60)) return null;
    const bars = st._history.slice(-(n + 1));
    const returns = [];
    for (let i = 1; i < bars.length; i++) {
      const prior = Number(bars[i - 1]?.close);
      const current = Number(bars[i]?.close);
      if (prior > 0 && current > 0) returns.push(Math.log(current / prior));
    }
    if (returns.length < 30) return null;

    const center = median(returns);
    const deviations = returns.map((value) => Math.abs(value - center));
    const mad = median(deviations);
    // 1.4826 scales normal MAD to standard deviation. Quantized/flat feeds can
    // have MAD=0; in that case return null rather than manufacture precision.
    const robustPerSecond = mad > 0 ? 1.4826 * mad : null;
    const squares = returns.map((value) => (value - center) ** 2);
    const totalVariance = squares.reduce((sum, value) => sum + value, 0);
    const rmsPerSecond = totalVariance > 0
      ? Math.sqrt(totalVariance / squares.length)
      : null;
    const ewmaSigma5m = this.getSigma5m(symbol);
    const robustSigma5m = robustPerSecond != null
      ? robustPerSecond * Math.sqrt(300)
      : null;

    return {
      lookbackSec: n,
      observations: returns.length,
      robustSigma5m,
      rmsSigma5m: rmsPerSecond != null ? rmsPerSecond * Math.sqrt(300) : null,
      ewmaSigma5m,
      maxVarianceShare: totalVariance > 0 ? Math.max(...squares) / totalVariance : null,
      ewmaToRobust: robustSigma5m > 0 && ewmaSigma5m > 0
        ? ewmaSigma5m / robustSigma5m
        : null,
    };
  }

  getPrice(symbol) { return this.bySymbol.get(symbol)?.price ?? null; }

  /**
   * Rolling, causal microstructure summary ending at the latest completed 1s
   * bar. Values are null until enough history exists. `flowImbalance` is
   * buyer-initiated minus seller-initiated volume over total volume.
   */
  getMicro(symbol, lookbackSec = 10) {
    const st = this.bySymbol.get(symbol);
    const n = Math.max(2, Math.trunc(lookbackSec));
    if (!st) return null;
    const causal = st._history.slice();
    if (st._bar && causal[causal.length - 1]?.sec !== st._bar.sec) causal.push(st._bar);
    if (causal.length < n) return null;
    const bars = causal.slice(-n);
    const first = bars[0]?.open;
    const last = bars[bars.length - 1]?.close;
    if (!(first > 0) || !(last > 0)) return null;
    let buy = 0; let sell = 0; let trades = 0;
    for (const bar of bars) {
      buy += Number(bar.buyVol) || 0;
      sell += Number(bar.sellVol) || 0;
      trades += Number(bar.n) || 0;
    }
    const volume = buy + sell;
    return {
      lookbackSec: n,
      returnBps: 10000 * Math.log(last / first),
      flowImbalance: volume > 0 ? (buy - sell) / volume : null,
      depthImbalance: Number.isFinite(st.depthImb) ? st.depthImb : null,
      trades,
      volume,
      lastClose: last,
      lastBarSec: bars[bars.length - 1].sec,
    };
  }

  /**
   * Wall-clock microstructure window for minute-horizon research.
   *
   * getMicro() intentionally preserves the frozen legacy interpretation of
   * its argument as a count of event bars. Less-active symbols can therefore
   * span more than N seconds. New minute strategies need elapsed time instead:
   * missing seconds mean no aggregate trade and a carried-forward price, not
   * permission to reach further into history.
   */
  getWallClockMicro(symbol, lookbackSec = 60) {
    const st = this.bySymbol.get(symbol);
    const seconds = Math.max(2, Math.trunc(lookbackSec));
    if (!st) return null;
    const causal = st._history.slice();
    if (st._bar && causal[causal.length - 1]?.sec !== st._bar.sec) causal.push(st._bar);
    const latest = causal.at(-1);
    if (!latest || !Number.isFinite(Number(latest.sec))) return null;
    const cutoffSec = Number(latest.sec) - seconds + 1;
    const bars = causal.filter((bar) => Number(bar.sec) >= cutoffSec);
    if (!bars.length) return null;
    const anchor = [...causal].reverse()
      .find((bar) => Number(bar.sec) < cutoffSec);
    const first = Number(anchor?.close ?? bars[0]?.open);
    const last = Number(bars.at(-1)?.close);
    if (!(first > 0) || !(last > 0)) return null;
    let buy = 0; let sell = 0; let trades = 0;
    for (const bar of bars) {
      buy += Number(bar.buyVol) || 0;
      sell += Number(bar.sellVol) || 0;
      trades += Number(bar.n) || 0;
    }
    const volume = buy + sell;
    return {
      lookbackSec: seconds,
      returnBps: 10000 * Math.log(last / first),
      flowImbalance: volume > 0 ? (buy - sell) / volume : null,
      depthImbalance: Number.isFinite(st.depthImb) ? st.depthImb : null,
      trades,
      volume,
      observedBars: bars.length,
      firstObservedBarSec: Number(bars[0].sec),
      lastBarSec: Number(bars.at(-1).sec),
      lastPriceAgeMs: st.priceAt
        ? Math.max(0, Date.now() - st.priceAt)
        : null,
    };
  }

  freshPrice(symbol, maxAgeMs = 3000) {
    const st = this.bySymbol.get(symbol);
    if (!st || !st.priceAt) return null;
    return Date.now() - st.priceAt <= maxAgeMs ? st.price : null;
  }

  isStale(maxAgeMs = 10000) {
    return Date.now() - this.lastMsgAt > maxAgeMs;
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

module.exports = BinanceRecon;
