'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { filterStrategiesByDisposition } = require('../borg/research/strategy-policy');

test('governance parks rejected strategies without deleting their implementations', () => {
  const strategies = [{ name: 'candidate' }, { name: 'failed' }, { name: 'protocol' }];
  const result = filterStrategiesByDisposition(strategies, [
    { strategy: 'failed', status: 'REJECTED_OUT_OF_SAMPLE' },
    { strategy: 'protocol', status: 'PROTOCOL_COMPLETION_ONLY' },
  ]);
  assert.deepEqual(result.active.map((row) => row.name), ['candidate']);
  assert.deepEqual(result.parked, [
    { strategy: 'failed', status: 'REJECTED_OUT_OF_SAMPLE' },
    { strategy: 'protocol', status: 'PROTOCOL_COMPLETION_ONLY' },
  ]);
  assert.equal(filterStrategiesByDisposition(strategies, [], { includeParked: true }).active.length, 3);
});
