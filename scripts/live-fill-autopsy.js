#!/usr/bin/env node
/**
 * Read-only reconciliation of G_late_arb DB rows against actual CLOB trades.
 *
 * Security: loads ~/.deltaforge-live/active-account.json only to authenticate
 * read methods. It never prints the key, wallet, order IDs, or trade IDs and
 * never calls an order/cancel method.
 *
 * Fee model: current official crypto curve, fee = shares * 0.07 * p * (1-p)
 * on taker matches; maker matches pay zero platform fee. This is intentionally
 * separate from BORG's frozen pessimistic 2%-of-notional score grid.
 *
 * Run: node scripts/live-fill-autopsy.js
 */
process.removeAllListeners('warning');
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Wallet } = require('ethers');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

let rngState = 0x1d872b41;
function random() {
  rngState = (1664525 * rngState + 1013904223) >>> 0;
  return rngState / 0x100000000;
}

function bootstrapCI(xs, alpha = 0.05, iterations = 50000) {
  if (xs.length < 2) return [null, null];
  const means = new Array(iterations);
  for (let b = 0; b < iterations; b++) {
    let sum = 0;
    for (let i = 0; i < xs.length; i++) sum += xs[(random() * xs.length) | 0];
    means[b] = sum / xs.length;
  }
  means.sort((a, b) => a - b);
  return [
    means[Math.floor(iterations * alpha / 2)],
    means[Math.floor(iterations * (1 - alpha / 2))],
  ];
}

function summarize(rows, alpha = 0.05) {
  if (!rows.length) return { n: 0 };
  const pnls = rows.map((r) => r.net);
  const [lo, hi] = bootstrapCI(pnls, alpha);
  const total = pnls.reduce((a, b) => a + b, 0);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const pnl of pnls) {
    equity += pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity - peak);
  }
  return {
    n: rows.length,
    wins: rows.filter((r) => r.win).length,
    winPct: 100 * rows.filter((r) => r.win).length / rows.length,
    net: total,
    mean: total / rows.length,
    fee: rows.reduce((s, r) => s + r.fee, 0),
    ciLo: lo,
    ciHi: hi,
    maxDrawdown,
  };
}

function printable(s) {
  if (!s.n) return { n: 0 };
  return {
    n: s.n,
    wins: s.wins,
    winPct: +s.winPct.toFixed(1),
    net: +s.net.toFixed(2),
    mean: +s.mean.toFixed(3),
    fees: +s.fee.toFixed(2),
    ci95: s.ciLo == null || s.ciHi == null
      ? null
      : [+s.ciLo.toFixed(3), +s.ciHi.toFixed(3)],
    maxDrawdown: +s.maxDrawdown.toFixed(2),
  };
}

async function makeReadClient(account) {
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

async function run() {
  const accountPath = path.join(os.homedir(), '.deltaforge-live', 'active-account.json');
  if (!fs.existsSync(accountPath)) throw new Error(`missing ${accountPath}`);
  const account = JSON.parse(fs.readFileSync(accountPath, 'utf8'));

  const { rows: orders } = await pool.query(`
    SELECT g.clob_order_id, g.size::float order_size, g.price::float live_limit,
      o.ts signal_ts, o.phase, o.market_id, o.token, o.price::float shadow_price,
      o.tte_sec::float tte_sec,
      m.asset, m.outcome, s.pnl_1x::float shadow_net
    FROM gla_live_orders g
    JOIN borg_shadow_orders o ON o.id=g.shadow_order_id
    JOIN borg_markets m ON m.id=o.market_id
    LEFT JOIN borg_shadow_scores s ON s.order_id=o.id
    WHERE NOT g.dry_run AND g.status='PLACED' AND g.clob_order_id IS NOT NULL
    ORDER BY o.ts`);
  if (!orders.length) {
    console.log('No placed live G orders.');
    await pool.end();
    return;
  }

  const client = await makeReadClient(account);
  const earliest = Math.floor(new Date(orders[0].signal_ts).getTime() / 1000) - 3600;
  const exchangeTrades = await client.getTrades({ after: String(earliest) });
  const orderById = new Map(orders.map((o) => [o.clob_order_id, o]));
  const actual = new Map();

  function addFill(orderId, sizeRaw, priceRaw, role) {
    const order = orderById.get(orderId);
    if (!order) return;
    const size = parseFloat(sizeRaw);
    const price = parseFloat(priceRaw);
    if (!Number.isFinite(size) || !Number.isFinite(price) || size <= 0) return;
    const row = actual.get(orderId) || {
      ...order, size: 0, cost: 0, fee: 0, takerSize: 0, makerSize: 0,
    };
    row.size += size;
    row.cost += size * price;
    if (role === 'taker') {
      row.takerSize += size;
      row.fee += size * 0.07 * price * (1 - price);
    } else {
      row.makerSize += size;
    }
    actual.set(orderId, row);
  }

  for (const trade of exchangeTrades) {
    addFill(trade.taker_order_id, trade.size, trade.price, 'taker');
    for (const maker of trade.maker_orders || []) {
      addFill(maker.order_id, maker.matched_amount, maker.price, 'maker');
    }
  }

  const filled = [...actual.values()].map((row) => {
    const avgPrice = row.cost / row.size;
    const win = row.outcome != null && row.outcome.toUpperCase() === row.token.toUpperCase();
    return {
      ...row,
      avgPrice,
      win,
      net: row.size * ((win ? 1 : 0) - avgPrice) - row.fee,
      role: row.takerSize > 0 && row.makerSize > 0 ? 'mixed'
        : row.takerSize > 0 ? 'taker' : 'maker',
    };
  }).sort((a, b) => new Date(a.signal_ts) - new Date(b.signal_ts));
  const unfilled = orders.filter((o) => !actual.has(o.clob_order_id));

  console.log(`LIVE FILL AUTOPSY — ${new Date().toISOString()}`);
  console.log(`DB accepted orders: ${orders.length}`);
  console.log(`orders with any exchange fill: ${filled.length} (${(100 * filled.length / orders.length).toFixed(1)}%)`);
  console.log(`unfilled: ${unfilled.length}; would-have-won: ${unfilled.filter((o) => o.outcome?.toUpperCase() === o.token.toUpperCase()).length}`);

  const allActual = summarize(filled);
  const matchedShadow = filled.reduce((sum, row) => sum + (Number.isFinite(row.shadow_net) ? row.shadow_net : 0), 0);
  const unfilledShadow = unfilled.reduce((sum, row) => sum + (Number.isFinite(row.shadow_net) ? row.shadow_net : 0), 0);
  console.log('\nActual exchange result vs the same shadow-order ids:');
  console.log('actual fills ', printable(allActual));
  console.log(`matched shadow PnL: $${matchedShadow.toFixed(2)}; live-minus-shadow: $${(allActual.net - matchedShadow).toFixed(2)}`);
  console.log(`unfilled shadow counterfactual: $${unfilledShadow.toFixed(2)} (descriptive only; those orders were not executable at the submitted limits)`);

  console.log('\nBy phase / asset (official crypto taker curve; maker fee zero):');
  const keys = [...new Set(filled.map((r) => `${r.phase}:${r.asset}`))].sort();
  for (const key of keys) {
    const [phase, asset] = key.split(':');
    console.log(`${key.padEnd(14)} ${JSON.stringify(printable(summarize(filled.filter((r) => r.phase === phase && r.asset === asset))))}`);
  }

  console.log('\nBy execution role (eval rows):');
  const roleKeys = [...new Set(filled.filter((r) => r.phase === 'eval').map((r) => `${r.asset}:${r.role}`))].sort();
  for (const key of roleKeys) {
    const [asset, role] = key.split(':');
    console.log(`${key.padEnd(14)} ${JSON.stringify(printable(summarize(filled.filter((r) => r.phase === 'eval' && r.asset === asset && r.role === role))))}`);
  }

  console.log('\nBy submitted-limit generation (actual fills; diagnostic, not a tuned filter):');
  const generations = [
    ['old_1c_or_cap', (r) => r.live_limit - r.shadow_price < 0.025],
    ['chase_3c', (r) => r.live_limit - r.shadow_price >= 0.025],
  ];
  for (const [label, keep] of generations) {
    const rows = filled.filter(keep);
    const missed = unfilled.filter(keep);
    console.log(`${label.padEnd(14)} ${JSON.stringify(printable(summarize(rows)))}; unfilled=${missed.length}, wouldWin=${missed.filter((o) => o.outcome?.toUpperCase() === o.token.toUpperCase()).length}`);
  }

  const currentCore = filled.filter((r) => r.phase === 'eval' && r.asset !== 'hype');
  console.log('\nCurrent frozen eval core (actual exchange fills only):');
  console.log(printable(summarize(currentCore)));

  const ethEval = filled.filter((r) => r.phase === 'eval' && r.asset === 'eth');
  const half = Math.floor(ethEval.length / 2);
  console.log('\nETH eval candidate:');
  console.log('all        ', printable(summarize(ethEval)));
  console.log('first half ', printable(summarize(ethEval.slice(0, half))));
  console.log('second half', printable(summarize(ethEval.slice(half))));
  const adjusted = summarize(ethEval, 0.05 / 6);
  console.log('99.17% CI (six-asset Bonferroni):', adjusted.ciLo == null
    ? null
    : [+adjusted.ciLo.toFixed(3), +adjusted.ciHi.toFixed(3)]);
  console.log('ETH diagnostic by direction (post-hoc; not a filter recommendation):');
  for (const token of ['UP', 'DOWN']) {
    console.log(`  ${token.padEnd(4)}`, printable(summarize(ethEval.filter((r) => r.token.toUpperCase() === token))));
  }
  console.log('ETH diagnostic by TTE (post-hoc; not a filter recommendation):');
  const tteBands = [
    ['5-24s', (r) => r.tte_sec >= 5 && r.tte_sec < 25],
    ['25-49s', (r) => r.tte_sec >= 25 && r.tte_sec < 50],
    ['50-75s', (r) => r.tte_sec >= 50 && r.tte_sec <= 75],
  ];
  for (const [label, keep] of tteBands) {
    console.log(`  ${label.padEnd(6)}`, printable(summarize(ethEval.filter(keep))));
  }
  const ethUnfilled = unfilled.filter((r) => r.phase === 'eval' && r.asset === 'eth');
  console.log(`ETH unfilled: ${ethUnfilled.length}; would-have-won: ${ethUnfilled.filter((o) => o.outcome?.toUpperCase() === o.token.toUpperCase()).length}`);

  console.log('\nCaveat: an exchange fill is ground truth; wallet-baseline P&L may span a different start time and should not be forced to reconcile without a timestamped baseline.');
  await pool.end();
}

run().catch(async (err) => {
  console.error(err.stack || err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
