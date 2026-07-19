#!/usr/bin/env node
/**
 * Developmental replay for H9-H13 over the durable collector archive plus
 * the current Postgres rolling window.
 *
 * This is deliberately NOT an evaluation result: the hypotheses were formed
 * while looking at the same collector family, thresholds are provisional,
 * and H12 has no historical Coinbase control before this deployment. The
 * script exists to catch impossible mechanics, starvation, fee mistakes and
 * quote-survival failures before a fresh forward pilot is frozen.
 *
 * Run: node scripts/research-v2-backtest.js
 */
'use strict';

process.removeAllListeners('warning');
require('dotenv').config();
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const zlib = require('node:zlib');
const { Pool } = require('pg');
const makeStrategies = require('../borg/shadow/strategies');

const {
  CrossVenueConsensus,
  DualBookMicroprice,
  LiquidityVacuumContinuation,
  IdiosyncraticImpulse,
  ThetaLagConvergence,
} = makeStrategies._test;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const ARCHIVE_DIR = process.env.BORG_ARCHIVE_DIR ||
  path.join(os.homedir(), '.deltaforge-archive', 'borg-raw', 'borg_book_snaps');
const TAKER_RATE = 0.07;

function listGzipFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listGzipFiles(full));
    else if (entry.name.endsWith('.ndjson.gz')) out.push(full);
  }
  return out.sort();
}

function asNum(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function normalize(row) {
  return {
    id: String(row.id),
    ts: new Date(row.ts).getTime(),
    marketId: parseInt(row.market_id, 10),
    tteSec: asNum(row.tte_sec),
    upBids: Array.isArray(row.up_bids) ? row.up_bids : [],
    upAsks: Array.isArray(row.up_asks) ? row.up_asks : [],
    downBids: Array.isArray(row.down_bids) ? row.down_bids : [],
    downAsks: Array.isArray(row.down_asks) ? row.down_asks : [],
    upMid: asNum(row.up_mid),
    gammaUp: asNum(row.gamma_up),
    price: asNum(row.btc_price),
    ref: asNum(row.btc_ref),
    sigma: asNum(row.sigma5m_ewma),
    phi: asNum(row.phi_fair),
    bookSrc: row.book_src,
  };
}

async function loadArchive(markets, seen) {
  const rows = [];
  for (const file of listGzipFiles(ARCHIVE_DIR)) {
    const input = fs.createReadStream(file).pipe(zlib.createGunzip());
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let first = true;
    for await (const line of lines) {
      if (first) { first = false; continue; }
      if (!line) continue;
      const raw = JSON.parse(line);
      const marketId = parseInt(raw.market_id, 10);
      if (seen.has(String(raw.id)) || !markets.has(marketId)) continue;
      seen.add(String(raw.id));
      rows.push(normalize(raw));
    }
  }
  return rows;
}

async function loadCurrent(markets, seen) {
  const { rows } = await pool.query(`
    SELECT id, ts, market_id, tte_sec, up_bids, up_asks, down_bids, down_asks,
           up_mid, gamma_up, btc_price, btc_ref, sigma5m_ewma, phi_fair, book_src
    FROM borg_book_snaps ORDER BY ts`);
  return rows.filter((row) => markets.has(parseInt(row.market_id, 10)) && !seen.has(String(row.id)))
    .map((row) => { seen.add(String(row.id)); return normalize(row); });
}

function micro(history, now, seconds) {
  const target = now - seconds * 1000;
  let old = null;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].at <= target) { old = history[i]; break; }
  }
  const latest = history[history.length - 1];
  if (!old || !latest || latest.at - old.at < seconds * 800 || !(old.price > 0) || !(latest.price > 0)) return null;
  return { returnBps: 10000 * Math.log(latest.price / old.price) };
}

function lowerBound(rows, ts) {
  let lo = 0; let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (rows[mid].ts < ts) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function latencyFill(order, rowsByMarket) {
  const rows = rowsByMarket.get(order.marketId) || [];
  const earliest = order.ts + 1250;
  const i = lowerBound(rows, earliest);
  const snap = rows[i];
  if (!snap || snap.ts > earliest + 2000 || /stale/i.test(snap.bookSrc || '')) return null;
  const asks = order.token === 'UP' ? snap.upAsks : snap.downAsks;
  let shares = 0; let cost = 0;
  for (const level of asks || []) {
    const price = asNum(level[0]);
    const size = asNum(level[1]);
    if (!(price > 0) || !(size > 0)) continue;
    if (price > order.price + 1e-9) break;
    const take = Math.min(size, order.size - shares);
    shares += take;
    cost += take * price;
    if (shares >= order.size - 1e-9) break;
  }
  return shares > 0 ? { shares, price: cost / shares, ts: snap.ts } : null;
}

let rng = 0x9e3779b9;
function random() {
  rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
  return rng / 0x100000000;
}

function bootstrapMean(values, alpha = 0.05, iterations = 10000) {
  if (values.length < 2) return [null, null];
  const means = new Array(iterations);
  for (let b = 0; b < iterations; b++) {
    let total = 0;
    for (let i = 0; i < values.length; i++) total += values[(random() * values.length) | 0];
    means[b] = total / values.length;
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(iterations * alpha / 2)], means[Math.floor(iterations * (1 - alpha / 2))]];
}

function summary(orders) {
  const fills = orders.filter((row) => row.fill);
  const values = fills.map((row) => row.pnl1);
  const [lo, hi] = bootstrapMean(values);
  const [adjLo, adjHi] = bootstrapMean(values, 0.05 / 5);
  let equity = 0; let peak = 0; let maxDrawdown = 0;
  for (const pnl of values) {
    equity += pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity - peak);
  }
  const half = Math.floor(values.length / 2);
  const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  return {
    orders: orders.length,
    fills: fills.length,
    fillRatePct: orders.length ? +(100 * fills.length / orders.length).toFixed(1) : null,
    wins: fills.filter((row) => row.win).length,
    winRatePct: fills.length ? +(100 * fills.filter((row) => row.win).length / fills.length).toFixed(1) : null,
    pnl1x: +sum(values).toFixed(2),
    pnl2x: +sum(fills.map((row) => row.pnl2)).toFixed(2),
    mean1x: fills.length ? +(sum(values) / fills.length).toFixed(3) : null,
    ci95: lo == null ? null : [+lo.toFixed(3), +hi.toFixed(3)],
    ci99Bonferroni5: adjLo == null ? null : [+adjLo.toFixed(3), +adjHi.toFixed(3)],
    firstHalfPnl: +sum(values.slice(0, half)).toFixed(2),
    secondHalfPnl: +sum(values.slice(half)).toFixed(2),
    maxDrawdown: +maxDrawdown.toFixed(2),
  };
}

async function main() {
  const { rows: marketRows } = await pool.query(`
    SELECT id, asset, outcome FROM borg_markets
    WHERE outcome IN ('UP','DOWN') AND asset IS NOT NULL`);
  const markets = new Map(marketRows.map((row) => [parseInt(row.id, 10), {
    id: parseInt(row.id, 10), asset: row.asset, outcome: row.outcome,
  }]));
  const seen = new Set();
  const archive = await loadArchive(markets, seen);
  const current = await loadCurrent(markets, seen);
  const rows = [...archive, ...current]
    .filter((row) => Number.isFinite(row.ts) && row.tteSec > 0 && row.tteSec <= 300)
    .sort((a, b) => a.ts - b.ts || a.marketId - b.marketId);
  const rowsByMarket = new Map();
  for (const row of rows) {
    if (!rowsByMarket.has(row.marketId)) rowsByMarket.set(row.marketId, []);
    rowsByMarket.get(row.marketId).push(row);
  }

  const strategies = [
    new DualBookMicroprice(), new ThetaLagConvergence(),
    new LiquidityVacuumContinuation(), new CrossVenueConsensus(),
    new IdiosyncraticImpulse(),
  ];
  const intended = [];
  const histories = new Map();
  const engine = { seq: 0, _coid(name) { this.seq += 1; return `replay-${name}-${this.seq}`; } };

  for (const row of rows) {
    const market = markets.get(row.marketId);
    if (!market || /stale/i.test(row.bookSrc || '') || !(row.price > 0)) continue;
    const history = histories.get(market.asset) || [];
    history.push({ at: row.ts, price: row.price });
    while (history.length && history[0].at < row.ts - 40000) history.shift();
    histories.set(market.asset, history);
    const ctx = {
      now: row.ts, market, tteSec: row.tteSec,
      upBook: { bids: row.upBids, asks: row.upAsks, at: row.ts, src: row.bookSrc },
      downBook: { bids: row.downBids, asks: row.downAsks, at: row.ts, src: row.bookSrc },
      upMid: row.upMid, phiFair: row.phi, sigma: row.sigma,
      btc: row.price, ref: row.ref, gammaUp: row.gammaUp,
      micro10: micro(history, row.ts, 10), micro30: micro(history, row.ts, 30),
      // Coinbase collection begins with this deployment. H12 must starve in
      // historical replay rather than silently substituting Binance twice.
      venuePrice: null, venue10: null, venueStale: true,
    };
    for (const strategy of strategies) {
      for (const action of strategy.evaluate(ctx, engine) || []) {
        if (action.action !== 'place') continue;
        intended.push({
          strategy: strategy.name, ts: row.ts, marketId: row.marketId,
          asset: market.asset, outcome: market.outcome,
          token: action.token, price: action.price, size: action.size,
          note: action.note,
        });
      }
    }
  }

  for (const order of intended) {
    order.fill = latencyFill(order, rowsByMarket);
    if (!order.fill) continue;
    order.win = order.outcome === order.token;
    const payout = order.win ? 1 : 0;
    const gross = order.fill.shares * (payout - order.fill.price);
    const fee = order.fill.shares * TAKER_RATE * order.fill.price * (1 - order.fill.price);
    order.pnl1 = gross - fee;
    order.pnl2 = gross - 2 * fee;
  }

  console.log(`H9-H13 DEVELOPMENTAL REPLAY — ${new Date().toISOString()}`);
  console.log({
    archiveRows: archive.length,
    rollingRows: current.length,
    uniqueRows: rows.length,
    resolvedMarkets: new Set(rows.map((row) => row.marketId)).size,
    firstTs: rows.length ? new Date(rows[0].ts).toISOString() : null,
    lastTs: rows.length ? new Date(rows[rows.length - 1].ts).toISOString() : null,
    fillModel: '1.25s latency then recorded surviving depth at/below original ask',
    feeModel: 'shares × 0.07 × p × (1-p), plus 2x stress',
  });
  console.log('\nOverall (development only; not forward evidence):');
  for (const strategy of strategies) {
    const cohort = intended.filter((row) => row.strategy === strategy.name);
    console.log(strategy.name, summary(cohort));
    const assets = [...new Set(cohort.map((row) => row.asset))].sort();
    if (assets.length) {
      console.table(assets.map((asset) => ({ asset, ...summary(cohort.filter((row) => row.asset === asset)) })));
    }
  }
  console.log('\nGuardrails:');
  console.log('- H12 has n=0 historically by design: no Coinbase series existed before this deployment.');
  console.log('- These rows helped inspect the hypotheses, so their P&L is in-sample developmental evidence only.');
  console.log('- Pilot fills validate machinery. A later freeze starts each strategy at 0/500 and requires 14 days plus a five-test-adjusted positive interval.');
  await pool.end();
}

main().catch(async (err) => {
  console.error(err.stack || err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
