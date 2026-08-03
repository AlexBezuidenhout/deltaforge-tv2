#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  compactFromGoogle,
  hydrateParquet,
  loadLakeState,
} = require('../borg/research/parquet-lake');

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const command = process.argv[2] || 'compact';
  if (command === 'compact') {
    const report = await compactFromGoogle({
      sources: arg('--sources'),
      maxFiles: arg('--max-files'),
      maxBytes: arg('--max-bytes'),
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
    console.log(JSON.stringify({
      format: state.format,
      updatedAt: state.updatedAt || null,
      sourceFiles: Object.keys(state.sources).length,
      batches: Object.keys(state.batches).length,
      verifiedBatches: Object.values(state.batches).filter((row) => row.verified).length,
      receiptPresent: fs.existsSync(process.env.PARQUET_LAKE_RECEIPT || '/var/lib/deltaforge/parquet-lake.receipt'),
    }, null, 2));
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
