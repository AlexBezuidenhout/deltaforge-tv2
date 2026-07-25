'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const makeStrategies = require('../borg/shadow/strategies');
const {
  ExperimentRegistry,
  readExperimentManifests,
} = require('../borg/research/experiment-registry');

const {
  PROMISING_FORWARD_COHORT,
  makeBaseStrategies,
  makePromisingForwardStrategies,
} = makeStrategies._forward;

test('promising forward cohort changes identity only and starts under a fresh experiment', () => {
  const sources = new Map(makeBaseStrategies().map((strategy) => [strategy.name, strategy]));
  const forward = makePromisingForwardStrategies();
  const registry = new ExperimentRegistry(readExperimentManifests());

  assert.equal(forward.length, PROMISING_FORWARD_COHORT.length);
  for (const [index, strategy] of forward.entries()) {
    const spec = PROMISING_FORWARD_COHORT[index];
    const source = sources.get(spec.source);
    assert.ok(source, spec.source);
    assert.notEqual(strategy, source);
    assert.equal(strategy.constructor, source.constructor);
    assert.equal(strategy.name, spec.name);
    assert.equal(strategy.sourceStrategy, spec.source);
    assert.equal(strategy.forwardTier, spec.tier);
    assert.deepEqual(strategy.cfg, source.cfg);
    assert.deepEqual(strategy.marketTypes, source.marketTypes);
    assert.equal(strategy.cadence, source.cadence);
    assert.equal(strategy.evaluate, source.evaluate);

    const binding = registry.resolve(spec.name);
    assert.equal(binding.experimentId, 'promising-paper-forward-2026-07-25-v1');
    assert.equal(binding.phase, 'eval');
    assert.equal(binding.arm, 'unchanged_rule');
    assert.equal(binding.minIndependentMarkets, 300);
    assert.equal(binding.minDays, 14);
  }
});

test('failed H52/H53 and H41 specifications are not in the fresh cohort', () => {
  const names = new Set(PROMISING_FORWARD_COHORT.map((row) => row.source));
  assert.equal(names.has('H52_hourly_neareven_favorite_v1'), false);
  assert.equal(names.has('H52_15m_neareven_favorite_v2'), false);
  assert.equal(names.has('H53_5m_neareven_favorite_live_v1'), false);
  assert.equal(names.has('H41_crossasset_dispersion_reversion'), false);
});
