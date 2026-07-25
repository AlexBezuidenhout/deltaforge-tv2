'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MECHANISM_STATUSES,
  PROOF_CLASSES,
  evaluateOpportunity,
  summarizeOpportunities,
} = require('../borg/research/opportunity-economics');

function base(overrides = {}) {
  return {
    opportunityId: 'candidate-1',
    program: 'certified_payoff_graph',
    independentUnit: 'market-1',
    observedAt: '2026-07-21T12:00:00Z',
    proofClass: PROOF_CLASSES.DETERMINISTIC_LOCK,
    mechanismStatus: MECHANISM_STATUSES.CERTIFIED,
    atomic: true,
    payoutLowerUsd: '12.00',
    entryPrincipalUsd: '10.00',
    feeStressUsd: '0.20',
    slippageStressUsd: '0.30',
    failureRiskReserveUsd: '0.50',
    displayedCapacityUsd: '50.00',
    minimumDeployableUsd: '5.00',
    capitalDurationSec: '3600',
    dataQualityGrade: 'A',
    executionFidelityGrade: 'B',
    fullDepth: true,
    booksFresh: true,
    ...overrides,
  };
}

test('evaluates every PostgreSQL decimal string on one USD scale', () => {
  const row = evaluateOpportunity(base());
  assert.equal(row.paperTestEligible, true);
  assert.equal(row.certifiedLock, true);
  assert.equal(row.liveEligible, false);
  assert.equal(row.economics.conservativeNetUsd, 1);
  assert.equal(row.economics.deployedCapitalUsd, 10.2);
  assert.equal(row.economics.roiPct, 9.803922);
});

test('non-atomic execution can be paper-testable but is never a certified pre-trade lock', () => {
  const row = evaluateOpportunity(base({ atomic: false }));
  assert.equal(row.paperTestEligible, true);
  assert.equal(row.certifiedLock, false);
});

test('missing failure reserve and capital duration fail closed', () => {
  const row = evaluateOpportunity(base({
    failureRiskReserveUsd: null,
    capitalDurationSec: null,
  }));
  assert.equal(row.paperTestEligible, false);
  assert.ok(row.rejectionReasons.includes('INVALID_FAILURE_RISK_RESERVE_USD'));
  assert.ok(row.rejectionReasons.includes('INVALID_CAPITAL_DURATION_SEC'));
});

test('failure reserve can turn a displayed arithmetic residual into a rejection', () => {
  const row = evaluateOpportunity(base({ failureRiskReserveUsd: '3.00' }));
  assert.equal(row.economics.conservativeNetUsd, -1.5);
  assert.equal(row.paperTestEligible, false);
  assert.ok(row.rejectionReasons.includes('NONPOSITIVE_CONSERVATIVE_NET'));
});

test('summary ranks eligible conservative dollars without summing rejected diagnostics', () => {
  const accepted = evaluateOpportunity(base());
  const rejected = evaluateOpportunity(base({
    opportunityId: 'candidate-2', independentUnit: 'market-2',
    failureRiskReserveUsd: '20',
  }));
  const summary = summarizeOpportunities([rejected, accepted]);
  assert.equal(summary.paperTestEligible, 1);
  assert.equal(summary.certifiedLocks, 1);
  assert.equal(summary.eligibleConservativeNetUsd, 1);
  assert.equal(summary.rows[0].opportunityId, 'candidate-1');
});

