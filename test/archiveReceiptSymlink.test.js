'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('VPS receipt consumers follow stable receipt symlinks for freshness', () => {
  const retention = fs.readFileSync(
    path.join(root, 'ops/vps/local-hot-tier-retention.sh'),
    'utf8',
  );
  const snapshot = fs.readFileSync(
    path.join(root, 'ops/vps/local-db-snapshot.sh'),
    'utf8',
  );

  assert.match(retention, /receipt_mtime=\$\(stat -Lc '%Y' "\$RECEIPT"\)/);
  assert.match(
    retention,
    /snapshot_receipt_mtime=\$\(stat -Lc '%Y' "\$SNAPSHOT_RECEIPT"\)/,
  );
  assert.match(snapshot, /receipt_mtime=\$\(stat -Lc '%Y' "\$RAW_RECEIPT"\)/);
});
