'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  PHYSICAL_GRAPH_V2_UNIVERSE, buildExpandedPhysicalCandidates,
} = require('../borg/structural/physical-event-graph-v2');

const END = '2026-08-07T16:00:00.000Z';
const RESOLUTION = 'The primary resolution source for this market is the official statistics ' +
  'of the event as recognized by the governing body or event organizers. However, if the ' +
  'governing body or event organizers have not published final match statistics within 2 hours ' +
  'after the event conclusion, a consensus of credible reporting may be used instead. All markets ' +
  'will settle based on the official final result as recognized by the governing body or event ' +
  'organizers. Revisions to officially declared final scores made after market resolution will ' +
  'not be accounted for in determining the outcome.';
const SCOPE = 'This market refers only to the outcome within the first 90 minutes of regular play ' +
  'plus stoppage time. Extra time and penalty shoot-outs are excluded.';
const POSTPONED = 'If the game is postponed, this market will remain open until the game has been completed.';

function market(id, slug, question, groupItemTitle, description) {
  return { id, slug, conditionId: `condition-${id}`, question, groupItemTitle,
    outcomes: '["Yes","No"]', clobTokenIds: JSON.stringify([`${id}-yes`, `${id}-no`]),
    description, endDate: END, active: true, closed: false, acceptingOrders: true,
    orderMinSize: '5', feesEnabled: false };
}

function fixtures() {
  const shared = `${SCOPE} ${POSTPONED} ${RESOLUTION}`;
  return [
    { id: 'score-event', gameId: 'fixture-2', title: 'Alpha vs. Beta - Exact Score',
      endDate: END, markets: [market('score-10', 'alpha-beta-exact-score-1-0',
        'Exact Score: Alpha 1 - 0 Beta?', 'Alpha 1 - 0 Beta',
        `${shared} If the game is canceled entirely, with no make-up game, this market resolves to 0-0.`)] },
    { id: 'result-event', gameId: 'fixture-2', title: 'Alpha vs. Beta', endDate: END,
      markets: [
        market('home', 'alpha-beta-home', 'Will Alpha win?', 'Alpha',
          `${shared} If Alpha wins, this market will resolve to Yes. If the game is canceled entirely, with no make-up game, this market will resolve No.`),
        market('draw', 'alpha-beta-draw', 'Will Alpha vs. Beta end in a draw?', 'Draw (Alpha vs. Beta)',
          `${shared} If the game ends in a draw, this market will resolve to Yes. If the game is canceled entirely, with no make-up game, this market will resolve to Yes.`),
        market('away', 'alpha-beta-away', 'Will Beta win?', 'Beta',
          `${shared} If Beta wins, this market will resolve to Yes. If the game is canceled entirely, with no make-up game, this market will resolve No.`),
      ] },
    { id: 'more-event', gameId: 'fixture-2', title: 'Alpha vs. Beta - More Markets', endDate: END,
      markets: [market('btts', 'alpha-beta-btts', 'Alpha vs. Beta: Both Teams to Score',
        'Both Teams to Score', `${shared} This market resolves Yes if both teams score. ` +
        'If the game is canceled entirely, with no make-up game, this market will resolve 50-50.')] },
    { id: 'first-event', gameId: 'fixture-2', title: 'Alpha vs. Beta - First Team to Score',
      endDate: END, markets: ['home', 'away', 'neither'].map((role) => market(`first-${role}`,
        `alpha-beta-first-to-score-${role}`, `${role} first?`, role === 'home' ? 'Alpha'
          : role === 'away' ? 'Beta' : 'Neither', `${shared} If neither team scores, this market ` +
          'will resolve Neither. If the game is canceled entirely, with no make-up game, ' +
          'this market will resolve to Neither.')) },
  ];
}

test('expanded physical graph proves exact-score implications including cancellation', () => {
  const candidates = buildExpandedPhysicalCandidates(fixtures());
  assert.equal(candidates.length, 7);
  assert.ok(candidates.every((candidate) => candidate.universeId === PHYSICAL_GRAPH_V2_UNIVERSE));
  assert.ok(candidates.every((candidate) => candidate.ruleCertification.valid));
  assert.ok(candidates.every((candidate) => candidate.guaranteedMinPayout >= 1));
  const home = candidates.find((candidate) => candidate.legs[1].gammaId === 'home');
  assert.deepEqual(home.legs.map((entry) => entry.outcome), ['NO', 'YES']);
  assert.deepEqual(home.payoffVector, [1, 2, 1, 1]);
  const btts = candidates.find((candidate) => candidate.legs[1].gammaId === 'btts');
  assert.equal(btts.legs[1].outcome, 'NO');
});

test('expanded graph vetoes mismatched resolver policy', () => {
  const events = fixtures();
  events[1].markets[0].description = events[1].markets[0].description
    .replace('within 2 hours', 'within 3 hours');
  const home = buildExpandedPhysicalCandidates(events)
    .find((candidate) => candidate.legs[1].gammaId === 'home');
  assert.equal(home.ruleCertification.valid, false);
  assert.ok(home.ruleCertification.checks.includes('MIXED_RESOLUTION_POLICY'));
});
