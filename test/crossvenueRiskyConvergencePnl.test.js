'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyReplayRow,
  mismatchClass,
  summarize,
} = require('../scripts/crossvenue-risky-convergence-pnl');

test('hard payoff mismatches cannot be presented as comparable convergence', () => {
  assert.equal(mismatchClass(['RESOLVER_SOURCE_DIFFERS']), 'SOFT_MISMATCH_ONLY');
  assert.equal(mismatchClass([]), 'NO_RECORDED_MISMATCH');
  assert.equal(
    mismatchClass(['RESOLVER_SOURCE_DIFFERS', 'NUMERIC_OR_THRESHOLD_MISMATCH']),
    'HARD_MISMATCH',
  );
});

test('mature timeouts realize executable bid PnL while immature rows stay censored', () => {
  const mature = classifyReplayRow({
    entry_at: '2026-07-25T00:00:00Z',
    coverage_last_at: '2026-07-25T01:05:00Z',
    timeout_exit_at: '2026-07-25T01:00:01Z',
    timeout_exit_proceeds: '4.80',
    target_exit_at: null,
    target_exit_proceeds: null,
    entry_total_cost: '4.90',
    poly_entry_fee: '0.03',
    kalshi_entry_fee: '0.04',
    timeout_poly_exit_fee: '0.02',
    timeout_kalshi_exit_fee: '0.03',
    quantity: '5',
    poly_tick: '0.01',
    kalshi_tick: '0.01',
    terminal_locked_profit: '0.10',
    horizon_ms: '3600000',
    mismatch_reasons: [],
  });
  const censored = classifyReplayRow({
    entry_at: '2026-07-25T00:00:00Z',
    coverage_last_at: '2026-07-25T00:30:00Z',
    timeout_exit_at: null,
    timeout_exit_proceeds: null,
    target_exit_at: null,
    target_exit_proceeds: null,
    entry_total_cost: '4.90',
    terminal_locked_profit: '0.10',
    horizon_ms: '3600000',
    mismatch_reasons: [],
  });
  assert.equal(mature.status, 'TIMEOUT_EXIT');
  assert.ok(Math.abs(mature.pnl + 0.10) < 1e-9);
  assert.ok(Math.abs(mature.pnl2xFees + 0.22) < 1e-9);
  assert.ok(Math.abs(mature.pnl2xFeesOneTick + 0.42) < 1e-9);
  assert.equal(censored.status, 'RIGHT_CENSORED');
  assert.equal(censored.pnl, null);
});

test('summary never turns right-censored positions into profitable exits', () => {
  const rows = [
    {
      entryAt: 0, exitAt: 60_000, coverageAt: 60_000,
      entryCost: 5, pnl: 0.10, pnl2xFees: 0.08,
      pnl2xFeesOneTick: 0.04, holdMs: 60_000, status: 'TARGET_EXIT',
      match_id: 'a',
    },
    {
      entryAt: 120_000, exitAt: null, coverageAt: 130_000,
      entryCost: 5, pnl: null, pnl2xFees: null, pnl2xFeesOneTick: null,
      holdMs: null, status: 'RIGHT_CENSORED',
      match_id: 'b',
    },
  ];
  const result = summarize(rows);
  assert.equal(result.entries, 2);
  assert.equal(result.realized, 1);
  assert.equal(result.wins, 1);
  assert.equal(result.rightCensored, 1);
  assert.equal(result.pnlUsd, 0.1);
  assert.equal(result.pnl2xFeesUsd, 0.08);
  assert.equal(result.pnl2xFeesOneTickUsd, 0.04);
});

test('a vanished executable tape is scored from both settlements when available', () => {
  const settled = classifyReplayRow({
    entry_at: '2026-07-25T00:00:00Z',
    coverage_last_at: '2026-07-25T00:30:00Z',
    timeout_exit_at: null,
    timeout_exit_proceeds: null,
    target_exit_at: null,
    target_exit_proceeds: null,
    entry_total_cost: '4.80',
    poly_entry_fee: '0.04',
    kalshi_entry_fee: '0.05',
    poly_tick: '0.01',
    kalshi_tick: '0.01',
    terminal_locked_profit: '0.20',
    horizon_ms: '3600000',
    mismatch_reasons: ['NUMERIC_OR_THRESHOLD_MISMATCH'],
    direction: 'POLY_NO+KALSHI_YES',
    quantity: '5',
    poly_outcome: 'YES',
    kalshi_result: 'NO',
    poly_resolved_at: '2026-07-25T00:45:00Z',
    kalshi_settled_at: '2026-07-25T01:30:00Z',
  });
  assert.equal(settled.status, 'TERMINAL_FALLBACK');
  assert.ok(Math.abs(settled.pnl + 4.80) < 1e-9);
  assert.ok(Math.abs(settled.pnl2xFees + 4.89) < 1e-9);
  assert.ok(Math.abs(settled.pnl2xFeesOneTick + 4.99) < 1e-9);
  assert.equal(settled.exitAt, Date.parse('2026-07-25T01:30:00Z'));
});
