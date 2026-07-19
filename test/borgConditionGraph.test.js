'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildConditionGraph, evaluateCandidate, STRUCTURAL_UNIVERSE_VERSION,
} = require('../borg/structural/condition-graph');
const { createRuleDocument } = require('../borg/structural/rule-certifier');

function market(id, label, options = {}) {
  return {
    id,
    groupItemTitle: label,
    question: label,
    outcomes: JSON.stringify(['Yes', 'No']),
    clobTokenIds: JSON.stringify([`yes-${id}`, `no-${id}`]),
    conditionId: `condition-${id}`,
    acceptingOrders: true,
    orderMinSize: 5,
    ...options,
  };
}

test('condition graph builds algebraic nested, disjoint, and explicit complete sets', () => {
  const graph = buildConditionGraph([
    { id: 'thresholds', title: 'BTC above ___', markets: [market(1, '$90,000'), market(2, '$100,000')] },
    { id: 'ranges', title: 'BTC price on Friday', markets: [market(3, '$80,000-$90,000'), market(4, '$100,000-$110,000')] },
    { id: 'exclusive', title: 'ETH closing bucket', negRisk: true,
      markets: [market(5, 'Below $2,000', { negRisk: true }), market(6, 'Above $2,000', { negRisk: true })] },
  ]);
  const nested = graph.find((candidate) => candidate.structureType === 'nested_threshold');
  assert.deepEqual(nested.payoffVector, [1, 2, 1]);
  assert.deepEqual(nested.legs.map((entry) => entry.outcome), ['YES', 'NO']);
  const disjoint = graph.find((candidate) => candidate.structureType === 'disjoint_ranges');
  assert.deepEqual(disjoint.payoffVector, [2, 1, 1]);
  assert.equal(disjoint.payoffProof.valid, true);
  assert.match(disjoint.payoffProof.proofHash, /^[a-f0-9]{64}$/);
  const complete = graph.find((candidate) => candidate.structureType === 'complete_mutually_exclusive_set');
  assert.equal(complete.complete, true);
  assert.equal(complete.legs.length, 2);
  assert.equal(complete.ruleCertification.valid, true);
  assert.equal(complete.universeId, 'structural-certified-payoff-graph-v3');
  assert.equal(STRUCTURAL_UNIVERSE_VERSION, 'structural-certified-payoff-graph-v3');
});

test('augmented negRisk sets fail closed as complete payoff identities', () => {
  const graph = buildConditionGraph([{
    id: 'augmented', title: 'World Cup winner', negRisk: true,
    enableNegRisk: true, negRiskAugmented: true,
    markets: [
      market(1, 'Spain', { negRisk: true }),
      market(2, 'England', { negRisk: true }),
    ],
  }]);
  const complete = graph.find((candidate) =>
    candidate.structureType === 'complete_mutually_exclusive_set');
  assert.ok(complete);
  assert.equal(complete.ruleCertification.valid, false);
  assert.ok(complete.ruleCertification.checks.includes('AUGMENTED_NEGRISK_NOT_EXHAUSTIVE'));
  const result = evaluateCandidate(complete, new Map(), Date.now());
  assert.equal(result.passRuleCertification, false);
  assert.equal(result.passProof, false);
  assert.equal(result.economicCandidate, false);
});

test('rule documents are content-addressed and rule changes create new candidate identities', () => {
  const event = { id: 'rules', title: 'BTC above ___' };
  const first = market(1, '$90,000', { description: 'Uses exchange A closing price.' });
  const same = market(1, '$90,000', { description: 'Uses exchange A closing price.' });
  const changed = market(1, '$90,000', { description: 'Uses exchange B closing price.' });
  assert.equal(createRuleDocument(event, first).ruleHash, createRuleDocument(event, same).ruleHash);
  assert.notEqual(createRuleDocument(event, first).ruleHash, createRuleDocument(event, changed).ruleHash);
  const firstId = buildConditionGraph([{ ...event, markets: [first] }])[0].candidateId;
  const changedId = buildConditionGraph([{ ...event, markets: [changed] }])[0].candidateId;
  assert.notEqual(firstId, changedId);
});

test('scanner separates 2x-fee economics, FOK capacity, and non-atomic orphan risk', () => {
  const candidate = buildConditionGraph([{ id: 'one', title: 'Binary', markets: [market(1, 'Yes or no')] }])
    .find((entry) => entry.structureType === 'binary_complement');
  const now = Date.now();
  const books = new Map([
    ['yes-1', { asks: [[0.45, 100]], at: now, src: 'ws' }],
    ['no-1', { asks: [[0.45, 100]], at: now, src: 'ws' }],
  ]);
  const result = evaluateCandidate(candidate, books, now, {
    targetNotionalUsd: 10, minCapacityProfitUsd: 0.05,
  });
  assert.equal(result.passStale, true);
  assert.equal(result.passFees2x, true);
  assert.equal(result.passFok, true);
  assert.equal(result.passCapacity, true);
  assert.equal(result.economicCandidate, true);
  assert.equal(result.passOrphanRisk, false);
  assert.equal(result.qualified, false);
  assert.ok(result.orphanLossStressUsd > 0);
});

test('fee-enabled candidates fail closed when the current schedule is absent', () => {
  const candidate = buildConditionGraph([{ id: 'fees', title: 'Binary', markets: [
    market(1, 'Yes or no', { feesEnabled: true }),
  ] }]).find((entry) => entry.structureType === 'binary_complement');
  const now = Date.now();
  const books = new Map([
    ['yes-1', { bids: [[0.44, 100]], asks: [[0.45, 100]], at: now }],
    ['no-1', { bids: [[0.44, 100]], asks: [[0.45, 100]], at: now }],
  ]);
  const result = evaluateCandidate(candidate, books, now);
  assert.equal(result.passFeeSchedule, false);
  assert.equal(result.passFees2x, false);
  assert.equal(result.economicCandidate, false);
});

test('condition graph fails closed on dates and mixed percentage operators', () => {
  const graph = buildConditionGraph([
    {
      id: 'dates', title: 'When will Mojtaba Khamenei be first seen?',
      markets: [market(1, 'By September 30'), market(2, 'By December 31')],
    },
    {
      id: 'margins', title: 'What will the election victory margin be?',
      markets: [market(3, 'Under 10%'), market(4, 'Over 30%')],
    },
  ]);
  assert.equal(graph.filter((candidate) => candidate.structureType === 'nested_threshold').length, 0);
  assert.equal(graph.filter((candidate) => candidate.structureType === 'disjoint_ranges').length, 0);
  assert.equal(graph.filter((candidate) => candidate.structureType === 'binary_complement').length, 4);
});

test('generic $1 settlement prose cannot turn dates or margins into price ladders', () => {
  const settlement = 'This market pays $1 if the named condition is satisfied and $0 otherwise.';
  const graph = buildConditionGraph([
    {
      id: 'dates-with-payout', title: 'Mojtaba Khamenei public appearance by...?',
      description: settlement,
      markets: [
        market(1, 'Seen in public by September 30', { description: settlement }),
        market(2, 'Seen in public by December 31', { description: settlement }),
      ],
    },
    {
      id: 'margin-with-payout', title: 'NY-10 Democratic Primary Margin of Victory',
      description: settlement,
      markets: [
        market(3, 'Win by less than 10%', { description: settlement }),
        market(4, 'Win by more than 30%', { description: settlement }),
      ],
    },
  ]);
  assert.equal(graph.some((candidate) => candidate.structureType === 'nested_threshold'), false);
  assert.equal(graph.some((candidate) => candidate.structureType === 'disjoint_ranges'), false);
});

test('below-price thresholds reverse the legs and retain a proved minimum payout', () => {
  const graph = buildConditionGraph([{
    id: 'below-prices', title: 'What will the BTC closing price be below?',
    markets: [market(1, 'Below $90,000'), market(2, 'Below $100,000')],
  }]);
  const nested = graph.find((candidate) => candidate.structureType === 'nested_threshold');
  assert.deepEqual(nested.legs.map((entry) => entry.outcome), ['NO', 'YES']);
  assert.deepEqual(nested.payoffVector, [1, 2, 1]);
  assert.equal(nested.guaranteedMinPayout, 1);
});

test('sports universe proves ordered totals and keeps non-YES moneylines as binary complements', () => {
  const sportsEvent = {
    id: 'game-1', title: 'France vs. England - More Markets',
    tags: [{ id: '1', slug: 'sports' }],
    markets: [
      market('moneyline', 'France vs. England', {
        outcomes: JSON.stringify(['France', 'England']),
        clobTokenIds: JSON.stringify(['france-win', 'england-win']),
        description: 'France wins the named full match; standard cancellation rules apply.',
      }),
      market('total-15', 'France vs. England: O/U 1.5', {
        outcomes: JSON.stringify(['Over', 'Under']),
        clobTokenIds: JSON.stringify(['over-15', 'under-15']),
        description: 'Over 1.5 total goals in the named full match; standard cancellation rules apply.',
      }),
      market('total-25', 'France vs. England: O/U 2.5', {
        outcomes: JSON.stringify(['Over', 'Under']),
        clobTokenIds: JSON.stringify(['over-25', 'under-25']),
        description: 'Over 2.5 total goals in the named full match; standard cancellation rules apply.',
      }),
    ],
  };
  const graph = buildConditionGraph([sportsEvent]);
  const total = graph.find((candidate) => candidate.structureType === 'sports_total_ladder');
  assert.ok(total);
  assert.deepEqual(total.legs.map((entry) => entry.tokenId), ['over-15', 'under-25']);
  assert.deepEqual(total.payoffVector, [1, 2, 1]);
  assert.equal(total.universeClass, 'sports');
  const moneyline = graph.find((candidate) => candidate.structureType === 'binary_complement'
    && candidate.legs.some((entry) => entry.tokenId === 'france-win'));
  assert.deepEqual(moneyline.legs.map((entry) => entry.tokenId), ['france-win', 'england-win']);
});

test('sports spread ladder maps the listed participant to strict and lenient executable tokens', () => {
  const graph = buildConditionGraph([{
    id: 'game-2', title: 'France vs. England - More Markets',
    tags: [{ id: 1, slug: 'sports' }],
    markets: [
      market('spread-15', 'Spread: France (-1.5)', {
        outcomes: JSON.stringify(['France', 'England']),
        clobTokenIds: JSON.stringify(['france-minus-15', 'england-plus-15']),
        description: 'France receives a -1.5 goal handicap in the full match.',
      }),
      market('spread-25', 'Spread: France (-2.5)', {
        outcomes: JSON.stringify(['France', 'England']),
        clobTokenIds: JSON.stringify(['france-minus-25', 'england-plus-25']),
        description: 'France receives a -2.5 goal handicap in the full match.',
      }),
    ],
  }]);
  const spread = graph.find((candidate) => candidate.structureType === 'sports_spread_ladder');
  assert.ok(spread);
  assert.deepEqual(spread.legs.map((entry) => entry.tokenId), [
    'france-minus-15', 'england-plus-25',
  ]);
  assert.deepEqual(spread.payoffVector, [1, 2, 1]);
});

test('sports ordered predicates fail closed across different periods or rule templates', () => {
  const graph = buildConditionGraph([{
    id: 'game-3', title: 'Tennis match', tags: [{ id: 1, slug: 'sports' }],
    markets: [
      market('set-one-85', 'Set 1 Games O/U 8.5', {
        outcomes: JSON.stringify(['Over', 'Under']),
        clobTokenIds: JSON.stringify(['a', 'b']), description: 'Set 1 total games over 8.5.',
      }),
      market('match-95', 'Match Games O/U 9.5', {
        outcomes: JSON.stringify(['Over', 'Under']),
        clobTokenIds: JSON.stringify(['c', 'd']), description: 'Full match total games over 9.5 including retirement.',
      }),
    ],
  }]);
  assert.equal(graph.some((candidate) => candidate.structureType === 'sports_total_ladder'), false);
});
