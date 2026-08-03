'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { restoreMapBatch, takeMapBatch } = require('../borg/flow/collector');

test('global discovery SQL queue drains in bounded insertion batches', () => {
  const queue = new Map(Array.from({ length: 7 }, (_, index) => [`k${index}`, [`row${index}`]]));
  const batch = takeMapBatch(queue, 3);
  assert.deepEqual(batch.map(([key]) => key), ['k0', 'k1', 'k2']);
  assert.equal(queue.size, 4);
});

test('failed SQL batches restore WAL-authoritative rows without overwriting newer queue state', () => {
  const queue = new Map([['newer', ['replacement']]]);
  restoreMapBatch(queue, [['older', ['retry']], ['newer', ['stale']]]);
  assert.deepEqual(queue.get('older'), ['retry']);
  assert.deepEqual(queue.get('newer'), ['replacement']);
  assert.deepEqual([...queue.keys()], ['older', 'newer']);
});
