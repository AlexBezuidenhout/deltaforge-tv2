#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
require('dotenv').config();
const { createResearchPool } = require('./lib/research-pool');
const { auditProposals } = require('../borg/research/semantic-condition-proposer');

function integerArgument(name, fallback, maximum) {
  const prefix = `--${name}=`;
  const raw = process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function stringArgument(name, fallback = null) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || fallback;
}

function loadExternal(file) {
  if (!file) return [];
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('--proposals must contain a JSON array');
  return parsed;
}

async function loadRows(pool, days, limit) {
  const { rows } = await pool.query(`
    SELECT rule_hash,rule_document
      FROM borg_structural_rule_snapshots
     WHERE first_observed_at >= now() - ($1::int * interval '1 day')
       AND COALESCE(rule_document#>>'{market,question}','')
           ~* '(at least|at most|at or above|at or below|or above|or below|above|below|greater than|less than|more than|fewer than)'
     ORDER BY first_observed_at DESC,rule_hash
     LIMIT $2
  `, [days, limit]);
  return rows;
}

function render(report) {
  const statuses = Object.entries(report.statusCounts)
    .map(([status, count]) => `| ${status} | ${count} |`);
  return [
    '# Semantic condition-graph proposer',
    '',
    `Generated ${report.generatedAt}. Source rows ${report.sourceRuleRows.toLocaleString()}; typed threshold nodes ${report.typedThresholdNodes.toLocaleString()}.`,
    '',
    `Proposals: ${report.proposals.toLocaleString()}; cross-event proposals: ${report.crossEventProposals.toLocaleString()}. Deterministic venue-rule certifications: **${report.deterministicRuleCertified}**; executable candidates: **${report.executableCandidates}**.`,
    '',
    '| Verification status | Count |',
    '|---|---:|',
    ...(statuses.length ? statuses : ['| No proposals | 0 |']),
    '',
    report.disclosure,
    '',
    'This tool has no database write, wallet, signer, quote or order path. Proposals must enter the existing immutable rule certifier and statewise execution scanner before they have economic meaning.',
    '',
  ].join('\n');
}

async function buildReport(pool, options = {}) {
  const days = options.days || 30;
  const limit = options.limit || 100000;
  const rows = await loadRows(pool, days, limit);
  return auditProposals(rows, options.externalProposals || [], {
    maxProposals: options.maxProposals || 10000,
    sampleLimit: options.sampleLimit || 100,
  });
}

async function main() {
  const days = integerArgument('days', 30, 365);
  const limit = integerArgument('limit', 100000, 200000);
  const maxProposals = integerArgument('max-proposals', 10000, 50000);
  const externalProposals = loadExternal(stringArgument('proposals'));
  const pool = createResearchPool({
    applicationName: 'semantic-condition-proposer', statementTimeoutMs: 120000,
  });
  try {
    const report = await buildReport(pool, { days, limit, maxProposals, externalProposals });
    console.log(process.argv.includes('--json') ? JSON.stringify(report, null, 2) : render(report));
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

module.exports = { buildReport, loadExternal, loadRows, render };
