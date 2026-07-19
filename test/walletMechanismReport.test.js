'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  pairedBuyUpperBound, summarizeActivity, summarizeLeaderboards, summarizeTape,
} = require('../scripts/wallet-mechanism-report');

test('wallet activity parses Data API numeric strings by period', () => {
  const now = 1_000_000;
  const summary = summarizeActivity([
    { timestamp: now - 10, usdcSize: '12.50' },
    { timestamp: now - 2 * 86_400, size: '7.25' },
  ], now);
  assert.deepEqual(summary.DAY, { actions: 1, usd: 12.5 });
  assert.deepEqual(summary.WEEK, { actions: 2, usd: 19.75 });
});

test('wallet leaderboard keeps authoritative PnL separate from volume', () => {
  const report = summarizeLeaderboards([{
    period: 'DAY', category: 'OVERALL', payload: { rank: '5', pnl: '100', vol: '10000' },
  }]);
  assert.equal(report.DAY.OVERALL.pnlUsd, 100);
  assert.equal(report.DAY.OVERALL.pnlPerVolume, 0.01);
});

test('paired-buy diagnostic is explicitly a non-synchronous upper bound', () => {
  const rows = [
    { conditionId: 'c', outcome: 'Yes', side: 'BUY', size: '10', price: '0.40', timestamp: 100 },
    { conditionId: 'c', outcome: 'No', side: 'BUY', size: '8', price: '0.50', timestamp: 101 },
    { conditionId: 'c', outcome: 'No', side: 'SELL', size: '2', price: '0.60', timestamp: 102 },
  ];
  const result = pairedBuyUpperBound(rows, { startSec: 0 });
  assert.equal(result.conditionsWithBothOutcomes, 1);
  assert.equal(result.pairableShares, 8);
  assert.equal(result.grossNonSynchronousUpperBoundUsd, 0.8);
  assert.match(result.label, /NOT_EXECUTABLE_PNL/);
});

test('maker share diagnostic uses taker transaction hashes and parses prices', () => {
  const all = [
    { timestamp: 995, transactionHash: 'maker', size: '10', price: '0.5' },
    { timestamp: 996, transactionHash: 'taker', size: '10', price: '0.5' },
  ];
  const report = summarizeTape(all, [{ transactionHash: 'taker' }], 1000);
  assert.equal(report.DAY.notionalUsd, 10);
  assert.equal(report.DAY.makerApproxNotionalUsd, 5);
  assert.equal(report.DAY.makerApproxNotionalShare, 0.5);
});
