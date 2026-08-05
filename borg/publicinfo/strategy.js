'use strict';

const { feePerShare, walkAsk } = require('../allmarket/strategy');
const { finite } = require('./xtracker');

function askDepth(book) {
  if (!Array.isArray(book?.asks)) return 0;
  return book.asks.reduce((sum, level) => {
    const price = finite(level?.[0]);
    const size = finite(level?.[1]);
    return price > 0 && price < 1 && size > 0 ? sum + size : sum;
  }, 0);
}

/**
 * Conservative terminal-hold paper fill for a resolver-state barrier.
 *
 * The guaranteed token pays $1 if the deterministic rule certificate remains
 * valid. Qualification uses walked displayed depth, doubled taker fees, one
 * tick of price stress and a separate source/fallback reserve. The nominal PnL
 * reports the expected cash result with one entry fee; the stressed PnL is the
 * promotion metric. No live order path is present here.
 */
function paperBarrierFill(options = {}) {
  const book = options.book;
  const firstAsk = finite(book?.asks?.[0]?.[0]);
  const minimumOrderSize = Math.max(1, finite(options.minimumOrderSize, 5));
  const targetUsd = Math.max(1, finite(options.targetUsd, 10));
  const tickSize = Math.max(0.0001, finite(options.tickSize, 0.01));
  const feeRate = Math.max(0, finite(options.feeRate, 0));
  const feeExponent = Math.max(0, finite(options.feeExponent, 1));
  const sourceRiskReserve = Math.max(0, finite(options.sourceRiskReserve, 0.01));
  if (!(firstAsk > 0 && firstAsk < 1)) {
    return { qualified: false, filled: false, reason: 'NO_EXECUTABLE_ASK' };
  }

  const requestedShares = Math.max(minimumOrderSize, targetUsd / firstAsk);
  const displayedShares = askDepth(book);
  const averageFillPrice = walkAsk(book, requestedShares);
  if (averageFillPrice == null) {
    return {
      qualified: false,
      filled: false,
      reason: 'INSUFFICIENT_DISPLAYED_DEPTH',
      requestedShares,
      displayedShares,
    };
  }

  const entryFeePerShare = feePerShare(averageFillPrice, feeRate, feeExponent) || 0;
  const fee2xPerShare = 2 * entryFeePerShare;
  const nominalEdgePerShare = 1 - averageFillPrice - entryFeePerShare;
  const stressedEdgePerShare = 1 - averageFillPrice - fee2xPerShare
    - tickSize - sourceRiskReserve;
  const qualified = stressedEdgePerShare > 1e-9;
  return {
    qualified,
    filled: qualified,
    reason: qualified ? 'QUALIFIED_RESOLVER_BARRIER' : 'NON_POSITIVE_STRESSED_EDGE',
    requestedShares,
    displayedShares,
    averageFillPrice,
    entryFeePerShare,
    fee2xPerShare,
    tickStressPerShare: tickSize,
    sourceRiskReservePerShare: sourceRiskReserve,
    nominalTerminalPnlUsd: requestedShares * nominalEdgePerShare,
    stressedTerminalPnlUsd: requestedShares * stressedEdgePerShare,
    nominalEdgePerShare,
    stressedEdgePerShare,
  };
}

module.exports = { askDepth, paperBarrierFill };
