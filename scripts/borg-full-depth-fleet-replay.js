#!/usr/bin/env node
'use strict';

/**
 * Read-only fleet execution audit over immutable Polymarket CLOB WAL segments.
 *
 * The script replays each strategy's first resolved taker intent per frozen
 * cohort/market at 100/250/500ms against causal full-depth books. It never
 * updates shadow scores, trial status, strategy settings, or live-order state.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const serviceEnv = process.env.TV2_ENV_FILE || '/etc/deltaforge/tv2.env';
if (!process.env.DATABASE_URL && fs.existsSync(serviceEnv)) {
  require('dotenv').config({ path: serviceEnv });
}

const { createResearchPool } = require('./lib/research-pool');
const { finite, FULL_DEPTH_REPLAY_VERSION } = require('../borg/research/full-depth-wal-replay');
const {
  DEFAULT_MIN_COVERAGE_PCT,
  DEFAULT_MIN_MARKETS,
  EXECUTION_VALIDATION_FORMAT,
  buildFleetValidation,
  cohortKey,
} = require('../borg/research/execution-validation');
const {
  MAX_PREDECESSOR_AGE_MS,
  acquireArchiveLock,
  assertRemoteRunIdentity,
  atomicWrite,
  buildSegmentCatalog,
  hasSegmentCoverage,
  parseProfiles,
  removeStage,
  replayOrders,
  selectSegments,
  stageRemoteSegments,
  utcDaysBetween,
} = require('./h43-full-depth-replay');

const DEFAULT_PROFILES = Object.freeze([100, 250, 500]);
const DEFAULT_ARCHIVE_START = '2026-07-26T00:00:00.000Z';
const DEFAULT_WAL_ROOT = '/var/lib/deltaforge/wal/borg/polymarket-clob';
const DEFAULT_RCLONE = '/usr/local/bin/rclone';
const DEFAULT_RCLONE_CONFIG = '/var/lib/deltaforge/google-drive-archive/rclone.conf';
const DEFAULT_REMOTE = 'deltaforge-gdrive';
const DEFAULT_REMOTE_PREFIX = 'VPS Data/wal/polymarket-clob';
const DEFAULT_LOOKBACK_MS = 7 * 60_000;
const DEFAULT_TAIL_MS = 5_000;
const DEFAULT_MAX_BYTES = 8 * 1024 ** 3;

function arg(name, fallback = null) {
  const equal = process.argv.find((value) => value.startsWith(`${name}=`));
  if (equal) return equal.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedPercentage(value, fallback) {
  if (value == null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : fallback;
}

function parseDate(value, label) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} must be an ISO timestamp`);
  return parsed;
}

function parseStrategyList(value) {
  return [...new Set(String(value || '').split(',').map((item) => item.trim()).filter(Boolean))];
}

async function loadFleetOrders(pool, options) {
  const params = [options.since, options.until, options.minMarkets];
  const filters = [
    "o.action='place'", "o.order_kind='taker'", 'm.outcome IS NOT NULL',
    'COALESCE(o.available_at,o.ts)>=$1', 'COALESCE(o.available_at,o.ts)<=$2',
  ];
  if (options.strategies.length) {
    params.push(options.strategies);
    filters.push(`o.strategy=ANY($${params.length}::text[])`);
  }
  const { rows } = await pool.query(`
    WITH ranked AS (
      SELECT o.id,o.strategy,COALESCE(o.experiment_id,'unregistered') experiment_id,
             COALESCE(o.arm,'baseline') arm,COALESCE(o.phase,'eval') phase,
             o.market_id,o.ts,COALESCE(o.available_at,o.ts) available_at,
             o.side,o.token,o.price,o.size,o.order_kind,o.features,o.intent_id,
             o.source_event_id,m.outcome,m.up_token_id,m.down_token_id,
             m.positive_label,m.negative_label,m.window_end,m.asset,
             row_number() OVER (
               PARTITION BY o.strategy,o.experiment_id,COALESCE(o.arm,'baseline'),
                            o.phase,o.market_id
               ORDER BY COALESCE(o.available_at,o.ts),o.id
             ) market_rank
        FROM borg_shadow_orders o
        JOIN borg_markets m ON m.id=o.market_id
       WHERE ${filters.join(' AND ')}
    ), first_intents AS (
      SELECT * FROM ranked WHERE market_rank=1
    ), eligible_cohorts AS (
      SELECT strategy,experiment_id,arm,phase,count(*)::int independent_markets
        FROM first_intents
       GROUP BY strategy,experiment_id,arm,phase
      HAVING count(*) >= $3
    )
    SELECT f.*,e.independent_markets cohort_independent_markets
      FROM first_intents f
      JOIN eligible_cohorts e USING(strategy,experiment_id,arm,phase)
     ORDER BY f.available_at,f.id
  `, params);
  return rows.map((row) => ({
    ...row,
    id: String(row.id),
    market_id: String(row.market_id),
    price: finite(row.price),
    size: finite(row.size),
    cohort_independent_markets: Number.parseInt(row.cohort_independent_markets, 10),
  }));
}

function manifestForOrders(orders) {
  const grouped = new Map();
  for (const order of orders) {
    const key = cohortKey(order);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(order);
  }
  return [...grouped.entries()].map(([key, rows]) => {
    const times = rows.map((row) => Date.parse(row.available_at)).filter(Number.isFinite);
    return {
      cohortKey: key,
      strategy: rows[0].strategy,
      experimentId: rows[0].experiment_id,
      arm: rows[0].arm,
      phase: rows[0].phase,
      independentMarkets: new Set(rows.map((row) => row.market_id)).size,
      firstAt: new Date(Math.min(...times)).toISOString(),
      latestAt: new Date(Math.max(...times)).toISOString(),
    };
  }).sort((left, right) => left.strategy.localeCompare(right.strategy)
    || left.experimentId.localeCompare(right.experimentId));
}

async function loadPrimaryComparisons(pool, orders) {
  const byOrder = new Map(orders.map((order) => [String(order.id), order]));
  const result = new Map();
  const ids = [...byOrder.keys()];
  const chunkSize = 5_000;
  for (let offset = 0; offset < ids.length; offset += chunkSize) {
    const chunk = ids.slice(offset, offset + chunkSize);
    const { rows } = await pool.query(`
      SELECT order_id,filled,pnl_1x,pnl_2x,data_quality_grade,
             execution_fidelity_grade,detail
        FROM borg_shadow_scores
       WHERE order_id=ANY($1::bigint[])
    `, [chunk]);
    for (const row of rows) {
      const order = byOrder.get(String(row.order_id));
      if (!order) continue;
      const key = cohortKey(order);
      const summary = result.get(key) || {
        intendedOrders: 0, storedScores: 0, filled: 0, jointlyABFills: 0,
        pnl1xAllFills: 0, pnl2xAllFills: 0, pnl1xJointlyAB: 0, pnl2xJointlyAB: 0,
      };
      summary.storedScores += 1;
      if (row.filled === true) {
        summary.filled += 1;
        summary.pnl1xAllFills += finite(row.pnl_1x, 0);
        summary.pnl2xAllFills += finite(row.pnl_2x, 0);
        if (['A', 'B'].includes(row.data_quality_grade)
          && ['A', 'B'].includes(row.execution_fidelity_grade)) {
          summary.jointlyABFills += 1;
          summary.pnl1xJointlyAB += finite(row.pnl_1x, 0);
          summary.pnl2xJointlyAB += finite(row.pnl_2x, 0);
        }
      }
      result.set(key, summary);
    }
  }
  for (const order of orders) {
    const key = cohortKey(order);
    const summary = result.get(key) || {
      intendedOrders: 0, storedScores: 0, filled: 0, jointlyABFills: 0,
      pnl1xAllFills: 0, pnl2xAllFills: 0, pnl1xJointlyAB: 0, pnl2xJointlyAB: 0,
    };
    summary.intendedOrders += 1;
    result.set(key, summary);
  }
  return result;
}

function breakdown(rows, latencyMs) {
  const eligible = rows.filter((row) => Number(row.latencyMs) === Number(latencyMs)
    && row.executionState === 'ELIGIBLE_FILL');
  const aggregate = (keyFor) => [...eligible.reduce((groups, row) => {
    const key = keyFor(row);
    const current = groups.get(key) || {
      key, fills: 0, markets: new Set(), pnl2x: 0, pnl2xOneTick: 0,
    };
    current.fills += 1;
    current.markets.add(row.marketId);
    current.pnl2x += finite(row.pnl2x, 0);
    current.pnl2xOneTick += finite(row.pnl2xOneTick, 0);
    groups.set(key, current);
    return groups;
  }, new Map()).values()].map((row) => ({
    key: row.key, fills: row.fills, markets: row.markets.size,
    pnl2x: row.pnl2x, pnl2xOneTick: row.pnl2xOneTick,
  })).sort((left, right) => right.pnl2x - left.pnl2x || left.key.localeCompare(right.key));
  return {
    latencyMs,
    byAsset: aggregate((row) => String(row.asset || 'unknown').toUpperCase()),
    byUtcDay: aggregate((row) => String(row.availableAt || '').slice(0, 10) || 'unknown'),
  };
}

function attachCohortContext(validation, results, manifest, primary, profileForBreakdown) {
  const manifestByKey = new Map(manifest.map((row) => [row.cohortKey, row]));
  const resultGroups = results.reduce((groups, row) => {
    const key = cohortKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
    return groups;
  }, new Map());
  return validation.cohorts.map((cohort) => ({
    ...cohort,
    manifest: manifestByKey.get(cohort.cohortKey) || null,
    primaryPaperComparator: primary.get(cohort.cohortKey) || null,
    concentration: breakdown(resultGroups.get(cohort.cohortKey) || [], profileForBreakdown),
  }));
}

async function main() {
  const profiles = parseProfiles(arg('--profiles', DEFAULT_PROFILES.join(',')));
  if (!profiles.length) throw new Error('At least one latency profile is required');
  const since = parseDate(arg('--since', DEFAULT_ARCHIVE_START), '--since');
  const until = parseDate(arg('--until'), '--until') || new Date();
  if (since >= until) throw new Error('--since must be earlier than --until');
  const source = String(arg('--source', 'auto')).toLowerCase();
  if (!['auto', 'local', 'remote'].includes(source)) {
    throw new Error('--source must be auto, local, or remote');
  }
  const minMarkets = positiveInteger(arg('--min-markets'), DEFAULT_MIN_MARKETS);
  const minCoveragePct = boundedPercentage(
    arg('--min-coverage-pct'), DEFAULT_MIN_COVERAGE_PCT,
  );
  const options = {
    since, until, minMarkets, minCoveragePct,
    strategies: parseStrategyList(arg('--strategies')),
    source,
    includeOpen: flag('--include-open'),
    walRoot: arg('--wal-root', process.env.BORG_CLOB_WAL_ROOT || DEFAULT_WAL_ROOT),
    rcloneBinary: arg('--rclone', process.env.GDRIVE_RCLONE_BINARY || DEFAULT_RCLONE),
    rcloneConfig: arg('--rclone-config', process.env.GDRIVE_RCLONE_CONFIG || DEFAULT_RCLONE_CONFIG),
    remote: arg('--remote', process.env.GDRIVE_RCLONE_REMOTE || DEFAULT_REMOTE),
    remotePrefix: arg('--remote-prefix', process.env.BORG_FLEET_REPLAY_REMOTE_PREFIX
      || process.env.H43_REPLAY_REMOTE_PREFIX || DEFAULT_REMOTE_PREFIX),
    lookbackMs: positiveInteger(arg('--lookback-ms'), DEFAULT_LOOKBACK_MS),
    tailMs: positiveInteger(arg('--tail-ms'), DEFAULT_TAIL_MS),
    maxTransportSilenceMs: positiveInteger(arg('--transport-fresh-ms'), 10_000),
    maximumBytes: positiveInteger(arg('--max-bytes'), DEFAULT_MAX_BYTES),
    cacheRoot: arg('--cache-root', process.env.BORG_FLEET_REPLAY_CACHE_ROOT
      || path.join(os.tmpdir(), 'deltaforge-borg-fleet-replay')),
    diskReserveBytes: positiveInteger(arg('--disk-reserve-bytes'), 20 * 1024 ** 3),
    stageRoot: arg('--stage-root', process.env.BORG_FLEET_REPLAY_STAGE_ROOT || null),
    streamRemote: flag('--stream-remote'),
    quiet: flag('--quiet'),
    stagePrefix: 'borg-fleet-l4-',
    progressLabel: 'borg-fleet-l4',
    archiveLockFile: arg('--archive-lock', process.env.DELTAFORGE_ARCHIVE_LOCK
      || '/var/lib/deltaforge/google-drive-archive/archive-retention.lock'),
    archiveLockWaitSec: positiveInteger(arg('--archive-lock-wait-sec'), 7_200),
  };
  const pool = createResearchPool({
    applicationName: 'borg-full-depth-fleet-replay', statementTimeoutMs: 60_000,
    lockTimeoutMs: 250, max: 1,
  });
  try {
    const orders = await loadFleetOrders(pool, options);
    if (!orders.length) throw new Error('No resolved taker cohorts meet the requested minimum');
    const manifest = manifestForOrders(orders);
    const primary = await loadPrimaryComparisons(pool, orders);
    const manifestWithPrimary = manifest.map((cohort) => ({
      ...cohort,
      primaryPaperComparator: primary.get(cohort.cohortKey) || null,
    }));
    if (flag('--inventory-only')) {
      process.stdout.write(`${JSON.stringify({
        format: 'borg-fleet-execution-inventory-v1',
        generatedAt: new Date().toISOString(),
        readOnly: true,
        paperOnly: true,
        filters: {
          since: since.toISOString(), until: until.toISOString(),
          strategies: options.strategies, minMarkets, minCoveragePct,
        },
        cohortCount: manifest.length,
        resolvedOrders: orders.length,
        cohorts: manifestWithPrimary,
        warning: 'Inventory only: no raw archive was listed, downloaded or replayed.',
      }, null, 2)}\n`);
      return;
    }
    const maximumLatencyMs = Math.max(...profiles);
    const availableTimes = orders.map((order) => Date.parse(order.available_at));
    const windows = orders.map((order) => ({
      startMs: Date.parse(order.available_at) - options.lookbackMs,
      endMs: Date.parse(order.available_at) + maximumLatencyMs + options.tailMs,
    }));
    const days = utcDaysBetween(
      Math.min(...availableTimes) - options.lookbackMs - MAX_PREDECESSOR_AGE_MS,
      Math.max(...availableTimes) + maximumLatencyMs + options.tailMs,
    );
    assertRemoteRunIdentity(options);
    const archiveLock = await acquireArchiveLock(options);
    let catalog;
    let selected;
    let selectedBytes;
    let staged;
    let plan;
    try {
      catalog = await buildSegmentCatalog(days, options);
      selected = selectSegments(catalog.segments, windows);
      selectedBytes = selected.reduce((sum, segment) => sum + finite(segment.size, 0), 0);
      const coveredOrders = orders.filter((order) => hasSegmentCoverage(
        order, selected, options.lookbackMs, options.tailMs, maximumLatencyMs,
      )).length;
      plan = {
        format: 'borg-fleet-causal-full-depth-replay-plan-v1',
        generatedAt: new Date().toISOString(),
        readOnly: true,
        paperOnly: true,
        filters: {
          since: since.toISOString(), until: until.toISOString(),
          strategies: options.strategies, minMarkets, minCoveragePct,
        },
        profilesMs: profiles,
        cohorts: manifestWithPrimary,
        cohortCount: manifest.length,
        resolvedOrders: orders.length,
        daysRequested: days,
        missingRemoteDays: catalog.missingRemoteDays,
        catalogSegments: catalog.segments.length,
        selectedSegments: selected.length,
        selectedCompressedBytes: selectedBytes,
        selectedCompressedGiB: selectedBytes / 1024 ** 3,
        archiveCoveredOrders: coveredOrders,
        archiveMissingOrders: orders.length - coveredOrders,
        configuredMaximumGiB: options.maximumBytes / 1024 ** 3,
        executableWithinConfiguredBound: selectedBytes <= options.maximumBytes,
      };
      if (flag('--plan-only')) {
        process.stdout.write(`${JSON.stringify({ ...plan,
          warning: 'Plan only: no raw segment was downloaded or replayed.' }, null, 2)}\n`);
        return;
      }
      if (selectedBytes > options.maximumBytes) {
        throw new Error(
          `selected WAL is ${(selectedBytes / 1024 ** 3).toFixed(2)} GiB, above `
          + `--max-bytes ${(options.maximumBytes / 1024 ** 3).toFixed(2)} GiB`,
        );
      }
      staged = await stageRemoteSegments(selected, options);
    } finally {
      await archiveLock.release();
    }
    let replayed;
    try {
      replayed = await replayOrders(orders, profiles, staged.segments, options);
    } finally {
      if (!staged.persistentStage) removeStage(staged.stageRoot);
    }
    const validation = buildFleetValidation(replayed.results, {
      profilesMs: profiles, minMarkets, minCoveragePct,
    });
    const cohorts = attachCohortContext(
      validation, replayed.results, manifest, primary,
      profiles.includes(250) ? 250 : profiles[0],
    );
    const report = {
      format: EXECUTION_VALIDATION_FORMAT,
      replayVersion: FULL_DEPTH_REPLAY_VERSION,
      generatedAt: new Date().toISOString(),
      readOnly: true,
      paperOnly: true,
      frozenSignalsChanged: false,
      liveOrderPathChanged: false,
      evidenceScope: 'L4_COUNTERFACTUAL_EXECUTION',
      filters: plan.filters,
      executionModel: {
        profilesMs: profiles,
        informationClock: 'stored available_at',
        orderClock: 'raw WAL local receive time plus counterfactual order latency',
        depth: 'all displayed levels through the frozen order limit; partial fills retained',
        costs: 'actual modelled crypto taker fee at 2x plus independent one-tick/leg stress',
        caveat: 'L4 counterfactual replay is not authenticated L5 exchange acknowledgement or proof of live profitability.',
      },
      archive: {
        sourceRequested: source,
        daysRequested: days,
        missingRemoteDays: catalog.missingRemoteDays,
        catalogSegments: catalog.segments.length,
        localSegments: catalog.localSegments,
        remoteSegments: catalog.remoteSegments,
        selectedSegments: selected.length,
        selectedCompressedBytes: selectedBytes,
        selectedCompressedGiB: selectedBytes / 1024 ** 3,
        stagedSegments: staged.stagedSegments,
        stagedBytes: staged.stagedBytes,
        temporaryCacheRemoved: staged.stageRoot != null,
        archiveCoveredOrders: replayed.archiveCoveredOrders,
        archiveMissingOrders: replayed.archiveMissingOrders,
        warnings: [...new Set([...catalog.warnings, staged.warning].filter(Boolean))],
      },
      diagnostics: replayed.diagnostics,
      counts: validation.counts,
      ranking: cohorts.map((cohort, index) => ({
        rank: index + 1, strategy: cohort.strategy, experimentId: cohort.experimentId,
        arm: cohort.arm, phase: cohort.phase, classification: cohort.classification,
        intendedMarkets: cohort.intendedMarkets,
        minimumScoreableMarkets: cohort.minimumScoreableMarkets,
        minimumCoveragePct: cohort.minimumCoveragePct,
        worstPnl2x: cohort.worstPnl2x,
        worstPnl2xOneTick: cohort.worstPnl2xOneTick,
      })),
      cohorts,
      interpretationRules: [
        'UNSCOREABLE rows contribute no PnL and are not converted into non-fills.',
        'A robust-positive label is reused-cohort execution evidence, not a live-capital promotion.',
        'No strategy parameter, lifecycle, trial ledger row, shadow score, or live-order path is changed.',
        'Formal promotion still requires 300 fresh independent markets, chronological stability, multiple-testing correction and a 50-fill authenticated pilot.',
      ],
    };
    const rendered = `${JSON.stringify(report, null, 2)}\n`;
    const outputFile = arg('--json-out', process.env.BORG_EXECUTION_VALIDATION_REPORT);
    if (outputFile) report.outputFile = atomicWrite(outputFile, rendered);
    if (flag('--json') || !outputFile) process.stdout.write(rendered);
    else process.stdout.write(`${JSON.stringify({
      format: report.format, generatedAt: report.generatedAt,
      outputFile: report.outputFile, counts: report.counts,
      archive: report.archive, ranking: report.ranking,
    }, null, 2)}\n`);
    if (staged.persistentStage) removeStage(staged.stageRoot);
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

module.exports = {
  attachCohortContext,
  breakdown,
  loadFleetOrders,
  loadPrimaryComparisons,
  manifestForOrders,
  parseStrategyList,
};
