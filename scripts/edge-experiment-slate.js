#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { renderSlate, slateDocument } = require('../borg/research/edge-experiment-slate');

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function main() {
  const outDir = path.resolve(arg('--out-dir', path.join(__dirname, '..')));
  const document = slateDocument();
  fs.mkdirSync(outDir, { recursive: true });
  const json = path.join(outDir, 'EDGE_EXPERIMENT_SLATE.json');
  const markdown = path.join(outDir, 'EDGE_EXPERIMENT_SLATE.md');
  fs.writeFileSync(json, `${JSON.stringify(document, null, 2)}\n`);
  fs.writeFileSync(markdown, renderSlate(document));
  console.log(JSON.stringify({ lanes: document.lanes.length, manifestHash: document.manifestHash, json, markdown }, null, 2));
}

if (require.main === module) main();
