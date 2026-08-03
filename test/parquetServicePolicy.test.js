'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const unit = fs.readFileSync(
  path.join(__dirname, '..', 'deploy', 'deltaforge-parquet-lake.service'),
  'utf8',
);

test('continuous Parquet projection is frozen to compact decision and proof tapes', () => {
  const line = unit.split('\n').find((row) => row.startsWith('Environment=PARQUET_SOURCES='));
  assert.ok(line, 'PARQUET_SOURCES must be explicit');
  const sources = line.split('=', 3)[2].split(',').sort();
  assert.deepEqual(sources, [
    'allmarket-decisions',
    'crossvenue-decisions',
    'options-decisions',
    'polymarket-flow-boundary-intents',
    'pyth-boundary-decisions',
    'research-control',
    'strategy-decisions',
    'structural-scanner',
  ]);
  for (const raw of ['polymarket-clob', 'polymarket-flow-clob', 'deribit-options']) {
    assert.equal(sources.includes(raw), false, `${raw} must remain on-demand bronze`);
  }
  assert.match(unit, /^Environment=PARQUET_MAX_FILES=12$/m);
  assert.match(unit, /^Environment=PARQUET_MAX_BYTES=67108864$/m);
  assert.match(unit, /^MemoryHigh=2G$/m);
  assert.match(unit, /^MemoryMax=3G$/m);
  assert.match(unit, /^OOMScoreAdjust=500$/m);
});
