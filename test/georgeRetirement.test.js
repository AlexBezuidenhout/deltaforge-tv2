'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const GeorgeBotInstance = require('../src/bot/GeorgeBotInstance');

test('legacy George mainnet source is permanently retired before own/resurrection entry', () => {
  assert.equal(GeorgeBotInstance.LEGACY_GEORGE_SOURCE_RETIRED, true);
});
