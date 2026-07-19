'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateAttempt,
  firstSourceAttemptPerMarket,
  summarizeAttempts,
} = require('../scripts/flow-boundary-report');

function row(overrides = {}) {
  return {
    condition_id: 'm1',
    slug: 'btc-test',
    available_at: '2026-07-18T13:36:29.000Z',
    window_end: '2026-07-18T13:36:30.000Z',
    target_outcome: 'Up',
    outcome: 'UP',
    filled: true,
    markouts: {
      order_latency: {
        '250ms': {
          filled: true,
          reason: 'filled_at_causal_arrival_touch',
          fill_size: '20',
          notional: '10',
          entry_fee: '0.10',
        },
      },
    },
    ...overrides,
  };
}

test('forward cohort keeps one armed source attempt per market inside ten seconds', () => {
  const attempts = firstSourceAttemptPerMarket([
    row({ filled: false, available_at: '2026-07-18T13:36:28.000Z' }),
    row(),
    row({ available_at: '2026-07-18T13:36:29.500Z' }),
    row({ condition_id: 'm2', available_at: '2026-07-18T13:36:10.000Z' }),
  ]);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].condition_id, 'm1');
  assert.equal(attempts[0].tteSeconds, 1);
});

test('terminal forward PnL parses DECIMAL strings and doubles entry fees', () => {
  const attempt = evaluateAttempt({ ...row(), tteSeconds: 1 }, 250);
  assert.equal(attempt.filled, true);
  assert.equal(attempt.won, true);
  assert.equal(attempt.pnl_1x, 9.9);
  assert.equal(attempt.pnl_2x, 9.8);
});

test('a resolved arrival rejection contributes zero rather than disappearing', () => {
  const rejected = row({
    markouts: { order_latency: { '250ms': { filled: false, reason: 'post_boundary' } } },
  });
  const attempts = firstSourceAttemptPerMarket([rejected]);
  const summary = summarizeAttempts(attempts, 250);
  assert.equal(summary.resolvedMarkets, 1);
  assert.equal(summary.resolvedFills, 0);
  assert.equal(summary.pnl2x, 0);
  assert.equal(summary.marketClustered2x.clusters, 1);
  assert.deepEqual(summary.rejectionReasons, { post_boundary: 1 });
});
