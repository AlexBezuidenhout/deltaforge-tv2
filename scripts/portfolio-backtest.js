#!/usr/bin/env node
/**
 * Read-only evidence report for the $500 three-bot candidate portfolio.
 *
 *  1. MAIN: calibration plus the small retained-tape executable replay.
 *  2. ETH_late_taker: actual G evaluation fills where this wallet was taker.
 *  3. ETH_late_maker: actual G evaluation fills where this wallet was maker.
 *
 * It never places/cancels orders or updates the database. Historical MAIN
 * paper P&L is reported but explicitly excluded from projections.
 */
process.removeAllListeners('warning');
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Wallet } = require('ethers');
const { Pool } = require('pg');
const { buildPortfolioPolicy } = require('../src/bot/PortfolioRiskPolicy');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const POLICY = buildPortfolioPolicy(500);

let rngState = 0x44c01a5d;
function random() {
  rngState = (1664525 * rngState + 1013904223) >>> 0;
  return rngState / 0x100000000;
}

function bootstrapMeanCI(xs, alpha = 0.05, iterations = 50000) {
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

function summarize(values, alpha = 0.05) {
  if (!values.length) return { n: 0 };
  const total = values.reduce((a, b) => a + b, 0);
  const [lo, hi] = bootstrapMeanCI(values, alpha);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const pnl of values) {
    equity += pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity - peak);
  }
  return {
    n: values.length,
    wins: values.filter((x) => x > 0).length,
    total,
    mean: total / values.length,
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
    winPct: +(100 * s.wins / s.n).toFixed(1),
    targetStakeUsd: POLICY.stakeUsd,
    pnlAtTargetStake: +s.total.toFixed(2),
    meanAtTargetStake: +s.mean.toFixed(3),
    ci95: s.ciLo == null ? null : [+s.ciLo.toFixed(3), +s.ciHi.toFixed(3)],
    maxDrawdownAtTargetStake: +s.maxDrawdown.toFixed(2),
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

async function actualEthFills() {
  const accountPath = path.join(os.homedir(), '.deltaforge-live', 'active-account.json');
  if (!fs.existsSync(accountPath)) return [];
  const account = JSON.parse(fs.readFileSync(accountPath, 'utf8'));
  const { rows: orders } = await pool.query(`
    SELECT g.clob_order_id, o.ts signal_ts, o.tte_sec, o.phase, o.token, m.asset, m.outcome
    FROM gla_live_orders g
    JOIN borg_shadow_orders o ON o.id=g.shadow_order_id
    JOIN borg_markets m ON m.id=o.market_id
    WHERE NOT g.dry_run AND g.status='PLACED' AND g.clob_order_id IS NOT NULL
    ORDER BY o.ts`);
  if (!orders.length) return [];

  const client = await makeReadClient(account);
  const earliest = Math.floor(new Date(orders[0].signal_ts).getTime() / 1000) - 3600;
  const trades = await client.getTrades({ after: String(earliest) });
  const orderById = new Map(orders.map((o) => [o.clob_order_id, o]));
  const fills = new Map();

  function add(orderId, sizeRaw, priceRaw, role) {
    const order = orderById.get(orderId);
    if (!order) return;
    const size = parseFloat(sizeRaw);
    const price = parseFloat(priceRaw);
    if (!(size > 0) || !(price > 0 && price < 1)) return;
    const row = fills.get(orderId) || { ...order, shares: 0, cost: 0, fee: 0, taker: 0, maker: 0 };
    row.shares += size;
    row.cost += size * price;
    row[role] += size;
    if (role === 'taker') row.fee += size * 0.07 * price * (1 - price);
    fills.set(orderId, row);
  }

  for (const trade of trades) {
    add(trade.taker_order_id, trade.size, trade.price, 'taker');
    for (const maker of trade.maker_orders || []) {
      add(maker.order_id, maker.matched_amount, maker.price, 'maker');
    }
  }

  return [...fills.values()].map((row) => {
    const win = row.outcome?.toUpperCase() === row.token?.toUpperCase();
    const gross = row.shares * (win ? 1 : 0) - row.cost;
    const net = gross - row.fee;
    return {
      ...row,
      win,
      net,
      role: row.taker > 0 && row.maker > 0 ? 'mixed' : row.taker > 0 ? 'taker' : 'maker',
      replayAtTargetStake: row.cost > 0 ? net * (POLICY.stakeUsd / row.cost) : 0,
    };
  }).sort((a, b) => new Date(a.signal_ts) - new Date(b.signal_ts));
}

async function mainEvidence() {
  const [{ rows: calibration }, { rows: paper }, { rows: recent }] = await Promise.all([
    pool.query(`
      WITH last AS (
        SELECT DISTINCT ON (s.market_id) s.model_prob::float p, s.yes_price::float market_p,
          CASE WHEN upper(m.outcome)='UP' THEN 1.0 ELSE 0.0 END y
        FROM signals s JOIN borg_markets m ON m.gamma_id=s.market_id
        WHERE s.created_at >= '2026-07-12T10:00:00Z'
          AND s.model_prob IS NOT NULL AND s.yes_price IS NOT NULL AND m.outcome IS NOT NULL
        ORDER BY s.market_id, s.created_at DESC)
      SELECT count(*)::int n, avg((p-y)^2)::float model_brier,
        avg((market_p-y)^2)::float market_brier FROM last`),
    pool.query(`
      SELECT count(*)::int n, count(*) FILTER (WHERE pnl>0)::int wins,
        coalesce(sum(pnl),0)::float pnl
      FROM trades WHERE user_id=1 AND status='closed'
        AND created_at >= '2026-07-12T10:00:00Z'`),
    pool.query(`
      SELECT t.created_at, t.direction, t.entry_price::float paper_entry,
        t.model_prob::float model_prob, m.outcome,
        CASE WHEN t.direction='YES' THEN snap.up_best_ask ELSE snap.down_best_ask END::float ask
      FROM trades t
      JOIN borg_markets m ON m.gamma_id=t.market_id
      CROSS JOIN LATERAL (
        SELECT b.* FROM borg_book_snaps b
        WHERE b.market_id=m.id AND b.ts<=t.created_at
          AND b.ts>t.created_at-interval '2 seconds'
        ORDER BY b.ts DESC LIMIT 1) snap
      WHERE t.created_at>=now()-interval '2 hours' AND m.outcome IS NOT NULL
        AND t.model_prob IS NOT NULL ORDER BY t.created_at`),
  ]);

  const replay = recent.map((r) => {
    const ask = parseFloat(r.ask);
    const modelProb = parseFloat(r.model_prob);
    const outcomeProb = r.direction === 'YES' ? modelProb : 1 - modelProb;
    const executionEV = (outcomeProb - ask - 0.07 * ask * (1 - ask)) * 100;
    const win = (r.direction === 'YES' && r.outcome === 'UP') ||
      (r.direction === 'NO' && r.outcome === 'DOWN');
    const shares = POLICY.stakeUsd / ask;
    const pnl = shares * ((win ? 1 : 0) - ask) - shares * 0.07 * ask * (1 - ask);
    return { ...r, ask, executionEV, pnl };
  }).filter((r) => Number.isFinite(r.ask) && Number.isFinite(parseFloat(r.paper_entry)));
  const eligible = replay.filter((r) => r.ask >= 0.40 && r.ask <= 0.65 && r.executionEV >= 0.8);
  return {
    calibration: calibration[0],
    paper: paper[0],
    recentObserved: replay.length,
    avgEntryGap: replay.length
      ? replay.reduce((s, r) => s + Math.abs(parseFloat(r.paper_entry) - r.ask), 0) / replay.length
      : null,
    executable: summarize(eligible.map((r) => r.pnl)),
  };
}

async function run() {
  console.log(`THREE-BOT PORTFOLIO BACKTEST — ${new Date().toISOString()}`);
  console.log('Risk envelope:', POLICY);

  const [main, actual] = await Promise.all([mainEvidence(), actualEthFills()]);
  console.log('\n1) MAIN — prediction evidence vs executable evidence');
  console.log({
    calibrationN: main.calibration?.n || 0,
    modelBrier: +(parseFloat(main.calibration?.model_brier) || 0).toFixed(4),
    marketBrier: +(parseFloat(main.calibration?.market_brier) || 0).toFixed(4),
    apparentPaperN: main.paper?.n || 0,
    apparentPaperWins: main.paper?.wins || 0,
    apparentPaperWinPct: main.paper?.n > 0
      ? +(100 * main.paper.wins / main.paper.n).toFixed(1)
      : null,
    apparentPaperPnl: +(parseFloat(main.paper?.pnl) || 0).toFixed(2),
    recentBookMatchedN: main.recentObserved,
    avgPaperVsAskGap: main.avgEntryGap == null ? null : +main.avgEntryGap.toFixed(3),
    newExecutableRuleReplay: printable(main.executable),
  });

  const ethAll = actual.filter((r) => r.phase === 'eval' && r.asset === 'eth');
  // The fresh candidate has the mechanism-derived 45-second jump-risk guard.
  // Show the inherited full G sample for context, but project only the rows
  // that satisfy the candidate's actual entry policy.
  const eth = ethAll.filter((r) => parseFloat(r.tte_sec) >= 45);
  const taker = summarize(eth.filter((r) => r.role === 'taker').map((r) => r.replayAtTargetStake));
  const maker = summarize(eth.filter((r) => r.role === 'maker').map((r) => r.replayAtTargetStake));
  const combined = summarize(eth.map((r) => r.replayAtTargetStake));
  console.log(`\n2) ETH_late_taker — actual CLOB role replay at $${POLICY.stakeUsd}`);
  console.log(printable(taker));
  console.log(`\n3) ETH_late_maker — actual CLOB role replay at $${POLICY.stakeUsd} (no rebate credit)`);
  console.log(printable(maker));
  console.log(`\nCombined historical ETH execution sample normalized to $${POLICY.stakeUsd}`);
  console.log(printable(combined));
  console.log('Inherited G sample before the 45s safety guard (context only):');
  console.log(printable(summarize(ethAll.map((r) => r.replayAtTargetStake))));
  const adjusted = summarize(eth.map((r) => r.replayAtTargetStake), 0.05 / 6);
  console.log('Six-asset adjusted 99.17% mean CI:', adjusted.ciLo == null
    ? null
    : [+adjusted.ciLo.toFixed(3), +adjusted.ciHi.toFixed(3)]);

  const observed100 = combined.n ? combined.mean * 100 : 0;
  console.log('\nScenario projection per 100 fresh ETH fills (not a forecast):');
  console.table([
    { scenario: 'zero edge', pnl: 0, endEquity: POLICY.bankrollUsdc },
    { scenario: '50% haircut to observed expectancy', pnl: +(observed100 * 0.5).toFixed(2), endEquity: +(POLICY.bankrollUsdc + observed100 * 0.5).toFixed(2) },
    { scenario: 'repeat observed expectancy', pnl: +observed100.toFixed(2), endEquity: +(POLICY.bankrollUsdc + observed100).toFixed(2) },
  ]);
  console.log('\nGuardrail: MAIN has no defensible dollar projection until the corrected executable-fill cohort grows.');
  await pool.end();
}

run().catch(async (err) => {
  console.error(err.stack || err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
