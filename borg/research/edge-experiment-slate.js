'use strict';

const { HYPOTHESES } = require('./edge-mechanism-map');
const { sha256, stableStringify } = require('./contracts');

const FROZEN_AT = '2026-08-03T14:20:00.000Z';

const COMMON_PROMOTION = Object.freeze({
  paperOnly: true,
  authenticatedOrdersAllowed: false,
  liveOrderPath: 'disabled',
  freshEvidenceOnly: true,
  minimumIndependentUnits: 300,
  minimumDaysFrequentCrypto: 14,
  minimumDaysCrossVenueOptionsMaking: 30,
  doubledCosts: true,
  positiveBothChronologicalHalves: true,
  marketAndDayClusteredLowerBoundAboveZero: true,
  familyWiseMultipleTestingCorrection: true,
  requiredLatencyProfilesMs: [100, 250, 500],
  sharedBankrollsUsd: [500, 1000],
  realisticNonFillsPartialFillsQueueAndDepth: true,
  noDominantEventAssetOrDay: true,
  postPaperPilot: 'Only after a separate approval: 50 authenticated $1–$2 fills, then reassess.',
});

const SLATE = Object.freeze([
  {
    rank: 1,
    laneId: 'resolver-chainlink-tail-v1',
    mechanismId: 'R01',
    experimentId: 'h43x-chainlink-tail-residual-v1',
    mode: 'FROZEN_FORWARD_PAPER',
    currentStatus: 'ACTIVE_UNCHANGED',
    evidenceStartedAt: '2026-08-03T12:40:00.000Z',
    independentUnit: 'one resolved market',
    minimumDays: 14,
    primaryMetric: 'net_pnl_2x_clustered_by_market_day',
    entryAuthorization: 'paper intents only through the existing H43-X kernel',
    prerequisite: 'Fresh Chainlink RTDS, certified resolver, frozen q99.5 artifact and executable book.',
    killRule: 'Do not tune. Reject at the registered read if either half is non-positive, clustered LCB is not above zero, or latency/capacity fails.',
    note: 'Current positive result is tiny and not promotion evidence.',
  },
  {
    rank: 2,
    laneId: 'structural-ordered-strike-v1',
    mechanismId: 'S03',
    experimentId: 'structural-ordered-strike-orphan-safe-v1',
    mode: 'DETERMINISTIC_CONTINUOUS_SCANNER',
    currentStatus: 'ACTIVE_NO_QUALIFYING_ECONOMICS',
    evidenceStartedAt: '2026-08-03T12:40:00.000Z',
    independentUnit: 'one certified strike relationship/event',
    minimumDays: 30,
    primaryMetric: 'worst_state_profit_2x_after_orphan_reserve',
    entryAuthorization: 'none until finite-state proof, walked depth and orphan reserve are all positive',
    prerequisite: 'Exact predicate/resolver/time/precision identity and all terminal states compiled.',
    killRule: 'A candidate with any negative terminal state, stale leg, insufficient depth or negative orphan-stressed economics is vetoed.',
    note: 'A scanner may run continuously because it proves identities rather than mining outcome P&L.',
  },
  {
    rank: 3,
    laneId: 'structural-certified-graph-v5',
    mechanismId: 'S01',
    experimentId: 'structural-certified-payoff-graph-v5-orphan-reserve',
    mode: 'DETERMINISTIC_CONTINUOUS_SCANNER',
    currentStatus: 'ACTIVE_NO_QUALIFYING_ECONOMICS',
    evidenceStartedAt: '2026-07-27T13:05:00.000Z',
    independentUnit: 'one certified condition graph/event',
    minimumDays: 30,
    primaryMetric: 'worst_state_profit_after_2x_costs_and_orphan_reserve',
    entryAuthorization: 'none until statewise and executable proof',
    prerequisite: 'Exhaustive state space, immutable rule hashes, current fees, synchronized depth.',
    killRule: 'UNKNOWN rule state, uncovered payoff state or non-positive stressed capacity is an automatic veto.',
    note: 'Arithmetic anomalies without executable economics count as zero opportunities.',
  },
  {
    rank: 4,
    laneId: 'crossvenue-certified-terminal-v1',
    mechanismId: 'X01',
    experimentId: 'crossvenue-certified-terminal-lock-v5',
    mode: 'DETERMINISTIC_CONTINUOUS_SCANNER',
    currentStatus: 'ACTIVE_BLOCKED_NO_CERTIFIED_EQUAL_PAIR',
    evidenceStartedAt: '2026-07-21T14:22:12.875Z',
    independentUnit: 'one certified pair-direction-day',
    minimumDays: 30,
    primaryMetric: 'worst_state_profit_2x_cost_orphan_stressed',
    entryAuthorization: 'paper only after every identity dimension is CERTIFIED_EQUAL',
    prerequisite: 'Subject, predicate, comparator, strike, resolver, instant, timezone, precision and fallback all equal.',
    killRule: 'CERTIFIED_DIFFERENT or UNKNOWN is a hard veto; no risk-free label without a terminal payoff proof.',
    note: 'No cross-venue atomicity is assumed.',
  },
  {
    rank: 5,
    laneId: 'crossvenue-exact-convergence-v7',
    mechanismId: 'X03',
    experimentId: 'crossvenue-exact-rule-convergence-v7',
    mode: 'FROZEN_FORWARD_PAPER_WHEN_ELIGIBLE',
    currentStatus: 'ACTIVE_ZERO_ELIGIBLE_ENTRIES',
    evidenceStartedAt: '2026-08-03T12:40:00.000Z',
    independentUnit: 'first eligible pair/direction/UTC day',
    minimumDays: 30,
    primaryMetric: 'net_convergence_pnl_2x_cost_one_tick',
    entryAuthorization: 'five-share paper state machine only for fully certified pairs',
    prerequisite: 'Synchronized A/B books, per-market Kalshi fees and 5/10/25-share replays.',
    killRule: 'Do not broaden semantic matching to create trades. Reject if 300 clean pair-days fail post-four-fee P&L and mismatch stress.',
    note: 'Convergence is risky statistical arbitrage, never automatically risk-free.',
  },
  {
    rank: 6,
    laneId: 'options-exact-expiry-v4',
    mechanismId: 'O01',
    experimentId: 'options-exact-expiry-residual-v4',
    mode: 'COLLECT_ONLY_UNTIL_A_GRADE',
    currentStatus: 'ACTIVE_COLLECTOR_ZERO_EXECUTABLE_TARGETS',
    evidenceStartedAt: '2026-08-03T12:40:00.000Z',
    independentUnit: 'one exact-expiry prediction market',
    minimumDays: 30,
    primaryMetric: 'realized_pnl_after_2x_fees_depth_and_hedge_cost',
    entryAuthorization: 'none for term interpolation; paper only after exact-expiry A-grade mapping',
    prerequisite: 'Exact expiry/observation mapping, sequenced bid/ask IV and executable perpetual hedge.',
    killRule: 'DVOL or unsupported interpolation remains diagnostic and cannot count as a trade.',
    note: 'The current zero-entry result is the honest result, not a collector failure.',
  },
  {
    rank: 7,
    laneId: 'resolver-timestamp-precision-v1',
    mechanismId: 'R07',
    experimentId: 'resolver-timestamp-precision-audit-v1',
    mode: 'CHEAP_FALSIFICATION_ONLY',
    currentStatus: 'FROZEN_NOT_STARTED',
    evidenceStartedAt: null,
    independentUnit: 'one unique rule/cutoff/source combination',
    minimumDays: 30,
    primaryMetric: 'count_and_capacity_of_statewise_proved_precision_dislocations',
    entryAuthorization: 'none; audit/scanner output only',
    prerequisite: 'Machine-readable cutoff inclusivity, source timestamp precision and terminal tick provenance.',
    killRule: 'Reject if rules are ambiguous or no positive doubled-cost statewise proof exists in a bounded 30-day scan.',
    note: 'This is selected for cheap falsification, not because it has observed P&L.',
  },
  {
    rank: 8,
    laneId: 'semantic-condition-proposer-v1',
    mechanismId: 'N09',
    experimentId: 'semantic-condition-graph-proposer-v1',
    mode: 'DISCOVERY_TOOL_NO_TRADING',
    currentStatus: 'FROZEN_BUILD_NEXT',
    evidenceStartedAt: null,
    independentUnit: 'one proposed relationship before deterministic verification',
    minimumDays: 30,
    primaryMetric: 'verified_novel_relationships_per_100_reviewed_with_zero_false_proofs',
    entryAuthorization: 'none; AI can propose but never certify or trade',
    prerequisite: 'Immutable source rules and deterministic finite-state verifier.',
    killRule: 'Any unverified AI relation is discarded; measured value is verifier-approved coverage, not model confidence.',
    note: 'This expands neglected-contract coverage without weakening proof standards.',
  },
  {
    rank: 9,
    laneId: 'fair-bound-passive-observation-v1',
    mechanismId: 'M01',
    experimentId: 'fair-bound-one-sided-passive-observation-v1',
    mode: 'OBSERVATION_ONLY',
    currentStatus: 'FROZEN_BUILD_AFTER_REPLAY',
    evidenceStartedAt: null,
    independentUnit: 'one flat-to-flat quote episode/market session',
    minimumDays: 30,
    primaryMetric: 'queue_stressed_5s_and_30s_markout_after_actual_fee_reward',
    entryAuthorization: 'none until public replay passes; later paper quotes still receive zero queue credit by default',
    prerequisite: 'Independent fair interval, queue-ahead, partial-fill and cancel-ack model.',
    killRule: 'Reject if lower-bound spread/reward does not exceed adverse markout at 100/250/500 ms.',
    note: 'Generic public-flow and symmetric maker results remain negative controls.',
  },
  {
    rank: 10,
    laneId: 'main-longshot-successor-v1',
    mechanismId: 'Q02',
    experimentId: 'main-longshot-0-20-v1',
    mode: 'FROZEN_FORWARD_PAPER_CONTROL',
    currentStatus: 'ACTIVE_UNCHANGED_LOW_PRIORITY',
    evidenceStartedAt: '2026-08-03T12:40:00.000Z',
    independentUnit: 'one resolved market',
    minimumDays: 14,
    primaryMetric: 'net_pnl_2x_clustered_by_market_day',
    entryAuthorization: 'paper intents only through the exact first-intent wrapper',
    prerequisite: 'Unchanged source intent and executable price in the frozen 1–20¢ interval.',
    killRule: 'No price-band retuning. Evaluate only at 300 markets/14 days with family-wise correction across every inspected MAIN band.',
    note: 'Fresh evidence currently starts with a loss; discovery profit is excluded.',
  },
]);

function mechanismById(id) {
  return HYPOTHESES.find((row) => row.id === id) || null;
}

function validateSlate(slate = SLATE) {
  if (slate.length > 10) throw new Error(`at most ten incubator lanes are permitted; found ${slate.length}`);
  if (slate.length !== 10) throw new Error(`the frozen slate requires ten lanes; found ${slate.length}`);
  const laneIds = new Set();
  const experimentIds = new Set();
  for (const lane of slate) {
    if (laneIds.has(lane.laneId)) throw new Error(`duplicate lane ${lane.laneId}`);
    if (experimentIds.has(lane.experimentId)) throw new Error(`duplicate experiment ${lane.experimentId}`);
    laneIds.add(lane.laneId);
    experimentIds.add(lane.experimentId);
    if (!mechanismById(lane.mechanismId)) throw new Error(`unknown mechanism ${lane.mechanismId}`);
    if (/live/i.test(lane.entryAuthorization) && !/paper/i.test(lane.entryAuthorization)) {
      throw new Error(`${lane.laneId}: non-paper authorization is prohibited`);
    }
    for (const field of ['mode', 'currentStatus', 'independentUnit', 'primaryMetric', 'prerequisite', 'killRule', 'note']) {
      if (!lane[field]) throw new Error(`${lane.laneId}: ${field} is required`);
    }
  }
  return true;
}

function slateDocument() {
  validateSlate();
  const core = {
    format: 'deltaforge-edge-experiment-slate-v1',
    frozenAt: FROZEN_AT,
    mandate: 'paper research only; no authenticated/live-order authorization',
    commonPromotion: COMMON_PROMOTION,
    lanes: SLATE.map((lane) => ({
      ...lane,
      mechanismTitle: mechanismById(lane.mechanismId).title,
      mechanismScore: mechanismById(lane.mechanismId).score.total,
    })),
  };
  return { ...core, manifestHash: sha256(stableStringify(core)) };
}

function renderSlate(document = slateDocument()) {
  const rows = document.lanes.map((lane) =>
    `| ${lane.rank} | ${lane.laneId} | ${lane.mechanismId} | ${lane.mode} | ${lane.currentStatus} | ${lane.primaryMetric} |`);
  const lines = [
    '# Frozen edge experiment slate',
    '',
    `Frozen: ${document.frozenAt}; manifest SHA-256: \`${document.manifestHash}\`.`,
    '',
    'This is the maximum ten-lane incubator. It contains deterministic scanners and collection lanes as well as statistical forward tests; it does **not** authorize ten trading bots. Only H43-X and the exact longshot successor currently emit paper intents. No lane authorizes authenticated or live orders.',
    '',
    '| Rank | Lane | Mechanism | Mode | Current status | Primary metric |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '## Common promotion and rejection contract',
    '',
    `- Minimum fresh independent units: ${document.commonPromotion.minimumIndependentUnits}.`,
    `- Minimum duration: ${document.commonPromotion.minimumDaysFrequentCrypto} days for frequent crypto; ${document.commonPromotion.minimumDaysCrossVenueOptionsMaking} days for cross-venue/options/making.`,
    '- Positive doubled-cost P&L in both chronological halves; market/day-clustered lower confidence bound above zero; family-wise multiple-testing correction.',
    `- Positive execution at ${document.commonPromotion.requiredLatencyProfilesMs.join('/')} ms with realistic non-fills, partial fills, queue and depth.`,
    `- Shared finite bankroll replays at $${document.commonPromotion.sharedBankrollsUsd.join(' and $')}; no dominant event, asset or day.`,
    `- ${document.commonPromotion.postPaperPilot}`,
    '',
  ];
  for (const lane of document.lanes) {
    lines.push(
      `## ${lane.rank}. ${lane.laneId}`,
      '',
      `Mechanism: ${lane.mechanismId} — ${lane.mechanismTitle}. Existing/new experiment identity: \`${lane.experimentId}\`.`,
      '',
      `Status: **${lane.currentStatus}**; mode: **${lane.mode}**.`,
      '',
      `- Entry authority: ${lane.entryAuthorization}`,
      `- Independent unit: ${lane.independentUnit}; minimum duration: ${lane.minimumDays} days.`,
      `- Prerequisite: ${lane.prerequisite}`,
      `- Primary metric: ${lane.primaryMetric}`,
      `- Frozen kill/rejection rule: ${lane.killRule}`,
      `- Evidence note: ${lane.note}`,
      '',
    );
  }
  return `${lines.join('\n')}\n`;
}

module.exports = {
  COMMON_PROMOTION,
  FROZEN_AT,
  SLATE,
  mechanismById,
  renderSlate,
  slateDocument,
  validateSlate,
};
