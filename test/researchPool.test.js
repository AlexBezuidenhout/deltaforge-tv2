'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildResearchPoolConfig,
} = require('../scripts/lib/research-pool');

test('research reports prefer the analytics replica and are read-only with bounded waits', () => {
  const config = buildResearchPoolConfig({}, {
    ANALYTICS_DATABASE_URL: 'postgres://reader@analytics.internal/deltaforge',
    DATABASE_URL: 'postgres://writer@localhost/deltaforge',
  });
  assert.equal(config.connectionString, 'postgres://reader@analytics.internal/deltaforge');
  assert.equal(config.max, 1);
  assert.equal(config.statement_timeout, 30_000);
  assert.equal(config.lock_timeout, 500);
  assert.match(config.options, /default_transaction_read_only=on/);
  assert.deepEqual(config.ssl, { rejectUnauthorized: false });
});

test('research reports retain a safe local fallback without enabling writes', () => {
  const config = buildResearchPoolConfig({ statementTimeoutMs: 1234 }, {
    DATABASE_URL: 'postgres://deltaforge@127.0.0.1/deltaforge',
  });
  assert.equal(config.ssl, false);
  assert.equal(config.statement_timeout, 1234);
  assert.match(config.options, /default_transaction_read_only=on/);
});
