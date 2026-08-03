'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const BotManager = require('../src/bot/BotManager');

test('dashboard-only application instances cannot manually start evaluators', async () => {
  const manager = new BotManager({ runnerEnabled: false, instanceId: 'df2' });
  await assert.rejects(manager.startBot(1, {}), /disabled.*df2/);
  await assert.rejects(manager.startCopyBot(1, {}), /disabled.*df2/);
  await assert.rejects(manager.startGeorgeBot(1, {}), /disabled.*df2/);
  assert.equal(manager.getActiveCount(), 0);
});

test('deployable TV2 web process is loopback-only and cannot own the bot runner', () => {
  const unit = fs.readFileSync(path.join(__dirname, '..', 'deploy',
    'deltaforge-tv2-dashboard.service'), 'utf8');
  assert.match(unit, /Environment=HOST=127\.0\.0\.1/);
  assert.match(unit, /Environment=PORT=3014/);
  assert.match(unit, /Environment=BOT_RUNNER_ENABLED=false/);
  assert.match(unit, /ExecStart=\/usr\/bin\/env[^\n]*PORT=3014[^\n]*BOT_RUNNER_ENABLED=false/);
  assert.doesNotMatch(unit, /^Environment=BOT_RUNNER_ENABLED=true$/m);
});
