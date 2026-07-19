const test = require('node:test');
const assert = require('node:assert/strict');
const VirtualLossManager = require('../src/bot/VirtualLossManager');

test('virtual loss stays virtual until enough virtual losses arm it', async () => {
  const mgr = new VirtualLossManager({
    virtual_loss_enabled: true,
    virtual_loss_required: 1,
    virtual_loss_count: 0,
    virtual_loss_armed: false,
  });

  assert.equal(mgr.shouldExecuteVirtual(), true);
  assert.equal(mgr.shouldAllowRealTrade(), false);

  await mgr.onTradeClosed({ is_virtual: true }, 'LOSS');

  assert.equal(mgr.shouldExecuteVirtual(), false);
  assert.equal(mgr.shouldAllowRealTrade(), true);
  assert.equal(mgr.getStatus().armed, true);
});

test('virtual loss disarms after a real win', async () => {
  const mgr = new VirtualLossManager({
    virtual_loss_enabled: true,
    virtual_loss_required: 1,
    virtual_loss_count: 0,
    virtual_loss_armed: true,
  });

  assert.equal(mgr.shouldAllowRealTrade(), true);

  await mgr.onTradeClosed({ is_virtual: false }, 'WIN');

  assert.equal(mgr.shouldExecuteVirtual(), true);
  assert.equal(mgr.shouldAllowRealTrade(), false);
  assert.equal(mgr.getStatus().armed, false);
  assert.equal(mgr.getStatus().count, 0);
});
