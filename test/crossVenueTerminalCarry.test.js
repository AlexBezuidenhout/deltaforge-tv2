'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TERMINAL_CARRY_EXPERIMENT_ID,
  evaluateTerminalCarry,
  wilsonLower,
} = require('../borg/crossvenue/terminal-carry');

function books({ polyYes = 0.20, polyNo = 0.66, kalshiYes = 0.40, kalshiNo = 0.50 } = {}) {
  return {
    polyBooks: {
      YES: { asks: [[polyYes, 100]], bids: [[polyYes - 0.01, 100]] },
      NO: { asks: [[polyNo, 100]], bids: [[polyNo - 0.01, 100]] },
    },
    kalshiBooks: {
      YES: { asks: [[kalshiYes, 100]], bids: [[kalshiYes - 0.01, 100]] },
      NO: { asks: [[kalshiNo, 100]], bids: [[kalshiNo - 0.01, 100]] },
    },
  };
}

function evaluate(overrides = {}) {
  return evaluateTerminalCarry({
    ...books(),
    prior: {
      clusters: 213,
      allAgreeClusters: 194,
      agreementLower: wilsonLower(194, 213),
    },
    paperEvalApproved: true,
    relationApproved: false,
    booksFresh: true,
    dataQualityGrade: 'B',
    executionFidelityGrade: 'B',
    quantities: [5, 10],
    minQuantity: 5,
    maxQuantity: 100,
    totalCapitalUsd: 500,
    polyCapitalUsd: 250,
    kalshiCapitalUsd: 250,
    polyFeeRate: 0,
    polyFeeExponent: 1,
    kalshiFeeMultiplier: 1,
    polyTick: 0.01,
    kalshiTick: 0.01,
    ...overrides,
  });
}

test('Wilson prior uses event-cluster sample count rather than raw matches', () => {
  const lower = wilsonLower(194, 213);
  assert.ok(lower > 0.85 && lower < 0.88);
  assert.equal(wilsonLower(0, 0), null);
});

test('terminal carry can arm only a conservatively positive direction', () => {
  const rows = evaluate();
  const yesNo = rows.find((row) => row.direction === 'POLY_YES+KALSHI_NO');
  assert.equal(yesNo.experimentId, TERMINAL_CARRY_EXPERIMENT_ID);
  assert.equal(yesNo.eligible, true);
  assert.equal(yesNo.reason, 'ELIGIBLE');
  assert.ok(yesNo.expectedProfitLower > 0);
  assert.ok(yesNo.orphanReserve > 0);
  assert.equal(yesNo.atomic, false);
  assert.equal(yesNo.paperOnly, true);
  assert.equal(yesNo.payoutModel,
    'CLUSTERED_AGREEMENT_WILSON_LOWER; MISMATCH_PAYOUT_ZERO');
});

test('mismatch risk, second costs, and orphan reserve all reduce expected value', () => {
  const row = evaluate()[0];
  assert.equal(row.worstMismatchLoss, -row.totalCost);
  assert.ok(row.expectedPayoutLower < row.quantity);
  assert.ok(row.additionalCostStress > 0);
  assert.ok(row.expectedProfitLower < row.expectedProfitBeforeOrphan);
});

test('unapproved pairs and insufficient clustered history fail closed', () => {
  const unapproved = evaluate({ paperEvalApproved: false });
  assert.ok(unapproved.every((row) =>
    row.reason === 'PAIR_NOT_SCORE_APPROVED_FOR_PAPER_EVALUATION' && !row.eligible));
  const thinPrior = evaluate({
    prior: { clusters: 99, allAgreeClusters: 99, agreementLower: wilsonLower(99, 99) },
  });
  assert.ok(thinPrior.every((row) =>
    row.reason === 'INSUFFICIENT_SETTLED_EVENT_CLUSTERS' && !row.eligible));
});

test('rule-certified identities are kept in the deterministic payoff lane', () => {
  const rows = evaluate({ relationApproved: true });
  assert.ok(rows.every((row) =>
    row.reason === 'DETERMINISTIC_RELATION_USES_CERTIFIED_LANE' && !row.eligible));
});
