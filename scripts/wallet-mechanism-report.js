#!/usr/bin/env node
'use strict';

const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DATA_API = 'https://data-api.polymarket.com';
const DEFAULT_WALLET = '0x2c335066fe58fe9237c3d3dc7b275c2a034a0563';
const PERIOD_SECONDS = Object.freeze({ DAY: 86_400, WEEK: 7 * 86_400, MONTH: 30 * 86_400 });
const LEADERBOARD_PERIODS = Object.freeze(['DAY', 'WEEK', 'MONTH', 'ALL']);
const LEADERBOARD_CATEGORIES = Object.freeze(['OVERALL', 'SPORTS', 'ESPORTS', 'CRYPTO', 'POLITICS', 'FINANCE']);
const ACTIVITY_TYPES = Object.freeze(['MERGE', 'SPLIT', 'REDEEM', 'REWARD', 'MAKER_REBATE', 'CONVERSION']);

function number(value, fallback = 0) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function round(value, places = 4) {
  return value == null || !Number.isFinite(Number(value)) ? null : +Number(value).toFixed(places);
}
function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function notional(trade) { return Math.max(0, number(trade?.size)) * Math.max(0, number(trade?.price)); }

async function fetchJson(url, timeoutMs = 20_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

async function fetchPaged(pathname, params, options = {}) {
  const pageSize = Number(options.pageSize || 500);
  const maxRows = Number(options.maxRows || 10_000);
  const rows = [];
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const url = new URL(`${DATA_API}${pathname}`);
    for (const [key, value] of Object.entries({ ...params, limit: pageSize, offset })) {
      url.searchParams.set(key, String(value));
    }
    const page = await fetchJson(url);
    if (!Array.isArray(page)) break;
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return { rows: rows.slice(0, maxRows), truncated: rows.length >= maxRows };
}

function summarizeActivity(rows, nowSec = Math.floor(Date.now() / 1000)) {
  const output = {};
  for (const period of LEADERBOARD_PERIODS) {
    const start = period === 'ALL' ? -Infinity : nowSec - PERIOD_SECONDS[period];
    const selected = rows.filter((row) => number(row.timestamp, -Infinity) >= start);
    output[period] = {
      actions: selected.length,
      usd: round(selected.reduce((sum, row) => sum + number(row.usdcSize, number(row.size)), 0), 2),
    };
  }
  return output;
}

function summarizeTape(allTrades, takerTrades, nowSec = Math.floor(Date.now() / 1000)) {
  const takerHashes = new Set(takerTrades.map((trade) => trade.transactionHash).filter(Boolean));
  const output = {};
  for (const period of ['DAY', 'WEEK', 'MONTH']) {
    const start = nowSec - PERIOD_SECONDS[period];
    const all = allTrades.filter((trade) => number(trade.timestamp, -Infinity) >= start);
    const makerApprox = all.filter((trade) => !takerHashes.has(trade.transactionHash));
    const allNotional = all.reduce((sum, trade) => sum + notional(trade), 0);
    const makerNotional = makerApprox.reduce((sum, trade) => sum + notional(trade), 0);
    output[period] = {
      rows: all.length,
      notionalUsd: round(allNotional, 2),
      makerApproxRows: makerApprox.length,
      makerApproxNotionalUsd: round(makerNotional, 2),
      makerApproxNotionalShare: allNotional > 0 ? round(makerNotional / allNotional, 4) : null,
    };
  }
  return output;
}

/**
 * Pairs BUY fills across the whole window after the fact. It is intentionally
 * an upper-bound diagnostic: fills were not synchronized and later sales are
 * ignored, so this must never be labeled executable arbitrage or PnL.
 */
function pairedBuyUpperBound(trades, options = {}) {
  const startSec = number(options.startSec, -Infinity);
  const groups = new Map();
  for (const trade of trades) {
    if (String(trade.side).toUpperCase() !== 'BUY' || number(trade.timestamp, -Infinity) < startSec) continue;
    const conditionId = String(trade.conditionId || '');
    const outcome = String(trade.outcome || trade.asset || '');
    if (!conditionId || !outcome) continue;
    const key = `${conditionId}\u0000${outcome}`;
    const state = groups.get(key) || { conditionId, outcome, shares: 0, cost: 0 };
    const shares = Math.max(0, number(trade.size));
    state.shares += shares;
    state.cost += shares * Math.max(0, number(trade.price));
    groups.set(key, state);
  }
  const conditions = new Map();
  for (const state of groups.values()) {
    const outcomes = conditions.get(state.conditionId) || [];
    outcomes.push(state);
    conditions.set(state.conditionId, outcomes);
  }
  const pairs = [];
  for (const [conditionId, outcomes] of conditions) {
    if (outcomes.length !== 2 || outcomes.some((row) => !(row.shares > 0))) continue;
    const pairableShares = Math.min(outcomes[0].shares, outcomes[1].shares);
    const averagePrices = outcomes.map((row) => row.cost / row.shares);
    const averagePairCost = averagePrices[0] + averagePrices[1];
    const grossUpperBound = pairableShares * (1 - averagePairCost);
    pairs.push({
      conditionId,
      outcomes: outcomes.map((row) => row.outcome),
      pairableShares,
      averagePairCost,
      grossUpperBound,
      sideBalance: 2 * pairableShares / (outcomes[0].shares + outcomes[1].shares),
    });
  }
  return {
    conditionsWithBothOutcomes: pairs.length,
    belowOneConditions: pairs.filter((row) => row.averagePairCost < 1).length,
    pairableShares: round(pairs.reduce((sum, row) => sum + row.pairableShares, 0), 2),
    grossNonSynchronousUpperBoundUsd: round(pairs.reduce((sum, row) => sum + row.grossUpperBound, 0), 2),
    positiveComponentUsd: round(pairs.filter((row) => row.grossUpperBound > 0)
      .reduce((sum, row) => sum + row.grossUpperBound, 0), 2),
    negativeComponentUsd: round(pairs.filter((row) => row.grossUpperBound < 0)
      .reduce((sum, row) => sum + row.grossUpperBound, 0), 2),
    medianAveragePairCost: round(median(pairs.map((row) => row.averagePairCost)), 6),
    medianSideBalance: round(median(pairs.map((row) => row.sideBalance)), 4),
    label: 'NON_SYNCHRONOUS_HINDSIGHT_UPPER_BOUND_NOT_EXECUTABLE_PNL',
  };
}

function summarizeLeaderboards(rows) {
  const report = {};
  for (const row of rows) {
    report[row.period] ||= {};
    const pnl = number(row.payload?.pnl);
    const volume = number(row.payload?.vol);
    report[row.period][row.category] = {
      rank: row.payload?.rank == null ? null : number(row.payload.rank),
      pnlUsd: round(pnl, 2),
      volumeUsd: round(volume, 2),
      pnlPerVolume: volume > 0 ? round(pnl / volume, 6) : null,
    };
  }
  return report;
}

function walletArgument(argv = process.argv.slice(2)) {
  const argument = argv.find((item) => item.startsWith('--wallet='));
  return String(argument?.slice('--wallet='.length) || DEFAULT_WALLET).toLowerCase();
}

async function buildReport(wallet = DEFAULT_WALLET) {
  const nowSec = Math.floor(Date.now() / 1000);
  const leaderboardRequests = LEADERBOARD_PERIODS.flatMap((period) =>
    LEADERBOARD_CATEGORIES.map(async (category) => {
      const url = new URL(`${DATA_API}/v1/leaderboard`);
      Object.entries({ category, timePeriod: period, orderBy: 'PNL', limit: 10, user: wallet })
        .forEach(([key, value]) => url.searchParams.set(key, value));
      const payload = await fetchJson(url);
      return { period, category, payload: Array.isArray(payload) ? payload[0] || null : null };
    }));
  const activityRequests = ACTIVITY_TYPES.map(async (type) => ({
    type,
    ...(await fetchPaged('/activity', { user: wallet, type }, { pageSize: 500, maxRows: 10_000 })),
  }));
  const [leaderboardRows, activityRows, traded, value, allTape, takerTape] = await Promise.all([
    Promise.all(leaderboardRequests),
    Promise.all(activityRequests),
    fetchJson(`${DATA_API}/traded?user=${encodeURIComponent(wallet)}`),
    fetchJson(`${DATA_API}/value?user=${encodeURIComponent(wallet)}`),
    fetchPaged('/trades', { user: wallet, takerOnly: false }, { pageSize: 10_000, maxRows: 20_000 }),
    fetchPaged('/trades', { user: wallet, takerOnly: true }, { pageSize: 10_000, maxRows: 20_000 }),
  ]);
  const leaderboards = summarizeLeaderboards(leaderboardRows.filter((row) => row.payload));
  const activities = Object.fromEntries(activityRows.map((entry) => [entry.type, {
    ...summarizeActivity(entry.rows, nowSec), truncated: entry.truncated,
  }]));
  const dayStart = nowSec - PERIOD_SECONDS.DAY;
  const dayTrades = allTape.rows.filter((trade) => number(trade.timestamp, -Infinity) >= dayStart);
  const takerHashes = new Set(takerTape.rows.map((trade) => trade.transactionHash).filter(Boolean));
  const makerApproxDay = dayTrades.filter((trade) => !takerHashes.has(trade.transactionHash));
  const currentValue = number(Array.isArray(value) ? value[0]?.value : value?.value);
  return {
    format: 'polymarket-wallet-mechanism-report-v1',
    generatedAt: new Date().toISOString(),
    wallet,
    scope: 'Public Data API only; no wallet credentials, private data, or copied orders.',
    officialLeaderboard: leaderboards,
    currentPublicPositionValueUsd: round(currentValue, 2),
    totalMarketsTraded: number(traded?.traded),
    activity: activities,
    recentTape: {
      ...summarizeTape(allTape.rows, takerTape.rows, nowSec),
      allTapeRows: allTape.rows.length,
      allTapeTruncated: allTape.truncated,
      takerTapeRows: takerTape.rows.length,
      takerTapeTruncated: takerTape.truncated,
      makerClassification: 'Approximation: public all-trade rows whose transaction hash is absent from takerOnly=true rows.',
    },
    pairedBuyDiagnosticDay: {
      allFills: pairedBuyUpperBound(dayTrades),
      makerApproxFills: pairedBuyUpperBound(makerApproxDay),
    },
    capitalReality: {
      researchBankrollUsd: 500,
      publicPositionValueMultipleOfResearchBankroll: currentValue > 0 ? round(currentValue / 500, 1) : null,
      linearScalingAllowed: false,
      reason: 'Reward/rebate share, queue priority, inventory capacity, category diversification and drawdown tolerance are nonlinear in capital.',
    },
    interpretation: [
      'Use official leaderboard PnL for period performance; activity totals explain mechanism but are not additive PnL.',
      'MERGE/SPLIT/REDEEM activity plus maker-heavy tape supports a high-turnover inventory/complete-set mechanism.',
      'Maker rebates and liquidity rewards are real account cash flows, but the strategy also carries substantial directional and event inventory risk.',
      'The paired BUY diagnostic combines fills across time with hindsight and ignores sales; it is an upper bound, not simultaneous executable arbitrage.',
      'A profitable large wallet is evidence that a mechanism deserves a forward test, not evidence that its return can be reproduced by a $500 bot.',
    ],
  };
}

async function main() {
  console.log(JSON.stringify(await buildReport(walletArgument()), null, 2));
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

module.exports = {
  DEFAULT_WALLET,
  buildReport,
  median,
  number,
  pairedBuyUpperBound,
  summarizeActivity,
  summarizeLeaderboards,
  summarizeTape,
  walletArgument,
};
