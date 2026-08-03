'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const makeStrategies = require('../borg/shadow/strategies');
const {
  ExperimentRegistry,
  readExperimentManifests,
} = require('../borg/research/experiment-registry');

const {
  WORTHY_FORWARD_COHORT,
  makeBaseStrategies,
  makeWorthyForwardStrategies,
} = makeStrategies._forward;

test('worthy continuations are identity-only five-minute clones with fresh bindings', () => {
  const sources = new Map(makeBaseStrategies().map((strategy) => [strategy.name, strategy]));
  const forward = makeWorthyForwardStrategies();
  const registry = new ExperimentRegistry(readExperimentManifests());

  assert.equal(forward.length, 2);
  assert.equal(forward.length, WORTHY_FORWARD_COHORT.length);
  for (const [index, strategy] of forward.entries()) {
    const spec = WORTHY_FORWARD_COHORT[index];
    const source = sources.get(spec.source);
    assert.ok(source, spec.source);
    assert.notEqual(strategy, source);
    assert.equal(strategy.constructor, source.constructor);
    assert.equal(strategy.name, spec.name);
    assert.equal(strategy.sourceStrategy, spec.source);
    assert.equal(strategy.forwardCohort, 'worthy-paper-forward-2026-08-03-v1');
    assert.deepEqual(strategy.cfg, source.cfg);
    assert.deepEqual(strategy.marketTypes, source.marketTypes);
    assert.equal(strategy.cadence, source.cadence);
    assert.equal(strategy.evaluate, source.evaluate);
    const binding = registry.resolve(spec.name);
    assert.equal(binding.experimentId, 'worthy-paper-forward-2026-08-03-v1');
    assert.equal(binding.phase, 'eval');
    assert.equal(binding.arm, 'unchanged_rule_fresh_identity');
    assert.equal(binding.minIndependentMarkets, 300);
    assert.equal(binding.minDays, 14);
  }
  const service = require('node:fs').readFileSync(
    require.resolve('../ops/vps/borg-collector.service'), 'utf8',
  );
  assert.match(service, /^Environment=BORG_CAPTURE_MARKET_TYPES=direction_5m$/m);
});

test('negative and invalidated forward rules are not smuggled into the worthy cohort', () => {
  const names = new Set(WORTHY_FORWARD_COHORT.map((row) => row.source));
  for (const excluded of [
    'H1_pair_arb_2x',
    'H15_jump_adjusted_sigma',
    'H24_hourly_flow_breakout',
    'H38_passive_flow_divergence',
    'H40_directional_entropy_breakout',
    'H44_hourly_midwindow_reversal',
    'H74_markov_regime_residual',
    'H75_4h_dynamic_liquidity_leadlag',
  ]) assert.equal(names.has(excluded), false, excluded);
});
