const EVEngine = require('./EVEngine');
const MicrostructureEngine = require('./MicrostructureEngine');
const PhiModel = require('./PhiModel');
const SignalEnsemble = require('./SignalEnsemble');
const SlippageEngine = require('./SlippageEngine');

class GBMSignalEngine {
  constructor(polymarket, binance, chainlink, settings, priceFeed = null) {
    this.polymarket = polymarket;
    this.binance = binance;
    this.chainlink = chainlink;
    this.settings = settings;
    this.priceFeed = priceFeed; // real-time WS price feed (optional)
    this.evEngine = new EVEngine();
    this.microEngine = new MicrostructureEngine(); // btc / back-compat
    this._microByAsset = new Map([['btc', this.microEngine]]);
    this.feeds = null; // multi-asset: { asset: BinanceFeed } set via setFeeds()

    // EMA for BTC trend (used as confirmation, not primary signal)
    this.emaShort = null;
    this.emaLong = null;
    this.emaAlpha = 0.1;

    // Track signal timestamps for freshness
    this.lastSignalPrices = {}; // marketId -> { price, timestamp }

    // Single-source-of-truth price cache: Map<marketId, { smoothedPrice, priceSource, timestamp }>
    // Keyed ONLY by marketId. Cleared explicitly in clearMarket() — never reset per tick.
    this._priceCache = new Map();
  }

  // Adaptive EMA alpha based on seconds remaining in the 5-min window.
  // Higher alpha = faster reaction. Near expiry, price moves decisively toward 0/1
  // and we need to track it without lag.
  //   >120s: smooth aggressively (noise suppression is the priority)
  //   60–120s: moderate (balance noise vs signal)
  //   <60s: fast (resolution spike must propagate immediately)
  _adaptiveAlpha(remaining) {
    if (remaining == null || remaining > 120) return 0.25;
    if (remaining > 60) return 0.40;
    return 0.65;
  }

  // Smooth price using adaptive alpha. rawPrice is always stored separately so
  // callers can use it for PnL marking without smoothing-induced distortion.
  _smoothPrice(marketId, rawPrice, remaining) {
    // In the final 60s bypass EMA entirely — resolution price moves are real and
    // α=0.25 introduces ~12s lag that causes missed TP/SL exits near expiry.
    if (remaining != null && remaining <= 60) return rawPrice;
    const last = this._priceCache.get(marketId)?.smoothedPrice;
    if (!last) return rawPrice;
    const alpha = this._adaptiveAlpha(remaining);
    return (1 - alpha) * last + alpha * rawPrice;
  }

  // Sanity filter: reject implausible single-tick spikes from CLOB mid-price only.
  // Gamma outcomePrices are NOT filtered — a 10–15%+ Gamma jump is real market
  // consensus (news broke) and is the most valuable update we can receive.
  // CLOB mid threshold: 25% — anything larger is a data artifact, not a real move.
  _sanityCheck(marketId, rawPrice, priceSource) {
    if (priceSource === 'gamma') return rawPrice;
    const last = this._priceCache.get(marketId)?.smoothedPrice;
    if (!last) return rawPrice;
    return Math.abs(rawPrice - last) > 0.25 ? last : rawPrice;
  }

  /** Multi-asset: per-asset feed map ({btc: feed, eth: feed, ...}). */
  setFeeds(map) { this.feeds = map; }

  _microFor(asset) {
    const a = asset || 'btc';
    if (!this._microByAsset.has(a)) {
      this._microByAsset.set(a, new MicrostructureEngine());
    }
    return this._microByAsset.get(a);
  }

  updateEMA(price) {
    if (!price) return;
    if (this.emaShort === null) {
      this.emaShort = price;
      this.emaLong = price;
    } else {
      this.emaShort = this.emaAlpha * price + (1 - this.emaAlpha) * this.emaShort;
      this.emaLong = (this.emaAlpha / 2) * price + (1 - this.emaAlpha / 2) * this.emaLong;
    }
  }

  _buildLatencyArbSignal({
    market,
    marketId,
    direction,
    confidence,
    edge,
    yesPrice,
    rawYesPrice,
    yesTokenId,
    noTokenId,
    orderBook,
    micro,
    priceSource,
    remaining,
    elapsed,
    modelProb,
    log
  }) {
    const tokenId = direction === 'YES' ? yesTokenId : (noTokenId || yesTokenId);
    const evAdj = edge * 100;
    const evYes = (modelProb - yesPrice) * 100;
    const evNo = ((1 - modelProb) - (1 - yesPrice)) * 100;

    log.verdict = 'TRADE';
    log.reason = `LatencyArb ${direction}: edge=${(edge * 100).toFixed(1)}pp modelProb=${modelProb.toFixed(3)} yes=${yesPrice.toFixed(3)} remaining=${Math.round(remaining)}s`;

    return {
      verdict: 'TRADE',
      market,
      marketId,
      direction,
      scenario: 'LATENCY_ARB',
      confidence,
      evRaw: evAdj,
      evAdj,
      evYes,
      evNo,
      emaEdge: this.binance.getWindowDeltaScore(30),
      modelProb,
      modelProbSource: 'latency_arb',
      phi: null,
      ensemble: null,
      indicators: null,
      macd: null,
      bollinger: null,
      volumeSpike: null,
      slippage: null,
      depthUsd: null,
      oracleLagMs: null,
      entryPrice: direction === 'YES' ? yesPrice : (1 - yesPrice),
      fillProb: 1.0,
      tokenId,
      noTokenId: noTokenId || null,
      orderBook,
      microstructure: micro,
      costs: { spread: 0.01, estimatedSlippage: 0.005, takerFeeRate: 0.07 },
      log,
      yesPrice,
      rawPrice: rawYesPrice,
      noPrice: 1 - yesPrice,
      priceSource,
      timestamp: Date.now(),
      latencyArb: {
        enabled: true,
        edge,
        remainingSec: Math.round(remaining),
        elapsedSec: Math.round(elapsed)
      }
    };
  }

  /**
   * Main evaluation pipeline
   * 
   * Architecture:
   *   Pre-filters → Model Probability → EV (primary signal) → Confirmation → Trade
   * 
   * This is NOT a scalping bot. It trades on:
   *   - EV as primary signal
   *   - Market inefficiency (lag vs model)
   *   - Dynamic position flipping (YES ↔ NO)
   *   - Short-term probabilistic resolution
   */
  /**
   * @param {Set<string>|null} excludedMarketIds — markets to skip entirely (normalized
   *   string ids). BotInstance passes its one-cycle-per-market lock set so a market we
   *   already traded this window stops producing TRADE verdicts (decision-stream spam,
   *   audit §2.5) and stops burning order-book/Gamma calls.
   */
  async evaluate(excludedMarketIds = null) {
    const log = {
      timestamp: new Date().toISOString(),
      gates: {},
      verdict: 'SKIP',
      reason: ''
    };

    try {
      // Standalone mode: last ≤60s of window, buy the side quoted ≥99¢ at market (no EV/Φ gates).
      if (this.settings.simple_last_minute_mode === true) {
        return await this._evaluateSimpleLastMinute(log);
      }

      // --- Get current BTC data ---
      // Use last known price so a brief WebSocket drop doesn't block signal evaluation
      const btcPrice = this.binance.getLastKnownPrice();
      const chainlinkPrice = this.chainlink.getPrice();
      log.btcPrice = btcPrice;
      log.chainlinkPrice = chainlinkPrice;

      if (!btcPrice) {
        log.reason = 'No BTC price available from Binance';
        return { verdict: 'SKIP', log, marketId: null, market: null, yesPrice: null, rawPrice: null, noPrice: null, priceSource: null, timestamp: Date.now() };
      }

      this.updateEMA(btcPrice);

      // ── Resolution-source risk (audit Phase 2.2) ─────────────────────────────
      // Signals are computed from Binance, but Polymarket resolves on Chainlink.
      // Log the divergence on every evaluation (persisted per trade) so the
      // ev-autopsy can test whether losses cluster at high divergence. Optional
      // hard skip via max_oracle_divergence_bps (NULL = off, PROVISIONAL).
      let oracleDivergenceBps = null;
      if (Number.isFinite(chainlinkPrice) && chainlinkPrice > 0 && Number.isFinite(btcPrice) && btcPrice > 0) {
        oracleDivergenceBps = (Math.abs(btcPrice - chainlinkPrice) / btcPrice) * 10000;
      }
      log.oracleDivergenceBps = oracleDivergenceBps != null ? +oracleDivergenceBps.toFixed(1) : null;
      const maxDivBps = parseFloat(this.settings?.max_oracle_divergence_bps);
      if (Number.isFinite(maxDivBps) && oracleDivergenceBps != null && oracleDivergenceBps > maxDivBps) {
        log.gates.oracleDivergence = { divergenceBps: +oracleDivergenceBps.toFixed(1), maxDivBps, passed: false };
        log.reason = `Oracle divergence: |binance−chainlink|=${oracleDivergenceBps.toFixed(1)}bps > ${maxDivBps}bps — resolution anchor unreliable, skipping scan`;
        return { verdict: 'SKIP', log, marketId: null, market: null, yesPrice: null, rawPrice: null, noPrice: null, priceSource: null, timestamp: Date.now() };
      }

      // Pre-check delta before expensive per-market work (polybot-backend parity).
      // MULTI-ASSET (2026-07-12): the check is per asset feed — a flat BTC no
      // longer blocks an ETH move. Scan is skipped only when EVERY enabled
      // asset is flat; per-asset flat markets are skipped inside the loop.
      const minBtcDeltaPrecheck = parseFloat(this.settings?.min_btc_delta) || 0.015;
      const feedsMap = this.feeds || { btc: this.binance };
      const flatAssets = new Set();
      const deltasByAsset = {};
      for (const [asset, feed] of Object.entries(feedsMap)) {
        const d = feed.getWindowDeltaScore(60);
        deltasByAsset[asset] = d;
        if (Math.abs(d) < minBtcDeltaPrecheck) flatAssets.add(asset);
      }
      log.gates.btcPrecheck = { deltas: deltasByAsset, threshold: minBtcDeltaPrecheck, passed: flatAssets.size < Object.keys(feedsMap).length };
      if (flatAssets.size >= Object.keys(feedsMap).length) {
        log.reason = `Pre-check flat on all assets: max|delta| < ${minBtcDeltaPrecheck}% — skipping market scan`;
        return { verdict: 'SKIP', log, marketId: null, market: null, yesPrice: null, rawPrice: null, noPrice: null, priceSource: null, timestamp: Date.now() };
      }

      // --- Fetch active markets ---
      const markets = await this.polymarket.fetchActiveBTCMarkets();
      if (!markets || markets.length === 0) {
        log.reason = 'No active BTC markets found';
        return { verdict: 'SKIP', log, marketId: null, market: null, yesPrice: null, rawPrice: null, noPrice: null, priceSource: null, timestamp: Date.now() };
      }

      // --- Evaluate each market ---
      let lastMarket = null; // track last market seen so SKIP returns can include market context
      for (const market of markets) {
        lastMarket = market;
        const marketId = market.id || market.condition_id;
        log.reason = ''; // reset per-market so stale reasons don't bleed across iterations
        // Multi-asset: route to this market's own price feed; skip if its
        // asset has no feed (e.g. HYPE — enabled for BORG only) or is flat.
        const feed = feedsMap[market.asset || 'btc'];
        if (!feed) continue;
        if (flatAssets.has(market.asset || 'btc')) continue;
        const assetPrice = feed.getLastKnownPrice() || btcPrice;
        const microEng = this._microFor(market.asset);
        log.gates = {};  // reset gates per-market so prior market's gate state doesn't bleed into skip summary

        // One-cycle lock (from BotInstance): this window's position here already closed.
        // No re-entry is possible, so don't evaluate or emit signals for it at all.
        if (excludedMarketIds && marketId != null && excludedMarketIds.has(String(marketId))) {
          log.gates.cycleLock = { passed: false };
          log.reason = `Market ${String(marketId).slice(0, 12)} cycle complete — re-entry locked for this window`;
          continue;
        }

        // Gamma API returns clobTokenIds as a JSON string "[\"id1\",\"id2\"]" — must parse it
        // CLOB API returns tokens[].token_id — support both
        let clobIds = market.clobTokenIds;
        if (typeof clobIds === 'string') { try { clobIds = JSON.parse(clobIds); } catch(e) { clobIds = []; } }
        const yesTokenId = market.tokens?.[0]?.token_id || clobIds?.[0];
        const noTokenId  = market.tokens?.[1]?.token_id || clobIds?.[1];

        if (!yesTokenId) {
          console.warn(`[GBMSignalEngine] Market ${marketId} has no token IDs — skipping`);
          continue;
        }

        // ==========================================
        // STEP 1: GET REAL MARKET DATA
        // Price discovery — 4-source waterfall:
        //   0. WebSocket real-time price (sub-second, preferred)
        //   1. YES token CLOB order book (most direct)
        //   2. NO token CLOB order book  (token order may be inverted in API)
        //   3. Gamma API tokens[i].price (actual market price from last trade)
        // bid=0.01/ask=0.99 = boundary/resting liquidity only — not a real price.
        // ==========================================

        // Subscribe WS to this market's tokens (no-op if already subscribed)
        if (this.priceFeed && yesTokenId) {
          const toSub = [yesTokenId];
          if (noTokenId) toSub.push(noTokenId);
          this.priceFeed.subscribe(toSub);
        }

        // SOURCE 0: WebSocket live price — freshest possible, sub-second latency.
        // Only use if received within last 10s to avoid stale WS cache.
        let rawYesPrice = null;
        let priceSource = null;
        if (this.priceFeed) {
          const wsEntry = this.priceFeed.getPrice(yesTokenId);
          if (wsEntry && (Date.now() - wsEntry.timestamp) < 10000) {
            const wsPrice = wsEntry.price;
            if (wsPrice > 0.01 && wsPrice < 0.99) {
              rawYesPrice = wsPrice;
              priceSource = 'ws';
              console.log(`[GBMSignalEngine] WS source: yesPrice=${wsPrice.toFixed(3)} age=${((Date.now()-wsEntry.timestamp)/1000).toFixed(1)}s`);
            }
          }
          // Try NO token WS if YES not available
          if (rawYesPrice == null && noTokenId) {
            const wsNoEntry = this.priceFeed.getPrice(noTokenId);
            if (wsNoEntry && (Date.now() - wsNoEntry.timestamp) < 10000) {
              const wsNoPrice = wsNoEntry.price;
              if (wsNoPrice > 0.01 && wsNoPrice < 0.99) {
                rawYesPrice = 1 - wsNoPrice;
                priceSource = 'ws';
                console.log(`[GBMSignalEngine] WS source (NO token): noPrice=${wsNoPrice.toFixed(3)} yesPrice=${rawYesPrice.toFixed(3)}`);
              }
            }
          }
        }

        // Bug 1 fix: Gamma tokens[] objects don't carry .outcome or .price fields.
        // Use outcomePrices[] array for diagnostic prices, default outcomes to YES/NO.
        let op0 = market.outcomePrices;
        if (typeof op0 === 'string') { try { op0 = JSON.parse(op0); } catch(_) { op0 = null; } }
        const t0Price = op0 ? parseFloat(op0[0]) : undefined;
        const t1Price = op0 ? parseFloat(op0[1]) : undefined;
        console.log(`[Tokens] [0] outcome="YES" id=${yesTokenId?.slice(0,12)}... price=${t0Price} | [1] outcome="NO" id=${noTokenId?.slice(0,12)}... price=${t1Price}`);

        // Fetch YES book, NO book, and Gamma price all in parallel — don't wait for each
        // source sequentially. BTC 5-min markets almost always have boundary CLOB books
        // so we always need Gamma anyway; running in parallel cuts latency ~2×.
        // Skip HTTP fetches if WS already gave us a fresh price.
        const needsHttpPrice = rawYesPrice == null;
        const [yesBook, noBook, gammaYes] = await Promise.all([
          this.polymarket.getOrderBook(yesTokenId).catch(() => null),
          noTokenId ? this.polymarket.getOrderBook(noTokenId).catch(() => null) : Promise.resolve(null),
          needsHttpPrice ? this.polymarket.getLivePriceFromGamma(marketId, yesTokenId).catch(() => null) : Promise.resolve(null),
        ]);

        const yesSpread = yesBook?.spread ?? (yesBook ? yesBook.bestAsk - yesBook.bestBid : 1);
        console.log(`[OrderBook:YES] bid=${yesBook?.bestBid} ask=${yesBook?.bestAsk} mid=${yesBook?.midPrice} spread=${(yesSpread*100).toFixed(0)}% depth=${yesBook?.totalDepth?.toFixed(0)}`);
        if (noBook) {
          const noSpread = noBook?.spread ?? (noBook.bestAsk - noBook.bestBid);
          console.log(`[OrderBook:NO]  bid=${noBook?.bestBid} ask=${noBook?.bestAsk} mid=${noBook?.midPrice} spread=${(noSpread*100).toFixed(0)}% depth=${noBook?.totalDepth?.toFixed(0)}`);
        }

        // Signal price and executable liquidity are deliberately separate.
        // A last trade / Gamma probability is useful to the model, but it is
        // not an ask. The old synthetic {price±1 tick} object was later treated
        // as a real book and produced paper fills such as 0.52 while the CLOB
        // ask was 0.96. `orderBook` must therefore remain venue-sourced.
        let orderBook = yesBook || noBook;
        // Only apply CLOB price if WS didn't already give us one
        if (rawYesPrice == null) {
          rawYesPrice = (yesBook?.midPrice != null && yesSpread <= 0.10) ? yesBook.midPrice : null;
          priceSource = rawYesPrice != null ? 'clob' : null;
        }

        // Try NO token book if YES is boundary-only
        if (rawYesPrice == null && noBook) {
          const noSpread = noBook?.spread ?? (noBook.bestAsk - noBook.bestBid);
          if (noBook?.midPrice != null && noSpread <= 0.10) {
            rawYesPrice = 1 - noBook.midPrice;
            orderBook = noBook;
            priceSource = 'clob';
            console.log(`[GBMSignalEngine] YES book boundary-only — using NO book: noMid=${noBook.midPrice.toFixed(3)} yesPrice=${rawYesPrice.toFixed(3)}`);
          }
        }

        // SOURCE 3: Gamma live price (already fetched in parallel above).
        // BTC 5-min markets structurally show boundary CLOB books (bid=0.01/ask=0.99).
        // Execution uses a GTC limit order placed at Gamma price — how real fills happen.
        if (rawYesPrice == null) {
          if (gammaYes != null && isFinite(gammaYes) && gammaYes > 0.01 && gammaYes < 0.99) {
            rawYesPrice = gammaYes;
            priceSource = 'gamma';
            orderBook = yesBook || noBook;
            console.log(`[GBMSignalEngine] Gamma source (live): yesPrice=${gammaYes.toFixed(3)}`);
          } else {
            // Fallback: cached outcomePrices
            let op = market.outcomePrices;
            if (typeof op === 'string') { try { op = JSON.parse(op); } catch(_) { op = null; } }
            const cachedYes = op ? parseFloat(op[0]) : null;
            if (cachedYes != null && isFinite(cachedYes) && cachedYes > 0.01 && cachedYes < 0.99) {
              rawYesPrice = cachedYes;
              priceSource = 'gamma';
              orderBook = yesBook || noBook;
              console.log(`[GBMSignalEngine] Gamma source (cached): yesPrice=${cachedYes.toFixed(3)} outcomePrices=${JSON.stringify(op)}`);
            }
          }
        }

        if (rawYesPrice == null || !orderBook) {
          let op = market.outcomePrices;
          if (typeof op === 'string') { try { op = JSON.parse(op); } catch(_) { op = null; } }
          console.log(`[Gamma] outcomePrices=${JSON.stringify(op)} — no usable price from any source, skipping market`);
          continue;
        }

        log.polyYesPrice = rawYesPrice;
        log.polyNoPrice = 1 - rawYesPrice;

        // Rough seconds-remaining estimate — used for adaptive smoothing alpha and time gate.
        const roughRemaining = market.end_date_iso
          ? new Date(market.end_date_iso).getTime() / 1000 - Date.now() / 1000
          : 300;

        // Reject near-resolved prices: token settling to 0 or 1 — no edge remains.
        if (rawYesPrice >= 0.88 || rawYesPrice <= 0.12) {
          console.log(`[GBMSignalEngine] SKIP — near-resolved price: rawYesPrice=${rawYesPrice.toFixed(3)} (outside 0.12–0.88 range)`);
          continue;
        }

        // Sanity filter: CLOB mid only (Gamma passes through unfiltered).
        const sanitizedPrice = this._sanityCheck(marketId, rawYesPrice, priceSource);
        if (sanitizedPrice !== rawYesPrice) {
          console.log(`[GBMSignalEngine] Sanity filter (CLOB): rawPrice=${rawYesPrice.toFixed(3)} jumped >25% vs last=${this._priceCache.get(marketId)?.smoothedPrice?.toFixed(3)} — using last`);
        }

        // Adaptive EMA: faster near expiry so resolution spikes propagate without lag.
        const yesPrice = this._smoothPrice(marketId, sanitizedPrice, roughRemaining);

        // Commit smoothed price to cache (keyed by marketId, never tokenId).
        // rawYesPrice is preserved separately so _manageOpenPositions can use it
        // for PnL marking without smoothing-induced distortion.
        this._priceCache.set(marketId, { smoothedPrice: yesPrice, rawPrice: rawYesPrice, priceSource, timestamp: Date.now() });
        const alpha = this._adaptiveAlpha(roughRemaining);
        console.log(`[GBMSignalEngine] price: raw=${rawYesPrice.toFixed(3)} sanity=${sanitizedPrice.toFixed(3)} smoothed=${yesPrice.toFixed(3)} alpha=${alpha} src=${priceSource} remaining=${Math.round(roughRemaining)}s`);

        // Real spread from order book. Gamma-sourced markets carry the actual boundary spread
        // (~0.98) and will be blocked by the boundary book gate below.
        const rawSpread = orderBook.spread ?? (yesBook?.spread) ?? null;
        const spread = rawSpread ?? 0;

        // ==========================================
        // PRE-FILTER A: Signal Freshness
        // Check how old the last Binance tick is (WebSocket-based, not on-chain)
        // Chainlink on-chain BTC/USD updates every 5-30 min — too slow for a 20s threshold
        // ==========================================
        const lastTick = feed.priceHistory.length > 0
          ? feed.priceHistory[feed.priceHistory.length - 1].timestamp
          : 0;
        const lagAgeSeconds = lastTick > 0 ? (Date.now() - lastTick) / 1000 : 999;
        const maxLagAge = this.settings.stale_lag_seconds || 20;

        // Always record lagAge so avg_lag_age computes for ALL signals, not just stale ones
        log.gates.freshness = { lagAge: lagAgeSeconds, max: maxLagAge, passed: lagAgeSeconds <= maxLagAge };

        if (lagAgeSeconds > maxLagAge) {
          log.reason = `Stale BTC data: lag=${lagAgeSeconds.toFixed(1)}s > max=${maxLagAge}s`;
          continue;
        }

        // ==========================================
        // PRE-FILTER B: No-Chase Rule
        // If price moved significantly since we first spotted opportunity, skip
        // ==========================================
        const chaseThreshold = (this.settings.chase_threshold || 8) / 100; // Convert to decimal

        // Bug 2 fix: always update reference price BEFORE the chase check.
        // Old code only updated on pass, so a first-tick skip froze the reference price
        // and caused priceMove to stay identical every tick (permanent freeze).
        const prevSignal = this.lastSignalPrices[marketId];
        this.lastSignalPrices[marketId] = { price: yesPrice, timestamp: Date.now() };

        if (prevSignal) {
          const prevPrice = prevSignal.price;
          const priceMove = Math.abs(yesPrice - prevPrice);
          if (priceMove > chaseThreshold) {
            log.gates.chase = { priceMove, threshold: chaseThreshold, passed: false };
            log.reason = `Chase filter: price moved ${(priceMove*100).toFixed(1)}% > threshold ${(chaseThreshold*100).toFixed(1)}%`;
            continue;
          }
        }

        // ==========================================
        // STEP 2: MODEL PROBABILITY
        // Derive from microstructure + BTC trend
        // ==========================================

        // Record prices for latency detection
        microEng.recordPrices(assetPrice, yesPrice);

        // Gate 1 inputs must come from the REAL CLOB book. The synthetic price
        // objects built for WS/Gamma-sourced prices carry only totalDepth, so
        // imbalance/whale terms were permanently 0 and the saturated depth term
        // produced a constant 0.200 confidence on every Gamma-priced market.
        const microBook = (yesBook && yesBook.bidDepth != null) ? yesBook : orderBook;
        const microOrderCount = (microBook.bidCount ?? 0) + (microBook.askCount ?? 0);
        const micro = microEng.composite({
          btcPrice: assetPrice,
          polyPrice: yesPrice,
          bidSize: microBook.bidDepth,
          askSize: microBook.askDepth,
          largestBid: microBook.largestBid,
          largestAsk: microBook.largestAsk,
          totalDepth: microBook.totalDepth,
          avgOrderSize: (microBook.totalDepth > 0 && microOrderCount > 0) ? microBook.totalDepth / microOrderCount : 20,
          bestBid: microBook.bestBid,
          bestAsk: microBook.bestAsk
        });

        // ==========================================
        // MODEL PROBABILITY — ENSEMBLE (Φ + heuristic, mode B)
        // ==========================================
        // Two independent estimators are computed every tick and combined:
        //   pPhi   — closed-form Brownian-motion fair value (PhiModel)
        //   pHeur  — legacy yesPrice + btcEdge heuristic (kept from v2)
        //
        // SignalEnsemble.combine() blends them by weight, flags AGREE/DISAGREE,
        // and returns a confidenceMul applied to the final signalConfidence.
        // Both votes are recorded on the signal so the UI can show divergence.
        const btcDelta = feed.getWindowDeltaScore(60);
        log.btcDelta = btcDelta;
        log.yesPrice = yesPrice;

        // Window timing — needed by Φ for tte; reused later by time gates.
        const marketEndSec = market.end_date_iso
          ? new Date(market.end_date_iso).getTime() / 1000
          : (market.resolution_time || market.end_time || 0);
        const marketStartSec = market.start_date_iso
          ? new Date(market.start_date_iso).getTime() / 1000
          : (market.start_time || marketEndSec - 300);
        const nowSec = Date.now() / 1000;
        const elapsed = nowSec - marketStartSec;
        const remaining = marketEndSec - nowSec;

        // ==========================================
        // SCENARIO + HARD PRE-FILTERS (Printer CLOB v2 / polybot-backend parity)
        // Before Φ / ref-BTC fetch — cheaply skip no-trade regimes.
        // ==========================================
        const scenario = this._classifyScenario(btcDelta);
        log.scenario = scenario.type;

        const chopOverrideThreshold = parseFloat(this.settings?.range_chop_gamma_override) || 0.045;
        const gammaDisplacementPct = Math.abs(yesPrice - 0.5);
        const gammaOverridesChop = scenario.type === 'RANGE_CHOP' && gammaDisplacementPct >= chopOverrideThreshold;
        if (scenario.noTrade && !gammaOverridesChop) {
          log.gates.scenarioFilter = { type: scenario.type, passed: false };
          log.reason = `Scenario blocked: ${scenario.type}`;
          continue;
        }
        if (gammaOverridesChop) {
          log.scenario = 'RANGE_CHOP_GAMMA_OVERRIDE';
          log.gates.scenarioFilter = {
            type: scenario.type,
            passed: true,
            note: `Gamma disp=${gammaDisplacementPct.toFixed(3)} ≥ ${chopOverrideThreshold}`,
          };
        } else {
          log.gates.scenarioFilter = { type: scenario.type, passed: true };
        }

        const gammaPriceSignificant = Math.abs(yesPrice - 0.5) > 0.02;
        const minBtcDelta = parseFloat(this.settings?.min_btc_delta) || 0.015;
        if (Math.abs(btcDelta) < minBtcDelta && !gammaPriceSignificant) {
          log.gates.btcFlat = { btcDelta, minBtcDelta, yesPrice, passed: false };
          log.reason = `BTC flat: |delta|=${Math.abs(btcDelta).toFixed(3)}% < ${minBtcDelta}% and Gamma near 0.5`;
          continue;
        }

        const minStrongDelta = parseFloat(this.settings?.min_strong_btc_delta) || 0.05;
        if (Math.abs(yesPrice - 0.5) < 0.03 && Math.abs(btcDelta) < minStrongDelta) {
          log.gates.neutralBlock = { yesPrice, btcDelta, threshold: 0.03, minDelta: minStrongDelta, passed: false };
          log.reason = `Neutral market: yesPrice=${yesPrice.toFixed(3)} within 3% of 0.5 and BTC delta=${btcDelta.toFixed(3)}% < ${minStrongDelta}% — coin flip, skip`;
          continue;
        }

        // BTC indicators (ATR/RSI/ADX + dynamic σ) — null until klines warm up (~16 candles).
        const indicators = feed.getIndicators ? feed.getIndicators() : null;
        const klinesAgeSec = feed.getKlinesAgeSec ? feed.getKlinesAgeSec() : Infinity;
        const indicatorsReady = indicators && indicators.adx != null && indicators.rsi != null && klinesAgeSec < 120;
        if (indicators) {
          log.indicators = {
            atrPct: indicators.atrPct != null ? +(indicators.atrPct * 100).toFixed(4) : null,
            rsi: indicators.rsi != null ? +indicators.rsi.toFixed(1) : null,
            adx: indicators.adx != null ? +indicators.adx.toFixed(1) : null,
            plusDI: indicators.plusDI != null ? +indicators.plusDI.toFixed(1) : null,
            minusDI: indicators.minusDI != null ? +indicators.minusDI.toFixed(1) : null,
            trend: indicators.trend,
            regime: indicators.regime,
            realizedVol: indicators.realizedVol != null ? +indicators.realizedVol.toFixed(4) : null,
            klinesAgeSec: klinesAgeSec === Infinity ? null : Math.round(klinesAgeSec),
          };
        }
        const macdSnap = feed.getMACD ? feed.getMACD() : null;
        const bbSnap = feed.getBollinger ? feed.getBollinger() : null;
        const volSpike = feed.getVolumeSpike ? feed.getVolumeSpike(5) : null;
        if (macdSnap) log.macd = { line: +macdSnap.macd.toFixed(2), signal: +macdSnap.signal.toFixed(2), hist: +macdSnap.histogram.toFixed(2) };
        if (bbSnap) log.bb = { mid: +bbSnap.middle.toFixed(2), upper: +bbSnap.upper.toFixed(2), lower: +bbSnap.lower.toFixed(2), widthPct: bbSnap.bandWidthPct != null ? +bbSnap.bandWidthPct.toFixed(3) : null };
        if (volSpike) log.volumeSpike = { ratio: +volSpike.ratio.toFixed(2), bullish: btcDelta > 0 };

        // Dynamic σ: prefer rolling 5m σ from klines, fall back to static setting.
        let sigma5min = feed.getDynamicSigma5min ? feed.getDynamicSigma5min(20) : null;
        let sigmaSource = 'dynamic';
        if (sigma5min == null) {
          sigma5min = parseFloat(this.settings?.phi_sigma_5min) || PhiModel.DEFAULT_SIGMA_5MIN;
          sigmaSource = 'static';
        }

        // Φ-model probability — anchored to BTC price at market open.
        let refBtcPrice = null;
        let phi = null;
        const phiEnabled = this.settings?.phi_enabled !== false;
        if (phiEnabled) {
          try {
            refBtcPrice = await feed.getRefBtcPriceAt(marketStartSec);
          } catch (_) { refBtcPrice = null; }
          if (refBtcPrice != null && Number.isFinite(remaining)) {
            phi = PhiModel.evaluate({
              btcPrice: assetPrice,
              refPrice: refBtcPrice,
              ttseSec: remaining,
              sigma5min,
              windowSec: PhiModel.DEFAULT_WINDOW_SEC,
            });
          }
        }
        if (phi) {
          log.phi = {
            pUp: +phi.pUp.toFixed(4),
            z: Number.isFinite(phi.z) ? +phi.z.toFixed(3) : (phi.z > 0 ? '+Inf' : '-Inf'),
            refBtc: +refBtcPrice.toFixed(2),
            sigma5min: +sigma5min.toFixed(5),
            sigmaSource,
            tteSec: Math.max(0, Math.round(remaining)),
          };
        }

        // Optional alternate mode: Binance-vs-Polymarket latency arb check.
        // Disabled by default so the existing strategy remains unchanged.
        const latencyArbEnabled = this.settings?.latency_arb_enabled === true;
        if (latencyArbEnabled && phi) {
          const edgeThreshold = parseFloat(this.settings?.latency_arb_edge_pp) || 0.10;
          const precloseSec = parseInt(this.settings?.latency_arb_preclose_sec, 10) || 180;
          const slopeGuardSec = parseInt(this.settings?.latency_arb_slope_guard_sec, 10) || 30;
          const impliedProb = Math.min(0.99, Math.max(0.01, phi.pUp));
          const arbEdge = impliedProb - yesPrice;
          const absEdge = Math.abs(arbEdge);
          const slopeDelta = feed.getWindowDeltaScore(slopeGuardSec) || 0;
          const direction = arbEdge >= 0 ? 'YES' : 'NO';
          const slopeAligned = direction === 'YES' ? slopeDelta > 0 : slopeDelta < 0;
          const confidence = Math.min(0.99, Math.max(0.15, absEdge * 3));

          log.gates.latencyArb = {
            impliedProb,
            yesPrice,
            edge: arbEdge,
            edgeThreshold,
            absEdge,
            remaining: Math.round(remaining),
            precloseSec,
            slopeGuardSec,
            slopeDelta,
            slopeAligned,
            passed: absEdge >= edgeThreshold && remaining <= precloseSec && remaining > 0 && slopeAligned
          };

          if (absEdge >= edgeThreshold && remaining <= precloseSec && remaining > 0 && slopeAligned) {
            return this._buildLatencyArbSignal({
              market,
              marketId,
              direction,
              confidence,
              edge: absEdge,
              yesPrice,
              rawYesPrice,
              yesTokenId,
              noTokenId,
              orderBook,
              micro,
              priceSource,
              remaining,
              elapsed,
              modelProb: impliedProb,
              log
            });
          }

          log.reason = `LatencyArb SKIP: edge=${(absEdge * 100).toFixed(1)}pp need>${(edgeThreshold * 100).toFixed(1)}pp, remaining=${Math.round(remaining)}s<=${precloseSec}s, slope=${slopeDelta.toFixed(3)}%`;
          continue;
        }

        // Heuristic vote (kept from v2, lightly cleaned up).
        const btcEdge = Math.min(Math.abs(btcDelta) * 0.5, 0.15);
        const microEdge = micro.confidence * 0.10;
        const hasLag = micro.hasMarketLag;
        const totalEdge = btcEdge + microEdge;
        const gammaDisplacement = yesPrice - 0.5;
        const bullish = btcDelta > 0.02;
        const bearish = btcDelta < -0.02;
        const gammaBullish = !bullish && !bearish && gammaDisplacement > 0.02;
        const gammaBearish = !bullish && !bearish && gammaDisplacement < -0.02;

        let pHeur;
        if (bullish || gammaBullish) pHeur = Math.min(0.99, Math.max(0.01, yesPrice + totalEdge));
        else if (bearish || gammaBearish) pHeur = Math.max(0.01, Math.min(0.99, yesPrice - totalEdge));
        else pHeur = yesPrice;

        // Edge decomposition (audit Phase 3.3): persist each claimed-edge component
        // per signal so scripts/ev-autopsy.js can attribute losses to a component.
        // Note the structural property being tested: pHeur = yesPrice ± totalEdge means
        // the heuristic's claimed EV ≈ totalEdge − costs BY CONSTRUCTION, regardless of
        // whether the market is actually mispriced.
        log.edgeComponents = {
          btcEdge: +btcEdge.toFixed(5),
          microEdge: +microEdge.toFixed(5),
          hasLag,
        };

        // Ensemble combine: Φ × phiWeight + heuristic × (1 − phiWeight).
        const phiWeight = parseFloat(this.settings?.ensemble_phi_weight);
        const ensembleResult = SignalEnsemble.combine(phi ? phi.pUp : null, pHeur, {
          phiWeight: Number.isFinite(phiWeight) ? phiWeight : SignalEnsemble.PHI_WEIGHT_DEFAULT,
        });
        const modelProb = ensembleResult.modelProb;
        const modelProbSource = ensembleResult.modelProbSource;
        const ensembleVotes = ensembleResult.votes;
        const ensembleConfMul = ensembleResult.confidenceMul;
        log.ensemble = {
          source: modelProbSource,
          pPhi: ensembleVotes.phi != null ? +ensembleVotes.phi.toFixed(4) : null,
          pHeur: ensembleVotes.heuristic != null ? +ensembleVotes.heuristic.toFixed(4) : null,
          agreement: ensembleVotes.agreement,
          delta: ensembleVotes.delta != null ? +ensembleVotes.delta.toFixed(4) : null,
          confidenceMul: ensembleConfMul,
        };

        // ==========================================
        // GATE 1: MICROSTRUCTURE CONFIDENCE (informational — not a hard block)
        // Low confidence just means smaller edge, not a skip
        // Hard block would make Gate 1 impossible on thin books (confidence rarely reaches 0.45)
        // ==========================================
        const gate1Threshold = parseFloat(this.settings.gate1_threshold) || 0.45;

        log.gates.gate1 = {
          confidence: micro.confidence,
          threshold: gate1Threshold,
          hasLag: micro.hasMarketLag,
          passed: micro.confidence >= gate1Threshold  // informational only — Gate 2 EV is the real filter, no hard block here
        };

        // ==========================================
        // GATE 2: EV ANALYSIS (PRIMARY SIGNAL)
        // Spread is a COST COMPONENT, not a gate
        // ==========================================
        const costs = {
          spread: 0, // limit orders at mid — not crossing the spread, real cost is slippage + fees only
          estimatedSlippage: 0.005,
          takerFeeRate: 0.07
        };

        // marketEndSec / marketStartSec / nowSec / elapsed / remaining already
        // computed above (needed by Φ-model). Reused here without re-fetching.

        // TIME GATE: trade ONLY in the opening window OR the closing window.
        // Opening window: elapsed ≤ earlyWindowSec — fresh mispricing, widest spread.
        // Closing window: remaining ≤ lateWindowSec — resolution momentum, price locked in.
        // Middle period: skip — market is efficiently priced, no structural edge.
        //
        // For 5-min markets (300s): lateWindowSec=600 always covers the full window → always pass.
        // For 15-min+ markets: skip the middle unless in the first earlyWindowSec.
        // Configurable via settings.early_window_sec / late_window_sec (defaults: 100 / 600).
        // Skip pre-open markets (market hasn't started yet — elapsed < 0)
        if (elapsed < 0) {
          log.reason = `Pre-open: market starts in ${Math.round(-elapsed)}s — skip`;
          continue;
        }

        // Skip expired markets
        if (remaining <= 0) {
          log.reason = `Expired: market ended ${Math.round(-remaining)}s ago — skip`;
          continue;
        }

        // TIME GATE: only trade in the last 300s (5 min) of any market.
        // 5-min markets → always in window. 15-min+ → only last 5 min.
        const TRADE_WINDOW_SEC = 300;
        if (remaining > TRADE_WINDOW_SEC) {
          log.gates.timeGate = { remaining: Math.round(remaining), window: TRADE_WINDOW_SEC, passed: false };
          log.reason = `Outside trade window: ${Math.round(remaining)}s remaining > ${TRADE_WINDOW_SEC}s — wait for last 5 min`;
          continue;
        }
        log.gates.timeGate = { remaining: Math.round(remaining), window: TRADE_WINDOW_SEC, passed: true };

        // BOUNDARY BOOK GUARD: bid=0.01/ask=0.99 means no real liquidity at fair value.
        // Entry price must be near bestAsk — on a boundary book, bestAsk=0.99 is a ghost
        // resting order, NOT a fillable price. Never trade when spread >= 0.90.
        // Gamma may be used for signal generation only, never for execution or PnL.
        const isBoundaryBook = spread >= 0.90;
        if (isBoundaryBook) {
          log.gates.boundaryBook = { spread, passed: false };
          log.reason = `no_liquidity_boundary_book (spread=${(spread*100).toFixed(0)}%) — bestAsk=0.99 is a ghost order, not a real price`;
          continue;
        }
        log.gates.boundaryBook = { spread, passed: true };

        // DEPTH FLOOR — polybot-backend default 100 USDC; override via min_depth_usdc.
        const totalDepth = orderBook.totalDepth || 0;
        const depthFloor = parseFloat(this.settings?.min_depth_usdc);
        const effectiveDepthFloor = Number.isFinite(depthFloor) ? depthFloor : 100;
        if (totalDepth < effectiveDepthFloor) {
          log.gates.depth = { totalDepth, floor: effectiveDepthFloor, passed: false };
          log.reason = `Thin book: depth=${totalDepth.toFixed(0)} USDC < ${effectiveDepthFloor} min`;
          continue;
        }
        log.gates.depth = { totalDepth, floor: effectiveDepthFloor, passed: true };

        // Fill probability: spread-adjusted depth score for real CLOB books only.
        const spreadPenalty = Math.max(0, 1 - spread * 5);
        const fillProb = Math.min(1.0, (totalDepth / 500) * spreadPenalty);

        // ── NEW METRICS (informational unless explicit gate setting) ────────────
        // Slippage walker: simulate buying `slip_check_size_usd` at top-of-book.
        const slipCheckSize = parseFloat(this.settings?.slip_check_size_usd) || 5.0;
        let slipYes = null, slipNo = null;
        if (yesBook && Array.isArray(yesBook.askLevels)) {
          slipYes = SlippageEngine.estimate(yesBook.askLevels, slipCheckSize, 'buy');
        }
        if (noBook && Array.isArray(noBook.askLevels)) {
          slipNo = SlippageEngine.estimate(noBook.askLevels, slipCheckSize, 'buy');
        }
        log.slippage = {
          yes: slipYes ? { avgFill: slipYes.avgFillPrice != null ? +slipYes.avgFillPrice.toFixed(4) : null, slipBps: slipYes.slipBps != null ? +slipYes.slipBps.toFixed(1) : null, fillable: slipYes.fillable } : null,
          no: slipNo ? { avgFill: slipNo.avgFillPrice != null ? +slipNo.avgFillPrice.toFixed(4) : null, slipBps: slipNo.slipBps != null ? +slipNo.slipBps.toFixed(1) : null, fillable: slipNo.fillable } : null,
          sizeUsd: slipCheckSize,
        };
        log.depthUsd = {
          yes_bid: yesBook?.bestBidUsd != null ? +yesBook.bestBidUsd.toFixed(2) : null,
          yes_ask: yesBook?.bestAskUsd != null ? +yesBook.bestAskUsd.toFixed(2) : null,
          no_bid: noBook?.bestBidUsd != null ? +noBook.bestBidUsd.toFixed(2) : null,
          no_ask: noBook?.bestAskUsd != null ? +noBook.bestAskUsd.toFixed(2) : null,
        };

        // Oracle lag (Chainlink vs CEX/Binance) — informational; resolution is
        // by Chainlink so a stale oracle means our anchor is wrong.
        const oracleLagMs = this.chainlink && this.chainlink.getOracleLagMs
          ? this.chainlink.getOracleLagMs(Date.now())
          : null;
        log.oracleLagMs = oracleLagMs;

        // Evaluate BOTH sides — check EV directly against floor (no fillProb penalty)
        const evAnalysis = this.evEngine.evaluateBothSides(modelProb, yesPrice, costs);
        const evReal = evAnalysis.bestEV;

        let evFloor = parseFloat(this.settings.gate2_ev_floor) || 2.2;

        // Scenario 9: Cross-Market Lag — strongest edge, ease floor significantly
        if (scenario.type === 'LAG_EDGE') evFloor *= 0.65;

        // Scenario 1: Momentum Breakout — confirmed continuation, ease floor
        else if (scenario.type === 'MOMENTUM_BREAKOUT') evFloor *= 0.80;

        // Scenario 4: Volatility Expansion — trade with direction but require more conviction
        else if (scenario.type === 'VOLATILITY_EXPANSION') evFloor *= 0.90;

        // Scenario 2: Fake Breakout — price already reversed, tighten floor (only trade if EV is very clear)
        else if (scenario.type === 'FAKE_BREAKOUT') evFloor *= 1.50;

        // Lag detected (microstructure): high-priority execution, ease floor slightly
        if (hasLag && elapsed < 60) evFloor *= 0.8;

        // Fill quality — hard gate (polybot-backend parity: 25% floor by default).
        const fillProbFloor = parseFloat(this.settings?.fillprob_floor);
        const effFillProbFloor = Number.isFinite(fillProbFloor) ? fillProbFloor : 0.25;
        log.gates.fillProb = {
          fillProb,
          floor: effFillProbFloor,
          passed: fillProb >= effFillProbFloor,
        };
        if (fillProb < effFillProbFloor) {
          log.reason = `Low fill probability: ${(fillProb * 100).toFixed(0)}% (depth=${totalDepth.toFixed(0)} spread=${(spread * 100).toFixed(0)}%)`;
          continue;
        }

        log.gates.gate2 = {
          evYes: evAnalysis.evYes,
          evNo: evAnalysis.evNo,
          bestDirection: evAnalysis.bestDirection,
          bestEV: evAnalysis.bestEV,
          evReal,
          fillProb,
          evFloor,
          spread,
          modelProb,
          elapsed: Math.round(elapsed),
          remaining: Math.round(remaining),
          passed: evReal >= evFloor
        };

        console.log(`[GBMSignalEngine] Gate2: btcDelta=${btcDelta.toFixed(3)}% modelProb=${modelProb.toFixed(3)} yesPrice=${yesPrice.toFixed(3)} EV=${evAnalysis.bestEV.toFixed(2)}% fillProb=${(fillProb*100).toFixed(0)}% floor=${evFloor.toFixed(2)}% depth=${totalDepth.toFixed(0)} remaining=${Math.round(remaining)}s`);

        if (evReal < evFloor) {
          log.gates.gate2.passed = false;
          log.reason = `EV ${evReal.toFixed(2)}% below floor ${evFloor.toFixed(2)}%`;
          continue;
        }

        log.gates.gate2.passed = true;

        // EV BAND CEILING (PROVISIONAL, default off — ev_band_ceiling NULL).
        // Mechanism: in an efficient adversarial market, a 5-minute binary priced by
        // active market makers does not leave 15%+ of free EV lying around. A claimed
        // EV that high is far more likely a model error (stale σ, manufactured
        // heuristic edge) than an opportunity. Historical data agrees: the >15%
        // bucket was the biggest loser (32 trades, 41% wins, −$177).
        const evCeil = parseFloat(this.settings?.ev_band_ceiling);
        if (Number.isFinite(evCeil) && evReal > evCeil) {
          log.gates.evBand = { evReal, ceiling: evCeil, passed: false };
          log.reason = `EV ${evReal.toFixed(2)}% above ceiling ${evCeil.toFixed(2)}% — implausibly high claimed edge, treating as model error`;
          continue;
        }

        // ==========================================
        // EV TREND FILTER: velocity + acceleration
        // Bug 4 fix: recordEV() must come AFTER the decay/velocity checks.
        // Old code recorded the current tick first, so isEVDecaying() compared
        // current tick against itself — a single observation always appears flat
        // or decaying, blocking valid signals on the first pass.
        // ==========================================
        // EV trend filter: only block if EV is actively collapsing, not just ticking down.
        // Two conditions must BOTH be true to skip:
        //   1. isEVDecaying: velocity<0 AND acceleration<=0 (sustained deceleration)
        //   2. evVelocity drop exceeds absolute floor of 1.0% — prevents blocking a
        //      22%→21.9% move (noise) while still catching 10%→5%→2% collapse.
        const evVelocity = this.evEngine.getEVVelocity(marketId);
        // evTrend filter: only block on sustained, rapid EV collapse.
        // Raised default floor to 8.0 — BTC 5-min markets oscillate ±3-5% per tick
        // (boundary books + Gamma lag). A 3% drop is noise, not a collapse signal.
        // Only block when EV is both decaying AND drops >8% in a single tick.
        const evDecayRatio = parseFloat(this.settings?.ev_decay_ratio) || 8.0;
        const EV_VELOCITY_FLOOR = -1.0 * evDecayRatio;
        if (this.evEngine.isEVDecaying(marketId) && evVelocity < EV_VELOCITY_FLOOR) {
          log.gates.evTrend = { status: 'DECAYING', velocity: evVelocity.toFixed(2), floor: EV_VELOCITY_FLOOR, passed: false };
          log.reason = `EV collapsing: velocity=${evVelocity.toFixed(2)} < floor=${EV_VELOCITY_FLOOR}`;
          continue;
        }

        // Record EV now that checks passed — informs the NEXT tick's trend check
        this.evEngine.recordEV(marketId, evReal, evAnalysis.bestDirection);

        // ==========================================
        // GATE 3: BTC MOMENTUM DIRECTION CONFIRMATION (optional)
        // Uses btcDelta (30s window) — same signal driving EV, no lag.
        // Replaces slow EMA which had ~11min half-life and always conflicted
        // with short-term momentum signals on 5-min binary markets.
        // ==========================================
        const direction = evAnalysis.bestDirection;
        let emaEdge = btcDelta; // kept as emaEdge for return object compatibility

        if (this.settings.gate3_enabled !== false) {
          // btcDelta > 0 = BTC rising (bullish), < 0 = falling (bearish)
          const isBullish = btcDelta > 0;
          const minDelta = parseFloat(this.settings.gate3_min_delta) || 0.01;

          log.gates.gate3 = {
            btcDelta,
            minDelta,
            direction,
            passed: false
          };

          // When BTC signal is weak (|btcDelta| < minDelta), direction is unreliable —
          // skip the direction check and let EV gate decide. Gamma displacement already
          // priced a directional move in this case; blocking it here is over-filtering.
          const btcSignalWeak = Math.abs(btcDelta) < minDelta;

          if (!btcSignalWeak) {
            // Direction alignment: YES needs BTC rising, NO needs BTC falling
            if (direction === 'YES' && !isBullish) {
              log.gates.gate3 = { btcDelta, minDelta, direction, passed: false, reason: 'direction_mismatch' };
              log.reason = `Gate3 direction mismatch: signal=YES but BTC falling (delta=${btcDelta.toFixed(3)}%)`;
              continue;
            }
            if (direction === 'NO' && isBullish) {
              log.gates.gate3 = { btcDelta, minDelta, direction, passed: false, reason: 'direction_mismatch' };
              log.reason = `Gate3 direction mismatch: signal=NO but BTC rising (delta=${btcDelta.toFixed(3)}%)`;
              continue;
            }
          }

          log.gates.gate3.passed = true;
          log.gates.gate3.note = btcSignalWeak ? 'weak_btc_skipped_direction_check' : 'direction_confirmed';
        }

        // ==========================================
        // MACRO TREND FILTER — suppresses signals that fight a sustained BTC trend.
        // Uses a longer window (default 10 min) than Gate 3's 60-second delta.
        // If the macro trend strongly contradicts the signal direction, skip.
        // ==========================================
        const macroWindowSec = parseInt(this.settings?.macro_trend_window_sec, 10) || 600;
        const macroThresholdPct = parseFloat(this.settings?.macro_trend_threshold_pct) || 0.10;
        const macroTrend = feed.getWindowDeltaScore(macroWindowSec);
        const macroContradict =
          (direction === 'NO'  && macroTrend >  macroThresholdPct) ||
          (direction === 'YES' && macroTrend < -macroThresholdPct);
        if (macroContradict) {
          log.gates.macroTrend = { macroTrend, macroWindowSec, macroThresholdPct, direction, passed: false };
          log.reason = `Macro trend block: signal=${direction} but ${macroWindowSec}s BTC trend=${macroTrend.toFixed(3)}% — fighting sustained trend`;
          continue;
        }
        log.gates.macroTrend = { macroTrend, macroWindowSec, macroThresholdPct, direction, passed: true };

        // ==========================================
        // ALL GATES PASSED — GENERATE SIGNAL
        // ==========================================
        // entryPrice = token mid price (0–1) — used for Kelly market probability.
        // For YES: mid of YES token. For NO: 1 - YES mid (= NO token mid).
        // Do NOT use bestAsk/bestBid here — wide spreads on illiquid markets
        // make b=(1/entry)-1 collapse to ~0 and kill Kelly even on valid signals.
        const entryPrice = direction === 'YES' ? yesPrice : (1 - yesPrice);
        const tokenId = direction === 'YES' ? yesTokenId : (noTokenId || yesTokenId);

        // Entry price ceiling — avoid buying tokens already heavily priced in.
        // High-price entries (e.g. NO @ 0.79) have thin margin before the stop fires.
        const maxEntryPriceRaw = parseFloat(this.settings?.max_entry_price);
        const maxEntryPrice = Number.isFinite(maxEntryPriceRaw) && maxEntryPriceRaw > 0 ? maxEntryPriceRaw : 0.65;
        if (entryPrice > maxEntryPrice) {
          log.gates.entryPriceCeiling = { entryPrice, maxEntryPrice, direction, passed: false };
          log.reason = `Entry price ceiling: ${direction} token @ ${entryPrice.toFixed(3)} > max ${maxEntryPrice} — late entry, skip`;
          continue;
        }
        log.gates.entryPriceCeiling = { entryPrice, maxEntryPrice, direction, passed: true };

        // Signal quality confidence — reflects actual outcome predictors.
        const momentumScore   = Math.min(Math.abs(btcDelta) / 0.10, 1.0);
        const evScore         = Math.min(Math.max(0, evAnalysis.bestEV) / 15.0, 1.0);
        const convictionScore = Math.abs(modelProb - 0.5) * 2;
        const timeScore       = Math.min(remaining / 240, 1.0);
        const microScore      = micro.confidence || 0;
        let rawConfidence =
          momentumScore   * 0.45 +
          evScore         * 0.30 +
          convictionScore * 0.15 +
          timeScore       * 0.05 +
          microScore      * 0.05;

        // Scenario confidence adjustments
        if (scenario.type === 'LAG_EDGE')           rawConfidence = Math.min(1.0, rawConfidence * 1.20); // +20% on best edge
        if (scenario.type === 'MOMENTUM_BREAKOUT')  rawConfidence = Math.min(1.0, rawConfidence * 1.10); // +10%
        if (scenario.type === 'FAKE_BREAKOUT')      rawConfidence *= 0.70; // -30% on unreliable setup
        if (scenario.type === 'MEAN_REVERSION')     rawConfidence *= 0.85; // -15% on counter-trend

        // Ensemble multiplier — AGREE boosts confidence, DISAGREE cuts it.
        rawConfidence = Math.min(1.0, Math.max(0.0, rawConfidence * ensembleConfMul));

        const signalConfidence = parseFloat(rawConfidence.toFixed(3));

        // Confidence gate — skip if signal quality is too low (noise, not edge).
        // 0.42 fallback applies only when the setting is NULL/absent; a stored 0 is
        // honored (previous `|| 0.42` silently discarded an explicit 0).
        const confThreshRaw = parseFloat(this.settings?.min_confidence);
        const confidenceThreshold = Number.isFinite(confThreshRaw) ? confThreshRaw : 0.42;
        if (signalConfidence < confidenceThreshold) {
          log.gates.confidence = { value: signalConfidence, threshold: confidenceThreshold, passed: false };
          log.reason = `Low confidence: ${signalConfidence.toFixed(3)} < ${confidenceThreshold} — insufficient signal quality`;
          continue;
        }

        log.verdict = 'TRADE';
        log.reason = `EV-driven signal: ${direction} @ EV ${evAnalysis.bestEV.toFixed(2)}%, confidence=${signalConfidence.toFixed(3)}, modelProb=${modelProb.toFixed(3)}`;

        return {
          verdict: 'TRADE',
          market: market,
          marketId: marketId,
          direction: direction,
          scenario: scenario.type,
          confidence: signalConfidence,
          evRaw: this.evEngine.calculateRawEV(modelProb, yesPrice, direction),
          evAdj: evAnalysis.bestEV,
          evYes: evAnalysis.evYes,
          evNo: evAnalysis.evNo,
          emaEdge: emaEdge,
          modelProb: modelProb,
          modelProbSource: modelProbSource,
          phi: phi ? { pUp: phi.pUp, z: phi.z, refBtc: refBtcPrice, sigma5min, sigmaSource, tteSec: Math.max(0, Math.round(remaining)) } : null,
          ensemble: { source: modelProbSource, pPhi: ensembleVotes.phi, pHeur: ensembleVotes.heuristic, agreement: ensembleVotes.agreement, delta: ensembleVotes.delta, confidenceMul: ensembleConfMul },
          indicators: indicatorsReady ? indicators : null,
          macd: macdSnap || null,
          bollinger: bbSnap || null,
          volumeSpike: volSpike || null,
          slippage: log.slippage,
          depthUsd: log.depthUsd,
          oracleLagMs: oracleLagMs,
          oracleDivergenceBps: oracleDivergenceBps != null ? +oracleDivergenceBps.toFixed(1) : null,
          entryPrice: entryPrice,
          fillProb: fillProb,
          tokenId: tokenId,
          noTokenId: noTokenId || null,
          orderBook: orderBook,
          executionBooks: { yes: yesBook || null, no: noBook || null },
          microstructure: micro,
          costs: costs,
          log: log,
          // Single-source-of-truth price fields — BotInstance must use ONLY these.
          // yesPrice: smoothed — used for all decisions (EV, entries, exits, gates)
          // rawPrice: unsmoothed — used ONLY for PnL marking (more reactive to real moves)
          yesPrice: yesPrice,
          rawPrice: rawYesPrice,
          noPrice: 1 - yesPrice,
          priceSource: priceSource,
          timestamp: Date.now()
        };
      }

      // No market passed — log summary of what happened
      const gateNames = Object.keys(log.gates);
      const failedAt = gateNames.find(k => log.gates[k]?.passed === false) || 'all_markets_skipped';
      log.verdict = 'SKIP';
      log.reason = log.reason || 'No market passed all gates';
      log.skipDetail = failedAt;
      const lastMarketId = lastMarket ? (lastMarket.id || lastMarket.condition_id) : null;

      // Rich skip log: show exactly what blocked the best candidate market
      const skipCtx = {
        gate: failedAt,
        reason: log.reason,
        btcDelta: log.btcDelta != null ? `${log.btcDelta.toFixed(3)}%` : null,
        yesPrice: log.yesPrice != null ? log.yesPrice.toFixed(3) : null,
        evAdj: log.gates?.gate2?.bestEV != null ? `${log.gates.gate2.bestEV.toFixed(2)}%` : null,
        evFloor: log.gates?.gate2?.evFloor != null ? `${log.gates.gate2.evFloor.toFixed(2)}%` : null,
        confidence: log.gates?.gate1?.confidence != null ? log.gates.gate1.confidence.toFixed(3) : null,
        remaining: log.gates?.timeGate?.remaining != null ? `${log.gates.timeGate.remaining}s` : null,
        scenario: log.scenario || null,
      };
      // Filter nulls for cleaner output
      const skipCtxClean = Object.fromEntries(Object.entries(skipCtx).filter(([,v]) => v != null));
      console.log(`[GBMSignalEngine] SKIP [${failedAt}]`, JSON.stringify(skipCtxClean));

      return { verdict: 'SKIP', log, marketId: lastMarketId, market: lastMarket, yesPrice: null, rawPrice: null, noPrice: null, priceSource: null, timestamp: Date.now() };

    } catch (err) {
      console.error('[GBMSignalEngine] evaluate error:', err.message);
      log.verdict = 'ERROR';
      log.reason = `Evaluation error: ${err.message}`;
      return { verdict: 'ERROR', log, marketId: null, market: null, yesPrice: null, rawPrice: null, noPrice: null, priceSource: null, timestamp: Date.now() };
    }
  }

  /**
   * Classify the current BTC market regime into one of 10 scenarios.
   * Uses priceHistory (120 ticks, ~2 min) to detect structure.
   *
   * Returns: { type, noTrade, description }
   *
   * Scenarios mapped:
   *   MOMENTUM_BREAKOUT   — Scenario 1: strong push, no wick rejection
   *   FAKE_BREAKOUT       — Scenario 2: broke level then instantly reversed
   *   RANGE_CHOP          — Scenario 3: price stuck, no momentum → NO TRADE
   *   VOLATILITY_EXPANSION— Scenario 4: tight consolidation → sudden breakout
   *   WHALE_ABSORPTION    — Scenario 5: price refusing to move despite pressure
   *   MEAN_REVERSION      — Scenario 6: overextension, momentum slowing
   *   LATE_ENTRY          — Scenario 7: move already happened → NO TRADE (handled by chase filter upstream)
   *   MOMENTUM_FADE       — Scenario 8: trend weakening, smaller candles
   *   LAG_EDGE            — Scenario 9: Binance leads, Polymarket lags → best edge
   *   NEWS_SPIKE          — Scenario 10: instant chaotic spike → NO TRADE
   *   NORMAL              — no special regime, standard gate pipeline applies
   */
  _classifyScenario(btcDelta) {
    const history = this.binance?.priceHistory;
    if (!history || history.length < 10) return { type: 'NORMAL', noTrade: false };

    const recent = history.slice(-30);  // last 30 ticks (~30s)
    const prices = recent.map(h => h.price);
    const latest = prices[prices.length - 1];

    // Volatility: std deviation of last 30 ticks
    const mean = prices.reduce((s, p) => s + p, 0) / prices.length;
    const variance = prices.reduce((s, p) => s + Math.pow(p - mean, 2), 0) / prices.length;
    const stdDev = Math.sqrt(variance);
    const relStdDev = stdDev / mean; // normalised

    // Max range over last 30 ticks
    const hi = Math.max(...prices);
    const lo = Math.min(...prices);
    const range = (hi - lo) / mean;

    // Wick ratio: |high - close| / total range — proxy for rejection wick
    const open30 = prices[0];
    const bodySize = Math.abs(latest - open30) / mean;
    const upperWick = hi > Math.max(latest, open30) ? (hi - Math.max(latest, open30)) / mean : 0;
    const lowerWick = lo < Math.min(latest, open30) ? (Math.min(latest, open30) - lo) / mean : 0;
    const wickRatio = bodySize > 0 ? Math.max(upperWick, lowerWick) / (bodySize + 0.0001) : 0;

    // Velocity trend: compare first half vs second half delta
    const half = Math.floor(prices.length / 2);
    const firstHalfDelta = (prices[half] - prices[0]) / prices[0] * 100;
    const secondHalfDelta = (prices[prices.length - 1] - prices[half]) / prices[half] * 100;
    const fadingMomentum = Math.abs(secondHalfDelta) < Math.abs(firstHalfDelta) * 0.5;

    // Lag scenario: microstructure detects Polymarket lagging Binance
    // Checked externally — passed as btcDelta being strong with freshness passing
    const absbtcDelta = Math.abs(btcDelta);

    // Scenario 10: NEWS SPIKE — instant large chaotic move
    // >0.15% in 30s AND large wicks (chaotic) OR very high volatility
    if (absbtcDelta > 0.15 && (wickRatio > 1.5 || relStdDev > 0.0015)) {
      return { type: 'NEWS_SPIKE', noTrade: true, description: `Chaotic spike: Δ${btcDelta.toFixed(3)}% wick=${wickRatio.toFixed(2)} vol=${relStdDev.toFixed(5)}` };
    }

    // Scenario 3: RANGE CHOP — very low range, no direction
    // <0.02% range in 30s AND btcDelta tiny — truly flat, no signal
    if (range < 0.0002 && absbtcDelta < 0.008) {
      return { type: 'RANGE_CHOP', noTrade: true, description: `Range chop: range=${(range*100).toFixed(4)}% Δ=${btcDelta.toFixed(3)}%` };
    }

    // Scenario 2: FAKE BREAKOUT — broke out then reversed with rejection wick
    // Large initial move but now reversing, significant wick against direction
    const reversing = (btcDelta > 0 && secondHalfDelta < -0.01) ||
                      (btcDelta < 0 && secondHalfDelta > 0.01);
    if (reversing && wickRatio > 1.2 && absbtcDelta > 0.04) {
      return { type: 'FAKE_BREAKOUT', noTrade: false, description: `Fake breakout: reversal detected wick=${wickRatio.toFixed(2)} 2ndΔ=${secondHalfDelta.toFixed(3)}%` };
    }

    // Scenario 9: LAG EDGE — strong BTC move + microstructure lag (best edge)
    // Detected upstream by hasLag; here we just check BTC is strongly directional
    if (absbtcDelta > 0.05 && !fadingMomentum && wickRatio < 0.8) {
      return { type: 'LAG_EDGE', noTrade: false, description: `Lag edge candidate: Δ=${btcDelta.toFixed(3)}% clean momentum` };
    }

    // Scenario 1: MOMENTUM BREAKOUT — strong clean directional move, low wicks
    if (absbtcDelta > 0.03 && wickRatio < 0.6 && !fadingMomentum) {
      return { type: 'MOMENTUM_BREAKOUT', noTrade: false, description: `Momentum breakout: Δ=${btcDelta.toFixed(3)}% wick=${wickRatio.toFixed(2)}` };
    }

    // Scenario 4: VOLATILITY EXPANSION — was compressed, now expanding
    const prevRange = history.length >= 60
      ? (() => { const p = history.slice(-60, -30).map(h => h.price); return (Math.max(...p) - Math.min(...p)) / p[0]; })()
      : range;
    if (range > prevRange * 2.0 && absbtcDelta > 0.02) {
      return { type: 'VOLATILITY_EXPANSION', noTrade: false, description: `Vol expansion: range=${(range*100).toFixed(4)}% vs prev=${(prevRange*100).toFixed(4)}%` };
    }

    // Scenario 8: MOMENTUM FADE — trend losing strength
    if (fadingMomentum && absbtcDelta > 0.02) {
      return { type: 'MOMENTUM_FADE', noTrade: false, description: `Momentum fade: 1stΔ=${firstHalfDelta.toFixed(3)}% → 2ndΔ=${secondHalfDelta.toFixed(3)}%` };
    }

    // Scenario 6: MEAN REVERSION — overextended, wicks forming
    if (absbtcDelta > 0.08 && wickRatio > 0.9) {
      return { type: 'MEAN_REVERSION', noTrade: false, description: `Mean reversion setup: Δ=${btcDelta.toFixed(3)}% wick=${wickRatio.toFixed(2)}` };
    }

    // Scenario 5: WHALE ABSORPTION — price barely moving despite BTC pressure (handled by low btcDelta + micro)
    // Falls through to NORMAL — microstructure engine detects whale patterns separately

    return { type: 'NORMAL', noTrade: false };
  }

  /**
   * Bug 3: Clear per-market state when a market resolves/expires.
   * Prevents lastSignalPrices and EVEngine history from leaking into
   * the next window that reuses the same marketId.
   */
  clearMarket(marketId) {
    delete this.lastSignalPrices[marketId];
    this._priceCache.delete(marketId);
    this.evEngine.clearMarket(marketId);
  }

  /**
   * Simple mode: enter only in the final 60s before market end, when the winning side
   * is priced ≥ 0.99 (ask or Gamma). Market buy at current book / mid (handled in BotInstance).
   */
  async _evaluateSimpleLastMinute(log) {
    const ASK_MIN = 0.99;
    const REMAINING_MAX = 60;
    const REMAINING_MIN = 2; // avoid racing the resolver

    const markets = await this.polymarket.fetchActiveBTCMarkets();
    if (!markets || markets.length === 0) {
      log.reason = 'Simple mode: no active BTC markets';
      return { verdict: 'SKIP', log, marketId: null, market: null, yesPrice: null, rawPrice: null, noPrice: null, priceSource: null, timestamp: Date.now() };
    }

    for (const market of markets) {
      const marketId = market.id || market.condition_id;
      log.reason = '';
      log.gates = {};

      const endMs = market.end_date_iso ? new Date(market.end_date_iso).getTime() : NaN;
      if (!Number.isFinite(endMs)) continue;
      const remaining = (endMs - Date.now()) / 1000;
      if (remaining > REMAINING_MAX || remaining <= REMAINING_MIN) continue;

      let clobIds = market.clobTokenIds;
      if (typeof clobIds === 'string') {
        try {
          clobIds = JSON.parse(clobIds);
        } catch (_) {
          clobIds = [];
        }
      }
      const yesTokenId = market.tokens?.[0]?.token_id || clobIds?.[0];
      const noTokenId = market.tokens?.[1]?.token_id || clobIds?.[1];
      if (!yesTokenId) continue;

      if (this.priceFeed && yesTokenId) {
        const toSub = [yesTokenId];
        if (noTokenId) toSub.push(noTokenId);
        this.priceFeed.subscribe(toSub);
      }

      const [yesBook, noBook, gammaYes] = await Promise.all([
        this.polymarket.getOrderBook(yesTokenId).catch(() => null),
        noTokenId ? this.polymarket.getOrderBook(noTokenId).catch(() => null) : Promise.resolve(null),
        this.polymarket.getLivePriceFromGamma(marketId, yesTokenId).catch(() => null),
      ]);

      const yesAsk = yesBook?.bestAsk != null ? parseFloat(yesBook.bestAsk) : null;
      const noAsk = noBook?.bestAsk != null ? parseFloat(noBook.bestAsk) : null;
      const gYes = gammaYes != null && Number.isFinite(gammaYes) ? gammaYes : null;

      let direction = null;
      if (gYes != null && gYes >= ASK_MIN) direction = 'YES';
      else if (gYes != null && gYes <= 1 - ASK_MIN) direction = 'NO';
      else if (yesAsk != null && yesAsk >= ASK_MIN && (noAsk == null || noAsk < ASK_MIN)) direction = 'YES';
      else if (noAsk != null && noAsk >= ASK_MIN && (yesAsk == null || yesAsk < ASK_MIN)) direction = 'NO';
      else if (yesAsk != null && yesAsk >= ASK_MIN && noAsk != null && noAsk >= ASK_MIN) {
        direction = yesAsk >= noAsk ? 'YES' : 'NO';
      }

      if (!direction) continue;

      const rawYes =
        gYes != null && Number.isFinite(gYes)
          ? gYes
          : direction === 'YES'
            ? yesAsk ?? 0.99
            : 1 - (noAsk ?? 0.99);
      const yesPrice = Math.min(0.999, Math.max(0.001, rawYes));
      let orderBook = yesBook;
      let priceSource = 'clob';
      if (direction === 'NO' && noBook) orderBook = noBook;
      if (gYes != null && Number.isFinite(gYes)) {
        priceSource = 'gamma';
        orderBook = {
          midPrice: gYes,
          bestAsk: direction === 'YES' ? Math.min(0.99, gYes + 0.01) : Math.min(0.99, 1 - gYes + 0.01),
          bestBid: direction === 'YES' ? Math.max(0.01, gYes - 0.01) : Math.max(0.01, 1 - gYes - 0.01),
          spread: 0.02,
          totalDepth: yesBook?.totalDepth || 0,
        };
      }

      this._priceCache.set(marketId, {
        smoothedPrice: yesPrice,
        rawPrice: rawYes,
        priceSource,
        timestamp: Date.now(),
      });

      const tokenId = direction === 'YES' ? yesTokenId : (noTokenId || yesTokenId);
      log.verdict = 'TRADE';
      log.reason = `Simple last minute: ${direction} remaining=${Math.round(remaining)}s yesAsk=${yesAsk ?? 'n/a'} noAsk=${noAsk ?? 'n/a'} gamma=${gYes ?? 'n/a'}`;
      log.gates.simpleLastMinute = { remainingSec: Math.round(remaining), yesAsk, noAsk, gammaYes: gYes };

      return {
        verdict: 'TRADE',
        simpleLastMinute: true,
        market,
        marketId,
        direction,
        scenario: 'SIMPLE_LAST_MINUTE',
        confidence: 0.99,
        evRaw: 0,
        evAdj: 0,
        evYes: 0,
        evNo: 0,
        emaEdge: 0,
        // modelProb is always P(YES), regardless of the selected token.
        modelProb: yesPrice,
        modelProbSource: 'simple_last_minute',
        phi: null,
        ensemble: null,
        indicators: null,
        macd: null,
        bollinger: null,
        volumeSpike: null,
        slippage: null,
        depthUsd: null,
        oracleLagMs: null,
        entryPrice: direction === 'YES' ? yesPrice : 1 - yesPrice,
        fillProb: 1,
        tokenId,
        noTokenId: noTokenId || null,
        orderBook,
        executionBooks: { yes: yesBook || null, no: noBook || null },
        microstructure: {},
        costs: { spread: 0.01, estimatedSlippage: 0.005, takerFeeRate: 0.07 },
        log,
        yesPrice,
        rawPrice: rawYes,
        noPrice: 1 - yesPrice,
        priceSource,
        timestamp: Date.now(),
      };
    }

    log.verdict = 'SKIP';
    log.reason = `Simple last minute: no market in ≤${REMAINING_MAX}s with YES/NO ≥ ${ASK_MIN}`;
    return { verdict: 'SKIP', log, marketId: null, market: null, yesPrice: null, rawPrice: null, noPrice: null, priceSource: null, timestamp: Date.now() };
  }

  /**
   * Estimate lag age between Chainlink and Binance
   * Returns seconds of estimated lag
   */
  _getLagAge(chainlinkPrice, binancePrice) {
    if (!chainlinkPrice || !binancePrice) return 0;

    // Price divergence as proxy for lag
    const divergence = Math.abs(chainlinkPrice - binancePrice) / binancePrice;

    // Rough estimate: 0.1% divergence ≈ 5-10 seconds of lag
    // This is a heuristic — real lag tracking would use timestamps
    if (this.chainlink.lastUpdate) {
      return (Date.now() - this.chainlink.lastUpdate.getTime()) / 1000;
    }

    return divergence > 0.005 ? 30 : 0; // >0.5% divergence = likely stale
  }
}

module.exports = GBMSignalEngine;
