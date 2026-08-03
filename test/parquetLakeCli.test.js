'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { writeFailureReport } = require('../scripts/parquet-lake');

test('Parquet CLI atomically replaces a stale success report on runtime failure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parquet-cli-failure-'));
  const report = path.join(root, 'last-report.json');
  const previous = process.env.PARQUET_LAKE_REPORT;
  process.env.PARQUET_LAKE_REPORT = report;
  try {
    fs.writeFileSync(report, JSON.stringify({
      format: 'deltaforge-parquet-lake-run-v1', status: 'verified',
    }));
    writeFailureReport(Object.assign(new Error('native binding missing'), {
      code: 'MODULE_NOT_FOUND',
    }), 'compact');
    const stored = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.equal(stored.format, 'deltaforge-parquet-lake-run-v1');
    assert.equal(stored.status, 'failed');
    assert.equal(stored.command, 'compact');
    assert.equal(stored.errorCode, 'MODULE_NOT_FOUND');
    assert.match(stored.error, /native binding missing/);
    assert.match(stored.failedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(fs.readdirSync(root).some((name) => name.endsWith('.tmp')), false);
  } finally {
    if (previous == null) delete process.env.PARQUET_LAKE_REPORT;
    else process.env.PARQUET_LAKE_REPORT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
