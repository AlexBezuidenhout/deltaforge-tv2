#!/usr/bin/env node
'use strict';

const { clusterSignFlipPValue, clusteredBootstrap } = require('../borg/research/statistics');

const API_URL = 'https://api.hyperliquid.xyz/info';
const DEFAULT_COINS = Object.freeze(['BTC', 'ETH', 'SOL', 'HYPE']);

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 4) {
  const parsed = finite(value);
  return parsed == null ? null : +parsed.toFixed(digits);
}

function utcDay(timestamp) {
  const date = new Date(parseInt(timestamp, 10));
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

function parseArgs(argv) {
  const values = Object.fromEntries(argv.slice(2).filter((arg) => arg.startsWith('--'))
    .map((arg) => {
      const [key, value = 'true'] = arg.slice(2).split('=');
      return [key, value];
    }));
  const number = (name, fallback) => finite(values[name]) ?? fallback;
  return {
    days: Math.max(1, Math.floor(number('days', 90))),
    capitalUsd: Math.max(1, number('capital', 1000)),
    notionalFraction: Math.max(0.01, Math.min(1, number('notional-fraction', 0.5))),
    spotTakerBps: Math.max(0, number('spot-taker-bps', 10)),
    perpTakerBps: Math.max(0, number('perp-taker-bps', 4.5)),
    slippageBpsPerLeg: Math.max(0, number('slippage-bps', 2)),
    basisStressBps: Math.max(0, number('basis-stress-bps', 10)),
    coins: String(values.coins || DEFAULT_COINS.join(','))
      .split(',').map((coin) => coin.trim().toUpperCase()).filter(Boolean),
    json: values.json === 'true',
  };
}

async function fetchPage(coin, startTime, endTime) {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'fundingHistory', coin, startTime, endTime }),
  });
  if (!response.ok) throw new Error(`${coin}: HTTP ${response.status} from fundingHistory`);
  const body = await response.json();
  if (!Array.isArray(body)) throw new Error(`${coin}: malformed fundingHistory response`);
  return body;
}

async function fetchFundingHistory(coin, startTime, endTime) {
  const rows = [];
  let cursor = startTime;
  while (cursor <= endTime) {
    const page = await fetchPage(coin, cursor, endTime);
    if (!page.length) break;
    for (const row of page) {
      const time = parseInt(row.time, 10);
      const fundingRate = finite(row.fundingRate);
      const premium = finite(row.premium);
      if (Number.isFinite(time) && fundingRate != null && time >= startTime && time <= endTime) {
        rows.push({ coin, time, fundingRate, premium });
      }
    }
    const lastTime = parseInt(page[page.length - 1]?.time, 10);
    if (!Number.isFinite(lastTime) || lastTime < cursor) break;
    cursor = lastTime + 1;
    if (page.length < 500) break;
  }
  const unique = new Map(rows.map((row) => [`${row.coin}:${row.time}`, row]));
  return [...unique.values()].sort((left, right) => left.time - right.time);
}

function maxDrawdown(values) {
  let cumulative = 0;
  let peak = 0;
  let drawdown = 0;
  for (const value of values) {
    cumulative += value;
    peak = Math.max(peak, cumulative);
    drawdown = Math.min(drawdown, cumulative - peak);
  }
  return drawdown;
}

function rollingMinimum(values, window) {
  if (!values.length) return null;
  let minimum = Infinity;
  for (let index = 0; index < values.length; index += 1) {
    const start = Math.max(0, index - window + 1);
    let sum = 0;
    for (let cursor = start; cursor <= index; cursor += 1) sum += values[cursor];
    minimum = Math.min(minimum, sum);
  }
  return minimum;
}

function summarizeCarry(rows, assumptions) {
  const notional = assumptions.capitalUsd * assumptions.notionalFraction;
  const daily = new Map();
  for (const row of rows) {
    const day = utcDay(row.time);
    if (!day) continue;
    const value = daily.get(day) || { day, rate: 0, hours: 0 };
    value.rate += finite(row.fundingRate) || 0;
    value.hours += 1;
    daily.set(day, value);
  }
  const days = [...daily.values()].sort((left, right) => left.day.localeCompare(right.day));
  const cumulativeRate = rows.reduce((sum, row) => sum + (finite(row.fundingRate) || 0), 0);
  const grossFundingPnl = notional * cumulativeRate;
  const feeRate = 2 * (assumptions.spotTakerBps + assumptions.perpTakerBps) / 10000;
  const slippageRate = 4 * assumptions.slippageBpsPerLeg / 10000;
  const basisStressRate = assumptions.basisStressBps / 10000;
  const estimatedRoundTripCost = notional * (feeRate + slippageRate);
  const stressedRoundTripCost = notional * (2 * feeRate + 2 * slippageRate + basisStressRate);
  const netAfterEstimatedCosts = grossFundingPnl - estimatedRoundTripCost;
  const netAfterStress = grossFundingPnl - stressedRoundTripCost;
  const elapsedDays = rows.length > 1
    ? Math.max(1 / 24, (rows[rows.length - 1].time - rows[0].time) / 86400000) : 0;
  const meanDailyRate = elapsedDays ? cumulativeRate / elapsedDays : null;
  const bootstrapRows = days.map((day) => ({ day: day.day, pnl: notional * day.rate }));
  const dayBootstrap = clusteredBootstrap(bootstrapRows, 'day', 'pnl');
  const dayP = clusterSignFlipPValue(bootstrapRows, 'day', 'pnl');
  const hourlyPnl = rows.map((row) => notional * row.fundingRate);
  return {
    observations: rows.length,
    calendarDays: days.length,
    elapsedDays,
    firstAt: rows[0] ? new Date(rows[0].time).toISOString() : null,
    lastAt: rows.length ? new Date(rows[rows.length - 1].time).toISOString() : null,
    notionalUsd: notional,
    cumulativeFundingRate: cumulativeRate,
    simpleAnnualizedFundingRate: meanDailyRate == null ? null : meanDailyRate * 365,
    positiveFundingHours: rows.filter((row) => row.fundingRate > 0).length,
    negativeFundingHours: rows.filter((row) => row.fundingRate < 0).length,
    positiveDays: days.filter((day) => day.rate > 0).length,
    grossFundingPnl,
    estimatedRoundTripCost,
    netAfterEstimatedCosts,
    stressedRoundTripCost,
    netAfterStress,
    fundingMaxDrawdownUsd: maxDrawdown(hourlyPnl),
    worstRolling7DayFundingUsd: rollingMinimum(days.map((day) => notional * day.rate), 7),
    breakEvenHoldingDays: meanDailyRate > 0 ? (feeRate + slippageRate) / meanDailyRate : null,
    dayClusteredCi95Usd: dayBootstrap.ci,
    dayClusteredOneSidedP: dayP,
    daily: days,
  };
}

function serializeSummary(summary) {
  return {
    ...summary,
    elapsedDays: round(summary.elapsedDays, 2),
    notionalUsd: round(summary.notionalUsd, 2),
    cumulativeFundingRate: round(summary.cumulativeFundingRate, 6),
    simpleAnnualizedFundingRate: round(summary.simpleAnnualizedFundingRate),
    grossFundingPnl: round(summary.grossFundingPnl, 2),
    estimatedRoundTripCost: round(summary.estimatedRoundTripCost, 2),
    netAfterEstimatedCosts: round(summary.netAfterEstimatedCosts, 2),
    stressedRoundTripCost: round(summary.stressedRoundTripCost, 2),
    netAfterStress: round(summary.netAfterStress, 2),
    fundingMaxDrawdownUsd: round(summary.fundingMaxDrawdownUsd, 2),
    worstRolling7DayFundingUsd: round(summary.worstRolling7DayFundingUsd, 2),
    breakEvenHoldingDays: round(summary.breakEvenHoldingDays, 1),
    dayClusteredCi95Usd: summary.dayClusteredCi95Usd.map((value) => round(value, 4)),
    dayClusteredOneSidedP: round(summary.dayClusteredOneSidedP, 6),
    daily: undefined,
  };
}

async function main() {
  const assumptions = parseArgs(process.argv);
  const endTime = Date.now();
  const startTime = endTime - assumptions.days * 86400000;
  const assets = [];
  for (const coin of assumptions.coins) {
    const rows = await fetchFundingHistory(coin, startTime, endTime);
    assets.push({ coin, ...serializeSummary(summarizeCarry(rows, assumptions)) });
  }
  const output = {
    format: 'hyperliquid-funding-carry-backtest-v1',
    generatedAt: new Date().toISOString(),
    source: API_URL,
    sourceContract: 'Public hourly fundingHistory; positive funding is received by a short perpetual position.',
    assumptions: {
      capitalUsd: assumptions.capitalUsd,
      notionalFraction: assumptions.notionalFraction,
      spotTakerBps: assumptions.spotTakerBps,
      perpTakerBps: assumptions.perpTakerBps,
      slippageBpsPerLeg: assumptions.slippageBpsPerLeg,
      basisStressBps: assumptions.basisStressBps,
      execution: 'Long spot plus equal-notional short perpetual; open at sample start and close at sample end.',
    },
    warning: 'Funding-only reconstruction, not a trade ledger. Basis changes, borrow/custody, liquidation, taxes, venue access and transfer risk are not observed; the stress line applies an explicit basis haircut but is not a substitute for synchronized spot/perp books.',
    assets,
  };
  if (assumptions.json) console.log(JSON.stringify(output, null, 2));
  else {
    console.log(`HYPERLIQUID FUNDING CARRY — ${output.generatedAt}`);
    console.log(output.warning);
    console.table(assets.map((asset) => ({
      coin: asset.coin,
      days: asset.elapsedDays,
      annualized_funding: asset.simpleAnnualizedFundingRate,
      gross_usd: asset.grossFundingPnl,
      net_usd: asset.netAfterEstimatedCosts,
      stress_usd: asset.netAfterStress,
      max_funding_dd: asset.fundingMaxDrawdownUsd,
      break_even_days: asset.breakEvenHoldingDays,
      day_ci_low: asset.dayClusteredCi95Usd[0],
    })));
  }
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

module.exports = {
  fetchFundingHistory,
  maxDrawdown,
  parseArgs,
  rollingMinimum,
  summarizeCarry,
  utcDay,
};
