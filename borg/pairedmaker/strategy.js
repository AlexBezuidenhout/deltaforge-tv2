'use strict';

/**
 * Pure condition-level paired-maker paper simulator.
 *
 * The strategy buys complementary outcome tokens only. A complete set pays
 * exactly $1 at merge/resolution; until both legs fill, the residual is a
 * directional binary position and must be reported as orphan inventory.
 * Prices are Polymarket token prices on [0,1]. Sizes are shares.
 */

const {
  advanceQueue,
  createQueueState,
  feePerShare,
  finite,
  microstructure,
  sizeAtPrice,
  walkBid,
} = require('../allmarket/strategy');

const EPSILON = 1e-9;

function floorToTick(value, tickSize = 0.01) {
  const tick = finite(tickSize) || 0.01;
  const parsed = finite(value);
  if (parsed == null) return null;
  const floored = Math.floor((parsed + EPSILON) / tick) * tick;
  if (floored < tick - EPSILON) return null;
  return Math.min(1 - tick, +floored.toFixed(6));
}

function makerFee(price, shares, market = {}) {
  if (market.feeTakerOnly !== false) return 0;
  return shares * feePerShare(price, market.feeRate, market.feeExponent);
}

function pairBookView(books, options = {}) {
  if (!Array.isArray(books) || books.length !== 2) {
    return { qualified: false, reason: 'MISSING_COMPLEMENT_BOOK' };
  }
  const nowMs = finite(options.nowMs) || Date.now();
  const staleMs = finite(options.staleMs) ?? 750;
  const maxBookSkewMs = finite(options.maxBookSkewMs) ?? 250;
  const views = books.map((book) => microstructure(book));
  if (views.some((view) => !view)) return { qualified: false, reason: 'INVALID_BOOK' };
  const agesMs = books.map((book) => {
    const at = finite(book?.at);
    return at == null ? Infinity : nowMs - at;
  });
  if (agesMs.some((age) => age < -1000 || age > staleMs)) {
    return { qualified: false, reason: 'STALE_BOOK', views, agesMs };
  }
  const bookSkewMs = Math.abs((finite(books[0]?.at) ?? nowMs) - (finite(books[1]?.at) ?? nowMs));
  if (bookSkewMs > maxBookSkewMs) {
    return { qualified: false, reason: 'BOOK_SKEW', views, agesMs, bookSkewMs };
  }
  return {
    qualified: true,
    reason: 'SYNCHRONIZED_BOOKS',
    views,
    agesMs,
    bookSkewMs,
    bestBidSum: views[0].bid + views[1].bid,
    bestAskSum: views[0].ask + views[1].ask,
    midpointSum: views[0].midpoint + views[1].midpoint,
  };
}

/**
 * Quote both best bids only when their total acquisition cost leaves the
 * pre-registered complete-set edge. Joining, rather than improving, avoids
 * manufacturing a paper edge by crossing away the one-cent gross spread.
 */
function buildInitialPairQuotes({
  market, books, minPairEdge, targetPairUsd, minimumShares = 0,
  maxReservedUsd = null, nowMs, staleMs, maxBookSkewMs,
}) {
  const tick = finite(market?.tickSize) || 0.01;
  const edge = finite(minPairEdge);
  const targetUsd = finite(targetPairUsd);
  if (!(edge >= tick - EPSILON) || !(targetUsd > 0)) {
    return { qualified: false, reason: 'INVALID_CONFIGURATION' };
  }
  const pair = pairBookView(books, { nowMs, staleMs, maxBookSkewMs });
  if (!pair.qualified) return pair;
  const prices = pair.views.map((view) => floorToTick(view.bid, tick));
  if (prices.some((price) => price == null)) return { ...pair, qualified: false, reason: 'INVALID_BID' };
  const rawPairCost = prices[0] + prices[1];
  const pairCost = rawPairCost + makerFee(prices[0], 1, market) + makerFee(prices[1], 1, market);
  const maxPairCost = 1 - edge;
  if (pairCost > maxPairCost + EPSILON) {
    return {
      ...pair, qualified: false, reason: 'PAIR_EDGE_TOO_SMALL', prices,
      rawPairCost, pairCost, maxPairCost, grossEdgePerShare: 1 - pairCost,
    };
  }
  const orderMinSize = Math.max(0, finite(market?.orderMinSize) || 0);
  const targetShares = Math.max(orderMinSize, Math.max(0, finite(minimumShares) || 0), targetUsd / pairCost);
  const reservedCost = targetShares * pairCost;
  const reserveLimit = finite(maxReservedUsd);
  if (reserveLimit != null && reservedCost > reserveLimit + EPSILON) {
    return {
      ...pair, qualified: false, reason: 'PAIR_RESERVE_EXCEEDS_CAPITAL', prices,
      rawPairCost, pairCost, maxPairCost, targetShares, reservedCost, reserveLimit,
      grossEdgePerShare: 1 - pairCost,
    };
  }
  const quotes = prices.map((price, index) => ({
    qualified: true,
    price,
    size: targetShares,
    queueAhead: sizeAtPrice(books[index].bids, price) + orderMinSize,
    view: pair.views[index],
  }));
  return {
    ...pair,
    qualified: true,
    reason: 'PAIR_EDGE_QUALIFIED',
    quotes,
    prices,
    rawPairCost,
    pairCost,
    maxPairCost,
    targetShares,
    reservedCost,
    grossEdgePerShare: 1 - pairCost,
    grossLockedPnlIfFilled: targetShares * (1 - pairCost),
  };
}

function makeLeg(meta, quote, placedAtMs) {
  return {
    assetId: String(meta.assetId),
    outcome: meta.outcome,
    shares: 0,
    cost: 0,
    makerFees: 0,
    totalMakerFilled: 0,
    initialQuotePrice: quote.price,
    quote: {
      kind: 'INITIAL',
      active: true,
      price: quote.price,
      size: quote.size,
      accountedShares: 0,
      queue: createQueueState(quote, placedAtMs),
      placedAtMs,
      cancelRequestedAtMs: null,
      cancelEffectiveAtMs: null,
    },
  };
}

function createPairCycle({ cycleId, runId, experimentId, strategy, arm, market, metas, proposal, placedAtMs, initialQuoteLifetimeMs, repairTimeoutMs, cancelAckMs }) {
  if (!proposal?.qualified || !Array.isArray(metas) || metas.length !== 2) {
    throw new TypeError('qualified pair proposal and two token metadata records required');
  }
  return {
    cycleId,
    runId,
    experimentId,
    strategy,
    arm,
    conditionId: market.conditionId,
    market,
    openedAtMs: placedAtMs,
    firstFillAtMs: null,
    closedAtMs: null,
    status: 'QUOTING_BOTH',
    targetShares: proposal.targetShares,
    minPairEdge: proposal.maxPairCost == null ? null : 1 - proposal.maxPairCost,
    initialPairCost: proposal.pairCost,
    initialQuoteLifetimeMs,
    repairTimeoutMs,
    cancelAckMs,
    cancelReason: null,
    postCancelAction: null,
    legs: metas.map((meta, index) => makeLeg(meta, proposal.quotes[index], placedAtMs)),
    mergedShares: 0,
    lockedPnl: 0,
    orphanExitProceeds: 0,
    orphanExitFees: 0,
    orphanPnl: 0,
    orphanExitPrice: null,
    totalPnl: null,
    rewardDailyRate: Math.max(0, finite(market?.rewardsDailyRate) || 0),
    rewardMinSize: Math.max(0, finite(market?.rewardsMinSize) || 0),
    rewardMaxSpread: Math.max(0, finite(market?.rewardsMaxSpread) || 0),
    rewardQualifiedMs: 0,
    rewardOwnScoreSeconds: 0,
    rewardCompetitorUpperScoreSeconds: 0,
    modeledRewardAccrual: 0,
    lastRewardAtMs: placedAtMs,
    executionEvents: 0,
    dataQualityGrade: 'A',
    executionFidelityGrade: 'B',
  };
}

/**
 * Polymarket's liquidity score is quadratic in distance from midpoint. The
 * venue normalizes each maker's Q score against every other maker; public L2
 * does not reveal maker identities, so this module can only produce a
 * conservative modeled share, never an earned reward.
 */
function rewardOrderScore(maxSpreadCents, distanceCents, size) {
  const spread = finite(maxSpreadCents);
  const distance = finite(distanceCents);
  const shares = finite(size);
  if (!(spread > 0) || !(distance >= 0) || distance > spread + EPSILON || !(shares > 0)) return 0;
  return shares * Math.pow((spread - distance) / spread, 2);
}

function rewardWindowActive(market, nowMs = Date.now()) {
  const start = Date.parse(market?.rewardsStartDate);
  const end = Date.parse(market?.rewardsEndDate);
  return (!Number.isFinite(start) || nowMs >= start)
    && (!Number.isFinite(end) || nowMs < end + 86_400_000);
}

function displayedRewardScore(book, midpoint, maxSpreadCents) {
  return (Array.isArray(book?.bids) ? book.bids : []).reduce((sum, level) => {
    const price = finite(level?.[0]);
    const size = finite(level?.[1]);
    if (!(price > 0 && price < 1) || !(size > 0)) return sum;
    return sum + rewardOrderScore(maxSpreadCents, Math.max(0, (midpoint - price) * 100), size);
  }, 0);
}

function rewardQuoteSnapshot(cycle, books, options = {}) {
  const nowMs = finite(options.nowMs) || Date.now();
  const dailyRate = Math.max(0, finite(cycle?.rewardDailyRate) || 0);
  const minSize = Math.max(0, finite(cycle?.rewardMinSize) || 0);
  const maxSpread = Math.max(0, finite(cycle?.rewardMaxSpread) || 0);
  if (!(dailyRate > 0) || !(minSize > 0) || !(maxSpread > 0)) {
    return { qualified: false, reason: 'NO_ACTIVE_REWARD_CONFIGURATION' };
  }
  if (!rewardWindowActive(cycle.market, nowMs)) {
    return { qualified: false, reason: 'OUTSIDE_REWARD_WINDOW' };
  }
  const pair = pairBookView(books, options);
  if (!pair.qualified) return pair;
  const quotes = cycle.legs.map((leg) => leg.quote);
  if (quotes.some((quote) => !quote?.active || quote.kind !== 'INITIAL')) {
    return { ...pair, qualified: false, reason: 'TWO_SIDED_INITIAL_QUOTES_NOT_RESTING' };
  }
  const remaining = quotes.map((quote) => Math.max(0, quote.size - quote.accountedShares));
  if (remaining.some((size) => size + EPSILON < minSize)) {
    return { ...pair, qualified: false, reason: 'BELOW_REWARD_MINIMUM', remaining, minSize };
  }
  const ownSideScores = quotes.map((quote, index) => rewardOrderScore(
    maxSpread,
    Math.max(0, (pair.views[index].midpoint - quote.price) * 100),
    remaining[index],
  ));
  if (ownSideScores.some((score) => !(score > 0))) {
    return { ...pair, qualified: false, reason: 'QUOTE_OUTSIDE_REWARD_SPREAD', ownSideScores };
  }
  // Requiring two-sided liquidity in every price regime is deliberately more
  // conservative than the venue's edge-market exception.
  const ownQ = Math.min(...ownSideScores);
  const competitorSideScores = books.map((book, index) =>
    displayedRewardScore(book, pair.views[index].midpoint, maxSpread));
  // Sum(min(q1_i,q2_i)) <= min(sum(q1_i),sum(q2_i)); treating the latter as
  // competitor Q therefore lowers our estimated share when identities are
  // unavailable. Hidden liquidity can still make the estimate optimistic.
  const competitorUpperQ = Math.min(...competitorSideScores);
  const shareFloor = ownQ / Math.max(EPSILON, ownQ + competitorUpperQ);
  return {
    ...pair,
    qualified: true,
    reason: 'MODELED_REWARD_ELIGIBLE',
    dailyRate,
    minSize,
    maxSpread,
    remaining,
    ownSideScores,
    ownQ,
    competitorSideScores,
    competitorUpperQ,
    modeledShareFloor: shareFloor,
    modeledRewardPerDay: dailyRate * shareFloor,
  };
}

function accrueModeledReward(cycle, books, options = {}) {
  const nowMs = finite(options.nowMs) || Date.now();
  const previous = finite(cycle.lastRewardAtMs) ?? nowMs;
  const elapsedMs = Math.max(0, nowMs - previous);
  cycle.lastRewardAtMs = nowMs;
  if (!(elapsedMs > 0)) return { accrued: 0, elapsedMs, snapshot: null };
  const snapshot = rewardQuoteSnapshot(cycle, books, { ...options, nowMs });
  if (!snapshot.qualified) return { accrued: 0, elapsedMs, snapshot };
  const accrued = snapshot.dailyRate * snapshot.modeledShareFloor * elapsedMs / 86_400_000;
  cycle.rewardQualifiedMs += elapsedMs;
  cycle.rewardOwnScoreSeconds += snapshot.ownQ * elapsedMs / 1000;
  cycle.rewardCompetitorUpperScoreSeconds += snapshot.competitorUpperQ * elapsedMs / 1000;
  cycle.modeledRewardAccrual += accrued;
  return { accrued, elapsedMs, snapshot };
}

function activeQuote(cycle, legIndex) {
  const quote = cycle?.legs?.[legIndex]?.quote;
  return quote?.active ? quote : null;
}

function consumeMakerPrints(cycle, legIndex, prints, nowMs = Date.now()) {
  const leg = cycle?.legs?.[legIndex];
  const quote = activeQuote(cycle, legIndex);
  if (!leg || !quote) return { filledShares: 0, fillCost: 0, fillFee: 0 };
  const usable = (Array.isArray(prints) ? prints : []).filter((print) => {
    const at = finite(print?.[0]);
    return at != null && (quote.cancelEffectiveAtMs == null || at <= quote.cancelEffectiveAtMs);
  });
  advanceQueue(quote.queue, usable);
  const filledShares = Math.max(0, quote.queue.filledShares - quote.accountedShares);
  if (!(filledShares > EPSILON)) return { filledShares: 0, fillCost: 0, fillFee: 0 };
  quote.accountedShares += filledShares;
  const fillFee = makerFee(quote.price, filledShares, cycle.market);
  const fillCost = filledShares * quote.price + fillFee;
  leg.shares += filledShares;
  leg.cost += fillCost;
  leg.makerFees += fillFee;
  leg.totalMakerFilled += filledShares;
  cycle.firstFillAtMs ??= quote.queue.fillAtMs || quote.queue.lastPrintAtMs || nowMs;
  cycle.executionEvents += 1;
  if (quote.queue.filled) quote.active = false;
  return {
    filledShares,
    fillCost,
    fillFee,
    fillPrice: quote.price,
    fillAtMs: quote.queue.fillAtMs || quote.queue.lastPrintAtMs || nowMs,
    quoteKind: quote.kind,
  };
}

function mergeCompleteSets(cycle) {
  const [left, right] = cycle.legs;
  const shares = Math.min(left.shares, right.shares);
  if (!(shares > EPSILON)) return { mergedShares: 0, lockedPnl: 0, allocatedCost: 0 };
  const leftCost = shares * left.cost / left.shares;
  const rightCost = shares * right.cost / right.shares;
  const allocatedCost = leftCost + rightCost;
  const lockedPnl = shares - allocatedCost;
  left.shares -= shares; left.cost -= leftCost;
  right.shares -= shares; right.cost -= rightCost;
  if (left.shares <= EPSILON) { left.shares = 0; left.cost = 0; }
  if (right.shares <= EPSILON) { right.shares = 0; right.cost = 0; }
  cycle.mergedShares += shares;
  cycle.lockedPnl += lockedPnl;
  cycle.executionEvents += 1;
  return { mergedShares: shares, lockedPnl, allocatedCost };
}

function orphanPosition(cycle) {
  const populated = cycle.legs
    .map((leg, legIndex) => ({ legIndex, assetId: leg.assetId, outcome: leg.outcome, shares: leg.shares, cost: leg.cost }))
    .filter((leg) => leg.shares > EPSILON);
  if (!populated.length) return null;
  if (populated.length > 1) throw new Error('complete sets must be netted before orphan inspection');
  const orphan = populated[0];
  return { ...orphan, averageCost: orphan.cost / orphan.shares, complementLegIndex: 1 - orphan.legIndex };
}

function requestCancel(cycle, reason, postCancelAction, nowMs = Date.now()) {
  const effectiveAtMs = nowMs + Math.max(0, finite(cycle.cancelAckMs) || 0);
  const requested = [];
  cycle.legs.forEach((leg, legIndex) => {
    if (!leg.quote?.active || leg.quote.cancelRequestedAtMs != null) return;
    leg.quote.cancelRequestedAtMs = nowMs;
    leg.quote.cancelEffectiveAtMs = effectiveAtMs;
    requested.push({ legIndex, assetId: leg.assetId, quote: leg.quote });
  });
  cycle.cancelReason = reason;
  cycle.postCancelAction = postCancelAction;
  cycle.status = 'CANCEL_PENDING';
  return { requested, effectiveAtMs };
}

function acknowledgeCancels(cycle, nowMs = Date.now()) {
  const acknowledged = [];
  for (let legIndex = 0; legIndex < cycle.legs.length; legIndex += 1) {
    const quote = cycle.legs[legIndex].quote;
    if (!quote?.active || quote.cancelEffectiveAtMs == null || nowMs < quote.cancelEffectiveAtMs) continue;
    quote.active = false;
    acknowledged.push({ legIndex, assetId: cycle.legs[legIndex].assetId, quote });
  }
  const pending = cycle.legs.some((leg) => leg.quote?.active && leg.quote.cancelRequestedAtMs != null);
  return { complete: !pending, acknowledged, postCancelAction: cycle.postCancelAction };
}

function repairPriceWithinEdge({ orphanAverageCost, candidatePrice, minPairEdge, tickSize, market }) {
  const tick = finite(tickSize) || 0.01;
  const edge = finite(minPairEdge) || tick;
  let price = floorToTick(candidatePrice, tick);
  while (price != null && orphanAverageCost + price
    + makerFee(price, 1, market) > 1 - edge + EPSILON) {
    price = floorToTick(price - tick, tick);
  }
  return price;
}

function buildRepairQuote({ cycle, books, nowMs, staleMs, maxBookSkewMs }) {
  const orphan = orphanPosition(cycle);
  if (!orphan) return { qualified: false, reason: 'NO_ORPHAN' };
  const pair = pairBookView(books, { nowMs, staleMs, maxBookSkewMs });
  if (!pair.qualified) return pair;
  const complement = orphan.complementLegIndex;
  const view = pair.views[complement];
  const tick = finite(cycle.market.tickSize) || 0.01;
  const maxPostOnly = floorToTick(view.ask - tick, tick);
  if (maxPostOnly == null) return { ...pair, qualified: false, reason: 'NO_POST_ONLY_PRICE' };
  const improve = view.spread >= 2 * tick - EPSILON ? view.bid + tick : view.bid;
  const desired = Math.min(maxPostOnly, improve);
  const price = repairPriceWithinEdge({
    orphanAverageCost: orphan.averageCost,
    candidatePrice: desired,
    minPairEdge: cycle.minPairEdge,
    tickSize: tick,
    market: cycle.market,
  });
  if (price == null || price >= view.ask - EPSILON) {
    return { ...pair, qualified: false, reason: 'REPAIR_BREAKS_EDGE', orphan };
  }
  const minimum = Math.max(0, finite(cycle.market.orderMinSize) || 0);
  // A residual below the venue minimum cannot be honestly repaired with a new
  // order. It must be liquidated or carried; rounding it up manufactures risk.
  if (orphan.shares + EPSILON < minimum) {
    return { ...pair, qualified: false, reason: 'ORPHAN_BELOW_ORDER_MINIMUM', orphan };
  }
  return {
    ...pair,
    qualified: true,
    reason: 'REPAIR_QUOTE',
    orphan,
    complementLegIndex: complement,
    quote: {
      qualified: true,
      price,
      size: orphan.shares,
      queueAhead: sizeAtPrice(books[complement].bids, price) + minimum,
      view,
    },
  };
}

function installRepairQuote(cycle, proposal, nowMs = Date.now()) {
  if (!proposal?.qualified) throw new TypeError('qualified repair proposal required');
  const leg = cycle.legs[proposal.complementLegIndex];
  leg.quote = {
    kind: 'REPAIR',
    active: true,
    price: proposal.quote.price,
    size: proposal.quote.size,
    accountedShares: 0,
    queue: createQueueState(proposal.quote, nowMs),
    placedAtMs: nowMs,
    cancelRequestedAtMs: null,
    cancelEffectiveAtMs: null,
  };
  cycle.status = 'REPAIRING';
  cycle.cancelReason = null;
  cycle.postCancelAction = null;
  return { legIndex: proposal.complementLegIndex, assetId: leg.assetId, quote: leg.quote };
}

/**
 * Exit the residual through actual displayed bid depth, then worsen the depth
 * VWAP by a fixed number of ticks and charge the exact configured taker fee.
 * Insufficient depth returns NO_FILL; it never fabricates a liquidation.
 */
function liquidateOrphan(cycle, books, options = {}) {
  const orphan = orphanPosition(cycle);
  if (!orphan) return { filled: false, reason: 'NO_ORPHAN' };
  const nowMs = finite(options.nowMs) || Date.now();
  const staleMs = finite(options.staleMs) ?? 750;
  const book = books?.[orphan.legIndex];
  if (!book || nowMs - (finite(book.at) ?? 0) > staleMs) {
    return { filled: false, reason: 'STALE_EXIT_BOOK', orphan };
  }
  const depthVwap = walkBid(book, orphan.shares);
  if (depthVwap == null) return { filled: false, reason: 'INSUFFICIENT_EXIT_DEPTH', orphan };
  const tick = finite(cycle.market.tickSize) || 0.01;
  const adverseTicks = Math.max(0, finite(options.adverseTicks) ?? 1);
  const exitPrice = floorToTick(depthVwap - adverseTicks * tick, tick);
  if (exitPrice == null) return { filled: false, reason: 'EXIT_PRICE_BELOW_TICK', orphan, depthVwap };
  const fee = orphan.shares * feePerShare(exitPrice, cycle.market.feeRate, cycle.market.feeExponent);
  const proceeds = orphan.shares * exitPrice - fee;
  const pnl = proceeds - orphan.cost;
  const leg = cycle.legs[orphan.legIndex];
  leg.shares = 0; leg.cost = 0;
  cycle.orphanExitProceeds += proceeds;
  cycle.orphanExitFees += fee;
  cycle.orphanPnl += pnl;
  cycle.orphanExitPrice = exitPrice;
  cycle.executionEvents += 1;
  return {
    filled: true,
    reason: 'FULL_DEPTH_MINUS_ADVERSE_TICKS',
    ...orphan,
    depthVwap,
    exitPrice,
    adverseTicks,
    fee,
    proceeds,
    pnl,
  };
}

/** Score residual binary inventory at the actual winner after resolution. */
function settleOrphanAtResolution(cycle, winningAssetId) {
  mergeCompleteSets(cycle);
  const orphan = orphanPosition(cycle);
  if (!orphan) return { settled: false, reason: 'NO_ORPHAN' };
  const winner = String(winningAssetId || '');
  if (!winner) return { settled: false, reason: 'WINNER_UNKNOWN', orphan };
  const payoutPrice = orphan.assetId === winner ? 1 : 0;
  const proceeds = orphan.shares * payoutPrice;
  const pnl = proceeds - orphan.cost;
  const leg = cycle.legs[orphan.legIndex];
  leg.shares = 0;
  leg.cost = 0;
  cycle.orphanExitProceeds += proceeds;
  cycle.orphanPnl += pnl;
  cycle.orphanExitPrice = payoutPrice;
  cycle.executionEvents += 1;
  return {
    settled: true,
    reason: 'MARKET_RESOLUTION',
    ...orphan,
    payoutPrice,
    proceeds,
    pnl,
  };
}

function closeCycle(cycle, status, nowMs = Date.now()) {
  const orphan = orphanPosition(cycle);
  cycle.status = status;
  cycle.closedAtMs = nowMs;
  cycle.totalPnl = orphan ? null : cycle.lockedPnl + cycle.orphanPnl;
  return cycle;
}

module.exports = {
  EPSILON,
  accrueModeledReward,
  acknowledgeCancels,
  activeQuote,
  buildInitialPairQuotes,
  buildRepairQuote,
  closeCycle,
  consumeMakerPrints,
  createPairCycle,
  floorToTick,
  installRepairQuote,
  liquidateOrphan,
  makerFee,
  mergeCompleteSets,
  orphanPosition,
  pairBookView,
  rewardOrderScore,
  rewardQuoteSnapshot,
  rewardWindowActive,
  repairPriceWithinEdge,
  requestCancel,
  settleOrphanAtResolution,
};
