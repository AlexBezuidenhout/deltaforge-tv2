'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EXECUTION_STATES,
  chooseOrphanAction,
  newExecutionState,
  transition,
  twoLegTransitionMatrix,
} = require('../borg/research/multileg-state-machine');

test('two-leg Markov matrix is stochastic and exposes both orphan paths', () => {
  const result = twoLegTransitionMatrix({
    fillProbabilityLeg0: 0.4, fillProbabilityLeg1: 0.25,
  });
  assert.equal(result.matrix.length, 7);
  for (const row of result.matrix) {
    assert.ok(Math.abs(row.reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
  }
  assert.ok(result.matrix[0][1] > 0);
  assert.ok(result.matrix[0][2] > 0);
  assert.ok(result.matrix[0][3] > 0);
});

test('orphan policy waits only when continuation EV dominates executable unwind', () => {
  const wait = chooseOrphanAction({
    hedgeFillProbabilityNext: 0.8,
    lockedProfitIfHedged: 2,
    continuationOrphanValue: -1,
    immediateUnwindPnl: -0.5,
    conservativeTerminalPnl: -1.5,
    inventoryRiskPenalty: 0.1,
    cvar95LossUsd: 2,
    cvarLimitUsd: 5,
    remainingDecisionMs: 500,
    minimumWaitMs: 100,
  });
  assert.equal(wait.action, 'WAIT');
  const unwind = chooseOrphanAction({
    hedgeFillProbabilityNext: 0.1,
    lockedProfitIfHedged: 2,
    continuationOrphanValue: -2,
    immediateUnwindPnl: -0.4,
    conservativeTerminalPnl: -3,
    cvar95LossUsd: 10,
    cvarLimitUsd: 5,
  });
  assert.equal(unwind.action, 'UNWIND');
  assert.equal(unwind.cvarBreach, true);
});

test('state machine never labels a partial fill as aborted or hedged', () => {
  let state = newExecutionState({ intentId: 'bundle-1', legCount: 2 });
  state = transition(state, { type: 'VALIDATE', ok: true, requested: [10, 10] });
  state = transition(state, { type: 'SUBMIT' });
  state = transition(state, { type: 'FILL', legIndex: 0, quantity: 10, price: 0.4 });
  assert.equal(state.status, EXECUTION_STATES.PARTIAL);
  assert.throws(() => transition(state, { type: 'ABORT' }), /illegal transition/);
  state = transition(state, { type: 'CHOOSE_ORPHAN', action: 'UNWIND' });
  assert.equal(state.status, EXECUTION_STATES.UNWINDING);
  state = transition(state, { type: 'CLOSE' });
  assert.equal(state.status, EXECUTION_STATES.COMPLETE);
});

test('both complete fills move the bundle to hedged', () => {
  let state = newExecutionState({ intentId: 'bundle-2', legCount: 2 });
  state = transition(state, { type: 'VALIDATE', ok: true, requested: [5, 5] });
  state = transition(state, { type: 'SUBMIT' });
  state = transition(state, { type: 'FILL', legIndex: 0, quantity: 5, price: 0.45 });
  state = transition(state, { type: 'FILL', legIndex: 1, quantity: 5, price: 0.45 });
  assert.equal(state.status, EXECUTION_STATES.HEDGED);
});

test('an oversized exchange fill is capped without corrupting average price', () => {
  let state = newExecutionState({ intentId: 'overfill', legCount: 2 });
  state = transition(state, { type: 'VALIDATE', ok: true, requested: [5, 5] });
  state = transition(state, { type: 'SUBMIT' });
  state = transition(state, { type: 'FILL', legIndex: 0, quantity: 3, price: 0.4 });
  state = transition(state, { type: 'FILL', legIndex: 0, quantity: 4, price: 0.5 });
  assert.equal(state.filled[0], 5);
  assert.ok(Math.abs(state.averagePrices[0] - 0.44) < 1e-12);
});
