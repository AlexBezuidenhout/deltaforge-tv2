'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ADAPTERS, LegacyPaperAdapter } = require('../borg/shadow/legacy-paper-adapter');

function adapter() {
  return new LegacyPaperAdapter({
    pool: {}, insertRows: async () => 0, logEvent: async () => {},
    experimentRegistry: {
      resolve: (strategy) => ({
        experimentId: 'paper-comparators-main-george-v1',
        manifestHash: 'abc', family: 'legacy_execution_parity', arm: 'baseline',
        phase: 'pilot', strategyVersion: 'v1', strategy,
      }),
    },
  });
}

test('legacy comparator converts paper stake dollars to shares and preserves 0-1 price scale', () => {
  const row = adapter()._toOrder(ADAPTERS.main, {
    id: 99, user_id: 1, market_id: 'gamma-1', borg_market_id: 7,
    direction: 'YES', entry_price: '0.625', trade_size: '10.00',
    execution_type: 'SIMULATED', is_virtual: false, paper_trading: true,
    positive_label: 'UP', negative_label: 'DOWN',
    created_at: '2026-07-15T12:00:00.000Z', window_end: '2026-07-15T12:02:00.000Z',
  });
  assert.ok(row);
  assert.equal(row[8], 0.625);
  assert.equal(row[9], 16);
  assert.equal(row[3], 7);
  assert.equal(row[6], 'BUY');
  assert.equal(row[7], 'UP');
  assert.equal(row[14].startsWith('oi_'), true);
});

test('legacy comparator rejects live, virtual, unmapped, and invalid-price rows', () => {
  const base = {
    id: 1, borg_market_id: 7, direction: 'NO', entry_price: '0.4', trade_size: '10',
    execution_type: 'SIMULATED', is_virtual: false, paper_trading: true,
    created_at: '2026-07-15T12:00:00.000Z',
  };
  assert.equal(adapter()._toOrder(ADAPTERS.main, { ...base, paper_trading: false }), null);
  assert.equal(adapter()._toOrder(ADAPTERS.main, { ...base, execution_type: 'LIVE' }), null);
  assert.equal(adapter()._toOrder(ADAPTERS.main, { ...base, is_virtual: true }), null);
  assert.equal(adapter()._toOrder(ADAPTERS.main, { ...base, borg_market_id: null }), null);
  assert.equal(adapter()._toOrder(ADAPTERS.main, { ...base, entry_price: '60000' }), null);
});

test('legacy comparator conflict target matches the partial intent index', async () => {
  let conflictClause = null;
  let checkpointUpdate = null;
  const subject = new LegacyPaperAdapter({
    pool: { query: async (sql) => {
      checkpointUpdate = sql;
      return { rows: [] };
    } },
    insertRows: async (_table, _columns, _rows, clause) => {
      conflictClause = clause;
      return 1;
    },
    logEvent: async () => {},
    experimentRegistry: {
      resolve: (strategy) => ({
        experimentId: 'paper-comparators-main-george-v1',
        manifestHash: 'abc', family: 'legacy_execution_parity', arm: 'baseline',
        phase: 'pilot', strategyVersion: 'v1', strategy,
      }),
    },
  });
  subject._checkpoint = async () => ({ initialized: false, lastId: 0 });
  subject._sourceRows = async () => [{
    id: 99, user_id: 1, market_id: 'gamma-1', borg_market_id: 7,
    direction: 'YES', entry_price: '0.625', trade_size: '10.00',
    execution_type: 'SIMULATED', is_virtual: false, paper_trading: true,
    positive_label: 'UP', negative_label: 'DOWN',
    created_at: '2026-07-15T12:00:00.000Z', window_end: '2026-07-15T12:02:00.000Z',
  }];

  assert.equal(await subject._pollOne('main'), 1);
  assert.equal(
    conflictClause,
    'ON CONFLICT (intent_id) WHERE intent_id IS NOT NULL DO NOTHING'
  );
  assert.match(checkpointUpdate, /\$3::text/);
  assert.match(checkpointUpdate, /\$4::integer/);
});
