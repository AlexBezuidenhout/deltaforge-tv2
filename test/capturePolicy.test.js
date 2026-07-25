'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCapturePolicy } = require('../borg/recon/capture-policy');

test('capture policy selects only explicitly configured assets and market types', () => {
  const policy = createCapturePolicy({
    BORG_CAPTURE_ASSETS: 'btc, ETH,sol,xrp',
    BORG_CAPTURE_MARKET_TYPES: 'direction_5m',
  });
  assert.equal(policy.allowsMarket({ asset: 'eth', market_type: 'direction_5m' }), true);
  assert.equal(policy.allowsMarket({ asset: 'doge', market_type: 'direction_5m' }), false);
  assert.equal(policy.allowsMarket({ asset: 'eth', market_type: 'direction_1h' }), false);
  assert.deepEqual(policy.filterAssets([
    { asset: 'btc' }, { asset: 'doge' }, { asset: 'xrp' },
  ]), [{ asset: 'btc' }, { asset: 'xrp' }]);
});

test('empty capture policy preserves the full research universe', () => {
  const policy = createCapturePolicy({});
  assert.equal(policy.allowsMarket({ asset: 'doge', market_type: 'range_daily' }), true);
  assert.deepEqual(policy.describe(), { assets: ['*'], marketTypes: ['*'] });
});
