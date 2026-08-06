'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const script = fs.readFileSync(
  path.resolve(__dirname, '../ops/vps/start-evidence-epoch.sh'),
  'utf8',
);

test('new evidence epochs default to the immutable deployed release identifier', () => {
  assert.match(
    script,
    /deployed_release="\$\(basename "\$\(readlink -f \/opt\/deltaforge\/tv2\/current\)"\)"/,
  );
  assert.match(
    script,
    /code_version="\$\{BORG_EPOCH_CODE_VERSION:-\$\{deployed_release\}\}"/,
  );
  assert.doesNotMatch(
    script,
    /code_version="\$\{BORG_EPOCH_CODE_VERSION:-backlog-research-v\d+\}"/,
  );
});

test('epoch launch drains receipt-gated retention without terminating its oneshot', () => {
  assert.match(script, /systemctl stop deltaforge-hot-retention\.timer/);
  assert.match(script,
    /while systemctl is-active --quiet deltaforge-hot-retention\.service/);
  assert.match(script,
    /refusing to start evidence epoch: hot retention failed before the boundary/);
  assert.doesNotMatch(script,
    /deltaforge-hot-retention\.timer deltaforge-hot-retention\.service/);
  assert.match(script,
    /if \[\[ "\$\{hot_retention_timer_drained\}" == true \]\]; then[\s\S]*enable --now deltaforge-hot-retention\.timer/);
});
