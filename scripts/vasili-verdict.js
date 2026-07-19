#!/usr/bin/env node
/**
 * Vasili (Thesis V) pre-registered n=300 verdict — frozen 2026-07-13 at
 * registration, BEFORE any Vasili data existed. Do not edit thresholds.
 *
 *   CONFIRM: core fills >= 300 AND per-fill mean (pnl_1x) > $0.40
 *            AND worst single-market P&L > -$30
 *   KILL:    core fills >= 300 AND per-fill mean < $0.10
 *   else:    CONTINUE — re-read at n=500.
 * Constraints: 1x stake forever; hype judged separately at its own n=300.
 * Also reports direction-call accuracy separately from P&L — the registered
 * prediction is that accuracy will be high while profit is ~zero (the ask
 * already prices the lead). Distinguishing those two outcomes is the point.
 *
 * Run anytime: node scripts/vasili-verdict.js
 */
process.removeAllListeners('warning');
const { Pool } = require('pg');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

function bootstrapCI(xs, n = 10000) {
  if (xs.length < 2) return [null, null];
  const means = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < xs.length; j++) s += xs[(Math.random() * xs.length) | 0];
    means[i] = s / xs.length;
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(n * 0.025)], means[Math.floor(n * 0.975)]];
}

async function main() {
  const { rows: fills } = await pool.query(`
    SELECT s.pnl_1x, s.pnl_2x, s.outcome, o.token, o.market_id, m.asset
    FROM borg_shadow_scores s
    JOIN borg_shadow_orders o ON o.id = s.order_id
    JOIN borg_markets m ON m.id = o.market_id
    WHERE o.strategy = 'Vasili' AND s.filled`);

  const core = fills.filter((f) => f.asset !== 'hype');
  const hype = fills.filter((f) => f.asset === 'hype');
  const pnls = core.map((f) => parseFloat(f.pnl_1x));
  const n = pnls.length;
  const mean = pnls.reduce((a, b) => a + b, 0) / (n || 1);
  const [lo, hi] = bootstrapCI(pnls);
  const correct = core.filter((f) => f.outcome === f.token).length;

  const byMkt = new Map();
  for (const f of core) byMkt.set(f.market_id, (byMkt.get(f.market_id) || 0) + parseFloat(f.pnl_1x));
  const worst = byMkt.size ? Math.min(...byMkt.values()) : 0;
  const marginal = fills.reduce((a, f) => a + (parseFloat(f.pnl_2x) - parseFloat(f.pnl_1x)), 0);
  const hypePnl = hype.reduce((a, f) => a + parseFloat(f.pnl_1x), 0);

  console.log('═══ Vasili (Thesis V) pre-registered read ═══');
  console.log(`core fills (ex-hype): ${n}   mean/fill: $${mean.toFixed(4)}   bootstrap 95% CI: [$${lo?.toFixed(4)}, $${hi?.toFixed(4)}]`);
  console.log(`direction-call accuracy: ${n ? (100 * correct / n).toFixed(1) : '—'}% (${correct}/${n}) — registered prediction: high accuracy, ~zero profit`);
  console.log(`total core pnl: $${pnls.reduce((a, b) => a + b, 0).toFixed(2)}   worst single market: $${worst.toFixed(2)}`);
  console.log(`marginal-size check (pnl_2x−pnl_1x): $${marginal.toFixed(2)} ${marginal < 0 ? '(negative — 1x cap stands)' : '(POSITIVE?! re-examine)'}`);
  console.log(`hype (judged separately): n=${hype.length}, pnl $${hypePnl.toFixed(2)}`);
  console.log('');

  if (n < 300) {
    console.log(`VERDICT: NOT YET — n=${n} < 300. Interim view only; the read fires at 300.`);
  } else if (mean > 0.40 && worst > -30) {
    console.log(`VERDICT: CONFIRM — mean $${mean.toFixed(2)} > $0.40 AND worst market $${worst.toFixed(2)} > −$30. Registered prediction was WRONG; value survives at the ask.`);
  } else if (mean < 0.10) {
    console.log(`VERDICT: KILL — mean $${mean.toFixed(2)} < $0.10. Registered prediction held: the ask prices the lead.`);
  } else {
    console.log(`VERDICT: CONTINUE — mean $${mean.toFixed(2)} in gray zone or worst-market breach ($${worst.toFixed(2)}); re-read at n=500.`);
  }
  await pool.end();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
