'use strict';

const HORIZONS_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
  7 * 24 * 60 * 60_000,
  30 * 24 * 60 * 60_000,
];

const HORIZON_LABELS = new Map([
  [60_000, '1m'], [5 * 60_000, '5m'], [30 * 60_000, '30m'],
  [60 * 60_000, '1h'], [6 * 60 * 60_000, '6h'],
  [24 * 60 * 60_000, '24h'], [7 * 24 * 60 * 60_000, '7d'],
  [30 * 24 * 60 * 60_000, '30d'],
]);

function finite(value, fallback = null) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function flag(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function normalizeSample(row) {
  const observedAt = new Date(row.observed_at ?? row.observedAt).getTime();
  return {
    observedAt,
    matchId: String(row.match_id ?? row.matchId ?? ''),
    direction: String(row.direction || ''),
    quantity: finite(row.quantity),
    entryTotalCost: finite(row.entry_total_cost ?? row.entryTotalCost),
    netLiquidationProceeds: finite(row.net_liquidation_proceeds ?? row.netLiquidationProceeds),
    terminalLockedProfit: finite(row.terminal_locked_profit ?? row.terminalLockedProfit),
    immediateRoundTripPnl: finite(row.immediate_round_trip_pnl ?? row.immediateRoundTripPnl),
    entryEconomic: flag(row.entry_economic ?? row.entryEconomic),
    paperEvalApproved: flag(row.paper_eval_approved ?? row.paperEvalApproved),
    paperEntryEligible: flag(row.paper_entry_eligible ?? row.paperEntryEligible),
    identityApproved: flag(row.identity_approved ?? row.identityApproved),
    relationApproved: flag(row.relation_approved ?? row.relationApproved
      ?? row.identity_approved ?? row.identityApproved),
    exactRuleKey: String(row.exact_rule_key ?? row.exactRuleKey ?? ''),
    exactRuleEligible: flag(row.exact_rule_eligible ?? row.exactRuleEligible),
    hardMismatch: row.hard_mismatch == null && row.hardMismatch == null
      ? true : flag(row.hard_mismatch ?? row.hardMismatch),
    booksFresh: flag(row.books_fresh ?? row.booksFresh),
    fullEntryDepth: flag(row.full_entry_depth ?? row.fullEntryDepth),
    fullExitDepth: flag(row.full_exit_depth ?? row.fullExitDepth),
    quality: String(row.data_quality_grade ?? row.dataQualityGrade ?? 'F'),
    fidelity: String(row.execution_fidelity_grade ?? row.executionFidelityGrade ?? 'F'),
  };
}

function cleanExactRuleSample(sample) {
  return Boolean(sample?.exactRuleKey)
    && sample.exactRuleEligible === true
    && sample.hardMismatch !== true;
}

function baseEligibleSample(sample) {
  return Number.isFinite(sample.observedAt)
    && sample.matchId && sample.direction
    && sample.quantity > 0
    && sample.booksFresh
    && ['A', 'B'].includes(sample.quality) && ['A', 'B'].includes(sample.fidelity);
}

function eligibleEntrySample(sample) {
  return baseEligibleSample(sample) && sample.fullEntryDepth && sample.entryTotalCost != null;
}

function eligibleExitSample(sample) {
  return baseEligibleSample(sample) && sample.fullExitDepth && sample.netLiquidationProceeds != null;
}

function eligibleSample(sample) {
  return eligibleEntrySample(sample) || eligibleExitSample(sample);
}

/**
 * One entry per continuous positive terminal-edge regime. Future samples are
 * used only as executable liquidation marks. An event occurs on the first
 * future sample whose bid-side proceeds cover the frozen entry cost after all
 * four fees. Unobserved outcomes are right-censored.
 */
function buildConvergenceEpisodes(rawRows, { maxHorizonMs = HORIZONS_MS.at(-1) } = {}) {
  const groups = new Map();
  for (const raw of rawRows || []) {
    const sample = normalizeSample(raw);
    if (!baseEligibleSample(sample)) continue;
    const key = [
      sample.matchId,
      sample.direction,
      sample.quantity,
      sample.exactRuleKey || 'NO_EXACT_RULE_KEY',
    ].join(':');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sample);
  }

  const episodes = [];
  for (const samples of groups.values()) {
    samples.sort((a, b) => a.observedAt - b.observedAt);
    let armed = true;
    for (let i = 0; i < samples.length; i += 1) {
      const entry = samples[i];
      if (!eligibleEntrySample(entry)) continue;
      if (!entry.entryEconomic && !entry.paperEntryEligible) { armed = true; continue; }
      if (!armed) continue;
      armed = false;

      let eventAt = null; let eventPnl = null; let bestPnl = -Infinity;
      let lastObservedAt = entry.observedAt;
      for (let j = i + 1; j < samples.length; j += 1) {
        const mark = samples[j];
        const elapsed = mark.observedAt - entry.observedAt;
        if (elapsed > maxHorizonMs) break;
        lastObservedAt = mark.observedAt;
        if (!eligibleExitSample(mark)) continue;
        const pnl = mark.netLiquidationProceeds - entry.entryTotalCost;
        if (Number.isFinite(pnl)) bestPnl = Math.max(bestPnl, pnl);
        if (eventAt == null && pnl >= -1e-9) {
          eventAt = mark.observedAt; eventPnl = pnl;
          break;
        }
      }
      const observedDurationMs = Math.max(0, Math.min(maxHorizonMs, lastObservedAt - entry.observedAt));
      episodes.push({
        matchId: entry.matchId, direction: entry.direction, quantity: entry.quantity,
        entryAt: new Date(entry.observedAt).toISOString(),
        entryTotalCost: entry.entryTotalCost,
        terminalLockedProfit: entry.terminalLockedProfit,
        identityApproved: entry.identityApproved,
        relationApproved: entry.relationApproved,
        exactRuleKey: entry.exactRuleKey,
        exactRuleEligible: entry.exactRuleEligible,
        hardMismatch: entry.hardMismatch,
        paperEvalApproved: entry.paperEvalApproved,
        paperEntryEligible: entry.paperEntryEligible,
        event: eventAt != null,
        durationMs: eventAt == null ? observedDurationMs : eventAt - entry.observedAt,
        eventAt: eventAt == null ? null : new Date(eventAt).toISOString(),
        eventPnl, bestPnl: Number.isFinite(bestPnl) ? bestPnl : null,
        rightCensored: eventAt == null,
      });
    }
  }
  return episodes.sort((a, b) => Date.parse(a.entryAt) - Date.parse(b.entryAt));
}

function pairDirectionDayKey(episode) {
  const at = new Date(episode?.entryAt);
  if (!episode?.matchId || !episode?.direction || Number.isNaN(at.getTime())) return null;
  return `${episode.matchId}:${episode.direction}:${at.toISOString().slice(0, 10)}`;
}

/**
 * Repeated quote regimes from one pair on one day share venue, rule and event
 * risk. Keep the first prospectively eligible episode only; later re-entries
 * remain useful diagnostics but cannot manufacture independent sample size.
 */
function firstEpisodePerPairDirectionDay(episodes) {
  const first = new Map();
  for (const episode of [...(episodes || [])]
    .sort((left, right) => Date.parse(left.entryAt) - Date.parse(right.entryAt))) {
    const key = pairDirectionDayKey(episode);
    if (key && !first.has(key)) first.set(key, episode);
  }
  return [...first.values()];
}

function kmAt(episodes, horizonMs) {
  const observations = episodes.map((row) => ({
    duration: Math.max(0, Math.min(horizonMs, finite(row.durationMs, 0))),
    event: Boolean(row.event) && finite(row.durationMs, Infinity) <= horizonMs,
  })).sort((a, b) => a.duration - b.duration);
  let atRisk = observations.length; let survival = 1; let cursor = 0; let events = 0;
  while (cursor < observations.length) {
    const time = observations[cursor].duration;
    if (time > horizonMs || atRisk <= 0) break;
    let deaths = 0; let censored = 0;
    while (cursor < observations.length && observations[cursor].duration === time) {
      if (observations[cursor].event) deaths += 1; else censored += 1;
      cursor += 1;
    }
    if (deaths) survival *= (1 - deaths / atRisk);
    events += deaths;
    atRisk -= deaths + censored;
  }
  return { probability: observations.length ? 1 - survival : null, events, atRisk };
}

function summarizeCohort(episodes) {
  const independent = firstEpisodePerPairDirectionDay(episodes);
  const firstAt = independent.length ? independent[0].entryAt : null;
  const lastAt = independent.length ? independent.at(-1).entryAt : null;
  const spanDays = firstAt && lastAt
    ? (Date.parse(lastAt) - Date.parse(firstAt)) / 86_400_000
    : 0;
  const horizons = HORIZONS_MS.map((horizonMs) => ({
    label: HORIZON_LABELS.get(horizonMs), horizonMs, ...kmAt(independent, horizonMs),
  }));
  const eventDurations = independent.filter((row) => row.event).map((row) => row.durationMs).sort((a, b) => a - b);
  let medianMs = null;
  for (const horizon of horizons) {
    if (horizon.probability != null && horizon.probability >= 0.5) { medianMs = horizon.horizonMs; break; }
  }
  return {
    episodes: independent.length,
    rawEpisodes: episodes.length,
    repeatedSamePairDirectionDay: episodes.length - independent.length,
    independentPairDirectionDays: independent.length,
    pairs: new Set(independent.map((row) => row.matchId)).size,
    firstAt,
    lastAt,
    spanDays,
    observedProfitableExits: eventDurations.length,
    rightCensored: independent.length - eventDurations.length,
    medianTimeToProfitableMs: medianMs,
    observedMedianEventMs: eventDurations.length ? eventDurations[Math.floor(eventDurations.length / 2)] : null,
    horizons,
  };
}

function summarizeConvergence(rows, options = {}) {
  const episodes = buildConvergenceEpisodes(rows, options);
  const requireExactRule = options.requireExactRule === true;
  const clean = (row) => !requireExactRule || cleanExactRuleSample(row);
  const approved = episodes.filter((row) => clean(row) && row.relationApproved);
  const paper = episodes.filter((row) =>
    clean(row) && row.paperEvalApproved && !row.relationApproved);
  const diagnostic = episodes.filter((row) =>
    !clean(row) || (!row.paperEvalApproved && !row.relationApproved));
  const allEligible = (rows || []).map(normalizeSample).filter(eligibleSample)
    .sort((a, b) => a.observedAt - b.observedAt);
  const eligible = requireExactRule
    ? allEligible.filter(cleanExactRuleSample)
    : allEligible;
  const firstAt = eligible.length ? new Date(eligible[0].observedAt).toISOString() : null;
  const lastAt = eligible.length ? new Date(eligible.at(-1).observedAt).toISOString() : null;
  const spanDays = firstAt && lastAt ? (Date.parse(lastAt) - Date.parse(firstAt)) / 86_400_000 : 0;
  const approvedSummary = summarizeCohort(approved);
  const paperSummary = summarizeCohort(paper);
  return {
    methodology: `First profitable executable liquidation after fixed ask-side entry; entry and exit fees charged on all four legs; Kaplan-Meier right-censoring.${requireExactRule ? ' Entry must carry a complete immutable exact-rule key with no hard mismatch.' : ''}`,
    horizons: HORIZONS_MS.map((ms) => HORIZON_LABELS.get(ms)),
    coverage: { firstAt, lastAt, spanDays, samples: eligible.length },
    diagnosticSamples: allEligible.length - eligible.length,
    approvedEvidence: approvedSummary,
    paperEvaluation: paperSummary,
    unapprovedDiagnostic: summarizeCohort(diagnostic),
    evidenceReady: approvedSummary.independentPairDirectionDays >= 300
      && approvedSummary.spanDays >= 30,
    paperEvaluationReady: paperSummary.independentPairDirectionDays >= 300
      && paperSummary.spanDays >= 14,
    warning: requireExactRule
      ? 'V6 paper rows require a complete exact-rule key and hard-mismatch veto. Certified rows are reported separately; all incomplete or mismatched title candidates remain diagnostics and cannot enter evidence.'
      : 'Legacy score-approved rows are paper tests of an assumed $1 parity relationship. They are not contractual-identity approvals, terminal locks, or live-trading evidence.',
  };
}

module.exports = {
  HORIZONS_MS, baseEligibleSample, buildConvergenceEpisodes, cleanExactRuleSample,
  eligibleEntrySample, eligibleExitSample, eligibleSample, kmAt,
  firstEpisodePerPairDirectionDay, normalizeSample, pairDirectionDayKey,
  summarizeCohort, summarizeConvergence,
};
