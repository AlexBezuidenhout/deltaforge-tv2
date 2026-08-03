#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function reportFile() {
  const stateRoot = process.env.PARQUET_LAKE_STATE_ROOT || '/var/lib/deltaforge/parquet-lake';
  return process.env.PARQUET_LAKE_REPORT || path.join(stateRoot, 'last-report.json');
}

function writeFailureReport(error, command) {
  const file = reportFile();
  const report = {
    format: 'deltaforge-parquet-lake-run-v1',
    status: 'failed',
    command,
    failedAt: new Date().toISOString(),
    errorCode: error?.code || null,
    error: String(error?.message || error || 'unknown Parquet failure').slice(0, 500),
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (writeError) {
    console.error(`unable to persist Parquet failure report: ${writeError.message}`);
  }
  return report;
}

function loadLake() {
  // Keep the native DuckDB import inside the guarded execution path. If a
  // release points at an incomplete dependency set, the monitor must see a
  // current failed report immediately rather than trusting the last successful
  // receipt for up to 90 minutes.
  return require('../borg/research/parquet-lake');
}

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
  const {
    compactFromGoogle,
    hydrateParquet,
    loadLakeState,
    materializeFromGoogle,
  } = loadLake();
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

if (require.main === module) {
  main().catch((error) => {
    writeFailureReport(error, process.argv[2] || 'compact');
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = { loadLake, reportFile, writeFailureReport };
