/**
 * MAIN V2 — frozen resolver-aware quorum strategy.
 *
 * This is intentionally implemented in the BORG shadow plane rather than the
 * legacy BotInstance execution path. It has no credentials, signer, order
 * client or live path. The scorer applies the same causal quote-survival,
 * depth, latency and fee model used by every institutional shadow trial.
 */
'use strict';

const { TARGET_STAKE_USD } = require('../research/capital-policy');
const makeV3Strategies = require('./research-v3');

const { binaryFair } = makeV3Strategies._test;

const STRATEGY_NAME = 'MAIN_V2_resolver_quorum';
const THESIS_VERSION = 'main-v2-resolver-quorum-v1';
const SUPPORTED_ASSETS = new Set(['btc', 'eth', 'sol', 'xrp']);
const CRYPTO_TAKER_RATE = 0.07;
const MIN_TTE_SEC = 60;
const MAX_TTE_SEC = 300;
const MAX_RESOLVER_AGE_MS = 3000;
const MIN_SOURCE_MOVE_BPS = 2.5;
const MAX_QUORUM_DISAGREEMENT_BPS = 2.5;
const MIN_BINANCE_RESIDUAL_BPS = 2.5;
const MIN_EDGE_AFTER_2X_FEES = 0.02;
const MIN_ASK = 0.08;
const MAX_ASK = 0.94;
const MAX_TOUCH_PARTICIPATION = 0.20;

const inBand = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
const feePerShare = (price, multiplier = 1) =>
  CRYPTO_TAKER_RATE * price * (1 - price) * multiplier;

function remember(set, value, limit = 3000) {
  set.add(value);
  if (set.size > limit) set.delete(set.values().next().value);
}

function labels(ctx) {
  return {
    positive: String(ctx.market?.positive_label || 'UP').toUpperCase(),
    negative: String(ctx.market?.negative_label || 'DOWN').toUpperCase(),
  };
}

function fairPositive(ctx, residualBps) {
  if (!(ctx.btc > 0) || !(ctx.ref > 0) || !(ctx.sigma > 0) || !(ctx.tteSec > 0)) return null;
  const projectedSpot = ctx.btc * Math.exp(residualBps / 10000);
  return binaryFair(projectedSpot, ctx.ref, ctx.sigma, ctx.tteSec);
}

class MainV2ResolverQuorum {
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

    const binance10 = ctx.micro10?.returnBps;
    const coinbase10 = ctx.venue10?.returnBps;
    const chainlink10 = ctx.rtdsChainlink10?.returnBps;
    if (![binance10, coinbase10, chainlink10].every(Number.isFinite)) return [];
    if (Math.sign(coinbase10) === 0 || Math.sign(coinbase10) !== Math.sign(chainlink10)) return [];
    if (Math.abs(coinbase10) < MIN_SOURCE_MOVE_BPS || Math.abs(chainlink10) < MIN_SOURCE_MOVE_BPS) return [];
    if (Math.abs(coinbase10 - chainlink10) > MAX_QUORUM_DISAGREEMENT_BPS) return [];

    const consensusBps = (coinbase10 + chainlink10) / 2;
    const residualBps = consensusBps - binance10;
    if (Math.abs(residualBps) < MIN_BINANCE_RESIDUAL_BPS ||
        Math.sign(residualBps) !== Math.sign(consensusBps)) return [];

    const probabilityPositive = fairPositive(ctx, residualBps);
    if (!inBand(probabilityPositive, 0.000001, 0.999999)) return [];

    const names = labels(ctx);
    const positive = consensusBps > 0;
    const token = positive ? names.positive : names.negative;
    const book = positive ? ctx.upBook : ctx.downBook;
    const ask = Number(book?.asks?.[0]?.[0]);
    const askSize = Number(book?.asks?.[0]?.[1]);
    const probability = positive ? probabilityPositive : 1 - probabilityPositive;
    if (!inBand(ask, MIN_ASK, MAX_ASK) || !(askSize > 0)) return [];

    const edge2x = probability - ask - feePerShare(ask, 2);
    if (edge2x < MIN_EDGE_AFTER_2X_FEES) return [];

    const shares = Math.min(TARGET_STAKE_USD / ask, askSize * MAX_TOUCH_PARTICIPATION);
    const notional = shares * ask;
    if (!(shares > 0) || notional < 1) return [];

    remember(this._fired, marketId);
    return [{
      action: 'place',
      side: 'BUY',
      token,
      price: ask,
      size: shares,
      kind: 'taker',
      coid: engine._coid(this.name),
      queueAhead: askSize,
      executionModel: 'event_order_250ms',
      thesisVersion: THESIS_VERSION,
      features: {
        mechanism_family: 'resolver_quorum_latency',
        cross_network_arbitrage: true,
        network_set: 'coinbase|chainlink_rtds|binance_direct|polymarket_clob',
        atomic_external_hedge: false,
        main_v2: true,
        hold_to_resolution: true,
        resolver_age_ms: resolverAgeMs,
        binance_10s_bps: binance10,
        coinbase_10s_bps: coinbase10,
        chainlink_10s_bps: chainlink10,
        quorum_consensus_bps: consensusBps,
        binance_residual_bps: residualBps,
        model_probability: probability,
        edge_after_2x_fees: edge2x,
        touch_participation: shares / askSize,
      },
      note: `resolver_quorum consensus=${consensusBps.toFixed(2)}bp ` +
        `binance=${binance10.toFixed(2)}bp residual=${residualBps.toFixed(2)}bp ` +
        `edge2x=${edge2x.toFixed(3)} stake=$${notional.toFixed(2)}`,
    }];
  }
}

function makeMainV2Strategies() {
  return [new MainV2ResolverQuorum()];
}

module.exports = makeMainV2Strategies;
module.exports._test = {
  MainV2ResolverQuorum,
  STRATEGY_NAME,
  fairPositive,
  feePerShare,
};
