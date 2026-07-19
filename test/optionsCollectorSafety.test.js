'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { feeMetadata } = require('../borg/options/collector');

test('option observer parses the current dynamic fee schedule and fails unknown fees closed', () => {
  assert.deepEqual(feeMetadata({
    feesEnabled: true, feeSchedule: { rate: '0.05', exponent: '1' },
  }), { enabled: true, rate: 0.05, exponent: 1, known: true });
  assert.equal(feeMetadata({ feesEnabled: true }).known, false);
  assert.deepEqual(feeMetadata({ feesEnabled: false }), {
    enabled: false, rate: 0, exponent: 1, known: true,
  });
});

test('option observer has no live order or secret-key dependency', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'borg', 'options', 'collector.js'), 'utf8');
  assert.equal(source.includes('createAndPostOrder'), false);
  assert.equal(source.includes('POLY_PRIVATE_KEY'), false);
  assert.equal(source.includes('privateKey'), false);
  assert.equal(source.includes('authenticated'), true); // explicit documentation that it is absent
  assert.match(source, /new RawWal\('options-decisions'/);
  assert.match(source, /this\.decisionWal\.append[\s\S]*options_shadow_mark/);
});
