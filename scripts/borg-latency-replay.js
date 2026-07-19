#!/usr/bin/env node
/**
 * Deterministic quote-survival replay across independent order-latency
 * profiles. No order is sent and no strategy parameter is fitted.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const { binaryPnl, simulateTakerTouch } = require('../borg/research/execution-kernel');

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function parseProfiles() {
  const fixed = String(arg('--profiles', '100,250,500,1000,2000'))
    .split(',').map(Number).filter((value) => Number.isFinite(value) && value > 0);
  const profiles = fixed.map((latencyMs) => ({ name: `${latencyMs}ms`, latencyMs }));
  for (const [flag, name] of [['--mac-benchmark', 'measured-mac'], ['--dublin-benchmark', 'measured-dublin'], ['--us-east-benchmark', 'measured-us-east']]) {
    const file = arg(flag);
    if (!file) continue;
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    const latencyMs = Number(report.suggested_order_latency_ms);
    if (latencyMs > 0) profiles.push({ name, latencyMs, benchmark: path.resolve(file) });
  }
  return profiles;
}

function lcg(seed = 0x5eed1234) {
  let state = seed >>> 0;
  return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

function quantile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function clustered(records, keyFn, draws = 2000) {
  const groups = new Map();
  for (const row of records) {
    const key = keyFn(row);
    const group = groups.get(key) || { pnl: 0, n: 0 };
    group.pnl += row.pnl1x;
    group.n += 1;
    groups.set(key, group);
  }
  const values = [...groups.values()];
  if (!values.length) return { clusters: 0, mean_pnl_per_signal: null, ci95: [null, null] };
  const observed = values.reduce((sum, group) => sum + group.pnl, 0) /
    values.reduce((sum, group) => sum + group.n, 0);
  if (values.length < 2) return { clusters: values.length, mean_pnl_per_signal: observed, ci95: [null, null] };
  const random = lcg();
  const boot = [];
  for (let draw = 0; draw < draws; draw++) {
    let pnl = 0; let n = 0;
    for (let i = 0; i < values.length; i++) {
      const group = values[Math.floor(random() * values.length)];
      pnl += group.pnl; n += group.n;
    }
    boot.push(n ? pnl / n : 0);
  }
  return {
    clusters: values.length,
    mean_pnl_per_signal: observed,
    ci95: [quantile(boot, 0.025), quantile(boot, 0.975)],
  };
}

async function replayProfile(db, profile, strategy, asOf) {
  const strategyClause = strategy ? 'AND o.strategy = $3' : '';
  const params = strategy ? [profile.latencyMs, asOf, strategy] : [profile.latencyMs, asOf];
  const { rows } = await db.query(`
    SELECT o.id, o.ts, o.strategy, o.market_id, o.token, o.price, o.size, o.queue_ahead,
           o.features, m.asset, m.outcome,
           touch.ts AS state_ts, touch.best_ask, touch.ask_size, touch.state_source,
           touch.connection_epoch, touch.event_sequence,
           EXISTS (
             SELECT 1 FROM borg_clob_events gap
             WHERE gap.event_type='connection_gap' AND gap.ts > o.ts
               AND gap.ts <= o.ts + ($1::text || ' milliseconds')::interval
           ) AS connection_gap
    FROM borg_shadow_orders o
    JOIN borg_markets m ON m.id=o.market_id AND m.outcome IS NOT NULL
    LEFT JOIN LATERAL (
      SELECT candidate.* FROM (
        SELECT e.ts, e.best_ask, e.ask_size, 'event'::text state_source,
               e.connection_epoch, e.event_sequence
        FROM borg_clob_touch e
        WHERE e.market_id=o.market_id
          AND e.asset_id=CASE WHEN o.token='UP' THEN m.up_token_id ELSE m.down_token_id END
          AND e.best_ask IS NOT NULL
          AND e.ts >= o.ts - interval '2 seconds'
          AND e.ts <= o.ts + ($1::text || ' milliseconds')::interval
        UNION ALL
        SELECT e.ts, e.best_ask, e.ask_size, 'legacy_event'::text,
               e.connection_epoch, e.event_sequence
        FROM borg_clob_events e
        WHERE e.market_id=o.market_id
          AND e.asset_id=CASE WHEN o.token='UP' THEN m.up_token_id ELSE m.down_token_id END
          AND e.best_ask IS NOT NULL
          AND e.ts >= o.ts - interval '2 seconds'
          AND e.ts <= o.ts + ($1::text || ' milliseconds')::interval
        UNION ALL
        SELECT s.ts,
               CASE WHEN o.token='UP' THEN (s.up_asks->0->>0)::real ELSE (s.down_asks->0->>0)::real END,
               CASE WHEN o.token='UP' THEN (s.up_asks->0->>1)::real ELSE (s.down_asks->0->>1)::real END,
               'snapshot'::text, NULL::int, NULL::bigint
        FROM borg_book_snaps s
        WHERE s.market_id=o.market_id
          AND s.ts >= o.ts - interval '2 seconds'
          AND s.ts <= o.ts + ($1::text || ' milliseconds')::interval
      ) candidate
      WHERE candidate.best_ask IS NOT NULL
      ORDER BY candidate.ts DESC LIMIT 1
    ) touch ON true
    WHERE o.action='place' AND o.order_kind='taker' AND o.ts <= $2 ${strategyClause}
    ORDER BY o.id`, params);

  return rows.map((row) => {
    const arrivalMs = new Date(row.ts).getTime() + profile.latencyMs;
    const stateMs = row.state_ts ? new Date(row.state_ts).getTime() : null;
    const stateAgeMs = stateMs == null ? null : Math.max(0, arrivalMs - stateMs);
    const fill = simulateTakerTouch({
      limitPrice: row.price, requestedSize: row.size,
      bestAsk: row.best_ask, askSize: row.ask_size,
      connectionGap: row.connection_gap === true,
      stateSource: row.state_source, stateAgeMs,
    });
    const one = binaryPnl({
      token: row.token, outcome: row.outcome,
      fillPrice: fill.fillPrice, fillSize: fill.fillSize,
      orderKind: 'taker', feeMultiplier: 1,
    });
    const two = binaryPnl({
      token: row.token, outcome: row.outcome,
      fillPrice: fill.fillPrice, fillSize: fill.fillSize,
      orderKind: 'taker', feeMultiplier: 2,
    });
    return {
      orderId: String(row.id), strategy: row.strategy, marketId: String(row.market_id),
      asset: row.asset, day: new Date(row.ts).toISOString().slice(0, 10),
      decisionTs: new Date(row.ts).toISOString(), latencyProfile: profile.name,
      orderLatencyMs: profile.latencyMs,
      informationCadence: row.features?.information_cadence || 'legacy_unknown',
      dataQualityGrade: fill.dataQualityGrade,
      executionFidelityGrade: fill.executionFidelityGrade,
      stateSource: row.state_source || null,
      stateAgeMs,
      connectionGap: row.connection_gap === true,
      filled: fill.filled, fillSize: fill.fillSize, fillPrice: fill.fillPrice,
      pnlGross: one.gross, pnl1x: one.net, pnl2x: two.net,
    };
  });
}

function summarize(records, profile) {
  const quality = { A: 0, B: 0, C: 0, F: 0 };
  for (const row of records) quality[row.dataQualityGrade] += 1;
  const valid = records.filter((row) => row.dataQualityGrade !== 'F');
  const filled = valid.filter((row) => row.filled);
  return {
    profile: profile.name,
    order_latency_ms: profile.latencyMs,
    intended_signals: records.length,
    independent_markets: new Set(records.map((row) => row.marketId)).size,
    utc_days: new Set(records.map((row) => row.day)).size,
    replayable: valid.length,
    fill_rate_on_replayable: valid.length ? filled.length / valid.length : null,
    pnl_1x: valid.reduce((sum, row) => sum + row.pnl1x, 0),
    pnl_2x: valid.reduce((sum, row) => sum + row.pnl2x, 0),
    quality_grades: quality,
    market_clustered: clustered(valid, (row) => row.marketId),
    day_clustered: clustered(valid, (row) => row.day),
  };
}

async function main() {
  const profiles = parseProfiles();
  const strategy = arg('--strategy');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2 });
  const db = await pool.connect();
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const { rows: clock } = await db.query('SELECT clock_timestamp() AS as_of');
  const asOf = clock[0].as_of;
  const output = {
    format: 'borg-latency-replay-v1',
    created_at: new Date().toISOString(),
    strategy: strategy || 'ALL_TAKER_STRATEGIES',
    database_snapshot_as_of: new Date(asOf).toISOString(),
    caveat: 'Counterfactual quote-survival replay, not a causal alpha estimate. F-grade rows are excluded, never assumed filled.',
    profiles: [],
  };
  const allRows = [];
  try {
    for (const profile of profiles) {
      const rows = await replayProfile(db, profile, strategy, asOf);
      allRows.push(...rows);
      output.profiles.push(summarize(rows, profile));
    }
  } finally {
    await db.query('ROLLBACK').catch(() => {});
    db.release();
    await pool.end();
  }
  const rowsFile = arg('--rows');
  if (rowsFile) fs.writeFileSync(rowsFile, `${allRows.map((row) => JSON.stringify(row)).join('\n')}\n`, { mode: 0o600 });
  const json = `${JSON.stringify(output, null, 2)}\n`;
  const out = arg('--out');
  if (out) fs.writeFileSync(out, json, { mode: 0o600 });
  console.log(json.trim());
}

if (require.main === module) main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });

module.exports = { clustered, summarize };
