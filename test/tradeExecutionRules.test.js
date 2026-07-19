const test = require('node:test');
const assert = require('node:assert/strict');

function loadRules() {
  try {
    return require('../src/bot/tradeExecutionRules');
  } catch (error) {
    assert.fail(`tradeExecutionRules module is missing: ${error.message}`);
  }
}

test('isEntryPriceAllowed blocks entries below 40 cents', () => {
  const { isEntryPriceAllowed, DEFAULT_MIN_MARKET_ENTRY } = loadRules();

  assert.equal(DEFAULT_MIN_MARKET_ENTRY, 0.4);
  assert.equal(isEntryPriceAllowed(0.39), false);
  assert.equal(isEntryPriceAllowed(0.4), true);
  assert.equal(isEntryPriceAllowed(0.55), true);
});

test('withDipOutcomePrice keeps NO rawPrice in YES-price space', () => {
  const { withDipOutcomePrice, getRawOutcomePrice } = loadRules();

  const baseSignal = {
    direction: 'NO',
    yesPrice: 0.99,
    rawPrice: 0.99,
  };

  const normalized = withDipOutcomePrice(baseSignal, 0.01);

  assert.equal(normalized.rawPrice, 0.99);
  assert.equal(normalized.rawOutcomePrice, 0.01);
  assert.equal(getRawOutcomePrice(normalized), 0.01);
});

test('shouldTriggerTrailingStop ignores healthy profit pullbacks', () => {
  const { shouldTriggerTrailingStop } = loadRules();

  assert.equal(
    shouldTriggerTrailingStop({
      peakPnlPct: 22,
      pnlPct: 12,
      marketEndSec: 180,
    }),
    false
  );

  assert.equal(
    shouldTriggerTrailingStop({
      peakPnlPct: 42,
      pnlPct: 8,
      marketEndSec: 180,
    }),
    true
  );

  assert.equal(
    shouldTriggerTrailingStop({
      peakPnlPct: 42,
      pnlPct: 8,
      marketEndSec: 45,
    }),
    false
  );
});

test('calculateSlippageTicks uses actual outcome reference price', () => {
  const { calculateSlippageTicks } = loadRules();

  assert.equal(calculateSlippageTicks(0.56, 0.505), 5.5);
  assert.equal(calculateSlippageTicks(0.58, 0.56), 2);
});

test('calculateCryptoTakerFeeUsd follows the crypto fee curve', () => {
  const { calculateCryptoTakerFeeUsd } = loadRules();

  assert.ok(Math.abs(calculateCryptoTakerFeeUsd(10, 0.5) - 0.175) < 1e-12);
  assert.ok(Math.abs(calculateCryptoTakerFeeUsd(10, 0.8) - 0.112) < 1e-12);
  assert.equal(calculateCryptoTakerFeeUsd(0, 0.5), 0);
});

test('calculateExecutionAdjustedEV values the executable outcome ask', () => {
  const { calculateExecutionAdjustedEV } = loadRules();

  // A model at 62% cannot justify paying a 96-cent ask, despite a much lower
  // last-trade/mid quote. This is the MAIN paper-fill regression guard.
  assert.ok(calculateExecutionAdjustedEV({
    modelProb: 0.62,
    direction: 'YES',
    fillPrice: 0.96,
  }) < -34);

  assert.ok(calculateExecutionAdjustedEV({
    modelProb: 0.8,
    direction: 'NO',
    fillPrice: 0.15,
  }) > 4);
});
