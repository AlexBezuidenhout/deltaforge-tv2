'use strict';

const EXECUTION_STATES = Object.freeze({
  IDLE: 'IDLE',
  VALIDATED: 'VALIDATED',
  SUBMITTING: 'SUBMITTING',
  PARTIAL: 'PARTIAL',
  HEDGED: 'HEDGED',
  UNWINDING: 'UNWINDING',
  HELD_TO_RESOLUTION: 'HELD_TO_RESOLUTION',
  COMPLETE: 'COMPLETE',
  ABORTED: 'ABORTED',
});

const MATRIX_STATES = Object.freeze([
  'NO_FILL', 'LEG0_ONLY', 'LEG1_ONLY', 'HEDGED', 'UNWOUND', 'HELD', 'FAILED',
]);

function finite(value, fallback = null) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function probability(value) {
  return Math.max(0, Math.min(1, finite(value, 0)));
}

function row(...values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 1) > 1e-9) throw new Error(`transition row is not stochastic: ${total}`);
  return values;
}

/**
 * Two-leg discrete-time fill matrix. Fill probabilities are conditional on
 * the quotes still being live for the next decision interval. Orphan policy
 * is supplied by the dynamic program, not embedded as a fixed stop loss.
 */
function twoLegTransitionMatrix({
  fillProbabilityLeg0, fillProbabilityLeg1,
  leg0OnlyAction = 'WAIT', leg1OnlyAction = 'WAIT',
  unwindProbabilityLeg0 = 1, unwindProbabilityLeg1 = 1,
}) {
  const p0 = probability(fillProbabilityLeg0);
  const p1 = probability(fillProbabilityLeg1);
  const u0 = probability(unwindProbabilityLeg0);
  const u1 = probability(unwindProbabilityLeg1);
  const orphanRow = (action, hedgeFillProbability, unwindProbability) => {
    if (action === 'WAIT') return row(0, 1 - hedgeFillProbability, 0, hedgeFillProbability, 0, 0, 0);
    if (action === 'WAIT_LEG1') return row(0, 0, 1 - hedgeFillProbability, hedgeFillProbability, 0, 0, 0);
    if (action === 'UNWIND') return row(0, 0, 0, 0, unwindProbability, 0, 1 - unwindProbability);
    if (action === 'HOLD') return row(0, 0, 0, 0, 0, 1, 0);
    throw new Error(`unsupported orphan action ${action}`);
  };
  return {
    states: MATRIX_STATES,
    matrix: [
      row((1 - p0) * (1 - p1), p0 * (1 - p1), (1 - p0) * p1, p0 * p1, 0, 0, 0),
      orphanRow(leg0OnlyAction, p1, u0),
      orphanRow(leg1OnlyAction === 'WAIT' ? 'WAIT_LEG1' : leg1OnlyAction, p0, u1),
      row(0, 0, 0, 1, 0, 0, 0),
      row(0, 0, 0, 0, 1, 0, 0),
      row(0, 0, 0, 0, 0, 1, 0),
      row(0, 0, 0, 0, 0, 0, 1),
    ],
  };
}

function chooseOrphanAction({
  hedgeFillProbabilityNext,
  lockedProfitIfHedged,
  continuationOrphanValue,
  immediateUnwindPnl = null,
  conservativeTerminalPnl,
  inventoryRiskPenalty = 0,
  cvar95LossUsd = 0,
  cvarLimitUsd = Infinity,
  remainingDecisionMs = Infinity,
  minimumWaitMs = 0,
}) {
  const pFill = probability(hedgeFillProbabilityNext);
  const locked = finite(lockedProfitIfHedged, -Infinity);
  const continuation = finite(continuationOrphanValue, -Infinity);
  const unwind = finite(immediateUnwindPnl);
  const terminal = finite(conservativeTerminalPnl, -Infinity);
  const riskPenalty = Math.max(0, finite(inventoryRiskPenalty, 0));
  const cvar = Math.max(0, finite(cvar95LossUsd, 0));
  const cvarLimit = finite(cvarLimitUsd, Infinity);
  const enoughTime = finite(remainingDecisionMs, 0) >= Math.max(0, finite(minimumWaitMs, 0));
  const riskAdmissible = cvar <= cvarLimit;
  const values = {
    WAIT: enoughTime && riskAdmissible
      ? pFill * locked + (1 - pFill) * continuation - riskPenalty : -Infinity,
    UNWIND: unwind == null ? -Infinity : unwind,
    HOLD: riskAdmissible ? terminal - riskPenalty : -Infinity,
  };
  let action = Object.entries(values).sort((left, right) => right[1] - left[1])[0][0];
  if (!Number.isFinite(values[action])) {
    // An orphan cannot be wished away. If no executable unwind exists, the
    // only honest terminal state is hold-to-resolution with a breached risk
    // flag, not ABORTED or a zero-PnL deletion.
    action = unwind == null ? 'HOLD' : 'UNWIND';
  }
  return {
    action,
    values,
    cvarBreach: !riskAdmissible,
    forcedHold: action === 'HOLD' && !riskAdmissible,
  };
}

function newExecutionState({ intentId, legCount }) {
  const count = parseInt(legCount, 10);
  if (!intentId || !(count >= 2)) throw new Error('multi-leg state requires an id and at least two legs');
  return {
    intentId: String(intentId),
    status: EXECUTION_STATES.IDLE,
    legCount: count,
    requested: new Array(count).fill(0),
    filled: new Array(count).fill(0),
    averagePrices: new Array(count).fill(null),
    history: [],
  };
}

function transition(state, event) {
  const next = {
    ...state,
    requested: [...state.requested],
    filled: [...state.filled],
    averagePrices: [...state.averagePrices],
    history: [...state.history, { ...event }],
  };
  const type = String(event?.type || '');
  if (type === 'VALIDATE' && state.status === EXECUTION_STATES.IDLE) {
    if (event.ok !== true) next.status = EXECUTION_STATES.ABORTED;
    else {
      if (!Array.isArray(event.requested) || event.requested.length !== state.legCount) {
        throw new Error('validated request vector has wrong dimension');
      }
      next.requested = event.requested.map((value) => Math.max(0, finite(value, 0)));
      next.status = EXECUTION_STATES.VALIDATED;
    }
    return next;
  }
  if (type === 'SUBMIT' && state.status === EXECUTION_STATES.VALIDATED) {
    next.status = EXECUTION_STATES.SUBMITTING;
    return next;
  }
  if (type === 'FILL' && [EXECUTION_STATES.SUBMITTING, EXECUTION_STATES.PARTIAL].includes(state.status)) {
    const index = parseInt(event.legIndex, 10);
    const quantity = Math.max(0, finite(event.quantity, 0));
    const price = finite(event.price);
    if (!(index >= 0 && index < state.legCount) || !(quantity > 0) || !(price > 0 && price < 1)) {
      throw new Error('invalid fill event');
    }
    const priorQuantity = next.filled[index];
    const priorCost = priorQuantity * (next.averagePrices[index] || 0);
    const acceptedQuantity = Math.min(quantity, Math.max(0, next.requested[index] - priorQuantity));
    if (!(acceptedQuantity > 0)) throw new Error('fill exceeds remaining requested quantity');
    next.filled[index] = priorQuantity + acceptedQuantity;
    next.averagePrices[index] = (priorCost + acceptedQuantity * price)
      / (priorQuantity + acceptedQuantity);
    const complete = next.filled.every((value, leg) => value + 1e-9 >= next.requested[leg]);
    next.status = complete ? EXECUTION_STATES.HEDGED : EXECUTION_STATES.PARTIAL;
    return next;
  }
  if (type === 'CHOOSE_ORPHAN' && state.status === EXECUTION_STATES.PARTIAL) {
    if (event.action === 'UNWIND') next.status = EXECUTION_STATES.UNWINDING;
    else if (event.action === 'HOLD') next.status = EXECUTION_STATES.HELD_TO_RESOLUTION;
    else if (event.action !== 'WAIT') throw new Error('invalid orphan action');
    return next;
  }
  if (type === 'CLOSE' && [EXECUTION_STATES.HEDGED, EXECUTION_STATES.UNWINDING,
    EXECUTION_STATES.HELD_TO_RESOLUTION].includes(state.status)) {
    next.status = EXECUTION_STATES.COMPLETE;
    return next;
  }
  if (type === 'ABORT' && ![EXECUTION_STATES.PARTIAL, EXECUTION_STATES.HEDGED,
    EXECUTION_STATES.COMPLETE].includes(state.status)) {
    next.status = EXECUTION_STATES.ABORTED;
    return next;
  }
  throw new Error(`illegal transition ${state.status} + ${type}`);
}

module.exports = {
  EXECUTION_STATES,
  MATRIX_STATES,
  chooseOrphanAction,
  newExecutionState,
  transition,
  twoLegTransitionMatrix,
};
