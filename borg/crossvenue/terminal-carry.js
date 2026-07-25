'use strict';

/**
 * Prospective, paper-only terminal carry for similar (not rule-certified)
 * Polymarket/Kalshi contracts.
 *
 * The historical agreement estimate is clustered by event family. A mismatch
 * is assigned a zero bundle payout even though some realized mismatch states
 * can pay one or two dollars. This deliberately prices wording/resolver risk
 * instead of relabelling similar contracts as deterministic arbitrage.
 */

const {
  evaluateCombination, finite,
} = require('./strategy');

const TERMINAL_CARRY_EXPERIMENT_ID = 'crossvenue-resolver-risk-terminal-carry-v1';
const DEFAULT_MIN_PRIOR_CLUSTERS = 100;
const DEFAULT_Z_SCORE = 1.959963984540054;

function wilsonLower(successes, trials, z = DEFAULT_Z_SCORE) {
  const n = Math.max(0, Math.floor(finite(trials, 0)));
  const wins = Math.max(0, Math.min(n, Math.floor(finite(successes, 0))));
  const score = Math.max(0, finite(z, DEFAULT_Z_SCORE));
  if (!n) return null;
  const p = wins / n;
  const z2 = score * score;
  const denominator = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = score * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, (centre - margin) / denominator);
}

function cumulativeDepth(levels) {
  const output = [];
  let cumulative = 0;
  for (const level of Array.isArray(levels) ? levels : []) {
    const price = finite(level?.[0]);
    const size = finite(level?.[1]);
    if (!(price > 0 && price < 1 && size > 0)) continue;
    cumulative += size;
    output.push(cumulative);
  }
  return output;
}

function roundDown(value, decimals = 4) {
  const scale = 10 ** decimals;
  return Math.floor((finite(value, 0) + 1e-12) * scale) / scale;
}

function candidateRows({
  polyOutcome, kalshiOutcome, polyBook, kalshiBook,
  agreementLower, quantities, minQuantity, maxQuantity,
  totalCapitalUsd, polyCapitalUsd, kalshiCapitalUsd,
  polyFeeRate, polyFeeExponent, kalshiFeeMultiplier,
  polyTick, kalshiTick, booksFresh,
}) {
  const minimum = Math.max(0.0001, finite(minQuantity, 1));
  const maximum = Math.max(minimum, finite(maxQuantity, 10_000));
  const polyDepth = cumulativeDepth(polyBook?.asks);
  const kalshiDepth = cumulativeDepth(kalshiBook?.asks);
  if (!polyDepth.length || !kalshiDepth.length) return [];
  const depthCapacity = Math.min(polyDepth.at(-1), kalshiDepth.at(-1), maximum);
  if (depthCapacity + 1e-9 < minimum) return [];

  const evaluate = (quantity) => evaluateCombination({
    polyOutcome, kalshiOutcome, quantity, polyBook, kalshiBook,
    polyFeeRate, polyFeeExponent, kalshiFeeMultiplier,
    polyTick, kalshiTick,
    identityApproved: false,
    // Internal pricing switch only: agreementLower is a statistical payout
    // lower bound, never persisted or presented as a deterministic proof.
    relationApproved: true,
    relationType: 'STATISTICAL_TERMINAL_CARRY',
    guaranteedMinPayoutPerShare: agreementLower,
    booksFresh,
    totalCapitalUsd, polyCapitalUsd, kalshiCapitalUsd,
  });

  let low = 0;
  let high = depthCapacity;
  for (let iteration = 0; iteration < 48; iteration += 1) {
    const middle = (low + high) / 2;
    const row = evaluate(middle);
    if (row?.budgetFeasible) low = middle;
    else high = middle;
  }
  const affordableCapacity = roundDown(low);
  if (affordableCapacity + 1e-9 < minimum) return [];

  const candidates = new Set();
  const add = (value) => {
    const quantity = roundDown(Math.min(affordableCapacity, finite(value, 0)));
    if (quantity + 1e-9 >= minimum) candidates.add(quantity);
  };
  add(minimum);
  add(affordableCapacity);
  for (const value of quantities || []) add(value);
  for (const value of [...polyDepth, ...kalshiDepth]) add(value);

  return [...candidates].sort((left, right) => left - right)
    .map((quantity) => {
      const row = evaluate(quantity);
      if (!row?.budgetFeasible) return null;
      const immediateUnwindAvailable = row.immediateOrphanUnwindAvailable === true
        && Number.isFinite(finite(row.worstImmediateOrphanUnwindPnl));
      const orphanReserve = immediateUnwindAvailable
        ? Math.max(0, -finite(row.worstImmediateOrphanUnwindPnl, 0)) : null;
      const additionalCostStress = row.polyFee + row.kalshiFee
        + quantity * (Math.max(0, finite(polyTick, 0.01))
          + Math.max(0, finite(kalshiTick, 0.01)));
      const expectedPayoutLower = quantity * agreementLower;
      const expectedProfitBeforeOrphan = expectedPayoutLower - row.totalCost
        - additionalCostStress;
      const expectedProfitLower = orphanReserve == null
        ? null : expectedProfitBeforeOrphan - orphanReserve;
      return {
        direction: `POLY_${polyOutcome}+KALSHI_${kalshiOutcome}`,
        polyOutcome,
        kalshiOutcome,
        quantity,
        polyVwap: row.polyVwap,
        kalshiVwap: row.kalshiVwap,
        polyFee: row.polyFee,
        kalshiFee: row.kalshiFee,
        totalCost: row.totalCost,
        expectedPayoutLower,
        additionalCostStress,
        orphanReserve,
        expectedProfitBeforeOrphan,
        expectedProfitLower,
        expectedRoiLower: expectedProfitLower == null || !(row.totalCost > 0)
          ? null : expectedProfitLower / row.totalCost,
        worstMismatchLoss: -row.totalCost,
        immediateOrphanUnwindAvailable: immediateUnwindAvailable,
        worstImmediateOrphanUnwindPnl: row.worstImmediateOrphanUnwindPnl,
        availableDepthShares: depthCapacity,
        affordableCapacityShares: affordableCapacity,
        polyCashRequired: row.polyCashRequired,
        kalshiCashRequired: row.kalshiCashRequired,
      };
    }).filter(Boolean);
}

function blocker({
  paperEvalApproved, relationApproved, booksFresh,
  dataQualityGrade, executionFidelityGrade, prior, minPriorClusters,
}) {
  if (relationApproved === true) return 'DETERMINISTIC_RELATION_USES_CERTIFIED_LANE';
  if (paperEvalApproved !== true) return 'PAIR_NOT_SCORE_APPROVED_FOR_PAPER_EVALUATION';
  if (booksFresh !== true) return 'BOOKS_NOT_FRESH_AND_SYNCHRONIZED';
  if (!['A', 'B'].includes(dataQualityGrade)) return 'DATA_QUALITY_BELOW_B';
  if (!['A', 'B'].includes(executionFidelityGrade)) return 'EXECUTION_FIDELITY_BELOW_B';
  if (!prior || finite(prior.clusters, 0) < minPriorClusters) {
    return 'INSUFFICIENT_SETTLED_EVENT_CLUSTERS';
  }
  if (!(finite(prior.agreementLower) > 0)) return 'AGREEMENT_LOWER_BOUND_UNAVAILABLE';
  return null;
}

function evaluateTerminalCarry({
  polyBooks, kalshiBooks, prior,
  paperEvalApproved = false, relationApproved = false, booksFresh = false,
  dataQualityGrade = 'F', executionFidelityGrade = 'F',
  quantities = [1, 5, 10, 25, 50, 100],
  minQuantity = 1, maxQuantity = 10_000,
  totalCapitalUsd = 500, polyCapitalUsd = 250, kalshiCapitalUsd = 250,
  polyFeeRate = 0, polyFeeExponent = 1, kalshiFeeMultiplier = 1,
  polyTick = 0.01, kalshiTick = 0.01,
  minPriorClusters = DEFAULT_MIN_PRIOR_CLUSTERS,
}) {
  const minimumPrior = Math.max(1, Math.floor(finite(
    minPriorClusters, DEFAULT_MIN_PRIOR_CLUSTERS,
  )));
  const priorBlocker = blocker({
    paperEvalApproved, relationApproved, booksFresh,
    dataQualityGrade, executionFidelityGrade, prior,
    minPriorClusters: minimumPrior,
  });
  const agreementLower = finite(prior?.agreementLower, 0);
  const directions = [
    ['YES', 'NO'],
    ['NO', 'YES'],
  ];
  return directions.map(([polyOutcome, kalshiOutcome]) => {
    const rows = agreementLower > 0 ? candidateRows({
      polyOutcome,
      kalshiOutcome,
      polyBook: polyBooks?.[polyOutcome],
      kalshiBook: kalshiBooks?.[kalshiOutcome],
      agreementLower,
      quantities,
      minQuantity,
      maxQuantity,
      totalCapitalUsd,
      polyCapitalUsd,
      kalshiCapitalUsd,
      polyFeeRate,
      polyFeeExponent,
      kalshiFeeMultiplier,
      polyTick,
      kalshiTick,
      booksFresh,
    }) : [];
    const ranked = rows.filter((row) => row.expectedProfitLower != null)
      .sort((left, right) => right.expectedProfitLower - left.expectedProfitLower
        || right.expectedRoiLower - left.expectedRoiLower
        || left.quantity - right.quantity);
    const best = ranked[0] || rows[0] || null;
    const reason = priorBlocker
      || (!best ? 'NO_FULL_DEPTH_WITHIN_BANKROLL'
        : !best.immediateOrphanUnwindAvailable ? 'ORPHAN_IMMEDIATE_UNWIND_UNAVAILABLE'
          : !(best.expectedProfitLower > 0) ? 'NONPOSITIVE_CONSERVATIVE_EXPECTED_PROFIT'
            : 'ELIGIBLE');
    return {
      experimentId: TERMINAL_CARRY_EXPERIMENT_ID,
      direction: `POLY_${polyOutcome}+KALSHI_${kalshiOutcome}`,
      polyOutcome,
      kalshiOutcome,
      ...(best || {
        quantity: null,
        polyVwap: null,
        kalshiVwap: null,
        polyFee: null,
        kalshiFee: null,
        totalCost: null,
        expectedPayoutLower: null,
        additionalCostStress: null,
        orphanReserve: null,
        expectedProfitBeforeOrphan: null,
        expectedProfitLower: null,
        expectedRoiLower: null,
        worstMismatchLoss: null,
        immediateOrphanUnwindAvailable: false,
        worstImmediateOrphanUnwindPnl: null,
        availableDepthShares: null,
        affordableCapacityShares: null,
        polyCashRequired: null,
        kalshiCashRequired: null,
      }),
      eligible: reason === 'ELIGIBLE',
      reason,
      agreementLower: agreementLower || null,
      priorClusters: Math.floor(finite(prior?.clusters, 0)),
      priorAllAgreeClusters: Math.floor(finite(prior?.allAgreeClusters, 0)),
      minPriorClusters: minimumPrior,
      payoutModel: 'CLUSTERED_AGREEMENT_WILSON_LOWER; MISMATCH_PAYOUT_ZERO',
      atomic: false,
      paperOnly: true,
    };
  });
}

module.exports = {
  DEFAULT_MIN_PRIOR_CLUSTERS,
  TERMINAL_CARRY_EXPERIMENT_ID,
  evaluateTerminalCarry,
  wilsonLower,
};
