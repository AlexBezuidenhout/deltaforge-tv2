'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  clusterInference, holmAdjust, inverseTerms, walkBook,
} = require('../scripts/borg-inverse-autopsy');

test('inverse terms preserve intended dollars and the original price cushion', () => {
  const terms = inverseTerms({ price: '0.62', size: '10' }, '0.60', '0.41');
  assert.equal(terms.intendedNotional, 6.2);
  assert.ok(Math.abs(terms.priceCushion - 0.02) < 1e-12);
  assert.ok(Math.abs(terms.limitPrice - 0.43) < 1e-12);
  assert.ok(Math.abs(terms.requestedSize * 0.41 - 6.2) < 1e-12);
});

test('book walk never fills above the preserved limit or beyond displayed depth', () => {
  const fill = walkBook([[0.40, 4], [0.41, 3], [0.43, 100]], 10, 0.41);
  assert.equal(fill.filled, true);
  assert.equal(fill.fillSize, 7);
  assert.equal(fill.partial, true);
  assert.ok(Math.abs(fill.fillPrice - (0.40 * 4 + 0.41 * 3) / 7) < 1e-12);
});

test('cluster inference is deterministic and detects uniformly positive markets', () => {
  const first = clusterInference([1, 2, 1.5, 0.8, 1.2], 1000, 42);
  const second = clusterInference([1, 2, 1.5, 0.8, 1.2], 1000, 42);
  assert.deepEqual(first, second);
  assert.ok(first.ci95[0] > 0);
});

test('Holm adjustment is monotone in ordered p-values', () => {
  const adjusted = holmAdjust([
    { key: 'a', p: 0.01 }, { key: 'b', p: 0.02 }, { key: 'c', p: 0.5 },
  ]);
  assert.equal(adjusted.a, 0.03);
  assert.equal(adjusted.b, 0.04);
  assert.equal(adjusted.c, 0.5);
});
