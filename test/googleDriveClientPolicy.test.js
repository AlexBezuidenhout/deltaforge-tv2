'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { googleDriveClientPolicy } = require('../scripts/google-drive-archive');

test('Google Drive policy distinguishes a private OAuth client from rclone shared credentials', () => {
  const shared = googleDriveClientPolicy({ token: '{...}' });
  assert.equal(shared.mode, 'SHARED_RCLONE');
  assert.equal(shared.migrationRequired, true);
  assert.match(shared.warning, /retired during 2026/);

  const custom = googleDriveClientPolicy({ client_id: 'id', client_secret: 'secret' });
  assert.equal(custom.mode, 'CUSTOM');
  assert.equal(custom.migrationRequired, false);
  assert.equal(custom.warning, null);
});
