/**
 * Frozen T-240 four-state residual forward arm.
 *
 * This is a paper-only test of a discovery model. Coefficients and execution
 * rules are frozen in the matching manifest; pre-freeze rows are not evidence.
 */
'use strict';

const { TARGET_STAKE_USD } = require('../research/capital-policy');

const STRATEGY = 'T240_four_state_residual_v1';
const COEFFICIENTS = Object.freeze([-0.282899, 1.188078, -0.182171, 0.153905, 0.489076]);
const ASSETS = new Set(['btc', 'eth', 'sol', 'bnb', 'doge', 'xrp', 'hype']);
const CRYPTO_TAKER_RATE = 0.07;
const FEE_MULTIPLIER = 2;
const EDGE_BUFFER = 0.01;
const DEPTH_PARTICIPATION = 0.20;
const LOOKBACK_MS = 60_000;
const MIN_HISTORY_MS = 55_000;

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampProbability(value) {
  return Math.max(0.001, Math.min(0.999, value));
}

function logistic(value) {
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));
}

function feePerShare(price, multiplier = FEE_MULTIPLIER) {
  return multiplier * CRYPTO_TAKER_RATE * price * (1 - price);
}

function stateFor(momentumBps, marketUp) {
  const cexUp = momentumBps >= 0;
  if (cexUp && marketUp) return 0;
  if (cexUp && !marketUp) return 1;
  if (!cexUp && marketUp) return 2;
  return 3;
}

function predictFourState(mid, state) {
  const probability = clampProbability(mid);
  const logOdds = Math.log(probability / (1 - probability));
  const features = [1, logOdds, state === 1 ? 1 : 0, state === 2 ? 1 : 0, state === 3 ? 1 : 0];
  return clampProbability(logistic(features.reduce(
    (sum, value, index) => sum + value * COEFFICIENTS[index], 0,
  )));
}

function quote(book) {
  return {
    ask: finite(book?.asks?.[0]?.[0]),
    askSize: finite(book?.asks?.[0]?.[1]),
  };
}

class T240FourStateResidual {
  constructor() {
    this.name = STRATEGY;
    this.marketTypes = ['direction_5m'];
    this.cadence = 'sampled';
    this._history = new Map();
    this._fired = new Set();
  }

  onHalt() { return []; }

  _remember(asset, now, price) {
    const history = this._history.get(asset) || [];
    history.push({ at: now, price });
    while (history.length && history[0].at < now - 70_000) history.shift();
    this._history.set(asset, history);
    return history;
  }

  evaluate(ctx, engine) {
    const asset = String(ctx.market?.asset || '').toLowerCase();
    const marketId = ctx.market?.id;
    const spot = finite(ctx.btc);
    if (!ASSETS.has(asset) || marketId == null || !(spot > 0)) return [];
    const history = this._remember(asset, ctx.now, spot);
    if (this._fired.has(marketId) || !(ctx.tteSec <= 240.5 && ctx.tteSec >= 237.5)) return [];

    const old = [...history].reverse().find((row) => row.at <= ctx.now - LOOKBACK_MS);
    if (!old || ctx.now - old.at < MIN_HISTORY_MS || !(old.price > 0)) return [];
    const momentumBps = 10_000 * Math.log(spot / old.price);
    const upBid = finite(ctx.upBook?.bids?.[0]?.[0]);
    const upAsk = finite(ctx.upBook?.asks?.[0]?.[0]);
    if (!(upBid > 0.01 && upAsk > upBid && upAsk < 0.99)) return [];
    const mid = (upBid + upAsk) / 2;
    const state = stateFor(momentumBps, mid >= 0.5);
    const fairUp = predictFourState(mid, state);
    const up = quote(ctx.upBook);
    const down = quote(ctx.downBook);
    const candidates = [
      { token: String(ctx.market?.positive_label || 'UP').toUpperCase(), ...up, probability: fairUp },
      { token: String(ctx.market?.negative_label || 'DOWN').toUpperCase(), ...down, probability: 1 - fairUp },
    ].map((candidate) => ({
      ...candidate,
      edge2x: candidate.ask == null ? -Infinity
        : candidate.probability - candidate.ask - feePerShare(candidate.ask),
    })).filter((candidate) => candidate.ask > 0.01 && candidate.ask < 0.99 && candidate.askSize > 0)
      .sort((left, right) => right.edge2x - left.edge2x);
    const best = candidates[0];
    if (!best || best.edge2x < EDGE_BUFFER) return [];

    const shares = Math.min(TARGET_STAKE_USD / best.ask, best.askSize * DEPTH_PARTICIPATION);
    if (!(shares > 0) || shares * best.ask < 1) return [];
    this._fired.add(marketId);
    if (this._fired.size > 5000) this._fired.delete(this._fired.values().next().value);
    return [{
      action: 'place', side: 'BUY', token: best.token, price: best.ask, size: shares,
      kind: 'taker', coid: engine._coid(this.name), queueAhead: best.askSize,
      executionModel: 'latency_1s',
      thesisVersion: 't240-four-state-residual-v1-frozen',
      features: {
        model_family: 'four_state_residual', benchmark: 'executable_ask', fair_up: fairUp,
        market_mid_up: mid, cex_momentum_60s_bps: momentumBps, four_state: state,
        frozen_coefficients: COEFFICIENTS, edge_2x_per_share: best.edge2x,
        displayed_touch_shares: best.askSize, depth_participation: DEPTH_PARTICIPATION,
        displayed_capacity_usd: best.ask * best.askSize,
        simulated_notional_usd: best.ask * shares, atomic_external_hedge: false,
      },
      note: `frozen T-240 residual state=${state} fair=${fairUp.toFixed(4)} ask=${best.ask.toFixed(4)} edge2x=${best.edge2x.toFixed(4)}`,
    }];
  }
}

module.exports = () => [new T240FourStateResidual()];
module.exports._test = { COEFFICIENTS, T240FourStateResidual, feePerShare, predictFourState, stateFor };
