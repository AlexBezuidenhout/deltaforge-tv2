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
  assert.match(sql, /ORDER BY t\.observed_at, t\.id/);
  assert.match(sql, /LIMIT \$2/);
  assert.match(sql, /FOR UPDATE SKIP LOCKED/);
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

test('cross-venue high-rate dashboard rows use their real primary keys', () => {
  const opportunities = specs.find((entry) => entry.table === 'cv_opportunities');
  const basis = specs.find((entry) => entry.table === 'cv_basis_samples');
  assert.ok(opportunities && basis);
  assert.match(deleteSql(opportunities), /t\.opportunity_id AS row_id/);
  assert.match(deleteSql(opportunities), /t\.opportunity_id=d\.row_id/);
  assert.equal(opportunities.batchRows, 5000);
  assert.match(deleteSql(basis), /t\.sample_id AS row_id/);
  assert.equal(basis.keepHours, 24 * 30);
});

test('external and structural full-rate diagnostics are bounded replay tiers', () => {
  const books = specs.find((entry) => entry.table === 'borg_external_book_touch');
  const trades = specs.find((entry) => entry.table === 'borg_external_trades');
  const structural = specs.find((entry) => entry.table === 'borg_structural_evaluations');
  assert.ok(books && trades && structural);
  assert.equal(books.keepHours, 24);
  assert.equal(trades.keepHours, 24);
  assert.equal(structural.keepHours, 24);
  assert.doesNotMatch(deleteSql(books), /ORDER BY/);
  assert.doesNotMatch(deleteSql(trades), /ORDER BY/);
  assert.match(deleteSql(structural), /NOT \(t\.economic_candidate OR t\.qualified\)/);
});
