#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const serviceEnv = process.env.TV2_ENV_FILE || '/etc/deltaforge/tv2.env';
if (!process.env.DATABASE_URL && fs.existsSync(serviceEnv)) {
  require('dotenv').config({ path: serviceEnv });
}
const { Pool } = require('pg');
const { summarizeConvergence } = require('../borg/crossvenue/convergence');
const { CURRENT_CROSSVENUE_EXPERIMENT_ID } = require('../borg/crossvenue/experiment');

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function main() {
  const days = Math.max(1, Math.min(365, parseInt(arg('days', '30'), 10) || 30));
  const experimentId = arg('experiment', CURRENT_CROSSVENUE_EXPERIMENT_ID);
  const jsonOutput = process.argv.includes('--json');
  if (!process.env.DATABASE_URL) {
    throw new Error(`DATABASE_URL is missing; set it in .env or ${serviceEnv}`);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }, max: 1 });
  try {
    const approved = await pool.query(`SELECT match_id,relation_proof
      FROM cv_contract_matches
      WHERE relation_approved=true
        AND COALESCE((identity_certification->>'valid')::boolean,false)=true`);
    const relationDefinitions = approved.rows.map((row) => ({
      matchId: row.match_id, relation: row.relation_proof,
    }));
    const relationIds = relationDefinitions.map((row) => row.matchId);
    const [coverage, identity, episodes, directions, basis, retrospectiveRows, forwardLifecycle] = await Promise.all([
      pool.query(`SELECT count(*)::int snapshots,count(DISTINCT match_id)::int pairs,
                         count(DISTINCT (observed_at AT TIME ZONE 'UTC')::date)::int days,
                         min(observed_at) first_at,max(observed_at) last_at,
                         avg(pair_skew_ms)::float mean_pair_skew_ms,
                         percentile_cont(0.95) WITHIN GROUP (ORDER BY pair_skew_ms)::float p95_pair_skew_ms
                    FROM cv_book_snapshots
                   WHERE observed_at>=now()-($1||' days')::interval
                     AND experiment_id=$2 AND synchronized=true`, [days, experimentId]),
      pool.query(`SELECT count(*)::int candidates,
                         count(*) FILTER (WHERE identity_approved)::int approved,
                         count(*) FILTER (WHERE relation_approved)::int approved_relations,
                         count(*) FILTER (WHERE monitored)::int monitored
                    FROM cv_contract_matches
                   WHERE (active OR relation_approved)
                     AND identity_snapshot_hash IS NOT NULL`),
      pool.query(`WITH per_episode AS (
                    SELECT episode_id,match_id,direction,bool_or(relation_approved) approved,
                           max(locked_profit_after_both_fills)::float best_raw,
                           max(stressed_profit)::float best_stressed,
                           min(observed_at) first_at,max(observed_at) last_at
                      FROM cv_opportunities
                     WHERE observed_at>=now()-($1||' days')::interval
                       AND experiment_id=$2 AND synchronized=true
                       AND detail->>'model' IN ('VIDEO_PARITY_EQUAL_PAYOUT_TERMINAL_LOCK','DETERMINISTIC_PAYOFF_RELATION_V1')
                       AND economic AND relation_approved AND episode_id IS NOT NULL
                     GROUP BY episode_id,match_id,direction)
                  SELECT count(*)::int episodes,count(DISTINCT match_id)::int pairs,
                         count(*) FILTER (WHERE approved)::int approved_episodes,
                         sum(best_raw) FILTER (WHERE approved)::float approved_raw_upper_bound,
                         sum(best_stressed) FILTER (WHERE approved)::float approved_stressed_upper_bound,
                         avg(EXTRACT(EPOCH FROM (last_at-first_at)))::float mean_duration_sec
                    FROM per_episode`, [days, experimentId]),
      pool.query(`SELECT direction,count(*)::int observations,
                         count(DISTINCT episode_id) FILTER (WHERE economic AND relation_approved)::int economic_episodes,
                         count(DISTINCT episode_id) FILTER (WHERE lockable_after_both_fills)::int lockable_episodes,
                         max(locked_profit_after_both_fills) FILTER (WHERE relation_approved)::float max_raw,
                         max(stressed_profit) FILTER (WHERE relation_approved)::float max_stressed,
                         max(100*locked_profit_after_both_fills/NULLIF(total_cost,0)) FILTER (WHERE relation_approved)::float max_raw_roi_pct,
                         max(100*stressed_profit/NULLIF(total_cost,0)) FILTER (WHERE relation_approved)::float max_stressed_roi_pct,
                         max(quantity) FILTER (WHERE relation_approved)::float max_sized_quantity
                    FROM cv_opportunities WHERE observed_at>=now()-($1||' days')::interval
                     AND experiment_id=$2 AND synchronized=true
                     AND detail->>'model'='DETERMINISTIC_PAYOFF_RELATION_V1'
                   GROUP BY direction ORDER BY direction`, [days, experimentId]),
      pool.query(`SELECT observed_at,match_id,direction,quantity::float,
                         entry_total_cost::float,net_liquidation_proceeds::float,
                         terminal_locked_profit::float,immediate_round_trip_pnl::float,
                         entry_economic,paper_eval_approved,paper_entry_eligible,
                         identity_approved,relation_approved,relation_type,books_fresh,
                         exact_rule_key,exact_rule_eligible,hard_mismatch,
                         full_entry_depth,full_exit_depth,
                         data_quality_grade,execution_fidelity_grade
                    FROM cv_basis_samples
                   WHERE observed_at>=now()-($1||' days')::interval
                     AND experiment_id=$2 AND synchronized=true
                   ORDER BY match_id,direction,quantity,observed_at`, [days, experimentId]),
      pool.query(`SELECT observed_at,match_id,episode_id,direction,quantity::float,
                         locked_profit_after_both_fills::float raw_profit,
                         stressed_profit::float,books_fresh,data_quality_grade,
                         execution_fidelity_grade
                    FROM cv_opportunities
                   WHERE observed_at>=now()-($1||' days')::interval
                     AND match_id=ANY($2::text[])
                     AND experiment_id=$3 AND synchronized=true
                   ORDER BY observed_at`, [days, relationIds, experimentId]),
      pool.query(`SELECT episode_id,match_id,relation_id,direction,state_active_from,
                         first_observed_at,last_observed_at,first_economic_at,last_economic_at,
                         disappeared_at,closed_at,lifecycle_status,observations::int,
                         economic_observations::int,disappearances,reappearances,
                         max_quantity::float,max_total_cost::float,max_raw_profit::float,
                         max_stressed_profit::float,worst_orphan_unwind_pnl::float,
                         orphan_stress_loss_observations::int,
                         orphan_unwind_unavailable_observations::int,
                         last_data_quality_grade,last_execution_fidelity_grade
                    FROM cv_relation_episodes
                   WHERE first_observed_at>=now()-($1||' days')::interval
                     AND experiment_id=$2
                   ORDER BY first_observed_at`, [days, experimentId]),
    ]);
    const convergence = summarizeConvergence(basis.rows, {
      requireExactRule: experimentId === CURRENT_CROSSVENUE_EXPERIMENT_ID,
    });
    const relationByMatch = new Map(relationDefinitions.map((row) => [row.matchId, row.relation]));
    const eligibleRetrospective = retrospectiveRows.rows.filter((row) => {
      const relation = relationByMatch.get(row.match_id);
      if (!relation?.relationApproved || row.books_fresh !== true) return false;
      if (relation.activeFrom && Date.parse(row.observed_at) < Date.parse(relation.activeFrom)) return false;
      return relation.validBundles.some((bundle) => bundle.direction === row.direction);
    });
    const retrospectiveEpisodes = new Map();
    for (const row of eligibleRetrospective) {
      if (!(parseFloat(row.raw_profit) > 0) || !row.episode_id) continue;
      const relation = relationByMatch.get(row.match_id);
      // One contract pair/event is one independent discovery unit even if the
      // same dislocation flickers in and out or the 30-second telemetry episode
      // id changes. This prevents hundreds of snapshots becoming fake n.
      const key = `${row.match_id}:${relation.id}:${row.direction}`;
      const prior = retrospectiveEpisodes.get(key) || {
        matchId: row.match_id, relationId: relation.id, direction: row.direction,
        sourceEpisodeIds: new Set(),
        observations: 0, bestRaw: -Infinity, bestStressed: -Infinity,
      };
      prior.sourceEpisodeIds.add(row.episode_id);
      prior.observations += 1;
      prior.bestRaw = Math.max(prior.bestRaw, parseFloat(row.raw_profit));
      prior.bestStressed = Math.max(prior.bestStressed, parseFloat(row.stressed_profit));
      retrospectiveEpisodes.set(key, prior);
    }
    const retrospective = [...retrospectiveEpisodes.values()].map((row) => ({
      ...row, sourceEpisodeIds: [...row.sourceEpisodeIds],
    }));
    const report = {
      generatedAt: new Date().toISOString(), requestedDays: days,
      engineCohort: experimentId,
      capitalModel: {
        startingUsd: 500, perVenueUsd: 250,
        sizing: 'equal payout shares optimized over executable depth and bankroll',
      },
      verdict: Number(identity.rows[0].approved_relations) === 0
        ? 'NO FORWARD-APPROVED PAYOFF RELATIONS: parity controls are not arbitrage evidence.'
        : 'Approved payoff relations exist; require fresh forward episodes and explicit non-atomic leg-risk review.',
      coverage: coverage.rows[0], identity: identity.rows[0], episodes: episodes.rows[0],
      directions: directions.rows, convergence,
      forwardRelationEvents: {
        independentUnit: 'approved relation + state activation + safe bundle direction',
        events: forwardLifecycle.rows.length,
        everEconomic: forwardLifecycle.rows.filter((row) => row.economic_observations > 0).length,
        disappeared: forwardLifecycle.rows.filter((row) => row.disappearances > 0).length,
        closed: forwardLifecycle.rows.filter((row) => row.closed_at != null).length,
        orphanStressExposed: forwardLifecycle.rows.filter((row) => row.orphan_stress_loss_observations > 0).length,
        warning: 'Orphan metrics are immediate-unwind paper stress, not observed live fills.',
        rows: forwardLifecycle.rows,
      },
      retrospectiveRelationAudit: {
        forwardEvidence: false,
        warning: 'Relations were approved after inspecting this history; these rows validate payoff logic and executable-book plumbing only.',
        approvedRelations: relationDefinitions.filter((row) => row.relation.relationApproved).length,
        eligibleObservations: eligibleRetrospective.length,
        episodes: retrospective.length,
        pairs: new Set(retrospective.map((row) => row.matchId)).size,
        positiveStressedEpisodes: retrospective.filter((row) => row.bestStressed > 0).length,
        bestStressedProfit: retrospective.length
          ? Math.max(...retrospective.map((row) => row.bestStressed)) : null,
        rows: retrospective,
      },
      interpretation: [
        'Do not sum millisecond observations; each episode is one dislocation.',
        'Upper-bound PnL assumes both displayed legs fill. Cross-venue orders are not atomic.',
        'Public historical trades/candles can test price convergence but cannot reconstruct synchronized L2, queue, partial fills or legging loss.',
        'Forward cv_book_snapshots plus raw WAL are the execution-grade backtest source.',
        'Convergence means both positions could be sold at executable bids for non-negative PnL after all four entry/exit fees; censored episodes are retained.',
        'ROI is profit divided by deployed entry cash; equal share quantity, not equal dollar stake, creates the terminal hedge.',
      ],
    };
    if (jsonOutput) console.log(JSON.stringify(report, null, 2));
    else {
      console.log('CROSS-VENUE FORWARD REPLAY REPORT');
      console.log(`Generated: ${report.generatedAt}`);
      console.log(`Window: ${days} days`);
      console.log(`Verdict: ${report.verdict}`);
      console.table([report.coverage]);
      console.table([report.identity]);
      console.table([report.episodes]);
      console.table([{
        cohort: 'forward relation-event ledger',
        events: report.forwardRelationEvents.events,
        everEconomic: report.forwardRelationEvents.everEconomic,
        disappeared: report.forwardRelationEvents.disappeared,
        orphanStressExposed: report.forwardRelationEvents.orphanStressExposed,
      }]);
      console.table([report.retrospectiveRelationAudit]);
      console.table(report.directions);
      console.log('CAPITAL-RELEASE CONVERGENCE (Kaplan-Meier)');
      console.table([
        { cohort: 'approved evidence', ...report.convergence.approvedEvidence },
        { cohort: 'unapproved diagnostic', ...report.convergence.unapprovedDiagnostic },
      ].map(({ horizons, ...row }) => row));
      console.table(report.convergence.approvedEvidence.horizons.map((row) => ({
        horizon: row.label,
        probability: row.probability == null ? null : +(100 * row.probability).toFixed(2),
        events: row.events, atRisk: row.atRisk,
      })));
      console.log(report.interpretation.map((line) => `- ${line}`).join('\n'));
    }
  } finally { await pool.end(); }
}

main().catch((error) => { console.error(error.stack || error.message); process.exit(1); });
