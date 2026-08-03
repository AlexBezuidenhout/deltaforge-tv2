'use strict';

const { SLATE, slateDocument } = require('./edge-experiment-slate');
const { buildPriorityLaneStatus } = require('./priority-lane-status');

const STRATEGY_BY_LANE = Object.freeze({
  'resolver-chainlink-tail-v1': 'H43X_chainlink_tail_residual_v1',
  'main-longshot-successor-v1': 'MAIN_LONGSHOT_0_20_V1',
});

const PROGRAM_BY_LANE = Object.freeze({
  'structural-ordered-strike-v1': 'certified_payoff_graph',
  'structural-certified-graph-v5': 'certified_payoff_graph',
  'crossvenue-certified-terminal-v1': 'rule_aware_crossvenue',
  'crossvenue-exact-convergence-v7': 'rule_aware_crossvenue',
  'options-exact-expiry-v4': 'options_implied_binary_residual',
  'fair-bound-passive-observation-v1': 'fair_bound_passive_overlay',
});

function finite(value, fallback = 0) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function strategyEvidenceMap(rows = []) {
  return new Map(rows.map((row) => [row.strategy, {
    strategy: row.strategy,
    runtimeActive: row.runtime_active === true,
    evaluations: finite(row.evaluations), actions: finite(row.actions), errors: finite(row.errors),
    fills: finite(row.fills), markets: finite(row.markets), days: finite(row.days),
    pnl2x: finite(row.pnl_2x), latest: row.latest || null,
    first: row.first || null,
  }]));
}

function addDays(iso, days) {
  const value = Date.parse(iso || '');
  return Number.isFinite(value) ? new Date(value + days * 86_400_000).toISOString() : null;
}

function laneReadiness(lane, evidence, lifecycle, active, now = new Date()) {
  const statistical = ['resolver-chainlink-tail-v1', 'main-longshot-successor-v1'];
  const targetUnits = lane.mechanismId === 'N09' ? 100 : 300;
  let units = 0;
  let unitsLabel = lane.independentUnit;
  let days = 0;
  let firstEligibleAt = null;
  if (statistical.includes(lane.laneId)) {
    units = finite(evidence.markets);
    days = finite(evidence.days);
    firstEligibleAt = evidence.first || null;
  } else if (lane.laneId.startsWith('structural-')) {
    units = finite(evidence.qualified);
    firstEligibleAt = lane.evidenceStartedAt;
    if (active && firstEligibleAt) {
      days = Math.max(0, Math.ceil((new Date(now) - new Date(firstEligibleAt)) / 86_400_000));
    }
  } else if (lane.laneId === 'crossvenue-certified-terminal-v1') {
    units = finite(evidence.certifiedPairDirectionDays);
    firstEligibleAt = evidence.firstCertifiedAt || null;
    days = finite(evidence.certifiedCalendarDays);
  } else if (lane.laneId === 'crossvenue-exact-convergence-v7') {
    units = finite(evidence.pairDirectionDays);
    firstEligibleAt = evidence.firstEligibleAt || null;
    days = finite(evidence.eligibleCalendarDays);
  } else if (lane.laneId === 'options-exact-expiry-v4') {
    units = finite(evidence.executableMarkets);
    firstEligibleAt = evidence.firstExecutableAt || null;
    days = finite(evidence.executableDays);
  } else if (lane.laneId === 'resolver-timestamp-precision-v1') {
    units = finite(evidence.certifiedUnits);
    firstEligibleAt = evidence.firstCertifiedAt || null;
    days = finite(evidence.certifiedDays);
  } else if (lane.laneId === 'semantic-condition-proposer-v1') {
    units = finite(evidence.reviewedProposals);
    unitsLabel = 'one human-reviewed proposal';
    firstEligibleAt = evidence.firstReviewedAt || null;
    days = finite(evidence.reviewDays);
  } else if (lane.laneId === 'fair-bound-passive-observation-v1') {
    units = finite(evidence.independentFills);
    firstEligibleAt = evidence.firstEligibleAt || null;
    days = finite(evidence.eligibleCalendarDays);
  }
  const minimumDays = finite(lane.minimumDays);
  const unitGate = { id: 'independent_units', status: units >= targetUnits ? 'PASS' : 'PENDING',
    current: units, target: targetUnits, unit: unitsLabel };
  const dayGate = { id: 'calendar_days', status: days >= minimumDays ? 'PASS' : 'PENDING',
    current: days, target: minimumDays, unit: 'UTC calendar days' };
  let decisionState = 'BLOCKED_NO_ELIGIBLE_UNIT';
  if (lifecycle === 'DEAD') decisionState = 'FALSIFIED';
  else if (lane.mechanismId === 'N09' && units < targetUnits) decisionState = 'AWAITING_HUMAN_REVIEW';
  else if (units > 0 && (unitGate.status !== 'PASS' || dayGate.status !== 'PASS')) {
    decisionState = 'ACCRUING_FROZEN_EVIDENCE';
  } else if (unitGate.status === 'PASS' && dayGate.status === 'PASS') {
    decisionState = 'FORMAL_PROMOTION_AUDIT_REQUIRED';
  }
  return {
    decisionState,
    firstEligibleAt,
    earliestCalendarReadAt: addDays(firstEligibleAt, minimumDays),
    sampleProgressPct: targetUnits ? +Math.min(100, 100 * units / targetUnits).toFixed(1) : 0,
    durationProgressPct: minimumDays ? +Math.min(100, 100 * days / minimumDays).toFixed(1) : 0,
    gates: [
      { id: 'paper_only', status: 'PASS', detail: 'No authenticated/live-order authority.' },
      unitGate,
      dayGate,
      { id: 'positive_both_halves_2x_cost', status: 'PENDING_FORMAL_READ' },
      { id: 'market_day_clustered_lcb_above_zero', status: 'PENDING_FORMAL_READ' },
      { id: 'multiple_testing_correction', status: 'PENDING_FORMAL_READ' },
      { id: 'latency_100_250_500ms', status: 'PENDING_FORMAL_READ' },
      { id: 'shared_500_1000_bankroll_capacity', status: 'PENDING_FORMAL_READ' },
    ],
    warning: 'Meeting count and duration gates does not establish profitability; it only triggers the frozen formal read.',
  };
}

function composeEdgeIncubatorStatus({ priority, strategyRows = [], now = new Date() }) {
  const primary = new Map((priority?.lanes || []).map((lane) => [lane.program, lane]));
  const strategies = strategyEvidenceMap(strategyRows);
  const frozenSlate = slateDocument();
  const frozenByLane = new Map(frozenSlate.lanes.map((lane) => [lane.laneId, lane]));
  const lanes = SLATE.map((lane) => {
    const strategy = STRATEGY_BY_LANE[lane.laneId];
    const runtime = strategy ? strategies.get(strategy) : null;
    const programme = PROGRAM_BY_LANE[lane.laneId];
    const inherited = programme ? primary.get(programme) : null;
    let lifecycle = 'PAUSED';
    let status = lane.currentStatus;
    let active = false;
    let evidence = {};
    if (runtime) {
      active = runtime.runtimeActive && runtime.errors === 0;
      lifecycle = active ? 'TESTING' : 'PAUSED';
      status = active ? (runtime.fills ? 'FRESH_FORWARD_FILLS_COLLECTING' : 'ACTIVE_NO_ELIGIBLE_FILL')
        : 'RUNTIME_MISSING_OR_ERROR';
      evidence = runtime;
    } else if (inherited) {
      active = inherited.active;
      lifecycle = lane.mode.includes('COLLECT') || lane.mode.includes('OBSERVATION')
        ? 'COLLECTING' : active ? 'TESTING' : 'PAUSED';
      status = inherited.status;
      evidence = inherited.evidence;
    } else if (lane.mechanismId === 'R07') {
      lifecycle = 'DEAD';
      status = 'FALSIFIED_CURRENT_RULE_WORDING';
      evidence = { scannedRules: 87729, certifiedUnits: 0, positiveEpisodes: 0, capacityUsd: 0 };
    } else if (lane.mechanismId === 'N09') {
      lifecycle = 'DISCOVERY';
      status = 'LEXICAL_BASELINE_COMPLETE_NO_NOVEL_CROSS_EVENT_RELATION';
      evidence = { sourceRules: 19848, typedNodes: 18832, proposals: 998,
        crossEventProposals: 0, ruleCertified: 0, executable: 0 };
    }
    const readiness = laneReadiness(lane, evidence, lifecycle, active, now);
    return {
      priority: lane.rank,
      laneId: lane.laneId,
      mechanismId: lane.mechanismId,
      experimentId: lane.experimentId,
      program: programme || lane.mechanismId,
      mechanismTitle: frozenByLane.get(lane.laneId)?.mechanismTitle,
      lifecycle,
      runMode: lane.mode,
      active,
      status,
      evidence,
      readiness,
      premise: lane.note,
      nextTest: lane.killRule,
      paperOnly: true,
      liveAuthority: false,
    };
  });
  return {
    format: 'deltaforge-edge-incubator-status-v1',
    generatedAt: new Date(now).toISOString(),
    frozenSlateHash: frozenSlate.manifestHash,
    paperOnly: true,
    liveAuthority: false,
    activeStatisticalForwardTrials: lanes.filter((lane) =>
      lane.lifecycle === 'TESTING' && STRATEGY_BY_LANE[lane.laneId]).length,
    lanes,
    warning: 'Lifecycle describes current machinery, not profitability. DEAD means the frozen specification is falsified; it is not silently retuned or inverted.',
  };
}

async function loadStrategyRows(pool) {
  const bindings = Object.entries(STRATEGY_BY_LANE).map(([laneId, strategy]) => {
    const lane = SLATE.find((row) => row.laneId === laneId);
    if (!lane) throw new Error(`missing frozen lane ${laneId}`);
    return { strategy, experimentId: lane.experimentId };
  });
  const strategies = bindings.map((row) => row.strategy);
  const experimentIds = bindings.map((row) => row.experimentId);
  const { rows } = await pool.query(`
    WITH latest AS (
      SELECT run_id,epoch_id,started_at
        FROM borg_collector_runs WHERE status='RUNNING'
       ORDER BY started_at DESC LIMIT 1
    ), names AS (
      SELECT * FROM unnest($1::text[],$2::text[]) AS n(strategy,experiment_id)
    ), runtime AS (
      SELECT r.strategy,true runtime_active,r.evaluations,r.actions,r.errors
        FROM borg_strategy_runtime r JOIN latest l ON l.run_id=r.collector_run_id
        JOIN names n USING(strategy)
    ), scored AS (
      SELECT o.strategy,o.experiment_id,
             count(*) FILTER (WHERE s.filled AND s.data_quality_grade IN ('A','B')
                                                AND s.execution_fidelity_grade IN ('A','B'))::int fills,
             count(DISTINCT o.market_id) FILTER (WHERE s.filled AND s.data_quality_grade IN ('A','B')
                                                AND s.execution_fidelity_grade IN ('A','B'))::int markets,
             count(DISTINCT (o.available_at AT TIME ZONE 'UTC')::date) FILTER (
               WHERE s.filled AND s.data_quality_grade IN ('A','B')
                 AND s.execution_fidelity_grade IN ('A','B'))::int days,
             COALESCE(sum(s.pnl_2x) FILTER (WHERE s.filled AND s.data_quality_grade IN ('A','B')
                                                AND s.execution_fidelity_grade IN ('A','B')),0)::float8 pnl_2x,
             min(o.available_at) FILTER (WHERE s.filled AND s.data_quality_grade IN ('A','B')
                                                AND s.execution_fidelity_grade IN ('A','B')) first,
             max(o.available_at) latest
        FROM borg_shadow_orders o
        JOIN latest l ON o.features->>'collection_epoch_id'=l.epoch_id
        JOIN names n ON n.strategy=o.strategy AND n.experiment_id=o.experiment_id
        LEFT JOIN borg_shadow_scores s ON s.order_id=o.id
       WHERE o.action='place' AND COALESCE(o.available_at,o.ts)>=l.started_at
       GROUP BY o.strategy,o.experiment_id
    )
    SELECT names.strategy,COALESCE(r.runtime_active,false) runtime_active,
           COALESCE(r.evaluations,0) evaluations,COALESCE(r.actions,0) actions,
           COALESCE(r.errors,0) errors,COALESCE(s.fills,0) fills,
           COALESCE(s.markets,0) markets,COALESCE(s.days,0) days,
           COALESCE(s.pnl_2x,0) pnl_2x,s.first,s.latest
      FROM names
      LEFT JOIN runtime r USING(strategy)
      LEFT JOIN scored s USING(strategy,experiment_id)
  `, [strategies, experimentIds]);
  return rows;
}

async function buildEdgeIncubatorStatus(pool, options = {}) {
  const now = options.now || new Date();
  const [priority, strategyRows] = await Promise.all([
    buildPriorityLaneStatus(pool, { now }),
    loadStrategyRows(pool),
  ]);
  return composeEdgeIncubatorStatus({ priority, strategyRows, now });
}

module.exports = {
  PROGRAM_BY_LANE,
  STRATEGY_BY_LANE,
  buildEdgeIncubatorStatus,
  composeEdgeIncubatorStatus,
  laneReadiness,
  loadStrategyRows,
  strategyEvidenceMap,
};
