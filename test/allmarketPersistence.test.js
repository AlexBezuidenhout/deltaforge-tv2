'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  coalesceScoreRows, isTransientUniverseError, lastRowsByKey, universeRefreshSeverity,
} = require('../borg/allmarket/collector');

test('inventory persistence keeps one final row per conflict key', () => {
  const rows = [
    ['run', 'market', 'asset', 'YES', 1, 0.5],
    ['run', 'market', 'asset', 'YES', 2, 1.0],
    ['run', 'market', 'other', 'NO', 1, 0.4],
  ];
  const unique = lastRowsByKey(rows, (row) => row.slice(0, 3).join('|'));
  assert.equal(unique.length, 2);
  assert.deepEqual(unique[0], rows[1]);
});

test('score persistence coalesces markout updates for one intent', () => {
  const first = Array(23).fill(null);
  first[0] = 'intent'; first[1] = true; first[8] = 0.51;
  first[11] = 0.1; first[21] = JSON.stringify({ mark1: true });
  const second = Array(23).fill(null);
  second[0] = 'intent'; second[9] = 0.53;
  second[12] = 0.2; second[21] = JSON.stringify({ mark5: true });
  const [merged] = coalesceScoreRows([first, second]);
  assert.equal(merged[8], 0.51);
  assert.equal(merged[9], 0.53);
  assert.equal(merged[11], 0.1);
  assert.equal(merged[12], 0.2);
  assert.deepEqual(JSON.parse(merged[21]), { mark1: true, mark5: true });
});

test('a single Gamma timeout retains a live frozen panel without hiding an outage', () => {
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  assert.equal(isTransientUniverseError(error), true);
  assert.equal(universeRefreshSeverity({
    error,
    selectedMarkets: 20,
    consecutiveTimeouts: 1,
    lastSuccessAt: 1_000,
    now: 2_000,
    maxStaleMs: 10_000,
  }), 'WARN');
  assert.equal(universeRefreshSeverity({
    error,
    selectedMarkets: 20,
    consecutiveTimeouts: 3,
    lastSuccessAt: 1_000,
    now: 2_000,
    maxStaleMs: 10_000,
  }), 'ERROR');
  assert.equal(universeRefreshSeverity({
    error: new Error('schema mismatch'),
    selectedMarkets: 20,
    consecutiveTimeouts: 0,
    lastSuccessAt: 1_000,
    now: 2_000,
    maxStaleMs: 10_000,
  }), 'ERROR');
});
