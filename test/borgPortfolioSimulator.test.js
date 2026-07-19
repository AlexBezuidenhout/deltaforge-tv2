'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { simulatePortfolio } = require('../borg/research/portfolio-simulator');

function fill(overrides = {}) {
  return {
    orderId: '1', strategy: 'A', marketId: 'm1', token: 'UP', filled: true,
    fillTs: '2026-07-15T12:00:00Z', windowEnd: '2026-07-15T12:05:00Z',
    fillPrice: 0.5, fillSize: 20, pnl1x: 10, pnl2x: 9.5,
    capacityAtArrival: 20, capacityKey: 'm1:UP:1', ...overrides,
  };
}

test('shared portfolio enforces $500 capital, $10 target, and one owner per market', () => {
  const result = simulatePortfolio([
    fill(),
    fill({ orderId: '2', strategy: 'B', pnl1x: -10 }),
    fill({ orderId: '3', strategy: 'C', marketId: 'm2', token: 'DOWN', capacityKey: 'm2:DOWN:1' }),
  ]);
  assert.equal(result.startingBankroll, 500);
  assert.equal(result.maxGrossExposureUsd, 30);
  assert.equal(result.admittedOrders, 2);
  assert.equal(result.winningPositions, 2);
  assert.equal(result.losingPositions, 0);
  assert.equal(result.winRatePct, 100);
  assert.equal(result.rejectionReasons.MARKET_EXPOSURE_CONFLICT, 1);
  assert.equal(result.endingBankroll, 520);
});

test('shared portfolio does not allocate the same displayed liquidity twice', () => {
  const result = simulatePortfolio([
    fill({ fillSize: 10, capacityAtArrival: 10 }),
    fill({ orderId: '2', strategy: 'A', marketId: 'm2', capacityKey: 'm1:UP:1', fillSize: 10, capacityAtArrival: 10 }),
  ]);
  assert.equal(result.admittedOrders, 1);
  assert.equal(result.rejectionReasons.LIQUIDITY_ALREADY_CONSUMED, 1);
});
