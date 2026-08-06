'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  normalizeEquityThreshold,
  selectEquityThresholds,
} = require('../borg/equity-options/universe');
const { scanRobustVerticals } = require('../borg/equity-options/vertical-floor');

const EXPIRY = Date.parse('2026-08-07T20:00:00.000Z');
const RULE = 'This market will resolve to "Yes" if the Close price for S&P 500 (SPY) ' +
  'on August 7, 2026 is higher than the listed price. Otherwise, this market will resolve ' +
  'to "No." If the two specified prices are exactly equal, this market will resolve to "No". ' +
  'Closing prices will be used exactly as published by Pyth, without rounding. If S&P 500 ' +
  '(SPY) does not trade at all during the regular session, the market will resolve 50-50. ' +
  'For a standard full trading session, the closing price refers to the Pyth "Close" value ' +
  'of the 1-minute candle corresponding to the final minute of regular trading hours on the ' +
  'primary exchange. If the specified day has no valid Pyth Close value for the 1-minute candle ' +
  'corresponding to the end of regular trading hours, the market will use the last valid Pyth ' +
  'price achieved during the regular trading hours. If no valid Pyth price exists due to a ' +
  'system outage, the official closing price published by the primary exchange will be used. ' +
  'If the listed date is not a trading day under the applicable trading-hours schedule as ' +
  'listed on Pyth, this market will resolve 50-50. In the event of a stock split, reverse stock ' +
  'split, or similar corporate action, the target price will be adjusted proportionally. ' +
  'The resolution source is https://pythdata.app/explore/Equity.US.SPY%2FUSD.';

function event() {
  return {
    id: 'event-spy', slug: 'spy-closes-above-test', active: true, closed: false,
    title: 'S&P 500 (SPY) closes above ___ on August 7?', endDate: new Date(EXPIRY).toISOString(),
    markets: [100, 105].map((strike) => ({
      id: `market-${strike}`, conditionId: `condition-${strike}`,
      slug: `spy-above-${strike}`,
      question: `S&P 500 (SPY) closes above $${strike} on August 7?`,
      groupItemTitle: `$${strike}`, outcomes: '["Yes","No"]',
      clobTokenIds: JSON.stringify([`yes-${strike}`, `no-${strike}`]),
      description: RULE, resolutionSource: 'https://pythdata.app/explore/Equity.US.SPY%2FUSD',
      endDate: new Date(EXPIRY).toISOString(), acceptingOrders: true,
      active: true, closed: false, orderMinSize: '5',
      feesEnabled: true, feeSchedule: { rate: '0.04', exponent: '1', takerOnly: true },
    })),
  };
}

test('equity option universe certifies exact Pyth close-above thresholds', () => {
  const row = normalizeEquityThreshold(event(), event().markets[0]);
  assert.equal(row.certified, true);
  assert.equal(row.symbol, 'SPY');
  assert.equal(row.strike, 100);
  assert.equal(row.fees.rate, 0.04);
  assert.match(row.ruleHash, /^[a-f0-9]{64}$/);
  const selection = selectEquityThresholds([event()], {
    symbols: ['SPY'], nowMs: EXPIRY - 3600_000,
  });
  assert.equal(selection.records.length, 2);
});

test('robust vertical evaluator keeps token and option price scales separate', () => {
  const target = normalizeEquityThreshold(event(), event().markets[0]);
  const now = EXPIRY - 3600_000;
  const option = (id, strike, bid, ask) => ({
    instrumentId: id, underlying: 'SPY', optionType: 'call', strike,
    expiryMs: EXPIRY, bid, ask, bidSize: 5, askSize: 5, multiplier: 100,
    sourceMs: now - 10, receiveMs: now - 5, adjusted: false,
    exerciseStyle: 'AMERICAN', settlementStyle: 'PHYSICAL',
  });
  const result = scanRobustVerticals({
    target,
    nowMs: now,
    optionQuotes: [option('call-98', 98, 1.1, 1.2), option('call-99', 99, 1.0, 1.1)],
    polyBooks: {
      yes: { asks: [[0.5, 1000]], bids: [[0.49, 1000]] },
      no: { asks: [[0.4, 1000]], bids: [[0.39, 1000]] },
    },
    config: {
      basisBoundUsd: 1,
      basisEvidenceId: 'frozen-basis-30d-v1',
      basisObservationDays: 30,
      regularSessionTradeObserved: true,
      corporateActionClear: true,
      optionFeePerContractPerLeg: 0.65,
      optionTickSizeUsd: 0.01,
      assignmentReserveUsdPerContract: 1,
      feeMultiplier: 2,
      budgetUsd: 500,
      minProfitUsd: 1,
      maxContracts: 1,
      maxAgeMs: 1000,
    },
  });
  assert.equal(result.failures.length, 0);
  assert.equal(result.qualified.length, 1);
  const candidate = result.qualified[0];
  assert.equal(candidate.side, 'NO');
  assert.equal(candidate.tokenShares, 100);
  assert.ok(Math.abs(candidate.verticalDebitUsd - 20) < 1e-9);
  assert.ok(candidate.polyEntry.vwap > 0 && candidate.polyEntry.vwap < 1);
  assert.ok(candidate.orphanSafeProfitUsd > 1);
});

test('vertical experiment fails closed without untouched basis evidence or current source timestamps', () => {
  const target = normalizeEquityThreshold(event(), event().markets[0]);
  const noBasis = scanRobustVerticals({ target, config: {} });
  assert.ok(noBasis.failures.includes('INSUFFICIENT_FROZEN_BASIS_EVIDENCE'));

  const now = EXPIRY - 3600_000;
  const stale = scanRobustVerticals({
    target, nowMs: now,
    optionQuotes: [{
      instrumentId: 'stale', underlying: 'SPY', optionType: 'call', strike: 99,
      expiryMs: EXPIRY, bid: 1, ask: 1.1, bidSize: 5, askSize: 5,
      sourceMs: now - 60_000, receiveMs: now, exerciseStyle: 'AMERICAN',
      settlementStyle: 'PHYSICAL',
    }],
    config: {
      basisBoundUsd: 1, basisEvidenceId: 'basis', basisObservationDays: 30,
      regularSessionTradeObserved: true, corporateActionClear: true,
      optionFeePerContractPerLeg: 0.65, optionTickSizeUsd: 0.01,
      assignmentReserveUsdPerContract: 1, feeMultiplier: 2, maxAgeMs: 1000,
    },
  });
  assert.deepEqual(stale.failures, ['NO_FRESH_EXACT_EXPIRY_OPTION_QUOTES']);
});
