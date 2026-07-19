'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildStructuredSportsPairs, parseKalshiGameEvent, parsePolyGameSlug, teamsMatchBlob,
} = require('../borg/crossvenue/sports-structured');

function polyLeg(overrides = {}) {
  return {
    conditionId: '0xesp', gammaId: '201', slug: 'fifwc-esp-arg-2026-07-19-esp',
    question: 'Will Spain win on 2026-07-19?', eventTitle: 'Spain vs. Argentina',
    description: 'In the upcoming game, scheduled for July 19, 2026...',
    endDate: '2026-07-19T19:00:00Z', category: 'sports',
    yesToken: 'y', noToken: 'n', tickSize: 0.01, feeRate: 0, orderMinSize: 5,
    feeExponent: 1, liquidity: 4_000_000, volume24h: 1_000_000,
    resolutionSource: null, resolvedBy: null,
    ...overrides,
  };
}

function kalshiLeg(overrides = {}) {
  return {
    ticker: 'KXWCGAME-26JUL19ESPARG-ESP', eventTicker: 'KXWCGAME-26JUL19ESPARG',
    seriesTicker: 'KXWCGAME', title: 'Spain vs Argentina: Regulation Time Moneyline',
    yesSubTitle: 'Reg Time: Spain', noSubTitle: 'Reg Time: Spain',
    rulesPrimary: 'If Spain wins ... after 90 minutes plus stoppage time...',
    rulesSecondary: 'does not include extra time or penalties',
    closeTime: '2026-08-02T19:00:00Z', openTime: '2026-07-12T00:00:00Z',
    expectedExpirationTime: '2026-07-19T21:00:00Z',
    floorStrike: null, capStrike: null, strikeType: null,
    liquidity: 1000, volume24h: 1_500_000, canCloseEarly: true, provisional: false,
    ...overrides,
  };
}

test('parsePolyGameSlug reads league, teams, date, and leg', () => {
  assert.deepEqual(parsePolyGameSlug('fifwc-esp-arg-2026-07-19-esp'),
    { league: 'fifwc', teamA: 'esp', teamB: 'arg', date: '2026-07-19', leg: 'esp' });
  assert.equal(parsePolyGameSlug('fifwc-esp-arg-2026-07-19-draw').leg, 'draw');
  assert.equal(parsePolyGameSlug('fifwc-esp-arg-2026-07-19-fra'), null, 'leg must be a fixture team or draw');
  assert.equal(parsePolyGameSlug('btc-updown-15m-1784480400'), null);
});

test('parseKalshiGameEvent reads ticker dates with and without start times', () => {
  assert.deepEqual(parseKalshiGameEvent('KXWCGAME-26JUL19ESPARG', 'KXWCGAME'),
    { date: '2026-07-19', startTime: null, teamBlob: 'ESPARG' });
  assert.deepEqual(parseKalshiGameEvent('KXMLBGAME-26JUL172010SDKC', 'KXMLBGAME'),
    { date: '2026-07-17', startTime: '2010', teamBlob: 'SDKC' });
  assert.equal(parseKalshiGameEvent('KXWCGAME-26JUL19ESPARG', 'KXMLBGAME'), null);
});

test('teamsMatchBlob accepts either ordering and rejects partials', () => {
  assert.ok(teamsMatchBlob('esp', 'arg', 'ESPARG'));
  assert.ok(teamsMatchBlob('arg', 'esp', 'ESPARG'));
  assert.ok(!teamsMatchBlob('esp', 'fra', 'ESPARG'));
  assert.ok(!teamsMatchBlob('es', 'arg', 'ESPARG'), 'concatenation must be exact');
});

test('pairs winner and draw legs of the same fixture', () => {
  const poly = [
    polyLeg(),
    polyLeg({ conditionId: '0xdraw', slug: 'fifwc-esp-arg-2026-07-19-draw', question: 'Will Spain vs. Argentina end in a draw?' }),
  ];
  const kalshi = [
    kalshiLeg(),
    kalshiLeg({ ticker: 'KXWCGAME-26JUL19ESPARG-TIE', yesSubTitle: 'Reg Time: Tie' }),
    kalshiLeg({ ticker: 'KXWCGAME-26JUL19ESPARG-ARG', yesSubTitle: 'Reg Time: Argentina' }),
  ];
  const pairs = buildStructuredSportsPairs(poly, kalshi);
  assert.equal(pairs.length, 2);
  const byLeg = new Map(pairs.map((pair) => [pair.structuredEvidence.leg, pair]));
  assert.equal(byLeg.get('esp').kalshi.ticker, 'KXWCGAME-26JUL19ESPARG-ESP');
  assert.equal(byLeg.get('draw').kalshi.ticker, 'KXWCGAME-26JUL19ESPARG-TIE');
  assert.ok(pairs.every((pair) =>
    pair.structuredEvidence.reasons.includes('CANCELLATION_RESCHEDULE_RULES_DIFFER')));
});

test('tolerates one-day timezone skew only when the fixture is unique', () => {
  const skewed = buildStructuredSportsPairs([polyLeg({ slug: 'fifwc-esp-arg-2026-07-20-esp' })], [kalshiLeg()]);
  assert.equal(skewed.length, 1);
  assert.ok(skewed[0].structuredEvidence.reasons.includes('DATE_TIMEZONE_SKEW_TOLERATED'));
  // Doubleheader: two Kalshi games, same teams, adjacent dates — ambiguous.
  const double = buildStructuredSportsPairs([polyLeg({ slug: 'mlb-sd-kc-2026-07-18-sd' })], [
    kalshiLeg({
      seriesTicker: 'KXMLBGAME', eventTicker: 'KXMLBGAME-26JUL172010SDKC',
      ticker: 'KXMLBGAME-26JUL172010SDKC-SD', yesSubTitle: 'San Diego',
    }),
    kalshiLeg({
      seriesTicker: 'KXMLBGAME', eventTicker: 'KXMLBGAME-26JUL181310SDKC',
      ticker: 'KXMLBGAME-26JUL181310SDKC-SD', yesSubTitle: 'San Diego',
    }),
  ]);
  assert.equal(double.length, 1, 'exact-date match must win over the skewed sibling');
  assert.equal(double[0].kalshi.eventTicker, 'KXMLBGAME-26JUL181310SDKC');
});

test('never pairs across leagues even with matching team codes and dates', () => {
  const pairs = buildStructuredSportsPairs(
    [polyLeg({ slug: 'nwsl-sd-kc-2026-07-17-sd' })],
    [kalshiLeg({
      seriesTicker: 'KXMLBGAME', eventTicker: 'KXMLBGAME-26JUL172010SDKC',
      ticker: 'KXMLBGAME-26JUL172010SDKC-SD', yesSubTitle: 'San Diego',
    })]);
  assert.equal(pairs.length, 0);
});
