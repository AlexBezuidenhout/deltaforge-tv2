/**
 * BORG recon — asset-keyed price-feed facade.
 * Wraps BinanceRecon (multi-symbol WS), Coinbase and Hyperliquid public
 * reference networks behind one interface keyed by ASSET ('btc', 'eth', …,
 * 'hype'), driven by asset_config. The collector and markets code never touch
 * exchange symbols directly.
 */
const BinanceRecon = require('./binance');
const HyperliquidRecon = require('./hyper');
const CoinbaseRecon = require('./coinbase');

class Feeds {
  /** @param assets rows from asset_config (enabled_borg=true) */
  constructor(onGap, assets, options = {}) {
    this.assets = assets;
    this.byAsset = new Map(assets.map((a) => [a.asset, a]));
    const binanceSymbols = assets.filter((a) => a.price_source === 'binance' && a.binance_symbol).map((a) => a.binance_symbol);
    // Hyperliquid publishes all tracked coins. HYPE uses it as its primary
    // source; the remaining assets use it only as a separately received
    // reference network for H47-H51. Keep the mapping explicit so a venue
    // symbol can never be mistaken for a Polymarket asset key.
    this.hyperCoinByAsset = new Map(assets.map((asset) => [
      asset.asset,
      asset.hl_coin || String(asset.asset).toUpperCase(),
    ]));
    const assetByHyperCoin = new Map([...this.hyperCoinByAsset].map(([asset, coin]) => [coin, asset]));
    this.assetByHyperCoin = assetByHyperCoin;
    const hlCoins = [...new Set(this.hyperCoinByAsset.values())];
    this.binance = new BinanceRecon(onGap, binanceSymbols, {
      wal: options.binanceWal,
      onMarketEvent: options.onMarketEvent,
    });
    this.hyper = new HyperliquidRecon(onGap, hlCoins, {
      wal: options.hyperWal,
      onMarketEvent: (event) => options.onMarketEvent?.({
        ...event,
        asset: assetByHyperCoin.get(event.coin) || null,
      }),
    });
    // Independent public venue. It is a proxy for broad-market agreement,
    // never a claim that Coinbase equals the Chainlink resolver.
    const coinbaseProducts = Object.fromEntries(assets
      .filter((a) => a.price_source === 'binance')
      .map((a) => [a.asset, `${a.asset.toUpperCase()}-USD`]));
    this.coinbase = new CoinbaseRecon(onGap, coinbaseProducts, {
      wal: options.coinbaseWal,
      onMarketEvent: options.onMarketEvent,
    });
  }

  async connect() {
    this.hyper.start();
    const [binanceOk] = await Promise.all([
      this.binance.connect(),
      this.coinbase.connect(),
    ]);
    return binanceOk;
  }

  _route(asset) {
    const a = this.byAsset.get(asset);
    if (!a) return [null, null];
    return a.price_source === 'hyperliquid' ? [this.hyper, a.hl_coin] : [this.binance, a.binance_symbol];
  }

  getPrice(asset) { const [f, k] = this._route(asset); return f ? f.getPrice(k) : null; }
  freshPrice(asset, maxAgeMs = 3000) { const [f, k] = this._route(asset); return f ? f.freshPrice(k, maxAgeMs) : null; }
  getSigma5m(asset) { const [f, k] = this._route(asset); return f ? f.getSigma5m(k) : null; }
  getVolatilityProfile(asset, lookbackSec = 120) {
    const [f, k] = this._route(asset);
    return f?.getVolatilityProfile ? f.getVolatilityProfile(k, lookbackSec) : null;
  }
  getMicro(asset, lookbackSec = 10) {
    const [f, k] = this._route(asset);
    return f?.getMicro ? f.getMicro(k, lookbackSec) : null;
  }
  getReferencePrice(asset) { return this.coinbase.getPrice(asset); }
  getReferenceMicro(asset, lookbackSec = 10) { return this.coinbase.getMicro(asset, lookbackSec); }
  referenceStale(asset, maxAgeMs = 10000) { return this.coinbase.assetStale(asset, maxAgeMs); }
  getHyperliquidPrice(asset) {
    const coin = this.hyperCoinByAsset.get(asset);
    return coin ? this.hyper.getPrice(coin) : null;
  }
  getHyperliquidMicro(asset, lookbackSec = 10) {
    const coin = this.hyperCoinByAsset.get(asset);
    return coin ? this.hyper.getMicro(coin, lookbackSec) : null;
  }
  hyperliquidStale(asset, maxAgeMs = 10000) {
    const coin = this.hyperCoinByAsset.get(asset);
    return !coin || this.hyper.freshPrice(coin, maxAgeMs) == null;
  }

  /** Per-asset staleness — drives the shadow engine's §7 halt for that asset only. */
  assetStale(asset, maxAgeMs = 10000) {
    const a = this.byAsset.get(asset);
    if (!a) return true;
    return a.price_source === 'hyperliquid' ? this.hyper.isStale(maxAgeMs) : this.binance.isStale(maxAgeMs);
  }

  drainBars() { return [...this.binance.drainBars(), ...this.hyper.drainBars()]; }
  drainReferenceRows() { return this.coinbase.drainRows(); }
  drainExternalRows() {
    const coinbase = this.coinbase.drainExternalRows();
    const hyper = this.hyper.drainExternalRows();
    return {
      touches: [
        ...coinbase.touches,
        ...hyper.touches.map((row) => ({ ...row, asset: this.assetByHyperCoin.get(row.product) || null })),
      ],
      trades: [
        ...coinbase.trades,
        ...hyper.trades.map((row) => ({ ...row, asset: this.assetByHyperCoin.get(row.product) || null })),
      ],
    };
  }

  checkStale(maxAgeMs = 30000) {
    this.binance.checkStale(maxAgeMs);
    this.hyper.checkStale(maxAgeMs);
    this.coinbase.checkStale(maxAgeMs);
  }

  isStale(maxAgeMs = 10000) { return this.binance.isStale(maxAgeMs); }

  /** Heartbeat summary, e.g. 'binance ok, hyperliquid stale' */
  feedStatus() {
    const parts = [];
    if (this.binance.symbols.length) parts.push(this.binance.isStale() ? 'binance>10s' : null);
    if (this.hyper.coins.length) parts.push(this.hyper.isStale() ? 'hyperliquid>10s' : null);
    if (this.coinbase.products.length) parts.push(this.coinbase.isStale() ? 'coinbase>10s' : null);
    const stale = parts.filter(Boolean);
    return stale.length ? `STALE: ${stale.join(', ')}` : 'ok';
  }

  stop() {
    this.binance.stop();
    this.hyper.stop();
    this.coinbase.stop();
  }
}

module.exports = Feeds;
