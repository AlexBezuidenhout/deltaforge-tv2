'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { maxDrawdown, rollingMinimum, summarizeCarry } = require('../scripts/funding-carry-backtest');

test('funding carry charges both spot and perp round trips and parses decimal strings', () => {
  const rows = [
    { time: Date.parse('2026-07-01T00:00:00Z'), fundingRate: '0.001' },
    { time: Date.parse('2026-07-02T00:00:00Z'), fundingRate: '-0.0002' },
  ];
  const summary = summarizeCarry(rows, {
    capitalUsd: 1000,
    notionalFraction: 0.5,
    spotTakerBps: 10,
    perpTakerBps: 5,
    slippageBpsPerLeg: 2,
    basisStressBps: 10,
  });
  assert.ok(Math.abs(summary.grossFundingPnl - 0.4) < 1e-12);
  assert.ok(Math.abs(summary.estimatedRoundTripCost - 1.9) < 1e-12);
  assert.ok(summary.netAfterStress < summary.netAfterEstimatedCosts);
});

test('drawdown and rolling loss calculations preserve adverse funding regimes', () => {
  assert.equal(maxDrawdown([2, -1, -4, 1]), -5);
  assert.equal(rollingMinimum([2, -1, -4, 1], 2), -5);
});
