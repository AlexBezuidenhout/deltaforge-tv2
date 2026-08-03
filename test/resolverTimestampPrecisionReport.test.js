'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderReport } = require('../scripts/resolver-timestamp-precision-audit');

test('R07 report makes the zero-capacity and authorization boundaries explicit', () => {
  const markdown = renderReport({
    generatedAt: '2026-08-03T14:41:30.000Z', boundedDays: 30,
    verdict: 'NO_MACHINE_CERTIFIED_TERMINAL_TICK_SEMANTICS',
    scannedRuleDocuments: 10, relevantPriceResolverRules: 9,
    certifiedIndependentRuleCutoffSourceUnits: 0,
    statusCounts: { CERTIFIED: 0, UNKNOWN: 9, CONFLICT: 0, NOT_RELEVANT: 1 },
    missingDimensions: { SOURCE_TIMESTAMP_PRECISION: 9 },
    feedCoverage: [], statewiseProvedEpisodes: 0,
    positiveDoubledCostEpisodes: 0, executableCapacityUsd: 0,
    disclosure: 'Unknown means excluded.',
  });
  assert.match(markdown, /cannot place paper or live orders/);
  assert.match(markdown, /positive after doubled costs: \*\*0\*\*/);
  assert.match(markdown, /executable capacity: \*\*\$0\.00\*\*/);
});
