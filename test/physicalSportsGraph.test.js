'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { evaluateCandidate } = require('../borg/structural/condition-graph');
const {
  PHYSICAL_SPORTS_UNIVERSE_VERSION,
  buildPhysicalSportsCandidates,
} = require('../borg/structural/physical-event-graph');

const END = '2026-08-07T16:00:00.000Z';
const RESOLUTION = 'The primary resolution source for this market is the official statistics ' +
  'of the event as recognized by the governing body or event organizers. However, if the ' +
  'governing body or event organizers have not published final match statistics within 2 hours ' +
  'after the event conclusion, a consensus of credible reporting may be used instead. All markets ' +
  'will settle based on the official final result as recognized by the governing body or event ' +
  'organizers. Revisions to officially declared final scores made after market resolution will ' +
  'not be accounted for in determining the outcome.';
const SCOPE = 'This market considers only the final score at the end of 90 minutes of regulation plus ' +
  'stoppage time; extra time and penalty shoot-outs are excluded.';
const POSTPONED = 'If the game is postponed, this market will remain open until the game has been completed.';

function market(id, question, outcomes, tokens, description) {
  return {
    id, conditionId: `condition-${id}`, question, groupItemTitle: question,
    outcomes: JSON.stringify(outcomes), clobTokenIds: JSON.stringify(tokens),
    description, endDate: END, acceptingOrders: true, orderMinSize: 5,
  };
}

function fixture(options = {}) {
  const fixtureId = options.fixtureId || 'fixture-123';
  const exactCancellation = options.exactCancellation
    || 'If the game is canceled entirely with no make-up game, this market resolves to 0-0.';
  const totalResolution = options.totalResolution || RESOLUTION;
  return [
    {
      id: 'exact-event', gameId: fixtureId, title: 'Alpha vs. Beta - Exact Score', endDate: END,
      tags: [{ id: 1, slug: 'sports' }],
      markets: [market('exact-00', 'Exact Score: Alpha 0 - 0 Beta?', ['Yes', 'No'],
        ['exact-yes', 'exact-no'], `${SCOPE} ${POSTPONED} ${exactCancellation} ${RESOLUTION}`)],
    },
    {
      id: 'total-event', gameId: options.totalFixtureId || fixtureId,
      title: 'Alpha vs. Beta - More Markets', endDate: END,
      tags: [{ id: 1, slug: 'sports' }],
      markets: [market('total-05', 'Alpha vs. Beta: O/U 0.5', ['Over', 'Under'],
        ['over-05', 'under-05'], `${SCOPE} ${POSTPONED} If the game is canceled entirely with ` +
          `no make-up game, this market will resolve 50-50. ${totalResolution}`)],
    },
  ];
}

test('physical graph proves completed and fractional-cancellation payoff states', () => {
  const [candidate] = buildPhysicalSportsCandidates(fixture());
  assert.ok(candidate);
  assert.equal(candidate.universeId, PHYSICAL_SPORTS_UNIVERSE_VERSION);
  assert.equal(candidate.structureType, 'sports_exact00_over05_floor');
  assert.deepEqual(candidate.legs.map((entry) => entry.tokenId), ['exact-yes', 'over-05']);
  assert.deepEqual(candidate.payoffVector, [1, 1, 1.5]);
  assert.equal(candidate.guaranteedMinPayout, 1);
  assert.equal(candidate.ruleCertification.valid, true);
  assert.match(candidate.payoffProof.proofHash, /^[a-f0-9]{64}$/);
});

test('physical graph fails certification on different fixture, cancellation, or source policy', () => {
  assert.equal(buildPhysicalSportsCandidates(fixture({ totalFixtureId: 'other-fixture' })).length, 0);

  const [badCancellation] = buildPhysicalSportsCandidates(fixture({
    exactCancellation: 'If the game is canceled entirely with no make-up game, this market resolves 50-50.',
  }));
  assert.equal(badCancellation.ruleCertification.valid, false);
  assert.ok(badCancellation.ruleCertification.checks.includes('UNSUPPORTED_CANCELLATION_COMBINATION'));

  const [badSource] = buildPhysicalSportsCandidates(fixture({
    totalResolution: RESOLUTION.replace('within 2 hours', 'within 3 hours'),
  }));
  assert.equal(badSource.ruleCertification.valid, false);
  assert.ok(badSource.ruleCertification.checks.includes('MIXED_RESOLUTION_POLICY'));
});

test('physical graph vetoes participant team totals that only resemble the match total', () => {
  const events = fixture();
  events[1].markets[0].question = 'Alpha vs. Beta: Alpha O/U 0.5';
  events[1].markets[0].groupItemTitle = events[1].markets[0].question;
  assert.equal(buildPhysicalSportsCandidates(events).length, 0);
});

test('physical candidate remains subject to depth and non-atomic orphan reserve', () => {
  const [candidate] = buildPhysicalSportsCandidates(fixture());
  const now = Date.now();
  const books = new Map([
    ['exact-yes', { bids: [[0.44, 100]], asks: [[0.45, 100]], at: now, src: 'ws', minOrderSize: 5 }],
    ['over-05', { bids: [[0.44, 100]], asks: [[0.45, 100]], at: now, src: 'ws', minOrderSize: 5 }],
  ]);
  const result = evaluateCandidate(candidate, books, now, {
    targetNotionalUsd: 10,
    minCapacityProfitUsd: 0.05,
  });
  assert.equal(result.passProof, true);
  assert.equal(result.passFees2x, true);
  assert.equal(result.passFok, true);
  assert.equal(result.passOrphanRisk, true);
  assert.equal(result.qualified, true);
  assert.equal(result.bregman, null, 'fractional settlement is not forced into Boolean marginals');
});
