'use strict';

const { finite } = require('./full-depth-wal-replay');

const EXECUTION_VALIDATION_FORMAT = 'borg-fleet-causal-full-depth-replay-v1';
const DEFAULT_MIN_MARKETS = 20;
const DEFAULT_MIN_COVERAGE_PCT = 80;
const CLASS_RANK = Object.freeze({
  ROBUST_POSITIVE: 0,
  FRAGILE_POSITIVE: 1,
  EXECUTION_NEGATIVE: 2,
  INSUFFICIENT: 3,
  UNSCOREABLE: 4,
});

function identityValue(value, fallback) {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function cohortIdentity(row = {}) {
  return {
    strategy: identityValue(row.strategy, 'unknown'),
    experimentId: identityValue(row.experimentId ?? row.experiment_id, 'unregistered'),
    arm: identityValue(row.arm, 'baseline'),
    phase: identityValue(row.phase, 'eval'),
  };
}

function cohortKey(row = {}) {
  const identity = cohortIdentity(row);
  return [identity.strategy, identity.experimentId, identity.arm, identity.phase]
    .map((value) => `${value.length}:${value}`).join('|');
}

function chronologicalHalves(rows, field) {
  const ordered = [...rows].sort((left, right) =>
    Date.parse(left.availableAt) - Date.parse(right.availableAt)
      || String(left.orderId).localeCompare(String(right.orderId)));
  const split = Math.ceil(ordered.length / 2);
  const sum = (selected) => selected.reduce((total, row) =>
    total + (row.executionState === 'ELIGIBLE_FILL' ? finite(row[field], 0) : 0), 0);
  return {
    n: ordered.length,
    first: sum(ordered.slice(0, split)),
    second: sum(ordered.slice(split)),
  };
}

function summarizeProfile(rows, latencyMs) {
  const selected = rows.filter((row) => Number(row.latencyMs) === Number(latencyMs));
  const scoreable = selected.filter((row) => ['ELIGIBLE_FILL', 'PROVEN_NONFILL']
    .includes(row.executionState));
  const fills = scoreable.filter((row) => row.executionState === 'ELIGIBLE_FILL');
  const stressed = fills.filter((row) => row.detail?.tick_stress_available === true);
  const pnl1xHalves = chronologicalHalves(scoreable, 'pnl1x');
  const pnl2xHalves = chronologicalHalves(scoreable, 'pnl2x');
  const tickHalves = chronologicalHalves(scoreable, 'pnl2xOneTick');
  const sum = (items, field) => items.reduce((total, row) => total + finite(row[field], 0), 0);
  return {
    latencyMs: Number(latencyMs),
    intents: selected.length,
    independentMarkets: new Set(selected.map((row) => row.marketId).filter(Boolean)).size,
    scoreable: scoreable.length,
    scoreableMarkets: new Set(scoreable.map((row) => row.marketId).filter(Boolean)).size,
    coveragePct: selected.length ? 100 * scoreable.length / selected.length : 0,
    fills: fills.length,
    fullFills: fills.filter((row) => row.detail?.full === true).length,
    partialFills: fills.filter((row) => row.detail?.partial === true).length,
    provenNonfills: scoreable.length - fills.length,
    unscoreable: selected.length - scoreable.length,
    tickStressCovered: stressed.length,
    tickStressCoveragePct: fills.length ? 100 * stressed.length / fills.length : 100,
    filledNotionalUsd: fills.reduce((total, row) =>
      total + finite(row.fillPrice, 0) * finite(row.fillSize, 0), 0),
    pnl1x: sum(fills, 'pnl1x'),
    pnl2x: sum(fills, 'pnl2x'),
    pnl2xOneTick: sum(stressed, 'pnl2xOneTick'),
    pnl1xHalves,
    pnl2xHalves,
    pnl2xOneTickHalves: tickHalves,
    wins: fills.filter((row) => finite(row.gross, 0) > 0).length,
    losses: fills.filter((row) => finite(row.gross, 0) < 0).length,
    rejectionReasons: Object.fromEntries([...selected.reduce((counts, row) => {
      if (['ELIGIBLE_FILL', 'PROVEN_NONFILL'].includes(row.executionState)) return counts;
      counts.set(row.executionState, (counts.get(row.executionState) || 0) + 1);
      return counts;
    }, new Map()).entries()].sort()),
  };
}

function classifyProfiles(profiles, options = {}) {
  const minMarkets = Number(options.minMarkets ?? DEFAULT_MIN_MARKETS);
  const minCoveragePct = Number(options.minCoveragePct ?? DEFAULT_MIN_COVERAGE_PCT);
  if (!profiles.length || profiles.every((profile) => profile.scoreable === 0)) {
    return {
      classification: 'UNSCOREABLE', executionValidated: false,
      reason: 'No latency profile has causal A/B full-depth evidence.',
    };
  }
  const minimumMarkets = Math.min(...profiles.map((profile) => profile.scoreableMarkets));
  const minimumCoverage = Math.min(...profiles.map((profile) => profile.coveragePct));
  if (minimumMarkets < minMarkets || minimumCoverage < minCoveragePct) {
    return {
      classification: 'INSUFFICIENT', executionValidated: false,
      reason: minimumMarkets < minMarkets
        ? `${minimumMarkets} archive-covered markets; ${minMarkets} are required for an execution classification.`
        : `Minimum causal-book coverage is ${minimumCoverage.toFixed(1)}%; ${minCoveragePct.toFixed(1)}% is required.`,
    };
  }

  const nonPositive = profiles.filter((profile) => profile.pnl2x <= 0);
  if (nonPositive.length) {
    return {
      classification: 'EXECUTION_NEGATIVE', executionValidated: true,
      reason: `Doubled-cost P&L is non-positive at ${nonPositive.map((row) => `${row.latencyMs}ms`).join(', ')}.`,
    };
  }

  const fragile = profiles.filter((profile) =>
    profile.pnl2xOneTick <= 0
      || profile.tickStressCoveragePct < 100
      || profile.pnl2xHalves.first <= 0
      || profile.pnl2xHalves.second <= 0
      || profile.pnl2xOneTickHalves.first <= 0
      || profile.pnl2xOneTickHalves.second <= 0);
  if (fragile.length) {
    return {
      classification: 'FRAGILE_POSITIVE', executionValidated: true,
      reason: 'Raw replay is positive, but one-tick stress, stress coverage, or a chronological half fails.',
    };
  }
  return {
    classification: 'ROBUST_POSITIVE', executionValidated: true,
    reason: `Positive at ${profiles.map((row) => `${row.latencyMs}ms`).join('/')} after doubled costs and one-tick stress, with both chronological halves positive.`,
  };
}

function summarizeCohort(rows, options = {}) {
  if (!rows.length) throw new Error('Cannot summarize an empty execution cohort');
  const identity = cohortIdentity(rows[0]);
  const profilesMs = options.profilesMs || [100, 250, 500];
  const profiles = profilesMs.map((latencyMs) => summarizeProfile(rows, latencyMs));
  const decision = classifyProfiles(profiles, options);
  const timestamps = rows.map((row) => Date.parse(row.availableAt)).filter(Number.isFinite);
  const worstPnl2x = Math.min(...profiles.map((profile) => profile.pnl2x));
  const worstTickPnl2x = Math.min(...profiles.map((profile) => profile.pnl2xOneTick));
  return {
    ...identity,
    cohortKey: cohortKey(identity),
    ...decision,
    classRank: CLASS_RANK[decision.classification],
    liveReady: false,
    evidenceScope: 'L4_COUNTERFACTUAL_EXECUTION',
    intendedMarkets: Math.max(...profiles.map((profile) => profile.independentMarkets)),
    minimumScoreableMarkets: Math.min(...profiles.map((profile) => profile.scoreableMarkets)),
    minimumCoveragePct: Math.min(...profiles.map((profile) => profile.coveragePct)),
    worstPnl2x,
    worstPnl2xOneTick: worstTickPnl2x,
    firstAt: timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null,
    latestAt: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null,
    profiles,
    guardrail: 'This validates only counterfactual L4 execution on reused paper decisions. Promotion still requires 300 fresh independent markets and an authenticated live pilot.',
  };
}

function buildFleetValidation(results, options = {}) {
  const grouped = new Map();
  for (const row of results) {
    const key = cohortKey(row);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  const cohorts = [...grouped.values()].map((rows) => summarizeCohort(rows, options))
    .sort((left, right) => left.classRank - right.classRank
      || right.worstPnl2xOneTick - left.worstPnl2xOneTick
      || right.worstPnl2x - left.worstPnl2x
      || left.strategy.localeCompare(right.strategy));
  const counts = Object.fromEntries(Object.keys(CLASS_RANK).map((classification) => [
    classification, cohorts.filter((cohort) => cohort.classification === classification).length,
  ]));
  return { cohorts, counts };
}

module.exports = {
  CLASS_RANK,
  DEFAULT_MIN_COVERAGE_PCT,
  DEFAULT_MIN_MARKETS,
  EXECUTION_VALIDATION_FORMAT,
  buildFleetValidation,
  chronologicalHalves,
  classifyProfiles,
  cohortIdentity,
  cohortKey,
  summarizeCohort,
  summarizeProfile,
};
