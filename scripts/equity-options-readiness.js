#!/usr/bin/env node
'use strict';

/** Read-only readiness report for the staged equity/options experiment. */

const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { FINANCE_UPDOWN_TAG, GAMMA, fetchJson } = require('../borg/pyth/universe');
const { selectEquityThresholds } = require('../borg/equity-options/universe');

async function fetchCurrentEvents(nowMs = Date.now()) {
  const events = [];
  for (let page = 0; page < 4; page += 1) {
    const url = new URL(`${GAMMA}/events`);
    const params = {
      tag_id: FINANCE_UPDOWN_TAG,
      active: 'true',
      closed: 'false',
      limit: '100',
      offset: String(page * 100),
      order: 'endDate',
      ascending: 'true',
      end_date_min: new Date(nowMs - 3600_000).toISOString(),
      end_date_max: new Date(nowMs + 8 * 86_400_000).toISOString(),
    };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const rows = await fetchJson(url.toString());
    events.push(...rows);
    if (rows.length < 100) break;
  }
  return [...new Map(events.map((event) => [String(event.id || event.slug), event])).values()];
}

async function main() {
  const nowMs = Date.now();
  const symbols = String(process.env.EQOPT_SYMBOLS || 'SPY,EWY')
    .split(',').map((value) => value.trim().toUpperCase()).filter(Boolean);
  const events = await fetchCurrentEvents(nowMs);
  const selection = selectEquityThresholds(events, { symbols, nowMs });
  const licensedFeedConfigured = Boolean(process.env.IBKR_CLIENT_PORTAL_URL
    && process.env.IBKR_ACCOUNT_ID);
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
