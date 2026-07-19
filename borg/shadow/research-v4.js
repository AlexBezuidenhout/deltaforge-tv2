/**
 * BORG H22-H31 — multi-horizon Polymarket crypto shadow pilots.
 *
 * All ten strategies are forward-only, phase='pilot', paper/shadow only, and
 * use the same pessimistic 1.25-second quote-survival scorer as H14-H21. The
 * thresholds below are mechanism discriminators, not fitted parameters:
 *   - at least two token ticks after 2x the published crypto taker curve;
 *   - no more than $10 total stake and 20% of displayed touch;
 *   - direct use of Binance only where the contract text names Binance as the
 *     resolver; Coinbase is confirmation, never substituted settlement data;
 *   - every cross-contract bundle is equal-share and explicitly records its
 *     non-atomic leg risk.
 */
'use strict';

const { TARGET_STAKE_USD } = require('../research/capital-policy');
const makeV3Strategies = require('./research-v3');

const {
  digitalImpliedSigma,
  marketUpProbability,
} = makeV3Strategies._test;

const CRYPTO_TAKER_RATE = 0.07;
const MAX_TOTAL_STAKE_USD = TARGET_STAKE_USD;
const DEPTH_PARTICIPATION = 0.20;
const MIN_EDGE_2X = 0.02;
const THESIS_VERSION = '2026-07-15-v4-pilot-v1-500usd';
const HOUR_ASSETS = new Set(['btc', 'eth', 'sol', 'xrp']);

const inBand = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
const feePerShare = (price, multiplier = 1) =>
  CRYPTO_TAKER_RATE * price * (1 - price) * multiplier;
const edgeAfterCosts = (probability, ask, multiplier = 1) =>
  probability - ask - feePerShare(ask, multiplier);

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function boundedRemember(set, value, limit = 2000) {
  set.add(value);
  if (set.size > limit) set.delete(set.values().next().value);
}

function bookMid(book) {
  const bid = Number(book?.bids?.[0]?.[0]);
  const ask = Number(book?.asks?.[0]?.[0]);
  return bid > 0 && ask > bid ? (bid + ask) / 2 : null;
}

function positiveProbability(ctx, maxComplementGap = 0.10) {
  const positive = Number.isFinite(ctx.upMid) ? ctx.upMid : bookMid(ctx.upBook);
  const negative = bookMid(ctx.downBook);
  const fromNegative = Number.isFinite(negative) ? 1 - negative : null;
  if (Number.isFinite(positive) && Number.isFinite(fromNegative)) {
    if (Math.abs(positive - fromNegative) > maxComplementGap) return null;
    return (positive + fromNegative) / 2;
  }
  return Number.isFinite(positive) ? positive : fromNegative;
}

function tokenLabels(ctx) {
  return {
    positive: String(ctx.market?.positive_label || 'UP').toUpperCase(),
    negative: String(ctx.market?.negative_label || 'DOWN').toUpperCase(),
  };
}

function tokenView(ctx, token, probabilityPositive) {
  const labels = tokenLabels(ctx);
  const positive = token === labels.positive;
  const book = positive ? ctx.upBook : ctx.downBook;
  return {
    token,
    probability: positive ? probabilityPositive : 1 - probabilityPositive,
    ask: Number(book?.asks?.[0]?.[0]),
    askSize: Number(book?.asks?.[0]?.[1]),
  };
}

function takerAction(ctx, engine, strategy, token, probabilityPositive, note, extra = {}) {
  if (!inBand(probabilityPositive, 0.000001, 0.999999)) return null;
  const quote = tokenView(ctx, token, probabilityPositive);
  const edge = edgeAfterCosts(quote.probability, quote.ask, 2);
  if (!inBand(quote.ask, 0.10, 0.92) || !(quote.askSize > 0) || edge < MIN_EDGE_2X) return null;
  const shares = Math.min(MAX_TOTAL_STAKE_USD / quote.ask, quote.askSize * DEPTH_PARTICIPATION);
  if (!(shares > 0) || shares * quote.ask < 1) return null;
  return {
    action: 'place', side: 'BUY', token, price: quote.ask, size: shares,
    kind: 'taker', coid: engine._coid(strategy), queueAhead: quote.askSize,
    executionModel: 'latency_1s', thesisVersion: THESIS_VERSION,
    note: `${note} edge2x=${edge.toFixed(3)} stake=$${(shares * quote.ask).toFixed(2)} depth_part=20%`,
    ...extra,
  };
}

function bestFairAction(ctx, engine, strategy, probabilityPositive, note, extra = {}) {
  const labels = tokenLabels(ctx);
  const candidates = [labels.positive, labels.negative]
    .map((token) => ({ token, quote: tokenView(ctx, token, probabilityPositive) }))
    .filter(({ quote }) => inBand(quote.ask, 0.10, 0.92) && quote.askSize > 0)
    .map(({ token, quote }) => ({ token, edge: edgeAfterCosts(quote.probability, quote.ask, 2) }))
    .sort((a, b) => b.edge - a.edge);
  if (!candidates.length || candidates[0].edge < MIN_EDGE_2X) return null;
  return takerAction(ctx, engine, strategy, candidates[0].token, probabilityPositive, note, extra);
}

function moveFromOpenBps(ctx) {
  return ctx.btc > 0 && ctx.cexRef > 0 ? 10000 * Math.log(ctx.btc / ctx.cexRef) : null;
}

function snapshot(ctx) {
  const labels = tokenLabels(ctx);
  return {
    at: ctx.now,
    marketId: ctx.market?.id,
    eventId: ctx.market?.event_id,
    asset: ctx.market?.asset,
    marketType: ctx.market?.market_type,
    tteSec: ctx.tteSec,
    strike: ctx.strike,
    lower: ctx.lowerBound,
    upper: ctx.upperBound,
    positiveLabel: labels.positive,
    negativeLabel: labels.negative,
    positiveAsk: Number(ctx.upBook?.asks?.[0]?.[0]),
    positiveAskSize: Number(ctx.upBook?.asks?.[0]?.[1]),
    negativeAsk: Number(ctx.downBook?.asks?.[0]?.[0]),
    negativeAskSize: Number(ctx.downBook?.asks?.[0]?.[1]),
    positiveMid: positiveProbability(ctx),
    modelFair: ctx.modelFairPositive,
    ret30: ctx.micro30?.returnBps,
  };
}

function rememberByEvent(store, ctx) {
  const row = snapshot(ctx);
  if (!row.eventId || row.marketId == null) return [];
  if (!store.has(row.eventId)) store.set(row.eventId, new Map());
  const event = store.get(row.eventId);
  event.set(row.marketId, row);
  for (const [marketId, value] of event) if (ctx.now - value.at > 5000) event.delete(marketId);
  if (store.size > 100) store.delete(store.keys().next().value);
  return [...event.values()].filter((value) => ctx.now - value.at <= 2500);
}

function bundleActions(engine, strategy, legs, residual, note) {
  if (residual < MIN_EDGE_2X || legs.length < 2) return [];
  const combinedAsk = legs.reduce((sum, leg) => sum + leg.ask, 0);
  const shares = Math.min(
    MAX_TOTAL_STAKE_USD / combinedAsk,
    ...legs.map((leg) => leg.askSize * DEPTH_PARTICIPATION),
  );
  if (!(shares > 0) || shares * combinedAsk < 1) return [];
  const groupId = engine._coid(`${strategy}-group`);
  return legs.map((leg, index) => ({
    action: 'place', side: 'BUY', token: leg.token, price: leg.ask, size: shares,
    kind: 'taker', coid: engine._coid(strategy), queueAhead: leg.askSize,
    executionModel: 'latency_1s', thesisVersion: THESIS_VERSION,
    groupId, marketId: leg.marketId, tteSec: leg.tteSec,
    features: {
      structural_group: true,
      group_leg_index: index,
      group_leg_count: legs.length,
      group_cost_per_share: combinedAsk,
      group_edge_2x_per_share: residual,
      group_execution: 'non_atomic_equal_share',
    },
    note: `${note} group=${groupId} leg=${index + 1}/${legs.length} ` +
      `cost=${combinedAsk.toFixed(3)} edge2x=${residual.toFixed(3)} total_stake=$${(shares * combinedAsk).toFixed(2)} ` +
      'non_atomic_leg_risk=true',
  }));
}

/** H22 — direct Binance resolver displacement vs an executable hourly token. */
class HourlyResolverDislocation {
  constructor() {
    this.name = 'H22_hourly_resolver_dislocation';
    this.marketTypes = ['direction_1h'];
    this._fired = new Set();
  }
  onHalt() { return []; }
  evaluate(ctx, engine) {
    const id = ctx.market?.id;
    const move = moveFromOpenBps(ctx);
    const ret30 = ctx.micro30?.returnBps;
    if (id == null || this._fired.has(id) || !HOUR_ASSETS.has(ctx.market?.asset) ||
        !inBand(ctx.tteSec, 60, 1200) || !Number.isFinite(ctx.modelFairPositive) ||
        !Number.isFinite(move) || Math.abs(move) < 8 || !Number.isFinite(ret30) ||
        Math.sign(move) !== Math.sign(ret30) || Math.abs(ret30) < 2) return [];
    const action = bestFairAction(ctx, engine, this.name, ctx.modelFairPositive,
      `binance_resolver_open_move=${move.toFixed(2)}bp resolver_ret30=${ret30.toFixed(2)}bp`);
    if (!action) return [];
    boundedRemember(this._fired, id);
    return [action];
  }
}

/** H23 — independent-venue confirmation of the Binance-resolver move. */
class HourlyCrossVenueConfirmation {
  constructor() {
    this.name = 'H23_hourly_crossvenue_confirmation';
    this.marketTypes = ['direction_1h'];
    this._fired = new Set();
  }
  onHalt() { return []; }
  evaluate(ctx, engine) {
    const id = ctx.market?.id;
    const primary = ctx.micro30?.returnBps;
    const secondary = ctx.venue30?.returnBps;
    if (id == null || this._fired.has(id) || !HOUR_ASSETS.has(ctx.market?.asset) ||
        ctx.venueStale !== false || !inBand(ctx.tteSec, 120, 1800) ||
        !Number.isFinite(ctx.modelFairPositive) || !Number.isFinite(primary) ||
        !Number.isFinite(secondary) || Math.sign(primary) !== Math.sign(secondary) ||
        Math.abs(primary) < 3 || Math.abs(secondary) < 3 || Math.abs(primary - secondary) > 4) return [];
    const action = bestFairAction(ctx, engine, this.name, ctx.modelFairPositive,
      `binance30=${primary.toFixed(2)}bp coinbase30=${secondary.toFixed(2)}bp`);
    if (!action) return [];
    boundedRemember(this._fired, id);
    return [action];
  }
}

/** H24 — hourly opening-range continuation confirmed by aggressor flow/depth. */
class HourlyFlowBreakout {
  constructor() {
    this.name = 'H24_hourly_flow_breakout';
    this.marketTypes = ['direction_1h'];
    this._fired = new Set();
  }
  onHalt() { return []; }
  evaluate(ctx, engine) {
    const id = ctx.market?.id;
    const move = moveFromOpenBps(ctx);
    const micro = ctx.micro10;
    const sign = Math.sign(move);
    if (id == null || this._fired.has(id) || !HOUR_ASSETS.has(ctx.market?.asset) ||
        !inBand(ctx.tteSec, 300, 2400) || !Number.isFinite(ctx.modelFairPositive) ||
        !sign || Math.abs(move) < 10 || !Number.isFinite(micro?.returnBps) ||
        sign * micro.returnBps < 2 || sign * micro.flowImbalance < 0.20 ||
        sign * micro.depthImbalance < 0.10) return [];
    const action = bestFairAction(ctx, engine, this.name, ctx.modelFairPositive,
      `open_move=${move.toFixed(2)}bp ret10=${micro.returnBps.toFixed(2)}bp ` +
      `flow=${micro.flowImbalance.toFixed(2)} depth=${micro.depthImbalance.toFixed(2)}`);
    if (!action) return [];
    boundedRemember(this._fired, id);
    return [action];
  }
}

/** H25 — five-minute/hourly digital-implied volatility term-structure outlier. */
class HorizonVolSurface {
  constructor() {
    this.name = 'H25_horizon_vol_surface';
    this.marketTypes = ['direction_5m', 'direction_1h'];
    this._fiveMinute = new Map();
    this._fired = new Set();
  }
  onHalt() { return []; }
  evaluate(ctx, engine) {
    const asset = ctx.market?.asset;
    const type = ctx.market?.market_type || 'direction_5m';
    const marketProbability = type === 'direction_5m'
      ? marketUpProbability(ctx) : positiveProbability(ctx);
    if (!HOUR_ASSETS.has(asset) || !Number.isFinite(marketProbability) ||
        !(ctx.btc > 0) || !(ctx.ref > 0) || !(ctx.tteSec > 0)) return [];
    const implied = digitalImpliedSigma(marketProbability, ctx.btc, ctx.ref, ctx.tteSec);
    if (type === 'direction_5m') {
      if (implied > 0 && inBand(ctx.tteSec, 60, 240)) this._fiveMinute.set(asset, { at: ctx.now, implied });
      return [];
    }
    const id = ctx.market?.id;
    const short = this._fiveMinute.get(asset);
    if (id == null || this._fired.has(id) || !short || ctx.now - short.at > 360000 ||
        !inBand(ctx.tteSec, 300, 1800) || !(implied > 0) || !Number.isFinite(ctx.modelFairPositive)) return [];
    const anchor = median([short.implied, ctx.volatility?.robustSigma5m].filter((value) => value > 0));
    if (!(anchor > 0)) return [];
    const ratio = implied / anchor;
    if (ratio < 1.75 && ratio > 1 / 1.75) return [];
    const action = bestFairAction(ctx, engine, this.name, ctx.modelFairPositive,
      `hourly_implied_sigma5m=${implied.toFixed(5)} short_anchor=${anchor.toFixed(5)} ratio=${ratio.toFixed(2)}`);
    if (!action) return [];
    boundedRemember(this._fired, id);
    return [action];
  }
}

/** H26 — exact nested-threshold bundle: YES(low strike) + NO(high strike). */
class NestedThresholdBundle {
  constructor() {
    this.name = 'H26_nested_threshold_bundle';
    this.marketTypes = ['threshold_daily'];
    this._events = new Map();
    this._fired = new Set();
  }
  onHalt() { return []; }
  evaluate(ctx, engine) {
    const rows = rememberByEvent(this._events, ctx).filter((row) => Number.isFinite(row.strike));
    if (rows.length < 2) return [];
    const sorted = [...rows].sort((a, b) => a.strike - b.strike);
    let best = null;
    for (let i = 0; i < sorted.length - 1; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const low = sorted[i]; const high = sorted[j];
        if (!(low.positiveAsk > 0 && low.positiveAskSize > 0 && high.negativeAsk > 0 && high.negativeAskSize > 0)) continue;
        const residual = 1 - low.positiveAsk - high.negativeAsk -
          feePerShare(low.positiveAsk, 2) - feePerShare(high.negativeAsk, 2);
        if (!best || residual > best.residual) best = { low, high, residual };
      }
    }
    if (!best || best.residual < MIN_EDGE_2X) return [];
    const key = `${best.low.eventId}:${best.low.marketId}:${best.high.marketId}`;
    if (this._fired.has(key)) return [];
    const actions = bundleActions(engine, this.name, [
      { marketId: best.low.marketId, tteSec: best.low.tteSec, token: best.low.positiveLabel,
        ask: best.low.positiveAsk, askSize: best.low.positiveAskSize },
      { marketId: best.high.marketId, tteSec: best.high.tteSec, token: best.high.negativeLabel,
        ask: best.high.negativeAsk, askSize: best.high.negativeAskSize },
    ], best.residual, `nested_threshold low=${best.low.strike} high=${best.high.strike} guaranteed_min_payout=1`);
    if (actions.length) boundedRemember(this._fired, key);
    return actions;
  }
}

function disjointRanges(left, right) {
  const leftBefore = left.upper != null && right.lower != null && left.upper <= right.lower;
  const rightBefore = right.upper != null && left.lower != null && right.upper <= left.lower;
  return leftBefore || rightBefore;
}

/** H27 — exact disjoint-bucket bundle: NO(bucket A) + NO(bucket B). */
class DisjointBucketBundle {
  constructor() {
    this.name = 'H27_disjoint_bucket_bundle';
    this.marketTypes = ['range_daily'];
    this._events = new Map();
    this._fired = new Set();
  }
  onHalt() { return []; }
  evaluate(ctx, engine) {
    const rows = rememberByEvent(this._events, ctx);
    if (rows.length < 2) return [];
    let best = null;
    for (let i = 0; i < rows.length - 1; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const left = rows[i]; const right = rows[j];
        if (!disjointRanges(left, right) || !(left.negativeAsk > 0 && right.negativeAsk > 0) ||
            !(left.negativeAskSize > 0 && right.negativeAskSize > 0)) continue;
        const residual = 1 - left.negativeAsk - right.negativeAsk -
          feePerShare(left.negativeAsk, 2) - feePerShare(right.negativeAsk, 2);
        if (!best || residual > best.residual) best = { left, right, residual };
      }
    }
    if (!best || best.residual < MIN_EDGE_2X) return [];
    const ids = [best.left.marketId, best.right.marketId].sort();
    const key = `${best.left.eventId}:${ids.join(':')}`;
    if (this._fired.has(key)) return [];
    const actions = bundleActions(engine, this.name, [
      { marketId: best.left.marketId, tteSec: best.left.tteSec, token: best.left.negativeLabel,
        ask: best.left.negativeAsk, askSize: best.left.negativeAskSize },
      { marketId: best.right.marketId, tteSec: best.right.tteSec, token: best.right.negativeLabel,
        ask: best.right.negativeAsk, askSize: best.right.negativeAskSize },
    ], best.residual, 'mutually_exclusive_buckets guaranteed_min_payout=1');
    if (actions.length) boundedRemember(this._fired, key);
    return actions;
  }
}

/** H28 — last-five-minute direct Binance close estimate for threshold markets. */
class ThresholdResolverClose {
  constructor() {
    this.name = 'H28_threshold_resolver_close';
    this.marketTypes = ['threshold_daily'];
    this._fired = new Set();
  }
  onHalt() { return []; }
  evaluate(ctx, engine) {
    const id = ctx.market?.id;
    if (id == null || this._fired.has(id) || !inBand(ctx.tteSec, 30, 300) ||
        !Number.isFinite(ctx.modelFairPositive) || !Number.isFinite(ctx.strike)) return [];
    const action = bestFairAction(ctx, engine, this.name, ctx.modelFairPositive,
      `binance_1m_close_threshold=${ctx.strike} spot=${Number(ctx.btc).toFixed(6)} tte=${ctx.tteSec.toFixed(1)}s`);
    if (!action) return [];
    boundedRemember(this._fired, id);
    return [action];
  }
}

/** H29 — last-five-minute direct Binance close estimate for disjoint buckets. */
class RangeResolverClose {
  constructor() {
    this.name = 'H29_range_resolver_close';
    this.marketTypes = ['range_daily'];
    this._fired = new Set();
  }
  onHalt() { return []; }
  evaluate(ctx, engine) {
    const id = ctx.market?.id;
    if (id == null || this._fired.has(id) || !inBand(ctx.tteSec, 30, 300) ||
        !Number.isFinite(ctx.modelFairPositive)) return [];
    const action = bestFairAction(ctx, engine, this.name, ctx.modelFairPositive,
      `binance_1m_close_range=[${ctx.lowerBound ?? '-inf'},${ctx.upperBound ?? 'inf'}) ` +
      `spot=${Number(ctx.btc).toFixed(6)} tte=${ctx.tteSec.toFixed(1)}s`);
    if (!action) return [];
    boundedRemember(this._fired, id);
    return [action];
  }
}

/** H30 — one threshold leg stale relative to its same-event neighbours. */
class ThresholdLadderResidual {
  constructor() {
    this.name = 'H30_threshold_ladder_residual';
    this.marketTypes = ['threshold_daily'];
    this._events = new Map();
    this._fired = new Set();
  }
  onHalt() { return []; }
  evaluate(ctx, engine) {
    const rows = rememberByEvent(this._events, ctx)
      .filter((row) => Number.isFinite(row.modelFair) && Number.isFinite(row.positiveMid) && Number.isFinite(row.strike));
    if (rows.length < 3 || !inBand(ctx.tteSec, 60, 1800)) return [];
    const enriched = rows.map((row) => ({ ...row, residual: row.modelFair - row.positiveMid }));
    const current = enriched.find((row) => row.marketId === ctx.market?.id);
    if (!current || this._fired.has(current.marketId)) return [];
    const peerResidual = median(enriched.filter((row) => row.marketId !== current.marketId).map((row) => row.residual));
    if (!Number.isFinite(peerResidual) || Math.abs(current.residual - peerResidual) < 0.05) return [];
    const action = bestFairAction(ctx, engine, this.name, current.modelFair,
      `strike=${current.strike} local_residual=${current.residual.toFixed(3)} peer_median=${peerResidual.toFixed(3)} n=${rows.length}`);
    if (!action) return [];
    boundedRemember(this._fired, current.marketId);
    return [action];
  }
}

/** H31 — cross-asset hourly probability residual after a broad CEX move. */
class HourlyCrossAssetResidual {
  constructor() {
    this.name = 'H31_hourly_crossasset_residual';
    this.marketTypes = ['direction_1h'];
    this._latest = new Map();
    this._fired = new Set();
  }
  onHalt() { return []; }
  evaluate(ctx, engine) {
    const asset = ctx.market?.asset;
    const marketProbability = positiveProbability(ctx);
    if (!HOUR_ASSETS.has(asset) || !Number.isFinite(marketProbability) ||
        !Number.isFinite(ctx.modelFairPositive) || !Number.isFinite(ctx.micro30?.returnBps)) return [];
    const current = {
      at: ctx.now, asset, marketId: ctx.market?.id,
      residual: ctx.modelFairPositive - marketProbability,
      ret30: ctx.micro30.returnBps,
    };
    this._latest.set(asset, current);
    const peers = [...this._latest.values()].filter((row) => row.asset !== asset && ctx.now - row.at <= 2500);
    if (current.marketId == null || this._fired.has(current.marketId) || peers.length < 3 ||
        !inBand(ctx.tteSec, 120, 1800)) return [];
    const peerResidual = median(peers.map((row) => row.residual));
    const peerReturn = median(peers.map((row) => row.ret30));
    const excess = current.residual - peerResidual;
    const sign = Math.sign(excess);
    if (!sign || Math.abs(excess) < 0.05 || !Number.isFinite(peerReturn) ||
        sign * peerReturn < 2 || sign * current.ret30 < 2) return [];
    const action = bestFairAction(ctx, engine, this.name, ctx.modelFairPositive,
      `asset_residual=${current.residual.toFixed(3)} peer_residual=${peerResidual.toFixed(3)} ` +
      `target30=${current.ret30.toFixed(2)}bp peer30=${peerReturn.toFixed(2)}bp peers=${peers.length}`);
    if (!action) return [];
    boundedRemember(this._fired, current.marketId);
    return [action];
  }
}

function makeV4Strategies() {
  return [
    new HourlyResolverDislocation(),
    new HourlyCrossVenueConfirmation(),
    new HourlyFlowBreakout(),
    new HorizonVolSurface(),
    new NestedThresholdBundle(),
    new DisjointBucketBundle(),
    new ThresholdResolverClose(),
    new RangeResolverClose(),
    new ThresholdLadderResidual(),
    new HourlyCrossAssetResidual(),
  ];
}

module.exports = makeV4Strategies;
module.exports._test = {
  DisjointBucketBundle,
  HorizonVolSurface,
  HourlyCrossAssetResidual,
  HourlyCrossVenueConfirmation,
  HourlyFlowBreakout,
  HourlyResolverDislocation,
  NestedThresholdBundle,
  RangeResolverClose,
  ThresholdLadderResidual,
  ThresholdResolverClose,
  bestFairAction,
  bundleActions,
  disjointRanges,
  edgeAfterCosts,
  feePerShare,
  positiveProbability,
};
