'use strict';

const fs = require('node:fs');

const DEFAULT_MIN_HOURS = 24;
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
  return /(?:sequence.?gaps?|discardedsequence|coveragegaps?)$/i.test(String(key));
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

async function assessEvidenceEpoch(pool, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const nowMs = now.getTime();
  const minHours = finite(options.minHours, DEFAULT_MIN_HOURS);
  const critical = [];
  const warnings = [];
  const { rows: runRows } = await pool.query(`
    SELECT r.run_id,r.epoch_id,r.started_at run_started_at,r.host,r.code_version,
           e.started_at epoch_started_at,e.reason,e.data_contract_version
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
    SELECT DISTINCT ON (source) source,ts,data
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

  const currentStatus = critical.length ? 'FAIL' : 'PASS';
  if (options.record === true) {
    await pool.query(`
      INSERT INTO borg_evidence_health_samples
        (epoch_id,checked_at,status,critical,warnings,metrics)
      VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb)
    `, [run.epoch_id, now, currentStatus, JSON.stringify(critical), JSON.stringify(warnings),
      JSON.stringify({ runId: run.run_id, components: Object.fromEntries(
        Object.entries(components).map(([key, row]) => [key, {
          beatAt: row.beat_at, ageSeconds: ageSeconds(row.beat_at, nowMs),
        }]),
      ), disk, sequenceCounters, errorCounters })]);
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
  const burnInComplete = epochAgeHours >= minHours;
  const promotionEligible = currentStatus === 'PASS' && burnInComplete && coverageComplete;
  const status = promotionEligible ? 'PASSED_24H_CLEAN'
    : currentStatus === 'FAIL' || (burnInComplete && !coverageComplete) ? 'FAILED'
      : 'PENDING_24H';
  if (!burnInComplete) {
    warnings.push(`${Math.max(0, minHours - epochAgeHours).toFixed(2)} clean hour(s) remain`);
  } else if (!coverageComplete) {
    critical.push('24-hour health-sample coverage is incomplete or contains a failed sample');
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
      codeVersion: run.code_version,
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
      },
      sequenceCounters,
      errorCounters,
    },
  };
}

module.exports = {
  DEFAULT_MIN_HOURS,
  REQUIRED_FAST_COMPONENTS,
  REQUIRED_SLOW_COMPONENTS,
  ageSeconds,
  assessEvidenceEpoch,
  findCounters,
  isAtOrAfter,
  isErrorCounter,
  isGapCounter,
  readReceipt,
};
