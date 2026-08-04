'use strict';

function number(value, fallback = 0) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizedRow(row) {
  return {
    strategy: row.strategy,
    intents: parseInt(row.intents, 10) || 0,
    replayed: parseInt(row.replayed, 10) || 0,
    eligibleFills: parseInt(row.eligible_fills, 10) || 0,
    provenNonfills: parseInt(row.proven_nonfills, 10) || 0,
    unscoreable: parseInt(row.unscoreable, 10) || 0,
    lowQuality: parseInt(row.low_quality, 10) || 0,
    independentMarkets: parseInt(row.independent_markets, 10) || 0,
    pnl1x: number(row.pnl_1x),
    pnl2x: number(row.pnl_2x),
    firstIntentAt: row.first_intent_at || null,
    lastIntentAt: row.last_intent_at || null,
  };
}

async function activeEpoch(db) {
  const { rows } = await db.query(`
    SELECT r.run_id,r.epoch_id,r.started_at run_started_at,
           e.started_at epoch_started_at,e.code_version,e.reason
      FROM borg_collector_runs r
      JOIN borg_collection_epochs e ON e.epoch_id=r.epoch_id
     WHERE r.status='RUNNING'
     ORDER BY r.started_at DESC LIMIT 1
  `);
  return rows[0] || null;
}

async function horizonRows(db, epoch, now, hours) {
  const floor = new Date(Math.max(
    new Date(epoch.epoch_started_at).getTime(),
    now.getTime() - hours * 3_600_000,
  ));
  const { rows } = await db.query(`
    WITH active_strategies AS (
      SELECT strategy FROM borg_strategy_runtime WHERE collector_run_id=$1
    ), intents AS (
      SELECT o.id,o.strategy,o.market_id,COALESCE(o.available_at,o.ts) intent_at,
             CASE WHEN o.features->>'execution_model'='latency_1s' THEN 1250 ELSE 250 END latency_ms
        FROM borg_shadow_orders o
        JOIN active_strategies a ON a.strategy=o.strategy
       WHERE o.action='place'
         AND o.features->>'collection_epoch_id'=$2
         AND COALESCE(o.available_at,o.ts)>=$3
         AND COALESCE(o.available_at,o.ts)<=$4
    )
    SELECT a.strategy,
           count(i.id)::int intents,
           count(r.order_id)::int replayed,
           count(r.order_id) FILTER (WHERE r.execution_state='ELIGIBLE_FILL')::int eligible_fills,
           count(r.order_id) FILTER (WHERE r.execution_state='PROVEN_NONFILL')::int proven_nonfills,
           count(r.order_id) FILTER (WHERE r.execution_state LIKE 'UNSCOREABLE%'
             OR r.execution_state='INVALID_CONNECTION_GAP')::int unscoreable,
           count(r.order_id) FILTER (WHERE r.execution_state='LOW_QUALITY')::int low_quality,
           count(DISTINCT i.market_id) FILTER (
             WHERE r.execution_state='ELIGIBLE_FILL')::int independent_markets,
           COALESCE(sum(r.pnl_1x) FILTER (
             WHERE r.execution_state='ELIGIBLE_FILL'),0)::float pnl_1x,
           COALESCE(sum(r.pnl_2x) FILTER (
             WHERE r.execution_state='ELIGIBLE_FILL'),0)::float pnl_2x,
           min(i.intent_at) first_intent_at,max(i.intent_at) last_intent_at
      FROM active_strategies a
      LEFT JOIN intents i ON i.strategy=a.strategy
      LEFT JOIN borg_shadow_execution_replays r
        ON r.order_id=i.id
       AND r.replay_version='borg-wal-arrival-v3'
       AND r.latency_ms=i.latency_ms
     GROUP BY a.strategy ORDER BY a.strategy
  `, [epoch.run_id, epoch.epoch_id, floor, now]);
  return {
    hours,
    from: floor.toISOString(),
    to: now.toISOString(),
    strategies: rows.map(normalizedRow),
  };
}

async function buildEvidenceWindowReport(db, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const epoch = await activeEpoch(db);
  if (!epoch) throw new Error('no RUNNING collection epoch');
  const horizons = [...new Set(options.horizons || [6, 24])]
    .map(Number).filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  const windows = await Promise.all(horizons.map((hours) =>
    horizonRows(db, epoch, now, hours)));
  return {
    format: 'deltaforge-forward-execution-window-v1',
    generatedAt: now.toISOString(),
    epoch: {
      id: epoch.epoch_id,
      startedAt: new Date(epoch.epoch_started_at).toISOString(),
      runId: epoch.run_id,
      codeVersion: epoch.code_version,
      reason: epoch.reason,
    },
    executionAuthority: 'borg-wal-arrival-v3 at each intent\'s frozen model latency',
    windows,
    interpretation: 'Unscoreable and low-quality rows contribute no PnL. These windows are monitoring views, not promotion tests or annualized forecasts.',
  };
}

module.exports = { activeEpoch, buildEvidenceWindowReport, normalizedRow };
