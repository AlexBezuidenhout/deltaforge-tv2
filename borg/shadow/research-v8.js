/**
 * BORG H64-H73 — ten distinct paper-only research mechanisms.
 *
 * The cohort is deliberately frozen before forward PnL exists. It does not
 * revive rejected favourite, generic momentum, static imbalance, inversion,
 * or unconstrained Phi-divergence rules. Every directional order must survive
 * the executable ask, doubled crypto taker fees, a one-cent edge buffer and
 * displayed-depth capacity. The two structural arms additionally expose
 * non-atomic leg risk rather than describing a displayed identity as a lock.
 *
 * There is no signer, wallet, private key or order-submission dependency in
 * this module. Outputs are shadow intents consumed by the paper scorer.
 */
'use strict';

const makeV4Strategies = require('./research-v4');
const makeV7Strategies = require('./research-v7');
const GateDiagnostics = require('./gate-diagnostics');
const { TARGET_STAKE_USD } = require('../research/capital-policy');
const H73_CALIBRATION = require('../research/models/h73-market-prior-calibration-2026-07-26.json');

const { positiveProbability } = makeV4Strategies._test;
const { fairEnvelope } = makeV7Strategies._test;

const STRATEGY_VERSION = 'research-v8-h64-h73-paper-v1';
const CRYPTO_TAKER_RATE = 0.07;
const COST_MULTIPLIER = 2;
const EDGE_BUFFER = 0.01;
const DEPTH_PARTICIPATION = 0.20;
const MAX_STAKE_USD = TARGET_STAKE_USD;
const DIRECTION_ASSETS = new Set(['btc', 'eth', 'sol', 'xrp']);

const STRATEGY_NAMES = Object.freeze([
  'H64_multivenue_cusum_break',
  'H65_kalman_latent_consensus',
  'H66_range_threshold_partition_lock',
  'H67_queue_depletion_hazard',
  'H68_multilevel_ofi_impact',
  'H69_quarticity_confidence_envelope',
  'H70_stationary_block_bootstrap_digital',
  'H71_token_elasticity_residual',
  'H72_crosshorizon_nested_lock',
  'H73_market_prior_calibration_residual',
]);

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function inBand(value, lower, upper) {
  return Number.isFinite(value) && value >= lower && value <= upper;
}

function clamp(value, lower, upper) {
  return Math.max(lower, Math.min(upper, value));
}

function clampProbability(value) {
  return clamp(value, 0.000001, 0.999999);
}

function mean(values) {
  const clean = values.map(finite).filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function median(values) {
  const clean = values.map(finite).filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (!clean.length) return null;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2
    ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
}

function logit(probability) {
  const p = clampProbability(probability);
  return Math.log(p / (1 - p));
}

function logistic(value) {
  return 1 / (1 + Math.exp(-clamp(value, -35, 35)));
}

function boundedRemember(set, value, limit = 5000) {
  set.add(value);
  if (set.size > limit) set.delete(set.values().next().value);
}

function boundedMap(map, key, value, limit = 5000) {
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value);
  return value;
}

function labels(ctx) {
  return {
    positive: String(ctx.market?.positive_label || 'UP').toUpperCase(),
    negative: String(ctx.market?.negative_label || 'DOWN').toUpperCase(),
  };
}

function touch(book) {
  const bid = finite(book?.bids?.[0]?.[0]);
  const bidSize = finite(book?.bids?.[0]?.[1]);
  const ask = finite(book?.asks?.[0]?.[0]);
  const askSize = finite(book?.asks?.[0]?.[1]);
  if (!(bid > 0 && ask > bid && bidSize > 0 && askSize > 0)) return null;
  return {
    bid,
    bidSize,
    ask,
    askSize,
    mid: (bid + ask) / 2,
    imbalance: (bidSize - askSize) / (bidSize + askSize),
  };
}

function feePerShare(price, multiplier = COST_MULTIPLIER) {
  const p = finite(price);
  return p == null ? Infinity : multiplier * CRYPTO_TAKER_RATE * p * (1 - p);
}

function directionalQuote(ctx, sign, envelope) {
  if (!envelope) return null;
  const positive = sign > 0;
  const view = touch(positive ? ctx.upBook : ctx.downBook);
  if (!view) return null;
  const names = labels(ctx);
  return {
    ...view,
    token: positive ? names.positive : names.negative,
    probabilityLower: positive ? envelope.lower : 1 - envelope.upper,
    probabilityUpper: positive ? envelope.upper : 1 - envelope.lower,
  };
}

function takerAction(ctx, engine, strategy, sign, envelope, note, features = {}) {
  const quote = directionalQuote(ctx, sign, envelope);
  if (!quote || !inBand(quote.ask, 0.08, 0.94)) return null;
  const edge2x = quote.probabilityLower - quote.ask - feePerShare(quote.ask);
  if (edge2x < EDGE_BUFFER) return null;
  const shares = Math.min(MAX_STAKE_USD / quote.ask,
    quote.askSize * DEPTH_PARTICIPATION);
  if (!(shares > 0) || shares * quote.ask < 1) return null;
  return {
    action: 'place',
    side: 'BUY',
    token: quote.token,
    price: quote.ask,
    size: shares,
    kind: 'taker',
    coid: engine._coid(strategy),
    queueAhead: quote.askSize,
    executionModel: String(ctx.triggerEvent?.source || '').length
      ? 'event_order_250ms' : 'latency_1s',
    thesisVersion: STRATEGY_VERSION,
    features: {
      mechanism_family: features.mechanism_family || 'research_v8',
      fair_lower_selected: quote.probabilityLower,
      fair_upper_selected: quote.probabilityUpper,
      edge_2x_per_share: edge2x,
      fee_multiplier: COST_MULTIPLIER,
      edge_buffer: EDGE_BUFFER,
      displayed_touch_shares: quote.askSize,
      displayed_capacity_usd: quote.ask * quote.askSize,
      depth_participation: DEPTH_PARTICIPATION,
      simulated_notional_usd: quote.ask * shares,
      provisional: true,
      paper_only: true,
      ...features,
    },
    note: `${note} lower=${quote.probabilityLower.toFixed(4)} ` +
      `ask=${quote.ask.toFixed(4)} edge2x=${edge2x.toFixed(4)}`,
  };
}

function bestBoundedAction(ctx, engine, strategy, envelope, note, features = {}) {
  if (!envelope) return null;
  const candidates = [1, -1].map((sign) => {
    const quote = directionalQuote(ctx, sign, envelope);
    return quote ? {
      sign,
      edge: quote.probabilityLower - quote.ask - feePerShare(quote.ask),
    } : null;
  }).filter(Boolean).sort((left, right) => right.edge - left.edge);
  if (!candidates.length || candidates[0].edge < EDGE_BUFFER) return null;
  return takerAction(ctx, engine, strategy, candidates[0].sign,
    envelope, note, features);
}

function sourceRows(ctx) {
  const rows = [{ source: 'binance_direct', price: finite(ctx.btc) }];
  if (inBand(finite(ctx.rtdsChainlinkAgeMs), 0, 3000)) {
    rows.push({ source: 'chainlink_rtds', price: finite(ctx.rtdsChainlink) });
  }
  if (ctx.venueStale === false) {
    rows.push({ source: 'coinbase', price: finite(ctx.venuePrice) });
  }
  if (ctx.hyperStale === false) {
    rows.push({ source: 'hyperliquid', price: finite(ctx.hyperPrice) });
  }
  return rows.filter((row) => row.price > 0);
}

function sourcePrices(ctx) {
  return sourceRows(ctx).map((row) => row.price);
}

function marketEndMs(market) {
  const value = market?.window_end;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolutionFamily(market) {
  const source = String(market?.resolution_source || '').toLowerCase();
  if (source.includes('chainlink')
      || (market?.market_type === 'direction_5m'
        && source === 'polymarket_crypto_5m')) return 'chainlink';
  if (source.includes('binance')) return 'binance';
  if (source.includes('coinbase')) return 'coinbase';
  if (source.includes('pyth')) return 'pyth';
  return source || null;
}

function exactNumber(left, right) {
  const a = finite(left);
  const b = finite(right);
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= Math.max(1e-9, 1e-9 * Math.max(Math.abs(a), Math.abs(b)));
}

function structuralBundleActions(engine, strategy, legs, guaranteedPayout,
  residual2x, note, features = {}) {
  if (legs.length < 2 || residual2x < EDGE_BUFFER) return [];
  const combinedAsk = legs.reduce((sum, leg) => sum + leg.ask, 0);
  const shares = Math.min(
    MAX_STAKE_USD / combinedAsk,
    ...legs.map((leg) => leg.askSize * DEPTH_PARTICIPATION),
  );
  if (!(shares > 0) || shares * combinedAsk < 1) return [];
  const groupId = engine._coid(`${strategy}-group`);
  return legs.map((leg, index) => ({
    action: 'place',
    side: 'BUY',
    token: leg.token,
    price: leg.ask,
    size: shares,
    kind: 'taker',
    coid: engine._coid(strategy),
    queueAhead: leg.askSize,
    executionModel: 'latency_1s',
    thesisVersion: STRATEGY_VERSION,
    groupId,
    marketId: leg.marketId,
    tteSec: leg.tteSec,
    features: {
      mechanism_family: features.mechanism_family || 'certified_payoff_identity',
      structural_group: true,
      group_leg_index: index,
      group_leg_count: legs.length,
      group_cost_per_share: combinedAsk,
      group_guaranteed_payout: guaranteedPayout,
      group_edge_2x_per_share: residual2x,
      group_execution: 'non_atomic_equal_share',
      max_total_stake_usd: MAX_STAKE_USD,
      depth_participation: DEPTH_PARTICIPATION,
      provisional: true,
      paper_only: true,
      non_atomic_leg_risk: true,
      ...features,
    },
    note: `${note} group=${groupId} leg=${index + 1}/${legs.length} ` +
      `cost=${combinedAsk.toFixed(4)} guaranteed=${guaranteedPayout.toFixed(2)} ` +
      `edge2x=${residual2x.toFixed(4)} non_atomic_leg_risk=true`,
  }));
}

/** H64 — Page-CUSUM on a robust cross-venue efficient-price proxy. */
class MultiVenueCusumBreak {
  constructor() {
    this.name = STRATEGY_NAMES[0];
    this.marketTypes = ['direction_5m', 'direction_15m'];
    this.cadence = 'sampled';
    this._states = new Map();
    this._fired = new Set();
    this._gates = new GateDiagnostics(this.name);
  }

  onHalt() { return []; }

  diagnostics() {
    return { gateDiagnostics: this._gates.snapshot() };
  }

  _observe(ctx) {
    const asset = ctx.market?.asset;
    const second = Math.floor(ctx.now / 1000);
    const consensus = median(sourcePrices(ctx));
    if (!DIRECTION_ASSETS.has(asset) || !(consensus > 0)) return null;
    let state = this._states.get(asset);
    if (!state) {
      state = {
        lastSecond: second,
        lastConsensus: consensus,
        mean: 0,
        variance: (0.5 / 10000) ** 2,
        observations: 0,
        positive: 0,
        negative: 0,
        signal: null,
      };
      boundedMap(this._states, asset, state, 20);
      return null;
    }
    if (state.lastSecond === second) return state.signal;
    const logReturn = Math.log(consensus / state.lastConsensus);
    const previousMean = state.mean;
    const previousSd = Math.sqrt(Math.max(state.variance, (0.05 / 10000) ** 2));
    const z = (logReturn - previousMean) / previousSd;
    state.signal = null;
    if (state.observations >= 30 && Number.isFinite(z)) {
      // k=0.5 and h=5 are a conventional one-sigma-shift Page-CUSUM design,
      // not thresholds selected from strategy PnL.
      state.positive = Math.max(0, state.positive + z - 0.5);
      state.negative = Math.max(0, state.negative - z - 0.5);
      if (Math.max(state.positive, state.negative) >= 5) {
        const sign = state.positive >= state.negative ? 1 : -1;
        state.signal = {
          at: ctx.now,
          sign,
          z,
          cusum: Math.max(state.positive, state.negative),
          consensus,
          sourceCount: sourceRows(ctx).length,
        };
        state.positive = 0;
        state.negative = 0;
      }
    }
    const lambda = 0.97;
    const error = logReturn - previousMean;
    state.mean = lambda * previousMean + (1 - lambda) * logReturn;
    state.variance = lambda * state.variance + (1 - lambda) * error * error;
    state.observations += 1;
    state.lastSecond = second;
    state.lastConsensus = consensus;
    return state.signal;
  }

  evaluate(ctx, engine) {
    this._gates.begin();
    const signal = this._observe(ctx);
    const marketId = ctx.market?.id;
    if (!signal) return this._gates.reject('no_page_cusum_alarm', ctx.now);
    if (marketId == null) return this._gates.reject('missing_market_id', ctx.now);
    if (this._fired.has(marketId)) return this._gates.reject('already_fired_market', ctx.now);
    if (ctx.now - signal.at > 1200) return this._gates.reject('cusum_alarm_expired', ctx.now);
    if (!inBand(ctx.tteSec, 20, 240)) return this._gates.reject('outside_tte_window', ctx.now);
    if (signal.sourceCount < 2) return this._gates.reject('insufficient_fresh_venues', ctx.now);
    const action = takerAction(ctx, engine, this.name, signal.sign,
      fairEnvelope(ctx),
      `page_cusum=${signal.cusum.toFixed(2)} z=${signal.z.toFixed(2)} ` +
      `sources=${signal.sourceCount}`, {
        mechanism_family: 'multivenue_page_cusum',
        cusum_reference_shift_sigma: 1,
        cusum_allowance_k: 0.5,
        cusum_alarm_h: 5,
        standardized_innovation: signal.z,
        source_count: signal.sourceCount,
        consensus_spot: signal.consensus,
      });
    if (!action) return this._gates.reject('executable_edge_or_capacity_failed', ctx.now);
    boundedRemember(this._fired, marketId);
    return this._gates.accept([action], ctx.now);
  }
}

/** H65 — adaptive scalar Kalman fusion of four independently timestamped feeds. */
class KalmanLatentConsensus {
  constructor() {
    this.name = STRATEGY_NAMES[1];
    this.marketTypes = ['direction_5m', 'direction_15m'];
    this.cadence = 'sampled';
    this._states = new Map();
    this._fired = new Set();
  }

  onHalt() { return []; }

  _observe(ctx) {
    const asset = ctx.market?.asset;
    const rows = sourceRows(ctx);
    const second = Math.floor(ctx.now / 1000);
    if (!DIRECTION_ASSETS.has(asset) || rows.length < 2) return null;
    let state = this._states.get(asset);
    if (!state) {
      const initial = Math.log(median(rows.map((row) => row.price)));
      state = {
        x: initial,
        covariance: (2 / 10000) ** 2,
        processVariance: (0.5 / 10000) ** 2,
        measurementVariance: new Map(),
        lastPrice: new Map(),
        lastSecond: null,
        startedAt: ctx.now,
        samples: 0,
        result: null,
      };
      boundedMap(this._states, asset, state, 20);
    }
    if (state.lastSecond === second) return state.result;
    state.covariance += state.processVariance;
    let maximumInnovationZ = 0;
    let updates = 0;
    const before = state.x;
    for (const row of rows) {
      if (state.lastPrice.get(row.source) === row.price) continue;
      const observation = Math.log(row.price);
      const variance = state.measurementVariance.get(row.source)
        || (1.5 / 10000) ** 2;
      const innovation = observation - state.x;
      const innovationVariance = state.covariance + variance;
      const gain = state.covariance / innovationVariance;
      state.x += gain * innovation;
      state.covariance = Math.max((1 - gain) * state.covariance, 1e-16);
      maximumInnovationZ = Math.max(maximumInnovationZ,
        Math.abs(innovation) / Math.sqrt(innovationVariance));
      state.measurementVariance.set(row.source, clamp(
        0.98 * variance + 0.02 * innovation * innovation,
        (0.05 / 10000) ** 2,
        (10 / 10000) ** 2,
      ));
      state.lastPrice.set(row.source, row.price);
      updates += 1;
    }
    const latentMove = state.x - before;
    state.processVariance = clamp(
      0.98 * state.processVariance + 0.02 * latentMove * latentMove,
      (0.05 / 10000) ** 2,
      (5 / 10000) ** 2,
    );
    // The feeds are economically correlated, so repeated venue observations
    // are not allowed to collapse uncertainty as if they were independent
    // sensors. Cross-source dispersion and a 0.25 bp floor both survive the
    // sequential Kalman updates.
    const logPrices = rows.map((row) => Math.log(row.price));
    const logMedian = median(logPrices);
    const crossSourceMad = median(logPrices.map((value) =>
      Math.abs(value - logMedian))) || 0;
    state.covariance = Math.max(
      state.covariance,
      crossSourceMad * crossSourceMad,
      (0.25 / 10000) ** 2,
    );
    state.samples += updates;
    state.lastSecond = second;
    const standardError = Math.sqrt(state.covariance);
    state.result = {
      at: ctx.now,
      spot: Math.exp(state.x),
      lowSpot: Math.exp(state.x - 2.576 * standardError),
      highSpot: Math.exp(state.x + 2.576 * standardError),
      standardErrorBps: standardError * 10000,
      maximumInnovationZ,
      crossSourceMadBps: crossSourceMad * 10000,
      updates: state.samples,
      ageSec: (ctx.now - state.startedAt) / 1000,
      sourceCount: rows.length,
    };
    return state.result;
  }

  evaluate(ctx, engine) {
    const filtered = this._observe(ctx);
    const marketId = ctx.market?.id;
    if (!filtered || marketId == null || this._fired.has(marketId)
        || filtered.updates < 120 || filtered.ageSec < 30
        || filtered.sourceCount < 2 || !inBand(ctx.tteSec, 20, 240)) return [];
    const envelope = fairEnvelope(ctx, {
      spots: [filtered.lowSpot, filtered.highSpot],
    });
    const action = bestBoundedAction(ctx, engine, this.name, envelope,
      `kalman_spot=${filtered.spot.toFixed(6)} se=${filtered.standardErrorBps.toFixed(3)}bp ` +
      `max_innovation_z=${filtered.maximumInnovationZ.toFixed(2)}`, {
        mechanism_family: 'adaptive_kalman_latent_price',
        latent_spot: filtered.spot,
        latent_spot_lower_99: filtered.lowSpot,
        latent_spot_upper_99: filtered.highSpot,
        latent_standard_error_bps: filtered.standardErrorBps,
        maximum_measurement_innovation_z: filtered.maximumInnovationZ,
        cross_source_mad_bps: filtered.crossSourceMadBps,
        filter_measurement_updates: filtered.updates,
        source_count: filtered.sourceCount,
      });
    if (!action) return [];
    boundedRemember(this._fired, marketId);
    return [action];
  }
}

function marketSnapshot(ctx) {
  const names = labels(ctx);
  const positive = touch(ctx.upBook);
  const negative = touch(ctx.downBook);
  if (!positive || !negative) return null;
  return {
    at: ctx.now,
    marketId: ctx.market?.id,
    marketType: ctx.market?.market_type,
    asset: ctx.market?.asset,
    endMs: marketEndMs(ctx.market),
    eventId: ctx.market?.event_id || null,
    resolutionSource: String(ctx.market?.resolution_source || ''),
    resolutionFamily: resolutionFamily(ctx.market),
    tteSec: finite(ctx.tteSec),
    strike: finite(ctx.strike ?? ctx.market?.strike),
    lower: finite(ctx.lowerBound ?? ctx.market?.lower_bound),
    upper: finite(ctx.upperBound ?? ctx.market?.upper_bound),
    boundary: finite(ctx.resolverRef),
    boundarySource: ctx.resolverRefSource || null,
    positiveLabel: names.positive,
    negativeLabel: names.negative,
    positiveAsk: positive.ask,
    positiveAskSize: positive.askSize,
    negativeAsk: negative.ask,
    negativeAskSize: negative.askSize,
  };
}

/** H66 — exact range/threshold partition identities under one resolver/end. */
class RangeThresholdPartitionLock {
  constructor() {
    this.name = STRATEGY_NAMES[2];
    this.marketTypes = ['threshold_daily', 'range_daily'];
    this.cadence = 'sampled';
    this._groups = new Map();
    this._fired = new Set();
    this._gates = new GateDiagnostics(this.name);
  }

  onHalt() { return []; }

  diagnostics() {
    return { gateDiagnostics: this._gates.snapshot() };
  }

  _remember(ctx) {
    const row = marketSnapshot(ctx);
    if (!row || !row.asset || !row.endMs || !row.resolutionSource) return [];
    const key = `${row.asset}:${row.endMs}:${row.resolutionSource}`;
    const group = this._groups.get(key) || new Map();
    group.set(row.marketId, row);
    for (const [marketId, value] of group) {
      if (ctx.now - value.at > 3000) group.delete(marketId);
    }
    boundedMap(this._groups, key, group, 200);
    return [...group.values()].filter((value) => ctx.now - value.at <= 2500);
  }

  evaluate(ctx, engine) {
    this._gates.begin();
    const rows = this._remember(ctx);
    if (rows.length < 3) return this._gates.reject('fewer_than_three_synchronized_contracts', ctx.now);
    const ranges = rows.filter((row) => row.marketType === 'range_daily'
      && row.lower != null && row.upper != null && row.lower < row.upper);
    const thresholds = rows.filter((row) => row.marketType === 'threshold_daily'
      && row.strike != null);
    let best = null;
    for (const range of ranges) {
      const low = thresholds.find((row) => exactNumber(row.strike, range.lower));
      const high = thresholds.find((row) => exactNumber(row.strike, range.upper));
      if (!low || !high) continue;
      const candidates = [
        {
          identity: 'RANGE_YES+LOW_NO+HIGH_YES',
          payout: 1,
          legs: [
            { marketId: range.marketId, tteSec: range.tteSec,
              token: range.positiveLabel, ask: range.positiveAsk, askSize: range.positiveAskSize },
            { marketId: low.marketId, tteSec: low.tteSec,
              token: low.negativeLabel, ask: low.negativeAsk, askSize: low.negativeAskSize },
            { marketId: high.marketId, tteSec: high.tteSec,
              token: high.positiveLabel, ask: high.positiveAsk, askSize: high.positiveAskSize },
          ],
        },
        {
          identity: 'RANGE_NO+LOW_YES+HIGH_NO',
          payout: 2,
          legs: [
            { marketId: range.marketId, tteSec: range.tteSec,
              token: range.negativeLabel, ask: range.negativeAsk, askSize: range.negativeAskSize },
            { marketId: low.marketId, tteSec: low.tteSec,
              token: low.positiveLabel, ask: low.positiveAsk, askSize: low.positiveAskSize },
            { marketId: high.marketId, tteSec: high.tteSec,
              token: high.negativeLabel, ask: high.negativeAsk, askSize: high.negativeAskSize },
          ],
        },
      ];
      for (const candidate of candidates) {
        const allQuoted = candidate.legs.every((leg) =>
          inBand(leg.ask, 0.01, 0.99) && leg.askSize > 0);
        if (!allQuoted) continue;
        const cost2x = candidate.legs.reduce((sum, leg) =>
          sum + leg.ask + feePerShare(leg.ask), 0);
        const residual = candidate.payout - cost2x;
        if (!best || residual > best.residual) {
          best = { ...candidate, residual, range, low, high };
        }
      }
    }
    if (!best) return this._gates.reject('no_exact_range_threshold_partition', ctx.now);
    if (best.residual < EDGE_BUFFER) {
      return this._gates.reject('partition_does_not_clear_2x_costs', ctx.now);
    }
    const key = `${best.identity}:${best.range.marketId}:${best.low.marketId}:${best.high.marketId}`;
    if (this._fired.has(key)) return this._gates.reject('already_fired_partition', ctx.now);
    const actions = structuralBundleActions(engine, this.name, best.legs,
      best.payout, best.residual,
      `partition=${best.identity} lower=${best.range.lower} upper=${best.range.upper}`, {
        mechanism_family: 'range_threshold_exact_partition',
        payoff_identity: best.identity,
        range_lower: best.range.lower,
        range_upper: best.range.upper,
        metadata_rule_certification: 'same_asset_end_resolver_and_exact_numeric_boundaries',
        human_rule_text_review_required: true,
        true_arbitrage_claim: false,
      });
    if (!actions.length) return this._gates.reject('insufficient_bundle_capacity', ctx.now);
    boundedRemember(this._fired, key);
    return this._gates.accept(actions, ctx.now);
  }
}

function queueFlow(previous, current) {
  if (!previous || !current) return null;
  const epsilon = 1e-9;
  let askDepletion = 0;
  let askRefill = 0;
  let bidAddition = 0;
  let bidRemoval = 0;
  if (current.ask > previous.ask + epsilon) askDepletion += previous.askSize;
  else if (Math.abs(current.ask - previous.ask) <= epsilon) {
    askDepletion += Math.max(0, previous.askSize - current.askSize);
    askRefill += Math.max(0, current.askSize - previous.askSize);
  } else askRefill += current.askSize;
  if (current.bid > previous.bid + epsilon) bidAddition += current.bidSize;
  else if (Math.abs(current.bid - previous.bid) <= epsilon) {
    bidAddition += Math.max(0, current.bidSize - previous.bidSize);
    bidRemoval += Math.max(0, previous.bidSize - current.bidSize);
  } else bidRemoval += previous.bidSize;
  const depth = Math.max(1, (previous.askSize + previous.bidSize
    + current.askSize + current.bidSize) / 2);
  return {
    pressure: (askDepletion + bidAddition) / depth,
    adverse: (askRefill + bidRemoval) / depth,
  };
}

/** H67 — queue-reactive depletion-before-refill hazard, not static imbalance. */
class QueueDepletionHazard {
  constructor() {
    this.name = STRATEGY_NAMES[3];
    this.marketTypes = ['direction_5m', 'direction_15m'];
    this.cadence = 'event';
    this._states = new Map();
    this._fired = new Set();
    this._gates = new GateDiagnostics(this.name);
  }

  onHalt() { return []; }

  diagnostics() {
    return { gateDiagnostics: this._gates.snapshot() };
  }

  _observe(ctx) {
    if (String(ctx.triggerEvent?.source || '') !== 'clob') return null;
    const marketId = ctx.market?.id;
    const up = touch(ctx.upBook);
    const down = touch(ctx.downBook);
    if (marketId == null || !up || !down) return null;
    const state = this._states.get(marketId) || { previous: null, rows: [] };
    if (state.previous) {
      const upFlow = queueFlow(state.previous.up, up);
      const downFlow = queueFlow(state.previous.down, down);
      if (upFlow && downFlow) state.rows.push({
        at: ctx.now,
        upPressure: upFlow.pressure,
        upAdverse: upFlow.adverse,
        downPressure: downFlow.pressure,
        downAdverse: downFlow.adverse,
      });
    }
    state.previous = { up, down };
    while (state.rows.length && state.rows[0].at < ctx.now - 3000) state.rows.shift();
    boundedMap(this._states, marketId, state);
    if (state.rows.length < 8) return null;
    const spanSec = (state.rows.at(-1).at - state.rows[0].at) / 1000;
    if (spanSec < 0.75) return null;
    const hazard = (prefix) => {
      const pressure = state.rows.reduce((sum, row) => sum + row[`${prefix}Pressure`], 0);
      const adverse = state.rows.reduce((sum, row) => sum + row[`${prefix}Adverse`], 0);
      return {
        pressure,
        adverse,
        conditional: pressure / Math.max(1e-9, pressure + adverse),
        intensity: pressure / spanSec,
      };
    };
    return { up: hazard('up'), down: hazard('down'), spanSec, events: state.rows.length };
  }

  evaluate(ctx, engine) {
    this._gates.begin();
    const state = this._observe(ctx);
    const marketId = ctx.market?.id;
    if (!state) return this._gates.reject('queue_hazard_warmup_or_non_clob_event', ctx.now);
    if (marketId == null) return this._gates.reject('missing_market_id', ctx.now);
    if (this._fired.has(marketId)) return this._gates.reject('already_fired_market', ctx.now);
    if (!inBand(ctx.tteSec, 20, 240)) {
      return this._gates.reject('outside_tte_window', ctx.now);
    }
    const sign = state.up.conditional >= state.down.conditional ? 1 : -1;
    const selected = sign > 0 ? state.up : state.down;
    const opposite = sign > 0 ? state.down : state.up;
    if (selected.conditional < 0.75) {
      return this._gates.reject('depletion_probability_below_threshold', ctx.now);
    }
    if (selected.conditional - opposite.conditional < 0.25) {
      return this._gates.reject('depletion_probability_separation_below_threshold', ctx.now);
    }
    if (selected.intensity < 0.5) {
      return this._gates.reject('queue_pressure_intensity_below_threshold', ctx.now);
    }
    const action = takerAction(ctx, engine, this.name, sign, fairEnvelope(ctx),
      `queue_hazard=${selected.conditional.toFixed(3)} opposite=${opposite.conditional.toFixed(3)} ` +
      `intensity=${selected.intensity.toFixed(2)}/s events=${state.events}`, {
        mechanism_family: 'queue_depletion_before_refill_hazard',
        selected_depletion_probability: selected.conditional,
        opposite_depletion_probability: opposite.conditional,
        selected_normalized_pressure_intensity: selected.intensity,
        observation_span_ms: state.spanSec * 1000,
        queue_events: state.events,
        cancellation_trade_ambiguity: true,
      });
    if (!action) return this._gates.reject('executable_edge_or_capacity_failed', ctx.now);
    boundedRemember(this._fired, marketId);
    return this._gates.accept([action], ctx.now);
  }
}

function levelView(book, index) {
  const bid = finite(book?.bids?.[index]?.[0]);
  const bidSize = finite(book?.bids?.[index]?.[1]);
  const ask = finite(book?.asks?.[index]?.[0]);
  const askSize = finite(book?.asks?.[index]?.[1]);
  return bid > 0 && ask > bid && bidSize > 0 && askSize > 0
    ? { bid, bidSize, ask, askSize } : null;
}

function levelOfi(previous, current) {
  if (!previous || !current) return 0;
  let value = 0;
  if (current.bid >= previous.bid) value += current.bidSize;
  if (current.bid <= previous.bid) value -= previous.bidSize;
  if (current.ask <= previous.ask) value -= current.askSize;
  if (current.ask >= previous.ask) value += previous.askSize;
  return value;
}

function multiLevelOfi(previousBook, currentBook, levels = 5) {
  let value = 0;
  let depth = 0;
  let used = 0;
  for (let index = 0; index < levels; index += 1) {
    const previous = levelView(previousBook, index);
    const current = levelView(currentBook, index);
    if (!previous || !current) continue;
    const weight = 1 / Math.sqrt(index + 1);
    value += weight * levelOfi(previous, current);
    depth += weight * (previous.bidSize + previous.askSize
      + current.bidSize + current.askSize) / 2;
    used += 1;
  }
  return used ? { value, depth, levels: used } : null;
}

function snapshotBook(book, levels = 5) {
  return {
    bids: (book?.bids || []).slice(0, levels).map((level) => [
      finite(level?.[0]), finite(level?.[1]),
    ]),
    asks: (book?.asks || []).slice(0, levels).map((level) => [
      finite(level?.[0]), finite(level?.[1]),
    ]),
  };
}

function updateRegression(stats, x, y) {
  stats.n += 1;
  stats.sx += x;
  stats.sy += y;
  stats.sxx += x * x;
  stats.sxy += x * y;
  stats.syy += y * y;
}

function regressionProfile(stats) {
  if (!stats || stats.n < 3) return null;
  const sxx = stats.sxx - stats.sx * stats.sx / stats.n;
  const sxy = stats.sxy - stats.sx * stats.sy / stats.n;
  const syy = stats.syy - stats.sy * stats.sy / stats.n;
  if (!(sxx > 1e-12) || !(syy > 1e-12)) return null;
  const beta = sxy / sxx;
  const alpha = stats.sy / stats.n - beta * stats.sx / stats.n;
  const sse = Math.max(0, syy - beta * sxy);
  const sigma2 = stats.n > 2 ? sse / (stats.n - 2) : Infinity;
  const betaSe = Math.sqrt(sigma2 / sxx);
  return {
    alpha,
    beta,
    betaSe,
    betaT: betaSe > 0 ? beta / betaSe : null,
    r2: clamp(sxy * sxy / (sxx * syy), 0, 1),
    sigma2,
    sxx,
    meanX: stats.sx / stats.n,
    n: stats.n,
  };
}

/** H68 — five-level OFI with a causal, learned next-event impact coefficient. */
class MultiLevelOfiImpact {
  constructor() {
    this.name = STRATEGY_NAMES[4];
    this.marketTypes = ['direction_5m', 'direction_15m'];
    this.cadence = 'event';
    this._states = new Map();
    this._fired = new Set();
    this._gates = new GateDiagnostics(this.name);
  }

  onHalt() { return []; }

  diagnostics() {
    return { gateDiagnostics: this._gates.snapshot() };
  }

  _observe(ctx) {
    if (String(ctx.triggerEvent?.source || '') !== 'clob') return null;
    const marketId = ctx.market?.id;
    const probability = positiveProbability(ctx);
    if (marketId == null || !inBand(probability, 0.03, 0.97)) return null;
    const state = this._states.get(marketId) || {
      previousUp: null,
      previousDown: null,
      previousProbability: null,
      pendingX: null,
      stats: { n: 0, sx: 0, sy: 0, sxx: 0, sxy: 0, syy: 0 },
    };
    if (!state.previousUp || !state.previousDown) {
      state.previousUp = snapshotBook(ctx.upBook);
      state.previousDown = snapshotBook(ctx.downBook);
      state.previousProbability = probability;
      boundedMap(this._states, marketId, state);
      return null;
    }
    const up = multiLevelOfi(state.previousUp, ctx.upBook);
    const down = multiLevelOfi(state.previousDown, ctx.downBook);
    if (!up || !down) return null;
    const normalization = Math.max(1, (up.depth + down.depth) / 2);
    const x = (up.value - down.value) / normalization;
    const y = logit(probability) - logit(state.previousProbability);
    if (Number.isFinite(state.pendingX) && Number.isFinite(y)) {
      updateRegression(state.stats, state.pendingX, y);
    }
    const profile = regressionProfile(state.stats);
    const forecastLogit = profile ? profile.beta * x : null;
    const forecastProbability = Number.isFinite(forecastLogit)
      ? logistic(logit(probability) + forecastLogit) : null;
    state.pendingX = x;
    state.previousUp = snapshotBook(ctx.upBook);
    state.previousDown = snapshotBook(ctx.downBook);
    state.previousProbability = probability;
    boundedMap(this._states, marketId, state);
    return {
      x,
      probability,
      forecastLogit,
      forecastProbability,
      levels: Math.min(up.levels, down.levels),
      profile,
    };
  }

  evaluate(ctx, engine) {
    this._gates.begin();
    const state = this._observe(ctx);
    const marketId = ctx.market?.id;
    const profile = state?.profile;
    if (!state) return this._gates.reject('no_causal_clob_ofi_observation', ctx.now);
    if (!profile) return this._gates.reject('impact_regression_warmup', ctx.now);
    if (marketId == null) return this._gates.reject('missing_market_id', ctx.now);
    if (this._fired.has(marketId)) return this._gates.reject('already_fired_market', ctx.now);
    if (profile.n < 50) return this._gates.reject('impact_sample_below_50', ctx.now);
    if (!(profile.beta > 0)) return this._gates.reject('impact_beta_not_positive', ctx.now);
    if (!(profile.betaT >= 2.576)) return this._gates.reject('impact_beta_not_99pct_significant', ctx.now);
    if (Math.abs(state.forecastProbability - state.probability) < 0.01) {
      return this._gates.reject('forecast_token_move_below_one_tick', ctx.now);
    }
    if (!inBand(ctx.tteSec, 20, 240)) return this._gates.reject('outside_tte_window', ctx.now);
    const sign = Math.sign(state.forecastLogit);
    const action = takerAction(ctx, engine, this.name, sign, fairEnvelope(ctx),
      `mlofi=${state.x.toFixed(4)} beta=${profile.beta.toFixed(4)} ` +
      `t=${profile.betaT.toFixed(2)} forecast_move=${(state.forecastProbability - state.probability).toFixed(4)}`, {
        mechanism_family: 'causal_multilevel_ofi_impact',
        mlofi_normalized: state.x,
        book_levels: state.levels,
        online_impact_beta: profile.beta,
        online_impact_beta_t: profile.betaT,
        online_impact_r2: profile.r2,
        regression_observations: profile.n,
        next_event_probability_forecast: state.forecastProbability,
      });
    if (!action) return this._gates.reject('executable_edge_or_capacity_failed', ctx.now);
    boundedRemember(this._fired, marketId);
    return this._gates.accept([action], ctx.now);
  }
}

function rememberSecond(store, key, now, price, horizonMs = 660000) {
  if (!(price > 0)) return [];
  const second = Math.floor(now / 1000);
  const rows = store.get(key) || [];
  if (rows.at(-1)?.second === second) rows.at(-1).price = price;
  else rows.push({ second, at: now, price });
  while (rows.length && rows[0].at < now - horizonMs) rows.shift();
  boundedMap(store, key, rows, 20);
  return rows;
}

function logReturns(rows) {
  const returns = [];
  for (let index = 1; index < rows.length; index += 1) {
    const left = rows[index - 1];
    const right = rows[index];
    if (right.second - left.second <= 2 && left.price > 0 && right.price > 0) {
      returns.push(Math.log(right.price / left.price));
    }
  }
  return returns;
}

function quarticityProfile(rows) {
  const returns = logReturns(rows);
  if (returns.length < 60) return null;
  const spanSec = Math.max(1, rows.at(-1).at - rows[0].at) / 1000;
  const rv = returns.reduce((sum, value) => sum + value * value, 0);
  const realizedQuarticity = returns.length / 3
    * returns.reduce((sum, value) => sum + value ** 4, 0);
  const standardErrorRv = Math.sqrt(2 * realizedQuarticity / returns.length);
  const varianceLower = Math.max(1e-12, rv - 2.576 * standardErrorRv);
  const varianceUpper = Math.max(varianceLower, rv + 2.576 * standardErrorRv);
  return {
    observations: returns.length,
    spanSec,
    realizedVariance: rv,
    realizedQuarticity,
    standardErrorRv,
    sigmaLower5m: Math.sqrt(varianceLower * 300 / spanSec),
    sigmaUpper5m: Math.sqrt(varianceUpper * 300 / spanSec),
  };
}

/** H69 — confidence bounds for sigma derived from realized quarticity. */
class QuarticityConfidenceEnvelope {
  constructor() {
    this.name = STRATEGY_NAMES[5];
    this.marketTypes = ['direction_5m', 'direction_15m'];
    this.cadence = 'sampled';
    this._prices = new Map();
    this._fired = new Set();
    this._gates = new GateDiagnostics(this.name);
  }

  onHalt() { return []; }

  diagnostics() {
    return { gateDiagnostics: this._gates.snapshot() };
  }

  evaluate(ctx, engine) {
    this._gates.begin();
    const asset = ctx.market?.asset;
    const marketId = ctx.market?.id;
    const spot = median(sourcePrices(ctx));
    const rows = rememberSecond(this._prices, asset, ctx.now, spot, 130000);
    const profile = quarticityProfile(rows);
    if (!DIRECTION_ASSETS.has(asset)) return this._gates.reject('unsupported_asset', ctx.now);
    if (marketId == null) return this._gates.reject('missing_market_id', ctx.now);
    if (this._fired.has(marketId)) return this._gates.reject('already_fired_market', ctx.now);
    if (!profile) return this._gates.reject('quarticity_history_warmup', ctx.now);
    if (!inBand(ctx.tteSec, 20, 180)) {
      return this._gates.reject('outside_tte_window', ctx.now);
    }
    const envelope = fairEnvelope(ctx, {
      spots: sourcePrices(ctx),
      sigmas: [profile.sigmaLower5m, profile.sigmaUpper5m],
    });
    const action = bestBoundedAction(ctx, engine, this.name, envelope,
      `rq=${profile.realizedQuarticity.toExponential(3)} ` +
      `sigma99=[${profile.sigmaLower5m.toFixed(6)},${profile.sigmaUpper5m.toFixed(6)}]`, {
        mechanism_family: 'realized_quarticity_sigma_confidence',
        return_observations: profile.observations,
        realized_variance: profile.realizedVariance,
        realized_quarticity: profile.realizedQuarticity,
        realized_variance_standard_error: profile.standardErrorRv,
        sigma_lower_99_5m: profile.sigmaLower5m,
        sigma_upper_99_5m: profile.sigmaUpper5m,
      });
    if (!action) return this._gates.reject('executable_edge_or_capacity_failed', ctx.now);
    boundedRemember(this._fired, marketId);
    return this._gates.accept([action], ctx.now);
  }
}

function wilsonInterval(successes, trials, z = 1.96) {
  if (!(trials > 0) || successes < 0 || successes > trials) return null;
  const probability = successes / trials;
  const denominator = 1 + z * z / trials;
  const center = probability + z * z / (2 * trials);
  const radius = z * Math.sqrt(probability * (1 - probability) / trials
    + z * z / (4 * trials * trials));
  return {
    probability,
    lower: (center - radius) / denominator,
    upper: (center + radius) / denominator,
  };
}

function seedFor(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function makeRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function bootstrapTerminalProbabilities(options) {
  const returns = options.returns.map(finite).filter(Number.isFinite);
  const spots = options.spots.map(finite).filter((value) => value > 0);
  const refs = options.refs.map(finite).filter((value) => value > 0);
  const horizon = Math.max(1, Math.round(options.horizonSec));
  const paths = Math.max(100, Math.round(options.paths || 512));
  if (returns.length < 100 || !spots.length || !refs.length) return null;
  const centeredMean = mean(returns);
  const centered = returns.map((value) => value - centeredMean);
  const base = Math.max(2, Math.round(Math.cbrt(centered.length)));
  const blockLengths = [...new Set([base, Math.min(centered.length, 2 * base)])];
  const probabilities = [];
  for (const blockLength of blockLengths) {
    const random = makeRandom(seedFor(`${options.seed}:${blockLength}`));
    const pathReturns = [];
    for (let path = 0; path < paths; path += 1) {
      let total = 0;
      let index = Math.floor(random() * centered.length);
      for (let consumed = 0; consumed < horizon; consumed += 1) {
        if (consumed === 0 || random() < 1 / blockLength) {
          index = Math.floor(random() * centered.length);
        } else {
          index = (index + 1) % centered.length;
        }
        total += centered[index];
      }
      pathReturns.push(total);
    }
    for (const spot of spots) {
      for (const ref of refs) {
        const successes = pathReturns.reduce((count, value) =>
          count + (spot * Math.exp(value) >= ref ? 1 : 0), 0);
        const interval = wilsonInterval(successes, paths);
        probabilities.push({
          ...interval,
          blockLength,
          spot,
          ref,
        });
      }
    }
  }
  return {
    lower: Math.min(...probabilities.map((row) => row.lower)),
    upper: Math.max(...probabilities.map((row) => row.upper)),
    probabilities,
    blockLengths,
    paths,
    observations: returns.length,
    centeredMean,
  };
}

/** H70 — non-Gaussian digital pricing from deterministic stationary blocks. */
class StationaryBlockBootstrapDigital {
  constructor() {
    this.name = STRATEGY_NAMES[6];
    this.marketTypes = ['direction_5m'];
    this.cadence = 'sampled';
    this._prices = new Map();
    this._fired = new Set();
    this._gates = new GateDiagnostics(this.name);
  }

  onHalt() { return []; }

  diagnostics() {
    return { gateDiagnostics: this._gates.snapshot() };
  }

  evaluate(ctx, engine) {
    this._gates.begin();
    const asset = ctx.market?.asset;
    const marketId = ctx.market?.id;
    const spot = median(sourcePrices(ctx));
    const rows = rememberSecond(this._prices, asset, ctx.now, spot);
    if (!DIRECTION_ASSETS.has(asset)) return this._gates.reject('unsupported_asset', ctx.now);
    if (marketId == null) return this._gates.reject('missing_market_id', ctx.now);
    if (this._fired.has(marketId)) return this._gates.reject('already_fired_market', ctx.now);
    if (!inBand(ctx.tteSec, 118, 122)) return this._gates.reject('outside_fixed_t120_window', ctx.now);
    const returns = logReturns(rows);
    if (returns.length < 300) return this._gates.reject('return_history_below_300', ctx.now);
    const refs = [finite(ctx.ref), finite(ctx.resolverRef)]
      .filter((value) => value > 0);
    const model = bootstrapTerminalProbabilities({
      returns,
      spots: sourcePrices(ctx),
      refs,
      horizonSec: ctx.tteSec,
      paths: 512,
      seed: `${asset}:${marketId}:T120`,
    });
    if (!model) return this._gates.reject('bootstrap_model_unavailable', ctx.now);
    const envelope = {
      lower: clampProbability(model.lower),
      upper: clampProbability(model.upper),
      midpoint: (model.lower + model.upper) / 2,
    };
    const action = bestBoundedAction(ctx, engine, this.name, envelope,
      `block_bootstrap n=${model.observations} blocks=${model.blockLengths.join('/')} ` +
      `paths=${model.paths} p99=[${model.lower.toFixed(4)},${model.upper.toFixed(4)}]`, {
        mechanism_family: 'centered_stationary_block_bootstrap_digital',
        return_observations: model.observations,
        bootstrap_paths: model.paths,
        block_lengths: model.blockLengths,
        bootstrap_probability_lower_95: model.lower,
        bootstrap_probability_upper_95: model.upper,
        empirical_drift_removed: true,
        fixed_decision_tte_sec: 120,
      });
    if (!action) return this._gates.reject('executable_edge_or_capacity_failed', ctx.now);
    boundedRemember(this._fired, marketId);
    return this._gates.accept([action], ctx.now);
  }
}

/** H71 — quote logit residual from its own causal resolver-distance elasticity. */
class TokenElasticityResidual {
  constructor() {
    this.name = STRATEGY_NAMES[7];
    this.marketTypes = ['direction_5m', 'direction_15m'];
    this.cadence = 'sampled';
    this._states = new Map();
    this._fired = new Set();
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
    const marketId = ctx.market?.id;
    const probability = positiveProbability(ctx);
    const spot = median(sourcePrices(ctx));
    const ref = finite(ctx.resolverRef) || finite(ctx.ref);
    const sigma = median([
      finite(ctx.volatility?.robustSigma5m),
      finite(ctx.volatility?.rmsSigma5m),
      finite(ctx.sigma),
    ].filter((value) => value > 0));
    if (marketId == null || !inBand(probability, 0.03, 0.97)
        || !(spot > 0 && ref > 0 && sigma > 0 && ctx.tteSec > 0)) return [];
    const remainingSigma = sigma * Math.sqrt(ctx.tteSec / 300);
    const x = Math.log(spot / ref) / Math.max(1e-9, remainingSigma);
    const y = logit(probability);
    const state = this._states.get(marketId)
      || { stats: { n: 0, sx: 0, sy: 0, sxx: 0, sxy: 0, syy: 0 } };
    const profile = regressionProfile(state.stats);
    let candidate = null;
    if (profile && profile.n >= 30 && profile.beta > 0
        && profile.betaT >= 2.576 && !this._fired.has(marketId)
        && inBand(ctx.tteSec, 20, 240)) {
      const prediction = profile.alpha + profile.beta * x;
      const residual = y - prediction;
      const leverage = 1 + 1 / profile.n
        + (x - profile.meanX) ** 2 / profile.sxx;
      const predictionSe = Math.sqrt(Math.max(1e-12, profile.sigma2 * leverage));
      const residualZ = residual / predictionSe;
      const predictedProbability = logistic(prediction);
      if (Math.abs(residualZ) >= 2.576
          && Math.abs(predictedProbability - probability) >= 0.01) {
        candidate = {
          sign: -Math.sign(residual),
          prediction,
          predictedProbability,
          residual,
          residualZ,
          profile,
        };
      }
    }
    updateRegression(state.stats, x, y);
    boundedMap(this._states, marketId, state);
    if (!candidate || !candidate.sign) return [];
    const action = takerAction(ctx, engine, this.name, candidate.sign,
      fairEnvelope(ctx),
      `elasticity_beta=${candidate.profile.beta.toFixed(3)} ` +
      `residual_z=${candidate.residualZ.toFixed(2)} predicted=${candidate.predictedProbability.toFixed(3)} ` +
      `market=${probability.toFixed(3)}`, {
        mechanism_family: 'online_token_logit_elasticity_residual',
        resolver_distance_z: x,
        elasticity_beta: candidate.profile.beta,
        elasticity_beta_t: candidate.profile.betaT,
        elasticity_r2: candidate.profile.r2,
        regression_observations: candidate.profile.n,
        predicted_market_probability: candidate.predictedProbability,
        market_probability: probability,
        standardized_quote_residual: candidate.residualZ,
      });
    if (!action) return [];
    boundedRemember(this._fired, marketId);
    return [action];
  }
}

/** H72 — same-expiry Chainlink windows imply a nested-threshold payoff lock. */
class CrossHorizonNestedLock {
  constructor() {
    this.name = STRATEGY_NAMES[8];
    this.marketTypes = ['direction_5m', 'direction_15m'];
    this.cadence = 'sampled';
    this._groups = new Map();
    this._fired = new Set();
  }

  onHalt() { return []; }

  _remember(ctx) {
    const row = marketSnapshot(ctx);
    if (!row || row.resolutionFamily !== 'chainlink'
        || row.boundarySource !== 'chainlink_rtds_nearest_3s'
        || !(row.boundary > 0) || !row.endMs || !row.asset) return [];
    const key = `${row.asset}:${row.endMs}:chainlink`;
    const group = this._groups.get(key) || new Map();
    group.set(row.marketId, row);
    for (const [marketId, value] of group) {
      if (ctx.now - value.at > 3000) group.delete(marketId);
    }
    boundedMap(this._groups, key, group, 500);
    return [...group.values()].filter((value) => ctx.now - value.at <= 2500);
  }

  evaluate(ctx, engine) {
    const rows = this._remember(ctx);
    if (rows.length < 2) return [];
    const five = rows.filter((row) => row.marketType === 'direction_5m');
    const fifteen = rows.filter((row) => row.marketType === 'direction_15m');
    let best = null;
    for (const left of five) {
      for (const right of fifteen) {
        if (exactNumber(left.boundary, right.boundary)) continue;
        const low = left.boundary < right.boundary ? left : right;
        const high = left.boundary < right.boundary ? right : left;
        const legs = [
          { marketId: low.marketId, tteSec: low.tteSec,
            token: low.positiveLabel, ask: low.positiveAsk, askSize: low.positiveAskSize },
          { marketId: high.marketId, tteSec: high.tteSec,
            token: high.negativeLabel, ask: high.negativeAsk, askSize: high.negativeAskSize },
        ];
        if (!legs.every((leg) => inBand(leg.ask, 0.01, 0.99) && leg.askSize > 0)) continue;
        const cost2x = legs.reduce((sum, leg) =>
          sum + leg.ask + feePerShare(leg.ask), 0);
        const residual = 1 - cost2x;
        if (!best || residual > best.residual) {
          best = { low, high, legs, residual };
        }
      }
    }
    if (!best || best.residual < EDGE_BUFFER) return [];
    const key = `${best.low.marketId}:${best.high.marketId}`;
    if (this._fired.has(key)) return [];
    const actions = structuralBundleActions(engine, this.name, best.legs,
      1, best.residual,
      `same_expiry_nested low=${best.low.boundary} high=${best.high.boundary}`, {
        mechanism_family: 'crosshorizon_same_expiry_nested_threshold',
        lower_boundary: best.low.boundary,
        upper_boundary: best.high.boundary,
        terminal_time_ms: best.low.endMs,
        resolver_family: 'chainlink',
        boundary_capture_source: 'chainlink_rtds_nearest_3s',
        metadata_rule_certification: 'same_asset_terminal_time_resolver_family',
        human_rule_text_review_required: true,
        true_arbitrage_claim: false,
      });
    if (actions.length) boundedRemember(this._fired, key);
    return actions;
  }
}

/** H73 — frozen empirical calibration interval; PnL was not a fit target. */
class MarketPriorCalibrationResidual {
  constructor() {
    this.name = STRATEGY_NAMES[9];
    this.marketTypes = ['direction_5m'];
    this.cadence = 'sampled';
    this._fired = new Set();
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
    const marketId = ctx.market?.id;
    const probability = positiveProbability(ctx);
    if (marketId == null || this._fired.has(marketId)
        || !DIRECTION_ASSETS.has(ctx.market?.asset)
        || !inBand(ctx.tteSec, 118, 122)
        || !inBand(probability, 0.01, 0.99)) return [];
    const bucketIndex = Math.min(9, Math.floor(probability * 10));
    const bucket = H73_CALIBRATION.buckets.find((row) => row.bucket === bucketIndex);
    if (!bucket || finite(bucket.n) < H73_CALIBRATION.estimator.minimum_cell_n) return [];
    const envelope = {
      lower: finite(bucket.wilson_lower),
      upper: finite(bucket.wilson_upper),
      midpoint: finite(bucket.realized_probability),
    };
    if (!(envelope.lower >= 0 && envelope.upper <= 1
        && envelope.lower <= envelope.upper)) return [];
    const action = bestBoundedAction(ctx, engine, this.name, envelope,
      `calibration_bucket=${bucketIndex} n=${bucket.n} ` +
      `market=${probability.toFixed(3)} realized=${envelope.midpoint.toFixed(3)}`, {
        mechanism_family: 'frozen_market_prior_calibration',
        calibration_bucket: bucketIndex,
        calibration_cell_n: bucket.n,
        calibration_market_probability_mean: bucket.mean_market_probability,
        calibration_realized_probability: bucket.realized_probability,
        calibration_wilson_lower_95: bucket.wilson_lower,
        calibration_wilson_upper_95: bucket.wilson_upper,
        calibration_data_cutoff: H73_CALIBRATION.data_cutoff,
        calibration_dataset_hash: H73_CALIBRATION.dataset_hash,
        calibration_fit_used_pnl: false,
        fixed_decision_tte_sec: 120,
      });
    if (!action) return [];
    boundedRemember(this._fired, marketId);
    return [action];
  }
}

function makeV8Strategies() {
  return [
    new MultiVenueCusumBreak(),
    new KalmanLatentConsensus(),
    new RangeThresholdPartitionLock(),
    new QueueDepletionHazard(),
    new MultiLevelOfiImpact(),
    new QuarticityConfidenceEnvelope(),
    new StationaryBlockBootstrapDigital(),
    new TokenElasticityResidual(),
    new CrossHorizonNestedLock(),
    new MarketPriorCalibrationResidual(),
  ];
}

module.exports = makeV8Strategies;
module.exports._test = {
  CrossHorizonNestedLock,
  KalmanLatentConsensus,
  MarketPriorCalibrationResidual,
  MultiLevelOfiImpact,
  MultiVenueCusumBreak,
  QueueDepletionHazard,
  QuarticityConfidenceEnvelope,
  RangeThresholdPartitionLock,
  STRATEGY_NAMES,
  StationaryBlockBootstrapDigital,
  TokenElasticityResidual,
  bootstrapTerminalProbabilities,
  feePerShare,
  marketSnapshot,
  multiLevelOfi,
  quarticityProfile,
  queueFlow,
  regressionProfile,
  snapshotBook,
  structuralBundleActions,
  wilsonInterval,
};
