/**
 * BORG shadow scorer — offline tape replay per EVAL_PROTOCOL.md §1/§4.
 *
 * Scores every unscored 'place' order whose market has resolved:
 *  - taker: fills at the logged ask, size capped at what was displayed.
 *  - maker: BACK-OF-QUEUE — the order fills only when cumulative tape volume
 *    through its price level (prints at price ≤ bid for buys, ≥ ask for
 *    sells) exceeds the size that was already displayed at that level when
 *    the order was placed. Life ends at its matching 'cancel' row or at
 *    window end.
 *  - PnL to resolution (BUY: payout − price; SELL: price − payout, standard
 *    short-binary accounting).
 *  - Cost grid (§4): current crypto taker curve
 *    (shares × 0.07 × price × (1-price)), 0 on maker; reported at
 *    0.5×/1×/2×. Maker rebates are deliberately not credited.
 *  - Adverse selection: Φ-fair 5s/30s after fill vs fill price (online
 *    phi_fair — convenience σ; see RECON.md Q2 caveat, fine for pilots).
 *
 * Aggregate report: per strategy — orders, fill rate, expectancy per filled
 * order at the cost grid, bootstrap 95% CI (10k resamples) on the 1× mean.
 * PILOT data tunes machinery; it is NOT evidence (§3).
 *
 * Run: node borg/shadow/score.js
 */
const { pool, migrate } = require('../recon/db');
const { archiveAndPrune, safeArchiveCutoff } = require('./archive');
const {
  FEE_MODEL_VERSION,
  SIMULATOR_VERSION,
  binaryPnl,
  executionFidelity,
  qualityGrade,
  simulateTakerTouch,
} = require('../research/execution-kernel');
const { persistWalExecutionReplays } = require('../research/execution-replay');

const GRID = { '05x': 0.5, '1x': 1, '2x': 2 };
const PROMOTION_LATENCIES_MS = Object.freeze([100, 250, 500]);
const SCHEDULED = process.argv.includes('--scheduled');
const RETENTION_LOCK = 'deltaforge-raw-retention-v1';

async function ensureSchema() {
  const { rows } = await pool.query(`
    SELECT to_regclass('borg_shadow_orders') IS NOT NULL AS orders_ready,
           to_regclass('borg_shadow_scores') IS NOT NULL AS scores_ready,
           to_regclass('borg_shadow_latency_scores') IS NOT NULL AS latency_scores_ready,
           to_regclass('borg_shadow_execution_replays') IS NOT NULL AS execution_replays_ready,
           EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_name='borg_shadow_scores' AND column_name='simulator_version'
           ) AS score_contract_ready`);
  const state = rows[0] || {};
  if (!state.orders_ready || !state.scores_ready || !state.latency_scores_ready
      || !state.execution_replays_ready
      || !state.score_contract_ready) await migrate();
}

async function heartbeat(meta = {}) {
  await pool.query(
    `INSERT INTO system_heartbeats (component, beat_at, meta)
     VALUES ('borg_scorer', now(), $1::jsonb)
     ON CONFLICT (component) DO UPDATE SET beat_at=now(), meta=EXCLUDED.meta`,
    [JSON.stringify(meta)],
  ).catch(() => {});
}

function isPositiveToken(token, market = null) {
  const value = String(token || '').toUpperCase();
  const configured = String(market?.positive_label || '').toUpperCase();
  return value === 'UP' || value === 'YES' || (configured && value === configured);
}

async function fairAt(marketId, ts, token) {
  const { rows } = await pool.query(
    `SELECT phi_fair FROM borg_book_snaps
     WHERE market_id=$1 AND ts >= $2 AND phi_fair IS NOT NULL
     ORDER BY ts LIMIT 1`, [marketId, ts]);
  const phi = rows[0]?.phi_fair ?? null;
  if (phi == null) return null;
  return isPositiveToken(token) ? phi : 1 - phi;
}

async function scoreMakerFill(o, market, cancelTs) {
  const assetId = isPositiveToken(o.token, market) ? market.up_token_id : market.down_token_id;
  const dirSql = o.side === 'BUY' ? 'price <= $4' : 'price >= $4';
  const { rows: prints } = await pool.query(
    `SELECT ts, price, size FROM borg_clob_events
     WHERE market_id=$1 AND asset_id=$2 AND event_type='last_trade_price'
       AND ts > $3 AND ts <= $5 AND size IS NOT NULL AND ${dirSql}
     ORDER BY ts`, [o.market_id, assetId, o.ts, o.price, cancelTs]);
  let cum = 0;
  const queue = o.queue_ahead ?? 0;
  for (const p of prints) {
    cum += p.size;
    if (cum > queue) {
      return { filled: true, fillTs: p.ts, fillPrice: o.price, fillSize: Math.min(o.size, cum - queue) };
    }
  }
  return { filled: false };
}

/**
 * Conservative shadow taker: wait for the current local pipeline's observed
 * signal-to-claim latency, then require the recorded book still to offer
 * executable depth at or below the original limit. A quote that vanished is
 * a non-fill, which is essential after the G live audit found missed orders
 * were disproportionately winners.
 *
 * This is opt-in through features.execution_model so frozen historical G/ETH
 * cohorts keep their original scoring definition and are never mixed with a
 * changed methodology.
 */
async function scoreLatencyTakerFill(o) {
  const latencyMs = 1250; // 1s polling cadence + typical CLOB request time
  const arrival = new Date(new Date(o.available_at || o.ts).getTime() + latencyMs);
  const col = isPositiveToken(o.token, o) ? 'up_asks' : 'down_asks';
  const { rows } = await pool.query(
    `SELECT ts, book_src, ${col} AS asks FROM borg_book_snaps
     WHERE market_id=$1 AND ts >= $2 AND ts <= $3
     ORDER BY ts DESC LIMIT 1`, [o.market_id, o.available_at || o.ts, arrival]);
  if (!rows[0] || !Array.isArray(rows[0].asks)) {
    return { filled: false, detail: {
      order_latency_ms: latencyMs, latency_tape_missing: true,
      data_quality_grade: 'F', execution_fidelity_grade: 'F', fidelity_level: 'L2',
    } };
  }
  const stateAgeMs = arrival.getTime() - new Date(rows[0].ts).getTime();
  const stateSource = String(rows[0].book_src || '').includes('ws') ? 'event' : 'snapshot';
  const dataQualityGrade = qualityGrade({ connectionGap: false, stateSource, stateAgeMs });
  const fidelity = executionFidelity({ model: 'latency_1s', dataQualityGrade, fullDepth: true });
  if (dataQualityGrade === 'F') {
    return { filled: false, detail: {
      order_latency_ms: latencyMs, state_age_ms: stateAgeMs,
      data_quality_grade: dataQualityGrade,
      execution_fidelity_grade: fidelity.executionFidelityGrade,
      fidelity_level: fidelity.fidelityLevel,
    } };
  }
  let shares = 0; let cost = 0; let capacityAtArrival = 0;
  for (const level of rows[0].asks) {
    const price = parseFloat(Array.isArray(level) ? level[0] : level?.price);
    const size = parseFloat(Array.isArray(level) ? level[1] : level?.size);
    if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0) continue;
    if (price > o.price + 1e-9) break;
    capacityAtArrival += size;
    const take = Math.min(size, o.size - shares);
    shares += take;
    cost += take * price;
    if (shares >= o.size - 1e-9) break;
  }
  if (!(shares > 0)) {
    return { filled: false, detail: {
      order_latency_ms: latencyMs, quote_survived: false, capacity_at_arrival: capacityAtArrival,
      state_age_ms: stateAgeMs, data_quality_grade: dataQualityGrade,
      execution_fidelity_grade: fidelity.executionFidelityGrade,
      fidelity_level: fidelity.fidelityLevel,
    } };
  }
  return {
    filled: true,
    fillTs: arrival,
    fillPrice: cost / shares,
    fillSize: shares,
    detail: {
      order_latency_ms: latencyMs, quote_survived: true, partial: shares + 1e-9 < o.size,
      capacity_at_arrival: capacityAtArrival, state_age_ms: stateAgeMs,
      data_quality_grade: dataQualityGrade,
      execution_fidelity_grade: fidelity.executionFidelityGrade,
      fidelity_level: fidelity.fidelityLevel,
    },
  };
}

/**
 * Event-tape execution model used by randomized cadence experiments. Signal
 * observation latency is already represented by the arm's trigger time; this
 * function adds only order latency. The latest derived CLOB touch at arrival
 * determines quote survival and displayed capacity. A connection gap means
 * non-fill, never an optimistic assumption.
 */
async function scoreEventTakerFill(o, latencyMs) {
  const availableAt = o.available_at || o.ts;
  const arrival = new Date(new Date(availableAt).getTime() + latencyMs);
  const assetId = isPositiveToken(o.token, o) ? o.up_token_id : o.down_token_id;
  const { rows: gaps } = await pool.query(
    `SELECT count(*)::int AS n FROM borg_clob_events
     WHERE event_type='connection_gap' AND ts > $1 AND ts <= $2`, [availableAt, arrival]);
  if ((parseInt(gaps[0]?.n) || 0) > 0) {
    return { filled: false, detail: {
      information_latency_ms: o.features?.decision_delay_ms ?? null, order_latency_ms: latencyMs,
      data_quality_grade: 'F', execution_fidelity_grade: 'F', fidelity_level: 'L3', connection_gap: true,
    } };
  }
  const { rows } = await pool.query(
    `SELECT ts, best_ask, ask_size, source_ts, connection_epoch, event_sequence
     FROM borg_clob_touch
     WHERE market_id=$1 AND asset_id=$2 AND ts > $3 AND ts <= $4
       AND best_ask IS NOT NULL
     ORDER BY ts DESC LIMIT 1`, [o.market_id, assetId, availableAt, arrival]);
  const tape = rows[0] || null;
  if (!tape) return { filled: false, detail: {
    information_latency_ms: o.features?.decision_delay_ms ?? null,
    order_latency_ms: latencyMs, data_quality_grade: 'F',
    execution_fidelity_grade: 'F', fidelity_level: 'L3', latency_tape_missing: true,
  } };
  const bestAsk = parseFloat(tape.best_ask);
  const askSize = parseFloat(tape.ask_size);
  const stateAt = new Date(tape.ts);
  const stateAgeMs = arrival.getTime() - stateAt.getTime();
  const simulated = simulateTakerTouch({
    limitPrice: o.price, requestedSize: o.size,
    bestAsk, askSize,
    stateSource: tape ? 'event' : 'snapshot', stateAgeMs,
  });
  const detail = {
    information_latency_ms: o.features?.decision_delay_ms ?? null,
    order_latency_ms: latencyMs,
    state_age_ms: stateAgeMs,
    data_quality_grade: simulated.dataQualityGrade,
    execution_fidelity_grade: simulated.executionFidelityGrade,
    fidelity_level: simulated.fidelityLevel,
    capacity_at_arrival: simulated.capacityAtArrival,
    clob_event_sequence: tape?.event_sequence ?? null,
    clob_connection_epoch: tape?.connection_epoch ?? null,
    quote_survived: simulated.quoteSurvived,
  };
  if (!simulated.filled) return { filled: false, detail };
  return {
    filled: true,
    fillTs: arrival,
    fillPrice: simulated.fillPrice,
    fillSize: simulated.fillSize,
    detail: { ...detail, partial: simulated.partial },
  };
}

function pnl(o, fill, outcome) {
  const one = binaryPnl({
    side: o.side, token: o.token, outcome,
    fillPrice: fill.fillPrice, fillSize: fill.fillSize,
    orderKind: o.order_kind, feeMultiplier: 1,
  });
  const gross = one.gross;
  const baseCost = one.fee;
  const at = {};
  for (const [k, mul] of Object.entries(GRID)) at[k] = gross - baseCost * mul;
  return { gross, at };
}

async function persistLatencyCounterfactuals(o) {
  if (o.order_kind !== 'taker') return 0;
  let inserted = 0;
  for (const latencyMs of PROMOTION_LATENCIES_MS) {
    const fill = await scoreEventTakerFill(o, latencyMs);
    const dataQualityGrade = fill.detail?.data_quality_grade || 'F';
    const executionFidelityGrade = fill.detail?.execution_fidelity_grade || 'F';
    let gross = 0; let pnl1x = 0; let pnl2x = 0;
    if (fill.filled) {
      const scored = pnl(o, fill, o.outcome);
      gross = scored.gross;
      pnl1x = scored.at['1x'];
      pnl2x = scored.at['2x'];
    }
    const { rowCount } = await pool.query(`
      INSERT INTO borg_shadow_latency_scores
        (order_id,latency_ms,filled,fill_ts,fill_price,fill_size,
         pnl_gross,pnl_1x,pnl_2x,data_quality_grade,
         execution_fidelity_grade,detail)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
      ON CONFLICT (order_id,latency_ms) DO NOTHING
    `, [o.id, latencyMs, fill.filled === true, fill.fillTs || null,
      fill.fillPrice || null, fill.fillSize || null, gross, pnl1x, pnl2x,
      dataQualityGrade, executionFidelityGrade, JSON.stringify({
        counterfactualOnly: true,
        changesSignal: false,
        latencyMs,
        ...(fill.detail || {}),
      })]);
    inserted += rowCount;
  }
  return inserted;
}

function bootstrapCI(xs, n = 10000) {
  if (xs.length < 2) return [null, null];
  const means = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < xs.length; j++) s += xs[(Math.random() * xs.length) | 0];
    means[i] = s / xs.length;
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(n * 0.025)], means[Math.floor(n * 0.975)]];
}

// Retention: local PostgreSQL is a configurable hot tier (24h default). Raw
// rows are atomically archived + gzip-verified on local disk BEFORE the
// exact rows are deleted. Prune AFTER scoring, and never archive/prune tape
// newer than the oldest unscored order — a maker order scored against missing
// tape silently becomes filled=false.
async function pruneRawFeed(options = {}) {
  const { cutoff } = await safeArchiveCutoff(pool);
  // The independent hot-tier timer touches some of the same derived tables.
  // Serialize both jobs so DELETE/foreign-key checks do not contend and turn a
  // healthy collector into a recurring maintenance failure.
  const retentionClient = await pool.connect();
  let retentionLocked = false;
  let state;
  try {
    const { rows: lockRows } = await retentionClient.query(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', [RETENTION_LOCK],
    );
    retentionLocked = lockRows[0]?.acquired === true;
    if (!retentionLocked) {
      console.log('raw archive/prune skipped: another retention worker holds the advisory lock');
      return;
    }
    state = await archiveAndPrune(retentionClient, cutoff, options);
  } finally {
    if (retentionLocked) {
      await retentionClient.query('SELECT pg_advisory_unlock(hashtext($1))', [RETENTION_LOCK]).catch(() => {});
    }
    retentionClient.release();
  }
  const archivedRows = state.results.reduce((sum, result) => sum + result.rows, 0);
  const archivedBytes = state.results.reduce((sum, result) => sum + result.compressed_bytes, 0);
  if (archivedRows > 0) {
    console.log(
      `archived + pruned ${archivedRows} raw rows in ${state.results.reduce((s, r) => s + r.files, 0)} files ` +
      `(${(archivedBytes / 1024 / 1024).toFixed(1)} MiB gzip) -> ${state.archive_dir}`,
    );
  }
  if (state.errors.length) {
    console.warn(`RAW ARCHIVE DEGRADED: ${state.errors.length} table(s) retained in DB; no unarchived rows were deleted`);
  }

  await pruneShadowOrderHygiene();
}

async function pruneShadowOrderHygiene() {
  // Shadow-order hygiene (2026-07-12 relaunch audit): borg_shadow_orders was
  // the largest UNBOUNDED table at ~5.4 MB/day (A_maker requotes every 5s,
  // each row carrying a full feature JSONB) — projected days-to-full ~26.
  // Two lossless-for-evaluation reductions, both restricted to PILOT rows:
  //  - cancel rows are only consumed by scoring (they bound a quote's life);
  //    once every order they could affect is scored and >48h old, drop them.
  //  - feature JSONB on scored pilot orders >7 days old is stripped (the
  //    score row keeps fill/pnl/detail; features exist for strategy tuning,
  //    which per EVAL_PROTOCOL §3 never uses stale pilot data anyway).
  try {
    const { rowCount: c1 } = await pool.query(`
      DELETE FROM borg_shadow_orders c
      WHERE c.action='cancel' AND c.phase='pilot' AND c.ts < now() - interval '48 hours'
        AND NOT EXISTS (
          SELECT 1 FROM borg_shadow_orders o
          LEFT JOIN borg_shadow_scores s ON s.order_id = o.id
          WHERE o.client_order_id = c.client_order_id AND o.action='place' AND s.order_id IS NULL)`);
    const { rowCount: c2 } = await pool.query(`
      UPDATE borg_shadow_orders o SET features = NULL
      FROM borg_shadow_scores s
      WHERE s.order_id = o.id AND o.phase='pilot' AND o.features IS NOT NULL
        AND ((NOT s.filled AND o.ts < now() - interval '24 hours')
             OR o.ts < now() - interval '7 days')`);
    if (c1 || c2) console.log(`shadow-order hygiene: ${c1} old cancels dropped, ${c2} feature blobs stripped`);
  } catch (e) {
    console.warn(`shadow-order hygiene skipped: ${e.message}`);
  }
}

async function main() {
  await ensureSchema();
  await heartbeat({ status: 'scoring', mode: SCHEDULED ? 'scheduled' : 'manual-full' });
  const heartbeatTimer = setInterval(() => {
    heartbeat({ status: 'scoring', mode: SCHEDULED ? 'scheduled' : 'manual-full' }).catch(() => {});
  }, 60000);
  heartbeatTimer.unref();
  const { rows: orders } = await pool.query(
    `SELECT o.*, m.outcome, m.window_end, m.up_token_id, m.down_token_id,
            m.positive_label, m.negative_label
     FROM borg_shadow_orders o
     JOIN borg_markets m ON m.id = o.market_id
     LEFT JOIN borg_shadow_scores s ON s.order_id = o.id
     WHERE o.action='place' AND s.order_id IS NULL
       AND m.outcome IS NOT NULL AND m.window_end < now() - interval '60 seconds'
     ORDER BY o.id`);
  console.log(`${orders.length} unscored orders`);

  for (const o of orders) {
    let cancelTs = o.window_end;
    if (o.order_kind === 'maker') {
      const { rows: c } = await pool.query(
        `SELECT ts FROM borg_shadow_orders WHERE action='cancel' AND client_order_id=$1 AND ts > $2 ORDER BY ts LIMIT 1`,
        [o.client_order_id, o.ts]);
      if (c[0] && c[0].ts < cancelTs) cancelTs = c[0].ts;
    }
    // Tape coverage over the order's life — 0 events means the score is
    // tape-blind (EVAL_PROTOCOL §2 requires these windows be excluded).
    let tapeEvents = null;
    if (o.order_kind === 'maker') {
      const { rows: tc } = await pool.query(
        `SELECT count(*)::int AS n FROM borg_clob_events WHERE market_id=$1 AND ts > $2 AND ts <= $3`,
        [o.market_id, o.ts, cancelTs]);
      tapeEvents = tc[0].n;
    }
    const executionModel = o.features?.execution_model;
    const eventLatency = /^event_order_(100|250|500|1000|2000)ms$/.exec(executionModel || '');
    const fill = o.order_kind === 'taker'
      ? (eventLatency
        ? await scoreEventTakerFill(o, parseInt(eventLatency[1]))
        : executionModel === 'latency_1s'
          ? await scoreLatencyTakerFill(o)
          : { filled: true, fillTs: o.ts, fillPrice: o.price, fillSize: Math.min(o.size, o.queue_ahead || o.size),
            detail: { data_quality_grade: 'C', execution_fidelity_grade: 'D', fidelity_level: 'L1',
              capacity_at_arrival: o.queue_ahead || o.size, legacy_touch_assumption: true } })
      : await scoreMakerFill(o, o, cancelTs);

    if (o.order_kind === 'maker' && !fill.detail) {
      const makerQuality = tapeEvents > 0 ? 'B' : 'F';
      const makerFidelity = executionFidelity({
        model: 'maker_queue_v1', dataQualityGrade: makerQuality, queueReplay: true,
      });
      fill.detail = {
        data_quality_grade: makerQuality,
        execution_fidelity_grade: makerFidelity.executionFidelityGrade,
        fidelity_level: makerFidelity.fidelityLevel,
        capacity_at_arrival: fill.filled ? fill.fillSize : 0,
      };
    }

    const dataQualityGrade = fill.detail?.data_quality_grade || 'F';
    const executionFidelityGrade = fill.detail?.execution_fidelity_grade || 'F';
    const fidelityLevel = fill.detail?.fidelity_level || 'L0';

    let row;
    if (!fill.filled) {
      row = [o.id, o.strategy, o.phase, o.market_id, false, null, null, null, null, null, o.outcome, null, null, null, null,
        JSON.stringify({ cancel_ts: cancelTs, tape_events: tapeEvents, tape_blind: tapeEvents === 0,
          execution_model: executionModel || (o.order_kind === 'taker' ? 'touch_immediate' : 'maker_back_queue'),
          ...(fill.detail || {}) }), dataQualityGrade, executionFidelityGrade, fidelityLevel,
        SIMULATOR_VERSION, FEE_MODEL_VERSION];
    } else {
      const { gross, at } = pnl(o, fill, o.outcome);
      const f5 = await fairAt(o.market_id, new Date(new Date(fill.fillTs).getTime() + 5000), o.token);
      const f30 = await fairAt(o.market_id, new Date(new Date(fill.fillTs).getTime() + 30000), o.token);
      row = [o.id, o.strategy, o.phase, o.market_id, true, fill.fillTs, fill.fillPrice, fill.fillSize,
        f5, f30, o.outcome, gross, at['05x'], at['1x'], at['2x'],
        JSON.stringify({ cancel_ts: cancelTs, queue_ahead: o.queue_ahead, note: o.features?.note,
          tape_events: tapeEvents, tape_blind: tapeEvents === 0,
          execution_model: executionModel || (o.order_kind === 'taker' ? 'touch_immediate' : 'maker_back_queue'),
          ...(fill.detail || {}),
          fee_model: o.order_kind === 'taker' ? FEE_MODEL_VERSION : 'maker_zero_no_rebate' }),
        dataQualityGrade, executionFidelityGrade, fidelityLevel, SIMULATOR_VERSION, FEE_MODEL_VERSION];
    }
    // Freeze all desk-required latency counterfactuals before raw CLOB rows
    // leave the 24-hour SQL hot tier. Do this before the primary score insert:
    // a transient failure then leaves the order eligible for a complete retry.
    // These rows never feed back into the signal, primary fill or order path.
    await persistLatencyCounterfactuals(o);
    await persistWalExecutionReplays(pool, o);
    await pool.query(
      `INSERT INTO borg_shadow_scores (order_id, strategy, phase, market_id, filled, fill_ts, fill_price,
         fill_size, fair_5s, fair_30s, outcome, pnl_gross, pnl_05x, pnl_1x, pnl_2x, detail,
         data_quality_grade, execution_fidelity_grade, fidelity_level, simulator_version, fee_model_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       ON CONFLICT (order_id) DO NOTHING`, row);
  }

  // ── aggregate report ──────────────────────────────────────────────────
  // The five-minute service only needs to score new outcomes. Rebuilding a
  // 10k-resample bootstrap for every historical strategy made the timer spend
  // most of its life reporting instead of scoring. Manual runs retain the
  // complete research report.
  if (!SCHEDULED) {
    const { rows: agg } = await pool.query(
    `SELECT strategy, phase, count(*) AS n,
            count(*) FILTER (WHERE filled) AS n_filled,
            sum(pnl_gross) AS gross, sum(pnl_05x) AS p05, sum(pnl_1x) AS p1, sum(pnl_2x) AS p2,
            avg(fair_5s - fill_price) FILTER (WHERE filled AND side_is_buy) AS advsel_5s
     FROM (SELECT s.*, o.side = 'BUY' AS side_is_buy
           FROM borg_shadow_scores s JOIN borg_shadow_orders o ON o.id = s.order_id) t
     GROUP BY strategy, phase ORDER BY strategy`);
    console.log('\n━━━ shadow scoreboard (per strategy) ━━━');
    for (const a of agg) {
      const { rows: xs } = await pool.query(
      `SELECT pnl_1x FROM borg_shadow_scores WHERE strategy=$1 AND phase=$2 AND filled`, [a.strategy, a.phase]);
      const pnls = xs.map((r) => parseFloat(r.pnl_1x));
      const [lo, hi] = bootstrapCI(pnls);
      const mean = pnls.length ? pnls.reduce((s, x) => s + x, 0) / pnls.length : null;
      console.log(
      `  ${a.strategy} [${a.phase}]  orders=${a.n} filled=${a.n_filled} ` +
      `(${a.n > 0 ? Math.round((100 * a.n_filled) / a.n) : 0}%)\n` +
      `    PnL  0.5×=$${(+a.p05 || 0).toFixed(2)}  1×=$${(+a.p1 || 0).toFixed(2)}  2×=$${(+a.p2 || 0).toFixed(2)}` +
      `  | mean/fill(1×)=${mean != null ? '$' + mean.toFixed(3) : '—'}` +
      `  95% CI [${lo != null ? lo.toFixed(3) : '—'}, ${hi != null ? hi.toFixed(3) : '—'}]` +
      `  | advsel_5s=${a.advsel_5s != null ? (+a.advsel_5s).toFixed(4) : '—'}`);
    }
    console.log('\nPILOT data tunes machinery — not evidence (EVAL_PROTOCOL §3).');
  } else {
    console.log(`scheduled scorer persisted ${orders.length} resolved order(s); full bootstrap omitted`);
  }

  await heartbeat({
    status: process.env.BORG_SCORE_ARCHIVE === '0' ? 'maintenance' : 'archiving',
    scored: orders.length,
  });
  // Production separates archival from scoring. Manual/legacy environments
  // retain the bounded scheduled fallback so raw rows are never abandoned if
  // the dedicated worker has not been installed.
  if (process.env.BORG_SCORE_ARCHIVE === '0') await pruneShadowOrderHygiene();
  else await pruneRawFeed(SCHEDULED ? { maxBatchesPerTable: 4 } : {});
  clearInterval(heartbeatTimer);
  await heartbeat({ status: 'complete', scored: orders.length });
  await pool.end();
}

if (require.main === module) main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});

module.exports = {
  PROMOTION_LATENCIES_MS,
  ensureSchema,
  heartbeat,
  persistLatencyCounterfactuals,
  pnl,
  pruneRawFeed,
  pruneShadowOrderHygiene,
  scoreEventTakerFill,
  scoreLatencyTakerFill,
};
