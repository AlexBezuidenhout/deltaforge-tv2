'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ageSeconds, findCounters, isAtOrAfter, isErrorCounter, isGapCounter, readReceipt,
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

test('evidence report distinguishes the immutable release from the collector family label', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'borg', 'research',
    'evidence-epoch.js'), 'utf8');
  assert.match(source, /e\.code_version epoch_code_version/);
  assert.match(source, /r\.code_version run_code_version/);
  assert.match(source, /codeVersion: run\.epoch_code_version/);
  assert.match(source, /collectorCodeVersion: run\.run_code_version/);
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
