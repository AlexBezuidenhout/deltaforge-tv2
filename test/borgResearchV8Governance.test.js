'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const manifest = require('../borg/experiments/research-v8-h64-h73-paper-v1.json');
const artifact = require('../borg/research/models/h73-market-prior-calibration-2026-07-26.json');
const { buildArtifact } = require('../scripts/h73-calibration-train');
const { STRATEGIES, markdown } = require('../scripts/research-v8-report');

test('V8 manifest freezes exactly ten paper-only bindings with no live path', () => {
  assert.equal(manifest.paper_only, true);
  assert.equal(manifest.live_order_path, 'disabled');
  assert.equal(manifest.strategy_bindings.length, 10);
  assert.equal(new Set(manifest.strategy_bindings.map((row) => row.strategy)).size, 10);
  assert.deepEqual(STRATEGIES, manifest.strategy_bindings.map((row) => row.strategy));
  assert.ok(manifest.strategy_bindings.every((row) =>
    row.min_independent_markets >= 300 && row.min_days >= 14));
});

test('H73 checked-in artifact is reproducible from its sufficient statistics', () => {
  const rows = artifact.buckets.map((row) => ({
    bucket: row.bucket,
    n: row.n,
    positive_outcomes: row.positive_outcomes,
    mean_market_probability: row.mean_market_probability,
    first_market_end: artifact.selection.first_market_end,
    last_market_end: artifact.selection.last_market_end,
  }));
  const rebuilt = buildArtifact(rows, artifact.data_cutoff);
  assert.equal(rebuilt.dataset_hash, artifact.dataset_hash);
  assert.equal(rebuilt.selection.independent_markets,
    artifact.selection.independent_markets);
  assert.deepEqual(rebuilt.buckets, artifact.buckets);
  assert.equal(artifact.estimator.pnl_used_to_fit, false);
});

test('V8 report clearly labels empty forward evidence as paper-only', () => {
  const rendered = markdown({
    generatedAt: '2026-07-26T15:01:00.000Z',
    since: manifest.evidence_started_at,
    activeCount: 10,
    expectedActiveCount: 10,
    strategies: STRATEGIES.map((strategy) => ({
      strategy,
      active: true,
      evaluations: 1,
      intendedUnits: 0,
      fills: 0,
      eligibleUnits: 0,
      winningLegRate2xPct: null,
      pnl1x: 0,
      pnl2x: 0,
      firstHalfPnl2x: 0,
      secondHalfPnl2x: 0,
    })),
    interpretation: ['No profitability verdict.'],
  });
  assert.match(rendered, /paper only; live order path disabled/i);
  assert.match(rendered, /No profitability verdict/);
});
