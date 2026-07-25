'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  evaluatePromotion,
  latencyProfileMs,
  promotionEligibleRow,
  summarizeConcentration,
  summarizeLatencyProfiles,
} = require('../borg/research/promotion-policy');

test('promotion evidence requires both data quality and execution fidelity A/B', () => {
  assert.equal(promotionEligibleRow({ data_quality_grade: 'A', execution_fidelity_grade: 'B' }), true);
  assert.equal(promotionEligibleRow({ data_quality_grade: 'A', execution_fidelity_grade: 'C' }), false);
  assert.equal(promotionEligibleRow({ data_quality_grade: 'F', execution_fidelity_grade: 'A' }), false);
});

test('latency profile parser recognizes millisecond and one-second labels', () => {
  assert.equal(latencyProfileMs({ latency_profile: 'event_order_250ms' }), 250);
  assert.equal(latencyProfileMs({ latency_profile: 'latency_1s' }), 1000);
  assert.equal(latencyProfileMs({ detail: { order_latency_ms: '500' } }), 500);
  const summary = summarizeLatencyProfiles([
    { market_id: 1, latency_profile: '100ms', pnl_2x: 1, data_quality_grade: 'A', execution_fidelity_grade: 'B' },
    { market_id: 2, latency_profile: '250ms', pnl_2x: 1, data_quality_grade: 'A', execution_fidelity_grade: 'B' },
    { market_id: 3, latency_profile: '500ms', pnl_2x: -1, data_quality_grade: 'A', execution_fidelity_grade: 'B' },
  ]);
  assert.equal(summary.pass, false);
  const lowQuality = summarizeLatencyProfiles([
    { market_id: 1, latency_ms: 100, pnl_2x: 2, data_quality_grade: 'A', execution_fidelity_grade: 'B' },
    { market_id: 2, latency_ms: 100, pnl_2x: 0, data_quality_grade: 'F', execution_fidelity_grade: 'F' },
  ], [100]);
  assert.equal(lowQuality.profiles[100].qualityCoverage, 0.5);
  assert.equal(lowQuality.pass, false);
});

test('concentration gate requires profit to survive removal of the best cluster', () => {
  const rows = [
    { market_id: 1, available_at: '2026-07-20T00:00:00Z', asset: 'btc', pnl_2x: 6 },
    { market_id: 2, available_at: '2026-07-21T00:00:00Z', asset: 'eth', pnl_2x: 5 },
  ];
  assert.equal(summarizeConcentration(rows).pass, true);
  rows[1].pnl_2x = -1;
  assert.equal(summarizeConcentration(rows).pass, false);
});

test('promotion cannot pass without the clean epoch and shared bankroll gates', () => {
  const base = {
    trialStatus: 'COLLECTING', phase: 'eval', independentMarkets: 300,
    minimumIndependentMarkets: 300, calendarDays: 14, minimumDays: 14,
    qualityCoverage: 1, pnl2x: 10, firstHalfPnl2x: 5, secondHalfPnl2x: 5,
    marketClusteredCi95: [0.01, 1], dayClusteredCi95: [0.01, 1],
    latencyProfiles: { pass: true }, concentration: { pass: true },
  };
  assert.equal(evaluatePromotion(base, {
    holmAdjustedP: 0.01,
    evidenceEpoch: { promotionEligible: false },
    shared500: { pass: true },
  }).verdict, 'EVIDENCE_EPOCH_NOT_CLEAN_24H');
  assert.equal(evaluatePromotion(base, {
    holmAdjustedP: 0.01,
    evidenceEpoch: { promotionEligible: true },
    shared500: { pass: false },
  }).pass, false);
});
