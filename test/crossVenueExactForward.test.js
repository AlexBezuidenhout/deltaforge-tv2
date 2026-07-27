'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  classifyForwardRow, summarize,
} = require('../scripts/crossvenue-exact-rule-forward');

function base(overrides = {}) {
  return {
    entry_at: '2026-07-27T00:00:00Z',
    coverage_last_at: '2026-07-27T01:01:00Z',
    target_exit_at: null,
    timeout_exit_at: '2026-07-27T01:00:01Z',
    timeout_exit_proceeds: '4.90',
    timeout_poly_exit_fee: '0.02',
    timeout_kalshi_exit_fee: '0.03',
    entry_total_cost: '5.00',
    poly_entry_fee: '0.02',
    kalshi_entry_fee: '0.03',
    quantity: '5',
    poly_tick: '0.01',
    kalshi_tick: '0.01',
    match_id: 'pair',
    direction: 'POLY_YES+KALSHI_NO',
    identity_approved: false,
    ...overrides,
  };
}

test('the frozen one-hour rule realizes executable timeout loss with full stress', () => {
  const row = classifyForwardRow(base());
  assert.equal(row.status, 'TIMEOUT_EXIT');
  assert.ok(Math.abs(row.pnl + 0.10) < 1e-9);
  assert.ok(Math.abs(row.pnl2xFeesOneTick + 0.40) < 1e-9);
});

test('terminal payout is forbidden unless identity is independently certified', () => {
  const unproved = classifyForwardRow(base({
    timeout_exit_at: null,
    timeout_exit_proceeds: null,
    terminal_payout: '5',
    settled_at: '2026-07-28T00:00:00Z',
  }));
  assert.equal(unproved.status, 'NO_EXECUTABLE_TIMEOUT_EXIT');
  assert.equal(unproved.pnl, null);
  const certified = classifyForwardRow(base({
    timeout_exit_at: null,
    timeout_exit_proceeds: null,
    identity_approved: true,
    terminal_payout: '5',
    settled_at: '2026-07-28T00:00:00Z',
  }));
  assert.equal(certified.status, 'CERTIFIED_TERMINAL_FALLBACK');
  assert.equal(certified.pnl, 0);
});

test('summary counts independent pair-direction-days and censored rows honestly', () => {
  const realized = classifyForwardRow(base());
  const censored = classifyForwardRow(base({
    match_id: 'pair-2',
    coverage_last_at: '2026-07-27T00:30:00Z',
    timeout_exit_at: null,
    timeout_exit_proceeds: null,
  }));
  const result = summarize([realized, censored]);
  assert.equal(result.entries, 2);
  assert.equal(result.realized, 1);
  assert.equal(result.pairDirectionDays, 2);
  assert.equal(result.censored, 1);
  assert.equal(result.marketClusters, 1);
  assert.equal(result.dayClusters, 1);
  assert.deepEqual(result.marketClusteredMeanCi95Usd, [null, null]);
  assert.equal(result.conservativeOneSidedP, 1);
});

test('forward scoring binds certification to the entry row, not a later match update', () => {
  const source = fs.readFileSync(path.join(
    __dirname,
    '..',
    'scripts',
    'crossvenue-exact-rule-forward.js',
  ), 'utf8');
  assert.match(source, /WHEN b\.identity_approved/);
  assert.doesNotMatch(source, /m\.identity_approved/);
  assert.match(source, /b\.exact_rule_key IS NOT NULL/);
  assert.match(source, /x\.exact_rule_key=e\.entry_exact_rule_key/);
  assert.match(source, /\$2::int \* interval '1 day'/);
  assert.match(source, /\$4::bigint \* interval '1 millisecond'/);
  assert.doesNotMatch(source, /\$[24]\|\|/);
  assert.doesNotMatch(source, /m\.exact_rule_eligible/);
});
