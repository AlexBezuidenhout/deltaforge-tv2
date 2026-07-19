'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  callSpreadProbabilityBounds,
  deltaHedgeForBinary,
  digitalCashFair,
  interpolateSurfaceVariance,
  optimizeBinaryEntry,
  priceBinaryFromSurface,
  quantifyResidualRisk,
} = require('../borg/options/digital-pricer');
const { classifyExecutionBarrier } = require('../borg/options/collector');

test('ATM forward digital is close to one half and has positive delta', () => {
  const fair = digitalCashFair({
    spot: 100, forward: 100, strike: 100, annualizedVol: 0.6,
    secondsToExpiry: 30 * 86400,
  });
  assert.ok(fair.probability < 0.5 && fair.probability > 0.45);
  assert.ok(fair.delta > 0);
  assert.ok(Number.isFinite(fair.gamma));
});

test('executable call-spread quotes produce an ordered digital interval', () => {
  const bounds = callSpreadProbabilityBounds({
    lowerStrike: 90, upperStrike: 110,
    lowerCallBid: 14, lowerCallAsk: 15,
    upperCallBid: 4, upperCallAsk: 5,
  });
  assert.deepEqual(bounds, {
    lower: 0.45, upper: 0.55, width: 20, premiumToQuoteMultiplier: 1,
  });
});

test('inverse-option call spreads require explicit base-to-quote conversion', () => {
  const bounds = callSpreadProbabilityBounds({
    lowerStrike: 90_000, upperStrike: 100_000,
    lowerCallBid: 0.08, lowerCallAsk: 0.081,
    upperCallBid: 0.03, upperCallAsk: 0.031,
    premiumToQuoteMultiplier: 95_000,
  });
  assert.ok(bounds.lower > 0.4 && bounds.upper < 0.5);
});

test('a mark-only surface is retained but explicitly graded D', () => {
  const now = Date.UTC(2026, 0, 1);
  const expiry = now + 10 * 86400e3;
  const mark = priceBinaryFromSurface({
    rows: [
      { expiryMs: expiry, strike: 90, markIv: 45 },
      { expiryMs: expiry, strike: 110, markIv: 45 },
    ],
    spot: 100, strike: 100, targetExpiryMs: expiry, nowMs: now,
  });
  assert.equal(mark.fidelity, 'D');
  assert.equal(mark.ivIntervalComplete, false);
});

test('surface interpolation is linear in total variance across expiries', () => {
  const now = Date.UTC(2026, 0, 1);
  const rows = [
    { expiryMs: now + 10 * 86400e3, strike: 90, bidIv: 40, markIv: 45, askIv: 50 },
    { expiryMs: now + 10 * 86400e3, strike: 110, bidIv: 40, markIv: 45, askIv: 50 },
    { expiryMs: now + 30 * 86400e3, strike: 90, bidIv: 50, markIv: 55, askIv: 60 },
    { expiryMs: now + 30 * 86400e3, strike: 110, bidIv: 50, markIv: 55, askIv: 60 },
  ];
  const surface = interpolateSurfaceVariance({
    rows, targetStrike: 100, targetExpiryMs: now + 20 * 86400e3, nowMs: now,
  });
  assert.equal(surface.mode, 'TERM_INTERPOLATED');
  assert.ok(surface.bidIv > 0.4 && surface.bidIv < 0.5);
  assert.ok(surface.markIv > surface.bidIv);
});

test('surface binary output carries resolver-basis and IV uncertainty', () => {
  const now = Date.UTC(2026, 0, 1);
  const expiry = now + 10 * 86400e3;
  const rows = [
    { expiryMs: expiry, strike: 90, bidIv: 40, markIv: 45, askIv: 50 },
    { expiryMs: expiry, strike: 110, bidIv: 40, markIv: 45, askIv: 50 },
  ];
  const mark = priceBinaryFromSurface({
    rows, spot: 100, strike: 100, targetExpiryMs: expiry, nowMs: now,
    basisBpsInterval: [-10, 10],
  });
  assert.equal(mark.fidelity, 'A');
  assert.ok(mark.fairYesLower < mark.fairYes);
  assert.ok(mark.fairYesUpper > mark.fairYes);
});

test('delta hedge quantifies rather than erases binary gamma and basis risk', () => {
  const fair = digitalCashFair({
    spot: 100, strike: 100, annualizedVol: 0.5, secondsToExpiry: 86400,
  });
  const hedge = deltaHedgeForBinary({
    tokenShares: 10, outcome: 'YES', deltaPerShare: fair.delta,
    spot: 100, quantityStep: 0.001,
  });
  assert.ok(hedge.hedgeBase < 0);
  const risk = quantifyResidualRisk({
    tokenShares: 10, outcome: 'YES', spot: 100, strike: 100,
    annualizedVol: 0.5, secondsToExpiry: 86400, hedgeBase: hedge.hedgeBase,
  });
  assert.ok(risk.worstLossUsd > 0);
  assert.ok(risk.cvar95LossUsd > 0);
});

test('binary entry optimization walks depth and rejects sub-minimum fake edge', () => {
  const best = optimizeBinaryEntry({
    asks: [[0.40, 5], [0.45, 10], [0.70, 100]], fairLower: 0.60,
    budgetUsd: 10, minimumOrderSize: 5, feeRate: 0, feeExponent: 1,
    hedgeCostPerShare: 0.005,
  });
  assert.equal(best.shares, 15);
  assert.ok(best.expectedProfitLower > 2);
  const none = optimizeBinaryEntry({
    asks: [[0.40, 4]], fairLower: 0.60, budgetUsd: 10,
    minimumOrderSize: 5, feeRate: 0, feeExponent: 1,
  });
  assert.equal(none, null);
});

test('binary optimizer selects the last profitable displayed-depth breakpoint', () => {
  const best = optimizeBinaryEntry({
    asks: [[0.40, 5], [0.45, 10], [0.90, 100]], fairLower: 0.60,
    budgetUsd: 100, minimumOrderSize: 5, feeRate: 0, feeExponent: 1,
  });
  assert.equal(best.shares, 15);
});

test('options evidence fails closed with an explicit primary barrier', () => {
  assert.equal(classifyExecutionBarrier({
    valuation: {
      fidelity: 'C', ivIntervalComplete: true,
      surface: { mode: 'SHORT_HORIZON_VOL_EXTRAPOLATION' },
    },
    optimized: {}, freshBook: true, book: {}, bookAgeMs: 10,
    chainlinkAgeMs: 10, feesKnown: true, minimumOrderSize: 5,
  }), 'UNSUPPORTED_SHORT_HORIZON_VOL_EXTRAPOLATION');
  assert.equal(classifyExecutionBarrier({
    valuation: {
      fidelity: 'A', ivIntervalComplete: true, surface: { mode: 'EXACT_EXPIRY' },
    },
    optimized: null, freshBook: true, book: {}, bookAgeMs: 10,
    chainlinkAgeMs: 10, feesKnown: true, minimumOrderSize: 5,
  }), 'NO_POSITIVE_DEPTH_WALK_AFTER_2X_COSTS');
});
