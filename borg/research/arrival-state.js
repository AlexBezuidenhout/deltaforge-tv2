'use strict';

/**
 * Causal arrival-state lookup for paper execution replay.
 *
 * The normalized touch row is an index over the immutable append-before-
 * process WAL.  A replay may use the latest state already received when the
 * hypothetical order reaches the venue; it must never require a new sample to
 * arrive after the strategy decision.  Missing WAL provenance, a connection
 * gap, or stale state is retained as unscoreable evidence rather than being
 * converted into a non-fill.
 */

const {
  executionFidelity,
  qualityGrade,
  simulateTakerTouch,
} = require('./execution-kernel');

const WAL_ARRIVAL_REPLAY_VERSION = 'borg-wal-arrival-v3';
const DEFAULT_MAX_STATE_AGE_MS = 2000;

function finite(value, fallback = null) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveToken(token, market = {}) {
  const value = String(token || '').toUpperCase();
  const configured = String(market.positive_label || '').toUpperCase();
  return value === 'UP' || value === 'YES' || Boolean(configured && value === configured);
}

function classifyExecutionState({ filled, detail = {} }) {
  if (detail.latency_tape_missing) return 'UNSCOREABLE_TAPE';
  if (detail.wal_provenance_missing) return 'UNSCOREABLE_PROVENANCE';
  if (detail.connection_gap) return 'INVALID_CONNECTION_GAP';
  if (!['A', 'B'].includes(detail.data_quality_grade)
      || !['A', 'B'].includes(detail.execution_fidelity_grade)) return 'LOW_QUALITY';
  return filled ? 'ELIGIBLE_FILL' : 'PROVEN_NONFILL';
}

function simulateWalArrivalTouch({ order, tape, arrival, latencyMs }) {
  const informationLatencyMs = finite(order?.features?.decision_delay_ms);
  if (!tape) {
    const detail = {
      replay_version: WAL_ARRIVAL_REPLAY_VERSION,
      information_latency_ms: informationLatencyMs,
      order_latency_ms: latencyMs,
      latency_tape_missing: true,
      data_quality_grade: 'F',
      execution_fidelity_grade: 'F',
      fidelity_level: 'L3',
    };
    return { filled: false, executionState: classifyExecutionState({ filled: false, detail }), detail };
  }

  const stateAtMs = new Date(tape.ts).getTime();
  const arrivalMs = new Date(arrival).getTime();
  const stateAgeMs = Number.isFinite(stateAtMs) && Number.isFinite(arrivalMs)
    ? Math.max(0, arrivalMs - stateAtMs) : null;
  const provenanceMissing = !tape.wal_event_id
    || tape.receive_monotonic_ns == null
    || tape.connection_epoch == null
    || tape.event_sequence == null;
  const connectionGap = tape.connection_gap === true;
  let dataQualityGrade = qualityGrade({
    connectionGap: connectionGap || provenanceMissing,
    stateSource: 'event',
    stateAgeMs,
  });
  let simulated = simulateTakerTouch({
    limitPrice: order.price,
    requestedSize: order.size,
    bestAsk: finite(tape.best_ask),
    askSize: finite(tape.ask_size),
    connectionGap: connectionGap || provenanceMissing,
    stateSource: 'event',
    stateAgeMs,
  });
  if (provenanceMissing) {
    dataQualityGrade = 'F';
    const fidelity = executionFidelity({
      model: 'wal_arrival_v3', dataQualityGrade,
    });
    simulated = {
      ...simulated,
      filled: false,
      fillPrice: null,
      fillSize: 0,
      dataQualityGrade,
      executionFidelityGrade: fidelity.executionFidelityGrade,
      fidelityLevel: fidelity.fidelityLevel,
    };
  }

  const detail = {
    replay_version: WAL_ARRIVAL_REPLAY_VERSION,
    information_latency_ms: informationLatencyMs,
    order_latency_ms: latencyMs,
    state_source: 'normalized_wal_clob_touch',
    state_ts: new Date(tape.ts).toISOString(),
    source_ts: tape.source_ts ? new Date(tape.source_ts).toISOString() : null,
    state_age_ms: stateAgeMs,
    data_quality_grade: simulated.dataQualityGrade,
    execution_fidelity_grade: simulated.executionFidelityGrade,
    fidelity_level: simulated.fidelityLevel,
    capacity_at_arrival: simulated.capacityAtArrival,
    quote_survived: simulated.quoteSurvived,
    connection_gap: connectionGap,
    wal_provenance_missing: provenanceMissing,
    wal_event_id: tape.wal_event_id || null,
    clob_event_sequence: tape.event_sequence ?? null,
    clob_connection_epoch: tape.connection_epoch ?? null,
    clob_connection_shard: tape.connection_shard ?? null,
    receive_monotonic_ns: tape.receive_monotonic_ns == null
      ? null : String(tape.receive_monotonic_ns),
  };
  const result = simulated.filled ? {
    filled: true,
    fillTs: new Date(arrival),
    fillPrice: simulated.fillPrice,
    fillSize: simulated.fillSize,
    detail: { ...detail, partial: simulated.partial },
  } : { filled: false, detail };
  result.executionState = classifyExecutionState(result);
  return result;
}

async function latestCausalWalTouch(db, order, latencyMs, options = {}) {
  const availableAt = new Date(order.available_at || order.ts);
  const arrival = new Date(availableAt.getTime() + latencyMs);
  const maxStateAgeMs = Math.max(1, finite(options.maxStateAgeMs, DEFAULT_MAX_STATE_AGE_MS));
  const stateFloor = new Date(arrival.getTime() - maxStateAgeMs);
  const assetId = positiveToken(order.token, order)
    ? order.up_token_id : order.down_token_id;
  if (!assetId) return { arrival, tape: null, assetId: null };
  const { rows } = await db.query(`
    WITH latest AS (
      SELECT t.ts,t.source_ts,t.best_ask,t.ask_size,t.receive_monotonic_ns,
             t.connection_epoch,t.connection_shard,t.event_sequence,t.wal_event_id
        FROM borg_clob_touch t
       WHERE t.market_id=$1 AND t.asset_id=$2
         AND t.ts >= $3 AND t.ts <= $4
         AND t.best_ask IS NOT NULL
       ORDER BY t.ts DESC,t.id DESC
       LIMIT 1
    )
    SELECT latest.*,
           EXISTS (
             SELECT 1 FROM borg_clob_events gap
              WHERE gap.event_type='connection_gap'
                AND gap.ts > latest.ts AND gap.ts <= $4
                AND (gap.market_id IS NULL OR gap.market_id=$1)
                AND (gap.asset_id IS NULL OR gap.asset_id=$2)
                AND (gap.connection_shard IS NULL
                  OR latest.connection_shard IS NULL
                  OR gap.connection_shard=latest.connection_shard)
           ) AS connection_gap
      FROM latest
  `, [order.market_id, assetId, stateFloor, arrival]);
  return { arrival, tape: rows[0] || null, assetId };
}

async function scoreWalArrivalFill(db, order, latencyMs, options = {}) {
  const { arrival, tape } = await latestCausalWalTouch(db, order, latencyMs, options);
  return simulateWalArrivalTouch({ order, tape, arrival, latencyMs });
}

module.exports = {
  DEFAULT_MAX_STATE_AGE_MS,
  WAL_ARRIVAL_REPLAY_VERSION,
  classifyExecutionState,
  finite,
  latestCausalWalTouch,
  positiveToken,
  scoreWalArrivalFill,
  simulateWalArrivalTouch,
};
