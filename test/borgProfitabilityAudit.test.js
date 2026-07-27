'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildReport,
  horizonMetrics,
  isCurrentTrialRow,
  summarizeArm,
} = require('../scripts/borg-profitability-audit');

function row(overrides = {}) {
  return {
    strategy: 'candidate',
    phase: 'eval',
    experiment_id: 'candidate-forward-v1',
    arm: 'baseline',
    collection_epoch_id: 'clean-v11',
    market_id: 'm1',
    available_at: '2026-07-25T11:00:00.000Z',
    filled: true,
    pnl_1x: '1.25',
    pnl_2x: '1.00',
    data_quality_grade: 'A',
    execution_fidelity_grade: 'B',
    asset: 'btc',
    ...overrides,
  };
}

test('profitability horizons use entry time and parse Postgres numeric strings', () => {
  const now = new Date('2026-07-25T12:00:00.000Z');
  const result = horizonMetrics([
    row(),
    row({ market_id: 'm2', available_at: '2026-07-24T13:00:00.000Z',
      pnl_1x: '-0.50', pnl_2x: '-0.75' }),
    row({ market_id: 'm3', available_at: '2026-07-21T12:00:00.000Z',
      pnl_1x: '100', pnl_2x: '100' }),
  ], now);
  assert.deepEqual(result['6h'], {
    fills: 1, markets: 1, pnl1x: 1.25, pnl2x: 1,
  });
  assert.deepEqual(result['24h'], {
    fills: 2, markets: 2, pnl1x: 0.75, pnl2x: 0.25,
  });
  assert.equal(result['3d'].fills, 2);
});

test('current-trial evidence cannot pool an older experiment or pre-freeze row', () => {
  const trial = {
    strategy: 'candidate',
    experiment_id: 'candidate-forward-v1',
    variant: 'baseline',
    phase: 'eval',
    evidence_started_at: '2026-07-25T10:00:00.000Z',
  };
  const epoch = {
    id: 'clean-v11',
    startedAt: '2026-07-25T10:30:00.000Z',
  };
  assert.equal(isCurrentTrialRow(row(), trial, epoch), true);
  assert.equal(isCurrentTrialRow(row({ experiment_id: 'discovery-v0' }), trial, epoch), false);
  assert.equal(isCurrentTrialRow(row({ collection_epoch_id: 'old-v10' }), trial, epoch), false);
  assert.equal(isCurrentTrialRow(row({
    available_at: '2026-07-25T10:29:59.999Z',
  }), trial, epoch), false);
});

test('report query retains the non-baseline trial variant used by cohort matching', async () => {
  const candidate = row({
    arm: 'source_ordered_market_prior_residual',
    available_at: '2026-07-25T11:30:00.000Z',
  });
  const pool = {
    async query(sql) {
      if (sql.includes('FROM borg_shadow_orders')) return { rows: [candidate] };
      if (sql.includes('count(*)::int trials')) return { rows: [{ trials: 1 }] };
      if (sql.includes('FROM borg_trial_ledger')) {
        assert.match(sql, /experiment_id,variant/);
        return { rows: [{
          strategy: 'candidate',
          phase: 'eval',
          status: 'COLLECTING',
          status_reason: null,
          experiment_id: 'candidate-forward-v1',
          variant: 'source_ordered_market_prior_residual',
          frozen_at: '2026-07-25T10:00:00.000Z',
          evidence_started_at: '2026-07-25T10:00:00.000Z',
        }] };
      }
      if (sql.includes('FROM borg_collector_runs')) {
        return { rows: [{
          id: 'clean-v11',
          started_at: '2026-07-25T10:30:00.000Z',
        }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const report = await buildReport(pool, {
    now: new Date('2026-07-25T12:00:00.000Z'),
  });
  assert.equal(report.arms[0].currentTrial.eligibleFills, 1);
  assert.equal(report.arms[0].currentTrial.pnl2x, 1);
});

test('profitability summary excludes any row without joint A/B fidelity', () => {
  const result = summarizeArm([
    row(),
    row({ market_id: 'm2', pnl_1x: '20', pnl_2x: '20',
      execution_fidelity_grade: 'F' }),
  ], {
    strategy: 'candidate', phase: 'eval', status: 'COLLECTING',
  }, new Date('2026-07-25T12:00:00.000Z'));
  assert.equal(result.rawFills, 2);
  assert.equal(result.eligibleFills, 1);
  assert.equal(result.pnl1x, 1.25);
  assert.equal(result.pnl2x, 1);
  assert.equal(result.interpretation, 'CURRENT_FORWARD_LEAD_UNVALIDATED');
});
