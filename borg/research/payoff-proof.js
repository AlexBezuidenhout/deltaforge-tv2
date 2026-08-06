'use strict';

/**
 * Deterministic payoff proofs for small binary-contract bundles.
 *
 * This module deliberately accepts typed logical relations instead of prose.
 * An LLM or human review may propose a relation, but only this finite-state
 * compiler determines which terminal states are permitted and the minimum
 * payout of a bundle. It has no database, network, wallet, or order path.
 */

const crypto = require('node:crypto');

const RELATION_TYPES = Object.freeze({
  UNCONSTRAINED_BINARY: 'UNCONSTRAINED_BINARY',
  EQUIVALENT: 'EQUIVALENT',
  IMPLIES: 'IMPLIES',
  MUTUALLY_EXCLUSIVE: 'MUTUALLY_EXCLUSIVE',
  EXACTLY_ONE: 'EXACTLY_ONE',
  EXHAUSTIVE: 'EXHAUSTIVE',
  EXPLICIT_TERMINAL_STATES: 'EXPLICIT_TERMINAL_STATES',
});

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function stateLabel(variables, state) {
  return variables.map((variable) => `${variable}=${state[variable] ? 'YES' : 'NO'}`).join('|');
}

function enumerateStates(variables) {
  if (variables.length > 12) throw new Error('generic payoff enumeration is capped at 12 predicates');
  return Array.from({ length: 2 ** variables.length }, (_, mask) => Object.fromEntries(
    variables.map((variable, index) => [variable, Boolean(mask & (1 << index))]),
  ));
}

function allowedStates(relationType, variables) {
  if (relationType === RELATION_TYPES.UNCONSTRAINED_BINARY) {
    if (variables.length !== 1) throw new Error('UNCONSTRAINED_BINARY requires exactly one predicate');
    return [{ [variables[0]]: false }, { [variables[0]]: true }];
  }
  if (relationType === RELATION_TYPES.EXACTLY_ONE) {
    if (variables.length < 2) throw new Error('EXACTLY_ONE requires at least two predicates');
    return variables.map((selected) => Object.fromEntries(
      variables.map((variable) => [variable, variable === selected]),
    ));
  }
  if (variables.length !== 2) {
    throw new Error(`${relationType} requires exactly two ordered predicates`);
  }
  const [left, right] = variables;
  return enumerateStates(variables).filter((state) => {
    if (relationType === RELATION_TYPES.EQUIVALENT) return state[left] === state[right];
    if (relationType === RELATION_TYPES.IMPLIES) return !state[left] || state[right];
    if (relationType === RELATION_TYPES.MUTUALLY_EXCLUSIVE) return !(state[left] && state[right]);
    if (relationType === RELATION_TYPES.EXHAUSTIVE) return state[left] || state[right];
    throw new Error(`unsupported payoff relation type: ${relationType}`);
  });
}

function legPayout(leg, state) {
  const truth = state[leg.predicateId];
  if (typeof truth !== 'boolean') throw new Error(`missing predicate ${leg.predicateId} in terminal state`);
  if (leg.outcome === 'YES') return truth ? 1 : 0;
  if (leg.outcome === 'NO') return truth ? 0 : 1;
  throw new Error(`unsupported binary outcome: ${leg.outcome}`);
}

function compilePayoffProof({ relationType, variables, legs }) {
  const orderedVariables = [...new Set((variables || []).map(String))];
  if (!orderedVariables.length || orderedVariables.length !== (variables || []).length) {
    throw new Error('payoff proof requires unique predicate ids');
  }
  const normalizedLegs = (legs || []).map((leg) => ({
    predicateId: String(leg.predicateId), outcome: String(leg.outcome || '').toUpperCase(),
  }));
  if (!normalizedLegs.length) throw new Error('payoff proof requires at least one leg');
  for (const leg of normalizedLegs) {
    if (!orderedVariables.includes(leg.predicateId)) {
      throw new Error(`leg predicate ${leg.predicateId} is not declared`);
    }
    if (!['YES', 'NO'].includes(leg.outcome)) throw new Error(`invalid binary outcome ${leg.outcome}`);
  }
  const states = allowedStates(relationType, orderedVariables);
  if (!states.length) throw new Error('payoff relation permits no terminal states');
  const terminalStates = states.map((state) => ({
    label: stateLabel(orderedVariables, state),
    values: state,
    payout: normalizedLegs.reduce((sum, leg) => sum + legPayout(leg, state), 0),
  }));
  const payoffVector = terminalStates.map((state) => state.payout);
  const guaranteedMinPayout = Math.min(...payoffVector);
  const proofBody = {
    version: 'binary-payoff-proof-v1', relationType,
    variables: orderedVariables, legs: normalizedLegs, terminalStates,
    payoffVector, guaranteedMinPayout,
  };
  return {
    ...proofBody,
    valid: Number.isFinite(guaranteedMinPayout),
    proofHash: crypto.createHash('sha256')
      .update(JSON.stringify(canonical(proofBody))).digest('hex'),
  };
}

/**
 * Compile a proof when venue rules include fractional settlement states (for
 * example, a 50/50 cancellation). Each predicate supplies the payout of its
 * YES and NO token in every explicitly certified terminal state. This avoids
 * forcing a non-binary settlement into a Boolean truth table.
 */
function compileExplicitPayoffProof({ variables, legs, terminalStates }) {
  const orderedVariables = [...new Set((variables || []).map(String))];
  if (!orderedVariables.length || orderedVariables.length !== (variables || []).length) {
    throw new Error('explicit payoff proof requires unique predicate ids');
  }
  const normalizedLegs = (legs || []).map((leg) => ({
    predicateId: String(leg.predicateId), outcome: String(leg.outcome || '').toUpperCase(),
  }));
  if (!normalizedLegs.length) throw new Error('explicit payoff proof requires at least one leg');
  for (const leg of normalizedLegs) {
    if (!orderedVariables.includes(leg.predicateId) || !['YES', 'NO'].includes(leg.outcome)) {
      throw new Error(`invalid explicit payoff leg ${leg.predicateId}:${leg.outcome}`);
    }
  }
  const states = (terminalStates || []).map((state, index) => {
    const label = String(state?.label || `state_${index}`);
    const outcomePayouts = {};
    for (const variable of orderedVariables) {
      const source = state?.outcomePayouts?.[variable];
      const yes = Number(source?.YES);
      const no = Number(source?.NO);
      if (!(yes >= 0 && yes <= 1) || !(no >= 0 && no <= 1) ||
          Math.abs(yes + no - 1) > 1e-9) {
        throw new Error(`invalid complementary payouts for ${variable} in ${label}`);
      }
      outcomePayouts[variable] = { YES: yes, NO: no };
    }
    const payout = normalizedLegs.reduce((sum, leg) =>
      sum + outcomePayouts[leg.predicateId][leg.outcome], 0);
    return { label, outcomePayouts, payout };
  });
  if (!states.length) throw new Error('explicit payoff proof requires terminal states');
  const payoffVector = states.map((state) => state.payout);
  const guaranteedMinPayout = Math.min(...payoffVector);
  const proofBody = {
    version: 'explicit-payoff-proof-v1',
    relationType: RELATION_TYPES.EXPLICIT_TERMINAL_STATES,
    variables: orderedVariables,
    legs: normalizedLegs,
    terminalStates: states,
    payoffVector,
    guaranteedMinPayout,
  };
  return {
    ...proofBody,
    valid: Number.isFinite(guaranteedMinPayout),
    proofHash: crypto.createHash('sha256')
      .update(JSON.stringify(canonical(proofBody))).digest('hex'),
  };
}

module.exports = { RELATION_TYPES, compileExplicitPayoffProof, compilePayoffProof };
