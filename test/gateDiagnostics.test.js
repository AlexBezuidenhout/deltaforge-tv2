'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const GateDiagnostics = require('../borg/shadow/gate-diagnostics');

test('gate diagnostics attribute every evaluated predicate without changing actions', () => {
  const gates = new GateDiagnostics('quiet_strategy');
  const at = Date.parse('2026-07-27T02:00:00.000Z');

  gates.begin();
  assert.deepEqual(gates.reject('outside_tte_window', at), []);
  gates.begin();
  gates.reject('outside_tte_window', at + 1);
  gates.begin();
  gates.reject('missing_market', at + 2);
  gates.begin();
  const action = { action: 'place', token: 'UP' };
  assert.deepEqual(gates.accept([action], at + 3), [action]);

  const snapshot = gates.snapshot();
  assert.equal(snapshot.evaluations, 4);
  assert.equal(snapshot.rejectedEvaluations, 3);
  assert.equal(snapshot.actionEvaluations, 1);
  assert.equal(snapshot.actions, 1);
  assert.deepEqual(snapshot.rejectionCounts, {
    outside_tte_window: 2,
    missing_market: 1,
  });
  assert.deepEqual(snapshot.topRejection, {
    reason: 'outside_tte_window',
    count: 2,
    share: 2 / 3,
  });
  assert.equal(snapshot.lastRejection.reason, 'missing_market');
  assert.equal(snapshot.lastActionAt, new Date(at + 3).toISOString());
});

test('empty action builder results are attributed as rejections', () => {
  const gates = new GateDiagnostics('empty_builder');
  gates.begin();
  assert.deepEqual(gates.accept([], 0), []);
  const snapshot = gates.snapshot();
  assert.equal(snapshot.actionEvaluations, 0);
  assert.equal(snapshot.rejectionCounts.empty_action_builder_result, 1);
});
