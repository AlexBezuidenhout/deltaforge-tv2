'use strict';

const { evaluateCostConfirmedEntry, takerFee } = require('./strategy');

const BOUNDARY_EXPERIMENT_ID = 'flow-late-absorption-boundary-v3';
const BOUNDARY_SOURCE_ARM = 'absorption_reversal_v2';
const BOUNDARY_SOURCE_LATENCY_MS = 500;
const BOUNDARY_ORDER_TRANSIT_MS = 250;
const BOUNDARY_WINDOW_MS = 10_000;

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function latestCausalTouch(touches, targetMs) {
  if (!Array.isArray(touches) || !Number.isFinite(targetMs)) return null;
  for (let index = touches.length - 1; index >= 0; index -= 1) {
    const touch = touches[index];
    if (finite(touch?.observedAt) != null && touch.observedAt <= targetMs) return touch;
  }
  return null;
}

function hasConnectionGap(events, { fromMs, toMs, shard }) {
  if (!Array.isArray(events) || !Number.isFinite(fromMs) || !Number.isFinite(toMs)) return true;
  return events.some((event) => event.shard === shard
    && event.at >= fromMs && event.at <= toMs
    && ['close', 'error', 'stale'].includes(event.event));
}

/**
 * Venue-faithful delayed arrival state. A displayed top can support an order
 * only when both the frozen 20% participation rule and the market's published
 * minimum share size are satisfied. Historical V2 signals have no
 * minimumOrderSize and therefore keep their original scoring contract; V3
 * records the CLOB value in every signal.
 */
function paperArrivalState({
  availableMs,
  boundaryMs,
  delayMs,
  observedAt,
  bestBid,
  bidSize,
  bestAsk,
  askSize,
  feeRate,
  targetStake,
  touchParticipation,
  minimumOrderSize,
  sourceArmed,
  connectionGap,
}) {
  const arrivalAt = availableMs + delayMs;
  const observedMs = observedAt == null ? null : new Date(observedAt).getTime();
  const stateAgeMs = Number.isFinite(observedMs) ? arrivalAt - observedMs : Infinity;
  const bid = finite(bestBid);
  const bidCapacity = finite(bidSize);
  const ask = finite(bestAsk);
  const askCapacity = finite(askSize);
  const boundary = Number.isFinite(boundaryMs) ? boundaryMs : null;
  const minimumShares = Math.max(0, finite(minimumOrderSize) || 0);
  const base = {
    delay_ms: delayMs,
    arrival_at: new Date(arrivalAt).toISOString(),
    observed_at: Number.isFinite(observedMs) ? new Date(observedMs).toISOString() : null,
    boundary_at: boundary == null ? null : new Date(boundary).toISOString(),
    state_age_ms: Number.isFinite(stateAgeMs) ? stateAgeMs : null,
    best_bid: bid,
    bid_capacity: bidCapacity,
    best_ask: ask,
    ask_capacity: askCapacity,
    minimum_order_size: minimumShares || null,
    connection_gap: Boolean(connectionGap),
    source_armed: Boolean(sourceArmed),
    filled: false,
  };
  if (!sourceArmed) return { ...base, reason: 'source_signal_not_armed' };
  if (boundary == null) return { ...base, reason: 'missing_authoritative_boundary' };
  if (arrivalAt >= boundary) return { ...base, reason: 'arrival_at_or_after_resolution_boundary' };
  if (connectionGap) return { ...base, reason: 'connection_gap_before_arrival' };
  if (!(stateAgeMs >= 0 && stateAgeMs <= 1500)) return { ...base, reason: 'no_fresh_causal_book' };
  if (!(ask > 0 && ask <= 0.99) || !(askCapacity > 0)) {
    return { ...base, reason: 'no_marketable_displayed_ask' };
  }
  const stake = finite(targetStake) || 10;
  const participation = finite(touchParticipation) || 0.20;
  const shares = Math.min(stake / ask, askCapacity * participation);
  const notional = shares * ask;
  if (!(shares > 0)) return { ...base, reason: 'no_displayed_capacity' };
  if (minimumShares > 0 && shares + 1e-9 < minimumShares) {
    return { ...base, reason: 'below_venue_minimum_size', candidate_size: shares, candidate_notional: notional };
  }
  if (!(notional >= 1)) return { ...base, reason: 'below_minimum_notional' };
  const rate = finite(feeRate) || 0;
  return {
    ...base,
    filled: true,
    reason: 'filled_at_causal_arrival_touch',
    fill_price: ask,
    fill_size: shares,
    notional,
    entry_fee: takerFee(shares, ask, rate),
    fee_rate: rate,
    max_touch_participation: participation,
  };
}

function boundarySourceState({
  signal,
  signalDecisionMs,
  availableMs,
  boundaryMs,
  touch,
  connectionGap,
}) {
  const boundary = Number.isFinite(boundaryMs) ? boundaryMs : null;
  const tteMs = boundary == null ? null : boundary - availableMs;
  const observedMs = touch?.observedAt == null ? null : Number(touch.observedAt);
  const stateAgeMs = Number.isFinite(observedMs) ? availableMs - observedMs : Infinity;
  const bestBid = finite(touch?.bestBid);
  const bidSize = finite(touch?.bidSize);
  const bestAsk = finite(touch?.bestAsk);
  const askSize = finite(touch?.askSize);
  const minimumShares = Math.max(0, finite(signal?.features?.minimum_order_size) || 0);
  const base = {
    experiment_id: BOUNDARY_EXPERIMENT_ID,
    condition_id: signal?.conditionId || null,
    token_id: signal?.targetAssetId || null,
    target_outcome: signal?.targetOutcome || null,
    signal_decision_at: new Date(signalDecisionMs).toISOString(),
    signal_available_at: new Date(availableMs).toISOString(),
    boundary_at: boundary == null ? null : new Date(boundary).toISOString(),
    tte_ms: tteMs,
    observed_at: Number.isFinite(observedMs) ? new Date(observedMs).toISOString() : null,
    state_age_ms: Number.isFinite(stateAgeMs) ? stateAgeMs : null,
    best_bid: bestBid,
    bid_size: bidSize,
    best_ask: bestAsk,
    ask_size: askSize,
    connection_epoch: touch?.connectionEpoch ?? null,
    connection_shard: touch?.connectionShard ?? null,
    connection_gap: Boolean(connectionGap),
    minimum_order_size: minimumShares || null,
    armed: false,
  };
  if (boundary == null) return { ...base, reason: 'missing_authoritative_boundary' };
  if (!(tteMs > 0 && tteMs <= BOUNDARY_WINDOW_MS)) return { ...base, reason: 'outside_final_10s_window' };
  if (connectionGap) return { ...base, reason: 'connection_gap_before_confirmation' };
  if (!(stateAgeMs >= 0 && stateAgeMs <= 1500)) return { ...base, reason: 'no_fresh_causal_confirmation_book' };

  const confirmation = evaluateCostConfirmedEntry({
    features: signal.features,
    entryBid: bestBid,
    bidSize,
    entryAsk: bestAsk,
    askSize,
    feeRate: signal.feeRate,
  });
  if (!confirmation.eligible) return { ...base, confirmation, reason: confirmation.reason };

  const targetStake = finite(signal.features?.target_stake_usd) || 10;
  const participation = finite(signal.features?.max_touch_participation) || 0.20;
  const shares = bestAsk > 0 && askSize > 0
    ? Math.min(targetStake / bestAsk, askSize * participation) : 0;
  const notional = shares * (bestAsk || 0);
  if (!(shares > 0)) return { ...base, confirmation, reason: 'no_displayed_capacity' };
  if (minimumShares > 0 && shares + 1e-9 < minimumShares) {
    return { ...base, confirmation, reason: 'below_venue_minimum_size', candidate_size: shares, candidate_notional: notional };
  }
  if (!(notional >= 1)) return { ...base, confirmation, reason: 'below_minimum_notional' };
  return {
    ...base,
    armed: true,
    reason: 'source_signal_armed',
    confirmation,
    source_size: shares,
    source_notional: notional,
    target_stake_usd: targetStake,
    max_touch_participation: participation,
    fee_rate: finite(signal.feeRate) || 0,
  };
}

module.exports = {
  BOUNDARY_EXPERIMENT_ID,
  BOUNDARY_ORDER_TRANSIT_MS,
  BOUNDARY_SOURCE_ARM,
  BOUNDARY_SOURCE_LATENCY_MS,
  BOUNDARY_WINDOW_MS,
  boundarySourceState,
  hasConnectionGap,
  latestCausalTouch,
  paperArrivalState,
};
