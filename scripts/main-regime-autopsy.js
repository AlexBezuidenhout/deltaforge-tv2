#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const MainMarketRegime = require('../src/bot/MainMarketRegime');
const MainModelChallenger = require('../src/bot/MainModelChallenger');
const { clusteredBootstrap, wilsonInterval } = require('../borg/research/statistics');

const argv = process.argv.slice(2);
function argument(name, fallback) {
  const direct = argv.find((value) => value.startsWith(`--${name}=`));
  if (direct) return direct.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] != null ? argv[index + 1] : fallback;
}

const USER_ID = parseInt(argument('user', '1'), 10) || 1;
const LATENCY_MS = Math.max(0, parseInt(argument('latency-ms', '250'), 10) || 250);
const STAKE_USD = Math.max(1, parseFloat(argument('stake', '10')) || 10);
const MAX_BOOK_DELAY_SEC = Math.max(1, parseFloat(argument('book-delay-sec', '10')) || 10);

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 4) {
  const parsed = finite(value);
  return parsed == null ? null : +parsed.toFixed(digits);
}

function clamp(value, lower = 1e-6, upper = 1 - 1e-6) {
  return Math.max(lower, Math.min(upper, value));
}

function probabilityMetrics(rows, key) {
  let n = 0;
  let brier = 0;
  let logLoss = 0;
  for (const row of rows) {
    const probability = finite(row[key]);
    const outcome = Number(row.outcome_up);
    if (!(probability > 0 && probability < 1) || (outcome !== 0 && outcome !== 1)) continue;
    const p = clamp(probability);
    n += 1;
    brier += (p - outcome) ** 2;
    logLoss -= outcome * Math.log(p) + (1 - outcome) * Math.log(1 - p);
  }
  return n ? { n, brier: round(brier / n, 6), logLoss: round(logLoss / n, 6) }
    : { n: 0, brier: null, logLoss: null };
}

function grouped(rows, keyFor) {
  const groups = new Map();
  for (const row of rows) {
    const key = String(keyFor(row) || 'UNKNOWN');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function inferredMode(row) {
  if (row.main_market_mode) return row.main_market_mode;
  return MainMarketRegime.classify({
    scenario: row.scenario,
    indicatorRegime: row.indicator_regime,
    indicatorTrend: row.indicator_trend,
    btcDelta: row.ema_edge,
  }).mode;
}

function calibrationSummary(rows, label) {
  const wins = rows.filter((row) => {
    const direction = String(row.direction || '').toUpperCase();
    return (direction === 'YES' && Number(row.outcome_up) === 1) ||
      (direction === 'NO' && Number(row.outcome_up) === 0);
  }).length;
  const market = probabilityMetrics(rows, 'yes_price');
  const phi = probabilityMetrics(rows, 'p_phi');
  const heuristic = probabilityMetrics(rows, 'p_heur');
  const ensemble = probabilityMetrics(rows, 'model_prob');
  const residual = probabilityMetrics(rows, 'residual_prob');
  const interval = wilsonInterval(wins, rows.length);
  return {
    label,
    markets: rows.length,
    days: new Set(rows.map((row) => new Date(row.created_at).toISOString().slice(0, 10))).size,
    directionalHitRate: rows.length ? round(wins / rows.length) : null,
    directionalHitWilson95: interval.map((value) => round(value)),
    market,
    phi,
    heuristic,
    ensemble,
    residual,
    residualMinusMarketBrier: market.brier != null && residual.brier != null
      ? round(residual.brier - market.brier, 6) : null,
  };
}

function replayPnl(row) {
  const ask = finite(row.ask);
  const askSize = finite(row.ask_size);
  if (!(ask > 0 && ask <= 0.98) || !(askSize > 0) || ask * askSize < STAKE_USD) return null;
  const entry = Math.min(0.99, ask + 0.01);
  const hit = row.hit === true || row.hit === 1 || row.hit === '1';
  const shares = STAKE_USD / entry;
  const fee = shares * 2 * 0.07 * entry * (1 - entry);
  return shares * (hit ? 1 : 0) - STAKE_USD - fee;
}

function pnlSummary(rows, label, valueFor = replayPnl) {
  const filled = rows.map((row) => ({ ...row, replay_pnl: valueFor(row) }))
    .filter((row) => row.replay_pnl != null)
    .sort((left, right) => new Date(left.created_at || left.available_at) - new Date(right.created_at || right.available_at));
  const split = Math.floor(filled.length / 2);
  const sum = (sample) => sample.reduce((total, row) => total + row.replay_pnl, 0);
  const wins = filled.filter((row) => row.replay_pnl > 0).length;
  const bootstrap = clusteredBootstrap(filled, (row) => row.market_id, 'replay_pnl');
  return {
    label,
    observations: rows.length,
    executableFills: filled.length,
    independentMarkets: new Set(filled.map((row) => String(row.market_id))).size,
    days: new Set(filled.map((row) => new Date(row.created_at || row.available_at).toISOString().slice(0, 10))).size,
    wins,
    winRate: filled.length ? round(wins / filled.length) : null,
    pnl2xFeesOneTick: round(sum(filled), 2),
    firstHalfPnl: round(sum(filled.slice(0, split)), 2),
    secondHalfPnl: round(sum(filled.slice(split)), 2),
    meanPnl: round(bootstrap.mean),
    marketClusteredCi95: bootstrap.ci.map((value) => round(value)),
  };
}

function shadowSummary(rows, label) {
  const scored = rows.filter((row) => row.scored_at != null);
  const quality = scored.filter((row) => row.data_quality_grade !== 'F');
  const fills = quality.filter((row) => row.filled === true).map((row) => ({
    ...row,
    replay_pnl: finite(row.pnl_2x) || 0,
  })).sort((left, right) => new Date(left.available_at) - new Date(right.available_at));
  return {
    ...pnlSummary(fills, label, (row) => row.replay_pnl),
    intendedOrders: rows.length,
    scoredOrders: scored.length,
    dataQualityCoverage: scored.length ? round(quality.length / scored.length) : null,
    fillRate: quality.length ? round(fills.length / quality.length) : null,
  };
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
      SELECT paper_trading, main_legacy_execution_enabled, main_exec_honest_anchor,
             gate2_ev_floor, min_confidence, min_btc_delta, max_trade_size
      FROM bot_settings WHERE user_id=$1
    `, [USER_ID]);
    const settings = settingsRows[0] || {};
    const honestAnchor = settings.main_exec_honest_anchor || '2026-07-15T22:26:55.888Z';

    const { rows: epochRows } = await client.query(`
      SELECT epoch_id, started_at, code_version, reason
      FROM borg_collection_epochs
      ORDER BY started_at DESC LIMIT 1
    `);
    const epoch = epochRows[0] || { epoch_id: null, started_at: honestAnchor };
    const cleanStart = argument('clean-start', new Date(epoch.started_at).toISOString());

    const { rows: legacyTrades } = await client.query(`
      SELECT market_id, trade_size, pnl, created_at
      FROM trades
      WHERE user_id=$1 AND trade_type='signal' AND status='closed'
        AND pnl IS NOT NULL AND abs(pnl) < 100000
      ORDER BY created_at, id
    `, [USER_ID]);
    const summarizeLegacy = (rows) => ({
      trades: rows.length,
      independentMarkets: new Set(rows.map((row) => String(row.market_id))).size,
      wins: rows.filter((row) => finite(row.pnl) > 0).length,
      netPnl: round(rows.reduce((sum, row) => sum + (finite(row.pnl) || 0), 0), 2),
      returnOnStakedCapital: round(
        rows.reduce((sum, row) => sum + (finite(row.pnl) || 0), 0) /
        Math.max(1, rows.reduce((sum, row) => sum + (finite(row.trade_size) || 0), 0)),
      ),
    });
    const anchorMs = new Date(honestAnchor).getTime();

    const { rows: signalRows } = await client.query(`
      SELECT DISTINCT ON (s.market_id)
        s.market_id, s.created_at, coalesce(s.asset,m.asset,'btc') asset,
        coalesce(s.scenario,'UNKNOWN') scenario, s.direction, s.ema_edge,
        s.yes_price, s.p_phi, s.p_heur, s.model_prob, s.residual_prob,
        s.main_market_mode, s.indicator_regime, s.indicator_trend,
        CASE upper(m.outcome) WHEN 'UP' THEN 1 ELSE 0 END outcome_up
      FROM signals s
      JOIN borg_markets m ON m.gamma_id=s.market_id
      WHERE s.user_id=$1 AND s.created_at >= $2 AND s.verdict='TRADE'
        AND upper(m.outcome) IN ('UP','DOWN')
        AND s.yes_price BETWEEN 0.001 AND 0.999
      ORDER BY s.market_id, s.created_at, s.id
    `, [USER_ID, honestAnchor]);

    const calibrationByScenario = [...grouped(signalRows, (row) => row.scenario)]
      .map(([label, rows]) => calibrationSummary(rows, label))
      .sort((left, right) => right.markets - left.markets);
    const calibrationByMode = [...grouped(signalRows, inferredMode)]
      .map(([label, rows]) => calibrationSummary(rows, label))
      .sort((left, right) => right.markets - left.markets);

    const { rows: cleanReplayRows } = await client.query(`
      WITH first_trade AS (
        SELECT DISTINCT ON (s.market_id)
          s.market_id, m.id AS borg_market_id, s.created_at,
          coalesce(s.asset,m.asset,'btc') AS asset,
          coalesce(s.scenario,'UNKNOWN') AS scenario,
          s.main_market_mode, s.indicator_regime, s.indicator_trend,
          s.direction, s.ema_edge, upper(m.outcome) AS outcome
        FROM signals s
        JOIN borg_markets m ON m.gamma_id=s.market_id
        WHERE s.user_id=$1 AND s.created_at >= $2 AND s.verdict='TRADE'
          AND upper(m.outcome) IN ('UP','DOWN')
        ORDER BY s.market_id, s.created_at, s.id
      )
      SELECT f.*,
             CASE WHEN f.direction='NO' THEN b.down_best_ask ELSE b.up_best_ask END AS ask,
             CASE WHEN f.direction='NO'
                    THEN (b.down_asks->0->>1)::numeric
                    ELSE (b.up_asks->0->>1)::numeric END AS ask_size,
             CASE WHEN (f.direction='YES' AND f.outcome='UP') OR
                            (f.direction='NO' AND f.outcome='DOWN')
                    THEN true ELSE false END AS hit,
             b.ts AS book_ts
      FROM first_trade f
      LEFT JOIN LATERAL (
        SELECT * FROM borg_book_snaps b
        WHERE b.market_id=f.borg_market_id
          AND b.ts >= f.created_at + ($3::text || ' milliseconds')::interval
          AND b.ts <= f.created_at + ($4::text || ' seconds')::interval
        ORDER BY b.ts LIMIT 1
      ) b ON true
      ORDER BY f.created_at, f.market_id
    `, [USER_ID, cleanStart, LATENCY_MS, MAX_BOOK_DELAY_SEC]);
    const replayByScenario = [...grouped(cleanReplayRows, (row) => row.scenario)]
      .map(([label, rows]) => pnlSummary(rows, label))
      .sort((left, right) => right.executableFills - left.executableFills);
    const replayByMode = [...grouped(cleanReplayRows, inferredMode)]
      .map(([label, rows]) => pnlSummary(rows, label))
      .sort((left, right) => right.executableFills - left.executableFills);

    const mainStrategies = [
      'MAIN_V2_resolver_quorum',
      'MAIN_V3_robust_source_envelope',
      'MAIN_V4_warm_vol_temporal_consensus',
      'MAIN_VIDEO_PARITY_V1__taker250',
      'MAIN_VIDEO_PARITY_V1__postonly',
      'MAIN_LONGSHOT_0_20_V1',
      'MAIN_REGIME_CONTROL_V1',
      'MAIN_REGIME_RESIDUAL_V1',
    ];
    const { rows: shadowRows } = await client.query(`
      SELECT o.id, o.strategy, o.market_id, o.available_at, o.tte_sec, o.token, o.features,
             s.scored_at, coalesce(s.filled,false) filled,
             coalesce(s.data_quality_grade,'F') data_quality_grade,
             s.pnl_2x
      FROM borg_shadow_orders o
      LEFT JOIN borg_shadow_scores s ON s.order_id=o.id
      WHERE o.action='place' AND o.strategy=ANY($1::text[])
      ORDER BY o.available_at, o.id
    `, [mainStrategies]);
    const mainFamily = [...grouped(shadowRows, (row) => row.strategy)]
      .map(([label, rows]) => shadowSummary(rows, label));

    const sourceRows = shadowRows.filter((row) => row.strategy === 'MAIN_VIDEO_PARITY_V1__taker250');
    const retrospectiveRows = [];
    for (const row of sourceRows) {
      const features = row.features || {};
      const assessment = MainModelChallenger.evaluate({
        marketProbability: finite(features.up_bb) != null && finite(features.up_ba) != null
          ? (finite(features.up_bb) + finite(features.up_ba)) / 2
          : features.gamma_up,
        legacyProbability: features.model_probability,
        heuristicProbability: features.p_heuristic,
        phiProbability: features.p_phi,
        remainingSec: row.tte_sec,
        sigma5min: features.sigma,
        scenario: features.scenario,
        btcDelta: features.btc_delta_pct_60s,
        yesAsk: features.up_ba,
        noAsk: features.down_ba,
      }, new Date(row.available_at));
      const expectedToken = assessment?.regimeChallengerDirection === 'YES' ? 'UP'
        : assessment?.regimeChallengerDirection === 'NO' ? 'DOWN' : null;
      if (assessment?.regimeChallengerEligible && expectedToken === row.token) {
        retrospectiveRows.push({
          ...row,
          replay_pnl: row.filled ? (finite(row.pnl_2x) || 0) : null,
          assessment,
        });
      }
    }
    const retrospective = shadowSummary(retrospectiveRows, 'POST_DIAGNOSTIC_RETROSPECTIVE_ONLY');

    const allExecutableModesNegative = replayByMode
      .filter((row) => row.executableFills > 0)
      .every((row) => row.pnl2xFeesOneTick <= 0);
    const report = {
      format: 'main-regime-autopsy-v1',
      createdAt: new Date().toISOString(),
      userId: USER_ID,
      safety: {
        paperTrading: settings.paper_trading !== false,
        legacyMainPaperExecutionEnabled: settings.main_legacy_execution_enabled === true,
        newRegimeExperimentPaperOnly: true,
        liveOrderPathChanged: false,
      },
      parameters: {
        executableReplayLatencyMs: LATENCY_MS,
        maximumBookDelaySec: MAX_BOOK_DELAY_SEC,
        fixedStakeUsd: STAKE_USD,
        costs: 'actual future ask + one tick; doubled 7% p(1-p) crypto taker curve',
      },
      cohortBoundaries: {
        executableBookRepair: new Date(honestAnchor).toISOString(),
        cleanCollectionEpoch: epoch,
        cleanReplayStart: new Date(cleanStart).toISOString(),
      },
      currentSettings: {
        gate2EvFloor: finite(settings.gate2_ev_floor),
        minConfidence: finite(settings.min_confidence),
        minBtcDelta: finite(settings.min_btc_delta),
        maxTradeSize: finite(settings.max_trade_size),
      },
      legacyMain: {
        contaminatedBeforeExecutableRepair: summarizeLegacy(
          legacyTrades.filter((row) => new Date(row.created_at).getTime() < anchorMs),
        ),
        honestAfterExecutableRepair: summarizeLegacy(
          legacyTrades.filter((row) => new Date(row.created_at).getTime() >= anchorMs),
        ),
      },
      calibration: {
        independentUnit: 'first legacy TRADE intent per resolved market after executable-book repair',
        overall: calibrationSummary(signalRows, 'ALL'),
        byScenario: calibrationByScenario,
        byMode: calibrationByMode,
      },
      cleanExecutableReplay: {
        caveat: 'Nearest BORG book at or after the latency horizon; requires $10 at touch. It is a conservative diagnostic, not authenticated fill proof.',
        overall: pnlSummary(cleanReplayRows, 'ALL'),
        byScenario: replayByScenario,
        byMode: replayByMode,
      },
      borgMainFamily: mainFamily,
      postDiagnosticRetrospective: {
        ...retrospective,
        evidenceStatus: 'IN_SAMPLE_SELECTION_DIAGNOSTIC_ONLY',
      },
      decision: {
        historicalRegimeTradingDemonstrated: !allExecutableModesNegative,
        legacyMainShouldRemainExecutionDisabled: true,
        launchFreshMatchedPaperExperiment: true,
        experiment: 'main-regime-residual-v1',
        requiredRead: '>=300 fresh independent markets per arm, >=14 days, positive doubled-cost PnL in both halves, clustered lower bounds above zero, positive incremental PnL versus control, Holm correction and positive 100/250/500ms replays',
        honestNull: 'The likely result may remain approximately zero or negative; mode conditioning is not evidence until the fresh matched arm passes.',
      },
    };
    console.log(JSON.stringify(report, null, 2));
    await client.query('ROLLBACK');
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

module.exports = {
  calibrationSummary,
  inferredMode,
  pnlSummary,
  probabilityMetrics,
  replayPnl,
};
