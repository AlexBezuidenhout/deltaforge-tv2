#!/usr/bin/env node
'use strict';

const { fetchFundingHistory, maxDrawdown } = require('./funding-carry-backtest');
const { clusteredBootstrap } = require('../borg/research/statistics');

const BINANCE_URL = 'https://fapi.binance.com/fapi/v1/fundingRate';
const COINS = Object.freeze(['BTC', 'ETH', 'SOL']);

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 4) {
  const parsed = finite(value);
  return parsed == null ? null : +parsed.toFixed(digits);
}

function parseArgs(argv) {
  const pairs = argv.slice(2).filter((arg) => arg.startsWith('--')).map((arg) => {
    const [key, value = 'true'] = arg.slice(2).split('=');
    return [key, value];
  });
  const values = Object.fromEntries(pairs);
  const number = (key, fallback) => finite(values[key]) ?? fallback;
  return {
    days: Math.max(14, Math.floor(number('days', 180))),
    capitalUsd: Math.max(1, number('capital', 1000)),
    notionalFraction: Math.max(0.01, Math.min(1, number('notional-fraction', 0.5))),
    lookbackPeriods: Math.max(3, Math.floor(number('lookback-periods', 21))),
    binanceTakerBps: Math.max(0, number('binance-taker-bps', 5)),
    hyperliquidTakerBps: Math.max(0, number('hyperliquid-taker-bps', 4.5)),
    slippageBpsPerVenue: Math.max(0, number('slippage-bps', 2)),
    basisStressBpsPerRegime: Math.max(0, number('basis-stress-bps', 20)),
    coins: String(values.coins || COINS.join(',')).split(',')
      .map((coin) => coin.trim().toUpperCase()).filter(Boolean),
    json: values.json === 'true',
  };
}

async function fetchBinanceFunding(symbol, startTime, endTime) {
  const rows = [];
  let cursor = startTime;
  while (cursor <= endTime) {
    const url = new URL(BINANCE_URL);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('startTime', String(cursor));
    url.searchParams.set('endTime', String(endTime));
    url.searchParams.set('limit', '1000');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${symbol}: Binance funding HTTP ${response.status}`);
    const page = await response.json();
    if (!Array.isArray(page) || !page.length) break;
    for (const row of page) {
      const time = parseInt(row.fundingTime, 10);
      const fundingRate = finite(row.fundingRate);
      if (Number.isFinite(time) && fundingRate != null && time >= startTime && time <= endTime) {
        rows.push({ time, fundingRate, markPrice: finite(row.markPrice) });
      }
    }
    const last = parseInt(page[page.length - 1]?.fundingTime, 10);
    if (!Number.isFinite(last) || last < cursor || page.length < 1000) break;
    cursor = last + 1;
  }
  return [...new Map(rows.map((row) => [row.time, row])).values()]
    .sort((left, right) => left.time - right.time);
}

function alignDifferentials(binanceRows, hyperliquidRows) {
  const periods = [];
  let hyperIndex = 0;
  for (let index = 1; index < binanceRows.length; index += 1) {
    const previous = binanceRows[index - 1].time;
    const current = binanceRows[index].time;
    while (hyperIndex < hyperliquidRows.length && hyperliquidRows[hyperIndex].time <= previous) {
      hyperIndex += 1;
    }
    let cursor = hyperIndex;
    let hyperRate = 0;
    let hyperHours = 0;
    while (cursor < hyperliquidRows.length && hyperliquidRows[cursor].time <= current) {
      hyperRate += hyperliquidRows[cursor].fundingRate;
      hyperHours += 1;
      cursor += 1;
    }
    const intervalHours = (current - previous) / 3600000;
    if (intervalHours >= 3 && intervalHours <= 12 && hyperHours >= Math.floor(intervalHours) - 1) {
      periods.push({
        time: current,
        day: new Date(current).toISOString().slice(0, 10),
        intervalHours,
        binanceRate: binanceRows[index].fundingRate,
        hyperliquidRate: hyperRate,
        // Positive means short Binance / long Hyperliquid receives funding.
        differential: binanceRows[index].fundingRate - hyperRate,
      });
    }
  }
  return periods;
}

function executionCostRate(assumptions, regimes, stressed = false) {
  const pairOneWayBps = assumptions.binanceTakerBps + assumptions.hyperliquidTakerBps
    + 2 * assumptions.slippageBpsPerVenue;
  const roundTrips = Math.max(1, regimes);
  const base = 2 * roundTrips * pairOneWayBps / 10000;
  if (!stressed) return base;
  return 2 * base + roundTrips * assumptions.basisStressBpsPerRegime / 10000;
}

function summarizeReturns(periods, signedRates, assumptions, regimes) {
  const notional = assumptions.capitalUsd * assumptions.notionalFraction;
  const grossRate = signedRates.reduce((sum, value) => sum + value, 0);
  const grossPnl = notional * grossRate;
  const cost = notional * executionCostRate(assumptions, regimes, false);
  const stressCost = notional * executionCostRate(assumptions, regimes, true);
  const pnlSeries = signedRates.map((rate) => notional * rate);
  const dailyMap = new Map();
  for (let index = 0; index < signedRates.length; index += 1) {
    const key = periods[index].day;
    dailyMap.set(key, (dailyMap.get(key) || 0) + pnlSeries[index]);
  }
  const daily = [...dailyMap.entries()].map(([day, pnl]) => ({ day, pnl }));
  const bootstrap = clusteredBootstrap(daily, 'day', 'pnl');
  const elapsedDays = periods.length > 1
    ? (periods[periods.length - 1].time - periods[0].time) / 86400000 : 0;
  return {
    periods: signedRates.length,
    calendarDays: daily.length,
    regimes,
    notionalUsd: notional,
    grossRate,
    simpleAnnualizedRate: elapsedDays > 0 ? grossRate * 365 / elapsedDays : null,
    grossPnl,
    executionCost: cost,
    netPnl: grossPnl - cost,
    stressCost,
    stressNetPnl: grossPnl - stressCost,
    fundingMaxDrawdownUsd: maxDrawdown(pnlSeries),
    dayClusteredCi95Usd: bootstrap.ci,
  };
}

function backtestDifferential(periods, assumptions) {
  const fixedShortBinance = summarizeReturns(
    periods, periods.map((row) => row.differential), assumptions, 1,
  );
  const fixedShortHyperliquid = summarizeReturns(
    periods, periods.map((row) => -row.differential), assumptions, 1,
  );
  const walkPeriods = [];
  const walkRates = [];
  let priorDirection = 0;
  let regimes = 0;
  for (let index = assumptions.lookbackPeriods; index < periods.length; index += 1) {
    const history = periods.slice(index - assumptions.lookbackPeriods, index);
    const mean = history.reduce((sum, row) => sum + row.differential, 0) / history.length;
    const direction = mean >= 0 ? 1 : -1;
    if (direction !== priorDirection) {
      regimes += 1;
      priorDirection = direction;
    }
    walkPeriods.push(periods[index]);
    walkRates.push(direction * periods[index].differential);
  }
  const walkForward = summarizeReturns(walkPeriods, walkRates, assumptions, regimes || 1);
  return { fixedShortBinance, fixedShortHyperliquid, walkForward };
}

function serialize(summary) {
  return Object.fromEntries(Object.entries(summary).map(([key, value]) => {
    if (Array.isArray(value)) return [key, value.map((item) => round(item, 4))];
    return [key, typeof value === 'number' ? round(value, 6) : value];
  }));
}

async function main() {
  const assumptions = parseArgs(process.argv);
  const endTime = Date.now();
  const startTime = endTime - assumptions.days * 86400000;
  const assets = [];
  for (const coin of assumptions.coins) {
    const [binance, hyperliquid] = await Promise.all([
      fetchBinanceFunding(`${coin}USDT`, startTime, endTime),
      fetchFundingHistory(coin, startTime - 12 * 3600000, endTime),
    ]);
    const periods = alignDifferentials(binance, hyperliquid);
    const result = backtestDifferential(periods, assumptions);
    assets.push({
      coin,
      alignedPeriods: periods.length,
      firstAt: periods[0] ? new Date(periods[0].time).toISOString() : null,
      lastAt: periods.length ? new Date(periods[periods.length - 1].time).toISOString() : null,
      fixedShortBinance: serialize(result.fixedShortBinance),
      fixedShortHyperliquid: serialize(result.fixedShortHyperliquid),
      walkForward: serialize(result.walkForward),
    });
  }
  const output = {
    format: 'cross-venue-funding-backtest-v1',
    generatedAt: new Date().toISOString(),
    sources: { binance: BINANCE_URL, hyperliquid: 'https://api.hyperliquid.xyz/info fundingHistory' },
    assumptions,
    mechanism: 'Equal-notional long perpetual on the lower-funding venue and short perpetual on the higher-funding venue. The walk-forward arm chooses direction from the prior seven days (21 Binance funding periods) only.',
    warning: 'Not risk-free: legs are non-atomic and venue basis, mark-price, collateral, liquidation, transfer, counterparty and access risks remain. Historical funding alone cannot reconstruct basis PnL; the stress line charges 20 bp per holding regime but does not prove executability.',
    selectionDisclosure: 'Both fixed directions are descriptive/hindsight controls. Only the trailing-21-period arm is causal. No lookback or cost parameter was selected from the reported PnL.',
    assets,
  };
  if (assumptions.json) console.log(JSON.stringify(output, null, 2));
  else {
    console.log(`CROSS-VENUE FUNDING — ${output.generatedAt}`);
    console.log(output.warning);
    console.table(assets.map((asset) => ({
      coin: asset.coin,
      periods: asset.alignedPeriods,
      fixed_short_binance_net: round(asset.fixedShortBinance.netPnl, 2),
      fixed_short_hl_net: round(asset.fixedShortHyperliquid.netPnl, 2),
      walk_net: round(asset.walkForward.netPnl, 2),
      walk_stress: round(asset.walkForward.stressNetPnl, 2),
      walk_regimes: asset.walkForward.regimes,
      walk_annualized: asset.walkForward.simpleAnnualizedRate,
      walk_ci_low: asset.walkForward.dayClusteredCi95Usd[0],
    })));
  }
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

module.exports = {
  alignDifferentials,
  backtestDifferential,
  executionCostRate,
  summarizeReturns,
};
