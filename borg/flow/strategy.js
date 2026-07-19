'use strict';

const { TARGET_STAKE_USD } = require('../research/capital-policy');

const STRATEGY_VERSION = 'public-flow-scalp-v1';
const CHALLENGER_STRATEGY_VERSION = 'public-flow-cost-confirmed-v3';
const CHALLENGER_EXPERIMENT_ID = 'public-flow-cost-confirmed-v3';
const FEE_MODEL_VERSION = 'polymarket-token-fee-endpoint-v1';
const LATENCY_PROFILES_MS = Object.freeze([25, 100, 250, 500, 1000, 2000]);
const CHALLENGER_LATENCY_PROFILES_MS = Object.freeze([100, 250, 500]);
const MARKOUT_HORIZONS_MS = Object.freeze([1000, 2000, 5000, 10000]);
const MAX_TOUCH_PARTICIPATION = 0.20;
const TOKEN_TICK = 0.01;

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function marketMinimumOrderSize(market) {
  return Math.max(0, finite(market?.minimumOrderSize)
    ?? finite(market?.raw?.minimum_order_size)
    ?? finite(market?.raw?.min_order_size)
    ?? 0);
}

function takerFee(shares, price, feeRate) {
  const q = finite(shares);
  const p = finite(price);
  const r = finite(feeRate);
  if (q == null || p == null || r == null || q <= 0 || p <= 0 || p >= 1 || r <= 0) return 0;
  return q * r * p * (1 - p);
}

function roundTripPnl({ shares, entryPrice, exitPrice, feeRate }) {
  const q = finite(shares);
  const entry = finite(entryPrice);
  const exit = finite(exitPrice);
  if (q == null || entry == null || exit == null) return null;
  const gross = q * (exit - entry);
  const entryFee = takerFee(q, entry, feeRate);
  const exitFee = takerFee(q, exit, feeRate);
  return { gross, entryFee, exitFee, net: gross - entryFee - exitFee };
}

function oppositeToken(market, assetId) {
  const index = market.tokenIds.indexOf(String(assetId));
  if (index < 0 || market.tokenIds.length !== 2) return null;
  const oppositeIndex = index === 0 ? 1 : 0;
  return {
    assetId: market.tokenIds[oppositeIndex],
    outcome: market.outcomes[oppositeIndex] || null,
  };
}

/**
 * Causal entry predicate evaluated from the last book state at or before the
 * scheduled decision time. The target token must already show one full tick
 * of executable-bid follow-through, non-negative top-level queue pressure,
 * and the public sweep must have walked far enough to cover the contemporaneous
 * round-trip spread plus exact entry/exit taker fees.
 *
 * Every threshold is a venue/economic quantity, not a fit to observed PnL.
 */
function evaluateCostConfirmedEntry({ features, entryBid, bidSize, entryAsk, askSize, feeRate }) {
  const decisionBid = finite(features?.decision_target_bid);
  const decisionAsk = finite(features?.decision_target_ask);
  const displacement = finite(features?.sweep_displacement_per_share);
  const bid = finite(entryBid);
  const bidQty = finite(bidSize);
  const ask = finite(entryAsk);
  const askQty = finite(askSize);
  const rate = finite(feeRate) ?? 0;
  if ([decisionBid, decisionAsk, displacement, bid, bidQty, ask, askQty].some((value) => value == null) ||
      decisionBid <= 0 || decisionAsk >= 1 || bid <= 0 || ask >= 1 || ask <= bid ||
      bidQty <= 0 || askQty <= 0) {
    return { eligible: false, reason: 'invalid_confirmation_book' };
  }
  const bidImprovement = bid - decisionBid;
  const spread = ask - bid;
  const roundTripCostPerShare = spread + rate * ask * (1 - ask) + rate * bid * (1 - bid);
  const followThrough = bidImprovement + 1e-9 >= TOKEN_TICK;
  const queuePressure = bidQty + 1e-9 >= askQty;
  const costCovered = displacement + 1e-9 >= roundTripCostPerShare;
  return {
    eligible: followThrough && queuePressure && costCovered,
    reason: !followThrough ? 'no_one_tick_followthrough'
      : !queuePressure ? 'ask_queue_dominates'
        : !costCovered ? 'sweep_does_not_cover_roundtrip_cost' : 'eligible',
    bidImprovement,
    spread,
    roundTripCostPerShare,
    sweepDisplacementPerShare: displacement,
    queueRatio: bidQty / askQty,
  };
}

/**
 * Create continuation and fade controls after a completed public taker sweep.
 * This does not predict or intercept an unbroadcast order. The event is only
 * eligible after the venue publishes last_trade_price and a displayed touch
 * proves that the reported aggressor consumed at least one top level.
 */
function evaluatePublicSweep({
  trade, market, triggerBook, oppositeBook, preTouch, nowMs = Date.now(),
  includeControls = true, includeChallengers = true,
}) {
  if (!trade || !market || !preTouch) return { eligible: false, reason: 'missing_public_state' };
  const side = String(trade.side || '').toUpperCase();
  const price = finite(trade.price);
  const size = finite(trade.size);
  if (!['BUY', 'SELL'].includes(side) || price == null || size == null || size <= 0) {
    return { eligible: false, reason: 'invalid_trade' };
  }
  const notional = price * size;
  if (notional + 1e-9 < TARGET_STAKE_USD) return { eligible: false, reason: 'below_research_stake' };

  const opposingPrice = side === 'BUY' ? finite(preTouch.bestAsk) : finite(preTouch.bestBid);
  const opposingSize = side === 'BUY' ? finite(preTouch.askSize) : finite(preTouch.bidSize);
  const touchedLevel = side === 'BUY'
    ? opposingPrice != null && price + 1e-9 >= opposingPrice
    : opposingPrice != null && price <= opposingPrice + 1e-9;
  const consumedDisplayedTop = opposingSize != null && opposingSize > 0 && size + 1e-9 >= opposingSize;
  if (!touchedLevel || !consumedDisplayedTop) {
    return { eligible: false, reason: 'not_a_displayed_touch_sweep' };
  }

  const complement = oppositeToken(market, trade.assetId);
  if (!complement) return { eligible: false, reason: 'not_binary' };
  const original = {
    assetId: String(trade.assetId),
    outcome: market.outcomes[market.tokenIds.indexOf(String(trade.assetId))] || trade.outcome || null,
    book: triggerBook,
  };
  const opposite = { ...complement, book: oppositeBook };

  // Buying a complement is the executable long-only expression of a fall in
  // the originally traded token. Both arms therefore use the same paper fill
  // model and the same capital/depth rules.
  const continuation = side === 'BUY' ? original : opposite;
  const fade = side === 'BUY' ? opposite : original;
  const controlArms = [
    ['continuation', continuation],
    ['fade_control', fade],
  ];

  const signals = [];
  const minimumOrderSize = marketMinimumOrderSize(market);
  for (const [arm, target] of controlArms) {
    if (!includeControls) continue;
    const ask = finite(target.book?.asks?.[0]?.[0]);
    const askSize = finite(target.book?.asks?.[0]?.[1]);
    const bookAgeMs = target.book?.at == null ? Infinity : nowMs - target.book.at;
    if (ask == null || ask <= 0 || ask >= 1 || askSize == null || askSize <= 0 || bookAgeMs > 1500) continue;
    const requestedSize = Math.min(TARGET_STAKE_USD / ask, askSize * MAX_TOUCH_PARTICIPATION);
    if (requestedSize * ask < 1) continue;
    for (const latencyMs of LATENCY_PROFILES_MS) {
      signals.push({
        arm,
        latencyMs,
        availableAt: new Date(nowMs + latencyMs),
        targetAssetId: target.assetId,
        targetOutcome: target.outcome,
        entryLimit: ask,
        requestedSize,
        dataQualityGrade: bookAgeMs <= 500 ? 'A' : 'B',
        features: {
          strategy_version: STRATEGY_VERSION,
          trigger_side: side,
          trigger_price: price,
          trigger_size: size,
          trigger_notional: notional,
          pre_touch_price: opposingPrice,
          pre_touch_size: opposingSize,
          displayed_top_consumption: size / opposingSize,
          decision_book_age_ms: bookAgeMs,
          target_stake_usd: TARGET_STAKE_USD,
          max_touch_participation: MAX_TOUCH_PARTICIPATION,
          minimum_order_size: minimumOrderSize || null,
          public_event_only: true,
          pending_order_visibility: false,
        },
      });
    }
  }

  // V2 does not buy blindly after the print. It schedules a conditional
  // decision and the scorer evaluates confirmation using only the book known
  // at that availability timestamp. Both target tokens are expressed long-only
  // and therefore use the same causal predicate and execution model.
  const sweepDisplacement = Math.abs(price - opposingPrice);
  const challengerArms = [
    ['cost_confirmed_continuation_v2', continuation],
    ['absorption_reversal_v2', fade],
  ];
  if (includeChallengers && sweepDisplacement > 0) {
    for (const [arm, target] of challengerArms) {
      const decisionBid = finite(target.book?.bids?.[0]?.[0]);
      const decisionBidSize = finite(target.book?.bids?.[0]?.[1]);
      const decisionAsk = finite(target.book?.asks?.[0]?.[0]);
      const decisionAskSize = finite(target.book?.asks?.[0]?.[1]);
      const bookAgeMs = target.book?.at == null ? Infinity : nowMs - target.book.at;
      if (decisionBid == null || decisionAsk == null || decisionAsk <= decisionBid ||
          decisionBidSize == null || decisionBidSize <= 0 ||
          decisionAskSize == null || decisionAskSize <= 0 || bookAgeMs > 1500) continue;
      const requestedSize = Math.min(TARGET_STAKE_USD / decisionAsk,
        decisionAskSize * MAX_TOUCH_PARTICIPATION);
      if (requestedSize * decisionAsk < 1) continue;
      for (const latencyMs of CHALLENGER_LATENCY_PROFILES_MS) {
        signals.push({
          arm,
          latencyMs,
          availableAt: new Date(nowMs + latencyMs),
          targetAssetId: target.assetId,
          targetOutcome: target.outcome,
          // V2 decides from the arrival book rather than pretending today's
          // ask survives. The scorer dynamically caps size at that book.
          entryLimit: 0.99,
          requestedSize,
          dataQualityGrade: bookAgeMs <= 500 ? 'A' : 'B',
          features: {
            strategy_version: CHALLENGER_STRATEGY_VERSION,
            experiment_id: CHALLENGER_EXPERIMENT_ID,
            entry_filter: 'cost_confirmed_followthrough_v2',
            deferred_decision: true,
            trigger_side: side,
            trigger_price: price,
            trigger_size: size,
            trigger_notional: notional,
            pre_touch_price: opposingPrice,
            pre_touch_size: opposingSize,
            displayed_top_consumption: size / opposingSize,
            sweep_displacement_per_share: sweepDisplacement,
            decision_target_bid: decisionBid,
            decision_target_bid_size: decisionBidSize,
            decision_target_ask: decisionAsk,
            decision_target_ask_size: decisionAskSize,
            decision_book_age_ms: bookAgeMs,
            target_stake_usd: TARGET_STAKE_USD,
            max_touch_participation: MAX_TOUCH_PARTICIPATION,
            minimum_order_size: minimumOrderSize || null,
            minimum_followthrough_tick: TOKEN_TICK,
            public_event_only: true,
            pending_order_visibility: false,
          },
        });
      }
    }
  }
  return signals.length ? { eligible: true, signals } : { eligible: false, reason: 'no_executable_touch' };
}

module.exports = {
  CHALLENGER_EXPERIMENT_ID,
  CHALLENGER_LATENCY_PROFILES_MS,
  CHALLENGER_STRATEGY_VERSION,
  FEE_MODEL_VERSION,
  LATENCY_PROFILES_MS,
  MARKOUT_HORIZONS_MS,
  MAX_TOUCH_PARTICIPATION,
  STRATEGY_VERSION,
  TOKEN_TICK,
  evaluateCostConfirmedEntry,
  evaluatePublicSweep,
  marketMinimumOrderSize,
  roundTripPnl,
  takerFee,
};
