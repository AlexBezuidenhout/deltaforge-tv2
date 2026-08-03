'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ALLOWED_PROPOSAL_TYPE,
  auditProposals,
  buildRuleNode,
  proposeOrderedThresholds,
  verifyProposal,
} = require('../borg/research/semantic-condition-proposer');

function rule(strike, overrides = {}) {
  const ruleHash = String(overrides.ruleHash || '').padEnd(64, String(strike).slice(-1) || '0').slice(0, 64);
  const question = `Will the Fed cut rates at least ${strike} times by December 31, 2026?`;
  const description = [
    `This resolves Yes if the Fed cuts rates at least ${strike} times by December 31, 2026.`,
    'The official Federal Reserve release is the source. If unavailable, resolves No.',
  ].join(' ');
  return {
    rule_hash: ruleHash,
    rule_document: {
      schema: 'polymarket-rule-document-v1',
      event: {
        id: overrides.eventId || `event-${strike}`,
        slug: `fed-cuts-${strike}`,
        title: question, description,
        resolutionSource: 'https://federalreserve.gov/',
        endDate: '2026-12-31T23:59:00.000Z',
      },
      market: {
        id: `market-${strike}`, conditionId: `condition-${strike}`,
        question, description,
        resolutionSource: 'https://federalreserve.gov/',
        endDate: '2026-12-31T23:59:00.000Z',
      },
    },
  };
}

test('lexical baseline proposes an abstract ordered implication from immutable hashes', () => {
  // Use a recognized resolver label while retaining separate event IDs.
  const low = rule(1); const high = rule(2);
  low.rule_document.event.description += ' Source: Binance.';
  low.rule_document.market.description += ' Source: Binance.';
  high.rule_document.event.description += ' Source: Binance.';
  high.rule_document.market.description += ' Source: Binance.';
  const nodes = [buildRuleNode(low), buildRuleNode(high)];
  const proposals = proposeOrderedThresholds(nodes);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].crossEvent, true);
  const result = verifyProposal(proposals[0], new Map(nodes.map((node) => [node.ruleHash, node])));
  assert.equal(result.abstractPayoffProved, true);
  assert.equal(result.payoffProof.guaranteedMinPayout, 1);
  assert.equal(result.deterministicRuleCertified, false);
  assert.equal(result.tradeAuthorization, 'NONE');
  assert.equal(result.status, 'ABSTRACT_PAYOFF_PROVED_RULE_REVIEW_REQUIRED');
});

test('different observation scopes or resolvers never generate a relationship', () => {
  const left = rule(1); const right = rule(2);
  left.rule_document.event.description += ' Source: Binance.';
  left.rule_document.market.description += ' Source: Binance.';
  right.rule_document.event.description += ' Source: Coinbase.';
  right.rule_document.market.description += ' Source: Coinbase.';
  assert.equal(proposeOrderedThresholds([buildRuleNode(left), buildRuleNode(right)]).length, 0);
});

test('an AI proposal cannot self-certify or smuggle an order instruction', () => {
  const left = rule(1); const right = rule(2);
  for (const item of [left, right]) {
    item.rule_document.event.description += ' Source: Binance.';
    item.rule_document.market.description += ' Source: Binance.';
  }
  const nodes = [buildRuleNode(left), buildRuleNode(right)];
  const proposal = {
    proposalId: 'ai-1', proposalType: ALLOWED_PROPOSAL_TYPE,
    harderRuleHash: nodes[1].ruleHash, easierRuleHash: nodes[0].ruleHash,
    proposer: 'MODEL', certified: true, order: { side: 'BUY' }, confidence: 0.999,
  };
  const result = verifyProposal(proposal, new Map(nodes.map((node) => [node.ruleHash, node])));
  assert.equal(result.abstractPayoffProved, false);
  assert.ok(result.proposalBlockers.includes('PROPOSAL_CONTAINS_FORBIDDEN_AUTHORITY_FIELDS'));
  assert.equal(result.tradeAuthorization, 'NONE');
});

test('audit output never turns abstract proofs into executable candidates', () => {
  const rows = [rule(1, { eventId: 'same' }), rule(2, { eventId: 'same' })];
  for (const item of rows) {
    item.rule_document.event.description += ' Source: Binance.';
    item.rule_document.market.description += ' Source: Binance.';
  }
  const report = auditProposals(rows, [], { generatedAt: '2026-08-03T15:04:00.000Z' });
  assert.equal(report.proposals, 1);
  assert.equal(report.deterministicRuleCertified, 0);
  assert.equal(report.executableCandidates, 0);
  assert.equal(report.tradeAuthorization, 'NONE');
});
