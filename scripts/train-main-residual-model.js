#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const { fit, metrics, predict } = require('../src/bot/ResidualProbabilityModel');

const TRAINING_START = process.env.MAIN_RESIDUAL_TRAINING_START || '2026-07-10T00:00:00.000Z';
const TRAINING_END = process.env.MAIN_RESIDUAL_TRAINING_END || '2026-07-15T22:26:55.888Z';
const EVIDENCE_START = process.env.MAIN_RESIDUAL_EVIDENCE_START || '2026-07-16T08:30:00.000Z';
const EXPERIMENT_ID = 'main-model-challenger-v1';
const MODEL_VERSION = 'main-residual-offset-logit-v1';

const finite = (value) => {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
};

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 });
  try {
    const { rows } = await pool.query(`
      WITH latest AS (
        SELECT DISTINCT ON (s.market_id)
          s.market_id, s.created_at, s.yes_price, s.p_heur, s.p_phi,
          s.remaining_sec, s.sigma_5min, s.asset
        FROM signals s
        WHERE s.user_id=1 AND s.created_at >= $1 AND s.created_at < $2
          AND s.yes_price BETWEEN 0.02 AND 0.98 AND s.p_heur IS NOT NULL
        ORDER BY s.market_id, s.created_at DESC
      )
      SELECT latest.*,
             CASE upper(m.outcome) WHEN 'UP' THEN 1 WHEN 'DOWN' THEN 0 END outcome
      FROM latest JOIN borg_markets m ON m.gamma_id=latest.market_id
      WHERE upper(m.outcome) IN ('UP','DOWN')
      ORDER BY latest.created_at, latest.market_id
    `, [TRAINING_START, TRAINING_END]);
    const data = rows.map((row) => ({
      ...row,
      marketProbability: finite(row.yes_price),
      heuristicProbability: finite(row.p_heur),
      phiProbability: finite(row.p_phi),
      remainingSec: finite(row.remaining_sec),
      sigma5min: finite(row.sigma_5min),
      outcome: Number(row.outcome),
    }));
    if (data.length < 300) throw new Error(`insufficient resolved training markets: ${data.length}`);

    const split = Math.floor(data.length * 0.7);
    const development = data.slice(0, split);
    const validation = data.slice(split);
    const developmentModel = fit(development);
    const validationMetrics = {
      marketBaseline: metrics(validation, (row) => row.marketProbability),
      legacyHeuristic: metrics(validation, (row) => row.heuristicProbability),
      residual: metrics(validation, (row) => predict(developmentModel, row)),
    };
    const finalModel = fit(data);
    const artifact = {
      format: 'main-residual-model-v1',
      experimentId: EXPERIMENT_ID,
      modelVersion: MODEL_VERSION,
      status: 'PROVISIONAL_FORWARD_ONLY',
      trainingStart: TRAINING_START,
      trainingEnd: TRAINING_END,
      evidenceStart: EVIDENCE_START,
      mechanism: 'regularized correction to market log-odds; market probability remains the offset',
      noTradingPath: true,
      validation: {
        method: 'chronological 70/30 split inside the training cohort; diagnostic only, never promotion evidence',
        developmentMarkets: development.length,
        validationMarkets: validation.length,
        metrics: validationMetrics,
      },
      ...finalModel,
    };
    console.log(JSON.stringify(artifact, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
