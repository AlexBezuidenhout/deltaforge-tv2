#!/usr/bin/env node
/**
 * scripts/calibration.js — model calibration report.
 *
 * Answers ONE question honestly: when the model says P(UP) = x, how often does the
 * market actually resolve UP? Reported separately for:
 *   - the Φ model alone        (signals.p_phi)
 *   - the heuristic alone      (signals.p_heur)
 *   - the ensemble             (signals.model_prob)
 *   - the raw Polymarket quote (signals.poly_yes_price; probability benchmark)
 *   - executed trades          (trades.model_prob, mapped to P(direction wins))
 *
 * Design decisions (do not quietly change these — they exist to avoid self-deception):
 *   - One observation per MARKET, not per signal row. Signals are logged every ~5s,
 *     so a single market can contribute 30+ near-identical rows; treating those as
 *     independent observations fabricates tight confidence intervals. We take the
 *     LAST evaluated signal per market per estimator.
 *   - Wilson 95% CIs and per-bucket counts are always printed. A bucket with n=3
 *     tells you nothing; the CI makes that visible.
 *   - Resolution comes from the collector's borg_markets table first, then the
 *     Gamma API only for missing markets (cached). Markets that have not clearly
 *     resolved (outcome not ~0/1) are excluded and counted.
 *   - Rows predating the edge-decomposition columns (2026-07-10) have NULL p_phi /
 *     p_heur / model_prob and are excluded and counted. If almost everything is
 *     excluded, the honest answer is "insufficient data" — and the script says so.
 *
 * Usage: node scripts/calibration.js [--user 1] [--buckets 10] [--min-n 1]
 * Requires DATABASE_URL in .env.
 */
require('dotenv').config();
const { pool } = require('../src/models/db');

const args = process.argv.slice(2);
function argVal(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : dflt;
}
const USER_ID = parseInt(argVal('user', '1'), 10);
const N_BUCKETS = Math.max(2, parseInt(argVal('buckets', '10'), 10));

// ── Resolution fetch (Gamma), cached per market ─────────────────────────────
const resolutionCache = new Map();
async function fetchResolution(marketId) {
  const cacheKey = String(marketId);
  if (resolutionCache.has(cacheKey)) return resolutionCache.get(cacheKey);
  let result = null; // 1 = YES/UP won, 0 = NO/DOWN won, null = unresolved/unknown
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
  } catch (_) { /* unresolved */ }
  resolutionCache.set(cacheKey, result);
  await new Promise((res) => setTimeout(res, 60)); // be polite to Gamma
  return result;
}

// ── Statistics ───────────────────────────────────────────────────────────────
/** Wilson 95% score interval for k successes in n trials. */
function wilson(k, n) {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

function scoreEstimator(name, obs) {
  // obs: [{ p, outcome }] where p = predicted P(UP), outcome = 1|0 (UP won?)
  const n = obs.length;
  console.log(`\n━━━ ${name} — ${n} resolved market(s) ━━━`);
  if (n === 0) {
    console.log('  INSUFFICIENT DATA — no resolved observations with this estimator recorded.');
    return;
  }
  let brier = 0, logloss = 0;
  const EPS = 1e-6;
  for (const o of obs) {
    brier += (o.p - o.outcome) ** 2;
    const pc = Math.min(1 - EPS, Math.max(EPS, o.p));
    logloss += -(o.outcome * Math.log(pc) + (1 - o.outcome) * Math.log(1 - pc));
  }
  brier /= n; logloss /= n;

  // Reference: an uninformative predictor that always says the base rate.
  const baseRate = obs.reduce((s, o) => s + o.outcome, 0) / n;
  const brierBase = obs.reduce((s, o) => s + (baseRate - o.outcome) ** 2, 0) / n;

  console.log(`  Brier score:   ${brier.toFixed(4)}  (always-predict-base-rate reference: ${brierBase.toFixed(4)} — lower is better; above reference = worse than knowing nothing)`);
  console.log(`  Log-loss:      ${logloss.toFixed(4)}  (coin-flip reference: ${Math.log(2).toFixed(4)})`);
  console.log(`  Base rate UP:  ${(baseRate * 100).toFixed(1)}%`);
  console.log('  bucket      n    predicted   realized    Wilson 95% CI');
  for (let b = 0; b < N_BUCKETS; b++) {
    const lo = b / N_BUCKETS, hi = (b + 1) / N_BUCKETS;
    const inB = obs.filter((o) => o.p >= lo && (b === N_BUCKETS - 1 ? o.p <= hi : o.p < hi));
    if (inB.length === 0) continue;
    const k = inB.reduce((s, o) => s + o.outcome, 0);
    const avgP = inB.reduce((s, o) => s + o.p, 0) / inB.length;
    const [wl, wh] = wilson(k, inB.length);
    const flag = inB.length < 10 ? '  (n<10 — noise, do not over-read)' : '';
    console.log(
      `  ${(lo * 100).toFixed(0).padStart(3)}–${(hi * 100).toFixed(0).padEnd(3)}%` +
      `${String(inB.length).padStart(5)}    ${(avgP * 100).toFixed(1).padStart(6)}%` +
      `    ${((k / inB.length) * 100).toFixed(1).padStart(6)}%` +
      `    [${(wl * 100).toFixed(1)}%, ${(wh * 100).toFixed(1)}%]${flag}`
    );
  }
}

async function run() {
  console.log(`Calibration report — user ${USER_ID}, ${N_BUCKETS} buckets, ${new Date().toISOString()}`);

  // 1. Signal-level: last signal per market with decomposition columns present.
  const sig = await pool.query(`
    SELECT DISTINCT ON (market_id)
      market_id, model_prob, p_phi, p_heur, poly_yes_price, created_at
    FROM signals
    WHERE user_id = $1 AND market_id IS NOT NULL
      AND (model_prob IS NOT NULL OR p_phi IS NOT NULL OR p_heur IS NOT NULL)
    ORDER BY market_id, created_at DESC
  `, [USER_ID]);

  // The collector already resolved most of these markets. Seeding the cache
  // avoids thousands of sequential API requests and makes the script usable
  // during ordinary operation; Gamma remains a read-only fallback for gaps.
  const localResolutions = await pool.query(`
    SELECT gamma_id, outcome FROM borg_markets
    WHERE gamma_id IS NOT NULL AND upper(outcome) IN ('UP', 'DOWN')
  `).catch(() => ({ rows: [] }));
  for (const row of localResolutions.rows) {
    resolutionCache.set(String(row.gamma_id), String(row.outcome).toUpperCase() === 'UP' ? 1 : 0);
  }

  const missing = await pool.query(`
    SELECT COUNT(DISTINCT market_id) AS n FROM signals
    WHERE user_id = $1 AND market_id IS NOT NULL AND model_prob IS NULL AND p_phi IS NULL AND p_heur IS NULL
  `, [USER_ID]);
  console.log(`Markets with decomposed signals: ${sig.rowCount}. Markets predating decomposition columns (excluded): ${missing.rows[0].n}.`);

  let unresolved = 0;
  const obsPhi = [], obsHeur = [], obsEns = [], obsRawMarket = [];
  for (const row of sig.rows) {
    const outcome = await fetchResolution(row.market_id);
    if (outcome == null) { unresolved++; continue; }
    const pPhi = parseFloat(row.p_phi), pHeur = parseFloat(row.p_heur), pEns = parseFloat(row.model_prob);
    const pRawMarket = parseFloat(row.poly_yes_price);
    if (Number.isFinite(pPhi)) obsPhi.push({ p: pPhi, outcome });
    if (Number.isFinite(pHeur)) obsHeur.push({ p: pHeur, outcome });
    if (Number.isFinite(pEns)) obsEns.push({ p: pEns, outcome });
    if (Number.isFinite(pRawMarket) && pRawMarket > 0 && pRawMarket < 1) {
      obsRawMarket.push({ p: pRawMarket, outcome });
    }
  }
  if (unresolved > 0) console.log(`Markets excluded as unresolved/unfetchable: ${unresolved}.`);

  scoreEstimator('Φ model alone (p_phi)', obsPhi);
  scoreEstimator('Heuristic alone (p_heur)', obsHeur);
  scoreEstimator('Ensemble (model_prob)', obsEns);
  scoreEstimator('Raw Polymarket quote (poly_yes_price; non-executable probability benchmark)', obsRawMarket);

  // 1b. Forward-only paired challenger. All three probabilities are stamped
  // on the same signal, so model comparisons cannot be driven by different
  // market selection. Rows before the frozen evidence boundary are excluded.
  const challengerRows = await pool.query(`
    SELECT DISTINCT ON (market_id)
      market_id, model_prob, market_baseline_prob, residual_prob, poly_yes_price, created_at
    FROM signals
    WHERE user_id=$1 AND model_challenger_evidence_eligible=true
      AND model_challenger_experiment_id='main-model-challenger-v1'
      AND market_id IS NOT NULL
    ORDER BY market_id, created_at DESC
  `, [USER_ID]);
  const obsChallengerLegacy = [];
  const obsChallengerMarket = [];
  const obsChallengerResidual = [];
  const obsChallengerRawMarket = [];
  for (const row of challengerRows.rows) {
    const outcome = await fetchResolution(row.market_id);
    if (outcome == null) continue;
    const legacy = parseFloat(row.model_prob);
    const market = parseFloat(row.market_baseline_prob);
    const residual = parseFloat(row.residual_prob);
    const rawMarket = parseFloat(row.poly_yes_price);
    if (Number.isFinite(legacy)) obsChallengerLegacy.push({ p: legacy, outcome });
    if (Number.isFinite(market)) obsChallengerMarket.push({ p: market, outcome });
    if (Number.isFinite(residual)) obsChallengerResidual.push({ p: residual, outcome });
    if (Number.isFinite(rawMarket) && rawMarket > 0 && rawMarket < 1) {
      obsChallengerRawMarket.push({ p: rawMarket, outcome });
    }
  }
  console.log('\n━━━ Forward-only Main challenger (paired markets; PROVISIONAL) ━━━');
  scoreEstimator('Challenger legacy arm', obsChallengerLegacy);
  scoreEstimator('Challenger market baseline arm', obsChallengerMarket);
  scoreEstimator('Challenger residual arm', obsChallengerResidual);
  scoreEstimator('Challenger raw-market benchmark (measurement only)', obsChallengerRawMarket);

  // 2. Trade-level: executed trades, model_prob mapped to P(this trade's direction wins),
  //    scored against MARKET RESOLUTION (not close_reason — a stopped trade's own PnL
  //    conflates exit policy with model quality).
  const trades = await pool.query(`
    SELECT id, market_id, direction, model_prob
    FROM trades
    WHERE user_id = $1 AND status = 'closed' AND model_prob IS NOT NULL AND market_id IS NOT NULL
  `, [USER_ID]);
  const obsTrade = [];
  for (const t of trades.rows) {
    const outcome = await fetchResolution(t.market_id);
    if (outcome == null) continue;
    const mp = parseFloat(t.model_prob);
    if (!Number.isFinite(mp)) continue;
    const pWin = t.direction === 'NO' ? 1 - mp : mp;
    const won = t.direction === 'NO' ? 1 - outcome : outcome;
    obsTrade.push({ p: pWin, outcome: won });
  }
  const noProb = await pool.query(
    `SELECT COUNT(*) AS n FROM trades WHERE user_id=$1 AND status='closed' AND model_prob IS NULL`, [USER_ID]);
  console.log(`\nExecuted trades with model_prob: ${trades.rowCount} (${noProb.rows[0].n} historical trades have NULL model_prob and cannot be calibrated).`);
  scoreEstimator('Executed trades — P(direction wins) vs resolution', obsTrade);

  const totalObs = obsEns.length;
  console.log('\n━━━ Verdict guidance ━━━');
  if (totalObs < 100) {
    console.log(`  Only ${totalObs} resolved ensemble observations. Below ~100 the bucket CIs span most of [0,1];`);
    console.log('  below ~300 treat ANY conclusion as provisional. Do not tune parameters off this report yet.');
  } else {
    console.log('  If realized frequency is ~flat across buckets (CIs all overlapping the base rate),');
    console.log('  modelProb is uninformative and claimed EV is miscalibration, not edge.');
  }

  await pool.end();
}

run().catch((e) => { console.error('calibration failed:', e.message); pool.end(); process.exit(1); });
