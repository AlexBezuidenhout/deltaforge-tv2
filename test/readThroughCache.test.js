'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createReadThroughCache } = require('../src/utils/readThroughCache');

test('read-through cache coalesces concurrent dashboard report loads', async () => {
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const cache = createReadThroughCache();
  const loader = async () => { calls += 1; await pending; return { rows: 3 }; };

  const first = cache.get('report', 10_000, loader);
  const second = cache.get('report', 10_000, loader);
  assert.equal(calls, 0, 'loader starts on the next microtask');
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await first, { rows: 3 });
  assert.deepEqual(await second, { rows: 3 });
  assert.equal(calls, 1);
});

test('read-through cache refreshes only after its TTL', async () => {
  let clock = 1_000;
  let calls = 0;
  const cache = createReadThroughCache({ now: () => clock });
  const loader = async () => ++calls;

  assert.equal(await cache.get('report', 100, loader), 1);
  clock = 1_099;
  assert.equal(await cache.get('report', 100, loader), 1);
  clock = 1_100;
  assert.equal(await cache.get('report', 100, loader), 2);
});
