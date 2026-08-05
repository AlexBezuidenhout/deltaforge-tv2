'use strict';

const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCoverage, STATUSES } = require('../borg/research/free-edge-test-coverage');

test('every registered mechanism has one explicit free-test disposition', () => {
  const report = buildCoverage(path.join(__dirname, '..'));
  assert.equal(report.hypothesisCount, 118);
  assert.equal(new Set(report.rows.map((row) => row.id)).size, 118);
  assert.equal(Object.values(report.statusCounts).reduce((sum, count) => sum + count, 0), 118);
  assert.equal(report.rows.filter((row) => row.status === STATUSES.PROMISING_UNVALIDATED).length, 1);
  for (const row of report.rows) {
    assert.ok(row.screen);
    assert.ok(row.evidence);
    assert.ok(row.nextAction);
  }
});
