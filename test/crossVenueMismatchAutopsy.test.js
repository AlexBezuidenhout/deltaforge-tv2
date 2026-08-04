'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  autopsyRow, buildMismatchAutopsy, observationClassification,
} = require('../borg/crossvenue/mismatch-autopsy');

function row(overrides = {}) {
  const equal = (value) => ({
    status: 'CERTIFIED_EQUAL', polyValue: value, kalshiValue: value,
  });
  return {
    match_id: 'pair-1', poly_condition_id: 'poly-1', kalshi_ticker: 'kalshi-1',
    match_score: '0.93', exact_rule_eligible: false, hard_mismatch: true,
    hard_mismatch_reasons: ['OBSERVATIONAT_MISMATCH'], unknown_rule_reasons: [],
    exact_rule_audit: {
      fieldComparisons: {
        subject: equal('event'), predicate: equal('binary'), comparator: equal('n/a'),
        strike: equal('n/a'), resolver: equal('media:ap'),
        observationAt: { status: 'CERTIFIED_DIFFERENT' },
        timezone: equal('UTC'), fallback: equal('no'),
        settlementPrecision: equal('binary_event'),
      },
      polyRule: { key: { observationAt: '2026-08-05T12:00:00.000Z' } },
      kalshiRule: { key: { observationAt: '2026-08-05T14:00:00.000Z' } },
    },
    metadata: {
      poly: { endDate: '2026-08-05T12:00:00.000Z' },
      kalshi: {
        expectedExpirationTime: '2026-08-05T14:00:00.000Z',
        closeTime: '2026-08-05T12:00:00.000Z',
      },
    },
    ...overrides,
  };
}

test('close-time equality is reviewable only when every other rule field is certified', () => {
  const result = autopsyRow(row());
  assert.equal(result.observationClassification, 'CLOSE_TIME_EXACT_UNCERTIFIED');
  assert.equal(result.reviewableTimeSemantics, true);
  assert.equal(result.automaticEligibility, false);

  const mismatch = row({ hard_mismatch_reasons: [
    'OBSERVATIONAT_MISMATCH', 'RESOLVER_MISMATCH',
  ] });
  assert.equal(autopsyRow(mismatch).reviewableTimeSemantics, false);
});

test('timestamp diagnostics never turn a close-time match into automatic approval', () => {
  assert.equal(observationClassification(row()), 'CLOSE_TIME_EXACT_UNCERTIFIED');
  const report = buildMismatchAutopsy([row()], { now: '2026-08-04T00:00:00Z' });
  assert.equal(report.observationTime.reviewableAfterEveryOtherFieldPasses, 1);
  assert.equal(report.successorDecision,
    'MANUAL_RULE_DOCUMENT_REVIEW_REQUIRED_BEFORE_A_NEW_EXPERIMENT_ID');
  assert.equal(report.safety.autoApprovesPairs, false);
  assert.equal(report.safety.hardMismatchVetoPreserved, true);
});
