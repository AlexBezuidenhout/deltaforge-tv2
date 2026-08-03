'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

function routeBlock(source, route, nextRoute) {
  const start = source.indexOf(`router.get('${route}'`);
  const end = source.indexOf(`router.get('${nextRoute}'`, start);
  assert.notEqual(start, -1, `${route} route exists`);
  assert.notEqual(end, -1, `${nextRoute} route exists after ${route}`);
  return source.slice(start, end);
}

test('Flow status remains a constant-time heartbeat report', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'routes', 'borg.js'), 'utf8');
  const status = routeBlock(source, '/flow/status', '/flow/summary');

  assert.doesNotMatch(status, /FROM\s+pm_flow_trades/i);
  assert.doesNotMatch(status, /FROM\s+pm_flow_signals/i);
  assert.match(status, /source='flow_heartbeat'/);
  assert.match(status, /BROAD_CAPTURE_ONLY_CLOB_STRATEGY_PAUSED/);
  assert.match(status, /counter_window:\s*'collector_run'/);
});

test('BORG status is cached, single-connection and bounded to a recent gap sample', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'routes', 'borg.js'), 'utf8');
  const status = routeBlock(source, '/status', '/shadow/summary');

  assert.match(status, /dashboardReports\.get\(cacheKey,\s*10_000/);
  assert.match(status, /const client = await pool\.connect\(\)/);
  assert.match(status, /ORDER BY id DESC LIMIT 10000/);
  assert.doesNotMatch(status, /now\(\)\s*-\s*interval\s*'24 hours'/i);
});

test('Lab refreshers cannot overlap their own pending requests', () => {
  const source = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

  for (const lab of ['borg', 'flow', 'bookLab', 'crossVenue', 'dashboard']) {
    const title = lab[0].toUpperCase() + lab.slice(1);
    assert.match(source, new RegExp(`if \\(_${lab}Loading\\) return;`));
    assert.match(source, new RegExp(`try \\{ await load${title}Once\\(\\); \\} finally \\{ _${lab}Loading = false; \\}`));
  }
  assert.match(source, /AbortController/);
});
