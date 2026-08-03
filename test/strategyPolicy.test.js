'use strict';

const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const makeStrategies = require('../borg/shadow/strategies');
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

test('VPS allowlist is restricted to the frozen priority and fresh worthy successors', () => {
  const service = fs.readFileSync(
    require.resolve('../ops/vps/borg-collector.service'),
    'utf8',
  );
  const line = service.split('\n')
    .find((value) => value.startsWith('Environment=BORG_ACTIVE_STRATEGIES='));
  assert.ok(line);
  const allowlist = activeStrategyAllowlist({
    BORG_ACTIVE_STRATEGIES: line.split('=').slice(2).join('='),
  });
  assert.deepEqual([...allowlist].sort(), [
    'H43X_chainlink_tail_residual_v1',
    'H43_resolution_boundary_buffer',
    'MAIN_LONGSHOT_0_20_V1',
    'NEXT_H54_dynamic_ofi_resolver_confirm_v1',
    'NEXT_H7_btc_oracle_confirm_v1',
  ]);
  assert.equal(allowlist.has('MAIN_VIDEO_PARITY_V1__taker250'), false);
  assert.equal(allowlist.has('MAIN_VIDEO_PARITY_V1__postonly'), false);
  assert.equal(allowlist.has('H58_resolver_event_stale_quote'), false);
  assert.equal(allowlist.has('H59_resolver_cross_persistence'), false);
  assert.doesNotThrow(() => filterStrategiesByAllowlist(makeStrategies(), allowlist));
});
