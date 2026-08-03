'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RULE_STATUS,
  TICK_POLICIES,
  classifyRuleDocument,
  selectTerminalTick,
  summarizeAudit,
  terminalTimeSemantics,
} = require('../borg/research/resolver-timestamp-precision');

function document(description, overrides = {}) {
  return {
    schema: 'polymarket-rule-document-v1',
    event: {
      id: 'event-1', title: 'Bitcoin Up or Down - 12:00-12:05 UTC',
      endDate: '2026-08-03T12:05:00.000Z',
      description,
      resolutionSource: 'https://data.chain.link/streams/btc-usd',
    },
    market: {
      id: 'market-1', conditionId: 'condition-1',
      question: 'Bitcoin Up or Down - 12:00-12:05 UTC',
      endDate: '2026-08-03T12:05:00.000Z',
      description,
      resolutionSource: 'https://data.chain.link/streams/btc-usd',
      ...overrides,
    },
  };
}

test('generic end-of-window language is not promoted into exact tick semantics', () => {
  const rule = classifyRuleDocument(document(
    'Resolves Up if the Chainlink BTC/USD data stream price at the end of the range is at least the opening price.',
  ), { ruleHash: 'abc' });
  assert.equal(rule.relevant, true);
  assert.equal(rule.status, RULE_STATUS.UNKNOWN);
  assert.ok(rule.missing.includes('SOURCE_TIMESTAMP_PRECISION'));
  assert.ok(rule.missing.includes('TERMINAL_TICK_POLICY'));
  assert.equal(rule.independentUnitKey, null);
});

test('an explicit source-clock policy can be machine certified', () => {
  const rule = classifyRuleDocument(document([
    'The source is the Chainlink BTC/USD data stream.',
    'Use the latest report with a source timestamp at or before 12:05:00 UTC.',
    'Chainlink source timestamps are evaluated with millisecond precision.',
  ].join(' ')), { ruleHash: 'def' });
  assert.equal(rule.status, RULE_STATUS.CERTIFIED);
  assert.equal(rule.resolver, 'chainlink');
  assert.equal(rule.timestampPrecision, 'millisecond');
  assert.equal(rule.terminalTickPolicy, TICK_POLICIES.LAST_AT_OR_BEFORE);
  assert.equal(rule.cutoffPolicy, 'AT_OR_BEFORE_INCLUSIVE');
  assert.match(rule.independentUnitKey, /^r07:[a-f0-9]{64}$/);
});

test('conflicting precision or tick policies fail closed', () => {
  const semantics = terminalTimeSemantics([
    'Use the latest price at or before the cutoff with millisecond precision.',
    'Alternatively use the first price after the cutoff with second precision.',
  ].join(' '));
  assert.equal(semantics.certified, false);
  assert.ok(semantics.conflicts.includes('CONFLICTING_SOURCE_TIMESTAMP_PRECISION'));
  assert.ok(semantics.conflicts.includes('CONFLICTING_TERMINAL_TICK_POLICY'));
});

test('terminal tick selection is causal and requires complete provenance', () => {
  const certification = classifyRuleDocument(document([
    'Chainlink BTC/USD is authoritative.',
    'Use the latest report with a source timestamp at or before 12:05:00 UTC.',
    'Source timestamps use millisecond precision.',
  ].join(' ')));
  const ticks = [
    {
      source_ts: '2026-08-03T12:04:59.900Z', received_at: '2026-08-03T12:05:00.050Z',
      receive_monotonic_ns: '100', connection_epoch: 4, event_sequence: 10, value: '100.5',
    },
    {
      source_ts: '2026-08-03T12:05:00.000Z', received_at: '2026-08-03T12:05:00.300Z',
      receive_monotonic_ns: '200', connection_epoch: 4, event_sequence: 11, value: '101',
    },
    {
      source_ts: '2026-08-03T12:05:00.001Z', received_at: '2026-08-03T12:05:00.100Z',
      receive_monotonic_ns: '150', connection_epoch: 4, event_sequence: 12, value: '99',
    },
  ];
  const early = selectTerminalTick(ticks, certification, '2026-08-03T12:05:00.200Z');
  assert.equal(early.selected.value, '100.5');
  assert.equal(early.sourceOffsetMs, -100);
  const later = selectTerminalTick(ticks, certification, '2026-08-03T12:05:00.400Z');
  assert.equal(later.selected.value, '101');
  assert.equal(later.sourceOffsetMs, 0);

  const missingProvenance = selectTerminalTick([
    { source_ts: '2026-08-03T12:05:00.000Z', received_at: '2026-08-03T12:05:00.100Z' },
  ], certification, '2026-08-03T12:05:01.000Z');
  assert.equal(missingProvenance.selected, null);
  assert.equal(missingProvenance.reason, 'NO_CAUSALLY_AVAILABLE_TERMINAL_TICK');
});

test('audit counts missing dimensions and does not fabricate capacity', () => {
  const generic = document('Chainlink BTC/USD price at the end determines the result.');
  const explicit = document([
    'Chainlink BTC/USD is authoritative.',
    'Use the latest report with a source timestamp at or before 12:05:00 UTC.',
    'Source timestamps use millisecond precision.',
  ].join(' '), { conditionId: 'condition-2' });
  const report = summarizeAudit([
    { rule_hash: 'one', rule_document: generic },
    { rule_hash: 'two', rule_document: explicit },
  ], [{
    source: 'chainlink_rtds', asset: 'btc', observations: '10',
    with_source_ts: '10', with_monotonic: '10', with_sequence: '10',
  }], { generatedAt: '2026-08-03T12:00:00.000Z' });
  assert.equal(report.relevantPriceResolverRules, 2);
  assert.equal(report.statusCounts.CERTIFIED, 1);
  assert.equal(report.statusCounts.UNKNOWN, 1);
  assert.equal(report.positiveDoubledCostEpisodes, 0);
  assert.equal(report.executableCapacityUsd, 0);
  assert.equal(report.feedCoverage[0].sequenceCoverage, 1);
});
