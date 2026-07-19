'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateObservation,
  nearestCausalDvol,
  normalCdf,
  selectOnePerEvent,
  thresholdFair,
  walkAsk,
} = require('../scripts/dvol-threshold-backtest');

test('digital fair value is monotonic in spot and centered near the strike', () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-6);
  const below = thresholdFair(99, 100, 50, 3600);
  const centered = thresholdFair(100, 100, 50, 3600);
  const above = thresholdFair(101, 100, 50, 3600);
  assert.ok(below < centered && centered < above);
});

test('book walking parses numeric levels and limits participation', () => {
  const fill = walkAsk([['0.50', '100'], ['0.51', '100']], 10);
  assert.equal(fill.cost, 10);
  assert.equal(fill.shares, 20);
  assert.ok(fill.fee > 0);
});

test('DVOL lookup is causal and refuses stale observations', () => {
  const candles = [{ time: 1000, close: 40 }, { time: 2000, close: 41 }];
  assert.equal(nearestCausalDvol(candles, 2500, 1000), 41);
  assert.equal(nearestCausalDvol(candles, 1500, 1000), 40);
  assert.equal(nearestCausalDvol(candles, 4000, 1000), null);
});

test('evaluation uses executable asks, exact fees and one best strike per event', () => {
  const base = {
    market_id: 1,
    event_key: 'event-1',
    asset: 'btc',
    horizon_seconds: 3600,
    ts: '2026-07-18T00:00:00Z',
    tte_sec: 3600,
    spot: 110,
    strike: 100,
    outcome: 'YES',
    up_asks: [[0.60, 100]],
    down_asks: [[0.90, 100]],
  };
  const first = evaluateObservation(base, 40);
  const second = evaluateObservation({ ...base, market_id: 2, strike: 105, up_asks: [[0.70, 100]] }, 40);
  assert.equal(first.side, 'YES');
  assert.ok(first.pnl1x > first.pnl2x);
  assert.equal(selectOnePerEvent([first, second]).length, 1);
});
