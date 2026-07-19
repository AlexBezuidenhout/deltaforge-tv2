#!/usr/bin/env node
/**
 * G_late_arb phase-separated verdict report.
 *
 * The historical n=300 rule (registered 2026-07-12, commit 47cc0fc;
 * refined in borg/NEXT.md §2b) applies ONLY to the pilot cohort that opened
 * the parameter-freeze stamp. The post-freeze `eval` cohort is printed
 * separately against EVAL_PROTOCOL.md's 500-fill + 14-day standard. Pooling
 * those phases once made current losses look like persistent profitability.
 *
 * THE READ IS MECHANICAL — this script IS the pre-registration. Do not edit
 * thresholds after data exists. Criteria, verbatim:
 *   CONFIRM: fills >= 300 AND per-fill mean (pnl_1x) > $0.40
 *            AND worst single-market P&L > -$30
 *   KILL:    fills >= 300 AND per-fill mean < $0.10
 *   else:    CONTINUE (gray zone $0.10-$0.40 — keep collecting, re-read at 500
 *            per EVAL_PROTOCOL sample rules)
 * Constraints that ride along regardless of verdict:
 *   - 1x stake forever (pnl_2x - pnl_1x already proved marginal size negative)
 *   - hype judged separately at its own n=300 (excluded from headline mean)
 *   - Q3 cross-check: near-flat-window cohort (phi built on <2bp projected
 *     move) reported separately — informational at this read, not a criterion.
 *
 * Run anytime: node scripts/g-verdict.js
 */
process.removeAllListeners('warning');
const { Pool } = require('pg');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

function bootstrapCI(xs, n = 10000, alpha = 0.05) {
  if (xs.length < 2) return [null, null];
  const means = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < xs.length; j++) s += xs[(Math.random() * xs.length) | 0];
    means[i] = s / xs.length;
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(n * alpha / 2)], means[Math.floor(n * (1 - alpha / 2))]];
}

function summarize(rows, alpha = 0.05) {
  const pnl1 = rows.map((f) => parseFloat(f.pnl_1x));
  const pnl2 = rows.map((f) => parseFloat(f.pnl_2x));
  const total = pnl1.reduce((a, b) => a + b, 0);
  const [lo, hi] = bootstrapCI(pnl1, 10000, alpha);
  const byMarket = new Map();
  for (const f of rows) byMarket.set(f.market_id, (byMarket.get(f.market_id) || 0) + parseFloat(f.pnl_1x));
  return {
    n: rows.length,
    total,
    mean: rows.length ? total / rows.length : 0,
    lo,
    hi,
    pnl2: pnl2.reduce((a, b) => a + b, 0),
    worstMarket: byMarket.size ? Math.min(...byMarket.values()) : null,
  };
}

function printStats(label, s, ciLabel = 'CI95') {
  const ci = s.lo == null ? 'n/a' : `[$${s.lo.toFixed(4)}, $${s.hi.toFixed(4)}]`;
  console.log(`${label}: n=${s.n} mean/fill=$${s.mean.toFixed(4)} total=$${s.total.toFixed(2)} ${ciLabel}=${ci} 2x=$${s.pnl2.toFixed(2)} worst-market=${s.worstMarket == null ? 'n/a' : '$' + s.worstMarket.toFixed(2)}`);
}

async function main() {
  const { rows: fills } = await pool.query(`
    SELECT s.pnl_1x, s.pnl_2x, o.market_id, o.phase, o.ts, m.asset,
           (o.features->>'sigma')::float AS sigma,
           (o.features->>'btc')::float AS px,
           (o.features->>'ref')::float AS ref
    FROM borg_shadow_scores s
    JOIN borg_shadow_orders o ON o.id = s.order_id
    JOIN borg_markets m ON m.id = o.market_id
    WHERE o.strategy = 'G_late_arb' AND s.filled`);

  const core = fills.filter((f) => f.asset !== 'hype');
  const pilot = core.filter((f) => f.phase === 'pilot');
  const evaluation = core.filter((f) => f.phase === 'eval');
  const hype = fills.filter((f) => f.asset === 'hype');
  const frozen = summarize(pilot);
  const current = summarize(evaluation);
  const currentAdjusted = summarize(evaluation, 0.05 / 6);

  // 2x sanity for the historical freeze cohort (should stay negative-marginal)
  const marginal = pilot.reduce((a, f) => a + (parseFloat(f.pnl_2x) - parseFloat(f.pnl_1x)), 0);

  // Q3 near-flat cohort: projected move at entry < 2bp of ref
  const flat = evaluation.filter((f) => f.px && f.ref && Math.abs(f.px - f.ref) / f.ref * 10000 < 2);
  const flatPnl = flat.reduce((a, f) => a + parseFloat(f.pnl_1x), 0);

  const hypePnl = hype.reduce((a, f) => a + parseFloat(f.pnl_1x), 0);

  console.log('═══ G_late_arb phase-separated read ═══');
  console.log('HISTORICAL PARAMETER-FREEZE COHORT (pilot; this is what opened the original stamp):');
  printStats('pilot core', frozen);
  console.log(`pilot marginal-size check (2x−1x): $${marginal.toFixed(2)} ${marginal < 0 ? '(negative — 1x cap stands)' : '(positive — investigate)'}`);
  console.log('');
  console.log('CURRENT FROZEN EVALUATION (the only cohort relevant to profitability now):');
  printStats('eval core', current);
  printStats('eval core, six-asset adjusted', currentAdjusted, 'CI99.17');
  console.log(`eval near-flat cohort (<2bp projected move, Q3 flag): n=${flat.length}, pnl $${flatPnl.toFixed(2)} — informational`);
  console.log(`hype (judged separately): n=${hype.length}, pnl $${hypePnl.toFixed(2)} — own read at n=300 hype fills`);
  console.log('');

  if (frozen.n < 300) {
    console.log(`HISTORICAL FREEZE VERDICT: NOT YET — n=${frozen.n} < 300.`);
  } else if (frozen.mean > 0.40 && frozen.worstMarket > -30) {
    console.log(`HISTORICAL FREEZE VERDICT: CONFIRM — pilot mean $${frozen.mean.toFixed(2)} > $0.40 AND worst market $${frozen.worstMarket.toFixed(2)} > −$30.`);
    // --stamp writes the live-executor gate file. Output artifact only —
    // criteria above are frozen; the stamp can only ever follow a CONFIRM.
    if (process.argv.includes('--stamp')) {
      const fs = require('fs'); const path = require('path');
      const f = path.join(__dirname, '../borg/live/VERDICT_CONFIRMED');
      fs.writeFileSync(f, `CONFIRM ${new Date().toISOString()} phase=pilot n=${frozen.n} mean=${frozen.mean.toFixed(4)} ci=[${frozen.lo?.toFixed(4)},${frozen.hi?.toFixed(4)}] worst=${frozen.worstMarket.toFixed(2)}\n`);
      console.log(`Stamped ${f} — live executor gate 1 now open.`);
    }
  } else if (frozen.mean < 0.10) {
    console.log(`HISTORICAL FREEZE VERDICT: KILL — pilot mean $${frozen.mean.toFixed(2)} < $0.10.`);
  } else {
    console.log(`HISTORICAL FREEZE VERDICT: CONTINUE — pilot mean $${frozen.mean.toFixed(2)} or worst-market $${frozen.worstMarket?.toFixed(2)} missed the frozen bar.`);
  }
  console.log('');
  if (current.n < 500) {
    console.log(`CURRENT EVAL STATUS: NOT READY — n=${current.n}/500 and the 14-day clock is not complete.`);
  } else if (current.lo > 0 && current.pnl2 > 0) {
    console.log('CURRENT EVAL STATUS: candidate pass on expectancy/cost checks; still verify 14 days, both halves, and adjusted CI per EVAL_PROTOCOL.');
  } else {
    console.log('CURRENT EVAL STATUS: DOES NOT PASS — current expectancy is not robustly above zero after costs.');
  }
  if (current.mean <= 0 || current.lo <= 0) {
    console.log('LIVE INTERPRETATION: current frozen data does not support profitable real-money deployment; keep the mirror paper-only.');
  }
  await pool.end();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
