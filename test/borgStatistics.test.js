'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  clusterSignFlipPValue, clusteredBootstrap, holmAdjust, wilsonInterval,
} = require('../borg/research/statistics');

test('clustered statistics count markets rather than treating correlated orders as independent', () => {
  const rows = [
    { market: 'a', pnl: 1 }, { market: 'a', pnl: 2 },
    { market: 'b', pnl: 3 }, { market: 'c', pnl: 4 },
  ];
  const result = clusteredBootstrap(rows, 'market', 'pnl', { iterations: 1000 });
  assert.equal(result.clusters, 3);
  assert.equal(result.mean, 2.5);
  assert.ok(result.ci[0] != null && result.ci[1] != null);
  assert.ok(clusterSignFlipPValue(rows, 'market', 'pnl', { iterations: 1000 }) < 0.5);
});

test('Wilson intervals and Holm adjustment remain conservative at small n', () => {
  const [low, high] = wilsonInterval(1, 1);
  assert.ok(low < 0.5);
  assert.equal(high, 1);
  assert.deepEqual(holmAdjust([0.01, 0.03, 0.2]).map((x) => +x.toFixed(2)), [0.03, 0.06, 0.2]);
});
