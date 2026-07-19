#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const { clusteredBootstrap } = require('../borg/research/statistics');

const DERIBIT_URL = 'https://www.deribit.com/api/v2/public/get_volatility_index_data';
const HORIZONS_SECONDS = Object.freeze([3600, 1800, 900, 300]);
const TARGET_NOTIONAL_USD = 10;
const MAX_LEVEL_PARTICIPATION = 0.20;
const CRYPTO_FEE_RATE = 0.07;

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 4) {
  const parsed = finite(value);
  return parsed == null ? null : +parsed.toFixed(digits);
}

function normalCdf(value) {
  const x = finite(value);
  if (x == null) return null;
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const density = 0.3989422804014327 * Math.exp(-0.5 * x * x);
  const polynomial = t * (0.319381530 + t * (-0.356563782
    + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const cdf = 1 - density * polynomial;
  return x >= 0 ? cdf : 1 - cdf;
}

function thresholdFair(spot, strike, annualizedVolPct, secondsToResolution) {
  const s = finite(spot);
  const k = finite(strike);
  const sigma = (finite(annualizedVolPct) || 0) / 100;
  const seconds = finite(secondsToResolution);
  if (!(s > 0) || !(k > 0) || !(sigma > 0) || !(seconds > 0)) return null;
  const years = seconds / (365.25 * 86400);
  const denominator = sigma * Math.sqrt(years);
  if (!(denominator > 0)) return null;
  const d2 = (Math.log(s / k) - 0.5 * sigma * sigma * years) / denominator;
  return Math.max(0.000001, Math.min(0.999999, normalCdf(d2)));
}

function takerFee(shares, price, feeRate = CRYPTO_FEE_RATE) {
  const q = finite(shares);
  const p = finite(price);
  if (!(q > 0) || !(p > 0) || !(p < 1)) return 0;
  return q * feeRate * p * (1 - p);
}

function walkAsk(book, targetNotional = TARGET_NOTIONAL_USD) {
  if (!Array.isArray(book) || !(targetNotional > 0)) return null;
  let remaining = targetNotional;
  let shares = 0;
  let cost = 0;
  let fee = 0;
  for (const level of book) {
    const price = finite(level?.[0]);
    const displayed = finite(level?.[1]);
    if (!(price > 0) || !(price < 1) || !(displayed > 0)) continue;
    const capacity = displayed * MAX_LEVEL_PARTICIPATION;
    const take = Math.min(capacity, remaining / price);
    if (!(take > 0)) continue;
    shares += take;
    cost += take * price;
    fee += takerFee(take, price);
    remaining -= take * price;
    if (remaining <= 1e-9) break;
  }
  if (!(cost >= 1) || remaining > targetNotional * 0.05) return null;
  return { shares, cost, fee, averagePrice: cost / shares };
}

function nearestCausalDvol(candles, timestamp, maxAgeMs = 120000) {
  const target = new Date(timestamp).getTime();
  let low = 0;
  let high = candles.length - 1;
  let candidate = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].time <= target) {
      candidate = candles[middle];
      low = middle + 1;
    } else high = middle - 1;
  }
  return candidate && target - candidate.time <= maxAgeMs ? candidate.close : null;
}

function evaluateObservation(row, dvol) {
  const fairYes = thresholdFair(row.spot, row.strike, dvol, row.tte_sec);
  if (fairYes == null) return null;
  const candidates = [
    { side: 'YES', fair: fairYes, fill: walkAsk(row.up_asks) },
    { side: 'NO', fair: 1 - fairYes, fill: walkAsk(row.down_asks) },
  ].filter((candidate) => candidate.fill);
  for (const candidate of candidates) {
    const fill = candidate.fill;
    candidate.expectedPnl = candidate.fair * fill.shares - fill.cost - fill.fee;
    candidate.expectedReturn = candidate.expectedPnl / fill.cost;
  }
  const selected = candidates.sort((left, right) => right.expectedReturn - left.expectedReturn)[0];
  if (!selected || !(selected.expectedPnl > 0)) return null;
  const won = String(row.outcome).toUpperCase() === selected.side;
  const pnl1x = (won ? selected.fill.shares : 0) - selected.fill.cost - selected.fill.fee;
  const pnl2x = pnl1x - selected.fill.fee;
  return {
    marketId: String(row.market_id),
    eventKey: String(row.event_key),
    asset: row.asset,
    horizonSeconds: parseInt(row.horizon_seconds, 10),
    timestamp: row.ts,
    side: selected.side,
    won,
    fair: selected.fair,
    dvol,
    entryPrice: selected.fill.averagePrice,
    notional: selected.fill.cost,
    expectedPnl: selected.expectedPnl,
    expectedReturn: selected.expectedReturn,
    pnl1x,
    pnl2x,
  };
}

function selectOnePerEvent(rows) {
  const selected = new Map();
  for (const row of rows) {
    const key = `${row.eventKey}:${row.horizonSeconds}`;
    const prior = selected.get(key);
    if (!prior || row.expectedReturn > prior.expectedReturn) selected.set(key, row);
  }
  return [...selected.values()].sort((left, right) => new Date(left.timestamp) - new Date(right.timestamp));
}

function summarize(rows) {
  const pnl1x = rows.reduce((sum, row) => sum + row.pnl1x, 0);
  const pnl2x = rows.reduce((sum, row) => sum + row.pnl2x, 0);
  const turnover = rows.reduce((sum, row) => sum + row.notional, 0);
  const split = Math.floor(rows.length / 2);
  const halves = [rows.slice(0, split), rows.slice(split)].map((half) => ({
    n: half.length,
    pnl1x: half.reduce((sum, row) => sum + row.pnl1x, 0),
    pnl2x: half.reduce((sum, row) => sum + row.pnl2x, 0),
  }));
  const eventClustered = clusteredBootstrap(rows, 'eventKey', 'pnl2x');
  return {
    trades: rows.length,
    independentEvents: new Set(rows.map((row) => row.eventKey)).size,
    wins: rows.filter((row) => row.won).length,
    turnover,
    pnl1x,
    pnl2x,
    returnOnTurnover1x: turnover ? pnl1x / turnover : null,
    returnOnTurnover2x: turnover ? pnl2x / turnover : null,
    halves,
    eventClusteredCi95Pnl2x: eventClustered.ci,
  };
}

async function fetchDvol(currency, startMs, endMs) {
  const url = new URL(DERIBIT_URL);
  url.searchParams.set('currency', currency);
  url.searchParams.set('start_timestamp', String(startMs));
  url.searchParams.set('end_timestamp', String(endMs));
  url.searchParams.set('resolution', '60');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Deribit ${currency} DVOL HTTP ${response.status}`);
  const body = await response.json();
  const data = body?.result?.data;
  if (!Array.isArray(data)) throw new Error(`Deribit ${currency} DVOL malformed response`);
  return data.map((row) => ({ time: parseInt(row[0], 10), close: finite(row[4]) }))
    .filter((row) => Number.isFinite(row.time) && row.close != null)
    .sort((left, right) => left.time - right.time);
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
    const { rows } = await pool.query(`
      WITH horizons(horizon_seconds) AS (VALUES (3600),(1800),(900),(300))
      SELECT m.id market_id,COALESCE(m.event_id,m.asset||':'||m.window_end::text) event_key,
             m.asset,m.strike,m.outcome,h.horizon_seconds,b.ts,b.tte_sec,b.btc_price spot,
             b.up_asks,b.down_asks
        FROM borg_markets m CROSS JOIN horizons h
        JOIN LATERAL (
          SELECT * FROM borg_book_snaps candidate
           WHERE candidate.market_id=m.id
             AND candidate.tte_sec BETWEEN h.horizon_seconds-10 AND h.horizon_seconds+10
           ORDER BY abs(candidate.tte_sec-h.horizon_seconds),candidate.ts LIMIT 1
        ) b ON true
       WHERE m.market_type='threshold_daily' AND m.asset IN ('btc','eth')
         AND m.outcome IN ('YES','NO') AND m.strike IS NOT NULL
       ORDER BY b.ts,m.id,h.horizon_seconds`);
    if (!rows.length) throw new Error('No resolved BTC/ETH threshold observations at registered horizons');
    const startMs = new Date(rows[0].ts).getTime() - 120000;
    const endMs = new Date(rows[rows.length - 1].ts).getTime() + 60000;
    const dvolByAsset = {
      btc: await fetchDvol('BTC', startMs, endMs),
      eth: await fetchDvol('ETH', startMs, endMs),
    };
    const evaluated = rows.map((row) => evaluateObservation(
      row, nearestCausalDvol(dvolByAsset[row.asset] || [], row.ts),
    )).filter(Boolean);
    const selected = selectOnePerEvent(evaluated);
    const byHorizon = HORIZONS_SECONDS.map((horizon) => ({
      horizonSeconds: horizon,
      ...summarize(selected.filter((row) => row.horizonSeconds === horizon)),
    }));
    const output = {
      format: 'dvol-threshold-backtest-v1',
      generatedAt: new Date().toISOString(),
      source: DERIBIT_URL,
      design: 'Causal 1-minute BTC/ETH DVOL close; lognormal digital probability; best positive expected-return strike/side per expiry and fixed horizon; $10 book walk capped at 20% of each displayed level; hold to resolution.',
      disclosure: 'Discovery-only. DVOL is a 30-day implied-volatility index, not a strike/expiry surface; hourly threshold markets within one expiry are clustered; no threshold was selected from PnL. A full Deribit option surface and >=300 fresh expiry events are required before promotion.',
      rawObservations: rows.length,
      economicallyPositiveCandidates: evaluated.length,
      selectedTrades: selected.length,
      overall: summarize(selected),
      byHorizon,
    };
    const clean = JSON.parse(JSON.stringify(output, (_key, value) =>
      typeof value === 'number' ? round(value, 6) : value));
    if (process.argv.includes('--json')) console.log(JSON.stringify(clean, null, 2));
    else {
      console.log(`DVOL THRESHOLD DISCOVERY — ${clean.generatedAt}`);
      console.log(clean.disclosure);
      console.table(clean.byHorizon.map((row) => ({
        horizon_sec: row.horizonSeconds,
        trades: row.trades,
        events: row.independentEvents,
        wins: row.wins,
        turnover: round(row.turnover, 2),
        pnl_1x: round(row.pnl1x, 2),
        pnl_2x: round(row.pnl2x, 2),
        first_half_2x: round(row.halves[0].pnl2x, 2),
        second_half_2x: round(row.halves[1].pnl2x, 2),
        ci_low_2x: round(row.eventClusteredCi95Pnl2x[0], 4),
      })));
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
  evaluateObservation,
  nearestCausalDvol,
  normalCdf,
  selectOnePerEvent,
  summarize,
  thresholdFair,
  walkAsk,
};
