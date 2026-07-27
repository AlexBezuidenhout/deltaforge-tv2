'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RUNTIME_STALE_AFTER_SEC,
  dossierFor,
  lifecycleFor,
  premiseFor,
} = require('../borg/research/strategy-dossiers');

const NOW = Date.parse('2026-07-26T12:00:00.000Z');

test('fresh runtime is labelled TESTING rather than inferred from recent orders', () => {
  const state = lifecycleFor({
    trialStatus: 'COLLECTING',
    runtimePresent: true,
    runtimeUpdatedAt: new Date(NOW - 20_000).toISOString(),
    evaluations: 100,
    actions: 0,
  }, NOW);
  assert.equal(state.lifecycle, 'TESTING');
  assert.match(state.reason, /no qualifying order/i);
});

test('expired runtime is labelled STALE even when the trial remains collecting', () => {
  const state = lifecycleFor({
    trialStatus: 'COLLECTING',
    runtimePresent: true,
    runtimeUpdatedAt: new Date(NOW - (RUNTIME_STALE_AFTER_SEC + 1) * 1000).toISOString(),
  }, NOW);
  assert.equal(state.lifecycle, 'STALE');
  assert.equal(state.active, false);
});

test('a collecting trial absent from the active run is PAUSED', () => {
  const state = lifecycleFor({ trialStatus: 'COLLECTING', runtimePresent: false }, NOW);
  assert.equal(state.lifecycle, 'PAUSED');
});

test('governance dispositions override runtime activity and label the exact rule DEAD', () => {
  const state = lifecycleFor({
    trialStatus: 'NEGATIVE_CONTROL',
    trialStatusReason: 'Forward cohort was negative.',
    runtimePresent: true,
    runtimeUpdatedAt: new Date(NOW - 10_000).toISOString(),
  }, NOW);
  assert.equal(state.lifecycle, 'DEAD');
  assert.equal(state.reason, 'Forward cohort was negative.');
});

test('mechanism-invalid governance is terminal even if a stale runtime row exists', () => {
  const state = lifecycleFor({
    trialStatus: 'REJECTED_MECHANISM_INVALID',
    trialStatusReason: 'Source-time causality failed.',
    runtimePresent: true,
    runtimeUpdatedAt: new Date(NOW - 10_000).toISOString(),
  }, NOW);
  assert.equal(state.lifecycle, 'DEAD');
  assert.equal(state.active, false);
  assert.equal(state.reason, 'Source-time causality failed.');
});

test('LIVE is reserved for an explicit authenticated live executor', () => {
  const state = lifecycleFor({
    liveActive: true,
    runtimePresent: true,
    runtimeUpdatedAt: new Date(NOW - 10_000).toISOString(),
  }, NOW);
  assert.equal(state.lifecycle, 'LIVE');
});

test('forward successor dossier discloses identity-only redesign and source', () => {
  const dossier = dossierFor('FWD_H24_hourly_flow_breakout_v1', {
    trialStatus: 'COLLECTING',
    runtimePresent: true,
    runtimeUpdatedAt: new Date(NOW - 10_000).toISOString(),
    nowMs: NOW,
  });
  assert.equal(dossier.lifecycle, 'TESTING');
  assert.equal(dossier.sourceStrategy, 'H24_hourly_flow_breakout');
  assert.equal(dossier.recommended, true);
  assert.match(dossier.design, /thresholds.*unchanged/i);
  assert.match(dossier.priorOutcome, /original broad H24 cohort was negative/i);
});

test('every unknown strategy receives an honest fallback premise', () => {
  assert.match(premiseFor('custom_edge_v1'), /repeatable executable edge/i);
});
