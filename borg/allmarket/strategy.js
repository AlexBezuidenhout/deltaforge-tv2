'use strict';

/**
 * Pure microstructure and paper-execution helpers for the all-market lab.
 *
 * These functions contain no database, wallet, signer, or network dependency.
 * Every price is a Polymarket token price on [0,1]. Sizes are shares.
 */

const DEFAULT_TICK = 0.01;

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampPrice(value, tickSize = DEFAULT_TICK) {
  const tick = finite(tickSize) || DEFAULT_TICK;
  const rounded = Math.round((finite(value) || 0) / tick) * tick;
  return Math.min(1 - tick, Math.max(tick, +rounded.toFixed(6)));
}

function top(book) {
  const bid = finite(book?.bids?.[0]?.[0]);
  const bidSize = finite(book?.bids?.[0]?.[1]);
  const ask = finite(book?.asks?.[0]?.[0]);
  const askSize = finite(book?.asks?.[0]?.[1]);
  if (!(bid > 0 && ask > bid && ask < 1 && bidSize > 0 && askSize > 0)) return null;
  return { bid, bidSize, ask, askSize };
}

function microstructure(book) {
  const touch = top(book);
  if (!touch) return null;
  const total = touch.bidSize + touch.askSize;
  const midpoint = (touch.bid + touch.ask) / 2;
  // The opposite queue weights the next executable-price estimate: a large
  // bid queue pushes microprice toward the ask, and vice versa.
  const microprice = (touch.ask * touch.bidSize + touch.bid * touch.askSize) / total;
  return {
    ...touch,
    midpoint,
    microprice,
    spread: touch.ask - touch.bid,
    imbalance: (touch.bidSize - touch.askSize) / total,
  };
}

function dataQuality({ connectionGap = false, stateAgeMs, stateSource = 'event' }) {
  const age = finite(stateAgeMs);
  if (connectionGap || age == null || age < -1000) return 'F';
  if (stateSource === 'event' && age <= 250) return 'A';
  if (age <= 750) return 'B';
  if (age <= 2000) return 'C';
  return 'F';
}

/**
 * Pre-registered L2 predictor. Thresholds are mechanism defaults, not fitted
 * to historical PnL: queue imbalance must be substantial and the microprice
 * must move at least one quarter tick away from midpoint.
 */
function evaluateL2Predictor(book, options = {}) {
  const view = microstructure(book);
  if (!view) return { qualified: false, reason: 'INVALID_BOOK' };
  const tickSize = finite(options.tickSize) || DEFAULT_TICK;
  const minImbalance = finite(options.minImbalance) ?? 0.60;
  const minMicropriceTicks = finite(options.minMicropriceTicks) ?? 0.25;
  const maxSpreadTicks = finite(options.maxSpreadTicks) ?? 4;
  const displacementTicks = Math.abs(view.microprice - view.midpoint) / tickSize;
  if (view.spread > maxSpreadTicks * tickSize + 1e-9) {
    return { qualified: false, reason: 'SPREAD_TOO_WIDE', ...view, displacementTicks };
  }
  if (Math.abs(view.imbalance) < minImbalance) {
    return { qualified: false, reason: 'WEAK_IMBALANCE', ...view, displacementTicks };
  }
  if (displacementTicks < minMicropriceTicks) {
    return { qualified: false, reason: 'WEAK_MICROPRICE', ...view, displacementTicks };
  }
  return {
    qualified: true,
    reason: 'QUALIFIED',
    direction: view.imbalance > 0 ? 'UP' : 'DOWN',
    ...view,
    displacementTicks,
  };
}

function feePerShare(price, feeRate = 0, feeExponent = 1) {
  const p = finite(price);
  const rate = finite(feeRate) || 0;
  const exponent = finite(feeExponent) || 1;
  return p == null ? null : rate * Math.pow(p * (1 - p), exponent);
}

function costConfirmedTaker({ predictor, arrivalBook, feeRate = 0, feeExponent = 1, requiredTicks = 1, tickSize = DEFAULT_TICK }) {
  const arrival = microstructure(arrivalBook);
  if (!predictor?.qualified || !arrival) return { qualified: false, reason: 'INVALID_STATE' };
  const tick = finite(tickSize) || DEFAULT_TICK;
  const predictedMove = Math.abs(predictor.microprice - predictor.midpoint);
  const roundTripFees = 2 * feePerShare(arrival.ask, feeRate, feeExponent);
  const hurdle = arrival.spread + roundTripFees + requiredTicks * tick;
  return {
    qualified: predictedMove > hurdle,
    reason: predictedMove > hurdle ? 'QUALIFIED' : 'COST_HURDLE',
    predictedMove,
    hurdle,
    roundTripFees,
    arrival,
  };
}

function sizeAtPrice(levels, price) {
  const wanted = finite(price);
  if (wanted == null || !Array.isArray(levels)) return 0;
  return levels.reduce((sum, level) => {
    const p = finite(level?.[0]); const size = finite(level?.[1]);
    return Math.abs(p - wanted) <= 1e-9 && size > 0 ? sum + size : sum;
  }, 0);
}

/**
 * Build a post-only BUY quote. It joins the best bid in a one-tick spread and
 * improves by one tick only when at least two ticks are available. Queue-ahead
 * is pessimistically the displayed queue plus one minimum qualifying order.
 */
function makerQuote({ book, tickSize = DEFAULT_TICK, requestedShares, minimumQualifyingSize = 0 }) {
  const view = microstructure(book);
  const tick = finite(tickSize) || DEFAULT_TICK;
  const requested = finite(requestedShares);
  if (!view || !(requested > 0)) return { qualified: false, reason: 'INVALID_STATE' };
  const canImprove = view.spread >= 2 * tick - 1e-9;
  const price = clampPrice(canImprove ? view.bid + tick : view.bid, tick);
  if (price >= view.ask - 1e-9) return { qualified: false, reason: 'WOULD_CROSS' };
  const displayed = sizeAtPrice(book.bids, price);
  const queueAhead = displayed + Math.max(0, finite(minimumQualifyingSize) || 0);
  return {
    qualified: true,
    reason: 'POST_ONLY',
    price,
    size: requested,
    queueAhead,
    improved: canImprove,
    fair: view.microprice,
    view,
  };
}

function createQueueState(quote, placedAtMs) {
  if (!quote?.qualified) throw new TypeError('qualified maker quote required');
  return {
    price: quote.price,
    size: quote.size,
    queueAheadInitial: quote.queueAhead,
    remainingAhead: quote.queueAhead,
    tradedThrough: 0,
    filledShares: 0,
    placedAtMs: finite(placedAtMs) || Date.now(),
    lastPrintAtMs: finite(placedAtMs) || Date.now(),
    filled: false,
    fillAtMs: null,
  };
}

/**
 * Conservative maker fill rule: cancellations never advance our queue. Only
 * public prints at or through our bid consume queue-ahead. Volume beyond the
 * conservative queue estimate produces partial fills; the quote is complete
 * only after print volume also covers our requested size.
 */
function advanceQueue(state, prints) {
  if (!state || state.filled) return state;
  for (const print of Array.isArray(prints) ? prints : []) {
    const at = finite(print?.[0]); const price = finite(print?.[1]); const size = finite(print?.[2]);
    if (!(at > state.lastPrintAtMs) || !(size > 0) || price == null) continue;
    state.lastPrintAtMs = Math.max(state.lastPrintAtMs, at);
    if (price > state.price + 1e-9) continue;
    state.tradedThrough += size;
    state.remainingAhead = Math.max(0, state.queueAheadInitial - state.tradedThrough);
    state.filledShares = Math.min(
      state.size,
      Math.max(0, state.tradedThrough - state.queueAheadInitial),
    );
    if (state.tradedThrough + 1e-9 >= state.queueAheadInitial + state.size) {
      state.filled = true;
      state.fillAtMs = at;
      break;
    }
  }
  return state;
}

function walkBid(book, shares) {
  let remaining = finite(shares);
  if (!(remaining > 0) || !Array.isArray(book?.bids)) return null;
  let proceeds = 0;
  for (const level of book.bids) {
    const price = finite(level?.[0]); const size = finite(level?.[1]);
    if (!(price > 0) || !(size > 0)) continue;
    const take = Math.min(remaining, size);
    proceeds += take * price;
    remaining -= take;
    if (remaining <= 1e-9) break;
  }
  if (remaining > 1e-9) return null;
  return proceeds / shares;
}

function walkAsk(book, shares) {
  let remaining = finite(shares);
  if (!(remaining > 0) || !Array.isArray(book?.asks)) return null;
  let cost = 0;
  for (const level of book.asks) {
    const price = finite(level?.[0]); const size = finite(level?.[1]);
    if (!(price > 0 && price < 1) || !(size > 0)) continue;
    const take = Math.min(remaining, size);
    cost += take * price;
    remaining -= take;
    if (remaining <= 1e-9) break;
  }
  if (remaining > 1e-9) return null;
  return cost / shares;
}

function markoutPnl({
  entryPrice, exitPrice, shares, entryKind = 'maker', feeRate = 0,
  feeExponent = 1, feeTakerOnly = true,
}) {
  const entry = finite(entryPrice); const exit = finite(exitPrice); const qty = finite(shares);
  if (entry == null || exit == null || !(qty > 0)) return null;
  const entryFee = entryKind === 'taker' || feeTakerOnly === false
    ? qty * feePerShare(entry, feeRate, feeExponent) : 0;
  const exitFee = qty * feePerShare(exit, feeRate, feeExponent);
  return qty * (exit - entry) - entryFee - exitFee;
}

module.exports = {
  DEFAULT_TICK,
  advanceQueue,
  clampPrice,
  costConfirmedTaker,
  createQueueState,
  dataQuality,
  evaluateL2Predictor,
  feePerShare,
  finite,
  makerQuote,
  markoutPnl,
  microstructure,
  sizeAtPrice,
  top,
  walkAsk,
  walkBid,
};
