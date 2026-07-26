/**
 * BORG H54-H63 — ten paper-only, forward research strategies.
 *
 * These rules deliberately avoid the already-falsified generic momentum,
 * favourite buying, signal inversion and two-sided maker families. Every
 * order is an intent for the shadow scorer; this module has no signer, wallet
 * dependency or order-submission path.
 *
 * Common execution contract:
 *   - executable bid/ask, never midpoint, is the benchmark;
 *   - two times the documented crypto taker curve is charged even to the
 *     passive arm, plus a one-token-tick edge buffer;
 *   - no more than $10 or 20% of displayed touch is simulated;
 *   - one terminal position per strategy/market;
 *   - all numerical cut-offs are mechanism discriminators and PROVISIONAL
 *     until 300 fresh independent markets and the full promotion protocol.
 */
'use strict';

const ShadowEngine = require('./engine');
const makeV3Strategies = require('./research-v3');
const makeV4Strategies = require('./research-v4');
const { TARGET_STAKE_USD } = require('../research/capital-policy');

const { binaryFair } = makeV3Strategies._test;
const { positiveProbability } = makeV4Strategies._test;

const STRATEGY_VERSION = 'research-v7-h54-h63-paper-v1';
const CRYPTO_TAKER_RATE = 0.07;
const COST_MULTIPLIER = 2;
const EDGE_BUFFER = 0.01;
const DEPTH_PARTICIPATION = 0.20;
const MAX_STAKE_USD = TARGET_STAKE_USD;
const DIRECTION_ASSETS = new Set(['btc', 'eth', 'sol', 'xrp']);

const STRATEGY_NAMES = Object.freeze([
  'H54_dynamic_ofi_resolver_confirm',
  'H55_ofi_guarded_passive_maker',
  'H56_hawkes_excitation_continuation',
  'H57_adaptive_venue_leader_residual',
  'H58_resolver_event_stale_quote',
  'H59_resolver_cross_persistence',
  'H60_bipower_jump_envelope',
  'H61_vol_regime_envelope',
  'H62_threshold_isotonic_residual',
  'H63_range_simplex_residual',
]);

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

function median(values) {
  const clean = values.map(finite).filter(Number.isFinite).sort((left, right) => left - right);
  if (!clean.length) return null;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
}

function boundedRemember(set, value, limit = 5000) {
  set.add(value);
  if (set.size > limit) set.delete(set.values().next().value);
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
  const total = bidSize + askSize;
  return {
    bid, bidSize, ask, askSize,
    mid: (bid + ask) / 2,
    imbalance: (bidSize - askSize) / total,
    microprice: (ask * bidSize + bid * askSize) / total,
  };
}

function feePerShare(price, multiplier = COST_MULTIPLIER) {
  return multiplier * CRYPTO_TAKER_RATE * price * (1 - price);
}

function volatilityCandidates(ctx) {
  return [
    finite(ctx.volatility?.robustSigma5m),
    finite(ctx.volatility?.rmsSigma5m),
    finite(ctx.sigma),
  ].filter((value) => value > 1e-8 && value < 1);
}

function isFreshAge(value, maxAgeMs) {
  const age = finite(value);
  return age != null && age >= 0 && age <= maxAgeMs;
}

function freshSpotCandidates(ctx) {
  const rows = [finite(ctx.btc)];
  if (isFreshAge(ctx.rtdsChainlinkAgeMs, 3000)) rows.push(finite(ctx.rtdsChainlink));
  if (ctx.venueStale === false) rows.push(finite(ctx.venuePrice));
  if (ctx.hyperStale === false) rows.push(finite(ctx.hyperPrice));
  return rows.filter((value) => value > 0);
}

/**
 * Distributionally conservative probability interval. It does not average
 * away resolver or volatility uncertainty: every plausible source/sigma
 * combination must be survived by the selected side.
 */
function fairEnvelope(ctx, options = {}) {
  const tteSec = finite(ctx.tteSec);
  const refs = (options.refs || [finite(ctx.ref), finite(ctx.resolverRef)])
    .map(finite).filter((value) => value > 0);
  const spots = (options.spots || freshSpotCandidates(ctx))
    .map(finite).filter((value) => value > 0);
  const sigmas = (options.sigmas || volatilityCandidates(ctx))
    .map(finite).filter((value) => value > 1e-8 && value < 1);
  if (!(tteSec > 0) || !refs.length || !spots.length || !sigmas.length) return null;
  const probabilities = [];
  for (const ref of refs) {
    for (const spot of spots) {
      for (const sigma of sigmas) {
        const probability = binaryFair(spot, ref, sigma, tteSec);
        if (Number.isFinite(probability)) probabilities.push(clampProbability(probability));
      }
    }
  }
  if (!probabilities.length) return null;
  return {
    lower: Math.min(...probabilities),
    upper: Math.max(...probabilities),
    midpoint: median(probabilities),
    refs,
    spots,
    sigmas,
  };
}

function directionalQuote(ctx, sign, envelope) {
  const names = labels(ctx);
  const positive = sign > 0;
  const book = positive ? ctx.upBook : ctx.downBook;
  const view = touch(book);
  if (!view || !envelope) return null;
  return {
    token: positive ? names.positive : names.negative,
    book,
    ...view,
    probabilityLower: positive ? envelope.lower : 1 - envelope.upper,
    probabilityUpper: positive ? envelope.upper : 1 - envelope.lower,
  };
}

function takerAction(ctx, engine, strategy, sign, envelope, note, features = {}) {
  const quote = directionalQuote(ctx, sign, envelope);
  if (!quote || !inBand(quote.ask, 0.08, 0.94)) return null;
  const edge2x = quote.probabilityLower - quote.ask - feePerShare(quote.ask);
  if (edge2x < EDGE_BUFFER) return null;
  const shares = Math.min(MAX_STAKE_USD / quote.ask, quote.askSize * DEPTH_PARTICIPATION);
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
      mechanism_family: features.mechanism_family || 'research_v7',
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
  return takerAction(ctx, engine, strategy, candidates[0].sign, envelope, note, features);
}

function topOfi(previous, current) {
  if (!previous || !current) return null;
  let value = 0;
  if (current.bid >= previous.bid) value += current.bidSize;
  if (current.bid <= previous.bid) value -= previous.bidSize;
  if (current.ask <= previous.ask) value -= current.askSize;
  if (current.ask >= previous.ask) value += previous.askSize;
  return value;
}

class DynamicOfiTape {
  constructor() {
    this.byMarket = new Map();
  }

  observe(ctx) {
    const marketId = ctx.market?.id;
    if (marketId == null || String(ctx.triggerEvent?.source || '') !== 'clob') return null;
    const up = touch(ctx.upBook);
    const down = touch(ctx.downBook);
    if (!up || !down) return null;
    const state = this.byMarket.get(marketId) || { previous: null, events: [] };
    let increment = null;
    if (state.previous) {
      const upOfi = topOfi(state.previous.up, up);
      const downOfi = topOfi(state.previous.down, down);
      if (Number.isFinite(upOfi) && Number.isFinite(downOfi)) increment = upOfi - downOfi;
    }
    state.previous = { up, down };
    if (Number.isFinite(increment) && Math.abs(increment) > 1e-9) {
      state.events.push({
        at: ctx.now,
        increment,
        depth: (up.bidSize + up.askSize + down.bidSize + down.askSize) / 2,
      });
    }
    while (state.events.length && state.events[0].at < ctx.now - 2000) state.events.shift();
    this.byMarket.set(marketId, state);
    if (this.byMarket.size > 5000) this.byMarket.delete(this.byMarket.keys().next().value);
    if (state.events.length < 3) return null;
    const cumulative = state.events.reduce((sum, row) => sum + row.increment, 0);
    const averageDepth = state.events.reduce((sum, row) => sum + row.depth, 0) / state.events.length;
    return {
      events: state.events.length,
      cumulative,
      averageDepth,
      normalized: averageDepth > 0 ? cumulative / averageDepth : null,
      spanMs: state.events.at(-1).at - state.events[0].at,
    };
  }
}

/**
 * H54 — dynamic order-flow imbalance, depth-normalized as in Cont, Kukanov &
 * Stoikov, is used only as an entry-timing filter. Resolver and venue prices
 * still supply terminal fair value.
 */
class DynamicOfiResolverConfirm {
  constructor() {
    this.name = STRATEGY_NAMES[0];
    this.marketTypes = ['direction_5m'];
    this.cadence = 'event';
    this._tape = new DynamicOfiTape();
    this._fired = new Set();
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
    const state = this._tape.observe(ctx);
    const marketId = ctx.market?.id;
    if (!state || marketId == null || this._fired.has(marketId)
        || !DIRECTION_ASSETS.has(ctx.market?.asset)
        || !inBand(ctx.tteSec, 30, 240)
        || !Number.isFinite(state.normalized)
        || Math.abs(state.normalized) < 0.50) return [];
    const sign = Math.sign(state.normalized);
    const resolverReturn = finite(ctx.rtdsChainlink10?.returnBps);
    const venueReturn = finite(ctx.micro10?.returnBps);
    if (!sign || !Number.isFinite(resolverReturn) || !Number.isFinite(venueReturn)
        || sign * resolverReturn < 1 || sign * venueReturn < 1) return [];
    const envelope = fairEnvelope(ctx);
    const action = takerAction(ctx, engine, this.name, sign, envelope,
      `dynamic_ofi=${state.normalized.toFixed(3)} events=${state.events} ` +
      `resolver10=${resolverReturn.toFixed(2)}bp venue10=${venueReturn.toFixed(2)}bp`, {
        mechanism_family: 'depth_normalized_dynamic_ofi',
        ofi_normalized_2s: state.normalized,
        ofi_events_2s: state.events,
        ofi_span_ms: state.spanMs,
      });
    if (!action) return [];
    boundedRemember(this._fired, marketId);
    return [action];
  }
}

/**
 * H55 — one-sided passive liquidity, admitted only after persistent supportive
 * queue imbalance and removed on adverse OFI. This tests whether toxicity
 * filtering can rescue a narrowly selected maker; it is not a revival of the
 * rejected generic two-sided maker.
 */
class OfiGuardedPassiveMaker {
  constructor() {
    this.name = STRATEGY_NAMES[1];
    this.marketTypes = ['direction_5m'];
    this.cadence = 'event';
    this._ofi = new DynamicOfiTape();
    this._samples = new Map();
    this._active = new Map();
    this._done = new Set();
  }

  _cancel(marketId, note) {
    const active = this._active.get(marketId);
    if (!active) return [];
    this._active.delete(marketId);
    boundedRemember(this._done, marketId);
    return [{ action: 'cancel', coid: active.coid, note }];
  }

  onHalt(ctx) { return this._cancel(ctx.market?.id, 'halt'); }

  evaluate(ctx, engine) {
    const marketId = ctx.market?.id;
    const ofi = this._ofi.observe(ctx);
    if (marketId == null) return [];
    const active = this._active.get(marketId);
    if (active) {
      const quote = directionalQuote(ctx, active.sign, fairEnvelope(ctx));
      const ownImbalance = quote?.imbalance;
      const adverseOfi = Number.isFinite(ofi?.normalized)
        && active.sign * ofi.normalized < -0.10;
      const edgeLost = !quote
        || quote.probabilityLower - active.price - feePerShare(active.price) < EDGE_BUFFER;
      if (ctx.now - active.placedAt >= 8000 || ctx.tteSec < 45
          || adverseOfi || edgeLost || ownImbalance < 0) {
        return this._cancel(marketId, adverseOfi ? 'adverse_ofi'
          : edgeLost ? 'fair_edge_lost' : ownImbalance < 0 ? 'queue_flipped' : 'quote_timeout');
      }
      return [];
    }
    if (this._done.has(marketId) || String(ctx.triggerEvent?.source || '') !== 'clob'
        || !inBand(ctx.tteSec, 60, 240)) return [];
    const envelope = fairEnvelope(ctx);
    if (!envelope) return [];
    const candidates = [1, -1].map((sign) => {
      const quote = directionalQuote(ctx, sign, envelope);
      if (!quote || !inBand(quote.bid, 0.08, 0.93)) return null;
      return {
        sign,
        quote,
        edge: quote.probabilityLower - quote.bid - feePerShare(quote.bid),
      };
    }).filter(Boolean).sort((left, right) => right.edge - left.edge);
    const best = candidates[0];
    if (!best || best.edge < 0.03) return [];
    const key = `${marketId}:${best.sign}`;
    const samples = this._samples.get(key) || [];
    samples.push({ at: ctx.now, imbalance: best.quote.imbalance });
    while (samples.length && samples[0].at < ctx.now - 2000) samples.shift();
    this._samples.set(key, samples);
    if (this._samples.size > 10000) this._samples.delete(this._samples.keys().next().value);
    if (samples.length < 4 || samples.at(-1).at - samples[0].at < 750
        || median(samples.map((row) => row.imbalance)) < 0.25
        || Math.min(...samples.map((row) => row.imbalance)) < 0
        || (Number.isFinite(ofi?.normalized) && best.sign * ofi.normalized < -0.10)) return [];
    const price = best.quote.bid;
    const size = Math.min(MAX_STAKE_USD / price,
      best.quote.bidSize * DEPTH_PARTICIPATION);
    if (!(size > 0) || size * price < 1) return [];
    const coid = engine._coid(this.name);
    this._active.set(marketId, {
      coid, sign: best.sign, price, placedAt: ctx.now,
    });
    return [{
      action: 'place',
      side: 'BUY',
      token: best.quote.token,
      price,
      size,
      kind: 'maker',
      coid,
      queueAhead: ShadowEngine.queueAhead(best.quote.book, 'bids', price),
      executionModel: 'maker_queue_v1',
      thesisVersion: STRATEGY_VERSION,
      features: {
        mechanism_family: 'ofi_guarded_one_sided_maker',
        fair_lower_selected: best.quote.probabilityLower,
        edge_2x_at_quote: best.edge,
        median_queue_imbalance_2s: median(samples.map((row) => row.imbalance)),
        ofi_normalized_2s: ofi?.normalized ?? null,
        quote_lifetime_ms: 8000,
        provisional: true,
        paper_only: true,
      },
      note: `persistent_queue=${median(samples.map((row) => row.imbalance)).toFixed(3)} ` +
        `edge2x_at_bid=${best.edge.toFixed(4)} cancel_on_adverse_ofi=true`,
    }];
  }
}

function burstForToken(prints, now) {
  const recent = prints.filter(([at]) => at >= now - 3000);
  const baseline = prints.filter(([at]) => at >= now - 30000 && at < now - 3000);
  const expected = baseline.length / 27 * 3;
  const z = (recent.length - expected) / Math.sqrt(expected + 1);
  const olderMedian = median(baseline.map((row) => row[1]));
  const recentMedian = median(recent.map((row) => row[1]));
  const latestAt = recent.length ? Math.max(...recent.map((row) => row[0])) : null;
  return {
    recent: recent.length,
    baseline: baseline.length,
    expected,
    z,
    olderMedian,
    recentMedian,
    latestAt,
    recentVolume: recent.reduce((sum, row) => sum + (finite(row[2]) || 0), 0),
  };
}

/** H56 — a Hawkes-style excitation proxy on public prints, resolver-confirmed. */
class HawkesExcitationContinuation {
  constructor() {
    this.name = STRATEGY_NAMES[2];
    this.marketTypes = ['direction_5m'];
    this.cadence = 'sampled';
    this._fired = new Set();
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
    const marketId = ctx.market?.id;
    if (marketId == null || this._fired.has(marketId)
        || typeof ctx.prints !== 'function'
        || !inBand(ctx.tteSec, 30, 180)) return [];
    const rows = [
      { sign: 1, tokenId: ctx.upTokenId },
      { sign: -1, tokenId: ctx.downTokenId },
    ].filter((row) => row.tokenId).map((row) => ({
      ...row,
      burst: burstForToken(ctx.prints(row.tokenId, ctx.now - 30000), ctx.now),
    })).filter((row) => row.burst.recent >= 5
      && row.burst.z >= 2
      && row.burst.latestAt != null
      && ctx.now - row.burst.latestAt <= 1200
      && Number.isFinite(row.burst.olderMedian)
      && Number.isFinite(row.burst.recentMedian)
      && row.burst.recentMedian >= row.burst.olderMedian + 0.01)
      .sort((left, right) => right.burst.z - left.burst.z);
    const best = rows[0];
    if (!best) return [];
    const resolverReturn = finite(ctx.rtdsChainlink10?.returnBps);
    if (!Number.isFinite(resolverReturn) || best.sign * resolverReturn < 1) return [];
    const action = takerAction(ctx, engine, this.name, best.sign, fairEnvelope(ctx),
      `hawkes_z=${best.burst.z.toFixed(2)} recent=${best.burst.recent} ` +
      `expected=${best.burst.expected.toFixed(2)} resolver10=${resolverReturn.toFixed(2)}bp`, {
        mechanism_family: 'hawkes_trade_excitation',
        excitation_z: best.burst.z,
        recent_prints_3s: best.burst.recent,
        baseline_prints_27s: best.burst.baseline,
        recent_print_volume: best.burst.recentVolume,
      });
    if (!action) return [];
    boundedRemember(this._fired, marketId);
    return [action];
  }
}

function normalizeSource(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('chainlink')) return 'chainlink';
  if (text.includes('coinbase')) return 'coinbase';
  if (text.includes('hyper')) return 'hyperliquid';
  if (text.includes('binance')) return 'binance';
  return null;
}

function sourcePrices(ctx) {
  return {
    binance: finite(ctx.btc),
    coinbase: ctx.venueStale === false ? finite(ctx.venuePrice) : null,
    hyperliquid: ctx.hyperStale === false ? finite(ctx.hyperPrice) : null,
    chainlink: isFreshAge(ctx.rtdsChainlinkAgeMs, 3000) ? finite(ctx.rtdsChainlink) : null,
  };
}

function wilsonLower(successes, trials, z = 1.96) {
  if (!(trials > 0) || successes < 0 || successes > trials) return 0;
  const probability = successes / trials;
  const denominator = 1 + z * z / trials;
  const center = probability + z * z / (2 * trials);
  const radius = z * Math.sqrt(probability * (1 - probability) / trials
    + z * z / (4 * trials * trials));
  return (center - radius) / denominator;
}

/**
 * H57 — venue leadership is learned online from causal follow-through, not
 * assumed. A source cannot emit an order until its Wilson lower bound exceeds
 * chance after at least thirty completed lead episodes.
 */
class AdaptiveVenueLeaderResidual {
  constructor() {
    this.name = STRATEGY_NAMES[3];
    this.marketTypes = ['direction_5m'];
    this.cadence = 'event';
    this._last = new Map();
    this._pending = new Map();
    this._stats = new Map();
    this._fired = new Set();
  }

  onHalt() { return []; }

  _statKey(asset, source) { return `${asset}:${source}`; }

  _finish(asset, pending, success) {
    const key = this._statKey(asset, pending.source);
    const stats = this._stats.get(key) || { successes: 0, trials: 0 };
    stats.trials += 1;
    if (success) stats.successes += 1;
    this._stats.set(key, stats);
    this._pending.delete(asset);
    return stats;
  }

  evaluate(ctx, engine) {
    const asset = ctx.market?.asset;
    const marketId = ctx.market?.id;
    if (!DIRECTION_ASSETS.has(asset) || marketId == null) return [];
    const prices = sourcePrices(ctx);
    const previous = this._last.get(asset);
    this._last.set(asset, { at: ctx.now, prices });
    if (!previous || ctx.now - previous.at > 2500) return [];
    const triggerSource = normalizeSource(ctx.triggerEvent?.source);
    let pending = this._pending.get(asset);
    let confirmed = null;
    if (pending) {
      const moves = Object.entries(prices)
        .filter(([source, price]) => source !== pending.source && price > 0
          && pending.baselines[source] > 0)
        .map(([source, price]) => ({
          source,
          move: 10000 * Math.log(price / pending.baselines[source]),
        }));
      const confirmations = moves.filter((row) => pending.sign * row.move >= 1);
      if (confirmations.length >= 2 && ctx.now - pending.at <= 2000) {
        const stats = this._finish(asset, pending, true);
        confirmed = { pending, stats, confirmations };
        pending = null;
      } else if (ctx.now - pending.at > 3000) {
        this._finish(asset, pending, false);
        pending = null;
      }
    }
    if (!pending && !confirmed && triggerSource && prices[triggerSource] > 0
        && previous.prices[triggerSource] > 0) {
      const triggerMove = 10000 * Math.log(
        prices[triggerSource] / previous.prices[triggerSource],
      );
      const otherMoves = Object.entries(prices)
        .filter(([source, price]) => source !== triggerSource && price > 0
          && previous.prices[source] > 0)
        .map(([source, price]) => 10000 * Math.log(price / previous.prices[source]));
      if (Math.abs(triggerMove) >= 2
          && otherMoves.filter((move) => Math.sign(move) === Math.sign(triggerMove)
            && Math.abs(move) >= 0.75).length === 0) {
        this._pending.set(asset, {
          source: triggerSource,
          sign: Math.sign(triggerMove),
          at: ctx.now,
          triggerMove,
          baselines: prices,
        });
      }
    }
    if (!confirmed || this._fired.has(marketId) || !inBand(ctx.tteSec, 30, 240)) return [];
    const lower = wilsonLower(confirmed.stats.successes, confirmed.stats.trials);
    if (confirmed.stats.trials < 30 || lower <= 0.50) return [];
    const action = takerAction(ctx, engine, this.name, confirmed.pending.sign,
      fairEnvelope(ctx),
      `leader=${confirmed.pending.source} trials=${confirmed.stats.trials} ` +
      `success=${confirmed.stats.successes} wilson_lower=${lower.toFixed(3)}`, {
        mechanism_family: 'online_adaptive_venue_lead_lag',
        learned_leader: confirmed.pending.source,
        leader_trials: confirmed.stats.trials,
        leader_successes: confirmed.stats.successes,
        leader_wilson_lower_95: lower,
        confirmation_sources: confirmed.confirmations.map((row) => row.source),
      });
    if (!action) return [];
    boundedRemember(this._fired, marketId);
    return [action];
  }

  diagnostics() {
    return {
      minimumLeaderTrials: 30,
      requiredWilsonLower95: 0.50,
      stats: Object.fromEntries([...this._stats].map(([key, value]) => [
        key,
        { ...value, wilsonLower95: wilsonLower(value.successes, value.trials) },
      ])),
    };
  }
}

function isChainlinkResolved(ctx) {
  const source = String(ctx.market?.resolution_source || '');
  return /chainlink/i.test(source)
    || (ctx.market?.market_type === 'direction_5m' && source === 'polymarket_crypto_5m');
}

/** H58 — act on a fresh resolver event only while the CLOB quote predates it. */
class ResolverEventStaleQuote {
  constructor() {
    this.name = STRATEGY_NAMES[4];
    this.marketTypes = ['direction_5m', 'direction_15m'];
    this.cadence = 'event';
    this._fired = new Set();
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
    const marketId = ctx.market?.id;
    const triggerSource = normalizeSource(ctx.triggerEvent?.source);
    const receiveMs = finite(ctx.triggerEvent?.receiveWallMs);
    const latestBookAt = Math.max(finite(ctx.upBook?.at) || 0, finite(ctx.downBook?.at) || 0);
    const quoteAgeAtEvent = receiveMs == null ? null : receiveMs - latestBookAt;
    if (marketId == null || this._fired.has(marketId) || triggerSource !== 'chainlink'
        || !isChainlinkResolved(ctx) || !inBand(ctx.tteSec, 15, 180)
        || !isFreshAge(ctx.rtdsChainlinkAgeMs, 3000)
        || ctx.resolverRefSource !== 'chainlink_rtds_nearest_3s'
        || !(receiveMs > 0) || !inBand(quoteAgeAtEvent, 0, 3000)) return [];
    const chainlink = finite(ctx.rtdsChainlink);
    const ref = finite(ctx.resolverRef);
    const direct = finite(ctx.btc);
    const coinbase = ctx.venueStale === false ? finite(ctx.venuePrice) : null;
    if (!(chainlink > 0 && ref > 0 && direct > 0 && coinbase > 0)) return [];
    const sign = Math.sign(chainlink - ref);
    if (!sign || sign * (direct - ref) <= 0 || sign * (coinbase - ref) <= 0) return [];
    const envelope = fairEnvelope(ctx, {
      spots: [chainlink, direct, coinbase],
      refs: [ref],
      sigmas: volatilityCandidates(ctx),
    });
    const action = takerAction(ctx, engine, this.name, sign, envelope,
      `resolver_event quote_age_at_event=${quoteAgeAtEvent.toFixed(1)}ms ` +
      `resolver_distance=${(10000 * Math.log(chainlink / ref)).toFixed(2)}bp`, {
        mechanism_family: 'resolver_event_to_clob_transfer',
        resolver_event_receive_ms: receiveMs,
        latest_clob_book_at_ms: latestBookAt,
        quote_predates_resolver_ms: quoteAgeAtEvent,
      });
    if (!action) return [];
    boundedRemember(this._fired, marketId);
    return [action];
  }
}

/** H59 — slower arm: require three resolver observations on one side. */
class ResolverCrossPersistence {
  constructor() {
    this.name = STRATEGY_NAMES[5];
    this.marketTypes = ['direction_5m', 'direction_15m'];
    this.cadence = 'event';
    this._history = new Map();
    this._fired = new Set();
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
    const marketId = ctx.market?.id;
    if (marketId == null || !isChainlinkResolved(ctx)
        || normalizeSource(ctx.triggerEvent?.source) !== 'chainlink') return [];
    const price = finite(ctx.rtdsChainlink);
    const ref = finite(ctx.resolverRef);
    if (!(price > 0 && ref > 0) || !isFreshAge(ctx.rtdsChainlinkAgeMs, 3000)
        || ctx.resolverRefSource !== 'chainlink_rtds_nearest_3s') return [];
    const history = this._history.get(marketId) || [];
    const sourceMs = finite(ctx.triggerEvent?.sourceMs) || ctx.now;
    if (!history.length || history.at(-1).sourceMs !== sourceMs) {
      history.push({ at: ctx.now, sourceMs, price, sign: Math.sign(price - ref) });
    }
    while (history.length && history[0].at < ctx.now - 3000) history.shift();
    this._history.set(marketId, history);
    if (this._fired.has(marketId) || !inBand(ctx.tteSec, 15, 150)
        || history.length < 3 || history.at(-1).at - history.at(-3).at < 500) return [];
    const last = history.slice(-3);
    const sign = last[0].sign;
    if (!sign || !last.every((row) => row.sign === sign)) return [];
    const direct = finite(ctx.btc);
    const coinbase = ctx.venueStale === false ? finite(ctx.venuePrice) : null;
    if (!(direct > 0 && coinbase > 0)
        || sign * (direct - ref) <= 0 || sign * (coinbase - ref) <= 0) return [];
    const envelope = fairEnvelope(ctx, {
      spots: [price, direct, coinbase],
      refs: [ref],
      sigmas: volatilityCandidates(ctx),
    });
    const action = takerAction(ctx, engine, this.name, sign, envelope,
      `resolver_persistent ticks=3 span=${(last.at(-1).at - last[0].at)}ms`, {
        mechanism_family: 'resolver_cross_persistence',
        resolver_confirming_ticks: 3,
        resolver_confirmation_span_ms: last.at(-1).at - last[0].at,
      });
    if (!action) return [];
    boundedRemember(this._fired, marketId);
    return [action];
  }
}

function rememberSecond(store, key, now, price, horizonMs = 360000) {
  if (!(price > 0)) return [];
  const second = Math.floor(now / 1000);
  const rows = store.get(key) || [];
  if (rows.at(-1)?.second === second) rows.at(-1).price = price;
  else rows.push({ second, at: now, price });
  while (rows.length && rows[0].at < now - horizonMs) rows.shift();
  store.set(key, rows);
  if (store.size > 100) store.delete(store.keys().next().value);
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

function sigma5mFromReturns(returns, durationSec) {
  if (!returns.length || !(durationSec > 0)) return null;
  const variance = returns.reduce((sum, value) => sum + value * value, 0);
  return Math.sqrt(Math.max(1e-16, variance * 300 / durationSec));
}

function bipowerProfile(rows) {
  const returns = logReturns(rows);
  const durationSec = rows.length > 1 ? rows.at(-1).second - rows[0].second : 0;
  if (returns.length < 40 || durationSec < 40) return null;
  const rv = returns.reduce((sum, value) => sum + value * value, 0);
  let bpv = 0;
  for (let index = 1; index < returns.length; index += 1) {
    bpv += Math.abs(returns[index] * returns[index - 1]);
  }
  bpv = Math.min(rv, Math.PI / 2 * bpv);
  return {
    observations: returns.length,
    durationSec,
    rv,
    bpv,
    jumpVariance: Math.max(0, rv - bpv),
    jumpShare: rv > 0 ? Math.max(0, rv - bpv) / rv : 0,
    totalSigma5m: Math.sqrt(Math.max(1e-16, rv * 300 / durationSec)),
    continuousSigma5m: Math.sqrt(Math.max(1e-16, bpv * 300 / durationSec)),
  };
}

/** H60 — fair must survive both total and jump-robust bipower variance. */
class BipowerJumpEnvelope {
  constructor() {
    this.name = STRATEGY_NAMES[6];
    this.marketTypes = ['direction_5m'];
    this.cadence = 'sampled';
    this._prices = new Map();
    this._fired = new Set();
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
    const asset = ctx.market?.asset;
    const marketId = ctx.market?.id;
    const history = rememberSecond(this._prices, asset, ctx.now, finite(ctx.btc), 180000);
    const profile = bipowerProfile(history);
    if (!profile || marketId == null || this._fired.has(marketId)
        || !inBand(ctx.tteSec, 45, 210)
        || profile.totalSigma5m / profile.continuousSigma5m < 1.25) return [];
    const envelope = fairEnvelope(ctx, {
      spots: freshSpotCandidates(ctx),
      sigmas: [profile.continuousSigma5m, profile.totalSigma5m],
    });
    const action = bestBoundedAction(ctx, engine, this.name, envelope,
      `bpv_jump_share=${profile.jumpShare.toFixed(3)} ` +
      `continuous_sigma=${profile.continuousSigma5m.toFixed(6)} ` +
      `total_sigma=${profile.totalSigma5m.toFixed(6)}`, {
        mechanism_family: 'bipower_jump_robust_probability_envelope',
        ...profile,
      });
    if (!action) return [];
    boundedRemember(this._fired, marketId);
    return [action];
  }
}

function trailingRows(rows, now, horizonMs) {
  return rows.filter((row) => row.at >= now - horizonMs);
}

/** H61 — guard explicitly against short/long volatility regime breaks. */
class VolRegimeEnvelope {
  constructor() {
    this.name = STRATEGY_NAMES[7];
    this.marketTypes = ['direction_5m', 'direction_15m', 'direction_1h'];
    this.cadence = 'sampled';
    this._prices = new Map();
    this._fired = new Set();
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
    const asset = ctx.market?.asset;
    const marketId = ctx.market?.id;
    const rows = rememberSecond(this._prices, asset, ctx.now, finite(ctx.btc), 360000);
    const shortRows = trailingRows(rows, ctx.now, 30000);
    const longRows = trailingRows(rows, ctx.now, 180000);
    const shortReturns = logReturns(shortRows);
    const longReturns = logReturns(longRows);
    const shortSigma = sigma5mFromReturns(shortReturns,
      shortRows.length > 1 ? shortRows.at(-1).second - shortRows[0].second : 0);
    const longSigma = sigma5mFromReturns(longReturns,
      longRows.length > 1 ? longRows.at(-1).second - longRows[0].second : 0);
    if (marketId == null || this._fired.has(marketId)
        || !(shortSigma > 0 && longSigma > 0)
        || shortReturns.length < 20 || longReturns.length < 100
        || !inBand(ctx.tteSec, 45, ctx.market?.market_type === 'direction_1h' ? 1800 : 600)) return [];
    const ratio = Math.max(shortSigma, longSigma) / Math.min(shortSigma, longSigma);
    if (ratio < 1.50) return [];
    const envelope = fairEnvelope(ctx, {
      spots: freshSpotCandidates(ctx),
      sigmas: [shortSigma, longSigma, ...volatilityCandidates(ctx)],
    });
    const action = bestBoundedAction(ctx, engine, this.name, envelope,
      `vol_regime_ratio=${ratio.toFixed(3)} short30=${shortSigma.toFixed(6)} ` +
      `long180=${longSigma.toFixed(6)}`, {
        mechanism_family: 'multi_horizon_volatility_regime_envelope',
        short_sigma_5m_30s: shortSigma,
        long_sigma_5m_180s: longSigma,
        short_return_observations: shortReturns.length,
        long_return_observations: longReturns.length,
        volatility_regime_ratio: ratio,
      });
    if (!action) return [];
    boundedRemember(this._fired, marketId);
    return [action];
  }
}

function pavaIncreasing(values, weights) {
  const blocks = [];
  for (let index = 0; index < values.length; index += 1) {
    const weight = Math.max(1e-9, finite(weights[index]) || 1);
    blocks.push({
      start: index,
      end: index,
      weight,
      weighted: weight * values[index],
      mean: values[index],
    });
    while (blocks.length >= 2
        && blocks.at(-2).mean > blocks.at(-1).mean) {
      const right = blocks.pop();
      const left = blocks.pop();
      const merged = {
        start: left.start,
        end: right.end,
        weight: left.weight + right.weight,
        weighted: left.weighted + right.weighted,
      };
      merged.mean = merged.weighted / merged.weight;
      blocks.push(merged);
    }
  }
  const fitted = Array(values.length);
  for (const block of blocks) {
    for (let index = block.start; index <= block.end; index += 1) fitted[index] = block.mean;
  }
  return fitted;
}

function isotonicNonIncreasing(values, weights = values.map(() => 1)) {
  return pavaIncreasing(values.map((value) => -value), weights).map((value) => -value);
}

function eventSnapshot(ctx) {
  const probability = positiveProbability(ctx);
  const up = touch(ctx.upBook);
  const down = touch(ctx.downBook);
  if (ctx.market?.id == null || !Number.isFinite(probability) || !up || !down) return null;
  return {
    at: ctx.now,
    marketId: ctx.market.id,
    eventId: ctx.market.event_id,
    strike: finite(ctx.strike),
    lower: finite(ctx.lowerBound),
    upper: finite(ctx.upperBound),
    probability,
    modelFair: finite(ctx.modelFairPositive),
    weight: Math.max(1, up.bidSize + up.askSize + down.bidSize + down.askSize),
  };
}

function rememberEvent(store, ctx, maxAgeMs = 2500) {
  const row = eventSnapshot(ctx);
  if (!row?.eventId) return [];
  const event = store.get(row.eventId) || new Map();
  event.set(row.marketId, row);
  for (const [marketId, value] of event) {
    if (ctx.now - value.at > maxAgeMs) event.delete(marketId);
  }
  store.set(row.eventId, event);
  if (store.size > 200) store.delete(store.keys().next().value);
  return [...event.values()].filter((value) => ctx.now - value.at <= maxAgeMs);
}

/** H62 — project ordered threshold probabilities onto the monotone cone. */
class ThresholdIsotonicResidual {
  constructor() {
    this.name = STRATEGY_NAMES[8];
    this.marketTypes = ['threshold_daily'];
    this.cadence = 'sampled';
    this._events = new Map();
    this._fired = new Set();
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
    const rows = rememberEvent(this._events, ctx)
      .filter((row) => Number.isFinite(row.strike) && Number.isFinite(row.modelFair))
      .sort((left, right) => left.strike - right.strike);
    if (rows.length < 3 || this._fired.has(ctx.market?.id) || !inBand(ctx.tteSec, 60, 3600)) return [];
    const maximumViolation = Math.max(0, ...rows.slice(1)
      .map((row, index) => row.probability - rows[index].probability));
    if (maximumViolation < 0.03) return [];
    const fitted = isotonicNonIncreasing(
      rows.map((row) => row.probability),
      rows.map((row) => row.weight),
    );
    const index = rows.findIndex((row) => row.marketId === ctx.market?.id);
    if (index < 0) return [];
    const current = rows[index];
    const residual = fitted[index] - current.probability;
    const sign = Math.sign(residual);
    if (!sign || Math.abs(residual) < 0.03
        || sign * (current.modelFair - current.probability) <= 0) return [];
    const envelope = {
      lower: Math.min(fitted[index], current.modelFair),
      upper: Math.max(fitted[index], current.modelFair),
      midpoint: (fitted[index] + current.modelFair) / 2,
      spots: [],
      sigmas: [],
    };
    const action = takerAction(ctx, engine, this.name, sign, envelope,
      `isotonic strike=${current.strike} raw=${current.probability.toFixed(3)} ` +
      `projected=${fitted[index].toFixed(3)} max_violation=${maximumViolation.toFixed(3)}`, {
        mechanism_family: 'ordered_threshold_isotonic_projection',
        ladder_size: rows.length,
        maximum_monotonicity_violation: maximumViolation,
        isotonic_probability: fitted[index],
        raw_market_probability: current.probability,
        analytic_model_probability: current.modelFair,
        true_arbitrage: false,
      });
    if (!action) return [];
    boundedRemember(this._fired, current.marketId);
    return [action];
  }
}

function projectSimplex(values) {
  if (!values.length) return [];
  const sorted = [...values].sort((left, right) => right - left);
  let cumulative = 0;
  let rho = -1;
  for (let index = 0; index < sorted.length; index += 1) {
    cumulative += sorted[index];
    if (sorted[index] - (cumulative - 1) / (index + 1) > 0) rho = index;
  }
  if (rho < 0) return values.map(() => 1 / values.length);
  const theta = (sorted.slice(0, rho + 1).reduce((sum, value) => sum + value, 0) - 1)
    / (rho + 1);
  return values.map((value) => Math.max(0, value - theta));
}

function certifiedPartition(rows, tolerance = 1e-8) {
  if (rows.length < 3) return { valid: false, reason: 'TOO_FEW_BUCKETS' };
  const sorted = [...rows].sort((left, right) => {
    if (left.lower == null) return -1;
    if (right.lower == null) return 1;
    return left.lower - right.lower;
  });
  if (sorted[0].lower != null || sorted.at(-1).upper != null) {
    return { valid: false, reason: 'OPEN_TAIL_MISSING' };
  }
  for (let index = 0; index < sorted.length - 1; index += 1) {
    if (sorted[index].upper == null || sorted[index + 1].lower == null
        || Math.abs(sorted[index].upper - sorted[index + 1].lower) > tolerance) {
      return { valid: false, reason: 'GAP_OR_OVERLAP' };
    }
  }
  return { valid: true, rows: sorted, reason: null };
}

function certifiedDisjointRanges(rows, tolerance = 1e-8) {
  if (rows.length < 3) return { valid: false, reason: 'TOO_FEW_BUCKETS' };
  const sorted = [...rows].sort((left, right) => {
    if (left.lower == null) return -1;
    if (right.lower == null) return 1;
    return left.lower - right.lower;
  });
  for (let index = 0; index < sorted.length; index += 1) {
    const row = sorted[index];
    if (row.lower != null && row.upper != null && row.upper <= row.lower) {
      return { valid: false, reason: 'INVALID_RANGE' };
    }
    if (index > 0) {
      const previous = sorted[index - 1];
      if (previous.upper == null || row.lower == null
          || row.lower < previous.upper - tolerance) {
        return { valid: false, reason: 'OVERLAP_OR_OPEN_INTERIOR' };
      }
    }
  }
  return { valid: true, rows: sorted, reason: null };
}

/**
 * H63 — a disjoint range family has a sub-simplex constraint even when the
 * listed buckets are not exhaustive: their probabilities cannot sum above
 * one. Only the overpriced direction is tested, and the analytic range fair
 * must agree. This is risky residual trading, not a certified payoff lock.
 */
class RangeSimplexResidual {
  constructor() {
    this.name = STRATEGY_NAMES[9];
    this.marketTypes = ['range_daily'];
    this.cadence = 'sampled';
    this._events = new Map();
    this._fired = new Set();
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
    const remembered = rememberEvent(this._events, ctx)
      .filter((row) => Number.isFinite(row.modelFair));
    const proof = certifiedDisjointRanges(remembered);
    if (!proof.valid || this._fired.has(ctx.market?.id) || !inBand(ctx.tteSec, 60, 3600)) return [];
    const probabilitySum = proof.rows.reduce((sum, row) => sum + row.probability, 0);
    if (probabilitySum <= 1.03) return [];
    const projected = projectSimplex(proof.rows.map((row) => row.probability));
    const index = proof.rows.findIndex((row) => row.marketId === ctx.market?.id);
    if (index < 0) return [];
    const current = proof.rows[index];
    const residual = projected[index] - current.probability;
    const sign = Math.sign(residual);
    if (sign !== -1 || Math.abs(residual) < 0.03
        || sign * (current.modelFair - current.probability) <= 0) return [];
    const envelope = {
      lower: Math.min(projected[index], current.modelFair),
      upper: Math.max(projected[index], current.modelFair),
      midpoint: (projected[index] + current.modelFair) / 2,
      spots: [],
      sigmas: [],
    };
    const action = takerAction(ctx, engine, this.name, sign, envelope,
      `simplex buckets=${proof.rows.length} sum=${probabilitySum.toFixed(3)} ` +
      `raw=${current.probability.toFixed(3)} projected=${projected[index].toFixed(3)}`, {
        mechanism_family: 'disjoint_range_subsimplex_projection',
        ranges_disjoint_certified: true,
        partition_exhaustive: false,
        partition_buckets: proof.rows.length,
        raw_probability_sum: probabilitySum,
        simplex_probability: projected[index],
        raw_market_probability: current.probability,
        analytic_model_probability: current.modelFair,
        true_arbitrage: false,
      });
    if (!action) return [];
    boundedRemember(this._fired, current.marketId);
    return [action];
  }
}

function makeV7Strategies() {
  return [
    new DynamicOfiResolverConfirm(),
    new OfiGuardedPassiveMaker(),
    new HawkesExcitationContinuation(),
    new AdaptiveVenueLeaderResidual(),
    new ResolverEventStaleQuote(),
    new ResolverCrossPersistence(),
    new BipowerJumpEnvelope(),
    new VolRegimeEnvelope(),
    new ThresholdIsotonicResidual(),
    new RangeSimplexResidual(),
  ];
}

module.exports = makeV7Strategies;
module.exports._test = {
  AdaptiveVenueLeaderResidual,
  BipowerJumpEnvelope,
  DynamicOfiResolverConfirm,
  DynamicOfiTape,
  HawkesExcitationContinuation,
  OfiGuardedPassiveMaker,
  RangeSimplexResidual,
  ResolverCrossPersistence,
  ResolverEventStaleQuote,
  STRATEGY_NAMES,
  ThresholdIsotonicResidual,
  VolRegimeEnvelope,
  bipowerProfile,
  burstForToken,
  certifiedDisjointRanges,
  certifiedPartition,
  fairEnvelope,
  feePerShare,
  isotonicNonIncreasing,
  projectSimplex,
  topOfi,
  wilsonLower,
};
