#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const {
  fetchInstruments, fetchThresholdEvents, listedCallExpiries,
} = require('../borg/options/collector');
const { selectExactExpiryThresholds } = require('../borg/options/target-universe');
const { summarizeExactExpiryCoverage } = require('../borg/options/exact-expiry-coverage');
const { writeAtomic } = require('./object-store-archive');

function reportRoot() {
  return process.env.DELTAFORGE_RESEARCH_REPORT_DIR
    || '/var/lib/deltaforge/research-reports';
}

function persist(report) {
  const root = path.join(reportRoot(), 'options');
  fs.mkdirSync(root, { recursive: true });
  const stamp = report.generatedAt.replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
  const body = `${JSON.stringify(report, null, 2)}\n`;
  const file = path.join(root, `exact-expiry-${stamp}.json`);
  writeAtomic(file, body, 0o600);
  writeAtomic(path.join(root, 'exact-expiry-latest.json'), body, 0o600);
  return file;
}

async function buildLiveCoverage(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const currencies = options.currencies || String(process.env.OPTIONS_CURRENCIES || 'BTC,ETH')
    .split(',').map((value) => value.trim().toUpperCase()).filter(Boolean);
  const pages = await Promise.all(currencies.map(fetchInstruments));
  const rawInstruments = pages.flat();
  const listedExpiries = listedCallExpiries(rawInstruments, now.getTime());
  const events = await fetchThresholdEvents(listedExpiries);
  const selection = selectExactExpiryThresholds(events, rawInstruments, {
    nowMs: now.getTime(),
    minTteMs: Math.max(30, Number(process.env.OPTIONS_MIN_TTE_SEC || 300)) * 1000,
    maxTteMs: Math.max(300, Number(process.env.OPTIONS_MAX_TTE_SEC || 604800)) * 1000,
    currencies,
  });
  return summarizeExactExpiryCoverage({
    now, currencies, rawInstruments, listedExpiries, events, selection,
  });
}

async function main() {
  const report = await buildLiveCoverage();
  if (process.argv.includes('--persist')) report.persistedAt = persist(report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

module.exports = { buildLiveCoverage, persist, reportRoot };
