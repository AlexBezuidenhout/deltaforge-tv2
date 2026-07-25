#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const { readExperimentManifests } = require('../borg/research/experiment-registry');

const REQUIRED_WAL_SOURCES = [
  'binance', 'coinbase', 'hyperliquid', 'polymarket-clob',
  'polymarket-rtds-chainlink', 'research-control',
];
const DEEP_CONTRACT_SCAN = process.argv.includes('--deep');
const CONTRACT_SAMPLE_LIMIT = DEEP_CONTRACT_SCAN ? 2147483647 : 100000;

function ageSeconds(value) {
  return value ? Math.max(0, (Date.now() - new Date(value).getTime()) / 1000) : null;
}

function finite(value, fallback = null) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function newestMtime(root) {
  if (!fs.existsSync(root)) return null;
  let newest = null;
  const visit = (directory, depth) => {
    if (depth > 4) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target, depth + 1);
      else {
        const mtime = fs.statSync(target).mtime;
        if (!newest || mtime > newest) newest = mtime;
      }
    }
  };
  visit(root, 0);
  return newest;
}

function inspectLocalWal(root) {
  const latest = newestMtime(root);
  const sources = {};
  for (const source of REQUIRED_WAL_SOURCES) {
    const sourceLatest = newestMtime(path.join(root, source));
    sources[source] = { latest: sourceLatest, ageSeconds: ageSeconds(sourceLatest) };
  }
  let disk = null;
  if (fs.existsSync(root)) {
    const stat = fs.statfsSync(root);
    disk = {
      freeGb: +(Number(stat.bavail) * Number(stat.bsize) / 1024 ** 3).toFixed(2),
      totalGb: +(Number(stat.blocks) * Number(stat.bsize) / 1024 ** 3).toFixed(2),
      requiredReserveGb: Number(process.env.BORG_WAL_MIN_FREE_GB || 10),
    };
  }
  return { enabled: true, root, latest, ageSeconds: ageSeconds(latest), sources, disk };
}

function defaultWalRoot() {
  if (process.env.BORG_WAL_DIR) return process.env.BORG_WAL_DIR;
  const systemRoot = '/var/lib/deltaforge/wal/borg';
  if (fs.existsSync(systemRoot)) return systemRoot;
  return path.join(os.homedir(), '.deltaforge-wal', 'borg');
}

function defaultArchiveRoot() {
  if (process.env.BORG_ARCHIVE_DIR) return process.env.BORG_ARCHIVE_DIR;
  const systemRoot = '/var/lib/deltaforge/archive/borg-raw';
  if (fs.existsSync(systemRoot)) return systemRoot;
  return path.join(os.homedir(), '.deltaforge-archive', 'borg-raw');
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

function evaluateWalHealth(snapshot, critical, warnings) {
  if (!snapshot || snapshot.enabled === false) {
    critical.push('active collector has no raw WAL health attestation');
    return;
  }
  if (snapshot.checkedAt && ageSeconds(snapshot.checkedAt) > 130) {
    critical.push(`collector WAL attestation is ${Math.round(ageSeconds(snapshot.checkedAt))}s old`);
  }
  const sources = snapshot.sources || {};
  for (const source of REQUIRED_WAL_SOURCES) {
    const record = sources[source];
    if (!record) {
      critical.push(`raw WAL source missing: ${source}`);
      continue;
    }
    const latest = record.lastAppendAt || record.latest || null;
    const age = record.ageSeconds ?? ageSeconds(latest);
    if (!latest) critical.push(`raw WAL source has no append evidence: ${source}`);
    else if (source !== 'research-control' && age > 90) {
      critical.push(`raw WAL source ${source} is ${Math.round(age)}s old`);
    }
  }
  const sourceDisk = Object.values(sources).find((source) => Number.isFinite(Number(source.freeGb)));
  const disk = snapshot.disk || (sourceDisk ? {
    freeGb: Number(sourceDisk.freeGb),
    requiredReserveGb: Number(sourceDisk.requiredReserveGb),
  } : null);
  if (!disk) critical.push('active collector WAL disk reserve is unknown');
  else if (disk.freeGb < disk.requiredReserveGb) critical.push('WAL disk reserve breached');
  else if (disk.freeGb < disk.requiredReserveGb + 10) {
    warnings.push(`WAL disk has only ${(disk.freeGb - disk.requiredReserveGb).toFixed(1)} GiB above its hard reserve`);
  }
  if (snapshot.ageSeconds > 60) warnings.push(`raw WAL newest file is ${Math.round(snapshot.ageSeconds)}s old`);
}

function defaultReceiptPath() {
  const candidates = [
    process.env.BORG_OFFHOST_ARCHIVE_RECEIPT,
    path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs',
      'DeltaForge', 'Dublin-VPS', 'LAST_SUCCESS.txt'),
    '/var/lib/deltaforge/offhost-archive.receipt',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate))
    || process.env.BORG_OFFHOST_ARCHIVE_RECEIPT
    || null;
}

async function main() {
  const critical = [];
  const warnings = [];
  const checks = {};

  try {
    const manifests = readExperimentManifests();
    const ids = manifests.map((manifest) => manifest.experiment_id);
    if (new Set(ids).size !== ids.length) critical.push('duplicate experiment_id in frozen manifests');
    checks.manifests = { count: manifests.length, unique: new Set(ids).size === ids.length };
  } catch (error) {
    critical.push(`manifest validation failed: ${error.message}`);
  }

  const walRoot = defaultWalRoot();
  const localWal = inspectLocalWal(walRoot);
  checks.localWal = localWal;

  const mirror = process.env.BORG_WAL_MIRROR_DIR || null;
  const mirrorLatest = mirror ? newestMtime(mirror) : null;
  checks.offHostMirror = { configured: !!mirror, root: mirror, latest: mirrorLatest, ageSeconds: ageSeconds(mirrorLatest) };
  if (mirror && !mirrorLatest) warnings.push(`off-host WAL mirror has no files at ${mirror}`);

  // A Mac/iCloud pull cannot be mounted safely into the collector's hot path.
  // It instead uploads an append-only receipt after rsync succeeds. Treat the
  // receipt as a separate durability mechanism and require it to stay fresh.
  const receipt = defaultReceiptPath();
  const receiptMtime = receipt && fs.existsSync(receipt) ? fs.statSync(receipt).mtime : null;
  checks.offHostArchiveReceipt = {
    configured: !!receipt,
    file: receipt,
    latest: receiptMtime,
    ageSeconds: ageSeconds(receiptMtime),
  };
  const maxReceiptAgeSec = finite(process.env.DELTAFORGE_MAX_RECEIPT_AGE_SEC, 10800);
  if (!mirror && !receipt) {
    warnings.push('no direct WAL mirror or off-host archive receipt is configured');
  } else if (!mirror && !receiptMtime) {
    warnings.push(`off-host archive receipt is missing at ${receipt}`);
  } else if (!mirror && ageSeconds(receiptMtime) > maxReceiptAgeSec) {
    critical.push(`off-host archive receipt is ${Math.round(ageSeconds(receiptMtime) / 60)}m old; VPS retention is fail-closed`);
  } else if (!mirror && ageSeconds(receiptMtime) > 7200) {
    warnings.push(`off-host archive receipt is ${Math.round(ageSeconds(receiptMtime) / 60)}m old`);
  }

  const archiveDir = defaultArchiveRoot();
  const archiveStateFile = path.join(archiveDir, 'archive-state.json');
  let archiveState = null;
  try { archiveState = JSON.parse(fs.readFileSync(archiveStateFile, 'utf8')); } catch (_) {}
  const archiveStateMtime = fs.existsSync(archiveStateFile) ? fs.statSync(archiveStateFile).mtime : null;
  checks.verifiedRawArchive = {
    file: archiveStateFile, latest: archiveStateMtime, ageSeconds: ageSeconds(archiveStateMtime),
    cutoff: archiveState?.cutoff || null, errors: archiveState?.errors || null,
    results: archiveState?.results || null,
  };
  if (!archiveStateMtime || ageSeconds(archiveStateMtime) > 900) {
    critical.push('verified raw archive state is stale or missing');
  }
  if (Array.isArray(archiveState?.errors) && archiveState.errors.length) {
    critical.push(`verified raw archive reports ${archiveState.errors.length} retained table error(s)`);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 });
  try {
    // Establish the connection before measuring query RTT; including DNS,
    // TCP, TLS and SCRAM setup made a local database look tens of ms slower.
    await pool.query('SELECT 1');
    const rttSamplesMs = [];
    for (let i = 0; i < 7; i += 1) {
      const started = process.hrtime.bigint();
      await pool.query('SELECT 1');
      rttSamplesMs.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    checks.databaseRttMs = +percentile(rttSamplesMs, 0.5).toFixed(3);
    checks.databaseRtt = {
      samples: rttSamplesMs.length,
      medianMs: checks.databaseRttMs,
      p95Ms: +percentile(rttSamplesMs, 0.95).toFixed(3),
    };
    const { rows: relations } = await pool.query(`
      SELECT to_regclass('borg_experiments') experiments,
             to_regclass('borg_trial_ledger') trials,
             to_regclass('borg_shadow_orders') orders,
             to_regclass('borg_clob_touch') clob_touch,
             to_regclass('borg_collection_epochs') collection_epochs,
             to_regclass('borg_collector_runs') collector_runs,
             to_regclass('borg_strategy_runtime') strategy_runtime`);
    if (Object.values(relations[0]).some((value) => !value)) critical.push('one or more research tables are missing; run BORG migration');

    const { rows: storageRows } = await pool.query(`
      SELECT pg_database_size(current_database())::text database_bytes,
             pg_total_relation_size('borg_clob_touch')::text clob_touch_bytes,
             pg_total_relation_size('borg_shadow_orders')::text shadow_orders_bytes,
             (SELECT ts FROM borg_clob_touch ORDER BY id LIMIT 1) oldest_clob_touch,
             (SELECT ts FROM borg_clob_touch ORDER BY id DESC LIMIT 1) newest_clob_touch`);
    const storage = storageRows[0] || {};
    checks.databaseStorage = {
      databaseGb: +(finite(storage.database_bytes, 0) / 1024 ** 3).toFixed(2),
      clobTouchGb: +(finite(storage.clob_touch_bytes, 0) / 1024 ** 3).toFixed(2),
      shadowOrdersGb: +(finite(storage.shadow_orders_bytes, 0) / 1024 ** 3).toFixed(3),
      oldestClobTouch: storage.oldest_clob_touch,
      newestClobTouch: storage.newest_clob_touch,
      clobHotSpanHours: storage.oldest_clob_touch && storage.newest_clob_touch
        ? +((new Date(storage.newest_clob_touch) - new Date(storage.oldest_clob_touch)) / 3600000).toFixed(2)
        : null,
    };
    if (checks.databaseStorage.clobHotSpanHours > 30) {
      warnings.push(`CLOB SQL hot tier spans ${checks.databaseStorage.clobHotSpanHours}h; verified archive is behind its 24h target`);
    }

    const { rows: freshness } = await pool.query(`
      SELECT (SELECT ts FROM borg_book_snaps ORDER BY id DESC LIMIT 1) book,
             (SELECT max(ts) FROM borg_binance_1s) binance,
             (SELECT received_at FROM borg_rtds_ticks ORDER BY id DESC LIMIT 1) rtds,
             (SELECT ts FROM borg_clob_touch ORDER BY id DESC LIMIT 1) clob,
             (SELECT received_at FROM borg_external_book_touch ORDER BY id DESC LIMIT 1) external_book,
             (SELECT received_at FROM borg_external_trades ORDER BY id DESC LIMIT 1) external_trades,
             (SELECT ts FROM borg_events WHERE source='heartbeat' ORDER BY id DESC LIMIT 1) heartbeat`);
    checks.feedAgeSeconds = Object.fromEntries(Object.entries(freshness[0]).map(([key, value]) => [key, ageSeconds(value)]));
    for (const [source, age] of Object.entries(checks.feedAgeSeconds)) {
      if (age == null || age > 90) critical.push(`${source} feed/heartbeat is ${age == null ? 'missing' : `${Math.round(age)}s old`}`);
      // The primary collector intentionally emits its aggregate heartbeat once
      // per minute; market-data lanes are event driven. Warn at the expected
      // cadence plus jitter without weakening the shared 90-second hard fail.
      else if (age > (source === 'heartbeat' ? 75 : 30)) warnings.push(`${source} is ${Math.round(age)}s old`);
    }

    const { rows: quality } = await pool.query(`
      SELECT count(*)::int scored_48h,
             count(*) FILTER (WHERE data_quality_grade IN ('A','B'))::int quality_ab,
             count(*) FILTER (WHERE data_quality_grade='F')::int quality_f,
             count(*) FILTER (WHERE simulator_version IS NULL)::int unversioned
      FROM borg_shadow_scores WHERE scored_at >= now()-interval '48 hours'`);
    checks.scoring48h = quality[0];
    if (quality[0].scored_48h > 0 && quality[0].unversioned > 0) {
      warnings.push(`${quality[0].unversioned} recent scores predate simulator-version stamping`);
    }

    const { rows: provenance } = await pool.query(`
      WITH sample AS (
        SELECT source_ts,receive_monotonic_ns,connection_epoch,event_sequence
          FROM borg_clob_touch ORDER BY id DESC LIMIT $1
      )
      SELECT count(*)::int events_48h,
             count(*) FILTER (WHERE source_ts IS NOT NULL AND receive_monotonic_ns IS NOT NULL
                               AND connection_epoch IS NOT NULL AND event_sequence IS NOT NULL)::int complete
      FROM sample`, [CONTRACT_SAMPLE_LIMIT]);
    checks.eventProvenance48h = provenance[0];
    checks.eventProvenance48h.scan_mode = DEEP_CONTRACT_SCAN ? 'deep' : 'bounded-latest-sample';
    if (provenance[0].events_48h > 0 && provenance[0].complete / provenance[0].events_48h < 0.95) {
      warnings.push('less than 95% of recent CLOB touches have complete source/local/sequence provenance');
    }

    const { rows: currentRuns } = await pool.query(`
      SELECT r.run_id, r.epoch_id, r.started_at run_started_at, r.host, r.code_version,
             e.started_at epoch_started_at, e.location, e.data_contract_version
        FROM borg_collector_runs r
        JOIN borg_collection_epochs e ON e.epoch_id=r.epoch_id
       WHERE r.status='RUNNING' ORDER BY r.started_at DESC LIMIT 1
    `);
    const run = currentRuns[0] || null;
    checks.collection = run;
    if (!run) {
      critical.push('no active collection epoch/collector run');
    } else {
      const { rows: heartbeatRows } = await pool.query(`
        SELECT ts, data FROM borg_events
         WHERE source='heartbeat' AND data->>'collectorRunId'=$1
         ORDER BY ts DESC LIMIT 1
      `, [run.run_id]);
      const heartbeat = heartbeatRows[0] || null;
      const remoteCollector = run.host !== os.hostname();
      const collectorWal = heartbeat?.data?.wal || null;
      checks.collectorWalAttestation = {
        authority: remoteCollector ? 'collector-heartbeat' : 'local-filesystem',
        collectorHost: run.host,
        checkerHost: os.hostname(),
        remoteCollector,
        heartbeatAt: heartbeat?.ts || null,
        wal: collectorWal,
      };
      checks.wal = remoteCollector ? collectorWal : localWal;
      evaluateWalHealth(checks.wal, critical, warnings);
      const effectiveSource = checks.wal?.sources
        ? Object.values(checks.wal.sources).find((source) => Number.isFinite(Number(source.freeGb)))
        : null;
      checks.disk = remoteCollector && effectiveSource ? {
        freeGb: Number(effectiveSource.freeGb),
        requiredReserveGb: Number(effectiveSource.requiredReserveGb),
      } : localWal.disk;

      const { rows: runtime } = await pool.query(`
        SELECT count(*)::int registered,
               count(*) FILTER (WHERE evaluations > 0)::int evaluated,
               count(*) FILTER (WHERE errors > 0)::int with_errors,
               max(updated_at) updated_at
          FROM borg_strategy_runtime WHERE collector_run_id=$1
      `, [run.run_id]);
      checks.strategyRuntime = runtime[0];
      if (runtime[0].registered === 0) critical.push('collector run has no registered shadow strategies');
      if (runtime[0].with_errors > 0) critical.push(`${runtime[0].with_errors} strategies have runtime errors`);
      if (ageSeconds(runtime[0].updated_at) > 130) critical.push('strategy runtime heartbeat is stale');

      const { rows: contract } = await pool.query(`
        WITH book_sample AS (
          SELECT id FROM borg_book_snaps
           WHERE ts >= $1 ORDER BY id DESC LIMIT $4
        ), clob_sample AS (
          SELECT source_ts,receive_monotonic_ns,connection_epoch,event_sequence,wal_event_id
            FROM borg_clob_touch
           WHERE ts >= $1 ORDER BY id DESC LIMIT $4
        ), external_book_sample AS (
          SELECT source,source_ts,receive_monotonic_ns,connection_epoch,event_sequence,wal_event_id
            FROM borg_external_book_touch
           WHERE received_at >= $1 ORDER BY id DESC LIMIT $4
        ), external_trade_sample AS (
          SELECT source FROM borg_external_trades
           WHERE received_at >= $1 ORDER BY id DESC LIMIT $4
        )
        SELECT
          (SELECT array_agg(DISTINCT symbol ORDER BY symbol)
             FROM borg_binance_1s WHERE ts >= $1) bar_symbols,
          (SELECT array_agg(DISTINCT asset ORDER BY asset)
             FROM borg_coinbase_1s WHERE ts >= $1) coinbase_assets,
          (SELECT jsonb_object_agg(source, assets) FROM (
             SELECT source, array_agg(DISTINCT asset ORDER BY asset) assets
               FROM borg_rtds_ticks WHERE received_at >= $1 GROUP BY source
           ) x) rtds_assets,
          (SELECT count(*)::int FROM book_sample) book_snapshots,
          (SELECT count(*)::int FROM clob_sample) clob_touches,
          (SELECT count(*) FILTER (WHERE source_ts IS NOT NULL
                                    AND receive_monotonic_ns IS NOT NULL
                                    AND connection_epoch IS NOT NULL
                                    AND event_sequence IS NOT NULL
                                    AND wal_event_id IS NOT NULL)::int
             FROM clob_sample) complete_clob_provenance,
          (SELECT jsonb_object_agg(source, n) FROM (
             SELECT source, count(*)::int n FROM external_book_sample GROUP BY source
           ) x) external_book_touches,
          (SELECT jsonb_object_agg(source, n) FROM (
             SELECT source, count(*)::int n FROM external_trade_sample GROUP BY source
           ) x) external_trades,
          (SELECT count(*) FILTER (WHERE source_ts IS NOT NULL
                                    AND receive_monotonic_ns IS NOT NULL
                                    AND connection_epoch IS NOT NULL
                                    AND event_sequence IS NOT NULL
                                    AND wal_event_id IS NOT NULL)::int
             FROM external_book_sample) complete_external_provenance,
          (SELECT count(*)::int FROM external_book_sample) all_external_touches,
          (SELECT count(*)::int FROM borg_shadow_orders
             WHERE ts >= $3 AND features->>'collection_epoch_id'=$2) epoch_stamped_orders,
          (SELECT count(*)::int FROM borg_shadow_orders WHERE ts >= $3) all_orders
      `, [run.epoch_started_at, run.epoch_id, run.run_started_at, CONTRACT_SAMPLE_LIMIT]);
      const c = contract[0];
      const provenanceRatio = c.clob_touches > 0 ? c.complete_clob_provenance / c.clob_touches : 0;
      checks.currentEpochDataContract = {
        ...c,
        scanMode: DEEP_CONTRACT_SCAN ? 'deep' : 'bounded-latest-sample',
        sampleLimit: CONTRACT_SAMPLE_LIMIT,
        clobProvenanceRatio: +provenanceRatio.toFixed(6),
        requiredReplayFields: [
          'source_timestamp', 'receive_wall_timestamp', 'receive_monotonic_timestamp',
          'sequence_id', 'connection_epoch', 'WAL_event_id', 'collection_epoch_id',
          'collector_run_id', 'full_CLOB_depth', 'external_venue_ticks',
          'Chainlink_resolver_ticks', 'market_metadata', 'terminal_outcome',
          'order_intent', 'queue_ahead', 'fee_model', 'latency_profile',
        ],
      };
      if (c.book_snapshots === 0 || c.clob_touches === 0) critical.push('current epoch has no book snapshots or CLOB touches');
      if (c.clob_touches > 0 && provenanceRatio < 0.99) critical.push('current-epoch CLOB provenance is below 99%');
      if (c.all_external_touches === 0) critical.push('current epoch has no executable external-venue book touches');
      if (c.all_external_touches > 0 && c.complete_external_provenance / c.all_external_touches < 0.99) {
        critical.push('current-epoch external-book provenance is below 99%');
      }
      if (c.all_orders > 0 && c.epoch_stamped_orders !== c.all_orders) {
        critical.push('one or more current-epoch shadow orders lack epoch attribution');
      }
    }

    const { rows: experiments } = await pool.query('SELECT count(*)::int n FROM borg_experiments');
    const { rows: trials } = await pool.query('SELECT count(*)::int n FROM borg_trial_ledger');
    checks.registry = { experiments: experiments[0].n, trials: trials[0].n };
  } catch (error) {
    critical.push(`database acceptance checks failed: ${error.message}`);
  } finally {
    await pool.end();
  }

  const status = critical.length ? 'FAIL' : warnings.length ? 'DEGRADED' : 'PASS';
  console.log(JSON.stringify({
    format: 'borg-platform-acceptance-v1', checkedAt: new Date().toISOString(), status,
    acceptanceWindow: '48h rolling diagnostics; strategy evidence still follows each frozen manifest minimum',
    checks, critical, warnings,
  }, null, 2));
  if (critical.length || (process.argv.includes('--strict') && warnings.length)) process.exitCode = 1;
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message); process.exit(1);
});
