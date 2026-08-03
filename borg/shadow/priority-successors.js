/**
 * Frozen successors for the two strongest unresolved discovery leads.
 *
 * Both strategies are paper-only BORG hypotheses. They have fresh identities,
 * inherit no discovery PnL and intentionally fail closed when their evidence
 * prerequisites are unavailable.
 */
'use strict';

const fs = require('fs');
const crypto = require('crypto');

const makeMainVideoParityStrategies = require('./main-video-parity');
const { usesChainlinkResolver } = require('../recon/markets');
const { TARGET_STAKE_USD } = require('../research/capital-policy');

const { MainVideoParity } = makeMainVideoParityStrategies._test;

const H43X_NAME = 'H43X_chainlink_tail_residual_v1';
const LONGSHOT_NAME = 'MAIN_LONGSHOT_0_20_V1';
const MODEL_VERSION = 'h43x-resolver-tail-v1';
const MODEL_CUTOFF = '2026-08-03T12:37:57.000Z';
const DEFAULT_MODEL_PATH = '/var/lib/deltaforge/models/h43x-resolver-tail-v1.json';
const MIN_MODEL_SAMPLES = 300;
const MODEL_QUANTILE = 0.995;
const TERMINAL_HORIZONS_SEC = Object.freeze([20, 45, 75]);
const CRYPTO_TAKER_RATE = 0.07;
const TOKEN_TICK = 0.01;
const DEPTH_PARTICIPATION = 0.20;

const finite = (value) => value !== null && value !== undefined && value !== '' &&
  Number.isFinite(Number(value));
const inBand = (value, min, max) => finite(value) && Number(value) >= min && Number(value) <= max;
const feePerShare = (price, multiplier = 1) =>
  CRYPTO_TAKER_RATE * price * (1 - price) * multiplier;

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function modelHash(model) {
  const canonical = { ...model };
  delete canonical.sha256;
  return crypto.createHash('sha256').update(stableStringify(canonical)).digest('hex');
}

function wilsonLower(successes, observations, z = 1.959963984540054) {
  const n = Number(observations);
  const k = Number(successes);
  if (!(n > 0) || !(k >= 0) || k > n) return null;
  const p = k / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const radius = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, (centre - radius) / denominator);
}

function horizonForTte(tteSec) {
  return TERMINAL_HORIZONS_SEC.find((horizon) => Number(tteSec) <= horizon) || null;
}

function validateTailModel(model) {
  const reasons = [];
  if (!model || typeof model !== 'object') reasons.push('MODEL_NOT_OBJECT');
  if (model?.version !== MODEL_VERSION) reasons.push('MODEL_VERSION_MISMATCH');
  if (Number(model?.quantile) !== MODEL_QUANTILE) reasons.push('MODEL_QUANTILE_MISMATCH');
  if (Number(model?.minimumSamples) !== MIN_MODEL_SAMPLES) reasons.push('MODEL_MINIMUM_MISMATCH');
  const trainedThroughMs = Date.parse(model?.trainedThrough);
  if (!Number.isFinite(trainedThroughMs)) reasons.push('MODEL_CUTOFF_MISSING');
  if (trainedThroughMs > Date.parse(MODEL_CUTOFF)) reasons.push('MODEL_USES_FORWARD_DATA');
  const computedHash = model && typeof model === 'object' ? modelHash(model) : null;
  if (model?.sha256 && model.sha256 !== computedHash) reasons.push('MODEL_HASH_MISMATCH');
  return { valid: reasons.length === 0, reasons, computedHash };
}

function loadTailModel(modelPath = process.env.BORG_H43X_TAIL_MODEL || DEFAULT_MODEL_PATH) {
  try {
    const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
    const validation = validateTailModel(model);
    return validation.valid
      ? { model, modelPath, hash: validation.computedHash, error: null }
      : { model: null, modelPath, hash: validation.computedHash,
        error: validation.reasons.join(',') };
  } catch (error) {
    return { model: null, modelPath, hash: null, error: error.message };
  }
}

function modelBucket(model, asset, horizonSec) {
  const key = String(horizonSec);
  const assetBucket = model?.buckets?.[String(asset || '').toLowerCase()]?.[key];
  const pooledBucket = model?.buckets?.pooled?.[key];
  const selected = Number(assetBucket?.n) >= MIN_MODEL_SAMPLES ? assetBucket
    : (Number(pooledBucket?.n) >= MIN_MODEL_SAMPLES ? pooledBucket : null);
  if (!selected) return null;
  const n = Number(selected.n);
  const successes = Number(selected.successes);
  const adverseMoveBps = Number(selected.adverseMoveBps);
  if (!(n >= MIN_MODEL_SAMPLES) || !(successes >= 0 && successes <= n) ||
      !(adverseMoveBps >= 0)) return null;
  const probabilityLower = wilsonLower(successes, n);
  if (!finite(probabilityLower)) return null;
  return {
    source: selected === assetBucket ? 'asset' : 'pooled',
    n,
    successes,
    adverseMoveBps,
    probabilityLower,
  };
}

function selectedQuote(ctx, sign) {
  const token = sign > 0 ? 'UP' : 'DOWN';
  const book = sign > 0 ? ctx.upBook : ctx.downBook;
  const bid = Number(book?.bids?.[0]?.[0]);
  const bidSize = Number(book?.bids?.[0]?.[1]);
  const ask = Number(book?.asks?.[0]?.[0]);
  const askSize = Number(book?.asks?.[0]?.[1]);
  return {
    token,
    book,
    bid,
    bidSize,
    ask,
    askSize,
    midpoint: inBand(bid, 0.01, 0.99) && inBand(ask, 0.01, 0.99) && ask >= bid
      ? (bid + ask) / 2 : null,
  };
}

class H43XChainlinkTailResidual {
  constructor(options = {}) {
    this.name = H43X_NAME;
    this.marketTypes = ['direction_5m'];
    this.cadence = 'event';
    this._fired = new Set();
    this._diagnostics = new Map();
    this._lastDiagnostic = null;
    const loaded = options.model
      ? (() => {
        const validation = validateTailModel(options.model);
        return validation.valid
          ? { model: options.model, modelPath: options.modelPath || 'injected',
            hash: validation.computedHash, error: null }
          : { model: null, modelPath: options.modelPath || 'injected',
            hash: validation.computedHash, error: validation.reasons.join(',') };
      })()
      : loadTailModel(options.modelPath);
    this.model = loaded.model;
    this.modelPath = loaded.modelPath;
    this.modelSha256 = loaded.hash;
    this.modelError = loaded.error;
  }

  onHalt(ctx) {
    return this._diagnostic('FEED_HALT', ctx || { now: Date.now(), market: null });
  }

  _diagnostic(reason, ctx, detail = {}) {
    this._diagnostics.set(reason, (this._diagnostics.get(reason) || 0) + 1);
    this._lastDiagnostic = {
      reason,
      at: new Date(ctx?.now || Date.now()).toISOString(),
      marketId: ctx?.market?.id ?? null,
      asset: ctx?.market?.asset ?? null,
      ...detail,
    };
    return [];
  }

  diagnostics() {
    return {
      paperOnly: true,
      provisional: true,
      frozenRule: 'h43x-chainlink-tail-residual-v1',
      modelPath: this.modelPath,
      modelSha256: this.modelSha256,
      modelCutoff: MODEL_CUTOFF,
      modelReady: Boolean(this.model),
      modelError: this.modelError,
      outcomes: Object.fromEntries(this._diagnostics),
      last: this._lastDiagnostic,
    };
  }

  _remember(marketId) {
    this._fired.add(marketId);
    if (this._fired.size > 5000) this._fired.delete(this._fired.values().next().value);
  }

  evaluate(ctx, engine) {
    const marketId = ctx.market?.id;
    if (marketId == null || this._fired.has(marketId)) {
      return this._diagnostic('ALREADY_FIRED_OR_MISSING_MARKET', ctx);
    }
    if (!this.model) return this._diagnostic('FROZEN_MODEL_UNAVAILABLE', ctx, {
      modelError: this.modelError,
    });
    if (!usesChainlinkResolver(ctx.market) ||
        ctx.resolverRefSource !== 'chainlink_rtds_nearest_3s') {
      return this._diagnostic('UNTRUSTED_RESOLVER_IDENTITY', ctx, {
        resolutionSource: ctx.market?.resolution_source ?? null,
        resolverRefSource: ctx.resolverRefSource ?? null,
      });
    }
    if (!inBand(ctx.tteSec, 20, 75)) return this._diagnostic('TTE_OUTSIDE_FROZEN_WINDOW', ctx);
    if (!(Number(ctx.resolverRef) > 0) || !(Number(ctx.rtdsChainlink) > 0) ||
        !inBand(ctx.rtdsChainlinkAgeMs, 0, 3000)) {
      return this._diagnostic('CHAINLINK_TICK_MISSING_OR_STALE', ctx, {
        tickAgeMs: finite(ctx.rtdsChainlinkAgeMs) ? Number(ctx.rtdsChainlinkAgeMs) : null,
      });
    }
    const horizonSec = horizonForTte(ctx.tteSec);
    const bucket = modelBucket(this.model, ctx.market?.asset, horizonSec);
    if (!bucket) return this._diagnostic('INSUFFICIENT_FROZEN_TAIL_SAMPLE', ctx, { horizonSec });

    const signedMarginBps = 10000 * Math.log(Number(ctx.rtdsChainlink) / Number(ctx.resolverRef));
    const sign = Math.sign(signedMarginBps);
    const marginBps = Math.abs(signedMarginBps);
    if (!sign || !(marginBps > bucket.adverseMoveBps)) {
      return this._diagnostic('INSIDE_EMPIRICAL_TERMINAL_TAIL', ctx, {
        marginBps,
        adverseMoveBps: bucket.adverseMoveBps,
        horizonSec,
      });
    }

    const quote = selectedQuote(ctx, sign);
    if (!(quote.askSize > 0) || !inBand(quote.ask, 0.01, 0.99) ||
        !inBand(quote.midpoint, 0.01, 0.99)) {
      return this._diagnostic('EXECUTABLE_BOOK_UNAVAILABLE', ctx);
    }
    const fairLower = Math.max(quote.midpoint, bucket.probabilityLower);
    const feeStress = feePerShare(quote.ask, 2);
    const edgeLower = fairLower - quote.ask - feeStress - TOKEN_TICK;
    if (!(edgeLower > 0)) return this._diagnostic('LOWER_BOUND_NOT_EXECUTABLE', ctx, {
      fairLower,
      executableAsk: quote.ask,
      feeStress,
      tickStress: TOKEN_TICK,
      edgeLower,
    });

    const shares = Math.min(TARGET_STAKE_USD / quote.ask,
      quote.askSize * DEPTH_PARTICIPATION);
    if (!(shares > 0) || shares * quote.ask < 1) {
      return this._diagnostic('INSUFFICIENT_DISPLAYED_CAPACITY', ctx, {
        askSize: quote.askSize,
        intendedNotionalUsd: shares * quote.ask,
      });
    }

    this._remember(marketId);
    this._diagnostic('ORDER_INTENT', ctx, { edgeLower, marginBps, horizonSec });
    return [{
      action: 'place',
      side: 'BUY',
      token: quote.token,
      price: quote.ask,
      size: shares,
      kind: 'taker',
      coid: engine._coid(this.name),
      queueAhead: quote.askSize,
      executionModel: 'event_order_250ms',
      thesisVersion: 'h43x-chainlink-tail-residual-v1',
      features: {
        mechanism_family: 'resolver_boundary_empirical_tail',
        paper_only: true,
        provisional: true,
        hold_to_resolution: true,
        resolver_identity_certified: true,
        resolver_reference_source: ctx.resolverRefSource,
        resolver_reference_price: Number(ctx.resolverRef),
        chainlink_price_at_intent: Number(ctx.rtdsChainlink),
        chainlink_tick_age_ms: Number(ctx.rtdsChainlinkAgeMs),
        resolver_margin_signed_bps: signedMarginBps,
        resolver_margin_abs_bps: marginBps,
        empirical_horizon_sec: horizonSec,
        empirical_tail_quantile: MODEL_QUANTILE,
        empirical_tail_bps: bucket.adverseMoveBps,
        empirical_probability_lower: bucket.probabilityLower,
        empirical_observations: bucket.n,
        empirical_successes: bucket.successes,
        empirical_bucket_source: bucket.source,
        model_cutoff: MODEL_CUTOFF,
        model_trained_through: this.model.trainedThrough,
        model_sha256: this.modelSha256,
        market_quote_prior: quote.midpoint,
        fair_lower_selected: fairLower,
        executable_ask: quote.ask,
        fee_stress_multiplier: 2,
        fee_stress_per_share: feeStress,
        token_tick_stress: TOKEN_TICK,
        edge_lower_after_2x_fees_and_tick: edgeLower,
        displayed_touch_shares: quote.askSize,
        touch_participation: shares / quote.askSize,
        intended_notional_usd: shares * quote.ask,
        counterfactual_latency_profiles_ms: [100, 250, 500],
      },
      note: `chainlink_tail ${quote.token} margin=${marginBps.toFixed(2)}bp ` +
        `q995=${bucket.adverseMoveBps.toFixed(2)}bp lower=${fairLower.toFixed(4)} ` +
        `ask=${quote.ask.toFixed(4)} edge=${edgeLower.toFixed(4)} n=${bucket.n}`,
    }];
  }
}

class MainLongshotSuccessor {
  constructor(options = {}) {
    this.name = LONGSHOT_NAME;
    this.marketTypes = ['direction_5m'];
    this.cadence = 'sampled';
    this.source = options.source || new MainVideoParity({ executionArm: 'taker250' });
    this._filtered = 0;
    this._retained = 0;
  }

  onHalt(ctx, engine) {
    return this.source.onHalt(ctx, engine);
  }

  diagnostics() {
    return {
      ...(typeof this.source.diagnostics === 'function' ? this.source.diagnostics() : {}),
      paperOnly: true,
      provisional: true,
      frozenRule: 'main-longshot-0-20-v1',
      sourceStrategy: 'MAIN_VIDEO_PARITY_V1__taker250',
      exactPosthocFilter: 'first source intent executable price <= 0.20',
      discoveryRowsReused: false,
      filteredSourceIntents: this._filtered,
      retainedSourceIntents: this._retained,
    };
  }

  evaluate(ctx, engine) {
    const actions = this.source.evaluate(ctx, engine);
    if (!actions.length) return [];
    const retained = [];
    for (const action of actions) {
      const price = Number(action.price);
      if (!(price >= 0.01 && price <= 0.20)) {
        this._filtered += 1;
        continue;
      }
      this._retained += 1;
      retained.push({
        ...action,
        coid: engine._coid(this.name),
        thesisVersion: 'main-longshot-0-20-v1',
        features: {
          ...(action.features || {}),
          mechanism_family: 'main_video_exact_longshot_successor',
          paper_only: true,
          provisional: true,
          source_strategy: 'MAIN_VIDEO_PARITY_V1__taker250',
          source_rule_unchanged: true,
          posthoc_selection_disclosed: true,
          exact_price_filter_max: 0.20,
          discovery_rows_reused: false,
          counterfactual_latency_profiles_ms: [100, 250, 500],
        },
        note: `longshot_successor price<=0.20 ${action.note || ''}`.trim(),
      });
    }
    return retained;
  }
}

function makePrioritySuccessors() {
  return [new H43XChainlinkTailResidual(), new MainLongshotSuccessor()];
}

module.exports = makePrioritySuccessors;
module.exports._test = {
  CRYPTO_TAKER_RATE,
  DEFAULT_MODEL_PATH,
  H43XChainlinkTailResidual,
  H43X_NAME,
  LONGSHOT_NAME,
  MainLongshotSuccessor,
  MIN_MODEL_SAMPLES,
  MODEL_CUTOFF,
  MODEL_QUANTILE,
  MODEL_VERSION,
  TERMINAL_HORIZONS_SEC,
  feePerShare,
  horizonForTte,
  loadTailModel,
  modelBucket,
  modelHash,
  validateTailModel,
  wilsonLower,
};
