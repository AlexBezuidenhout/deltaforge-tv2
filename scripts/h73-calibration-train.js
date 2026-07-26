#!/usr/bin/env node
/**
 * Reproducible H73 calibration builder.
 *
 * The script prints an artifact to stdout; it never overwrites the frozen
 * model used by a running experiment. A retrain is a new hypothesis/version,
 * not an in-place update.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const serviceEnv = process.env.TV2_ENV_FILE || '/etc/deltaforge/tv2.env';
if (!process.env.DATABASE_URL && fs.existsSync(serviceEnv)) {
  require('dotenv').config({ path: serviceEnv });
}
const { Pool } = require('pg');

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integer(value) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function wilson(successes, trials, z = 1.96) {
  if (!(trials > 0) || successes < 0 || successes > trials) return null;
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

function rounded(value, digits = 8) {
  const parsed = finite(value);
  return parsed == null ? null : +parsed.toFixed(digits);
}

function buildArtifact(rows, cutoff) {
  const buckets = rows.map((row) => {
    const bucket = integer(row.bucket);
    const n = integer(row.n);
    const positiveOutcomes = integer(row.positive_outcomes);
    const realized = positiveOutcomes / n;
    const interval = wilson(positiveOutcomes, n);
    return {
      bucket,
      lower: bucket / 10,
      upper: (bucket + 1) / 10,
      n,
      positive_outcomes: positiveOutcomes,
      mean_market_probability: rounded(row.mean_market_probability),
      realized_probability: rounded(realized),
      wilson_lower: rounded(interval.lower),
      wilson_upper: rounded(interval.upper),
    };
  });
  const hashRows = buckets.map((row) => [
    row.bucket,
    row.n,
    row.positive_outcomes,
    row.mean_market_probability,
  ]);
  return {
    artifact_format: 'borg-market-prior-calibration-v1',
    model_scope: 'paper_forward_only',
    strategy: 'H73_market_prior_calibration_residual',
    paper_only: true,
    generated_at: new Date().toISOString(),
    data_cutoff: cutoff,
    dataset_hash: crypto.createHash('sha256')
      .update(JSON.stringify(hashRows)).digest('hex'),
    selection: {
      market_type: 'direction_5m',
      assets: ['btc', 'eth', 'sol', 'xrp'],
      decision_tte_sec: 120,
      snapshot_window_sec: [110, 130],
      one_snapshot_per_market:
        'minimum absolute distance from T-120, then earliest timestamp',
      eligible_probability_interval: [0.01, 0.99],
      independent_markets: buckets.reduce((sum, row) => sum + row.n, 0),
      first_market_end: rows.map((row) => row.first_market_end)
        .filter(Boolean).sort()[0] || null,
      last_market_end: rows.map((row) => row.last_market_end)
        .filter(Boolean).sort().at(-1) || null,
    },
    estimator: {
      kind: 'ten_equal_width_market_probability_buckets',
      target: 'positive outcome frequency',
      interval: 'two-sided Wilson score interval',
      confidence_level: 0.95,
      minimum_cell_n: 100,
      pnl_used_to_fit: false,
      disclosure:
        'Calibration artifact only. A new cutoff or estimator requires a new strategy and evidence clock.',
    },
    buckets,
  };
}

async function loadRows(pool, cutoff) {
  const { rows } = await pool.query(`
    WITH picked AS (
      SELECT DISTINCT ON (b.market_id)
             b.market_id,b.ts,b.up_mid,m.outcome,m.positive_label,m.window_end
        FROM borg_book_snaps b
        JOIN borg_markets m ON m.id=b.market_id
       WHERE m.market_type='direction_5m'
         AND m.asset=ANY($1::text[])
         AND m.outcome IS NOT NULL
         AND b.up_mid BETWEEN 0.01 AND 0.99
         AND b.up_best_ask BETWEEN 0.01 AND 0.99
         AND b.down_best_ask BETWEEN 0.01 AND 0.99
         AND b.tte_sec BETWEEN 110 AND 130
         AND b.ts<$2
       ORDER BY b.market_id,abs(b.tte_sec-120),b.ts
    ), bucketed AS (
      SELECT least(9,floor(up_mid*10))::int bucket,
             up_mid,window_end,(outcome=positive_label)::int y
        FROM picked
    )
    SELECT bucket,count(*)::int n,sum(y)::int positive_outcomes,
           avg(up_mid)::float8 mean_market_probability,
           min(window_end) first_market_end,max(window_end) last_market_end
      FROM bucketed
     GROUP BY bucket
     ORDER BY bucket
  `, [['btc', 'eth', 'sol', 'xrp'], cutoff]);
  return rows;
}

async function main() {
  const cutoff = new Date(arg('cutoff', new Date().toISOString()));
  if (!Number.isFinite(cutoff.getTime())) throw new Error('Invalid --cutoff');
  const localSocket = !process.env.DATABASE_URL && fs.existsSync('/var/run/postgresql');
  if (!process.env.DATABASE_URL && !localSocket) {
    throw new Error(`DATABASE_URL is missing; set it in .env or ${serviceEnv}`);
  }
  const local = localSocket
    || /(?:localhost|127\.0\.0\.1|\/deltaforge)/i.test(process.env.DATABASE_URL);
  const pool = new Pool(localSocket
    ? { host: '/var/run/postgresql', database: 'deltaforge', max: 1 }
    : {
        connectionString: process.env.DATABASE_URL,
        ssl: local ? false : { rejectUnauthorized: false },
        max: 1,
      });
  try {
    const rows = await loadRows(pool, cutoff.toISOString());
    if (rows.length !== 10) {
      throw new Error(`Expected ten populated probability buckets, received ${rows.length}`);
    }
    process.stdout.write(`${JSON.stringify(
      buildArtifact(rows, cutoff.toISOString()), null, 2,
    )}\n`);
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

module.exports = { buildArtifact, loadRows, wilson };
