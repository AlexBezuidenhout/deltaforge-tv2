'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  FAST_MAX_AGE_SEC,
  TIMER_MAX_AGE_SEC,
  activeFleetBotComponents,
  classifyHeartbeats,
  heartbeatRowFresh,
  heartbeatPolicies,
  researchFleetRequired,
} = require('../src/monitoring/heartbeatPolicy');

test('dashboard-only TV2 process monitors the fleet without gaining runner authority', () => {
  assert.equal(researchFleetRequired('tv2-dashboard'), true);
  assert.equal(researchFleetRequired('tv2'), true);
  assert.equal(researchFleetRequired('df2-dashboard'), false);
  assert.equal(researchFleetRequired('tv2-dashboard', 'false'), false);
  assert.equal(heartbeatPolicies({}, { researchRequired: true })
    .public_info_collector.required, true);
});

test('fleet bot count is derived from configured fresh heartbeats', () => {
  const heartbeats = {
    main_bot: { ageSec: 7, maxAgeSec: FAST_MAX_AGE_SEC, stale: false },
    george_bot: { ageSec: 121, maxAgeSec: FAST_MAX_AGE_SEC, stale: false },
  };
  assert.equal(heartbeatRowFresh(heartbeats.main_bot), true);
  assert.equal(heartbeatRowFresh(heartbeats.george_bot), false);
  assert.deepEqual(activeFleetBotComponents(heartbeats, {
    is_active: true,
    george_is_active: true,
  }), ['main_bot']);
});

test('five-minute maintenance jobs allow two missed schedules, not 120 seconds', () => {
  const policy = heartbeatPolicies({}, { researchRequired: true });
  assert.equal(policy.hot_partition_manager.maxAgeSec, TIMER_MAX_AGE_SEC);
  assert.equal(policy.raw_archiver.maxAgeSec, TIMER_MAX_AGE_SEC);
  assert.equal(policy.borg_scorer.maxAgeSec, TIMER_MAX_AGE_SEC);

  const heartbeats = classifyHeartbeats([
    { component: 'hot_partition_manager', age_sec: 300, msg: null },
    { component: 'raw_archiver', age_sec: 659, msg: null },
    { component: 'borg_scorer', age_sec: 661, msg: null },
  ], policy);
  assert.equal(heartbeats.hot_partition_manager.stale, false);
  assert.equal(heartbeats.raw_archiver.stale, false);
  assert.equal(heartbeats.borg_scorer.stale, true);
});

test('parked experiments and disabled live executors cannot degrade health', () => {
  const policy = heartbeatPolicies({
    live_gla_enabled: false,
    live_h53_enabled: false,
    live_eth_g_late_enabled: false,
    live_flow_boundary_enabled: false,
  }, { researchRequired: true, pairedMakerRequired: false });
  const heartbeats = classifyHeartbeats([
    { component: 'paired_maker_lab', age_sec: 200000, msg: null },
    { component: 'gla_live', age_sec: 200000, msg: null },
  ], policy);

  assert.equal(heartbeats.paired_maker_lab.required, false);
  assert.equal(heartbeats.paired_maker_lab.stale, false);
  assert.equal(heartbeats.gla_live.required, false);
  assert.equal(heartbeats.gla_live.stale, false);
});

test('enabled live executors are required and retain the fast threshold', () => {
  const policy = heartbeatPolicies({
    live_gla_enabled: true,
    live_eth_g_late_enabled: true,
  }, {
    researchRequired: true,
  });
  const heartbeats = classifyHeartbeats([
    { component: 'gla_live', age_sec: FAST_MAX_AGE_SEC + 1, msg: null },
  ], policy);
  assert.equal(heartbeats.gla_live.required, true);
  assert.equal(heartbeats.gla_live.stale, true);
  assert.equal(heartbeats.gla_live.reason, 'heartbeat_stale');
  assert.equal(policy.eth_g_late_live.required, true);
});

test('required components are degraded when their heartbeat row is missing', () => {
  const policy = {
    main_bot: { required: true, maxAgeSec: FAST_MAX_AGE_SEC },
    optional_probe: { required: false, maxAgeSec: FAST_MAX_AGE_SEC },
  };
  const heartbeats = classifyHeartbeats([], policy);
  assert.equal(heartbeats.main_bot.stale, true);
  assert.equal(heartbeats.main_bot.reason, 'heartbeat_missing');
  assert.equal(heartbeats.optional_probe.stale, false);
});

test('collector feed degradation is distinct from process silence', () => {
  const policy = {
    borg_collector: { required: true, maxAgeSec: FAST_MAX_AGE_SEC },
  };
  const heartbeats = classifyHeartbeats([
    { component: 'borg_collector', age_sec: 3, msg: 'STALE: binance>10s' },
  ], policy);
  assert.equal(heartbeats.borg_collector.stale, true);
  assert.equal(heartbeats.borg_collector.reason, 'feed_degraded');
  assert.equal(heartbeats.borg_collector.feedStatus, 'STALE: binance>10s');
});

test('a fresh maintenance failure is degraded with its explicit reason', () => {
  const policy = {
    hot_partition_manager: { required: true, maxAgeSec: TIMER_MAX_AGE_SEC },
  };
  const heartbeats = classifyHeartbeats([{
    component: 'hot_partition_manager',
    age_sec: 2,
    msg: null,
    meta: {
      status: 'DEGRADED',
      errorCount: 1,
      errors: [{ phase: 'retention_authority', error: 'off-host receipt is stale' }],
    },
  }], policy);

  assert.equal(heartbeats.hot_partition_manager.stale, true);
  assert.equal(
    heartbeats.hot_partition_manager.reason,
    'component_reported_failure',
  );
  assert.equal(heartbeats.hot_partition_manager.reportedStatus, 'DEGRADED');
  assert.equal(heartbeats.hot_partition_manager.detail, 'off-host receipt is stale');
});
