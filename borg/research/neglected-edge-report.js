'use strict';

const {
  MECHANISM_STATUSES,
  PROOF_CLASSES,
  evaluateOpportunity,
  finite,
  summarizeOpportunities,
} = require('./opportunity-economics');

const H43_EXPERIMENT_ID = 'research-h43-forward-v1';
const STRUCTURAL_UNIVERSE_ID = 'structural-certified-payoff-graph-v5-orphan-reserve';
const { CURRENT_CROSSVENUE_EXPERIMENT_ID: CROSSVENUE_EXPERIMENT_ID } =
  require('../crossvenue/experiment');
const { OPTIONS_EVIDENCE_START, OPTIONS_EXPERIMENT_ID } =
  require('../options/experiment');

function secondsBetween(later, earlier) {
  const end = new Date(later).getTime();
  const start = new Date(earlier).getTime();
  return Number.isFinite(end) && Number.isFinite(start) && end > start
    ? (end - start) / 1000 : null;
}

function crossVenueExpiry(metadata, observedAt) {
  const values = [
    metadata?.poly?.endDate,
    metadata?.kalshi?.expectedExpirationTime,
    metadata?.kalshi?.latestExpirationTime,
    metadata?.kalshi?.closeTime,
  ].map((value) => new Date(value).getTime()).filter(Number.isFinite);
  if (!values.length) return null;
  return secondsBetween(new Date(Math.max(...values)), observedAt);
}

function h43Verdict(row) {
  const markets = Number(row?.orders || 0);
  const fills = Number(row?.fills || 0);
  const pnl = finite(row?.pnl_2x, 0);
  const fidelity = Number(row?.fidelity_ab || 0);
  if (!markets) return 'NO_FORWARD_OBSERVATIONS';
  if (pnl <= 0) return 'NO_POSITIVE_FORWARD_LEAD';
  if (fidelity < fills) return 'POSITIVE_LEAD_BUT_EXECUTION_FIDELITY_INCOMPLETE';
  if (markets < 300) return 'POSITIVE_LEAD_BUT_UNDERPOWERED';
  return 'APPLY_FROZEN_PROMOTION_TESTS';
}

function structuralOpportunity(row) {
  const shares = finite(row.target_shares);
  const payout = finite(row.guaranteed_min_payout);
  const cost = finite(row.cost_per_bundle);
  const fees = finite(row.fees_2x_per_bundle);
  const targetNotional = finite(row.target_notional_usd, 0);
  return evaluateOpportunity({
    opportunityId: `structural:${row.candidate_id}:${row.latency_ms}`,
    program: 'certified_payoff_graph',
    independentUnit: row.candidate_id,
    observedAt: row.evaluated_at,
    proofClass: PROOF_CLASSES.DETERMINISTIC_LOCK,
    mechanismStatus: row.pass_proof === true && row.pass_rule_certification === true
      ? MECHANISM_STATUSES.CERTIFIED : MECHANISM_STATUSES.UNVERIFIED,
    atomic: row.atomic === true,
    payoutLowerUsd: shares != null && payout != null ? shares * payout : null,
    entryPrincipalUsd: shares != null && cost != null ? shares * cost : null,
    feeStressUsd: shares != null && fees != null ? shares * fees : null,
    slippageStressUsd: 0,
    failureRiskReserveUsd: finite(row.orphan_loss_stress_usd),
    displayedCapacityUsd: finite(row.displayed_notional_usd),
    minimumDeployableUsd: targetNotional,
    capitalDurationSec: secondsBetween(row.end_date, row.evaluated_at),
    dataQualityGrade: row.pass_stale === true && row.pass_quotes === true ? 'B' : 'F',
    executionFidelityGrade: row.pass_fok === true && row.pass_capacity === true ? 'B' : 'F',
    fullDepth: row.pass_fok === true && row.pass_capacity === true,
    booksFresh: row.pass_stale === true && row.pass_quotes === true,
    detail: {
      structureType: row.structure_type,
      displayedProfit2xUsd: finite(row.displayed_profit_2x_usd),
      ruleCertified: row.pass_rule_certification === true,
      payoffProved: row.pass_proof === true,
      orphanRiskPassed: row.pass_orphan_risk === true,
    },
  });
}

function crossVenueOpportunity(row) {
  const quantity = finite(row.quantity);
  const guaranteedPayout = finite(row.guaranteed_min_payout_per_share);
  const totalCost = finite(row.total_cost);
  const rawProfit = finite(row.locked_profit_after_both_fills);
  const stressedProfit = finite(row.stressed_profit);
  const orphanPnl = finite(row.detail?.legRisk?.worstImmediateUnwindPnl);
  const proof = row.relation_approved === true && row.payoff_proof_hash;
  return evaluateOpportunity({
    opportunityId: `crossvenue:${row.opportunity_id}`,
    program: row.relation_type === 'EQUIVALENT'
      ? 'crossvenue_certified_terminal_lock' : 'crossvenue_rule_aware_convergence',
    independentUnit: `${row.match_id}:${row.direction}`,
    observedAt: row.observed_at,
    proofClass: proof ? PROOF_CLASSES.DETERMINISTIC_LOCK : PROOF_CLASSES.STATISTICAL_CONVERGENCE,
    mechanismStatus: proof ? MECHANISM_STATUSES.CERTIFIED
      : row.paper_eval_approved === true ? MECHANISM_STATUSES.RULE_NORMALIZED
        : MECHANISM_STATUSES.UNVERIFIED,
    atomic: false,
    payoutLowerUsd: quantity != null && guaranteedPayout != null
      ? quantity * guaranteedPayout : null,
    // cv total_cost already includes both entry fees. Passing it as principal
    // and feeStress=0 prevents double charging while preserving the identity.
    entryPrincipalUsd: totalCost,
    feeStressUsd: 0,
    slippageStressUsd: rawProfit != null && stressedProfit != null
      ? Math.max(0, rawProfit - stressedProfit) : null,
    failureRiskReserveUsd: orphanPnl == null ? null : Math.max(0, -orphanPnl),
    displayedCapacityUsd: totalCost,
    minimumDeployableUsd: totalCost,
    capitalDurationSec: crossVenueExpiry(row.metadata, row.observed_at),
    dataQualityGrade: row.data_quality_grade,
    executionFidelityGrade: row.execution_fidelity_grade,
    fullDepth: row.full_depth === true,
    booksFresh: row.books_fresh === true,
    detail: {
      direction: row.direction,
      relationType: row.relation_type,
      relationApproved: row.relation_approved === true,
      paperTradeEligible: row.paper_trade_eligible === true,
      rawProfitUsd: rawProfit,
      stressedProfitUsd: stressedProfit,
      nonAtomic: true,
    },
  });
}

function optionOpportunity(row) {
  const optimized = row.detail?.optimized || {};
  const fill = optimized.fill || {};
  const ask = finite(row.poly_ask);
  const minimumSize = finite(row.detail?.minimumOrderSize);
  return evaluateOpportunity({
    opportunityId: `options:${row.id}`,
    program: 'options_implied_binary_residual',
    independentUnit: String(row.market_id),
    observedAt: row.observed_at,
    proofClass: PROOF_CLASSES.BOUNDED_FAIR_VALUE,
    mechanismStatus: row.executable === true && ['A', 'B'].includes(row.surface_fidelity)
      ? MECHANISM_STATUSES.CERTIFIED : MECHANISM_STATUSES.UNVERIFIED,
    atomic: false,
    payoutLowerUsd: finite(optimized.expectedPayoutLower),
    entryPrincipalUsd: finite(fill.gross),
    feeStressUsd: finite(fill.fees),
    slippageStressUsd: finite(row.hedge_cost_stress_usd),
    failureRiskReserveUsd: finite(row.residual_cvar95_usd),
    displayedCapacityUsd: finite(optimized.cashRequired),
    minimumDeployableUsd: ask != null && minimumSize != null ? ask * minimumSize : null,
    capitalDurationSec: secondsBetween(row.target_expiry_at, row.observed_at),
    dataQualityGrade: row.data_quality_grade,
    executionFidelityGrade: row.executable === true ? 'B' : 'F',
    fullDepth: optimized.fill != null,
    booksFresh: finite(row.detail?.bookAgeMs, Infinity) <= 500,
    detail: {
      asset: row.asset,
      side: row.side,
      strike: finite(row.strike),
      surfaceFidelity: row.surface_fidelity,
      expectedProfitBeforeResidualRiskUsd: finite(row.expected_profit_lower_usd),
    },
  });
}

async function buildNeglectedEdgeReport(pool, options = {}) {
  const includeCandidateRows = options.includeCandidateRows !== false;
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows: clock } = await client.query('SELECT clock_timestamp() AS as_of');
    const asOf = clock[0].as_of;
    const runtimes = (await client.query(`
      SELECT component,beat_at,meta FROM system_heartbeats
       WHERE component=ANY($1::text[]) ORDER BY component`, [[
      'allmarket_lab', 'crossvenue_lab', 'options_surface',
      'pyth_boundary', 'structural_scanner',
    ]])).rows;
    const runtimeByComponent = Object.fromEntries(runtimes.map((row) => [row.component, row]));
    const allMarketHeartbeat = runtimeByComponent.allmarket_lab || null;
    const allMarketMeta = allMarketHeartbeat?.meta || {};
    const structuralEpochId = runtimeByComponent.structural_scanner?.meta?.collectionEpochId
      || allMarketMeta.collectionEpochId || null;
    const structuralEpoch = structuralEpochId ? (await client.query(`
      SELECT started_at FROM borg_collection_epochs WHERE epoch_id=$1`,
    [structuralEpochId])).rows[0] : null;
    // A missing epoch must not turn a dashboard report into an unbounded scan.
    // The fallback matches the structural SQL hot tier; immutable WAL/Parquet
    // remains the source for older replay.
    const structuralEvidenceStart = structuralEpoch?.started_at
      || new Date(new Date(asOf).getTime() - 2 * 86_400_000);

    const h43 = (await client.query(`
      WITH first_market AS (
        SELECT DISTINCT ON (o.market_id) o.id,o.market_id,o.ts,s.filled,s.pnl_2x,
               s.data_quality_grade,s.execution_fidelity_grade
          FROM borg_shadow_orders o
          LEFT JOIN borg_shadow_scores s ON s.order_id=o.id
         WHERE o.strategy='H43_resolution_boundary_buffer' AND o.experiment_id=$1
         ORDER BY o.market_id,o.ts,o.id
      )
      SELECT count(*)::int orders,count(*) FILTER (WHERE filled)::int fills,
             count(DISTINCT market_id)::int independent_markets,
             count(DISTINCT (ts AT TIME ZONE 'UTC')::date)::int calendar_days,
             count(*) FILTER (WHERE filled AND data_quality_grade IN ('A','B')
               AND execution_fidelity_grade IN ('A','B'))::int fidelity_ab,
             COALESCE(sum(pnl_2x) FILTER (WHERE filled),0)::float pnl_2x,
             min(ts) first_at,max(ts) latest
        FROM first_market`, [H43_EXPERIMENT_ID])).rows[0];

    const structural = (await client.query(`
      WITH positive AS MATERIALIZED (
        SELECT e.candidate_id,e.evaluated_at,e.economic_candidate,e.qualified,
               e.displayed_profit_2x_usd,e.orphan_safe_profit_2x_usd
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
      SELECT count(*)::int positive_observations,
             count(DISTINCT candidate_id)::int candidates,
             count(DISTINCT candidate_id)
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
             max(displayed_profit_2x_usd)::float max_displayed_profit_2x,
             max(orphan_safe_profit_2x_usd)
               FILTER (WHERE qualified)::float max_orphan_safe_profit_2x,
             max(evaluated_at) latest
        FROM positive`, [STRUCTURAL_UNIVERSE_ID, structuralEvidenceStart])).rows[0];

    const structuralRows = includeCandidateRows ? (await client.query(`
      WITH latest_positive AS (
        SELECT DISTINCT ON (e.candidate_id)
               e.*,c.atomic,c.end_date
          FROM borg_structural_evaluations e
          JOIN borg_structural_candidates c USING(candidate_id)
         WHERE c.universe_id=$1 AND e.evaluated_at >= $2
           AND (e.economic_candidate OR e.qualified)
         ORDER BY e.candidate_id,e.evaluated_at DESC,e.id DESC
      )
      SELECT * FROM latest_positive
       ORDER BY economic_candidate DESC,residual_2x_per_bundle DESC NULLS LAST,
                displayed_profit_2x_usd DESC NULLS LAST`,
    [STRUCTURAL_UNIVERSE_ID, structuralEvidenceStart])).rows : [];

    const crossvenue = (await client.query(`
      SELECT count(*)::int observations,count(DISTINCT match_id)::int pairs,
             count(DISTINCT episode_id) FILTER (WHERE episode_id IS NOT NULL)::int episodes,
             count(DISTINCT episode_id) FILTER (WHERE economic AND relation_approved)::int economic_episodes,
             count(DISTINCT episode_id) FILTER (WHERE paper_trade_eligible)::int trade_eligible_episodes,
             count(*) FILTER (WHERE relation_approved)::int relation_approved_observations,
             max(stressed_profit) FILTER (WHERE relation_approved)::float max_approved_stressed_profit,
             max(observed_at) latest
        FROM cv_opportunities WHERE experiment_id=$1`, [CROSSVENUE_EXPERIMENT_ID])).rows[0];

    const crossRows = includeCandidateRows ? (await client.query(`
      WITH latest AS (
        SELECT DISTINCT ON (o.match_id,o.direction)
               o.*,m.metadata
          FROM cv_opportunities o JOIN cv_contract_matches m USING(match_id)
         WHERE o.experiment_id=$1
         ORDER BY o.match_id,o.direction,o.observed_at DESC
      )
      SELECT * FROM latest
       ORDER BY relation_approved DESC,economic DESC,
                stressed_profit DESC NULLS LAST,match_id,direction`,
    [CROSSVENUE_EXPERIMENT_ID])).rows : [];

    const optionsSummary = (await client.query(`
      SELECT count(*)::int observations,count(DISTINCT market_id)::int markets,
             count(*) FILTER (WHERE surface_fidelity IN ('A','B'))::int surface_ab,
             count(*) FILTER (WHERE executable)::int executable,
             max(expected_profit_lower_usd) FILTER (WHERE executable)::float max_expected_lower,
             max(observed_at) latest
        FROM borg_option_shadow_marks
       WHERE observed_at >= $1 AND experiment_id=$2`,
    [OPTIONS_EVIDENCE_START, OPTIONS_EXPERIMENT_ID])).rows[0];

    const optionRows = includeCandidateRows ? (await client.query(`
      WITH latest AS (
        SELECT DISTINCT ON (market_id,side) *
          FROM borg_option_shadow_marks
         WHERE observed_at >= $1 AND experiment_id=$2
         ORDER BY market_id,side,observed_at DESC
      )
      SELECT * FROM latest
       ORDER BY executable DESC,expected_profit_lower_usd DESC NULLS LAST,
                market_id,side`,
    [OPTIONS_EVIDENCE_START, OPTIONS_EXPERIMENT_ID])).rows : [];

    const makerControls = (await client.query(`
      SELECT i.strategy,count(*) FILTER (WHERE i.action='PLACE')::int intents,
             count(*) FILTER (WHERE s.filled)::int fills,
             count(DISTINCT i.condition_id) FILTER (WHERE s.filled)::int markets,
             COALESCE(sum(s.pnl_5s) FILTER (WHERE s.filled),0)::float pnl_5s,
             COALESCE(sum(s.pnl_30s) FILTER (WHERE s.filled),0)::float pnl_30s
        FROM am_order_intents i LEFT JOIN am_execution_scores s USING(intent_id)
       WHERE i.strategy IN ('AM_passive_maker_v1','AM_reward_passive_maker_v1')
       GROUP BY i.strategy ORDER BY i.strategy`)).rows;

    const pairedControl = (await client.query(`
      SELECT count(*)::int cycles,count(DISTINCT condition_id)::int markets,
             count(*) FILTER (WHERE status='LOCKED_COMPLETE_SET')::int complete_sets,
             count(*) FILTER (WHERE status LIKE '%ORPHAN%')::int orphan_cycles,
             COALESCE(sum(total_pnl),0)::float total_pnl,
             COALESCE(sum(modeled_reward_adjusted_pnl),0)::float reward_adjusted_pnl
        FROM pmm_cycles`)).rows[0];

    const allMarketAgeSec = allMarketHeartbeat
      ? Math.max(0, (new Date(asOf).getTime() - new Date(allMarketHeartbeat.beat_at).getTime()) / 1000)
      : null;
    const fairBoundCaptureActive = allMarketAgeSec != null && allMarketAgeSec < 30
      && allMarketMeta.panelMode === 'neglected'
      && allMarketMeta.strategySignalsEnabled === false;
    const fairBoundCapture = {
      active: fairBoundCaptureActive,
      selectedMarkets: Number(allMarketMeta.selectedMarkets || 0),
      subscribedTokens: Number(allMarketMeta.subscribedTokens || 0),
      panelMode: allMarketMeta.panelMode || 'legacy',
      panelVersion: allMarketMeta.panelVersion || null,
      panelHash: allMarketMeta.panelHash || null,
      frozenMemberships: Number(allMarketMeta.panelMembershipCount || 0),
      strategySignalsEnabled: allMarketMeta.strategySignalsEnabled === true,
      liveOrderPath: false,
      heartbeatAgeSec: allMarketAgeSec,
      genericMakerControls: makerControls,
      pairedMakerControl: pairedControl,
    };

    const opportunities = [
      ...structuralRows.map(structuralOpportunity),
      ...crossRows.map(crossVenueOpportunity),
      ...optionRows.map(optionOpportunity),
    ];
    const candidateEconomics = includeCandidateRows ? summarizeOpportunities(opportunities) : null;
    if (candidateEconomics) {
      candidateEconomics.rows = candidateEconomics.rows.slice(0, Number(options.limit || 50));
    }

    const report = {
      format: 'borg-neglected-edge-report-v2',
      generatedAt: new Date().toISOString(),
      databaseSnapshotAsOf: new Date(asOf).toISOString(),
      paperOnly: true,
      liveAuthority: false,
      bankrollUsd: 500,
      benchmark: 'lower-bound payout - executable principal - stressed fees - stressed slippage - full failure reserve > 0',
      lanes: [
        {
          priority: 1, program: 'resolver_boundary_transfer', strategy: 'H43_resolution_boundary_buffer',
          runMode: 'PAPER_FORWARD_FROZEN', active: true,
          status: h43Verdict(h43), evidence: h43,
          nextTest: 'Preserve H43 unchanged; repair A/B causal arrival-book replay at 100/250/500ms before interpreting PnL.',
        },
        {
          priority: 2, program: 'certified_payoff_graph', runMode: 'PAPER_SCANNER', active: true,
          status: Number(structural.qualified_episodes) > 0
            ? 'QUALIFIED_CANDIDATES_REQUIRE_MANUAL_EXECUTION_REVIEW'
            : 'ZERO_ORPHAN_SAFE_QUALIFIED_EPISODES',
          evidence: structural,
          nextTest: 'Continue deterministic rule proof; rank only absolute executable dollars after full orphan reserve and capital duration.',
        },
        {
          priority: 3, program: 'rule_aware_crossvenue', runMode: 'PAPER_LIVE_DATA', active: true,
          status: Number(crossvenue.trade_eligible_episodes) > 0
            ? 'FORWARD_EPISODES_COLLECTING' : 'ZERO_TRADE_ELIGIBLE_PROVED_EPISODES',
          evidence: crossvenue,
          nextTest: 'Keep terminal identities and risky convergence separate; collect synchronized depth and right-censored capital-release time.',
        },
        {
          priority: 4, program: 'options_implied_binary_residual', runMode: 'PAPER_SURFACE_COLLECTOR', active: true,
          status: Number(optionsSummary.executable) > 0
            ? 'EXECUTABLE_FORWARD_MARKS_COLLECTING' : 'SURFACE_COLLECTING_NO_EXECUTABLE_TARGETS',
          evidence: optionsSummary,
          nextTest: 'Wait for exact-expiry or bounded-interpolation threshold contracts; subtract residual CVaR from the lower-bound edge.',
        },
        {
          priority: 5, program: 'fair_bound_passive_overlay', runMode: 'CAPTURE_ONLY_NO_QUOTES',
          active: false,
          status: fairBoundCaptureActive
            ? 'STAGED_CAPTURE_ACTIVE_STRATEGY_DISABLED' : 'STAGED_NOT_ACTIVE',
          evidence: fairBoundCapture,
          nextTest: 'Keep quoting disabled until an independently certified A/B lower bound maps to a current token; never revive generic directional or complete-set making.',
        },
      ],
      candidateEconomics,
      infrastructure: {
        runtimes,
        activeEpochMustRemainUnchanged: true,
        currentCapturePanel: fairBoundCapture.panelVersion,
        capturePanelHash: fairBoundCapture.panelHash,
        activationCondition: 'Capture may run now. Passive quote intents remain disabled until a separately certified lower-bound source is available.',
      },
      controls: {
        genericMaker: makerControls,
        pairedCompleteSetMaker: pairedControl,
        verdict: 'NEGATIVE_CONTROLS: fills were adversely selected and orphan losses dominated complete-set gains.',
      },
      warnings: [
        'Rows are opportunity diagnostics, not additive portfolio PnL; repeated snapshots share capacity.',
        'A non-atomic cross-venue or multi-leg bundle is not risk-free before every leg fills.',
        'H43 remains below 300 independent markets and currently lacks broad A/B execution replay coverage.',
        'No staged experiment or report grants live-order authority.',
      ],
    };
    await client.query('ROLLBACK');
    return report;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  CROSSVENUE_EXPERIMENT_ID,
  H43_EXPERIMENT_ID,
  OPTIONS_EXPERIMENT_ID,
  OPTIONS_EVIDENCE_START,
  STRUCTURAL_UNIVERSE_ID,
  buildNeglectedEdgeReport,
  crossVenueExpiry,
  crossVenueOpportunity,
  h43Verdict,
  optionOpportunity,
  secondsBetween,
  structuralOpportunity,
};
