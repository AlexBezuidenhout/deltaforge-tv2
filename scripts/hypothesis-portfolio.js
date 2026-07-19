#!/usr/bin/env node
/**
 * Read-only phase-separated verdict tooling for the eight H1–H8 shadow pilots.
 * Pilot output is machinery telemetry, never a promotion verdict. Evaluation
 * output applies the pre-registered 500-fill + 14-day + eight-test-adjusted CI.
 */
process.removeAllListeners('warning');
require('dotenv').config();
const { Pool } = require('pg');

const STRATEGIES = [
  'H1_pair_arb_2x', 'H2_cex_impulse_lag', 'H3_flow_confirmed',
  'H4_btc_leads_alts', 'H5_vol_expansion', 'H6_phi_overreaction',
  'H7_btc_oracle_confirm', 'H8_informed_maker',
];
const ALPHA = 0.05 / STRATEGIES.length;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

let rng = 0x6d2b79f5;
function random() {
  rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
  return rng / 0x100000000;
}

function bootstrapMeanCI(values, alpha = ALPHA, iterations = 20000) {
  if (values.length < 2) return [null, null];
  const means = new Array(iterations);
  for (let b = 0; b < iterations; b++) {
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[(random() * values.length) | 0];
    means[b] = sum / values.length;
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(iterations * alpha / 2)], means[Math.floor(iterations * (1 - alpha / 2))]];
}

function round(value, digits = 3) {
  return Number.isFinite(value) ? +value.toFixed(digits) : null;
}

function summarize(fills) {
  const p1 = fills.map((row) => parseFloat(row.pnl_1x)).filter(Number.isFinite);
  const p2 = fills.map((row) => parseFloat(row.pnl_2x)).filter(Number.isFinite);
  if (!p1.length) return { fills: 0 };
  const [ciLo, ciHi] = bootstrapMeanCI(p1);
  let equity = 0; let peak = 0; let maxDrawdown = 0;
  for (const value of p1) {
    equity += value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity - peak);
  }
  const half = Math.floor(p1.length / 2);
  const first = p1.slice(0, half).reduce((a, b) => a + b, 0);
  const second = p1.slice(half).reduce((a, b) => a + b, 0);
  return {
    fills: p1.length,
    wins: p1.filter((value) => value > 0).length,
    pnl1x: round(p1.reduce((a, b) => a + b, 0), 2),
    pnl2x: round(p2.reduce((a, b) => a + b, 0), 2),
    mean1x: round(p1.reduce((a, b) => a + b, 0) / p1.length),
    adjustedCI: [round(ciLo), round(ciHi)],
    firstHalfPnl: round(first, 2),
    secondHalfPnl: round(second, 2),
    maxDrawdown: round(maxDrawdown, 2),
  };
}

function pairSummary(rows) {
  const groups = new Map();
  for (const row of rows) {
    const id = row.features?.group_id;
    if (!id) continue;
    const group = groups.get(id) || [];
    group.push(row);
    groups.set(id, group);
  }
  let complete = 0; let singleLeg = 0; let noFill = 0; let p1 = 0; let p2 = 0;
  for (const group of groups.values()) {
    const fills = group.filter((row) => row.filled);
    if (fills.length >= 2) complete += 1;
    else if (fills.length === 1) singleLeg += 1;
    else noFill += 1;
    for (const fill of fills) {
      p1 += parseFloat(fill.pnl_1x) || 0;
      p2 += parseFloat(fill.pnl_2x) || 0;
    }
  }
  return { groups: groups.size, complete, singleLeg, noFill, pnl1x: round(p1, 2), pnl2x: round(p2, 2) };
}

async function main() {
  const { rows } = await pool.query(`
    SELECT o.id, o.ts, o.strategy, o.phase, o.market_id, o.token, o.order_kind, o.features,
      s.filled, s.fill_price, s.fill_size, s.fair_5s, s.fair_30s, s.pnl_1x, s.pnl_2x,
      m.asset, m.outcome
    FROM borg_shadow_orders o
    LEFT JOIN borg_shadow_scores s ON s.order_id=o.id
    LEFT JOIN borg_markets m ON m.id=o.market_id
    WHERE o.action='place' AND o.strategy = ANY($1)
    ORDER BY o.ts, o.id`, [STRATEGIES]);

  console.log(`H1–H8 SHADOW PORTFOLIO — ${new Date().toISOString()}`);
  console.log(`Adjusted interval: ${(100 * (1 - ALPHA)).toFixed(3)}% (Bonferroni across ${STRATEGIES.length} hypotheses)`);
  for (const strategy of STRATEGIES) {
    for (const phase of ['pilot', 'eval']) {
      const cohort = rows.filter((row) => row.strategy === strategy && row.phase === phase);
      if (!cohort.length && phase === 'eval') continue;
      const scored = cohort.filter((row) => row.filled != null);
      const fills = scored.filter((row) => row.filled);
      const first = cohort[0]?.ts ? new Date(cohort[0].ts) : null;
      const last = cohort.at(-1)?.ts ? new Date(cohort.at(-1).ts) : null;
      const days = first && last ? (last - first) / 86400000 : 0;
      const stats = summarize(fills);
      const nonfills = scored.filter((row) => !row.filled);
      const nonfillWins = nonfills.filter((row) => String(row.outcome).toUpperCase() === String(row.token).toUpperCase()).length;
      const verdict = phase === 'pilot' ? 'PILOT_NOT_EVIDENCE'
        : stats.fills >= 500 && days >= 14 && stats.adjustedCI?.[0] > 0 && stats.pnl2x > 0
          && stats.firstHalfPnl > 0 && stats.secondHalfPnl > 0 ? 'CANDIDATE_PASS' : 'NOT_READY_OR_FAIL';
      console.log(strategy, phase, {
        orders: cohort.length,
        scored: scored.length,
        fillRatePct: scored.length ? round(100 * fills.length / scored.length, 1) : null,
        nonfills: nonfills.length,
        nonfillWouldWinPct: nonfills.length ? round(100 * nonfillWins / nonfills.length, 1) : null,
        days: round(days, 2),
        ...stats,
        verdict,
      });
      if (strategy === 'H1_pair_arb_2x') console.log('  pair execution', pairSummary(cohort));
      if (strategy === 'H8_informed_maker' && fills.length) {
        const marks = (field) => fills.map((row) => row[field] == null ? null : parseFloat(row[field]) - parseFloat(row.fill_price)).filter(Number.isFinite);
        const m5 = marks('fair_5s'); const m30 = marks('fair_30s');
        console.log('  maker adverse selection', {
          fairMinusFill5s: m5.length ? round(m5.reduce((a, b) => a + b, 0) / m5.length, 4) : null,
          fairMinusFill30s: m30.length ? round(m30.reduce((a, b) => a + b, 0) / m30.length, 4) : null,
        });
      }
    }
  }
  console.log('Pilot P&L is machinery telemetry only. Do not pool it into a future evaluation.');
}

main()
  .catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => pool.end());

