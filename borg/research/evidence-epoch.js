'use strict';

const fs = require('node:fs');

const DEFAULT_MIN_HOURS = 24;
const DEFAULT_PARQUET_MIN_HOURS = 24;
const DEFAULT_PARQUET_MAX_AGE_SEC = 90 * 60;
const DEFAULT_PARQUET_MIN_VERIFIED_BATCHES = 2;
const PARQUET_STATE_FORMAT = 'deltaforge-parquet-lake-state-v1';
const PARQUET_RECEIPT_FORMAT = 'deltaforge-parquet-lake-receipt-v1';
const PARQUET_REPORT_FORMAT = 'deltaforge-parquet-lake-run-v1';
const PARQUET_DATASET = 'event-envelope-v1';
const FAST_COMPONENT_MAX_AGE_SEC = 120;
const SLOW_COMPONENT_MAX_AGE_SEC = 15 * 60;
const REQUIRED_FAST_COMPONENTS = Object.freeze([
  'allmarket_lab',
  'crossvenue_lab',
  'options_surface',
  'pyth_boundary',
  'structural_scanner',
  'main_bot',
  'george_bot',
]);
const REQUIRED_SLOW_COMPONENTS = Object.freeze([
  'raw_archiver', 'borg_scorer', 'hot_partition_manager',
]);
const DOMAIN_PROGRESS_FIELDS = Object.freeze({
  allmarket_lab: 'lastEventAt',
  crossvenue_lab: 'lastEvaluationAt',
  options_surface: 'lastEventAt',
  structural_scanner: 'lastPersistedAt',
});

function finite(value, fallback = null) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function ageSeconds(value, nowMs = Date.now()) {
  const parsed = value == null ? NaN : new Date(value).getTime();
  return Number.isFinite(parsed) ? Math.max(0, (nowMs - parsed) / 1000) : null;
}

function isAtOrAfter(value, boundary) {
  const parsed = value == null ? NaN : new Date(value).getTime();
  const boundaryMs = boundary == null ? NaN : new Date(boundary).getTime();
  return Number.isFinite(parsed) && Number.isFinite(boundaryMs) && parsed >= boundaryMs;
}

function findCounters(value, matcher, path = [], output = []) {
  if (value == null || path.length > 8) return output;
  if (Array.isArray(value)) {
    value.forEach((item, index) => findCounters(item, matcher, [...path, index], output));
    return output;
  }
  if (typeof value !== 'object') return output;
  for (const [key, nested] of Object.entries(value)) {
    const nextPath = [...path, key];
    if (matcher(key) && finite(nested, 0) > 0) {
      output.push({ path: nextPath.join('.'), value: finite(nested, 0) });
    }
    if (nested && typeof nested === 'object') findCounters(nested, matcher, nextPath, output);
  }
  return output;
}

function isErrorCounter(key) {
  return /(?:errors|failures|errorcount)$/i.test(String(key));
}

function isGapCounter(key) {
  return /(?:sequence.?gaps?|discardedsequence|coveragegaps?|connection.?gaps?|reconfigurationgaps?|bookstategaps?)$/i
    .test(String(key));
}

function latestContinuousHealthySuffix(rows, options = {}) {
  const maxGapSec = finite(options.maxGapSec, FAST_COMPONENT_MAX_AGE_SEC);
  const ordered = [...(Array.isArray(rows) ? rows : [])]
    .filter((row) => Number.isFinite(new Date(row?.checked_at).getTime()))
    .sort((left, right) => new Date(left.checked_at) - new Date(right.checked_at));
  let suffix = [];
  let previousMs = null;
  let lastFailedAt = null;
  let lastContinuityBreakAt = null;
  for (const row of ordered) {
    const checkedMs = new Date(row.checked_at).getTime();
    const gapSec = previousMs == null ? null : (checkedMs - previousMs) / 1000;
    if (gapSec != null && gapSec > maxGapSec) {
      suffix = [];
      lastContinuityBreakAt = row.checked_at;
    }
    if (row.healthy !== true) {
      suffix = [];
      lastFailedAt = row.checked_at;
      lastContinuityBreakAt = row.checked_at;
    } else {
      suffix.push({ ...row, gapSec: suffix.length ? gapSec : null });
    }
    previousMs = checkedMs;
  }
  return {
    samples: suffix.length,
    first_sample_at: suffix[0]?.checked_at || null,
    last_sample_at: suffix.at(-1)?.checked_at || null,
    max_gap_seconds: suffix.reduce((maximum, row) =>
      Math.max(maximum, finite(row.gapSec, 0)), 0),
    last_failed_at: lastFailedAt,
    last_continuity_break_at: lastContinuityBreakAt,
  };
}

function diskSnapshot(root = '/var/lib/deltaforge') {
  try {
    const stat = fs.statfsSync(root);
    return {
      freeGiB: Number(stat.bavail) * Number(stat.bsize) / 1024 ** 3,
      totalGiB: Number(stat.blocks) * Number(stat.bsize) / 1024 ** 3,
    };
  } catch (_) {
    return { freeGiB: null, totalGiB: null };
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function archiveReportFailure(report) {
  if (!report) return null;
  if (report.format !== 'deltaforge-google-drive-archive-v1') {
    return 'Google Drive archive report format is invalid';
  }
  if (report.status === 'failed') {
    return `Google Drive archive failed${report.failedAt ? ` at ${report.failedAt}` : ''}: ${
      String(report.error || 'unknown failure').slice(0, 240)}`;
  }
  if (report.status !== 'verified') {
    return `Google Drive archive report status is ${report.status || 'missing'}; verified required`;
  }
  return null;
}

function readReceipt(file) {
  try {
    return Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/)
      .filter((line) => line.includes('='))
      .map((line) => {
        const split = line.indexOf('=');
        return [line.slice(0, split), line.slice(split + 1)];
      }));
  } catch (_) {
    return null;
  }
}

function fileMtime(file) {
  try { return fs.statSync(file).mtime; } catch (_) { return null; }
}

function assessParquetLake(options = {}) {
  const nowMs = options.now ? new Date(options.now).getTime() : Date.now();
  const stateFile = options.stateFile || '/var/lib/deltaforge/parquet-lake/state.json';
  const receiptFile = options.receiptFile || '/var/lib/deltaforge/parquet-lake/receipt';
  const reportFile = options.reportFile || '/var/lib/deltaforge/parquet-lake/last-report.json';
  const maxAgeSec = finite(options.maxAgeSec, DEFAULT_PARQUET_MAX_AGE_SEC);
  const minimumVerifiedBatches = finite(
    options.minimumVerifiedBatches,
    DEFAULT_PARQUET_MIN_VERIFIED_BATCHES,
  );
  const critical = [];
  const state = readJson(stateFile);
  const receipt = readReceipt(receiptFile);
  const report = readJson(reportFile);
  const reportMtime = fileMtime(reportFile);
  if (!state || state.format !== PARQUET_STATE_FORMAT) {
    critical.push('verified Parquet lake state is missing or invalid');
  }
  const batches = Object.entries(state?.batches || {})
    .filter(([, batch]) => batch?.verified === true)
    .sort((left, right) => String(left[1].verifiedAt || '')
      .localeCompare(String(right[1].verifiedAt || '')));
  const latestEntry = batches.at(-1) || null;
  const latestHash = latestEntry?.[0] || null;
  const latestBatch = latestEntry?.[1] || null;
  const parquetOutputs = batches.flatMap(([, batch]) => (batch.outputs || [])
    .filter((output) => String(output.relative || '').endsWith('.parquet')));
  const invalidOutputs = parquetOutputs.filter((output) => output.verified !== true
    || !/^[a-f0-9]{64}$/i.test(String(output.sha256 || ''))
    || output.compression !== 'ZSTD'
    || !(finite(output.bytes, 0) > 0)
    || !(finite(output.rows, 0) > 0));
  const sourceFiles = Object.keys(state?.sources || {}).length;
  const rejectedSourceFiles = Object.keys(state?.rejectedSources || {}).length;
  const rows = parquetOutputs.reduce((sum, output) => sum + finite(output.rows, 0), 0);
  if (batches.length < minimumVerifiedBatches) {
    critical.push(`verified Parquet recurrence has ${batches.length} batch(es); ${minimumVerifiedBatches} required`);
  }
  if (!(sourceFiles > 0) || !(rows > 0) || !parquetOutputs.length) {
    critical.push('verified Parquet lake contains no queryable source events');
  }
  if (invalidOutputs.length) {
    critical.push(`${invalidOutputs.length} Parquet output(s) fail checksum/ZSTD/row validation`);
  }
  if (rejectedSourceFiles > 0) {
    critical.push(`${rejectedSourceFiles} raw source object(s) are quarantined from Parquet replay`);
  }
  const receiptAgeSec = ageSeconds(receipt?.completed_at, nowMs);
  if (!receipt || receipt.format !== PARQUET_RECEIPT_FORMAT) {
    critical.push('verified Parquet lake receipt is missing or invalid');
  } else {
    if (receipt.dataset !== PARQUET_DATASET) {
      critical.push(`Parquet receipt dataset is ${receipt.dataset || 'missing'}; ${PARQUET_DATASET} required`);
    }
    if (!latestHash || receipt.latest_batch !== latestHash) {
      critical.push('Parquet receipt does not attest the latest verified state batch');
    }
    if (receipt.compression !== 'ZSTD') critical.push('Parquet receipt does not attest ZSTD compression');
    if (receipt.remote_verification !== 'google-drive-md5-via-rclone-check') {
      critical.push('Parquet receipt lacks remote checksum verification');
    }
    if (receiptAgeSec == null || receiptAgeSec > maxAgeSec) {
      critical.push(`verified Parquet receipt is ${receiptAgeSec == null
        ? 'undated' : `${Math.round(receiptAgeSec)}s old`}; ${maxAgeSec}s maximum`);
    }
  }
  const reportAgeSec = ageSeconds(reportMtime, nowMs);
  const allowedReportStatuses = new Set(['verified', 'verified_no_new_batch']);
  if (!report || report.format !== PARQUET_REPORT_FORMAT) {
    critical.push('Parquet compaction report is missing or invalid');
  } else if (!allowedReportStatuses.has(report.status)) {
    critical.push(`latest Parquet compaction status is ${report.status || 'missing'}`);
  }
  if (reportAgeSec == null || reportAgeSec > maxAgeSec) {
    critical.push(`Parquet compaction report is ${reportAgeSec == null
      ? 'undated' : `${Math.round(reportAgeSec)}s old`}; ${maxAgeSec}s maximum`);
  }
  return {
    healthy: critical.length === 0,
    critical,
    checkedAt: new Date(nowMs).toISOString(),
    stateFile,
    receiptFile,
    reportFile,
    verifiedBatches: batches.length,
    minimumVerifiedBatches,
    firstVerifiedAt: batches[0]?.[1]?.verifiedAt || null,
    latestVerifiedAt: latestBatch?.verifiedAt || null,
    latestBatch: latestHash,
    sourceFiles,
    rows,
    parquetFiles: parquetOutputs.length,
    invalidOutputs: invalidOutputs.length,
    rejectedSourceFiles,
    receiptCompletedAt: receipt?.completed_at || null,
    receiptAgeSec,
    reportStatus: report?.status || null,
    reportAgeSec,
    pendingSourceFiles: finite(
      receipt?.pending_source_files ?? report?.pendingSourceFiles ?? report?.pending,
      null,
    ),
  };
}

async function assessEvidenceEpoch(pool, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const nowMs = now.getTime();
  const minHours = finite(options.minHours, DEFAULT_MIN_HOURS);
  const parquetMinHours = finite(options.parquetMinHours, DEFAULT_PARQUET_MIN_HOURS);
  const critical = [];
  const warnings = [];
  const { rows: runRows } = await pool.query(`
    SELECT r.run_id,r.epoch_id,r.started_at run_started_at,r.host,
           r.code_version run_code_version,
           e.started_at epoch_started_at,e.code_version epoch_code_version,
           e.reason,e.data_contract_version
      FROM borg_collector_runs r
      JOIN borg_collection_epochs e ON e.epoch_id=r.epoch_id
     WHERE r.status='RUNNING'
     ORDER BY r.started_at DESC LIMIT 1
  `);
  const run = runRows[0] || null;
  if (!run) {
    return {
      format: 'borg-evidence-epoch-v1', checkedAt: now.toISOString(),
      status: 'FAILED', promotionEligible: false, minCleanHours: minHours,
      epoch: null, critical: ['no RUNNING primary collector'], warnings, metrics: {},
    };
  }
  const epochStart = new Date(run.epoch_started_at);
  const epochAgeHours = Math.max(0, (nowMs - epochStart.getTime()) / 3_600_000);

  const { rows: componentRows } = await pool.query(`
    SELECT component,beat_at,meta
      FROM system_heartbeats
     WHERE component=ANY($1::text[])
  `, [[...REQUIRED_FAST_COMPONENTS, ...REQUIRED_SLOW_COMPONENTS]]);
  const components = Object.fromEntries(componentRows.map((row) => [row.component, row]));
  for (const component of REQUIRED_FAST_COMPONENTS) {
    const row = components[component];
    const age = ageSeconds(row?.beat_at, nowMs);
    if (!isAtOrAfter(row?.beat_at, epochStart)) {
      critical.push(`${component} has not emitted a heartbeat in this epoch`);
    } else if (age == null || age > FAST_COMPONENT_MAX_AGE_SEC) {
      critical.push(`${component} heartbeat is ${age == null ? 'missing' : `${Math.round(age)}s old`}`);
    }
    const progressField = DOMAIN_PROGRESS_FIELDS[component];
    if (progressField) {
      const processStartedAt = row?.meta?.processStartedAt;
      const progressAt = row?.meta?.[progressField];
      const uptimeSec = ageSeconds(processStartedAt, nowMs);
      const progressAgeSec = ageSeconds(progressAt, nowMs);
      if (row?.meta?.collectionEpochId !== run.epoch_id) {
        critical.push(`${component} heartbeat belongs to a different collection epoch`);
      }
      if (!isAtOrAfter(processStartedAt, epochStart) || uptimeSec == null || uptimeSec < 60) {
        critical.push(`${component} process is warming, stale or repeatedly restarting`);
      }
      if (!isAtOrAfter(progressAt, epochStart)
          || progressAgeSec == null || progressAgeSec > FAST_COMPONENT_MAX_AGE_SEC) {
        critical.push(`${component} ${progressField} is ${
          progressAgeSec == null ? 'missing' : `${Math.round(progressAgeSec)}s old`}`);
      }
    }
    if (component === 'allmarket_lab') {
      const refreshAt = row?.meta?.lastUniverseRefreshAt;
      const refreshAgeSec = ageSeconds(refreshAt, nowMs);
      const maxRefreshAgeSec = finite(row?.meta?.universeMaxStaleMs, 7_200_000) / 1000;
      const consecutiveTimeouts = finite(row?.meta?.consecutiveUniverseRefreshTimeouts, 0);
      if (!isAtOrAfter(refreshAt, epochStart)
          || refreshAgeSec == null || refreshAgeSec > maxRefreshAgeSec) {
        critical.push(`allmarket_lab universe refresh is ${
          refreshAgeSec == null ? 'missing' : `${Math.round(refreshAgeSec)}s old`}`);
      }
      if (consecutiveTimeouts >= 3) {
        critical.push(`allmarket_lab has ${consecutiveTimeouts} consecutive universe timeouts`);
      }
    }
    if (component === 'pyth_boundary') {
      const meta = row?.meta || {};
      const processStartedAt = meta.processStartedAt;
      const uptimeSec = ageSeconds(processStartedAt, nowMs);
      if (meta.collectionEpochId !== run.epoch_id) {
        critical.push('pyth_boundary heartbeat belongs to a different collection epoch');
      }
      if (!isAtOrAfter(processStartedAt, epochStart) || uptimeSec == null || uptimeSec < 60) {
        critical.push('pyth_boundary process is warming, stale or repeatedly restarting');
      }
      if (meta.experimentId !== 'pyth-resolver-boundary-transfer-v3-hermes-exact-feed') {
        critical.push('pyth_boundary is not running the exact-feed Hermes forward arm');
      }
      if (meta.transportConnected !== true || finite(meta.symbols, 0) <= 0) {
        critical.push('pyth_boundary exact-feed Hermes transport or feed set is unavailable');
      }
      if (finite(meta.hermes?.metrics?.unresolvedFeeds, 0) > 0) {
        critical.push(`pyth_boundary has ${finite(meta.hermes.metrics.unresolvedFeeds, 0)} unresolved exact feed(s)`);
      }
      const marketsInWindow = finite(meta.marketsInWindow, 0);
      if (marketsInWindow > 0) {
        const expectedFeeds = finite(meta.expectedWindowFeeds, null);
        const coveredFeeds = finite(meta.coveredWindowFeeds, null);
        const tickAgeSec = ageSeconds(meta.lastUsableTickAt, nowMs);
        if (meta.transportConnected !== true || meta.feedState !== 'LIVE') {
          critical.push(`pyth_boundary exact-feed transport is ${meta.feedState || 'UNKNOWN'}`);
        }
        if (expectedFeeds == null || coveredFeeds == null || expectedFeeds <= 0
            || coveredFeeds < expectedFeeds) {
          critical.push(`pyth_boundary exact-feed coverage is ${coveredFeeds ?? 'missing'}/${expectedFeeds ?? 'missing'}`);
        }
        if (!isAtOrAfter(meta.lastUsableTickAt, epochStart)
            || tickAgeSec == null || tickAgeSec > 30) {
          critical.push(`pyth_boundary last usable exact-feed tick is ${
            tickAgeSec == null ? 'missing' : `${Math.round(tickAgeSec)}s old`}`);
        }
      } else {
        warnings.push('pyth_boundary has no exact-feed market currently inside its resolver window');
      }
    }
  }
  for (const component of REQUIRED_SLOW_COMPONENTS) {
    const age = ageSeconds(components[component]?.beat_at, nowMs);
    if (!isAtOrAfter(components[component]?.beat_at, epochStart)) {
      critical.push(`${component} has not emitted a heartbeat in this epoch`);
    } else if (age == null || age > SLOW_COMPONENT_MAX_AGE_SEC) {
      critical.push(`${component} heartbeat is ${age == null ? 'missing' : `${Math.round(age)}s old`}`);
    }
  }

  const { rows: eventHeartbeatRows } = await pool.query(`
    SELECT DISTINCT ON (source) source,ts,message,data
      FROM borg_events
     WHERE source=ANY($1::text[])
     ORDER BY source,ts DESC
  `, [['heartbeat', 'flow_heartbeat']]);
  const eventHeartbeats = Object.fromEntries(eventHeartbeatRows.map((row) => [row.source, row]));
  for (const source of ['heartbeat', 'flow_heartbeat']) {
    const age = ageSeconds(eventHeartbeats[source]?.ts, nowMs);
    if (!isAtOrAfter(eventHeartbeats[source]?.ts, epochStart)) {
      critical.push(`${source} has not emitted a heartbeat in this epoch`);
    } else if (age == null || age > FAST_COMPONENT_MAX_AGE_SEC) {
      critical.push(`${source} is ${age == null ? 'missing' : `${Math.round(age)}s old`}`);
    }
  }
  // Latest-state health alone is insufficient: a feed may go stale, reconnect,
  // and emit a later green heartbeat before the evidence recorder samples it.
  // Persisted stale heartbeats therefore invalidate the whole immutable epoch.
  const { rows: staleHeartbeatRows } = await pool.query(`
    SELECT count(*)::int n,min(ts) first_at,max(ts) last_at
      FROM borg_events
     WHERE ts >= $1
       AND source IN ('heartbeat','flow_heartbeat')
       AND upper(COALESCE(level,''))='WARN'
       AND message LIKE 'STALE:%'
  `, [epochStart]);
  const staleHeartbeats = staleHeartbeatRows[0] || { n: 0 };
  if (finite(staleHeartbeats.n, 0) > 0) {
    critical.push(`${staleHeartbeats.n} transient stale-feed heartbeat(s) in epoch`);
  }
  const flowHeartbeat = eventHeartbeats.flow_heartbeat?.data || {};
  const primaryClob = eventHeartbeats.heartbeat?.data?.clob || null;
  if (primaryClob?.routingMode === 'redundant-explicit') {
    const expectedAssets = finite(primaryClob.expectedAssets, null);
    const coveredAssets = finite(primaryClob.coveredAssets, null);
    if (expectedAssets == null || coveredAssets == null) {
      critical.push('primary redundant CLOB asset-coverage telemetry is missing');
    } else if (expectedAssets <= 0 || coveredAssets < expectedAssets) {
      critical.push(`primary redundant CLOB coverage is ${coveredAssets}/${expectedAssets} token assets`);
    }
  } else if (!primaryClob
      || finite(primaryClob.expectedSockets, null) == null
      || finite(primaryClob.activeSockets, null) == null) {
    critical.push('primary CLOB socket coverage telemetry is missing');
  } else if (finite(primaryClob.expectedSockets, 0) <= 0
      || finite(primaryClob.activeSockets, 0) < finite(primaryClob.expectedSockets, 0)) {
    critical.push(`primary CLOB socket coverage is ${finite(primaryClob.activeSockets, 0)}/${finite(primaryClob.expectedSockets, 0)}`);
  }
  const primaryRtds = eventHeartbeats.heartbeat?.data?.rtds || null;
  const expectedRtdsAssets = finite(primaryRtds?.expectedAssets, null);
  const coveredRtdsAssets = finite(primaryRtds?.coveredAssets, null);
  if (expectedRtdsAssets == null || coveredRtdsAssets == null) {
    critical.push('primary redundant RTDS asset-coverage telemetry is missing');
  } else if (expectedRtdsAssets <= 0 || coveredRtdsAssets < expectedRtdsAssets) {
    critical.push(`primary redundant RTDS coverage is ${coveredRtdsAssets}/${expectedRtdsAssets} assets`);
  }
  if (flowHeartbeat.routingMode === 'redundant-explicit') {
    const expectedFlowAssets = finite(flowHeartbeat.expectedAssets, null);
    const coveredFlowAssets = finite(flowHeartbeat.coveredAssets, null);
    if (expectedFlowAssets == null || coveredFlowAssets == null) {
      critical.push('public-flow redundant CLOB asset-coverage telemetry is missing');
    } else if (expectedFlowAssets <= 0 || coveredFlowAssets < expectedFlowAssets) {
      critical.push(`public-flow redundant CLOB coverage is ${coveredFlowAssets}/${expectedFlowAssets} token assets`);
    }
  } else {
    const activeFlowSockets = finite(flowHeartbeat.activeSockets, null);
    const expectedFlowSockets = finite(flowHeartbeat.expectedSockets, null);
    if (activeFlowSockets == null || expectedFlowSockets == null) {
      critical.push('public-flow CLOB socket coverage telemetry is missing');
    } else if (expectedFlowSockets <= 0 || activeFlowSockets < expectedFlowSockets) {
      critical.push(`public-flow CLOB socket coverage is ${activeFlowSockets}/${expectedFlowSockets}`);
    }
  }
  const globalDbQueue = finite(flowHeartbeat.globalDbQueue, null);
  const globalDbQueueOldestAgeMs = finite(flowHeartbeat.globalDbQueueOldestAgeMs, null);
  if (globalDbQueue == null || globalDbQueueOldestAgeMs == null) {
    critical.push('public-flow derived SQL queue telemetry is missing');
  } else if (globalDbQueue > 5000 || globalDbQueueOldestAgeMs > 120_000) {
    critical.push(`public-flow derived SQL queue is stalled: ${globalDbQueue} rows, oldest ${Math.round(globalDbQueueOldestAgeMs)}ms`);
  }
  const diagnosticTransitionDwellMs = finite(
    components.options_surface?.meta?.diagnosticTransitionDwellMs,
    null,
  );
  if (diagnosticTransitionDwellMs == null || diagnosticTransitionDwellMs < 30_000) {
    critical.push('options diagnostic SQL transition dwell is missing or below 30000ms');
  }

  const { rows: runFailureRows } = await pool.query(`
    SELECT status,count(*)::int n
      FROM borg_collector_runs
     WHERE epoch_id=$1 AND started_at >= $2 AND status IN ('ABANDONED','FAILED')
     GROUP BY status
  `, [run.epoch_id, epochStart]);
  if (runFailureRows.length) {
    critical.push(`collector run failures in epoch: ${runFailureRows
      .map((row) => `${row.status}=${row.n}`).join(', ')}`);
  }

  const { rows: errorRows } = await pool.query(`
    SELECT count(*)::int n
      FROM borg_events
     WHERE ts >= $1 AND upper(COALESCE(level,'')) IN ('ERROR','CRITICAL','FATAL')
  `, [epochStart]);
  if (errorRows[0].n > 0) critical.push(`${errorRows[0].n} ERROR/CRITICAL event(s) in epoch`);

  const sequenceCounters = [];
  const errorCounters = [];
  for (const row of [...componentRows, ...eventHeartbeatRows]) {
    findCounters(row.meta || row.data, isGapCounter, [], sequenceCounters);
    findCounters(row.meta || row.data, isErrorCounter, [], errorCounters);
  }
  if (sequenceCounters.length) {
    critical.push(`non-zero sequence-gap counters: ${sequenceCounters
      .map((row) => `${row.path}=${row.value}`).join(', ')}`);
  }
  if (errorCounters.length) {
    critical.push(`non-zero collector error counters: ${errorCounters
      .map((row) => `${row.path}=${row.value}`).join(', ')}`);
  }

  const allMarketCount = finite(components.allmarket_lab?.meta?.selectedMarkets, 0);
  const flowMarketCount = finite(eventHeartbeats.flow_heartbeat?.data?.selectedMarkets, 0);
  const crossVenueCount = finite(components.crossvenue_lab?.meta?.monitoredMatches, 0);
  if (!(allMarketCount > 0)) critical.push('all-market collector has no selected markets');
  if (!(flowMarketCount > 0)) critical.push('public-flow collector has no selected markets');
  if (!(crossVenueCount > 0)) critical.push('cross-venue collector has no monitored matches');

  const disk = diskSnapshot(options.storageRoot);
  const minimumFreeGiB = finite(options.minimumFreeGiB, 30);
  if (disk.freeGiB == null) critical.push('capture-disk free space is unknown');
  else if (disk.freeGiB < minimumFreeGiB) {
    critical.push(`capture disk has ${disk.freeGiB.toFixed(2)} GiB free; ${minimumFreeGiB} GiB required`);
  }

  const archiveFile = options.archiveStateFile || '/var/lib/deltaforge/archive/borg-raw/archive-state.json';
  const archive = readJson(archiveFile);
  if (!archive) critical.push('verified raw-archive state is missing');
  else if (Array.isArray(archive.errors) && archive.errors.length) {
    critical.push(`verified raw archiver has ${archive.errors.length} error(s)`);
  }

  const offhostReceiptFile = options.offhostReceiptFile
    || '/var/lib/deltaforge/offhost-archive.receipt';
  const offhostReportFile = options.offhostReportFile
    || '/var/lib/deltaforge/google-drive-archive/last-report.json';
  const offhostReport = readJson(offhostReportFile);
  const offhostFailure = archiveReportFailure(offhostReport);
  if (offhostFailure) critical.push(offhostFailure);
  const offhostReceipt = readReceipt(offhostReceiptFile);
  const maxOffhostAgeSec = finite(options.maxOffhostAgeSec, 3 * 60 * 60);
  const offhostAgeSec = ageSeconds(offhostReceipt?.completed_at, nowMs);
  if (!offhostReceipt || offhostReceipt.format !== 'deltaforge-offhost-receipt-v1') {
    critical.push('off-host immutable archive receipt is missing or invalid');
  } else {
    if (!offhostReceipt.latest_file || offhostReceipt.latest_file === 'none') {
      critical.push('off-host immutable archive receipt contains no archived file');
    }
    if (offhostAgeSec == null || offhostAgeSec > maxOffhostAgeSec) {
      critical.push(`off-host immutable archive receipt is ${offhostAgeSec == null
        ? 'undated' : `${Math.round(offhostAgeSec)}s old`}; ${maxOffhostAgeSec}s maximum`);
    }
  }

  const parquet = assessParquetLake({
    now,
    stateFile: options.parquetStateFile,
    receiptFile: options.parquetReceiptFile,
    reportFile: options.parquetReportFile,
    maxAgeSec: options.maxParquetAgeSec,
    minimumVerifiedBatches: options.minimumParquetVerifiedBatches,
  });
  critical.push(...parquet.critical);

  const currentStatus = critical.length ? 'FAIL' : 'PASS';
  if (options.record === true) {
    await pool.query(`
      INSERT INTO borg_evidence_health_samples
        (epoch_id,checked_at,status,critical,warnings,metrics)
      VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb)
    `, [run.epoch_id, now, currentStatus, JSON.stringify(critical), JSON.stringify(warnings),
      JSON.stringify({ requirementsVersion: 'evidence-health-v3-feed-gaps', runId: run.run_id,
        components: Object.fromEntries(
        Object.entries(components).map(([key, row]) => [key, {
          beatAt: row.beat_at, ageSeconds: ageSeconds(row.beat_at, nowMs),
        }]),
      ), disk, parquet, staleHeartbeats, sequenceCounters, errorCounters })]);
  }

  const { rows: coverageRows } = await pool.query(`
    WITH ordered AS (
      SELECT checked_at,status,
             checked_at-lag(checked_at) OVER (ORDER BY checked_at) AS gap
        FROM borg_evidence_health_samples
       WHERE epoch_id=$1 AND checked_at >= $2 AND checked_at <= $3
    )
    SELECT count(*)::int samples,
           count(*) FILTER (WHERE status<>'PASS')::int failed_samples,
           min(checked_at) first_sample_at,max(checked_at) last_sample_at,
           max(EXTRACT(EPOCH FROM gap))::float8 max_gap_seconds
      FROM ordered
  `, [run.epoch_id, epochStart, now]);
  const coverage = coverageRows[0];
  const firstDelaySec = coverage.first_sample_at
    ? (new Date(coverage.first_sample_at) - epochStart) / 1000 : null;
  const lastAgeSec = ageSeconds(coverage.last_sample_at, nowMs);
  const coverageComplete = coverage.samples > 0
    && firstDelaySec != null && firstDelaySec <= 300
    && lastAgeSec != null && lastAgeSec <= 120
    && finite(coverage.max_gap_seconds, 0) <= 120
    && coverage.failed_samples === 0;
  // Pull a bounded window and identify the latest uninterrupted healthy suffix.
  // A monitor pause longer than the allowed cadence resets burn-in at the first
  // returning sample; it must not poison all future epochs forever.
  const parquetLookbackHours = Math.max(48, parquetMinHours * 2);
  const parquetLookbackStart = new Date(nowMs - parquetLookbackHours * 3_600_000);
  const { rows: parquetCoverageRows } = await pool.query(`
    SELECT checked_at,
           COALESCE((metrics->'parquet'->>'healthy')::boolean,false) healthy
      FROM borg_evidence_health_samples
     WHERE checked_at >= $1 AND checked_at <= $2 AND metrics ? 'parquet'
     ORDER BY checked_at
  `, [parquetLookbackStart, now]);
  const parquetCoverage = latestContinuousHealthySuffix(parquetCoverageRows, {
    maxGapSec: FAST_COMPONENT_MAX_AGE_SEC,
  });
  const parquetFirstMs = parquetCoverage.first_sample_at
    ? new Date(parquetCoverage.first_sample_at).getTime() : NaN;
  const parquetCleanHours = Number.isFinite(parquetFirstMs)
    ? Math.max(0, (nowMs - parquetFirstMs) / 3_600_000) : 0;
  const parquetLastAgeSec = ageSeconds(parquetCoverage.last_sample_at, nowMs);
  const parquetCoverageContinuous = parquetCoverage.samples > 0
    && parquetLastAgeSec != null && parquetLastAgeSec <= 120
    && finite(parquetCoverage.max_gap_seconds, 0) <= 120;
  const parquetBurnInComplete = parquet.healthy
    && parquetCoverageContinuous && parquetCleanHours >= parquetMinHours;
  const burnInComplete = epochAgeHours >= minHours;
  const promotionEligible = currentStatus === 'PASS' && burnInComplete && coverageComplete
    && parquetBurnInComplete;
  const status = promotionEligible ? 'PASSED_24H_CLEAN'
    : currentStatus === 'FAIL' || (burnInComplete && !coverageComplete) ? 'FAILED'
      : 'PENDING_24H';
  if (!burnInComplete) {
    warnings.push(`${Math.max(0, minHours - epochAgeHours).toFixed(2)} clean hour(s) remain`);
  } else if (!coverageComplete) {
    critical.push('24-hour health-sample coverage is incomplete or contains a failed sample');
  }
  if (parquet.healthy && !parquetBurnInComplete) {
    warnings.push(`${Math.max(0, parquetMinHours - parquetCleanHours).toFixed(2)} verified Parquet burn-in hour(s) remain`);
  }
  return {
    format: 'borg-evidence-epoch-v1',
    checkedAt: now.toISOString(),
    status,
    promotionEligible,
    minCleanHours: minHours,
    epoch: {
      id: run.epoch_id,
      startedAt: epochStart.toISOString(),
      ageHours: +epochAgeHours.toFixed(4),
      runId: run.run_id,
      host: run.host,
      codeVersion: run.epoch_code_version,
      collectorCodeVersion: run.run_code_version,
      dataContractVersion: run.data_contract_version,
      reason: run.reason,
    },
    coverage: {
      samples: coverage.samples,
      failedSamples: coverage.failed_samples,
      firstSampleAt: coverage.first_sample_at,
      lastSampleAt: coverage.last_sample_at,
      maxGapSeconds: finite(coverage.max_gap_seconds),
      complete: coverageComplete,
    },
    parquetBurnIn: {
      status: !parquet.healthy ? 'FAILED_CURRENT'
        : parquetBurnInComplete ? 'PASSED_24H_CLEAN' : 'PENDING_24H',
      minCleanHours: parquetMinHours,
      cleanHours: +parquetCleanHours.toFixed(4),
      samples: parquetCoverage.samples,
      firstSampleAt: parquetCoverage.first_sample_at,
      lastSampleAt: parquetCoverage.last_sample_at,
      lastFailedAt: parquetCoverage.last_failed_at,
      lastContinuityBreakAt: parquetCoverage.last_continuity_break_at,
      maxGapSeconds: finite(parquetCoverage.max_gap_seconds),
      continuous: parquetCoverageContinuous,
      complete: parquetBurnInComplete,
    },
    critical,
    warnings,
    metrics: {
      components: Object.fromEntries(Object.entries(components).map(([key, row]) => [key, {
        beatAt: row.beat_at, ageSeconds: ageSeconds(row.beat_at, nowMs),
      }])),
      eventHeartbeats: Object.fromEntries(Object.entries(eventHeartbeats).map(([key, row]) => [key, {
        beatAt: row.ts, ageSeconds: ageSeconds(row.ts, nowMs),
      }])),
      disk,
      archiveStatus: archive?.status || null,
      offhostArchive: {
        completedAt: offhostReceipt?.completed_at || null,
        ageSeconds: offhostAgeSec,
        latestFile: offhostReceipt?.latest_file || null,
        reportStatus: offhostReport?.status || null,
        reportFailedAt: offhostReport?.failedAt || null,
      },
      parquet,
      staleHeartbeats,
      sequenceCounters,
      errorCounters,
    },
  };
}

module.exports = {
  DEFAULT_MIN_HOURS,
  DEFAULT_PARQUET_MAX_AGE_SEC,
  DEFAULT_PARQUET_MIN_HOURS,
  DEFAULT_PARQUET_MIN_VERIFIED_BATCHES,
  REQUIRED_FAST_COMPONENTS,
  REQUIRED_SLOW_COMPONENTS,
  ageSeconds,
  assessParquetLake,
  assessEvidenceEpoch,
  archiveReportFailure,
  findCounters,
  isAtOrAfter,
  isErrorCounter,
  isGapCounter,
  latestContinuousHealthySuffix,
  readReceipt,
};
