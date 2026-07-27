/**
 * H58 source-causal successor.
 *
 * The original H58 confused local packet arrival order with causal source
 * order. This successor can act only when the selected CLOB book's VENUE
 * timestamp is provably between two distinct Chainlink source ticks after a
 * conservative clock-order margin. With the current delayed RTDS path, zero
 * orders is the expected and correct result.
 *
 * The executable ask is the probability prior. The model contributes only the
 * conservative incremental digital-probability change caused by the new
 * resolver tick; it never substitutes an absolute GBM fair value for the
 * market price. This module is shadow-only and imports no signer/order client.
 */
'use strict';

const makeV3Strategies = require('./research-v3');
const makeV7Strategies = require('./research-v7');
const GateDiagnostics = require('./gate-diagnostics');
const { TARGET_STAKE_USD } = require('../research/capital-policy');

const { binaryFair } = makeV3Strategies._test;
const { feePerShare } = makeV7Strategies._test;

const STRATEGY_NAME = 'H58_source_causal_residual_v2';
const STRATEGY_VERSION = 'research-h58-source-causal-residual-v2';
const ASSETS = Object.freeze(['btc', 'eth', 'sol', 'xrp']);
const ASSET_SET = new Set(ASSETS);
const SOURCE_CLOCK_UNCERTAINTY_MS = 1000;
const MAX_LOCAL_QUOTE_AGE_MS = 3000;
const COST_MULTIPLIER = 2;
const EDGE_BUFFER = 0.01;
const DEPTH_PARTICIPATION = 0.20;
const MAX_STAKE_USD = TARGET_STAKE_USD;

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function inBand(value, lower, upper) {
  return Number.isFinite(value) && value >= lower && value <= upper;
}

function clampProbability(value) {
  return Math.max(0.000001, Math.min(0.999999, value));
}

function normalizeSource(value) {
  return String(value || '').toLowerCase().includes('chainlink')
    ? 'chainlink'
    : null;
}

function isChainlinkResolved(ctx) {
  const source = String(ctx.market?.resolution_source || '');
  return /chainlink/i.test(source)
    || (ctx.market?.market_type === 'direction_5m'
      && source === 'polymarket_crypto_5m');
}

function volatilityCandidates(ctx) {
  return [
    finite(ctx.volatility?.robustSigma5m),
    finite(ctx.volatility?.rmsSigma5m),
    finite(ctx.sigma),
  ].filter((value) => value > 1e-8 && value < 1);
}

function resolverProbabilityResidual(ctx, previousSpot, currentSpot, sign) {
  const ref = finite(ctx.resolverRef);
  const tteSec = finite(ctx.tteSec);
  const sigmas = volatilityCandidates(ctx);
  if (!(ref > 0 && previousSpot > 0 && currentSpot > 0 && tteSec > 0)
      || !sigmas.length || !sign) return null;
  const rows = sigmas.map((sigma) => {
    const previousPositive = binaryFair(previousSpot, ref, sigma, tteSec);
    const currentPositive = binaryFair(currentSpot, ref, sigma, tteSec);
    if (!Number.isFinite(previousPositive) || !Number.isFinite(currentPositive)) return null;
    const before = sign > 0 ? previousPositive : 1 - previousPositive;
    const after = sign > 0 ? currentPositive : 1 - currentPositive;
    return {
      sigma,
      before: clampProbability(before),
      after: clampProbability(after),
      residual: after - before,
    };
  }).filter(Boolean);
  if (!rows.length || rows.some((row) => !(row.residual > 0))) return null;
  return {
    lower: Math.min(...rows.map((row) => row.residual)),
    upper: Math.max(...rows.map((row) => row.residual)),
    rows,
  };
}

function quoteForSign(ctx, sign) {
  const positive = sign > 0;
  const book = positive ? ctx.upBook : ctx.downBook;
  const ask = finite(book?.asks?.[0]?.[0]);
  const askSize = finite(book?.asks?.[0]?.[1]);
  const bid = finite(book?.bids?.[0]?.[0]);
  const token = positive
    ? String(ctx.market?.positive_label || 'UP').toUpperCase()
    : String(ctx.market?.negative_label || 'DOWN').toUpperCase();
  if (!(ask > 0 && ask < 1 && askSize > 0 && bid > 0 && bid < ask)) return null;
  return { book, ask, askSize, bid, token };
}

class ResolverSourceCausalResidualV2 {
  constructor() {
    this.name = STRATEGY_NAME;
    this.marketTypes = ['direction_5m', 'direction_15m'];
    this.cadence = 'event';
    this._resolver = new Map();
    this._fired = new Set();
    this._gates = new GateDiagnostics(this.name);
  }

  onHalt() { return []; }

  diagnostics() {
    return {
      gateDiagnostics: this._gates.snapshot(),
      sourceClockUncertaintyMs: SOURCE_CLOCK_UNCERTAINTY_MS,
      marketPrior: 'selected_executable_ask',
      modelContribution: 'resolver_event_probability_residual_only',
      assets: ASSETS,
      marketTypes: this.marketTypes,
    };
  }

  _observeResolver(ctx) {
    const asset = String(ctx.market?.asset || '').toLowerCase();
    const sourceMs = finite(ctx.triggerEvent?.sourceMs);
    const value = finite(ctx.rtdsChainlink);
    const sequence = ctx.triggerEvent?.eventSequence ?? null;
    if (!ASSET_SET.has(asset) || !(sourceMs > 0 && value > 0)) {
      return { reason: 'missing_resolver_source_observation' };
    }
    const state = this._resolver.get(asset);
    if (!state) {
      this._resolver.set(asset, {
        current: { sourceMs, value, sequence },
        pair: null,
      });
      return { reason: 'resolver_history_warmup' };
    }
    if (sourceMs < state.current.sourceMs) {
      return { reason: 'non_monotonic_resolver_source_time' };
    }
    if (sourceMs === state.current.sourceMs) {
      if (sequence === state.current.sequence && value === state.current.value) {
        return state.pair
          ? { pair: state.pair }
          : { reason: 'resolver_history_warmup' };
      }
      return { reason: 'ambiguous_same_source_timestamp' };
    }
    const pair = {
      previous: state.current,
      current: { sourceMs, value, sequence },
    };
    this._resolver.set(asset, { current: pair.current, pair });
    return { pair };
  }

  evaluate(ctx, engine) {
    this._gates.begin();
    const marketId = ctx.market?.id;
    if (normalizeSource(ctx.triggerEvent?.source) !== 'chainlink') {
      return this._gates.reject('not_chainlink_event', ctx.now);
    }
    const observed = this._observeResolver(ctx);
    if (!observed.pair) return this._gates.reject(observed.reason, ctx.now);
    if (marketId == null || this._fired.has(marketId)) {
      return this._gates.reject(marketId == null ? 'missing_market_id' : 'already_fired_market', ctx.now);
    }
    if (!ASSET_SET.has(String(ctx.market?.asset || '').toLowerCase())) {
      return this._gates.reject('asset_not_preregistered', ctx.now);
    }
    if (!isChainlinkResolved(ctx)) {
      return this._gates.reject('market_not_chainlink_resolved', ctx.now);
    }
    if (!inBand(ctx.tteSec, 15, 180)) {
      return this._gates.reject('outside_tte_window', ctx.now);
    }
    if (ctx.resolverRefSource !== 'chainlink_rtds_nearest_3s'
        || !(finite(ctx.resolverRef) > 0)) {
      return this._gates.reject('untrusted_resolver_boundary', ctx.now);
    }

    const { previous, current } = observed.pair;
    const sign = Math.sign(current.value - previous.value);
    if (!sign) return this._gates.reject('zero_resolver_move', ctx.now);
    const quote = quoteForSign(ctx, sign);
    if (!quote) return this._gates.reject('missing_executable_selected_book', ctx.now);

    const eventReceiveMs = finite(ctx.triggerEvent?.receiveWallMs);
    const bookReceiveMs = finite(quote.book?.at);
    const bookSourceMs = finite(quote.book?.sourceAt);
    if (!(eventReceiveMs > 0 && bookReceiveMs > 0 && bookSourceMs > 0)) {
      return this._gates.reject('missing_comparable_source_timestamps', ctx.now);
    }
    const localQuoteAgeMs = eventReceiveMs - bookReceiveMs;
    if (!inBand(localQuoteAgeMs, 0, MAX_LOCAL_QUOTE_AGE_MS)) {
      return this._gates.reject('quote_not_present_before_local_event', ctx.now);
    }
    if (previous.sourceMs > bookSourceMs) {
      return this._gates.reject('book_predates_previous_resolver_tick', ctx.now);
    }
    const causalLeadMs = current.sourceMs - bookSourceMs;
    if (causalLeadMs < SOURCE_CLOCK_UNCERTAINTY_MS) {
      return this._gates.reject('book_not_source_causally_stale', ctx.now);
    }

    const directReturn = finite(ctx.micro10?.returnBps);
    const venueReturn = ctx.venueStale === false
      ? finite(ctx.venue10?.returnBps)
      : null;
    if (!Number.isFinite(directReturn) || !Number.isFinite(venueReturn)
        || sign * directReturn <= 0 || sign * venueReturn <= 0) {
      return this._gates.reject('secondary_venue_return_not_confirmed', ctx.now);
    }

    const residual = resolverProbabilityResidual(
      ctx,
      previous.value,
      current.value,
      sign,
    );
    if (!residual) return this._gates.reject('no_conservative_probability_residual', ctx.now);
    if (!inBand(quote.ask, 0.08, 0.94)) {
      return this._gates.reject('selected_ask_outside_execution_band', ctx.now);
    }
    const marketPrior = quote.ask;
    const fairLower = clampProbability(marketPrior + residual.lower);
    const stressedFee = feePerShare(quote.ask, COST_MULTIPLIER);
    const edge2x = fairLower - quote.ask - stressedFee;
    if (edge2x < EDGE_BUFFER) {
      return this._gates.reject('residual_does_not_clear_2x_costs', ctx.now);
    }
    const shares = Math.min(
      MAX_STAKE_USD / quote.ask,
      quote.askSize * DEPTH_PARTICIPATION,
    );
    if (!(shares > 0) || shares * quote.ask < 1) {
      return this._gates.reject('insufficient_executable_capacity', ctx.now);
    }

    const sourceDeliveryMs = eventReceiveMs - current.sourceMs;
    const action = {
      action: 'place',
      side: 'BUY',
      token: quote.token,
      price: quote.ask,
      size: shares,
      kind: 'taker',
      coid: engine._coid(this.name),
      queueAhead: quote.askSize,
      executionModel: 'event_order_250ms',
      thesisVersion: STRATEGY_VERSION,
      features: {
        mechanism_family: 'resolver_source_order_causal_residual',
        market_prior_probability: marketPrior,
        market_prior_source: 'selected_executable_ask',
        resolver_residual_lower: residual.lower,
        resolver_residual_upper: residual.upper,
        fair_lower_selected: fairLower,
        edge_2x_per_share: edge2x,
        fee_multiplier: COST_MULTIPLIER,
        edge_buffer: EDGE_BUFFER,
        source_clock_uncertainty_ms: SOURCE_CLOCK_UNCERTAINTY_MS,
        previous_resolver_source_ms: previous.sourceMs,
        current_resolver_source_ms: current.sourceMs,
        selected_book_source_ms: bookSourceMs,
        selected_book_receive_ms: bookReceiveMs,
        resolver_event_receive_ms: eventReceiveMs,
        resolver_source_delivery_ms: sourceDeliveryMs,
        book_before_resolver_source_ms: causalLeadMs,
        local_quote_age_at_event_ms: localQuoteAgeMs,
        previous_resolver_price: previous.value,
        current_resolver_price: current.value,
        selected_direction_sign: sign,
        direct_return_10s_bps: directReturn,
        secondary_return_10s_bps: venueReturn,
        displayed_touch_shares: quote.askSize,
        displayed_capacity_usd: quote.ask * quote.askSize,
        depth_participation: DEPTH_PARTICIPATION,
        simulated_notional_usd: quote.ask * shares,
        absolute_terminal_model_not_used_for_edge: true,
        asset_timeframe_arm: `${String(ctx.market.asset).toLowerCase()}_${ctx.market.market_type}`,
        provisional: true,
        paper_only: true,
      },
      note: `source_causal prior=${marketPrior.toFixed(4)} ` +
        `residual=[${residual.lower.toFixed(4)},${residual.upper.toFixed(4)}] ` +
        `edge2x=${edge2x.toFixed(4)} book_lead=${causalLeadMs.toFixed(0)}ms`,
    };
    this._fired.add(marketId);
    if (this._fired.size > 5000) this._fired.delete(this._fired.values().next().value);
    return this._gates.accept([action], ctx.now);
  }
}

function makeV10Strategies() {
  return [new ResolverSourceCausalResidualV2()];
}

module.exports = makeV10Strategies;
module.exports._test = {
  ASSETS,
  MAX_LOCAL_QUOTE_AGE_MS,
  ResolverSourceCausalResidualV2,
  SOURCE_CLOCK_UNCERTAINTY_MS,
  STRATEGY_NAME,
  quoteForSign,
  resolverProbabilityResidual,
};
