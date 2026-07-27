'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  feeForFills, normalizeKalshiFeeSchedule,
} = require('../borg/crossvenue/kalshi-fees');
const {
  evaluateBasisCombination,
} = require('../borg/crossvenue/strategy');

test('series fee metadata applies documented non-direct member cash rounding', () => {
  const schedule = normalizeKalshiFeeSchedule({
    ticker: 'KXEXAMPLE',
    fee_type: 'quadratic',
    fee_multiplier: '1',
  }, { observedAt: '2026-07-27T00:00:00Z' });
  assert.equal(schedule.supported, true);
  assert.equal(schedule.balancePrecisionUsd, 0.01);
  assert.equal(schedule.membershipAssumption, 'NON_DIRECT_CONSERVATIVE');
  assert.equal(schedule.takerCoefficient, 0.07);
  assert.equal(feeForFills([{ price: 0.5, size: 100 }], schedule), 1.75);
  assert.equal(feeForFills([{ price: 0.5, size: 1 }], schedule), 0.02);
  assert.equal(feeForFills([{ price: 0.505, size: 1 }], schedule, 'taker', 'buy'), 0.025);
  assert.equal(feeForFills([{ price: 0.505, size: 1 }], schedule, 'taker', 'sell'), 0.025);
});

test('maker-bearing schedules preserve separate maker and taker coefficients', () => {
  const schedule = normalizeKalshiFeeSchedule({
    fee_type: 'quadratic_with_maker_fees',
    fee_multiplier: 2,
  });
  assert.equal(schedule.takerCoefficient, 0.14);
  assert.equal(schedule.makerCoefficient, 0.035);
  assert.ok(Math.abs(
    feeForFills([{ price: 0.5, size: 10 }], schedule, 'maker') - 0.09,
  ) < 1e-12);
});

test('direct-member precision can be selected explicitly without changing the series formula', () => {
  const schedule = normalizeKalshiFeeSchedule({
    fee_type: 'quadratic',
    fee_multiplier: 1,
  }, {
    balancePrecisionUsd: 0.0001,
    membershipAssumption: 'DIRECT_MEMBER',
  });
  assert.equal(feeForFills([{ price: 0.5, size: 1 }], schedule), 0.0175);
});

test('unsupported or missing fee types fail closed in depth economics', () => {
  const unsupported = normalizeKalshiFeeSchedule({
    fee_type: 'flat',
    fee_multiplier: 1,
  });
  assert.equal(unsupported.supported, false);
  assert.equal(feeForFills([{ price: 0.5, size: 5 }], unsupported), null);
  const result = evaluateBasisCombination({
    polyOutcome: 'YES',
    kalshiOutcome: 'NO',
    quantity: 5,
    polyBook: { asks: [[0.45, 10]], bids: [[0.44, 10]] },
    kalshiBook: { asks: [[0.45, 10]], bids: [[0.44, 10]] },
    kalshiFeeSchedule: unsupported,
    booksFresh: true,
  });
  assert.equal(result, null);
});
