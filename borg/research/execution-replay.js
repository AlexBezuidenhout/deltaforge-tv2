'use strict';

const { binaryPnl } = require('./execution-kernel');
const {
  WAL_ARRIVAL_REPLAY_VERSION,
  scoreWalArrivalFill,
} = require('./arrival-state');

const WAL_REPLAY_LATENCIES_MS = Object.freeze([100, 250, 500, 1250]);

function replayPnl(order, fill) {
  if (!fill.filled) return { gross: 0, pnl1x: 0, pnl2x: 0 };
  const one = binaryPnl({
    side: order.side,
    token: order.token,
    outcome: order.outcome,
    fillPrice: fill.fillPrice,
    fillSize: fill.fillSize,
    orderKind: order.order_kind,
    feeMultiplier: 1,
  });
  const two = binaryPnl({
    side: order.side,
    token: order.token,
    outcome: order.outcome,
    fillPrice: fill.fillPrice,
    fillSize: fill.fillSize,
    orderKind: order.order_kind,
    feeMultiplier: 2,
  });
  return { gross: one.gross, pnl1x: one.net, pnl2x: two.net };
}

async function replayOrder(db, order, latencyMs, options = {}) {
  const fill = await scoreWalArrivalFill(db, order, latencyMs, options);
  const pnl = replayPnl(order, fill);
  return {
    orderId: order.id,
    replayVersion: WAL_ARRIVAL_REPLAY_VERSION,
    latencyMs,
    filled: fill.filled === true,
    fillTs: fill.fillTs || null,
    fillPrice: fill.fillPrice ?? null,
    fillSize: fill.fillSize ?? null,
    ...pnl,
    dataQualityGrade: fill.detail?.data_quality_grade || 'F',
    executionFidelityGrade: fill.detail?.execution_fidelity_grade || 'F',
    fidelityLevel: fill.detail?.fidelity_level || 'L3',
    executionState: fill.executionState,
    stateTs: fill.detail?.state_ts || null,
    stateSource: fill.detail?.state_source || null,
    detail: fill.detail || {},
  };
}

async function persistReplay(db, replay) {
  const { rowCount } = await db.query(`
    INSERT INTO borg_shadow_execution_replays
      (order_id,replay_version,latency_ms,state_ts,state_source,filled,
       fill_ts,fill_price,fill_size,pnl_gross,pnl_1x,pnl_2x,
       data_quality_grade,execution_fidelity_grade,fidelity_level,
       execution_state,detail)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
    ON CONFLICT (order_id,replay_version,latency_ms) DO NOTHING
  `, [
    replay.orderId, replay.replayVersion, replay.latencyMs,
    replay.stateTs, replay.stateSource, replay.filled,
    replay.fillTs, replay.fillPrice, replay.fillSize,
    replay.gross, replay.pnl1x, replay.pnl2x,
    replay.dataQualityGrade, replay.executionFidelityGrade,
    replay.fidelityLevel, replay.executionState,
    JSON.stringify({
      immutable: true,
      counterfactualOnly: true,
      changesSignal: false,
      ...replay.detail,
    }),
  ]);
  return rowCount;
}

async function persistWalExecutionReplays(db, order, options = {}) {
  if (order.order_kind !== 'taker') return { inserted: 0, rows: [] };
  const latencies = options.latencies || WAL_REPLAY_LATENCIES_MS;
  const rows = [];
  let inserted = 0;
  for (const latencyMs of latencies) {
    const replay = await replayOrder(db, order, latencyMs, options);
    rows.push(replay);
    if (options.persist !== false) inserted += await persistReplay(db, replay);
  }
  return { inserted, rows };
}

module.exports = {
  WAL_REPLAY_LATENCIES_MS,
  persistReplay,
  persistWalExecutionReplays,
  replayOrder,
  replayPnl,
};
