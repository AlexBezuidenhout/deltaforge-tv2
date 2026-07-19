#!/usr/bin/env node
/**
 * scripts/ev-autopsy.js — does claimed EV predict realized PnL?
 *
 * Sections:
 *   1. Claimed EV_adj vs realized ROI per trade: buckets, correlation, OLS slope.
 *      If the strategy's EV numbers mean anything, higher claimed EV must map to
 *      higher realized ROI. The suspicion under test: the relationship is INVERTED.
 *   2. Counterfactual hold-to-resolution PnL per trade (separates exit policy
 *      from entry/model quality).
 *   3. Mechanical-EV test (hypothesis 4a): the heuristic sets
 *      modelProb = yesPrice ± (btcEdge + microEdge), so claimed EV grows with
 *      btcDelta BY CONSTRUCTION. Quantified as corr(|ema_edge|, ev_adj) on
 *      TRADE-verdict signals — a high correlation with no matching realized-PnL
 *      correlation means the "edge" is manufactured, not discovered.
 *   4. Loss clustering vs oracle divergence (new column; reports insufficient
 *      data until enough fresh trades carry it).
 *   5. Adverse selection: instant vs rested fills (time_to_fill_sec).
 *
 * Usage: node scripts/ev-autopsy.js [--user 1]
 * Requires DATABASE_URL in .env.
 */
require('dotenv').config();
const { pool } = require('../src/models/db');

const args = process.argv.slice(2);
const USER_ID = parseInt(args[args.indexOf('--user') + 1] || '1', 10) || 1;

const resolutionCache = new Map();
async function fetchResolution(marketId) {
  if (resolutionCache.has(marketId)) return resolutionCache.get(marketId);
  let result = null;
  try {
    const r = await fetch(`https://gamma-api.polymarket.com/markets/${marketId}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const m = await r.json();
      let op = m.outcomePrices;
      if (typeof op === 'string') { try { op = JSON.parse(op); } catch (_) { op = null; } }
      if (Array.isArray(op) && op.length >= 2) {
        const yes = parseFloat(op[0]);
        if (Number.isFinite(yes)) {
          if (yes >= 0.9) result = 1;
          else if (yes <= 0.1) result = 0;
        }
      }
    }
  } catch (_) {}
  resolutionCache.set(marketId, result);
  await new Promise((res) => setTimeout(res, 60));
  return result;
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** OLS y = a + b·x → { a, b } */
function ols(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  if (sxx === 0) return null;
  const b = sxy / sxx;
  return { a: my - b * mx, b };
}

const fmt = (v, d = 2) => (v == null || !Number.isFinite(v) ? 'n/a' : v.toFixed(d));

async function run() {
  console.log(`EV autopsy — user ${USER_ID}, ${new Date().toISOString()}`);

  const { rows: trades } = await pool.query(`
    SELECT id, market_id, direction, entry_price, exit_price, trade_size, pnl, ev_adj,
           signal_confidence, close_reason, scenario, time_to_fill_sec,
           oracle_divergence_bps, created_at
    FROM trades
    WHERE user_id = $1 AND status = 'closed' AND pnl IS NOT NULL AND ev_adj IS NOT NULL
      AND ABS(pnl) < 100000
    ORDER BY id
  `, [USER_ID]);
  console.log(`Closed trades with claimed EV: ${trades.length}`);
  if (trades.length === 0) { console.log('Nothing to autopsy.'); await pool.end(); return; }

  // ── 1. Claimed EV vs realized ROI ─────────────────────────────────────────
  const evs = [], rois = [];
  const buckets = [
    { name: '     <2%', lo: -Infinity, hi: 2 },
    { name: '   2–5%', lo: 2, hi: 5 },
    { name: '  5–10%', lo: 5, hi: 10 },
    { name: ' 10–15%', lo: 10, hi: 15 },
    { name: '   >15%', lo: 15, hi: Infinity },
  ].map((b) => ({ ...b, n: 0, wins: 0, pnl: 0, roiSum: 0 }));

  for (const t of trades) {
    const ev = parseFloat(t.ev_adj);
    const size = parseFloat(t.trade_size);
    const pnl = parseFloat(t.pnl);
    if (!Number.isFinite(ev) || !Number.isFinite(size) || size <= 0 || !Number.isFinite(pnl)) continue;
    const roi = (pnl / size) * 100;
    evs.push(ev); rois.push(roi);
    const b = buckets.find((x) => ev >= x.lo && ev < x.hi);
    if (b) { b.n++; b.pnl += pnl; b.roiSum += roi; if (pnl > 0) b.wins++; }
  }

  console.log('\n━━━ 1. Claimed EV_adj vs realized outcome ━━━');
  console.log('  claimed EV     n   win%   total PnL   avg ROI   (claimed EV says avg ROI should be ≈ mid-bucket)');
  for (const b of buckets) {
    if (b.n === 0) continue;
    console.log(
    `  ${b.name}   ${String(b.n).padStart(3)}   ${((b.wins / b.n) * 100).toFixed(0).padStart(3)}%` +
    `   $${b.pnl.toFixed(2).padStart(8)}   ${fmt(b.roiSum / b.n, 1).padStart(6)}%`
    );
  }
  const r = pearson(evs, rois);
  const fit = ols(evs, rois);
  console.log(`\n  Pearson corr(claimed EV, realized ROI): ${fmt(r, 3)}  (n=${evs.length})`);
  if (fit) {
    console.log(`  OLS: realizedROI% = ${fmt(fit.a, 2)} + ${fmt(fit.b, 3)} × claimedEV%`);
    console.log(`  A calibrated model needs slope ≈ +1. Slope ≤ 0 with meaningful n = claimed EV is anti-signal.`);
  }
  if (evs.length < 100) {
    console.log(`  NOTE: n=${evs.length} < 100 — correlation CI is wide; treat direction as suggestive, not proven.`);
  }

  // ── 2. Counterfactual: hold every trade to resolution ─────────────────────
  console.log('\n━━━ 2. Exit policy vs entry quality (hold-to-resolution counterfactual) ━━━');
  let actual = 0, held = 0, resolved = 0, unresolved = 0;
  const byReason = new Map();
  for (const t of trades) {
    const outcome = await fetchResolution(t.market_id);
    const entry = parseFloat(t.entry_price), size = parseFloat(t.trade_size), pnl = parseFloat(t.pnl);
    if (outcome == null || !Number.isFinite(entry) || entry <= 0 || !Number.isFinite(size)) { unresolved++; continue; }
    resolved++;
    const win = t.direction === 'NO' ? 1 - outcome : outcome; // 1 if this trade's side won
    const shares = size / entry;
    const gross = shares * win - size;
    const heldPnl = gross - shares * 0.07 * entry * (1 - entry);
    actual += pnl; held += heldPnl;
    const key = t.close_reason || 'UNKNOWN';
    const agg = byReason.get(key) || { n: 0, actual: 0, held: 0 };
    agg.n++; agg.actual += pnl; agg.held += heldPnl;
    byReason.set(key, agg);
  }
  console.log(`  Resolved ${resolved}/${trades.length} (${unresolved} unresolved/unfetchable)`);
  console.log(`  Actual PnL: $${actual.toFixed(2)}   Hold-to-resolution PnL: $${held.toFixed(2)}   (exit policy ${held < actual ? 'ADDED' : 'COST'} $${Math.abs(actual - held).toFixed(2)})`);
  console.log('  close_reason              n     actual        held-to-resolution');
  for (const [k, v] of [...byReason.entries()].sort((a, b) => a[1].actual - b[1].actual)) {
    console.log(`  ${k.padEnd(24)}${String(v.n).padStart(3)}   $${v.actual.toFixed(2).padStart(8)}   $${v.held.toFixed(2).padStart(8)}`);
  }
  console.log('  Reading: if held-to-resolution is also deeply negative, the losses are ENTRY quality, not exits.');

  // ── 3. Mechanical-EV test (hypothesis 4a) ─────────────────────────────────
  console.log('\n━━━ 3. Is claimed EV manufactured from btcDelta? (hypothesis 4a) ━━━');
  const { rows: sigRows } = await pool.query(`
    SELECT ema_edge, ev_adj, btc_edge, micro_edge, p_phi, p_heur, yes_price
    FROM signals
    WHERE user_id = $1 AND verdict = 'TRADE' AND ev_adj IS NOT NULL AND ema_edge IS NOT NULL
  `, [USER_ID]);
  const absDelta = [], sigEv = [];
  for (const s of sigRows) {
    const d = Math.abs(parseFloat(s.ema_edge)), e = parseFloat(s.ev_adj);
    if (Number.isFinite(d) && Number.isFinite(e)) { absDelta.push(d); sigEv.push(e); }
  }
  const rMech = pearson(absDelta, sigEv);
  console.log(`  corr(|btcDelta|, claimed EV) on ${absDelta.length} TRADE signals: ${fmt(rMech, 3)}`);
  console.log('  Structure: pHeur = yesPrice ± (min(|Δ|·0.5, .15) + micro·.10) ⇒ heuristic EV ≈ totalEdge − costs');
  console.log('  by construction. Positive corr here is EXPECTED and is not evidence of edge; it becomes');
  console.log('  damning when section 1 shows realized ROI does NOT rise with claimed EV.');
  const withComponents = sigRows.filter((s) => s.btc_edge != null).length;
  if (withComponents === 0) {
    console.log('  Component columns (btc_edge/micro_edge/p_phi/p_heur): no rows yet — attribution split');
    console.log('  (btcEdge vs microEdge vs Φ-divergence) available after fresh trades accumulate.');
  } else {
    const phiDiv = [], comps = { btc: [], micro: [] }, evByComp = [];
    for (const s of sigRows) {
      if (s.btc_edge == null) continue;
      const e = parseFloat(s.ev_adj);
      evByComp.push(e);
      comps.btc.push(parseFloat(s.btc_edge) * 100);
      comps.micro.push(parseFloat(s.micro_edge ?? 0) * 100);
      if (s.p_phi != null && s.yes_price != null) phiDiv.push(Math.abs(parseFloat(s.p_phi) - parseFloat(s.yes_price)) * 100);
      else phiDiv.push(null);
    }
    console.log(`  Attribution on ${evByComp.length} decomposed TRADE signals:`);
    console.log(`    corr(btcEdge,  claimed EV): ${fmt(pearson(comps.btc, evByComp), 3)}`);
    console.log(`    corr(microEdge, claimed EV): ${fmt(pearson(comps.micro, evByComp), 3)}`);
    const pd = phiDiv.map((v, i) => (v == null ? null : [v, evByComp[i]])).filter(Boolean);
    if (pd.length >= 3) {
      console.log(`    corr(|Φ − price|, claimed EV): ${fmt(pearson(pd.map((x) => x[0]), pd.map((x) => x[1])), 3)}  (n=${pd.length})`);
    }
  }

  // ── 4. Losses vs oracle divergence ────────────────────────────────────────
  console.log('\n━━━ 4. Loss clustering vs Binance/Chainlink divergence ━━━');
  const withDiv = trades.filter((t) => t.oracle_divergence_bps != null);
  if (withDiv.length < 10) {
    console.log(`  ${withDiv.length} trade(s) carry oracle_divergence_bps (column is new).`);
    console.log('  INSUFFICIENT DATA — re-run after ≥300 fresh trades. If losses cluster at high divergence,');
    console.log('  enable the max_oracle_divergence_bps hard skip (currently NULL = off).');
  } else {
    const divs = withDiv.map((t) => parseFloat(t.oracle_divergence_bps));
    const roi2 = withDiv.map((t) => (parseFloat(t.pnl) / parseFloat(t.trade_size)) * 100);
    console.log(`  corr(divergence bps, realized ROI) on ${withDiv.length} trades: ${fmt(pearson(divs, roi2), 3)}`);
    const sorted = [...divs].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const hi = withDiv.filter((t) => parseFloat(t.oracle_divergence_bps) > median);
    const lo = withDiv.filter((t) => parseFloat(t.oracle_divergence_bps) <= median);
    const avg = (xs) => xs.reduce((s, t) => s + parseFloat(t.pnl), 0) / (xs.length || 1);
    console.log(`  Above-median divergence (> ${median.toFixed(1)}bps): n=${hi.length}, avg PnL $${avg(hi).toFixed(2)}`);
    console.log(`  Below-median divergence: n=${lo.length}, avg PnL $${avg(lo).toFixed(2)}`);
  }

  // ── 5. Adverse selection: instant vs rested fills ─────────────────────────
  console.log('\n━━━ 5. Adverse selection (instant vs rested fills) ━━━');
  const instant = trades.filter((t) => parseFloat(t.time_to_fill_sec) === 0);
  const rested = trades.filter((t) => parseFloat(t.time_to_fill_sec) > 0);
  const avgPnl = (xs) => (xs.length ? xs.reduce((s, t) => s + parseFloat(t.pnl), 0) / xs.length : null);
  console.log(`  Instant fills: n=${instant.length}, avg PnL ${instant.length ? '$' + fmt(avgPnl(instant)) : 'n/a'}`);
  console.log(`  Rested fills:  n=${rested.length}, avg PnL ${rested.length ? '$' + fmt(avgPnl(rested)) : 'n/a'}`);
  if (rested.length < 10) {
    console.log('  Current paper entries fill instantly (market-style), so this comparison has no power yet.');
    console.log('  It becomes meaningful if resting-limit entries are reintroduced or in live mode.');
  }

  await pool.end();
}

run().catch((e) => { console.error('ev-autopsy failed:', e.message); pool.end(); process.exit(1); });
