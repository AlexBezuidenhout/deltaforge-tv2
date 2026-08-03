'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DECISIONS,
  HYPOTHESES,
  RUBRIC,
  renderMechanismMap,
  scoreHypothesis,
  topCandidates,
  validateHypotheses,
} = require('../borg/research/edge-mechanism-map');

test('mechanism registry contains at least 100 distinct complete hypotheses', () => {
  assert.equal(validateHypotheses(HYPOTHESES), true);
  assert.ok(HYPOTHESES.length >= 100);
  assert.equal(new Set(HYPOTHESES.map((row) => row.id)).size, HYPOTHESES.length);
});

test('fixed rubric sums to 100 and scoring is bounded', () => {
  assert.equal(Object.values(RUBRIC).reduce((sum, value) => sum + value, 0), 100);
  const perfect = scoreHypothesis(Object.fromEntries(Object.keys(RUBRIC).map((key) => [key, 5])));
  assert.equal(perfect.total, 100);
  assert.throws(() => scoreHypothesis({}));
});

test('top screen excludes blocked and rejected mechanisms and caps family concentration', () => {
  const top = topCandidates(HYPOTHESES, 10);
  assert.equal(top.length, 10);
  assert.ok(top.every((row) => ![
    DECISIONS.BLOCKED_DATA,
    DECISIONS.REJECTED_EXISTING_EVIDENCE,
    DECISIONS.REJECTED_MECHANISM,
  ].includes(row.decision)));
  const counts = new Map();
  for (const row of top) counts.set(row.family, (counts.get(row.family) || 0) + 1);
  assert.ok([...counts.values()].every((count) => count <= 2));
});

test('known failed mechanisms remain explicit and cannot re-enter the top screen', () => {
  const failed = ['C15', 'M04', 'M11', 'M12', 'D11', 'D12', 'N10', 'P07'];
  for (const id of failed) {
    const row = HYPOTHESES.find((item) => item.id === id);
    assert.ok(row, id);
    assert.ok(row.decision.startsWith('REJECTED_'));
  }
  assert.ok(!topCandidates(HYPOTHESES, 10).some((row) => failed.includes(row.id)));
});

test('rendered map labels scores as priorities rather than evidence', () => {
  const markdown = renderMechanismMap(HYPOTHESES, { generatedAt: '2026-08-03T00:00:00.000Z' });
  assert.match(markdown, /Scores allocate research effort; they are not backtest results/);
  assert.match(markdown, /S03 — Ordered-strike YES-low plus NO-high/);
  assert.match(markdown, /Primary sources/);
});
