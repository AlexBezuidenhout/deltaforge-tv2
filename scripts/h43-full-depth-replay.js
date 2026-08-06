#!/usr/bin/env node
'use strict';

/**
 * Read-only H43 execution audit over the append-before-process raw CLOB WAL.
 *
 * This script deliberately does not import the shadow scorer, migrate schema,
 * update scores, change the frozen H43 rule, or touch any live-order process.
 * It can stream immutable historical segments directly from Google Drive so a
 * replay does not have to restore the whole archive onto the VPS hot disk.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const serviceEnv = process.env.TV2_ENV_FILE || '/etc/deltaforge/tv2.env';
if (!process.env.DATABASE_URL && fs.existsSync(serviceEnv)) {
  require('dotenv').config({ path: serviceEnv });
}

const { createResearchPool } = require('./lib/research-pool');
const { lfDelimitedLines } = require('../borg/research/strict-ndjson');
const {
  FULL_DEPTH_REPLAY_VERSION,
  FullDepthWalReconstructor,
  attachPnl,
  finite,
  summarizeFullDepthReplays,
} = require('../borg/research/full-depth-wal-replay');

const DEFAULT_STRATEGY = 'H43_resolution_boundary_buffer';
const DEFAULT_EXPERIMENT = 'research-h43-forward-v1';
const DEFAULT_PROFILES = Object.freeze([100, 250, 500]);
const DEFAULT_WAL_ROOT = '/var/lib/deltaforge/wal/borg/polymarket-clob';
const DEFAULT_RCLONE = '/usr/local/bin/rclone';
const DEFAULT_RCLONE_CONFIG = '/var/lib/deltaforge/google-drive-archive/rclone.conf';
const DEFAULT_REMOTE = 'deltaforge-gdrive';
const DEFAULT_REMOTE_PREFIX = 'VPS Data/wal/polymarket-clob';
const DEFAULT_LOOKBACK_MS = 7 * 60_000;
const DEFAULT_TAIL_MS = 5_000;
const MAX_PREDECESSOR_AGE_MS = 20 * 60_000;
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

function parseProfiles(value = DEFAULT_PROFILES.join(',')) {
  return [...new Set(String(value).split(',')
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isSafeInteger(item) && item >= 0 && item <= 10_000))]
    .sort((left, right) => left - right);
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseDate(value, label) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} must be an ISO timestamp`);
  return parsed;
}

function parseSegmentStart(name) {
  const match = path.basename(String(name)).match(
    /^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})-(\d{3})Z__/,
  );
  if (!match) return null;
  const timestamp = Date.parse(`${match[1]}${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function utcDaysBetween(startMs, endMs) {
  const days = [];
  const cursor = new Date(startMs);
  cursor.setUTCHours(0, 0, 0, 0);
  const last = new Date(endMs);
  last.setUTCHours(0, 0, 0, 0);
  while (cursor <= last) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function coalesceWindows(windows) {
  const ordered = windows
    .filter((window) => Number.isFinite(window.startMs) && Number.isFinite(window.endMs))
    .sort((left, right) => left.startMs - right.startMs);
  const merged = [];
  for (const window of ordered) {
    const prior = merged.at(-1);
    if (!prior || window.startMs > prior.endMs) merged.push({ ...window });
    else prior.endMs = Math.max(prior.endMs, window.endMs);
  }
  return merged;
}

function selectSegments(segments, windows, options = {}) {
  const maximumPredecessorAgeMs = positiveInteger(
    options.maximumPredecessorAgeMs, MAX_PREDECESSOR_AGE_MS,
  );
  const ordered = [...segments]
    .filter((segment) => Number.isFinite(segment.startMs))
    .sort((left, right) => left.startMs - right.startMs
      || String(left.relative).localeCompare(String(right.relative)));
  const selected = new Map();
  const mergedWindows = coalesceWindows(windows);
  for (let windowIndex = 0; windowIndex < mergedWindows.length; windowIndex += 1) {
    const window = mergedWindows[windowIndex];
    let predecessor = null;
    for (const segment of ordered) {
      if (segment.startMs <= window.startMs) predecessor = segment;
      if (segment.startMs >= window.startMs && segment.startMs <= window.endMs) {
        selected.set(segment.relative, { ...segment, replayWindow: windowIndex });
      }
      if (segment.startMs > window.endMs) break;
    }
    if (predecessor && window.startMs - predecessor.startMs <= maximumPredecessorAgeMs) {
      selected.set(predecessor.relative, { ...predecessor, replayWindow: windowIndex });
    }
  }
  return [...selected.values()].sort((left, right) => left.startMs - right.startMs
    || String(left.relative).localeCompare(String(right.relative)));
}

function hasSegmentCoverage(order, segments, lookbackMs, tailMs, maximumLatencyMs) {
  const availableMs = Date.parse(order.available_at || order.ts);
  if (!Number.isFinite(availableMs)) return false;
  const start = availableMs - lookbackMs - MAX_PREDECESSOR_AGE_MS;
  const end = availableMs + maximumLatencyMs + tailMs;
  return segments.some((segment) => segment.startMs >= start && segment.startMs <= end);
}

function remoteTarget(remote, prefix, day = null, name = null) {
  const parts = [prefix, day, name].filter(Boolean);
  return `${remote}:${parts.join('/')}`;
}

function boundedText(value, maximum = 2_000) {
  const text = String(value || '').trim();
  return text.length <= maximum ? text : text.slice(-maximum);
}

function runCommand(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr = boundedText(`${stderr}${chunk}`, 8_000); });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) return resolve({ stdout, stderr });
      const error = new Error(`${binary} exited ${code ?? signal}: ${boundedText(stderr)}`);
      error.code = code;
      error.stderr = stderr;
      reject(error);
    });
  });
}

function rcloneCommon(configFile) {
  return [
    '--config', configFile,
    '--contimeout', process.env.GDRIVE_CONNECT_TIMEOUT || '30s',
    '--timeout', process.env.GDRIVE_IO_TIMEOUT || '5m',
    '--retries', String(positiveInteger(process.env.GDRIVE_RETRIES, 3)),
    '--low-level-retries', String(positiveInteger(process.env.GDRIVE_LOW_LEVEL_RETRIES, 10)),
    '--tpslimit', String(positiveInteger(process.env.GDRIVE_TPS_LIMIT, 8)),
    '--tpslimit-burst', String(positiveInteger(process.env.GDRIVE_TPS_BURST, 8)),
  ];
}

function acceptedWalName(name, includeOpen = false) {
  return name.endsWith('.ndjson.gz') || name.endsWith('.ndjson')
    || (includeOpen && name.endsWith('.open'));
}

function listLocalSegments(days, root, includeOpen = false) {
  const output = [];
  for (const day of days) {
    const directory = path.join(root, day);
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !acceptedWalName(entry.name, includeOpen)) continue;
      const file = path.join(directory, entry.name);
      const stat = fs.statSync(file);
      output.push({
        relative: `${day}/${entry.name}`,
        day,
        name: entry.name,
        startMs: parseSegmentStart(entry.name),
        size: Number(stat.size) || 0,
        origin: 'local',
        file,
      });
    }
  }
  return output;
}

async function listRemoteSegments(days, options) {
  const output = [];
  const missingDays = [];
  const warnings = [];
  for (const day of days) {
    try {
      const result = await runCommand(options.rcloneBinary, [
        'lsjson', remoteTarget(options.remote, options.remotePrefix, day),
        '--files-only', ...rcloneCommon(options.rcloneConfig),
      ]);
      const records = JSON.parse(result.stdout || '[]');
      for (const record of records) {
        const name = String(record.Name || record.Path || '');
        if (!acceptedWalName(name, options.includeOpen)) continue;
        output.push({
          relative: `${day}/${name}`,
          day,
          name,
          startMs: parseSegmentStart(name),
          size: finite(record.Size, 0),
          origin: 'remote',
          remotePath: remoteTarget(options.remote, options.remotePrefix, day, name),
        });
      }
      if (result.stderr.trim()) warnings.push(`rclone emitted a warning while listing ${day}`);
    } catch (error) {
      if (/directory not found|path not found|couldn't find root directory|object not found/i
        .test(String(error.stderr || error.message))) {
        missingDays.push(day);
        continue;
      }
      throw error;
    }
  }
  return { segments: output, missingDays, warnings };
}

async function buildSegmentCatalog(days, options) {
  let remote = { segments: [], missingDays: [], warnings: [] };
  const local = options.source === 'remote' ? []
    : listLocalSegments(days, options.walRoot, options.includeOpen);
  const remoteEnabled = options.source !== 'local'
    && fs.existsSync(options.rcloneBinary) && fs.existsSync(options.rcloneConfig);
  if (options.source === 'remote' && !remoteEnabled) {
    throw new Error('remote WAL requested but rclone binary or config is missing');
  }
  if (remoteEnabled) remote = await listRemoteSegments(days, options);
  const combined = new Map();
  for (const segment of remote.segments) combined.set(segment.relative, segment);
  // Prefer local immutable bytes for duplicate paths; this avoids downloading
  // a segment which is still retained in the VPS hot tier.
  for (const segment of local) combined.set(segment.relative, segment);
  return {
    segments: [...combined.values()].sort((left, right) => left.startMs - right.startMs),
    remoteSegments: remote.segments.length,
    localSegments: local.length,
    missingRemoteDays: remote.missingDays,
    warnings: remote.warnings,
    remoteEnabled,
  };
}

function openRemoteStream(segment, options, diagnostics) {
  const child = spawn(options.rcloneBinary, [
    'cat', segment.remotePath, ...rcloneCommon(options.rcloneConfig),
  ], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = boundedText(`${stderr}${chunk}`, 8_000); });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        if (stderr.trim()) diagnostics.remoteWarnings += 1;
        resolve();
      } else {
        const error = new Error(`rclone cat exited ${code ?? signal}: ${boundedText(stderr)}`);
        error.code = code;
        reject(error);
      }
    });
  });
  const stream = segment.name.endsWith('.gz')
    ? child.stdout.pipe(zlib.createGunzip()) : child.stdout;
  return { stream, done, close: () => child.kill('SIGTERM') };
}

function openLocalStream(segment) {
  const input = fs.createReadStream(segment.file);
  const stream = segment.name.endsWith('.gz') ? input.pipe(zlib.createGunzip()) : input;
  return { stream, done: Promise.resolve(), close: () => input.destroy() };
}

async function replaySegment(segment, options, handler, diagnostics) {
  const opened = segment.origin === 'remote'
    ? openRemoteStream(segment, options, diagnostics) : openLocalStream(segment);
  try {
    for await (const line of lfDelimitedLines(opened.stream)) {
      diagnostics.lines += 1;
      if (!line || line.length < 2) continue;
      let envelope;
      try {
        envelope = JSON.parse(line);
      } catch (_) {
        diagnostics.malformedLines += 1;
        continue;
      }
      if (envelope?._borg_wal) {
        diagnostics.headers += 1;
        continue;
      }
      await handler(envelope);
    }
    await opened.done;
    diagnostics.filesRead += 1;
    diagnostics.bytesRead += finite(segment.size, 0);
  } catch (error) {
    opened.close();
    await opened.done.catch(() => {});
    throw error;
  }
}

function atomicWrite(file, contents) {
  const absolute = path.resolve(file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, absolute);
  return absolute;
}

function assertStagingCapacity(root, selectedBytes, reserveBytes) {
  const stat = fs.statfsSync(root);
  const freeBytes = Number(stat.bavail) * Number(stat.bsize);
  if (freeBytes - selectedBytes < reserveBytes) {
    throw new Error(
      `temporary replay staging would leave ${((freeBytes - selectedBytes) / 1024 ** 3).toFixed(2)} GiB free; `
      + `${(reserveBytes / 1024 ** 3).toFixed(2)} GiB reserve is required`,
    );
  }
  return freeBytes;
}

async function stageRemoteSegments(segments, options) {
  const remoteSegments = segments.filter((segment) => segment.origin === 'remote');
  if (!remoteSegments.length || options.streamRemote) {
    return { segments, stageRoot: null, stagedSegments: 0, stagedBytes: 0, warning: null };
  }
  fs.mkdirSync(options.cacheRoot, { recursive: true, mode: 0o700 });
  assertStagingCapacity(
    options.cacheRoot,
    remoteSegments.reduce((sum, segment) => sum + finite(segment.size, 0), 0),
    options.diskReserveBytes,
  );
  const stageRoot = fs.mkdtempSync(path.join(options.cacheRoot, 'h43-l4-'));
  const listFile = path.join(stageRoot, 'selected.files');
  fs.writeFileSync(
    listFile,
    `${remoteSegments.map((segment) => segment.relative).join('\n')}\n`,
    { mode: 0o600 },
  );
  try {
    const result = await runCommand(options.rcloneBinary, [
      'copy', remoteTarget(options.remote, options.remotePrefix), stageRoot,
      '--files-from-raw', listFile,
      '--checksum', '--no-traverse',
      '--transfers', String(positiveInteger(process.env.H43_REPLAY_TRANSFERS, 4)),
      '--checkers', String(positiveInteger(process.env.H43_REPLAY_CHECKERS, 8)),
      ...rcloneCommon(options.rcloneConfig),
    ]);
    const mapped = segments.map((segment) => {
      if (segment.origin !== 'remote') return segment;
      const file = path.join(stageRoot, ...segment.relative.split('/'));
      if (!fs.existsSync(file)) throw new Error(`staged segment missing: ${segment.relative}`);
      const size = fs.statSync(file).size;
      if (finite(segment.size, 0) > 0 && size !== finite(segment.size, 0)) {
        throw new Error(`staged segment size mismatch: ${segment.relative}`);
      }
      return { ...segment, origin: 'staged', file };
    });
    return {
      segments: mapped,
      stageRoot,
      stagedSegments: remoteSegments.length,
      stagedBytes: remoteSegments.reduce((sum, segment) => sum + finite(segment.size, 0), 0),
      warning: result.stderr.trim() ? 'rclone emitted a warning during bounded staging' : null,
    };
  } catch (error) {
    fs.rmSync(stageRoot, { recursive: true, force: true });
    throw error;
  }
}

function removeStage(stageRoot) {
  if (stageRoot) fs.rmSync(stageRoot, { recursive: true, force: true });
}

async function loadOrders(pool, options) {
  const conditions = [
    "o.action='place'", "o.order_kind='taker'", 'm.outcome IS NOT NULL',
    'o.strategy=$1', 'o.experiment_id=$2',
  ];
  const params = [options.strategy, options.experiment];
  if (options.since) {
    params.push(options.since);
    conditions.push(`COALESCE(o.available_at,o.ts)>=$${params.length}`);
  }
  if (options.until) {
    params.push(options.until);
    conditions.push(`COALESCE(o.available_at,o.ts)<=$${params.length}`);
  }
  if (options.orderId) {
    params.push(options.orderId);
    conditions.push(`o.id=$${params.length}`);
  }
  if (options.epoch) {
    params.push(options.epoch);
    conditions.push(`o.features->>'collection_epoch_id'=$${params.length}`);
  }
  const { rows } = await pool.query(`
    WITH candidates AS (
      SELECT o.id,o.strategy,o.experiment_id,o.phase,o.market_id,o.ts,
             COALESCE(o.available_at,o.ts) available_at,o.side,o.token,
             o.price,o.size,o.order_kind,o.features,o.intent_id,o.source_event_id,
             m.outcome,m.up_token_id,m.down_token_id,m.positive_label,m.negative_label,
             m.window_end,m.asset,
             row_number() OVER (
               PARTITION BY o.market_id ORDER BY COALESCE(o.available_at,o.ts),o.id
             ) market_rank
        FROM borg_shadow_orders o
        JOIN borg_markets m ON m.id=o.market_id
       WHERE ${conditions.join(' AND ')}
    ) SELECT * FROM candidates
      ${options.allIntents ? '' : 'WHERE market_rank=1'}
     ORDER BY available_at,id
  `, params);
  const limited = options.latest > 0 ? rows.slice(-options.latest) : rows;
  return limited.map((row) => ({
    ...row,
    id: String(row.id),
    market_id: String(row.market_id),
    price: finite(row.price),
    size: finite(row.size),
  }));
}

async function loadPrimaryComparison(pool, orders) {
  const ids = orders.map((order) => order.id);
  if (!ids.length) return null;
  const { rows } = await pool.query(`
    SELECT order_id,filled,pnl_1x,pnl_2x,data_quality_grade,
           execution_fidelity_grade,fidelity_level,detail
      FROM borg_shadow_scores
     WHERE order_id=ANY($1::bigint[])
  `, [ids]);
  const filled = rows.filter((row) => row.filled === true);
  const eligible = filled.filter((row) => ['A', 'B'].includes(row.data_quality_grade)
    && ['A', 'B'].includes(row.execution_fidelity_grade));
  const sum = (selected, field) => selected.reduce((total, row) =>
    total + finite(row[field], 0), 0);
  return {
    intendedOrders: orders.length,
    storedScores: rows.length,
    filled: filled.length,
    jointlyABFills: eligible.length,
    pnl1xAllFills: sum(filled, 'pnl_1x'),
    pnl2xAllFills: sum(filled, 'pnl_2x'),
    pnl1xJointlyAB: sum(eligible, 'pnl_1x'),
    pnl2xJointlyAB: sum(eligible, 'pnl_2x'),
    executionModels: Object.fromEntries([...rows.reduce((counts, row) => {
      const model = row.detail?.execution_model || row.detail?.executionModel
        || row.fidelity_level || 'unknown';
      counts.set(model, (counts.get(model) || 0) + 1);
      return counts;
    }, new Map()).entries()].sort()),
    caveat: 'Stored primary paper scores use the original frozen execution model. They are shown only as a same-cohort comparator and are not pooled with raw-WAL replay PnL.',
  };
}

function archiveMissingReplay(reconstructor, order, arrivalMs, latencyMs) {
  const replay = reconstructor.unscoreable(
    'UNSCOREABLE_ARCHIVE_MISSING', arrivalMs, null,
    { order_id: order.id, market_id: order.market_id },
  );
  return {
    ...attachPnl(order, replay),
    orderId: order.id,
    marketId: order.market_id,
    availableAt: new Date(order.available_at).toISOString(),
    latencyMs,
    asset: order.asset || null,
    token: order.token,
    outcome: order.outcome,
    limitPrice: finite(order.price),
    requestedSize: finite(order.size),
  };
}

async function replayOrders(orders, profiles, segments, options) {
  const maximumLatencyMs = Math.max(...profiles);
  const reconstructor = new FullDepthWalReconstructor({
    maxTransportSilenceMs: options.maxTransportSilenceMs,
  });
  const covered = [];
  const results = [];
  for (const order of orders) {
    if (hasSegmentCoverage(order, segments, options.lookbackMs, options.tailMs, maximumLatencyMs)) {
      covered.push(order);
      continue;
    }
    const availableMs = Date.parse(order.available_at);
    for (const latencyMs of profiles) {
      results.push(archiveMissingReplay(
        reconstructor, order, availableMs + latencyMs, latencyMs,
      ));
    }
  }
  const tasks = covered.flatMap((order) => profiles.map((latencyMs) => ({
    order,
    latencyMs,
    arrivalMs: Date.parse(order.available_at) + latencyMs,
  }))).sort((left, right) => left.arrivalMs - right.arrivalMs
    || Number(left.order.id) - Number(right.order.id)
    || left.latencyMs - right.latencyMs);
  let taskIndex = 0;
  let lastWallMs = null;
  const diagnostics = {
    filesRead: 0, bytesRead: 0, lines: 0, headers: 0,
    malformedLines: 0, segmentReadFailures: 0, wallClockRegressions: 0,
    remoteWarnings: 0, selectionWindowResets: 0,
  };
  const scoreUntil = (wallMs, inclusive = false) => {
    while (taskIndex < tasks.length
      && (inclusive ? tasks[taskIndex].arrivalMs <= wallMs : tasks[taskIndex].arrivalMs < wallMs)) {
      const task = tasks[taskIndex];
      const replay = attachPnl(task.order,
        reconstructor.replay(task.order, task.arrivalMs));
      results.push({
        ...replay,
        orderId: task.order.id,
        marketId: task.order.market_id,
        availableAt: new Date(task.order.available_at).toISOString(),
        latencyMs: task.latencyMs,
        asset: task.order.asset || null,
        token: task.order.token,
        outcome: task.order.outcome,
        limitPrice: finite(task.order.price),
        requestedSize: finite(task.order.size),
      });
      taskIndex += 1;
    }
  };

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (index > 0 && segment.replayWindow !== segments[index - 1].replayWindow) {
      reconstructor.beginSelectionWindow();
      diagnostics.selectionWindowResets += 1;
      lastWallMs = null;
    }
    if (!options.quiet && (index === 0 || (index + 1) % 25 === 0 || index + 1 === segments.length)) {
      process.stderr.write(`[h43-l4] segment ${index + 1}/${segments.length} ${segment.relative}\n`);
    }
    try {
      await replaySegment(segment, options, (envelope) => {
        const wallMs = finite(envelope?.receive_wall_timestamp_ms);
        if (!Number.isFinite(wallMs)) {
          diagnostics.malformedLines += 1;
          return;
        }
        if (lastWallMs != null && wallMs < lastWallMs) {
          diagnostics.wallClockRegressions += 1;
          reconstructor.clearAll('RECEIVE_WALL_CLOCK_REGRESSION', {
            previous: lastWallMs, observed: wallMs,
          });
          return;
        }
        // All events sharing the arrival millisecond are applied before that
        // arrival is scored; later events remain causally invisible.
        scoreUntil(wallMs, false);
        reconstructor.applyEnvelope(envelope);
        lastWallMs = wallMs;
      }, diagnostics);
    } catch (error) {
      diagnostics.segmentReadFailures += 1;
      reconstructor.clearAll('WAL_SEGMENT_READ_FAILURE', {
        relative: segment.relative, error: boundedText(error.message, 500),
      });
      if (!options.quiet) process.stderr.write(`[h43-l4] failed ${segment.relative}: ${error.message}\n`);
    }
  }
  scoreUntil(Infinity, true);
  return {
    results: results.sort((left, right) => Date.parse(left.availableAt) - Date.parse(right.availableAt)
      || left.latencyMs - right.latencyMs),
    diagnostics: {
      ...diagnostics,
      envelopesApplied: reconstructor.frames,
      payloadParseErrors: reconstructor.parseErrors,
      sequenceGaps: reconstructor.sequenceGaps,
      finalGap: reconstructor.lastGap,
    },
    archiveCoveredOrders: covered.length,
    archiveMissingOrders: orders.length - covered.length,
  };
}

async function main() {
  const profiles = parseProfiles(arg('--profiles', DEFAULT_PROFILES.join(',')));
  if (!profiles.length) throw new Error('at least one valid --profiles value is required');
  const source = String(arg('--source', 'auto')).toLowerCase();
  if (!['auto', 'local', 'remote'].includes(source)) {
    throw new Error('--source must be auto, local, or remote');
  }
  const options = {
    strategy: arg('--strategy', DEFAULT_STRATEGY),
    experiment: arg('--experiment', DEFAULT_EXPERIMENT),
    since: parseDate(arg('--since'), '--since'),
    until: parseDate(arg('--until'), '--until'),
    orderId: arg('--order-id'),
    epoch: arg('--epoch'),
    latest: positiveInteger(arg('--latest'), 0),
    allIntents: flag('--all-intents'),
    source,
    includeOpen: flag('--include-open'),
    walRoot: arg('--wal-root', process.env.BORG_CLOB_WAL_ROOT || DEFAULT_WAL_ROOT),
    rcloneBinary: arg('--rclone', process.env.GDRIVE_RCLONE_BINARY || DEFAULT_RCLONE),
    rcloneConfig: arg('--rclone-config', process.env.GDRIVE_RCLONE_CONFIG || DEFAULT_RCLONE_CONFIG),
    remote: arg('--remote', process.env.GDRIVE_RCLONE_REMOTE || DEFAULT_REMOTE),
    remotePrefix: arg('--remote-prefix', process.env.H43_REPLAY_REMOTE_PREFIX || DEFAULT_REMOTE_PREFIX),
    lookbackMs: positiveInteger(arg('--lookback-ms'), DEFAULT_LOOKBACK_MS),
    tailMs: positiveInteger(arg('--tail-ms'), DEFAULT_TAIL_MS),
    maxTransportSilenceMs: positiveInteger(arg('--transport-fresh-ms'), 10_000),
    maximumBytes: positiveInteger(arg('--max-bytes'), DEFAULT_MAX_BYTES),
    cacheRoot: arg('--cache-root', process.env.H43_REPLAY_CACHE_ROOT
      || path.join(os.tmpdir(), 'deltaforge-h43-replay')),
    diskReserveBytes: positiveInteger(arg('--disk-reserve-bytes'), 20 * 1024 ** 3),
    streamRemote: flag('--stream-remote'),
    quiet: flag('--quiet'),
  };
  const pool = createResearchPool({
    applicationName: 'h43-full-depth-replay', statementTimeoutMs: 30_000,
    lockTimeoutMs: 250, max: 1,
  });
  try {
    const orders = await loadOrders(pool, options);
    if (!orders.length) throw new Error('No resolved H43 orders matched the requested cohort');
    const primaryComparison = await loadPrimaryComparison(pool, orders);
    if (flag('--primary-only')) {
      process.stdout.write(`${JSON.stringify({
        format: 'h43-primary-cohort-comparison-v1',
        generatedAt: new Date().toISOString(),
        readOnly: true,
        strategy: options.strategy,
        experimentId: options.experiment,
        filters: {
          since: options.since?.toISOString() || null,
          until: options.until?.toISOString() || null,
          epoch: options.epoch || null,
          orderId: options.orderId || null,
          latest: options.latest || null,
        },
        primaryComparison,
      }, null, 2)}\n`);
      return;
    }
    const availableTimes = orders.map((order) => Date.parse(order.available_at));
    const maximumLatencyMs = Math.max(...profiles);
    const windows = orders.map((order) => ({
      startMs: Date.parse(order.available_at) - options.lookbackMs,
      endMs: Date.parse(order.available_at) + maximumLatencyMs + options.tailMs,
    }));
    const days = utcDaysBetween(
      Math.min(...availableTimes) - options.lookbackMs - MAX_PREDECESSOR_AGE_MS,
      Math.max(...availableTimes) + maximumLatencyMs + options.tailMs,
    );
    const catalog = await buildSegmentCatalog(days, options);
    const selected = selectSegments(catalog.segments, windows);
    const selectedBytes = selected.reduce((sum, segment) => sum + finite(segment.size, 0), 0);
    if (flag('--plan-only')) {
      const maximumLatency = Math.max(...profiles);
      const coveredOrders = orders.filter((order) => hasSegmentCoverage(
        order, selected, options.lookbackMs, options.tailMs, maximumLatency,
      )).length;
      process.stdout.write(`${JSON.stringify({
        format: 'h43-causal-full-depth-replay-plan-v1',
        generatedAt: new Date().toISOString(),
        readOnly: true,
        strategy: options.strategy,
        experimentId: options.experiment,
        profilesMs: profiles,
        resolvedOrders: orders.length,
        independentMarkets: new Set(orders.map((order) => order.market_id)).size,
        firstAt: new Date(Math.min(...availableTimes)).toISOString(),
        latestAt: new Date(Math.max(...availableTimes)).toISOString(),
        daysRequested: days,
        missingRemoteDays: catalog.missingRemoteDays,
        catalogSegments: catalog.segments.length,
        selectedSegments: selected.length,
        selectedRemoteSegments: selected.filter((segment) => segment.origin === 'remote').length,
        selectedLocalSegments: selected.filter((segment) => segment.origin === 'local').length,
        selectedCompressedBytes: selectedBytes,
        selectedCompressedGiB: selectedBytes / 1024 ** 3,
        archiveCoveredOrders: coveredOrders,
        archiveMissingOrders: orders.length - coveredOrders,
        configuredMaximumGiB: options.maximumBytes / 1024 ** 3,
        executableWithinConfiguredBound: selectedBytes <= options.maximumBytes,
        warning: 'Plan only: no raw segment was downloaded or replayed.',
        primaryPaperComparator: primaryComparison,
      }, null, 2)}\n`);
      return;
    }
    if (selectedBytes > options.maximumBytes) {
      throw new Error(
        `selected WAL is ${(selectedBytes / 1024 ** 3).toFixed(2)} GiB, above `
        + `--max-bytes ${(options.maximumBytes / 1024 ** 3).toFixed(2)} GiB; narrow the cohort or explicitly raise the bound`,
      );
    }
    const staged = await stageRemoteSegments(selected, options);
    let replayed;
    try {
      replayed = await replayOrders(orders, profiles, staged.segments, options);
    } finally {
      removeStage(staged.stageRoot);
    }
    const report = {
      format: 'h43-causal-full-depth-replay-v1',
      replayVersion: FULL_DEPTH_REPLAY_VERSION,
      generatedAt: new Date().toISOString(),
      readOnly: true,
      paperOnly: true,
      frozenSignalChanged: false,
      cohort: {
        strategy: options.strategy,
        experimentId: options.experiment,
        firstIntentPerMarket: !options.allIntents,
        resolvedOrders: orders.length,
        independentMarkets: new Set(orders.map((order) => order.market_id)).size,
        firstAt: new Date(Math.min(...availableTimes)).toISOString(),
        latestAt: new Date(Math.max(...availableTimes)).toISOString(),
        filters: {
          since: options.since?.toISOString() || null,
          until: options.until?.toISOString() || null,
          epoch: options.epoch || null,
          orderId: options.orderId || null,
          latest: options.latest || null,
        },
      },
      executionModel: {
        profilesMs: profiles,
        informationClock: 'stored available_at; no post-decision market data enters the signal',
        orderClock: 'raw WAL local receive time plus selected latency profile',
        depth: 'all displayed levels through the original limit; partial fills retained',
        redundancy: 'each CLOB shard reconstructed independently; disagreement fails closed',
        costs: 'Polymarket crypto taker fee at 1x and 2x plus a separate pessimistic one-tick/leg stress',
        limitations: 'Counterfactual L4 taker replay, not exchange acknowledgement (L5); hidden liquidity, matching-engine races and wallet/order rejection remain unobserved.',
      },
      primaryPaperComparator: primaryComparison,
      archive: {
        sourceRequested: source,
        remoteEnabled: catalog.remoteEnabled,
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
      profiles: summarizeFullDepthReplays(replayed.results, profiles),
      interpretationRules: [
        'UNSCOREABLE and invalid rows contribute no PnL and are not genuine non-fills.',
        'A/B replay is necessary evidence, not proof that a live order would have filled.',
        'The H43 thresholds, market selection, sizing and primary paper scores remain unchanged.',
        'Do not promote or tune from this reused cohort; require the frozen fresh-market protocol.',
      ],
      orders: replayed.results.map((row) => ({
        orderId: row.orderId,
        marketId: row.marketId,
        availableAt: row.availableAt,
        latencyMs: row.latencyMs,
        asset: row.asset,
        token: row.token,
        outcome: row.outcome,
        limitPrice: row.limitPrice,
        requestedSize: row.requestedSize,
        executionState: row.executionState,
        dataQualityGrade: row.dataQualityGrade,
        executionFidelityGrade: row.executionFidelityGrade,
        filled: row.filled,
        fillPrice: row.fillPrice,
        fillSize: row.fillSize,
        gross: row.gross,
        pnl1x: row.pnl1x,
        pnl2x: row.pnl2x,
        pnl2xOneTick: row.pnl2xOneTick,
        detail: row.detail,
      })),
    };
    const rendered = `${JSON.stringify(report, null, 2)}\n`;
    const outputFile = arg('--json-out');
    if (outputFile) report.outputFile = atomicWrite(outputFile, rendered);
    if (flag('--json') || !outputFile) process.stdout.write(rendered);
    else process.stdout.write(`${JSON.stringify({
      format: report.format,
      generatedAt: report.generatedAt,
      outputFile: report.outputFile,
      cohort: report.cohort,
      archive: report.archive,
      diagnostics: report.diagnostics,
      profiles: report.profiles,
    }, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

module.exports = {
  buildSegmentCatalog,
  coalesceWindows,
  hasSegmentCoverage,
  listLocalSegments,
  loadPrimaryComparison,
  parseProfiles,
  parseSegmentStart,
  replayOrders,
  stageRemoteSegments,
  selectSegments,
  utcDaysBetween,
};
