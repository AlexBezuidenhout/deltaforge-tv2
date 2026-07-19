'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const BotInstance = require('../src/bot/BotInstance');
const GeorgeBotInstance = require('../src/bot/GeorgeBotInstance');

function settings(overrides = {}) {
  return {
    email: 'paper@example.com',
    paper_trading: true,
    paper_balance: '-100.00',
    virtual_paper_balance: '-100.00',
    george_paper_balance: '-100.00',
    paper_risk_limits_enabled: false,
    candidate_portfolio_enabled: true,
    portfolio_bankroll_usdc: '500.00',
    ...overrides,
  };
}

test('Main paper research cannot be stopped by imaginary loss or drawdown', async () => {
  const bot = new BotInstance(1, settings());
  assert.equal(bot._isUnboundedPaperResearch(), true);
  assert.equal(await bot._checkDirectionalExposure('YES'), false);
  bot.drawdownCooldownUntil = Date.now() + 60_000;
  assert.equal(await bot._checkDrawdownCircuitBreaker(), true);
  assert.equal(bot.drawdownCooldownUntil, null);
  assert.equal(await bot._checkDailyLossLimit(), false);
  assert.equal(bot._dailyLossHaltedAt, null);
  assert.ok(bot.decisionLog.some((row) => row.message.includes('PAPER RESEARCH')));
});

test('live mode never inherits the unbounded paper-research branch', () => {
  const bot = new BotInstance(1, settings({ paper_trading: false }));
  assert.equal(bot._isUnboundedPaperResearch(), false);
  assert.equal(bot._shouldSuppressLegacyPaperExecution(), false);
});

test('legacy Main execution is retired only in paper mode and can be explicitly restored', () => {
  const retired = new BotInstance(1, settings());
  const restored = new BotInstance(1, settings({ main_legacy_execution_enabled: true }));
  assert.equal(retired._shouldSuppressLegacyPaperExecution(), true);
  assert.equal(restored._shouldSuppressLegacyPaperExecution(), false);
});

test('George paper research ignores the imaginary daily-loss ledger', async () => {
  const george = new GeorgeBotInstance(1, settings());
  george._dailyLossHaltedAt = Date.now();
  assert.equal(await george._checkDailyLoss(), false);
  assert.equal(george._dailyLossHaltedAt, null);
});
