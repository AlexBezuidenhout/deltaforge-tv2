#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { renderSlate, slateDocument } = require('../borg/research/edge-experiment-slate');
const { DECISIONS, HYPOTHESES } = require('../borg/research/edge-mechanism-map');

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function markdownCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function nearMissDisposition(hypothesis, selected) {
  if (hypothesis.decision === DECISIONS.REJECTED_EXISTING_EVIDENCE) {
    return `Rejected by existing evidence: ${hypothesis.existingEvidence}`;
  }
  if (hypothesis.decision === DECISIONS.REJECTED_MECHANISM) {
    return `Rejected at mechanism review: ${hypothesis.existingEvidence}`;
  }
  if (hypothesis.decision === DECISIONS.BLOCKED_DATA) {
    return `Blocked before testing: ${hypothesis.existingEvidence}`;
  }
  const represented = selected.filter((row) => row.family === hypothesis.family)
    .map((row) => row.id);
  if (represented.length >= 2) {
    return `Family capacity is already allocated to ${represented.join(' and ')}; this lower-ranked or overlapping mechanism remains at ${hypothesis.decision} until a slot is freed. ${hypothesis.existingEvidence}`;
  }
  return `Outside the bounded ten-lane slate after the frozen score, mechanism-diversity, data-readiness and bankroll-capacity screen; remains ${hypothesis.decision} in the idea/cheap-falsification registry. ${hypothesis.existingEvidence}`;
}

function renderNearMisses(document) {
  const selectedIds = new Set(document.lanes.map((lane) => lane.mechanismId));
  const selected = HYPOTHESES.filter((row) => selectedIds.has(row.id));
  const nearMisses = HYPOTHESES.filter((row) => !selectedIds.has(row.id));
  const rows = nearMisses.map((row) => `| ${[
    row.id,
    row.title,
    row.familyLabel,
    row.score.total,
    nearMissDisposition(row, selected),
    row.cheapestFalsification,
  ].map(markdownCell).join(' | ')} |`);
  return [
    '## Near-miss disposition',
    '',
    `All ${nearMisses.length} non-selected mechanisms remain explicit below so a rejected or blocked idea cannot be relaunched under a new name after seeing P&L. The full economic and data rationale is in \`EDGE_MECHANISM_MAP.md\`.`,
    '',
    '| ID | Mechanism | Family | Score | Why it is not in the ten-lane incubator | Reopening gate |',
    '| --- | --- | --- | ---: | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

function main() {
  const outDir = path.resolve(arg('--out-dir', path.join(__dirname, '..')));
  const document = slateDocument();
  fs.mkdirSync(outDir, { recursive: true });
  const json = path.join(outDir, 'EDGE_EXPERIMENT_SLATE.json');
  const markdown = path.join(outDir, 'EDGE_EXPERIMENT_SLATE.md');
  const requiredDeliverable = path.join(outDir, 'TOP_EDGE_EXPERIMENTS.md');
  fs.writeFileSync(json, `${JSON.stringify(document, null, 2)}\n`);
  const rendered = renderSlate(document);
  fs.writeFileSync(markdown, rendered);
  fs.writeFileSync(requiredDeliverable, `${rendered}${renderNearMisses(document)}\n## Post-freeze implementation ledger\n\nThe immutable slate above records selection-time status. Later work does not rewrite its hash. As of 2026-08-03 16:20 UTC: R07 completed its bounded falsification (87,729 rule documents, zero machine-certified timing units, zero capacity); N09's deterministic lexical baseline read 19,848 immutable rules and produced 998 within-event proposals but zero novel cross-event, rule-certified or executable relationships; two bounded Parquet batches remotely verified 50 source segments, 2,255,941 causal event envelopes and 23 ZSTD Parquet partitions under batch hashes \`76ba651b576861e5dfcc0dd5be44f009\` and \`1485186d236e2a5712fe5c36117c2a4b\`; H43-X and the longshot successor remain the only statistical paper-intent emitters, with 18 and 3 current A/B fills respectively; all other lanes remain scanner, collection, tooling or observation lanes.\n`);
  console.log(JSON.stringify({
    lanes: document.lanes.length, manifestHash: document.manifestHash,
    json, markdown, requiredDeliverable,
  }, null, 2));
}

if (require.main === module) main();

module.exports = { markdownCell, nearMissDisposition, renderNearMisses };
