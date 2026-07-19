/**
 * BORG recon — market discovery, window boundary capture, resolution tracking.
 * MULTI-ASSET (2026-07-12): driven by asset_config (enabled_borg) — one
 * updown-5m market per asset per 5-min window (btc, eth, sol, doge, xrp,
 * bnb, hype).
 *
 * Discovery: Gamma slug lookup <prefix>-<epochSec> for the current and next
 * windows per asset. Full raw market JSON is stored — resolution rules live
 * in `description` and must stay auditable.
 *
 * Boundary capture: ref_open / ref_close are captured LIVE from the asset's
 * own feed at the window boundary (±1s tick), stored in the binance_* columns
 * (legacy names; the source feed is per-asset). If missed, healed from the
 * asset's Binance 5m kline, labeled — Hyperliquid-priced assets have no kline
 * to heal from and stay NULL (analysis must treat them accordingly).
 *
 * Resolution: after window_end, poll Gamma until outcomePrices collapses to
 * 0/1. Record the outcome and WHEN WE SAW IT (resolution latency matters).
 */
const { pool, logEvent } = require('./db');
const { selectResearchMarkets } = require('./research-universe');

const GAMMA = 'https://gamma-api.polymarket.com';

function buildResearchEventsUrl(now = Date.now()) {
  const url = new URL(`${GAMMA}/events`);
  const params = {
    tag_id: '21', active: 'true', closed: 'false', limit: '500',
    end_date_min: new Date(now - 2 * 3600_000).toISOString(),
    // A seven-day deterministic lookahead keeps the nearest daily threshold
    // and range ladders warm even when Gamma lists no contract inside 48h.
    // Selection still takes only the nearest expiry; this widens capture
    // availability, not the trading population based on realized PnL.
    end_date_max: new Date(now + 7 * 24 * 3600_000).toISOString(),
    // Gamma validates this against its response-field name. `end_date` is
    // rejected with HTTP 422 even though the range filters use snake_case.
    order: 'endDate', ascending: 'true',
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

async function fetchJson(url, timeoutMs = 5000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

class MarketsRecon {
  /**
   * @param feeds     Feeds facade (asset-keyed)
   * @param chainlink ChainlinkRecon (BTC mainnet control series only)
   * @param assets    asset_config rows with enabled_borg=true
   */
  constructor(feeds, chainlink, assets) {
    this.feeds = feeds;
    this.chainlink = chainlink;
    this.assets = assets;
    this.bySlug = new Map();        // slug -> market rec (in-memory mirror)
    this.gammaByAsset = new Map();  // asset -> { up, at } latest Gamma UP price
    this.gammaByMarket = new Map(); // market id -> positive-token Gamma price
    this.researchSelectedSlugs = new Set();
    this.researchSelectionMeta = null;
    this._lastResearchDiscoveryAt = 0;
  }

  windowEpoch(offset = 0) {
    return (Math.floor(Date.now() / 1000 / 300) + offset) * 300;
  }

  _slug(asset, epoch) {
    const a = this.assets.find((x) => x.asset === asset);
    return a ? `${a.slug_prefix}-${epoch}` : null;
  }

  /** Active market for one asset (or null). */
  active(asset = 'btc') {
    const slug = this._slug(asset, this.windowEpoch(0));
    return slug ? this.bySlug.get(slug) || null : null;
  }

  /** Active markets across all configured assets. */
  activeAll() {
    return this.assets.map((a) => this.active(a.asset)).filter(Boolean);
  }

  upcomingAll() {
    return this.assets
      .map((a) => this.bySlug.get(`${a.slug_prefix}-${this.windowEpoch(1)}`))
      .filter(Boolean);
  }

  /** Active bounded H22-H31/H45-H46 markets (hourly + frozen daily v2 panel). */
  activeResearch() {
    const now = Date.now();
    return [...this.researchSelectedSlugs]
      .map((slug) => this.bySlug.get(slug))
      .filter((rec) => rec && rec.accepting_orders !== false &&
        rec.window_start.getTime() <= now && rec.window_end.getTime() > now);
  }

  upcomingResearch() {
    const now = Date.now();
    return [...this.researchSelectedSlugs]
      .map((slug) => this.bySlug.get(slug))
      .filter((rec) => rec && rec.accepting_orders !== false && rec.window_start.getTime() > now);
  }

  /** Every market that should receive snapshots and shadow evaluation now. */
  evaluationAll() {
    const byId = new Map([...this.activeAll(), ...this.activeResearch()].map((rec) => [rec.id, rec]));
    return [...byId.values()];
  }

  evaluationForAsset(asset) {
    return this.evaluationAll().filter((rec) => rec.asset === asset);
  }

  marketForToken(assetId) {
    if (!assetId) return null;
    for (const rec of this.bySlug.values()) {
      if (rec.up_token_id === assetId || rec.down_token_id === assetId) return rec;
    }
    return null;
  }

  gammaUp(asset) {
    const g = this.gammaByAsset.get(asset);
    return g && Date.now() - g.at < 15000 ? g.up : null;
  }

  gammaPositive(market) {
    const g = this.gammaByMarket.get(market?.id);
    if (g && Date.now() - g.at < 15000) return g.value;
    return market?.market_type === 'direction_5m' ? this.gammaUp(market.asset) : null;
  }

  /** Discover current + next windows for every asset. Idempotent; ~10s cadence. */
  async discover() {
    for (const a of this.assets) {
      for (const offset of [0, 1]) {
        const epoch = this.windowEpoch(offset);
        const slug = `${a.slug_prefix}-${epoch}`;
        if (this.bySlug.has(slug)) continue;
        let rows;
        try {
          rows = await fetchJson(`${GAMMA}/markets?slug=${slug}`);
        } catch (err) {
          await logEvent('WARN', 'markets', `gamma discovery failed for ${slug}: ${err.message}`);
          continue;
        }
        const m = Array.isArray(rows) ? rows[0] : null;
        if (!m) continue;
        let tokenIds = m.clobTokenIds;
        if (typeof tokenIds === 'string') { try { tokenIds = JSON.parse(tokenIds); } catch (_) { tokenIds = []; } }
        let outcomes = m.outcomes;
        if (typeof outcomes === 'string') { try { outcomes = JSON.parse(outcomes); } catch (_) { outcomes = []; } }
        const upIdx = outcomes.findIndex((o) => /up/i.test(o));
        const downIdx = outcomes.findIndex((o) => /down/i.test(o));
        const rec = {
          slug,
          asset: a.asset,
          gamma_id: String(m.id ?? ''),
          condition_id: m.conditionId || null,
          question: m.question || null,
          window_start: new Date(epoch * 1000),
          window_end: new Date((epoch + 300) * 1000),
          up_token_id: tokenIds[upIdx >= 0 ? upIdx : 0] || null,
          down_token_id: tokenIds[downIdx >= 0 ? downIdx : 1] || null,
          market_type: 'direction_5m',
          timeframe_sec: 300,
          event_id: null,
          event_slug: null,
          strike: null,
          lower_bound: null,
          upper_bound: null,
          positive_label: 'UP',
          negative_label: 'DOWN',
          positive_outcome_index: upIdx >= 0 ? upIdx : 0,
          negative_outcome_index: downIdx >= 0 ? downIdx : 1,
          resolution_source: 'polymarket_crypto_5m',
          accepting_orders: m.acceptingOrders !== false && m.closed !== true,
          raw: m,
        };
        try {
          const res = await pool.query(
            `INSERT INTO borg_markets (slug, asset, gamma_id, condition_id, question, window_start, window_end,
               up_token_id, down_token_id, market_type, timeframe_sec, positive_label, negative_label,
               positive_outcome_index, negative_outcome_index, resolution_source, accepting_orders, raw)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
             ON CONFLICT (slug) DO UPDATE SET raw = EXCLUDED.raw, asset = EXCLUDED.asset,
               accepting_orders = EXCLUDED.accepting_orders
             RETURNING id, binance_open, binance_open_src, binance_close, binance_close_src,
               chainlink_open, outcome`,
            [rec.slug, rec.asset, rec.gamma_id, rec.condition_id, rec.question, rec.window_start,
             rec.window_end, rec.up_token_id, rec.down_token_id, rec.market_type, rec.timeframe_sec,
             rec.positive_label, rec.negative_label, rec.positive_outcome_index,
             rec.negative_outcome_index, rec.resolution_source, rec.accepting_orders, JSON.stringify(m)]
          );
          rec.id = res.rows[0].id;
          rec.binance_open = res.rows[0].binance_open == null ? null : parseFloat(res.rows[0].binance_open);
          rec.binance_open_src = res.rows[0].binance_open_src;
          rec.binance_close = res.rows[0].binance_close == null ? null : parseFloat(res.rows[0].binance_close);
          rec.binance_close_src = res.rows[0].binance_close_src;
          rec.chainlink_open = res.rows[0].chainlink_open == null ? null : parseFloat(res.rows[0].chainlink_open);
          rec.outcome = res.rows[0].outcome;
          this.bySlug.set(slug, rec);
          await logEvent('INFO', 'markets', `discovered ${slug} (id ${rec.id})`);
        } catch (err) {
          await logEvent('ERROR', 'markets', `insert failed for ${slug}: ${err.message}`);
        }
      }
    }
    await this._discoverResearch();
    // prune finished-and-resolved markets from memory (keep last 3 windows)
    const cutoff = this.windowEpoch(-3) * 1000;
    for (const [slug, rec] of this.bySlug) {
      if (rec.window_end.getTime() < cutoff && rec.outcome) this.bySlug.delete(slug);
    }
  }

  async _discoverResearch() {
    const now = Date.now();
    if (now - this._lastResearchDiscoveryAt < 30000) return;
    this._lastResearchDiscoveryAt = now;
    const url = buildResearchEventsUrl(now);

    let events;
    try {
      events = await fetchJson(url.toString(), 10000);
    } catch (err) {
      await logEvent('WARN', 'research_markets', `Gamma event discovery failed: ${err.message}`);
      return;
    }
    const configuredHourly = String(process.env.BORG_RESEARCH_HOURLY_ASSETS || 'btc,eth,sol,xrp')
      .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
    const configuredDaily = String(process.env.BORG_RESEARCH_DAILY_ASSETS || 'btc,eth,sol,xrp')
      .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
    const prices = Object.fromEntries(this.assets.map((asset) => [asset.asset, this.feeds.getPrice(asset.asset)]));
    const { selected, meta } = selectResearchMarkets(events, prices, now, {
      hourlyAssets: configuredHourly,
      dailyAssets: configuredDaily,
      dailyAsset: process.env.BORG_RESEARCH_DAILY_ASSET || undefined,
    });
    this.researchSelectedSlugs = new Set(selected.map((record) => record.slug));
    this.researchSelectionMeta = meta;

    for (const rec of selected) {
      const existed = this.bySlug.has(rec.slug);
      try {
        const { rows } = await pool.query(
          `INSERT INTO borg_markets (
             slug, asset, gamma_id, condition_id, question, window_start, window_end,
             up_token_id, down_token_id, market_type, timeframe_sec, event_id, event_slug,
             strike, lower_bound, upper_bound, positive_label, negative_label,
             positive_outcome_index, negative_outcome_index, resolution_source, accepting_orders, raw)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
           ON CONFLICT (slug) DO UPDATE SET
             raw=EXCLUDED.raw, accepting_orders=EXCLUDED.accepting_orders,
             event_id=EXCLUDED.event_id, event_slug=EXCLUDED.event_slug,
             strike=EXCLUDED.strike, lower_bound=EXCLUDED.lower_bound, upper_bound=EXCLUDED.upper_bound,
             positive_label=EXCLUDED.positive_label, negative_label=EXCLUDED.negative_label,
             positive_outcome_index=EXCLUDED.positive_outcome_index,
             negative_outcome_index=EXCLUDED.negative_outcome_index,
             resolution_source=EXCLUDED.resolution_source
           RETURNING id, binance_open, binance_open_src, binance_close, binance_close_src,
             chainlink_open, outcome`,
          [rec.slug, rec.asset, rec.gamma_id, rec.condition_id, rec.question,
            rec.window_start, rec.window_end, rec.up_token_id, rec.down_token_id,
            rec.market_type, rec.timeframe_sec, rec.event_id, rec.event_slug,
            rec.strike, rec.lower_bound, rec.upper_bound, rec.positive_label, rec.negative_label,
            rec.positive_outcome_index, rec.negative_outcome_index, rec.resolution_source,
            rec.accepting_orders, JSON.stringify(rec.raw)]
        );
        const row = rows[0];
        Object.assign(rec, {
          id: row.id,
          binance_open: row.binance_open == null ? null : parseFloat(row.binance_open),
          binance_open_src: row.binance_open_src,
          binance_close: row.binance_close == null ? null : parseFloat(row.binance_close),
          binance_close_src: row.binance_close_src,
          chainlink_open: row.chainlink_open == null ? null : parseFloat(row.chainlink_open),
          outcome: row.outcome,
        });
        this.bySlug.set(rec.slug, rec);
        if (!existed) await logEvent('INFO', 'research_markets',
          `discovered ${rec.market_type} ${rec.slug} (id ${rec.id})`, {
            asset: rec.asset, selected_daily_assets: meta.selectedDailyAssets,
          });
      } catch (err) {
        await logEvent('ERROR', 'research_markets', `insert failed for ${rec.slug}: ${err.message}`);
      }
    }
  }

  /**
   * Called every 1s tick — capture boundaries with the asset's OWN feed.
   * freshPrice() only: a frozen feed must never stamp a boundary as 'live'
   * (2026-07-11 incident — see repair-boundaries.js). Missed boundaries heal
   * from the asset's Binance 5m kline where one exists.
   */
  async captureBoundaries() {
    const now = Date.now();
    for (const rec of this.bySlug.values()) {
      const px = this.feeds.freshPrice(rec.asset, 2500);
      const startMs = rec.window_start.getTime();
      const endMs = rec.window_end.getTime();
      const isDirection = String(rec.market_type || 'direction_5m').startsWith('direction_');
      if (isDirection && rec.binance_open == null && now >= startMs) {
        if (now - startMs <= 3000 && px != null) {
          rec.binance_open = px;
          rec.binance_open_src = 'live';
        } else if (now - startMs > 3000) {
          rec.binance_open = await this._klineOpen(rec).catch(() => null);
          rec.binance_open_src = rec.binance_open != null ? 'kline_backfill' : null;
        }
        if (rec.binance_open != null) {
          const clOpen = rec.market_type === 'direction_5m' && rec.asset === 'btc'
            ? this.chainlink.getPriceAtMs(startMs) : null;
          rec.chainlink_open = clOpen;
          await pool.query(
            `UPDATE borg_markets SET binance_open=$1, binance_open_src=$2, chainlink_open=$3 WHERE id=$4`,
            [rec.binance_open, rec.binance_open_src, clOpen, rec.id]
          );
        }
      }
      const settlementDelayMs = isDirection ? 0 : 65000;
      if (rec.binance_close == null && now >= endMs + settlementDelayMs) {
        if (isDirection && now - endMs <= 3000 && px != null) {
          rec.binance_close = px;
          rec.binance_close_src = 'live';
        } else if ((isDirection && now - endMs > 8000) || (!isDirection && now >= endMs + settlementDelayMs)) {
          rec.binance_close = isDirection
            ? await this._klineClose(rec).catch(() => null)
            : await this._settlementClose(rec).catch(() => null);
          rec.binance_close_src = rec.binance_close != null ? 'kline_backfill' : null;
        }
        if (rec.binance_close != null) {
          await pool.query(
            'UPDATE borg_markets SET binance_close=$1, binance_close_src=$2 WHERE id=$3',
            [rec.binance_close, rec.binance_close_src, rec.id]
          );
        }
      }
    }
  }

  async backfillResolutions() {
    const { rows } = await pool.query(
      `SELECT id, slug, gamma_id, positive_label, negative_label,
              positive_outcome_index, negative_outcome_index
       FROM borg_markets
       WHERE outcome IS NULL AND gamma_id IS NOT NULL AND window_end < now() - interval '30 seconds'
       ORDER BY id LIMIT 50`
    );
    for (const r of rows) {
      try {
        const m = await fetchJson(`${GAMMA}/markets/${r.gamma_id}`);
        let prices = m?.outcomePrices;
        if (typeof prices === 'string') { try { prices = JSON.parse(prices); } catch (_) { prices = null; } }
        if (!Array.isArray(prices)) continue;
        const parsedPositiveIndex = parseInt(r.positive_outcome_index, 10);
        const parsedNegativeIndex = parseInt(r.negative_outcome_index, 10);
        const positiveIndex = Number.isInteger(parsedPositiveIndex) ? parsedPositiveIndex : 0;
        const negativeIndex = Number.isInteger(parsedNegativeIndex) ? parsedNegativeIndex : 1;
        const positive = parseFloat(prices[positiveIndex]);
        const negative = parseFloat(prices[negativeIndex]);
        if ((positive >= 0.99 && negative <= 0.01) || (positive <= 0.01 && negative >= 0.99)) {
          const outcome = positive >= 0.99 ? (r.positive_label || 'UP') : (r.negative_label || 'DOWN');
          await pool.query(
            `UPDATE borg_markets SET outcome=$1, outcome_prices=$2, resolved_at=now(), raw=$3 WHERE id=$4`,
            [outcome, JSON.stringify(prices), JSON.stringify(m), r.id]
          );
          const mem = this.bySlug.get(r.slug);
          if (mem) mem.outcome = outcome;
          await logEvent('INFO', 'markets', `${r.slug} resolved ${outcome} (backfill)`);
        }
      } catch (_) { /* transient — next backfill pass retries */ }
    }
  }

  async _klineOpen(rec) {
    if (rec.market_type === 'direction_1h' || rec.market_type === 'direction_15m') {
      // These windows are not aligned to any calendar candle interval; anchor
      // on the exact 1m candle at the true window start.
      const raw = await this._kline(rec.asset, rec.window_start.getTime(), '1m');
      const open = raw?.[1];
      return open != null ? parseFloat(open) : null;
    }
    const raw = await this._kline(rec.asset, rec.window_start.getTime(), '5m');
    const open = raw?.[1];
    return open != null ? parseFloat(open) : null;
  }

  async _klineClose(rec) {
    if (rec.market_type === 'direction_1h' || rec.market_type === 'direction_15m') {
      // Close of the final 1m candle inside the window, not a calendar candle.
      const raw = await this._kline(rec.asset, rec.window_end.getTime() - 60000, '1m');
      const close = raw?.[4];
      return close != null ? parseFloat(close) : null;
    }
    const raw = await this._kline(rec.asset, rec.window_start.getTime(), '5m');
    const close = raw?.[4];
    return close != null ? parseFloat(close) : null;
  }

  async _settlementClose(rec) {
    const raw = await this._kline(rec.asset, rec.window_end.getTime(), '1m');
    const close = raw?.[4];
    return close != null ? parseFloat(close) : null;
  }

  async _kline(asset, startMs, interval = '5m') {
    const a = this.assets.find((x) => x.asset === asset);
    if (!a || a.price_source !== 'binance' || !a.binance_symbol) return null; // no kline source (e.g. HYPE)
    const intervalMs = interval === '1h' ? 3600000 : interval === '1m' ? 60000 : 300000;
    const aligned = Math.floor(startMs / intervalMs) * intervalMs;
    const raw = await fetchJson(
      `https://api.binance.com/api/v3/klines?symbol=${a.binance_symbol}&interval=${interval}&limit=1&startTime=${aligned}`
    );
    return raw?.[0] || null;
  }

  /**
   * Poll Gamma for every active market's live price (5s cadence) and for
   * resolution of any ended, unresolved market.
   */
  async pollGamma() {
    for (const act of this.evaluationAll()) {
      try {
        const rows = await fetchJson(`${GAMMA}/markets?slug=${act.slug}`);
        const m = Array.isArray(rows) ? rows[0] : null;
        let prices = m?.outcomePrices;
        if (typeof prices === 'string') { try { prices = JSON.parse(prices); } catch (_) { prices = null; } }
        if (Array.isArray(prices)) {
          const positiveIndex = Number.isInteger(act.positive_outcome_index) ? act.positive_outcome_index : 0;
          const value = parseFloat(prices[positiveIndex]);
          if (Number.isFinite(value)) this.gammaByMarket.set(act.id, { value, at: Date.now() });
          if (act.market_type === 'direction_5m' && Number.isFinite(value)) {
            this.gammaByAsset.set(act.asset, { up: value, at: Date.now() });
          }
        }
      } catch (_) { /* transient */ }
    }
    // resolution polling for ended markets.
    // MUST use the by-id endpoint: `?slug=` returns [] once a market closes.
    for (const rec of this.bySlug.values()) {
      if (rec.outcome || !rec.gamma_id || Date.now() < rec.window_end.getTime() + 2000) continue;
      try {
        const m = await fetchJson(`${GAMMA}/markets/${rec.gamma_id}`);
        let prices = m?.outcomePrices;
        if (typeof prices === 'string') { try { prices = JSON.parse(prices); } catch (_) { prices = null; } }
        if (!Array.isArray(prices)) continue;
        const positiveIndex = Number.isInteger(rec.positive_outcome_index) ? rec.positive_outcome_index : 0;
        const negativeIndex = Number.isInteger(rec.negative_outcome_index) ? rec.negative_outcome_index : 1;
        const positive = parseFloat(prices[positiveIndex]);
        const negative = parseFloat(prices[negativeIndex]);
        if ((positive >= 0.99 && negative <= 0.01) || (positive <= 0.01 && negative >= 0.99)) {
          rec.outcome = positive >= 0.99 ? (rec.positive_label || 'UP') : (rec.negative_label || 'DOWN');
          await pool.query(
            `UPDATE borg_markets SET outcome=$1, outcome_prices=$2, resolved_at=now(), raw=$3 WHERE id=$4`,
            [rec.outcome, JSON.stringify(prices), JSON.stringify(m), rec.id]
          );
          await logEvent('INFO', 'markets', `${rec.slug} resolved ${rec.outcome}`, {
            binance_open: rec.binance_open, binance_close: rec.binance_close,
          });
        }
      } catch (_) { /* transient */ }
    }
  }
}

module.exports = MarketsRecon;
module.exports.buildResearchEventsUrl = buildResearchEventsUrl;
