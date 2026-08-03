#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  HYPOTHESES,
  RESEARCH_AS_OF,
  RUBRIC,
  SOURCE_REGISTRY,
  renderMechanismMap,
  topCandidates,
} = require('../borg/research/edge-mechanism-map');

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function main() {
  const root = path.resolve(arg('--out-dir', path.join(__dirname, '..')));
  const jsonFile = path.join(root, 'EDGE_MECHANISM_MAP.json');
  const markdownFile = path.join(root, 'EDGE_MECHANISM_MAP.md');
  const generatedAt = new Date().toISOString();
  const document = {
    format: 'deltaforge-edge-mechanism-map-v1',
    generatedAt,
    researchAsOf: RESEARCH_AS_OF,
    notice: 'Research priorities are not profitability evidence. Paper-only.',
    rubric: RUBRIC,
    sources: SOURCE_REGISTRY,
    hypothesisCount: HYPOTHESES.length,
    selectedScreen: topCandidates(HYPOTHESES, 10).map((row) => row.id),
    hypotheses: HYPOTHESES,
  };
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(jsonFile, `${JSON.stringify(document, null, 2)}\n`);
  fs.writeFileSync(markdownFile, `${renderMechanismMap(HYPOTHESES, { generatedAt })}\n`);
  console.log(JSON.stringify({
    hypotheses: HYPOTHESES.length,
    top: document.selectedScreen,
    json: jsonFile,
    markdown: markdownFile,
  }, null, 2));
}

if (require.main === module) main();
