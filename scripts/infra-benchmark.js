#!/usr/bin/env node
/** Read-only infrastructure benchmark. It never signs or posts an order. */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const WebSocket = require('ws');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function percentile(xs, p) {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function stats(xs) {
  const clean = xs.filter(Number.isFinite);
  return {
    n: clean.length,
    min_ms: clean.length ? +Math.min(...clean).toFixed(3) : null,
    p50_ms: percentile(clean, 0.5) != null ? +percentile(clean, 0.5).toFixed(3) : null,
    p95_ms: percentile(clean, 0.95) != null ? +percentile(clean, 0.95).toFixed(3) : null,
    max_ms: clean.length ? +Math.max(...clean).toFixed(3) : null,
  };
}

async function httpRtts(url, count = 10) {
  const values = [];
  for (let i = 0; i < count; i++) {
    const started = performance.now();
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    await response.arrayBuffer();
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    values.push(performance.now() - started);
  }
  return stats(values);
}

async function clockCalibration(url, parseServerMs, count = 10, quantizationMs = 1) {
  const offsets = []; const uncertainties = [];
  for (let i = 0; i < count; i++) {
    const startWall = Date.now();
    const started = performance.now();
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const payload = await response.json();
    const endWall = Date.now();
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const serverMs = parseServerMs(payload);
    const rtt = performance.now() - started;
    if (Number.isFinite(serverMs)) {
      offsets.push((startWall + endWall) / 2 - serverMs);
      uncertainties.push(rtt / 2);
    }
  }
  return {
    local_minus_source_ms: stats(offsets),
    midpoint_uncertainty_ms: stats(uncertainties),
    quantization_ms: quantizationMs,
    reliable: quantizationMs < 1000,
    correction_ms: quantizationMs < 1000 ? (percentile(offsets, 0.5) || 0) : 0,
  };
}

async function dbRtts(pool, count = 20) {
  const values = [];
  for (let i = 0; i < count; i++) {
    const started = performance.now();
    await pool.query('SELECT 1');
    values.push(performance.now() - started);
  }
  return stats(values);
}

async function observeWs({
  url, subscribe, durationMs, parse,
  sourceClockOffsetMs = 0, sourceClockUncertaintyMs = null,
}) {
  return new Promise((resolve) => {
    const freshness = [];
    const rawFreshness = [];
    const arrivalGaps = [];
    let lastArrival = null;
    let openedAt = null;
    let error = null;
    let settled = false;
    const ws = new WebSocket(url);
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { ws.close(); } catch (_) {}
      resolve({
        connect_ms: openedAt,
        freshness_corrected: stats(freshness),
        freshness_raw: stats(rawFreshness),
        source_clock_correction_ms: sourceClockOffsetMs,
        source_clock_uncertainty_ms: sourceClockUncertaintyMs,
        interarrival: stats(arrivalGaps), error,
      });
    };
    const timeout = setTimeout(finish, durationMs);
    const started = performance.now();
    ws.on('open', () => {
      openedAt = performance.now() - started;
      if (subscribe) ws.send(JSON.stringify(subscribe));
    });
    ws.on('message', (raw) => {
      const now = Date.now();
      if (lastArrival != null) arrivalGaps.push(now - lastArrival);
      lastArrival = now;
      try {
        const sourceMs = parse(raw);
        if (Number.isFinite(sourceMs)) {
          rawFreshness.push(now - sourceMs);
          freshness.push(Math.max(0, now - sourceMs - sourceClockOffsetMs));
        }
      } catch (_) {}
    });
    ws.on('error', (err) => { error = err.message; });
    ws.on('close', finish);
  });
}

async function main() {
  const durationMs = Math.max(5000, Number(arg('--duration-ms', 10000)));
  const location = arg('--location', 'measured-mac');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 });
  const database = await dbRtts(pool);
  const dbHost = (() => { try { return new URL(process.env.DATABASE_URL).host; } catch (_) { return null; } })();
  const { rows } = await pool.query(
    `SELECT up_token_id FROM borg_markets
     WHERE window_end > now() ORDER BY window_start LIMIT 1`).catch(() => ({ rows: [] }));
  await pool.end();
  const token = rows[0]?.up_token_id || null;

  const [binanceClock, clobClock] = await Promise.all([
    clockCalibration('https://api.binance.com/api/v3/time', (payload) => Number(payload.serverTime)),
    clockCalibration('https://clob.polymarket.com/time', (payload) => {
      const value = Number(payload); return value < 1e12 ? value * 1000 : value;
    }, 10, 1000),
  ]);

  const [clobHttp, binanceHttp, binanceWs, rtdsWs, clobWs] = await Promise.all([
    httpRtts('https://clob.polymarket.com/time'),
    httpRtts('https://api.binance.com/api/v3/time'),
    observeWs({
      url: 'wss://stream.binance.com:9443/ws/btcusdt@aggTrade', durationMs,
      sourceClockOffsetMs: binanceClock.correction_ms,
      sourceClockUncertaintyMs: binanceClock.midpoint_uncertainty_ms.p50_ms,
      parse: (raw) => Number(JSON.parse(raw).T),
    }),
    observeWs({
      url: 'wss://ws-live-data.polymarket.com', durationMs,
      sourceClockOffsetMs: clobClock.correction_ms,
      sourceClockUncertaintyMs: 500,
      subscribe: { action: 'subscribe', subscriptions: [{ topic: 'crypto_prices_chainlink', type: '*', filters: '' }] },
      parse: (raw) => {
        if (raw.toString() === 'PONG') return null;
        const message = JSON.parse(raw); const payload = message.payload;
        return Number((Array.isArray(payload) ? payload[0] : payload)?.timestamp || message.timestamp);
      },
    }),
    token ? observeWs({
      url: 'wss://ws-subscriptions-clob.polymarket.com/ws/market', durationMs,
      sourceClockOffsetMs: clobClock.correction_ms,
      sourceClockUncertaintyMs: 500,
      subscribe: { type: 'market', assets_ids: [token], custom_feature_enabled: true },
      parse: (raw) => {
        if (raw.toString() === 'PONG') return null;
        const parsed = JSON.parse(raw); const event = Array.isArray(parsed) ? parsed[0] : parsed;
        const value = Number(event?.timestamp); return value < 1e12 ? value * 1000 : value;
      },
    }) : Promise.resolve({ error: 'no current token available', freshness_corrected: stats([]), interarrival: stats([]) }),
  ]);

  const report = {
    format: 'borg-infra-benchmark-v1',
    measured_at: new Date().toISOString(),
    location,
    host: os.hostname(),
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    duration_ms: durationMs,
    database: { host: dbHost, rtt: database },
    clock_calibration: { binance: binanceClock, polymarket: clobClock },
    public_http_rtt: { polymarket_clob_time: clobHttp, binance_time: binanceHttp },
    websocket: { binance_aggTrade: binanceWs, polymarket_chainlink_rtds: rtdsWs, polymarket_clob: clobWs },
    order_acknowledgement: {
      status: 'NOT_MEASURED',
      reason: 'Read-only benchmark: no signed/live order was authorized. HTTP RTT is a routing proxy, not order acknowledgement.',
    },
    suggested_order_latency_ms: Math.ceil(Math.max(100, clobHttp.p95_ms || 0)),
    interpretation: 'Compare identical reports from Mac, Dublin and us-east. A VPS claim is invalid unless feed freshness and CLOB RTT improve without a remote database bottleneck.',
  };
  const output = `${JSON.stringify(report, null, 2)}\n`;
  const outFile = arg('--out');
  if (outFile) {
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    fs.writeFileSync(path.resolve(outFile), output, { mode: 0o600 });
  }
  console.log(output.trim());
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
