'use strict';

/**
 * Queue-aware, paper-only passive-entry arm for certified payoff bundles.
 *
 * One leg joins the displayed best bid. Public prints at or through the quote
 * consume the recorded queue ahead; cancellations never advance it. Each
 * partial fill is hedged immediately at contemporaneous executable asks.
 * Taker fees are stressed at 2x, and maker fees are waived only when current
 * venue metadata explicitly identifies the schedule as taker-only.
 */

const crypto = require('node:crypto');
const { advanceQueue, createQueueState } = require('../allmarket/strategy');
const { feePerShare, walkShares } = require('./bregman');

const EPSILON = 1e-9;
const PASSIVE_ORDERED_TYPES = new Set([
  'nested_threshold',
  'sports_total_ladder',
  'sports_spread_ladder',
]);

function finite(value, fallback = null) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function legBook(books, tokenId) {
  const book = books?.get?.(tokenId);
  return {
    asks: Array.isArray(book?.asks) ? book.asks : [],
    bids: Array.isArray(book?.bids) ? book.bids : [],
    ask: finite(book?.asks?.[0]?.[0]),
    bid: finite(book?.bids?.[0]?.[0]),
    bidSize: finite(book?.bids?.[0]?.[1], 0),
    at: finite(book?.at),
  };
}

function stressedFill(levels, shares, leg, side) {
  return walkShares(
    levels,
    shares,
    finite(leg.feeRate),
    finite(leg.feeExponent),
    2,
    side,
  );
}

function passiveMakerFill(price, shares, leg) {
  const parsedPrice = finite(price);
  const parsedShares = finite(shares);
  if (!(parsedPrice > 0 && parsedPrice < 1) || !(parsedShares > 0)) return null;
  const unitFee = leg.feeTakerOnly === true
    ? 0 : feePerShare(
      parsedPrice,
      finite(leg.feeRate),
      finite(leg.feeExponent),
      2,
    );
  if (unitFee == null) return null;
  return {
    shares: parsedShares,
    gross: parsedPrice * parsedShares,
    fees: unitFee * parsedShares,
    fills: [[parsedPrice, parsedShares]],
    vwap: parsedPrice,
  };
}

function proposePassiveQuotes(candidate, books, nowMs, options = {}) {
  const staleMs = Math.max(1, finite(options.staleMs, 2000));
  const targetNotionalUsd = Math.max(1, finite(options.targetNotionalUsd, 10));
  const minimumProfitUsd = Math.max(0, finite(options.minCapacityProfitUsd, 0.05));
  if (candidate?.payoffProof?.valid !== true
    || candidate?.ruleCertification?.valid !== true
    || !(finite(candidate?.guaranteedMinPayout) > 0)
    || candidate?.legs?.length !== 2
    || !PASSIVE_ORDERED_TYPES.has(candidate?.structureType)) return [];
  const states = candidate.legs.map((leg) => ({ leg, book: legBook(books, leg.tokenId) }));
  if (states.some(({ leg, book }) => !(finite(leg.feeRate) >= 0)
    || !(finite(leg.feeExponent) > 0)
    || leg.feeScheduleKnown !== true
    || book.at == null || nowMs - book.at > staleMs)) return [];
  const shares = Math.max(...candidate.legs.map((leg) =>
    Math.max(0, finite(leg.orderMinSize, 0))));
  if (!(shares > 0)) return [];

  const proposals = [];
  for (let passiveLegIndex = 0; passiveLegIndex < states.length; passiveLegIndex += 1) {
    const passive = states[passiveLegIndex];
    if (!(passive.book.bid > 0.001 && passive.book.bid < 0.999
      && passive.book.bidSize > 0)) continue;
    const passiveFill = passiveMakerFill(passive.book.bid, shares, passive.leg);
    if (!passiveFill) continue;
    const hedgeFills = states.map(({ leg, book }, index) => index === passiveLegIndex
      ? passiveFill : stressedFill(book.asks, shares, leg, 'ASK'));
    if (hedgeFills.some((fill) => !fill)) continue;
    const cashRequired = hedgeFills.reduce((sum, fill) =>
      sum + fill.gross + fill.fees, 0);
    if (cashRequired > targetNotionalUsd + 1e-9) continue;
    const guaranteedPayout = shares * candidate.guaranteedMinPayout;
    const stressedProfit = guaranteedPayout - cashRequired;
    const unwind = stressedFill(passive.book.bids, shares, passive.leg, 'BID');
    const orphanUnwindPnl = unwind
      ? unwind.gross - unwind.fees - passiveFill.gross - passiveFill.fees : null;
    const orphanReserveUsd = orphanUnwindPnl == null ? null
      : Math.max(0, -orphanUnwindPnl);
    const orphanSafeProfitUsd = orphanReserveUsd == null ? null
      : stressedProfit - orphanReserveUsd;
    const eligible = orphanSafeProfitUsd != null
      && orphanSafeProfitUsd >= minimumProfitUsd;
    proposals.push({
      candidateId: candidate.candidateId,
      structureType: candidate.structureType,
      passiveLegIndex,
      passiveToken: passive.leg.tokenId,
      passiveOutcome: passive.leg.outcome,
      quotePrice: passive.book.bid,
      queueAheadShares: passive.book.bidSize,
      shares,
      cashRequired,
      guaranteedPayout,
      stressedProfit,
      orphanUnwindPnl,
      orphanReserveUsd,
      orphanSafeProfitUsd,
      eligible,
      payoffProofHash: candidate.payoffProof.proofHash,
      ruleCertificationHash: candidate.ruleCertification.certificationHash,
      feeModel: 'CURRENT_SCHEDULE_2X_ON_PASSIVE_AND_HEDGE_LEGS',
      makerFeeMode: passive.leg.feeTakerOnly === true
        ? 'EXPLICIT_TAKER_ONLY_ZERO_MAKER_FEE' : 'UNKNOWN_OR_MAKER_FEE_CHARGED_2X',
      fillModel: 'PUBLIC_PRINT_QUEUE_AHEAD_NO_CANCELLATION_CREDIT',
    });
  }
  return proposals.sort((left, right) =>
    Number(right.eligible) - Number(left.eligible)
    || finite(right.orphanSafeProfitUsd, -Infinity)
      - finite(left.orphanSafeProfitUsd, -Infinity)
    || left.passiveLegIndex - right.passiveLegIndex);
}

function createPassiveQuoteState(proposal, nowMs, options = {}) {
  const timeoutMs = Math.max(60_000, finite(options.timeoutMs, 60 * 60_000));
  const queue = createQueueState({
    qualified: true,
    price: proposal.quotePrice,
    size: proposal.shares,
    queueAhead: proposal.queueAheadShares,
  }, nowMs);
  return {
    quoteId: `sgpq_${crypto.randomUUID()}`,
    ...proposal,
    quotedAt: new Date(nowMs).toISOString(),
    quotedAtMs: nowMs,
    expiresAt: new Date(nowMs + timeoutMs).toISOString(),
    expiresAtMs: nowMs + timeoutMs,
    status: 'RESTING',
    observations: 0,
    queue,
    passiveFilledShares: 0,
    hedgedShares: 0,
    cumulativePassiveCost2xUsd: 0,
    cumulativeHedgeCost2xUsd: 0,
    cumulativeLockedPnl2xUsd: 0,
  };
}

function timeoutState(state, nowMs) {
  return {
    ...state,
    status: state.passiveFilledShares > EPSILON
      ? 'CANCELLED_PARTIAL_HEDGED_TIMEOUT' : 'CANCELLED_UNFILLED_TIMEOUT',
    closedAt: new Date(nowMs).toISOString(),
    totalCost2xUsd: state.cumulativePassiveCost2xUsd + state.cumulativeHedgeCost2xUsd,
    hedgeCost2xUsd: state.cumulativeHedgeCost2xUsd,
    lockedPnl2xUsd: state.cumulativeLockedPnl2xUsd,
  };
}

function updatePassiveQuoteState(state, candidate, books, nowMs, options = {}) {
  if (!state || state.status !== 'RESTING') return state;
  const staleMs = Math.max(1, finite(options.staleMs, 2000));
  const passiveLeg = candidate?.legs?.[state.passiveLegIndex];
  if (!passiveLeg) return {
    ...state,
    status: 'CANCELLED_RULE_CHANGED',
    closedAt: new Date(nowMs).toISOString(),
  };
  const passiveBook = legBook(books, passiveLeg.tokenId);
  const queue = { ...state.queue };
  const prints = (Array.isArray(options.prints) ? options.prints : [])
    .filter((print) => finite(print?.[0]) <= state.expiresAtMs);
  advanceQueue(queue, prints);
  let next = { ...state, queue, observations: state.observations + 1 };
  const newlyFilledShares = Math.max(
    0,
    finite(queue.filledShares, 0) - finite(state.passiveFilledShares, 0),
  );
  if (!(newlyFilledShares > EPSILON)) {
    return nowMs >= state.expiresAtMs ? timeoutState(next, nowMs) : next;
  }
  if (passiveBook.at == null || nowMs - passiveBook.at > staleMs) {
    return {
      ...next,
      status: 'FILLED_ORPHAN_UNWIND_UNAVAILABLE',
      filledAt: queue.fillAtMs
        ? new Date(queue.fillAtMs).toISOString() : new Date(nowMs).toISOString(),
      closedAt: new Date(nowMs).toISOString(),
      orphanUnwindPnl2xUsd: null,
    };
  }

  const passiveEntry = passiveMakerFill(state.quotePrice, newlyFilledShares, passiveLeg);
  const hedgeFills = candidate.legs.map((leg, index) => index === state.passiveLegIndex
    ? passiveEntry
    : stressedFill(legBook(books, leg.tokenId).asks, newlyFilledShares, leg, 'ASK'));
  const filledAt = queue.fillAtMs
    ? new Date(queue.fillAtMs).toISOString() : new Date(nowMs).toISOString();
  if (hedgeFills.every(Boolean)) {
    const incrementalCost = hedgeFills.reduce((sum, fill) =>
      sum + fill.gross + fill.fees, 0);
    const incrementalHedgeCost = incrementalCost - passiveEntry.gross - passiveEntry.fees;
    const incrementalLockedPnl = newlyFilledShares * candidate.guaranteedMinPayout
      - incrementalCost;
    const passiveFilledShares = finite(state.passiveFilledShares, 0) + newlyFilledShares;
    const hedgedShares = finite(state.hedgedShares, 0) + newlyFilledShares;
    const cumulativePassiveCost2xUsd = finite(state.cumulativePassiveCost2xUsd, 0)
      + passiveEntry.gross + passiveEntry.fees;
    const cumulativeHedgeCost2xUsd = finite(state.cumulativeHedgeCost2xUsd, 0)
      + incrementalHedgeCost;
    const cumulativeLockedPnl2xUsd = finite(state.cumulativeLockedPnl2xUsd, 0)
      + incrementalLockedPnl;
    const complete = queue.filled === true;
    next = {
      ...next,
      passiveFilledShares,
      hedgedShares,
      cumulativePassiveCost2xUsd,
      cumulativeHedgeCost2xUsd,
      cumulativeLockedPnl2xUsd,
      filledAt: state.filledAt || filledAt,
      hedgeCost2xUsd: cumulativeHedgeCost2xUsd,
      totalCost2xUsd: cumulativePassiveCost2xUsd + cumulativeHedgeCost2xUsd,
      lockedPnl2xUsd: cumulativeLockedPnl2xUsd,
      hedgeFullDepth: true,
    };
    if (!complete && nowMs < state.expiresAtMs) return next;
    return {
      ...next,
      status: complete
        ? cumulativeLockedPnl2xUsd > 0
          ? 'FILLED_HEDGED_POSITIVE' : 'FILLED_HEDGED_NEGATIVE'
        : 'CANCELLED_PARTIAL_HEDGED_TIMEOUT',
      closedAt: new Date(nowMs).toISOString(),
    };
  }

  const unwind = stressedFill(passiveBook.bids, newlyFilledShares, passiveLeg, 'BID');
  const orphanPnl = unwind
    ? unwind.gross - unwind.fees - passiveEntry.gross - passiveEntry.fees : null;
  return {
    ...next,
    status: unwind ? 'FILLED_ORPHAN_UNWOUND' : 'FILLED_ORPHAN_UNWIND_UNAVAILABLE',
    filledAt: state.filledAt || filledAt,
    closedAt: new Date(nowMs).toISOString(),
    hedgeFullDepth: false,
    passiveFilledShares: finite(state.passiveFilledShares, 0) + newlyFilledShares,
    orphanUnwindPnl2xUsd: orphanPnl,
    lockedPnl2xUsd: finite(state.cumulativeLockedPnl2xUsd, 0) + (orphanPnl || 0),
  };
}

module.exports = {
  PASSIVE_ORDERED_TYPES,
  createPassiveQuoteState,
  legBook,
  passiveMakerFill,
  proposePassiveQuotes,
  updatePassiveQuoteState,
};
