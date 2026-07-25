#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const serviceEnv = process.env.TV2_ENV_FILE || '/etc/deltaforge/tv2.env';
if (!process.env.DATABASE_URL && fs.existsSync(serviceEnv)) {
  require('dotenv').config({ path: serviceEnv });
}
const { Pool } = require('pg');
const {
  TERMINAL_CARRY_EXPERIMENT_ID,
} = require('../borg/crossvenue/terminal-carry');

function finite(value, fallback = null) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function summarize(values) {
  const rows = values.filter(Number.isFinite);
  if (!rows.length) return {
    n: 0, sum: 0, mean: null, standardError: null, lower95: null,
  };
  const sum = rows.reduce((total, value) => total + value, 0);
  const mean = sum / rows.length;
  const variance = rows.length > 1
    ? rows.reduce((total, value) => total + (value - mean) ** 2, 0) / (rows.length - 1)
    : null;
  const standardError = variance == null ? null : Math.sqrt(variance / rows.length);
  return {
    n: rows.length,
    sum,
    mean,
    standardError,
    lower95: standardError == null ? null : mean - 1.96 * standardError,
  };
}

function outcomePayout(row) {
  const poly = String(row.poly_outcome || '').toUpperCase();
  const kalshi = String(row.kalshi_result || '').toUpperCase();
  if (!['YES', 'NO'].includes(poly) || !['YES', 'NO'].includes(kalshi)) return null;
  const quantity = finite(row.quantity);
  if (!(quantity > 0)) return null;
  return quantity * (
    Number(poly === String(row.selected_poly_outcome || '').toUpperCase())
    + Number(kalshi === String(row.selected_kalshi_outcome || '').toUpperCase())
  );
}

function metrics(rows) {
  const scored = rows.map((row) => {
    const payout = outcomePayout(row);
    if (payout == null) return null;
    const totalCost = finite(row.total_cost, 0);
    const additional = finite(row.additional_cost_stress, 0);
    const orphan = finite(row.orphan_reserve, 0);
    return {
      ...row,
      payout,
      pnl1x: payout - totalCost,
      pnl2x: payout - totalCost - additional,
      fullHurdlePnl: payout - totalCost - additional - orphan,
      venuesAgreed: String(row.poly_outcome).toUpperCase()
        === String(row.kalshi_result).toUpperCase(),
    };
  }).filter(Boolean);
  const midpoint = Math.ceil(scored.length / 2);
  return {
    entries: rows.length,
    settled: scored.length,
    profitable1x: scored.filter((row) => row.pnl1x > 0).length,
    venueAgreement: scored.filter((row) => row.venuesAgreed).length,
    pnl1x: summarize(scored.map((row) => row.pnl1x)),
    pnl2x: summarize(scored.map((row) => row.pnl2x)),
    fullHurdlePnl: summarize(scored.map((row) => row.fullHurdlePnl)),
    chronologicalHalves: {
      first: summarize(scored.slice(0, midpoint).map((row) => row.pnl2x)),
      second: summarize(scored.slice(midpoint).map((row) => row.pnl2x)),
    },
    scored,
  };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error(`DATABASE_URL is missing; set it in .env or ${serviceEnv}`);
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost')
      ? false : { rejectUnauthorized: false },
    max: 1,
  });
  try {
    const { rows } = await pool.query(`
      SELECT t.observed_at,t.entry_day,t.match_id,t.direction,
             t.poly_outcome selected_poly_outcome,
             t.kalshi_outcome selected_kalshi_outcome,
             t.quantity,t.total_cost,t.additional_cost_stress,t.orphan_reserve,
             t.expected_profit_lower,t.agreement_lower,t.prior_clusters,
             s.poly_outcome,s.kalshi_result,
             COALESCE(NULLIF(m.kalshi_event_ticker,''),m.kalshi_ticker) kalshi_event,
             COALESCE(NULLIF(m.metadata->'poly'->>'eventTitle',''),m.poly_condition_id) poly_event
        FROM cv_terminal_carry_marks t
        JOIN cv_contract_matches m USING (match_id)
        LEFT JOIN cv_settlements s USING (match_id)
       WHERE t.experiment_id=$1 AND t.entry_armed=true
       ORDER BY t.observed_at
    `, [TERMINAL_CARRY_EXPERIMENT_ID]);
    const overall = metrics(rows);
    const byDirection = Object.fromEntries([...new Set(rows.map((row) => row.direction))]
      .map((direction) => [direction, metrics(rows.filter((row) => row.direction === direction))]));

    const clusterDay = new Map();
    for (const row of overall.scored) {
      const key = `${row.kalshi_event}\u0000${row.poly_event}\u0000${row.entry_day}`;
      clusterDay.set(key, (clusterDay.get(key) || 0) + row.pnl2x);
    }
    const days = new Set(rows.map((row) => String(row.entry_day))).size;
    const clusterDayPnl = summarize([...clusterDay.values()]);
    const dominantPositiveClusterShare = [...clusterDay.values()]
      .filter((value) => value > 0).sort((left, right) => right - left);
    const totalPositive = dominantPositiveClusterShare
      .reduce((sum, value) => sum + value, 0);
    const dominantShare = totalPositive > 0
      ? dominantPositiveClusterShare[0] / totalPositive : null;
    const promotion = {
      minimumFreshUnits: rows.length >= 300,
      minimum30CalendarDays: days >= 30,
      bothChronologicalHalvesPositive: overall.chronologicalHalves.first.sum > 0
        && overall.chronologicalHalves.second.sum > 0,
      clusterDayLower95AboveZero: clusterDayPnl.lower95 != null
        && clusterDayPnl.lower95 > 0,
      noDominantEventDay: dominantShare != null && dominantShare <= 0.2,
      latencyRobustness: 'PENDING_REPLAY_100_250_500MS',
      multipleTestingCorrection: 'PENDING_FAMILY_LEVEL_PROMOTION_REPORT',
      passed: false,
    };
    promotion.passed = Object.values(promotion).every((value) => value === true);

    const report = {
      generatedAt: new Date().toISOString(),
      experimentId: TERMINAL_CARRY_EXPERIMENT_ID,
      paperOnly: true,
      deterministicArbitrage: false,
      independentUnit: 'match + direction + UTC entry day',
      coverage: {
        entries: rows.length,
        settled: overall.settled,
        calendarDays: days,
        eventDayClusters: clusterDay.size,
        firstAt: rows[0]?.observed_at || null,
        lastAt: rows.at(-1)?.observed_at || null,
      },
      overall: {
        entries: overall.entries,
        settled: overall.settled,
        profitable1x: overall.profitable1x,
        venueAgreement: overall.venueAgreement,
        pnl1x: overall.pnl1x,
        pnl2x: overall.pnl2x,
        fullHurdlePnl: overall.fullHurdlePnl,
        chronologicalHalves: overall.chronologicalHalves,
      },
      byDirection: Object.fromEntries(Object.entries(byDirection).map(([key, value]) => [
        key,
        {
          entries: value.entries,
          settled: value.settled,
          profitable1x: value.profitable1x,
          venueAgreement: value.venueAgreement,
          pnl1x: value.pnl1x,
          pnl2x: value.pnl2x,
          fullHurdlePnl: value.fullHurdlePnl,
        },
      ])),
      clusterDayPnl2x: clusterDayPnl,
      dominantPositiveClusterShare: dominantShare,
      promotion,
      warning: 'Paper entry assumes both displayed legs fill. It is not a certified terminal identity, venue legs are non-atomic, and the normal cluster-day lower bound is only interpretable after the pre-registered sample minimum.',
    };

    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log('CROSS-VENUE RESOLVER-RISK TERMINAL CARRY');
    console.log(`Generated: ${report.generatedAt}`);
    console.log('PAPER ONLY · NOT DETERMINISTIC ARBITRAGE');
    console.table([report.coverage]);
    console.table(Object.entries(report.byDirection).map(([direction, row]) => ({
      direction,
      entries: row.entries,
      settled: row.settled,
      profitable1x: row.profitable1x,
      venueAgreement: row.venueAgreement,
      pnl1x: row.pnl1x.sum,
      pnl2x: row.pnl2x.sum,
      fullHurdlePnl: row.fullHurdlePnl.sum,
    })));
    console.table([{
      eventDayClusters: clusterDayPnl.n,
      mean2x: clusterDayPnl.mean,
      lower95: clusterDayPnl.lower95,
      dominantPositiveShare: dominantShare,
    }]);
    console.table([promotion]);
    console.log(report.warning);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = { finite, metrics, outcomePayout, summarize };
