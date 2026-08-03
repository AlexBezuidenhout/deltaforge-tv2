'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  COMMON_PROMOTION,
  SLATE,
  renderSlate,
  slateDocument,
  validateSlate,
} = require('../borg/research/edge-experiment-slate');
const { readExperimentManifests } = require('../borg/research/experiment-registry');

test('frozen incubator contains exactly ten unique paper-safe lanes', () => {
  assert.equal(validateSlate(SLATE), true);
  assert.equal(SLATE.length, 10);
  assert.equal(new Set(SLATE.map((row) => row.laneId)).size, 10);
  assert.equal(COMMON_PROMOTION.authenticatedOrdersAllowed, false);
  assert.equal(COMMON_PROMOTION.liveOrderPath, 'disabled');
});

test('only the two existing statistical controls currently emit paper intents', () => {
  const emitters = SLATE.filter((row) => /paper intents only/.test(row.entryAuthorization));
  assert.deepEqual(emitters.map((row) => row.mechanismId).sort(), ['Q02', 'R01']);
});

test('slate hash is deterministic and report states the authorization boundary', () => {
  const first = slateDocument();
  const second = slateDocument();
  assert.equal(first.manifestHash, second.manifestHash);
  assert.match(first.manifestHash, /^[a-f0-9]{64}$/);
  assert.match(renderSlate(first), /does \*\*not\*\* authorize ten trading bots/);
});

test('every frozen lane has an immutable paper-only root manifest', () => {
  const manifests = new Map(readExperimentManifests()
    .map((manifest) => [manifest.experiment_id, manifest]));
  for (const lane of SLATE) {
    const manifest = manifests.get(lane.experimentId);
    assert.ok(manifest, `${lane.experimentId} manifest is missing`);
    assert.equal(manifest.paper_only, true, lane.experimentId);
    assert.ok(manifest.live_order_path === false || manifest.live_order_path === 'disabled',
      `${lane.experimentId} live path must be disabled`);
    assert.match(manifest._hash, /^[a-f0-9]{64}$/);
  }
});
