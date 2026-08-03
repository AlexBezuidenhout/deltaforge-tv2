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
