'use strict';

/**
 * Pure execution math for the Pyth resolver-boundary observation arm.
 * This module makes no forecast and submits no order. It answers only:
 * "what could a $N paper probe have bought/sold against displayed depth?"
 */

function finite(value, fallback = null) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeLevels(levels, side) {
  if (!Array.isArray(levels)) return [];
  return levels.map((level) => (Array.isArray(level)
    ? [finite(level[0]), finite(level[1])]
    : [finite(level?.price), finite(level?.size)]))
    .filter(([price, size]) => price > 0 && price < 1 && size > 0)
    .sort((left, right) => (side === 'asks' ? left[0] - right[0] : right[0] - left[0]));
}

function walkBook(levels, requestedShares, side = 'asks') {
  let remaining = Math.max(0, finite(requestedShares, 0));
  let shares = 0;
  let gross = 0;
  const fills = [];
  for (const [price, available] of normalizeLevels(levels, side)) {
    if (remaining <= 1e-12) break;
    const size = Math.min(remaining, available);
    if (!(size > 0)) continue;
    shares += size;
    gross += size * price;
    remaining -= size;
    fills.push({ price, shares: size });
  }
  return {
    requestedShares: Math.max(0, finite(requestedShares, 0)),
    shares,
    gross,
    vwap: shares > 0 ? gross / shares : null,
    complete: remaining <= 1e-9,
    remaining: Math.max(0, remaining),
    fills,
  };
}

// Polymarket's current fee formula is rate * min(p,1-p)^exponent per share.
// A fee schedule must be supplied by the market metadata; unknown is invalid.
function takerFee(fills, rate, exponent) {
  const r = finite(rate);
  const e = finite(exponent);
  if (!(r >= 0) || !(e > 0)) return null;
  return fills.reduce((sum, fill) => {
    const price = finite(fill.price);
    const shares = finite(fill.shares);
    if (!(price > 0 && price < 1 && shares > 0)) return sum;
    return sum + shares * r * Math.min(price, 1 - price) ** e;
  }, 0);
}

function entryCost(levels, shares, feeRate, feeExponent) {
  const walk = walkBook(levels, shares, 'asks');
  if (!walk.complete) return { ...walk, fee: null, total: null };
  const fee = takerFee(walk.fills, feeRate, feeExponent);
  return { ...walk, fee, total: fee == null ? null : walk.gross + fee };
}

function sizePaperEntry({
  asks, budgetUsd, minimumOrderSize, feeRate, feeExponent,
}) {
  const budget = finite(budgetUsd);
  const minimum = finite(minimumOrderSize);
  if (!(budget > 0)) return { executable: false, reason: 'INVALID_BUDGET' };
  if (!(minimum > 0)) return { executable: false, reason: 'UNKNOWN_MINIMUM_ORDER_SIZE' };
  if (!(finite(feeRate) >= 0) || !(finite(feeExponent) > 0)) {
    return { executable: false, reason: 'UNKNOWN_FEE_SCHEDULE' };
  }
  const depth = normalizeLevels(asks, 'asks');
  const totalDepth = depth.reduce((sum, level) => sum + level[1], 0);
  if (totalDepth < minimum) return { executable: false, reason: 'INSUFFICIENT_ASK_DEPTH' };

  let low = 0;
  let high = totalDepth;
  for (let index = 0; index < 64; index += 1) {
    const mid = (low + high) / 2;
    const cost = entryCost(depth, mid, feeRate, feeExponent);
    if (cost.total != null && cost.total <= budget) low = mid;
    else high = mid;
  }
  const shares = low;
  if (shares + 1e-9 < minimum) return { executable: false, reason: 'BUDGET_BELOW_MINIMUM_ORDER' };
  const result = entryCost(depth, shares, feeRate, feeExponent);
  if (!result.complete || result.total == null) return { executable: false, reason: 'INSUFFICIENT_ASK_DEPTH' };
  return {
    executable: true,
    reason: 'DISPLAYED_DEPTH_PAPER_PROBE',
    shares: result.shares,
    vwap: result.vwap,
    gross: result.gross,
    fee: result.fee,
    total: result.total,
    unusedBudget: Math.max(0, budget - result.total),
    fills: result.fills,
  };
}

function executableMarkout({ bids, shares, entryTotal, feeRate, feeExponent }) {
  const quantity = finite(shares);
  const cost = finite(entryTotal);
  if (!(quantity > 0) || !(cost >= 0)) return { scored: false, reason: 'INVALID_ENTRY' };
  if (!(finite(feeRate) >= 0) || !(finite(feeExponent) > 0)) {
    return { scored: false, reason: 'UNKNOWN_FEE_SCHEDULE' };
  }
  const walk = walkBook(bids, quantity, 'bids');
  if (!walk.complete) return {
    scored: false, reason: 'INSUFFICIENT_BID_DEPTH', displayedShares: walk.shares,
  };
  const exitFee = takerFee(walk.fills, feeRate, feeExponent);
  const proceeds = walk.gross - exitFee;
  return {
    scored: true,
    reason: 'EXECUTABLE_BID_MARKOUT',
    shares: quantity,
    vwap: walk.vwap,
    grossProceeds: walk.gross,
    exitFee,
    netProceeds: proceeds,
    pnl: proceeds - cost,
    fills: walk.fills,
  };
}

function checkpointCrossings(previousTteSec, currentTteSec, checkpoints) {
  const previous = finite(previousTteSec);
  const current = finite(currentTteSec);
  if (!(previous >= 0) || !(current >= 0) || current > previous) return [];
  return [...new Set((checkpoints || []).map(finite).filter((value) => value > 0))]
    .sort((left, right) => right - left)
    .filter((threshold) => previous > threshold && current <= threshold);
}

function resolverSide(price, boundary) {
  const value = finite(price);
  const target = finite(boundary);
  if (value == null || target == null) return null;
  if (value > target) return 'UP';
  if (value < target) return 'DOWN';
  return 'TIE';
}

module.exports = {
  checkpointCrossings,
  entryCost,
  executableMarkout,
  finite,
  normalizeLevels,
  resolverSide,
  sizePaperEntry,
  takerFee,
  walkBook,
};
