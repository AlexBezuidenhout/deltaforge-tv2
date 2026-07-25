'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  activeStrategyAllowlist,
  filterStrategiesByAllowlist,
  filterStrategiesByDisposition,
} = require('../borg/research/strategy-policy');

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

test('an explicit research allowlist is strict and fail-closed on typos', () => {
  const strategies = [{ name: 'H43' }, { name: 'ETH_FORWARD' }, { name: 'OLD' }];
  const allowlist = activeStrategyAllowlist({
    BORG_ACTIVE_STRATEGIES: 'H43, ETH_FORWARD',
  });
  const result = filterStrategiesByAllowlist(strategies, allowlist);
  assert.deepEqual(result.active.map((row) => row.name), ['H43', 'ETH_FORWARD']);
  assert.deepEqual(result.excluded, [
    { strategy: 'OLD', status: 'NOT_IN_ACTIVE_RESEARCH_ALLOWLIST' },
  ]);
  assert.throws(
    () => filterStrategiesByAllowlist(strategies, new Set(['TYPO'])),
    /unknown strategies: TYPO/,
  );
});
