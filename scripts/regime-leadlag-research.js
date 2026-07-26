#!/usr/bin/env node
/**
 * Development-only research for two proposed paper mechanisms:
 *
 *  1. a three-state Markov reward model estimated on a trailing four-hour
 *     window; and
 *  2. a four-hour rolling, liquidity-confirmed cross-asset lead/lag graph.
 *
 * This script uses official public Binance one-minute klines. It deliberately
 * reports underlying-return predictability only: without contemporaneous
 * Polymarket books it cannot claim executable token PnL. Parameters below are
 * mechanism choices fixed before this script's output was inspected.
 */
'use strict';

const {
  leadLagProfile: exactLeadLagProfile,
  markovProfile: exactMarkovProfile,
} = require('../borg/shadow/research-v9')._test;

const ASSETS = Object.freeze(['btc', 'eth', 'sol', 'xrp']);
const SYMBOLS = Object.freeze({
  btc: 'BTCUSDT',
  eth: 'ETHUSDT',
  sol: 'SOLUSDT',
  xrp: 'XRPUSDT',
});
const API = 'https://data-api.binance.vision/api/v3/klines';
const MINUTE_MS = 60_000;
const FOUR_HOURS = 240;
const MARKOV_STEP_MINUTES = 15;
const MARKOV_HORIZONS = Object.freeze([1, 5, 15]);
const LEAD_LAG_HORIZONS = Object.freeze([1, 3, 5, 15]);

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integer(value) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function mean(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function variance(values) {
  if (values.length < 2) return null;
  const center = mean(values);
  return values.reduce((sum, value) => sum + (value - center) ** 2, 0)
    / (values.length - 1);
}

function standardDeviation(values) {
  const value = variance(values);
  return value != null && value >= 0 ? Math.sqrt(value) : null;
}

function quantile(values, probability) {
  const ordered = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!ordered.length) return null;
  const index = clamp(probability, 0, 1) * (ordered.length - 1);
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return ordered[low];
  return ordered[low] + (index - low) * (ordered[high] - ordered[low]);
}

function covariance(left, right) {
  if (left.length !== right.length || left.length < 2) return null;
  const leftMean = mean(left);
  const rightMean = mean(right);
  return left.reduce((sum, value, index) =>
    sum + (value - leftMean) * (right[index] - rightMean), 0)
    / (left.length - 1);
}

function correlation(left, right) {
  const cov = covariance(left, right);
  const leftVariance = variance(left);
  const rightVariance = variance(right);
  if (cov == null || !(leftVariance > 0) || !(rightVariance > 0)) return null;
  return cov / Math.sqrt(leftVariance * rightVariance);
}

function slope(left, right) {
  const cov = covariance(left, right);
  const leftVariance = variance(left);
  return cov != null && leftVariance > 0 ? cov / leftVariance : null;
}

function wilson(successes, trials, z = 1.96) {
  if (!(trials > 0) || successes < 0 || successes > trials) {
    return { lower: null, upper: null };
  }
  const probability = successes / trials;
  const denominator = 1 + z * z / trials;
  const center = probability + z * z / (2 * trials);
  const radius = z * Math.sqrt(probability * (1 - probability) / trials
    + z * z / (4 * trials * trials));
  return {
    lower: (center - radius) / denominator,
    upper: (center + radius) / denominator,
  };
}

function round(value, places = 6) {
  return Number.isFinite(value) ? +value.toFixed(places) : null;
}

function parseDays() {
  const raw = process.argv.find((value) => value.startsWith('--days='));
  const days = raw ? integer(raw.split('=')[1]) : 30;
  return clamp(days || 30, 2, 180);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchKlines(asset, startTime, endTime) {
  const symbol = SYMBOLS[asset];
  const rows = [];
  let cursor = startTime;
  let retries = 0;
  while (cursor < endTime) {
    const url = new URL(API);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', '1m');
    url.searchParams.set('startTime', String(cursor));
    url.searchParams.set('endTime', String(endTime - 1));
    url.searchParams.set('limit', '1000');
    const response = await fetch(url, {
      headers: { 'user-agent': 'deltaforge-regime-research/1.0' },
    });
    if (response.status === 429 || response.status >= 500) {
      if (retries >= 5) throw new Error(`${symbol} kline request failed: HTTP ${response.status}`);
      retries += 1;
      await wait(Math.min(5000, 250 * 2 ** retries));
      continue;
    }
    if (!response.ok) throw new Error(`${symbol} kline request failed: HTTP ${response.status}`);
    retries = 0;
    const batch = await response.json();
    if (!Array.isArray(batch) || !batch.length) break;
    for (const raw of batch) {
      const timestamp = integer(raw[0]);
      const close = finite(raw[4]);
      const quoteVolume = finite(raw[7]);
      const trades = integer(raw[8]);
      const takerBuyQuote = finite(raw[10]);
      if (timestamp == null || !(close > 0) || timestamp < startTime
          || timestamp >= endTime) continue;
      rows.push({
        timestamp,
        close,
        trades: trades || 0,
        quoteVolume: quoteVolume || 0,
        flow: quoteVolume > 0 && takerBuyQuote != null
          ? clamp(2 * takerBuyQuote / quoteVolume - 1, -1, 1)
          : 0,
      });
    }
    const next = integer(batch.at(-1)?.[0]);
    if (next == null || next < cursor || batch.length < 1000) break;
    cursor = next + MINUTE_MS;
  }
  return rows;
}

function align(series) {
  const maps = Object.fromEntries(ASSETS.map((asset) => [
    asset,
    new Map(series[asset].map((row) => [row.timestamp, row])),
  ]));
  const timestamps = [...maps.btc.keys()]
    .filter((timestamp) => ASSETS.every((asset) => maps[asset].has(timestamp)))
    .sort((left, right) => left - right);
  const aligned = timestamps.map((timestamp) => ({
    timestamp,
    assets: Object.fromEntries(ASSETS.map((asset) => [asset, maps[asset].get(timestamp)])),
  }));
  const returns = [];
  for (let index = 1; index < aligned.length; index += 1) {
    const previous = aligned[index - 1];
    const current = aligned[index];
    if (current.timestamp - previous.timestamp !== MINUTE_MS) continue;
    returns.push({
      timestamp: current.timestamp,
      returns: Object.fromEntries(ASSETS.map((asset) => [
        asset,
        10_000 * Math.log(
          current.assets[asset].close / previous.assets[asset].close,
        ),
      ])),
      flow: Object.fromEntries(ASSETS.map((asset) => [
        asset,
        current.assets[asset].flow,
      ])),
      trades: Object.fromEntries(ASSETS.map((asset) => [
        asset,
        current.assets[asset].trades,
      ])),
    });
  }
  return returns;
}

function lagCorrelations(rows) {
  const output = [];
  for (const leader of ASSETS) {
    for (const target of ASSETS) {
      if (leader === target) continue;
      const lags = {};
      for (let lag = 0; lag <= 3; lag += 1) {
        const left = [];
        const right = [];
        for (let index = lag; index < rows.length; index += 1) {
          const leaderReturn = rows[index - lag].returns[leader];
          const targetReturn = rows[index].returns[target];
          if (Number.isFinite(leaderReturn) && Number.isFinite(targetReturn)) {
            left.push(leaderReturn);
            right.push(targetReturn);
          }
        }
        lags[`lag_${lag}`] = round(correlation(left, right));
      }
      output.push({ leader, target, ...lags });
    }
  }
  return output;
}

function stateFor(value, scale) {
  if (value < -0.5 * scale) return 0;
  if (value > 0.5 * scale) return 2;
  return 1;
}

function vectorMatrix(vector, matrix) {
  return matrix[0].map((_, column) =>
    vector.reduce((sum, value, index) => sum + value * matrix[index][column], 0));
}

function normalizedEntropy(probabilities) {
  const entropy = probabilities.reduce((sum, probability) =>
    probability > 0 ? sum - probability * Math.log(probability) : sum, 0);
  return entropy / Math.log(probabilities.length);
}

function fitMarkov(values) {
  const scale = standardDeviation(values);
  if (!(scale > 0) || values.length < 60) return null;
  const states = values.map((value) => stateFor(value, scale));
  const counts = Array.from({ length: 3 }, () => [0.5, 0.5, 0.5]);
  const rowCounts = [0, 0, 0];
  const emissions = [[], [], []];
  for (let index = 0; index < values.length; index += 1) {
    emissions[states[index]].push(values[index]);
    if (index + 1 < values.length) {
      counts[states[index]][states[index + 1]] += 1;
      rowCounts[states[index]] += 1;
    }
  }
  const transition = counts.map((row) => {
    const total = row.reduce((sum, value) => sum + value, 0);
    return row.map((value) => value / total);
  });
  return {
    scale,
    states,
    transition,
    rowCounts,
    emissionMeans: emissions.map((rows) => mean(rows) || 0),
  };
}

function markovForecast(model, currentState, horizon) {
  let distribution = [0, 0, 0];
  distribution[currentState] = 1;
  let expectedReturn = 0;
  for (let step = 0; step < horizon; step += 1) {
    distribution = vectorMatrix(distribution, model.transition);
    expectedReturn += distribution.reduce((sum, probability, state) =>
      sum + probability * model.emissionMeans[state], 0);
  }
  return {
    expectedReturn,
    finalDistribution: distribution,
  };
}

function sumFuture(rows, index, asset, horizon) {
  let value = 0;
  for (let step = 1; step <= horizon; step += 1) {
    const row = rows[index + step];
    if (!row) return null;
    value += row.returns[asset];
  }
  return value;
}

function predictionSummary(records) {
  const usable = records.filter((row) =>
    Number.isFinite(row.forecast) && row.forecast !== 0
      && Number.isFinite(row.actual));
  const signed = usable.map((row) => Math.sign(row.forecast) * row.actual);
  const successes = signed.filter((value) => value > 0).length;
  const interval = wilson(successes, signed.length);
  const average = mean(signed);
  const deviation = standardDeviation(signed);
  return {
    observations: signed.length,
    hitRate: signed.length ? round(successes / signed.length, 4) : null,
    hitWilson95: [round(interval.lower, 4), round(interval.upper, 4)],
    meanSignedFutureBps: round(average, 4),
    signedFutureSdBps: round(deviation, 4),
    meanT: signed.length > 1 && deviation > 0
      ? round(average / (deviation / Math.sqrt(signed.length)), 4)
      : null,
    forecastActualCorrelation: round(correlation(
      usable.map((row) => row.forecast),
      usable.map((row) => row.actual),
    ), 4),
  };
}

function markovResearch(rows) {
  const output = [];
  for (const asset of ASSETS) {
    for (const horizon of MARKOV_HORIZONS) {
      const all = [];
      const conditional = [];
      for (let index = FOUR_HOURS; index + horizon < rows.length;
        index += MARKOV_STEP_MINUTES) {
        const training = rows.slice(index - FOUR_HOURS + 1, index + 1)
          .map((row) => row.returns[asset]);
        const model = fitMarkov(training);
        if (!model) continue;
        const currentState = model.states.at(-1);
        const forecast = markovForecast(model, currentState, horizon);
        const actual = sumFuture(rows, index, asset, horizon);
        const record = {
          forecast: forecast.expectedReturn,
          actual,
          state: currentState,
          entropy: normalizedEntropy(model.transition[currentState]),
          stateTransitions: model.rowCounts[currentState],
        };
        all.push(record);
        // This gate is defined by model identifiability, not historical PnL:
        // at least thirty current-state transitions and at least 10% entropy
        // reduction versus a uniform three-state row.
        if (record.stateTransitions >= 30 && record.entropy <= 0.90) {
          conditional.push(record);
        }
      }
      output.push({
        asset,
        horizonMinutes: horizon,
        allStates: predictionSummary(all),
        identifiableStateOnly: predictionSummary(conditional),
      });
    }
  }
  return output;
}

function pairedLagStats(rows, leader, target, start, end) {
  const contemporaneousLeader = [];
  const contemporaneousTarget = [];
  const lagLeader = [];
  const lagTarget = [];
  for (let index = start; index < end; index += 1) {
    contemporaneousLeader.push(rows[index].returns[leader]);
    contemporaneousTarget.push(rows[index].returns[target]);
    if (index + 1 < rows.length) {
      lagLeader.push(rows[index].returns[leader]);
      lagTarget.push(rows[index + 1].returns[target]);
    }
  }
  return {
    contemporaneousBeta: slope(contemporaneousLeader, contemporaneousTarget),
    lagBeta: slope(lagLeader, lagTarget),
    lagCorrelation: correlation(lagLeader, lagTarget),
  };
}

function trailingValues(rows, start, end, selector) {
  const values = [];
  for (let index = start; index < end; index += 1) {
    const value = selector(rows[index]);
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}

function leadLagResearch(rows) {
  const records = Object.fromEntries(LEAD_LAG_HORIZONS.map((horizon) => [
    horizon,
    Object.fromEntries(ASSETS.map((target) => [target, []])),
  ]));
  const selected = new Map();
  const nextEligible = new Map(ASSETS.map((asset) => [asset, 0]));
  const maximumHorizon = Math.max(...LEAD_LAG_HORIZONS);

  for (let index = FOUR_HOURS; index + maximumHorizon < rows.length; index += 1) {
    for (const target of ASSETS) {
      if (index < nextEligible.get(target)) continue;
      const firstStart = index - FOUR_HOURS;
      const middle = index - FOUR_HOURS / 2;
      let best = null;
      for (const leader of ASSETS) {
        if (leader === target) continue;
        const first = pairedLagStats(rows, leader, target, firstStart, middle);
        const second = pairedLagStats(rows, leader, target, middle, index);
        // Positive propagation must independently exist in both two-hour
        // halves. This is deliberately stricter than choosing a full-window
        // maximum after observing the next return.
        if (!(first.lagBeta > 0 && second.lagBeta > 0
            && first.lagCorrelation > 0 && second.lagCorrelation > 0)) continue;
        const score = Math.min(first.lagCorrelation, second.lagCorrelation);
        if (!best || score > best.score) {
          best = {
            leader,
            score,
            lagBeta: Math.min(first.lagBeta, second.lagBeta),
            contemporaneousBeta: Math.min(
              first.contemporaneousBeta,
              second.contemporaneousBeta,
            ),
          };
        }
      }
      if (!best || !(best.contemporaneousBeta > 0)) continue;
      const current = rows[index];
      const leaderReturn = current.returns[best.leader];
      const targetReturn = current.returns[target];
      const historicalLeaderReturns = trailingValues(
        rows,
        firstStart,
        index,
        (row) => Math.abs(row.returns[best.leader]),
      );
      const historicalLeaderFlow = trailingValues(
        rows,
        firstStart,
        index,
        (row) => Math.abs(row.flow[best.leader]),
      );
      const returnShock = quantile(historicalLeaderReturns, 0.95);
      const flowShock = quantile(historicalLeaderFlow, 0.75);
      const expectedContemporaneous = best.contemporaneousBeta * leaderReturn;
      const liquidityConfirmed = Math.sign(leaderReturn) === Math.sign(current.flow[best.leader])
        && Math.abs(current.flow[best.leader]) >= flowShock;
      const targetUnderResponded = Math.sign(expectedContemporaneous) !== 0
        && Math.abs(targetReturn) <= 0.5 * Math.abs(expectedContemporaneous)
        && Math.abs(current.flow[target]) < Math.abs(current.flow[best.leader]);
      if (!(Math.abs(leaderReturn) >= returnShock)
          || !liquidityConfirmed || !targetUnderResponded) continue;
      const forecast = best.lagBeta * leaderReturn;
      if (!Number.isFinite(forecast) || !forecast) continue;
      selected.set(`${best.leader}->${target}`,
        (selected.get(`${best.leader}->${target}`) || 0) + 1);
      for (const horizon of LEAD_LAG_HORIZONS) {
        records[horizon][target].push({
          forecast,
          actual: sumFuture(rows, index, target, horizon),
        });
      }
      // One shock episode per target per longest evaluation horizon.
      nextEligible.set(target, index + maximumHorizon);
    }
  }
  return {
    selectionCounts: Object.fromEntries([...selected].sort()),
    results: LEAD_LAG_HORIZONS.flatMap((horizon) =>
      ASSETS.map((target) => ({
        target,
        horizonMinutes: horizon,
        ...predictionSummary(records[horizon][target]),
      }))),
  };
}

/**
 * Replays the exact H74/H75 underlying-signal rules frozen in V9. This still
 * cannot report Polymarket PnL because public klines contain no historical
 * executable token book, fee quote, queue or resolver basis.
 */
function exactV9MechanismResearch(rows) {
  const exactRows = rows.map((row) => ({
    minute: row.timestamp,
    returns: row.returns,
    flow: row.flow,
  }));
  const markov = [];
  for (const asset of ASSETS) {
    const records = [];
    for (let index = FOUR_HOURS - 1; index + 1 < rows.length;
      index += MARKOV_STEP_MINUTES) {
      const profile = exactMarkovProfile(
        rows.slice(index - FOUR_HOURS + 1, index + 1)
          .map((row) => row.returns[asset]),
      );
      if (!profile) continue;
      records.push({
        forecast: profile.conservativeForecastBps,
        actual: sumFuture(rows, index, asset, 1),
      });
    }
    markov.push({ asset, ...predictionSummary(records) });
  }

  const leadLagRecords = Object.fromEntries(LEAD_LAG_HORIZONS.map((horizon) => [
    horizon,
    Object.fromEntries(ASSETS.map((asset) => [asset, []])),
  ]));
  const selectionCounts = new Map();
  const nextEligible = new Map(ASSETS.map((asset) => [asset, 0]));
  const maximumHorizon = Math.max(...LEAD_LAG_HORIZONS);
  for (let index = FOUR_HOURS; index + maximumHorizon < exactRows.length; index += 1) {
    const window = exactRows.slice(index - FOUR_HOURS, index + 1);
    for (const target of ASSETS) {
      if (index < nextEligible.get(target)) continue;
      const profile = exactLeadLagProfile(window, target);
      if (!profile) continue;
      const key = `${profile.leader}->${target}`;
      selectionCounts.set(key, (selectionCounts.get(key) || 0) + 1);
      for (const horizon of LEAD_LAG_HORIZONS) {
        leadLagRecords[horizon][target].push({
          forecast: profile.conservativeForecastBps,
          actual: sumFuture(rows, index, target, horizon),
        });
      }
      nextEligible.set(target, index + 15);
    }
  }
  return {
    markov,
    leadLagSelectionCounts: Object.fromEntries([...selectionCounts].sort()),
    leadLag: LEAD_LAG_HORIZONS.flatMap((horizon) =>
      ASSETS.map((target) => ({
        target,
        horizonMinutes: horizon,
        ...predictionSummary(leadLagRecords[horizon][target]),
      }))),
  };
}

async function main() {
  const days = parseDays();
  const endTime = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
  const startTime = endTime - days * 24 * 60 * MINUTE_MS;
  const fetched = Object.fromEntries(await Promise.all(ASSETS.map(async (asset) => [
    asset,
    await fetchKlines(asset, startTime, endTime),
  ])));
  const rows = align(fetched);
  const report = {
    format: 'deltaforge-regime-leadlag-development-v1',
    generatedAt: new Date().toISOString(),
    source: 'official Binance public one-minute klines',
    requestedDays: days,
    alignedMinutes: rows.length,
    firstMinute: rows.length ? new Date(rows[0].timestamp).toISOString() : null,
    lastMinute: rows.length ? new Date(rows.at(-1).timestamp).toISOString() : null,
    mechanismFreeze: {
      rollingWindowMinutes: FOUR_HOURS,
      markovStates: 'DOWN/NEUTRAL/UP at +/- 0.5 trailing four-hour sigma',
      markovEvaluationCadenceMinutes: MARKOV_STEP_MINUTES,
      markovConditionalGate:
        'current state has >=30 transitions and normalized transition entropy <=0.90',
      leadLagGate:
        'positive lag-1 slope/correlation in both causal two-hour halves; leader return >= trailing 95th percentile; aligned leader flow >= trailing 75th percentile; target price and flow under-response',
      note:
        'Mechanism thresholds were fixed before this report was run and were not selected from strategy PnL.',
    },
    lagCorrelations: lagCorrelations(rows),
    markov: markovResearch(rows),
    rollingLiquidityLeadLag: leadLagResearch(rows),
    exactFrozenV9UnderlyingRules: exactV9MechanismResearch(rows),
    interpretationLimits: [
      'Underlying return predictability is not Polymarket token profitability.',
      'The test contains no Polymarket executable ask, queue, fill, fee, or resolver-basis model.',
      'Overlapping return observations are descriptive; promotion inference must cluster by independent market and UTC day.',
      'A positive development estimate cannot be used to retune the frozen rule and cannot authorize live capital.',
    ],
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = {
  align,
  fitMarkov,
  lagCorrelations,
  leadLagResearch,
  exactV9MechanismResearch,
  markovForecast,
  markovResearch,
  predictionSummary,
  stateFor,
};
