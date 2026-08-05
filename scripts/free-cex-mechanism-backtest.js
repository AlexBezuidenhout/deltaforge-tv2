#!/usr/bin/env node
'use strict';

/**
 * Cheap causal falsification for the free-data CEX hypotheses in the edge map.
 *
 * This intentionally tests materially different mechanisms, not parameter
 * grids. Every rule below is fixed from a mechanism argument before observing
 * this script's output. Results use completed Binance hourly bars, non-
 * overlapping holding episodes, a 24 bp round-trip cost and a doubled-cost
 * stress. They are discovery screens, never authority for a live order.
 */

const { clusteredBootstrap } = require('../borg/research/statistics');

const KLINE_API = 'https://data-api.binance.vision/api/v3/klines';
const FUNDING_API = 'https://fapi.binance.com/fapi/v1/fundingRate';
const HOUR_MS = 3_600_000;
const ASSETS = Object.freeze(['BTC', 'ETH', 'SOL', 'XRP']);
const SYMBOLS = Object.freeze(Object.fromEntries(ASSETS.map((asset) => [asset, `${asset}USDT`])));
const LOOKBACK_HOURS = 30 * 24;
const HOLDING_HOURS = 4;
const ROUND_TRIP_COST_BPS = 24;

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function variance(values) {
  if (values.length < 2) return null;
  const center = mean(values);
  return values.reduce((sum, value) => sum + (value - center) ** 2, 0)
    / (values.length - 1);
}

function standardDeviation(values) {
  const value = variance(values);
  return value != null && value > 0 ? Math.sqrt(value) : null;
}

function covariance(left, right) {
  if (left.length !== right.length || left.length < 2) return null;
  const leftMean = mean(left); const rightMean = mean(right);
  return left.reduce((sum, value, index) =>
    sum + (value - leftMean) * (right[index] - rightMean), 0) / (left.length - 1);
}

function slope(left, right) {
  const denominator = variance(left);
  const numerator = covariance(left, right);
  return denominator > 0 && numerator != null ? numerator / denominator : null;
}

function correlation(left, right) {
  const cov = covariance(left, right);
  const leftVariance = variance(left); const rightVariance = variance(right);
  return cov != null && leftVariance > 0 && rightVariance > 0
    ? cov / Math.sqrt(leftVariance * rightVariance) : null;
}

function quantile(values, probability) {
  const ordered = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!ordered.length) return null;
  const position = Math.max(0, Math.min(1, probability)) * (ordered.length - 1);
  const low = Math.floor(position); const high = Math.ceil(position);
  return ordered[low] + (ordered[high] - ordered[low]) * (position - low);
}

function maxDrawdown(values) {
  let equity = 0; let peak = 0; let drawdown = 0;
  for (const value of values) {
    equity += value; peak = Math.max(peak, equity); drawdown = Math.min(drawdown, equity - peak);
  }
  return drawdown;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchJson(url, options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  const waitImpl = options.waitImpl || wait;
  for (let attempt = 0; attempt <= 5; attempt += 1) {
    const response = await fetchImpl(url, { headers: { 'user-agent': 'deltaforge-free-cex-research/1.0' } });
    if (response.ok) return response.json();
    if (!([429, 500, 502, 503, 504].includes(response.status)) || attempt === 5) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }
    const retryAfter = finite(response.headers?.get?.('retry-after'));
    await waitImpl(retryAfter == null ? Math.min(8000, 500 * (2 ** attempt)) : retryAfter * 1000);
  }
  throw new Error(`retry loop exhausted for ${url}`);
}

async function fetchHourlyKlines(asset, startTime, endTime, options = {}) {
  const rows = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const url = new URL(KLINE_API);
    url.searchParams.set('symbol', SYMBOLS[asset]);
    url.searchParams.set('interval', '1h');
    url.searchParams.set('startTime', String(cursor));
    url.searchParams.set('endTime', String(endTime - 1));
    url.searchParams.set('limit', '1000');
    const page = await fetchJson(url, options);
    if (!Array.isArray(page) || !page.length) break;
    for (const raw of page) {
      const time = parseInt(raw[0], 10);
      const close = finite(raw[4]); const quoteVolume = finite(raw[7]);
      const takerBuyQuote = finite(raw[10]);
      if (!Number.isFinite(time) || !(close > 0) || time < startTime || time >= endTime) continue;
      rows.push({
        time,
        close,
        quoteVolume: quoteVolume ?? 0,
        flow: quoteVolume > 0 && takerBuyQuote != null
          ? Math.max(-1, Math.min(1, 2 * takerBuyQuote / quoteVolume - 1)) : 0,
      });
    }
    const last = parseInt(page.at(-1)?.[0], 10);
    if (!Number.isFinite(last) || last < cursor || page.length < 1000) break;
    cursor = last + HOUR_MS;
  }
  return [...new Map(rows.map((row) => [row.time, row])).values()]
    .sort((left, right) => left.time - right.time);
}

async function fetchFunding(asset, startTime, endTime, options = {}) {
  const rows = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const url = new URL(FUNDING_API);
    url.searchParams.set('symbol', SYMBOLS[asset]);
    url.searchParams.set('startTime', String(cursor));
    url.searchParams.set('endTime', String(endTime));
    url.searchParams.set('limit', '1000');
    const page = await fetchJson(url, options);
    if (!Array.isArray(page) || !page.length) break;
    for (const raw of page) {
      const time = parseInt(raw.fundingTime, 10); const rate = finite(raw.fundingRate);
      if (Number.isFinite(time) && rate != null && time >= startTime && time <= endTime) {
        rows.push({ time, rate });
      }
    }
    const last = parseInt(page.at(-1)?.fundingTime, 10);
    if (!Number.isFinite(last) || last < cursor || page.length < 1000) break;
    cursor = last + 1;
  }
  return [...new Map(rows.map((row) => [row.time, row])).values()]
    .sort((left, right) => left.time - right.time);
}

function alignSeries(series) {
  const maps = Object.fromEntries(ASSETS.map((asset) => [asset,
    new Map((series[asset] || []).map((row) => [row.time, row]))]));
  const times = [...maps.BTC.keys()].filter((time) =>
    ASSETS.every((asset) => maps[asset].has(time))).sort((left, right) => left - right);
  const aligned = times.map((time) => ({
    time,
    close: Object.fromEntries(ASSETS.map((asset) => [asset,
      finite(maps[asset].get(time).close)])),
    flow: Object.fromEntries(ASSETS.map((asset) => [asset,
      finite(maps[asset].get(time).flow) ?? 0])),
    quoteVolume: Object.fromEntries(ASSETS.map((asset) => [asset,
      finite(maps[asset].get(time).quoteVolume) ?? 0])),
  }));
  const rows = [];
  for (let index = 1; index < aligned.length; index += 1) {
    if (aligned[index].time - aligned[index - 1].time !== HOUR_MS) continue;
    rows.push({
      ...aligned[index],
      returns: Object.fromEntries(ASSETS.map((asset) => [asset,
        10_000 * Math.log(aligned[index].close[asset] / aligned[index - 1].close[asset])])),
    });
  }
  return rows;
}

function futureBps(rows, index, asset, horizon = HOLDING_HOURS) {
  if (!rows[index + horizon]) return null;
  let total = 0;
  for (let step = 1; step <= horizon; step += 1) total += rows[index + step].returns[asset];
  return total;
}

function pairStats(rows, leader, target, start, end) {
  const lagLeader = []; const lagTarget = [];
  const sameLeader = []; const sameTarget = [];
  for (let index = start + 1; index < end; index += 1) {
    lagLeader.push(rows[index - 1].returns[leader]);
    lagTarget.push(rows[index].returns[target]);
    sameLeader.push(rows[index].returns[leader]);
    sameTarget.push(rows[index].returns[target]);
  }
  return {
    lagSlope: slope(lagLeader, lagTarget),
    lagCorrelation: correlation(lagLeader, lagTarget),
    contemporaneousSlope: slope(sameLeader, sameTarget),
  };
}

function conditionalLeadLag(rows, pairs) {
  const signals = [];
  const nextEligible = new Map(pairs.map(({ leader, target }) => [`${leader}->${target}`, 0]));
  for (let index = LOOKBACK_HOURS; index + HOLDING_HOURS < rows.length; index += 1) {
    const start = index - LOOKBACK_HOURS; const middle = start + LOOKBACK_HOURS / 2;
    for (const { leader, target, mechanismId } of pairs) {
      const key = `${leader}->${target}`;
      if (index < nextEligible.get(key)) continue;
      const first = pairStats(rows, leader, target, start, middle);
      const second = pairStats(rows, leader, target, middle, index);
      if (!(first.lagSlope > 0 && second.lagSlope > 0
          && first.lagCorrelation > 0 && second.lagCorrelation > 0
          && first.contemporaneousSlope > 0 && second.contemporaneousSlope > 0)) continue;
      const leaderReturn = rows[index].returns[leader];
      const targetReturn = rows[index].returns[target];
      const shock = quantile(rows.slice(start, index)
        .map((row) => Math.abs(row.returns[leader])), 0.95);
      const flowShock = quantile(rows.slice(start, index)
        .map((row) => Math.abs(row.flow[leader])), 0.75);
      const beta = Math.min(first.contemporaneousSlope, second.contemporaneousSlope);
      if (!(Math.abs(leaderReturn) >= shock)
          || Math.sign(leaderReturn) !== Math.sign(rows[index].flow[leader])
          || Math.abs(rows[index].flow[leader]) < flowShock
          || Math.abs(targetReturn) > 0.5 * Math.abs(beta * leaderReturn)) continue;
      signals.push({ mechanismId, variant: key, time: rows[index].time, asset: target,
        direction: Math.sign(leaderReturn), futureBps: futureBps(rows, index, target) });
      nextEligible.set(key, index + HOLDING_HOURS);
    }
  }
  return signals.filter((row) => row.futureBps != null && row.direction !== 0);
}

function commonFactorResidual(rows) {
  const signals = [];
  const targets = ['SOL', 'XRP'];
  const nextEligible = new Map(targets.map((target) => [target, 0]));
  for (let index = LOOKBACK_HOURS; index + HOLDING_HOURS < rows.length; index += 1) {
    for (const target of targets) {
      if (index < nextEligible.get(target)) continue;
      const start = index - LOOKBACK_HOURS;
      const trainingEnd = index - 24;
      const factor = []; const targetReturns = [];
      for (let cursor = start; cursor < trainingEnd; cursor += 1) {
        factor.push((rows[cursor].returns.BTC + rows[cursor].returns.ETH) / 2);
        targetReturns.push(rows[cursor].returns[target]);
      }
      const beta = slope(factor, targetReturns);
      if (!(beta > 0)) continue;
      const residualWindow = (end) => {
        let value = 0;
        for (let cursor = end - 23; cursor <= end; cursor += 1) {
          value += rows[cursor].returns[target]
            - beta * (rows[cursor].returns.BTC + rows[cursor].returns.ETH) / 2;
        }
        return value;
      };
      const historical = [];
      for (let cursor = start + 23; cursor < index - 24; cursor += 24) {
        historical.push(residualWindow(cursor));
      }
      const center = mean(historical); const scale = standardDeviation(historical);
      const current = residualWindow(index);
      if (center == null || !(scale > 0) || Math.abs(current - center) < 2 * scale) continue;
      signals.push({ mechanismId: 'C07', variant: `${target}-common-factor`,
        time: rows[index].time, asset: target, direction: -Math.sign(current - center),
        futureBps: futureBps(rows, index, target) });
      nextEligible.set(target, index + HOLDING_HOURS);
    }
  }
  return signals.filter((row) => row.futureBps != null && row.direction !== 0);
}

function fundingRegime(rows, fundingByAsset) {
  const timeIndex = new Map(rows.map((row, index) => [row.time, index]));
  const momentum = []; const reversal = [];
  for (const asset of ASSETS) {
    const funding = fundingByAsset[asset] || [];
    for (let event = 90; event < funding.length; event += 1) {
      // Funding at T may use the completed hourly bar ending at T, represented
      // by the row whose open timestamp is T-1h.
      const index = timeIndex.get(funding[event].time - HOUR_MS);
      if (!(index >= 4) || index + HOLDING_HOURS >= rows.length) continue;
      const threshold = quantile(funding.slice(event - 90, event)
        .map((row) => Math.abs(row.rate)), 0.95);
      const rate = funding[event].rate;
      if (!(Math.abs(rate) >= threshold) || rate === 0) continue;
      const prior4 = rows.slice(index - 3, index + 1)
        .reduce((sum, row) => sum + row.returns[asset], 0);
      const flow4 = mean(rows.slice(index - 3, index + 1).map((row) => row.flow[asset]));
      if (Math.sign(prior4) === Math.sign(flow4) && Math.sign(prior4) === Math.sign(rate)) {
        momentum.push({ mechanismId: 'C10', variant: asset, time: funding[event].time,
          asset, direction: Math.sign(prior4), futureBps: futureBps(rows, index, asset) });
      }
      const prior3 = rows.slice(index - 3, index)
        .reduce((sum, row) => sum + row.returns[asset], 0);
      const last = rows[index].returns[asset]; const lastFlow = rows[index].flow[asset];
      if (Math.sign(prior3) === Math.sign(rate)
          && Math.sign(last) === -Math.sign(prior3)
          && Math.sign(lastFlow) === -Math.sign(prior3)) {
        reversal.push({ mechanismId: 'C11', variant: asset, time: funding[event].time,
          asset, direction: -Math.sign(prior3), futureBps: futureBps(rows, index, asset) });
      }
    }
  }
  return { momentum, reversal };
}

function sessionHandoff(rows) {
  const hours = [0, 8, 16];
  return hours.map((hour) => {
    const selected = rows.filter((row) => new Date(row.time).getUTCHours() === hour);
    return {
      utcHour: hour,
      observations: selected.length,
      byAsset: Object.fromEntries(ASSETS.map((asset) => [asset, {
        meanReturnBps: mean(selected.map((row) => row.returns[asset])),
        meanAbsoluteReturnBps: mean(selected.map((row) => Math.abs(row.returns[asset]))),
        meanQuoteVolumeUsd: mean(selected.map((row) => row.quoteVolume[asset])),
      }])),
    };
  });
}

function summarizeSignals(signals, capitalUsd) {
  const notionalUsd = capitalUsd * 0.5;
  const ordered = [...signals].sort((left, right) => left.time - right.time);
  const rows = ordered.map((signal) => {
    const gross = notionalUsd * signal.direction * signal.futureBps / 10_000;
    return {
      ...signal,
      day: new Date(signal.time).toISOString().slice(0, 10),
      gross,
      pnl1x: gross - notionalUsd * ROUND_TRIP_COST_BPS / 10_000,
      pnl2x: gross - notionalUsd * 2 * ROUND_TRIP_COST_BPS / 10_000,
    };
  });
  const split = Math.floor(rows.length / 2);
  const sum = (items, field) => items.reduce((total, row) => total + row[field], 0);
  const clustered = clusteredBootstrap(rows, 'day', 'pnl2x', { iterations: 4000 });
  return {
    signals: rows.length,
    independentDays: new Set(rows.map((row) => row.day)).size,
    notionalPerSignalUsd: notionalUsd,
    grossPnlUsd: sum(rows, 'gross'),
    pnl1xUsd: sum(rows, 'pnl1x'),
    pnl2xUsd: sum(rows, 'pnl2x'),
    firstHalfPnl2xUsd: sum(rows.slice(0, split), 'pnl2x'),
    secondHalfPnl2xUsd: sum(rows.slice(split), 'pnl2x'),
    maxDrawdown2xUsd: maxDrawdown(rows.map((row) => row.pnl2x)),
    dayClusteredMeanPnl2xCi95Usd: clustered.ci,
    positive2xSignals: rows.filter((row) => row.pnl2x > 0).length,
    firstAt: rows[0] ? new Date(rows[0].time).toISOString() : null,
    lastAt: rows.length ? new Date(rows.at(-1).time).toISOString() : null,
  };
}

function mechanismReport(signals, capitals = [500, 1000]) {
  const groups = new Map();
  for (const signal of signals) {
    const key = `${signal.mechanismId}:${signal.variant}`;
    const group = groups.get(key) || { mechanismId: signal.mechanismId,
      variant: signal.variant, signals: [] };
    group.signals.push(signal); groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    mechanismId: group.mechanismId,
    variant: group.variant,
    capitalScenarios: Object.fromEntries(capitals.map((capital) => [capital,
      summarizeSignals(group.signals, capital)])),
  }));
}

function parseArgs(argv) {
  const pairs = Object.fromEntries(argv.slice(2).filter((value) => value.startsWith('--'))
    .map((value) => {
      const [key, raw = 'true'] = value.slice(2).split('='); return [key, raw];
    }));
  return { days: Math.max(60, Math.min(365, parseInt(pairs.days || '180', 10) || 180)) };
}

async function main() {
  const { days } = parseArgs(process.argv);
  const endTime = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  const startTime = endTime - days * 24 * HOUR_MS;
  const series = Object.fromEntries(await Promise.all(ASSETS.map(async (asset) => [asset,
    await fetchHourlyKlines(asset, startTime, endTime)])));
  const fundingByAsset = Object.fromEntries(await Promise.all(ASSETS.map(async (asset) => [asset,
    await fetchFunding(asset, startTime, endTime)])));
  const rows = alignSeries(series);
  const leadLag = conditionalLeadLag(rows, [
    { mechanismId: 'C05', leader: 'BTC', target: 'ETH' },
    { mechanismId: 'C05', leader: 'BTC', target: 'SOL' },
    { mechanismId: 'C05', leader: 'BTC', target: 'XRP' },
    { mechanismId: 'C06', leader: 'ETH', target: 'SOL' },
  ]);
  const residual = commonFactorResidual(rows);
  const funding = fundingRegime(rows, fundingByAsset);
  const report = {
    format: 'deltaforge-free-cex-mechanism-backtest-v1',
    generatedAt: new Date().toISOString(),
    source: 'Official public Binance hourly klines and perpetual funding history',
    requestedDays: days,
    alignedHours: rows.length,
    firstAt: rows[0] ? new Date(rows[0].time).toISOString() : null,
    lastAt: rows.length ? new Date(rows.at(-1).time).toISOString() : null,
    frozenAssumptions: {
      trailingWindowHours: LOOKBACK_HOURS,
      holdingHours: HOLDING_HOURS,
      roundTripCostBps: ROUND_TRIP_COST_BPS,
      doubledCostBps: 2 * ROUND_TRIP_COST_BPS,
      notionalFraction: 0.5,
      leadLag: 'positive causal lag slope/correlation in both 15-day halves; 95th percentile leader shock; 75th percentile aligned taker flow; target under-response',
      commonFactor: '24-hour SOL/XRP residual outside +/-2 prior trailing standard deviations; four-hour mean-reversion hold',
      fundingMomentum: 'absolute funding above its prior 30-day 95th percentile with four-hour price/flow/funding sign alignment',
      fundingReversal: 'same funding extreme after one completed hour reverses prior three-hour price and flow',
      session: 'fixed 00:00/08:00/16:00 UTC descriptive handoffs; no direction is invented',
    },
    results: mechanismReport([...leadLag, ...residual, ...funding.momentum, ...funding.reversal]),
    zeroSignalMechanisms: ['C05', 'C06', 'C07', 'C10', 'C11'].filter((id) =>
      ![...leadLag, ...residual, ...funding.momentum, ...funding.reversal]
        .some((row) => row.mechanismId === id)),
    sessionHandoff: sessionHandoff(rows),
    verdictRule: 'A family survives only if doubled-cost PnL is positive in both chronological halves and its day-clustered lower confidence bound is above zero. This cheap screen does not itself satisfy the 300-unit forward promotion contract.',
    limitations: [
      'Hourly bars do not reconstruct sub-hour book depth, rejects or queueing; $250/$500 notionals are small but execution remains modeled.',
      'The screen tests fixed mechanisms once. It does not optimize assets, horizons, z-scores or cost assumptions from the output.',
      'Each strategy is shown in isolation; results may not be summed because signals share capital and correlated crypto exposure.',
      'Positive discovery results require a new frozen forward identity and cannot inherit this PnL.',
    ],
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message); process.exit(1);
});

module.exports = {
  alignSeries,
  commonFactorResidual,
  conditionalLeadLag,
  correlation,
  fundingRegime,
  mechanismReport,
  pairStats,
  sessionHandoff,
  summarizeSignals,
};
