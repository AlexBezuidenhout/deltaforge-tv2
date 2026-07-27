/**
 * BORG shadow strategies — PILOT parameters (NOT frozen; see engine.js).
 *
 * Only theses with a live path to a BUILD verdict get a shadow module:
 *   A_maker       — two-sided quoting around Φ-fair (Thesis A)
 *   D_consistency — buy both sides when ask_UP + ask_DOWN < $1 − buffer (Thesis D)
 *   F_yield       — final-minute near-certainty buy, registered to be ATTACKED (Thesis F)
 * B is a calibration question (Q3), C is pre-registered dead, E folds into A's
 * event analysis — none of them logs shadow orders.
 *
 * Contract: evaluate(ctx, engine) returns shadow actions; it must never place
 * a real order (there is no code path to one) and must be cheap — it runs
 * inside the collector's 1s tick.
 */
const ShadowEngine = require('./engine');
const makeV3Strategies = require('./research-v3');
const makeV4Strategies = require('./research-v4');
const makeV5Strategies = require('./research-v5');
const makeV6Strategies = require('./research-v6');
const makeV7Strategies = require('./research-v7');
const makeV8Strategies = require('./research-v8');
const makeV9Strategies = require('./research-v9');
const makeV10Strategies = require('./research-v10');
const makeH52Strategies = require('./research-h52');
const makeH53Strategies = require('./research-h53');
const makeMainV2Strategies = require('./main-v2');
const makeMainV3Strategies = require('./main-v3');
const makeMainV4Strategies = require('./main-v4');
const { EthGLateExactForward } = require('./eth-g-late-forward');
const {
  RESEARCH_CAPITAL_VERSION,
  STARTING_BANKROLL_USD,
  TARGET_STAKE_USD,
} = require('../research/capital-policy');

const cents = (x) => Math.round(x * 100) / 100;
const clampPx = (x) => Math.min(0.99, Math.max(0.01, cents(x)));
const CRYPTO_TAKER_RATE = 0.07;
const RESEARCH_STAKE_USD = TARGET_STAKE_USD;
const THESIS_VERSION = '2026-07-15-pilot-v2-500usd';
const V2_THESIS_VERSION = '2026-07-15-pilot-v2-500usd';
const V2_MAX_STAKE_USD = TARGET_STAKE_USD;
const V2_DEPTH_PARTICIPATION = 0.20;

const feePerShare = (price, costMultiplier = 1) =>
  CRYPTO_TAKER_RATE * price * (1 - price) * costMultiplier;
const edgeAfterCosts = (probability, ask, costMultiplier = 1) =>
  probability - ask - feePerShare(ask, costMultiplier);
const inBand = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
const boundedRemember = (set, value, limit = 1000) => {
  set.add(value);
  if (set.size > limit) set.delete(set.values().next().value);
};
const tokenView = (ctx, token) => {
  const book = token === 'UP' ? ctx.upBook : ctx.downBook;
  const ask = book?.asks?.[0]?.[0];
  const askSize = book?.asks?.[0]?.[1];
  const bid = book?.bids?.[0]?.[0];
  const probability = token === 'UP' ? ctx.phiFair : 1 - ctx.phiFair;
  return { book, ask, askSize, bid, probability };
};
const researchTaker = ({ engine, strategy, token, ask, askSize, note, groupId }) => ({
  action: 'place', side: 'BUY', token, price: ask,
  size: Math.min(RESEARCH_STAKE_USD / ask, askSize), kind: 'taker',
  coid: engine._coid(strategy), queueAhead: askSize, note, groupId,
  executionModel: 'latency_1s', thesisVersion: THESIS_VERSION,
});
const moveFromOpenBps = (ctx) => Number.isFinite(ctx.btc) && ctx.ref > 0
  ? 10000 * Math.log(ctx.btc / ctx.ref)
  : null;
const bookPressure = (book) => {
  const [bid, bidSize] = book?.bids?.[0] || [];
  const [ask, askSize] = book?.asks?.[0] || [];
  const total = bidSize + askSize;
  if (!(bid > 0 && ask > bid && bidSize > 0 && askSize > 0 && total > 0)) return null;
  const imbalance = (bidSize - askSize) / total;
  const mid = (bid + ask) / 2;
  // Opposite-side weighting: a larger bid queue pushes conditional fair
  // toward the ask, and a larger ask queue pushes it toward the bid.
  const microprice = (ask * bidSize + bid * askSize) / total;
  return { bid, bidSize, ask, askSize, imbalance, mid, microprice };
};
const nearDepthUsd = (book, side, distance = 0.03) => {
  const levels = book?.[side];
  const touch = levels?.[0]?.[0];
  if (!Number.isFinite(touch)) return null;
  let usd = 0;
  for (const [price, size] of levels) {
    if (!Number.isFinite(price) || !Number.isFinite(size)) continue;
    if (Math.abs(price - touch) > distance + 1e-9) break;
    usd += price * size;
  }
  return usd;
};
const capacityTaker = ({
  engine, strategy, token, ask, askSize, edge, note,
  maxStakeUsd = V2_MAX_STAKE_USD,
}) => {
  if (!(ask > 0 && ask < 1 && askSize > 0)) return null;
  // Capacity, not alpha, controls size: at most 2% of the frozen research
  // bankroll ($10) and never more than 20%
  // of displayed touch. Skip dust below $1 because it cannot validate the
  // economics of this bankroll. The quote-survival scorer can reduce this to
  // a partial fill after 1.25s.
  const shares = Math.min(maxStakeUsd / ask, askSize * V2_DEPTH_PARTICIPATION);
  if (!(shares > 0) || shares * ask < 1) return null;
  return {
    action: 'place', side: 'BUY', token, price: ask, size: shares,
    kind: 'taker', coid: engine._coid(strategy), queueAhead: askSize,
    executionModel: 'latency_1s', thesisVersion: V2_THESIS_VERSION,
    note: `${note} edge2x=${edge.toFixed(3)} stake=$${(shares * ask).toFixed(2)} depth_part=20%`,
  };
};

/** Thesis A — quote UP-token bid/ask at Φ-fair ± δ during the mid-window. */
class MakerA {
  constructor() {
    this.name = 'A_maker';
    this.cfg = {
      deltaCents: 0.02,   // half-spread off fair
      sizeTokens: 20,     // ~ $10 a side at 0.5
      tteMax: 240, tteMin: 60,
      requoteMoveCents: 0.02, // re-quote on ≥2¢ fair moves (multi-asset: 7 markets — 1¢/5s churned ~60MB/day of order rows)
      requoteMinMs: 15000,    // but never faster than this
    };
    this.byMarket = new Map(); // market_id -> {bid:{coid,price}, ask:{coid,price}, lastQuoteAt}
  }

  // Halt is PER-ASSET (multi-asset 2026-07-12): only pull quotes for the
  // halted market — other assets' feeds may be perfectly healthy.
  onHalt(ctx) { return this._cancelMarket(ctx.market?.id, 'halt'); }

  _cancelMarket(mid, note) {
    if (mid == null) return this._cancelAll(note);
    const st = this.byMarket.get(mid);
    if (!st) return [];
    const out = [];
    for (const side of ['bid', 'ask']) {
      if (st[side]) out.push({ action: 'cancel', coid: st[side].coid, note });
    }
    this.byMarket.delete(mid);
    return out;
  }

  _cancelAll(note) {
    const out = [];
    for (const [mid, st] of this.byMarket) {
      for (const side of ['bid', 'ask']) {
        if (st[side]) out.push({ action: 'cancel', coid: st[side].coid, note });
      }
      this.byMarket.delete(mid);
    }
    return out;
  }

  evaluate(ctx, engine) {
    const { market, tteSec, upBook, phiFair } = ctx;
    if (!market) return this._cancelAll('no_market');
    const st = this.byMarket.get(market.id) || { bid: null, ask: null, lastQuoteAt: 0 };
    const inBand = tteSec >= this.cfg.tteMin && tteSec <= this.cfg.tteMax;

    if (!inBand || phiFair == null || !upBook) {
      // leave the band (or lose the model) → pull all quotes
      const out = [];
      for (const side of ['bid', 'ask']) {
        if (st[side]) { out.push({ action: 'cancel', coid: st[side].coid, note: inBand ? 'no_fair' : 'tte_band' }); st[side] = null; }
      }
      if (!st.bid && !st.ask) this.byMarket.delete(market.id); else this.byMarket.set(market.id, st);
      return out;
    }

    const bestBid = upBook.bids?.[0]?.[0] ?? null;
    const bestAsk = upBook.asks?.[0]?.[0] ?? null;
    let bidPx = clampPx(phiFair - this.cfg.deltaCents);
    let askPx = clampPx(phiFair + this.cfg.deltaCents);
    // never cross the touch — a crossing "maker" quote is really a taker order
    if (bestAsk != null) bidPx = Math.min(bidPx, cents(bestAsk - 0.01));
    if (bestBid != null) askPx = Math.max(askPx, cents(bestBid + 0.01));
    if (!(bidPx >= 0.01 && askPx <= 0.99 && bidPx < askPx)) return [];

    const out = [];
    const wantRequote = (cur, px) =>
      !cur || (Math.abs(cur.price - px) >= this.cfg.requoteMoveCents &&
               ctx.now - st.lastQuoteAt >= this.cfg.requoteMinMs);
    if (wantRequote(st.bid, bidPx)) {
      if (st.bid) out.push({ action: 'cancel', coid: st.bid.coid, note: 'requote' });
      const coid = engine._coid(this.name);
      out.push({
        action: 'place', side: 'BUY', token: 'UP', price: bidPx, size: this.cfg.sizeTokens,
        kind: 'maker', coid, queueAhead: ShadowEngine.queueAhead(upBook, 'bids', bidPx),
      });
      st.bid = { coid, price: bidPx };
      st.lastQuoteAt = ctx.now;
    }
    if (wantRequote(st.ask, askPx)) {
      if (st.ask) out.push({ action: 'cancel', coid: st.ask.coid, note: 'requote' });
      const coid = engine._coid(this.name);
      out.push({
        action: 'place', side: 'SELL', token: 'UP', price: askPx, size: this.cfg.sizeTokens,
        kind: 'maker', coid, queueAhead: ShadowEngine.queueAhead(upBook, 'asks', askPx),
      });
      st.ask = { coid, price: askPx };
      st.lastQuoteAt = ctx.now;
    }
    this.byMarket.set(market.id, st);
    return out;
  }
}

/** Thesis D — cross-side consistency: ask_UP + ask_DOWN < $1 − buffer ⇒ buy both. */
class ConsistencyD {
  constructor() {
    this.name = 'D_consistency';
    this.cfg = {
      minEdge: 0.01,      // ask sum must be ≤ 1 − this
      maxLegUsd: 25,
      cooldownMs: 30000,  // one detection per market per persistence window
    };
    this.lastFire = new Map(); // market_id -> ts
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
    const { market, upBook, downBook } = ctx;
    if (!market || !upBook?.asks?.[0] || !downBook?.asks?.[0]) return [];
    const [upA, upASz] = upBook.asks[0];
    const [dnA, dnASz] = downBook.asks[0];
    if (upA + dnA > 1 - this.cfg.minEdge) return [];
    if (ctx.now - (this.lastFire.get(market.id) || 0) < this.cfg.cooldownMs) return [];
    this.lastFire.set(market.id, ctx.now);
    if (this.lastFire.size > 50) this.lastFire.delete(this.lastFire.keys().next().value);
    // size = what is actually displayed, capped in USD — both legs same token count
    const size = Math.min(upASz, dnASz, this.cfg.maxLegUsd / Math.max(upA, dnA));
    if (!(size > 0)) return [];
    const note = `ask_sum=${(upA + dnA).toFixed(3)}`;
    return [
      { action: 'place', side: 'BUY', token: 'UP', price: upA, size, kind: 'taker',
        coid: engine._coid(this.name), queueAhead: upASz, note },
      { action: 'place', side: 'BUY', token: 'DOWN', price: dnA, size, kind: 'taker',
        coid: engine._coid(this.name), queueAhead: dnASz, note },
    ];
  }
}

/** Thesis F — near-certainty yield, registered to be attacked by its own data. */
class YieldF {
  constructor() {
    this.name = 'F_yield';
    this.cfg = {
      tteMax: 60, tteMin: 20,
      minPhi: 0.995,       // model near-certainty (symmetric for DOWN)
      askMin: 0.90, askMax: 0.985,
      stakeUsd: 10,
    };
    this.fired = new Set(); // one shot per market
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
    const { market, tteSec, phiFair, upBook, downBook } = ctx;
    if (!market || this.fired.has(market.id) || phiFair == null) return [];
    if (tteSec < this.cfg.tteMin || tteSec > this.cfg.tteMax) return [];
    let token = null, book = null;
    if (phiFair >= this.cfg.minPhi) { token = 'UP'; book = upBook; }
    else if (phiFair <= 1 - this.cfg.minPhi) { token = 'DOWN'; book = downBook; }
    if (!token || !book?.asks?.[0]) return [];
    const [ask, askSz] = book.asks[0];
    if (ask < this.cfg.askMin || ask > this.cfg.askMax) return [];
    this.fired.add(market.id);
    if (this.fired.size > 100) this.fired.delete(this.fired.values().next().value);
    return [{
      action: 'place', side: 'BUY', token, price: ask,
      size: Math.min(this.cfg.stakeUsd / ask, askSz), kind: 'taker',
      coid: engine._coid(this.name), queueAhead: askSz,
      note: `phi=${phiFair.toFixed(4)}`,
    }];
  }
}

/**
 * A2 — MakerA with the two guards the 2026-07-12 audit derived (ANALYSIS.md):
 *
 * 1. INVENTORY CAP: A_maker's entire loss came from 9 markets absorbing 11-21
 *    same-side fills (200-400 tokens) in near-strike windows. A2 estimates its
 *    own fills ONLINE with the same back-of-queue tape math the scorer uses
 *    (ctx.prints) and stops quoting a side once est. filled tokens ≥ capTokens.
 * 2. Φ-SANITY BAND: fills placed while |phiFair − gammaUp| ≤ 0.05 ran ≈
 *    breakeven (−$0.09/fill, n=64); every disagreement bucket lost. A2 quotes
 *    only inside the band — outside it a "quote" is a directional bet on a
 *    model whose Brier is worse than a coin.
 *
 * A_maker keeps running unchanged as the concurrent control. Pre-registered
 * metric (IMPROVEMENTS.md): over the next ≥300 A2 fills, mean pnl_1x/fill with
 * bootstrap 95% CI vs A_maker's over the same window. Band/cap values were
 * chosen on pilot data — they are hypotheses, evaluated only on new data.
 */
class MakerA2 {
  constructor() {
    this.name = 'A2_maker_capped';
    this.cfg = {
      deltaCents: 0.02,
      sizeTokens: 20,
      tteMax: 240, tteMin: 60,
      requoteMoveCents: 0.02, // matched to A_maker (control comparability)
      requoteMinMs: 15000,
      capTokens: 40,        // ≈ 2 full fills per side per market
      phiBand: 0.05,        // max |phiFair − gammaUp| to quote at all
    };
    // market_id -> { bid, ask, lastQuoteAt, filledEst: {bid, ask}, done: {bid, ask} }
    this.byMarket = new Map();
  }

  // Halt is PER-ASSET (multi-asset 2026-07-12): only pull quotes for the
  // halted market — other assets' feeds may be perfectly healthy.
  onHalt(ctx) { return this._cancelMarket(ctx.market?.id, 'halt'); }

  _cancelMarket(mid, note) {
    if (mid == null) return this._cancelAll(note);
    const st = this.byMarket.get(mid);
    if (!st) return [];
    const out = [];
    for (const side of ['bid', 'ask']) {
      if (st[side]) out.push({ action: 'cancel', coid: st[side].coid, note });
    }
    this.byMarket.delete(mid);
    return out;
  }

  _cancelAll(note) {
    const out = [];
    for (const [mid, st] of this.byMarket) {
      for (const side of ['bid', 'ask']) {
        if (st[side]) out.push({ action: 'cancel', coid: st[side].coid, note });
      }
      this.byMarket.delete(mid);
    }
    return out;
  }

  // Same back-of-queue estimate the offline scorer uses: cumulative print
  // volume through the quote price since placement, minus queue ahead.
  _estFill(ctx, quote, side) {
    if (!ctx.prints || !ctx.upTokenId || !quote) return 0;
    const prints = ctx.prints(ctx.upTokenId, quote.placedAt);
    let cum = 0;
    for (const [, price, size] of prints) {
      if (side === 'bid' ? price <= quote.price : price >= quote.price) cum += size;
    }
    return Math.max(0, Math.min(this.cfg.sizeTokens, cum - (quote.queueAhead || 0)));
  }

  evaluate(ctx, engine) {
    const { market, tteSec, upBook, phiFair, gammaUp } = ctx;
    if (!market) return this._cancelAll('no_market');
    const st = this.byMarket.get(market.id) ||
      { bid: null, ask: null, lastQuoteAt: 0, filledEst: { bid: 0, ask: 0 }, done: { bid: false, ask: false } };
    const inBand = tteSec >= this.cfg.tteMin && tteSec <= this.cfg.tteMax;
    const phiSane = phiFair != null && gammaUp != null &&
      Math.abs(phiFair - gammaUp) <= this.cfg.phiBand;

    // Update online fill estimates for resting quotes; retire a side at cap.
    for (const side of ['bid', 'ask']) {
      if (!st[side] || st.done[side]) continue;
      const est = this._estFill(ctx, st[side], side);
      if (st.filledEst[side] + est >= this.cfg.capTokens) st.done[side] = true;
    }

    if (!inBand || !phiSane || !upBook) {
      const note = !inBand ? 'tte_band' : (!phiSane ? 'phi_band' : 'no_fair');
      const out = [];
      for (const side of ['bid', 'ask']) {
        if (st[side]) {
          st.filledEst[side] += this._estFill(ctx, st[side], side);
          out.push({ action: 'cancel', coid: st[side].coid, note });
          st[side] = null;
        }
      }
      if (!st.bid && !st.ask && !st.done.bid && !st.done.ask) this.byMarket.delete(market.id);
      else this.byMarket.set(market.id, st);
      return out;
    }

    const bestBid = upBook.bids?.[0]?.[0] ?? null;
    const bestAsk = upBook.asks?.[0]?.[0] ?? null;
    let bidPx = clampPx(phiFair - this.cfg.deltaCents);
    let askPx = clampPx(phiFair + this.cfg.deltaCents);
    if (bestAsk != null) bidPx = Math.min(bidPx, cents(bestAsk - 0.01));
    if (bestBid != null) askPx = Math.max(askPx, cents(bestBid + 0.01));
    if (!(bidPx >= 0.01 && askPx <= 0.99 && bidPx < askPx)) return [];

    const out = [];
    const wantRequote = (cur, px) =>
      !cur || (Math.abs(cur.price - px) >= this.cfg.requoteMoveCents &&
               ctx.now - st.lastQuoteAt >= this.cfg.requoteMinMs);
    const sides = [
      ['bid', bidPx, 'BUY', 'bids'],
      ['ask', askPx, 'SELL', 'asks'],
    ];
    for (const [side, px, orderSide, bookSide] of sides) {
      if (st.done[side]) {
        if (st[side]) { out.push({ action: 'cancel', coid: st[side].coid, note: 'inv_cap' }); st[side] = null; }
        continue;
      }
      if (wantRequote(st[side], px)) {
        if (st[side]) {
          st.filledEst[side] += this._estFill(ctx, st[side], side);
          out.push({ action: 'cancel', coid: st[side].coid, note: 'requote' });
        }
        const coid = engine._coid(this.name);
        const qAhead = ShadowEngine.queueAhead(upBook, bookSide, px);
        out.push({
          action: 'place', side: orderSide, token: 'UP', price: px, size: this.cfg.sizeTokens,
          kind: 'maker', coid, queueAhead: qAhead,
        });
        st[side] = { coid, price: px, placedAt: ctx.now, queueAhead: qAhead };
        st.lastQuoteAt = ctx.now;
      }
    }
    this.byMarket.set(market.id, st);
    return out;
  }
}

// D_consistency and F_yield retired 2026-07-12 (ANALYSIS.md):
// F_yield — breakeven WR at 1× costs is 97.0% vs 92.1% achieved; arithmetic, not variance.
// D_consistency — minEdge (1%) < round-trip taker costs (~2%) by construction; 18 fills.
// A_maker RETIRED 2026-07-12 (verdict final, n≈1,100 fills): −$1,353 lifetime.
// A2_maker_capped RETIRED 2026-07-12: cap reduces worst case but cap-compliant fills still
// lose −$0.48/fill (n=571 clean); root cause is adverse selection by informed takers in a
// binary resolution market — no parameterization of a passive maker fixes a structural edge.
// Classes kept above for reference; none register below.

/**
 * Thesis G — Late-window resolution arbitrage (TAKER ONLY).
 *
 * EDGE SOURCE (validated on borg_book_snaps history 2026-07-12):
 *   When tte < 75s and phi_fair ≥ 0.88 (or ≤ 0.12 for DOWN), the outcome is
 *   near-certain — validated at 98.7% UP win rate across 1,852 snaps on 50
 *   resolved markets (phi_bucket 0.9, tte 5-60s). Polymarket CLOB asks lag
 *   this information by 20-40s: avg ask = 0.912 in the 5-10ct-edge bucket vs
 *   phi_fair 0.983. The gap is real, measurable, and fillable (CLOB asks at
 *   those levels are below boundary 0.99, so actual counterparty quotes exist).
 *
 * WHY TAKER ONLY:
 *   All prior maker strategies died to adverse selection — takers who cross our
 *   spread have information we don't. G flips this: WE are the informed taker
 *   in the final minute when direction is locked. No inventory, no flip risk,
 *   no multi-window exposure. One entry per market-side per window and done.
 *
 * PARAMETERS (chosen from pilot book-snap history, not frozen — EVAL_PROTOCOL §3):
 *   tteMax 75s / tteMin 5s  — fire window
 *   minPhiCert 0.88          — lower than 0.90 to capture pre-resolution minute
 *   minEdgeCents 0.05        — must be ≥5¢ better than ask after 2% fee (~1.8¢)
 *   minAsk / maxAsk          — exclude boundary books and near-par asks
 *   stakeUsd 10              — conservative pilot; pre-registered metric is
 *                               mean pnl_1x/fill + 95% CI vs zero over ≥200 fills.
 *
 * KILL CRITERION (pre-registered):
 *   If 95% CI lower bound < 0 at ≥200 fills, G has no edge in execution —
 *   the book-snap opportunity does not survive real fill conditions. Retire.
 */
class LateWindowArb {
  constructor() {
    this.name = 'G_late_arb';
    this.cfg = {
      tteMax: 75,          // start watching at 75s remaining
      tteMin: 5,           // stop at 5s — too close, execution risk
      minPhiCert: 0.88,    // phi_fair threshold for near-certainty
      minEdgeCents: 0.05,  // min (phi_fair - ask) to justify entry
      minAsk: 0.55,        // below this the book is dislocated / suspect
      maxAsk: 0.96,        // above this the edge is <4¢, fee-eaten
      stakeUsd: 10,        // per-leg stake for pilot
    };
    // market_id → Set<'UP'|'DOWN'> — one shot per side per window
    this._fired = new Map();
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
    const { market, tteSec, phiFair, upBook, downBook } = ctx;
    if (!market || phiFair == null) return [];
    if (tteSec < this.cfg.tteMin || tteSec > this.cfg.tteMax) return [];

    const fired = this._fired.get(market.id) || new Set();
    const out = [];

    // UP case: phi says UP near-certain, buy UP token at CLOB ask
    if (phiFair >= this.cfg.minPhiCert && !fired.has('UP')) {
      const ask = upBook?.asks?.[0]?.[0];
      const askSz = upBook?.asks?.[0]?.[1];
      if (ask != null && ask >= this.cfg.minAsk && ask <= this.cfg.maxAsk && askSz > 0) {
        const edge = phiFair - ask;
        if (edge >= this.cfg.minEdgeCents) {
          fired.add('UP');
          out.push({
            action: 'place', side: 'BUY', token: 'UP',
            price: ask,
            size: Math.min(this.cfg.stakeUsd / ask, askSz),
            kind: 'taker',
            coid: engine._coid(this.name),
            queueAhead: askSz,
            note: `phi=${phiFair.toFixed(3)} ask=${ask.toFixed(3)} edge=${edge.toFixed(3)} tte=${Math.round(tteSec)}s`,
          });
        }
      }
    }

    // DOWN case: phi says DOWN near-certain, buy DOWN token at CLOB ask
    if (phiFair <= (1 - this.cfg.minPhiCert) && !fired.has('DOWN')) {
      const ask = downBook?.asks?.[0]?.[0];
      const askSz = downBook?.asks?.[0]?.[1];
      if (ask != null && ask >= this.cfg.minAsk && ask <= this.cfg.maxAsk && askSz > 0) {
        const edge = (1 - phiFair) - ask;
        if (edge >= this.cfg.minEdgeCents) {
          fired.add('DOWN');
          out.push({
            action: 'place', side: 'BUY', token: 'DOWN',
            price: ask,
            size: Math.min(this.cfg.stakeUsd / ask, askSz),
            kind: 'taker',
            coid: engine._coid(this.name),
            queueAhead: askSz,
            note: `phi=${phiFair.toFixed(3)} ask=${ask.toFixed(3)} edge=${edge.toFixed(3)} tte=${Math.round(tteSec)}s`,
          });
        }
      }
    }

    if (fired.size > 0) {
      this._fired.set(market.id, fired);
      // evict stale entries (cap at 500 markets)
      if (this._fired.size > 500) this._fired.delete(this._fired.keys().next().value);
    }
    return out;
  }
}

/**
 * VASILI (Thesis V, post-registered 2026-07-13) — mid-window momentum-follow.
 *
 * ORIGIN: an external simulator screenshot claimed +13,264% in 30 days betting
 * a window's direction from its first decisive sub-bar — at a FIXED $0.50 fill.
 * That fill assumption is fiction (the book reprices within seconds; our Q3
 * data shows the market tracks the underlying), but the underlying mechanism —
 * "a decisive first half predicts the window's close" — is testable honestly.
 * Vasili is that test at REAL displayed asks, tape-scored like every other
 * shadow strategy. It is deliberately DISTINCT from G_late_arb: different seat
 * (mid-window 90–150s vs G's 5–75s), different signal (raw price lead vs
 * Φ-model near-certainty).
 *
 * MECHANISM: once per market, in the 90–150s-remaining band, if the move from
 * the live-captured window open is decisive (|lead| ≥ 3bp — above the 2bp
 * noise floor where Q3 proved direction is a coin flip), buy the leading
 * side's token at the displayed ask, capped at 0.85 (paying near-certainty
 * prices leaves no cushion and is G's seat anyway).
 *
 * COUNTERPARTY: whoever is selling the leading side mid-window below its
 * conditional probability — mean-reversion bettors and stale quotes.
 *
 * PRE-REGISTERED PREDICTION (written before any data): the direction call
 * will be right often (~75–90%), but per-fill profit will be ≈ $0 or negative
 * because the mid-window ask already prices the lead. If that's wrong and
 * value survives at the ask, Vasili earns a CONFIRM honestly.
 *
 * READ (frozen in scripts/vasili-verdict.js): core (ex-hype) n≥300 fills;
 * CONFIRM if mean pnl_1x > $0.40/fill AND worst single market > −$30;
 * KILL if mean < $0.10. 1× stake only. hype judged separately.
 */
class Vasili {
  constructor() {
    this.name = 'Vasili';
    this.cfg = {
      tteMax: 150,        // evaluate from ~half-window elapsed…
      tteMin: 90,         // …until 90s remain (G's seat starts at 75s)
      minLeadBps: 3,      // decisive = |move from open| ≥ 3bp (Q3 noise floor is 2bp)
      minAsk: 0.35,       // below this the book violently disagrees — different trade, skip
      maxAsk: 0.85,       // above this there is no cushion (and it's G's regime)
      stakeUsd: 10,
    };
    this._fired = new Set(); // one shot per market, ever
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
    const { market, tteSec, upBook, downBook, btc: px, ref } = ctx;
    if (!market || this._fired.has(market.id)) return [];
    if (tteSec < this.cfg.tteMin || tteSec > this.cfg.tteMax) return [];
    if (!Number.isFinite(px) || !Number.isFinite(ref) || ref <= 0) return [];

    const leadBps = ((px - ref) / ref) * 10000;
    if (Math.abs(leadBps) < this.cfg.minLeadBps) return [];

    const side = leadBps > 0 ? 'UP' : 'DOWN';
    const book = side === 'UP' ? upBook : downBook;
    const ask = book?.asks?.[0]?.[0];
    const askSz = book?.asks?.[0]?.[1];
    if (ask == null || !(askSz > 0)) return [];
    if (ask < this.cfg.minAsk || ask > this.cfg.maxAsk) return [];

    this._fired.add(market.id);
    if (this._fired.size > 300) {
      this._fired = new Set([...this._fired].slice(-100));
    }
    return [{
      action: 'place', side: 'BUY', token: side,
      price: ask,
      size: Math.min(this.cfg.stakeUsd / ask, askSz),
      kind: 'taker',
      coid: engine._coid(this.name),
      queueAhead: askSz,
      note: `lead=${leadBps.toFixed(1)}bp ask=${ask.toFixed(3)} tte=${Math.round(tteSec)}s`,
    }];
  }
}

/**
 * Fresh 2026-07-14 portfolio experiment: ETH-only G execution split.
 *
 * ETH is the only G asset that was positive in pilot, frozen shadow eval,
 * and actual CLOB fills. That asset selection is post-hoc, so these are new
 * forward-only strategies. The alpha parameters are inherited unchanged from G;
 * the 0.85 ask ceiling is the already-deployed execution rail. The 45-second
 * minimum is the pre-registered binary-jump safety guard from IMPROVEMENTS.md,
 * not a fitted threshold. A $10 stake is 2% of the frozen $500 test bankroll
 * and is risk sizing, not edge tuning.
 *
 * A stable hash assigns each ETH market to exactly one arm. Taker and maker
 * can therefore be compared without duplicate exposure or cherry-picking.
 */
// BORG deploys into its own minimal runtime mirror and must not import src/.
// $10 is the frozen 2% stake for the separately documented $500 envelope.
const PORTFOLIO_POLICY = Object.freeze({
  bankrollUsdc: STARTING_BANKROLL_USD,
  stakeUsd: TARGET_STAKE_USD,
});
const ETH_PORTFOLIO_CFG = Object.freeze({
  tteMax: 75,
  tteMin: 45,
  minPhiCert: 0.88,
  minEdgeCents: 0.05,
  minAsk: 0.55,
  maxAsk: 0.85,
  stakeUsd: PORTFOLIO_POLICY.stakeUsd,
});

function stableArm(marketId) {
  const input = String(marketId ?? '');
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 2 === 0 ? 'taker' : 'maker';
}

function cadenceArm(marketId, strategyName) {
  const input = `${strategyName}:${marketId ?? ''}`;
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 2 === 0 ? 'event' : 'sampled';
}

/**
 * Randomized paper-only information-cadence wrapper. The wrapped strategy's
 * economic thresholds are identical across arms. Both arms use the same
 * 250ms order-latency model; only the decision observation cadence differs.
 * Each market is assigned to one arm, preventing duplicate/correlated orders.
 */
class CadenceExperimentArm {
  constructor(StrategyClass, cadence) {
    this.inner = new StrategyClass();
    this.baseName = this.inner.name;
    this.cadence = cadence;
    this.name = `${this.baseName}__${cadence}`;
    this.inner.name = this.name;
    this.experimentTargetIndependentMarkets = 300;
  }

  _assigned(ctx) {
    const mid = ctx.market?.id;
    return mid != null && cadenceArm(mid, this.baseName) === this.cadence;
  }

  onHalt(ctx) {
    return this._assigned(ctx) ? this.inner.onHalt(ctx) : [];
  }

  evaluate(ctx, engine) {
    if (!this._assigned(ctx)) return [];
    return (this.inner.evaluate(ctx, engine) || []).map((action) => ({
      ...action,
      executionModel: 'event_order_250ms',
      thesisVersion: `2026-07-15-cadence-split-v2-${RESEARCH_CAPITAL_VERSION}`,
      note: `cadence_arm=${this.cadence} assignment=fnv1a_market target_independent_markets=300 ${action.note || ''}`.trim(),
    }));
  }
}

function qualifyEthLate(ctx) {
  const { market, tteSec, phiFair, upBook, downBook } = ctx;
  if (!market || market.asset !== 'eth' || phiFair == null) return null;
  if (tteSec < ETH_PORTFOLIO_CFG.tteMin || tteSec > ETH_PORTFOLIO_CFG.tteMax) return null;

  let token = null;
  let book = null;
  let probability = null;
  if (phiFair >= ETH_PORTFOLIO_CFG.minPhiCert) {
    token = 'UP';
    book = upBook;
    probability = phiFair;
  } else if (phiFair <= 1 - ETH_PORTFOLIO_CFG.minPhiCert) {
    token = 'DOWN';
    book = downBook;
    probability = 1 - phiFair;
  }
  if (!token || !book?.asks?.[0]) return null;

  const [ask, askSz] = book.asks[0];
  if (!(askSz > 0) || ask < ETH_PORTFOLIO_CFG.minAsk || ask > ETH_PORTFOLIO_CFG.maxAsk) return null;
  const edge = probability - ask;
  if (edge < ETH_PORTFOLIO_CFG.minEdgeCents) return null;
  return { token, book, ask, askSz, probability, edge };
}

class EthLateTaker {
  constructor() {
    this.name = 'ETH_late_taker';
    this.cfg = ETH_PORTFOLIO_CFG;
    this._fired = new Set();
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
    const mid = ctx.market?.id;
    if (mid == null || this._fired.has(mid) || stableArm(mid) !== 'taker') return [];
    const q = qualifyEthLate(ctx);
    if (!q) return [];
    this._fired.add(mid);
    if (this._fired.size > 500) this._fired.delete(this._fired.values().next().value);
    return [{
      action: 'place', side: 'BUY', token: q.token, price: q.ask,
      size: Math.min(this.cfg.stakeUsd / q.ask, q.askSz), kind: 'taker',
      coid: engine._coid(this.name), queueAhead: q.askSz,
      thesisVersion: `2026-07-15-eth-late-v2-${RESEARCH_CAPITAL_VERSION}`,
      note: `arm=taker phi=${q.probability.toFixed(3)} ask=${q.ask.toFixed(3)} edge=${q.edge.toFixed(3)} tte=${Math.round(ctx.tteSec)}s stake=$${this.cfg.stakeUsd}`,
    }];
  }
}

class EthLateMaker {
  constructor() {
    this.name = 'ETH_late_maker';
    this.cfg = ETH_PORTFOLIO_CFG;
    this._active = new Map();
    this._done = new Set();
  }

  _cancel(mid, note) {
    const active = this._active.get(mid);
    if (!active) return [];
    this._active.delete(mid);
    this._done.add(mid);
    return [{ action: 'cancel', coid: active.coid, note }];
  }

  onHalt(ctx) { return this._cancel(ctx.market?.id, 'halt'); }

  evaluate(ctx, engine) {
    const mid = ctx.market?.id;
    if (mid == null || stableArm(mid) !== 'maker') return [];
    const active = this._active.get(mid);
    const q = qualifyEthLate(ctx);

    // Pull the quote when certainty/edge disappears or the side flips. The
    // scorer consumes the cancel timestamp when replaying queue position.
    if (active) {
      if (!q || q.token !== active.token) {
        return this._cancel(mid, !q ? 'signal_lost' : 'side_flip');
      }
      return [];
    }
    if (this._done.has(mid) || !q) return [];

    const bid = q.book.bids?.[0]?.[0];
    if (!Number.isFinite(bid) || bid <= 0 || bid >= q.ask) return [];
    const quote = clampPx(bid); // join best bid; post-only by construction
    if (quote >= q.ask) return [];

    const coid = engine._coid(this.name);
    this._active.set(mid, { coid, token: q.token });
    return [{
      action: 'place', side: 'BUY', token: q.token, price: quote,
      size: this.cfg.stakeUsd / quote, kind: 'maker', coid,
      queueAhead: ShadowEngine.queueAhead(q.book, 'bids', quote),
      thesisVersion: `2026-07-15-eth-late-v2-${RESEARCH_CAPITAL_VERSION}`,
      note: `arm=maker phi=${q.probability.toFixed(3)} ask=${q.ask.toFixed(3)} bid=${quote.toFixed(3)} edge_at_ask=${q.edge.toFixed(3)} tte=${Math.round(ctx.tteSec)}s stake=$${this.cfg.stakeUsd}`,
    }];
  }
}

/**
 * H1 — fee-safe complement arbitrage.
 *
 * A matched UP+DOWN share pays exactly $1 at resolution. This pilot fires only
 * when both displayed asks plus TWO TIMES the published crypto taker curve
 * leave at least one cent per paired share. The threshold is therefore an
 * accounting identity plus safety buffer, not a fit to historical P&L.
 *
 * The two orders share group_id. Independent latency scoring deliberately
 * preserves leg risk: if only one quote survives, only that leg is scored.
 */
class StructuralPairArb {
  constructor() {
    this.name = 'H1_pair_arb_2x';
    this.cfg = { tteMin: 20, tteMax: 270, minNetPerShare: 0.01, costMultiplier: 2 };
    this._fired = new Set();
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
    const { market, tteSec, upBook, downBook } = ctx;
    if (!market || this._fired.has(market.id) || !inBand(tteSec, this.cfg.tteMin, this.cfg.tteMax)) return [];
    const [upAsk, upSize] = upBook?.asks?.[0] || [];
    const [downAsk, downSize] = downBook?.asks?.[0] || [];
    if (!(upAsk > 0 && downAsk > 0 && upSize > 0 && downSize > 0)) return [];
    const allIn = upAsk + downAsk
      + feePerShare(upAsk, this.cfg.costMultiplier)
      + feePerShare(downAsk, this.cfg.costMultiplier);
    const locked = 1 - allIn;
    if (locked < this.cfg.minNetPerShare) return [];
    const shares = Math.min(upSize, downSize, RESEARCH_STAKE_USD / (upAsk + downAsk));
    if (!(shares > 0)) return [];
    boundedRemember(this._fired, market.id);
    const groupId = `${this.name}:${market.id}:${Math.floor(ctx.now / 1000)}`;
    const note = `all_in_2x=${allIn.toFixed(4)} locked=${locked.toFixed(4)} pair_shares=${shares.toFixed(3)}`;
    return [
      { ...researchTaker({ engine, strategy: this.name, token: 'UP', ask: upAsk, askSize: shares, note, groupId }), size: shares },
      { ...researchTaker({ engine, strategy: this.name, token: 'DOWN', ask: downAsk, askSize: shares, note, groupId }), size: shares },
    ];
  }
}

/**
 * H2 — short-horizon CEX impulse reaches the underlying before the CLOB ask.
 * Requires a >=4bp causal 10s move and at least 3 cents of Φ-vs-ask edge after
 * 2x fees. Four basis points is a market-microstructure displacement, while
 * the 3-cent residual covers three 1-cent token ticks beyond stressed fees.
 */
class CexImpulseLag {
  constructor() {
    this.name = 'H2_cex_impulse_lag';
    this.cfg = { tteMin: 60, tteMax: 240, minReturnBps: 4, minEdge2x: 0.03, minAsk: 0.25, maxAsk: 0.80 };
    this._fired = new Set();
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
    const mid = ctx.market?.id;
    const ret = ctx.micro10?.returnBps;
    if (mid == null || this._fired.has(mid) || ctx.phiFair == null ||
        !inBand(ctx.tteSec, this.cfg.tteMin, this.cfg.tteMax) ||
        !Number.isFinite(ret) || Math.abs(ret) < this.cfg.minReturnBps) return [];
    const token = ret > 0 ? 'UP' : 'DOWN';
    const q = tokenView(ctx, token);
    if (!(q.askSize > 0) || !inBand(q.ask, this.cfg.minAsk, this.cfg.maxAsk)) return [];
    const edge = edgeAfterCosts(q.probability, q.ask, 2);
    if (edge < this.cfg.minEdge2x) return [];
    boundedRemember(this._fired, mid);
    return [researchTaker({
      engine, strategy: this.name, token, ask: q.ask, askSize: q.askSize,
      note: `ret10=${ret.toFixed(2)}bp phi=${q.probability.toFixed(3)} ask=${q.ask.toFixed(3)} edge2x=${edge.toFixed(3)}`,
    })];
  }
}

/**
 * H3 — aggressor flow + Binance depth agree before Polymarket reprices.
 * This is independent of H2's large-price-impulse trigger: it can act on a
 * smaller move only when signed trade flow and depth point the same way.
 */
class FlowConfirmedLag {
  constructor() {
    this.name = 'H3_flow_confirmed';
    this.cfg = {
      tteMin: 75, tteMax: 225, minReturnBps: 1.5, minFlow: 0.35,
      minDepthImbalance: 0.15, minEdge2x: 0.02, minAsk: 0.30, maxAsk: 0.80,
    };
    this._fired = new Set();
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
    const mid = ctx.market?.id;
    const m = ctx.micro10;
    if (mid == null || this._fired.has(mid) || ctx.phiFair == null ||
        !inBand(ctx.tteSec, this.cfg.tteMin, this.cfg.tteMax) ||
        !m || !Number.isFinite(m.returnBps) || !Number.isFinite(m.flowImbalance) ||
        !Number.isFinite(m.depthImbalance)) return [];
    const sign = Math.sign(m.returnBps);
    if (!sign || Math.abs(m.returnBps) < this.cfg.minReturnBps ||
        sign * m.flowImbalance < this.cfg.minFlow ||
        sign * m.depthImbalance < this.cfg.minDepthImbalance) return [];
    const token = sign > 0 ? 'UP' : 'DOWN';
    const q = tokenView(ctx, token);
    if (!(q.askSize > 0) || !inBand(q.ask, this.cfg.minAsk, this.cfg.maxAsk)) return [];
    const edge = edgeAfterCosts(q.probability, q.ask, 2);
    if (edge < this.cfg.minEdge2x) return [];
    boundedRemember(this._fired, mid);
    return [researchTaker({
      engine, strategy: this.name, token, ask: q.ask, askSize: q.askSize,
      note: `ret10=${m.returnBps.toFixed(2)}bp flow=${m.flowImbalance.toFixed(3)} depth=${m.depthImbalance.toFixed(3)} edge2x=${edge.toFixed(3)}`,
    })];
  }
}

/**
 * H4 — BTC price discovery leads a still-flat altcoin for a few seconds.
 * The target must itself have moved <=2bp over 10s and <=2.5bp from its own
 * five-minute open; this tests propagation, not generic same-direction beta.
 */
class BtcLeadsAlts {
  constructor() {
    this.name = 'H4_btc_leads_alts';
    this.cfg = {
      targets: new Set(['eth', 'sol', 'bnb', 'doge', 'xrp']),
      tteMin: 90, tteMax: 240, minBtcReturnBps: 5,
      maxTargetReturnBps: 2, maxTargetFromOpenBps: 2.5,
      minAsk: 0.35, maxAsk: 0.60, maxBtcAgeMs: 2000,
    };
    this._btc = null;
    this._fired = new Set();
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
    const asset = ctx.market?.asset;
    if (asset === 'btc' && Number.isFinite(ctx.micro10?.returnBps)) {
      this._btc = { at: ctx.now, returnBps: ctx.micro10.returnBps };
      return [];
    }
    const mid = ctx.market?.id;
    if (mid == null || this._fired.has(mid) || !this.cfg.targets.has(asset) ||
        !inBand(ctx.tteSec, this.cfg.tteMin, this.cfg.tteMax) || !this._btc ||
        ctx.now - this._btc.at > this.cfg.maxBtcAgeMs) return [];
    const btcRet = this._btc.returnBps;
    const targetRet = ctx.micro10?.returnBps;
    if (Math.abs(btcRet) < this.cfg.minBtcReturnBps || !Number.isFinite(targetRet) ||
        Math.abs(targetRet) > this.cfg.maxTargetReturnBps || !(ctx.ref > 0) || !Number.isFinite(ctx.btc)) return [];
    const targetFromOpen = 10000 * Math.log(ctx.btc / ctx.ref);
    if (Math.abs(targetFromOpen) > this.cfg.maxTargetFromOpenBps) return [];
    const token = btcRet > 0 ? 'UP' : 'DOWN';
    const q = tokenView(ctx, token);
    if (!(q.askSize > 0) || !inBand(q.ask, this.cfg.minAsk, this.cfg.maxAsk)) return [];
    boundedRemember(this._fired, mid);
    return [researchTaker({
      engine, strategy: this.name, token, ask: q.ask, askSize: q.askSize,
      note: `btc_ret10=${btcRet.toFixed(2)}bp target_ret10=${targetRet.toFixed(2)}bp target_open=${targetFromOpen.toFixed(2)}bp ask=${q.ask.toFixed(3)}`,
    })];
  }
}

/**
 * H5 — volatility-expansion continuation. A causal 5-minute EWMA of the
 * collector's own sigma estimate is the regime baseline. The strategy waits
 * for 60 observations, then requires current sigma >=1.5x baseline plus a
 * directional 30s move and 3 cents of stressed executable edge.
 */
class VolExpansionContinuation {
  constructor() {
    this.name = 'H5_vol_expansion';
    this.cfg = {
      tteMin: 90, tteMax: 240, warmup: 60, minVolRatio: 1.5,
      minReturn30Bps: 4, minEdge2x: 0.03, minAsk: 0.30, maxAsk: 0.80,
    };
    this._baseline = new Map();
    this._fired = new Set();
    this._alpha = 1 - Math.exp(-1 / 300);
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
    const asset = ctx.market?.asset;
    const sigma = ctx.sigma;
    if (!asset || !(sigma > 0)) return [];
    const prior = this._baseline.get(asset) || { mean: sigma, n: 0 };
    const baseline = prior.mean;
    this._baseline.set(asset, { mean: prior.mean + this._alpha * (sigma - prior.mean), n: prior.n + 1 });
    const mid = ctx.market?.id;
    const ret = ctx.micro30?.returnBps;
    if (prior.n < this.cfg.warmup || mid == null || this._fired.has(mid) || ctx.phiFair == null ||
        !inBand(ctx.tteSec, this.cfg.tteMin, this.cfg.tteMax) ||
        !Number.isFinite(ret) || Math.abs(ret) < this.cfg.minReturn30Bps ||
        sigma / baseline < this.cfg.minVolRatio) return [];
    const token = ret > 0 ? 'UP' : 'DOWN';
    const q = tokenView(ctx, token);
    if (!(q.askSize > 0) || !inBand(q.ask, this.cfg.minAsk, this.cfg.maxAsk)) return [];
    const edge = edgeAfterCosts(q.probability, q.ask, 2);
    if (edge < this.cfg.minEdge2x) return [];
    boundedRemember(this._fired, mid);
    return [researchTaker({
      engine, strategy: this.name, token, ask: q.ask, askSize: q.askSize,
      note: `vol_ratio=${(sigma / baseline).toFixed(2)} ret30=${ret.toFixed(2)}bp edge2x=${edge.toFixed(3)}`,
    })];
  }
}

/**
 * H6 — overreaction fade. Gamma/CLOB probability must overshoot Φ by at least
 * 12 cents, and the latest CEX move must already point back toward Φ. The bot
 * buys the underpriced opposite token only if 2x-fee edge remains positive by
 * three ticks. This attacks, rather than assumes, temporary crowd overshoot.
 */
class PhiOverreactionFade {
  constructor() {
    this.name = 'H6_phi_overreaction';
    this.cfg = {
      tteMin: 60, tteMax: 180, minDivergence: 0.12, minRetraceBps: 1,
      minEdge2x: 0.03, minAsk: 0.20, maxAsk: 0.75,
    };
    this._fired = new Set();
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
    const mid = ctx.market?.id;
    if (mid == null || this._fired.has(mid) || ctx.phiFair == null ||
        !inBand(ctx.tteSec, this.cfg.tteMin, this.cfg.tteMax)) return [];
    const marketUp = Number.isFinite(ctx.gammaUp) ? ctx.gammaUp : ctx.upMid;
    const ret = ctx.micro10?.returnBps;
    if (!Number.isFinite(marketUp) || !Number.isFinite(ret)) return [];
    const divergence = marketUp - ctx.phiFair;
    if (Math.abs(divergence) < this.cfg.minDivergence) return [];
    const token = divergence > 0 ? 'DOWN' : 'UP';
    const desiredSign = token === 'UP' ? 1 : -1;
    if (desiredSign * ret < this.cfg.minRetraceBps) return [];
    const q = tokenView(ctx, token);
    if (!(q.askSize > 0) || !inBand(q.ask, this.cfg.minAsk, this.cfg.maxAsk)) return [];
    const edge = edgeAfterCosts(q.probability, q.ask, 2);
    if (edge < this.cfg.minEdge2x) return [];
    boundedRemember(this._fired, mid);
    return [researchTaker({
      engine, strategy: this.name, token, ask: q.ask, askSize: q.askSize,
      note: `market_up=${marketUp.toFixed(3)} phi_up=${ctx.phiFair.toFixed(3)} div=${divergence.toFixed(3)} retrace10=${ret.toFixed(2)}bp edge2x=${edge.toFixed(3)}`,
    })];
  }
}

/**
 * H7 — BTC oracle-basis confirmation. This intentionally uses the mainnet
 * Chainlink push feed only as a CONTROL series, never as the claimed resolver
 * Data Stream. It tests whether requiring Binance and the control oracle to
 * agree removes basis-risk losses. Starvation is an acceptable outcome.
 */
class OracleConfirmedBtc {
  constructor() {
    this.name = 'H7_btc_oracle_confirm';
    this.cfg = {
      tteMin: 45, tteMax: 105, minMoveBps: 2, maxMoveGapBps: 2.5,
      minEdge2x: 0.02, minAsk: 0.35, maxAsk: 0.85,
    };
    this._fired = new Set();
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
    const mid = ctx.market?.id;
    if (ctx.market?.asset !== 'btc' || mid == null || this._fired.has(mid) || ctx.phiFair == null ||
        !inBand(ctx.tteSec, this.cfg.tteMin, this.cfg.tteMax) || !(ctx.ref > 0) || !(ctx.oracleRef > 0) ||
        !Number.isFinite(ctx.btc) || !Number.isFinite(ctx.oraclePrice)) return [];
    const cexMove = 10000 * Math.log(ctx.btc / ctx.ref);
    const oracleMove = 10000 * Math.log(ctx.oraclePrice / ctx.oracleRef);
    if (Math.abs(cexMove) < this.cfg.minMoveBps || Math.abs(oracleMove) < this.cfg.minMoveBps ||
        Math.sign(cexMove) !== Math.sign(oracleMove) ||
        Math.abs(cexMove - oracleMove) > this.cfg.maxMoveGapBps) return [];
    const token = cexMove > 0 ? 'UP' : 'DOWN';
    const q = tokenView(ctx, token);
    if (!(q.askSize > 0) || !inBand(q.ask, this.cfg.minAsk, this.cfg.maxAsk)) return [];
    const edge = edgeAfterCosts(q.probability, q.ask, 2);
    if (edge < this.cfg.minEdge2x) return [];
    boundedRemember(this._fired, mid);
    return [researchTaker({
      engine, strategy: this.name, token, ask: q.ask, askSize: q.askSize,
      note: `cex_move=${cexMove.toFixed(2)}bp oracle_move=${oracleMove.toFixed(2)}bp gap=${Math.abs(cexMove - oracleMove).toFixed(2)}bp edge2x=${edge.toFixed(3)}`,
    })];
  }
}

/**
 * H8 — informed one-sided maker. Prior symmetric makers lost because fills
 * arrived when counterparties knew more. This variant quotes only on the side
 * supported by CEX return AND aggressor flow, joins the best bid, assigns zero
 * rebate, and cancels as soon as confirmation disappears. Back-of-queue tape
 * scoring remains unchanged.
 */
class InformedOneSidedMaker {
  constructor() {
    this.name = 'H8_informed_maker';
    this.cfg = {
      tteMin: 90, tteMax: 210, minReturnBps: 3, minFlow: 0.20,
      minFairEdge: 0.04, minBid: 0.20, maxBid: 0.85,
    };
    this._active = new Map();
    this._done = new Set();
  }

  _cancel(mid, note) {
    const active = this._active.get(mid);
    if (!active) return [];
    this._active.delete(mid);
    boundedRemember(this._done, mid);
    return [{ action: 'cancel', coid: active.coid, note }];
  }

  onHalt(ctx) { return this._cancel(ctx.market?.id, 'halt'); }

  _qualify(ctx) {
    const m = ctx.micro10;
    if (ctx.phiFair == null || !inBand(ctx.tteSec, this.cfg.tteMin, this.cfg.tteMax) ||
        !m || !Number.isFinite(m.returnBps) || !Number.isFinite(m.flowImbalance)) return null;
    const sign = Math.sign(m.returnBps);
    if (!sign || Math.abs(m.returnBps) < this.cfg.minReturnBps || sign * m.flowImbalance < this.cfg.minFlow) return null;
    const token = sign > 0 ? 'UP' : 'DOWN';
    const q = tokenView(ctx, token);
    if (!(q.bid > 0) || !(q.ask > q.bid) || !inBand(q.bid, this.cfg.minBid, this.cfg.maxBid) ||
        q.probability - q.bid < this.cfg.minFairEdge) return null;
    return { token, ...q, ret: m.returnBps, flow: m.flowImbalance };
  }

  evaluate(ctx, engine) {
    const mid = ctx.market?.id;
    if (mid == null) return [];
    const active = this._active.get(mid);
    const q = this._qualify(ctx);
    if (active) {
      if (!q || q.token !== active.token) return this._cancel(mid, !q ? 'confirmation_lost' : 'side_flip');
      return [];
    }
    if (this._done.has(mid) || !q) return [];
    const coid = engine._coid(this.name);
    this._active.set(mid, { coid, token: q.token });
    return [{
      action: 'place', side: 'BUY', token: q.token, price: q.bid,
      size: RESEARCH_STAKE_USD / q.bid, kind: 'maker', coid,
      queueAhead: ShadowEngine.queueAhead(q.book, 'bids', q.bid),
      thesisVersion: THESIS_VERSION,
      note: `ret10=${q.ret.toFixed(2)}bp flow=${q.flow.toFixed(3)} phi=${q.probability.toFixed(3)} bid=${q.bid.toFixed(3)} edge=${(q.probability - q.bid).toFixed(3)}`,
    }];
  }
}

/**
 * H9 — dual-token queue-pressure confirmation.
 *
 * The UP and DOWN books are economically complementary but have independent
 * queues. A directional signal is accepted only when both books' top-level
 * microprices point to the same outcome and the underlying is at least 5bp
 * from its captured open (the collector's empirical no-divergence region).
 * Queue pressure is confirmation only; terminal value still has to clear the
 * executable ask and twice the published taker fee under Φ.
 */
class DualBookMicroprice {
  constructor() {
    this.name = 'H9_dual_book_microprice';
    this.cfg = {
      assets: new Set(['btc', 'eth', 'sol', 'bnb', 'doge', 'xrp']),
      tteMin: 60, tteMax: 210, minQueueImbalance: 0.40,
      minCombinedMicroTicks: 0.35, minMoveFromOpenBps: 5,
      minEdge2x: 0.02, minAsk: 0.25, maxAsk: 0.85,
    };
    this._fired = new Set();
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
    const mid = ctx.market?.id;
    if (mid == null || this._fired.has(mid) || !this.cfg.assets.has(ctx.market?.asset) || ctx.phiFair == null ||
        !inBand(ctx.tteSec, this.cfg.tteMin, this.cfg.tteMax)) return [];
    const up = bookPressure(ctx.upBook);
    const down = bookPressure(ctx.downBook);
    if (!up || !down) return [];
    let token = null;
    if (up.imbalance >= this.cfg.minQueueImbalance && down.imbalance <= -this.cfg.minQueueImbalance) token = 'UP';
    if (up.imbalance <= -this.cfg.minQueueImbalance && down.imbalance >= this.cfg.minQueueImbalance) token = 'DOWN';
    if (!token) return [];
    const sign = token === 'UP' ? 1 : -1;
    const combinedTicks = sign * ((up.microprice - up.mid) - (down.microprice - down.mid)) / 0.01;
    const openMove = moveFromOpenBps(ctx);
    if (combinedTicks < this.cfg.minCombinedMicroTicks || !Number.isFinite(openMove) ||
        sign * openMove < this.cfg.minMoveFromOpenBps) return [];
    const q = tokenView(ctx, token);
    if (!(q.askSize > 0) || !inBand(q.ask, this.cfg.minAsk, this.cfg.maxAsk)) return [];
    const edge = edgeAfterCosts(q.probability, q.ask, 2);
    if (edge < this.cfg.minEdge2x) return [];
    const action = capacityTaker({
      engine, strategy: this.name, token, ask: q.ask, askSize: q.askSize, edge,
      note: `up_qi=${up.imbalance.toFixed(3)} down_qi=${down.imbalance.toFixed(3)} micro_ticks=${combinedTicks.toFixed(2)} open=${openMove.toFixed(2)}bp`,
    });
    if (!action) return [];
    boundedRemember(this._fired, mid);
    return [action];
  }
}

/**
 * H10 — digital-option theta lag.
 *
 * With spot already away from the strike, the binary probability moves toward
 * 0/1 as time expires even if spot itself is flat. This pilot isolates that
 * mechanism by requiring a stable 10s underlying and sigma, a >=4-tick Φ
 * change, and at least a 3-tick shortfall in the token's response.
 */
class ThetaLagConvergence {
  constructor() {
    this.name = 'H10_theta_lag';
    this.cfg = {
      assets: new Set(['btc', 'eth', 'sol', 'bnb', 'doge', 'xrp']),
      tteMin: 45, tteMax: 180, lookbackMs: 10000,
      maxSpotReturnBps: 1.5, maxSigmaChange: 0.10,
      minPhiChange: 0.04, minLag: 0.03, minMoveFromOpenBps: 5,
      minEdge2x: 0.02, minAsk: 0.25, maxAsk: 0.90,
    };
    this._history = new Map();
    this._fired = new Set();
  }

  onHalt() { return []; }

  _remember(mid, ctx) {
    const hist = this._history.get(mid) || [];
    hist.push({ at: ctx.now, phi: ctx.phiFair, upMid: ctx.upMid, btc: ctx.btc, sigma: ctx.sigma });
    while (hist.length && hist[0].at < ctx.now - 20000) hist.shift();
    this._history.set(mid, hist);
    if (this._history.size > 500) this._history.delete(this._history.keys().next().value);
    return hist;
  }

  evaluate(ctx, engine) {
    const mid = ctx.market?.id;
    if (mid == null || !this.cfg.assets.has(ctx.market?.asset) || ctx.phiFair == null || !Number.isFinite(ctx.upMid) ||
        !Number.isFinite(ctx.btc) || !(ctx.sigma > 0)) return [];
    const hist = this._remember(mid, ctx);
    if (this._fired.has(mid) || !inBand(ctx.tteSec, this.cfg.tteMin, this.cfg.tteMax)) return [];
    const old = [...hist].reverse().find((row) => row.at <= ctx.now - this.cfg.lookbackMs);
    if (!old || !(old.btc > 0) || !(old.sigma > 0) || !Number.isFinite(old.phi) || !Number.isFinite(old.upMid)) return [];
    const spotRet = 10000 * Math.log(ctx.btc / old.btc);
    const sigmaChange = Math.abs(ctx.sigma / old.sigma - 1);
    const phiChange = ctx.phiFair - old.phi;
    const sign = Math.sign(phiChange);
    if (!sign || Math.abs(spotRet) > this.cfg.maxSpotReturnBps || sigmaChange > this.cfg.maxSigmaChange ||
        Math.abs(phiChange) < this.cfg.minPhiChange || sign !== Math.sign(ctx.phiFair - 0.5)) return [];
    const marketChange = ctx.upMid - old.upMid;
    const lag = Math.abs(phiChange) - sign * marketChange;
    const openMove = moveFromOpenBps(ctx);
    if (lag < this.cfg.minLag || !Number.isFinite(openMove) || sign * openMove < this.cfg.minMoveFromOpenBps) return [];
    const token = sign > 0 ? 'UP' : 'DOWN';
    const q = tokenView(ctx, token);
    if (!(q.askSize > 0) || !inBand(q.ask, this.cfg.minAsk, this.cfg.maxAsk)) return [];
    const edge = edgeAfterCosts(q.probability, q.ask, 2);
    if (edge < this.cfg.minEdge2x) return [];
    const action = capacityTaker({
      engine, strategy: this.name, token, ask: q.ask, askSize: q.askSize, edge,
      note: `phi_d=${phiChange.toFixed(3)} pm_d=${marketChange.toFixed(3)} lag=${lag.toFixed(3)} spot10=${spotRet.toFixed(2)}bp sigma_d=${sigmaChange.toFixed(3)}`,
    });
    if (!action) return [];
    boundedRemember(this._fired, mid);
    return [action];
  }
}

/**
 * H11 — liquidity-vacuum continuation.
 *
 * Cancellations and quote withdrawals are order-flow events. The pilot looks
 * for >=60% of near-touch ask depth disappearing over five seconds before the
 * ask has repriced, while same-token bid depth remains. CEX direction, the
 * 5bp resolver-basis guard and stressed terminal edge must all agree.
 */
class LiquidityVacuumContinuation {
  constructor() {
    this.name = 'H11_liquidity_vacuum';
    this.cfg = {
      assets: new Set(['btc', 'eth', 'sol', 'bnb', 'doge', 'xrp']),
      tteMin: 60, tteMax: 210, lookbackMs: 5000,
      maxAskDepthRatio: 0.40, minBidDepthRatio: 0.80,
      maxAskMove: 0.01, minReturnBps: 2, minMoveFromOpenBps: 5,
      minEdge2x: 0.02, minAsk: 0.25, maxAsk: 0.85,
    };
    this._history = new Map();
    this._fired = new Set();
  }

  onHalt() { return []; }

  _snapshot(ctx) {
    return {
      at: ctx.now,
      upAsk: ctx.upBook?.asks?.[0]?.[0], downAsk: ctx.downBook?.asks?.[0]?.[0],
      upAskDepth: nearDepthUsd(ctx.upBook, 'asks'), downAskDepth: nearDepthUsd(ctx.downBook, 'asks'),
      upBidDepth: nearDepthUsd(ctx.upBook, 'bids'), downBidDepth: nearDepthUsd(ctx.downBook, 'bids'),
    };
  }

  evaluate(ctx, engine) {
    const mid = ctx.market?.id;
    if (mid == null || !this.cfg.assets.has(ctx.market?.asset)) return [];
    const hist = this._history.get(mid) || [];
    const old = [...hist].reverse().find((row) => row.at <= ctx.now - this.cfg.lookbackMs);
    hist.push(this._snapshot(ctx));
    while (hist.length && hist[0].at < ctx.now - 12000) hist.shift();
    this._history.set(mid, hist);
    if (this._history.size > 500) this._history.delete(this._history.keys().next().value);
    if (this._fired.has(mid) || ctx.phiFair == null || !old ||
        !inBand(ctx.tteSec, this.cfg.tteMin, this.cfg.tteMax)) return [];
    const ret = ctx.micro10?.returnBps;
    if (!Number.isFinite(ret) || Math.abs(ret) < this.cfg.minReturnBps) return [];
    const token = ret > 0 ? 'UP' : 'DOWN';
    const prefix = token === 'UP' ? 'up' : 'down';
    const current = hist[hist.length - 1];
    const oldAskDepth = old[`${prefix}AskDepth`];
    const oldBidDepth = old[`${prefix}BidDepth`];
    const askDepth = current[`${prefix}AskDepth`];
    const bidDepth = current[`${prefix}BidDepth`];
    const ask = current[`${prefix}Ask`];
    const oldAsk = old[`${prefix}Ask`];
    if (!(oldAskDepth > 0 && oldBidDepth > 0 && askDepth >= 0 && bidDepth >= 0) ||
        askDepth / oldAskDepth > this.cfg.maxAskDepthRatio ||
        bidDepth / oldBidDepth < this.cfg.minBidDepthRatio ||
        !Number.isFinite(ask) || !Number.isFinite(oldAsk) || ask - oldAsk > this.cfg.maxAskMove + 1e-9) return [];
    const sign = token === 'UP' ? 1 : -1;
    const openMove = moveFromOpenBps(ctx);
    if (!Number.isFinite(openMove) || sign * openMove < this.cfg.minMoveFromOpenBps) return [];
    const q = tokenView(ctx, token);
    if (!(q.askSize > 0) || !inBand(q.ask, this.cfg.minAsk, this.cfg.maxAsk)) return [];
    const edge = edgeAfterCosts(q.probability, q.ask, 2);
    if (edge < this.cfg.minEdge2x) return [];
    const action = capacityTaker({
      engine, strategy: this.name, token, ask: q.ask, askSize: q.askSize, edge,
      note: `ask_depth_ratio=${(askDepth / oldAskDepth).toFixed(2)} bid_depth_ratio=${(bidDepth / oldBidDepth).toFixed(2)} ret10=${ret.toFixed(2)}bp`,
    });
    if (!action) return [];
    boundedRemember(this._fired, mid);
    return [action];
  }
}

/**
 * H12 — independent-venue consensus.
 *
 * Chainlink Data Streams aggregate broad market data, whereas the existing Φ
 * model observes Binance alone. Coinbase is used as an independent control:
 * both 10s returns must exceed 3bp, agree in sign and differ by no more than
 * 2bp. Missing/stale Coinbase data causes abstention, never fallback.
 */
class CrossVenueConsensus {
  constructor() {
    this.name = 'H12_cross_venue_consensus';
    this.cfg = {
      assets: new Set(['btc', 'eth', 'sol', 'bnb', 'doge', 'xrp']),
      tteMin: 45, tteMax: 180, minReturnBps: 3, maxReturnGapBps: 2,
      minMoveFromOpenBps: 5, minEdge2x: 0.02, minAsk: 0.25, maxAsk: 0.88,
    };
    this._fired = new Set();
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
    const mid = ctx.market?.id;
    const asset = ctx.market?.asset;
    const primary = ctx.micro10?.returnBps;
    const secondary = ctx.venue10?.returnBps;
    if (mid == null || this._fired.has(mid) || !this.cfg.assets.has(asset) || ctx.phiFair == null ||
        ctx.venueStale !== false || !inBand(ctx.tteSec, this.cfg.tteMin, this.cfg.tteMax) ||
        !Number.isFinite(primary) || !Number.isFinite(secondary) ||
        Math.abs(primary) < this.cfg.minReturnBps || Math.abs(secondary) < this.cfg.minReturnBps ||
        Math.sign(primary) !== Math.sign(secondary) ||
        Math.abs(primary - secondary) > this.cfg.maxReturnGapBps) return [];
    const token = primary > 0 ? 'UP' : 'DOWN';
    const sign = token === 'UP' ? 1 : -1;
    const openMove = moveFromOpenBps(ctx);
    if (!Number.isFinite(openMove) || sign * openMove < this.cfg.minMoveFromOpenBps) return [];
    const q = tokenView(ctx, token);
    if (!(q.askSize > 0) || !inBand(q.ask, this.cfg.minAsk, this.cfg.maxAsk)) return [];
    const edge = edgeAfterCosts(q.probability, q.ask, 2);
    if (edge < this.cfg.minEdge2x) return [];
    const action = capacityTaker({
      engine, strategy: this.name, token, ask: q.ask, askSize: q.askSize, edge,
      note: `binance10=${primary.toFixed(2)}bp coinbase10=${secondary.toFixed(2)}bp gap=${Math.abs(primary - secondary).toFixed(2)}bp`,
    });
    if (!action) return [];
    boundedRemember(this._fired, mid);
    return [action];
  }
}

/**
 * H13 — idiosyncratic CEX impulse.
 *
 * The first developmental replay rejected broad-market catch-up: a flat asset
 * did not profitably follow peer breadth. This replacement asks the opposite,
 * economically cleaner question: does asset-specific price discovery lead its
 * Polymarket token? The target must move >=4bp after subtracting the median of
 * at least four peers, while the peer median itself remains within 1.5bp.
 */
class IdiosyncraticImpulse {
  constructor() {
    this.name = 'H13_idiosyncratic_impulse';
    this.cfg = {
      assets: new Set(['btc', 'eth', 'sol', 'bnb', 'doge', 'xrp']),
      tteMin: 60, tteMax: 210, minPeers: 4,
      maxPeerMedianBps: 1.5, minResidualBps: 4,
      maxPeerAgeMs: 2500, minMoveFromOpenBps: 5,
      minEdge2x: 0.02, minAsk: 0.25, maxAsk: 0.85,
    };
    this._latest = new Map();
    this._fired = new Set();
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
    const asset = ctx.market?.asset;
    const ret = ctx.micro10?.returnBps;
    if (this.cfg.assets.has(asset) && Number.isFinite(ret)) this._latest.set(asset, { at: ctx.now, ret });
    const mid = ctx.market?.id;
    if (mid == null || this._fired.has(mid) || !this.cfg.assets.has(asset) || ctx.phiFair == null ||
        !Number.isFinite(ret) ||
        !inBand(ctx.tteSec, this.cfg.tteMin, this.cfg.tteMax)) return [];
    const peers = [...this._latest.entries()]
      .filter(([other, row]) => other !== asset && ctx.now - row.at <= this.cfg.maxPeerAgeMs)
      .map(([, row]) => row.ret);
    if (peers.length < this.cfg.minPeers) return [];
    const sorted = [...peers].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const peerMedian = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    const residual = ret - peerMedian;
    const sign = Math.sign(residual);
    if (!sign || Math.abs(peerMedian) > this.cfg.maxPeerMedianBps ||
        Math.abs(residual) < this.cfg.minResidualBps || Math.sign(ret) !== sign) return [];
    const token = sign > 0 ? 'UP' : 'DOWN';
    const openMove = moveFromOpenBps(ctx);
    if (!Number.isFinite(openMove) || sign * openMove < this.cfg.minMoveFromOpenBps) return [];
    const q = tokenView(ctx, token);
    if (!(q.askSize > 0) || !inBand(q.ask, this.cfg.minAsk, this.cfg.maxAsk)) return [];
    const edge = edgeAfterCosts(q.probability, q.ask, 2);
    if (edge < this.cfg.minEdge2x) return [];
    const action = capacityTaker({
      engine, strategy: this.name, token, ask: q.ask, askSize: q.askSize, edge,
      note: `target10=${ret.toFixed(2)}bp peer_med=${peerMedian.toFixed(2)}bp residual=${residual.toFixed(2)}bp peers=${peers.length}`,
    });
    if (!action) return [];
    boundedRemember(this._fired, mid);
    return [action];
  }
}

// Fresh forward identities for unchanged rules that produced a positive
// doubled-cost diagnostic point estimate. The old strategy IDs retain their
// historical governance disposition; these aliases begin at zero and cannot
// inherit discovery PnL. Renaming is the only mutation: every threshold,
// market type, cadence, sizing rule and evaluate() implementation is the
// original source object's.
const PROMISING_FORWARD_COHORT = Object.freeze([
  { source: 'H24_hourly_flow_breakout', name: 'FWD_H24_hourly_flow_breakout_v1', tier: 'A' },
  { source: 'H40_directional_entropy_breakout', name: 'FWD_H40_directional_entropy_breakout_v1', tier: 'A' },
  { source: 'H44_hourly_midwindow_reversal', name: 'FWD_H44_hourly_midwindow_reversal_v1', tier: 'A' },
  { source: 'H38_passive_flow_divergence', name: 'FWD_H38_passive_flow_divergence_v1', tier: 'B' },
  { source: 'H15_jump_adjusted_sigma', name: 'FWD_H15_jump_adjusted_sigma_v1', tier: 'B' },
  { source: 'H45_threshold_distance_velocity', name: 'FWD_H45_threshold_distance_velocity_v1', tier: 'C' },
  { source: 'H46_range_boundary_migration', name: 'FWD_H46_range_boundary_migration_v1', tier: 'C' },
  { source: 'H20_cross_venue_basis_reversion', name: 'FWD_H20_cross_venue_basis_reversion_v1', tier: 'C' },
  { source: 'H7_btc_oracle_confirm', name: 'FWD_H7_btc_oracle_confirm_v1', tier: 'C' },
  { source: 'H1_pair_arb_2x', name: 'FWD_H1_pair_arb_2x_v1', tier: 'C' },
]);

function makeBaseStrategies() {
  return [
  new LateWindowArb(), new EthLateTaker(), new EthLateMaker(), new EthGLateExactForward(),
  new StructuralPairArb(),
  new CadenceExperimentArm(CexImpulseLag, 'sampled'),
  new CadenceExperimentArm(CexImpulseLag, 'event'),
  new CadenceExperimentArm(FlowConfirmedLag, 'sampled'),
  new CadenceExperimentArm(FlowConfirmedLag, 'event'),
  new BtcLeadsAlts(), new VolExpansionContinuation(),
  new CadenceExperimentArm(PhiOverreactionFade, 'sampled'),
  new CadenceExperimentArm(PhiOverreactionFade, 'event'),
  new OracleConfirmedBtc(), new InformedOneSidedMaker(),
  new DualBookMicroprice(), new ThetaLagConvergence(),
  new LiquidityVacuumContinuation(), new CrossVenueConsensus(),
  new IdiosyncraticImpulse(),
  ...makeMainV2Strategies(),
  ...makeMainV3Strategies(),
  ...makeMainV4Strategies(),
  ...makeV3Strategies(),
  ...makeV4Strategies(),
  ...makeV5Strategies(),
  ...makeV6Strategies(),
  ...makeH52Strategies(),
  ...makeH53Strategies(),
  ...makeV7Strategies(),
  ...makeV8Strategies(),
  ...makeV9Strategies(),
  ...makeV10Strategies(),
  ];
}

function makePromisingForwardStrategies() {
  const sources = new Map(makeBaseStrategies().map((strategy) => [strategy.name, strategy]));
  return PROMISING_FORWARD_COHORT.map((spec) => {
    const strategy = sources.get(spec.source);
    if (!strategy) throw new Error(`Missing forward-cohort source strategy: ${spec.source}`);
    strategy.sourceStrategy = spec.source;
    strategy.forwardCohort = 'promising-paper-forward-2026-07-25-v1';
    strategy.forwardTier = spec.tier;
    strategy.name = spec.name;
    const sourceDiagnostics = typeof strategy.diagnostics === 'function'
      ? strategy.diagnostics.bind(strategy)
      : null;
    strategy.diagnostics = () => ({
      ...(sourceDiagnostics ? sourceDiagnostics() : {}),
      sourceStrategy: spec.source,
      forwardCohort: strategy.forwardCohort,
      forwardTier: spec.tier,
      identityOnlyClone: true,
    });
    return strategy;
  });
}

// Vasili remains above as an audit artifact but is no longer registered:
// n=983 core fills, -$393.77, and its losing CI excludes zero.
module.exports = () => [
  ...makeBaseStrategies(),
  ...makePromisingForwardStrategies(),
];
module.exports._test = {
  BtcLeadsAlts,
  CadenceExperimentArm,
  CexImpulseLag,
  CrossVenueConsensus,
  DualBookMicroprice,
  EthLateMaker,
  EthLateTaker,
  ETH_PORTFOLIO_CFG,
  FlowConfirmedLag,
  InformedOneSidedMaker,
  IdiosyncraticImpulse,
  LiquidityVacuumContinuation,
  OracleConfirmedBtc,
  PhiOverreactionFade,
  StructuralPairArb,
  ThetaLagConvergence,
  VolExpansionContinuation,
  edgeAfterCosts,
  bookPressure,
  capacityTaker,
  feePerShare,
  qualifyEthLate,
  stableArm,
  cadenceArm,
};
module.exports._forward = {
  PROMISING_FORWARD_COHORT,
  makeBaseStrategies,
  makePromisingForwardStrategies,
};
