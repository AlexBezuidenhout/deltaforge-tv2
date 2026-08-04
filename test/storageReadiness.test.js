'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStorageReadiness } = require('../borg/research/storage-readiness');

test('storage report separates continuous backlog from retained bronze and flags shared OAuth', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-ready-'));
  const archive = path.join(root, 'archive.json');
  const parquet = path.join(root, 'parquet.json');
  const receipt = path.join(root, 'receipt');
  const config = path.join(root, 'rclone.conf');
  fs.writeFileSync(archive, JSON.stringify({
    status: 'verified', checkedAt: '2026-08-04T00:00:00Z', receiptPublished: true,
    rawBacklog: { pendingFiles: 0, pendingBytes: 0 },
  }));
  fs.writeFileSync(parquet, JSON.stringify({ status: 'verified' }));
  fs.writeFileSync(receipt, [
    'pending_source_files=84486',
    'pending_scope_source_files=7',
  ].join('\n'));
  fs.writeFileSync(config, '[remote]\ntype = drive\nscope = drive.file\ntoken = hidden\n');
  const report = buildStorageReadiness({
    now: '2026-08-04T00:00:00Z', archiveReportFile: archive,
    parquetReportFile: parquet, parquetReceiptFile: receipt,
    rcloneConfigFile: config, rcloneRemote: 'remote',
  });
  assert.equal(report.parquet.continuousPendingFiles, 7);
  assert.equal(report.parquet.unmaterializedBronzeFiles, 84479);
  assert.equal(report.googleDriveOauth.mode, 'SHARED_RCLONE');
  assert.ok(report.warnings.some((row) => /OAuth client/.test(row)));
  fs.rmSync(root, { recursive: true, force: true });
});
