#!/usr/bin/env node
'use strict';

require('dotenv').config();

const { createResearchPool } = require('./lib/research-pool');
const {
  RULE_STATUS,
  classifyRuleDocument,
  summarizeAudit,
} = require('../borg/research/resolver-timestamp-precision');

function positiveInt(value, fallback, maximum = 200000) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function argument(name, fallback) {
  const prefix = `--${name}=`;
  const item = process.argv.find((value) => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : fallback;
}

async function loadRuleRows(pool, { days, perSourceLimit }) {
  const [structural, crossvenue] = await Promise.all([
    pool.query(`
      SELECT rule_hash,
             'POLYMARKET'::text AS venue,
             COALESCE(condition_id,gamma_id,event_id) AS contract_id,
             rule_document
        FROM borg_structural_rule_snapshots
       WHERE first_observed_at >= now() - ($1::int * interval '1 day')
         AND rule_document::text ~* '(chainlink|pyth|cf benchmarks|brti|binance|coinbase|deribit)'
       ORDER BY first_observed_at DESC,rule_hash
       LIMIT $2
    `, [days, perSourceLimit]),
    pool.query(`
      SELECT rule_hash,venue,contract_id,rule_document
        FROM cv_rule_snapshots
       WHERE first_observed_at >= now() - ($1::int * interval '1 day')
         AND rule_document::text ~* '(chainlink|pyth|cf benchmarks|brti|binance|coinbase|deribit)'
       ORDER BY first_observed_at DESC,rule_hash
       LIMIT $2
    `, [days, perSourceLimit]),
  ]);
  return [...structural.rows, ...crossvenue.rows];
}

async function loadFeedCoverage(pool, days) {
  const { rows } = await pool.query(`
    SELECT source,asset,count(*)::int AS observations,
           count(source_ts)::int AS with_source_ts,
           count(receive_monotonic_ns)::int AS with_monotonic,
           count(event_sequence)::int AS with_sequence,
           min(received_at) AS first,max(received_at) AS latest
      FROM borg_rtds_ticks
     WHERE received_at >= now() - ($1::int * interval '1 day')
     GROUP BY source,asset ORDER BY source,asset
  `, [days]);
  return rows;
}

function renderReport(report) {
  const statusRows = Object.entries(report.statusCounts)
    .map(([status, count]) => `| ${status} | ${count.toLocaleString()} |`);
  const missingRows = Object.entries(report.missingDimensions)
    .map(([field, count]) => `| ${field} | ${count.toLocaleString()} |`);
  const feedRows = report.feedCoverage.map((row) => [
    `| ${row.source} | ${row.asset} | ${row.observations.toLocaleString()} |`,
    `${(100 * row.sourceTimestampCoverage).toFixed(2)}% |`,
    `${(100 * row.monotonicCoverage).toFixed(2)}% |`,
    `${(100 * row.sequenceCoverage).toFixed(2)}% | ${row.first || '—'} | ${row.latest || '—'} |`,
  ].join(' '));
  return [
    '# Resolver timestamp-precision audit',
    '',
    `Generated: ${report.generatedAt}; bounded rule scan: ${report.boundedDays} days.`,
    '',
    '**Research-only result:** this scanner cannot place paper or live orders. It reports zero capacity unless a resolver result is statewise proved from immutable rule semantics and causally available source events.',
    '',
    `Verdict: **${report.verdict}**.`,
    '',
    `Scanned ${report.scannedRuleDocuments.toLocaleString()} source-filtered rule documents; ${report.relevantPriceResolverRules.toLocaleString()} were price/resolver rules. Machine-certified independent rule/cutoff/source units: ${report.certifiedIndependentRuleCutoffSourceUnits.toLocaleString()}.`,
    '',
    '| Rule status | Count |',
    '|---|---:|',
    ...statusRows,
    '',
    '| Missing certification dimension | Count |',
    '|---|---:|',
    ...(missingRows.length ? missingRows : ['| None | 0 |']),
    '',
    '| Feed | Asset | Observations | Source time | Monotonic | Sequence | First | Latest |',
    '|---|---|---:|---:|---:|---:|---|---|',
    ...(feedRows.length ? feedRows : ['| No qualifying resolver feed rows | — | 0 | — | — | — | — | — |']),
    '',
    `Statewise-proved episodes: **${report.statewiseProvedEpisodes}**; positive after doubled costs: **${report.positiveDoubledCostEpisodes}**; executable capacity: **$${report.executableCapacityUsd.toFixed(2)}**.`,
    '',
    report.disclosure,
    '',
    'A complete event feed does not repair an ambiguous contract rule. Conversely, a precise rule does not create an opportunity unless the winning token remains executable after the authoritative observation is causally known.',
    '',
  ].join('\n');
}

async function buildReport(pool, options = {}) {
  const days = positiveInt(options.days, 30, 365);
  const perSourceLimit = positiveInt(options.perSourceLimit, 100000);
  const [rows, feedCoverage] = await Promise.all([
    loadRuleRows(pool, { days, perSourceLimit }),
    loadFeedCoverage(pool, days),
  ]);
  const report = summarizeAudit(rows, feedCoverage, { days });
  report.scanLimits = { perSourceLimit };
  report.truncated = rows.filter((row) => row.venue === 'POLYMARKET').length >= perSourceLimit
    || rows.filter((row) => row.venue === 'KALSHI').length >= perSourceLimit;
  report.certifiedRules = rows.map((row) => classifyRuleDocument(row.rule_document, {
    venue: row.venue, contractId: row.contract_id, ruleHash: row.rule_hash,
  })).filter((row) => row.status === RULE_STATUS.CERTIFIED).slice(0, 100);
  return report;
}

async function main() {
  const days = positiveInt(argument('days', '30'), 30, 365);
  const perSourceLimit = positiveInt(argument('limit', '100000'), 100000);
  const pool = createResearchPool({
    applicationName: 'resolver-timestamp-precision-audit',
    statementTimeoutMs: 120000,
  });
  try {
    const report = await buildReport(pool, { days, perSourceLimit });
    console.log(process.argv.includes('--json') ? JSON.stringify(report, null, 2) : renderReport(report));
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

module.exports = { buildReport, loadFeedCoverage, loadRuleRows, renderReport };
