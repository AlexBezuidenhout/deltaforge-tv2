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
    entryEconomic: Boolean(row.entry_economic ?? row.entryEconomic),
    identityApproved: Boolean(row.identity_approved ?? row.identityApproved),
    relationApproved: Boolean(row.relation_approved ?? row.relationApproved
      ?? row.identity_approved ?? row.identityApproved),
    booksFresh: Boolean(row.books_fresh ?? row.booksFresh),
    fullEntryDepth: Boolean(row.full_entry_depth ?? row.fullEntryDepth),
    fullExitDepth: Boolean(row.full_exit_depth ?? row.fullExitDepth),
    quality: String(row.data_quality_grade ?? row.dataQualityGrade ?? 'F'),
    fidelity: String(row.execution_fidelity_grade ?? row.executionFidelityGrade ?? 'F'),
  };
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
    const key = `${sample.matchId}:${sample.direction}:${sample.quantity}`;
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
      if (!entry.entryEconomic) { armed = true; continue; }
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
  const horizons = HORIZONS_MS.map((horizonMs) => ({
    label: HORIZON_LABELS.get(horizonMs), horizonMs, ...kmAt(episodes, horizonMs),
  }));
  const eventDurations = episodes.filter((row) => row.event).map((row) => row.durationMs).sort((a, b) => a - b);
  let medianMs = null;
  for (const horizon of horizons) {
    if (horizon.probability != null && horizon.probability >= 0.5) { medianMs = horizon.horizonMs; break; }
  }
  return {
    episodes: episodes.length,
    pairs: new Set(episodes.map((row) => row.matchId)).size,
    observedProfitableExits: eventDurations.length,
    rightCensored: episodes.length - eventDurations.length,
    medianTimeToProfitableMs: medianMs,
    observedMedianEventMs: eventDurations.length ? eventDurations[Math.floor(eventDurations.length / 2)] : null,
    horizons,
  };
}

function summarizeConvergence(rows, options = {}) {
  const episodes = buildConvergenceEpisodes(rows, options);
  const approved = episodes.filter((row) => row.relationApproved);
  const eligible = (rows || []).map(normalizeSample).filter(eligibleSample)
    .sort((a, b) => a.observedAt - b.observedAt);
  const firstAt = eligible.length ? new Date(eligible[0].observedAt).toISOString() : null;
  const lastAt = eligible.length ? new Date(eligible.at(-1).observedAt).toISOString() : null;
  const spanDays = firstAt && lastAt ? (Date.parse(lastAt) - Date.parse(firstAt)) / 86_400_000 : 0;
  return {
    methodology: 'First profitable executable liquidation after fixed ask-side entry; entry and exit fees charged on all four legs; Kaplan-Meier right-censoring.',
    horizons: HORIZONS_MS.map((ms) => HORIZON_LABELS.get(ms)),
    coverage: { firstAt, lastAt, spanDays, samples: eligible.length },
    approvedEvidence: summarizeCohort(approved),
    unapprovedDiagnostic: summarizeCohort(episodes),
    evidenceReady: approved.length >= 300 && spanDays >= 30,
    warning: 'Unproved text matches are discovery diagnostics, not deployable convergence evidence.',
  };
}

module.exports = {
  HORIZONS_MS, baseEligibleSample, buildConvergenceEpisodes,
  eligibleEntrySample, eligibleExitSample, eligibleSample, kmAt,
  normalizeSample, summarizeCohort, summarizeConvergence,
};
