'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  alignDifferentials,
  backtestDifferential,
  executionCostRate,
} = require('../scripts/cross-venue-funding-backtest');

const assumptions = {
  capitalUsd: 1000,
  notionalFraction: 0.5,
  lookbackPeriods: 3,
  binanceTakerBps: 5,
  hyperliquidTakerBps: 4.5,
  slippageBpsPerVenue: 2,
  basisStressBpsPerRegime: 20,
};

test('alignment compares one Binance interval with only causal Hyperliquid payments', () => {
  const hour = 3600000;
  const binance = [
    { time: 0, fundingRate: 0 },
    { time: 8 * hour, fundingRate: 0.001 },
    { time: 16 * hour, fundingRate: 0.002 },
  ];
  const hyperliquid = Array.from({ length: 16 }, (_, index) => ({
    time: (index + 1) * hour,
    fundingRate: 0.00001,
  }));
  const rows = alignDifferentials(binance, hyperliquid);
  assert.equal(rows.length, 2);
  assert.ok(Math.abs(rows[0].differential - 0.00092) < 1e-12);
});

test('stress costs exceed ordinary costs and walk-forward direction uses prior rows', () => {
  assert.ok(executionCostRate(assumptions, 2, true) > executionCostRate(assumptions, 2, false));
  const periods = Array.from({ length: 10 }, (_, index) => ({
    time: index * 8 * 3600000,
    day: `2026-07-${String(index + 1).padStart(2, '0')}`,
    differential: index < 5 ? 0.001 : -0.001,
  }));
  const result = backtestDifferential(periods, assumptions);
  assert.equal(result.walkForward.periods, 7);
  assert.ok(result.walkForward.regimes >= 2);
});
