/**
 * BORG H14-H21 — mechanism-diverse, forward-only shadow pilots.
 *
 * These classes have no wallet, signer, CLOB client or live-order method.
 * Every action is an intended order consumed by the existing shadow engine
 * and pessimistic 1.25-second quote-survival scorer.
 *
 * Parameters are PROVISIONAL MECHANISM DISCRIMINATORS, not fitted values:
 * - 2x published taker costs plus >=2 token ticks of residual edge;
 * - >=2.5 robust-z for cross-sectional/statistical anomalies;
 * - broad execution-safe time bands;
 * - at most $10 and 20% of displayed touch.
 * Any parameter change after a freeze creates a new experiment identity.
 */
'use strict';

const { TARGET_STAKE_USD } = require('../research/capital-policy');

const CRYPTO_TAKER_RATE = 0.07;
const MAX_STAKE_USD = TARGET_STAKE_USD;
const DEPTH_PARTICIPATION = 0.20;
const THESIS_VERSION = '2026-07-15-v3-pilot-v2-500usd';
const CEX_ASSETS = new Set(['btc', 'eth', 'sol', 'bnb', 'doge', 'xrp']);

const inBand = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
const feePerShare = (price, multiplier = 1) =>
  CRYPTO_TAKER_RATE * price * (1 - price) * multiplier;
const edgeAfterCosts = (probability, ask, multiplier = 1) =>
  probability - ask - feePerShare(ask, multiplier);

function boundedRemember(set, value, limit = 1000) {
  set.add(value);
  if (set.size > limit) set.delete(set.values().next().value);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  let p = d * t * (0.31938153 + t * (-0.356563782
    + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  if (x > 0) p = 1 - p;
  return Math.min(0.999999, Math.max(0.000001, p));
}

// Peter J. Acklam's inverse-normal approximation. It is used only to convert
// a binary market probability into the sigma implied by TV2's existing Phi
// convention; no distributional claim beyond that model is introduced.
function inverseNormalCdf(p) {
  if (!(p > 0 && p < 1)) return null;
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969,
    138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887,
    66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184,
    -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143,
    3.75440866190742];
  const low = 0.02425;
  const high = 1 - low;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > high) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function binaryFair(spot, strike, sigma5m, tteSec) {
  if (!(spot > 0 && strike > 0 && sigma5m > 0 && tteSec > 0)) return null;
  const remainingSigma = strike * sigma5m * Math.sqrt(tteSec / 300);
  if (!(remainingSigma > 0)) return null;
  return normalCdf((spot - strike) / remainingSigma);
}

function digitalImpliedSigma(probabilityUp, spot, strike, tteSec) {
  if (!inBand(probabilityUp, 0.02, 0.98) || !(spot > 0 && strike > 0 && tteSec > 0)) return null;
  const z = inverseNormalCdf(probabilityUp);
  const displacement = (spot - strike) / strike;
  if (!Number.isFinite(z) || Math.abs(z) < 1e-6 || Math.abs(displacement) < 1e-8 ||
      Math.sign(z) !== Math.sign(displacement)) return null;
  const sigma = displacement / (z * Math.sqrt(tteSec / 300));
  return sigma > 0 && Number.isFinite(sigma) ? sigma : null;
}

function bookMid(book) {
  const bid = book?.bids?.[0]?.[0];
  const ask = book?.asks?.[0]?.[0];
  return bid > 0 && ask > bid ? (bid + ask) / 2 : null;
}

function marketUpProbability(ctx, maxComplementGap = 0.08) {
  const up = Number.isFinite(ctx.upMid) ? ctx.upMid : bookMid(ctx.upBook);
  const down = bookMid(ctx.downBook);
  const fromDown = Number.isFinite(down) ? 1 - down : null;
  if (Number.isFinite(up) && Number.isFinite(fromDown)) {
    if (Math.abs(up - fromDown) > maxComplementGap) return null;
    return (up + fromDown) / 2;
  }
  return Number.isFinite(up) ? up : fromDown;
}

function tokenView(ctx, token, probabilityUp) {
  const book = token === 'UP' ? ctx.upBook : ctx.downBook;
  const ask = book?.asks?.[0]?.[0];
  const askSize = book?.asks?.[0]?.[1];
  return {
    book,
    ask,
    askSize,
    probability: token === 'UP' ? probabilityUp : 1 - probabilityUp,
  };
}

function capacityTaker({ engine, strategy, token, ask, askSize, edge, note }) {
  if (!(ask > 0 && ask < 1 && askSize > 0 && edge >= 0.02)) return null;
  const shares = Math.min(MAX_STAKE_USD / ask, askSize * DEPTH_PARTICIPATION);
  if (!(shares > 0) || shares * ask < 1) return null;
  return {
    action: 'place', side: 'BUY', token, price: ask, size: shares,
    kind: 'taker', coid: engine._coid(strategy), queueAhead: askSize,
    executionModel: 'latency_1s', thesisVersion: THESIS_VERSION,
    note: `${note} edge2x=${edge.toFixed(3)} stake=$${(shares * ask).toFixed(2)} depth_part=20%`,
  };
}

function actionAtFair(ctx, engine, strategy, token, probabilityUp, note, askMin = 0.20, askMax = 0.90) {
  if (!inBand(probabilityUp, 0.000001, 0.999999)) return null;
  const q = tokenView(ctx, token, probabilityUp);
  if (!(q.askSize > 0) || !inBand(q.ask, askMin, askMax)) return null;
  const edge = edgeAfterCosts(q.probability, q.ask, 2);
  return capacityTaker({ engine, strategy, token, ask: q.ask, askSize: q.askSize, edge, note });
}

function robustProfile(ctx) {
  const v = ctx.volatility;
  if (!v || v.observations < 60 || !(v.robustSigma5m > 0)) return null;
  return v;
}

function openingReference(store, ctx) {
  const mid = ctx.market?.id;
  if (mid == null || ctx.venueStale !== false || !(ctx.venuePrice > 0)) return null;
  if (!store.has(mid) && ctx.tteSec >= 285 && ctx.tteSec <= 301) {
    store.set(mid, { venueRef: ctx.venuePrice, at: ctx.now });
    if (store.size > 1000) store.delete(store.keys().next().value);
  }
  return store.get(mid) || null;
}

/**
 * H14 — Barclays-style robust VolScore, absolute form.
 *
 * Convert the complement-consistent binary price into an implied five-minute
 * sigma and compare it with MAD-adjusted realized sigma. Rich implied sigma
 * makes the current leading side too cheap; cheap implied sigma makes the
 * trailing side too cheap. This is directional implementation of a volatility
 * discrepancy, not a claim that a single binary is a pure variance swap.
 */
class RobustVolScore {
  constructor() {
    this.name = 'H14_robust_volscore';
    this.cfg = {
      tteMin: 60, tteMax: 210, richRatio: 1.50, cheapRatio: 1 / 1.50,
      minMoveFromOpenBps: 3,
    };
    this._fired = new Set();
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
    const mid = ctx.market?.id;
    const vol = robustProfile(ctx);
    const marketUp = marketUpProbability(ctx);
    if (mid == null || this._fired.has(mid) || !CEX_ASSETS.has(ctx.market?.asset) || !vol ||
        !inBand(ctx.tteSec, this.cfg.tteMin, this.cfg.tteMax) || !Number.isFinite(marketUp)) return [];
    const implied = digitalImpliedSigma(marketUp, ctx.btc, ctx.ref, ctx.tteSec);
    if (!(implied > 0)) return [];
    const ratio = implied / vol.robustSigma5m;
    if (ratio < this.cfg.richRatio && ratio > this.cfg.cheapRatio) return [];
    const move = 10000 * Math.log(ctx.btc / ctx.ref);
    if (!Number.isFinite(move) || Math.abs(move) < this.cfg.minMoveFromOpenBps) return [];
    const robustFair = binaryFair(ctx.btc, ctx.ref, vol.robustSigma5m, ctx.tteSec);
    if (robustFair == null) return [];
    const leading = move > 0 ? 'UP' : 'DOWN';
    const token = ratio >= this.cfg.richRatio ? leading : (leading === 'UP' ? 'DOWN' : 'UP');
    const action = actionAtFair(ctx, engine, this.name, token, robustFair,
      `implied_sigma=${implied.toFixed(5)} robust_sigma=${vol.robustSigma5m.toFixed(5)} ratio=${ratio.toFixed(2)} open=${move.toFixed(2)}bp`);
    if (!action) return [];
    boundedRemember(this._fired, mid);
    return [action];
  }
}

/**
 * H15 — one-jump contamination of the EWMA sigma.
 *
 * Barclays warns that ordinary realized volatility can be dominated by a
 * large move that does not imply persistently high future volatility. This
 * pilot fires only when one return owns a large fraction of recent variance,
 * EWMA sigma remains far above robust sigma, and spot has stabilized. It buys
 * the already-leading terminal side at the robust, jump-adjusted probability.
 */
class JumpAdjustedSigma {
  constructor() {
    this.name = 'H15_jump_adjusted_sigma';
    this.cfg = {
      tteMin: 60, tteMax: 180, minEwmaToRobust: 1.75,
      minMaxVarianceShare: 0.35, maxStabilizedReturnBps: 1.5,
      minMoveFromOpenBps: 4,
    };
    this._fired = new Set();
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
    const mid = ctx.market?.id;
    const vol = robustProfile(ctx);
    const ret10 = ctx.micro10?.returnBps;
    if (mid == null || this._fired.has(mid) || !CEX_ASSETS.has(ctx.market?.asset) || !vol ||
        !inBand(ctx.tteSec, this.cfg.tteMin, this.cfg.tteMax) ||
        !(vol.ewmaToRobust >= this.cfg.minEwmaToRobust) ||
        !(vol.maxVarianceShare >= this.cfg.minMaxVarianceShare) ||
        !Number.isFinite(ret10) || Math.abs(ret10) > this.cfg.maxStabilizedReturnBps) return [];
    const move = 10000 * Math.log(ctx.btc / ctx.ref);
    if (!Number.isFinite(move) || Math.abs(move) < this.cfg.minMoveFromOpenBps) return [];
    const robustFair = binaryFair(ctx.btc, ctx.ref, vol.robustSigma5m, ctx.tteSec);
    if (robustFair == null) return [];
    const token = move > 0 ? 'UP' : 'DOWN';
    const action = actionAtFair(ctx, engine, this.name, token, robustFair,
      `ewma_robust=${vol.ewmaToRobust.toFixed(2)} max_var_share=${vol.maxVarianceShare.toFixed(2)} stable10=${ret10.toFixed(2)}bp open=${move.toFixed(2)}bp`);
    if (!action) return [];
    boundedRemember(this._fired, mid);
    return [action];
  }
}

/**
 * H16 — cross-asset VolScore dispersion.
 *
 * Barclays selected single stocks relative to their sector instead of selling
 * every high-IV name. Here the analog is the log ratio of binary-implied sigma
 * to robust realized sigma relative to contemporaneous crypto peers. A 2.5
 * robust-z outlier is traded only when its own robust fair clears stressed
 * executable costs.
 */
class CrossAssetVolScore {
  constructor() {
    this.name = 'H16_cross_asset_volscore';
    this.cfg = {
      tteMin: 60, tteMax: 210, minPeers: 4, maxPeerAgeMs: 2500,
      minAbsRobustZ: 2.5, minMoveFromOpenBps: 3,
    };
    this._latest = new Map();
    this._fired = new Set();
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
    const asset = ctx.market?.asset;
    const mid = ctx.market?.id;
    const vol = robustProfile(ctx);
    const marketUp = marketUpProbability(ctx);
    if (!CEX_ASSETS.has(asset) || mid == null || !vol || !Number.isFinite(marketUp)) return [];
    const implied = digitalImpliedSigma(marketUp, ctx.btc, ctx.ref, ctx.tteSec);
    if (!(implied > 0)) return [];
    const logRatio = Math.log(implied / vol.robustSigma5m);
    this._latest.set(asset, { at: ctx.now, logRatio });
    if (this._fired.has(mid) || !inBand(ctx.tteSec, this.cfg.tteMin, this.cfg.tteMax)) return [];
    const peers = [...this._latest.entries()]
      .filter(([other, row]) => other !== asset && ctx.now - row.at <= this.cfg.maxPeerAgeMs)
      .map(([, row]) => row.logRatio);
    if (peers.length < this.cfg.minPeers) return [];
    const peerMedian = median(peers);
    const peerMad = median(peers.map((value) => Math.abs(value - peerMedian)));
    if (!(peerMad > 1e-6)) return [];
    const robustZ = (logRatio - peerMedian) / (1.4826 * peerMad);
    if (Math.abs(robustZ) < this.cfg.minAbsRobustZ) return [];
    const move = 10000 * Math.log(ctx.btc / ctx.ref);
    if (!Number.isFinite(move) || Math.abs(move) < this.cfg.minMoveFromOpenBps) return [];
    const robustFair = binaryFair(ctx.btc, ctx.ref, vol.robustSigma5m, ctx.tteSec);
    if (robustFair == null) return [];
    const leading = move > 0 ? 'UP' : 'DOWN';
    const token = robustZ > 0 ? leading : (leading === 'UP' ? 'DOWN' : 'UP');
    const action = actionAtFair(ctx, engine, this.name, token, robustFair,
      `volscore_z=${robustZ.toFixed(2)} log_ratio=${logRatio.toFixed(3)} peer_med=${peerMedian.toFixed(3)} peers=${peers.length}`);
    if (!action) return [];
    boundedRemember(this._fired, mid);
    return [action];
  }
}

/** H17 — resolver-proxy agreement measured from each venue's window open. */
class OpeningBasisConsensus {
  constructor() {
    this.name = 'H17_opening_basis_consensus';
    this.cfg = {
      tteMin: 60, tteMax: 240, minMoveBps: 4, maxMoveGapBps: 3,
    };
    this._refs = new Map();
    this._fired = new Set();
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
    const ref = openingReference(this._refs, ctx);
    const mid = ctx.market?.id;
    if (!ref || mid == null || this._fired.has(mid) || !CEX_ASSETS.has(ctx.market?.asset) ||
        ctx.venueStale !== false || !inBand(ctx.tteSec, this.cfg.tteMin, this.cfg.tteMax)) return [];
    const primaryMove = 10000 * Math.log(ctx.btc / ctx.ref);
    const secondaryMove = 10000 * Math.log(ctx.venuePrice / ref.venueRef);
    if (!Number.isFinite(primaryMove) || !Number.isFinite(secondaryMove) ||
        Math.abs(primaryMove) < this.cfg.minMoveBps || Math.abs(secondaryMove) < this.cfg.minMoveBps ||
        Math.sign(primaryMove) !== Math.sign(secondaryMove) ||
        Math.abs(primaryMove - secondaryMove) > this.cfg.maxMoveGapBps) return [];
    const consensusMove = (primaryMove + secondaryMove) / 2;
    const sigma = robustProfile(ctx)?.robustSigma5m || ctx.sigma;
    const consensusSpot = ctx.ref * Math.exp(consensusMove / 10000);
    const fair = binaryFair(consensusSpot, ctx.ref, sigma, ctx.tteSec);
    if (fair == null) return [];
    const token = consensusMove > 0 ? 'UP' : 'DOWN';
    const action = actionAtFair(ctx, engine, this.name, token, fair,
      `binance_open_move=${primaryMove.toFixed(2)}bp coinbase_open_move=${secondaryMove.toFixed(2)}bp gap=${Math.abs(primaryMove - secondaryMove).toFixed(2)}bp`);
    if (!action) return [];
    boundedRemember(this._fired, mid);
    return [action];
  }
}

function returnsBySecond(series) {
  const out = new Map();
  for (let i = 1; i < series.length; i++) {
    const prior = series[i - 1];
    const current = series[i];
    if (current.sec - prior.sec > 2 || !(prior.price > 0) || !(current.price > 0)) continue;
    out.set(current.sec, 10000 * Math.log(current.price / prior.price));
  }
  return out;
}

function recentReturn(series, seconds) {
  const latest = series[series.length - 1];
  if (!latest) return null;
  const old = [...series].reverse().find((row) => row.sec <= latest.sec - seconds);
  if (!old || latest.sec - old.sec > seconds + 2 || !(old.price > 0)) return null;
  return 10000 * Math.log(latest.price / old.price);
}

/** H18 — adaptive BTC-beta catch-up instead of a fixed one-for-one lead rule. */
class AdaptiveBetaLag {
  constructor() {
    this.name = 'H18_adaptive_beta_lag';
    this.cfg = {
      targets: new Set(['eth', 'sol', 'bnb', 'doge', 'xrp']),
      tteMin: 75, tteMax: 225, minPairs: 60, minBtc5sBps: 3,
      minGapBps: 3, minAbsZ: 2.5, minBeta: 0.10, maxBeta: 3,
    };
    this._series = new Map();
    this._fired = new Set();
  }

  onHalt() { return []; }

  _remember(asset, now, price) {
    if (!CEX_ASSETS.has(asset) || !(price > 0)) return;
    const sec = Math.floor(now / 1000);
    const series = this._series.get(asset) || [];
    if (series[series.length - 1]?.sec === sec) series[series.length - 1].price = price;
    else series.push({ sec, price });
    while (series.length > 180) series.shift();
    this._series.set(asset, series);
  }

  evaluate(ctx, engine) {
    const asset = ctx.market?.asset;
    this._remember(asset, ctx.now, ctx.btc);
    const mid = ctx.market?.id;
    if (mid == null || this._fired.has(mid) || !this.cfg.targets.has(asset) ||
        !inBand(ctx.tteSec, this.cfg.tteMin, this.cfg.tteMax)) return [];
    const btcSeries = this._series.get('btc') || [];
    const targetSeries = this._series.get(asset) || [];
    const btcReturns = returnsBySecond(btcSeries);
    const targetReturns = returnsBySecond(targetSeries);
    const pairs = [];
    for (const [sec, btcRet] of btcReturns) {
      const targetRet = targetReturns.get(sec);
      if (Number.isFinite(targetRet)) pairs.push([btcRet, targetRet]);
    }
    if (pairs.length < this.cfg.minPairs) return [];
    const recent = pairs.slice(-120);
    const meanB = recent.reduce((sum, row) => sum + row[0], 0) / recent.length;
    const meanT = recent.reduce((sum, row) => sum + row[1], 0) / recent.length;
    let covariance = 0; let varianceB = 0;
    for (const [b, t] of recent) {
      covariance += (b - meanB) * (t - meanT);
      varianceB += (b - meanB) ** 2;
    }
    if (!(varianceB > 0)) return [];
    const beta = covariance / varianceB;
    if (!inBand(beta, this.cfg.minBeta, this.cfg.maxBeta)) return [];
    const residuals = recent.map(([b, t]) => t - beta * b);
    const residualMean = residuals.reduce((sum, value) => sum + value, 0) / residuals.length;
    const residualSd = Math.sqrt(residuals.reduce((sum, value) => sum + (value - residualMean) ** 2, 0) /
      Math.max(1, residuals.length - 1));
    if (!(residualSd > 0)) return [];
    const btc5 = recentReturn(btcSeries, 5);
    const target5 = recentReturn(targetSeries, 5);
    if (!Number.isFinite(btc5) || !Number.isFinite(target5) || Math.abs(btc5) < this.cfg.minBtc5sBps) return [];
    const expectedTarget5 = beta * btc5;
    const gap = expectedTarget5 - target5;
    const z = gap / (residualSd * Math.sqrt(5));
    if (Math.abs(gap) < this.cfg.minGapBps || Math.abs(z) < this.cfg.minAbsZ) return [];
    const predictedSpot = ctx.btc * Math.exp(gap / 10000);
    const fair = binaryFair(predictedSpot, ctx.ref, ctx.sigma, ctx.tteSec);
    if (fair == null) return [];
    const token = gap > 0 ? 'UP' : 'DOWN';
    const action = actionAtFair(ctx, engine, this.name, token, fair,
      `beta=${beta.toFixed(2)} btc5=${btc5.toFixed(2)}bp target5=${target5.toFixed(2)}bp catchup=${gap.toFixed(2)}bp z=${z.toFixed(2)}`);
    if (!action) return [];
    boundedRemember(this._fired, mid);
    return [action];
  }
}

/** H19 — coherent CLOB probability jump unsupported by CEX/Phi information. */
class ClobOnlyJumpFade {
  constructor() {
    this.name = 'H19_clob_only_jump_fade';
    this.cfg = {
      tteMin: 60, tteMax: 210, lookbackMs: 5000,
      minEachBookMove: 0.03, minAverageMove: 0.04,
      maxPhiMove: 0.015, maxSpotMoveBps: 1.5,
    };
    this._history = new Map();
    this._fired = new Set();
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
    const mid = ctx.market?.id;
    const up = Number.isFinite(ctx.upMid) ? ctx.upMid : bookMid(ctx.upBook);
    const downMid = bookMid(ctx.downBook);
    const downImpliedUp = Number.isFinite(downMid) ? 1 - downMid : null;
    if (mid == null || !Number.isFinite(up) || !Number.isFinite(downImpliedUp) ||
        !Number.isFinite(ctx.phiFair) || !(ctx.btc > 0)) return [];
    const hist = this._history.get(mid) || [];
    const old = [...hist].reverse().find((row) => row.at <= ctx.now - this.cfg.lookbackMs);
    hist.push({ at: ctx.now, up, downImpliedUp, phi: ctx.phiFair, spot: ctx.btc });
    while (hist.length && hist[0].at < ctx.now - 15000) hist.shift();
    this._history.set(mid, hist);
    if (!old || this._fired.has(mid) || !inBand(ctx.tteSec, this.cfg.tteMin, this.cfg.tteMax)) return [];
    const upMove = up - old.up;
    const downMove = downImpliedUp - old.downImpliedUp;
    const averageMove = (upMove + downMove) / 2;
    const spotMove = 10000 * Math.log(ctx.btc / old.spot);
    if (Math.sign(upMove) !== Math.sign(downMove) ||
        Math.abs(upMove) < this.cfg.minEachBookMove || Math.abs(downMove) < this.cfg.minEachBookMove ||
        Math.abs(averageMove) < this.cfg.minAverageMove ||
        Math.abs(ctx.phiFair - old.phi) > this.cfg.maxPhiMove ||
        Math.abs(spotMove) > this.cfg.maxSpotMoveBps) return [];
    const token = averageMove > 0 ? 'DOWN' : 'UP';
    const action = actionAtFair(ctx, engine, this.name, token, ctx.phiFair,
      `up_move=${upMove.toFixed(3)} down_implied_move=${downMove.toFixed(3)} phi_move=${(ctx.phiFair - old.phi).toFixed(3)} spot5=${spotMove.toFixed(2)}bp`);
    if (!action) return [];
    boundedRemember(this._fired, mid);
    return [action];
  }
}

/** H20 — Binance/Coinbase opening-basis convergence toward a resolver proxy. */
class CrossVenueBasisReversion {
  constructor() {
    this.name = 'H20_cross_venue_basis_reversion';
    this.cfg = {
      tteMin: 60, tteMax: 210, minOpeningGapBps: 5,
      minConvergence10sBps: 1.5, minMarketAnchorAdvantage: 0.01,
    };
    this._refs = new Map();
    this._fired = new Set();
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
    const ref = openingReference(this._refs, ctx);
    const mid = ctx.market?.id;
    const primary10 = ctx.micro10?.returnBps;
    const secondary10 = ctx.venue10?.returnBps;
    const marketUp = marketUpProbability(ctx);
    if (!ref || mid == null || this._fired.has(mid) || !CEX_ASSETS.has(ctx.market?.asset) ||
        ctx.venueStale !== false || !inBand(ctx.tteSec, this.cfg.tteMin, this.cfg.tteMax) ||
        !Number.isFinite(primary10) || !Number.isFinite(secondary10) || !Number.isFinite(marketUp)) return [];
    const primaryMove = 10000 * Math.log(ctx.btc / ctx.ref);
    const secondaryMove = 10000 * Math.log(ctx.venuePrice / ref.venueRef);
    if (!Number.isFinite(primaryMove) || !Number.isFinite(secondaryMove)) return [];
    const openingGap = primaryMove - secondaryMove;
    const convergence = primary10 - secondary10;
    if (Math.abs(openingGap) < this.cfg.minOpeningGapBps ||
        Math.sign(openingGap) * convergence > -this.cfg.minConvergence10sBps) return [];
    const sigma = robustProfile(ctx)?.robustSigma5m || ctx.sigma;
    const consensusMove = (primaryMove + secondaryMove) / 2;
    const consensusSpot = ctx.ref * Math.exp(consensusMove / 10000);
    const consensusFair = binaryFair(consensusSpot, ctx.ref, sigma, ctx.tteSec);
    const primaryFair = binaryFair(ctx.btc, ctx.ref, sigma, ctx.tteSec);
    if (consensusFair == null || primaryFair == null ||
        Math.abs(marketUp - primaryFair) + this.cfg.minMarketAnchorAdvantage >=
          Math.abs(marketUp - consensusFair)) return [];
    const upQ = tokenView(ctx, 'UP', consensusFair);
    const downQ = tokenView(ctx, 'DOWN', consensusFair);
    const upEdge = upQ.askSize > 0 ? edgeAfterCosts(upQ.probability, upQ.ask, 2) : -Infinity;
    const downEdge = downQ.askSize > 0 ? edgeAfterCosts(downQ.probability, downQ.ask, 2) : -Infinity;
    const token = upEdge >= downEdge ? 'UP' : 'DOWN';
    const action = actionAtFair(ctx, engine, this.name, token, consensusFair,
      `open_gap=${openingGap.toFixed(2)}bp convergence10=${convergence.toFixed(2)}bp market_up=${marketUp.toFixed(3)} consensus=${consensusFair.toFixed(3)}`);
    if (!action) return [];
    boundedRemember(this._fired, mid);
    return [action];
  }
}

/** H21 — one complement book moves while the economically identical view lags. */
class ComplementDesync {
  constructor() {
    this.name = 'H21_complement_desync';
    this.cfg = {
      tteMin: 60, tteMax: 210, lookbackMs: 4000,
      minMovedBook: 0.04, maxStableBook: 0.01,
      minCurrentGap: 0.03, maxPhiMove: 0.015,
    };
    this._history = new Map();
    this._fired = new Set();
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
    const mid = ctx.market?.id;
    const up = Number.isFinite(ctx.upMid) ? ctx.upMid : bookMid(ctx.upBook);
    const downMid = bookMid(ctx.downBook);
    const downImpliedUp = Number.isFinite(downMid) ? 1 - downMid : null;
    if (mid == null || !Number.isFinite(up) || !Number.isFinite(downImpliedUp) || !Number.isFinite(ctx.phiFair)) return [];
    const hist = this._history.get(mid) || [];
    const old = [...hist].reverse().find((row) => row.at <= ctx.now - this.cfg.lookbackMs);
    hist.push({ at: ctx.now, up, downImpliedUp, phi: ctx.phiFair });
    while (hist.length && hist[0].at < ctx.now - 12000) hist.shift();
    this._history.set(mid, hist);
    if (!old || this._fired.has(mid) || !inBand(ctx.tteSec, this.cfg.tteMin, this.cfg.tteMax) ||
        Math.abs(up - downImpliedUp) < this.cfg.minCurrentGap ||
        Math.abs(ctx.phiFair - old.phi) > this.cfg.maxPhiMove) return [];
    const upMove = up - old.up;
    const downMove = downImpliedUp - old.downImpliedUp;
    let stableView = null;
    let movedBook = null;
    if (Math.abs(upMove) >= this.cfg.minMovedBook && Math.abs(downMove) <= this.cfg.maxStableBook) {
      stableView = downImpliedUp;
      movedBook = 'up';
    } else if (Math.abs(downMove) >= this.cfg.minMovedBook && Math.abs(upMove) <= this.cfg.maxStableBook) {
      stableView = up;
      movedBook = 'down';
    } else return [];
    const fairUp = (stableView + ctx.phiFair) / 2;
    const upQ = tokenView(ctx, 'UP', fairUp);
    const downQ = tokenView(ctx, 'DOWN', fairUp);
    const upEdge = upQ.askSize > 0 ? edgeAfterCosts(upQ.probability, upQ.ask, 2) : -Infinity;
    const downEdge = downQ.askSize > 0 ? edgeAfterCosts(downQ.probability, downQ.ask, 2) : -Infinity;
    const token = upEdge >= downEdge ? 'UP' : 'DOWN';
    const action = actionAtFair(ctx, engine, this.name, token, fairUp,
      `moved_book=${movedBook} up_move=${upMove.toFixed(3)} down_implied_move=${downMove.toFixed(3)} gap=${(up - downImpliedUp).toFixed(3)} stable_phi_fair=${fairUp.toFixed(3)}`);
    if (!action) return [];
    boundedRemember(this._fired, mid);
    return [action];
  }
}

function makeV3Strategies() {
  return [
    new RobustVolScore(),
    new JumpAdjustedSigma(),
    new CrossAssetVolScore(),
    new OpeningBasisConsensus(),
    new AdaptiveBetaLag(),
    new ClobOnlyJumpFade(),
    new CrossVenueBasisReversion(),
    new ComplementDesync(),
  ];
}

module.exports = makeV3Strategies;
module.exports._test = {
  AdaptiveBetaLag,
  ClobOnlyJumpFade,
  ComplementDesync,
  CrossAssetVolScore,
  CrossVenueBasisReversion,
  JumpAdjustedSigma,
  OpeningBasisConsensus,
  RobustVolScore,
  binaryFair,
  digitalImpliedSigma,
  inverseNormalCdf,
  marketUpProbability,
  normalCdf,
};
