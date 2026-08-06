'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EXECUTION_VALIDATION_FORMAT } = require('../borg/research/execution-validation');
const {
  latestCohortsByStrategy,
  matchesFrozenTrial,
  publicExecutionValidation,
  readExecutionValidationReport,
} = require('../borg/research/execution-validation-report');

test('missing execution report fails open for the read-only dashboard', async () => {
  const value = await readExecutionValidationReport({
    file: path.join(os.tmpdir(), `does-not-exist-${process.pid}.json`),
  });
  assert.equal(value.available, false);
  assert.deepEqual(value.cohorts, []);
  assert.match(value.error, /No fleet/);
});

test('valid report loads and latest exact cohort is selected per strategy', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'borg-execution-report-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'report.json');
  await fs.writeFile(file, JSON.stringify({
    format: EXECUTION_VALIDATION_FORMAT,
    generatedAt: new Date().toISOString(),
    counts: { ROBUST_POSITIVE: 1 },
    ranking: [],
    cohorts: [
      { strategy: 'H1', experimentId: 'old', latestAt: '2026-08-01T00:00:00Z', classRank: 0 },
      { strategy: 'H1', experimentId: 'new', latestAt: '2026-08-02T00:00:00Z', classRank: 2 },
      { strategy: 'H2', experimentId: 'only', latestAt: '2026-08-01T00:00:00Z', classRank: 1 },
    ],
  }));
  const report = await readExecutionValidationReport({ file, strict: true });
  assert.equal(report.available, true);
  assert.equal(latestCohortsByStrategy(report).get('H1').experimentId, 'new');
  assert.equal(matchesFrozenTrial(
    { experimentId: 'new', arm: 'baseline', phase: 'eval' },
    { experiment_id: 'new', variant: 'baseline', phase: 'eval' },
  ), true);
  assert.equal(matchesFrozenTrial(
    { experimentId: 'old', arm: 'baseline', phase: 'eval' },
    { experiment_id: 'new', variant: 'baseline', phase: 'eval' },
  ), false);
  const publicValue = publicExecutionValidation(report);
  assert.equal(publicValue.reportFile, undefined);
  assert.match(publicValue.warning, /not authenticated/i);
});

test('unsupported report format is not silently presented as evidence', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'borg-invalid-report-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'report.json');
  await fs.writeFile(file, JSON.stringify({ format: 'wrong', cohorts: [] }));
  const value = await readExecutionValidationReport({ file });
  assert.equal(value.available, false);
  assert.match(value.error, /Unsupported/);
});
