'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  manifestDocument,
  main,
  parseCombinedReport,
  receiptText,
  remoteTarget,
  safeRemotePath,
  selectBatch,
  stateMatches,
  validateRcloneConfig,
  writeArchiveFailureReport,
} = require('../scripts/google-drive-archive');

test('Google Drive archive accepts only a least-privilege drive.file remote', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'df-gdrive-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, 'rclone.conf');
  fs.writeFileSync(config, [
    '[deltaforge-gdrive]',
    'type = drive',
    'scope = drive.file',
    'token = {"refresh_token":"secret"}',
  ].join('\n'));
  assert.deepEqual(validateRcloneConfig(config, 'deltaforge-gdrive'), {
    type: 'drive',
    scope: 'drive.file',
  });
  fs.writeFileSync(config, [
    '[deltaforge-gdrive]',
    'type = drive',
    'scope = drive',
    'token = {"refresh_token":"secret"}',
  ].join('\n'));
  assert.throws(() => validateRcloneConfig(config, 'deltaforge-gdrive'), /drive\.file/);
});

test('Google Drive remote paths reject traversal and colon injection', () => {
  assert.equal(
    remoteTarget('deltaforge-gdrive', 'VPS Data', 'wal'),
    'deltaforge-gdrive:VPS Data/wal',
  );
  assert.equal(safeRemotePath('/VPS Data/'), 'VPS Data');
  assert.throws(() => safeRemotePath('DeltaForge/../secret'), /unsafe/);
  assert.throws(() => remoteTarget('bad:remote', 'safe'), /must contain/);
});

test('archive batches respect file and byte ceilings while always making progress', () => {
  const records = [
    { size: 6 },
    { size: 5 },
    { size: 1 },
  ];
  assert.deepEqual(selectBatch(records, 10, 10), {
    records: [records[0]],
    bytes: 6,
  });
  assert.deepEqual(selectBatch(records, 2, 20), {
    records: [records[0], records[1]],
    bytes: 11,
  });
  assert.deepEqual(selectBatch([{ size: 50 }], 10, 10).records, [{ size: 50 }]);
});

test('combined rclone verification must account for every frozen source file', () => {
  assert.equal(parseCombinedReport('= one.gz\n= two.gz\n', 2), 2);
  assert.throws(() => parseCombinedReport('= one.gz\n+ two.gz\n', 2), /mismatch/);
  assert.throws(() => parseCombinedReport('= one.gz\n', 2), /1\/2/);
});

test('Google Drive failures atomically replace a stale successful run report', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'df-gdrive-failure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const reportFile = path.join(root, 'last-report.json');
  fs.writeFileSync(reportFile, JSON.stringify({
    format: 'deltaforge-google-drive-archive-v1', status: 'verified',
  }));
  writeArchiveFailureReport(Object.assign(new Error('rateLimitExceeded'), {
    code: 8,
  }), { GDRIVE_ARCHIVE_STATE_ROOT: root });
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  assert.equal(report.status, 'failed');
  assert.equal(report.errorCode, 8);
  assert.match(report.error, /rateLimitExceeded/);
});

test('manifests and receipts carry SHA-256 evidence and destination identity', () => {
  const destination = 'gdrive://team@leadlabs.design/VPS Data';
  const record = {
    id: 'wal:a.ndjson.gz',
    namespace: 'wal',
    relative: 'a.ndjson.gz',
    size: 12,
    mtimeMs: 1000,
  };
  const state = {
    objects: {
      [record.id]: {
        verified: true,
        destination,
        relative: record.relative,
        remotePath: 'VPS Data/wal/a.ndjson.gz',
        size: 12,
        mtimeMs: 1000,
        sha256: 'a'.repeat(64),
        verifiedAt: '2026-07-27T00:00:00.000Z',
      },
    },
  };
  assert.equal(stateMatches(state.objects[record.id], record, destination), true);
  const manifest = manifestDocument({
    cutoffMs: 1_800_000,
    destination,
    records: [record],
    state,
  });
  assert.equal(manifest.objects[0].sha256, 'a'.repeat(64));
  const receipt = receiptText({
    scope: 'raw-wal-and-db-archive',
    cutoffMs: 1_800_000,
    destination,
    account: 'team@leadlabs.design',
    latest: {
      key: state.objects[record.id].remotePath,
      size: 12,
      sha256: 'a'.repeat(64),
    },
    manifest: {
      remotePath: 'VPS Data/manifests/run.json',
      size: 99,
      sha256: 'b'.repeat(64),
    },
  });
  assert.match(receipt, /account=team@leadlabs\.design/);
  assert.match(receipt, /remote_verification=google-drive-md5-via-rclone-check/);
  assert.match(receipt, /manifest_sha256=b{64}/);
});

test('end-to-end frozen traversal publishes distinct raw and snapshot receipts', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'df-gdrive-main-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wal = path.join(root, 'wal');
  const archive = path.join(root, 'archive');
  const snapshots = path.join(root, 'snapshots');
  const state = path.join(root, 'state');
  for (const directory of [wal, archive, snapshots, state]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const walFile = path.join(wal, 'one.ndjson.gz');
  const archiveFile = path.join(archive, 'two.ndjson.gz');
  const dump = path.join(snapshots, 'latest.dump');
  fs.writeFileSync(walFile, 'wal');
  fs.writeFileSync(archiveFile, 'archive');
  fs.writeFileSync(dump, 'snapshot');
  const dumpSha = crypto.createHash('sha256').update('snapshot').digest('hex');
  fs.writeFileSync(`${dump}.sha256`, `${dumpSha}  latest.dump\n`);
  const old = new Date(Date.now() - 10 * 60_000);
  for (const file of [walFile, archiveFile, dump, `${dump}.sha256`]) {
    fs.utimesSync(file, old, old);
  }
  const config = path.join(root, 'rclone.conf');
  fs.writeFileSync(config, [
    '[deltaforge-gdrive]',
    'type = drive',
    'scope = drive.file',
    'token = {"refresh_token":"secret"}',
  ].join('\n'));
  const rawReceipt = path.join(root, 'raw.receipt');
  const snapshotReceipt = path.join(root, 'snapshot.receipt');
  const remoteCalls = [];
  const mockRclone = async (args) => {
    remoteCalls.push(args);
    if (args[0] !== 'check') return;
    const list = args[args.indexOf('--files-from-raw') + 1];
    const combined = args[args.indexOf('--combined') + 1];
    const names = fs.readFileSync(list, 'utf8').split(/\r?\n/).filter(Boolean);
    fs.writeFileSync(combined, names.map((name) => `= ${name}`).join('\n') + '\n');
  };
  const report = await main({
    env: {
      GDRIVE_RCLONE_REMOTE: 'deltaforge-gdrive',
      GDRIVE_ACCOUNT_LABEL: 'team@leadlabs.design',
      GDRIVE_ARCHIVE_PREFIX: 'VPS Data',
      GDRIVE_RCLONE_CONFIG: config,
      GDRIVE_RCLONE_BINARY: process.execPath,
      GDRIVE_ARCHIVE_STATE_ROOT: state,
      GDRIVE_CUTOFF_SECONDS: '300',
      BORG_WAL_DIR: wal,
      BORG_ARCHIVE_DIR: archive,
      DELTAFORGE_DB_SNAPSHOT_DIR: snapshots,
      BORG_OFFHOST_ARCHIVE_RECEIPT: rawReceipt,
      BORG_OFFHOST_SNAPSHOT_RECEIPT: snapshotReceipt,
    },
    rclone: mockRclone,
  });
  assert.equal(report.receiptPublished, true);
  assert.equal(report.snapshotReceiptPublished, true);
  assert.match(fs.readFileSync(rawReceipt, 'utf8'), /\.raw\.manifest\.json/);
  assert.match(fs.readFileSync(snapshotReceipt, 'utf8'), /\.snapshot\.manifest\.json/);
  assert.notEqual(report.manifest, report.snapshotManifest);
  assert.equal(remoteCalls.filter((args) => args[0] === 'mkdir').length, 5);
  assert.equal(remoteCalls.filter((args) => args[0] === 'check').length, 5);
});
