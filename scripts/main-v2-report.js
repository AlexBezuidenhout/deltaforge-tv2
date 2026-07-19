#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const { clusteredBootstrap, clusterSignFlipPValue } = require('../borg/research/statistics');

const args = process.argv.slice(2);
const USER_ID = parseInt(args[args.indexOf('--user') + 1] || '1', 10) || 1;
const MAIN_V2 = 'MAIN_V2_resolver_quorum';
const DEVELOPMENTAL_PRECURSOR = 'H49_network_coinbase_chainlink_quorum';

function number(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 4) {
  const parsed = number(value);
  return parsed == null ? null : +parsed.toFixed(digits);
}

function summarizeLegacy(rows) {
  const valid = rows.filter((row) => number(row.pnl) != null && Math.abs(number(row.pnl)) < 100000);
  const pnl = valid.reduce((sum, row) => sum + number(row.pnl), 0);
  const stake = valid.reduce((sum, row) => sum + (number(row.trade_size) || 0), 0);
  return {
    closedTrades: valid.length,
    independentMarkets: new Set(valid.map((row) => String(row.market_id))).size,
    wins: valid.filter((row) => number(row.pnl) > 0).length,
    winRate: valid.length ? round(valid.filter((row) => number(row.pnl) > 0).length / valid.length) : null,
    netPnl: round(pnl, 2),
    returnOnStakedCapital: stake > 0 ? round(pnl / stake) : null,
  };
}

function summarizeShadow(rows) {
  const scored = rows.filter((row) => row.scored_at != null);
  const qualityValid = scored.filter((row) => row.data_quality_grade !== 'F');
  const filled = qualityValid.filter((row) => row.filled === true);
  const ordered = [...filled].sort((a, b) => new Date(a.available_at) - new Date(b.available_at));
  const split = Math.floor(ordered.length / 2);
  const sum = (sample, field) => sample.reduce((total, row) => total + (number(row[field]) || 0), 0);
  const bootstrap = clusteredBootstrap(filled, 'market_id', 'pnl_2x');
  return {
    intendedOrders: rows.length,
    scoredOrders: scored.length,
    independentMarkets: new Set(qualityValid.map((row) => String(row.market_id))).size,
    calendarDays: new Set(qualityValid.map((row) => new Date(row.available_at).toISOString().slice(0, 10))).size,
    dataQualityCoverage: scored.length ? round(qualityValid.length / scored.length) : null,
    fills: filled.length,
    fillRate: qualityValid.length ? round(filled.length / qualityValid.length) : null,
    pnl1x: round(sum(filled, 'pnl_1x'), 2),
    pnl2x: round(sum(filled, 'pnl_2x'), 2),
    firstHalfPnl2x: round(sum(ordered.slice(0, split), 'pnl_2x'), 2),
    secondHalfPnl2x: round(sum(ordered.slice(split), 'pnl_2x'), 2),
    meanPnl2xPerFill: round(bootstrap.mean),
    marketClusteredCi95: bootstrap.ci.map((value) => round(value)),
    oneSidedClusterSignFlipP: round(clusterSignFlipPValue(filled, 'market_id', 'pnl_2x'), 6),
  };
}

async function shadowRows(client, strategy) {
  const { rows } = await client.query(`
    SELECT o.id, o.market_id, o.available_at, o.phase, o.experiment_id,
           s.scored_at, COALESCE(s.filled, false) AS filled,
           COALESCE(s.data_quality_grade, 'F') AS data_quality_grade,
           COALESCE(s.execution_fidelity_grade, 'F') AS execution_fidelity_grade,
           s.pnl_1x, s.pnl_2x
    FROM borg_shadow_orders o
    LEFT JOIN borg_shadow_scores s ON s.order_id = o.id
    WHERE o.strategy = $1 AND o.action = 'place'
    ORDER BY o.available_at, o.id
  `, [strategy]);
  return rows;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true' },
    max: 2,
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows: settingsRows } = await client.query(`
      SELECT paper_trading, main_exec_honest_anchor, main_legacy_execution_enabled
      FROM bot_settings WHERE user_id=$1
    `, [USER_ID]);
    const settings = settingsRows[0] || {};
    const anchor = settings.main_exec_honest_anchor;
    const { rows: legacyRows } = await client.query(`
      SELECT market_id, asset, direction, trade_size, pnl, close_reason, created_at
      FROM trades
      WHERE user_id=$1 AND trade_type='signal' AND status='closed' AND pnl IS NOT NULL
      ORDER BY created_at, id
    `, [USER_ID]);

    const beforeAnchor = anchor
      ? legacyRows.filter((row) => new Date(row.created_at) < new Date(anchor))
      : legacyRows;
    const afterAnchor = anchor
      ? legacyRows.filter((row) => new Date(row.created_at) >= new Date(anchor))
      : [];
    const mainV2Rows = await shadowRows(client, MAIN_V2);
    const precursorRows = await shadowRows(client, DEVELOPMENTAL_PRECURSOR);
    const mainV2 = summarizeShadow(mainV2Rows);
    const precursor = summarizeShadow(precursorRows);

    const enoughSample = mainV2.independentMarkets >= 500 && mainV2.calendarDays >= 14;
    const stablePositive = mainV2.pnl2x > 0 && mainV2.firstHalfPnl2x > 0 && mainV2.secondHalfPnl2x > 0;
    const lowerBound = mainV2.marketClusteredCi95[0];
    const qualityPass = mainV2.dataQualityCoverage != null && mainV2.dataQualityCoverage >= 0.90;
    const verdict = !enoughSample
      ? 'INSUFFICIENT_FRESH_EVIDENCE'
      : qualityPass && stablePositive && lowerBound != null && lowerBound > 0
        ? 'ELIGIBLE_FOR_MULTIPLE_TESTING_ADJUSTMENT_AND_TINY_CANARY_REVIEW'
        : 'NO_DEMONSTRATED_EDGE_OR_REJECTED';

    console.log(JSON.stringify({
      format: 'main-v2-evidence-report-v1',
      createdAt: new Date().toISOString(),
      userId: USER_ID,
      safety: {
        paperTrading: settings.paper_trading !== false,
        legacyMainPaperExecutionEnabled: settings.main_legacy_execution_enabled === true,
        mainV2HasLiveOrderPath: false,
      },
      cohortBoundary: anchor,
      legacyMain: {
        contaminatedPreExecutableBookCohort: summarizeLegacy(beforeAnchor),
        executableBookForwardCohort: summarizeLegacy(afterAnchor),
        interpretation: 'Legacy headline PnL is not promotion evidence. The forward cohort tests entry quality after executable-book repair.',
      },
      developmentalPrecursor: {
        strategy: DEVELOPMENTAL_PRECURSOR,
        ...precursor,
        evidenceStatus: 'PILOT_ONLY_NOT_TRANSFERABLE_TO_MAIN_V2',
      },
      mainV2: {
        strategy: MAIN_V2,
        ...mainV2,
        minimumIndependentMarkets: 500,
        minimumCalendarDays: 14,
        verdict,
      },
      decisionRule: 'Require >=500 independent markets, >=14 days, >=90% non-F quality, positive 2x-cost PnL in both chronological halves, a market-clustered lower confidence bound above zero, and multiple-testing correction before any separate live canary review.',
      zeroEdgeDisclosure: 'A plausible and acceptable result is that the lower confidence bound includes zero and exploitable edge is approximately zero.',
    }, null, 2));
    await client.query('ROLLBACK');
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

module.exports = { summarizeLegacy, summarizeShadow };
