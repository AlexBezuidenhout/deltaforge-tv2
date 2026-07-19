'use strict';

/** Pure option-surface-to-binary valuation and hedge accounting. */

const { feePerShare, walkShares } = require('../structural/bregman');

const YEAR_SECONDS = 365.25 * 24 * 60 * 60;

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalPdf(value) {
  return Math.exp(-0.5 * value * value) / Math.sqrt(2 * Math.PI);
}

function normalCdf(value) {
  const x = finite(value);
  if (x == null) return null;
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const density = normalPdf(x);
  const polynomial = t * (0.319381530 + t * (-0.356563782
    + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const cdf = 1 - density * polynomial;
  return x >= 0 ? cdf : 1 - cdf;
}

function normalizeVol(value) {
  const parsed = finite(value);
  if (!(parsed > 0)) return null;
  // Deribit IV fields are percentages; internal calculations are decimals.
  return parsed > 3 ? parsed / 100 : parsed;
}

function digitalCashFair({
  spot, forward = null, strike, annualizedVol, secondsToExpiry, discountRate = 0,
}) {
  const s = finite(spot);
  const k = finite(strike);
  const sigma = normalizeVol(annualizedVol);
  const seconds = finite(secondsToExpiry);
  const rate = finite(discountRate) ?? 0;
  if (!(s > 0) || !(k > 0) || !(sigma > 0) || !(seconds > 0)) return null;
  const years = seconds / YEAR_SECONDS;
  const rootT = Math.sqrt(years);
  const f = finite(forward) ?? s * Math.exp(rate * years);
  if (!(f > 0)) return null;
  const d2 = (Math.log(f / k) - 0.5 * sigma * sigma * years) / (sigma * rootT);
  const d1 = d2 + sigma * rootT;
  const discount = Math.exp(-rate * years);
  const probability = normalCdf(d2);
  const presentYes = discount * probability;
  const density = normalPdf(d2);
  const delta = discount * density / (s * sigma * rootT);
  const gamma = -discount * density / (s * s * sigma * rootT)
    * (1 + d2 / (sigma * rootT));
  const vega = -discount * density * d1 / sigma;
  return {
    probability,
    presentYes,
    presentNo: discount - presentYes,
    discount,
    d1,
    d2,
    delta,
    gamma,
    vega,
    forward: f,
    years,
  };
}

function callSpreadProbabilityBounds({
  lowerStrike, upperStrike, lowerCallBid, lowerCallAsk, upperCallBid, upperCallAsk,
  premiumToQuoteMultiplier = 1,
}) {
  const low = finite(lowerStrike);
  const high = finite(upperStrike);
  const lowBid = finite(lowerCallBid);
  const lowAsk = finite(lowerCallAsk);
  const highBid = finite(upperCallBid);
  const highAsk = finite(upperCallAsk);
  const multiplier = finite(premiumToQuoteMultiplier);
  if (!(high > low) || !(multiplier > 0)
    || [lowBid, lowAsk, highBid, highAsk].some((value) => value == null)) return null;
  const width = high - low;
  // Executable long/short call-spread prices bound the average discounted
  // digital value over [K_low,K_high]. Deribit inverse option premiums are
  // quoted in the base asset, so callers must explicitly supply a conversion
  // into the strike quote currency; silently dividing BTC by USD is forbidden.
  const lower = Math.max(0, Math.min(1, multiplier * (lowBid - highAsk) / width));
  const upper = Math.max(0, Math.min(1, multiplier * (lowAsk - highBid) / width));
  return {
    lower: Math.min(lower, upper), upper: Math.max(lower, upper), width,
    premiumToQuoteMultiplier: multiplier,
  };
}

function interpolate(left, right, target, field) {
  if (left[field] == null || right[field] == null) return null;
  if (right.logStrike === left.logStrike) return left[field];
  const weight = (target - left.logStrike) / (right.logStrike - left.logStrike);
  return left[field] + weight * (right[field] - left[field]);
}

function strikeSlice(rows, targetStrike) {
  const target = Math.log(targetStrike);
  const sorted = rows.map((row) => ({
    ...row,
    strike: finite(row.strike),
    logStrike: Math.log(finite(row.strike)),
    bidIv: normalizeVol(row.bidIv ?? row.bid_iv),
    askIv: normalizeVol(row.askIv ?? row.ask_iv),
    markIv: normalizeVol(row.markIv ?? row.mark_iv),
  })).filter((row) => row.strike > 0 && Number.isFinite(row.logStrike))
    .sort((left, right) => left.strike - right.strike);
  const below = sorted.filter((row) => row.strike <= targetStrike).at(-1);
  const above = sorted.find((row) => row.strike >= targetStrike);
  if (!below || !above) return null;
  const fields = ['bidIv', 'askIv', 'markIv'];
  const result = { targetStrike, lowerStrike: below.strike, upperStrike: above.strike };
  for (const field of fields) result[field] = interpolate(below, above, target, field);
  // A mark surface remains useful as a lower-fidelity observation when an
  // option wing has no executable bid. Missing bid/ask IV can never be
  // presented as a complete uncertainty interval.
  if (result.markIv == null) return null;
  return result;
}

function interpolateSurfaceVariance({ rows, targetStrike, targetExpiryMs, nowMs }) {
  const targetTime = finite(targetExpiryMs);
  const now = finite(nowMs);
  if (!(targetStrike > 0) || !(targetTime > now)) return null;
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const expiry = finite(row.expiryMs ?? row.expiry_ms ?? row.expiration_timestamp);
    if (!(expiry > now)) continue;
    const group = groups.get(expiry) || [];
    group.push(row);
    groups.set(expiry, group);
  }
  const slices = [...groups.entries()].map(([expiryMs, group]) => ({
    expiryMs, slice: strikeSlice(group, targetStrike),
  })).filter((entry) => entry.slice).sort((left, right) => left.expiryMs - right.expiryMs);
  if (!slices.length) return null;
  const targetT = (targetTime - now) / 1000 / YEAR_SECONDS;
  const lower = slices.filter((entry) => entry.expiryMs <= targetTime).at(-1);
  const upper = slices.find((entry) => entry.expiryMs >= targetTime);
  const volFields = ['bidIv', 'askIv', 'markIv'];
  if (lower && upper && lower.expiryMs !== upper.expiryMs) {
    const lowerT = (lower.expiryMs - now) / 1000 / YEAR_SECONDS;
    const upperT = (upper.expiryMs - now) / 1000 / YEAR_SECONDS;
    const weight = (targetT - lowerT) / (upperT - lowerT);
    const output = { mode: 'TERM_INTERPOLATED', lowerExpiryMs: lower.expiryMs, upperExpiryMs: upper.expiryMs };
    for (const field of volFields) {
      if (lower.slice[field] == null || upper.slice[field] == null) {
        output[field] = null;
        continue;
      }
      const lowerVariance = lower.slice[field] ** 2 * lowerT;
      const upperVariance = upper.slice[field] ** 2 * upperT;
      const variance = lowerVariance + weight * (upperVariance - lowerVariance);
      output[field] = Math.sqrt(Math.max(1e-12, variance / targetT));
    }
    return output;
  }
  const anchor = lower || upper;
  if (!anchor) return null;
  const mode = anchor.expiryMs === targetTime ? 'EXACT_EXPIRY'
    : targetTime < anchor.expiryMs ? 'SHORT_HORIZON_VOL_EXTRAPOLATION' : 'LONG_HORIZON_VOL_EXTRAPOLATION';
  return {
    mode,
    lowerExpiryMs: anchor.expiryMs,
    upperExpiryMs: anchor.expiryMs,
    ...Object.fromEntries(volFields.map((field) => [field, anchor.slice[field]])),
  };
}

function priceBinaryFromSurface({
  rows, spot, strike, targetExpiryMs, nowMs = Date.now(), basisBpsInterval = [0, 0],
  discountRate = 0,
}) {
  const surface = interpolateSurfaceVariance({ rows, targetStrike: strike, targetExpiryMs, nowMs });
  if (!surface) return null;
  const seconds = (targetExpiryMs - nowMs) / 1000;
  const basis = basisBpsInterval.map(finite);
  if (basis.some((value) => value == null)) return null;
  const vols = [surface.bidIv, surface.markIv, surface.askIv].map(normalizeVol).filter(Boolean);
  const spots = basis.map((value) => spot * (1 + value / 10000));
  const valuations = [];
  for (const adjustedSpot of spots) {
    for (const vol of vols) {
      const fair = digitalCashFair({
        spot: adjustedSpot, strike, annualizedVol: vol,
        secondsToExpiry: seconds, discountRate,
      });
      if (fair) valuations.push(fair.presentYes);
    }
  }
  const midpoint = digitalCashFair({
    spot: spot * (1 + (basis[0] + basis[1]) / 20000), strike,
    annualizedVol: surface.markIv, secondsToExpiry: seconds, discountRate,
  });
  if (!valuations.length || !midpoint) return null;
  return {
    fairYes: midpoint.presentYes,
    fairNo: midpoint.presentNo,
    fairYesLower: Math.min(...valuations),
    fairYesUpper: Math.max(...valuations),
    surface,
    ivIntervalComplete: surface.bidIv != null && surface.askIv != null,
    fidelity: surface.bidIv != null && surface.askIv != null
      ? (surface.mode === 'EXACT_EXPIRY' ? 'A'
        : surface.mode === 'TERM_INTERPOLATED' ? 'B' : 'C') : 'D',
  };
}

function deltaHedgeForBinary({ tokenShares, outcome = 'YES', deltaPerShare, spot, quantityStep = 0.001 }) {
  const shares = finite(tokenShares);
  const delta = finite(deltaPerShare);
  const s = finite(spot);
  const step = finite(quantityStep);
  if (!(shares > 0) || delta == null || !(s > 0) || !(step > 0)) return null;
  const direction = String(outcome).toUpperCase() === 'NO' ? -1 : 1;
  const binaryDeltaBase = direction * shares * delta;
  const rawHedgeBase = -binaryDeltaBase;
  const hedgeBase = Math.round(rawHedgeBase / step) * step;
  const residualDeltaBase = binaryDeltaBase + hedgeBase;
  return {
    binaryDeltaBase,
    rawHedgeBase,
    hedgeBase,
    residualDeltaBase,
    residualUsdPerOnePercentMove: residualDeltaBase * s * 0.01,
  };
}

function optimizeBinaryEntry({
  asks, fairLower, budgetUsd, minimumOrderSize, feeRate, feeExponent,
  feeMultiplier = 2, hedgeCostPerShare = 0,
}) {
  const fair = finite(fairLower);
  const budget = finite(budgetUsd);
  const minimum = finite(minimumOrderSize);
  const hedgeCost = Math.max(0, finite(hedgeCostPerShare) ?? 0);
  const rate = finite(feeRate);
  const exponent = finite(feeExponent);
  const levels = (Array.isArray(asks) ? asks : []).map((level) => ({
    price: finite(level?.price ?? level?.[0]), size: finite(level?.size ?? level?.[1]),
  })).filter((level) => level.price > 0 && level.price < 1 && level.size > 0)
    .sort((left, right) => left.price - right.price);
  if (!(fair > 0 && fair < 1) || !(budget > 0) || !(minimum > 0)
    || !(rate >= 0) || !(exponent > 0) || !levels.length) return null;
  const depth = levels.reduce((sum, level) => sum + level.size, 0);
  const evaluate = (shares) => {
    const fill = walkShares(levels, shares, rate, exponent, feeMultiplier, 'ASK');
    if (!fill) return null;
    const cashRequired = fill.gross + fill.fees;
    return {
      shares, fill, cashRequired,
      expectedPayoutLower: shares * fair,
      hedgeCostStress: shares * hedgeCost,
      expectedProfitLower: shares * fair - cashRequired - shares * hedgeCost,
    };
  };
  let affordable = depth;
  let low = 0; let high = depth;
  for (let iteration = 0; iteration < 64; iteration += 1) {
    const middle = (low + high) / 2;
    const result = evaluate(middle);
    if (result && result.cashRequired <= budget + 1e-9) low = middle;
    else high = middle;
  }
  affordable = low;
  if (affordable + 1e-7 < minimum) return null;
  const quantities = new Set([minimum, affordable]);
  let cumulative = 0;
  for (const level of levels) {
    cumulative += level.size;
    if (cumulative >= minimum - 1e-9 && cumulative <= affordable + 1e-9) {
      quantities.add(Math.min(cumulative, affordable));
    }
  }
  const rows = [...quantities].map(evaluate)
    .filter((row) => row && row.cashRequired <= budget + 1e-7)
    .sort((left, right) => right.expectedProfitLower - left.expectedProfitLower
      || left.cashRequired - right.cashRequired);
  const best = rows[0];
  return best && best.expectedProfitLower > 0 ? best : null;
}

function residualScenarioPnl({
  tokenShares, outcome = 'YES', spot, strike, annualizedVol, secondsToExpiry,
  hedgeBase, spotShockBps = 0, volShock = 0, basisShockBps = 0, discountRate = 0,
}) {
  const initial = digitalCashFair({ spot, strike, annualizedVol, secondsToExpiry, discountRate });
  const shockedSpot = spot * (1 + (spotShockBps + basisShockBps) / 10000);
  const shockedVol = Math.max(0.0001, normalizeVol(annualizedVol) + volShock);
  const shocked = digitalCashFair({
    spot: shockedSpot, strike, annualizedVol: shockedVol,
    secondsToExpiry, discountRate,
  });
  if (!initial || !shocked) return null;
  const initialToken = String(outcome).toUpperCase() === 'NO' ? initial.presentNo : initial.presentYes;
  const shockedToken = String(outcome).toUpperCase() === 'NO' ? shocked.presentNo : shocked.presentYes;
  const binaryPnl = tokenShares * (shockedToken - initialToken);
  const hedgePnl = hedgeBase * (shockedSpot - spot);
  return { binaryPnl, hedgePnl, totalPnl: binaryPnl + hedgePnl, shockedSpot, shockedVol };
}

function quantifyResidualRisk(options, scenarioGrid = {}) {
  const spotShocksBps = scenarioGrid.spotShocksBps || [-200, -100, -50, 50, 100, 200];
  const volShocks = scenarioGrid.volShocks || [-0.2, 0, 0.2];
  const basisShocksBps = scenarioGrid.basisShocksBps || [-10, 0, 10];
  const scenarios = [];
  for (const spotShockBps of spotShocksBps) {
    for (const volShock of volShocks) {
      for (const basisShockBps of basisShocksBps) {
        const pnl = residualScenarioPnl({ ...options, spotShockBps, volShock, basisShockBps });
        if (pnl) scenarios.push({ spotShockBps, volShock, basisShockBps, ...pnl });
      }
    }
  }
  const losses = scenarios.map((row) => -row.totalPnl).sort((left, right) => right - left);
  const tailCount = Math.max(1, Math.ceil(losses.length * 0.05));
  return {
    scenarios,
    worstLossUsd: losses[0] || 0,
    cvar95LossUsd: losses.slice(0, tailCount).reduce((sum, value) => sum + value, 0) / tailCount,
  };
}

module.exports = {
  YEAR_SECONDS,
  callSpreadProbabilityBounds,
  deltaHedgeForBinary,
  digitalCashFair,
  interpolateSurfaceVariance,
  normalCdf,
  normalizeVol,
  optimizeBinaryEntry,
  priceBinaryFromSurface,
  quantifyResidualRisk,
  residualScenarioPnl,
};
