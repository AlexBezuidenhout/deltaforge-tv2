/**
 * BORG H74-H75 — prospective state-dependent, minute-horizon research.
 *
 * H74 tests whether a statistically identifiable three-state Markov chain
 * contributes incremental binary fair value. H75 tests whether a dynamically
 * selected cross-asset leader transmits a liquidity-confirmed shock with a
 * one-minute delay. Both models are estimated from rolling four-hour windows.
 *
 * The development tape rejected naive fixed BTC -> alt propagation and an
 * unconditional Markov direction rule. These stricter successors therefore:
 *   - use complete one-minute observations, never repeated one-second rows;
 *   - require independently identifiable state/relationship estimates;
 *   - retain BTC, ETH, SOL and XRP instead of selecting the best development
 *     asset;
 *   - trade only incremental residual versus the executable token ask after
 *     doubled crypto taker fees and a one-cent buffer; and
 *   - remain paper-only with no signer, key or order-submission dependency.
 */
'use strict';

const makeV7Strategies = require('./research-v7');
const GateDiagnostics = require('./gate-diagnostics');
const { TARGET_STAKE_USD } = require('../research/capital-policy');

const { fairEnvelope } = makeV7Strategies._test;

const STRATEGY_VERSION = 'research-v9-h74-h75-paper-v1';
const ASSETS = Object.freeze(['btc', 'eth', 'sol', 'xrp']);
const ASSET_SET = new Set(ASSETS);
const MINUTE_MS = 60_000;
const ROLLING_MINUTES = 240;
const MIN_STATE_OBSERVATIONS = 30;
const MARKOV_ENTROPY_MAX = 0.90;
const MARKOV_Z_99 = 2.576;
const REGRESSION_Z_95 = 1.96;
const CRYPTO_TAKER_RATE = 0.07;
const COST_MULTIPLIER = 2;
const EDGE_BUFFER = 0.01;
const DEPTH_PARTICIPATION = 0.20;
const MAX_STAKE_USD = TARGET_STAKE_USD;
const EPISODE_COOLDOWN_MINUTES = 15;

const STRATEGY_NAMES = Object.freeze([
  'H74_markov_regime_residual',
  'H75_4h_dynamic_liquidity_leadlag',
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

function mean(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length
    ? clean.reduce((sum, value) => sum + value, 0) / clean.length
    : null;
}

function variance(values) {
  const clean = values.filter(Number.isFinite);
  if (clean.length < 2) return null;
  const center = mean(clean);
  return clean.reduce((sum, value) => sum + (value - center) ** 2, 0)
    / (clean.length - 1);
}

function standardDeviation(values) {
  const value = variance(values);
  return value != null && value >= 0 ? Math.sqrt(value) : null;
}

function quantile(values, probability) {
  const clean = values.filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (!clean.length) return null;
  const index = clamp(probability, 0, 1) * (clean.length - 1);
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return low === high
    ? clean[low]
    : clean[low] + (index - low) * (clean[high] - clean[low]);
}

function normalizedEntropy(probabilities) {
  const entropy = probabilities.reduce((sum, probability) =>
    probability > 0 ? sum - probability * Math.log(probability) : sum, 0);
  return entropy / Math.log(probabilities.length);
}

function stateFor(value, scale) {
  if (value < -0.5 * scale) return 0;
  if (value > 0.5 * scale) return 2;
  return 1;
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
  return { bid, bidSize, ask, askSize };
}

function feePerShare(price) {
  const p = finite(price);
  return p == null ? Infinity
    : COST_MULTIPLIER * CRYPTO_TAKER_RATE * p * (1 - p);
}

function selectedProbability(envelope, sign) {
  if (!envelope) return null;
  const lower = finite(envelope.lower);
  const upper = finite(envelope.upper);
  if (lower == null || upper == null) return null;
  return sign > 0 ? lower : 1 - upper;
}

function selectedBook(ctx, sign) {
  return touch(sign > 0 ? ctx.upBook : ctx.downBook);
}

function spotCandidates(ctx) {
  const rows = [finite(ctx.btc)];
  if (inBand(finite(ctx.rtdsChainlinkAgeMs), 0, 3000)) {
    rows.push(finite(ctx.rtdsChainlink));
  }
  if (ctx.venueStale === false) rows.push(finite(ctx.venuePrice));
  if (ctx.hyperStale === false) rows.push(finite(ctx.hyperPrice));
  return rows.filter((value) => value > 0);
}

function incrementalResidualAction({
  ctx,
  engine,
  strategy,
  sign,
  forecastBps,
  note,
  features,
}) {
  const baseSpots = spotCandidates(ctx);
  if (!baseSpots.length || !forecastBps || Math.sign(forecastBps) !== sign) return null;
  const base = fairEnvelope(ctx, { spots: baseSpots });
  const shifted = fairEnvelope(ctx, {
    spots: baseSpots.map((spot) => spot * Math.exp(forecastBps / 10_000)),
  });
  const quote = selectedBook(ctx, sign);
  const baseProbability = selectedProbability(base, sign);
  const shiftedProbability = selectedProbability(shifted, sign);
  if (!quote || !inBand(quote.ask, 0.08, 0.94)
      || !inBand(baseProbability, 0, 1)
      || !inBand(shiftedProbability, 0, 1)) return null;
  const baseEdge2x = baseProbability - quote.ask - feePerShare(quote.ask);
  const shiftedEdge2x = shiftedProbability - quote.ask - feePerShare(quote.ask);
  // Attribute the order to this mechanism: without its forecast adjustment,
  // the conservative terminal model must not already qualify independently.
  if (baseEdge2x >= EDGE_BUFFER || shiftedEdge2x < EDGE_BUFFER) return null;
  const shares = Math.min(MAX_STAKE_USD / quote.ask,
    quote.askSize * DEPTH_PARTICIPATION);
  if (!(shares > 0) || shares * quote.ask < 1) return null;
  const names = labels(ctx);
  return {
    action: 'place',
    side: 'BUY',
    token: sign > 0 ? names.positive : names.negative,
    price: quote.ask,
    size: shares,
    kind: 'taker',
    coid: engine._coid(strategy),
    queueAhead: quote.askSize,
    executionModel: String(ctx.triggerEvent?.source || '').length
      ? 'event_order_250ms' : 'latency_1s',
    thesisVersion: STRATEGY_VERSION,
    features: {
      mechanism_family: 'state_dependent_minute_residual',
      forecast_bps_conservative: forecastBps,
      base_fair_lower_selected: baseProbability,
      shifted_fair_lower_selected: shiftedProbability,
      incremental_probability: shiftedProbability - baseProbability,
      base_edge_2x_per_share: baseEdge2x,
      shifted_edge_2x_per_share: shiftedEdge2x,
      fee_multiplier: COST_MULTIPLIER,
      edge_buffer: EDGE_BUFFER,
      displayed_touch_shares: quote.askSize,
      displayed_capacity_usd: quote.ask * quote.askSize,
      depth_participation: DEPTH_PARTICIPATION,
      simulated_notional_usd: quote.ask * shares,
      rolling_window_minutes: ROLLING_MINUTES,
      provisional: true,
      paper_only: true,
      ...features,
    },
    note: `${note} forecast=${forecastBps.toFixed(3)}bp ` +
      `base_edge2x=${baseEdge2x.toFixed(4)} shifted_edge2x=${shiftedEdge2x.toFixed(4)}`,
  };
}

/**
 * Keeps one replaceable snapshot per wall-clock minute and exposes only
 * completed minutes. All DECIMAL/string-like fields are parsed at ingress.
 */
class MinuteTape {
  constructor() {
    this.byAsset = new Map(ASSETS.map((asset) => [asset, []]));
  }

  _upsert(asset, row) {
    const rows = this.byAsset.get(asset);
    const last = rows.at(-1);
    if (last?.minute === row.minute) rows[rows.length - 1] = row;
    else if (!last || row.minute > last.minute) rows.push(row);
    while (rows.length > ROLLING_MINUTES + 20) rows.shift();
  }

  observe(ctx) {
    const asset = String(ctx.market?.asset || '').toLowerCase();
    const price = finite(ctx.btc);
    if (!ASSET_SET.has(asset) || !(price > 0)) return;
    const minute = Math.floor(ctx.now / MINUTE_MS) * MINUTE_MS;
    const micro = ctx.micro60 || ctx.micro30 || null;
    const priceAgeMs = finite(micro?.lastPriceAgeMs);
    if (priceAgeMs != null && priceAgeMs > 5000) return;
    const row = {
      minute,
      close: price,
      flow: finite(micro?.flowImbalance),
      trades: finite(micro?.trades),
      volume: finite(micro?.volume),
    };
    this._upsert(asset, row);
  }

  hydrate(rawRows) {
    let accepted = 0;
    const rows = [...(rawRows || [])].sort((left, right) =>
      new Date(left.minute).getTime() - new Date(right.minute).getTime());
    for (const raw of rows) {
      const asset = String(raw.asset || '').toLowerCase();
      const minute = new Date(raw.minute).getTime();
      const close = finite(raw.close);
      const buyVolume = finite(raw.buy_vol);
      const sellVolume = finite(raw.sell_vol);
      const totalVolume = buyVolume != null && sellVolume != null
        ? buyVolume + sellVolume
        : finite(raw.volume);
      const flow = finite(raw.flow) ?? (
        totalVolume > 0 && buyVolume != null && sellVolume != null
          ? (buyVolume - sellVolume) / totalVolume
          : null
      );
      if (!ASSET_SET.has(asset) || !Number.isFinite(minute) || !(close > 0)) continue;
      this._upsert(asset, {
        minute,
        close,
        flow,
        trades: finite(raw.trades ?? raw.n_trades),
        volume: totalVolume,
      });
      accepted += 1;
    }
    return accepted;
  }

  complete(asset, now) {
    const currentMinute = Math.floor(now / MINUTE_MS) * MINUTE_MS;
    return (this.byAsset.get(asset) || [])
      .filter((row) => row.minute < currentMinute);
  }

  aligned(now) {
    const maps = new Map(ASSETS.map((asset) => [
      asset,
      new Map(this.complete(asset, now).map((row) => [row.minute, row])),
    ]));
    const minutes = [...maps.get('btc').keys()]
      .filter((minute) => ASSETS.every((asset) => maps.get(asset).has(minute)))
      .sort((left, right) => left - right);
    const snapshots = minutes.map((minute) => ({
      minute,
      values: Object.fromEntries(ASSETS.map((asset) => [
        asset,
        maps.get(asset).get(minute),
      ])),
    }));
    const returns = [];
    for (let index = 1; index < snapshots.length; index += 1) {
      const previous = snapshots[index - 1];
      const current = snapshots[index];
      if (current.minute - previous.minute !== MINUTE_MS) continue;
      returns.push({
        minute: current.minute,
        returns: Object.fromEntries(ASSETS.map((asset) => [
          asset,
          10_000 * Math.log(
            current.values[asset].close / previous.values[asset].close,
          ),
        ])),
        flow: Object.fromEntries(ASSETS.map((asset) => [
          asset,
          current.values[asset].flow,
        ])),
      });
    }
    return returns;
  }
}

function returnsFromTape(rows) {
  const returns = [];
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].minute - rows[index - 1].minute !== MINUTE_MS) {
      // A state model spanning a collector gap would silently treat missing
      // time as a one-minute transition. Retain only the continuous suffix.
      returns.length = 0;
      continue;
    }
    const prior = finite(rows[index - 1].close);
    const current = finite(rows[index].close);
    if (prior > 0 && current > 0) {
      returns.push(10_000 * Math.log(current / prior));
    }
  }
  return returns;
}

function transitionMatrix(states) {
  const counts = Array.from({ length: 3 }, () => [0.5, 0.5, 0.5]);
  const rowCounts = [0, 0, 0];
  for (let index = 0; index + 1 < states.length; index += 1) {
    counts[states[index]][states[index + 1]] += 1;
    rowCounts[states[index]] += 1;
  }
  return {
    matrix: counts.map((row) => {
      const total = row.reduce((sum, value) => sum + value, 0);
      return row.map((value) => value / total);
    }),
    rowCounts,
  };
}

function markovProfile(values) {
  const returns = values.filter(Number.isFinite).slice(-ROLLING_MINUTES);
  const scale = standardDeviation(returns);
  if (returns.length < ROLLING_MINUTES || !(scale > 0)) return null;
  const states = returns.map((value) => stateFor(value, scale));
  const transition = transitionMatrix(states);
  const currentState = states.at(-1);
  const rowCount = transition.rowCounts[currentState];
  const rowEntropy = normalizedEntropy(transition.matrix[currentState]);
  if (rowCount < MIN_STATE_OBSERVATIONS || rowEntropy > MARKOV_ENTROPY_MAX) return null;
  const emissions = [[], [], []];
  for (let index = 0; index < returns.length; index += 1) {
    emissions[states[index]].push(returns[index]);
  }
  const emissionMeans = emissions.map((rows) => mean(rows) || 0);
  const modelForecast = transition.matrix[currentState]
    .reduce((sum, probability, state) =>
      sum + probability * emissionMeans[state], 0);
  const conditionalNext = [];
  for (let index = 0; index + 1 < states.length; index += 1) {
    if (states[index] === currentState) conditionalNext.push(returns[index + 1]);
  }
  if (conditionalNext.length < MIN_STATE_OBSERVATIONS) return null;
  const empiricalMean = mean(conditionalNext);
  const empiricalSd = standardDeviation(conditionalNext);
  if (!Number.isFinite(empiricalMean) || !(empiricalSd > 0)) return null;
  const radius = MARKOV_Z_99 * empiricalSd / Math.sqrt(conditionalNext.length);
  const lower = empiricalMean - radius;
  const upper = empiricalMean + radius;
  const sign = lower > 0 ? 1 : upper < 0 ? -1 : 0;
  if (!sign || Math.sign(modelForecast) !== sign) return null;
  const conservativeForecastBps = sign > 0
    ? Math.min(modelForecast, lower)
    : Math.max(modelForecast, upper);
  if (!conservativeForecastBps || Math.sign(conservativeForecastBps) !== sign) return null;
  return {
    sign,
    conservativeForecastBps,
    modelForecastBps: modelForecast,
    empiricalMeanBps: empiricalMean,
    empiricalLower99Bps: lower,
    empiricalUpper99Bps: upper,
    empiricalObservations: conditionalNext.length,
    currentState,
    stateScaleBps: scale,
    stateTransitions: rowCount,
    transitionEntropy: rowEntropy,
    transitionRow: transition.matrix[currentState],
  };
}

function regression(left, right) {
  if (left.length !== right.length || left.length < 4) return null;
  const xMean = mean(left);
  const yMean = mean(right);
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let index = 0; index < left.length; index += 1) {
    const x = left[index] - xMean;
    const y = right[index] - yMean;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
  }
  if (!(sxx > 0) || !(syy > 0)) return null;
  const slope = sxy / sxx;
  const intercept = yMean - slope * xMean;
  const residualSum = left.reduce((sum, value, index) => {
    const residual = right[index] - (intercept + slope * value);
    return sum + residual * residual;
  }, 0);
  const slopeSe = Math.sqrt((residualSum / (left.length - 2)) / sxx);
  const correlation = sxy / Math.sqrt(sxx * syy);
  const boundedCorrelation = clamp(correlation, -0.999999, 0.999999);
  const fisherLower = Math.tanh(
    Math.atanh(boundedCorrelation) - REGRESSION_Z_95 / Math.sqrt(left.length - 3),
  );
  return {
    n: left.length,
    slope,
    slopeLower95: slope - REGRESSION_Z_95 * slopeSe,
    correlation,
    correlationLower95: fisherLower,
  };
}

function pairProfiles(rows, leader, target) {
  const leaderCurrent = [];
  const targetCurrent = [];
  const leaderLag = [];
  const targetNext = [];
  for (let index = 0; index < rows.length; index += 1) {
    leaderCurrent.push(rows[index].returns[leader]);
    targetCurrent.push(rows[index].returns[target]);
    if (index + 1 < rows.length) {
      leaderLag.push(rows[index].returns[leader]);
      targetNext.push(rows[index + 1].returns[target]);
    }
  }
  return {
    contemporaneous: regression(leaderCurrent, targetCurrent),
    lagged: regression(leaderLag, targetNext),
  };
}

function leadLagProfile(rawRows, target) {
  if (!ASSET_SET.has(target) || rawRows.length < ROLLING_MINUTES + 1) return null;
  const rows = rawRows.slice(-(ROLLING_MINUTES + 1));
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].minute - rows[index - 1].minute !== MINUTE_MS) return null;
  }
  const current = rows.at(-1);
  const training = rows.slice(0, -1);
  const halves = [
    training.slice(0, ROLLING_MINUTES / 2),
    training.slice(ROLLING_MINUTES / 2),
  ];
  let best = null;
  for (const leader of ASSETS) {
    if (leader === target) continue;
    const first = pairProfiles(halves[0], leader, target);
    const second = pairProfiles(halves[1], leader, target);
    if (!first.lagged || !second.lagged
        || !first.contemporaneous || !second.contemporaneous
        || !(first.lagged.slopeLower95 > 0)
        || !(second.lagged.slopeLower95 > 0)
        || !(first.lagged.correlationLower95 > 0)
        || !(second.lagged.correlationLower95 > 0)
        || !(first.contemporaneous.slope > 0)
        || !(second.contemporaneous.slope > 0)) continue;
    const score = Math.min(
      first.lagged.correlationLower95,
      second.lagged.correlationLower95,
    );
    if (!best || score > best.score) {
      best = {
        leader,
        score,
        lagBetaLower95: Math.min(
          first.lagged.slopeLower95,
          second.lagged.slopeLower95,
        ),
        contemporaneousBeta: Math.min(
          first.contemporaneous.slope,
          second.contemporaneous.slope,
        ),
        first,
        second,
      };
    }
  }
  if (!best) return null;
  const leaderReturn = finite(current.returns[best.leader]);
  const targetReturn = finite(current.returns[target]);
  const leaderFlow = finite(current.flow[best.leader]);
  const targetFlow = finite(current.flow[target]);
  const returnShock = quantile(
    training.map((row) => Math.abs(row.returns[best.leader])),
    0.95,
  );
  const flowShock = quantile(
    training.map((row) => Math.abs(row.flow[best.leader])),
    0.75,
  );
  if (!Number.isFinite(leaderReturn) || !Number.isFinite(targetReturn)
      || !Number.isFinite(leaderFlow) || !Number.isFinite(targetFlow)
      || !(Math.abs(leaderReturn) >= returnShock)
      || !(Math.abs(leaderFlow) >= flowShock)
      || Math.sign(leaderFlow) !== Math.sign(leaderReturn)) return null;
  const expectedContemporaneous = best.contemporaneousBeta * leaderReturn;
  if (!expectedContemporaneous
      || Math.sign(expectedContemporaneous) !== Math.sign(leaderReturn)
      || Math.abs(targetReturn) > 0.5 * Math.abs(expectedContemporaneous)
      || Math.abs(targetFlow) >= Math.abs(leaderFlow)) return null;
  const conservativeForecastBps = best.lagBetaLower95 * leaderReturn;
  if (!conservativeForecastBps) return null;
  return {
    sign: Math.sign(conservativeForecastBps),
    conservativeForecastBps,
    leader: best.leader,
    target,
    leaderReturnBps: leaderReturn,
    targetReturnBps: targetReturn,
    leaderFlow,
    targetFlow,
    returnShock95Bps: returnShock,
    flowShock75: flowShock,
    lagBetaLower95: best.lagBetaLower95,
    lagCorrelationLower95: best.score,
    contemporaneousBeta: best.contemporaneousBeta,
    firstHalfLagN: best.first.lagged.n,
    secondHalfLagN: best.second.lagged.n,
    completedMinute: current.minute,
  };
}

class MarkovRegimeResidual {
  constructor() {
    this.name = STRATEGY_NAMES[0];
    this.marketTypes = ['direction_15m'];
    this.cadence = 'sampled';
    this._tape = new MinuteTape();
    this._cache = new Map();
    this._fired = new Set();
    this._gates = new GateDiagnostics(this.name);
  }

  onHalt() { return []; }

  diagnostics() {
    return { gateDiagnostics: this._gates.snapshot() };
  }

  hydrateMinuteTape(rows) {
    return this._tape.hydrate(rows);
  }

  evaluate(ctx, engine) {
    this._gates.begin();
    this._tape.observe(ctx);
    const asset = String(ctx.market?.asset || '').toLowerCase();
    const marketId = ctx.market?.id;
    if (!ASSET_SET.has(asset)) return this._gates.reject('unsupported_asset', ctx.now);
    if (marketId == null) return this._gates.reject('missing_market_id', ctx.now);
    if (this._fired.has(marketId)) return this._gates.reject('already_fired_market', ctx.now);
    if (!inBand(ctx.tteSec, 180, 600)) {
      return this._gates.reject('outside_tte_window', ctx.now);
    }
    const complete = this._tape.complete(asset, ctx.now);
    const latestMinute = complete.at(-1)?.minute;
    if (latestMinute == null) {
      return this._gates.reject('no_complete_minute_observation', ctx.now);
    }
    if (ctx.now - latestMinute > 2 * MINUTE_MS) {
      return this._gates.reject('complete_minute_observation_stale', ctx.now);
    }
    const cacheKey = `${asset}:${latestMinute}`;
    if (!this._cache.has(cacheKey)) {
      this._cache.set(cacheKey, markovProfile(returnsFromTape(complete)));
      if (this._cache.size > 100) this._cache.delete(this._cache.keys().next().value);
    }
    const profile = this._cache.get(cacheKey);
    if (!profile) return this._gates.reject('markov_profile_unidentifiable', ctx.now);
    const action = incrementalResidualAction({
      ctx,
      engine,
      strategy: this.name,
      sign: profile.sign,
      forecastBps: profile.conservativeForecastBps,
      note: `state=${profile.currentState} transitions=${profile.stateTransitions} ` +
        `entropy=${profile.transitionEntropy.toFixed(3)} n=${profile.empiricalObservations}`,
      features: {
        mechanism_family: 'four_hour_three_state_markov_residual',
        markov_state: profile.currentState,
        markov_state_scale_bps: profile.stateScaleBps,
        markov_transition_row: profile.transitionRow,
        markov_transition_entropy: profile.transitionEntropy,
        markov_state_transitions: profile.stateTransitions,
        markov_model_forecast_bps: profile.modelForecastBps,
        markov_empirical_mean_bps: profile.empiricalMeanBps,
        markov_empirical_lower_99_bps: profile.empiricalLower99Bps,
        markov_empirical_upper_99_bps: profile.empiricalUpper99Bps,
        markov_empirical_observations: profile.empiricalObservations,
        development_prior: 'negative_unconditional_30d',
      },
    });
    if (!action) {
      return this._gates.reject('model_residual_or_executable_hurdle_failed', ctx.now);
    }
    this._fired.add(marketId);
    if (this._fired.size > 5000) this._fired.delete(this._fired.values().next().value);
    return this._gates.accept([action], ctx.now);
  }
}

class DynamicLiquidityLeadLag {
  constructor() {
    this.name = STRATEGY_NAMES[1];
    this.marketTypes = ['direction_15m'];
    this.cadence = 'sampled';
    this._tape = new MinuteTape();
    this._cache = new Map();
    this._nextEligible = new Map(ASSETS.map((asset) => [asset, 0]));
    this._fired = new Set();
    this._gates = new GateDiagnostics(this.name);
  }

  onHalt() { return []; }

  diagnostics() {
    return { gateDiagnostics: this._gates.snapshot() };
  }

  hydrateMinuteTape(rows) {
    return this._tape.hydrate(rows);
  }

  evaluate(ctx, engine) {
    this._gates.begin();
    this._tape.observe(ctx);
    const target = String(ctx.market?.asset || '').toLowerCase();
    const marketId = ctx.market?.id;
    if (!ASSET_SET.has(target)) return this._gates.reject('unsupported_asset', ctx.now);
    if (marketId == null) return this._gates.reject('missing_market_id', ctx.now);
    if (this._fired.has(marketId)) return this._gates.reject('already_fired_market', ctx.now);
    if (!inBand(ctx.tteSec, 180, 600)) {
      return this._gates.reject('outside_tte_window', ctx.now);
    }
    const aligned = this._tape.aligned(ctx.now);
    const latestMinute = aligned.at(-1)?.minute;
    if (latestMinute == null) {
      return this._gates.reject('no_aligned_complete_minute_observation', ctx.now);
    }
    if (ctx.now - latestMinute > 2 * MINUTE_MS) {
      return this._gates.reject('aligned_minute_observation_stale', ctx.now);
    }
    if (latestMinute < this._nextEligible.get(target)) {
      return this._gates.reject('episode_cooldown_active', ctx.now);
    }
    const cacheKey = `${target}:${latestMinute}`;
    if (!this._cache.has(cacheKey)) {
      this._cache.set(cacheKey, leadLagProfile(aligned, target));
      if (this._cache.size > 100) this._cache.delete(this._cache.keys().next().value);
    }
    const profile = this._cache.get(cacheKey);
    if (!profile) {
      return this._gates.reject('stable_liquidity_leader_episode_unavailable', ctx.now);
    }
    const action = incrementalResidualAction({
      ctx,
      engine,
      strategy: this.name,
      sign: profile.sign,
      forecastBps: profile.conservativeForecastBps,
      note: `${profile.leader}->${target} leader=${profile.leaderReturnBps.toFixed(2)}bp ` +
        `target=${profile.targetReturnBps.toFixed(2)}bp flow=${profile.leaderFlow.toFixed(3)}`,
      features: {
        mechanism_family: 'four_hour_dynamic_liquidity_leadlag',
        leader_asset: profile.leader,
        target_asset: profile.target,
        leader_return_bps: profile.leaderReturnBps,
        target_return_bps: profile.targetReturnBps,
        leader_flow_imbalance: profile.leaderFlow,
        target_flow_imbalance: profile.targetFlow,
        leader_return_shock_95_bps: profile.returnShock95Bps,
        leader_flow_shock_75: profile.flowShock75,
        lag_beta_lower_95: profile.lagBetaLower95,
        lag_correlation_lower_95: profile.lagCorrelationLower95,
        contemporaneous_beta: profile.contemporaneousBeta,
        first_half_lag_observations: profile.firstHalfLagN,
        second_half_lag_observations: profile.secondHalfLagN,
        dynamic_leader_not_fixed_btc: true,
        all_asset_arms_retained: ASSETS,
        development_eth_selection_rejected: true,
      },
    });
    if (!action) {
      return this._gates.reject('model_residual_or_executable_hurdle_failed', ctx.now);
    }
    this._fired.add(marketId);
    if (this._fired.size > 5000) this._fired.delete(this._fired.values().next().value);
    this._nextEligible.set(
      target,
      latestMinute + EPISODE_COOLDOWN_MINUTES * MINUTE_MS,
    );
    return this._gates.accept([action], ctx.now);
  }
}

function makeV9Strategies() {
  return [
    new MarkovRegimeResidual(),
    new DynamicLiquidityLeadLag(),
  ];
}

module.exports = makeV9Strategies;
module.exports._test = {
  ASSETS,
  DynamicLiquidityLeadLag,
  MarkovRegimeResidual,
  MinuteTape,
  STRATEGY_NAMES,
  incrementalResidualAction,
  leadLagProfile,
  markovProfile,
  regression,
  returnsFromTape,
  stateFor,
  transitionMatrix,
};
