#!/usr/bin/env node
/**
 * Build the frozen H43-X empirical terminal-move envelope.
 *
 * The model uses only Chainlink RTDS observations at each horizon and at the
 * contract boundary. PostgreSQL NUMERIC/DECIMAL values are parsed explicitly.
 * The output is a research artifact, never an online-fitted model.
 */
'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const { createResearchPool } = require('./lib/research-pool');
const {
  MIN_MODEL_SAMPLES,
  MODEL_CUTOFF,
  MODEL_QUANTILE,
  MODEL_VERSION,
  TERMINAL_HORIZONS_SEC,
  modelHash,
} = require('../borg/shadow/priority-successors')._test;

const ASSETS = Object.freeze(['btc', 'eth', 'sol', 'xrp']);

function parseArgs(argv) {
  const args = {
    cutoff: MODEL_CUTOFF,
    days: 30,
    quantile: MODEL_QUANTILE,
    minimumSamples: MIN_MODEL_SAMPLES,
    out: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--cutoff') args.cutoff = argv[++index];
    else if (value === '--days') args.days = Number(argv[++index]);
    else if (value === '--out') args.out = argv[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!Number.isFinite(Date.parse(args.cutoff))) throw new Error('Invalid --cutoff timestamp');
  if (!(args.days > 0 && args.days <= 365)) throw new Error('--days must be in (0,365]');
  if (Date.parse(args.cutoff) > Date.parse(MODEL_CUTOFF)) {
    throw new Error(`Cutoff must not exceed frozen cutoff ${MODEL_CUTOFF}`);
  }
  return args;
}

function empiricalQuantile(values, probability) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const index = Math.max(0, Math.ceil(probability * sorted.length) - 1);
  return sorted[Math.min(index, sorted.length - 1)];
}

function summarize(values, quantile) {
  const clean = values.filter(Number.isFinite);
  if (!clean.length) return null;
  const adverseMoveBps = empiricalQuantile(clean.map(Math.abs), quantile);
  return {
    n: clean.length,
    successes: clean.filter((value) => Math.abs(value) <= adverseMoveBps + 1e-12).length,
    adverseMoveBps,
    medianAbsMoveBps: empiricalQuantile(clean.map(Math.abs), 0.5),
    p95AbsMoveBps: empiricalQuantile(clean.map(Math.abs), 0.95),
    p99AbsMoveBps: empiricalQuantile(clean.map(Math.abs), 0.99),
  };
}

function buildTailModel(samples, options = {}) {
  const cutoff = options.cutoff || MODEL_CUTOFF;
  const days = Number(options.days || 30);
  const quantile = Number(options.quantile || MODEL_QUANTILE);
  const minimumSamples = Number(options.minimumSamples || MIN_MODEL_SAMPLES);
  const buckets = { pooled: {} };
  for (const asset of ASSETS) buckets[asset] = {};

  for (const horizonSec of TERMINAL_HORIZONS_SEC) {
    const pooled = samples.filter((row) => Number(row.horizonSec) === horizonSec)
      .map((row) => Number(row.terminalMoveBps));
    buckets.pooled[String(horizonSec)] = summarize(pooled, quantile);
    for (const asset of ASSETS) {
      const values = samples.filter((row) => row.asset === asset &&
          Number(row.horizonSec) === horizonSec)
        .map((row) => Number(row.terminalMoveBps));
      buckets[asset][String(horizonSec)] = summarize(values, quantile);
    }
  }

  const model = {
    version: MODEL_VERSION,
    trainedThrough: new Date(cutoff).toISOString(),
    lookbackDays: days,
    quantile,
    minimumSamples,
    horizonSeconds: [...TERMINAL_HORIZONS_SEC],
    source: 'borg_rtds_ticks:chainlink_rtds',
    endpointToleranceMs: 3000,
    construction: 'absolute Chainlink RTDS t-to-boundary return; nearest observed rank quantile',
    buckets,
  };
  model.sha256 = modelHash(model);
  return model;
}

async function loadSamples(pool, options) {
  const { rows } = await pool.query(`
    WITH eligible AS (
      SELECT id, lower(asset) AS asset, window_end
      FROM borg_markets
      WHERE market_type='direction_5m'
        AND lower(asset) = ANY($1::text[])
        AND chainlink_open_src='chainlink_rtds_nearest_3s'
        AND outcome IS NOT NULL
        AND window_end <= $2::timestamptz
        AND window_end >= $2::timestamptz - ($3::text || ' days')::interval
    ), targets AS (
      SELECT e.*, horizon_sec,
             e.window_end - make_interval(secs => horizon_sec) AS horizon_at
      FROM eligible e
      CROSS JOIN unnest($4::int[]) AS horizon_sec
    )
    SELECT t.id AS market_id,t.asset,t.horizon_sec,
           start_tick.value AS start_value,end_tick.value AS end_value,
           start_tick.received_at AS start_received_at,
           end_tick.received_at AS end_received_at
    FROM targets t
    JOIN LATERAL (
      SELECT value,received_at
      FROM borg_rtds_ticks
      WHERE source='chainlink_rtds' AND asset=t.asset
        AND received_at BETWEEN t.horizon_at - interval '3 seconds'
                            AND t.horizon_at + interval '3 seconds'
      ORDER BY abs(extract(epoch FROM (received_at-t.horizon_at)))
      LIMIT 1
    ) start_tick ON true
    JOIN LATERAL (
      SELECT value,received_at
      FROM borg_rtds_ticks
      WHERE source='chainlink_rtds' AND asset=t.asset
        AND received_at BETWEEN t.window_end - interval '3 seconds'
                            AND t.window_end + interval '3 seconds'
      ORDER BY abs(extract(epoch FROM (received_at-t.window_end)))
      LIMIT 1
    ) end_tick ON true
    ORDER BY t.window_end,t.asset,t.horizon_sec`, [
    ASSETS,
    options.cutoff,
    String(options.days),
    TERMINAL_HORIZONS_SEC,
  ]);
  return rows.map((row) => {
    const start = parseFloat(row.start_value);
    const end = parseFloat(row.end_value);
    return {
      marketId: String(row.market_id),
      asset: String(row.asset),
      horizonSec: parseInt(row.horizon_sec, 10),
      terminalMoveBps: start > 0 && end > 0 ? 10000 * Math.log(end / start) : NaN,
      startReceivedAt: row.start_received_at,
      endReceivedAt: row.end_received_at,
    };
  }).filter((row) => Number.isFinite(row.terminalMoveBps));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const pool = createResearchPool({ applicationName: 'deltaforge-h43x-trainer',
    statementTimeoutMs: 120000 });
  try {
    const samples = await loadSamples(pool, options);
    const model = buildTailModel(samples, options);
    const serialized = `${JSON.stringify(model, null, 2)}\n`;
    if (options.out) {
      const outputPath = path.resolve(options.out);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, serialized, { mode: 0o640 });
      process.stderr.write(`wrote ${outputPath} (${samples.length} horizon samples)\n`);
    } else {
      process.stdout.write(serialized);
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = { ASSETS, buildTailModel, empiricalQuantile, loadSamples, parseArgs, summarize };
