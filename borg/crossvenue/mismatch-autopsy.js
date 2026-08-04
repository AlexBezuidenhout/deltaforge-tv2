'use strict';

const RULE_FIELDS = Object.freeze([
  'subject', 'predicate', 'comparator', 'strike', 'resolver',
  'observationAt', 'timezone', 'fallback', 'settlementPrecision',
]);

function timestampMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function exactInstant(left, right, toleranceMs = 1000) {
  const a = timestampMs(left);
  const b = timestampMs(right);
  return a != null && b != null && Math.abs(a - b) <= toleranceMs;
}

function increment(object, key) {
  const safe = key || '(none)';
  object[safe] = (object[safe] || 0) + 1;
}

function rank(object) {
  return Object.entries(object).sort((left, right) => right[1] - left[1]
    || left[0].localeCompare(right[0]))
    .map(([name, count]) => ({ name, count }));
}

function fieldStatus(row, field) {
  return row?.exact_rule_audit?.fieldComparisons?.[field]?.status || 'MISSING_AUDIT';
}

function observationClassification(row) {
  const polyEnd = row?.metadata?.poly?.endDate
    || row?.exact_rule_audit?.polyRule?.key?.observationAt;
  const kalshi = row?.metadata?.kalshi || {};
  const expected = kalshi.expectedExpirationTime
    || row?.exact_rule_audit?.kalshiRule?.key?.observationAt;
  const close = kalshi.closeTime;
  const latest = kalshi.latestExpirationTime;
  if (exactInstant(polyEnd, expected)) return 'EXPECTED_EXPIRY_EXACT';
  if (exactInstant(polyEnd, close)) return 'CLOSE_TIME_EXACT_UNCERTIFIED';
  if (exactInstant(polyEnd, latest)) return 'LATEST_EXPIRY_EXACT_UNCERTIFIED';
  const polyMs = timestampMs(polyEnd);
  const closeMs = timestampMs(close);
  if (polyMs == null) return 'POLY_TIME_MISSING';
  if (timestampMs(expected) == null && closeMs == null) return 'KALSHI_TIME_MISSING';
  if (closeMs != null && Math.abs(polyMs - closeMs) <= 60_000) {
    return 'CLOSE_TIME_WITHIN_60S_UNCERTIFIED';
  }
  if (closeMs != null
      && new Date(polyMs).toISOString().slice(0, 10)
        === new Date(closeMs).toISOString().slice(0, 10)) {
    return 'SAME_UTC_DATE_ONLY';
  }
  return 'NO_EXACT_TIME_ALIGNMENT';
}

function autopsyRow(row) {
  const hardReasons = Array.isArray(row.hard_mismatch_reasons)
    ? row.hard_mismatch_reasons : [];
  const unknownReasons = Array.isArray(row.unknown_rule_reasons)
    ? row.unknown_rule_reasons : [];
  const otherFieldStatuses = Object.fromEntries(RULE_FIELDS
    .filter((field) => field !== 'observationAt')
    .map((field) => [field, fieldStatus(row, field)]));
  const allOtherFieldsCertifiedEqual = Object.values(otherFieldStatuses)
    .every((status) => status === 'CERTIFIED_EQUAL');
  const otherHardReasons = hardReasons.filter((reason) => reason !== 'OBSERVATIONAT_MISMATCH');
  const timeClass = observationClassification(row);
  const reviewableTimeSemantics = hardReasons.includes('OBSERVATIONAT_MISMATCH')
    && timeClass === 'CLOSE_TIME_EXACT_UNCERTIFIED'
    && allOtherFieldsCertifiedEqual
    && otherHardReasons.length === 0
    && unknownReasons.length === 0;
  return {
    matchId: row.match_id,
    polyConditionId: row.poly_condition_id || null,
    kalshiTicker: row.kalshi_ticker || null,
    score: Number.isFinite(parseFloat(row.match_score)) ? parseFloat(row.match_score) : null,
    hardReasons,
    unknownReasons,
    otherFieldStatuses,
    observationClassification: timeClass,
    reviewableTimeSemantics,
    automaticEligibility: false,
    polyObservationAt: row?.exact_rule_audit?.polyRule?.key?.observationAt
      || row?.metadata?.poly?.endDate || null,
    kalshiExpectedExpirationAt:
      row?.metadata?.kalshi?.expectedExpirationTime
      || row?.exact_rule_audit?.kalshiRule?.key?.observationAt || null,
    kalshiCloseAt: row?.metadata?.kalshi?.closeTime || null,
  };
}

function buildMismatchAutopsy(rows, options = {}) {
  const normalized = (Array.isArray(rows) ? rows : []).map(autopsyRow);
  const hardReasonCounts = {};
  const unknownReasonCounts = {};
  const observationCounts = {};
  const fieldStatusCounts = Object.fromEntries(RULE_FIELDS.map((field) => [field, {}]));
  for (const [index, row] of normalized.entries()) {
    for (const reason of row.hardReasons) increment(hardReasonCounts, reason);
    for (const reason of row.unknownReasons) increment(unknownReasonCounts, reason);
    increment(observationCounts, row.observationClassification);
    const source = rows[index];
    for (const field of RULE_FIELDS) increment(fieldStatusCounts[field], fieldStatus(source, field));
  }
  const reviewable = normalized.filter((row) => row.reviewableTimeSemantics);
  return {
    format: 'crossvenue-mismatch-autopsy-v1',
    generatedAt: options.now ? new Date(options.now).toISOString() : new Date().toISOString(),
    experimentId: options.experimentId || null,
    contracts: normalized.length,
    exactRuleEligible: (rows || []).filter((row) => row.exact_rule_eligible === true).length,
    hardMismatch: (rows || []).filter((row) => row.hard_mismatch === true).length,
    hardReasons: rank(hardReasonCounts),
    unknownReasons: rank(unknownReasonCounts),
    fieldStatuses: Object.fromEntries(Object.entries(fieldStatusCounts)
      .map(([field, counts]) => [field, rank(counts)])),
    observationTime: {
      classifications: rank(observationCounts),
      closeTimeExactButUncertified: normalized.filter((row) =>
        row.observationClassification === 'CLOSE_TIME_EXACT_UNCERTIFIED').length,
      reviewableAfterEveryOtherFieldPasses: reviewable.length,
      reviewableCandidates: reviewable.slice(0, 100),
    },
    successorDecision: reviewable.length
      ? 'MANUAL_RULE_DOCUMENT_REVIEW_REQUIRED_BEFORE_A_NEW_EXPERIMENT_ID'
      : 'NO_SUCCESSOR_COHORT_JUSTIFIED',
    safety: {
      changesCurrentEligibility: false,
      autoApprovesPairs: false,
      hardMismatchVetoPreserved: true,
      note: 'Kalshi close_time is diagnostic until the rule text proves it is the outcome observation instant rather than a trading cutoff.',
    },
  };
}

module.exports = {
  RULE_FIELDS,
  autopsyRow,
  buildMismatchAutopsy,
  exactInstant,
  observationClassification,
  timestampMs,
};
