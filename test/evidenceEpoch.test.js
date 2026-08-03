'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  ageSeconds, assessParquetLake, findCounters, isAtOrAfter, isErrorCounter,
  isGapCounter, latestContinuousHealthySuffix, readReceipt, archiveReportFailure,
} = require('../borg/research/evidence-epoch');

test('evidence health finds nested sequence and collector error counters', () => {
  const value = {
    transport: { sequenceGaps: '2', parseErrors: 1 },
    healthy: { sequenceGaps: 0, errors: 0 },
  };
  assert.deepEqual(
    findCounters(value, (key) => /sequence.?gaps?/i.test(key)),
    [{ path: 'transport.sequenceGaps', value: 2 }],
  );
  assert.deepEqual(
    findCounters(value, (key) => /^(errors|parseerrors)$/i.test(key)),
    [{ path: 'transport.parseErrors', value: 1 }],
  );
});

test('collector-specific error and WAL failure counters fail closed', () => {
  assert.equal(isErrorCounter('kalshiErrors'), true);
  assert.equal(isErrorCounter('refreshErrors'), true);
  assert.equal(isErrorCounter('walFailures'), true);
  assert.equal(isErrorCounter('executionBarriers'), false);
  assert.equal(isErrorCounter('universeRefreshTimeouts'), false);
  assert.equal(isErrorCounter('universeRefreshFailures'), true);
});

test('feed-specific coverage and sequence gaps fail closed', () => {
  assert.equal(isGapCounter('sequenceGaps'), true);
  assert.equal(isGapCounter('discardedSequence'), true);
  assert.equal(isGapCounter('globalCoverageGaps'), true);
  assert.equal(isGapCounter('realtimeConnectionGaps'), true);
  assert.equal(isGapCounter('realtimeCoverageGaps'), true);
  assert.equal(isGapCounter('realtimeTransportReconnects'), false);
  assert.equal(isGapCounter('bookStateGaps'), true);
  assert.equal(isGapCounter('connectionGaps'), true);
  assert.equal(isGapCounter('reconfigurationGaps'), true);
  assert.equal(isGapCounter('globalBootstrapTruncations'), false);
});

test('evidence age uses explicit clock and never reports negative age', () => {
  assert.equal(ageSeconds('2026-07-21T12:00:00Z', Date.parse('2026-07-21T12:00:05Z')), 5);
  assert.equal(ageSeconds('2026-07-21T12:00:10Z', Date.parse('2026-07-21T12:00:05Z')), 0);
  assert.equal(ageSeconds(null), null);
});

test('freshness cannot reuse a heartbeat from the previous evidence epoch', () => {
  const epochStart = '2026-07-21T12:00:00Z';
  assert.equal(isAtOrAfter('2026-07-21T11:59:59.999Z', epochStart), false);
  assert.equal(isAtOrAfter(epochStart, epochStart), true);
  assert.equal(isAtOrAfter('2026-07-21T12:00:00.001Z', epochStart), true);
  assert.equal(isAtOrAfter(null, epochStart), false);
});

test('Parquet burn-in restarts at the latest failed sample or cadence gap', () => {
  const rows = [
    { checked_at: '2026-08-03T10:00:00Z', healthy: true },
    { checked_at: '2026-08-03T10:01:00Z', healthy: true },
    { checked_at: '2026-08-03T10:10:00Z', healthy: true },
    { checked_at: '2026-08-03T10:11:00Z', healthy: false },
    { checked_at: '2026-08-03T10:12:00Z', healthy: true },
    { checked_at: '2026-08-03T10:13:00Z', healthy: true },
  ];
  const suffix = latestContinuousHealthySuffix(rows, { maxGapSec: 120 });
  assert.equal(suffix.samples, 2);
  assert.equal(suffix.first_sample_at, '2026-08-03T10:12:00Z');
  assert.equal(suffix.last_sample_at, '2026-08-03T10:13:00Z');
  assert.equal(suffix.last_failed_at, '2026-08-03T10:11:00Z');
  assert.equal(suffix.last_continuity_break_at, '2026-08-03T10:11:00Z');
  assert.equal(suffix.max_gap_seconds, 60);
});

test('Parquet burn-in can recover from a cadence gap without inventing a failure', () => {
  const suffix = latestContinuousHealthySuffix([
    { checked_at: '2026-08-03T10:00:00Z', healthy: true },
    { checked_at: '2026-08-03T10:20:00Z', healthy: true },
    { checked_at: '2026-08-03T10:21:00Z', healthy: true },
  ], { maxGapSec: 120 });
  assert.equal(suffix.samples, 2);
  assert.equal(suffix.first_sample_at, '2026-08-03T10:20:00Z');
  assert.equal(suffix.last_failed_at, null);
  assert.equal(suffix.last_continuity_break_at, '2026-08-03T10:20:00Z');
  assert.equal(suffix.max_gap_seconds, 60);
});

test('off-host receipt parser preserves values containing equals signs', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-receipt-'));
  const file = path.join(dir, 'receipt');
  fs.writeFileSync(file, 'format=deltaforge-offhost-receipt-v1\ncompleted_at=2026-07-21T00:00:00Z\nlatest_file=/archive/a=b.ndjson.gz\n');
  assert.deepEqual(readReceipt(file), {
    format: 'deltaforge-offhost-receipt-v1',
    completed_at: '2026-07-21T00:00:00Z',
    latest_file: '/archive/a=b.ndjson.gz',
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a current Google Drive failure report invalidates an older success receipt', () => {
  assert.equal(archiveReportFailure({
    format: 'deltaforge-google-drive-archive-v1',
    status: 'verified',
  }), null);
  assert.match(archiveReportFailure({
    format: 'deltaforge-google-drive-archive-v1',
    status: 'failed',
    failedAt: '2026-08-03T18:49:27.000Z',
    error: 'rateLimitExceeded',
  }), /rateLimitExceeded/);
  assert.match(archiveReportFailure({
    format: 'deltaforge-google-drive-archive-v1',
  }), /verified required/);
});

test('Parquet evidence requires recurrent remotely verified queryable batches', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-parquet-health-'));
  const now = '2026-08-03T16:30:00.000Z';
  const output = (suffix) => ({
    relative: `event-envelope-v1/source=binance/date=2026-08-03/hour=16/${suffix}.parquet`,
    sha256: 'a'.repeat(64), verified: true, compression: 'ZSTD', bytes: 100, rows: 10,
  });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    format: 'deltaforge-parquet-lake-state-v1',
    sources: { one: {}, two: {} }, rejectedSources: {},
    batches: {
      first: { verified: true, verifiedAt: '2026-08-03T15:00:00.000Z', outputs: [output('a')] },
      second: { verified: true, verifiedAt: '2026-08-03T16:15:00.000Z', outputs: [output('b')] },
    },
  }));
  fs.writeFileSync(path.join(dir, 'receipt'), [
    'format=deltaforge-parquet-lake-receipt-v1',
    'completed_at=2026-08-03T16:15:00.000Z',
    'dataset=event-envelope-v1',
    'latest_batch=second',
    'compression=ZSTD',
    'remote_verification=google-drive-md5-via-rclone-check',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'last-report.json'), JSON.stringify({
    format: 'deltaforge-parquet-lake-run-v1', status: 'verified', pendingSourceFiles: 12,
  }));
  fs.utimesSync(path.join(dir, 'last-report.json'), new Date(now), new Date(now));
  const report = assessParquetLake({
    now,
    stateFile: path.join(dir, 'state.json'),
    receiptFile: path.join(dir, 'receipt'),
    reportFile: path.join(dir, 'last-report.json'),
  });
  assert.equal(report.healthy, true);
  assert.equal(report.verifiedBatches, 2);
  assert.equal(report.sourceFiles, 2);
  assert.equal(report.rows, 20);
  assert.equal(report.latestBatch, 'second');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Parquet evidence fails closed on quarantine, stale receipt and invalid outputs', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-parquet-health-bad-'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    format: 'deltaforge-parquet-lake-state-v1', sources: { one: {} },
    rejectedSources: { bad: {} }, batches: {
      first: { verified: true, verifiedAt: '2026-08-03T12:00:00.000Z', outputs: [{
        relative: 'event-envelope-v1/source=x/date=2026-08-03/hour=12/bad.parquet',
        sha256: 'bad', verified: true, compression: 'SNAPPY', bytes: 1, rows: 0,
      }] },
    },
  }));
  fs.writeFileSync(path.join(dir, 'receipt'), [
    'format=deltaforge-parquet-lake-receipt-v1',
    'completed_at=2026-08-03T12:00:00.000Z',
    'dataset=event-envelope-v1',
    'latest_batch=first',
    'compression=ZSTD',
    'remote_verification=google-drive-md5-via-rclone-check',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'last-report.json'), JSON.stringify({
    format: 'deltaforge-parquet-lake-run-v1', status: 'source_rejections_only',
  }));
  fs.utimesSync(path.join(dir, 'last-report.json'),
    new Date('2026-08-03T12:00:00.000Z'), new Date('2026-08-03T12:00:00.000Z'));
  const report = assessParquetLake({
    now: '2026-08-03T16:30:00.000Z', maxAgeSec: 3600,
    stateFile: path.join(dir, 'state.json'),
    receiptFile: path.join(dir, 'receipt'),
    reportFile: path.join(dir, 'last-report.json'),
  });
  assert.equal(report.healthy, false);
  assert.match(report.critical.join(' | '), /recurrence/);
  assert.match(report.critical.join(' | '), /quarantined/);
  assert.match(report.critical.join(' | '), /checksum\/ZSTD\/row/);
  assert.match(report.critical.join(' | '), /receipt is 16200s old/);
  assert.match(report.critical.join(' | '), /source_rejections_only/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('epoch launcher seeds the raw archive before starting high-rate collectors', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const launcher = fs.readFileSync(path.join(__dirname, '..', 'ops', 'vps',
    'start-evidence-epoch.sh'), 'utf8');
  const archiveSeed = launcher.indexOf('systemctl start deltaforge-raw-archive.service');
  const collectorStart = launcher.indexOf('systemctl start \\\n  deltaforge-tv2.service');
  assert.ok(archiveSeed >= 0, 'raw archive seed is present');
  assert.ok(collectorStart >= 0, 'collector start block is present');
  assert.ok(archiveSeed < collectorStart, 'archive seed precedes the hot writers');
  assert.match(launcher,
    /systemctl stop \\\n+  deltaforge-google-drive-archive\.timer \\\n+  deltaforge-parquet-lake\.timer/);
  assert.match(launcher, /systemctl disable --now[\s\S]*eth-g-late-canary\.service/);
  assert.match(launcher, /require\.resolve\('\@duckdb\/node-api'\)/);
  assert.match(launcher, /refusing to start evidence epoch: release dependencies are incomplete/);
  assert.match(launcher, /systemctl is-failed --quiet/);
  assert.match(launcher, /systemctl is-active --quiet/);
  assert.match(launcher, /unverified maintenance report/);
  assert.match(launcher, /Freeze timer dispatch before checking the oneshot services/);
  assert.match(launcher, /trap cleanup EXIT/);
  assert.match(launcher, /restore_maintenance_timers/);
  const maintenanceRestart = launcher.lastIndexOf('deltaforge-google-drive-archive.timer \\\n  deltaforge-parquet-lake.timer');
  const warmupComplete = launcher.lastIndexOf('rm -f "${preflight_report}"');
  assert.ok(maintenanceRestart > warmupComplete,
    'off-host and Parquet maintenance restart only after collector warmup');
  assert.match(launcher,
    /A rejected epoch is still an operational collector run[\s\S]*deltaforge-evidence-health\.timer/);
  assert.match(
    launcher,
    /deployed_release="\$\(basename "\$\(readlink -f \/opt\/deltaforge\/tv2\/current\)"\)"/,
  );
  assert.match(
    launcher,
    /code_version="\$\{BORG_EPOCH_CODE_VERSION:-\$\{deployed_release\}\}"/,
  );
  assert.match(launcher, /exact-rule-structural-options-forward-after-runtime-repair/);
});

test('release dependency installer keys native modules to the immutable lockfile', () => {
  const installer = fs.readFileSync(path.join(
    __dirname, '..', 'ops', 'vps', 'install-release-deps.sh',
  ), 'utf8');
  assert.match(installer, /sha256sum "\$\{app\}\/package-lock\.json"/);
  assert.match(installer, /npm ci --omit=dev --no-audit --no-fund/);
  assert.match(installer, /require\.resolve\('\@duckdb\/node-api'\)/);
  assert.match(installer, /ln -sfn "\$\{dependency_root\}\/node_modules"/);
});

test('evidence report distinguishes the immutable release from the collector family label', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'borg', 'research',
    'evidence-epoch.js'), 'utf8');
  assert.match(source, /e\.code_version epoch_code_version/);
  assert.match(source, /r\.code_version run_code_version/);
  assert.match(source, /codeVersion: run\.epoch_code_version/);
  assert.match(source, /collectorCodeVersion: run\.run_code_version/);
  assert.match(source, /transient stale-feed heartbeat\(s\) in epoch/);
  assert.match(source, /requirementsVersion: 'evidence-health-v3-feed-gaps'/);
  assert.match(source, /primary redundant CLOB coverage is/);
  assert.match(source, /primary redundant RTDS coverage is/);
  assert.match(source, /public-flow process is warming, stale or repeatedly restarting/);
});

test('recorded failed evidence is data rather than a failed monitor process', () => {
  const cli = fs.readFileSync(path.join(
    __dirname, '..', 'scripts', 'evidence-epoch-status.js',
  ), 'utf8');
  assert.match(cli, /report\.status === 'FAILED' && !process\.argv\.includes\('--record'\)/);
});

test('partition heartbeat cadence stays inside the evidence freshness window', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const timer = fs.readFileSync(path.join(__dirname, '..', 'ops', 'vps',
    'deltaforge-hot-partitions.timer'), 'utf8');
  const cadence = timer.match(/^OnUnitActiveSec=(\d+)min$/m);
  assert.ok(cadence, 'partition timer has an explicit minute cadence');
  assert.ok(Number(cadence[1]) < 15, 'partition cadence is fresher than the 15-minute evidence limit');
});
