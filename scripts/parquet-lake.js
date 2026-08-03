#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  compactFromGoogle,
  hydrateParquet,
  loadLakeState,
  materializeFromGoogle,
} = require('../borg/research/parquet-lake');

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function compactOptions() {
  return {
    sources: arg('--sources'),
    from: arg('--from'),
    to: arg('--to'),
    order: process.argv.includes('--oldest') ? 'oldest' : arg('--order'),
    maxFiles: arg('--max-files'),
    maxBytes: arg('--max-bytes'),
  };
}

async function main() {
  const command = process.argv[2] || 'compact';
  if (command === 'compact') {
    const report = await compactFromGoogle(compactOptions());
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (command === 'materialize') {
    const options = compactOptions();
    const report = await materializeFromGoogle({
      ...options,
      order: process.argv.includes('--newest') ? 'newest' : (options.order || 'oldest'),
      maxBatches: arg('--max-batches'),
      maxMinutes: arg('--max-minutes'),
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (command === 'hydrate') {
    const report = await hydrateParquet({
      source: arg('--source'),
      from: arg('--from'),
      to: arg('--to'),
      maxBytes: arg('--max-bytes'),
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (command === 'status') {
    const stateRoot = process.env.PARQUET_LAKE_STATE_ROOT || '/var/lib/deltaforge/parquet-lake';
    const state = loadLakeState(path.join(stateRoot, 'state.json'));
    const receipt = process.env.PARQUET_LAKE_RECEIPT || path.join(stateRoot, 'receipt');
    console.log(JSON.stringify({
      format: state.format,
      updatedAt: state.updatedAt || null,
      sourceFiles: Object.keys(state.sources).length,
      batches: Object.keys(state.batches).length,
      verifiedBatches: Object.values(state.batches).filter((row) => row.verified).length,
      receiptPresent: fs.existsSync(receipt),
    }, null, 2));
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
