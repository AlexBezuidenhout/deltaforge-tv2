#!/usr/bin/env node
'use strict';

/**
 * Read-only, top-of-book latency sensitivity replay for BORG taker signals.
 *
 * The replay uses every retained Polymarket CLOB `book` touch change (local
 * receipt timestamp, best ask, and displayed best-ask size).  It asks whether
 * the original marketable limit would still execute immediately after a range
 * of downstream delays.  It deliberately does not score maker orders: the
 * compact event archive cannot reconstruct queue priority between 1s full-book
 * snapshots.
 *
 * This measures signal->submission latency only.  It cannot infer signals that
 * an event-driven strategy might have generated between the collector's 1s
 * evaluation ticks because raw sub-second CEX features were not persisted.
 */

process.removeAllListeners('warning');
require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const readline = require('node:readline');
const { Pool } = require('pg');

const LATENCIES_MS = [0, 2, 10, 25, 50, 100, 250, 500, 750, 1000, 1250, 1500, 2000, 3000];
const BASELINE_MS = 1250;
const CRYPTO_TAKER_RATE = 0.07;
const ARCHIVE_ROOT = process.env.BORG_ARCHIVE_DIR
  || path.join(os.homedir(), '.deltaforge-archive', 'borg-raw');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function round(value, digits = 3) {
  return Number.isFinite(value) ? +value.toFixed(digits) : null;
}

function percentile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
}

function fee(shares, price) {
  return shares * CRYPTO_TAKER_RATE * price * (1 - price);
}

function archiveStartMs(file) {
  const match = path.basename(file).match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/
  );
  if (!match) return null;
  return Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
}

function listArchiveFiles() {
  const root = path.join(ARCHIVE_ROOT, 'borg_clob_events');
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const day of fs.readdirSync(root).sort()) {
    const dayPath = path.join(root, day);
    if (!fs.statSync(dayPath).isDirectory()) continue;
    for (const name of fs.readdirSync(dayPath).sort()) {
      if (name.endsWith('.ndjson.gz')) files.push(path.join(dayPath, name));
    }
  }
  return files;
}

function addTouch(byToken, row, wantedTokens, sourceAgeMs) {
  if (row.event_type !== 'book' || !wantedTokens.has(String(row.asset_id))) return false;
  const raw = typeof row.raw === 'string' ? JSON.parse(row.raw) : row.raw;
  const ba = parseFloat(raw?.ba);
  const bas = parseFloat(raw?.bas);
  const bb = parseFloat(raw?.bb);
  const bbs = parseFloat(raw?.bbs);
  const at = new Date(row.ts).getTime();
  if (!Number.isFinite(at) || !Number.isFinite(ba) || !Number.isFinite(bas)) return false;
  const token = String(row.asset_id);
  if (!byToken.has(token)) byToken.set(token, []);
  byToken.get(token).push({ at, ba, bas, bb, bbs });
  const exchangeAt = parseFloat(raw?.ts);
  if (Number.isFinite(exchangeAt)) sourceAgeMs.push(at - exchangeAt);
  return true;
}

async function loadArchiveTouches(files, byToken, wantedTokens, sourceAgeMs) {
  let rows = 0;
  let touches = 0;
  for (let i = 0; i < files.length; i += 1) {
    const input = fs.createReadStream(files[i]).pipe(zlib.createGunzip());
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line || line.startsWith('{"_borg_archive"')) continue;
      rows += 1;
      let row;
      try { row = JSON.parse(line); } catch (_) { continue; }
      if (addTouch(byToken, row, wantedTokens, sourceAgeMs)) touches += 1;
    }
    if ((i + 1) % 50 === 0) {
      process.stderr.write(`archive ${i + 1}/${files.length}: ${touches} relevant touches\n`);
    }
  }
  return { rows, touches };
}

function atOrBefore(events, targetMs) {
  let lo = 0;
  let hi = events.length - 1;
  let answer = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].at <= targetMs) {
      answer = events[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return answer;
}

function replay(order, events, latencyMs) {
  const quote = atOrBefore(events, order.at + latencyMs);
  if (!quote) return { covered: false, net: 0, filledShares: 0 };
  const marketable = quote.ba <= order.limitPrice + 1e-9;
  if (!marketable || !(quote.bas > 0)) {
    return { covered: true, net: 0, filledShares: 0, quote };
  }
  const filledShares = Math.min(order.shares, quote.bas);
  const won = order.outcome === order.token;
  const net = filledShares * ((won ? 1 : 0) - quote.ba) - fee(filledShares, quote.ba);
  return { covered: true, net, filledShares, quote };
}

function uniqueMarketToken(orders) {
  const seen = new Set();
  return orders.filter((order) => {
    const key = `${order.strategy}|${order.marketId}|${order.token}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function ciForPairedDelta(orders, byToken, latencyMs) {
  const byMarket = new Map();
  for (const order of orders) {
    const events = byToken.get(order.tokenId) || [];
    const candidate = replay(order, events, latencyMs);
    const baseline = replay(order, events, BASELINE_MS);
    if (!candidate.covered || !baseline.covered) continue;
    const key = `${order.strategy}|${order.marketId}`;
    byMarket.set(key, (byMarket.get(key) || 0) + candidate.net - baseline.net);
  }
  const values = [...byMarket.values()];
  const total = values.reduce((sum, value) => sum + value, 0);
  if (values.length < 2) return { delta: total, markets: values.length, ciLow: null, ciHigh: null };
  const mean = total / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const seTotal = Math.sqrt(variance * values.length);
  return {
    delta: total,
    markets: values.length,
    ciLow: total - 1.96 * seTotal,
    ciHigh: total + 1.96 * seTotal,
  };
}

function summarize(orders, byToken, latencyMs) {
  let covered = 0;
  let fills = 0;
  let fullFills = 0;
  let filledShares = 0;
  let pnl = 0;
  let notional = 0;
  let winners = 0;
  const quoteAges = [];
  for (const order of orders) {
    const result = replay(order, byToken.get(order.tokenId) || [], latencyMs);
    if (!result.covered) continue;
    covered += 1;
    quoteAges.push(order.at + latencyMs - result.quote.at);
    if (!(result.filledShares > 0)) continue;
    fills += 1;
    if (result.filledShares + 1e-9 >= order.shares) fullFills += 1;
    filledShares += result.filledShares;
    notional += result.filledShares * result.quote.ba;
    pnl += result.net;
    if (order.outcome === order.token) winners += 1;
  }
  const paired = ciForPairedDelta(orders, byToken, latencyMs);
  return {
    latency_ms: latencyMs,
    signals: orders.length,
    covered,
    coverage_pct: round(100 * covered / Math.max(1, orders.length), 1),
    immediate_fills: fills,
    full_fills: fullFills,
    fill_rate_pct: round(100 * fills / Math.max(1, covered), 1),
    win_rate_filled_pct: round(100 * winners / Math.max(1, fills), 1),
    filled_shares: round(filledShares, 2),
    notional_usd: round(notional, 2),
    pnl_usd: round(pnl, 2),
    pnl_per_signal_usd: round(pnl / Math.max(1, covered), 4),
    quote_age_p50_ms: round(percentile(quoteAges, 0.5), 1),
    delta_vs_1250ms_usd: round(paired.delta, 2),
    paired_market_n: paired.markets,
    delta_ci95_low_usd: round(paired.ciLow, 2),
    delta_ci95_high_usd: round(paired.ciHigh, 2),
  };
}

function askStateDurations(byToken) {
  const durations = [];
  for (const events of byToken.values()) {
    if (events.length < 2) continue;
    let runStart = events[0].at;
    let key = `${events[0].ba}|${events[0].bas}`;
    for (let i = 1; i < events.length; i += 1) {
      const nextKey = `${events[i].ba}|${events[i].bas}`;
      if (nextKey === key) continue;
      const duration = events[i].at - runStart;
      if (duration >= 0 && duration < 60000) durations.push(duration);
      runStart = events[i].at;
      key = nextKey;
    }
  }
  return durations;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const files = listArchiveFiles();
  if (!files.length) throw new Error(`no CLOB event archives under ${ARCHIVE_ROOT}`);
  const firstArchiveMs = archiveStartMs(files[0]);
  if (!Number.isFinite(firstArchiveMs)) throw new Error(`cannot parse archive start: ${files[0]}`);

  // Leave ten seconds for an initial touch before the first eligible signal.
  const coverageStart = new Date(firstArchiveMs + 10000);
  const { rows } = await pool.query(`
    SELECT o.id, o.ts, o.strategy, o.phase, o.market_id, o.token,
      o.price::float AS limit_price, o.size::float AS shares,
      m.asset, upper(m.outcome) AS outcome,
      CASE WHEN upper(o.token)='UP' THEN m.up_token_id ELSE m.down_token_id END AS token_id
    FROM borg_shadow_orders o
    JOIN borg_markets m ON m.id=o.market_id
    WHERE o.action='place' AND o.order_kind='taker'
      AND o.ts >= $1 AND m.outcome IS NOT NULL
      AND o.price IS NOT NULL AND o.size IS NOT NULL
    ORDER BY o.ts, o.id
  `, [coverageStart]);

  const orders = rows.map((row) => ({
    id: String(row.id),
    at: new Date(row.ts).getTime(),
    strategy: row.strategy,
    phase: row.phase,
    marketId: Number(row.market_id),
    asset: row.asset,
    token: String(row.token).toUpperCase(),
    outcome: String(row.outcome).toUpperCase(),
    tokenId: String(row.token_id),
    limitPrice: parseFloat(row.limit_price),
    shares: parseFloat(row.shares),
  })).filter((row) => Number.isFinite(row.limitPrice) && Number.isFinite(row.shares));
  if (!orders.length) throw new Error('no resolved taker signals in retained event coverage');

  const wantedTokens = new Set(orders.map((order) => order.tokenId));
  const byToken = new Map();
  const sourceAgeMs = [];
  const archiveStats = await loadArchiveTouches(files, byToken, wantedTokens, sourceAgeMs);

  const { rows: liveEvents } = await pool.query(`
    SELECT ts, asset_id, event_type, raw
    FROM borg_clob_events
    WHERE event_type='book' AND asset_id = ANY($1::text[])
      AND ts >= $2
    ORDER BY ts, id
  `, [[...wantedTokens], coverageStart]);
  let liveTouches = 0;
  for (const row of liveEvents) {
    if (addTouch(byToken, row, wantedTokens, sourceAgeMs)) liveTouches += 1;
  }
  for (const events of byToken.values()) events.sort((a, b) => a.at - b.at);

  const deduped = uniqueMarketToken(orders);
  const strategyNames = [...new Set(deduped.map((order) => order.strategy))].sort();
  const perStrategy = {};
  for (const strategy of strategyNames) {
    const subset = deduped.filter((order) => order.strategy === strategy);
    perStrategy[strategy] = LATENCIES_MS.map((latency) => summarize(subset, byToken, latency));
  }

  const durations = askStateDurations(byToken);
  const output = {
    generated_at: new Date().toISOString(),
    method: {
      scope: 'resolved taker shadow signals with retained event-tape coverage',
      execution: 'immediate marketable-limit fill at best ask; partial fill capped to displayed top-ask size; official crypto taker fee curve rate 0.07',
      deduplication: 'first signal per strategy × market × token; repeated 1s emissions removed',
      baseline_ms: BASELINE_MS,
      excludes: ['maker queue replay', 'signals that might arise between 1s CEX feature ticks', 'rested-then-filled GTC orders'],
    },
    coverage: {
      archive_files: files.length,
      archive_rows_scanned: archiveStats.rows,
      archive_relevant_touches: archiveStats.touches,
      rolling_db_relevant_touches: liveTouches,
      tokens: wantedTokens.size,
      raw_taker_signals: orders.length,
      unique_market_token_signals: deduped.length,
      first_signal_at: new Date(orders[0].at).toISOString(),
      last_signal_at: new Date(orders[orders.length - 1].at).toISOString(),
    },
    measured_feed_receipt_age_ms: {
      note: 'local CLOB event receipt ts minus exchange event timestamp; includes clock skew',
      n: sourceAgeMs.length,
      p50: round(percentile(sourceAgeMs, 0.5), 1),
      p90: round(percentile(sourceAgeMs, 0.9), 1),
      p99: round(percentile(sourceAgeMs, 0.99), 1),
    },
    displayed_best_ask_state_duration_ms: {
      n: durations.length,
      p10: round(percentile(durations, 0.1), 1),
      p50: round(percentile(durations, 0.5), 1),
      p90: round(percentile(durations, 0.9), 1),
      share_under_100ms_pct: round(100 * durations.filter((x) => x < 100).length / Math.max(1, durations.length), 1),
      share_under_500ms_pct: round(100 * durations.filter((x) => x < 500).length / Math.max(1, durations.length), 1),
      caveat: 'event-state duration, not order-specific quote survival and not queue lifetime',
    },
    all_strategies_unique_market_token: LATENCIES_MS.map((latency) => summarize(deduped, byToken, latency)),
    per_strategy_unique_market_token: perStrategy,
  };
  console.log(JSON.stringify(output, null, 2));
}

main()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

