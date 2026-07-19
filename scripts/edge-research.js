#!/usr/bin/env node
/**
 * Read-only edge research report over the current Deltaforge/BORG database.
 *
 * The report deliberately separates:
 *   - pilot/development rows;
 *   - G_late_arb's frozen eval rows (the honest holdout);
 *   - paper-bot model calibration from execution realism;
 *   - the collector's short-retention tape from full market history.
 *
 * It does not update settings, place orders, score pending orders, or prune data.
 * Run: node scripts/edge-research.js
 */
process.removeAllListeners('warning');
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

let rngState = 0x71c84a2d;
function random() {
  rngState = (1664525 * rngState + 1013904223) >>> 0;
  return rngState / 0x100000000;
}

function bootstrapMeanCI(xs, alpha = 0.05, iterations = 20000) {
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

function stats(rows, pnlField = 'pnl_1x') {
  const pnls = rows.map((r) => parseFloat(r[pnlField])).filter(Number.isFinite);
  if (!pnls.length) return { n: 0 };
  const total = pnls.reduce((a, b) => a + b, 0);
  const [lo, hi] = bootstrapMeanCI(pnls);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const pnl of pnls) {
    equity += pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity - peak);
  }
  const pnl2 = rows.reduce((sum, r) => sum + (parseFloat(r.pnl_2x) || 0), 0);
  return {
    n: pnls.length,
    wins: pnls.filter((x) => x > 0).length,
    winPct: 100 * pnls.filter((x) => x > 0).length / pnls.length,
    total,
    mean: total / pnls.length,
    ciLo: lo,
    ciHi: hi,
    pnl2,
    maxDrawdown,
  };
}

function fmt(s) {
  if (!s.n) return 'n=0';
  const interval = s.ciLo == null || s.ciHi == null
    ? 'CI95=n/a'
    : `CI95=[$${s.ciLo.toFixed(3)}, $${s.ciHi.toFixed(3)}]`;
  return `n=${s.n}  W=${s.winPct.toFixed(1)}%  total=$${s.total.toFixed(2)}  ` +
    `mean=$${s.mean.toFixed(3)}  ${interval}  ` +
    `2x=$${s.pnl2.toFixed(2)}  maxDD=$${s.maxDrawdown.toFixed(2)}`;
}

function leadBps(row) {
  const px = parseFloat(row.features?.btc);
  const ref = parseFloat(row.features?.ref);
  return Number.isFinite(px) && Number.isFinite(ref) && ref > 0
    ? Math.abs(px - ref) / ref * 10000
    : null;
}

async function run() {
  console.log(`EDGE RESEARCH — ${new Date().toISOString()}\n`);

  const { rows: scoreboard } = await pool.query(`
    SELECT o.strategy, o.phase, count(*) FILTER (WHERE s.filled) n,
           round(sum(s.pnl_1x) FILTER (WHERE s.filled)::numeric, 2) pnl,
           max(o.ts) latest
    FROM borg_shadow_orders o
    LEFT JOIN borg_shadow_scores s ON s.order_id=o.id
    WHERE o.action='place'
    GROUP BY 1,2 ORDER BY 1,2`);
  console.log('━━━ Current BORG scoreboard ━━━');
  console.table(scoreboard);

  const { rows: g } = await pool.query(`
    SELECT o.ts, o.phase, o.market_id, o.token, o.price, o.tte_sec, o.features,
           s.pnl_1x, s.pnl_2x, m.asset
    FROM borg_shadow_orders o
    JOIN borg_shadow_scores s ON s.order_id=o.id AND s.filled
    JOIN borg_markets m ON m.id=o.market_id
    WHERE o.strategy='G_late_arb'
    ORDER BY o.ts`);
  const core = g.filter((r) => r.asset !== 'hype');
  const pilot = core.filter((r) => r.phase === 'pilot');
  const evaluation = core.filter((r) => r.phase === 'eval');

  console.log('\n━━━ G_late_arb: pilot must not be pooled with evaluation ━━━');
  console.log(`pilot core: ${fmt(stats(pilot))}`);
  console.log(`frozen eval core: ${fmt(stats(evaluation))}`);

  const byAsset = [...new Set(core.map((r) => r.asset))].sort();
  for (const asset of byAsset) {
    const dev = pilot.filter((r) => r.asset === asset);
    const val = evaluation.filter((r) => r.asset === asset);
    console.log(`${asset.padEnd(5)} pilot: ${fmt(stats(dev))}`);
    console.log(`${''.padEnd(5)} eval:  ${fmt(stats(val))}`);
  }

  // Mechanism-backed filters only. These were motivated before this script:
  // 0.85 = deployed live execution ceiling; 2bp = Q3 settlement-noise floor;
  // ETH = the only well-sampled asset positive in both development and holdout.
  // This is a hypothesis screen, not an exhaustive threshold optimizer.
  const candidates = {
    'all core': () => true,
    'ask <= 0.85': (r) => parseFloat(r.price) <= 0.85,
    'lead >= 2bp': (r) => leadBps(r) != null && leadBps(r) >= 2,
    'ask <= 0.85 AND lead >= 2bp': (r) => parseFloat(r.price) <= 0.85 && leadBps(r) != null && leadBps(r) >= 2,
    'ETH only': (r) => r.asset === 'eth',
    'ETH AND ask <= 0.85': (r) => r.asset === 'eth' && parseFloat(r.price) <= 0.85,
  };
  console.log('\n━━━ Pre-declared candidate screen: pilot → frozen eval holdout ━━━');
  for (const [name, keep] of Object.entries(candidates)) {
    console.log(`${name}\n  pilot ${fmt(stats(pilot.filter(keep)))}\n  eval  ${fmt(stats(evaluation.filter(keep)))}`);
  }

  const evalEth = evaluation.filter((r) => r.asset === 'eth');
  const half = Math.floor(evalEth.length / 2);
  console.log('\nETH eval chronology check:');
  console.log(`  first half  ${fmt(stats(evalEth.slice(0, half)))}`);
  console.log(`  second half ${fmt(stats(evalEth.slice(half)))}`);

  const { rows: vasili } = await pool.query(`
    SELECT o.ts, s.pnl_1x, s.pnl_2x, m.asset
    FROM borg_shadow_orders o
    JOIN borg_shadow_scores s ON s.order_id=o.id AND s.filled
    JOIN borg_markets m ON m.id=o.market_id
    WHERE o.strategy='Vasili' AND m.asset<>'hype'
    ORDER BY o.ts`);
  console.log(`\n━━━ Vasili core ━━━\n${fmt(stats(vasili))}`);

  const { rows: calibration } = await pool.query(`
    WITH last AS (
      SELECT DISTINCT ON (s.market_id)
        s.asset, s.model_prob::float p, s.p_phi::float phi,
        s.p_heur::float heur, s.yes_price::float px, m.outcome
      FROM signals s
      JOIN borg_markets m ON m.gamma_id=s.market_id
      WHERE s.created_at >= '2026-07-12T10:00:00Z'
        AND s.model_prob IS NOT NULL AND m.outcome IS NOT NULL
      ORDER BY s.market_id, s.created_at DESC
    ), z AS (
      SELECT *, CASE WHEN upper(outcome)='UP' THEN 1.0 ELSE 0.0 END y FROM last
    )
    SELECT coalesce(asset,'ALL') asset, count(*) n,
      round(avg((p-y)^2)::numeric,4) model_brier,
      round(avg((phi-y)^2)::numeric,4) phi_brier,
      round(avg((heur-y)^2)::numeric,4) heur_brier,
      round(avg((px-y)^2)::numeric,4) market_brier
    FROM z GROUP BY GROUPING SETS ((asset), ()) ORDER BY asset`);
  console.log('\n━━━ MAIN model calibration (one latest signal per resolved market) ━━━');
  console.table(calibration);

  const { rows: mainPaper } = await pool.query(`
    WITH x AS (
      SELECT t.*, m.outcome, coalesce(t.asset,m.asset,'btc') resolved_asset,
        t.trade_size::float stake, t.entry_price::float p,
        CASE WHEN (upper(t.direction) IN ('YES','UP') AND upper(m.outcome)='UP')
               OR (upper(t.direction) IN ('NO','DOWN') AND upper(m.outcome)='DOWN')
             THEN 1 ELSE 0 END win
      FROM trades t JOIN borg_markets m ON m.gamma_id=t.market_id
      WHERE t.created_at >= '2026-07-12T10:00:00Z' AND t.status='closed'
    ), z AS (
      SELECT *, stake/p*(win-p) - stake/p*0.07*p*(1-p) resolution_net FROM x
    )
    SELECT coalesce(resolved_asset,'ALL') asset, count(*) n, sum(win) wins,
      round(sum(pnl)::numeric,2) recorded_paper_pnl,
      round(sum(resolution_net)::numeric,2) resolution_net
    FROM z GROUP BY GROUPING SETS ((resolved_asset), ()) ORDER BY asset`);
  console.log('\nMAIN paper outcomes (informational only: execution is not exchange-confirmed):');
  console.table(mainPaper);

  const { rows: mainHonestRecent } = await pool.query(`
    WITH x AS (
      SELECT t.direction, m.outcome,
        t.entry_price::float paper_entry,
        CASE WHEN t.direction='YES' THEN snap.up_best_ask ELSE snap.down_best_ask END::float ask
      FROM trades t
      JOIN borg_markets m ON m.gamma_id=t.market_id
      CROSS JOIN LATERAL (
        SELECT b.* FROM borg_book_snaps b
        WHERE b.market_id=m.id AND abs(extract(epoch FROM (b.ts-t.created_at))) <= 2
        ORDER BY abs(extract(epoch FROM (b.ts-t.created_at))) LIMIT 1
      ) snap
      WHERE t.created_at >= now()-interval '2 hours' AND m.outcome IS NOT NULL
    ), z AS (
      SELECT *, CASE WHEN (direction='YES' AND outcome='UP')
                       OR (direction='NO' AND outcome='DOWN') THEN 1 ELSE 0 END win
      FROM x
    )
    SELECT count(*) observed,
      count(*) FILTER (WHERE ask BETWEEN .05 AND .96) exchange_fillable,
      sum(win) FILTER (WHERE ask BETWEEN .05 AND .96) wins,
      round(avg(abs(paper_entry-ask))::numeric,3) avg_entry_gap,
      round(percentile_cont(.5) WITHIN GROUP (ORDER BY abs(paper_entry-ask))::numeric,3) median_entry_gap,
      round(sum(CASE WHEN ask BETWEEN .05 AND .96
        THEN 10/ask*(win-ask)-10/ask*.07*ask*(1-ask) ELSE 0 END)::numeric,2) net
    FROM z`);
  console.log('MAIN current raw-tape overlap (2h retention; tiny but honest):');
  console.table(mainHonestRecent);

  const { rows: george } = await pool.query(`
    SELECT coalesce(entry_mode,'own') mode, coalesce(asset,'btc') asset,
      count(*) FILTER (WHERE status='closed') n,
      count(*) FILTER (WHERE status='closed' AND pnl>0) wins,
      round(sum(pnl) FILTER (WHERE status='closed')::numeric,2) pnl
    FROM george_trades GROUP BY 1,2 ORDER BY 1,2`);
  console.log('\n━━━ George (own signal is killed; resurrection is a new tiny cohort) ━━━');
  console.table(george);

  const { rows: q3 } = await pool.query(`
    WITH x AS (
      SELECT abs((binance_close-binance_open)/nullif(binance_open,0))*10000 move_bps,
        outcome,
        CASE WHEN binance_close >= binance_open THEN 'UP' ELSE 'DOWN' END predicted
      FROM borg_markets
      WHERE outcome IS NOT NULL AND binance_open IS NOT NULL AND binance_close IS NOT NULL
        AND binance_open_src='live' AND binance_close_src='live'
    )
    SELECT CASE WHEN move_bps<1 THEN '<1bp' WHEN move_bps<2 THEN '1-2bp'
                WHEN move_bps<5 THEN '2-5bp' WHEN move_bps<10 THEN '5-10bp'
                ELSE '>=10bp' END bucket,
      count(*) n, count(*) FILTER (WHERE outcome<>predicted) disagree,
      round(100.0*count(*) FILTER (WHERE outcome<>predicted)/count(*)::numeric,2) disagree_pct
    FROM x GROUP BY 1 ORDER BY min(move_bps)`);
  console.log('\n━━━ Collector Q3: Binance sign vs settlement ━━━');
  console.table(q3);

  const { rows: recentFlow } = await pool.query(`
    WITH x AS (
      SELECT m.asset, t.price::float p, t.size::float sz,
        CASE WHEN t.asset_id=m.up_token_id THEN 'UP' ELSE 'DOWN' END token, m.outcome
      FROM borg_taker_trades t JOIN borg_markets m ON m.condition_id=t.condition_id
      WHERE t.side='BUY' AND m.outcome IS NOT NULL
        AND extract(epoch FROM (m.window_end-t.ts)) BETWEEN 5 AND 75
        AND t.ts >= now()-interval '2 hours'
    )
    SELECT asset, count(*) n, round(sum(sz*p)::numeric,2) notional,
      round(sum(sz*((CASE WHEN upper(token)=upper(outcome) THEN 1 ELSE 0 END)-p)
                    - sz*.07*p*(1-p))::numeric,2) net,
      round((100*sum(sz*((CASE WHEN upper(token)=upper(outcome) THEN 1 ELSE 0 END)-p)
                    - sz*.07*p*(1-p))/nullif(sum(sz*p),0))::numeric,2) roi_pct
    FROM x GROUP BY 1 ORDER BY 1`);
  console.log('\n━━━ Collector market-wide BUY takers, tte 5-75s (rolling 2h only) ━━━');
  console.table(recentFlow);

  console.log('\n━━━ Interpretation guardrails ━━━');
  console.log('- G lifetime CONFIRM pools pilot and eval. The frozen eval cohort is the current truth.');
  console.log('- ETH late-window continuation is the only candidate positive in pilot and eval, but was selected after looking across assets.');
  console.log('- MAIN has probability signal (heuristic Brier beats market), but its paper PnL is not proof until exact real-book entries are forward shadowed.');
  console.log('- Raw book/taker tables retain about 2 hours; current-flow rows are regime checks, never long-horizon evidence.');
  console.log('- Any data-derived specialization needs a fresh forward evaluation clock; do not rewrite the old eval label.');

  await pool.end();
}

run().catch(async (err) => {
  console.error(err.stack || err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
