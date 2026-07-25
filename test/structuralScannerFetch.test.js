'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchEventPage, fetchEvents } = require('../borg/structural/scanner');

function response(payload, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] || null },
    text: async () => JSON.stringify(payload),
  };
}

test('structural Gamma page retries a transient timeout with a bounded backoff', async () => {
  let attempts = 0;
  const delays = [];
  const payload = [{ id: 'event-1' }];
  const result = await fetchEventPage({ active: 'true' }, {
    maxAttempts: 2,
    timeoutMs: 100,
    sleep: async (ms) => delays.push(ms),
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return response(payload);
    },
  });
  assert.deepEqual(result, payload);
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [500]);
});

test('structural universe bounds Gamma request concurrency', async () => {
  let active = 0;
  let maximumActive = 0;
  let requestId = 0;
  const rows = await fetchEvents({
    eventPages: 2,
    sportsEventPages: 1,
    concurrency: 2,
    maxAttempts: 1,
    timeoutMs: 1000,
    fetchImpl: async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const id = ++requestId;
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return response([{ id: `event-${id}` }]);
    },
  });
  assert.equal(maximumActive, 2);
  assert.equal(rows.length, 6);
});

test('structural Gamma page exposes a useful error after retry exhaustion', async () => {
  await assert.rejects(fetchEventPage({ active: 'true' }, {
    maxAttempts: 2,
    timeoutMs: 100,
    sleep: async () => {},
    fetchImpl: async () => response({ error: 'busy' }, 503),
  }), /Gamma HTTP 503/);
});
