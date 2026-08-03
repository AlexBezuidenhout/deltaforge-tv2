'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { summarizePassive } = require('../scripts/ordered-strike-report');
const {
  ORDERED_STRIKE_EXPERIMENT_ID,
  STRUCTURAL_BASE_EXPERIMENT_ID,
  structuralExperimentId,
} = require('../borg/structural/experiment');
const { ExperimentRegistry, readExperimentManifests } =
  require('../borg/research/experiment-registry');

test('only ordered crypto strikes receive the fresh experiment identity', () => {
  assert.equal(structuralExperimentId('nested_threshold'), ORDERED_STRIKE_EXPERIMENT_ID);
  assert.equal(structuralExperimentId('sports_total_ladder'), STRUCTURAL_BASE_EXPERIMENT_ID);
  assert.equal(structuralExperimentId('binary_complement'), STRUCTURAL_BASE_EXPERIMENT_ID);
});

test('ordered-strike report parses PostgreSQL numeric strings and keeps halves explicit', () => {
  const rows = [
    { candidate_id: 'a', quoted_at: '2026-08-04T00:00:00Z', filled_at: 'x',
      closed_at: 'x', status: 'FILLED_HEDGED_POSITIVE', locked_pnl_2x_usd: '1.25' },
    { candidate_id: 'b', quoted_at: '2026-08-05T00:00:00Z', filled_at: 'x',
      closed_at: 'x', status: 'FILLED_HEDGED_NEGATIVE', locked_pnl_2x_usd: '-0.50' },
  ];
  const summary = summarizePassive(rows);
  assert.equal(summary.pnl2xUsd, 0.75);
  assert.equal(summary.firstHalfPnl2xUsd, 1.25);
  assert.equal(summary.secondHalfPnl2xUsd, -0.50);
  assert.equal(summary.independentCandidates, 2);
  assert.equal(summary.calendarDays, 2);
});

test('ordered-strike successor is frozen paper-only for 300 independent units', () => {
  const registry = new ExperimentRegistry(readExperimentManifests());
  const binding = registry.resolve('structural_ordered_strike_orphan_safe_v1');
  assert.equal(binding.experimentId, ORDERED_STRIKE_EXPERIMENT_ID);
  assert.equal(binding.phase, 'eval');
  assert.equal(binding.minIndependentMarkets, 300);
  assert.equal(binding.minDays, 30);
});
