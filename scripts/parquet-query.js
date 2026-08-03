#!/usr/bin/env node
'use strict';

const { runParquetQuery } = require('../borg/research/parquet-query');

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const command = process.argv[2] || 'sources';
  const result = await runParquetQuery(command, {
    root: arg('--root'),
    source: arg('--source'),
    from: arg('--from'),
    to: arg('--to'),
    limit: arg('--limit'),
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
