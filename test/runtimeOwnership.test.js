'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const BotManager = require('../src/bot/BotManager');

test('dashboard-only application instances cannot manually start evaluators', async () => {
  const manager = new BotManager({ runnerEnabled: false, instanceId: 'df2' });
  await assert.rejects(manager.startBot(1, {}), /disabled.*df2/);
  await assert.rejects(manager.startCopyBot(1, {}), /disabled.*df2/);
  await assert.rejects(manager.startGeorgeBot(1, {}), /disabled.*df2/);
  assert.equal(manager.getActiveCount(), 0);
});
