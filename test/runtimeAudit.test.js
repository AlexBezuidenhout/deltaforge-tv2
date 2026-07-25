'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ageSeconds, requiredHeartbeatComponents } = require('../scripts/runtime-audit');

test('runtime freshness accepts numeric and ISO heartbeat timestamps', () => {
  const now = Date.parse('2026-07-23T17:00:00.000Z');
  assert.equal(ageSeconds(now - 5_000, now), 5);
  assert.equal(ageSeconds('2026-07-23T16:59:55.000Z', now), 5);
  assert.equal(ageSeconds('not-a-date', now), null);
});

test('runtime health requires optional executors only when their live switch is enabled', () => {
  const paperOnly = requiredHeartbeatComponents({
    live_gla_enabled: false,
    live_flow_boundary_enabled: false,
    live_h53_enabled: false,
  });
  assert.ok(paperOnly.includes('main_bot'));
  assert.ok(paperOnly.includes('structural_scanner'));
  assert.equal(paperOnly.includes('gla_live'), false);
  assert.equal(paperOnly.includes('flow_boundary_canary'), false);
  assert.equal(paperOnly.includes('h53_live'), false);
  assert.equal(paperOnly.includes('paired_maker_lab'), false);

  const live = requiredHeartbeatComponents({
    live_gla_enabled: true,
    live_flow_boundary_enabled: true,
    live_h53_enabled: true,
  });
  assert.ok(live.includes('gla_live'));
  assert.ok(live.includes('flow_boundary_canary'));
  assert.ok(live.includes('h53_live'));
});
