#!/usr/bin/env node
'use strict';

/** Read-only readiness report for the staged equity/options experiment. */

const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const {
  fetchCurrentEquityEvents, selectEquityThresholds,
} = require('../borg/equity-options/universe');

async function fetchCurrentEvents(nowMs = Date.now()) {
  return fetchCurrentEquityEvents({ nowMs });
}

async function main() {
  const nowMs = Date.now();
  const symbols = String(process.env.EQOPT_SYMBOLS || 'SPY,EWY')
    .split(',').map((value) => value.trim().toUpperCase()).filter(Boolean);
  const events = await fetchCurrentEvents(nowMs);
  const selection = selectEquityThresholds(events, { symbols, nowMs });
  const licensedFeedConfigured = Boolean(process.env.IBKR_CLIENT_PORTAL_URL);
  const report = {
    format: 'deltaforge-equity-options-readiness-v1',
    generatedAt: new Date(nowMs).toISOString(),
    paperOnly: true,
    liveOrderAuthority: false,
    fetchedEvents: events.length,
    targetCount: selection.records.length,
    symbols,
    targets: selection.records.map((record) => ({
      slug: record.slug,
      symbol: record.symbol,
      strike: record.strike,
      expiry: new Date(record.expiryMs).toISOString(),
      minimumOrderSize: record.minimumOrderSize,
      feeSchedule: record.fees,
      ruleHash: record.ruleHash,
    })),
    rejected: selection.rejected,
    licensedOptionsFeed: {
      configured: licensedFeedConfigured,
      required: 'Licensed OPRA top-of-book with source/receive timestamps and sizes',
      credentialsPrinted: false,
    },
    basisEvidence: {
      ready: false,
      required: 'At least 30 untouched symbol-days of Pyth close versus option-settlement underlying close',
    },
    decision: licensedFeedConfigured
      ? 'TARGETS_READY_BUT_BASIS_COHORT_REQUIRED'
      : 'TARGETS_READY_BUT_LICENSED_OPTIONS_ADAPTER_REQUIRED',
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

module.exports = { fetchCurrentEvents };
