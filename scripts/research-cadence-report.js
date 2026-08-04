#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { assessEvidenceEpoch } = require('../borg/research/evidence-epoch');
const { buildEvidenceWindowReport } = require('../borg/research/evidence-window');
const { buildMismatchAutopsy } = require('../borg/crossvenue/mismatch-autopsy');
const { CURRENT_CROSSVENUE_EXPERIMENT_ID } = require('../borg/crossvenue/experiment');
const { buildStorageReadiness } = require('../borg/research/storage-readiness');
const { OPTIONS_EXPERIMENT_ID } = require('../borg/options/experiment');
const { writeAtomic } = require('./object-store-archive');
const { createResearchPool } = require('./lib/research-pool');

function reportRoot() {
  return process.env.DELTAFORGE_RESEARCH_REPORT_DIR
    || '/var/lib/deltaforge/research-reports';
}

function persist(report) {
  const root = reportRoot();
  fs.mkdirSync(root, { recursive: true });
  const stamp = report.generatedAt.replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
  const file = path.join(root, `${stamp}.json`);
  const text = `${JSON.stringify(report, null, 2)}\n`;
  writeAtomic(file, text, 0o600);
  writeAtomic(path.join(root, 'latest.json'), text, 0o600);
  return file;
}

function normalizedOptionCounts(row = {}) {
  const integer = (value) => parseInt(value, 10) || 0;
  return {
    marks6h: integer(row.marks_6h),
    marks24h: integer(row.marks_24h),
    exactMarks24h: integer(row.exact_marks_24h),
    exactAbMarks24h: integer(row.exact_ab_marks_24h),
    exactExecutableAbMarks24h: integer(row.exact_executable_ab_marks_24h),
    executableMarks24h: integer(row.executable_marks_24h),
    latest: row.latest || null,
  };
}

async function optionsSummary(db) {
  if (!db?.query) throw new Error('optionsSummary requires a read-only research pool');
  const [{ rows: heartbeat }, { rows: marks }] = await Promise.all([
    db.query(`SELECT beat_at,meta FROM system_heartbeats
                 WHERE component='options_surface'`),
    db.query(`SELECT
        count(*) FILTER (WHERE observed_at>=now()-interval '6 hours')::int marks_6h,
        count(*) FILTER (WHERE observed_at>=now()-interval '24 hours')::int marks_24h,
        count(*) FILTER (WHERE observed_at>=now()-interval '24 hours'
          AND target_surface_mode='EXACT_EXPIRY')::int exact_marks_24h,
        count(*) FILTER (WHERE observed_at>=now()-interval '24 hours'
          AND target_surface_mode='EXACT_EXPIRY'
          AND surface_fidelity IN ('A','B'))::int exact_ab_marks_24h,
        count(*) FILTER (WHERE observed_at>=now()-interval '24 hours'
          AND target_surface_mode='EXACT_EXPIRY'
          AND surface_fidelity IN ('A','B') AND executable)::int exact_executable_ab_marks_24h,
        count(*) FILTER (WHERE observed_at>=now()-interval '24 hours'
          AND executable)::int executable_marks_24h,
        max(observed_at) latest
      FROM borg_option_shadow_marks
     WHERE experiment_id=$1`, [OPTIONS_EXPERIMENT_ID]),
  ]);
  const meta = heartbeat[0]?.meta || {};
  const observed = normalizedOptionCounts(marks[0]);
  return {
    heartbeatAt: heartbeat[0]?.beat_at || null,
    exactExpiryDiscovery: meta.exactExpiry || null,
    surfaceFidelity: meta.surfaceFidelity || null,
    executionBarriers: meta.executionBarriers || null,
    observed,
    successorEvidencePresent: observed.exactExecutableAbMarks24h > 0,
    successorRule: 'No new arm may start until at least one direct exact-expiry target produces an A/B-fidelity executable mark after 2x costs.',
  };
}

async function main() {
  const pool = createResearchPool({ applicationName: 'research-cadence-report' });
  try {
    const now = new Date();
    const [execution, evidence, mismatchRows, options] = await Promise.all([
      buildEvidenceWindowReport(pool, { now, horizons: [6, 24] }),
      assessEvidenceEpoch(pool, { now }),
      pool.query(`SELECT match_id,poly_condition_id,kalshi_ticker,match_score,
                         exact_rule_eligible,hard_mismatch,hard_mismatch_reasons,
                         unknown_rule_reasons,exact_rule_audit,metadata
                    FROM cv_contract_matches WHERE active ORDER BY match_id`),
      optionsSummary(pool),
    ]);
    const report = {
      format: 'deltaforge-research-cadence-v1',
      generatedAt: now.toISOString(),
      frozenCohort: true,
      changesStrategyRules: false,
      evidence: {
        status: evidence.status,
        promotionEligible: evidence.promotionEligible,
        epoch: evidence.epoch,
        critical: evidence.critical,
        warnings: evidence.warnings,
        lanes: evidence.lanes,
      },
      execution,
      crossvenue: buildMismatchAutopsy(mismatchRows.rows, {
        now, experimentId: CURRENT_CROSSVENUE_EXPERIMENT_ID,
      }),
      options,
      storage: buildStorageReadiness({ now }),
    };
    if (process.argv.includes('--persist')) report.persistedAt = persist(report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally { await pool.end(); }
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

module.exports = { normalizedOptionCounts, optionsSummary, persist, reportRoot };
