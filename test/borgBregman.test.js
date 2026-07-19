'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  generalizedSimplexKl,
  optimizeEqualShareBundle,
  projectMarginalsFrankWolfe,
} = require('../borg/structural/bregman');

test('Frank-Wolfe projects an exactly-one quote vector onto the probability simplex', () => {
  const result = projectMarginalsFrankWolfe({
    statePayoffs: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    quotedMarginals: [0.6, 0.6, 0.2],
    tolerance: 1e-8,
  });
  assert.ok(result.converged);
  assert.ok(Math.abs(result.coherentMarginals.reduce((sum, value) => sum + value, 0) - 1) < 1e-8);
  assert.ok(result.divergence > 0);
  assert.ok(result.coherentMarginals.every((value) => value >= 0 && value <= 1));
});

test('Frank-Wolfe enforces implication marginals without assuming independence', () => {
  // A => B permits (0,0), (0,1), and (1,1), hence P(A) <= P(B).
  const result = projectMarginalsFrankWolfe({
    statePayoffs: [[0, 0], [0, 1], [1, 1]],
    quotedMarginals: [0.8, 0.3],
    tolerance: 1e-8,
  });
  assert.ok(result.converged);
  assert.ok(result.coherentMarginals[0] <= result.coherentMarginals[1] + 1e-8);
  assert.ok(result.residuals[0] > 0);
  assert.ok(result.residuals[1] < 0);
});

test('simplex KL implements the requested normalized Bregman divergence', () => {
  const value = generalizedSimplexKl([0.5, 0.5], [0.6, 0.4]);
  assert.ok(Math.abs(value - (0.5 * Math.log(5 / 6) + 0.5 * Math.log(5 / 4))) < 1e-12);
});

test('equal-share optimizer walks every leg and maximizes guaranteed depth profit', () => {
  const result = optimizeEqualShareBundle({
    legs: [
      { asks: [[0.4, 10], [0.45, 10]], bids: [[0.39, 30]], minOrderSize: 1,
        feeRate: 0, feeExponent: 1 },
      { asks: [[0.5, 5], [0.55, 20]], bids: [[0.49, 30]], minOrderSize: 1,
        feeRate: 0, feeExponent: 1 },
    ],
    guaranteedMinPayout: 1,
    budgetUsd: 20,
    feeMultiplier: 2,
  });
  assert.equal(result.shares, 10);
  assert.ok(Math.abs(result.guaranteedProfit - 0.75) < 1e-9);
  assert.equal(result.fills[1].fills.length, 2);
  assert.equal(result.orphanUnwindAvailable, true);
  assert.ok(result.worstOrphanUnwindPnl < 0);
});

test('equal-share optimizer fails closed when one leg cannot meet its venue minimum', () => {
  const result = optimizeEqualShareBundle({
    legs: [
      { asks: [[0.4, 4]], minOrderSize: 5, feeRate: 0, feeExponent: 1 },
      { asks: [[0.5, 20]], minOrderSize: 5, feeRate: 0, feeExponent: 1 },
    ],
    guaranteedMinPayout: 1,
    budgetUsd: 10,
  });
  assert.equal(result, null);
});

test('equal-share optimizer never assumes missing fee metadata means zero fees', () => {
  const result = optimizeEqualShareBundle({
    legs: [
      { asks: [[0.4, 10]], minOrderSize: 1 },
      { asks: [[0.5, 10]], minOrderSize: 1, feeRate: 0, feeExponent: 1 },
    ],
    guaranteedMinPayout: 1,
    budgetUsd: 10,
  });
  assert.equal(result, null);
});
