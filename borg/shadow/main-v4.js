/**
 * MAIN V4 — warm conservative-volatility + temporal-consensus challenger.
 *
 * V3 makes source disagreement explicit, but it can still act before the
 * causal volatility profile is warm and can mistake a shared ten-second
 * impulse for terminal information. V4 is a separate forward arm: it requires
 * the three transports to agree at both 10s and 30s, and prices the terminal
 * binary with the largest available EWMA/RMS/robust five-minute sigma. This is
 * intentionally least favourable; no threshold was selected from V3 PnL.
 *
 * Paper/shadow only. No wallet, signer, CLOB client or order method exists.
 */
'use strict';

const { TARGET_STAKE_USD } = require('../research/capital-policy');
const makeMainV3Strategies = require('./main-v3');

const { sourceEnvelope } = makeMainV3Strategies._test;

const STRATEGY_NAME = 'MAIN_V4_warm_vol_temporal_consensus';
const THESIS_VERSION = 'main-v4-warm-vol-temporal-consensus-v1';
const SUPPORTED_ASSETS = new Set(['btc', 'eth', 'sol', 'xrp']);
const CRYPTO_TAKER_RATE = 0.07;
const MIN_TTE_SEC = 60;
const MAX_TTE_SEC = 300;
const MAX_RESOLVER_AGE_MS = 3000;
const MIN_VOL_OBSERVATIONS = 60;
const MIN_ASK = 0.08;
const MAX_ASK = 0.94;
const MAX_TOUCH_PARTICIPATION = 0.20;
const TOKEN_TICK = 0.01;

const inBand = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
const feePerShare = (price, multiplier = 1) =>
  CRYPTO_TAKER_RATE * price * (1 - price) * multiplier;

function remember(set, value, limit = 3000) {
  set.add(value);
  if (set.size > limit) set.delete(set.values().next().value);
}

function conservativeVolatility(ctx) {
  const profile = ctx.volatility;
  if (!profile || profile.observations < MIN_VOL_OBSERVATIONS) return null;
  const candidates = {
    ewma: Number(ctx.sigma),
    rms: Number(profile.rmsSigma5m),
    robust: Number(profile.robustSigma5m),
  };
  if (!Object.values(candidates).every((value) => Number.isFinite(value) && value > 0)) return null;
  return { sigma5m: Math.max(...Object.values(candidates)), candidates };
}

function temporalConsensus(ctx) {
  const returns = {
    binance10: ctx.micro10?.returnBps,
    binance30: ctx.micro30?.returnBps,
    coinbase10: ctx.venue10?.returnBps,
    coinbase30: ctx.venue30?.returnBps,
    chainlink10: ctx.rtdsChainlink10?.returnBps,
    chainlink30: ctx.rtdsChainlink30?.returnBps,
  };
  if (!Object.values(returns).every(Number.isFinite)) return null;
  const signs = Object.values(returns).map(Math.sign);
  if (!signs[0] || !signs.every((sign) => sign === signs[0])) return null;
  return { sign: signs[0], returns };
}

function labels(ctx) {
  return {
    positive: String(ctx.market?.positive_label || 'UP').toUpperCase(),
    negative: String(ctx.market?.negative_label || 'DOWN').toUpperCase(),
  };
}

class MainV4WarmVolTemporalConsensus {
  constructor() {
    this.name = STRATEGY_NAME;
    this.marketTypes = ['direction_5m'];
    this.cadence = 'event';
    this._fired = new Set();
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
    const marketId = ctx.market?.id;
    const asset = ctx.market?.asset;
    if (marketId == null || this._fired.has(marketId) || !SUPPORTED_ASSETS.has(asset)) return [];
    if (!inBand(ctx.tteSec, MIN_TTE_SEC, MAX_TTE_SEC) || ctx.venueStale !== false) return [];

    const resolverAgeMs = ctx.resolverDivergence?.ageMs;
    if (!Number.isFinite(resolverAgeMs) || resolverAgeMs > MAX_RESOLVER_AGE_MS) return [];

    const volatility = conservativeVolatility(ctx);
    const consensus = temporalConsensus(ctx);
    if (!volatility || !consensus) return [];
    if (Math.sign(ctx.resolverDivergence.signed) !== consensus.sign) return [];

    const envelope = sourceEnvelope(ctx, volatility.sigma5m);
    if (!envelope) return [];
    const names = labels(ctx);
    const candidates = [
      { token: names.positive, probability: envelope.fairUpLow, book: ctx.upBook, direction: 'positive' },
      { token: names.negative, probability: 1 - envelope.fairUpHigh, book: ctx.downBook, direction: 'negative' },
    ].map((candidate) => {
      const ask = Number(candidate.book?.asks?.[0]?.[0]);
      const askSize = Number(candidate.book?.asks?.[0]?.[1]);
      const edge2x = inBand(ask, MIN_ASK, MAX_ASK)
        ? candidate.probability - ask - feePerShare(ask, 2) : -Infinity;
      return { ...candidate, ask, askSize, edge2x };
    }).filter((candidate) => candidate.askSize > 0 && candidate.edge2x >= TOKEN_TICK)
      .sort((left, right) => right.edge2x - left.edge2x);
    if (!candidates.length) return [];

    const selected = candidates[0];
    const shares = Math.min(TARGET_STAKE_USD / selected.ask,
      selected.askSize * MAX_TOUCH_PARTICIPATION);
    const notional = shares * selected.ask;
    if (!(shares > 0) || notional < 1) return [];

    remember(this._fired, marketId);
    return [{
      action: 'place', side: 'BUY', token: selected.token,
      price: selected.ask, size: shares, kind: 'taker',
      coid: engine._coid(this.name), queueAhead: selected.askSize,
      executionModel: 'event_order_250ms', thesisVersion: THESIS_VERSION,
      features: {
        mechanism_family: 'warm_vol_temporal_source_envelope',
        main_v4: true,
        hold_to_resolution: true,
        resolver_age_ms: resolverAgeMs,
        resolver_divergence_signed: ctx.resolverDivergence.signed,
        temporal_consensus_sign: consensus.sign,
        temporal_returns_bps: consensus.returns,
        conservative_sigma_5m: volatility.sigma5m,
        sigma_candidates_5m: volatility.candidates,
        vol_observations: ctx.volatility.observations,
        source_probabilities: envelope.probabilities,
        fair_up_low: envelope.fairUpLow,
        fair_up_high: envelope.fairUpHigh,
        robust_probability: selected.probability,
        edge_after_2x_fees: selected.edge2x,
        uncertainty_hurdle: TOKEN_TICK,
        touch_participation: shares / selected.askSize,
      },
      note: `warm_vol_${selected.direction} p=${selected.probability.toFixed(3)} ` +
        `ask=${selected.ask.toFixed(3)} edge2x=${selected.edge2x.toFixed(3)} ` +
        `sigma=${volatility.sigma5m.toFixed(6)} sign=${consensus.sign}`,
    }];
  }
}

function makeMainV4Strategies() {
  return [new MainV4WarmVolTemporalConsensus()];
}

module.exports = makeMainV4Strategies;
module.exports._test = {
  MIN_VOL_OBSERVATIONS,
  MainV4WarmVolTemporalConsensus,
  STRATEGY_NAME,
  TOKEN_TICK,
  conservativeVolatility,
  temporalConsensus,
};
