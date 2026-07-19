'use strict';

/**
 * Bregman projection and fixed-bundle depth optimization.
 *
 * A logical component is represented by its permitted terminal-state payoff
 * vectors. Frank-Wolfe projects incoherent quoted marginals onto their convex
 * hull without inventing a probability model. The depth optimizer is a
 * separate executable calculation: it walks every leg, applies the market's
 * fee schedule, respects minimum sizes and maximizes guaranteed dollar profit
 * for an equal-share payoff proof. Neither function has a database, wallet,
 * network, or order-submission dependency.
 */

const EPSILON = 1e-10;

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clipProbability(value) {
  const parsed = finite(value);
  if (parsed == null) throw new Error('probability must be finite');
  return Math.max(EPSILON, Math.min(1 - EPSILON, parsed));
}

function dot(left, right) {
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

function validateStates(statePayoffs, dimension) {
  if (!Array.isArray(statePayoffs) || !statePayoffs.length) {
    throw new Error('at least one permitted terminal state is required');
  }
  return statePayoffs.map((state) => {
    if (!Array.isArray(state) || state.length !== dimension) {
      throw new Error('terminal-state payoff dimension mismatch');
    }
    return state.map((value) => {
      const parsed = finite(value);
      if (parsed == null || parsed < 0 || parsed > 1) {
        throw new Error('marginal payoffs must be on the 0-1 token scale');
      }
      return parsed;
    });
  });
}

function bernoulliKl(marginals, quoted, weights = null) {
  if (!Array.isArray(marginals) || marginals.length !== quoted?.length) {
    throw new Error('KL vectors must have the same dimension');
  }
  return marginals.reduce((sum, value, index) => {
    const mu = clipProbability(value);
    const theta = clipProbability(quoted[index]);
    const weight = finite(weights?.[index]) ?? 1;
    if (!(weight > 0)) throw new Error('KL weights must be positive');
    return sum + weight * (mu * Math.log(mu / theta)
      + (1 - mu) * Math.log((1 - mu) / (1 - theta)));
  }, 0);
}

function generalizedSimplexKl(distribution, reference) {
  if (!Array.isArray(distribution) || distribution.length !== reference?.length
    || !distribution.length) throw new Error('simplex KL vectors must have the same dimension');
  const left = distribution.map(finite);
  const right = reference.map(finite);
  if (left.some((value) => value == null || value < 0)
    || right.some((value) => value == null || value <= 0)) {
    throw new Error('simplex KL requires non-negative mass and a positive reference');
  }
  const leftTotal = left.reduce((sum, value) => sum + value, 0);
  const rightTotal = right.reduce((sum, value) => sum + value, 0);
  if (!(leftTotal > 0) || !(rightTotal > 0)) throw new Error('simplex mass must be positive');
  return left.reduce((sum, value, index) => {
    if (value === 0) return sum;
    const mu = value / leftTotal;
    const theta = right[index] / rightTotal;
    return sum + mu * Math.log(mu / theta);
  }, 0);
}

function bernoulliGradient(marginals, quoted, weights) {
  return marginals.map((value, index) => {
    const mu = clipProbability(value);
    const theta = clipProbability(quoted[index]);
    const weight = finite(weights?.[index]) ?? 1;
    return weight * (Math.log(mu / (1 - mu)) - Math.log(theta / (1 - theta)));
  });
}

function lineSearchDirection(marginals, direction, maxGamma, quoted, weights) {
  const derivative = (gamma) => {
    const point = marginals.map((value, index) => value + gamma * direction[index]);
    return dot(direction, bernoulliGradient(point, quoted, weights));
  };
  if (derivative(maxGamma) <= 0) return maxGamma;
  let low = 0;
  let high = maxGamma;
  for (let iteration = 0; iteration < 64; iteration += 1) {
    const middle = (low + high) / 2;
    if (derivative(middle) <= 0) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

function projectMarginalsFrankWolfe({
  statePayoffs, quotedMarginals, weights = null, tolerance = 1e-9, maxIterations = 2000,
}) {
  if (!Array.isArray(quotedMarginals) || !quotedMarginals.length) {
    throw new Error('quoted marginals are required');
  }
  const quoted = quotedMarginals.map(clipProbability);
  const states = validateStates(statePayoffs, quoted.length);
  const stateWeights = new Array(states.length).fill(1 / states.length);
  let marginals = quoted.map((_value, dimension) =>
    states.reduce((sum, state, index) => sum + stateWeights[index] * state[dimension], 0));
  let dualGap = Infinity;
  let iteration = 0;
  for (; iteration < maxIterations; iteration += 1) {
    const gradient = bernoulliGradient(marginals, quoted, weights);
    let oracleIndex = 0;
    let oracleValue = dot(states[0], gradient);
    for (let index = 1; index < states.length; index += 1) {
      const value = dot(states[index], gradient);
      if (value < oracleValue) {
        oracleValue = value;
        oracleIndex = index;
      }
    }
    const vertex = states[oracleIndex];
    dualGap = dot(marginals.map((value, index) => value - vertex[index]), gradient);
    if (dualGap <= tolerance) break;
    // Pairwise Frank-Wolfe transfers mass from the worst active state to the
    // linear-minimization oracle. Unlike vanilla FW, it can remove an atom and
    // therefore reaches boundary optima such as P(A)=P(B) efficiently.
    const active = stateWeights.map((mass, index) => ({ mass, index }))
      .filter((entry) => entry.mass > EPSILON);
    let awayIndex = active[0].index;
    let awayValue = dot(states[awayIndex], gradient);
    for (const entry of active.slice(1)) {
      const value = dot(states[entry.index], gradient);
      if (value > awayValue) {
        awayValue = value;
        awayIndex = entry.index;
      }
    }
    if (awayIndex === oracleIndex) break;
    const direction = states[oracleIndex].map((value, index) => value - states[awayIndex][index]);
    const gamma = lineSearchDirection(
      marginals, direction, stateWeights[awayIndex], quoted, weights,
    );
    marginals = marginals.map((value, index) => value + gamma * direction[index]);
    stateWeights[awayIndex] -= gamma;
    stateWeights[oracleIndex] += gamma;
  }
  return {
    coherentMarginals: marginals,
    stateWeights,
    divergence: bernoulliKl(marginals, quoted, weights),
    dualGap,
    iterations: iteration,
    converged: dualGap <= tolerance,
    residuals: quoted.map((value, index) => value - marginals[index]),
  };
}

function feePerShare(price, rate = 0, exponent = 1, multiplier = 1) {
  const p = finite(price);
  const r = finite(rate) ?? 0;
  const e = finite(exponent) ?? 1;
  const m = finite(multiplier) ?? 1;
  if (!(p > 0 && p < 1) || r < 0 || !(e > 0) || !(m >= 0)) return null;
  return m * r * Math.pow(p * (1 - p), e);
}

function normalizeLevels(levels, descending = false) {
  return (Array.isArray(levels) ? levels : []).map((level) => ({
    price: finite(level?.price ?? level?.[0]), size: finite(level?.size ?? level?.[1]),
  })).filter((level) => level.price > 0 && level.price < 1 && level.size > 0)
    .sort((left, right) => descending ? right.price - left.price : left.price - right.price);
}

function walkShares(levels, shares, feeRate, feeExponent, feeMultiplier, side = 'ASK') {
  const target = finite(shares);
  if (!(target > 0)) return null;
  let remaining = target;
  let gross = 0;
  let fees = 0;
  const fills = [];
  for (const level of normalizeLevels(levels, side === 'BID')) {
    const size = Math.min(remaining, level.size);
    if (!(size > 0)) continue;
    const unitFee = feePerShare(level.price, feeRate, feeExponent, feeMultiplier);
    if (unitFee == null) return null;
    gross += size * level.price;
    fees += size * unitFee;
    fills.push([level.price, size]);
    remaining -= size;
    if (remaining <= 1e-9) break;
  }
  if (remaining > 1e-7) return null;
  return { shares: target, gross, fees, fills, vwap: gross / target };
}

function optimizeEqualShareBundle({
  legs, guaranteedMinPayout = 1, budgetUsd = Infinity, maxShares = Infinity,
  feeMultiplier = 2,
}) {
  if (!Array.isArray(legs) || legs.length < 2) throw new Error('bundle requires at least two legs');
  const payout = finite(guaranteedMinPayout);
  if (!(payout > 0)) throw new Error('guaranteed payout must be positive');
  const normalized = legs.map((leg) => ({
    asks: normalizeLevels(leg.asks), bids: normalizeLevels(leg.bids, true),
    feeRate: finite(leg.feeRate),
    feeExponent: finite(leg.feeExponent),
    minOrderSize: Math.max(0, finite(leg.minOrderSize) ?? 0),
  }));
  if (normalized.some((leg) => !leg.asks.length || !(leg.feeRate >= 0)
    || !(leg.feeExponent > 0))) return null;
  const depth = Math.min(finite(maxShares) ?? Infinity,
    ...normalized.map((leg) => leg.asks.reduce((sum, level) => sum + level.size, 0)));
  const minimum = Math.max(...normalized.map((leg) => leg.minOrderSize), EPSILON);
  if (!(depth + 1e-9 >= minimum)) return null;
  const evaluate = (shares) => {
    const fills = normalized.map((leg) => walkShares(
      leg.asks, shares, leg.feeRate, leg.feeExponent, feeMultiplier, 'ASK',
    ));
    if (fills.some((fill) => !fill)) return null;
    const grossCost = fills.reduce((sum, fill) => sum + fill.gross, 0);
    const fees = fills.reduce((sum, fill) => sum + fill.fees, 0);
    const cashRequired = grossCost + fees;
    return {
      shares, fills, grossCost, fees, cashRequired,
      guaranteedPayout: shares * payout,
      guaranteedProfit: shares * payout - cashRequired,
    };
  };
  let affordable = depth;
  const budget = finite(budgetUsd) ?? Infinity;
  if (Number.isFinite(budget)) {
    let low = 0;
    let high = depth;
    for (let iteration = 0; iteration < 64; iteration += 1) {
      const middle = (low + high) / 2;
      const row = evaluate(middle);
      if (row && row.cashRequired <= budget + 1e-9) low = middle;
      else high = middle;
    }
    affordable = low;
  }
  if (affordable + 1e-7 < minimum) return null;
  const candidates = new Set([minimum, affordable]);
  for (const leg of normalized) {
    let cumulative = 0;
    for (const level of leg.asks) {
      cumulative += level.size;
      if (cumulative >= minimum - 1e-9 && cumulative <= affordable + 1e-9) {
        candidates.add(Math.min(cumulative, affordable));
      }
    }
  }
  const rows = [...candidates].map(evaluate).filter((row) => row && row.cashRequired <= budget + 1e-7)
    .sort((left, right) => right.guaranteedProfit - left.guaranteedProfit
      || left.cashRequired - right.cashRequired || left.shares - right.shares);
  const best = rows[0];
  if (!best) return null;
  const orphanPnls = normalized.map((leg, index) => {
    const entry = best.fills[index];
    const exit = walkShares(leg.bids, best.shares,
      leg.feeRate, leg.feeExponent, feeMultiplier, 'BID');
    return exit ? exit.gross - exit.fees - entry.gross - entry.fees : null;
  });
  return {
    ...best,
    candidateQuantities: rows.length,
    maximumDepthShares: depth,
    affordableShares: affordable,
    orphanPnls,
    orphanUnwindAvailable: orphanPnls.every((value) => value != null),
    worstOrphanUnwindPnl: orphanPnls.some((value) => value == null)
      ? null : Math.min(...orphanPnls),
  };
}

module.exports = {
  bernoulliKl,
  feePerShare,
  generalizedSimplexKl,
  optimizeEqualShareBundle,
  projectMarginalsFrankWolfe,
  walkShares,
};
