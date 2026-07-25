'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  NEGLECTED_PANEL_VERSION,
  neglectedPanelHash,
  selectNeglectedPanel,
} = require('../borg/allmarket/universe');

function market(index, overrides = {}) {
  return {
    conditionId: `condition-${String(index).padStart(2, '0')}`,
    eventId: index < 6 ? `event-${Math.floor(index / 3)}` : `event-${index}`,
    category: ['sports', 'politics', 'finance', 'weather', 'crypto', 'other'][index % 6],
    prices: [0.4, 0.6],
    tokenIds: [`yes-${index}`, `no-${index}`],
    orderMinSize: 5,
    rewardsMinSize: index % 4 === 0 ? 10 : 0,
    rewardsDailyRate: index % 4 === 0 ? 20 : 0,
    volume24h: index + 1,
    liquidity: 100 + index,
    endDate: '2026-08-30T00:00:00Z',
    active: true,
    closed: false,
    acceptingOrders: true,
    ...overrides,
  };
}

test('neglected panel is deterministic, PnL-independent and content hashed', () => {
  const universe = Array.from({ length: 24 }, (_, index) => market(index));
  const options = { maxMarkets: 12, nowMs: Date.parse('2026-07-21T00:00:00Z') };
  const first = selectNeglectedPanel(universe, options);
  const second = selectNeglectedPanel([...universe].reverse().map((row) => ({
    ...row, historicalPnl: 1_000_000, toxicity: -999,
  })), options);
  assert.equal(NEGLECTED_PANEL_VERSION, 'neglected-capacity-panel-v1');
  assert.deepEqual(first.map((row) => row.conditionId), second.map((row) => row.conditionId));
  assert.equal(neglectedPanelHash(first), neglectedPanelHash(second));
  assert.equal(first.length, 12);
  assert.ok(first.every((row) => row.selectionReason.startsWith('neglected:')));
});

test('capture panel rejects markets whose venue minimum exceeds the small-capacity scope', () => {
  const expensive = market(99, { conditionId: 'too-expensive', orderMinSize: 500, prices: [0.9, 0.1] });
  const universe = [expensive, ...Array.from({ length: 12 }, (_, index) => market(index))];
  const selected = selectNeglectedPanel(universe, {
    maxMarkets: 8,
    maxCapitalPerMarket: 100,
    nowMs: Date.parse('2026-07-21T00:00:00Z'),
  });
  assert.equal(selected.some((row) => row.conditionId === 'too-expensive'), false);
});

