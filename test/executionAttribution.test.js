'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  attributionEvent, passiveTransitionStage, structuralEvaluationStage,
} = require('../borg/research/execution-attribution');

test('execution evidence keeps detection, qualification and fill states distinct', () => {
  assert.equal(structuralEvaluationStage({}), 'DETECTED');
  assert.equal(structuralEvaluationStage({ passStale: true, passQuotes: true, passFok: true }),
    'SIMULTANEOUS_EXECUTABLE');
  assert.equal(structuralEvaluationStage({ passFees2x: true, passCapacity: true }),
    'COST_QUALIFIED');
  assert.equal(structuralEvaluationStage({ passFees2x: true, passCapacity: true,
    passOrphanRisk: true }), 'ORPHAN_SAFE');
  assert.equal(structuralEvaluationStage({ qualified: true }), 'QUALIFIED');
  assert.equal(passiveTransitionStage('PLACED'), 'PAPER_SUBMITTED');
  assert.equal(passiveTransitionStage('PARTIAL_FILL_HEDGED'), 'PARTIALLY_FILLED');
  assert.equal(passiveTransitionStage('CANCELLED_PARTIAL_ORPHAN'), 'ORPHANED');
});

test('attribution ids are content-addressed and always paper-only', () => {
  const input = { experimentId: 'exp', opportunityId: 'opp',
    observedAt: '2026-08-06T12:00:00Z', stage: 'DETECTED', latencyMs: '20' };
  const left = attributionEvent(input); const right = attributionEvent(input);
  assert.equal(left.attributionId, right.attributionId);
  assert.equal(left.paperOnly, true);
  assert.equal(left.latencyMs, 20);
  assert.throws(() => attributionEvent({ ...input, stage: 'LIVE_ORDER' }));
});
