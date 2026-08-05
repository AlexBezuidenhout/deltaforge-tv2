'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  alignSeries,
  sessionHandoff,
  summarizeSignals,
} = require('../scripts/free-cex-mechanism-backtest');

test('free CEX alignment parses native price scales and produces basis-point returns', () => {
  const series = {};
  for (const asset of ['BTC', 'ETH', 'SOL', 'XRP']) {
    series[asset] = [
      { time: 0, close: '100', flow: '0.1', quoteVolume: '1000' },
      { time: 3_600_000, close: '101', flow: '0.2', quoteVolume: '1100' },
    ];
  }
  const rows = alignSeries(series);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].returns.BTC > 99 && rows[0].returns.BTC < 100);
  assert.equal(rows[0].close.BTC, 101);
});

test('doubled costs and chronological halves are charged per independent signal', () => {
  const summary = summarizeSignals([
    { time: Date.parse('2026-01-01T00:00:00Z'), direction: 1, futureBps: 100 },
    { time: Date.parse('2026-01-02T00:00:00Z'), direction: -1, futureBps: -100 },
  ], 500);
  assert.equal(summary.notionalPerSignalUsd, 250);
  assert.ok(Math.abs(summary.grossPnlUsd - 5) < 1e-12);
  assert.ok(Math.abs(summary.pnl2xUsd - 2.6) < 1e-12);
  assert.ok(summary.firstHalfPnl2xUsd > 0 && summary.secondHalfPnl2xUsd > 0);
});

test('session handoff is descriptive and does not manufacture a trading direction', () => {
  const rows = [{
    time: Date.parse('2026-01-01T08:00:00Z'),
    returns: { BTC: 1, ETH: 2, SOL: 3, XRP: 4 },
    quoteVolume: { BTC: 10, ETH: 20, SOL: 30, XRP: 40 },
  }];
  const result = sessionHandoff(rows).find((row) => row.utcHour === 8);
  assert.equal(result.observations, 1);
  assert.equal(result.byAsset.SOL.meanAbsoluteReturnBps, 3);
  assert.equal('direction' in result, false);
});
