#!/usr/bin/env node
'use strict';

const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const {
  clusteredBootstrap, clusterSignFlipPValue, holmAdjust, wilsonInterval,
} = require('../borg/research/statistics');

function number(value, fallback = 0) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function round(value, places = 6) {
  return value == null || !Number.isFinite(Number(value)) ? null : +Number(value).toFixed(places);
}
function sum(rows, key) { return rows.reduce((total, row) => total + number(row[key]), 0); }

function summarizeArm(rows) {
  const filled = rows.filter((row) => row.first_fill_at);
  const scored = filled.filter((row) => row.total_pnl != null);
  const sorted = [...scored].sort((left, right) => new Date(left.closed_at) - new Date(right.closed_at));
  const split = Math.floor(sorted.length / 2);
  const firstHalf = sorted.slice(0, split);
  const secondHalf = sorted.slice(split);
  const wins = scored.filter((row) => number(row.total_pnl) > 0).length;
  const clusteredRows = scored.map((row) => ({
    ...row,
    cluster: `${row.condition_id}|${new Date(row.closed_at).toISOString().slice(0, 10)}`,
  }));
  const bootstrap = clusteredBootstrap(clusteredRows, 'cluster', 'pnl_2x', { iterations: 10000 });
  const rawP = clusterSignFlipPValue(clusteredRows, 'cluster', 'pnl_2x', { iterations: 20000 });
  const dates = new Set(filled.map((row) => new Date(row.first_fill_at).toISOString().slice(0, 10)));
  const markets = new Set(filled.map((row) => row.condition_id));
  return {
    arm: rows[0]?.arm || null,
    cycles: rows.length,
    filledCycles: filled.length,
    scoredCycles: scored.length,
    independentMarkets: markets.size,
    calendarDays: dates.size,
    mergedCycles: filled.filter((row) => number(row.merged_shares) > 0).length,
    orphanExitCycles: filled.filter((row) => row.orphan_exit_price != null).length,
    unscoredOrOpenCycles: filled.length - scored.length,
    mergeRate: filled.length ? round(filled.filter((row) => number(row.merged_shares) > 0).length / filled.length) : null,
    closedWinRate: scored.length ? round(wins / scored.length) : null,
    closedWinWilson95: wilsonInterval(wins, scored.length).map((value) => round(value)),
    mergedShares: round(sum(rows, 'merged_shares')),
    lockedPnl: round(sum(rows, 'locked_pnl')),
    orphanPnl: round(sum(rows, 'orphan_pnl')),
    realizedPnl: round(sum(scored, 'total_pnl')),
    modeledLiquidityReward: round(sum(rows, 'modeled_reward_accrual')),
    modeledRewardAdjustedPnl: round(sum(scored, 'total_pnl') + sum(scored, 'modeled_reward_accrual')),
    rewardQualifiedHours: round(sum(rows, 'reward_qualified_ms') / 3_600_000),
    rewardAccounting: 'MODELED_FROM_PUBLIC_L2_NOT_REALIZED_OR_CLAIMED',
    pnl2xExecutionStress: round(sum(scored, 'pnl_2x')),
    firstHalfPnl2x: round(sum(firstHalf, 'pnl_2x')),
    secondHalfPnl2x: round(sum(secondHalf, 'pnl_2x')),
    clusterMeanPnl2x: round(bootstrap.mean),
    clusterCi95Pnl2x: bootstrap.ci.map((value) => round(value)),
    rawOneSidedClusterP: round(rawP, 8),
    _rawP: rawP,
    provisional: markets.size < 300 || dates.size < 30,
  };
}

function summarize(rows, options = {}) {
  const byArm = new Map();
  for (const raw of rows) {
    const row = {
      ...raw,
      total_pnl: raw.total_pnl == null ? null : number(raw.total_pnl),
      locked_pnl: number(raw.locked_pnl),
      orphan_pnl: number(raw.orphan_pnl),
      merged_shares: number(raw.merged_shares),
      orphan_exit_fees: number(raw.orphan_exit_fees),
      maker_fees: number(raw.maker_fees),
      exit_shares: number(raw.exit_shares),
      tick_size: number(raw.tick_size, 0.01),
      modeled_reward_accrual: number(raw.modeled_reward_accrual),
      reward_qualified_ms: number(raw.reward_qualified_ms),
    };
    row.pnl_2x = row.total_pnl == null ? null
      : row.total_pnl - row.maker_fees - row.orphan_exit_fees - row.exit_shares * row.tick_size;
    const group = byArm.get(row.arm) || [];
    group.push(row); byArm.set(row.arm, group);
  }
  const arms = [...byArm.values()].map(summarizeArm);
  const adjusted = holmAdjust(arms.map((arm) => arm._rawP));
  arms.forEach((arm, index) => {
    arm.holmAdjustedClusterP = round(adjusted[index], 8);
    arm.promotionRead = !arm.provisional
      && arm.firstHalfPnl2x > 0 && arm.secondHalfPnl2x > 0
      && arm.clusterCi95Pnl2x[0] > 0 && arm.holmAdjustedClusterP < 0.05
      ? 'MECHANICALLY_ELIGIBLE_FOR_SEPARATE_REVIEW_NOT_LIVE_AUTHORIZATION'
      : 'NOT_VALIDATED';
    delete arm._rawP;
  });
  return {
    format: 'paired-complete-set-maker-report-v3',
    generatedAt: new Date().toISOString(),
    experimentId: options.experimentId || rows[0]?.experiment_id || null,
    accounting: 'Promotion PnL is closed-cycle execution PnL only. The 2x view doubles charged fees and adds one adverse tick to orphan exits. Public-L2 liquidity reward estimates are shown separately and cannot support promotion.',
    warning: 'Arms reuse the same tape and each represent a separate $500 counterfactual. Never sum arm PnL.',
    incentiveWarning: 'Modeled liquidity rewards are neither account-attributed nor claimed. Maker rebates remain zero until authenticated fill/rebate reconciliation exists.',
    zeroEdgeDisclosure: 'If orphan losses consume locked spread or the clustered interval includes zero, the accepted conclusion is that exploitable edge is approximately zero.',
    arms,
  };
}

async function main() {
  const experimentArg = process.argv.find((item) => item.startsWith('--experiment='));
  const experimentId = experimentArg?.slice('--experiment='.length)
    || process.env.PAIRED_MAKER_REPORT_EXPERIMENT
    || 'paired-complete-set-maker-v3-rewards';
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 1,
  });
  try {
    const { rows } = await pool.query(`
      SELECT c.*,
             COALESCE(x.exit_shares,0) exit_shares,
             COALESCE((c.detail->'makerFees'->>0)::numeric,0)
               + COALESCE((c.detail->'makerFees'->>1)::numeric,0) maker_fees,
             COALESCE(m.tick_size,0.01) tick_size
        FROM pmm_cycles c
        LEFT JOIN pmm_markets m USING (condition_id)
        LEFT JOIN (
          SELECT cycle_id,COALESCE(sum(size),0) exit_shares
            FROM pmm_events WHERE event_type='ORPHAN_EXIT' GROUP BY cycle_id
        ) x USING (cycle_id)
       WHERE c.experiment_id=$1
       ORDER BY c.opened_at,c.cycle_id
    `, [experimentId]);
    console.log(JSON.stringify(summarize(rows, { experimentId }), null, 2));
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

module.exports = { number, summarize, summarizeArm };
