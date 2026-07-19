'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('friend-access proxy keeps DF2 read-only and TV2 behind app authorization', () => {
  const caddy = fs.readFileSync(
    path.join(__dirname, '..', 'deploy', 'Caddyfile.friend-access'),
    'utf8'
  );
  assert.match(caddy, /tv2\.107\.174\.203\.197\.sslip\.io/);
  assert.match(caddy, /df2\.107\.174\.203\.197\.sslip\.io/);
  assert.match(caddy, /basic_auth/);
  assert.match(caddy, /@write_method not method GET HEAD OPTIONS/);
  assert.match(caddy, /respond @write_method .* 403/);
  assert.match(caddy, /__DF2_BCRYPT_HASH__/);
  assert.doesNotMatch(caddy, /password|private[_ -]?key|DATABASE_URL/i);
});
