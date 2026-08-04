#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { CURRENT_CROSSVENUE_EXPERIMENT_ID } = require('../borg/crossvenue/experiment');
const { buildMismatchAutopsy } = require('../borg/crossvenue/mismatch-autopsy');
const { writeAtomic } = require('./object-store-archive');
const { createResearchPool } = require('./lib/research-pool');

function outputRoot() {
  return process.env.DELTAFORGE_RESEARCH_REPORT_DIR
    || '/var/lib/deltaforge/research-reports';
}

function persistReport(report) {
  const root = path.join(outputRoot(), 'crossvenue');
  fs.mkdirSync(root, { recursive: true });
  const stamp = report.generatedAt.replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
  const file = path.join(root, `${stamp}.json`);
  writeAtomic(file, `${JSON.stringify(report, null, 2)}\n`, 0o600);
  writeAtomic(path.join(root, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 0o600);
  return file;
}

async function main() {
  const pool = createResearchPool({ applicationName: 'crossvenue-mismatch-autopsy' });
  try {
    const { rows } = await pool.query(`
      SELECT match_id,poly_condition_id,kalshi_ticker,match_score,
             exact_rule_eligible,hard_mismatch,hard_mismatch_reasons,
             unknown_rule_reasons,exact_rule_audit,metadata
        FROM cv_contract_matches
       WHERE active
       ORDER BY match_id
    `);
    const report = buildMismatchAutopsy(rows, {
      experimentId: CURRENT_CROSSVENUE_EXPERIMENT_ID,
    });
    if (process.argv.includes('--persist')) report.persistedAt = persistReport(report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally { await pool.end(); }
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

module.exports = { outputRoot, persistReport };
