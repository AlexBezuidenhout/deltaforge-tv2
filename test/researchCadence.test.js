'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizedOptionCounts, optionsSummary,
} = require('../scripts/research-cadence-report');

test('options cadence reads the real shadow-mark table and gates on exact executable A/B marks', async () => {
  const seen = [];
  const db = { query: async (sql, params) => {
    seen.push({ sql, params });
    if (sql.includes('system_heartbeats')) return { rows: [{ meta: {} }] };
    return { rows: [{
      marks_6h: '10', marks_24h: '20', exact_marks_24h: '3',
      exact_ab_marks_24h: '2', exact_executable_ab_marks_24h: '1',
      executable_marks_24h: '4',
    }] };
  } };
  const report = await optionsSummary(db);
  assert.match(seen[1].sql, /FROM borg_option_shadow_marks/);
  assert.doesNotMatch(seen[1].sql, /borg_option_binary_marks/);
  assert.equal(seen[1].params.length, 1);
  assert.equal(report.successorEvidencePresent, true);
  assert.equal(report.observed.exactExecutableAbMarks24h, 1);
});

test('PostgreSQL option counts are normalized before reporting', () => {
  assert.deepEqual(normalizedOptionCounts({ marks_6h: '2', marks_24h: '7' }), {
    marks6h: 2, marks24h: 7, exactMarks24h: 0, exactAbMarks24h: 0,
    exactExecutableAbMarks24h: 0, executableMarks24h: 0, latest: null,
  });
});

test('six-hour cadence unit is read-only research tooling and never invokes a live executor', () => {
  const root = path.join(__dirname, '..', 'deploy');
  const service = fs.readFileSync(path.join(root, 'deltaforge-research-cadence.service'), 'utf8');
  const timer = fs.readFileSync(path.join(root, 'deltaforge-research-cadence.timer'), 'utf8');
  assert.match(service, /WorkingDirectory=\/var\/lib\/deltaforge\/research-tools\/current/);
  assert.match(service, /options-exact-expiry-coverage\.js --persist/);
  assert.match(service, /research-cadence-report\.js --persist/);
  assert.doesNotMatch(service, /live\/|createAndPostOrder|src\/index\.js/);
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts',
    'research-cadence-report.js'), 'utf8');
  assert.match(script, /createResearchPool/);
  assert.match(timer, /OnCalendar=.*00,06,12,18/);
  assert.match(timer, /Persistent=true/);
});
