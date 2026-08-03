#!/usr/bin/env node
'use strict';

/**
 * Structural edge audit for the BORG research dataset.
 *
 * This is deliberately read-only. It scans immutable one-second book archives
 * plus the rolling database tail and answers two separate questions:
 *
 *  1. How often did a same-market UP+DOWN complement identity appear to be
 *     executable after two times the published crypto taker fee curve?
 *  2. Does a four-state model (60-second CEX direction x Polymarket side of
 *     50%) add out-of-sample information beyond the executable market price?
 *
 * The train/test split is chronological by five-minute window, observations
 * are one per market per time-to-expiry target, and every simulated trade uses
 * the displayed ask, top-level capacity, a 20% depth participation cap, a $10
 * stake cap, and a one-cent edge buffer after 2x fees. No threshold is selected
 * from the test set. Results remain PROVISIONAL until a frozen forward arm has
 * at least 300 independent markets and 14 calendar days.
 *
 * Usage:
 *   BORG_ARCHIVE_DIR=/path/to/borg-raw node scripts/structural-edge-audit.js
 *
 * Requires DATABASE_URL in .env and archive files produced by borg/shadow/archive.js.
 */

process.removeAllListeners('warning');
require('dotenv').config();

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { lfDelimitedLines } = require('../borg/research/strict-ndjson');
const { Pool } = require('pg');

const ARCHIVE_ROOT = process.env.BORG_ARCHIVE_DIR
  || path.join(os.homedir(), '.deltaforge-archive', 'borg-raw');
const TARGET_TTE = [240, 180, 120, 60];
const TARGET_TOLERANCE_SEC = 2.5;
const MOMENTUM_LOOKBACK_SEC = 60;
const MOMENTUM_MIN_HISTORY_SEC = 55;
const CRYPTO_TAKER_RATE = 0.07;
const STRESSED_FEE_MULTIPLIER = 2;
const EDGE_BUFFER_PER_SHARE = 0.01;
const STAKE_CAP_USD = 10;
const DEPTH_PARTICIPATION = 0.20;
const TRAIN_SHARE = 0.60;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampProbability(value) {
  return Math.max(0.001, Math.min(0.999, value));
}

function feePerShare(price, multiplier = 1) {
  return multiplier * CRYPTO_TAKER_RATE * price * (1 - price);
}

function round(value, digits = 4) {
  return Number.isFinite(value) ? +value.toFixed(digits) : null;
}

function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * quantile;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
}

function listArchives(table) {
  const root = path.join(ARCHIVE_ROOT, table);
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const day of fs.readdirSync(root).sort()) {
    const dayPath = path.join(root, day);
    if (!fs.statSync(dayPath).isDirectory()) continue;
    for (const name of fs.readdirSync(dayPath).sort()) {
      if (name.endsWith('.ndjson.gz')) files.push(path.join(dayPath, name));
    }
  }
  return files;
}

function topLevel(levels) {
  if (!Array.isArray(levels) || !Array.isArray(levels[0])) return [null, null];
  return [finite(levels[0][0]), finite(levels[0][1])];
}

function normalizedSnapshot(row) {
  const upBestBid = finite(row.up_best_bid);
  const upBestAsk = finite(row.up_best_ask);
  const downBestBid = finite(row.down_best_bid);
  const downBestAsk = finite(row.down_best_ask);
  const [, upAskSize] = topLevel(row.up_asks);
  const [, downAskSize] = topLevel(row.down_asks);
  const [, upBidSize] = topLevel(row.up_bids);
  const [, downBidSize] = topLevel(row.down_bids);
  const at = new Date(row.ts).getTime();
  const mid = finite(row.up_mid)
    ?? (upBestBid != null && upBestAsk != null ? (upBestBid + upBestAsk) / 2 : null);
  return {
    id: String(row.id),
    at,
    marketId: Number(row.market_id),
    tte: finite(row.tte_sec),
    upBestBid,
    upBestAsk,
    downBestBid,
    downBestAsk,
    upAskSize,
    downAskSize,
    upBidSize,
    downBidSize,
    mid,
    cexPrice: finite(row.btc_price),
    phiFair: finite(row.phi_fair),
    bookSource: String(row.book_src || ''),
  };
}

function stateFor(observation) {
  const cexUp = observation.momentumBps >= 0;
  const marketUp = observation.mid >= 0.5;
  if (cexUp && marketUp) return 0;
  if (cexUp && !marketUp) return 1;
  if (!cexUp && marketUp) return 2;
  return 3;
}

const STATE_NAMES = [
  'CEX_UP__MARKET_UP',
  'CEX_UP__MARKET_DOWN',
  'CEX_DOWN__MARKET_UP',
  'CEX_DOWN__MARKET_DOWN',
];

function logistic(value) {
  const bounded = Math.max(-30, Math.min(30, value));
  return 1 / (1 + Math.exp(-bounded));
}

function solveLinear(matrix, vector) {
  const n = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    if (Math.abs(augmented[column][column]) < 1e-9) augmented[column][column] = 1e-9;
    for (let row = column + 1; row < n; row += 1) {
      const scale = augmented[row][column] / augmented[column][column];
      for (let k = column; k <= n; k += 1) {
        augmented[row][k] -= scale * augmented[column][k];
      }
    }
  }
  const solution = new Array(n);
  for (let row = n - 1; row >= 0; row -= 1) {
    let value = augmented[row][n];
    for (let column = row + 1; column < n; column += 1) {
      value -= augmented[row][column] * solution[column];
    }
    solution[row] = value / augmented[row][row];
  }
  return solution;
}

function fitLogistic(rows, feature) {
  if (!rows.length) return null;
  let coefficients = new Array(feature(rows[0]).length).fill(0);
  for (let iteration = 0; iteration < 40; iteration += 1) {
    const dimension = coefficients.length;
    const hessian = Array.from({ length: dimension }, () => new Array(dimension).fill(0));
    const gradient = new Array(dimension).fill(0);
    for (const row of rows) {
      const x = feature(row);
      const probability = logistic(x.reduce((sum, value, index) => sum + value * coefficients[index], 0));
      const weight = Math.max(1e-6, probability * (1 - probability));
      for (let i = 0; i < dimension; i += 1) {
        gradient[i] += x[i] * (row.outcome - probability);
        for (let j = 0; j < dimension; j += 1) hessian[i][j] += weight * x[i] * x[j];
      }
    }
    // Numerical ridge only; it is not a fitted regularization parameter.
    for (let i = 0; i < coefficients.length; i += 1) hessian[i][i] += 1e-6;
    const step = solveLinear(hessian, gradient);
    let largest = 0;
    for (let i = 0; i < coefficients.length; i += 1) {
      coefficients[i] += step[i];
      largest = Math.max(largest, Math.abs(step[i]));
    }
    if (largest < 1e-8) break;
  }
  return coefficients;
}

function marketFeatures(row) {
  const p = clampProbability(row.mid);
  return [1, Math.log(p / (1 - p))];
}

function fourStateFeatures(row) {
  const state = stateFor(row);
  return [
    ...marketFeatures(row),
    state === 1 ? 1 : 0,
    state === 2 ? 1 : 0,
    state === 3 ? 1 : 0,
  ];
}

function predict(coefficients, features) {
  if (!coefficients) return null;
  return clampProbability(logistic(
    features.reduce((sum, value, index) => sum + value * coefficients[index], 0)
  ));
}

function scoreProbability(rows, probabilityFor) {
  if (!rows.length) return { n: 0, brier: null, logLoss: null };
  let brier = 0;
  let logLoss = 0;
  for (const row of rows) {
    const probability = clampProbability(probabilityFor(row));
    brier += (probability - row.outcome) ** 2;
    logLoss += -(row.outcome * Math.log(probability) + (1 - row.outcome) * Math.log(1 - probability));
  }
  return {
    n: rows.length,
    brier: round(brier / rows.length),
    logLoss: round(logLoss / rows.length),
  };
}

let randomState = 0x9e3779b9;
function seededRandom() {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
  return randomState / 0x100000000;
}

function clusteredMeanCi(bets, field, iterations = 10000) {
  const clusters = new Map();
  for (const bet of bets) {
    const key = String(bet.windowStart);
    const value = clusters.get(key) || { pnl: 0, trades: 0 };
    value.pnl += bet[field];
    value.trades += 1;
    clusters.set(key, value);
  }
  const values = [...clusters.values()];
  if (values.length < 2) return [null, null];
  const samples = new Array(iterations);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let pnl = 0;
    let trades = 0;
    for (let index = 0; index < values.length; index += 1) {
      const selected = values[(seededRandom() * values.length) | 0];
      pnl += selected.pnl;
      trades += selected.trades;
    }
    samples[iteration] = pnl / Math.max(1, trades);
  }
  samples.sort((a, b) => a - b);
  return [samples[Math.floor(iterations * 0.025)], samples[Math.floor(iterations * 0.975)]];
}

function simulateTrades(rows, probabilityFor) {
  const bets = [];
  for (const row of rows) {
    const fairUp = probabilityFor(row);
    if (!Number.isFinite(fairUp)) continue;
    const upEdge = fairUp - row.upBestAsk - feePerShare(row.upBestAsk, STRESSED_FEE_MULTIPLIER);
    const downEdge = (1 - fairUp) - row.downBestAsk
      - feePerShare(row.downBestAsk, STRESSED_FEE_MULTIPLIER);
    if (Math.max(upEdge, downEdge) < EDGE_BUFFER_PER_SHARE) continue;
    const isUp = upEdge >= downEdge;
    const price = isUp ? row.upBestAsk : row.downBestAsk;
    const displayedShares = isUp ? row.upAskSize : row.downAskSize;
    if (!(price > 0 && price < 1 && displayedShares > 0)) continue;
    const notional = Math.min(STAKE_CAP_USD, displayedShares * price * DEPTH_PARTICIPATION);
    if (notional < 1) continue;
    const shares = notional / price;
    const won = row.outcome === (isUp ? 1 : 0);
    const gross = shares * ((won ? 1 : 0) - price);
    bets.push({
      marketId: row.marketId,
      windowStart: row.windowStart,
      asset: row.asset,
      won,
      notional,
      pnl1x: gross - shares * feePerShare(price, 1),
      pnl2x: gross - shares * feePerShare(price, 2),
    });
  }
  const sum = (field, subset = bets) => subset.reduce((total, bet) => total + bet[field], 0);
  const half = Math.floor(bets.length / 2);
  const ci = clusteredMeanCi(bets, 'pnl2x');
  const byAsset = {};
  for (const asset of [...new Set(bets.map((bet) => bet.asset))].sort()) {
    const subset = bets.filter((bet) => bet.asset === asset);
    byAsset[asset] = {
      trades: subset.length,
      wins: subset.filter((bet) => bet.won).length,
      pnl2x: round(sum('pnl2x', subset), 2),
    };
  }
  return {
    trades: bets.length,
    independentMarkets: new Set(bets.map((bet) => bet.marketId)).size,
    windowClusters: new Set(bets.map((bet) => bet.windowStart)).size,
    wins: bets.filter((bet) => bet.won).length,
    winRate: bets.length ? round(bets.filter((bet) => bet.won).length / bets.length, 3) : null,
    notional: round(sum('notional'), 2),
    pnl1x: round(sum('pnl1x'), 2),
    pnl2x: round(sum('pnl2x'), 2),
    meanPnl2x: bets.length ? round(sum('pnl2x') / bets.length, 4) : null,
    clusteredMeanCi95: ci.map((value) => round(value, 4)),
    firstHalfPnl2x: round(sum('pnl2x', bets.slice(0, half)), 2),
    secondHalfPnl2x: round(sum('pnl2x', bets.slice(half)), 2),
    byAsset,
  };
}

function stateCalibration(rows, probabilityFor) {
  return STATE_NAMES.map((name, state) => {
    const subset = rows.filter((row) => stateFor(row) === state);
    return {
      state: name,
      n: subset.length,
      marketUp: subset.length ? round(subset.reduce((sum, row) => sum + row.mid, 0) / subset.length) : null,
      predictedUp: subset.length
        ? round(subset.reduce((sum, row) => sum + probabilityFor(row), 0) / subset.length)
        : null,
      realizedUp: subset.length
        ? round(subset.reduce((sum, row) => sum + row.outcome, 0) / subset.length)
        : null,
    };
  });
}

class AuditAccumulator {
  constructor(markets) {
    this.markets = markets;
    this.history = new Map();
    this.candidates = new Map();
    this.pairRuns = new Map();
    this.pairEpisodes = [];
    this.rows = 0;
    this.acceptedRows = 0;
    this.firstAt = null;
    this.lastAt = null;
  }

  _closePair(marketId) {
    const active = this.pairRuns.get(marketId);
    if (active) this.pairEpisodes.push(active);
    this.pairRuns.delete(marketId);
  }

  _pair(snapshot, market) {
    if (!snapshot.bookSource.startsWith('ws')) {
      this._closePair(snapshot.marketId);
      return;
    }
    const valid = [
      snapshot.upBestBid, snapshot.upBestAsk,
      snapshot.downBestBid, snapshot.downBestAsk,
    ].every((value) => value != null && value > 0 && value < 1);
    if (!valid) {
      this._closePair(snapshot.marketId);
      return;
    }
    const buyEdge = 1 - snapshot.upBestAsk - snapshot.downBestAsk
      - feePerShare(snapshot.upBestAsk, STRESSED_FEE_MULTIPLIER)
      - feePerShare(snapshot.downBestAsk, STRESSED_FEE_MULTIPLIER);
    const sellEdge = snapshot.upBestBid + snapshot.downBestBid - 1
      - feePerShare(snapshot.upBestBid, STRESSED_FEE_MULTIPLIER)
      - feePerShare(snapshot.downBestBid, STRESSED_FEE_MULTIPLIER);
    const kind = buyEdge >= sellEdge ? 'BUY_COMPLEMENT' : 'SELL_SPLIT_INVENTORY';
    const edge = Math.max(buyEdge, sellEdge);
    if (!(edge > 0)) {
      this._closePair(snapshot.marketId);
      return;
    }
    const displayedShares = kind === 'BUY_COMPLEMENT'
      ? Math.min(snapshot.upAskSize || 0, snapshot.downAskSize || 0)
      : Math.min(snapshot.upBidSize || 0, snapshot.downBidSize || 0);
    const previous = this.pairRuns.get(snapshot.marketId);
    if (!previous || previous.kind !== kind || snapshot.at - previous.lastAt > 2500) {
      this._closePair(snapshot.marketId);
      this.pairRuns.set(snapshot.marketId, {
        marketId: snapshot.marketId,
        asset: market.asset,
        kind,
        startAt: snapshot.at,
        lastAt: snapshot.at,
        observations: 1,
        maxEdge: edge,
        maxDisplayedShares: displayedShares,
      });
      return;
    }
    previous.lastAt = snapshot.at;
    previous.observations += 1;
    previous.maxEdge = Math.max(previous.maxEdge, edge);
    previous.maxDisplayedShares = Math.max(previous.maxDisplayedShares, displayedShares);
  }

  add(raw) {
    this.rows += 1;
    const snapshot = normalizedSnapshot(raw);
    const market = this.markets.get(snapshot.marketId);
    if (!market || market.marketType !== 'direction_5m' || market.outcome == null) return;
    if (!Number.isFinite(snapshot.at) || !Number.isFinite(snapshot.tte) ||
        !(snapshot.mid > 0.01 && snapshot.mid < 0.99) || !(snapshot.cexPrice > 0)) return;
    this.acceptedRows += 1;
    this.firstAt = this.firstAt == null ? snapshot.at : Math.min(this.firstAt, snapshot.at);
    this.lastAt = this.lastAt == null ? snapshot.at : Math.max(this.lastAt, snapshot.at);
    this._pair(snapshot, market);

    const history = this.history.get(snapshot.marketId) || [];
    history.push({ at: snapshot.at, cexPrice: snapshot.cexPrice, mid: snapshot.mid });
    while (history.length && history[0].at < snapshot.at - 70000) history.shift();
    this.history.set(snapshot.marketId, history);
    const old = [...history].reverse().find((entry) => entry.at <= snapshot.at - MOMENTUM_LOOKBACK_SEC * 1000);
    if (!old || snapshot.at - old.at < MOMENTUM_MIN_HISTORY_SEC * 1000) return;
    const momentumBps = 10000 * Math.log(snapshot.cexPrice / old.cexPrice);
    if (!Number.isFinite(momentumBps)) return;

    for (const target of TARGET_TTE) {
      const distance = Math.abs(snapshot.tte - target);
      if (distance > TARGET_TOLERANCE_SEC) continue;
      const key = `${snapshot.marketId}:${target}`;
      const previous = this.candidates.get(key);
      if (previous && previous.targetDistance <= distance) continue;
      if (!(snapshot.upBestAsk > 0.01 && snapshot.upBestAsk < 0.99 &&
            snapshot.downBestAsk > 0.01 && snapshot.downBestAsk < 0.99 &&
            snapshot.upAskSize > 0 && snapshot.downAskSize > 0)) continue;
      this.candidates.set(key, {
        ...snapshot,
        targetTte: target,
        targetDistance: distance,
        momentumBps,
        asset: market.asset,
        outcome: market.outcome,
        windowStart: market.windowStart,
      });
    }
  }

  finish() {
    for (const marketId of [...this.pairRuns.keys()]) this._closePair(marketId);
  }
}

async function scanArchive(files, accumulator) {
  for (let index = 0; index < files.length; index += 1) {
    const input = fs.createReadStream(files[index]).pipe(zlib.createGunzip());
    for await (const line of lfDelimitedLines(input)) {
      if (!line || line.startsWith('{"_borg_archive"')) continue;
      try { accumulator.add(JSON.parse(line)); } catch (_) { /* corrupt line excluded */ }
    }
    if ((index + 1) % 50 === 0) process.stderr.write(`book archives ${index + 1}/${files.length}\n`);
  }
}

async function scanRollingTail(accumulator) {
  const { rows } = await pool.query(`
    SELECT id, ts, market_id, tte_sec, up_bids, up_asks, down_bids, down_asks,
      up_best_bid, up_best_ask, up_mid, down_best_bid, down_best_ask,
      book_src, btc_price, phi_fair
    FROM borg_book_snaps
    ORDER BY ts, id
  `);
  for (const row of rows) accumulator.add(row);
  return rows.length;
}

function splitChronologically(rows) {
  const windows = [...new Set(rows.map((row) => row.windowStart))].sort((a, b) => a - b);
  if (windows.length < 3) return { train: [], test: [], splitAt: null };
  const splitAt = windows[Math.max(1, Math.floor(windows.length * TRAIN_SHARE))];
  return {
    train: rows.filter((row) => row.windowStart < splitAt),
    test: rows.filter((row) => row.windowStart >= splitAt),
    splitAt,
  };
}

function modelReport(rows) {
  const { train, test, splitAt } = splitChronologically(rows);
  if (!train.length || !test.length) return { train: train.length, test: test.length };
  const marketCoefficients = fitLogistic(train, marketFeatures);
  const fourStateCoefficients = fitLogistic(train, fourStateFeatures);
  const marketProbability = (row) => predict(marketCoefficients, marketFeatures(row));
  const fourStateProbability = (row) => predict(fourStateCoefficients, fourStateFeatures(row));
  return {
    total: rows.length,
    train: train.length,
    test: test.length,
    splitAt: new Date(splitAt).toISOString(),
    rawMarket: scoreProbability(test, (row) => row.mid),
    phi: scoreProbability(test.filter((row) => Number.isFinite(row.phiFair)), (row) => row.phiFair),
    calibratedMarket: {
      coefficients: marketCoefficients.map((value) => round(value, 6)),
      ...scoreProbability(test, marketProbability),
      trades: simulateTrades(test, marketProbability),
    },
    fourStateResidual: {
      coefficients: fourStateCoefficients.map((value) => round(value, 6)),
      ...scoreProbability(test, fourStateProbability),
      states: stateCalibration(test, fourStateProbability),
      trades: simulateTrades(test, fourStateProbability),
    },
  };
}

function pairReport(episodes) {
  const eligible = episodes.filter((episode) => episode.observations > 0);
  const byKind = {};
  for (const kind of ['BUY_COMPLEMENT', 'SELL_SPLIT_INVENTORY']) {
    const subset = eligible.filter((episode) => episode.kind === kind);
    const capacity = subset.reduce((total, episode) => {
      const shares = Math.min(episode.maxDisplayedShares, 500);
      return total + shares * episode.maxEdge;
    }, 0);
    byKind[kind] = {
      episodes: subset.length,
      markets: new Set(subset.map((episode) => episode.marketId)).size,
      durationP50Sec: round(percentile(subset.map((episode) => (episode.lastAt - episode.startAt) / 1000), 0.5), 3),
      durationP95Sec: round(percentile(subset.map((episode) => (episode.lastAt - episode.startAt) / 1000), 0.95), 3),
      maxEdgePerShare: round(Math.max(0, ...subset.map((episode) => episode.maxEdge))),
      naiveTopLevelProfitUpperBoundUsd: round(capacity, 2),
    };
  }
  return byKind;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const files = listArchives('borg_book_snaps');
  if (!files.length) throw new Error(`No borg_book_snaps archives under ${ARCHIVE_ROOT}`);
  const { rows: marketRows } = await pool.query(`
    SELECT id, asset, market_type, window_start, upper(outcome) AS outcome
    FROM borg_markets
    WHERE market_type='direction_5m' AND upper(outcome) IN ('UP','DOWN')
  `);
  const markets = new Map(marketRows.map((row) => [Number(row.id), {
    asset: row.asset,
    marketType: row.market_type,
    windowStart: new Date(row.window_start).getTime(),
    outcome: row.outcome === 'UP' ? 1 : 0,
  }]));
  const accumulator = new AuditAccumulator(markets);
  await scanArchive(files, accumulator);
  const rollingRows = await scanRollingTail(accumulator);
  accumulator.finish();

  const observations = [...accumulator.candidates.values()]
    .sort((a, b) => a.windowStart - b.windowStart || a.marketId - b.marketId);
  const models = {};
  for (const target of TARGET_TTE) {
    models[`${target}s_to_expiry`] = modelReport(
      observations.filter((row) => row.targetTte === target)
    );
  }
  const output = {
    format: 'structural-edge-audit-v1',
    generatedAt: new Date().toISOString(),
    verdictRule: 'Exploratory only. No promotion without a frozen forward arm >=300 independent markets and >=14 calendar days.',
    method: {
      archiveRoot: ARCHIVE_ROOT,
      archiveFiles: files.length,
      rollingRows,
      rowsScanned: accumulator.rows,
      eligibleResolvedRows: accumulator.acceptedRows,
      firstObservation: accumulator.firstAt == null ? null : new Date(accumulator.firstAt).toISOString(),
      lastObservation: accumulator.lastAt == null ? null : new Date(accumulator.lastAt).toISOString(),
      chronologicalTrainShare: TRAIN_SHARE,
      momentumLookbackSec: MOMENTUM_LOOKBACK_SEC,
      targetTteSec: TARGET_TTE,
      edgeRule: `predicted fair - displayed ask - ${STRESSED_FEE_MULTIPLIER}x taker fee >= $${EDGE_BUFFER_PER_SHARE.toFixed(2)}`,
      sizing: `$${STAKE_CAP_USD} cap and ${Math.round(100 * DEPTH_PARTICIPATION)}% of displayed touch`,
    },
    complementArbitrage: {
      caveat: 'Snapshot-paired quotes are an upper bound: the two token books are not an atomic multi-leg execution, and sell-side identity requires pre-split inventory.',
      ...pairReport(accumulator.pairEpisodes),
    },
    fourStateDefinition: STATE_NAMES,
    models,
  };
  console.log(JSON.stringify(output, null, 2));
}

main()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
