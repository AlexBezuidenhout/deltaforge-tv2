'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildStructuredPairs, canonicalKalshiStrike, parseKalshiCrypto, parsePolyCrypto,
} = require('../borg/crossvenue/crypto-structured');
const {
  applyPaperEvaluationPolicy, buildCandidates, selectMonitoredCandidates,
  selectPaperMonitoredCandidates,
} = require('../borg/crossvenue/universe');

const DEADLINE = '2026-07-19T17:00:00Z';

function kalshiThreshold(overrides = {}) {
  return {
    ticker: 'KXBTCD-26JUL1913-T72799.99', eventTicker: 'KXBTCD-26JUL1913',
    seriesTicker: 'KXBTCD', title: 'Bitcoin price on Jul 19, 2026?',
    yesSubTitle: '$72,800 or above', noSubTitle: '$72,800 or above',
    rulesPrimary: 'If the simple average of the sixty seconds of CF Benchmarks BRTI is above 72799.99, resolves Yes.',
    closeTime: DEADLINE, floorStrike: 72799.99, capStrike: null, strikeType: 'greater',
    liquidity: 0, volume24h: 0, canCloseEarly: true, provisional: false,
    ...overrides,
  };
}

function polyThreshold(overrides = {}) {
  return {
    conditionId: '0xabc', gammaId: '111', slug: 'will-bitcoin-be-above-72800-on-july-19',
    question: 'Will Bitcoin be above $72,800 on July 19?',
    eventTitle: 'Bitcoin price July 19', description: 'Resolution via oracle.',
    resolutionSource: null, resolvedBy: null, endDate: DEADLINE, category: 'crypto',
    yesToken: 'y1', noToken: 'n1', tickSize: 0.01, feeRate: 0, orderMinSize: 5,
    feeExponent: 1, liquidity: 1000, volume24h: 500,
    ...overrides,
  };
}

test('canonicalKalshiStrike shifts exclusive greater strikes to the inclusive boundary', () => {
  assert.equal(canonicalKalshiStrike(72799.99, 'greater'), 72800);
  assert.equal(canonicalKalshiStrike(72800, 'greater_or_equal'), 72800);
  assert.equal(canonicalKalshiStrike(null, 'greater'), null);
});

test('parseKalshiCrypto types thresholds, ranges, and 15m windows', () => {
  const threshold = parseKalshiCrypto(kalshiThreshold(), { ticker: 'KXBTCD', asset: 'btc', form: 'threshold' });
  assert.equal(threshold.strike, 72800);
  assert.equal(threshold.form, 'threshold');
  const range = parseKalshiCrypto(
    kalshiThreshold({ floorStrike: 64000, capStrike: 64500, strikeType: 'between' }),
    { ticker: 'KXBTC', asset: 'btc', form: 'range' });
  assert.deepEqual([range.lower, range.upper], [64000, 64500]);
  const updown = parseKalshiCrypto(
    kalshiThreshold({ floorStrike: 64533.61, strikeType: 'greater_or_equal' }),
    { ticker: 'KXBTC15M', asset: 'btc', form: 'updown_15m' });
  assert.equal(updown.strike, null);
  assert.equal(updown.form, 'updown_15m');
});

test('parsePolyCrypto reads slugs for 15m windows and questions for strikes', () => {
  const updown = parsePolyCrypto({ slug: 'btc-updown-15m-1784480400', question: 'Bitcoin Up or Down', endDate: DEADLINE });
  assert.equal(updown.form, 'updown_15m');
  assert.equal(updown.asset, 'btc');
  const threshold = parsePolyCrypto(polyThreshold());
  assert.equal(threshold.form, 'threshold');
  assert.equal(threshold.strike, 72800);
  const range = parsePolyCrypto(polyThreshold({
    question: 'Will Ethereum be between $3,300 and $3,400 on July 19?',
  }));
  assert.equal(range.form, 'range');
  assert.deepEqual([range.lower, range.upper], [3300, 3400]);
  assert.equal(range.asset, 'eth');
  assert.equal(parsePolyCrypto({ slug: 'x', question: 'Will it rain?', endDate: DEADLINE }), null);
});

test('buildStructuredPairs pairs only exact (asset, form, deadline, strike)', () => {
  const pairs = buildStructuredPairs([polyThreshold()], [kalshiThreshold()]);
  assert.equal(pairs.length, 1);
  assert.ok(pairs[0].structuredEvidence.reasons.includes('RESOLVER_SOURCE_DIFFERS'));
  assert.equal(buildStructuredPairs(
    [polyThreshold({ question: 'Will Bitcoin be above $73,000 on July 19?' })],
    [kalshiThreshold()]).length, 0, 'ladder neighbors must not pair');
  assert.equal(buildStructuredPairs(
    [polyThreshold({ endDate: '2026-07-19T18:00:00Z' })],
    [kalshiThreshold()]).length, 0, 'different deadlines must not pair');
});

test('structured candidates enter buildCandidates unapproved with provable evidence', () => {
  const candidates = buildCandidates([polyThreshold()], [kalshiThreshold()], { maxCandidates: 50 });
  const structured = candidates.filter((row) => row.identityStatus === 'STRUCTURED_CANDIDATE');
  assert.equal(structured.length, 1);
  assert.equal(structured[0].identityApproved, false);
  assert.equal(structured[0].relationApproved, false);
  assert.ok(structured[0].mismatches.includes('RESOLVER_SOURCE_DIFFERS'));
  assert.ok(structured[0].identityCertification.snapshotHash);
});

test('monitored selection still admits structured candidates as non-rejected rows', () => {
  const candidates = buildCandidates([polyThreshold()], [kalshiThreshold()], { maxCandidates: 50 });
  const selection = selectMonitoredCandidates(candidates, 6, 0);
  assert.ok(selection.monitored.some((row) => row.identityStatus === 'STRUCTURED_CANDIDATE'));
});

test('score policy approves only non-rejected rows strictly above 80% for paper evaluation', () => {
  const options = {
    paperScoreApproval: true, paperScoreFloor: 0.8,
    paperApprovedAt: '2026-07-19T21:14:45Z',
  };
  const approved = applyPaperEvaluationPolicy({
    matchId: 'approved', score: '0.800001', identityStatus: 'STRUCTURED_CANDIDATE',
    identityApproved: false, relationApproved: false,
    exactRuleEligible: true, hardMismatch: false,
  }, options);
  assert.equal(approved.paperEvalApproved, true);
  assert.equal(approved.paperEvalStatus, 'OPERATOR_APPROVED_PAPER_ONLY');
  assert.equal(approved.identityApproved, false);
  assert.equal(approved.relationApproved, false);
  assert.equal(approved.paperEvalApprovedAt, '2026-07-19T21:14:45.000Z');
  assert.equal(applyPaperEvaluationPolicy({
    matchId: 'floor', score: 0.8, identityStatus: 'CANDIDATE',
    exactRuleEligible: true, hardMismatch: false,
  }, options).paperEvalApproved, false);
  assert.equal(applyPaperEvaluationPolicy({
    matchId: 'rejected', score: 0.99, identityStatus: 'REJECTED',
  }, options).paperEvalApproved, false);
  const mismatch = applyPaperEvaluationPolicy({
    matchId: 'mismatch', score: 0.99, identityStatus: 'CANDIDATE',
    exactRuleEligible: false, hardMismatch: true,
  }, options);
  assert.equal(mismatch.paperEvalApproved, false);
  assert.equal(mismatch.paperEvalStatus, 'HARD_RULE_MISMATCH_VETO');
});

test('frozen exact-rule protocol needs no unrelated title-score threshold', () => {
  const approved = applyPaperEvaluationPolicy({
    matchId: 'exact', score: 0.4, identityStatus: 'CANDIDATE',
    exactRuleEligible: true, hardMismatch: false,
  }, {
    exactRuleApproval: true,
    paperScoreApproval: false,
    paperApprovedAt: '2026-07-27T00:00:00Z',
  });
  assert.equal(approved.paperEvalApproved, true);
  assert.equal(approved.paperEvalStatus, 'EXACT_RULE_KEY_APPROVED_PAPER_ONLY');
  assert.equal(approved.paperEvalSource, 'frozen_exact_rule_key_v2');
  assert.equal(approved.paperEvalThreshold, null);
});

test('paper monitoring prioritizes the complete approved cohort over exploratory reserves', () => {
  const candidates = Array.from({ length: 12 }, (_, index) => ({
    matchId: `paper-${index}`, score: 0.99 - index / 100,
    identityStatus: 'STRUCTURED_CANDIDATE', paperEvalApproved: true,
    relationApproved: false,
  })).concat([{
    matchId: 'exploratory', score: 0.79, identityStatus: 'CANDIDATE',
    paperEvalApproved: false, relationApproved: false,
  }]);
  const selection = selectPaperMonitoredCandidates(candidates, {
    maxMonitored: 13, exploratoryMonitored: 1, structuredMonitored: 0,
  });
  assert.equal(selection.monitored.filter((row) => row.paperEvalApproved).length, 12);
  assert.ok(selection.monitored.some((row) => row.matchId === 'exploratory'));
});
