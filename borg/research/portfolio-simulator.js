'use strict';

const {
  MAX_GROSS_EXPOSURE_PCT,
  RESEARCH_CAPITAL_VERSION,
  RISK_PER_TRADE_PCT,
  STARTING_BANKROLL_USD,
} = require('./capital-policy');
const { pearson } = require('./statistics');

function finite(value, fallback = null) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function timestamp(value) {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 4) {
  return Number.isFinite(value) ? +value.toFixed(digits) : null;
}

function simulatePortfolio(records, options = {}) {
  const startingBankroll = finite(options.startingBankroll, STARTING_BANKROLL_USD);
  const riskPerTrade = finite(options.riskPerTrade, RISK_PER_TRADE_PCT);
  const maxGrossPct = finite(options.maxGrossPct, MAX_GROSS_EXPOSURE_PCT);
  const sorted = [...records].sort((a, b) =>
    (timestamp(a.fillTs || a.availableAt || a.ts) || 0) - (timestamp(b.fillTs || b.availableAt || b.ts) || 0)
      || String(a.orderId || '').localeCompare(String(b.orderId || '')));

  let cash = startingBankroll;
  let realizedPnl = 0;
  let peakEquity = startingBankroll;
  let maxDrawdown = 0;
  let grossExposure = 0;
  let exposureTime = 0;
  let lastTime = sorted.length ? timestamp(sorted[0].fillTs || sorted[0].availableAt || sorted[0].ts) : null;
  const open = [];
  const marketOwners = new Map();
  const capacityUsed = new Map();
  const decisions = [];
  const pnlByStrategy = new Map();
  const pnlByDayStrategy = new Map();
  let settledPositions = 0;
  let winningPositions = 0;
  let losingPositions = 0;

  function ownerKey(record) {
    return record.groupId ? `${record.strategy}:group:${record.groupId}` : `${record.strategy}:single:${record.orderId}`;
  }

  function release(position) {
    cash += position.cost + position.pnl1x;
    grossExposure -= position.cost;
    realizedPnl += position.pnl1x;
    settledPositions += 1;
    if (position.pnl1x > 0) winningPositions += 1;
    else if (position.pnl1x < 0) losingPositions += 1;
    const owners = marketOwners.get(position.marketId);
    if (owners) {
      const remaining = (owners.get(position.owner) || 1) - 1;
      if (remaining > 0) owners.set(position.owner, remaining);
      else owners.delete(position.owner);
      if (!owners.size) marketOwners.delete(position.marketId);
    }
    pnlByStrategy.set(position.strategy, (pnlByStrategy.get(position.strategy) || 0) + position.pnl1x);
    const day = new Date(position.settleAt).toISOString().slice(0, 10);
    const dayMap = pnlByDayStrategy.get(day) || new Map();
    dayMap.set(position.strategy, (dayMap.get(position.strategy) || 0) + position.pnl1x);
    pnlByDayStrategy.set(day, dayMap);
    const equity = cash + grossExposure;
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdown = Math.min(maxDrawdown, equity - peakEquity);
  }

  function settleUntil(now) {
    open.sort((a, b) => a.settleAt - b.settleAt);
    while (open.length && open[0].settleAt <= now) release(open.shift());
  }

  for (const record of sorted) {
    const now = timestamp(record.fillTs || record.availableAt || record.ts);
    if (now == null) {
      decisions.push({ orderId: record.orderId, accepted: false, reason: 'INVALID_TIMESTAMP' });
      continue;
    }
    if (lastTime != null && now > lastTime) exposureTime += grossExposure * (now - lastTime);
    lastTime = now;
    settleUntil(now);

    if (record.filled === false) {
      decisions.push({ orderId: record.orderId, strategy: record.strategy, accepted: false, reason: 'NON_FILL' });
      continue;
    }
    const fillPrice = finite(record.fillPrice);
    const recordedShares = finite(record.fillSize);
    const recordedPnl1x = finite(record.pnl1x);
    const recordedPnl2x = finite(record.pnl2x);
    if (!(fillPrice > 0 && fillPrice < 1) || !(recordedShares > 0) || recordedPnl1x == null) {
      decisions.push({ orderId: record.orderId, strategy: record.strategy, accepted: false, reason: 'INVALID_FILL' });
      continue;
    }

    const marketId = String(record.marketId);
    const owner = ownerKey(record);
    const owners = marketOwners.get(marketId);
    if (owners && !owners.has(owner)) {
      decisions.push({ orderId: record.orderId, strategy: record.strategy, accepted: false, reason: 'MARKET_EXPOSURE_CONFLICT' });
      continue;
    }

    const equity = cash + grossExposure;
    const targetCost = Math.min(startingBankroll * riskPerTrade, Math.max(0, equity * riskPerTrade));
    const maxGross = Math.max(0, startingBankroll * maxGrossPct);
    const grossRoom = Math.max(0, maxGross - grossExposure);
    let shares = Math.min(recordedShares, targetCost / fillPrice, cash / fillPrice, grossRoom / fillPrice);

    const capacity = finite(record.capacityAtArrival ?? record.detail?.capacity_at_arrival);
    const capacityKey = record.capacityKey || [marketId, record.token || '', record.stateEventId || record.sourceEventId || now].join(':');
    if (capacity != null) {
      const remaining = Math.max(0, capacity - (capacityUsed.get(capacityKey) || 0));
      shares = Math.min(shares, remaining);
    }
    if (!(shares > 1e-9)) {
      const reason = grossRoom <= 1e-9 ? 'PORTFOLIO_GROSS_LIMIT'
        : cash <= 1e-9 ? 'INSUFFICIENT_CASH' : 'LIQUIDITY_ALREADY_CONSUMED';
      decisions.push({ orderId: record.orderId, strategy: record.strategy, accepted: false, reason });
      continue;
    }

    const scale = shares / recordedShares;
    const cost = shares * fillPrice;
    const settleAt = timestamp(record.settleAt || record.resolvedAt || record.windowEnd) || now;
    const position = {
      orderId: record.orderId, strategy: record.strategy, marketId, owner,
      cost, shares, fillPrice, openedAt: now, settleAt,
      pnl1x: recordedPnl1x * scale,
      pnl2x: (recordedPnl2x ?? recordedPnl1x) * scale,
    };
    cash -= cost;
    grossExposure += cost;
    open.push(position);
    const nextOwners = owners || new Map();
    nextOwners.set(owner, (nextOwners.get(owner) || 0) + 1); marketOwners.set(marketId, nextOwners);
    if (capacity != null) capacityUsed.set(capacityKey, (capacityUsed.get(capacityKey) || 0) + shares);
    decisions.push({
      orderId: record.orderId, strategy: record.strategy, accepted: true, reason: 'ADMITTED',
      shares: round(shares), cost: round(cost), scale: round(scale),
    });
  }

  if (open.length) {
    const lastSettle = Math.max(...open.map((position) => position.settleAt));
    if (lastTime != null && lastSettle > lastTime) exposureTime += grossExposure * (lastSettle - lastTime);
    settleUntil(lastSettle);
    lastTime = lastSettle;
  }

  const days = [...pnlByDayStrategy.keys()].sort();
  const strategies = [...pnlByStrategy.keys()].sort();
  const correlations = [];
  for (let left = 0; left < strategies.length; left += 1) {
    for (let right = left + 1; right < strategies.length; right += 1) {
      const xs = days.map((day) => pnlByDayStrategy.get(day)?.get(strategies[left]) || 0);
      const ys = days.map((day) => pnlByDayStrategy.get(day)?.get(strategies[right]) || 0);
      correlations.push({ left: strategies[left], right: strategies[right], correlation: round(pearson(xs, ys)) });
    }
  }
  const absolutePnl = [...pnlByStrategy.values()].reduce((sum, value) => sum + Math.abs(value), 0);
  const pnlConcentrationHhi = absolutePnl > 0
    ? [...pnlByStrategy.values()].reduce((sum, value) => sum + (Math.abs(value) / absolutePnl) ** 2, 0)
    : null;
  const admitted = decisions.filter((decision) => decision.accepted);
  const duration = sorted.length && lastTime != null
    ? Math.max(1, lastTime - (timestamp(sorted[0].fillTs || sorted[0].availableAt || sorted[0].ts) || lastTime))
    : 1;
  return {
    format: 'borg-shared-portfolio-v1',
    capitalVersion: RESEARCH_CAPITAL_VERSION,
    startingBankroll: round(startingBankroll, 2),
    endingBankroll: round(cash, 2),
    realizedPnl1x: round(realizedPnl, 2),
    admittedOrders: admitted.length,
    rejectedOrders: decisions.length - admitted.length,
    settledPositions,
    winningPositions,
    losingPositions,
    winRatePct: settledPositions ? round(100 * winningPositions / settledPositions, 2) : null,
    maxGrossExposureUsd: round(startingBankroll * maxGrossPct, 2),
    averageGrossUtilization: round(exposureTime / duration / (startingBankroll * maxGrossPct || 1)),
    maxDrawdownUsd: round(maxDrawdown, 2),
    pnlConcentrationHhi: round(pnlConcentrationHhi),
    pnlByStrategy: Object.fromEntries([...pnlByStrategy].map(([key, value]) => [key, round(value, 2)])),
    dailyStrategyCorrelations: correlations,
    rejectionReasons: decisions.filter((decision) => !decision.accepted).reduce((out, decision) => {
      out[decision.reason] = (out[decision.reason] || 0) + 1; return out;
    }, {}),
    decisions,
  };
}

module.exports = { simulatePortfolio };
