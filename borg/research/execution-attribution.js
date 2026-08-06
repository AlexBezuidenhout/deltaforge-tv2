'use strict';

/**
 * Canonical paper-execution lifecycle attribution.
 *
 * A detected anomaly, a synchronized executable bundle, a submitted paper
 * intent, and a filled position are different evidence states. This module
 * creates content-addressed transitions without importing any venue client or
 * order method. Callers append the transition to their decision WAL before
 * asynchronously persisting it.
 */

const crypto = require('node:crypto');

const STAGES = Object.freeze([
  'DETECTED', 'SIMULTANEOUS_EXECUTABLE', 'COST_QUALIFIED', 'ORPHAN_SAFE',
  'QUALIFIED', 'PAPER_SUBMITTED', 'PARTIALLY_FILLED', 'FULLY_FILLED',
  'CANCELLED', 'ORPHANED',
]);
const STAGE_SET = new Set(STAGES);

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort()
    .map((key) => [key, canonical(value[key])]));
}

function attributionEvent(input = {}) {
  const stage = String(input.stage || '').toUpperCase();
  const experimentId = String(input.experimentId || '');
  const opportunityId = String(input.opportunityId || '');
  const observedAtMs = new Date(input.observedAt ?? Date.now()).getTime();
  if (!STAGE_SET.has(stage)) throw new Error(`unsupported execution attribution stage: ${stage}`);
  if (!experimentId || !opportunityId || !Number.isFinite(observedAtMs)) {
    throw new Error('execution attribution requires experiment, opportunity, and observed time');
  }
  const body = {
    version: 'borg-execution-attribution-v1',
    experimentId,
    opportunityId,
    instrumentGroupId: input.instrumentGroupId == null
      ? null : String(input.instrumentGroupId),
    observedAt: new Date(observedAtMs).toISOString(),
    stage,
    latencyMs: finite(input.latencyMs),
    quantity: finite(input.quantity),
    conservativePnlUsd: finite(input.conservativePnlUsd),
    dataQualityGrade: String(input.dataQualityGrade || 'F'),
    executionFidelityGrade: String(input.executionFidelityGrade || 'F'),
    paperOnly: true,
    detail: input.detail && typeof input.detail === 'object' ? input.detail : {},
  };
  const identity = {
    experimentId: body.experimentId,
    opportunityId: body.opportunityId,
    observedAt: body.observedAt,
    stage: body.stage,
    latencyMs: body.latencyMs,
    detailIdentity: input.detailIdentity ?? null,
  };
  return {
    attributionId: `xea_${crypto.createHash('sha256')
      .update(JSON.stringify(canonical(identity))).digest('hex').slice(0, 28)}`,
    ...body,
  };
}

function attributionRow(event) {
  return [
    event.attributionId, event.experimentId, event.opportunityId,
    event.instrumentGroupId, event.observedAt, event.stage, event.latencyMs,
    event.quantity, event.conservativePnlUsd, event.dataQualityGrade,
    event.executionFidelityGrade, true, JSON.stringify(event.detail || {}),
  ];
}

function structuralEvaluationStage(evaluation) {
  if (evaluation?.qualified === true) return 'QUALIFIED';
  if (evaluation?.passOrphanRisk === true && evaluation?.passCapacity === true
      && evaluation?.passFees2x === true) return 'ORPHAN_SAFE';
  if (evaluation?.passFees2x === true && evaluation?.passCapacity === true) {
    return 'COST_QUALIFIED';
  }
  if (evaluation?.passStale === true && evaluation?.passQuotes === true
      && evaluation?.passFok === true) return 'SIMULTANEOUS_EXECUTABLE';
  return 'DETECTED';
}

function passiveTransitionStage(transition, state = {}) {
  const value = String(transition || state.status || '').toUpperCase();
  if (value === 'PLACED' || value === 'RESTING') return 'PAPER_SUBMITTED';
  if (value.includes('PARTIAL')) return value.includes('ORPHAN')
    ? 'ORPHANED' : 'PARTIALLY_FILLED';
  if (value.includes('ORPHAN')) return 'ORPHANED';
  if (value.includes('FILLED') || value.includes('LOCKED')) return 'FULLY_FILLED';
  if (value.includes('CANCEL') || value.includes('EXPIRED') || value.includes('ABANDON')) {
    return 'CANCELLED';
  }
  return null;
}

module.exports = {
  STAGES,
  attributionEvent,
  attributionRow,
  passiveTransitionStage,
  structuralEvaluationStage,
};
