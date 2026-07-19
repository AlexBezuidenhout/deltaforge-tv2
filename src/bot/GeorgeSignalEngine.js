/**
 * GeorgeSignalEngine — split-test signal model ("George" bot).
 *
 * Thesis under test (see IMPROVEMENTS.md and the 2026-07-10 audit): the main bot
 * models Binance spot, but Polymarket BTC 5-min markets RESOLVE on the Chainlink
 * BTC/USD feed. Chainlink only updates when spot moves ≥ the deviation threshold
 * (~0.5%) from its last print, or on the 3600s heartbeat. Near expiry that makes the
 * resolution print partly predictable in a way spot is not:
 *
 *   outcome = 1{ CL(end) > CL(open) }
 *
 *   P(UP) = P(update before end) · P(spot(end) > CL(open))        [update → print≈spot]
 *         + P(no update)         · 1{ CL(now) > CL(open) }        [no update → print=CL(now)]
 *
 *   P(update) ≈ P(spot path hits the deviation band before end)
 *             ≈ min(1, 2·(1 − Φ(d / σ_rem)))        (reflection principle, driftless)
 *             floored by remaining/3600 (heartbeat)
 *   d = relative distance from spot(now) to the NEAREST deviation-band edge around CL(now);
 *       d ≤ 0 (already outside the band) ⇒ P(update) = 1.
 *
 *   P(spot(end) > CL(open)) = Φ( (spot_now − CL_open) / (CL_open · σ_rem) )
 *   σ_rem = σ_5min · √(tte/300), σ_5min from an EWMA of Binance 1s tick returns
 *           (reacts to vol regime shifts in ~1 min, vs ~10 min for the 20×1m klines
 *            the main bot uses — audit hypothesis 4b).
 *
 * Differences from the main engine, all deliberate for a clean split test:
 *   - NO heuristic, NO ensemble: pure model probability. The audit showed the
 *     heuristic manufactures claimed EV mechanically (corr 0.33 with |btcΔ|, corr
 *     −0.01 with realized ROI).
 *   - Hard skip when CL(open) is unknown (we weren't watching the feed at window
 *     open). No fallback to Binance klines — a fallback would silently turn George
 *     back into the main bot.
 *   - Selectivity gates: edge floor AFTER costs, entry window, price band, vol floor.
 *
 * Paper-only companion: GeorgeBotInstance. Never places live orders.
 */

const PhiModel = require('./PhiModel');

const DEFAULTS = {
  deviationPct: 0.5,        // Chainlink BTC/USD mainnet deviation threshold (%)
  heartbeatSec: 3600,       // Chainlink heartbeat
  minEdge: 0.05,            // |p − price| floor AFTER costs (probability points)
  entryMinRemaining: 75,    // no entries later than this (jump risk)
  entryMaxRemaining: 300,   // no entries earlier than this before resolution
  minSigma5min: 0.0005,     // vol floor: below this the market is dead and spreads eat everything
  maxSigma5min: 0.02,       // vol ceiling: news-spike chaos, model assumptions break
  costBuffer: 0.03,         // entry slippage+penalty+fees in probability points (2 ticks + fee)
  priceBandLo: 0.10,        // tradeable market-price band
  priceBandHi: 0.90,
  ewmaLambda: 0.94,         // per-tick (~1s) EWMA decay: ~60s half-life ≈ ln2/(1−λ)
};

class GeorgeSignalEngine {
  constructor(polymarket, binance, chainlink, settings = {}) {
    this.polymarket = polymarket;
    this.binance = binance;
    this.chainlink = chainlink;
    this.settings = settings;
  }

  _cfg(key, settingName) {
    const raw = parseFloat(this.settings?.[settingName]);
    return Number.isFinite(raw) ? raw : DEFAULTS[key];
  }

  /**
   * EWMA σ scaled to a 5-min horizon, from Binance ~1s tick history.
   * Returns null if history is too short (<30 ticks) — callers must skip, not guess.
   */
  /** Multi-asset: per-asset feed maps. */
  setFeeds(feeds, chainlinks) { this.feeds = feeds; this.chainlinks = chainlinks; }

  ewmaSigma5min(feed = this.binance) {
    const hist = feed?.priceHistory || [];
    if (hist.length < 30) return null;
    const lambda = DEFAULTS.ewmaLambda;
    let ewmaVar = null;
    let prev = null;
    let dtSum = 0, dtN = 0;
    for (const h of hist) {
      if (prev != null && h.price > 0 && prev.price > 0) {
        const r = Math.log(h.price / prev.price);
        const dt = Math.max(0.2, (h.timestamp - prev.timestamp) / 1000);
        const varPerSec = (r * r) / dt; // normalize unequal tick spacing
        ewmaVar = ewmaVar == null ? varPerSec : lambda * ewmaVar + (1 - lambda) * varPerSec;
        dtSum += dt; dtN++;
      }
      prev = h;
    }
    if (ewmaVar == null || !(ewmaVar > 0)) return null;
    return Math.sqrt(ewmaVar * 300); // per-second variance → 5-min σ
  }

  /**
   * Core model. Pure function of feeds + market timing; exported pieces are static
   * for unit testing (see test/georgeModel.test.js).
   */
  static computeProbability({ spotNow, clNow, clOpen, sigma5min, remainingSec, deviationPct, heartbeatSec }) {
    if (![spotNow, clNow, clOpen, sigma5min].every((v) => Number.isFinite(v) && v > 0)) return null;
    if (!Number.isFinite(remainingSec) || remainingSec <= 0) return null;

    const sigmaRem = sigma5min * Math.sqrt(Math.max(0.5, remainingSec) / 300);
    if (!(sigmaRem > 0)) return null;

    // Distance (relative) from spot to the nearest deviation-band edge around CL(now).
    const band = deviationPct / 100;
    const rel = (spotNow - clNow) / clNow;
    const dToEdge = band - Math.abs(rel); // ≤0 ⇒ already beyond the band, update imminent

    let pUpdate;
    if (dToEdge <= 0) {
      pUpdate = 1;
    } else {
      // Reflection principle for a driftless diffusion: P(max |move| ≥ d) ≈ 2(1−Φ(d/σ)).
      // One-sided approximation toward the NEAREST edge; conservative for the far edge.
      pUpdate = Math.min(1, 2 * (1 - PhiModel.normalCdf(dToEdge / sigmaRem)));
    }
    // Heartbeat floor: an update lands anyway if the heartbeat expires inside the window.
    pUpdate = Math.max(pUpdate, Math.min(1, remainingSec / heartbeatSec));

    // If an update happens near the end, the final print tracks spot.
    const pUpGivenUpdate = PhiModel.normalCdf((spotNow - clOpen) / (clOpen * sigmaRem));
    // If no update, the final print IS clNow.
    const pUpGivenNoUpdate = clNow > clOpen ? 1 : clNow < clOpen ? 0 : 0.5;

    const pUp = pUpdate * pUpGivenUpdate + (1 - pUpdate) * pUpGivenNoUpdate;
    return {
      pUp: Math.min(0.999, Math.max(0.001, pUp)),
      pUpdate,
      pUpGivenUpdate,
      pUpGivenNoUpdate,
      sigmaRem,
      dToEdge,
    };
  }

  /**
   * Evaluate all active BTC 5-min markets. Returns the first TRADE signal or a SKIP
   * with the reason for the best candidate. `excludedMarketIds` = markets George
   * already holds/completed (Set of string ids).
   */
  async evaluate(excludedMarketIds = null) {
    const log = { ts: new Date().toISOString(), verdict: 'SKIP', reason: '', gates: {} };

    // Multi-asset (2026-07-12): spot/CL/σ checks are PER MARKET inside the
    // loop — a dead SOL feed must not block a BTC evaluation and vice versa.
    const feedsMap = this.feeds || { btc: this.binance };
    const clMap = this.chainlinks || { btc: this.chainlink };
    if (!Object.values(feedsMap).some((f) => f.getLastKnownPrice())) {
      return this._skip(log, 'No spot price on any asset feed');
    }
    const minSigma = this._cfg('minSigma5min', 'george_min_sigma');
    const maxSigma = this._cfg('maxSigma5min', 'george_max_sigma');

    const markets = await this.polymarket.fetchActiveBTCMarkets();
    if (!markets || markets.length === 0) return this._skip(log, 'No active BTC markets');

    const deviationPct = this._cfg('deviationPct', 'george_cl_deviation_pct');
    const heartbeatSec = DEFAULTS.heartbeatSec;
    const minEdge = this._cfg('minEdge', 'george_min_edge');
    const entryMin = this._cfg('entryMinRemaining', 'george_entry_min_remaining');
    const entryMax = this._cfg('entryMaxRemaining', 'george_entry_max_remaining');

    for (const market of markets) {
      const marketId = String(market.id || market.condition_id || '');
      if (!marketId) continue;
      if (excludedMarketIds && excludedMarketIds.has(marketId)) continue;

      const asset = market.asset || 'btc';
      const feed = feedsMap[asset];
      const cl = clMap[asset];
      if (!feed || !cl) continue; // asset not enabled for George (no CL anchor)
      const spotNow = feed.getLastKnownPrice();
      if (!spotNow) { log.reason = `[${asset}] no spot price`; continue; }
      const clNow = cl.getPrice();
      if (!Number.isFinite(clNow) || clNow <= 0) { log.reason = `[${asset}] no Chainlink price`; continue; }
      const clAgeSec = cl.lastUpdate ? (Date.now() - cl.lastUpdate.getTime()) / 1000 : Infinity;
      const sigma = this.ewmaSigma5min(feed);
      if (sigma == null) { log.reason = `[${asset}] EWMA σ warming up`; continue; }
      if (sigma < minSigma) { log.reason = `[${asset}] vol floor: σ5m=${sigma.toFixed(5)} < ${minSigma}`; continue; }
      if (sigma > maxSigma) { log.reason = `[${asset}] vol ceiling: σ5m=${sigma.toFixed(5)} > ${maxSigma}`; continue; }

      const endMs = market.end_date_iso ? new Date(market.end_date_iso).getTime() : NaN;
      const startMs = market.start_date_iso ? new Date(market.start_date_iso).getTime() : endMs - 300000;
      if (!Number.isFinite(endMs)) continue;
      const remaining = (endMs - Date.now()) / 1000;
      if (remaining < entryMin || remaining > entryMax) {
        log.reason = `Outside entry window: ${Math.round(remaining)}s remaining (want ${entryMin}–${entryMax}s)`;
        continue;
      }

      // Anchor: Chainlink price in force at window open. Unknown ⇒ hard skip.
      const clOpen = cl.getPriceAtMs(startMs);
      if (clOpen == null) {
        log.reason = `CL(open) unknown for market ${marketId.slice(0, 10)} — feed not observed at window open, skipping (no Binance fallback by design)`;
        continue;
      }

      // Market price (Gamma is the real price source for boundary-book 5-min markets).
      let clobIds = market.clobTokenIds;
      if (typeof clobIds === 'string') { try { clobIds = JSON.parse(clobIds); } catch (_) { clobIds = []; } }
      const yesTokenId = market.tokens?.[0]?.token_id || clobIds?.[0];
      const noTokenId = market.tokens?.[1]?.token_id || clobIds?.[1];
      if (!yesTokenId) continue;
      const yesPrice = await this.polymarket.getLivePriceFromGamma(marketId, yesTokenId).catch(() => null);
      if (yesPrice == null || !Number.isFinite(yesPrice)) {
        log.reason = 'No Gamma price';
        continue;
      }
      if (yesPrice < DEFAULTS.priceBandLo || yesPrice > DEFAULTS.priceBandHi) {
        log.reason = `Near-resolved price ${yesPrice.toFixed(3)} — no edge left`;
        continue;
      }

      const model = GeorgeSignalEngine.computeProbability({
        spotNow, clNow, clOpen, sigma5min: sigma, remainingSec: remaining, deviationPct, heartbeatSec,
      });
      if (!model) { log.reason = 'Model returned null (bad inputs)'; continue; }

      const rawEdge = model.pUp - yesPrice; // >0 ⇒ YES cheap, <0 ⇒ NO cheap
      const direction = rawEdge >= 0 ? 'YES' : 'NO';
      const cost = this._cfg('costBuffer', 'george_cost_buffer');
      const netEdge = Math.abs(rawEdge) - cost;

      const snapshot = {
        marketId,
        asset,
        question: market.question,
        direction,
        pUp: +model.pUp.toFixed(4),
        pUpdate: +model.pUpdate.toFixed(4),
        pUpGivenUpdate: +model.pUpGivenUpdate.toFixed(4),
        pUpGivenNoUpdate: model.pUpGivenNoUpdate,
        yesPrice: +yesPrice.toFixed(4),
        rawEdge: +rawEdge.toFixed(4),
        netEdge: +netEdge.toFixed(4),
        clOpen: +clOpen.toFixed(2),
        clNow: +clNow.toFixed(2),
        clAgeSec: Math.round(clAgeSec),
        spotNow: +spotNow.toFixed(2),
        divergenceBps: +(Math.abs(spotNow - clNow) / spotNow * 10000).toFixed(1),
        sigma5min: +sigma.toFixed(6),
        dToEdgeSigmas: model.sigmaRem > 0 ? +(model.dToEdge / model.sigmaRem).toFixed(2) : null,
        remainingSec: Math.round(remaining),
        yesTokenId,
        noTokenId,
        endMs,
      };

      if (netEdge < minEdge) {
        log.reason = `Edge ${netEdge.toFixed(3)} < floor ${minEdge} (p=${model.pUp.toFixed(3)} vs price=${yesPrice.toFixed(3)}, cost=${cost})`;
        log.lastSnapshot = snapshot;
        continue;
      }

      log.verdict = 'TRADE';
      log.reason = `George ${direction}: p(UP)=${model.pUp.toFixed(3)} vs price=${yesPrice.toFixed(3)}, netEdge=${netEdge.toFixed(3)}, pUpdate=${model.pUpdate.toFixed(2)}, CLopen=${clOpen.toFixed(0)} CLnow=${clNow.toFixed(0)} spot=${spotNow.toFixed(0)}`;
      return { verdict: 'TRADE', ...snapshot, log };
    }

    log.reason = log.reason || 'No market passed George gates';
    return { verdict: 'SKIP', log, lastSnapshot: log.lastSnapshot ?? null };
  }

  _skip(log, reason) {
    log.reason = reason;
    return { verdict: 'SKIP', log };
  }
}

module.exports = GeorgeSignalEngine;
module.exports.DEFAULTS = DEFAULTS;
