const WebSocket = require('ws');
const BTCIndicators = require('./BTCIndicators');

const INITIAL_CONNECT_ATTEMPTS = 6;
const INITIAL_RETRY_BASE_MS = 1000;

const BINANCE_REST_BASES = [
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
];
const KLINE_POLL_MS = 30000; // refresh 1m candles every 30s
const KLINE_LIMIT = 60; // last hour of 1m candles — enough for ADX(14) and MACD(26+9)

class BinanceFeed {
  /** @param symbol Binance spot symbol, e.g. 'BTCUSDT' (multi-asset 2026-07-12) */
  constructor(symbol = 'BTCUSDT') {
    this.symbol = symbol;
    this.ws = null;
    this.price = null;
    this.bestBid = null;
    this.bestAsk = null;
    this.bidQty = null;
    this.askQty = null;
    this.volume24h = null;
    this.reconnectDelay = 1000;
    this.isConnecting = false;
    this.priceHistory = [];
    this.maxHistoryLength = 120; // 2 minutes of 1s ticks
    /** True after a successful `open` for this socket — used to avoid spawn-on-close storms on failed DNS/handshake. */
    this._hadOpen = false;

    // 1-minute OHLC candles for indicators (ATR/RSI/ADX/MACD/BB/realised σ).
    // Polled via REST every 30 s; consumed by BTCIndicators (stateless).
    this._klines1m = [];
    this._klinesUpdatedAt = 0;
    this._klinePollTimer = null;
    this._restBaseIdx = 0;

    // Ref-price cache for Φ-model: Map<startTimeSec, refBtcPrice>.
    this._refPriceByStart = new Map();
    this._refPriceMaxEntries = 32;
  }

  /**
   * Connect with retries; also kicks off REST kline polling for indicators.
   */
  async connect() {
    let lastErr;
    for (let attempt = 1; attempt <= INITIAL_CONNECT_ATTEMPTS; attempt++) {
      try {
        await this._connectOnce();
        this._ensureKlinePolling();
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < INITIAL_CONNECT_ATTEMPTS) {
          const wait = Math.min(INITIAL_RETRY_BASE_MS * Math.pow(2, attempt - 1), 15000);
          console.warn(
            `[BinanceFeed] connect attempt ${attempt}/${INITIAL_CONNECT_ATTEMPTS} failed: ${err.message} — retry in ${wait}ms`
          );
          await new Promise((r) => setTimeout(r, wait));
        }
      }
    }
    throw lastErr;
  }

  _ensureKlinePolling() {
    if (this._klinePollTimer) return;
    this._pollKlines().catch((err) => console.warn('[BinanceFeed] initial kline fetch failed:', err.message));
    this._klinePollTimer = setInterval(() => {
      this._pollKlines().catch((err) => console.warn('[BinanceFeed] kline poll error:', err.message));
    }, KLINE_POLL_MS);
    if (typeof this._klinePollTimer?.unref === 'function') this._klinePollTimer.unref();
  }

  async _pollKlines() {
    const candles = await this._fetchKlines('1m', KLINE_LIMIT);
    if (Array.isArray(candles) && candles.length >= 16) {
      this._klines1m = candles;
      this._klinesUpdatedAt = Date.now();
    }
  }

  async _fetchKlines(interval, limit, startTimeMs = null) {
    const params = new URLSearchParams({ symbol: this.symbol, interval, limit: String(limit) });
    if (startTimeMs != null) params.set('startTime', String(startTimeMs));
    const path = `/api/v3/klines?${params.toString()}`;
    for (let i = 0; i < BINANCE_REST_BASES.length; i++) {
      const baseIdx = (this._restBaseIdx + i) % BINANCE_REST_BASES.length;
      const url = `${BINANCE_REST_BASES[baseIdx]}${path}`;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.json();
        if (!Array.isArray(raw)) throw new Error('non-array response');
        this._restBaseIdx = baseIdx;
        return raw.map((k) => ({
          openTime: Number(k[0]),
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
          closeTime: Number(k[6]),
        }));
      } catch (err) {
        if (i === BINANCE_REST_BASES.length - 1) {
          console.warn('[BinanceFeed] all REST bases failed:', err.message);
        }
      }
    }
    return [];
  }

  _connectOnce() {
    if (this.isConnecting) {
      return Promise.reject(new Error('BinanceFeed already connecting'));
    }
    this.isConnecting = true;
    this._hadOpen = false;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.isConnecting = false;
        this._cleanupWs();
        finish(reject, new Error('BinanceFeed WebSocket connection timeout (10s)'));
      }, 10000);

      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        fn(arg);
      };

      if (this.ws) {
        this.ws.removeAllListeners();
        try {
          this.ws.terminate();
        } catch (e) {}
        this.ws = null;
      }

      this.ws = new WebSocket(`wss://stream.binance.com:9443/ws/${this.symbol.toLowerCase()}@ticker`);

      this.ws.on('open', () => {
        this.isConnecting = false;
        this._hadOpen = true;
        this.reconnectDelay = 1000;
        console.log('[BinanceFeed] Connected to Binance WebSocket');
        finish(resolve);
      });

      this.ws.on('message', (data) => {
        try {
          const parsed = JSON.parse(data);
          this.price = parseFloat(parsed.c);
          if (this.price) this._lastValidPrice = this.price;
          this.bestBid = parseFloat(parsed.b);
          this.bestAsk = parseFloat(parsed.a);
          this.bidQty = parseFloat(parsed.B);
          this.askQty = parseFloat(parsed.A);
          this.volume24h = parseFloat(parsed.v);

          this.priceHistory.push({
            price: this.price,
            timestamp: Date.now()
          });
          if (this.priceHistory.length > this.maxHistoryLength) {
            this.priceHistory.shift();
          }
        } catch (e) {
          // Ignore parse errors on non-ticker messages
        }
      });

      this.ws.on('close', (code, reason) => {
        this.isConnecting = false;
        const hadOpen = this._hadOpen;
        this._hadOpen = false;

        if (!settled) {
          finish(reject, new Error(`WebSocket closed before open (code ${code})`));
        } else {
          console.log(`[BinanceFeed] Disconnected (code: ${code}). Reconnecting in ${this.reconnectDelay}ms...`);
        }

        if (this.ws) {
          this.ws.removeAllListeners();
        }

        // Only auto-reconnect after we had a working session — not on failed initial handshake/DNS.
        if (hadOpen && settled) {
          setTimeout(() => {
            this.connect().catch((err) => {
              console.error('[BinanceFeed] Reconnect failed:', err.message);
            });
          }, this.reconnectDelay);
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
        }
      });

      this.ws.on('error', (err) => {
        this.isConnecting = false;
        console.error('[BinanceFeed] WebSocket error:', err.message);
        if (!settled) {
          finish(reject, err);
        }
      });
    });
  }

  _cleanupWs() {
    if (!this.ws) return;
    this.ws.removeAllListeners();
    this.ws.on('error', () => {});
    try {
      this.ws.terminate();
    } catch (e) {}
    this.ws = null;
  }

  disconnect() {
    this._hadOpen = false;
    this._cleanupWs();
    this.isConnecting = false;
    if (this._klinePollTimer) {
      clearInterval(this._klinePollTimer);
      this._klinePollTimer = null;
    }
    console.log('[BinanceFeed] Disconnected');
  }

  /**
   * Returns the BTC price at the open of the 5 m kline containing `startTimeSec`.
   * Cached per market start. Falls back to current spot if Binance REST fails.
   */
  async getRefBtcPriceAt(startTimeSec) {
    if (!Number.isFinite(startTimeSec) || startTimeSec <= 0) return null;
    const key = Math.floor(startTimeSec);
    const cached = this._refPriceByStart.get(key);
    if (cached != null) return cached;

    const alignedSec = Math.floor(key / 300) * 300;
    const startMs = alignedSec * 1000;
    let ref = null;
    try {
      const candles = await this._fetchKlines('5m', 1, startMs);
      if (candles && candles.length > 0 && Number.isFinite(candles[0].open)) {
        ref = candles[0].open;
      }
    } catch (_) {}
    if (ref == null) {
      const live = this.getLastKnownPrice();
      if (live != null) ref = live;
    }
    if (ref != null) {
      if (this._refPriceByStart.size >= this._refPriceMaxEntries) {
        const firstKey = this._refPriceByStart.keys().next().value;
        this._refPriceByStart.delete(firstKey);
      }
      this._refPriceByStart.set(key, ref);
    }
    return ref;
  }

  /** Latest 1m candles (oldest first). May be empty until first poll. */
  getKlines1m() {
    return this._klines1m;
  }

  /** Seconds since last successful kline fetch. Infinity if never. */
  getKlinesAgeSec() {
    if (!this._klinesUpdatedAt) return Infinity;
    return (Date.now() - this._klinesUpdatedAt) / 1000;
  }

  /**
   * Dynamic realized volatility (annualised) from log-returns of recent 1m closes.
   * Replaces the static `phi_sigma_5min` setting when klines are loaded.
   * Falls back to null if not enough data (caller uses settings.phi_sigma_5min).
   *
   * Returns sigma scaled to a 5-min window (not annualised), since that's what
   * PhiModel expects as `sigma5min` in its formula.
   */
  getDynamicSigma5min(lookback = 20) {
    const annualVol = BTCIndicators.realizedVol(this._klines1m, lookback, 60);
    if (annualVol == null || !Number.isFinite(annualVol) || annualVol <= 0) return null;
    const secondsPerYear = 365.25 * 24 * 60 * 60;
    return annualVol * Math.sqrt(300 / secondsPerYear);
  }

  /** Composite ATR/RSI/ADX/regime snapshot + raw indicators. */
  getIndicators(opts = {}) {
    return BTCIndicators.composite(this._klines1m, opts);
  }

  /** MACD(12,26,9) on 1m candles. */
  getMACD(fast = 12, slow = 26, signal = 9) {
    return BTCIndicators.macd(this._klines1m, fast, slow, signal);
  }

  /** Bollinger Bands(20, 2σ) on 1m candles. */
  getBollinger(period = 20, stdDev = 2) {
    return BTCIndicators.bollinger(this._klines1m, period, stdDev);
  }

  /** Volume spike vs `lookback` previous candles' mean. */
  getVolumeSpike(lookback = 5) {
    return BTCIndicators.volumeSpike(this._klines1m, lookback);
  }

  getPrice() {
    return this.price;
  }

  getLastKnownPrice() {
    return this.price || this._lastValidPrice || null;
  }

  getOrderBookImbalance() {
    if (!this.bidQty || !this.askQty) return 0;
    return (this.bidQty - this.askQty) / (this.bidQty + this.askQty);
  }

  getPriceHistory() {
    return this.priceHistory;
  }

  getPriceSecondsAgo(seconds) {
    const targetTime = Date.now() - seconds * 1000;
    for (let i = this.priceHistory.length - 1; i >= 0; i--) {
      if (this.priceHistory[i].timestamp <= targetTime) {
        return this.priceHistory[i].price;
      }
    }
    return this.priceHistory.length > 0 ? this.priceHistory[0].price : null;
  }

  getWindowDeltaScore(windowSeconds = 30) {
    const currentPrice = this.price;
    const pastPrice = this.getPriceSecondsAgo(windowSeconds);
    if (!currentPrice || !pastPrice || pastPrice === 0) return 0;
    return ((currentPrice - pastPrice) / pastPrice) * 100;
  }
}

module.exports = BinanceFeed;
