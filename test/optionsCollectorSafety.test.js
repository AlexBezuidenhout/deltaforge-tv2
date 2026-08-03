'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DB_SAMPLE_MS, DIAGNOSTIC_HEARTBEAT_MS, EXECUTABLE_HEARTBEAT_MS,
  MARK_TRANSITION_DWELL_MS, REQUIRE_EXACT_EXPIRY,
  classifyExecutionBarrier, feeMetadata, isRetryableDbError, retryTransientDb,
} = require('../borg/options/collector');

test('option query tier uses transitions and bounded heartbeats', () => {
  assert.equal(DB_SAMPLE_MS, 5000);
  assert.equal(DIAGNOSTIC_HEARTBEAT_MS, 300000);
  assert.equal(EXECUTABLE_HEARTBEAT_MS, 60000);
  assert.equal(MARK_TRANSITION_DWELL_MS, 250);
  assert.equal(REQUIRE_EXACT_EXPIRY, true);
});

test('term interpolation is retained as diagnostic but cannot become executable evidence', () => {
  assert.equal(classifyExecutionBarrier({
    valuation: {
      fidelity: 'B', ivIntervalComplete: true,
      surface: { mode: 'TERM_INTERPOLATED' },
    },
    targetSurfaceMode: 'TERM_INTERPOLATED',
    optimized: {}, freshBook: true, book: {}, bookAgeMs: 10,
    resolverAgeMs: 10, feesKnown: true, minimumOrderSize: 5,
  }), 'TERM_INTERPOLATION_DIAGNOSTIC_ONLY');
});

test('option observer parses the current dynamic fee schedule and fails unknown fees closed', () => {
  assert.deepEqual(feeMetadata({
    feesEnabled: true, feeSchedule: { rate: '0.05', exponent: '1' },
  }), { enabled: true, rate: 0.05, exponent: 1, known: true });
  assert.equal(feeMetadata({ feesEnabled: true }).known, false);
  assert.deepEqual(feeMetadata({ feesEnabled: false }), {
    enabled: false, rate: 0, exponent: 1, known: true,
  });
});

test('option observer has no live order or secret-key dependency', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'borg', 'options', 'collector.js'), 'utf8');
  assert.equal(source.includes('createAndPostOrder'), false);
  assert.equal(source.includes('POLY_PRIVATE_KEY'), false);
  assert.equal(source.includes('privateKey'), false);
  assert.equal(source.includes('authenticated'), true); // explicit documentation that it is absent
  assert.match(source, /new RawWal\('options-decisions'/);
  assert.match(source, /this\.decisionWal\.append[\s\S]*options_shadow_mark/);
  assert.match(source, /if \(this\.flushPromise\) return this\.flushPromise/);
  assert.match(source, /persistenceErrors: this\.metrics\.persistenceErrors/);
});

test('option persistence retries transient PostgreSQL concurrency errors only', async () => {
  let attempts = 0;
  let retries = 0;
  const value = await retryTransientDb(async () => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
    return 'stored';
  }, { maxAttempts: 4, baseDelayMs: 0, onRetry: () => { retries += 1; } });
  assert.equal(value, 'stored');
  assert.equal(attempts, 3);
  assert.equal(retries, 2);
  assert.equal(isRetryableDbError({ code: '40001' }), true);
  assert.equal(isRetryableDbError({ code: '23505', message: 'unique violation' }), false);
  await assert.rejects(() => retryTransientDb(async () => {
    throw Object.assign(new Error('bad column'), { code: '42703' });
  }, { maxAttempts: 4, baseDelayMs: 0 }), /bad column/);
});
