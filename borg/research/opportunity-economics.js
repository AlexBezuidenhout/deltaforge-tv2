'use strict';

/**
 * Common conservative economics for low-capacity research opportunities.
 *
 * This module is deliberately side-effect free. It does not place orders and
 * it never converts an observation into live authority. Callers must provide
 * every term on the same USD scale; token prices remain on [0,1] upstream.
 */

const PROOF_CLASSES = Object.freeze({
  DETERMINISTIC_LOCK: 'DETERMINISTIC_LOCK',
  BOUNDED_FAIR_VALUE: 'BOUNDED_FAIR_VALUE',
  STATISTICAL_CONVERGENCE: 'STATISTICAL_CONVERGENCE',
  DIAGNOSTIC: 'DIAGNOSTIC',
});

const MECHANISM_STATUSES = Object.freeze({
  CERTIFIED: 'CERTIFIED',
  RULE_NORMALIZED: 'RULE_NORMALIZED',
  OBSERVATIONAL: 'OBSERVATIONAL',
  UNVERIFIED: 'UNVERIFIED',
});

const ACCEPTED_GRADES = new Set(['A', 'B']);

function finite(value, fallback = null) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? +value.toFixed(digits) : null;
}

function timestamp(value) {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegative(input, field, reasons) {
  const value = finite(input[field]);
  if (value == null || value < 0) {
    reasons.push(`INVALID_${field.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`);
    return null;
  }
  return value;
}

/**
 * Evaluate the desk benchmark:
 *
 * lower-bound payout - executable principal - stressed fees - stressed
 * slippage - full failure reserve > 0.
 *
 * `failureRiskReserveUsd` is a cash reserve, not a fitted failure probability.
 * A missing or unbounded reserve fails closed. This is intentionally harsher
 * than an expected-value estimate for non-atomic bundles.
 */
function evaluateOpportunity(input = {}) {
  const reasons = [];
  const opportunityId = input.opportunityId == null ? null : String(input.opportunityId);
  const program = input.program == null ? null : String(input.program);
  const independentUnit = input.independentUnit == null ? null : String(input.independentUnit);
  if (!opportunityId) reasons.push('MISSING_OPPORTUNITY_ID');
  if (!program) reasons.push('MISSING_PROGRAM');
  if (!independentUnit) reasons.push('MISSING_INDEPENDENT_UNIT');

  const observedAtMs = timestamp(input.observedAt);
  if (observedAtMs == null) reasons.push('INVALID_OBSERVED_AT');

  const payoutLowerUsd = nonNegative(input, 'payoutLowerUsd', reasons);
  const entryPrincipalUsd = nonNegative(input, 'entryPrincipalUsd', reasons);
  const feeStressUsd = nonNegative(input, 'feeStressUsd', reasons);
  const slippageStressUsd = nonNegative(input, 'slippageStressUsd', reasons);
  const failureRiskReserveUsd = nonNegative(input, 'failureRiskReserveUsd', reasons);
  const displayedCapacityUsd = nonNegative(input, 'displayedCapacityUsd', reasons);
  const minimumDeployableUsd = nonNegative(input, 'minimumDeployableUsd', reasons);
  const capitalDurationSec = finite(input.capitalDurationSec);
  if (!(capitalDurationSec > 0)) reasons.push('INVALID_CAPITAL_DURATION_SEC');

  const dataQualityGrade = String(input.dataQualityGrade || 'F').toUpperCase();
  const executionFidelityGrade = String(input.executionFidelityGrade || 'F').toUpperCase();
  if (!ACCEPTED_GRADES.has(dataQualityGrade)) reasons.push('DATA_QUALITY_BELOW_B');
  if (!ACCEPTED_GRADES.has(executionFidelityGrade)) reasons.push('EXECUTION_FIDELITY_BELOW_B');
  if (input.fullDepth !== true) reasons.push('FULL_DEPTH_NOT_PROVED');
  if (input.booksFresh !== true) reasons.push('BOOKS_NOT_FRESH');

  const proofClass = Object.values(PROOF_CLASSES).includes(input.proofClass)
    ? input.proofClass : PROOF_CLASSES.DIAGNOSTIC;
  const mechanismStatus = Object.values(MECHANISM_STATUSES).includes(input.mechanismStatus)
    ? input.mechanismStatus : MECHANISM_STATUSES.UNVERIFIED;
  if (mechanismStatus === MECHANISM_STATUSES.UNVERIFIED) reasons.push('MECHANISM_UNVERIFIED');

  const deployedCapitalUsd = entryPrincipalUsd == null || feeStressUsd == null
    ? null : entryPrincipalUsd + feeStressUsd;
  if (!(deployedCapitalUsd > 0)) reasons.push('NONPOSITIVE_DEPLOYED_CAPITAL');
  if (displayedCapacityUsd != null && minimumDeployableUsd != null
    && displayedCapacityUsd + 1e-9 < minimumDeployableUsd) {
    reasons.push('BELOW_MINIMUM_EXECUTABLE_CAPACITY');
  }

  const numericComplete = [
    payoutLowerUsd, entryPrincipalUsd, feeStressUsd, slippageStressUsd,
    failureRiskReserveUsd, displayedCapacityUsd, minimumDeployableUsd,
  ].every((value) => value != null) && capitalDurationSec > 0;
  const conservativeNetUsd = numericComplete
    ? payoutLowerUsd - entryPrincipalUsd - feeStressUsd
      - slippageStressUsd - failureRiskReserveUsd
    : null;
  if (conservativeNetUsd != null && conservativeNetUsd <= 0) {
    reasons.push('NONPOSITIVE_CONSERVATIVE_NET');
  }

  const paperTestEligible = reasons.length === 0;
  const atomic = input.atomic === true;
  const certifiedLock = paperTestEligible
    && proofClass === PROOF_CLASSES.DETERMINISTIC_LOCK
    && mechanismStatus === MECHANISM_STATUSES.CERTIFIED
    && atomic;
  const roiPct = conservativeNetUsd != null && deployedCapitalUsd > 0
    ? 100 * conservativeNetUsd / deployedCapitalUsd : null;
  const netUsdPerCapitalDay = conservativeNetUsd != null && deployedCapitalUsd > 0
    && capitalDurationSec > 0
    ? (conservativeNetUsd / deployedCapitalUsd) * (86400 / capitalDurationSec)
    : null;

  return Object.freeze({
    opportunityId,
    program,
    independentUnit,
    observedAt: observedAtMs == null ? null : new Date(observedAtMs).toISOString(),
    proofClass,
    mechanismStatus,
    atomic,
    paperOnly: input.paperOnly !== false,
    liveEligible: false,
    paperTestEligible,
    certifiedLock,
    rejectionReasons: [...new Set(reasons)],
    economics: {
      payoutLowerUsd: round(payoutLowerUsd),
      entryPrincipalUsd: round(entryPrincipalUsd),
      feeStressUsd: round(feeStressUsd),
      slippageStressUsd: round(slippageStressUsd),
      failureRiskReserveUsd: round(failureRiskReserveUsd),
      deployedCapitalUsd: round(deployedCapitalUsd),
      displayedCapacityUsd: round(displayedCapacityUsd),
      minimumDeployableUsd: round(minimumDeployableUsd),
      conservativeNetUsd: round(conservativeNetUsd),
      roiPct: round(roiPct),
      capitalDurationSec: round(capitalDurationSec),
      netUsdPerCapitalDay: round(netUsdPerCapitalDay),
    },
    quality: { dataQualityGrade, executionFidelityGrade },
    detail: input.detail || {},
  });
}

function rankOpportunities(rows) {
  return [...rows].sort((left, right) =>
    Number(right.paperTestEligible) - Number(left.paperTestEligible)
    || Number(right.certifiedLock) - Number(left.certifiedLock)
    || finite(right.economics?.conservativeNetUsd, -Infinity)
      - finite(left.economics?.conservativeNetUsd, -Infinity)
    || finite(right.economics?.netUsdPerCapitalDay, -Infinity)
      - finite(left.economics?.netUsdPerCapitalDay, -Infinity)
    || String(left.opportunityId).localeCompare(String(right.opportunityId)));
}

function summarizeOpportunities(rows) {
  const ranked = rankOpportunities(rows);
  const eligible = ranked.filter((row) => row.paperTestEligible);
  const reasonCounts = {};
  for (const row of ranked) for (const reason of row.rejectionReasons) {
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  }
  return {
    observations: ranked.length,
    independentUnits: new Set(ranked.map((row) => row.independentUnit).filter(Boolean)).size,
    paperTestEligible: eligible.length,
    certifiedLocks: ranked.filter((row) => row.certifiedLock).length,
    eligibleConservativeNetUsd: round(eligible.reduce(
      (sum, row) => sum + finite(row.economics?.conservativeNetUsd, 0), 0,
    )),
    rejectionReasons: reasonCounts,
    rows: ranked,
  };
}

module.exports = {
  ACCEPTED_GRADES,
  MECHANISM_STATUSES,
  PROOF_CLASSES,
  evaluateOpportunity,
  finite,
  rankOpportunities,
  summarizeOpportunities,
};
