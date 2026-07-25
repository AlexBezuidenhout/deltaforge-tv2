'use strict';

/**
 * Full-venue discovery is CPU-heavy enough to delay market-data callbacks.
 * Keep it outside the collector event loop; only the compact candidate result
 * crosses the worker boundary after matching is complete.
 */

const { parentPort, workerData } = require('node:worker_threads');
const { discoverCrossVenue } = require('./universe');

async function main() {
  const warnings = [];
  const universe = await discoverCrossVenue({
    ...(workerData?.options || {}),
    onCryptoError: (scope, error) => warnings.push({
      scope: String(scope || 'unknown'), message: error?.message || String(error),
    }),
  });
  parentPort.postMessage({ ok: true, universe, warnings });
}

main().catch((error) => parentPort.postMessage({
  ok: false,
  error: { message: error?.message || String(error), stack: error?.stack || null },
}));

