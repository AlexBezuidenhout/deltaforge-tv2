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
