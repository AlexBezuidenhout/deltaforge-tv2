#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const { lfDelimitedLines } = require('../borg/research/strict-ndjson');

const WAL_ROOT = process.env.FLOW_WAL_ROOT || '/var/lib/deltaforge/wal/borg/polymarket-flow-clob';
const ORDER_DELAYS_MS = Object.freeze([0, 25, 50, 100, 250, 500]);
const MAX_STATE_AGE_MS = 1500;
const MAX_TOUCH_PARTICIPATION = 0.20;
const TARGET_STAKE_USD = 10;

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 4) {
  const parsed = finite(value);
  return parsed == null ? null : +parsed.toFixed(digits);
}

function normLevels(levels, descending = false) {
  if (!Array.isArray(levels)) return [];
  return levels.map((level) => [finite(level?.price ?? level?.[0]), finite(level?.size ?? level?.[1])])
    .filter(([price, size]) => price != null && size != null && price > 0 && price < 1 && size > 0)
    .sort((left, right) => descending ? right[0] - left[0] : left[0] - right[0]);
}

function applyDelta(book, change) {
  const price = finite(change?.price);
  const size = finite(change?.size);
  const side = /buy|bid/i.test(change?.side || '') ? 'bids'
    : /sell|ask/i.test(change?.side || '') ? 'asks' : null;
  if (!book || price == null || size == null || !side) return false;
  const levels = book[side].filter(([levelPrice]) => levelPrice !== price);
  if (size > 0) levels.push([price, size]);
  levels.sort((left, right) => side === 'bids' ? right[0] - left[0] : left[0] - right[0]);
  book[side] = levels;
  return true;
}

function processWalEvent(event, provenance, wantedAssets, books, touches, windows) {
  if (!event || typeof event !== 'object') return;
  const type = event.event_type || event.type || 'unknown';
  const parentAsset = String(event.asset_id || '');
  const at = parseInt(provenance.receive_wall_timestamp_ms, 10);
  const epoch = parseInt(provenance.connection_epoch, 10) || 0;
  const shard = parseInt(provenance.connection_shard, 10) || 0;
  const record = (assetId) => {
    if (!wantedAssets.has(assetId)) return;
    const book = books.get(assetId);
    const window = windows.get(assetId);
    if (!book || !window || at < window.start || at > window.end) return;
    touches.get(assetId).push({
      at,
      bestBid: book.bids[0]?.[0] ?? null,
      bidSize: book.bids[0]?.[1] ?? null,
      bestAsk: book.asks[0]?.[0] ?? null,
      askSize: book.asks[0]?.[1] ?? null,
      epoch,
      shard,
    });
  };
  if (type === 'book' && wantedAssets.has(parentAsset)) {
    books.set(parentAsset, {
      bids: normLevels(event.bids || event.buys, true),
      asks: normLevels(event.asks || event.sells, false),
      epoch,
      shard,
    });
    record(parentAsset);
    return;
  }
  if (type !== 'price_change') return;
  const changes = Array.isArray(event.price_changes) ? event.price_changes
    : Array.isArray(event.changes) ? event.changes : [event];
  const touched = new Set();
  for (const change of changes) {
    const assetId = String(change.asset_id || parentAsset);
    if (!wantedAssets.has(assetId)) continue;
    const book = books.get(assetId);
    if (!book || book.epoch !== epoch || book.shard !== shard) continue;
    if (applyDelta(book, change)) touched.add(assetId);
  }
  for (const assetId of touched) record(assetId);
}

function nearestTouch(touches, timestamp) {
  let low = 0;
  let high = touches.length - 1;
  let selected = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (touches[middle].at <= timestamp) {
      selected = touches[middle];
      low = middle + 1;
    } else high = middle - 1;
  }
  return selected;
}

function simulateArrival(signal, touch, orderDelayMs) {
  const arrivalAt = new Date(signal.available_at).getTime() + orderDelayMs;
  const boundaryAt = new Date(signal.window_end).getTime();
  if (Number.isFinite(boundaryAt) && arrivalAt >= boundaryAt) {
    return { filled: false, ageMs: null, reason: 'arrival_at_or_after_resolution_boundary' };
  }
  const ageMs = touch ? arrivalAt - touch.at : Infinity;
  const ask = finite(touch?.bestAsk);
  const askSize = finite(touch?.askSize);
  if (!(ageMs >= 0 && ageMs <= MAX_STATE_AGE_MS) || !(ask > 0 && ask <= 0.99) || !(askSize > 0)) {
    return { filled: false, ageMs: Number.isFinite(ageMs) ? ageMs : null, reason: 'no_fresh_executable_ask' };
  }
  const shares = Math.min(TARGET_STAKE_USD / ask, askSize * MAX_TOUCH_PARTICIPATION);
  const notional = shares * ask;
  if (!(notional >= 1)) return { filled: false, ageMs, reason: 'below_minimum_notional' };
  const feeRate = finite(signal.fee_rate) || 0;
  const fee = shares * feeRate * ask * (1 - ask);
  const won = String(signal.target_outcome).toUpperCase() === String(signal.outcome).toUpperCase();
  const pnl1x = (won ? shares : 0) - notional - fee;
  return {
    filled: true,
    ageMs,
    ask,
    askSize,
    shares,
    notional,
    fee,
    won,
    pnl1x,
    pnl2x: pnl1x - fee,
  };
}

function summarize(results) {
  const fills = results.filter((row) => row.filled);
  return {
    signals: results.length,
    fills: fills.length,
    markets: new Set(fills.map((row) => row.condition_id)).size,
    wins: fills.filter((row) => row.won).length,
    averageAsk: fills.length ? fills.reduce((sum, row) => sum + row.ask, 0) / fills.length : null,
    turnover: fills.reduce((sum, row) => sum + row.notional, 0),
    pnl1x: fills.reduce((sum, row) => sum + row.pnl1x, 0),
    pnl2x: fills.reduce((sum, row) => sum + row.pnl2x, 0),
    averageStateAgeMs: fills.length ? fills.reduce((sum, row) => sum + row.ageMs, 0) / fills.length : null,
  };
}

function listWalFiles(dates) {
  return dates.flatMap((date) => {
    const directory = path.join(WAL_ROOT, date);
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory)
      .filter((name) => name.includes('.ndjson.gz'))
      .map((name) => path.join(directory, name));
  }).sort();
}

async function replayFile(file, handler) {
  const input = fs.createReadStream(file);
  const gunzip = zlib.createGunzip();
  const stream = input.pipe(gunzip);
  for await (const line of lfDelimitedLines(stream)) {
    if (!line || line.length < 2) continue;
    let envelope;
    try { envelope = JSON.parse(line); } catch (_error) { continue; }
    if (!envelope.raw) continue;
    let payload;
    try { payload = typeof envelope.raw === 'string' ? JSON.parse(envelope.raw) : envelope.raw; }
    catch (_error) { continue; }
    const events = Array.isArray(payload) ? payload : [payload];
    for (const event of events) handler(event, envelope);
  }
}

function poolConfig() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const local = /(?:localhost|127\.0\.0\.1|\/deltaforge)/i.test(connectionString);
  return { connectionString, ssl: local ? false : { rejectUnauthorized: false }, max: 2 };
}

async function main() {
  const pool = new Pool(poolConfig());
  try {
    const { rows: signals } = await pool.query(`
      WITH candidates AS (
        SELECT s.id,s.condition_id,s.available_at,s.target_asset_id,s.target_outcome,s.fee_rate,
               b.outcome,b.window_end,sc.entry_price,sc.fill_size,
               row_number() OVER (PARTITION BY s.condition_id ORDER BY s.available_at,s.id) rn
          FROM pm_flow_signals s
          JOIN pm_flow_scores sc ON sc.signal_id=s.id
          JOIN borg_markets b ON b.condition_id=s.condition_id
         WHERE s.features->>'strategy_version'='public-flow-cost-confirmed-v2'
           AND s.arm='absorption_reversal_v2' AND s.latency_ms=500
           AND sc.filled AND sc.data_quality_grade IN ('A','B') AND b.outcome IS NOT NULL
           AND extract(epoch FROM (b.window_end-s.available_at)) BETWEEN 0 AND 10
      ) SELECT * FROM candidates WHERE rn=1 ORDER BY available_at`);
    if (!signals.length) throw new Error('No late-boundary Flow discovery fills to replay');
    const wantedAssets = new Set(signals.map((row) => String(row.target_asset_id)));
    const windows = new Map();
    for (const signal of signals) {
      const asset = String(signal.target_asset_id);
      const at = new Date(signal.available_at).getTime();
      const prior = windows.get(asset) || { start: Infinity, end: -Infinity };
      prior.start = Math.min(prior.start, at - 5000);
      prior.end = Math.max(prior.end, at + Math.max(...ORDER_DELAYS_MS) + 2000);
      windows.set(asset, prior);
    }
    const touches = new Map([...wantedAssets].map((asset) => [asset, []]));
    const books = new Map();
    const dates = [...new Set(signals.map((row) => new Date(row.available_at).toISOString().slice(0, 10)))];
    const files = listWalFiles(dates);
    for (const file of files) {
      try {
        await replayFile(file, (event, envelope) =>
          processWalEvent(event, envelope, wantedAssets, books, touches, windows));
      } catch (error) {
        console.error(`[flow-wal-replay] skipped ${file}: ${error.message}`);
      }
    }
    for (const history of touches.values()) history.sort((left, right) => left.at - right.at);
    const delayResults = ORDER_DELAYS_MS.map((orderDelayMs) => {
      const results = signals.map((signal) => {
        const arrival = new Date(signal.available_at).getTime() + orderDelayMs;
        const touch = nearestTouch(touches.get(String(signal.target_asset_id)) || [], arrival);
        return { ...signal, orderDelayMs, ...simulateArrival(signal, touch, orderDelayMs) };
      });
      return { orderDelayMs, ...summarize(results), _results: results };
    });
    const zero = delayResults.find((row) => row.orderDelayMs === 0);
    const replayedZero = zero._results.filter((row) => row.filled);
    const priceMatches = replayedZero.filter((row) =>
      Math.abs(row.ask - finite(row.entry_price)) < 1e-9).length;
    const validatedIds = new Set(replayedZero.filter((row) =>
      Math.abs(row.ask - finite(row.entry_price)) < 1e-9).map((row) => String(row.id)));
    const validatedDelays = delayResults.map((delay) => ({
      orderDelayMs: delay.orderDelayMs,
      ...summarize(delay._results.filter((row) => validatedIds.has(String(row.id)))),
    }));
    const output = {
      format: 'flow-wal-order-latency-replay-v1',
      generatedAt: new Date().toISOString(),
      strategy: 'absorption_reversal_v2 @ 500ms information delay, TTE 0-10s, first fill per market',
      discoveryMarkets: signals.length,
      walFilesRead: files.length,
      replayValidation: {
        zeroDelayFillsRecovered: replayedZero.length,
        storedEntryPriceMatches: priceMatches,
        coverage: signals.length ? replayedZero.length / signals.length : 0,
        exactPriceMatchRate: replayedZero.length ? priceMatches / replayedZero.length : 0,
        valid: replayedZero.length / signals.length >= 0.9 && priceMatches / replayedZero.length >= 0.9,
      },
      warning: 'Discovery-only hold-to-resolution counterfactual. The TTE band was found after inspecting Flow results. WAL replay models information delay and extra order transit separately, but not exchange acknowledgement, partial matching ahead of the recorded touch, or rejected post-boundary orders.',
      delays: delayResults.map(({ _results, ...row }) => Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key, typeof value === 'number' ? round(value, 6) : value]),
      )),
      entryValidatedSubset: {
        warning: 'Sensitivity only, not a substitute for >=90% full-cohort replay coverage.',
        markets: validatedIds.size,
        delays: validatedDelays.map((row) => Object.fromEntries(
          Object.entries(row).map(([key, value]) => [key, typeof value === 'number' ? round(value, 6) : value]),
        )),
      },
    };
    if (process.argv.includes('--json')) console.log(JSON.stringify(output, null, 2));
    else {
      console.log(`FLOW WAL ORDER-LATENCY REPLAY — ${output.generatedAt}`);
      console.log(output.warning);
      console.log(output.replayValidation);
      console.table(output.delays);
      console.log(output.entryValidatedSubset.warning);
      console.table(output.entryValidatedSubset.delays);
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

module.exports = {
  applyDelta,
  nearestTouch,
  normLevels,
  processWalEvent,
  simulateArrival,
  summarize,
};
