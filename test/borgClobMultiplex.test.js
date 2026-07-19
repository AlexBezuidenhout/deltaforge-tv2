'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const ClobMultiplex = require('../borg/recon/clob-multiplex');

test('CLOB multiplex keeps complementary tokens together and balances markets', () => {
  const marketByToken = new Map([
    ['A_UP', 1], ['A_DOWN', 1],
    ['B_UP', 2], ['B_DOWN', 2],
    ['C_UP', 3], ['C_DOWN', 3],
  ]);
  const clob = new ClobMultiplex((token) => marketByToken.get(token), { shardCount: 3 });
  const groups = [];
  for (const shard of clob.shards) {
    shard.subscribe = (ids) => groups.push(ids);
  }

  clob.subscribe([...marketByToken.keys()]);

  assert.deepEqual(groups, [
    ['A_UP', 'A_DOWN'],
    ['B_UP', 'B_DOWN'],
    ['C_UP', 'C_DOWN'],
  ]);
  assert.equal(clob._shardIndex('A_UP'), clob._shardIndex('A_DOWN'));
});
