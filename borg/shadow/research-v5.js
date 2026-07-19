/**
 * BORG H32-H51 — fifth forward-only shadow research portfolio.
 *
 * H32-H46 are mechanism-diverse directional/relative-value pilots. H47-H51
 * are event-driven cross-network resolver/transport arbitrage pilots using
 * direct Binance, Coinbase, Hyperliquid and Polymarket RTDS observations.
 * "Arbitrage" here means a measurable price-network dislocation; it is not a
 * risk-free lock because the Polymarket leg cannot be atomically hedged on an
 * external venue. Every strategy remains shadow-only.
 */
'use strict';

const { TARGET_STAKE_USD } = require('../research/capital-policy');
const makeV3Strategies = require('./research-v3');
const makeV4Strategies = require('./research-v4');

const { binaryFair } = makeV3Strategies._test;
const { positiveProbability } = makeV4Strategies._test;

const CRYPTO_TAKER_RATE = 0.07;
const MAX_STAKE_USD = TARGET_STAKE_USD;
const DEPTH_PARTICIPATION = 0.20;
const MIN_EDGE_2X = 0.02;
const THESIS_VERSION = '2026-07-15-v5-pilot-v1-500usd';
const DIRECTION_ASSETS = new Set(['btc', 'eth', 'sol', 'bnb', 'doge', 'xrp', 'hype']);
const NETWORK_ASSETS = new Set(['btc', 'eth', 'sol', 'xrp']);

const inBand = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
const feePerShare = (price, multiplier = 1) =>
  CRYPTO_TAKER_RATE * price * (1 - price) * multiplier;
const edgeAfterCosts = (probability, ask, multiplier = 1) =>
  probability - ask - feePerShare(ask, multiplier);

function median(values) {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
}

function boundedRemember(set, value, limit = 2500) {
  set.add(value);
  if (set.size > limit) set.delete(set.values().next().value);
}

function remember(map, key, row, now, horizonMs = 120000, maxKeys = 2500) {
  const history = map.get(key) || [];
  history.push(row);
  while (history.length && history[0].at < now - horizonMs) history.shift();
  map.set(key, history);
  if (map.size > maxKeys) map.delete(map.keys().next().value);
  return history;
}

function atLeastOld(history, now, ageMs) {
  return [...history].reverse().find((row) => row.at <= now - ageMs) || null;
}

function labels(ctx) {
  return {
    positive: String(ctx.market?.positive_label || 'UP').toUpperCase(),
    negative: String(ctx.market?.negative_label || 'DOWN').toUpperCase(),
  };
}

function tokenQuote(ctx, token, fairPositive) {
  const names = labels(ctx);
  const positive = token === names.positive;
  const book = positive ? ctx.upBook : ctx.downBook;
  return {
    token,
    positive,
    book,
    probability: positive ? fairPositive : 1 - fairPositive,
    ask: Number(book?.asks?.[0]?.[0]),
    askSize: Number(book?.asks?.[0]?.[1]),
    bid: Number(book?.bids?.[0]?.[0]),
  };
}

function takerAction(ctx, engine, strategy, token, fairPositive, note, options = {}) {
  const reject = (reason, detail = {}) => {
    options.onReject?.(reason, detail);
    return null;
  };
  if (!inBand(fairPositive, 0.000001, 0.999999)) {
    return reject('MODEL_FAIR_OUT_OF_RANGE', { fairPositive });
  }
  const quote = tokenQuote(ctx, token, fairPositive);
  const edge = edgeAfterCosts(quote.probability, quote.ask, 2);
  if (!inBand(quote.ask, options.minAsk ?? 0.08, options.maxAsk ?? 0.94)) {
    return reject('ASK_OUTSIDE_ALLOWED_RANGE', {
      ask: quote.ask, minAsk: options.minAsk ?? 0.08, maxAsk: options.maxAsk ?? 0.94,
    });
  }
  if (!(quote.askSize > 0)) return reject('NO_ASK_DEPTH', { askSize: quote.askSize });
  if (edge < (options.minEdge2x ?? MIN_EDGE_2X)) {
    return reject('EDGE_BELOW_2X_COST_FLOOR', {
      edge2x: edge, minimumEdge2x: options.minEdge2x ?? MIN_EDGE_2X,
    });
  }
  const shares = Math.min(MAX_STAKE_USD / quote.ask, quote.askSize * DEPTH_PARTICIPATION);
  if (!(shares > 0) || shares * quote.ask < 1) {
    return reject('STAKE_BELOW_MINIMUM', { shares, notional: shares * quote.ask });
  }
  return {
    action: 'place', side: 'BUY', token, price: quote.ask, size: shares,
    kind: 'taker', coid: engine._coid(strategy), queueAhead: quote.askSize,
    executionModel: options.eventDriven ? 'event_order_250ms' : 'latency_1s',
    thesisVersion: THESIS_VERSION,
    features: {
      mechanism_family: options.mechanismFamily || 'directional_relative_value',
      cross_network_arbitrage: options.crossNetwork === true,
      network_set: options.networkSet || undefined,
      atomic_external_hedge: false,
      ...(options.features || {}),
    },
    note: `${note} edge2x=${edge.toFixed(3)} stake=$${(shares * quote.ask).toFixed(2)} depth_part=20%`,
  };
}

function bestAction(ctx, engine, strategy, fairPositive, note, options = {}) {
  const names = labels(ctx);
  const candidates = [names.positive, names.negative]
    .map((token) => ({ token, quote: tokenQuote(ctx, token, fairPositive) }))
    .filter(({ quote }) => quote.askSize > 0 && inBand(quote.ask, options.minAsk ?? 0.08, options.maxAsk ?? 0.94))
    .map(({ token, quote }) => ({ token, edge: edgeAfterCosts(quote.probability, quote.ask, 2) }))
    .sort((left, right) => right.edge - left.edge);
  if (!candidates.length || candidates[0].edge < (options.minEdge2x ?? MIN_EDGE_2X)) return null;
  return takerAction(ctx, engine, strategy, candidates[0].token, fairPositive, note, options);
}

function forcedDirectionAction(ctx, engine, strategy, sign, fairPositive, note, options = {}) {
  const names = labels(ctx);
  return takerAction(ctx, engine, strategy, sign > 0 ? names.positive : names.negative,
    fairPositive, note, options);
}

function directionFair(ctx, spot = ctx.btc, sigma = ctx.sigma) {
  if (!(spot > 0) || !(ctx.ref > 0) || !(sigma > 0) || !(ctx.tteSec > 0)) return null;
  return binaryFair(spot, ctx.ref, sigma, ctx.tteSec);
}

function moveFromOpenBps(ctx) {
  return ctx.btc > 0 && ctx.ref > 0 ? 10000 * Math.log(ctx.btc / ctx.ref) : null;
}

function bookSpread(book) {
  const bid = Number(book?.bids?.[0]?.[0]);
  const ask = Number(book?.asks?.[0]?.[0]);
  return bid > 0 && ask > bid ? ask - bid : null;
}

function depthUsd(levels, maxDistance = Infinity) {
  const touch = Number(levels?.[0]?.[0]);
  if (!Number.isFinite(touch)) return null;
  let total = 0;
  for (const [rawPrice, rawSize] of levels || []) {
    const price = Number(rawPrice); const size = Number(rawSize);
    if (!Number.isFinite(price) || !Number.isFinite(size) || Math.abs(price - touch) > maxDistance) continue;
    total += price * size;
  }
  return total;
}

function rangeFair(ctx, spot = ctx.btc) {
  if (!(spot > 0) || !(ctx.sigma > 0) || !(ctx.tteSec > 0)) return null;
  const aboveLower = ctx.lowerBound == null ? 1 : binaryFair(spot, ctx.lowerBound, ctx.sigma, ctx.tteSec);
  const aboveUpper = ctx.upperBound == null ? 0 : binaryFair(spot, ctx.upperBound, ctx.sigma, ctx.tteSec);
  if (!Number.isFinite(aboveLower) || !Number.isFinite(aboveUpper)) return null;
  return Math.max(0.000001, Math.min(0.999999, aboveLower - aboveUpper));
}

class OncePerMarket {
  constructor() { this._fired = new Set(); }
  onHalt() { return []; }
  available(ctx) { return ctx.market?.id != null && !this._fired.has(ctx.market.id); }
  fired(ctx) { boundedRemember(this._fired, ctx.market.id); }
}

/** H32 — first-45-second repricing from the captured resolver open. */
class OpeningGapRepair extends OncePerMarket {
  constructor() {
    super(); this.name = 'H32_opening_gap_repair'; this.marketTypes = ['direction_5m'];
  }
  evaluate(ctx, engine) {
    const fair = directionFair(ctx);
    const market = positiveProbability(ctx);
    const move = moveFromOpenBps(ctx);
    if (!this.available(ctx) || !DIRECTION_ASSETS.has(ctx.market?.asset) ||
        !inBand(ctx.tteSec, 255, 292) || !Number.isFinite(fair) || !Number.isFinite(market) ||
        !Number.isFinite(move) || Math.abs(move) < 2.5 || Math.abs(fair - market) < 0.04) return [];
    const action = bestAction(ctx, engine, this.name, fair,
      `open_gap move=${move.toFixed(2)}bp fair=${fair.toFixed(3)} market=${market.toFixed(3)}`);
    if (!action) return [];
    this.fired(ctx); return [action];
  }
}

/** H33 — asymmetric signed realized variance versus a symmetric digital model. */
class SignedSemivariance extends OncePerMarket {
  constructor() {
    super(); this.name = 'H33_signed_semivariance'; this.marketTypes = ['direction_5m']; this._prices = new Map();
  }
  evaluate(ctx, engine) {
    const asset = ctx.market?.asset;
    if (!(ctx.btc > 0) || !DIRECTION_ASSETS.has(asset)) return [];
    const history = remember(this._prices, asset, { at: ctx.now, price: ctx.btc }, ctx.now, 90000, 20);
    if (!this.available(ctx) || !inBand(ctx.tteSec, 60, 210) || history.length < 25 || !(ctx.sigma > 0)) return [];
    const returns = [];
    for (let index = 1; index < history.length; index += 1) {
      if (history[index].at - history[index - 1].at <= 2500) {
        returns.push(Math.log(history[index].price / history[index - 1].price));
      }
    }
    const pos = returns.filter((value) => value > 0).reduce((sum, value) => sum + value * value, 0);
    const neg = returns.filter((value) => value < 0).reduce((sum, value) => sum + value * value, 0);
    const move = moveFromOpenBps(ctx); const sign = Math.sign(move);
    const dominant = sign > 0 ? pos : neg; const opposite = sign > 0 ? neg : pos;
    if (!sign || !(dominant > 2 * Math.max(opposite, 1e-12)) || Math.abs(move) < 4) return [];
    const ratio = Math.min(2, Math.sqrt(dominant / Math.max(opposite, 1e-12)));
    const fair = directionFair(ctx, ctx.btc, ctx.sigma * ratio);
    const market = positiveProbability(ctx);
    if (!Number.isFinite(fair) || !Number.isFinite(market) || Math.abs(fair - market) < 0.04) return [];
    const action = bestAction(ctx, engine, this.name, fair,
      `semivar pos=${pos.toExponential(2)} neg=${neg.toExponential(2)} sigma_mult=${ratio.toFixed(2)}`,
      { mechanismFamily: 'signed_volatility' });
    if (!action) return [];
    this.fired(ctx); return [action];
  }
}

/** H34 — aggressive CEX flow without spot progress, followed by token overreaction. */
class FlowAbsorptionReversal extends OncePerMarket {
  constructor() {
    super(); this.name = 'H34_flow_absorption_reversal'; this.marketTypes = ['direction_5m']; this._markets = new Map();
  }
  evaluate(ctx, engine) {
    const id = ctx.market?.id; const market = positiveProbability(ctx);
    if (id == null || !Number.isFinite(market)) return [];
    const history = remember(this._markets, id, { at: ctx.now, market, phi: ctx.phiFair }, ctx.now, 15000);
    const old = atLeastOld(history, ctx.now, 5000); const micro = ctx.micro10;
    if (!old || !this.available(ctx) || !inBand(ctx.tteSec, 75, 210) || !Number.isFinite(ctx.phiFair) ||
        !Number.isFinite(micro?.returnBps) || !Number.isFinite(micro?.flowImbalance) ||
        Math.abs(micro.flowImbalance) < 0.60 || Math.abs(micro.returnBps) > 1.2) return [];
    const sign = Math.sign(micro.flowImbalance); const tokenMove = market - old.market;
    if (sign * tokenMove < 0.03 || Math.abs(ctx.phiFair - old.phi) > 0.015) return [];
    const action = forcedDirectionAction(ctx, engine, this.name, -sign, ctx.phiFair,
      `absorbed_flow=${micro.flowImbalance.toFixed(3)} spot10=${micro.returnBps.toFixed(2)}bp token5=${tokenMove.toFixed(3)}`,
      { mechanismFamily: 'flow_absorption' });
    if (!action) return [];
    this.fired(ctx); return [action];
  }
}

/** H35 — static depth convexity: shallow path in the CEX-confirmed direction. */
class DepthConvexityBreakout extends OncePerMarket {
  constructor() {
    super(); this.name = 'H35_depth_convexity_breakout'; this.marketTypes = ['direction_5m', 'direction_1h'];
  }
  evaluate(ctx, engine) {
    const ret = ctx.micro10?.returnBps; const sign = Math.sign(ret);
    const fair = directionFair(ctx) ?? ctx.modelFairPositive;
    if (!this.available(ctx) || !sign || Math.abs(ret) < 2.5 || !Number.isFinite(fair) ||
        !inBand(ctx.tteSec, 60, ctx.market?.market_type === 'direction_1h' ? 2400 : 210)) return [];
    const names = labels(ctx); const token = sign > 0 ? names.positive : names.negative;
    const quote = tokenQuote(ctx, token, fair);
    const nearAsk = depthUsd(quote.book?.asks?.slice(0, 2));
    const farAsk = depthUsd(quote.book?.asks?.slice(2, 8));
    const nearBid = depthUsd(quote.book?.bids?.slice(0, 3));
    if (!(nearAsk >= 0 && farAsk > 0 && nearBid > 0) || nearAsk / farAsk > 0.35 || nearBid < 1.5 * nearAsk) return [];
    const action = takerAction(ctx, engine, this.name, token, fair,
      `depth_convexity near_ask=$${nearAsk.toFixed(2)} far_ask=$${farAsk.toFixed(2)} near_bid=$${nearBid.toFixed(2)} ret10=${ret.toFixed(2)}bp`,
      { mechanismFamily: 'book_convexity' });
    if (!action) return [];
    this.fired(ctx); return [action];
  }
}

/** H36 — fade a CLOB sweep after depleted depth is visibly replenished. */
class SweepReplenishmentReversal extends OncePerMarket {
  constructor() {
    super(); this.name = 'H36_sweep_replenishment_reversal'; this.marketTypes = ['direction_5m']; this._history = new Map();
  }
  evaluate(ctx, engine) {
    const id = ctx.market?.id; const market = positiveProbability(ctx);
    if (id == null || !Number.isFinite(market)) return [];
    const row = {
      at: ctx.now, market,
      upAskDepth: depthUsd(ctx.upBook?.asks, 0.03),
      downAskDepth: depthUsd(ctx.downBook?.asks, 0.03),
    };
    const history = remember(this._history, id, row, ctx.now, 15000);
    const old = atLeastOld(history, ctx.now, 7000);
    if (!old || !this.available(ctx) || !inBand(ctx.tteSec, 60, 200) || !Number.isFinite(ctx.phiFair)) return [];
    const peak = history.reduce((best, value) => value.market > best.market ? value : best, history[0]);
    const trough = history.reduce((best, value) => value.market < best.market ? value : best, history[0]);
    let sign = 0; let currentDepth; let minimumDepth;
    if (peak.market - old.market >= 0.04) {
      sign = -1; currentDepth = row.upAskDepth;
      minimumDepth = Math.min(...history.map((value) => value.upAskDepth).filter(Number.isFinite));
    } else if (old.market - trough.market >= 0.04) {
      sign = 1; currentDepth = row.downAskDepth;
      minimumDepth = Math.min(...history.map((value) => value.downAskDepth).filter(Number.isFinite));
    }
    if (!sign || !(minimumDepth >= 0) || !(currentDepth >= Math.max(5, 2 * minimumDepth))) return [];
    const action = forcedDirectionAction(ctx, engine, this.name, sign, ctx.phiFair,
      `sweep_replenished current_depth=$${currentDepth.toFixed(2)} trough_depth=$${minimumDepth.toFixed(2)} market=${market.toFixed(3)}`,
      { mechanismFamily: 'book_resilience' });
    if (!action) return [];
    this.fired(ctx); return [action];
  }
}

/** H37 — temporary spread shock closes while fair value remains stable. */
class SpreadShockReversion extends OncePerMarket {
  constructor() {
    super(); this.name = 'H37_spread_shock_reversion'; this.marketTypes = ['direction_5m']; this._history = new Map();
  }
  evaluate(ctx, engine) {
    const id = ctx.market?.id; const market = positiveProbability(ctx);
    const spread = Math.max(bookSpread(ctx.upBook) ?? 0, bookSpread(ctx.downBook) ?? 0);
    if (id == null || !Number.isFinite(market) || !Number.isFinite(ctx.phiFair)) return [];
    const history = remember(this._history, id, { at: ctx.now, spread, market, phi: ctx.phiFair }, ctx.now, 15000);
    const old = atLeastOld(history, ctx.now, 5000);
    const maxSpread = Math.max(...history.map((row) => row.spread));
    if (!old || !this.available(ctx) || !inBand(ctx.tteSec, 75, 210) || maxSpread < 0.08 ||
        spread > maxSpread * 0.55 || Math.abs(ctx.phiFair - old.phi) > 0.02 ||
        Math.abs(ctx.phiFair - market) < 0.05) return [];
    const action = bestAction(ctx, engine, this.name, ctx.phiFair,
      `spread_shock max=${maxSpread.toFixed(3)} now=${spread.toFixed(3)} fair_gap=${(ctx.phiFair - market).toFixed(3)}`,
      { mechanismFamily: 'spread_resilience' });
    if (!action) return [];
    this.fired(ctx); return [action];
  }
}

/** H38 — price moves against aggressor flow: follow informed passive liquidity. */
class PassiveFlowDivergence extends OncePerMarket {
  constructor() {
    super(); this.name = 'H38_passive_flow_divergence'; this.marketTypes = ['direction_5m'];
  }
  evaluate(ctx, engine) {
    const micro = ctx.micro10; const fair = directionFair(ctx); const sign = Math.sign(micro?.returnBps);
    if (!this.available(ctx) || !sign || !Number.isFinite(fair) || !inBand(ctx.tteSec, 60, 210) ||
        Math.abs(micro.returnBps) < 3 || Math.abs(micro.flowImbalance) < 0.35 ||
        Math.sign(micro.flowImbalance) === sign) return [];
    const action = forcedDirectionAction(ctx, engine, this.name, sign, fair,
      `passive_lead ret10=${micro.returnBps.toFixed(2)}bp flow=${micro.flowImbalance.toFixed(3)}`,
      { mechanismFamily: 'price_flow_divergence' });
    if (!action) return [];
    this.fired(ctx); return [action];
  }
}

/** H39 — use causal one-second return autocorrelation to choose follow/fade. */
class AutocorrelationRegime extends OncePerMarket {
  constructor() {
    super(); this.name = 'H39_autocorrelation_regime'; this.marketTypes = ['direction_5m']; this._prices = new Map();
  }
  evaluate(ctx, engine) {
    const asset = ctx.market?.asset;
    if (!(ctx.btc > 0) || !DIRECTION_ASSETS.has(asset)) return [];
    const history = remember(this._prices, asset, { at: ctx.now, price: ctx.btc }, ctx.now, 70000, 20);
    if (!this.available(ctx) || history.length < 35 || !inBand(ctx.tteSec, 60, 210)) return [];
    const returns = [];
    for (let index = 1; index < history.length; index += 1) {
      if (history[index].at - history[index - 1].at <= 2500) returns.push(10000 * Math.log(history[index].price / history[index - 1].price));
    }
    if (returns.length < 30) return [];
    const x = returns.slice(0, -1); const y = returns.slice(1);
    const mx = x.reduce((sum, value) => sum + value, 0) / x.length;
    const my = y.reduce((sum, value) => sum + value, 0) / y.length;
    const cov = x.reduce((sum, value, index) => sum + (value - mx) * (y[index] - my), 0);
    const vx = x.reduce((sum, value) => sum + (value - mx) ** 2, 0);
    const vy = y.reduce((sum, value) => sum + (value - my) ** 2, 0);
    const rho = cov / Math.sqrt(vx * vy);
    const recent = returns.slice(-5).reduce((sum, value) => sum + value, 0);
    if (!Number.isFinite(rho) || Math.abs(rho) < 0.25 || Math.abs(recent) < 2.5) return [];
    const forecastBps = Math.max(-8, Math.min(8, rho * recent));
    const fair = directionFair(ctx, ctx.btc * Math.exp(forecastBps / 10000));
    const action = bestAction(ctx, engine, this.name, fair,
      `lag1_rho=${rho.toFixed(3)} recent5=${recent.toFixed(2)}bp forecast=${forecastBps.toFixed(2)}bp`,
      { mechanismFamily: 'serial_dependence' });
    if (!action) return [];
    this.fired(ctx); return [action];
  }
}

/** H40 — low sign entropy identifies persistent one-sided price discovery. */
class DirectionalEntropyBreakout extends OncePerMarket {
  constructor() {
    super(); this.name = 'H40_directional_entropy_breakout'; this.marketTypes = ['direction_5m']; this._prices = new Map();
  }
  evaluate(ctx, engine) {
    const asset = ctx.market?.asset;
    if (!(ctx.btc > 0) || !DIRECTION_ASSETS.has(asset)) return [];
    const history = remember(this._prices, asset, { at: ctx.now, price: ctx.btc }, ctx.now, 50000, 20);
    if (!this.available(ctx) || history.length < 25 || !inBand(ctx.tteSec, 75, 210)) return [];
    const signs = []; let cumulative = 0;
    for (let index = 1; index < history.length; index += 1) {
      const ret = 10000 * Math.log(history[index].price / history[index - 1].price);
      if (Math.abs(ret) < 0.05) continue;
      signs.push(Math.sign(ret)); cumulative += ret;
    }
    if (signs.length < 20) return [];
    const positiveShare = signs.filter((sign) => sign > 0).length / signs.length;
    const p = Math.max(1e-6, Math.min(1 - 1e-6, positiveShare));
    const entropy = -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
    const sign = positiveShare >= 0.5 ? 1 : -1;
    if (entropy > 0.72 || Math.max(positiveShare, 1 - positiveShare) < 0.70 || sign * cumulative < 4) return [];
    const fair = directionFair(ctx); const action = forcedDirectionAction(ctx, engine, this.name, sign, fair,
      `sign_entropy=${entropy.toFixed(3)} dominant=${Math.max(p, 1 - p).toFixed(2)} cumulative=${cumulative.toFixed(2)}bp`,
      { mechanismFamily: 'path_entropy' });
    if (!action) return [];
    this.fired(ctx); return [action];
  }
}

/** H41 — five-minute cross-sectional dispersion beginning to converge. */
class CrossAssetDispersionReversion extends OncePerMarket {
  constructor() {
    super(); this.name = 'H41_crossasset_dispersion_reversion'; this.marketTypes = ['direction_5m']; this._latest = new Map();
  }
  evaluate(ctx, engine) {
    const asset = ctx.market?.asset; const move = moveFromOpenBps(ctx); const ret10 = ctx.micro10?.returnBps;
    if (DIRECTION_ASSETS.has(asset) && Number.isFinite(move)) this._latest.set(asset, { at: ctx.now, move });
    const peers = [...this._latest.entries()]
      .filter(([other, row]) => other !== asset && ctx.now - row.at <= 2500)
      .map(([, row]) => row.move);
    if (!this.available(ctx) || peers.length < 3 || !inBand(ctx.tteSec, 75, 210) || !Number.isFinite(ret10)) return [];
    const peerMedian = median(peers); const residual = move - peerMedian;
    if (Math.abs(residual) < 8 || Math.sign(ret10) !== -Math.sign(residual) || Math.abs(ret10) < 1.5) return [];
    const targetMove = move - 0.35 * residual;
    const fair = directionFair(ctx, ctx.ref * Math.exp(targetMove / 10000));
    const action = forcedDirectionAction(ctx, engine, this.name, -Math.sign(residual), fair,
      `dispersion=${residual.toFixed(2)}bp peer_med=${peerMedian.toFixed(2)}bp convergence10=${ret10.toFixed(2)}bp`,
      { mechanismFamily: 'cross_sectional_reversion' });
    if (!action) return [];
    this.fired(ctx); return [action];
  }
}

/** H42 — recent CLOB prints disagree with the replenished terminal book/fair. */
class BookTradeDisagreement extends OncePerMarket {
  constructor() {
    super(); this.name = 'H42_book_trade_disagreement'; this.marketTypes = ['direction_5m'];
  }
  evaluate(ctx, engine) {
    if (!this.available(ctx) || typeof ctx.prints !== 'function' || !ctx.upTokenId ||
        !Number.isFinite(ctx.phiFair) || !inBand(ctx.tteSec, 60, 210)) return [];
    const prints = ctx.prints(ctx.upTokenId, ctx.now - 8000) || [];
    let volume = 0; let notional = 0;
    for (const [, rawPrice, rawSize] of prints) {
      const price = Number(rawPrice); const size = Number(rawSize);
      if (price > 0 && size > 0) { volume += size; notional += price * size; }
    }
    const market = positiveProbability(ctx);
    if (!(volume >= 5) || !Number.isFinite(market)) return [];
    const vwap = notional / volume; const gap = vwap - market;
    if (Math.abs(gap) < 0.025 || Math.sign(gap) === Math.sign(ctx.phiFair - market)) return [];
    const action = bestAction(ctx, engine, this.name, ctx.phiFair,
      `print_vwap=${vwap.toFixed(3)} book_prob=${market.toFixed(3)} volume=${volume.toFixed(2)} fair=${ctx.phiFair.toFixed(3)}`,
      { mechanismFamily: 'trade_book_disagreement' });
    if (!action) return [];
    this.fired(ctx); return [action];
  }
}

/** H43 — near-resolution certainty only beyond volatility and resolver buffers. */
class ResolutionBoundaryBuffer extends OncePerMarket {
  constructor() {
    super(); this.name = 'H43_resolution_boundary_buffer'; this.marketTypes = ['direction_5m'];
    this._diagnosticCounts = new Map();
    this._lastDiagnostic = null;
  }
  diagnostic(reason, ctx, detail = {}) {
    this._diagnosticCounts.set(reason, (this._diagnosticCounts.get(reason) || 0) + 1);
    this._lastDiagnostic = {
      reason, at: new Date(ctx.now).toISOString(), marketId: ctx.market?.id ?? null,
      asset: ctx.market?.asset ?? null, tteSec: Number.isFinite(ctx.tteSec) ? ctx.tteSec : null,
      ...detail,
    };
    return [];
  }
  diagnostics() {
    return {
      frozenRule: 'research-h43-forward-v1',
      outcomes: Object.fromEntries(this._diagnosticCounts),
      last: this._lastDiagnostic,
    };
  }
  evaluate(ctx, engine) {
    const move = moveFromOpenBps(ctx); const divergence = ctx.resolverDivergence?.absBps;
    if (!this.available(ctx)) return this.diagnostic('ALREADY_FIRED_OR_MISSING_MARKET', ctx);
    if (!NETWORK_ASSETS.has(ctx.market?.asset)) return this.diagnostic('UNSUPPORTED_ASSET', ctx);
    if (!inBand(ctx.tteSec, 20, 75)) return this.diagnostic('TTE_OUTSIDE_FROZEN_WINDOW', ctx);
    if (!Number.isFinite(move)) return this.diagnostic('MISSING_MOVE_FROM_OPEN', ctx);
    if (!(ctx.sigma > 0)) return this.diagnostic('MISSING_DYNAMIC_SIGMA', ctx);
    if (!Number.isFinite(ctx.phiFair)) return this.diagnostic('MISSING_PHI_FAIR', ctx);
    const remainingSigmaBps = ctx.sigma * Math.sqrt(ctx.tteSec / 300) * 10000;
    const z = Math.abs(move) / Math.max(remainingSigmaBps, 1e-6);
    const resolverBuffer = Math.max(2, Number.isFinite(divergence) ? divergence : 0);
    if (z < 2.5) return this.diagnostic('BELOW_FROZEN_VOLATILITY_BUFFER', ctx, {
      z, remainingSigmaBps, moveBps: move,
    });
    if (Math.abs(move) < resolverBuffer + 5) {
      return this.diagnostic('BELOW_RESOLVER_DIVERGENCE_BUFFER', ctx, {
        moveBps: move, resolverBufferBps: resolverBuffer,
      });
    }
    const action = forcedDirectionAction(ctx, engine, this.name, Math.sign(move), ctx.phiFair,
      `boundary_z=${z.toFixed(2)} move=${move.toFixed(2)}bp sigma_rem=${remainingSigmaBps.toFixed(2)}bp resolver_buffer=${resolverBuffer.toFixed(2)}bp`,
      { mechanismFamily: 'resolution_uncertainty', maxAsk: 0.96,
        onReject: (reason, detail) => this.diagnostic(reason, ctx, detail) });
    if (!action) return [];
    this.diagnostic('ACTION_EMITTED', ctx, { z, moveBps: move, resolverBufferBps: resolverBuffer });
    this.fired(ctx); return [action];
  }
}

/** H44 — hourly displacement starts reversing with confirming flow. */
class HourlyMidwindowReversal extends OncePerMarket {
  constructor() {
    super(); this.name = 'H44_hourly_midwindow_reversal'; this.marketTypes = ['direction_1h'];
  }
  evaluate(ctx, engine) {
    const move = moveFromOpenBps(ctx); const ret30 = ctx.micro30?.returnBps; const flow = ctx.micro30?.flowImbalance;
    if (!this.available(ctx) || !NETWORK_ASSETS.has(ctx.market?.asset) || !inBand(ctx.tteSec, 600, 2400) ||
        !Number.isFinite(move) || Math.abs(move) < 20 || !Number.isFinite(ret30) || !Number.isFinite(flow) ||
        Math.sign(ret30) !== -Math.sign(move) || Math.abs(ret30) < 4 || Math.sign(flow) !== Math.sign(ret30) || Math.abs(flow) < 0.20) return [];
    const forecast = Math.max(-15, Math.min(15, 2 * ret30));
    const fair = directionFair(ctx, ctx.btc * Math.exp(forecast / 10000));
    const action = forcedDirectionAction(ctx, engine, this.name, Math.sign(ret30), fair,
      `hour_move=${move.toFixed(2)}bp reversal30=${ret30.toFixed(2)}bp flow=${flow.toFixed(3)} forecast=${forecast.toFixed(2)}bp`,
      { mechanismFamily: 'hourly_mean_reversion' });
    if (!action) return [];
    this.fired(ctx); return [action];
  }
}

/** H45 — threshold probability lag after sustained distance velocity. */
class ThresholdDistanceVelocity extends OncePerMarket {
  constructor() {
    super(); this.name = 'H45_threshold_distance_velocity'; this.marketTypes = ['threshold_daily']; this._prices = new Map();
  }
  evaluate(ctx, engine) {
    const id = ctx.market?.id;
    if (id == null || !(ctx.btc > 0) || !(ctx.strike > 0)) return [];
    const history = remember(this._prices, id, { at: ctx.now, price: ctx.btc }, ctx.now, 90000);
    const old = atLeastOld(history, ctx.now, 30000);
    if (!old || !this.available(ctx) || !inBand(ctx.tteSec, 300, 1800) || !(ctx.sigma > 0)) return [];
    const velocity = 10000 * Math.log(ctx.btc / old.price);
    if (Math.abs(velocity) < 4) return [];
    const projection = Math.max(-15, Math.min(15, velocity * Math.min(ctx.tteSec, 120) / 30));
    const fair = binaryFair(ctx.btc * Math.exp(projection / 10000), ctx.strike, ctx.sigma, ctx.tteSec);
    const action = bestAction(ctx, engine, this.name, fair,
      `threshold=${ctx.strike} velocity30=${velocity.toFixed(2)}bp projected=${projection.toFixed(2)}bp`,
      { mechanismFamily: 'threshold_velocity' });
    if (!action) return [];
    this.fired(ctx); return [action];
  }
}

/** H46 — bounded-range entry/exit crossing that the bucket book has not absorbed. */
class RangeBoundaryMigration extends OncePerMarket {
  constructor() {
    super(); this.name = 'H46_range_boundary_migration'; this.marketTypes = ['range_daily']; this._prices = new Map();
  }
  evaluate(ctx, engine) {
    const id = ctx.market?.id;
    if (id == null || !(ctx.btc > 0) || (ctx.lowerBound == null && ctx.upperBound == null)) return [];
    const history = remember(this._prices, id, { at: ctx.now, price: ctx.btc }, ctx.now, 60000);
    const old = atLeastOld(history, ctx.now, 20000);
    if (!old || !this.available(ctx) || !inBand(ctx.tteSec, 300, 1800)) return [];
    const inside = (price) => (ctx.lowerBound == null || price >= ctx.lowerBound) &&
      (ctx.upperBound == null || price < ctx.upperBound);
    const wasInside = inside(old.price); const isInside = inside(ctx.btc);
    if (wasInside === isInside || !Number.isFinite(ctx.micro10?.returnBps)) return [];
    const crossedUp = ctx.btc > old.price; const continuationSign = Math.sign(ctx.micro10.returnBps);
    if (continuationSign !== (crossedUp ? 1 : -1) || Math.abs(ctx.micro10.returnBps) < 1.5) return [];
    const fair = rangeFair(ctx);
    const action = forcedDirectionAction(ctx, engine, this.name, isInside ? 1 : -1, fair,
      `range=[${ctx.lowerBound ?? '-inf'},${ctx.upperBound ?? 'inf'}) old=${old.price} now=${ctx.btc} entered=${isInside}`,
      { mechanismFamily: 'range_boundary_migration' });
    if (!action) return [];
    this.fired(ctx); return [action];
  }
}

const NETWORK_OPTIONS = Object.freeze({
  eventDriven: true,
  crossNetwork: true,
  mechanismFamily: 'cross_network_arbitrage',
});

/** H47 — direct Binance leads the separately transported Polymarket RTDS copy. */
class BinanceTransportArbitrage extends OncePerMarket {
  constructor() {
    super(); this.name = 'H47_network_binance_transport_arb';
    this.marketTypes = ['direction_5m', 'direction_1h']; this.cadence = 'event';
  }
  evaluate(ctx, engine) {
    const direct = ctx.micro10?.returnBps; const transported = ctx.rtdsBinance10?.returnBps;
    const sign = Math.sign(direct); const fair = directionFair(ctx) ?? ctx.modelFairPositive;
    if (!this.available(ctx) || !NETWORK_ASSETS.has(ctx.market?.asset) || !sign || !Number.isFinite(transported) ||
        !Number.isFinite(fair) || Math.abs(direct) < 2.5 ||
        Math.abs(direct) - sign * transported < 2 || (ctx.rtdsBinanceAgeMs ?? Infinity) > 3000) return [];
    const action = forcedDirectionAction(ctx, engine, this.name, sign, fair,
      `direct10=${direct.toFixed(2)}bp rtds_binance10=${transported.toFixed(2)}bp transport_age=${ctx.rtdsBinanceAgeMs}ms`,
      { ...NETWORK_OPTIONS, networkSet: 'binance_direct|polymarket_rtds_binance', features: { arbitrage_class: 'transport_latency' } });
    if (!action) return [];
    this.fired(ctx); return [action];
  }
}

/** H48 — Chainlink resolver network moves before the direct-Binance model. */
class ChainlinkResolverBasisArbitrage extends OncePerMarket {
  constructor() {
    super(); this.name = 'H48_network_chainlink_resolver_basis'; this.marketTypes = ['direction_5m']; this.cadence = 'event';
  }
  evaluate(ctx, engine) {
    const direct = ctx.micro10?.returnBps; const chainlink = ctx.rtdsChainlink10?.returnBps;
    if (!this.available(ctx) || !NETWORK_ASSETS.has(ctx.market?.asset) || !Number.isFinite(direct) ||
        !Number.isFinite(chainlink) || Math.abs(chainlink) < 2.5) return [];
    const lead = chainlink - direct;
    if (Math.abs(lead) < 2 || Math.sign(lead) !== Math.sign(chainlink)) return [];
    const fair = directionFair(ctx, ctx.btc * Math.exp(lead / 10000));
    const action = forcedDirectionAction(ctx, engine, this.name, Math.sign(chainlink), fair,
      `chainlink10=${chainlink.toFixed(2)}bp binance10=${direct.toFixed(2)}bp resolver_lead=${lead.toFixed(2)}bp`,
      { ...NETWORK_OPTIONS, networkSet: 'chainlink_rtds|binance_direct', features: { arbitrage_class: 'resolver_basis' } });
    if (!action) return [];
    this.fired(ctx); return [action];
  }
}

/** H49 — Coinbase and Chainlink agree while Binance is the lagging/outlier path. */
class CoinbaseChainlinkQuorumArbitrage extends OncePerMarket {
  constructor() {
    super(); this.name = 'H49_network_coinbase_chainlink_quorum'; this.marketTypes = ['direction_5m']; this.cadence = 'event';
  }
  evaluate(ctx, engine) {
    const direct = ctx.micro10?.returnBps; const coinbase = ctx.venue10?.returnBps;
    const chainlink = ctx.rtdsChainlink10?.returnBps;
    if (!this.available(ctx) || !NETWORK_ASSETS.has(ctx.market?.asset) || ctx.venueStale !== false ||
        ![direct, coinbase, chainlink].every(Number.isFinite) || Math.sign(coinbase) !== Math.sign(chainlink) ||
        Math.abs(coinbase) < 2.5 || Math.abs(chainlink) < 2.5 || Math.abs(coinbase - chainlink) > 2.5) return [];
    const consensus = (coinbase + chainlink) / 2; const residual = consensus - direct;
    if (Math.abs(residual) < 2.5 || Math.sign(residual) !== Math.sign(consensus)) return [];
    const fair = directionFair(ctx, ctx.btc * Math.exp(residual / 10000));
    const action = forcedDirectionAction(ctx, engine, this.name, Math.sign(consensus), fair,
      `coinbase10=${coinbase.toFixed(2)}bp chainlink10=${chainlink.toFixed(2)}bp binance10=${direct.toFixed(2)}bp residual=${residual.toFixed(2)}bp`,
      { ...NETWORK_OPTIONS, networkSet: 'coinbase|chainlink_rtds|binance_direct', features: { arbitrage_class: 'two_of_three_quorum' } });
    if (!action) return [];
    this.fired(ctx); return [action];
  }
}

/** H50 — Hyperliquid and Chainlink agree before the Polymarket binary reprices. */
class HyperliquidChainlinkArbitrage extends OncePerMarket {
  constructor() {
    super(); this.name = 'H50_network_hyperliquid_chainlink_arb'; this.marketTypes = ['direction_5m']; this.cadence = 'event';
  }
  evaluate(ctx, engine) {
    const direct = ctx.micro10?.returnBps; const hyper = ctx.hyper10?.returnBps;
    const chainlink = ctx.rtdsChainlink10?.returnBps;
    if (!this.available(ctx) || !NETWORK_ASSETS.has(ctx.market?.asset) || ctx.hyperStale !== false ||
        ![direct, hyper, chainlink].every(Number.isFinite) || Math.sign(hyper) !== Math.sign(chainlink) ||
        Math.abs(hyper) < 3 || Math.abs(chainlink) < 3 || Math.abs(hyper - chainlink) > 3) return [];
    const consensus = (hyper + chainlink) / 2; const adjustment = consensus - direct;
    const fair = directionFair(ctx, ctx.btc * Math.exp(adjustment / 10000));
    const market = positiveProbability(ctx);
    if (!Number.isFinite(fair) || !Number.isFinite(market) || Math.abs(fair - market) < 0.04) return [];
    const action = forcedDirectionAction(ctx, engine, this.name, Math.sign(consensus), fair,
      `hyper10=${hyper.toFixed(2)}bp chainlink10=${chainlink.toFixed(2)}bp binance10=${direct.toFixed(2)}bp fair_gap=${(fair - market).toFixed(3)}`,
      { ...NETWORK_OPTIONS, networkSet: 'hyperliquid|chainlink_rtds|binance_direct', features: { arbitrage_class: 'cross_network_consensus' } });
    if (!action) return [];
    this.fired(ctx); return [action];
  }
}

/** H51 — robust four-network median rejects one bad venue/path. */
class FourNetworkMedianArbitrage extends OncePerMarket {
  constructor() {
    super(); this.name = 'H51_network_four_feed_median_arb'; this.marketTypes = ['direction_5m']; this.cadence = 'event';
  }
  evaluate(ctx, engine) {
    const direct = ctx.micro30?.returnBps;
    const returns = [direct, ctx.venue30?.returnBps, ctx.hyper30?.returnBps, ctx.rtdsChainlink30?.returnBps];
    if (!this.available(ctx) || !NETWORK_ASSETS.has(ctx.market?.asset) || ctx.venueStale !== false ||
        ctx.hyperStale !== false || !returns.every(Number.isFinite)) return [];
    const center = median(returns); const mad = median(returns.map((value) => Math.abs(value - center)));
    if (!Number.isFinite(center) || Math.abs(center) < 3 || !Number.isFinite(mad) || mad > 3) return [];
    const agreeing = returns.filter((value) => Math.sign(value) === Math.sign(center)).length;
    if (agreeing < 3) return [];
    const adjustment = center - direct;
    const fair = directionFair(ctx, ctx.btc * Math.exp(adjustment / 10000));
    const action = forcedDirectionAction(ctx, engine, this.name, Math.sign(center), fair,
      `network_returns=${returns.map((value) => value.toFixed(2)).join(',')} median=${center.toFixed(2)}bp mad=${mad.toFixed(2)}bp`,
      { ...NETWORK_OPTIONS, networkSet: 'binance_direct|coinbase|hyperliquid|chainlink_rtds', features: { arbitrage_class: 'robust_network_median' } });
    if (!action) return [];
    this.fired(ctx); return [action];
  }
}

function makeV5Strategies() {
  return [
    new OpeningGapRepair(),
    new SignedSemivariance(),
    new FlowAbsorptionReversal(),
    new DepthConvexityBreakout(),
    new SweepReplenishmentReversal(),
    new SpreadShockReversion(),
    new PassiveFlowDivergence(),
    new AutocorrelationRegime(),
    new DirectionalEntropyBreakout(),
    new CrossAssetDispersionReversion(),
    new BookTradeDisagreement(),
    new ResolutionBoundaryBuffer(),
    new HourlyMidwindowReversal(),
    new ThresholdDistanceVelocity(),
    new RangeBoundaryMigration(),
    new BinanceTransportArbitrage(),
    new ChainlinkResolverBasisArbitrage(),
    new CoinbaseChainlinkQuorumArbitrage(),
    new HyperliquidChainlinkArbitrage(),
    new FourNetworkMedianArbitrage(),
  ];
}

module.exports = makeV5Strategies;
module.exports._test = {
  AutocorrelationRegime,
  BinanceTransportArbitrage,
  BookTradeDisagreement,
  ChainlinkResolverBasisArbitrage,
  CoinbaseChainlinkQuorumArbitrage,
  CrossAssetDispersionReversion,
  DepthConvexityBreakout,
  DirectionalEntropyBreakout,
  FlowAbsorptionReversal,
  FourNetworkMedianArbitrage,
  HourlyMidwindowReversal,
  HyperliquidChainlinkArbitrage,
  OpeningGapRepair,
  PassiveFlowDivergence,
  RangeBoundaryMigration,
  ResolutionBoundaryBuffer,
  SignedSemivariance,
  SpreadShockReversion,
  SweepReplenishmentReversal,
  ThresholdDistanceVelocity,
  bestAction,
  edgeAfterCosts,
  feePerShare,
  rangeFair,
};
