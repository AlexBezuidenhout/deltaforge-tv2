#!/usr/bin/env node
/**
 * Repair binance_open / binance_close for direction_1h markets.
 *
 * Root cause (2026-07-18): the collector's _kline() floor-aligns startTime to
 * the interval, so 1h windows rolling at :15/:30/:45 received the calendar
 * 1h candle — wrong open AND wrong close (33-41% resolution-sign mismatch on
 * offset windows vs ~1% on :00 windows). Outcomes were never affected (they
 * come from Gamma resolution); only the Binance reference columns were wrong.
 *
 * This script refetches exact 1m candles: open = open of the 1m candle at
 * window_start, close = close of the 1m candle at window_end - 60s, and stamps
 * *_src = 'repair_1m_kline'. Idempotent; only touches direction_1h rows.
 */
'use strict';

const { Pool } = require('pg');

const SYMBOLS = { btc: 'BTCUSDT', eth: 'ETHUSDT', sol: 'SOLUSDT', xrp: 'XRPUSDT' };
const SLEEP_MS = 120; // ~8 req/s, well under Binance limits

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function kline1m(symbol, startMs) {
  const aligned = Math.floor(startMs / 60000) * 60000;
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=1&startTime=${aligned}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`klines ${symbol} ${response.status}`);
  const rows = await response.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const { rows } = await pool.query(`
    SELECT id, asset, window_start, window_end
    FROM borg_markets
    WHERE market_type IN ('direction_1h', 'direction_15m')
      AND (binance_open_src IS DISTINCT FROM 'repair_1m_kline'
        OR binance_close_src IS DISTINCT FROM 'repair_1m_kline')
    ORDER BY id`);
  console.log(`repairing ${rows.length} direction_1h/direction_15m rows`);
  let repaired = 0; let skipped = 0; let failed = 0;
  for (const row of rows) {
    const symbol = SYMBOLS[row.asset];
    if (!symbol) { skipped += 1; continue; }
    const endMs = new Date(row.window_end).getTime() - 60000;
    if (endMs > Date.now() - 60000) { skipped += 1; continue; } // window not finished
    try {
      const openCandle = await kline1m(symbol, new Date(row.window_start).getTime());
      await sleep(SLEEP_MS);
      const closeCandle = await kline1m(symbol, endMs);
      await sleep(SLEEP_MS);
      const open = openCandle ? parseFloat(openCandle[1]) : NaN;
      const close = closeCandle ? parseFloat(closeCandle[4]) : NaN;
      if (!Number.isFinite(open) || !Number.isFinite(close)) { failed += 1; continue; }
      await pool.query(
        `UPDATE borg_markets
         SET binance_open=$1, binance_open_src='repair_1m_kline',
             binance_close=$2, binance_close_src='repair_1m_kline'
         WHERE id=$3`,
        [open, close, row.id],
      );
      repaired += 1;
    } catch (error) {
      failed += 1;
      console.error(`id=${row.id} ${row.asset}: ${error.message}`);
      await sleep(1000);
    }
  }
  console.log(`repaired=${repaired} skipped=${skipped} failed=${failed}`);
  const check = await pool.query(`
    SELECT extract(minute from window_start)::int mins, count(*) n,
      count(*) FILTER (WHERE (binance_close>=binance_open) <> (outcome='UP')) mm
    FROM borg_markets
    WHERE market_type IN ('direction_1h','direction_15m') AND outcome IN ('UP','DOWN') AND binance_close IS NOT NULL
    GROUP BY 1 ORDER BY 1`);
  for (const row of check.rows) {
    console.log(`post-repair minute=${row.mins} n=${row.n} sign_mismatch=${row.mm}`);
  }
  await pool.end();
}

main().catch((error) => { console.error(error); process.exit(1); });
