/**
 * MAIN video-parity challenger.
 *
 * This is a forward-only reconstruction of the signal settings visible in the
 * 23 July 2026 DeltaForge promotional video and in the untouched purchased
 * archive. It deliberately lives in BORG's keyless shadow plane:
 *
 *   - no signer, wallet, authenticated client, or live-order call exists;
 *   - executable CLOB prices replace Gamma/midpoint fills;
 *   - current crypto taker fees, one tick of stress, displayed depth, and
 *     quote-survival are charged by construction;
 *   - the advertised immediate/taker behaviour and a post-only reinterpretation
 *     are separate arms, never pooled.
 *
 * The raw model is intentionally preserved, including its questionable
 * quote-relative heuristic. That makes this a falsification experiment, not a
 * recommendation or a tuned replacement for MAIN.
 */
'use strict';

const { TARGET_STAKE_USD } = require('../research/capital-policy');

const TAKER_NAME = 'MAIN_VIDEO_PARITY_V1__taker250';
const MAKER_NAME = 'MAIN_VIDEO_PARITY_V1__postonly';
const THESIS_VERSION = 'main-video-parity-v1';
const CRYPTO_TAKER_RATE = 0.07;
const TOKEN_TICK = 0.01;

const CONFIG = Object.freeze({
  asset: 'btc',
  cadenceMs: 5000,
  minTteSec: 45,
  maxTteSec: 300,
  minFlatDeltaPct: 0.015,
  strongDeltaPct: 0.05,
  neutralBand: 0.03,
  gammaChopOverride: 0.045,
  gate1Threshold: 0.45,
  gate2Floor: 0.02,
  maxSpread: 0.03,
  minDepthUsd: 100,
  fillProbabilityFloor: 0.25,
  minConfidence: 0.15,
  phiWeight: 0.60,
  maxTouchParticipation: 0.20,
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value) =>
  value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const roundTick = (value) => Math.round(value * 100) / 100;
const inBand = (value, min, max) => finite(value) && Number(value) >= min && Number(value) <= max;
const feePerShare = (price, multiplier = 1) =>
  CRYPTO_TAKER_RATE * price * (1 - price) * multiplier;

function sumLevels(levels) {
  return (levels || []).reduce((acc, level) => {
    const price = Number(level?.[0]);
    const size = Number(level?.[1]);
    if (!(price > 0) || !(size > 0)) return acc;
    acc.size += size;
    acc.usd += price * size;
    acc.largest = Math.max(acc.largest, size);
    acc.count += 1;
    return acc;
  }, { size: 0, usd: 0, largest: 0, count: 0 });
}

function ensemble(pPhi, pHeuristic, phiWeight = CONFIG.phiWeight) {
  const hasPhi = finite(pPhi);
  const hasHeuristic = finite(pHeuristic);
  if (!hasPhi && !hasHeuristic) {
    return { probability: 0.5, agreement: 'NONE', confidenceMultiplier: 0.7 };
  }
  if (!hasPhi) {
    return {
      probability: clamp(Number(pHeuristic), 0.01, 0.99),
      agreement: 'HEUR_ONLY',
      confidenceMultiplier: 0.9,
    };
  }
  if (!hasHeuristic) {
    return {
      probability: clamp(Number(pPhi), 0.01, 0.99),
      agreement: 'PHI_ONLY',
      confidenceMultiplier: 1,
    };
  }

  const phi = Number(pPhi);
  const heuristic = Number(pHeuristic);
  const phiNeutral = inBand(phi, 0.45, 0.55);
  const heuristicNeutral = inBand(heuristic, 0.45, 0.55);
  let agreement = 'WEAK_DISAGREE';
  let confidenceMultiplier = 0.85;
  if (phiNeutral || heuristicNeutral) {
    agreement = 'NEUTRAL';
    confidenceMultiplier = 1;
  } else if ((phi - 0.5) * (heuristic - 0.5) > 0) {
    agreement = 'AGREE';
    confidenceMultiplier = 1.10;
  } else if (Math.abs(phi - heuristic) >= 0.10) {
    agreement = 'DISAGREE';
    confidenceMultiplier = 0.70;
  }
  return {
    probability: clamp(phiWeight * phi + (1 - phiWeight) * heuristic, 0.01, 0.99),
    agreement,
    confidenceMultiplier,
  };
}

function scenarioFromHistory(history, btcDeltaPct) {
  if (history.length < 10) return { type: 'NORMAL', noTrade: false };
  const recent = history.slice(-30);
  const prices = recent.map((row) => row.btc).filter((price) => price > 0);
  if (prices.length < 10) return { type: 'NORMAL', noTrade: false };
  const latest = prices.at(-1);
  const mean = prices.reduce((sum, price) => sum + price, 0) / prices.length;
  const variance = prices.reduce((sum, price) => sum + (price - mean) ** 2, 0) / prices.length;
  const relativeStdDev = Math.sqrt(variance) / mean;
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  const range = (high - low) / mean;
  const open = prices[0];
  const body = Math.abs(latest - open) / mean;
  const upperWick = high > Math.max(latest, open) ? (high - Math.max(latest, open)) / mean : 0;
  const lowerWick = low < Math.min(latest, open) ? (Math.min(latest, open) - low) / mean : 0;
  const wickRatio = body > 0 ? Math.max(upperWick, lowerWick) / (body + 0.0001) : 0;
  const half = Math.floor(prices.length / 2);
  const firstHalfDelta = 100 * (prices[half] - prices[0]) / prices[0];
  const secondHalfDelta = 100 * (latest - prices[half]) / prices[half];
  const fading = Math.abs(secondHalfDelta) < Math.abs(firstHalfDelta) * 0.5;
  const absoluteDelta = Math.abs(btcDeltaPct);

  if (absoluteDelta > 0.15 && (wickRatio > 1.5 || relativeStdDev > 0.0015)) {
    return { type: 'NEWS_SPIKE', noTrade: true };
  }
  if (range < 0.0002 && absoluteDelta < 0.008) {
    return { type: 'RANGE_CHOP', noTrade: true };
  }
  const reversing = (btcDeltaPct > 0 && secondHalfDelta < -0.01) ||
    (btcDeltaPct < 0 && secondHalfDelta > 0.01);
  if (reversing && wickRatio > 1.2 && absoluteDelta > 0.04) {
    return { type: 'FAKE_BREAKOUT', noTrade: false };
  }
  if (absoluteDelta > 0.05 && !fading && wickRatio < 0.8) {
    return { type: 'LAG_EDGE', noTrade: false };
  }
  if (absoluteDelta > 0.03 && wickRatio < 0.6 && !fading) {
    return { type: 'MOMENTUM_BREAKOUT', noTrade: false };
  }
  const prior = history.slice(-60, -30).map((row) => row.btc).filter((price) => price > 0);
  const priorRange = prior.length >= 10
    ? (Math.max(...prior) - Math.min(...prior)) / prior[0]
    : range;
  if (range > priorRange * 2 && absoluteDelta > 0.02) {
    return { type: 'VOLATILITY_EXPANSION', noTrade: false };
  }
  if (fading && absoluteDelta > 0.02) return { type: 'MOMENTUM_FADE', noTrade: false };
  if (absoluteDelta > 0.08 && wickRatio > 0.9) {
    return { type: 'MEAN_REVERSION', noTrade: false };
  }
  return { type: 'NORMAL', noTrade: false };
}

function microstructure(ctx, yesHistory) {
  const bids = sumLevels(ctx.upBook?.bids);
  const asks = sumLevels(ctx.upBook?.asks);
  const totalSize = bids.size + asks.size;
  const imbalance = totalSize > 0 ? (bids.size - asks.size) / totalSize : 0;
  const averageOrderSize = bids.count + asks.count > 0
    ? totalSize / (bids.count + asks.count)
    : 20;
  const whaleThreshold = averageOrderSize > 0 ? averageOrderSize * 5 : 100;
  const whaleSignal = Number(bids.largest > whaleThreshold) - Number(asks.largest > whaleThreshold);
  const depthUsd = bids.usd + asks.usd;
  const depthScore = Math.min(depthUsd / 10000, 1);

  const cutoff = ctx.now - 30000;
  const prior = [...yesHistory].reverse().find((row) => row.at <= cutoff) || yesHistory[0];
  const btcDelta = finite(ctx.micro30?.returnBps) ? Number(ctx.micro30.returnBps) / 10000 : 0;
  const yesPrice = Number(ctx.upMid);
  const polyDelta = prior && prior.yes > 0 && finite(yesPrice)
    ? (yesPrice - prior.yes) / prior.yes
    : 0;
  const latencyScore = Math.abs(btcDelta) > 0.001
    ? Math.min(1, Math.abs(btcDelta - polyDelta) / Math.max(Math.abs(btcDelta), 0.001))
    : 0;
  const confidence = clamp(
    Math.abs(imbalance) * 0.25 +
      Math.abs(whaleSignal) * 0.20 +
      depthScore * 0.20 +
      latencyScore * 0.35,
    0,
    1,
  );
  return {
    confidence,
    imbalance,
    whaleSignal,
    depthScore,
    latencyScore,
    depthUsd,
    hasMarketLag: latencyScore > 0.3,
  };
}

function selectedBook(ctx, token) {
  const book = token === 'UP' ? ctx.upBook : ctx.downBook;
  const bid = Number(book?.bids?.[0]?.[0]);
  const bidSize = Number(book?.bids?.[0]?.[1]);
  const ask = Number(book?.asks?.[0]?.[0]);
  const askSize = Number(book?.asks?.[0]?.[1]);
  const depth = sumLevels([...(book?.bids || []), ...(book?.asks || [])]);
  return { book, bid, bidSize, ask, askSize, spread: ask - bid, depthUsd: depth.usd };
}

class MainVideoParity {
  constructor({ executionArm }) {
    this.executionArm = executionArm;
    this.name = executionArm === 'postonly' ? MAKER_NAME : TAKER_NAME;
    this.marketTypes = ['direction_5m'];
    this.cadence = 'sampled';
    this._fired = new Set();
    this._lastDecisionAt = new Map();
    this._btcHistory = [];
    this._yesHistory = new Map();
    this._diagnostics = new Map();
  }

  onHalt() {
    this._diagnostic('FEED_HALT');
    return [];
  }

  diagnostics() {
    return {
      paperOnly: true,
      source: 'DeltaForge promotional-video reconstruction',
      executionArm: this.executionArm,
      provisional: true,
      outcomes: Object.fromEntries(this._diagnostics),
    };
  }

  _diagnostic(reason) {
    this._diagnostics.set(reason, (this._diagnostics.get(reason) || 0) + 1);
  }

  _skip(reason) {
    this._diagnostic(reason);
    return [];
  }

  _remember(ctx, yesPrice) {
    if (ctx.btc > 0) {
      this._btcHistory.push({ at: ctx.now, btc: Number(ctx.btc) });
      const cutoff = ctx.now - 180000;
      while (this._btcHistory.length && this._btcHistory[0].at < cutoff) this._btcHistory.shift();
    }
    const id = String(ctx.market?.id ?? 'unknown');
    const history = this._yesHistory.get(id) || [];
    if (finite(yesPrice)) history.push({ at: ctx.now, yes: Number(yesPrice) });
    const cutoff = ctx.now - 60000;
    while (history.length && history[0].at < cutoff) history.shift();
    this._yesHistory.set(id, history);
    if (this._yesHistory.size > 1000) this._yesHistory.delete(this._yesHistory.keys().next().value);
    return history;
  }

  evaluate(ctx, engine) {
    const marketId = ctx.market?.id;
    if (marketId == null || ctx.market?.asset !== CONFIG.asset) return this._skip('WRONG_UNIVERSE');
    const yesPrice = finite(ctx.upMid) ? Number(ctx.upMid) : Number(ctx.gammaUp);
    const yesHistory = this._remember(ctx, yesPrice);
    if (this._fired.has(marketId)) return this._skip('ALREADY_TRADED_MARKET');
    if (!inBand(ctx.tteSec, CONFIG.minTteSec, CONFIG.maxTteSec)) return this._skip('TTE_GUARD');
    if (!finite(yesPrice) || !finite(ctx.phiFair) || !(ctx.btc > 0) || !(ctx.ref > 0)) {
      return this._skip('MODEL_INPUT_MISSING');
    }

    const lastDecisionAt = this._lastDecisionAt.get(marketId) || 0;
    if (ctx.now - lastDecisionAt < CONFIG.cadenceMs) return this._skip('FIVE_SECOND_CADENCE');
    this._lastDecisionAt.set(marketId, ctx.now);

    const btcDeltaPct = finite(ctx.micro60?.returnBps)
      ? Number(ctx.micro60.returnBps) / 100
      : (finite(ctx.micro30?.returnBps) ? Number(ctx.micro30.returnBps) / 100 : 0);
    const gammaDisplacement = yesPrice - 0.5;
    const scenario = scenarioFromHistory(this._btcHistory, btcDeltaPct);
    const gammaOverridesChop = scenario.type === 'RANGE_CHOP' &&
      Math.abs(gammaDisplacement) >= CONFIG.gammaChopOverride;
    if (scenario.noTrade && !gammaOverridesChop) return this._skip(`SCENARIO_${scenario.type}`);
    if (Math.abs(btcDeltaPct) < CONFIG.minFlatDeltaPct && Math.abs(gammaDisplacement) <= 0.02) {
      return this._skip('BTC_FLAT');
    }
    if (Math.abs(gammaDisplacement) < CONFIG.neutralBand &&
        Math.abs(btcDeltaPct) < CONFIG.strongDeltaPct) {
      return this._skip('NEUTRAL_COIN_FLIP');
    }

    const micro = microstructure(ctx, yesHistory);
    const btcEdge = Math.min(Math.abs(btcDeltaPct) * 0.5, 0.15);
    const microEdge = micro.confidence * 0.10;
    const totalHeuristicEdge = btcEdge + microEdge;
    const bullish = btcDeltaPct > 0.02;
    const bearish = btcDeltaPct < -0.02;
    const gammaBullish = !bullish && !bearish && gammaDisplacement > 0.02;
    const gammaBearish = !bullish && !bearish && gammaDisplacement < -0.02;
    let pHeuristic = yesPrice;
    if (bullish || gammaBullish) pHeuristic = clamp(yesPrice + totalHeuristicEdge, 0.01, 0.99);
    else if (bearish || gammaBearish) pHeuristic = clamp(yesPrice - totalHeuristicEdge, 0.01, 0.99);

    const blended = ensemble(ctx.phiFair, pHeuristic);
    const candidates = [
      { token: 'UP', probability: blended.probability },
      { token: 'DOWN', probability: 1 - blended.probability },
    ].map((candidate) => {
      const quote = selectedBook(ctx, candidate.token);
      const stressedEdge = inBand(quote.ask, 0.01, 0.99)
        ? candidate.probability - quote.ask - feePerShare(quote.ask, 2) - TOKEN_TICK
        : -Infinity;
      return { ...candidate, ...quote, stressedEdge };
    }).filter((candidate) =>
      candidate.askSize > 0 &&
      candidate.bid >= 0.01 &&
      candidate.ask <= 0.99 &&
      candidate.spread >= 0 &&
      candidate.spread <= CONFIG.maxSpread &&
      candidate.depthUsd >= CONFIG.minDepthUsd)
      .sort((left, right) => right.stressedEdge - left.stressedEdge);
    if (!candidates.length) return this._skip('EXECUTABLE_BOOK_FILTER');

    const selected = candidates[0];
    let effectiveFloor = CONFIG.gate2Floor;
    if (scenario.type === 'LAG_EDGE') effectiveFloor *= 0.65;
    else if (scenario.type === 'MOMENTUM_BREAKOUT') effectiveFloor *= 0.80;
    else if (scenario.type === 'VOLATILITY_EXPANSION') effectiveFloor *= 0.90;
    else if (scenario.type === 'FAKE_BREAKOUT') effectiveFloor *= 1.50;
    if (micro.hasMarketLag && ctx.tteSec > 240) effectiveFloor *= 0.8;
    if (selected.stressedEdge < effectiveFloor) return this._skip('GATE2_STRESSED_EV');

    const spreadPenalty = Math.max(0, 1 - selected.spread * 5);
    const fillProbability = Math.min(1, (selected.depthUsd / 500) * spreadPenalty);
    if (fillProbability < CONFIG.fillProbabilityFloor) return this._skip('FILL_PROBABILITY');

    const btcSignalWeak = Math.abs(btcDeltaPct) < CONFIG.strongDeltaPct;
    if (!btcSignalWeak) {
      if (selected.token === 'UP' && btcDeltaPct < 0) return this._skip('GATE3_DIRECTION');
      if (selected.token === 'DOWN' && btcDeltaPct > 0) return this._skip('GATE3_DIRECTION');
    }

    const momentumScore = Math.min(Math.abs(btcDeltaPct) / 0.10, 1);
    const evScore = Math.min(Math.max(0, selected.stressedEdge * 100) / 15, 1);
    const convictionScore = Math.abs(blended.probability - 0.5) * 2;
    const timeScore = Math.min(ctx.tteSec / 240, 1);
    let confidence =
      momentumScore * 0.45 +
      evScore * 0.30 +
      convictionScore * 0.15 +
      timeScore * 0.05 +
      micro.confidence * 0.05;
    if (scenario.type === 'LAG_EDGE') confidence = Math.min(1, confidence * 1.20);
    if (scenario.type === 'MOMENTUM_BREAKOUT') confidence = Math.min(1, confidence * 1.10);
    if (scenario.type === 'FAKE_BREAKOUT') confidence *= 0.70;
    if (scenario.type === 'MEAN_REVERSION') confidence *= 0.85;
    confidence = clamp(confidence * blended.confidenceMultiplier, 0, 1);
    if (confidence < CONFIG.minConfidence) return this._skip('CONFIDENCE');

    let kind;
    let executionModel;
    let orderPrice;
    let queueAhead;
    let shares;
    if (this.executionArm === 'postonly') {
      kind = 'maker';
      executionModel = 'maker_queue_v1';
      orderPrice = roundTick(Math.min(selected.ask - TOKEN_TICK, selected.bid + TOKEN_TICK));
      if (!(orderPrice >= 0.01 && orderPrice < selected.ask)) return this._skip('NO_POSTONLY_PRICE');
      queueAhead = Math.abs(orderPrice - selected.bid) < 1e-9 ? selected.bidSize : 0;
      shares = TARGET_STAKE_USD / orderPrice;
    } else {
      kind = 'taker';
      executionModel = 'event_order_250ms';
      orderPrice = selected.ask;
      queueAhead = selected.askSize;
      shares = Math.min(
        TARGET_STAKE_USD / orderPrice,
        selected.askSize * CONFIG.maxTouchParticipation,
      );
    }
    if (!(shares > 0) || shares * orderPrice < 1) return this._skip('DUST_CAPACITY');

    this._fired.add(marketId);
    this._diagnostic('ORDER_INTENT');
    return [{
      action: 'place',
      side: 'BUY',
      token: selected.token,
      price: orderPrice,
      size: shares,
      kind,
      coid: engine._coid(this.name),
      queueAhead,
      executionModel,
      thesisVersion: THESIS_VERSION,
      features: {
        mechanism_family: 'purchased_main_video_falsification',
        paper_only: true,
        provisional: true,
        hold_to_resolution: true,
        video_parity: true,
        execution_arm: this.executionArm,
        model_probability: blended.probability,
        p_phi: Number(ctx.phiFair),
        p_heuristic: pHeuristic,
        ensemble_agreement: blended.agreement,
        ensemble_confidence_multiplier: blended.confidenceMultiplier,
        btc_delta_pct_60s: btcDeltaPct,
        btc_edge: btcEdge,
        micro_edge: microEdge,
        micro_confidence: micro.confidence,
        micro_imbalance: micro.imbalance,
        micro_latency_score: micro.latencyScore,
        gate1_threshold: CONFIG.gate1Threshold,
        gate1_informational_pass: micro.confidence >= CONFIG.gate1Threshold,
        gate2_floor: effectiveFloor,
        edge_after_2x_fees_and_tick: selected.stressedEdge,
        gate3_min_delta_pct: CONFIG.strongDeltaPct,
        gate3_weak_signal_bypass: btcSignalWeak,
        signal_confidence: confidence,
        scenario: scenario.type,
        executable_ask: selected.ask,
        executable_bid: selected.bid,
        executable_spread: selected.spread,
        displayed_depth_usd: selected.depthUsd,
        fill_probability_proxy: fillProbability,
        intended_notional_usd: shares * orderPrice,
        touch_participation: kind === 'taker' ? shares / selected.askSize : null,
        dynamic_fee_rate: CRYPTO_TAKER_RATE,
        fee_stress_multiplier: kind === 'taker' ? 2 : 0,
        token_tick_stress: TOKEN_TICK,
      },
      note: `video_parity_${this.executionArm} ${selected.token} ` +
        `p=${blended.probability.toFixed(3)} ask=${selected.ask.toFixed(3)} ` +
        `edge2x_tick=${selected.stressedEdge.toFixed(3)} conf=${confidence.toFixed(3)} ` +
        `btc60=${btcDeltaPct.toFixed(3)}% scenario=${scenario.type}`,
    }];
  }
}

function makeMainVideoParityStrategies() {
  return [
    new MainVideoParity({ executionArm: 'taker250' }),
    new MainVideoParity({ executionArm: 'postonly' }),
  ];
}

module.exports = makeMainVideoParityStrategies;
module.exports._test = {
  CONFIG,
  MAKER_NAME,
  MainVideoParity,
  TAKER_NAME,
  ensemble,
  feePerShare,
  microstructure,
  scenarioFromHistory,
};
