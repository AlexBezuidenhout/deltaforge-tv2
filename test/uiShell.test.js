'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'tv2-ui.css'), 'utf8');
const shell = fs.readFileSync(path.join(root, 'public', 'tv2-ui.js'), 'utf8');

test('dashboard shell exposes grouped navigation and persistent evidence controls', () => {
  assert.match(html, /class="app-sidebar"/);
  assert.match(html, />Monitor<\/li>/);
  assert.match(html, />Research<\/li>/);
  assert.match(html, />Tools<\/li>/);
  assert.match(html, /href="#dashboard"/);
  assert.match(html, /href="#borg"/);
  assert.match(html, /id="globalSystemState"/);
  assert.match(html, /id="globalEvidenceState"/);
  assert.match(html, /id="globalStorageState"/);
  assert.match(html, /id="globalArchiveState"/);
  assert.match(html, /tv2-ui\.css/);
  assert.match(html, /tv2-ui\.js/);
});

test('dashboard shell keeps runtime health distinct from evidence validity', () => {
  assert.match(shell, /Running ≠ valid|globalEvidenceState/);
  assert.match(shell, /promotionEligible/);
  assert.match(shell, /staleComponents/);
  assert.match(shell, /offhostArchive/);
  assert.match(shell, /verifiedBatches/);
});

test('dashboard shell is responsive, keyboard visible and motion aware', () => {
  assert.match(css, /@media \(max-width: 860px\)/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /\.nav-scrim/);
  assert.match(shell, /event\.key === 'Escape'/);
});
