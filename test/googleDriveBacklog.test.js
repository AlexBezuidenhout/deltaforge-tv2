'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { backlogSummary } = require('../scripts/google-drive-archive');

test('Google Drive archive reports pending bytes and oldest age after verification', () => {
  const destination = 'drive:VPS Data';
  const records = [
    { id: 'a', relative: 'x/a', size: 100, mtimeMs: 1000 },
    { id: 'b', relative: 'x/b', size: 250, mtimeMs: 3000 },
  ];
  const state = { objects: {
    a: {
      verified: true, destination, relative: 'x/a', size: 100, mtimeMs: 1000,
      sha256: 'a'.repeat(64),
    },
  } };
  assert.deepEqual(backlogSummary(records, state, destination, 5000), {
    pendingFiles: 1,
    pendingBytes: 250,
    oldestPendingAt: '1970-01-01T00:00:03.000Z',
    oldestPendingAgeSec: 2,
  });
});
