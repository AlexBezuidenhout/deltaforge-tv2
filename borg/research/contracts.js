'use strict';

const crypto = require('crypto');

const ORDER_INTENT_VERSION = 'order-intent-v1';
const EXECUTION_MODEL_VERSION = 'borg-execution-v2';
const FEE_MODEL_VERSION = 'polymarket-crypto-v1';

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.keys(value).sort().reduce((out, key) => {
      if (value[key] !== undefined) out[key] = stableValue(value[key]);
      return out;
    }, {});
  }
  if (value instanceof Date) return value.toISOString();
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function finiteNumber(value, field, { min = -Infinity, max = Infinity, optional = false } = {}) {
  if ((value === null || value === undefined || value === '') && optional) return null;
  const parsed = parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new TypeError(`${field} must be a finite number between ${min} and ${max}`);
  }
  return parsed;
}

function isoTimestamp(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw new TypeError(`${field} must be a valid timestamp`);
  return date.toISOString();
}

function createOrderIntent(input) {
  if (!input || typeof input !== 'object') throw new TypeError('OrderIntent input is required');
  if (!input.strategy) throw new TypeError('strategy is required');
  if (!input.marketId) throw new TypeError('marketId is required');

  const action = String(input.action || 'PLACE').toUpperCase();
  if (!['PLACE', 'CANCEL'].includes(action)) throw new TypeError('action must be PLACE or CANCEL');

  const decisionAt = isoTimestamp(input.decisionAt || input.availableAt, 'decisionAt');
  const availableAt = isoTimestamp(input.availableAt || input.decisionAt, 'availableAt');
  if (new Date(availableAt).getTime() < new Date(decisionAt).getTime()) {
    throw new TypeError('availableAt cannot precede decisionAt');
  }

  const normalized = {
    contractVersion: ORDER_INTENT_VERSION,
    strategy: String(input.strategy),
    strategyVersion: String(input.strategyVersion || 'unversioned'),
    experimentId: input.experimentId ? String(input.experimentId) : null,
    manifestHash: input.manifestHash ? String(input.manifestHash) : null,
    trialFamily: input.trialFamily ? String(input.trialFamily) : null,
    arm: input.arm ? String(input.arm) : null,
    action,
    marketId: String(input.marketId),
    token: input.token === null || input.token === undefined ? null : String(input.token),
    side: input.side === null || input.side === undefined ? null : String(input.side).toUpperCase(),
    orderKind: String(input.orderKind || 'TAKER').toUpperCase(),
    price: finiteNumber(input.price, 'price', { min: 0, max: 1, optional: action === 'CANCEL' }),
    size: finiteNumber(input.size, 'size', { min: Number.EPSILON, optional: action === 'CANCEL' }),
    decisionAt,
    availableAt,
    sourceEventId: input.sourceEventId ? String(input.sourceEventId) : null,
    executionModelVersion: String(input.executionModelVersion || EXECUTION_MODEL_VERSION),
    latencyProfile: String(input.latencyProfile || 'measured_local'),
    metadata: stableValue(input.metadata || {}),
  };

  const identity = stableStringify(normalized);
  return Object.freeze({ ...normalized, intentId: input.intentId || `oi_${sha256(identity).slice(0, 32)}` });
}

module.exports = {
  ORDER_INTENT_VERSION,
  EXECUTION_MODEL_VERSION,
  FEE_MODEL_VERSION,
  stableStringify,
  sha256,
  createOrderIntent,
};
