'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { deleteSql, RETENTION_LOCK, specs } = require('../scripts/hot-tier-prune');

test('flow trade hot-tier pruning is bounded and preserves trigger attribution', () => {
  const spec = specs.find((entry) => entry.table === 'pm_flow_trades');
  assert.ok(spec);
  assert.equal(spec.batchRows, 2000);
  const sql = deleteSql(spec);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM pm_flow_signals/);
  assert.match(sql, /ORDER BY t\.observed_at, t\.id/);
});

test('large indexed all-market touch pruning stays inside the maintenance budget', () => {
  const spec = specs.find((entry) => entry.table === 'am_book_touches');
  assert.ok(spec);
  assert.equal(spec.batchRows, 5000);
  const sql = deleteSql(spec);
  assert.match(sql, /t\.observed_at < \$1/);
  assert.match(sql, /LIMIT \$2/);
  assert.match(sql, /FOR UPDATE SKIP LOCKED/);
  assert.doesNotMatch(sql, /ORDER BY/);
});

test('archive and hot-tier workers share one retention lock', () => {
  assert.equal(RETENTION_LOCK, 'deltaforge-raw-retention-v1');
});

test('option hot tier preserves executable evidence and prunes replayable diagnostics', () => {
  const marks = specs.find((entry) => entry.table === 'borg_option_shadow_marks');
  const touches = specs.find((entry) => entry.table === 'borg_deribit_option_touch');
  assert.ok(marks && touches);
  assert.match(deleteSql(marks), /t\.executable=false/);
  assert.match(deleteSql(marks), /ORDER BY t\.observed_at, t\.id/);
  assert.match(deleteSql(touches), /ORDER BY t\.sample_at, t\.id/);
});
