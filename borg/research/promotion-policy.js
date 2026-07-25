'use strict';

const REQUIRED_LATENCY_PROFILES_MS = Object.freeze([100, 250, 500]);
const PROMOTION_GRADES = new Set(['A', 'B']);
const MIN_QUALITY_COVERAGE = 0.90;

function finite(value, fallback = null) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function utcDay(value) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
}

function promotionEligibleRow(row) {
  return PROMOTION_GRADES.has(String(row.data_quality_grade || '').toUpperCase())
    && PROMOTION_GRADES.has(String(row.execution_fidelity_grade || '').toUpperCase());
}

function latencyProfileMs(row) {
  const explicit = [
    row.latency_ms,
    row.order_latency_ms,
    row.detail?.order_latency_ms,
    row.detail?.orderLatencyMs,
    row.features?.order_latency_ms,
    row.features?.latency_ms,
  ].map((value) => finite(value)).find((value) => value != null);
  if (explicit != null) return Math.round(explicit);
  const label = String(row.latency_profile || row.latencyProfile || '');
  const milliseconds = /(\d+(?:\.\d+)?)\s*ms/i.exec(label);
  if (milliseconds) return Math.round(Number(milliseconds[1]));
  const seconds = /(?:latency[_-])?(\d+(?:\.\d+)?)\s*s(?:ec)?\b/i.exec(label);
  if (seconds) return Math.round(Number(seconds[1]) * 1000);
  return null;
}

function summarizeLatencyProfiles(rows, required = REQUIRED_LATENCY_PROFILES_MS) {
  const profiles = {};
  for (const latencyMs of required) {
    const subset = rows.filter((row) => latencyProfileMs(row) === latencyMs);
    const eligible = subset.filter(promotionEligibleRow);
    const qualityCoverage = subset.length ? eligible.length / subset.length : 0;
    const pnl2x = eligible.reduce((sum, row) => sum + (finite(row.pnl_2x, 0)), 0);
    profiles[latencyMs] = {
      signals: subset.length,
      eligibleSignals: eligible.length,
      qualityCoverage,
      independentMarkets: new Set(eligible.map((row) => String(row.market_id))).size,
      pnl2x,
      pass: subset.length > 0 && qualityCoverage >= MIN_QUALITY_COVERAGE && pnl2x > 0,
    };
  }
  return {
    requiredMs: [...required],
    profiles,
    pass: required.every((latencyMs) => profiles[latencyMs].pass),
  };
}

function dimensionConcentration(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (key == null || key === '') continue;
    groups.set(String(key), (groups.get(String(key)) || 0) + finite(row.pnl_2x, 0));
  }
  const values = [...groups.entries()].map(([key, pnl2x]) => ({ key, pnl2x }));
  const totalPnl2x = rows.reduce((sum, row) => sum + finite(row.pnl_2x, 0), 0);
  const best = values.sort((left, right) => right.pnl2x - left.pnl2x)[0] || null;
  const leaveBestOutPnl2x = best ? totalPnl2x - best.pnl2x : null;
  return {
    clusters: groups.size,
    totalPnl2x,
    largestContributor: best,
    leaveLargestContributorOutPnl2x: leaveBestOutPnl2x,
    // This is a definition-of-dominance test, not a PnL-tuned percentage:
    // removing the best cluster must leave strictly positive PnL.
    pass: groups.size >= 2 && leaveBestOutPnl2x > 0,
  };
}

function summarizeConcentration(rows) {
  const market = dimensionConcentration(rows, (row) => row.market_id);
  const day = dimensionConcentration(rows, (row) => utcDay(row.available_at));
  const asset = dimensionConcentration(rows, (row) => row.asset || null);
  return { market, day, asset, pass: market.pass && day.pass && asset.pass };
}

function positiveLowerBound(interval) {
  return Array.isArray(interval) && finite(interval[0]) > 0;
}

function evaluatePromotion(summary, options = {}) {
  const adjustedP = finite(options.holmAdjustedP, 1);
  const evidenceEpochPass = options.evidenceEpoch?.promotionEligible === true;
  const shared = options.shared500 || { admittedOrders: 0, pnl2x: 0, pass: false };
  const gates = {
    trialCollecting: summary.trialStatus === 'COLLECTING',
    confirmatoryPhase: summary.phase === 'eval',
    cleanEvidenceEpoch24h: evidenceEpochPass,
    minimumIndependentMarkets: summary.independentMarkets >= summary.minimumIndependentMarkets,
    minimumCalendarDays: summary.calendarDays >= summary.minimumDays,
    qualityAndFidelityAB: summary.qualityCoverage >= MIN_QUALITY_COVERAGE,
    positiveTotalPnl2x: finite(summary.pnl2x, 0) > 0,
    positiveBothChronologicalHalves2x:
      finite(summary.firstHalfPnl2x, 0) > 0 && finite(summary.secondHalfPnl2x, 0) > 0,
    marketClusteredLowerBoundAboveZero: positiveLowerBound(summary.marketClusteredCi95),
    dayClusteredLowerBoundAboveZero: positiveLowerBound(summary.dayClusteredCi95),
    holmFamilyWisePAtMost005: adjustedP <= 0.05,
    latency100250500Positive: summary.latencyProfiles?.pass === true,
    noSingleMarketDayAssetDominance: summary.concentration?.pass === true,
    positiveShared500Capacity: shared.pass === true,
  };
  const pass = Object.values(gates).every(Boolean);
  let verdict;
  if (!gates.trialCollecting) verdict = summary.trialStatus;
  else if (!gates.confirmatoryPhase) verdict = 'PILOT_NOT_EVIDENCE';
  else if (!gates.cleanEvidenceEpoch24h) verdict = 'EVIDENCE_EPOCH_NOT_CLEAN_24H';
  else if (!gates.minimumIndependentMarkets || !gates.minimumCalendarDays) {
    verdict = 'INSUFFICIENT_SAMPLE';
  } else {
    verdict = pass ? 'ELIGIBLE_FOR_TINY_CANARY_REVIEW' : 'REJECTED_OR_NO_DEMONSTRATED_EDGE';
  }
  return {
    verdict,
    pass,
    gates,
    shared500: shared,
    canaryContract: pass ? {
      authenticatedFills: 50,
      orderUsd: [1, 2],
      liveResultsExcludedFromPaperEvidence: true,
      scaleOnlyAfterReconciliation: [5, 10],
      requiredChecks: ['fill price', 'partial/non-fill rate', 'rejection rate', 'post-fee PnL'],
    } : null,
  };
}

module.exports = {
  MIN_QUALITY_COVERAGE,
  PROMOTION_GRADES,
  REQUIRED_LATENCY_PROFILES_MS,
  dimensionConcentration,
  evaluatePromotion,
  latencyProfileMs,
  promotionEligibleRow,
  summarizeConcentration,
  summarizeLatencyProfiles,
};
