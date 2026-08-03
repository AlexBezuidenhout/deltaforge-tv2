/**
 * BORG dashboard routes — READ-ONLY window onto the borg_* tables.
 *
 * The BORG collector + shadow engine do NOT run inside this server: they run
 * as launchd job `com.borg.recon` from ~/.borg-runtime (see borg/SHADOW.md).
 * These routes only report what that process has recorded — there is no
 * start/stop control here on purpose (supervision belongs to launchd, and
 * the shadow bot must not be steerable from the trading UI during pilots).
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../models/db');
const { authMiddleware } = require('../middleware/auth');
const {
  RESEARCH_CAPITAL_VERSION,
  STARTING_BANKROLL_USD,
} = require('../../borg/research/capital-policy');
const { simulatePortfolio } = require('../../borg/research/portfolio-simulator');
const { CHALLENGER_STRATEGY_VERSION } = require('../../borg/flow/strategy');
const { summarizeConvergence } = require('../../borg/crossvenue/convergence');
const { buildResolverBoundaryPortfolio } = require('../../borg/research/resolver-boundary-portfolio');
const { buildPriorityLaneStatus } = require('../../borg/research/priority-lane-status');
const { buildEdgeIncubatorStatus } = require('../../borg/research/edge-incubator-status');
const { assessEvidenceEpoch } = require('../../borg/research/evidence-epoch');
const { dossierFor } = require('../../borg/research/strategy-dossiers');
const { createReadThroughCache } = require('../utils/readThroughCache');

const dashboardReports = createReadThroughCache();
const { CURRENT_CROSSVENUE_EXPERIMENT_ID: CROSSVENUE_EXPERIMENT_ID } =
  require('../../borg/crossvenue/experiment');
const {
  TERMINAL_CARRY_EXPERIMENT_ID,
  TERMINAL_CARRY_V1_EXPERIMENT_ID,
} =
  require('../../borg/crossvenue/terminal-carry');
const STRUCTURAL_EXPERIMENT_ID = 'structural-certified-payoff-graph-v5-orphan-reserve';
const { ORDERED_STRIKE_EVIDENCE_START, ORDERED_STRIKE_EXPERIMENT_ID } =
  require('../../borg/structural/experiment');
const PYTH_EXPERIMENT_ID = 'pyth-resolver-boundary-transfer-v4-frozen-observation-window';

router.get('/research/priority-lanes', authMiddleware, async (req, res) => {
  try {
    const value = await dashboardReports.get('priority-research-lanes-v4', 10_000,
      () => buildPriorityLaneStatus(pool));
    res.json(value);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/research/edge-incubator', authMiddleware, async (req, res) => {
  try {
    const value = await dashboardReports.get('edge-incubator-v1', 10_000,
      () => buildEdgeIncubatorStatus(pool));
    res.json(value);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/research/evidence-epoch', authMiddleware, async (req, res) => {
  try {
    const value = await dashboardReports.get('evidence-epoch-v2', 30_000,
      () => assessEvidenceEpoch(pool, {
        minHours: Number(process.env.BORG_MIN_CLEAN_EVIDENCE_HOURS || 24),
        minimumFreeGiB: Number(process.env.BORG_EVIDENCE_MIN_FREE_GIB || 30),
        parquetMinHours: Number(process.env.BORG_PARQUET_MIN_CLEAN_HOURS || 24),
        maxParquetAgeSec: Number(process.env.BORG_PARQUET_MAX_AGE_SEC || 5400),
        minimumParquetVerifiedBatches: Number(
          process.env.BORG_PARQUET_MIN_VERIFIED_BATCHES || 2,
        ),
        parquetStateFile: process.env.PARQUET_LAKE_STATE_FILE,
        parquetReceiptFile: process.env.PARQUET_LAKE_RECEIPT,
        parquetReportFile: process.env.PARQUET_LAKE_REPORT,
      }));
    res.json(value);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Virtual paper account: BORG's "paper trading" is the scored shadow ledger —
// fills only when the recorded tape proves the order would have filled
// (back-of-queue), PnL after 1× pessimistic costs. Deliberately stricter than
// the instant-fill paper mode the main bot and George use.
const PAPER_START_BALANCE = STARTING_BANKROLL_USD;

// --- Collector + recon health ---
router.get('/status', authMiddleware, async (req, res) => {
  try {
    // ?since=<ISO> scopes the paper stats to orders placed after that time
    // (dashboard "this session" toggle). Balance is cumulative FROM the
    // operator's last paper reset (borg_paper_reset_at -> account rebases to
    // $500); history is never deleted, only the display window moves.
    const since = req.query.since && !isNaN(Date.parse(req.query.since)) ? new Date(req.query.since) : null;
    const cacheKey = `borg-status:${req.userId}:${since ? since.toISOString() : 'all'}`;
    const value = await dashboardReports.get(cacheKey, 10_000, async () => {
      // Keep this whole report on one checked-out connection. Previously the
      // Promise.all below could consume ten pool slots per browser refresh;
      // two tabs were enough to starve every dashboard route.
      const client = await pool.connect();
      try {
        const resetAt = (await client.query(
          'SELECT borg_paper_reset_at FROM bot_settings WHERE user_id = $1', [req.userId]
        )).rows[0]?.borg_paper_reset_at || null;
        // stats window floor = the later of session-since and the paper reset
        const statsFloor = since && resetAt ? new Date(Math.max(since.getTime(), new Date(resetAt).getTime()))
          : (since || (resetAt ? new Date(resetAt) : null));
        const [fresh, markets, heartbeat, shadowEvt, gaps, paper, pending, collection, runtime, balance] = await Promise.all([
          client.query(`SELECT
              (SELECT ts FROM borg_book_snaps ORDER BY id DESC LIMIT 1) AS book_snaps,
              (SELECT ts FROM borg_binance_1s ORDER BY ts DESC LIMIT 1) AS binance_1s,
              (SELECT ts FROM borg_clob_events ORDER BY id DESC LIMIT 1) AS clob_events,
              (SELECT ts FROM borg_taker_trades ORDER BY id DESC LIMIT 1) AS taker_trades,
              (SELECT seen_at FROM borg_chainlink_rounds ORDER BY seen_at DESC LIMIT 1) AS chainlink_rounds`),
          client.query(`SELECT count(*)::int total,
              count(*) FILTER (WHERE outcome IS NOT NULL)::int resolved,
              count(*) FILTER (WHERE binance_open_src = 'live')::int live_opens,
              count(*) FILTER (WHERE outcome IS NOT NULL AND binance_open IS NOT NULL AND binance_close IS NOT NULL
                AND outcome <> CASE WHEN binance_close >= binance_open THEN 'UP' ELSE 'DOWN' END)::int sign_disagreements
            FROM borg_markets`),
          client.query(`SELECT ts, level, message, data FROM borg_events
            WHERE source='heartbeat' ORDER BY id DESC LIMIT 1`),
          client.query(`SELECT ts, message FROM borg_events
            WHERE source='shadow' AND message LIKE '%strategies%' ORDER BY id DESC LIMIT 1`),
          // A bounded recent continuity diagnostic. The old 24-hour window
          // sorted millions of 2KB JSON book rows every five seconds.
          client.query(`WITH recent AS (
              SELECT id, ts FROM borg_book_snaps ORDER BY id DESC LIMIT 10000
            ), ordered AS (
              SELECT ts - lag(ts) OVER (ORDER BY ts, id) gap FROM recent
            )
            SELECT count(*)::int n FROM ordered WHERE gap > interval '5 seconds'`),
          client.query(`SELECT count(*)::int scored,
              count(*) FILTER (WHERE s.filled)::int fills,
              count(*) FILTER (WHERE s.filled AND s.pnl_1x > 0)::int wins,
              count(*) FILTER (WHERE s.filled AND s.pnl_1x <= 0)::int losses,
              COALESCE(sum(s.pnl_1x) FILTER (WHERE s.filled), 0)::float pnl_1x,
              max(s.scored_at) last_scored
            FROM borg_shadow_scores s
            JOIN borg_shadow_orders o ON o.id = s.order_id
            WHERE o.features->>'research_capital_version' = $1
            ${statsFloor ? 'AND o.ts >= $2' : ''}`,
          statsFloor ? [RESEARCH_CAPITAL_VERSION, statsFloor] : [RESEARCH_CAPITAL_VERSION]),
          client.query(`SELECT count(*)::int n FROM borg_shadow_orders o
            LEFT JOIN borg_shadow_scores s ON s.order_id = o.id
            WHERE o.action='place' AND s.order_id IS NULL
              AND o.features->>'research_capital_version' = $1`, [RESEARCH_CAPITAL_VERSION]),
          client.query(`SELECT e.*, r.run_id, r.started_at run_started_at, r.code_version run_code_version,
                             EXTRACT(EPOCH FROM now() - r.started_at)::int run_age_sec
                        FROM borg_collector_runs r
                        JOIN borg_collection_epochs e ON e.epoch_id=r.epoch_id
                       WHERE r.status='RUNNING' ORDER BY r.started_at DESC LIMIT 1`),
          client.query(`WITH latest AS (
                        SELECT run_id FROM borg_collector_runs
                         WHERE status='RUNNING' ORDER BY started_at DESC LIMIT 1
                      )
                      SELECT count(*)::int registered,
                             count(*) FILTER (WHERE evaluations > 0)::int evaluated,
                             count(*) FILTER (WHERE errors > 0)::int with_errors,
                             max(updated_at) updated_at
                        FROM borg_strategy_runtime r JOIN latest l ON l.run_id=r.collector_run_id`),
          client.query(`SELECT COALESCE(sum(s.pnl_1x) FILTER (WHERE s.filled), 0)::float p
             FROM borg_shadow_scores s JOIN borg_shadow_orders o ON o.id = s.order_id
             WHERE o.features->>'research_capital_version' = $1
             ${resetAt ? 'AND o.ts >= $2' : ''}`,
          resetAt ? [RESEARCH_CAPITAL_VERSION, resetAt] : [RESEARCH_CAPITAL_VERSION]),
        ]);
        const now = Date.now();
        const latest = fresh.rows[0] || {};
        const feeds = {};
        for (const name of ['book_snaps', 'binance_1s', 'clob_events', 'taker_trades', 'chainlink_rounds']) {
          feeds[name] = latest[name] ? Math.round((now - new Date(latest[name]).getTime()) / 1000) : null;
        }
        // alive = book snapshots landing on the 1s cadence (15s of slack)
        const alive = feeds.book_snaps != null && feeds.book_snaps < 15;
        const hb = heartbeat.rows[0] || null;
        return {
          alive,
          feeds, // seconds since last row, per table
          markets: markets.rows[0],
          snapshotGapsRecent: gaps.rows[0].n,
          snapshotGapWindowRows: 10000,
          heartbeat: hb ? { ts: hb.ts, level: hb.level, message: hb.message, counters: hb.data } : null,
          collection: collection.rows[0] || null,
          strategyRuntime: runtime.rows[0] || { registered: 0, evaluated: 0, with_errors: 0, updated_at: null },
          shadowPaused: shadowEvt.rows[0] ? /paused/.test(shadowEvt.rows[0].message) : false,
          paper: {
            startBalance: PAPER_START_BALANCE,
            // balance = $500 + everything scored since the last paper reset
            // (independent of the session toggle, which only scopes the stats)
            balance: +(PAPER_START_BALANCE + balance.rows[0].p).toFixed(2),
            balanceMeaning: 'NAIVE_LEDGER_SUM_NOT_SHARED_CAPITAL',
            warning: 'This aggregate assumes every strategy could consume the same capital and liquidity. Use /research/portfolio for the shared-$500 result.',
            capitalVersion: RESEARCH_CAPITAL_VERSION,
            sessionScoped: !!since,
            resetAt: resetAt || null,
            pnl1x: +paper.rows[0].pnl_1x.toFixed(2),
            scored: paper.rows[0].scored,
            fills: paper.rows[0].fills,
            wins: paper.rows[0].wins,
            losses: paper.rows[0].losses,
            pendingScore: pending.rows[0].n,
            lastScored: paper.rows[0].last_scored,
          },
        };
      } finally {
        client.release();
      }
    });
    res.json(value);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Shadow scoreboard: per strategy, orders + scored fills + cost-grid PnL ---
router.get('/shadow/summary', authMiddleware, async (req, res) => {
  try {
    const value = await dashboardReports.get('borg-shadow-summary', 15_000, async () => {
      const { rows } = await pool.query(`
        WITH latest_trial AS (
          SELECT DISTINCT ON (strategy)
                 strategy,status,status_reason,experiment_id,variant,
                 family,phase AS trial_phase,evidence_started_at,frozen_at,
                 min_independent_markets,min_days,primary_metric
            FROM borg_trial_ledger
           ORDER BY strategy,frozen_at DESC,id DESC
        ),
        active_epoch AS (
          SELECT r.epoch_id,e.started_at AS epoch_started_at
            FROM borg_collector_runs r
            JOIN borg_collection_epochs e ON e.epoch_id=r.epoch_id
           WHERE r.status='RUNNING'
           ORDER BY r.started_at DESC
           LIMIT 1
        )
        SELECT o.strategy, COALESCE(lt.trial_phase,'historical') AS phase,
          count(*) FILTER (WHERE o.action='place')::int places,
          count(*) FILTER (WHERE o.action='cancel')::int cancels,
          count(s.order_id)::int scored,
          count(s.order_id) FILTER (WHERE s.filled)::int fills,
          COALESCE(sum(s.pnl_gross) FILTER (WHERE s.filled), 0)::float pnl_gross,
          COALESCE(sum(s.pnl_05x)  FILTER (WHERE s.filled), 0)::float pnl_05x,
          COALESCE(sum(s.pnl_1x)   FILTER (WHERE s.filled), 0)::float pnl_1x,
          COALESCE(sum(s.pnl_2x)   FILTER (WHERE s.filled), 0)::float pnl_2x,
          count(s.order_id) FILTER (
            WHERE s.filled
              AND s.data_quality_grade IN ('A','B')
              AND s.execution_fidelity_grade IN ('A','B')
          )::int eligible_fills,
          count(DISTINCT o.market_id) FILTER (
            WHERE s.filled
              AND s.data_quality_grade IN ('A','B')
              AND s.execution_fidelity_grade IN ('A','B')
          )::int eligible_markets,
          COALESCE(sum(s.pnl_gross) FILTER (
            WHERE s.filled
              AND s.data_quality_grade IN ('A','B')
              AND s.execution_fidelity_grade IN ('A','B')
          ), 0)::float eligible_pnl_gross,
          COALESCE(sum(s.pnl_05x) FILTER (
            WHERE s.filled
              AND s.data_quality_grade IN ('A','B')
              AND s.execution_fidelity_grade IN ('A','B')
          ), 0)::float eligible_pnl_05x,
          COALESCE(sum(s.pnl_1x) FILTER (
            WHERE s.filled
              AND s.data_quality_grade IN ('A','B')
              AND s.execution_fidelity_grade IN ('A','B')
          ), 0)::float eligible_pnl_1x,
          COALESCE(sum(s.pnl_2x) FILTER (
            WHERE s.filled
              AND s.data_quality_grade IN ('A','B')
              AND s.execution_fidelity_grade IN ('A','B')
          ), 0)::float eligible_pnl_2x,
          count(s.order_id) FILTER (
            WHERE s.filled
              AND s.data_quality_grade IN ('A','B')
              AND s.execution_fidelity_grade IN ('A','B')
              AND o.experiment_id=lt.experiment_id
              AND COALESCE(o.arm,'baseline')=lt.variant
              AND o.phase=lt.trial_phase
              AND COALESCE(o.available_at,o.ts)>=GREATEST(
                lt.evidence_started_at,ae.epoch_started_at)
              AND o.features->>'collection_epoch_id'=ae.epoch_id
          )::int current_eligible_fills,
          count(DISTINCT o.market_id) FILTER (
            WHERE s.filled
              AND s.data_quality_grade IN ('A','B')
              AND s.execution_fidelity_grade IN ('A','B')
              AND o.experiment_id=lt.experiment_id
              AND COALESCE(o.arm,'baseline')=lt.variant
              AND o.phase=lt.trial_phase
              AND COALESCE(o.available_at,o.ts)>=GREATEST(
                lt.evidence_started_at,ae.epoch_started_at)
              AND o.features->>'collection_epoch_id'=ae.epoch_id
          )::int current_eligible_markets,
          COALESCE(sum(s.pnl_1x) FILTER (
            WHERE s.filled
              AND s.data_quality_grade IN ('A','B')
              AND s.execution_fidelity_grade IN ('A','B')
              AND o.experiment_id=lt.experiment_id
              AND COALESCE(o.arm,'baseline')=lt.variant
              AND o.phase=lt.trial_phase
              AND COALESCE(o.available_at,o.ts)>=GREATEST(
                lt.evidence_started_at,ae.epoch_started_at)
              AND o.features->>'collection_epoch_id'=ae.epoch_id
          ), 0)::float current_pnl_1x,
          COALESCE(sum(s.pnl_2x) FILTER (
            WHERE s.filled
              AND s.data_quality_grade IN ('A','B')
              AND s.execution_fidelity_grade IN ('A','B')
              AND o.experiment_id=lt.experiment_id
              AND COALESCE(o.arm,'baseline')=lt.variant
              AND o.phase=lt.trial_phase
              AND COALESCE(o.available_at,o.ts)>=GREATEST(
                lt.evidence_started_at,ae.epoch_started_at)
              AND o.features->>'collection_epoch_id'=ae.epoch_id
          ), 0)::float current_pnl_2x,
          count(s.order_id) FILTER (
            WHERE s.filled
              AND s.data_quality_grade IN ('A','B')
              AND s.execution_fidelity_grade IN ('A','B')
              AND o.experiment_id=lt.experiment_id
              AND COALESCE(o.arm,'baseline')=lt.variant
              AND o.phase=lt.trial_phase
              AND COALESCE(o.available_at,o.ts)>=GREATEST(
                lt.evidence_started_at,ae.epoch_started_at)
              AND o.features->>'collection_epoch_id'=ae.epoch_id
              AND COALESCE(o.available_at,o.ts) >= now()-interval '6 hours'
          )::int fills_6h,
          count(DISTINCT o.market_id) FILTER (
            WHERE s.filled
              AND s.data_quality_grade IN ('A','B')
              AND s.execution_fidelity_grade IN ('A','B')
              AND o.experiment_id=lt.experiment_id
              AND COALESCE(o.arm,'baseline')=lt.variant
              AND o.phase=lt.trial_phase
              AND COALESCE(o.available_at,o.ts)>=GREATEST(
                lt.evidence_started_at,ae.epoch_started_at)
              AND o.features->>'collection_epoch_id'=ae.epoch_id
              AND COALESCE(o.available_at,o.ts) >= now()-interval '6 hours'
          )::int markets_6h,
          COALESCE(sum(s.pnl_1x) FILTER (
            WHERE s.filled
              AND s.data_quality_grade IN ('A','B')
              AND s.execution_fidelity_grade IN ('A','B')
              AND o.experiment_id=lt.experiment_id
              AND COALESCE(o.arm,'baseline')=lt.variant
              AND o.phase=lt.trial_phase
              AND COALESCE(o.available_at,o.ts)>=GREATEST(
                lt.evidence_started_at,ae.epoch_started_at)
              AND o.features->>'collection_epoch_id'=ae.epoch_id
              AND COALESCE(o.available_at,o.ts) >= now()-interval '6 hours'
          ), 0)::float pnl_1x_6h,
          COALESCE(sum(s.pnl_2x) FILTER (
            WHERE s.filled
              AND s.data_quality_grade IN ('A','B')
              AND s.execution_fidelity_grade IN ('A','B')
              AND o.experiment_id=lt.experiment_id
              AND COALESCE(o.arm,'baseline')=lt.variant
              AND o.phase=lt.trial_phase
              AND COALESCE(o.available_at,o.ts)>=GREATEST(
                lt.evidence_started_at,ae.epoch_started_at)
              AND o.features->>'collection_epoch_id'=ae.epoch_id
              AND COALESCE(o.available_at,o.ts) >= now()-interval '6 hours'
          ), 0)::float pnl_2x_6h,
          count(s.order_id) FILTER (
            WHERE s.filled
              AND s.data_quality_grade IN ('A','B')
              AND s.execution_fidelity_grade IN ('A','B')
              AND o.experiment_id=lt.experiment_id
              AND COALESCE(o.arm,'baseline')=lt.variant
              AND o.phase=lt.trial_phase
              AND COALESCE(o.available_at,o.ts)>=GREATEST(
                lt.evidence_started_at,ae.epoch_started_at)
              AND o.features->>'collection_epoch_id'=ae.epoch_id
              AND COALESCE(o.available_at,o.ts) >= now()-interval '24 hours'
          )::int fills_24h,
          count(DISTINCT o.market_id) FILTER (
            WHERE s.filled
              AND s.data_quality_grade IN ('A','B')
              AND s.execution_fidelity_grade IN ('A','B')
              AND o.experiment_id=lt.experiment_id
              AND COALESCE(o.arm,'baseline')=lt.variant
              AND o.phase=lt.trial_phase
              AND COALESCE(o.available_at,o.ts)>=GREATEST(
                lt.evidence_started_at,ae.epoch_started_at)
              AND o.features->>'collection_epoch_id'=ae.epoch_id
              AND COALESCE(o.available_at,o.ts) >= now()-interval '24 hours'
          )::int markets_24h,
          COALESCE(sum(s.pnl_1x) FILTER (
            WHERE s.filled
              AND s.data_quality_grade IN ('A','B')
              AND s.execution_fidelity_grade IN ('A','B')
              AND o.experiment_id=lt.experiment_id
              AND COALESCE(o.arm,'baseline')=lt.variant
              AND o.phase=lt.trial_phase
              AND COALESCE(o.available_at,o.ts)>=GREATEST(
                lt.evidence_started_at,ae.epoch_started_at)
              AND o.features->>'collection_epoch_id'=ae.epoch_id
              AND COALESCE(o.available_at,o.ts) >= now()-interval '24 hours'
          ), 0)::float pnl_1x_24h,
          COALESCE(sum(s.pnl_2x) FILTER (
            WHERE s.filled
              AND s.data_quality_grade IN ('A','B')
              AND s.execution_fidelity_grade IN ('A','B')
              AND o.experiment_id=lt.experiment_id
              AND COALESCE(o.arm,'baseline')=lt.variant
              AND o.phase=lt.trial_phase
              AND COALESCE(o.available_at,o.ts)>=GREATEST(
                lt.evidence_started_at,ae.epoch_started_at)
              AND o.features->>'collection_epoch_id'=ae.epoch_id
              AND COALESCE(o.available_at,o.ts) >= now()-interval '24 hours'
          ), 0)::float pnl_2x_24h,
          count(s.order_id) FILTER (
            WHERE s.filled
              AND s.data_quality_grade IN ('A','B')
              AND s.execution_fidelity_grade IN ('A','B')
              AND o.experiment_id=lt.experiment_id
              AND COALESCE(o.arm,'baseline')=lt.variant
              AND o.phase=lt.trial_phase
              AND COALESCE(o.available_at,o.ts)>=GREATEST(
                lt.evidence_started_at,ae.epoch_started_at)
              AND o.features->>'collection_epoch_id'=ae.epoch_id
              AND COALESCE(o.available_at,o.ts) >= now()-interval '3 days'
          )::int fills_3d,
          count(DISTINCT o.market_id) FILTER (
            WHERE s.filled
              AND s.data_quality_grade IN ('A','B')
              AND s.execution_fidelity_grade IN ('A','B')
              AND o.experiment_id=lt.experiment_id
              AND COALESCE(o.arm,'baseline')=lt.variant
              AND o.phase=lt.trial_phase
              AND COALESCE(o.available_at,o.ts)>=GREATEST(
                lt.evidence_started_at,ae.epoch_started_at)
              AND o.features->>'collection_epoch_id'=ae.epoch_id
              AND COALESCE(o.available_at,o.ts) >= now()-interval '3 days'
          )::int markets_3d,
          COALESCE(sum(s.pnl_1x) FILTER (
            WHERE s.filled
              AND s.data_quality_grade IN ('A','B')
              AND s.execution_fidelity_grade IN ('A','B')
              AND o.experiment_id=lt.experiment_id
              AND COALESCE(o.arm,'baseline')=lt.variant
              AND o.phase=lt.trial_phase
              AND COALESCE(o.available_at,o.ts)>=GREATEST(
                lt.evidence_started_at,ae.epoch_started_at)
              AND o.features->>'collection_epoch_id'=ae.epoch_id
              AND COALESCE(o.available_at,o.ts) >= now()-interval '3 days'
          ), 0)::float pnl_1x_3d,
          COALESCE(sum(s.pnl_2x) FILTER (
            WHERE s.filled
              AND s.data_quality_grade IN ('A','B')
              AND s.execution_fidelity_grade IN ('A','B')
              AND o.experiment_id=lt.experiment_id
              AND COALESCE(o.arm,'baseline')=lt.variant
              AND o.phase=lt.trial_phase
              AND COALESCE(o.available_at,o.ts)>=GREATEST(
                lt.evidence_started_at,ae.epoch_started_at)
              AND o.features->>'collection_epoch_id'=ae.epoch_id
              AND COALESCE(o.available_at,o.ts) >= now()-interval '3 days'
          ), 0)::float pnl_2x_3d,
          count(s.order_id) FILTER (WHERE s.data_quality_grade IN ('A','B'))::int quality_ab,
          count(s.order_id) FILTER (WHERE s.data_quality_grade='F')::int quality_f,
          count(s.order_id) FILTER (WHERE s.execution_fidelity_grade IN ('A','B'))::int fidelity_ab,
          count(s.order_id) FILTER (WHERE s.execution_fidelity_grade='F')::int fidelity_f,
          min(o.ts) first_seen,
          max(o.ts) latest,
          lt.status trial_status,
          lt.status_reason trial_status_reason,
          lt.experiment_id current_experiment_id,
          lt.variant current_trial_variant,
          lt.family current_trial_family,
          lt.trial_phase current_trial_phase,
          lt.evidence_started_at current_evidence_started_at,
          lt.frozen_at current_trial_frozen_at,
          lt.min_independent_markets current_min_independent_markets,
          lt.min_days current_min_days,
          lt.primary_metric current_primary_metric,
          ae.epoch_id current_evidence_epoch_id,
          ae.epoch_started_at current_epoch_started_at
        FROM borg_shadow_orders o
        LEFT JOIN borg_shadow_scores s ON s.order_id = o.id
        LEFT JOIN latest_trial lt ON lt.strategy=o.strategy
        LEFT JOIN active_epoch ae ON true
        WHERE o.features->>'research_capital_version' = $1
        GROUP BY o.strategy,lt.status,lt.status_reason,
                 lt.experiment_id,lt.variant,lt.family,lt.trial_phase,
                 lt.evidence_started_at,lt.frozen_at,lt.min_independent_markets,
                 lt.min_days,lt.primary_metric,
                 ae.epoch_id,ae.epoch_started_at
        ORDER BY o.strategy`, [RESEARCH_CAPITAL_VERSION]);

      // The order ledger alone cannot tell the operator whether a quiet rule is
      // still evaluating. Merge in the active-run heartbeat and every latest
      // frozen trial so zero-signal strategies remain visible.
      const [runtimeResult, trialResult] = await Promise.all([
        pool.query(`
          WITH active_run AS (
            SELECT run_id,epoch_id,started_at
              FROM borg_collector_runs
             WHERE status='RUNNING'
             ORDER BY started_at DESC
             LIMIT 1
          )
          SELECT r.strategy,r.collector_run_id,r.epoch_id,r.cadence,r.market_types,
                 r.started_at runtime_started_at,r.last_evaluated_at,
                 r.evaluations::float evaluations,
                 r.halted_evaluations::float halted_evaluations,
                 r.actions::float actions,r.errors::float errors,
                 r.last_action_at,r.updated_at runtime_updated_at,r.diagnostics
            FROM borg_strategy_runtime r
            JOIN active_run a ON a.run_id=r.collector_run_id
        `),
        pool.query(`
          SELECT DISTINCT ON (strategy)
                 strategy,status trial_status,status_reason trial_status_reason,
                 experiment_id current_experiment_id,variant current_trial_variant,
                 family current_trial_family,phase current_trial_phase,
                 evidence_started_at current_evidence_started_at,
                 frozen_at current_trial_frozen_at,
                 min_independent_markets current_min_independent_markets,
                 min_days current_min_days,primary_metric current_primary_metric
            FROM borg_trial_ledger
           ORDER BY strategy,frozen_at DESC,id DESC
        `),
      ]);

      const numericFields = [
        'places', 'cancels', 'scored', 'fills', 'pnl_gross', 'pnl_05x', 'pnl_1x', 'pnl_2x',
        'eligible_fills', 'eligible_markets', 'eligible_pnl_gross', 'eligible_pnl_05x',
        'eligible_pnl_1x', 'eligible_pnl_2x', 'current_eligible_fills',
        'current_eligible_markets', 'current_pnl_1x', 'current_pnl_2x',
        'fills_6h', 'markets_6h', 'pnl_1x_6h', 'pnl_2x_6h',
        'fills_24h', 'markets_24h', 'pnl_1x_24h', 'pnl_2x_24h',
        'fills_3d', 'markets_3d', 'pnl_1x_3d', 'pnl_2x_3d',
        'quality_ab', 'quality_f', 'fidelity_ab', 'fidelity_f',
      ];
      const byStrategy = new Map();
      for (const row of rows) {
        const normalized = { ...row };
        for (const field of numericFields) normalized[field] = parseFloat(row[field] || 0);
        byStrategy.set(row.strategy, normalized);
      }
      for (const trial of trialResult.rows) {
        const row = byStrategy.get(trial.strategy) || { strategy: trial.strategy, phase: trial.current_trial_phase };
        Object.assign(row, trial);
        for (const field of numericFields) {
          if (!Number.isFinite(row[field])) row[field] = 0;
        }
        byStrategy.set(trial.strategy, row);
      }
      for (const runtime of runtimeResult.rows) {
        const row = byStrategy.get(runtime.strategy) || { strategy: runtime.strategy, phase: 'eval' };
        Object.assign(row, runtime, {
          runtime_present: true,
          evaluations: parseFloat(runtime.evaluations || 0),
          halted_evaluations: parseFloat(runtime.halted_evaluations || 0),
          actions: parseFloat(runtime.actions || 0),
          errors: parseFloat(runtime.errors || 0),
        });
        for (const field of numericFields) {
          if (!Number.isFinite(row[field])) row[field] = 0;
        }
        byStrategy.set(runtime.strategy, row);
      }

      return [...byStrategy.values()].map((row) => {
        const dossier = dossierFor(row.strategy, {
          trialStatus: row.trial_status,
          trialStatusReason: row.trial_status_reason,
          runtimePresent: row.runtime_present === true,
          runtimeUpdatedAt: row.runtime_updated_at,
          evaluations: row.evaluations,
          actions: row.actions,
        });
        const activityTimes = [
          row.runtime_updated_at,
          row.last_evaluated_at,
          row.last_action_at,
          row.latest,
        ].map((value) => value ? new Date(value).getTime() : NaN).filter(Number.isFinite);
        return {
          ...row,
          ...dossier,
          deployed_at: row.current_trial_frozen_at || row.first_seen || row.runtime_started_at || null,
          last_activity_at: activityTimes.length ? new Date(Math.max(...activityTimes)).toISOString() : null,
        };
      }).sort((left, right) =>
        left.lifecycleRank - right.lifecycleRank ||
        left.priorityRank - right.priorityRank ||
        String(left.strategy).localeCompare(String(right.strategy)));
    });
    res.json(value);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Strategy evidence dossier: one current frozen cohort, never pooled with discovery ---
router.get('/shadow/strategy/:strategy', authMiddleware, async (req, res) => {
  const strategy = String(req.params.strategy || '').trim();
  if (!strategy || strategy.length > 180) {
    return res.status(400).json({ error: 'Invalid strategy id' });
  }
  try {
    const value = await dashboardReports.get(`borg-strategy-dossier:${strategy}`, 10_000, async () => {
      const client = await pool.connect();
      try {
        const [trialResult, runtimeResult, epochResult, historyResult] = await Promise.all([
          client.query(`
            SELECT strategy,status,status_reason,experiment_id,variant,family,phase,
                   evidence_started_at,frozen_at,min_independent_markets,min_days,
                   primary_metric,status_decided_at,status_manifest_id
              FROM borg_trial_ledger
             WHERE strategy=$1
             ORDER BY frozen_at DESC,id DESC
             LIMIT 1
          `, [strategy]),
          client.query(`
            WITH active_run AS (
              SELECT run_id FROM borg_collector_runs
               WHERE status='RUNNING' ORDER BY started_at DESC LIMIT 1
            )
            SELECT r.strategy,r.collector_run_id,r.epoch_id,r.cadence,r.market_types,
                   r.started_at,r.last_evaluated_at,r.evaluations::float evaluations,
                   r.halted_evaluations::float halted_evaluations,
                   r.actions::float actions,r.errors::float errors,r.last_action_at,
                   r.updated_at,r.diagnostics
              FROM borg_strategy_runtime r
              JOIN active_run a ON a.run_id=r.collector_run_id
             WHERE r.strategy=$1
          `, [strategy]),
          client.query(`
            SELECT r.epoch_id,e.started_at
              FROM borg_collector_runs r
              JOIN borg_collection_epochs e ON e.epoch_id=r.epoch_id
             WHERE r.status='RUNNING'
             ORDER BY r.started_at DESC
             LIMIT 1
          `),
          client.query(`
            SELECT experiment_id,variant,family,phase,status,status_reason,
                   frozen_at,evidence_started_at,min_independent_markets,min_days,
                   primary_metric,status_decided_at,status_manifest_id
              FROM borg_trial_ledger
             WHERE strategy=$1
             ORDER BY frozen_at DESC,id DESC
          `, [strategy]),
        ]);
        const trial = trialResult.rows[0] || null;
        const runtime = runtimeResult.rows[0] || null;
        const epoch = epochResult.rows[0] || null;
        const dossier = dossierFor(strategy, {
          trialStatus: trial?.status,
          trialStatusReason: trial?.status_reason,
          runtimePresent: !!runtime,
          runtimeUpdatedAt: runtime?.updated_at,
          evaluations: parseFloat(runtime?.evaluations || 0),
          actions: parseFloat(runtime?.actions || 0),
        });

        const response = {
          ...dossier,
          trial,
          runtime: runtime ? {
            ...runtime,
            evaluations: parseFloat(runtime.evaluations || 0),
            halted_evaluations: parseFloat(runtime.halted_evaluations || 0),
            actions: parseFloat(runtime.actions || 0),
            errors: parseFloat(runtime.errors || 0),
          } : null,
          activeEpoch: epoch,
          trialHistory: historyResult.rows,
          evidence: null,
          chronologicalHalves: null,
          byDay: [],
          byAsset: [],
          recent: [],
        };
        if (!trial || !epoch) return response;

        const cohortParams = [
          strategy,
          trial.experiment_id,
          trial.variant,
          trial.phase,
          epoch.epoch_id,
          new Date(Math.max(
            new Date(trial.evidence_started_at).getTime(),
            new Date(epoch.started_at).getTime(),
          )),
          RESEARCH_CAPITAL_VERSION,
        ];
        const cohortWhere = `
          o.strategy=$1
          AND o.experiment_id=$2
          AND COALESCE(o.arm,'baseline')=$3
          AND o.phase=$4
          AND o.features->>'collection_epoch_id'=$5
          AND COALESCE(o.available_at,o.ts)>=$6
          AND o.features->>'research_capital_version'=$7
        `;
        const [evidenceResult, halvesResult, dayResult, assetResult, recentResult] = await Promise.all([
          client.query(`
            SELECT count(*) FILTER (WHERE o.action='place')::int places,
                   count(*) FILTER (WHERE o.action='cancel')::int cancels,
                   count(s.order_id)::int scored,
                   count(*) FILTER (WHERE s.filled)::int fills,
                   count(*) FILTER (
                     WHERE s.filled
                       AND s.data_quality_grade IN ('A','B')
                       AND s.execution_fidelity_grade IN ('A','B')
                   )::int eligible_fills,
                   count(DISTINCT o.market_id) FILTER (
                     WHERE s.filled
                       AND s.data_quality_grade IN ('A','B')
                       AND s.execution_fidelity_grade IN ('A','B')
                   )::int independent_markets,
                   count(DISTINCT (COALESCE(o.available_at,o.ts) AT TIME ZONE 'UTC')::date)
                     FILTER (WHERE s.filled
                       AND s.data_quality_grade IN ('A','B')
                       AND s.execution_fidelity_grade IN ('A','B'))::int utc_days,
                   COALESCE(sum(s.pnl_1x) FILTER (
                     WHERE s.filled
                       AND s.data_quality_grade IN ('A','B')
                       AND s.execution_fidelity_grade IN ('A','B')),0)::float pnl_1x,
                   COALESCE(sum(s.pnl_2x) FILTER (
                     WHERE s.filled
                       AND s.data_quality_grade IN ('A','B')
                       AND s.execution_fidelity_grade IN ('A','B')),0)::float pnl_2x,
                   min(COALESCE(o.available_at,o.ts)) first_observation_at,
                   max(COALESCE(o.available_at,o.ts)) last_observation_at
              FROM borg_shadow_orders o
              LEFT JOIN borg_shadow_scores s ON s.order_id=o.id
             WHERE ${cohortWhere}
          `, cohortParams),
          client.query(`
            WITH eligible AS (
              SELECT s.pnl_1x::float pnl_1x,s.pnl_2x::float pnl_2x,
                     row_number() OVER (
                       ORDER BY COALESCE(o.available_at,o.ts),o.id
                     ) sequence,
                     count(*) OVER () total
                FROM borg_shadow_orders o
                JOIN borg_shadow_scores s ON s.order_id=o.id
               WHERE ${cohortWhere}
                 AND s.filled
                 AND s.data_quality_grade IN ('A','B')
                 AND s.execution_fidelity_grade IN ('A','B')
            )
            SELECT count(*)::int n,
                   COALESCE(sum(pnl_1x) FILTER (WHERE sequence <= CEIL(total/2.0)),0)::float first_half_1x,
                   COALESCE(sum(pnl_1x) FILTER (WHERE sequence > CEIL(total/2.0)),0)::float second_half_1x,
                   COALESCE(sum(pnl_2x) FILTER (WHERE sequence <= CEIL(total/2.0)),0)::float first_half_2x,
                   COALESCE(sum(pnl_2x) FILTER (WHERE sequence > CEIL(total/2.0)),0)::float second_half_2x
              FROM eligible
          `, cohortParams),
          client.query(`
            SELECT (COALESCE(o.available_at,o.ts) AT TIME ZONE 'UTC')::date AS utc_day,
                   count(*)::int fills,count(DISTINCT o.market_id)::int markets,
                   COALESCE(sum(s.pnl_1x),0)::float pnl_1x,
                   COALESCE(sum(s.pnl_2x),0)::float pnl_2x
              FROM borg_shadow_orders o
              JOIN borg_shadow_scores s ON s.order_id=o.id
             WHERE ${cohortWhere}
               AND s.filled
               AND s.data_quality_grade IN ('A','B')
               AND s.execution_fidelity_grade IN ('A','B')
             GROUP BY 1 ORDER BY 1 DESC LIMIT 30
          `, cohortParams),
          client.query(`
            SELECT COALESCE(NULLIF(o.features->>'asset',''),'unknown') asset,
                   count(*)::int fills,count(DISTINCT o.market_id)::int markets,
                   COALESCE(sum(s.pnl_1x),0)::float pnl_1x,
                   COALESCE(sum(s.pnl_2x),0)::float pnl_2x
              FROM borg_shadow_orders o
              JOIN borg_shadow_scores s ON s.order_id=o.id
             WHERE ${cohortWhere}
               AND s.filled
               AND s.data_quality_grade IN ('A','B')
               AND s.execution_fidelity_grade IN ('A','B')
             GROUP BY 1 ORDER BY pnl_2x DESC
          `, cohortParams),
          client.query(`
            SELECT o.id,o.ts,o.market_id,o.action,o.side,o.token,
                   o.price::float price,o.size::float size,o.tte_sec::float tte_sec,
                   o.order_kind,o.features->>'note' note,o.features->>'asset' asset,
                   s.filled,s.pnl_1x::float pnl_1x,s.pnl_2x::float pnl_2x,
                   s.data_quality_grade,s.execution_fidelity_grade
              FROM borg_shadow_orders o
              LEFT JOIN borg_shadow_scores s ON s.order_id=o.id
             WHERE ${cohortWhere}
             ORDER BY o.id DESC LIMIT 12
          `, cohortParams),
        ]);
        response.evidence = evidenceResult.rows[0] || null;
        response.chronologicalHalves = halvesResult.rows[0] || null;
        response.byDay = dayResult.rows;
        response.byAsset = assetResult.rows;
        response.recent = recentResult.rows;
        return response;
      } finally {
        client.release();
      }
    });
    return res.json(value);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// --- H53 independently gated live mirror (explicit unproven operator override) ---
router.get('/h53/live', authMiddleware, async (req, res) => {
  try {
    const value = await dashboardReports.get(`borg-h53-live:${req.userId}`, 5_000, async () => {
      const client = await pool.connect();
      try {
        const [heartbeat, settings, totals, recent] = await Promise.all([
          client.query(`SELECT beat_at,meta FROM system_heartbeats WHERE component='h53_live'`),
          client.query(`SELECT COALESCE(live_h53_enabled,false) enabled FROM bot_settings WHERE user_id=$1`, [req.userId]),
          client.query(`SELECT
              count(*)::int decisions,
              count(*) FILTER (WHERE NOT dry_run)::int live_decisions,
              count(*) FILTER (WHERE NOT dry_run AND matched_shares>0)::int matched,
              count(*) FILTER (WHERE NOT dry_run AND (status='ERROR' OR status LIKE '%INVARIANT%'))::int errors,
              count(*) FILTER (WHERE status LIKE 'SKIPPED_%')::int skipped,
              COALESCE(sum(requested_notional) FILTER (WHERE NOT dry_run AND status NOT LIKE 'SKIPPED_%' AND status<>'ERROR'),0)::float submitted_notional,
              COALESCE(sum(matched_notional) FILTER (WHERE NOT dry_run),0)::float matched_notional,
              COALESCE(sum(fee_paid) FILTER (WHERE NOT dry_run),0)::float fees_paid,
              COALESCE(sum(matched_notional+COALESCE(fee_paid,0)) FILTER (WHERE NOT dry_run),0)::float economic_cost,
              COALESCE(sum(realized_pnl) FILTER (WHERE NOT dry_run),0)::float realized_pnl,
              count(*) FILTER (WHERE NOT dry_run AND matched_shares>0 AND resolved_outcome IS NULL)::int unresolved,
              avg(acknowledgement_latency_ms) FILTER (WHERE NOT dry_run)::float avg_ack_ms,
              max(created_at) latest
            FROM h53_live_orders`),
          client.query(`SELECT id,created_at,token,signal_price::float,signal_size::float,
              requested_notional::float,worst_price::float,dry_run,status,
              acknowledgement_latency_ms,matched_shares::float,matched_notional::float,
              average_fill_price::float,fee_paid::float,fee_rate::float,fee_exponent::float,
              tick_size::float,resolved_outcome,realized_pnl::float,error
            FROM h53_live_orders ORDER BY id DESC LIMIT 40`),
        ]);
        const beat = heartbeat.rows[0] || null;
        const ageSec = beat?.beat_at
          ? Math.max(0, Math.round((Date.now() - new Date(beat.beat_at).getTime()) / 1000))
          : null;
        return {
          strategy: 'H53_5m_neareven_favorite_live_v1',
          evidenceStatus: 'UNPROVEN_OPERATOR_OVERRIDE',
          dbEnabled: settings.rows[0]?.enabled === true,
          alive: ageSec != null && ageSec < 30,
          heartbeatAgeSec: ageSec,
          mode: beat?.meta?.dryRun === false ? 'LIVE' : 'DRY',
          walletBalanceUsdc: beat?.meta?.balanceUsdc ?? null,
          errorsObserved: beat?.meta?.errors ?? null,
          executionHaltReason: beat?.meta?.executionHaltReason ?? null,
          totals: totals.rows[0] || {},
          recent: recent.rows,
        };
      } finally {
        client.release();
      }
    });
    res.json(value);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- ETH-only exact G-late canary (post-hoc hypothesis; independently gated) ---
router.get('/eth-g-late/live', authMiddleware, async (req, res) => {
  try {
    const value = await dashboardReports.get(`borg-eth-g-late-live:${req.userId}`, 5_000, async () => {
      const client = await pool.connect();
      try {
        const [heartbeat, settings, totals, recent, evidence] = await Promise.all([
          client.query(`SELECT beat_at,meta FROM system_heartbeats
            WHERE component='eth_g_late_live'`),
          client.query(`SELECT COALESCE(live_eth_g_late_enabled,false) enabled
            FROM bot_settings WHERE user_id=$1`, [req.userId]),
          client.query(`SELECT
              count(*)::int decisions,
              count(*) FILTER (WHERE NOT dry_run)::int live_decisions,
              count(*) FILTER (WHERE NOT dry_run AND matched_shares>0)::int matched,
              count(*) FILTER (WHERE NOT dry_run AND status IN
                ('ERROR','ERROR_AFTER_ORDER_ACK','MATCHED_FILL_INVARIANT'))::int errors,
              count(*) FILTER (WHERE status LIKE 'SKIPPED_%')::int skipped,
              COALESCE(sum(requested_notional) FILTER
                (WHERE NOT dry_run AND status NOT LIKE 'SKIPPED_%' AND status<>'ERROR'),0)::float submitted_notional,
              COALESCE(sum(matched_notional) FILTER (WHERE NOT dry_run),0)::float matched_notional,
              COALESCE(sum(fee_paid) FILTER (WHERE NOT dry_run),0)::float fees_paid,
              COALESCE(sum(realized_pnl) FILTER (WHERE NOT dry_run),0)::float realized_pnl,
              count(*) FILTER (WHERE NOT dry_run AND matched_shares>0
                AND resolved_outcome IS NULL)::int unresolved,
              avg(acknowledgement_latency_ms) FILTER (WHERE NOT dry_run)::float avg_ack_ms,
              max(created_at) latest
            FROM eth_g_late_live_orders`),
          client.query(`SELECT id,created_at,token,signal_price::float,
              source_notional::float,requested_notional::float,worst_price::float,
              dry_run,status,acknowledgement_latency_ms,matched_shares::float,
              matched_notional::float,average_fill_price::float,fee_paid::float,
              resolved_outcome,realized_pnl::float,error
            FROM eth_g_late_live_orders ORDER BY id DESC LIMIT 40`),
          client.query(`WITH source AS (
              SELECT id,market_id,ts FROM borg_shadow_orders
              WHERE strategy='ETH_G_late_exact_forward_v1' AND action='place'
            ), base AS (
              SELECT s.* FROM borg_shadow_scores s JOIN source o ON o.id=s.order_id
            ), l250 AS (
              SELECT l.* FROM borg_shadow_latency_scores l JOIN source o ON o.id=l.order_id
              WHERE l.latency_ms=250
            )
            SELECT
              (SELECT count(*)::int FROM source) shadow_signals,
              (SELECT count(DISTINCT market_id)::int FROM source) independent_markets,
              (SELECT count(DISTINCT (ts AT TIME ZONE 'UTC')::date)::int FROM source) utc_days,
              (SELECT count(*) FILTER (WHERE filled)::int FROM base) base_fills,
              (SELECT COALESCE(sum(pnl_2x) FILTER (WHERE filled),0)::float FROM base) base_pnl_2x,
              (SELECT count(*) FILTER (WHERE filled)::int FROM l250) latency_250_fills,
              (SELECT COALESCE(sum(pnl_2x) FILTER (WHERE filled),0)::float FROM l250) latency_250_pnl_2x`),
        ]);
        const beat = heartbeat.rows[0] || null;
        const ageSec = beat?.beat_at
          ? Math.max(0, Math.round((Date.now() - new Date(beat.beat_at).getTime()) / 1000))
          : null;
        const geo = beat?.meta?.geoblock || null;
        return {
          strategy: 'ETH_G_late_exact_forward_v1',
          evidenceStatus: 'POSTHOC_UNPROVEN_LIVE_CANARY',
          historicalDiscoveryRateUsdPerDay: 22,
          historicalRateIsForecast: false,
          dbEnabled: settings.rows[0]?.enabled === true,
          alive: ageSec != null && ageSec < 30,
          heartbeatAgeSec: ageSec,
          mode: beat?.meta?.mode || (beat?.meta?.dryRun === false ? 'LIVE' : 'OFFLINE'),
          walletBalanceUsdc: beat?.meta?.balanceUsdc ?? null,
          geoblock: geo,
          executionHaltReason: beat?.meta?.executionHaltReason ?? null,
          errorsObserved: beat?.meta?.errors ?? null,
          risk: {
            maxOrderUsd: 5,
            maxOrdersPerUtcDay: 5,
            maxSpendPerUtcDay: 25,
            maxResolvedLossPerUtcDay: 10,
            maxPilotSubmissions: 50,
          },
          freshEvidence: evidence.rows[0] || {},
          totals: totals.rows[0] || {},
          recent: recent.rows,
        };
      } finally {
        client.release();
      }
    });
    res.json(value);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Recent shadow orders (places + cancels), scored PnL where available ---
router.get('/shadow/orders', authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(200, parseInt(req.query.limit, 10) || 50);
    const value = await dashboardReports.get(`borg-shadow-orders:${limit}`, 5_000, async () => {
      const { rows } = await pool.query(`
        SELECT o.id, o.ts, o.strategy, o.phase, o.action, o.side, o.token,
               o.price, o.size, o.tte_sec, o.order_kind, o.queue_ahead,
               o.experiment_id, o.arm, o.latency_profile,
               o.features->>'note' AS note,
               s.filled, s.fill_size, s.pnl_1x, s.outcome,
               s.data_quality_grade, s.execution_fidelity_grade, s.fidelity_level
        FROM borg_shadow_orders o
        LEFT JOIN borg_shadow_scores s ON s.order_id = o.id
        WHERE o.features->>'research_capital_version' = $1
        ORDER BY o.id DESC LIMIT $2`, [RESEARCH_CAPITAL_VERSION, limit]);
      return rows;
    });
    res.json(value);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Immutable trial registry + prospective sample progress ---
router.get('/research/experiments', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      WITH observations AS (
        SELECT 'borg:' || o.id::text observation_id, o.experiment_id, o.strategy,
               COALESCE(o.arm,'baseline') arm, o.available_at,
               o.market_id::text market_id, s.data_quality_grade
          FROM borg_shadow_orders o
          LEFT JOIN borg_shadow_scores s ON s.order_id=o.id
         WHERE o.action='place'
        UNION ALL
        SELECT 'allmarket:' || o.intent_id, o.experiment_id, o.strategy,
               COALESCE(o.arm,'baseline') arm, o.available_at,
               o.condition_id market_id, s.data_quality_grade
          FROM am_order_intents o
          LEFT JOIN am_execution_scores s USING (intent_id)
         WHERE o.action='PLACE'
        UNION ALL
        SELECT 'pairedmaker:' || c.cycle_id, c.experiment_id, c.strategy,
               c.arm, c.first_fill_at available_at,
               c.condition_id market_id, c.data_quality_grade
          FROM pmm_cycles c
         WHERE c.first_fill_at IS NOT NULL
      )
      SELECT l.experiment_id, l.strategy, l.variant, l.family, l.phase, l.status,
             l.primary_metric, l.min_independent_markets, l.min_days,
             l.frozen_at, l.evidence_started_at, l.manifest_hash,
             count(o.observation_id)::int intended_signals,
             count(DISTINCT o.market_id)::int independent_markets,
             count(DISTINCT (o.available_at AT TIME ZONE 'UTC')::date)::int calendar_days,
             count(o.observation_id) FILTER (WHERE o.data_quality_grade IN ('A','B'))::int quality_ab,
             count(o.observation_id) FILTER (WHERE o.data_quality_grade='F')::int quality_f
      FROM borg_trial_ledger l
      LEFT JOIN observations o
        ON o.experiment_id=l.experiment_id AND o.strategy=l.strategy
       AND COALESCE(o.arm,'baseline')=l.variant AND o.available_at >= l.evidence_started_at
      GROUP BY l.id ORDER BY l.family, l.strategy, l.variant`);
    res.json({
      evidenceRule: 'Forward-only from evidence_started_at; independent markets and UTC days, never raw order count.',
      trials: rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Data/execution fidelity distribution. F grades are retained, not hidden. ---
router.get('/research/quality', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT COALESCE(s.data_quality_grade,'UNSCORED') data_quality_grade,
             COALESCE(s.execution_fidelity_grade,'UNSCORED') execution_fidelity_grade,
             COALESCE(s.fidelity_level,'UNCLASSIFIED') fidelity_level,
             count(*)::int n
      FROM borg_shadow_orders o
      LEFT JOIN borg_shadow_scores s ON s.order_id=o.id
      WHERE o.action='place' AND o.experiment_id IS NOT NULL
      GROUP BY 1,2,3 ORDER BY 1,2,3`);
    const { rows: registration } = await pool.query(`
      SELECT count(*) FILTER (WHERE experiment_id IS NOT NULL)::int registered,
             count(*) FILTER (WHERE experiment_id IS NULL)::int legacy_unregistered
      FROM borg_shadow_orders WHERE action='place'`);
    res.json({ registration: registration[0], grades: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Shared-capital paper scenario: one $500 account, one market owner, one capacity pool. ---
router.get('/research/portfolio', authMiddleware, async (req, res) => {
  try {
    const phase = ['pilot', 'eval'].includes(req.query.phase) ? req.query.phase : 'pilot';
    const value = await dashboardReports.get(`borg-research-portfolio:${phase}`, 30_000, async () => {
      const { rows } = await pool.query(`
        SELECT o.id, o.strategy, o.market_id, o.token, o.ts, o.available_at,
               o.source_event_id, o.features, s.filled, s.fill_ts, s.fill_price, s.fill_size,
               s.pnl_gross, s.pnl_1x, s.pnl_2x, s.detail, m.window_end, m.resolved_at
        FROM borg_shadow_orders o
        JOIN borg_shadow_scores s ON s.order_id=o.id
        JOIN borg_markets m ON m.id=o.market_id
        WHERE o.action='place' AND o.phase=$1 AND o.experiment_id IS NOT NULL
          AND o.features->>'research_capital_version'=$2
        ORDER BY COALESCE(s.fill_ts,o.available_at,o.ts), o.id`, [phase, RESEARCH_CAPITAL_VERSION]);
      const result = simulatePortfolio(rows.map((row) => ({
        orderId: String(row.id), strategy: row.strategy, marketId: String(row.market_id), token: row.token,
        ts: row.ts, availableAt: row.available_at, sourceEventId: row.source_event_id,
        filled: row.filled, fillTs: row.fill_ts, fillPrice: row.fill_price, fillSize: row.fill_size,
        pnlGross: row.pnl_gross, pnl1x: row.pnl_1x, pnl2x: row.pnl_2x,
        detail: row.detail, capacityAtArrival: row.detail?.capacity_at_arrival,
        capacityKey: row.detail?.clob_event_sequence != null
          ? `${row.market_id}:${row.token}:${row.detail.clob_connection_epoch}:${row.detail.clob_event_sequence}` : null,
        groupId: row.features?.group_id, windowEnd: row.window_end, resolvedAt: row.resolved_at,
      })));
      return { phase, evidence: phase === 'eval' ? 'prospective evaluation scenario' : 'pilot machinery only', ...result };
    });
    res.json(value);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Recent collector/shadow events (the BORG log) ---
router.get('/events', authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 30);
    const level = req.query.level === 'warn' ? ['WARN', 'ERROR'] : ['INFO', 'WARN', 'ERROR'];
    const cacheKey = `borg-events:${req.query.level === 'warn' ? 'warn' : 'all'}:${limit}`;
    const value = await dashboardReports.get(cacheKey, 5_000, async () => {
      const { rows } = await pool.query(`
        SELECT ts, level, source, message FROM borg_events
        WHERE level = ANY($1) AND source <> 'heartbeat'
        ORDER BY id DESC LIMIT $2`, [level, limit]);
      return rows;
    });
    res.json(value);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Public-flow scalp laboratory (completed public events, paper only) ---
router.get('/flow/status', authMiddleware, async (req, res) => {
  try {
    const [heartbeat, markets, canaryHeartbeat, canaryCounts, canarySetting] = await Promise.all([
      pool.query(`SELECT ts,data FROM borg_events WHERE source='flow_heartbeat' ORDER BY id DESC LIMIT 1`),
      pool.query(`SELECT count(*) FILTER (WHERE selected_realtime)::int selected,
                         max(refreshed_at) refreshed_at FROM pm_flow_markets`),
      pool.query(`SELECT beat_at,meta FROM system_heartbeats WHERE component='flow_boundary_canary'`),
      pool.query(`SELECT count(*)::int intents,
                         count(*) FILTER (WHERE status='READY')::int ready,
                         count(*) FILTER (WHERE status='REJECTED')::int rejected,
                         max(updated_at) latest
                    FROM pm_flow_boundary_intents`),
      pool.query(`SELECT COALESCE(live_flow_boundary_enabled,false) enabled
                    FROM bot_settings WHERE user_id=$1`, [req.userId]),
    ]);
    const hb = heartbeat.rows[0] || null;
    const now = Date.now();
    const age = (value) => value ? Math.max(0, Math.round((now - new Date(value).getTime()) / 1000)) : null;
    const data = hb?.data || {};
    const socketTimes = Array.isArray(data.lastSocketMessageAt)
      ? data.lastSocketMessageAt.map(Number).filter(Number.isFinite) : [];
    const realtimeLatestMs = socketTimes.length ? Math.max(...socketTimes) : null;
    const globalResponseMs = Number(data.lastGlobalResponseAt);
    const globalLatest = data.lastGlobalResponseAt != null
      && Number.isFinite(globalResponseMs) && globalResponseMs > 0
      ? new Date(globalResponseMs) : data.wal?.global?.lastAppendAt || null;
    const realtimeLatest = realtimeLatestMs
      ? new Date(realtimeLatestMs) : data.wal?.clob?.lastAppendAt || null;
    const signalCount = parseInt(data.signals, 10) || 0;
    const scoredCount = parseInt(data.scored, 10) || 0;
    res.json({
      alive: hb ? age(hb.ts) < 150 : false,
      heartbeatAt: hb?.ts || null,
      counters: data,
      selectedMarkets: markets.rows[0].selected,
      universeRefreshedAt: markets.rows[0].refreshed_at,
      trades: {
        counter_window: 'collector_run', run_started_at: data.startedAt || null,
        global_run: parseInt(data.globalTrades, 10) || 0,
        realtime_run: parseInt(data.realtimeTrades, 10) || 0,
        global_latest: globalLatest, realtime_latest: realtimeLatest,
        global_age_sec: age(globalLatest), realtime_age_sec: age(realtimeLatest),
      },
      signals: {
        challenger_signals: signalCount,
        challenger_sweeps: parseInt(data.eligibleSweeps, 10) || 0,
        pending: Math.max(0, signalCount - scoredCount),
        challenger_scored: scoredCount,
        challenger_filled: parseInt(data.filled, 10) || 0,
      },
      boundaryCanary: {
        experimentId: 'flow-late-absorption-boundary-v3',
        processAlive: canaryHeartbeat.rows[0]
          ? age(canaryHeartbeat.rows[0].beat_at) < 30 : false,
        heartbeatAt: canaryHeartbeat.rows[0]?.beat_at || null,
        dryRun: canaryHeartbeat.rows[0]?.meta?.dryRun !== false,
        dbLiveGate: canarySetting.rows[0]?.enabled === true,
        ...canaryCounts.rows[0],
        evidenceStatus: 'UNPROVEN_POST_SELECTED',
      },
      contract: {
        mode: data.clobCaptureEnabled === true
          ? 'PAPER_ONLY' : 'BROAD_CAPTURE_ONLY_CLOB_STRATEGY_PAUSED',
        status: data.clobCaptureEnabled === true
          ? 'TESTING' : 'PAUSED_NEGATIVE_CONTROL',
        pendingOrderVisibility: false,
        globalScanner: 'all completed public Data API trades; delayed discovery only',
        realtimePanel: data.clobCaptureEnabled === true
          ? 'bounded high-volume market-channel panel; causal scalp evaluation'
          : 'disabled after correlated same-egress socket resets; historical events retained',
        liveOrderPath: 'separate independently gated canary; default dry',
        startingBankrollUsd: 500, targetStakeUsd: 10,
        activeStrategyVersion: data.clobCaptureEnabled === true
          ? CHALLENGER_STRATEGY_VERSION : null,
        retiredControl: 'public-flow-scalp-v1 retained as a negative historical control',
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/flow/summary', authMiddleware, async (req, res) => {
  try {
    const value = await dashboardReports.get('flow-summary', 15_000, async () => {
      const { rows } = await pool.query(`
      SELECT COALESCE(s.features->>'strategy_version','legacy') strategy_version,
             s.arm,s.latency_ms,
             count(*)::int signals,
             count(DISTINCT s.trigger_key)::int independent_sweeps,
             count(sc.signal_id)::int scored,
             count(sc.signal_id) FILTER (WHERE sc.filled)::int raw_fills,
             count(sc.signal_id) FILTER (WHERE sc.filled
               AND sc.data_quality_grade IN ('A','B'))::int fills,
             count(sc.signal_id) FILTER (WHERE sc.pnl_5s>0
               AND sc.data_quality_grade IN ('A','B'))::int wins_5s,
             COALESCE(sum(sc.pnl_1s) FILTER (WHERE sc.filled
               AND sc.data_quality_grade IN ('A','B')),0)::float pnl_1s,
             COALESCE(sum(sc.pnl_2s) FILTER (WHERE sc.filled
               AND sc.data_quality_grade IN ('A','B')),0)::float pnl_2s,
             COALESCE(sum(sc.pnl_5s) FILTER (WHERE sc.filled
               AND sc.data_quality_grade IN ('A','B')),0)::float pnl_5s,
             COALESCE(sum(sc.pnl_10s) FILTER (WHERE sc.filled
               AND sc.data_quality_grade IN ('A','B')),0)::float pnl_10s,
             count(sc.signal_id) FILTER (WHERE sc.filled
               AND sc.data_quality_grade IN ('A','B')
               AND s.available_at>=now()-interval '6 hours')::int fills_6h,
             COALESCE(sum(sc.pnl_5s) FILTER (WHERE sc.filled
               AND sc.data_quality_grade IN ('A','B')
               AND s.available_at>=now()-interval '6 hours'),0)::float pnl_5s_6h,
             count(sc.signal_id) FILTER (WHERE sc.filled
               AND sc.data_quality_grade IN ('A','B')
               AND s.available_at>=now()-interval '24 hours')::int fills_24h,
             COALESCE(sum(sc.pnl_5s) FILTER (WHERE sc.filled
               AND sc.data_quality_grade IN ('A','B')
               AND s.available_at>=now()-interval '24 hours'),0)::float pnl_5s_24h,
             count(sc.signal_id) FILTER (WHERE sc.filled
               AND sc.data_quality_grade IN ('A','B')
               AND s.available_at>=now()-interval '3 days')::int fills_3d,
             COALESCE(sum(sc.pnl_5s) FILTER (WHERE sc.filled
               AND sc.data_quality_grade IN ('A','B')
               AND s.available_at>=now()-interval '3 days'),0)::float pnl_5s_3d,
             avg(sc.pnl_5s) FILTER (WHERE sc.filled
               AND sc.data_quality_grade IN ('A','B'))::float mean_pnl_5s,
             count(sc.signal_id) FILTER (WHERE sc.data_quality_grade IN ('A','B'))::int quality_ab,
             max(s.decision_at) latest
        FROM pm_flow_signals s
        LEFT JOIN pm_flow_scores sc ON sc.signal_id=s.id
       GROUP BY 1,s.arm,s.latency_ms ORDER BY 1,s.arm,s.latency_ms`);
      return {
        phase: 'forward_pilot', evidence: false,
        activeStrategyVersion: CHALLENGER_STRATEGY_VERSION,
        warning: 'Latency and arm rows reuse the same trigger/capital. Never sum them as a portfolio.',
        primaryRead: 'Fresh V2 A/B-grade fills only: 5-second net markout after exact round-trip taker fees; require 300 independent sweeps and 30 days.',
        rows,
      };
    });
    res.json(value);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/flow/signals', authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(200, parseInt(req.query.limit, 10) || 50);
    const { rows } = await pool.query(`
      SELECT s.id,s.decision_at,s.condition_id,s.target_outcome,s.arm,s.latency_ms,
             COALESCE(s.features->>'strategy_version','legacy') strategy_version,
             s.entry_limit::float,s.requested_size::float,s.status,s.data_quality_grade,
             t.side trigger_side,t.price::float trigger_price,t.size::float trigger_size,
             t.notional::float trigger_notional,t.source_latency_ms,
             m.question,m.slug,
             sc.filled,sc.entry_price::float,sc.fill_size::float,
             sc.pnl_1s::float,sc.pnl_2s::float,sc.pnl_5s::float,sc.pnl_10s::float,
             sc.data_quality_grade score_quality,sc.execution_fidelity_grade
        FROM pm_flow_signals s
        JOIN pm_flow_trades t ON t.id=s.trigger_trade_id
        LEFT JOIN pm_flow_markets m ON m.condition_id=s.condition_id
        LEFT JOIN pm_flow_scores sc ON sc.signal_id=s.id
       ORDER BY s.id DESC LIMIT $1`, [limit]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/flow/boundary-canary', authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 30);
    const { rows } = await pool.query(`
      SELECT i.id,i.created_at,i.updated_at,i.condition_id,i.target_outcome,
             i.signal_available_at,i.boundary_at,i.tte_ms,i.order_latency_ms,
             i.arrival_state_age_ms,i.arrival_ask::float,i.arrival_ask_size::float,
             i.minimum_order_size::float,i.requested_size::float,
             i.requested_notional::float,i.status,i.reason,i.data_quality_grade,
             m.slug,m.question,
             o.dry_run,o.status order_status,o.clob_order_id,
             o.acknowledgement_latency_ms,o.average_fill_price::float,
             o.matched_notional::float,o.realized_pnl::float,o.error
        FROM pm_flow_boundary_intents i
        LEFT JOIN pm_flow_markets m ON m.condition_id=i.condition_id
        LEFT JOIN flow_boundary_canary_orders o ON o.intent_id=i.id
       ORDER BY i.id DESC LIMIT $1`, [limit]);
    res.json({
      warning: 'Discovery PnL is not a forecast. V3 forward evidence starts from zero after enforcing the venue minimum share size.',
      rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- All-market event-driven L2/passive-making laboratory (paper only) ---
router.get('/allmarket/status', authMiddleware, async (req, res) => {
  try {
    const [heartbeat, runtime, markets, activity] = await Promise.all([
      pool.query(`SELECT beat_at,meta FROM system_heartbeats WHERE component='allmarket_lab'`),
      pool.query(`SELECT * FROM am_runtime ORDER BY started_at DESC LIMIT 1`),
      pool.query(`SELECT count(*)::int scanned,
                         count(*) FILTER (WHERE selected_realtime)::int selected,
                         count(DISTINCT category) FILTER (WHERE selected_realtime)::int categories,
                         max(refreshed_at) refreshed_at
                    FROM am_markets`),
      pool.query(`SELECT count(*) FILTER (WHERE decision_at>now()-interval '1 hour')::int intents_1h,
                         count(*) FILTER (WHERE action='PLACE' AND decision_at>now()-interval '1 hour')::int places_1h,
                         count(s.intent_id) FILTER (WHERE s.filled AND i.decision_at>now()-interval '1 hour')::int fills_1h,
                         max(i.decision_at) latest_intent,
                         max(s.scored_at) latest_score
                    FROM am_order_intents i LEFT JOIN am_execution_scores s USING (intent_id)`),
    ]);
    const hb = heartbeat.rows[0] || null;
    const ageSec = hb ? Math.max(0, Math.round((Date.now() - new Date(hb.beat_at).getTime()) / 1000)) : null;
    res.json({
      alive: ageSec != null && ageSec < 30,
      heartbeatAt: hb?.beat_at || null,
      heartbeatAgeSec: ageSec,
      contract: {
        mode: 'PAPER_ONLY', walletLoaded: false, liveOrderPath: 'absent',
        internalTargetMs: '20-50', databaseInHotPath: false,
        startingBankrollUsd: STARTING_BANKROLL_USD,
      },
      runtime: runtime.rows[0] || null,
      universe: {
        ...markets.rows[0],
        scanned: Number(runtime.rows[0]?.metrics?.universeScanned ?? markets.rows[0].scanned),
        hotTierPersisted: Number(runtime.rows[0]?.metrics?.universePersisted ?? markets.rows[0].scanned),
      },
      activity: activity.rows[0],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/allmarket/summary', authMiddleware, async (req, res) => {
  try {
    const value = await dashboardReports.get('allmarket-summary', 15_000, async () => {
      const { rows } = await pool.query(`
      SELECT i.strategy,i.arm,i.latency_ms,
             count(*) FILTER (WHERE i.action='PLACE')::int intents,
             count(s.intent_id)::int scored,
             count(s.intent_id) FILTER (WHERE s.filled)::int fills,
             count(DISTINCT i.condition_id) FILTER (WHERE s.filled)::int filled_markets,
             count(s.intent_id) FILTER (WHERE s.filled AND s.pnl_5s>0)::int wins_5s,
             COALESCE(sum(s.pnl_1s) FILTER (WHERE s.filled),0)::float pnl_1s,
             COALESCE(sum(s.pnl_5s) FILTER (WHERE s.filled),0)::float pnl_5s,
             COALESCE(sum(s.pnl_30s) FILTER (WHERE s.filled),0)::float pnl_30s,
             count(s.intent_id) FILTER (WHERE s.filled
               AND i.available_at>=now()-interval '6 hours')::int fills_6h,
             COALESCE(sum(s.pnl_5s) FILTER (WHERE s.filled
               AND i.available_at>=now()-interval '6 hours'),0)::float pnl_5s_6h,
             count(s.intent_id) FILTER (WHERE s.filled
               AND i.available_at>=now()-interval '24 hours')::int fills_24h,
             COALESCE(sum(s.pnl_5s) FILTER (WHERE s.filled
               AND i.available_at>=now()-interval '24 hours'),0)::float pnl_5s_24h,
             count(s.intent_id) FILTER (WHERE s.filled
               AND i.available_at>=now()-interval '3 days')::int fills_3d,
             COALESCE(sum(s.pnl_5s) FILTER (WHERE s.filled
               AND i.available_at>=now()-interval '3 days'),0)::float pnl_5s_3d,
             avg(s.pnl_5s) FILTER (WHERE s.filled)::float mean_pnl_5s,
             avg(GREATEST(0,-s.pnl_5s)/NULLIF(s.fill_size,0))
               FILTER (WHERE s.filled)::float toxicity_5s_per_share,
             count(s.intent_id) FILTER (WHERE s.data_quality_grade IN ('A','B'))::int quality_ab,
             max(i.decision_at) latest
        FROM am_order_intents i
        LEFT JOIN am_execution_scores s USING (intent_id)
       WHERE i.action='PLACE'
       GROUP BY i.strategy,i.arm,i.latency_ms
       ORDER BY i.strategy,i.arm,i.latency_ms`);
      return {
        phase: 'forward_pilot', evidence: false,
        warning: 'Latency arms reuse each trigger and capital; never sum rows as a portfolio. Rewards and rebates are deliberately excluded until attribution is reconstructible.',
        requirement: 'At least 300 independent markets and 30 days with a positive market-clustered lower confidence bound after fees.',
        rows,
      };
    });
    res.json(value);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/allmarket/markets', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT condition_id,question,category,end_date,liquidity::float,volume_24h::float,
             fee_rate::float,fee_exponent::float,rewards_daily_rate::float,
             rewards_min_size::float,rewards_max_spread::float,
             toxicity_5s_per_share::float,selection_score::float,selection_reason,
             selected_realtime,refreshed_at
        FROM am_markets
       ORDER BY selected_realtime DESC,selection_score DESC NULLS LAST,volume_24h DESC
       LIMIT 200`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/allmarket/intents', authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(500, parseInt(req.query.limit, 10) || 100);
    const { rows } = await pool.query(`
      SELECT i.intent_id,i.decision_at,i.available_at,i.strategy,i.arm,i.action,
             i.condition_id,i.outcome,i.side,i.order_kind,i.post_only,
             i.price::float,i.size::float,i.latency_ms,i.queue_ahead::float,
             i.reaction_us::float,i.data_quality_grade,i.status,
             s.filled,s.fill_price::float,s.fill_size::float,s.fill_reason,
             s.mark_1s::float,s.mark_5s::float,s.mark_30s::float,
             s.pnl_1s::float,s.pnl_5s::float,s.pnl_30s::float,
             m.question,m.category
        FROM am_order_intents i
        LEFT JOIN am_execution_scores s USING (intent_id)
        LEFT JOIN am_markets m USING (condition_id)
       ORDER BY i.decision_at DESC LIMIT $1`, [limit]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Paired complementary-outcome maker laboratory (paper only) ---
router.get('/pairedmaker/status', authMiddleware, async (req, res) => {
  try {
    const [heartbeat, runtime, markets, activity] = await Promise.all([
      pool.query(`SELECT beat_at,meta FROM system_heartbeats WHERE component='paired_maker_lab'`),
      pool.query(`SELECT * FROM pmm_runtime ORDER BY started_at DESC LIMIT 1`),
      pool.query(`SELECT count(*)::int tracked,
                         count(*) FILTER (WHERE selected_realtime)::int selected,
                         count(DISTINCT category) FILTER (WHERE selected_realtime)::int categories,
                         max(refreshed_at) refreshed_at
                    FROM pmm_markets`),
      pool.query(`SELECT count(*) FILTER (WHERE observed_at>now()-interval '1 hour')::int observations_1h,
                         count(*) FILTER (WHERE observed_at>now()-interval '1 hour' AND one_cent_eligible)::int eligible_one_cent_1h,
                         count(*) FILTER (WHERE observed_at>now()-interval '1 hour' AND two_cent_eligible)::int eligible_two_cent_1h,
                         max(observed_at) latest_observation
                    FROM pmm_pair_observations`),
    ]);
    const hb = heartbeat.rows[0] || null;
    const ageSec = hb ? Math.max(0, Math.round((Date.now() - new Date(hb.beat_at).getTime()) / 1000)) : null;
    res.json({
      alive: ageSec != null && ageSec < 30,
      heartbeatAt: hb?.beat_at || null,
      heartbeatAgeSec: ageSec,
      contract: {
        mode: 'PAPER_ONLY', walletLoaded: false, liveOrderPath: 'absent',
        databaseInHotPath: false, startingBankrollUsd: 500,
        targetPairUsdBeforeRewardMinimum: 25, maximumReservedCostPerArmUsd: 250,
        rewardAccounting: 'modeled from public L2; not realized or claimed',
      },
      runtime: runtime.rows[0] || null,
      universe: markets.rows[0],
      activity: activity.rows[0],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/pairedmaker/summary', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT experiment_id,strategy,arm,
             count(*)::int cycles,
             count(*) FILTER (WHERE first_fill_at IS NOT NULL)::int filled_cycles,
             count(*) FILTER (WHERE merged_shares>0)::int merged_cycles,
             count(*) FILTER (WHERE orphan_exit_price IS NOT NULL)::int orphan_exits,
             count(*) FILTER (WHERE closed_at IS NULL
               AND leg0_residual_shares+leg1_residual_shares>0)::int open_orphans,
             count(*) FILTER (WHERE closed_at IS NOT NULL AND total_pnl IS NULL)::int unscored_interruptions,
             count(DISTINCT condition_id) FILTER (WHERE first_fill_at IS NOT NULL)::int independent_markets,
             COALESCE(sum(merged_shares),0)::float merged_shares,
             COALESCE(sum(locked_pnl),0)::float locked_pnl,
             COALESCE(sum(orphan_pnl),0)::float orphan_pnl,
             COALESCE(sum(total_pnl) FILTER (WHERE total_pnl IS NOT NULL),0)::float realized_pnl,
             count(*) FILTER (WHERE total_pnl IS NOT NULL
               AND opened_at>=now()-interval '6 hours')::int scored_6h,
             COALESCE(sum(total_pnl) FILTER (WHERE total_pnl IS NOT NULL
               AND opened_at>=now()-interval '6 hours'),0)::float realized_pnl_6h,
             count(*) FILTER (WHERE total_pnl IS NOT NULL
               AND opened_at>=now()-interval '24 hours')::int scored_24h,
             COALESCE(sum(total_pnl) FILTER (WHERE total_pnl IS NOT NULL
               AND opened_at>=now()-interval '24 hours'),0)::float realized_pnl_24h,
             count(*) FILTER (WHERE total_pnl IS NOT NULL
               AND opened_at>=now()-interval '3 days')::int scored_3d,
             COALESCE(sum(total_pnl) FILTER (WHERE total_pnl IS NOT NULL
               AND opened_at>=now()-interval '3 days'),0)::float realized_pnl_3d,
             COALESCE(sum(modeled_reward_accrual),0)::float modeled_reward,
             COALESCE(sum(total_pnl + modeled_reward_accrual)
               FILTER (WHERE total_pnl IS NOT NULL),0)::float modeled_reward_adjusted_pnl,
             COALESCE(sum(reward_qualified_ms),0)::float reward_qualified_ms,
             count(*) FILTER (WHERE total_pnl>0)::int winning_cycles,
             avg(total_pnl) FILTER (WHERE total_pnl IS NOT NULL)::float mean_cycle_pnl,
             max(opened_at) latest
        FROM pmm_cycles
       GROUP BY experiment_id,strategy,arm ORDER BY strategy,arm`);
    res.json({
      phase: 'forward_pilot', evidence: false,
      warning: 'Arms reuse the same public prints and each models its own $500 account. Never sum them. Realized PnL excludes incentives. Modeled reward is public-L2 attribution, not earned or claimed cash; maker rebates remain zero.',
      requirement: 'At least 300 independent filled markets and 30 days per arm; both halves and 2x-cost stress positive with a market-clustered lower confidence bound above zero.',
      rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/pairedmaker/cycles', authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(500, parseInt(req.query.limit, 10) || 100);
    const { rows } = await pool.query(`
      SELECT c.cycle_id,c.opened_at,c.first_fill_at,c.closed_at,c.strategy,c.arm,
             c.condition_id,c.status,c.target_shares::float,c.min_pair_edge::float,
             c.initial_pair_cost::float,c.leg0_outcome,c.leg0_quote_price::float,
             c.leg0_filled_shares::float,c.leg0_residual_shares::float,
             c.leg1_outcome,c.leg1_quote_price::float,c.leg1_filled_shares::float,
             c.leg1_residual_shares::float,c.merged_shares::float,c.locked_pnl::float,
             c.orphan_exit_price::float,c.orphan_pnl::float,c.total_pnl::float,
             c.modeled_reward_accrual::float,c.modeled_reward_adjusted_pnl::float,
             c.reward_qualified_ms::float,c.reward_daily_rate::float,
             c.reward_min_size::float,c.reward_max_spread::float,
             c.data_quality_grade,c.execution_fidelity_grade,c.detail,
             m.question,m.category,m.game_start_at
        FROM pmm_cycles c LEFT JOIN pmm_markets m USING (condition_id)
       ORDER BY c.opened_at DESC LIMIT $1`, [limit]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/pairedmaker/observations', authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(1000, parseInt(req.query.limit, 10) || 100);
    const { rows } = await pool.query(`
      SELECT o.observed_at,o.condition_id,o.best_bid_sum::float,o.best_ask_sum::float,
             o.gross_pair_edge::float,o.book_skew_ms::float,o.max_state_age_ms::float,
             o.one_cent_eligible,o.two_cent_eligible,o.data_quality_grade,o.detail,
             m.question,m.category
        FROM pmm_pair_observations o LEFT JOIN pmm_markets m USING (condition_id)
       ORDER BY o.observed_at DESC LIMIT $1`, [limit]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/structural/summary', authMiddleware, async (req, res) => {
  try {
    const value = await dashboardReports.get('structural-summary', 15_000, async () => {
      const [heartbeat, candidates, rows, passive, orderedStrike] = await Promise.all([
        pool.query(`SELECT beat_at,meta FROM system_heartbeats WHERE component='structural_scanner'`),
        pool.query(`SELECT universe_id,universe_class,structure_type,
                         count(*)::int catalog_candidates,
                         count(*) FILTER (WHERE active)::int subscribed_candidates
                    FROM borg_structural_candidates
                   WHERE refreshed_at>now()-interval '15 minutes' AND universe_id=$1
                   GROUP BY universe_id,universe_class,structure_type
                   ORDER BY universe_class,structure_type`, [STRUCTURAL_EXPERIMENT_ID]),
        pool.query(`SELECT e.structure_type,e.latency_ms,count(*)::int evaluations,
                         count(*) FILTER (WHERE pass_proof)::int proved_evaluations,
                         count(*) FILTER (WHERE economic_candidate AND pass_proof)::int economic_candidates,
                         count(*) FILTER (WHERE qualified AND pass_proof)::int orphan_safe_qualified,
                         max(displayed_profit_2x_usd) FILTER (WHERE pass_proof)::float max_displayed_profit_2x,
                         max(orphan_safe_profit_2x_usd)
                           FILTER (WHERE qualified AND pass_proof)::float max_orphan_safe_profit_2x,
                         sum(displayed_profit_2x_usd) FILTER (WHERE economic_candidate AND pass_proof)::float displayed_profit_not_portfolio,
                         max(evaluated_at) latest
                    FROM borg_structural_evaluations e
                    JOIN borg_structural_candidates c USING (candidate_id)
                   WHERE c.universe_id=$1
                   GROUP BY e.structure_type,e.latency_ms ORDER BY e.structure_type,e.latency_ms`,
          [STRUCTURAL_EXPERIMENT_ID]),
        pool.query(`SELECT structure_type,latency_ms,count(*)::int quotes,
                           count(*) FILTER (WHERE status='RESTING')::int resting,
                           count(*) FILTER (WHERE filled_at IS NOT NULL)::int fills,
                           count(*) FILTER (WHERE status='FILLED_HEDGED_POSITIVE')::int positive_locks,
                           count(*) FILTER (WHERE status='FILLED_HEDGED_NEGATIVE')::int negative_locks,
                           count(*) FILTER (WHERE status LIKE 'FILLED_ORPHAN%')::int orphan_fills,
                           COALESCE(sum(locked_pnl_2x_usd)
                             FILTER (WHERE closed_at IS NOT NULL),0)::float closed_pnl_2x,
                           max(updated_at) latest
                      FROM borg_structural_passive_quotes
                     GROUP BY structure_type,latency_ms
                     ORDER BY structure_type,latency_ms`),
        pool.query(`SELECT count(*)::int quotes,
                           count(DISTINCT candidate_id)::int independent_candidates,
                           count(DISTINCT (quoted_at AT TIME ZONE 'UTC')::date)::int calendar_days,
                           count(*) FILTER (WHERE filled_at IS NOT NULL)::int fills,
                           count(*) FILTER (WHERE status='FILLED_HEDGED_POSITIVE')::int positive_locks,
                           count(*) FILTER (WHERE status='FILLED_HEDGED_NEGATIVE')::int negative_locks,
                           count(*) FILTER (WHERE status LIKE 'FILLED_ORPHAN%')::int orphan_fills,
                           COALESCE(sum(locked_pnl_2x_usd)
                             FILTER (WHERE closed_at IS NOT NULL),0)::float closed_pnl_2x,
                           max(updated_at) latest
                      FROM borg_structural_passive_quotes
                     WHERE experiment_id=$1`, [ORDERED_STRIKE_EXPERIMENT_ID]),
      ]);
      const hb = heartbeat.rows[0] || null;
      const ageSec = hb ? Math.max(0, Math.round((Date.now() - new Date(hb.beat_at).getTime()) / 1000)) : null;
      return {
        alive: ageSec != null && ageSec < 30, heartbeatAt: hb?.beat_at || null,
        experimentId: STRUCTURAL_EXPERIMENT_ID,
        contract: 'Frozen V5 content-addressed rule universe. A bundle qualifies only when its doubled-cost displayed profit remains positive after reserving the worst executable proper-subset fill unwind across the bundle. The passive arm consumes public prints behind frozen queue-ahead and immediately crosses every partial hedge; it is C-grade until authenticated queue and cancel acknowledgements exist.',
        candidates: candidates.rows, rows: rows.rows, passive: passive.rows,
        orderedStrike: {
          experimentId: ORDERED_STRIKE_EXPERIMENT_ID,
          evidenceStartedAt: ORDERED_STRIKE_EVIDENCE_START,
          paperOnly: true,
          ...(orderedStrike.rows[0] || {}),
        },
      };
    });
    res.json(value);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Polymarket/Kalshi cross-venue identity + executable-book lab (paper only) ---
router.get('/crossvenue/status', authMiddleware, async (req, res) => {
  try {
    const [heartbeat, runtime, activity, relationEvents, exactRules] = await Promise.all([
      pool.query(`SELECT beat_at,meta FROM system_heartbeats WHERE component='crossvenue_lab'`),
      pool.query(`SELECT * FROM cv_runtime ORDER BY started_at DESC LIMIT 1`),
      pool.query(`SELECT count(*) FILTER (WHERE observed_at>now()-interval '1 hour')::int evaluations_1h,
                         count(*) FILTER (WHERE economic AND relation_approved AND observed_at>now()-interval '1 hour')::int economic_1h,
                         count(*) FILTER (WHERE paper_trade_eligible AND observed_at>now()-interval '1 hour')::int paper_trades_1h,
                         count(*) FILTER (WHERE paper_trade_eligible
                           AND exact_rule_eligible AND NOT hard_mismatch
                           AND observed_at>now()-interval '1 hour')::int exact_rule_paper_trades_1h,
                         count(*) FILTER (WHERE lockable_after_both_fills AND observed_at>now()-interval '1 hour')::int lockable_1h,
                         count(DISTINCT episode_id) FILTER (WHERE economic AND relation_approved AND observed_at>now()-interval '1 hour')::int episodes_1h,
                         max(observed_at) latest
                    FROM cv_opportunities WHERE experiment_id=$1`, [CROSSVENUE_EXPERIMENT_ID]),
      pool.query(`SELECT count(*)::int relation_events,
                         count(*) FILTER (WHERE lifecycle_status='OPEN_ECONOMIC')::int open_economic,
                         count(*) FILTER (WHERE lifecycle_status='DISAPPEARED')::int disappeared,
                         count(*) FILTER (WHERE economic_observations>0)::int ever_economic,
                         COALESCE(sum(orphan_stress_loss_observations),0)::int orphan_stress_loss_observations,
                         max(last_observed_at) latest
                    FROM cv_relation_episodes WHERE experiment_id=$1`, [CROSSVENUE_EXPERIMENT_ID]),
      pool.query(`SELECT count(*) FILTER (WHERE active)::int candidates,
                         count(*) FILTER (WHERE active AND exact_rule_eligible
                           AND NOT hard_mismatch)::int exact_rule_pairs,
                         count(*) FILTER (WHERE active AND monitored
                           AND exact_rule_eligible AND NOT hard_mismatch
                           AND (paper_eval_approved OR relation_approved OR identity_approved)
                           AND kalshi_fee_schedule IS NOT NULL
                           AND COALESCE((kalshi_fee_schedule->>'supported')::boolean,false)
                         )::int paper_eligible_exact,
                         count(*) FILTER (WHERE active AND hard_mismatch)::int hard_vetoes,
                         count(*) FILTER (WHERE active AND rule_comparison_status='UNKNOWN')::int unknown_rules,
                         count(*) FILTER (WHERE active AND kalshi_fee_schedule IS NOT NULL
                           AND COALESCE((kalshi_fee_schedule->>'supported')::boolean,false))::int fee_supported
                    FROM cv_contract_matches`),
    ]);
    const hb = heartbeat.rows[0] || null;
    const currentRuntime = runtime.rows[0] || null;
    const approvedMatches = parseInt(currentRuntime?.approved_matches, 10) || 0;
    const exact = exactRules.rows[0] || {};
    const exactRulePairs = parseInt(exact.exact_rule_pairs, 10) || 0;
    const paperEligibleExact = parseInt(exact.paper_eligible_exact, 10) || 0;
    const ageSec = hb ? Math.max(0, Math.round((Date.now() - new Date(hb.beat_at).getTime()) / 1000)) : null;
    res.json({
      alive: ageSec != null && ageSec < 30 && currentRuntime?.status === 'RUNNING'
        && hb?.meta?.runId === currentRuntime?.run_id,
      heartbeatAt: hb?.beat_at || null, heartbeatAgeSec: ageSec,
      evidenceEnabled: paperEligibleExact > 0,
      paperEvaluationEnabled: hb?.meta?.paperEvaluationPolicy?.enabled === true,
      evidenceBlocker: paperEligibleExact > 0 ? null
        : exactRulePairs > 0
          ? 'EXACT_RULE_KEYS_NOT_EXECUTION_ELIGIBLE: no exact pair is both monitored, enrolled and backed by a supported Kalshi fee schedule'
          : 'ZERO_COMPLETE_EXACT_RULE_KEYS: all current cross-venue candidates are vetoed or incomplete; no V7 convergence entry is admissible',
      contract: {
        mode: 'PAPER_ONLY_LIVE_DATA', walletLoaded: false, liveOrderPath: 'absent',
        atomicAcrossVenues: false, startingBankrollUsd: STARTING_BANKROLL_USD,
        capitalPerVenueUsd: STARTING_BANKROLL_USD / 2,
        sizingMode: 'equal payout shares, optimized over executable depth and the $250-per-venue bankroll',
        identityRule: 'V7 requires every subject/predicate/comparator/strike/resolver/time/timezone/fallback/precision field to be CERTIFIED_EQUAL. CERTIFIED_DIFFERENT is a hard veto; UNKNOWN stays review-only and cannot trade.',
        paperScorePolicy: hb?.meta?.paperEvaluationPolicy || null,
        experimentId: CROSSVENUE_EXPERIMENT_ID,
        kalshiTransport: hb?.meta?.kalshiTransport || 'public_batch_rest',
        kalshiFeed: hb?.meta?.kalshiFeed || null,
        jurisdiction: 'Dublin is data/research only; do not route Kalshi orders from this host.',
      },
      runtime: currentRuntime,
      exactRuleCoverage: {
        candidates: parseInt(exact.candidates, 10) || 0,
        exactRulePairs,
        paperEligibleExact,
        hardVetoes: parseInt(exact.hard_vetoes, 10) || 0,
        unknownRules: parseInt(exact.unknown_rules, 10) || 0,
        feeSupported: parseInt(exact.fee_supported, 10) || 0,
        legacyRelationApproved: approvedMatches,
      },
      activity: { ...(activity.rows[0] || {}), ...(relationEvents.rows[0] || {}) },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/crossvenue/matches', authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(2000, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const [matches, total] = await Promise.all([pool.query(`
      SELECT match_id,poly_condition_id,poly_question,kalshi_ticker,kalshi_title,
             match_score::float,title_similarity::float,identity_status,identity_approved,
             identity_snapshot_hash,identity_certification,
             exact_rule_key,exact_rule_eligible,rule_comparison_status,
             unknown_rule_reasons,hard_mismatch,hard_mismatch_reasons,exact_rule_audit,
             kalshi_fee_type,kalshi_fee_multiplier::float,kalshi_fee_source,
             kalshi_fee_observed_at,kalshi_fee_schedule,
             relation_type,relation_approved,relation_status,relation_proof,
             relation_resolution_audit,state_evidence,
             paper_eval_approved,paper_eval_status,paper_eval_source,
             paper_eval_approved_at,paper_eval_score_at_approval::float,
             paper_eval_threshold::float,
             approval_source,resolution_audit,mismatch_reasons,end_delta_hours::float,
             monitored,active,metadata,refreshed_at
        FROM cv_contract_matches
       WHERE active=true OR relation_approved=true
       ORDER BY exact_rule_eligible DESC,hard_mismatch ASC,
                relation_approved DESC,paper_eval_approved DESC,identity_approved DESC,
                monitored DESC,match_score DESC,refreshed_at DESC
       LIMIT $1`, [limit]), pool.query(`
      SELECT count(*)::int total
        FROM cv_contract_matches
       WHERE active=true OR relation_approved=true`)]);
    res.json({
      warning: 'A title score or manual review cannot override V7. Exact-rule paper convergence requires every typed rule field to be certified equal; unknown fields remain review-only, while proven differences are hard vetoes. A terminal lock additionally requires deterministic state-payoff certification.',
      total: total.rows[0]?.total || 0,
      returned: matches.rows.length,
      rows: matches.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/crossvenue/depth', authMiddleware, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(90, parseInt(req.query.days, 10) || 30));
    const { rows } = await pool.query(`
      SELECT quantity::float,direction,count(*)::int observations,
             count(DISTINCT match_id)::int pairs,
             count(*) FILTER (WHERE fee_schedule_known)::int fee_known,
             count(*) FILTER (WHERE full_entry_depth)::int full_entry_depth,
             count(*) FILTER (WHERE full_exit_depth)::int full_exit_depth,
             count(*) FILTER (WHERE paper_entry_eligible)::int paper_entry_eligible,
             count(*) FILTER (WHERE reason='KALSHI_FEE_SCHEDULE_UNKNOWN')::int fee_unknown,
             max(terminal_locked_profit)::float max_terminal_lock,
             avg(immediate_round_trip_pnl)
               FILTER (WHERE full_exit_depth)::float mean_immediate_round_trip_pnl,
             max(observed_at) latest
        FROM cv_depth_replays
       WHERE experiment_id=$1
         AND observed_at>=now()-($2||' days')::interval
         AND exact_rule_eligible AND NOT hard_mismatch
       GROUP BY quantity,direction
       ORDER BY quantity,direction
    `, [CROSSVENUE_EXPERIMENT_ID, days]);
    res.json({
      experimentId: CROSSVENUE_EXPERIMENT_ID,
      requestedDays: days,
      quantities: [5, 10, 25],
      warning: 'These are overlapping capacity observations, not additive trades. A row absent because depth or fees failed is recorded explicitly.',
      rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/crossvenue/opportunities', authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(500, parseInt(req.query.limit, 10) || 100);
    const { rows } = await pool.query(`
      SELECT o.opportunity_id,o.observed_at,o.match_id,o.episode_id,o.direction,
             o.quantity::float,o.poly_outcome,o.kalshi_outcome,o.poly_vwap::float,
             o.kalshi_vwap::float,o.poly_fee::float,o.kalshi_fee::float,
             o.total_cost::float,o.locked_profit_after_both_fills::float,
             o.stressed_profit::float,o.indicative_economic,o.economic,
             o.paper_eval_approved,o.paper_trade_eligible,o.identity_approved,
             o.relation_type,o.relation_approved,o.guaranteed_min_payout_per_share::float,
             o.payoff_proof_hash,o.exact_rule_key,o.exact_rule_eligible,o.hard_mismatch,
             o.books_fresh,
             (100*o.locked_profit_after_both_fills/NULLIF(o.total_cost,0))::float raw_roi_pct,
             (100*o.stressed_profit/NULLIF(o.total_cost,0))::float stressed_roi_pct,
             o.full_depth,o.atomic,o.lockable_after_both_fills,o.status,
             o.data_quality_grade,o.execution_fidelity_grade,o.experiment_id,o.synchronized,o.detail,
             m.poly_question,m.kalshi_title,m.identity_status,m.relation_status
        FROM cv_opportunities o JOIN cv_contract_matches m USING (match_id)
       WHERE o.experiment_id=$2
       ORDER BY o.observed_at DESC LIMIT $1`, [limit, CROSSVENUE_EXPERIMENT_ID]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/crossvenue/episodes', authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(500, parseInt(req.query.limit, 10) || 100);
    const { rows } = await pool.query(`
      SELECT e.episode_id,e.experiment_id,e.match_id,e.relation_id,e.direction,e.payoff_proof_hash,
             e.state_active_from,e.first_observed_at,e.last_observed_at,
             e.first_economic_at,e.last_economic_at,e.disappeared_at,e.closed_at,
             e.lifecycle_status,e.observations::int,e.economic_observations::int,
             e.disappearances,e.reappearances,e.max_quantity::float,
             e.max_total_cost::float,e.max_raw_profit::float,e.max_stressed_profit::float,
             e.worst_orphan_unwind_pnl::float,e.orphan_stress_loss_observations::int,
             e.orphan_unwind_unavailable_observations::int,
             e.last_data_quality_grade,e.last_execution_fidelity_grade,e.detail,
             m.poly_question,m.kalshi_title,m.kalshi_ticker,m.relation_type
        FROM cv_relation_episodes e
        JOIN cv_contract_matches m USING (match_id)
       WHERE e.experiment_id=$2
       ORDER BY e.first_observed_at DESC LIMIT $1`, [limit, CROSSVENUE_EXPERIMENT_ID]);
    res.json({
      evidence: 'One row is one approved relation/state-activation/direction event; quote observations are not independent.',
      orphanMeaning: 'worst_orphan_unwind_pnl is a paper immediate-unwind stress, not a claim that a live orphan fill occurred.',
      rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/crossvenue/summary', authMiddleware, async (req, res) => {
  try {
    const value = await dashboardReports.get('crossvenue-summary', 15_000, async () => {
      const [observations, episodes] = await Promise.all([pool.query(`
      SELECT direction,
             count(*)::int observations,
             count(DISTINCT match_id)::int pairs,
             count(DISTINCT episode_id) FILTER (WHERE economic AND relation_approved)::int economic_episodes,
             count(*) FILTER (WHERE indicative_economic)::int indicative_controls,
             count(*) FILTER (WHERE paper_trade_eligible)::int paper_trade_observations,
             count(*) FILTER (WHERE economic AND relation_approved)::int economic_observations,
             count(*) FILTER (WHERE lockable_after_both_fills)::int lockable_observations,
             max(locked_profit_after_both_fills)::float max_indicative_profit,
             max(stressed_profit) FILTER (WHERE relation_approved)::float max_stressed_profit,
             max(stressed_profit) FILTER (WHERE paper_trade_eligible)::float max_paper_stressed_profit,
             max(100*locked_profit_after_both_fills/NULLIF(total_cost,0))::float max_raw_roi_pct,
             max(100*stressed_profit/NULLIF(total_cost,0)) FILTER (WHERE relation_approved)::float max_stressed_roi_pct,
             max(quantity)::float max_sized_quantity,
             avg(locked_profit_after_both_fills)::float mean_indicative_profit,
             avg(locked_profit_after_both_fills)
               FILTER (WHERE relation_approved)::float mean_approved_profit,
             avg(stressed_profit) FILTER (WHERE paper_trade_eligible)::float mean_paper_stressed_profit,
             max(observed_at) latest
        FROM cv_opportunities
       WHERE experiment_id=$1 AND synchronized=true
         AND detail->>'model'='DETERMINISTIC_PAYOFF_RELATION_V1'
       GROUP BY direction ORDER BY direction`, [CROSSVENUE_EXPERIMENT_ID]), pool.query(`
      SELECT direction,count(*)::int relation_events,
             count(*) FILTER (WHERE economic_observations>0)::int ever_economic_events,
             count(*) FILTER (WHERE lifecycle_status='OPEN_ECONOMIC')::int open_economic_events,
             count(*) FILTER (WHERE lifecycle_status='DISAPPEARED')::int disappeared_events,
             count(*) FILTER (WHERE closed_at IS NOT NULL)::int closed_events,
             max(max_stressed_profit)::float best_event_stressed_profit,
             min(worst_orphan_unwind_pnl)::float worst_orphan_unwind_pnl
        FROM cv_relation_episodes WHERE experiment_id=$1
       GROUP BY direction ORDER BY direction`, [CROSSVENUE_EXPERIMENT_ID])]);
      const provedEvents = episodes.rows.reduce((sum, row) =>
        sum + (parseInt(row.relation_events, 10) || 0), 0);
      return {
        evidence: provedEvents > 0,
        evidenceBlocker: provedEvents > 0 ? null
          : 'No rule-certified relation event exists. Indicative controls are overlapping quote diagnostics and cannot be added or called profit.',
        engineCohort: CROSSVENUE_EXPERIMENT_ID,
        warning: 'Rows are overlapping observations, not additive trades. V6 paper entries require a complete exact-rule key, a hard-mismatch veto, synchronized depth and a persisted Kalshi fee schedule; terminal-lock economics still requires a deterministic payoff proof. Every cross-venue execution remains non-atomic.',
        requirement: 'Forward synchronized L2; one first entry per exact-rule match/direction/UTC day; at least 300 fresh pair-direction-days and 30 UTC days, positive 2x-cost plus one-tick economics in both halves, multiplicity correction, and market/day clustered lower bounds above zero before deployment review.',
        rows: observations.rows,
        relationEvents: episodes.rows,
      };
    });
    res.json(value);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/crossvenue/convergence', authMiddleware, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(90, parseInt(req.query.days, 10) || 30));
    const value = await dashboardReports.get(`crossvenue-convergence:${days}`, 60_000, async () => {
      const { rows } = await pool.query(`
        SELECT observed_at,match_id,direction,quantity::float,
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
         ORDER BY match_id,direction,quantity,observed_at`, [days, CROSSVENUE_EXPERIMENT_ID]);
      return {
        requestedDays: days,
        ...summarizeConvergence(rows, { requireExactRule: true }),
        interpretation: 'This measures time to executable early liquidation, not time to midpoint convergence. Terminal locks and early exits are reported separately.',
      };
    });
    return res.json(value);
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.get('/crossvenue/terminal-carry', authMiddleware, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 100));
    const value = await dashboardReports.get(`crossvenue-terminal-carry:${limit}`, 15_000,
      async () => {
        const [heartbeat, summary, recent, excludedV1] = await Promise.all([
          pool.query(`SELECT beat_at,meta->'terminalCarry' terminal_carry
                        FROM system_heartbeats WHERE component='crossvenue_lab'`),
          pool.query(`
            WITH entries AS (
              SELECT t.*,
                     CASE WHEN lower(s.kalshi_result) IN ('yes','no')
                                AND lower(s.poly_outcome) IN ('yes','no')
                       THEN t.quantity * (
                         CASE WHEN lower(s.poly_outcome)=lower(t.poly_outcome) THEN 1 ELSE 0 END
                         + CASE WHEN lower(s.kalshi_result)=lower(t.kalshi_outcome) THEN 1 ELSE 0 END
                       ) ELSE NULL END realized_payout,
                     CASE WHEN lower(s.kalshi_result) IN ('yes','no')
                                AND lower(s.poly_outcome) IN ('yes','no')
                       THEN lower(s.kalshi_result)=lower(s.poly_outcome) ELSE NULL END venues_agreed
                FROM cv_terminal_carry_marks t
                LEFT JOIN cv_settlements s USING (match_id)
               WHERE t.experiment_id=$1 AND t.entry_armed=true
            ), scored AS (
              SELECT *,
                     realized_payout-total_cost realized_pnl,
                     realized_payout-total_cost-additional_cost_stress realized_2x_pnl,
                     realized_payout-total_cost-additional_cost_stress-orphan_reserve
                       realized_full_hurdle_pnl
                FROM entries
            )
            SELECT direction,count(*)::int entries,
                   count(DISTINCT match_id)::int matches,
                   count(DISTINCT risk_class)::int risk_classes,
                   count(realized_payout)::int settled,
                   count(*) FILTER (WHERE realized_pnl>0)::int profitable,
                   count(*) FILTER (WHERE venues_agreed)::int settlements_agreed,
                   sum(total_cost)::float deployed_entry_cash,
                   sum(realized_pnl)::float realized_pnl,
                   sum(realized_2x_pnl)::float realized_2x_pnl,
                   sum(realized_full_hurdle_pnl)::float realized_full_hurdle_pnl,
                   count(realized_payout) FILTER (
                     WHERE observed_at>=now()-interval '6 hours')::int settled_6h,
                   COALESCE(sum(realized_2x_pnl) FILTER (
                     WHERE observed_at>=now()-interval '6 hours'),0)::float realized_2x_pnl_6h,
                   count(realized_payout) FILTER (
                     WHERE observed_at>=now()-interval '24 hours')::int settled_24h,
                   COALESCE(sum(realized_2x_pnl) FILTER (
                     WHERE observed_at>=now()-interval '24 hours'),0)::float realized_2x_pnl_24h,
                   count(realized_payout) FILTER (
                     WHERE observed_at>=now()-interval '3 days')::int settled_3d,
                   COALESCE(sum(realized_2x_pnl) FILTER (
                     WHERE observed_at>=now()-interval '3 days'),0)::float realized_2x_pnl_3d,
                   sum(expected_profit_lower)::float entry_expected_profit_lower,
                   min(agreement_lower)::float minimum_agreement_lower,
                   min(prior_clusters)::int minimum_prior_clusters,
                   max(observed_at) latest
              FROM scored
             GROUP BY direction ORDER BY direction
          `, [TERMINAL_CARRY_EXPERIMENT_ID]),
          pool.query(`
            SELECT t.mark_id,t.observed_at,t.entry_day,t.match_id,t.direction,
                   t.risk_class,
                   t.quantity::float,t.poly_vwap::float,t.kalshi_vwap::float,
                   t.poly_cash_required::float,t.kalshi_cash_required::float,
                   t.total_cost::float,t.expected_profit_lower::float,
                   t.expected_roi_lower::float,t.orphan_reserve::float,
                   t.agreement_lower::float,t.prior_clusters,t.eligible,
                   t.global_agreement_lower::float,t.global_prior_clusters,
                   t.entry_armed,t.reason,t.data_quality_grade,
                   t.execution_fidelity_grade,t.detail,
                   m.poly_question,m.kalshi_title
              FROM cv_terminal_carry_marks t
              JOIN cv_contract_matches m USING (match_id)
             WHERE t.experiment_id=$2
             ORDER BY t.observed_at DESC LIMIT $1
          `, [limit, TERMINAL_CARRY_EXPERIMENT_ID]),
          pool.query(`
            SELECT count(*)::int entries,
                   count(DISTINCT match_id)::int matches,
                   COALESCE(sum(total_cost),0)::float displayed_cash,
                   max(observed_at) latest
              FROM cv_terminal_carry_marks
             WHERE experiment_id=$1 AND entry_armed=true
          `, [TERMINAL_CARRY_V1_EXPERIMENT_ID]),
        ]);
        const terminalCarry = heartbeat.rows[0]?.terminal_carry || {};
        return {
          experimentId: TERMINAL_CARRY_EXPERIMENT_ID,
          supersedes: TERMINAL_CARRY_V1_EXPERIMENT_ID,
          paperOnly: true,
          deterministicArbitrage: false,
          warning: 'These contracts are not rule-certified identities. V1 is retained but excluded because it pooled heterogeneous resolver risk and reused $500 for every candidate. V2 uses a same-risk-class lower bound and one shared unresolved paper bankroll; PnL can still be lost to different settlement, non-atomic legs, partial fills, disappearing depth, fees and capital duration.',
          evidenceRule: 'One entry per match/direction/UTC day; require 300 fresh units and 30 days, positive 2x-cost PnL in both halves, clustered lower bound above zero, multiple-testing correction and 100/250/500ms robustness.',
          prior: terminalCarry.prior || null,
          riskClasses: terminalCarry.riskClasses || 0,
          capital: terminalCarry.capital || null,
          excludedV1: excludedV1.rows[0] || {
            entries: 0, matches: 0, displayed_cash: 0, latest: null,
          },
          heartbeatAt: heartbeat.rows[0]?.beat_at || null,
          rows: summary.rows,
          recent: recent.rows,
        };
      });
    res.json(value);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/research/resolver-boundary', authMiddleware, async (req, res) => {
  try {
    const value = await dashboardReports.get('resolver-boundary-portfolio-v4', 60_000,
      () => buildResolverBoundaryPortfolio(pool));
    res.json(value);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Pyth resolver-source boundary transfer lab (public feeds, paper only) ---
router.get('/pyth/status', authMiddleware, async (req, res) => {
  try {
    const [heartbeat, runtime, universe, activity] = await Promise.all([
      pool.query(`SELECT beat_at,meta FROM system_heartbeats WHERE component='pyth_boundary'`),
      pool.query(`SELECT * FROM borg_pyth_runtime WHERE experiment_id=$1
                   ORDER BY started_at DESC LIMIT 1`, [PYTH_EXPERIMENT_ID]),
      pool.query(`SELECT count(*) FILTER (WHERE active)::int active_markets,
                         count(DISTINCT symbol) FILTER (WHERE active)::int active_symbols,
                         count(*) FILTER (WHERE terminal_outcome IS NOT NULL)::int resolved_markets,
                         max(refreshed_at) refreshed_at
                    FROM borg_pyth_markets WHERE experiment_id=$1`, [PYTH_EXPERIMENT_ID]),
      pool.query(`SELECT count(*) FILTER (WHERE observed_at>now()-interval '24 hours')::int signals_24h,
                         count(DISTINCT condition_id) FILTER (WHERE observed_at>now()-interval '24 hours')::int markets_24h,
                         max(observed_at) latest_signal
                    FROM borg_pyth_signals WHERE experiment_id=$1`, [PYTH_EXPERIMENT_ID]),
    ]);
    const hb = heartbeat.rows[0] || null;
    const current = runtime.rows[0] || null;
    const ageSec = hb ? Math.max(0, Math.round((Date.now() - new Date(hb.beat_at).getTime()) / 1000)) : null;
    const processAlive = ageSec != null && ageSec < 30 && current?.status === 'RUNNING'
      && hb?.meta?.runId === current?.run_id;
    res.json({
      alive: processAlive,
      heartbeatAt: hb?.beat_at || null, heartbeatAgeSec: ageSec,
      feed: {
        state: hb?.meta?.feedState || 'UNKNOWN',
        transportConnected: hb?.meta?.transportConnected === true,
        marketsInWindow: parseInt(hb?.meta?.marketsInWindow, 10) || 0,
        nextWindowStartAt: hb?.meta?.nextWindowStartAt || null,
        lastUsableTickAt: hb?.meta?.lastUsableTickAt || null,
        unsupportedSymbols: hb?.meta?.unsupportedSymbols || [],
      },
      contract: {
        experimentId: PYTH_EXPERIMENT_ID, mode: 'PAPER_ONLY_FORWARD_MEASUREMENT',
        walletLoaded: false, liveOrderPath: false, historicalRowsReused: false,
        signal: 'market-quote prior plus Pyth resolver residual calibration probes; no frozen fair lower bound yet',
        execution: '$10 displayed-depth paper probes at 100/250/500ms; 1/5/30s executable bid markouts; probes are non-promotable',
        independence: 'market/day clustered; rows and latency arms are not additive trades',
        acceptance: 'blocked until a separately frozen out-of-sample fair lower bound exists; a successor would then require >=300 markets and >=14 days',
      },
      runtime: current, universe: universe.rows[0] || {}, activity: activity.rows[0] || {},
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/pyth/summary', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      WITH arrival AS (
        SELECT a.*,s.condition_id,s.trigger_kind,s.checkpoint_sec
          FROM borg_pyth_arrivals a JOIN borg_pyth_signals s USING (signal_id)
         WHERE a.experiment_id=$1 AND s.valid=true
      ), m5 AS (
        SELECT arrival_id,scored,pnl FROM borg_pyth_markouts
         WHERE experiment_id=$1 AND horizon_sec=5
      ), terminal AS (
        SELECT arrival_id,won,pnl FROM borg_pyth_terminal_scores WHERE experiment_id=$1
      )
      SELECT a.trigger_kind,a.checkpoint_sec,a.side,a.latency_ms,
             count(*)::int arrivals,count(DISTINCT a.condition_id)::int independent_markets,
             count(*) FILTER (WHERE a.executable)::int executable_arrivals,
             avg(a.entry_vwap) FILTER (WHERE a.executable)::float mean_entry_vwap,
             count(*) FILTER (WHERE m5.scored)::int scored_5s,
             avg(m5.pnl) FILTER (WHERE m5.scored)::float mean_pnl_5s,
             sum(m5.pnl) FILTER (WHERE m5.scored)::float pnl_5s_not_portfolio,
             count(t.arrival_id)::int terminal_n,
             count(*) FILTER (WHERE t.won)::int terminal_wins,
             avg(t.pnl)::float mean_terminal_pnl,
             sum(t.pnl)::float terminal_pnl_not_portfolio,
             max(a.observed_at) latest
        FROM arrival a LEFT JOIN m5 USING (arrival_id) LEFT JOIN terminal t USING (arrival_id)
       GROUP BY a.trigger_kind,a.checkpoint_sec,a.side,a.latency_ms
       ORDER BY a.trigger_kind,a.checkpoint_sec DESC NULLS LAST,a.side,a.latency_ms
    `, [PYTH_EXPERIMENT_ID]);
    res.json({
      evidence: false,
      experimentId: PYTH_EXPERIMENT_ID,
      warning: 'These are overlapping counterfactual latency arms, not an additive portfolio. Zero rows before a market session or before a checkpoint is expected.',
      rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/pyth/signals', authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(500, parseInt(req.query.limit, 10) || 100);
    const { rows } = await pool.query(`
      SELECT s.signal_id,s.observed_at,s.condition_id,m.question,m.symbol,
             s.trigger_kind,s.checkpoint_sec,s.side,s.resolver_price::float,
             s.price_to_beat::float,s.distance_bps::float,s.tte_sec::float,
             s.valid,s.invalid_reason,s.detail,
             count(a.arrival_id)::int latency_arrivals,
             count(a.arrival_id) FILTER (WHERE a.executable)::int executable_arrivals
        FROM borg_pyth_signals s JOIN borg_pyth_markets m USING (condition_id)
        LEFT JOIN borg_pyth_arrivals a USING (signal_id)
       WHERE s.experiment_id=$2
       GROUP BY s.signal_id,m.question,m.symbol
       ORDER BY s.observed_at DESC LIMIT $1
    `, [limit, PYTH_EXPERIMENT_ID]);
    res.json({ rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
