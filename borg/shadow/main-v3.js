/**
 * MAIN V3 — robust source-envelope challenger.
 *
 * V2 treated Coinbase + Chainlink as truth and a faster Binance return as the
 * lagging outlier. That is not a defensible price-discovery ordering. V3 keeps
 * every source in the uncertainty set: it translates each source's causal 10s
 * return onto the same Binance level, computes a binary fair for each, and
 * prices from the least favourable fair for the side being bought.
 *
 * Paper/shadow only. No wallet, signer, CLOB client or order method exists.
 */
'use strict';

const { TARGET_STAKE_USD } = require('../research/capital-policy');
const makeV3Strategies = require('./research-v3');

const { binaryFair } = makeV3Strategies._test;

const STRATEGY_NAME = 'MAIN_V3_robust_source_envelope';
const THESIS_VERSION = 'main-v3-robust-source-envelope-v1';
const SUPPORTED_ASSETS = new Set(['btc', 'eth', 'sol', 'xrp']);
const CRYPTO_TAKER_RATE = 0.07;
const MIN_TTE_SEC = 60;
const MAX_TTE_SEC = 300;
const MAX_RESOLVER_AGE_MS = 3000;
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

function sourceEnvelope(ctx, sigma5m = ctx.sigma) {
  const binance10 = ctx.micro10?.returnBps;
  const coinbase10 = ctx.venue10?.returnBps;
  const chainlink10 = ctx.rtdsChainlink10?.returnBps;
  if (!(ctx.btc > 0) || !(ctx.ref > 0) || !(sigma5m > 0) || !(ctx.tteSec > 0) ||
      ![binance10, coinbase10, chainlink10].every(Number.isFinite)) return null;

  // Put all three returns on one level before using the binary model. This
  // avoids mixing absolute exchange/oracle bases while retaining disagreement.
  const returns = { binance: binance10, coinbase: coinbase10, chainlink: chainlink10 };
  const probabilities = {};
  for (const [source, returnBps] of Object.entries(returns)) {
    const adjustedSpot = ctx.btc * Math.exp((returnBps - binance10) / 10000);
    const probability = binaryFair(adjustedSpot, ctx.ref, sigma5m, ctx.tteSec);
    if (!inBand(probability, 0.000001, 0.999999)) return null;
    probabilities[source] = probability;
  }
  const values = Object.values(probabilities);
  return {
    returns,
    probabilities,
    fairUpLow: Math.min(...values),
    fairUpHigh: Math.max(...values),
  };
}

function labels(ctx) {
  return {
    positive: String(ctx.market?.positive_label || 'UP').toUpperCase(),
    negative: String(ctx.market?.negative_label || 'DOWN').toUpperCase(),
  };
}

class MainV3RobustSourceEnvelope {
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

    const envelope = sourceEnvelope(ctx);
    if (!envelope) return [];
    const binanceSign = Math.sign(envelope.returns.binance);
    const coinbaseSign = Math.sign(envelope.returns.coinbase);
    if (!binanceSign || binanceSign !== coinbaseSign) return [];

    // The resolver must actually lag the independent price-discovery quorum in
    // the proposed direction. If it leads or crosses the other way, abstain.
    if (Math.sign(ctx.resolverDivergence.signed) !== binanceSign) return [];

    const names = labels(ctx);
    const candidates = [
      {
        token: names.positive,
        probability: envelope.fairUpLow,
        book: ctx.upBook,
        direction: 'positive',
      },
      {
        token: names.negative,
        probability: 1 - envelope.fairUpHigh,
        book: ctx.downBook,
        direction: 'negative',
      },
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
      action: 'place',
      side: 'BUY',
      token: selected.token,
      price: selected.ask,
      size: shares,
      kind: 'taker',
      coid: engine._coid(this.name),
      queueAhead: selected.askSize,
      executionModel: 'event_order_250ms',
      thesisVersion: THESIS_VERSION,
      features: {
        mechanism_family: 'robust_source_envelope',
        main_v3: true,
        hold_to_resolution: true,
        resolver_age_ms: resolverAgeMs,
        resolver_divergence_signed: ctx.resolverDivergence.signed,
        binance_10s_bps: envelope.returns.binance,
        coinbase_10s_bps: envelope.returns.coinbase,
        chainlink_10s_bps: envelope.returns.chainlink,
        source_probabilities: envelope.probabilities,
        fair_up_low: envelope.fairUpLow,
        fair_up_high: envelope.fairUpHigh,
        robust_probability: selected.probability,
        edge_after_2x_fees: selected.edge2x,
        uncertainty_hurdle: TOKEN_TICK,
        touch_participation: shares / selected.askSize,
      },
      note: `robust_${selected.direction} p=${selected.probability.toFixed(3)} ` +
        `ask=${selected.ask.toFixed(3)} edge2x=${selected.edge2x.toFixed(3)} ` +
        `source_range=[${envelope.fairUpLow.toFixed(3)},${envelope.fairUpHigh.toFixed(3)}]`,
    }];
  }
}

function makeMainV3Strategies() {
  return [new MainV3RobustSourceEnvelope()];
}

module.exports = makeMainV3Strategies;
module.exports._test = {
  MainV3RobustSourceEnvelope,
  STRATEGY_NAME,
  TOKEN_TICK,
  feePerShare,
  sourceEnvelope,
};
