'use strict';

const H43_STRATEGY = 'H43_resolution_boundary_buffer';
const STRUCTURAL_EXPERIMENT_ID = 'structural-certified-payoff-graph-v5-orphan-reserve';
const HEARTBEAT_COMPONENTS = Object.freeze([
  'allmarket_lab', 'crossvenue_lab', 'options_surface', 'pyth_boundary', 'structural_scanner',
]);

function finite(value, fallback = 0) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function ageSeconds(value, nowMs) {
  if (value == null || value === '') return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? Math.max(0, (nowMs - parsed) / 1000) : null;
}

function alive(row, nowMs) {
  const age = row ? ageSeconds(row.beat_at, nowMs) : null;
  return age != null && age < 30;
}

function collectorState(row, nowMs, epochId, progressValue, options = {}) {
  const heartbeatAgeSec = row ? ageSeconds(row.beat_at, nowMs) : null;
  const progressAgeSec = ageSeconds(progressValue, nowMs);
  const uptimeSec = ageSeconds(row?.meta?.processStartedAt, nowMs);
  const maxProgressAgeSec = finite(options.maxProgressAgeSec, 30);
  const minimumUptimeSec = finite(options.minimumUptimeSec, 60);
  const epochMatches = Boolean(epochId)
    && row?.meta?.collectionEpochId === epochId;
  const heartbeatFresh = heartbeatAgeSec != null && heartbeatAgeSec < 30;
  const progressFresh = progressAgeSec != null && progressAgeSec < maxProgressAgeSec;
  const stableProcess = uptimeSec != null && uptimeSec >= minimumUptimeSec;
  let reason = 'HEALTHY';
  if (!row) reason = 'HEARTBEAT_MISSING';
  else if (!epochMatches) reason = 'EPOCH_MISMATCH';
  else if (!heartbeatFresh) reason = 'HEARTBEAT_STALE';
  else if (!stableProcess) reason = 'PROCESS_WARMING_OR_RESTARTING';
  else if (!progressFresh) reason = 'DOMAIN_PROGRESS_STALE';
  return {
    active: epochMatches && heartbeatFresh && stableProcess && progressFresh,
    reason, heartbeatAgeSec, progressAgeSec, uptimeSec, epochMatches,
  };
}

async function buildPriorityLaneStatus(pool, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const heartbeatResult = await pool.query(`
    SELECT component,beat_at,meta FROM system_heartbeats
     WHERE component=ANY($1::text[])`, [HEARTBEAT_COMPONENTS]);
  const heartbeats = Object.fromEntries(heartbeatResult.rows
    .map((row) => [row.component, row]));
  const allMarket = heartbeats.allmarket_lab || null;
  const epochId = allMarket?.meta?.collectionEpochId || null;
  const epochResult = epochId ? await pool.query(`
    SELECT started_at FROM borg_collection_epochs WHERE epoch_id=$1`, [epochId])
    : { rows: [] };
  const epochStart = epochResult.rows[0]?.started_at || null;

  const [h43Result, structuralResult] = await Promise.all([
    epochId ? pool.query(`
      SELECT COALESCE(sum(evaluations),0)::bigint evaluations,
             COALESCE(sum(halted_evaluations),0)::bigint halted_evaluations,
             COALESCE(sum(actions),0)::bigint actions,
             COALESCE(sum(errors),0)::bigint errors,
             max(last_evaluated_at) last_evaluated_at,
             max(last_action_at) last_action_at
        FROM borg_strategy_runtime
       WHERE epoch_id=$1 AND strategy=$2`, [epochId, H43_STRATEGY])
      : Promise.resolve({ rows: [{}] }),
    epochStart ? pool.query(`
      WITH positive AS MATERIALIZED (
        SELECT e.candidate_id,e.evaluated_at,e.economic_candidate,e.qualified,
               e.orphan_safe_profit_2x_usd
          FROM borg_structural_evaluations e
          JOIN borg_structural_candidates c USING(candidate_id)
         WHERE c.universe_id=$1 AND e.evaluated_at >= $2
           AND (e.economic_candidate OR e.qualified)
      ), qualified_rows AS (
        SELECT candidate_id,evaluated_at,
               lag(evaluated_at) OVER (
                 PARTITION BY candidate_id ORDER BY evaluated_at
               ) previous_at
          FROM positive WHERE qualified
      )
      SELECT count(DISTINCT candidate_id)
               FILTER (WHERE economic_candidate)::int economic,
             count(*) FILTER (WHERE economic_candidate)::int economic_observations,
             count(DISTINCT candidate_id)
               FILTER (WHERE qualified)::int qualified,
             count(*) FILTER (WHERE qualified)::int qualified_observations,
             COALESCE((SELECT count(*) FROM qualified_rows
               WHERE previous_at IS NULL
                  OR evaluated_at-previous_at > interval '60 seconds'),0)::int qualified_episodes,
             count(DISTINCT (evaluated_at AT TIME ZONE 'UTC')::date)
               FILTER (WHERE qualified)::int qualified_days,
             max(orphan_safe_profit_2x_usd)
               FILTER (WHERE qualified)::float max_orphan_safe_profit_2x_usd,
             max(evaluated_at) latest
        FROM positive`, [STRUCTURAL_EXPERIMENT_ID, epochStart])
      : Promise.resolve({ rows: [{}] }),
  ]);

  const h43 = h43Result.rows[0] || {};
  const structuralPositive = structuralResult.rows[0] || {};
  const structuralQualifiedEpisodes = finite(
    structuralPositive.qualified_episodes,
    finite(structuralPositive.qualified),
  );
  const structuralMeta = heartbeats.structural_scanner?.meta || {};
  const crossMeta = heartbeats.crossvenue_lab?.meta || {};
  const optionsMeta = heartbeats.options_surface?.meta || {};
  const pythMeta = heartbeats.pyth_boundary?.meta || {};
  const allMarketMeta = allMarket?.meta || {};
  const h43State = collectorState(
    allMarket, now.getTime(), epochId, allMarketMeta.lastEventAt,
  );
  const h43EvaluationAgeSec = ageSeconds(h43.last_evaluated_at, now.getTime());
  const structuralState = collectorState(
    heartbeats.structural_scanner, now.getTime(), epochId, structuralMeta.lastPersistedAt,
    { maxProgressAgeSec: 60 },
  );
  const crossState = collectorState(
    heartbeats.crossvenue_lab, now.getTime(), epochId, crossMeta.lastEvaluationAt,
  );
  const optionsState = collectorState(
    heartbeats.options_surface, now.getTime(), epochId, optionsMeta.lastEventAt,
  );
  const pythHasWindow = finite(pythMeta.marketsInWindow) > 0;
  const pythState = collectorState(
    heartbeats.pyth_boundary, now.getTime(), epochId,
    pythHasWindow ? pythMeta.lastUsableTickAt : heartbeats.pyth_boundary?.beat_at,
    { maxProgressAgeSec: 30 },
  );
  const pythExactFeedActive = pythState.active
    && (!pythHasWindow || pythMeta.feedState === 'LIVE')
    && pythMeta.experimentId === 'pyth-resolver-boundary-transfer-v4-frozen-observation-window'
    && finite(pythMeta.hermes?.metrics?.catalogFailures) === 0
    && finite(pythMeta.hermes?.metrics?.connectFailures) === 0
    && finite(pythMeta.hermes?.metrics?.connectionGaps) === 0
    && finite(pythMeta.hermes?.metrics?.reconfigurationGaps) === 0
    && finite(pythMeta.hermes?.metrics?.parseErrors) === 0;
  const fairCaptureState = collectorState(
    allMarket, now.getTime(), epochId, allMarketMeta.lastEventAt,
  );
  const h43Active = h43State.active && finite(h43.errors) === 0;
  const structuralActive = structuralState.active
    && finite(structuralMeta.persistenceErrors) === 0;
  const crossActive = crossState.active
    && finite(crossMeta.kalshiErrors) === 0;
  const optionsActive = optionsState.active
    && finite(optionsMeta.persistenceErrors) === 0
    && finite(optionsMeta.parseErrors) === 0
    && finite(optionsMeta.refreshErrors) === 0;
  const fairCaptureActive = fairCaptureState.active
    && allMarketMeta.panelMode === 'neglected'
    && allMarketMeta.strategySignalsEnabled === false;

  const lanes = [
    {
      priority: 1, program: 'resolver_boundary_transfer',
      strategy: H43_STRATEGY, runMode: 'PAPER_FORWARD_FROZEN', active: h43Active,
      status: !h43Active ? 'COLLECTOR_STALE_OR_ERROR'
        : finite(h43.actions) > 0 ? 'FORWARD_ACTIONS_COLLECTING'
          : finite(h43.evaluations) > 0 ? 'FORWARD_EVALUATING_NO_ACTION_YET'
            : 'COLLECTOR_ACTIVE_WAITING_FOR_ELIGIBLE_MARKET',
      evidence: {
        evaluations: finite(h43.evaluations), haltedEvaluations: finite(h43.halted_evaluations),
        actions: finite(h43.actions), errors: finite(h43.errors),
        latest: h43.last_evaluated_at || null, lastActionAt: h43.last_action_at || null,
        evaluationAgeSec: h43EvaluationAgeSec,
        liveness: h43State,
        pythExactFeedArm: {
          experimentId: pythMeta.experimentId || null,
          active: pythExactFeedActive,
          feedState: pythMeta.feedState || null,
          markets: finite(pythMeta.markets),
          marketsInWindow: finite(pythMeta.marketsInWindow),
          exactFeeds: finite(pythMeta.symbols),
          signals: finite(pythMeta.signals),
          lastUsableTickAt: pythMeta.lastUsableTickAt || null,
          hermes: pythMeta.hermes || null,
          diagnosticRtds: pythMeta.diagnosticRtds || null,
          liveness: pythState,
        },
      },
      nextTest: 'Preserve H43 unchanged; require causal A/B scoring at 100/250/500ms and the frozen 300-market promotion read.',
    },
    {
      priority: 2, program: 'certified_payoff_graph', runMode: 'PAPER_SCANNER',
      active: structuralActive,
      status: !structuralActive ? 'COLLECTOR_STALE_OR_ERROR'
        : structuralQualifiedEpisodes > 0
          ? 'QUALIFIED_CANDIDATES_REQUIRE_EXECUTION_REVIEW'
          : finite(structuralPositive.economic) > 0
            ? 'NONATOMIC_ECONOMIC_LEADS_REQUIRE_ORPHAN_REVIEW'
            : 'ZERO_ECONOMIC_OR_ATOMIC_QUALIFIED_CANDIDATES',
      evidence: {
        candidates: finite(structuralMeta.candidates),
        catalogCandidates: finite(structuralMeta.catalogCandidates),
        tokens: finite(structuralMeta.tokens), economic: finite(structuralPositive.economic),
        economicObservations: finite(structuralPositive.economic_observations),
        qualified: finite(structuralPositive.qualified),
        qualifiedObservations: finite(structuralPositive.qualified_observations),
        qualifiedEpisodes: structuralQualifiedEpisodes,
        qualifiedDays: finite(structuralPositive.qualified_days),
        maxOrphanSafeProfit2xUsd: finite(
          structuralPositive.max_orphan_safe_profit_2x_usd, null,
        ),
        latest: structuralPositive.latest || null,
        persistenceErrors: finite(structuralMeta.persistenceErrors),
        liveness: structuralState,
      },
      nextTest: 'Continue deterministic rule/payoff proof and rank only executable absolute dollars after full orphan reserve.',
    },
    {
      priority: 3, program: 'rule_aware_crossvenue', runMode: 'PAPER_LIVE_DATA',
      active: crossActive,
      status: !crossActive ? 'COLLECTOR_STALE_OR_ERROR'
        : finite(crossMeta.exactRuleMatches) > 0
          ? 'EXACT_RULE_FORWARD_COHORT_COLLECTING'
          : 'ZERO_COMPLETE_EXACT_RULE_KEYS',
      evidence: {
        pairs: finite(crossMeta.monitoredMatches), approvedMatches: finite(crossMeta.approvedMatches),
        exactRuleMatches: finite(crossMeta.exactRuleMatches),
        hardMismatchMatches: finite(crossMeta.hardMismatchMatches),
        paperApprovedMatches: finite(crossMeta.paperApprovedMatches),
        evaluations: finite(crossMeta.evaluations),
        paperTradeLeads: finite(crossMeta.paperTradeLeads),
        economicLeads: finite(crossMeta.economicLeads),
        lockableNonatomic: finite(crossMeta.lockableNonatomic),
        terminalCarryEntries: finite(crossMeta.terminalCarryEntries),
        terminalCarryPriorClusters: finite(crossMeta.terminalCarry?.prior?.clusters),
        terminalCarryAgreementLower: finite(
          crossMeta.terminalCarry?.prior?.agreementLower, null,
        ),
        liveness: crossState,
      },
      nextTest: 'V6 only: hard-veto every incomplete/mismatched rule key; collect 300 fresh match-direction-days at the frozen 5-share, +1%, one-hour protocol with 5/10/25-share capacity replays.',
    },
    {
      priority: 4, program: 'options_implied_binary_residual',
      runMode: 'PAPER_SURFACE_COLLECTOR', active: optionsActive,
      status: !optionsActive ? 'COLLECTOR_STALE_OR_ERROR'
        : finite(optionsMeta.executableMarks) > 0 ? 'EXECUTABLE_FORWARD_MARKS_COLLECTING'
          : finite(optionsMeta.targets) > 0 ? 'TARGETS_ACTIVE_NO_EXECUTABLE_MARKS'
            : 'SURFACE_COLLECTING_NO_EXECUTABLE_TARGETS',
      evidence: {
        options: finite(optionsMeta.options), targets: finite(optionsMeta.targets),
        polyTokens: finite(optionsMeta.polyTokens), shadowMarks: finite(optionsMeta.shadowMarks),
        executable: finite(optionsMeta.executableMarks),
        exactExpiry: optionsMeta.exactExpiry || null,
        surfaceFidelity: optionsMeta.surfaceFidelity || null,
        executionBarriers: optionsMeta.executionBarriers || null,
        flushRetries: finite(optionsMeta.flushRetries),
        persistenceErrors: finite(optionsMeta.persistenceErrors),
        parseErrors: finite(optionsMeta.parseErrors), refreshErrors: finite(optionsMeta.refreshErrors),
        liveness: optionsState,
      },
      nextTest: 'Use exact-expiry or bounded-interpolation targets only; subtract hedge cost and residual CVaR from the lower-bound edge.',
    },
    {
      priority: 5, program: 'fair_bound_passive_overlay',
      runMode: 'CAPTURE_ONLY_NO_QUOTES', active: false,
      status: fairCaptureActive
        ? 'STAGED_CAPTURE_ACTIVE_STRATEGY_DISABLED' : 'STAGED_NOT_ACTIVE',
      evidence: {
        captureActive: fairCaptureActive,
        selectedMarkets: finite(allMarketMeta.selectedMarkets),
        subscribedTokens: finite(allMarketMeta.subscribedTokens),
        panelMode: allMarketMeta.panelMode || null,
        panelVersion: allMarketMeta.panelVersion || null,
        panelHash: allMarketMeta.panelHash || null,
        frozenMemberships: finite(allMarketMeta.panelMembershipCount),
        strategySignalsEnabled: allMarketMeta.strategySignalsEnabled === true,
        decisions: finite(allMarketMeta.decisions), fills: finite(allMarketMeta.fills),
        liveness: fairCaptureState,
      },
      nextTest: 'Keep quoting disabled until an independently certified A/B lower bound maps to a current token and clears every registered stress.',
    },
  ];

  return {
    format: 'borg-priority-lane-status-v1', generatedAt: now.toISOString(),
    paperOnly: true, liveAuthority: false,
    epoch: { id: epochId, startedAt: epochStart, provisional: true },
    lanes,
    warning: 'Runtime activity is not profitability evidence. Use the offline lane reports for frozen independent-unit PnL and promotion tests.',
  };
}

module.exports = {
  ageSeconds, alive, buildPriorityLaneStatus, collectorState, finite,
};
