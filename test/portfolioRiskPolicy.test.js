const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPortfolioPolicy,
  canOpenPortfolioPosition,
  riskWindowFloor,
} = require('../src/bot/PortfolioRiskPolicy');

test('builds the frozen $500 promotion envelope', () => {
  const policy = buildPortfolioPolicy('500.00');
  assert.equal(policy.stakeUsd, 10);
  assert.equal(policy.maxGrossExposureUsd, 30);
  assert.equal(policy.dailyLossUsd, 30);
  assert.equal(policy.hardDrawdownUsd, 50);
  assert.equal(policy.minimumCashReserveUsd, 400);
});

test('portfolio policy blocks duplicate, exposure, loss, and drawdown risk', () => {
  const policy = buildPortfolioPolicy(500);
  assert.equal(canOpenPortfolioPosition({ policy }).allowed, true);
  assert.equal(canOpenPortfolioPosition({ policy, marketAlreadyClaimed: true }).reason, 'market_already_claimed');
  assert.equal(canOpenPortfolioPosition({ policy, openPositions: '3' }).reason, 'max_concurrent_positions');
  assert.equal(canOpenPortfolioPosition({ policy, grossExposureUsd: '21.00' }).reason, 'max_gross_exposure');
  assert.equal(canOpenPortfolioPosition({ policy, rolling24hPnlUsd: '-30.00' }).reason, 'daily_loss_halt');
  assert.equal(canOpenPortfolioPosition({ policy, drawdownUsd: '50.00' }).reason, 'hard_drawdown_halt');
});

test('paper risk starts at the later of the rolling window and infrastructure cohort', () => {
  const now = new Date('2026-07-16T12:00:00.000Z');
  assert.equal(
    riskWindowFloor(now, '2026-07-15T22:26:55.888Z').toISOString(),
    '2026-07-15T22:26:55.888Z',
  );
  assert.equal(
    riskWindowFloor(now, '2026-07-01T00:00:00.000Z').toISOString(),
    '2026-07-15T12:00:00.000Z',
  );
  assert.equal(
    riskWindowFloor(now, null).toISOString(),
    '2026-07-15T12:00:00.000Z',
  );
});
