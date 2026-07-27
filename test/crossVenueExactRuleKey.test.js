'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  compareExactRuleKeys,
} = require('../borg/crossvenue/exact-rule-key');

function poly(overrides = {}) {
  return {
    question: 'Will Bitcoin be at or above $100,000 at 4:00 PM ET on July 31, 2026?',
    description: [
      'Resolves from the Binance BTC/USDT closing price at 4:00 PM ET.',
      'If the value is unavailable, this market resolves No.',
    ].join(' '),
    endDate: '2026-07-31T20:00:00Z',
    ...overrides,
  };
}

function kalshi(overrides = {}) {
  return {
    title: 'Will Bitcoin be at or above $100,000 at 4:00 PM ET on July 31, 2026?',
    yesSubTitle: '$100,000 or above',
    rulesPrimary: [
      'Resolves from the Binance BTC/USDT closing price at 4:00 PM ET.',
      'If the value is unavailable, this market resolves No.',
    ].join(' '),
    expectedExpirationTime: '2026-07-31T20:00:00Z',
    settlementSources: [{ name: 'Binance', url: 'https://binance.com/' }],
    floorStrike: 100000,
    strikeType: 'greater_or_equal',
    ...overrides,
  };
}

test('complete equal rule dimensions produce a content-addressed candidate key', () => {
  const result = compareExactRuleKeys(poly(), kalshi());
  assert.equal(result.exactRuleEligible, true);
  assert.equal(result.hardMismatch, false);
  assert.match(result.candidateKey, /^cv-rule:[a-f0-9]{64}$/);
  assert.deepEqual(result.hardMismatchReasons, []);
  assert.deepEqual(result.kalshiRule.resolverCandidates, ['exchange:binance']);
});

test('a strike, resolver, time, or fallback conflict is an automatic veto', () => {
  const strike = compareExactRuleKeys(poly(), kalshi({
    title: 'Will Bitcoin be at or above $110,000 at 4:00 PM ET on July 31, 2026?',
    yesSubTitle: '$110,000 or above',
    floorStrike: 110000,
  }));
  assert.equal(strike.exactRuleEligible, false);
  assert.ok(strike.hardMismatchReasons.includes('SUBJECT_MISMATCH'));
  assert.ok(strike.hardMismatchReasons.includes('STRIKE_MISMATCH'));

  const resolver = compareExactRuleKeys(poly(), kalshi({
    rulesPrimary: 'Resolves from the CF Benchmarks closing price at 4:00 PM ET. If unavailable, resolves No.',
    settlementSources: [{ name: 'CF Benchmarks', url: 'https://cfbenchmarks.com/' }],
  }));
  assert.ok(resolver.hardMismatchReasons.includes('RESOLVER_MISMATCH'));

  const time = compareExactRuleKeys(poly(), kalshi({
    expectedExpirationTime: '2026-07-31T21:00:00Z',
  }));
  assert.ok(time.hardMismatchReasons.includes('OBSERVATIONAT_MISMATCH'));

  const fallback = compareExactRuleKeys(poly(), kalshi({
    rulesPrimary: 'Resolves from the Binance BTC/USDT closing price at 4:00 PM ET. If unavailable, resolves 50 50.',
  }));
  assert.ok(fallback.hardMismatchReasons.includes('FALLBACK_MISMATCH'));
});

test('strict and inclusive comparators are never treated as the same payoff', () => {
  const result = compareExactRuleKeys(poly({
    question: 'Will Bitcoin be above $100,000 at 4:00 PM ET on July 31, 2026?',
  }), kalshi());
  assert.equal(result.exactRuleEligible, false);
  assert.ok(result.hardMismatchReasons.includes('COMPARATOR_MISMATCH'));
});

test('structured subjects ignore harmless venue wording but retain all rule gates', () => {
  const evidence = {
    version: 'crossvenue-crypto-structured-v1',
    asset: 'btc',
    form: 'threshold',
    polyParsed: { strike: 100000 },
    kalshiParsed: { strike: 100000 },
  };
  const result = compareExactRuleKeys(
    poly({ question: 'Bitcoin at or above $100,000 at the July fixing?' }),
    kalshi({ title: 'BTC price on July 31', yesSubTitle: '$100,000 or above' }),
    evidence,
  );
  assert.equal(result.polyRule.key.subject, 'crypto:btc:threshold');
  assert.equal(result.kalshiRule.key.subject, 'crypto:btc:threshold');
  assert.equal(result.hardMismatchReasons.includes('SUBJECT_MISMATCH'), false);
});

test('structured pairing cannot hide an exclusive fractional Kalshi boundary', () => {
  const evidence = {
    version: 'crossvenue-crypto-structured-v1',
    asset: 'btc',
    form: 'threshold',
    polyParsed: { strike: 100000 },
    kalshiParsed: { strike: 100000, rawFloorStrike: 99999.99, strikeType: 'greater' },
  };
  const result = compareExactRuleKeys(
    poly({ question: 'Will Bitcoin be above $100,000 at 4:00 PM ET on July 31, 2026?' }),
    kalshi({
      title: 'BTC above $100,000 at 4:00 PM ET on July 31, 2026',
      yesSubTitle: 'Above $99,999.99',
      floorStrike: 99999.99,
      strikeType: 'greater',
    }),
    evidence,
  );
  assert.equal(result.exactRuleEligible, false);
  assert.ok(result.hardMismatchReasons.includes('STRIKE_MISMATCH'));
});

test('an additional fallback resolver cannot hide behind one shared source', () => {
  const result = compareExactRuleKeys(poly(), kalshi({
    rulesPrimary: [
      'Resolves from the Binance BTC/USDT closing price at 4:00 PM ET.',
      'Coinbase is an alternative source. If unavailable, resolves No.',
    ].join(' '),
  }));
  assert.equal(result.exactRuleEligible, false);
  assert.ok(result.hardMismatchReasons.includes('RESOLVER_AMBIGUOUS'));
});

test('missing rule dimensions fail closed instead of inheriting title similarity', () => {
  const result = compareExactRuleKeys({
    question: 'Will Alice win?',
    endDate: '2026-08-01T00:00:00Z',
  }, {
    title: 'Will Alice win?',
    expectedExpirationTime: '2026-08-01T00:00:00Z',
  });
  assert.equal(result.exactRuleEligible, false);
  assert.ok(result.hardMismatchReasons.some((reason) => reason.includes('MISSING_RESOLVER')));
  assert.ok(result.hardMismatchReasons.some((reason) => reason.includes('MISSING_TIMEZONE')));
  assert.ok(result.hardMismatchReasons.some((reason) => reason.includes('MISSING_FALLBACK')));
});
