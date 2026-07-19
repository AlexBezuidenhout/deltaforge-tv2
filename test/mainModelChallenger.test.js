'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluate, model } = require('../src/bot/MainModelChallenger');

const input = {
  marketProbability: '0.52',
  legacyProbability: '0.61',
  heuristicProbability: '0.61',
  phiProbability: '0.58',
  remainingSec: '120',
  sigma5min: '0.0021',
};

test('Main challenger is a forward-only paired forecast with no trading path', () => {
  assert.equal(model.noTradingPath, true);
  assert.ok(new Date(model.trainingEnd) < new Date(model.evidenceStart));
  const before = evaluate(input, '2026-07-16T08:29:59.999Z');
  const after = evaluate(input, '2026-07-16T08:30:00.000Z');
  assert.equal(before.evidenceEligible, false);
  assert.equal(after.evidenceEligible, true);
  assert.equal(after.marketBaselineProbability, 0.52);
  assert.equal(after.legacyProbability, 0.61);
  assert.ok(after.residualProbability > 0 && after.residualProbability < 1);
  assert.equal('direction' in after, false);
  assert.equal('order' in after, false);
  assert.equal('size' in after, false);
});

test('Main challenger rejects invalid token/BTC-scale probabilities', () => {
  assert.equal(evaluate({ ...input, marketProbability: 60000 }), null);
});
