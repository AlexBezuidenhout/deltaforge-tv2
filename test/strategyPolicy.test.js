'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  activeStrategyAllowlist,
  filterStrategiesByAllowlist,
  filterStrategiesByDisposition,
  loadActiveStrategies,
} = require('../borg/research/strategy-policy');

test('governance parks rejected strategies without deleting their implementations', () => {
  const strategies = [
    { name: 'candidate' },
    { name: 'failed' },
    { name: 'invalid' },
    { name: 'protocol' },
  ];
  const result = filterStrategiesByDisposition(strategies, [
    { strategy: 'failed', status: 'REJECTED_OUT_OF_SAMPLE' },
    { strategy: 'invalid', status: 'REJECTED_MECHANISM_INVALID' },
    { strategy: 'protocol', status: 'PROTOCOL_COMPLETION_ONLY' },
  ]);
  assert.deepEqual(result.active.map((row) => row.name), ['candidate']);
  assert.deepEqual(result.parked, [
    { strategy: 'failed', status: 'REJECTED_OUT_OF_SAMPLE' },
    { strategy: 'invalid', status: 'REJECTED_MECHANISM_INVALID' },
    { strategy: 'protocol', status: 'PROTOCOL_COMPLETION_ONLY' },
  ]);
  assert.equal(filterStrategiesByDisposition(strategies, [], { includeParked: true }).active.length, 4);
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

test('runtime policy reads only the latest trial disposition for each strategy', async () => {
  let sql = '';
  const pool = {
    async query(statement) {
      sql = statement;
      return {
        rows: [
          { strategy: 'fresh', status: 'COLLECTING' },
          { strategy: 'failed', status: 'NEGATIVE_CONTROL' },
        ],
      };
    },
  };
  const result = await loadActiveStrategies(
    pool,
    [{ name: 'fresh' }, { name: 'failed' }],
    {},
  );
  assert.match(sql, /DISTINCT ON \(strategy\)/);
  assert.match(sql, /ORDER BY strategy,frozen_at DESC,id DESC/);
  assert.deepEqual(result.active.map((row) => row.name), ['fresh']);
  assert.deepEqual(result.parked, [
    { strategy: 'failed', status: 'NEGATIVE_CONTROL' },
  ]);
});
