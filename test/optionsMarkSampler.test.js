'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { TransitionMarkSampler } = require('../borg/options/mark-sampler');

function mark(overrides = {}) {
  return {
    executable: false,
    executionBarrier: 'NO_POSITIVE_DEPTH_WALK_AFTER_2X_COSTS',
    surfaceFidelity: 'A',
    targetSurfaceMode: 'EXACT_EXPIRY',
    valuationSurfaceMode: 'EXACT_EXPIRY',
    dataQualityGrade: 'B',
    ...overrides,
  };
}

test('mark sampler stores initial state, stable transitions and bounded heartbeats', () => {
  const sampler = new TransitionMarkSampler({
    transitionDwellMs: 250,
    executableHeartbeatMs: 5000,
    diagnosticHeartbeatMs: 30000,
  });
  assert.equal(sampler.observe('1:YES', mark(), 1000).eventKind, 'INITIAL_STATE');
  assert.equal(sampler.observe('1:YES', mark(), 2000).persist, false);

  const executable = mark({ executable: true, executionBarrier: null, dataQualityGrade: 'A' });
  assert.equal(sampler.observe('1:YES', executable, 3000).reason, 'TRANSITION_DWELL');
  assert.equal(sampler.observe('1:YES', executable, 3249).persist, false);
  assert.equal(sampler.observe('1:YES', executable, 3250).eventKind, 'EXECUTABLE_ENTER');
  assert.equal(sampler.observe('1:YES', executable, 8249).persist, false);
  assert.equal(sampler.observe('1:YES', executable, 8250).eventKind, 'EXECUTABLE_HEARTBEAT');
});

test('sub-250ms executable flicker is suppressed because it cannot survive the execution profile', () => {
  const sampler = new TransitionMarkSampler({ transitionDwellMs: 250 });
  sampler.observe('1:NO', mark(), 1000);
  const executable = mark({ executable: true, executionBarrier: null, dataQualityGrade: 'A' });
  assert.equal(sampler.observe('1:NO', executable, 1100).persist, false);
  assert.equal(sampler.observe('1:NO', mark(), 1200).persist, false);
  assert.equal(sampler.states.get('1:NO').accepted.executable, false);
});

test('non-executable diagnostic surface flicker must persist for thirty seconds', () => {
  const sampler = new TransitionMarkSampler({
    transitionDwellMs: 250,
    diagnosticTransitionDwellMs: 30000,
  });
  sampler.observe('1:NO', mark(), 1000);
  const incomplete = mark({ executionBarrier: 'INCOMPLETE_BID_ASK_IV_INTERVAL' });
  assert.equal(sampler.observe('1:NO', incomplete, 2000).persist, false);
  assert.equal(sampler.observe('1:NO', incomplete, 31999).persist, false);
  assert.equal(sampler.observe('1:NO', incomplete, 32000).eventKind, 'BARRIER_TRANSITION');
});

test('sampler prunes expired targets without changing active target state', () => {
  const sampler = new TransitionMarkSampler();
  sampler.observe('1:YES', mark(), 1000);
  sampler.observe('2:YES', mark(), 1000);
  sampler.prune(['2:YES']);
  assert.equal(sampler.states.has('1:YES'), false);
  assert.equal(sampler.states.has('2:YES'), true);
  assert.equal(sampler.metrics.pruned, 1);
});
