'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyDelta,
  nearestTouch,
  normLevels,
  simulateArrival,
} = require('../scripts/flow-wal-latency-replay');

test('WAL replay normalizes books and applies price changes causally', () => {
  const book = { asks: normLevels([{ price: '0.52', size: '10' }, { price: '0.51', size: '5' }]), bids: [] };
  assert.equal(book.asks[0][0], 0.51);
  assert.equal(applyDelta(book, { side: 'SELL', price: '0.51', size: '0' }), true);
  assert.equal(book.asks[0][0], 0.52);
});

test('nearest touch never looks beyond the simulated arrival', () => {
  const history = [{ at: 100, bestAsk: 0.5 }, { at: 200, bestAsk: 0.6 }];
  assert.equal(nearestTouch(history, 150).bestAsk, 0.5);
  assert.equal(nearestTouch(history, 250).bestAsk, 0.6);
});

test('arrival simulation parses Postgres decimals and charges terminal entry fees', () => {
  const signal = {
    available_at: '2026-07-18T00:00:00.000Z',
    window_end: '2026-07-18T00:00:10.000Z',
    target_outcome: 'UP', outcome: 'UP', fee_rate: '0.07',
  };
  const fill = simulateArrival(signal, {
    at: Date.parse(signal.available_at), bestAsk: '0.50', askSize: '100',
  }, 0);
  assert.equal(fill.filled, true);
  assert.equal(fill.notional, 10);
  assert.ok(fill.pnl1x > fill.pnl2x);
  assert.equal(simulateArrival({ ...signal, window_end: signal.available_at }, {
    at: Date.parse(signal.available_at), bestAsk: '0.50', askSize: '100',
  }, 0).reason, 'arrival_at_or_after_resolution_boundary');
});
