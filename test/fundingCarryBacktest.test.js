'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fetchPage,
  maxDrawdown,
  retryAfterMs,
  rollingMinimum,
  summarizeCarry,
} = require('../scripts/funding-carry-backtest');

test('funding carry charges both spot and perp round trips and parses decimal strings', () => {
  const rows = [
    { time: Date.parse('2026-07-01T00:00:00Z'), fundingRate: '0.001' },
    { time: Date.parse('2026-07-02T00:00:00Z'), fundingRate: '-0.0002' },
  ];
  const summary = summarizeCarry(rows, {
    capitalUsd: 1000,
    notionalFraction: 0.5,
    spotTakerBps: 10,
    perpTakerBps: 5,
    slippageBpsPerLeg: 2,
    basisStressBps: 10,
  });
  assert.ok(Math.abs(summary.grossFundingPnl - 0.4) < 1e-12);
  assert.ok(Math.abs(summary.estimatedRoundTripCost - 1.9) < 1e-12);
  assert.ok(summary.netAfterStress < summary.netAfterEstimatedCosts);
});

test('drawdown and rolling loss calculations preserve adverse funding regimes', () => {
  assert.equal(maxDrawdown([2, -1, -4, 1]), -5);
  assert.equal(rollingMinimum([2, -1, -4, 1], 2), -5);
});

test('funding history retries rate limits without hiding terminal failures', async () => {
  const waits = [];
  let calls = 0;
  const rows = await fetchPage('BTC', 1, 2, {
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          status: 429,
          headers: { get: () => '0.25' },
        };
      }
      return { ok: true, status: 200, json: async () => [{ time: 1, fundingRate: '0.1' }] };
    },
    waitImpl: async (milliseconds) => waits.push(milliseconds),
  });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [250]);
  assert.equal(rows[0].fundingRate, '0.1');

  await assert.rejects(() => fetchPage('SOL', 1, 2, {
    fetchImpl: async () => ({ ok: false, status: 400, headers: { get: () => null } }),
    waitImpl: async () => assert.fail('non-retryable response must not wait'),
  }), /HTTP 400.*1 attempt/);
});

test('Retry-After parser accepts seconds and HTTP dates', () => {
  assert.equal(retryAfterMs('1.5', 0), 1500);
  assert.equal(retryAfterMs('Thu, 01 Jan 1970 00:00:02 GMT', 1000), 1000);
  assert.equal(retryAfterMs('not-a-date', 0), null);
});
