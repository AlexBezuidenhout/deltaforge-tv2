'use strict';

/**
 * N09 discovery layer. Text/AI may propose relationships, but this module
 * rebuilds every relation from immutable rule documents and never certifies
 * venue rules, executable economics or an order.
 */

const crypto = require('node:crypto');
const { comparator, fallbackPolicy, thresholdStrike } = require('../crossvenue/exact-rule-key');
const { normalizeRuleText } = require('../structural/rule-certifier');
const { RELATION_TYPES, compilePayoffProof } = require('./payoff-proof');
const {
  explicitTimezone,
  resolverCandidates,
  terminalTimeSemantics,
} = require('./resolver-timestamp-precision');

const PROPOSER_VERSION = 'semantic-condition-graph-proposer-v1';
const ALLOWED_PROPOSAL_TYPE = 'ORDERED_THRESHOLD_IMPLICATION';
const FORBIDDEN_INPUT_KEYS = new Set([
  'action', 'certified', 'execute', 'live', 'order', 'orderIntent', 'qualified',
  'trade', 'tradeAuthorization', 'wallet',
]);

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function ruleParts(document = {}) {
  if (document.schema !== 'polymarket-rule-document-v1') return null;
  const event = document.event || {};
  const market = document.market || {};
  const question = market.question || event.title || '';
  const description = [market.description, event.description].filter(Boolean).join('\n');
  return {
    event, market, question, description,
    fullText: [question, description, market.resolutionSource, event.resolutionSource]
      .filter(Boolean).join('\n'),
    observationAt: market.endDate || event.endDate || null,
  };
}

function replaceStrike(text, strike) {
  return normalizeRuleText(text).replace(/\$?-?\d[\d,.]*(?:\.\d+)?%?/g, (raw) => {
    const parsed = finite(raw.replace(/[$,%]/g, '').replaceAll(',', ''));
    return parsed != null && Math.abs(parsed - strike) <= 1e-9 ? '<strike>' : raw;
  });
}

function subjectTemplate(question, strike) {
  return replaceStrike(question, strike)
    .replace(/\b(?:at least|at most|at or above|at or below|or above|or below|above|below|over|under|greater than(?: or equal to)?|less than(?: or equal to)?|more than|fewer than)\b/g, '<threshold>')
    .replace(/^will\s+/, '')
    .replace(/\s+/g, ' ').trim();
}

function directionForComparator(value) {
  if (['gt', 'gte'].includes(value)) return 'ABOVE';
  if (['lt', 'lte'].includes(value)) return 'BELOW';
  return null;
}

function buildRuleNode(row) {
  const document = row.rule_document || row.ruleDocument || row.document;
  const parts = ruleParts(document);
  if (!parts) return null;
  const cmp = comparator(parts.question, parts.market, 'poly');
  const strike = thresholdStrike(parts.market, 'poly');
  const direction = directionForComparator(cmp);
  if (strike == null || !direction) return null;
  const resolvers = resolverCandidates(parts.fullText);
  const observationMs = Date.parse(parts.observationAt || '');
  const timing = terminalTimeSemantics(parts.fullText);
  const node = {
    version: PROPOSER_VERSION,
    ruleHash: String(row.rule_hash || row.ruleHash || ''),
    eventId: String(parts.event.id || ''),
    eventSlug: parts.event.slug || null,
    conditionId: parts.market.conditionId || null,
    gammaId: parts.market.id || null,
    question: parts.question,
    subjectTemplate: subjectTemplate(parts.question, strike),
    ruleTemplate: replaceStrike(parts.description, strike),
    comparator: cmp,
    direction,
    strike,
    resolver: resolvers.length === 1 ? resolvers[0] : null,
    resolverCandidates: resolvers,
    observationAt: Number.isFinite(observationMs) ? new Date(observationMs).toISOString() : null,
    timezone: explicitTimezone(parts.fullText),
    fallback: fallbackPolicy(parts.fullText),
    terminalTimeSemantics: timing,
  };
  if (!/^[a-f0-9]{64}$/.test(node.ruleHash)) return null;
  node.nodeHash = hash(JSON.stringify(node));
  return Object.freeze(node);
}

function sameSemanticScope(left, right) {
  return left.subjectTemplate === right.subjectTemplate
    && left.ruleTemplate === right.ruleTemplate
    && left.observationAt != null && left.observationAt === right.observationAt
    && left.resolver != null && left.resolver === right.resolver
    && left.direction === right.direction;
}

function harderAndEasier(left, right) {
  if (left.direction !== right.direction || left.strike === right.strike) return null;
  if (left.direction === 'ABOVE') {
    return left.strike > right.strike ? { harder: left, easier: right }
      : { harder: right, easier: left };
  }
  return left.strike < right.strike ? { harder: left, easier: right }
    : { harder: right, easier: left };
}

function proposalIdentity(harder, easier) {
  return `n09:${hash([
    ALLOWED_PROPOSAL_TYPE, harder.ruleHash, easier.ruleHash,
  ].join(':'))}`;
}

function proposeOrderedThresholds(nodes, options = {}) {
  const maxProposals = Math.max(1, Number.parseInt(options.maxProposals, 10) || 10000);
  const groups = new Map();
  for (const node of nodes.filter(Boolean)) {
    const key = [node.subjectTemplate, node.ruleTemplate, node.observationAt,
      node.resolver, node.direction].join('\u0000');
    const group = groups.get(key) || [];
    group.push(node); groups.set(key, group);
  }
  const proposals = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) => a.strike - b.strike
      || a.ruleHash.localeCompare(b.ruleHash));
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const relation = harderAndEasier(ordered[index], ordered[index + 1]);
      if (!relation || !sameSemanticScope(relation.harder, relation.easier)) continue;
      proposals.push({
        proposalVersion: PROPOSER_VERSION,
        proposalId: proposalIdentity(relation.harder, relation.easier),
        proposalType: ALLOWED_PROPOSAL_TYPE,
        proposer: 'DETERMINISTIC_LEXICAL_BASELINE',
        harderRuleHash: relation.harder.ruleHash,
        easierRuleHash: relation.easier.ruleHash,
        crossEvent: relation.harder.eventId !== relation.easier.eventId,
        rationale: `${relation.harder.question} implies ${relation.easier.question}`,
        requiresDeterministicVerification: true,
        tradeAuthorization: 'NONE',
      });
      if (proposals.length >= maxProposals) return proposals;
    }
  }
  return proposals;
}

function forbiddenKeys(value, prefix = '') {
  if (!value || typeof value !== 'object') return [];
  const found = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (FORBIDDEN_INPUT_KEYS.has(key)) found.push(path);
    found.push(...forbiddenKeys(child, path));
  }
  return found;
}

function verifyProposal(proposal, nodeIndex) {
  const forbidden = forbiddenKeys(proposal).filter((key) => key !== 'tradeAuthorization');
  const blockers = [];
  if (forbidden.length) blockers.push('PROPOSAL_CONTAINS_FORBIDDEN_AUTHORITY_FIELDS');
  if (proposal?.proposalType !== ALLOWED_PROPOSAL_TYPE) blockers.push('UNSUPPORTED_PROPOSAL_TYPE');
  const harder = nodeIndex.get(String(proposal?.harderRuleHash || ''));
  const easier = nodeIndex.get(String(proposal?.easierRuleHash || ''));
  if (!harder || !easier) blockers.push('RULE_HASH_NOT_IN_IMMUTABLE_INPUT_SET');
  if (harder && easier) {
    if (!sameSemanticScope(harder, easier)) blockers.push('SEMANTIC_SCOPE_MISMATCH');
    const relation = harderAndEasier(harder, easier);
    if (!relation || relation.harder.ruleHash !== harder.ruleHash) {
      blockers.push('IMPLICATION_ORIENTATION_INVALID');
    }
  }
  let payoffProof = null;
  if (!blockers.length) {
    payoffProof = compilePayoffProof({
      relationType: RELATION_TYPES.IMPLIES,
      variables: [harder.ruleHash, easier.ruleHash],
      legs: [
        { predicateId: harder.ruleHash, outcome: 'NO' },
        { predicateId: easier.ruleHash, outcome: 'YES' },
      ],
    });
  }
  const ruleReviewBlockers = [];
  if (harder && easier) {
    if (!harder.timezone || !easier.timezone) ruleReviewBlockers.push('TIMEZONE_UNKNOWN');
    if (!harder.fallback || !easier.fallback) ruleReviewBlockers.push('FALLBACK_UNKNOWN');
    if (!harder.terminalTimeSemantics.certified
      || !easier.terminalTimeSemantics.certified) {
      ruleReviewBlockers.push('TERMINAL_TIME_SEMANTICS_UNKNOWN');
    }
    if (harder.eventId !== easier.eventId) ruleReviewBlockers.push('CROSS_EVENT_RULE_SCOPE_REQUIRES_REVIEW');
  }
  const abstractPayoffProved = blockers.length === 0
    && payoffProof?.valid === true && payoffProof.guaranteedMinPayout >= 1;
  return {
    verificationVersion: PROPOSER_VERSION,
    proposalId: proposal?.proposalId || null,
    proposalType: proposal?.proposalType || null,
    proposer: proposal?.proposer || 'UNSPECIFIED',
    harderRuleHash: harder?.ruleHash || proposal?.harderRuleHash || null,
    easierRuleHash: easier?.ruleHash || proposal?.easierRuleHash || null,
    abstractPayoffProved,
    payoffProof,
    proposalBlockers: [...new Set(blockers)].sort(),
    ruleReviewBlockers: [...new Set(ruleReviewBlockers)].sort(),
    status: blockers.length ? 'REJECTED_PROPOSAL'
      : ruleReviewBlockers.length ? 'ABSTRACT_PAYOFF_PROVED_RULE_REVIEW_REQUIRED'
        : 'READY_FOR_EXISTING_RULE_CERTIFIER',
    deterministicRuleCertified: false,
    economicAtDepth: false,
    tradeAuthorization: 'NONE',
  };
}

function auditProposals(rows, externalProposals = [], options = {}) {
  const nodes = rows.map(buildRuleNode).filter(Boolean);
  const nodeIndex = new Map(nodes.map((node) => [node.ruleHash, node]));
  const baseline = proposeOrderedThresholds(nodes, options);
  const external = externalProposals.map((proposal) => ({
    ...proposal,
    proposer: proposal.proposer || 'EXTERNAL_SEMANTIC_MODEL',
    proposalVersion: PROPOSER_VERSION,
    tradeAuthorization: 'NONE',
  }));
  const proposals = [...new Map([...baseline, ...external]
    .map((proposal) => [proposal.proposalId || hash(JSON.stringify(proposal)), proposal])).values()];
  const verifications = proposals.map((proposal) => verifyProposal(proposal, nodeIndex));
  const statusCounts = verifications.reduce((out, row) => {
    out[row.status] = (out[row.status] || 0) + 1; return out;
  }, {});
  return {
    format: PROPOSER_VERSION,
    generatedAt: options.generatedAt || new Date().toISOString(),
    sourceRuleRows: rows.length,
    typedThresholdNodes: nodes.length,
    proposals: proposals.length,
    crossEventProposals: proposals.filter((row) => row.crossEvent).length,
    statusCounts,
    deterministicRuleCertified: 0,
    executableCandidates: 0,
    tradeAuthorization: 'NONE',
    sample: verifications.slice(0, Number(options.sampleLimit || 100)),
    disclosure: 'Text or AI proposes immutable rule-hash relationships only. Abstract Boolean payout proof is not venue-rule certification and cannot authorize a quote or trade.',
  };
}

module.exports = {
  ALLOWED_PROPOSAL_TYPE,
  PROPOSER_VERSION,
  auditProposals,
  buildRuleNode,
  forbiddenKeys,
  harderAndEasier,
  proposeOrderedThresholds,
  replaceStrike,
  sameSemanticScope,
  subjectTemplate,
  verifyProposal,
};
