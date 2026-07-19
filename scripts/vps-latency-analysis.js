#!/usr/bin/env node
'use strict';

/**
 * Read-only latency/fill analysis for the only TV2 strategy with real CLOB
 * orders (G_late_arb). It does not place, cancel, or modify orders.
 *
 * The 2 ms counterfactual is intentionally bounded: retained data cannot say
 * which resting orders would have filled with sub-second arrival, so the
 * script prints zero-improvement and impossible-best-case endpoints rather
 * than inventing a point estimate.
 */

process.removeAllListeners('warning');
require('dotenv').config();
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Wallet } = require('ethers');
const { Pool } = require('pg');

const CURRENT_CLOB_P50_MS = 131.1;
const HYPOTHETICAL_VPS_CLOB_MS = 2;
const CRYPTO_TAKER_RATE = 0.07;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function round(value, digits = 2) {
  return Number.isFinite(value) ? +value.toFixed(digits) : null;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function fee(shares, price) {
  return shares * CRYPTO_TAKER_RATE * price * (1 - price);
}

function summary(rows) {
  const delays = rows.map((row) => row.delay_ms).filter(Number.isFinite).sort((a, b) => a - b);
  const filled = rows.filter((row) => row.filled);
  const net = filled.reduce((sum, row) => sum + row.net, 0);
  return {
    orders: rows.length,
    filled: filled.length,
    fill_rate_pct: rows.length ? round(100 * filled.length / rows.length, 1) : null,
    p50_signal_to_claim_ms: round(percentile(delays, 0.5), 1),
    p90_signal_to_claim_ms: round(percentile(delays, 0.9), 1),
    actual_net_usd: round(net, 2),
    actual_mean_per_fill_usd: filled.length ? round(net / filled.length, 3) : null,
  };
}

async function readClient(account) {
  const mod = await import('@polymarket/clob-client-v2');
  const signer = new Wallet(account.privateKey);
  if (!signer._signTypedData) {
    signer._signTypedData = (domain, types, value) => signer.signTypedData(domain, types, value);
  }
  const signatureType = mod.SignatureTypeV2[account.signatureType] ?? mod.SignatureTypeV2.POLY_1271;
  const l1 = new mod.ClobClient({
    host: 'https://clob.polymarket.com', chain: mod.Chain.POLYGON, signer,
    signatureType, funderAddress: account.funderAddress, throwOnError: true,
  });
  const creds = await l1.deriveApiKey();
  return new mod.ClobClient({
    host: 'https://clob.polymarket.com', chain: mod.Chain.POLYGON, signer, creds,
    signatureType, funderAddress: account.funderAddress, throwOnError: true,
  });
}

async function main() {
  const accountPath = path.join(os.homedir(), '.deltaforge-live', 'active-account.json');
  if (!fs.existsSync(accountPath)) throw new Error(`missing ${accountPath}`);
  const account = JSON.parse(fs.readFileSync(accountPath, 'utf8'));

  const { rows: orders } = await pool.query(`
    SELECT g.clob_order_id, g.price::float limit_price, g.size::float order_shares,
      g.ts claim_ts, o.ts signal_ts, o.phase, m.asset, m.outcome, o.token,
      extract(epoch FROM (g.ts-o.ts))*1000 AS delay_ms
    FROM gla_live_orders g
    JOIN borg_shadow_orders o ON o.id=g.shadow_order_id
    JOIN borg_markets m ON m.id=o.market_id
    WHERE NOT g.dry_run AND g.status='PLACED' AND g.clob_order_id IS NOT NULL
    ORDER BY o.ts
  `);
  if (!orders.length) throw new Error('no placed live G orders');

  const client = await readClient(account);
  const earliest = Math.floor(new Date(orders[0].signal_ts).getTime() / 1000) - 3600;
  const exchangeTrades = await client.getTrades({ after: String(earliest) });
  const orderById = new Map(orders.map((order) => [order.clob_order_id, order]));
  const fills = new Map();

  function addFill(orderId, sizeRaw, priceRaw, role) {
    const order = orderById.get(orderId);
    if (!order) return;
    const size = parseFloat(sizeRaw);
    const price = parseFloat(priceRaw);
    if (!Number.isFinite(size) || !Number.isFinite(price) || size <= 0) return;
    const row = fills.get(orderId) || { size: 0, cost: 0, taker_fee: 0 };
    row.size += size;
    row.cost += size * price;
    if (role === 'taker') row.taker_fee += fee(size, price);
    fills.set(orderId, row);
  }

  for (const trade of exchangeTrades) {
    addFill(trade.taker_order_id, trade.size, trade.price, 'taker');
    for (const maker of trade.maker_orders || []) {
      addFill(maker.order_id, maker.matched_amount, maker.price, 'maker');
    }
  }

  const reconciled = orders.map((order) => {
    const fill = fills.get(order.clob_order_id);
    const won = String(order.outcome || '').toUpperCase() === String(order.token || '').toUpperCase();
    if (!fill) return { ...order, delay_ms: parseFloat(order.delay_ms), won, filled: false, net: null };
    const avgPrice = fill.cost / fill.size;
    return {
      ...order,
      delay_ms: parseFloat(order.delay_ms),
      won,
      filled: true,
      avg_fill_price: avgPrice,
      net: fill.size * ((won ? 1 : 0) - avgPrice) - fill.taker_fee,
    };
  });

  const bins = [
    ['<500ms', (value) => value < 500],
    ['500-999ms', (value) => value >= 500 && value < 1000],
    ['1000-1499ms', (value) => value >= 1000 && value < 1500],
    ['>=1500ms', (value) => value >= 1500],
  ].map(([bucket, keep]) => ({ bucket, ...summary(reconciled.filter((row) => keep(row.delay_ms))) }));

  const unfilled = reconciled.filter((row) => !row.filled);
  const impossibleUpperIncrement = unfilled.reduce((sum, row) => {
    if (!row.won) return sum - row.order_shares * row.limit_price - fee(row.order_shares, row.limit_price);
    return sum + row.order_shares * (1 - row.limit_price) - fee(row.order_shares, row.limit_price);
  }, 0);
  const current = summary(reconciled);

  const { rows: scoreboard } = await pool.query(`
    SELECT o.strategy,o.phase,count(*) FILTER (WHERE s.filled)::int fills,
      round(sum(s.pnl_1x) FILTER (WHERE s.filled)::numeric,2) pnl_usd
    FROM borg_shadow_orders o
    LEFT JOIN borg_shadow_scores s ON s.order_id=o.id
    WHERE o.action='place'
    GROUP BY o.strategy,o.phase ORDER BY o.strategy,o.phase
  `);

  console.log(JSON.stringify({
    generated_at: new Date().toISOString(),
    measured_local: {
      clob_http_p50_ms: CURRENT_CLOB_P50_MS,
      placed_signal_to_db_claim: current,
    },
    hypothetical_vps: {
      assumed_clob_rtt_ms: HYPOTHETICAL_VPS_CLOB_MS,
      network_only_p50_saving_ms: round(CURRENT_CLOB_P50_MS - HYPOTHETICAL_VPS_CLOB_MS, 1),
      estimated_pipeline_p50_if_only_clob_rtt_changes_ms: round(current.p50_signal_to_claim_ms - CURRENT_CLOB_P50_MS + HYPOTHETICAL_VPS_CLOB_MS, 1),
      note: 'The one-second database poll dominates. Sub-2ms networking alone does not make the pipeline sub-2ms.',
    },
    actual_live_g: {
      ...current,
      unfilled_orders: unfilled.length,
      unfilled_would_have_won: unfilled.filter((row) => row.won).length,
      zero_improvement_net_usd: current.actual_net_usd,
      impossible_best_case_all_unfilled_also_fill_increment_usd: round(impossibleUpperIncrement, 2),
      impossible_best_case_total_net_usd: round(current.actual_net_usd + impossibleUpperIncrement, 2),
      caveat: 'The upper endpoint assumes every missed order fills at its limit without adding any future missed losers. It is not a forecast.',
    },
    fill_and_pnl_by_existing_signal_to_claim_latency: bins,
    tv2_shadow_scoreboard: scoreboard,
    conclusion_guardrail: 'Only G has real exchange orders. Shadow/Paper PnL for other strategies cannot be converted into a VPS profit uplift without exchange timestamps and sub-second counterfactual books.',
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

