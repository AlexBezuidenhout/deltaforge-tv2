'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const { buildPriorityLaneStatus } = require('../borg/research/priority-lane-status');

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function manifest(relative) {
  return JSON.parse(read(relative));
}

test('priority research manifests are paper-only and preserve frozen H43', () => {
  const h43 = manifest('borg/experiments/research-h43-forward-v1.json');
  const structural = manifest('borg/experiments/structural-certified-payoff-graph-v5-orphan-reserve.json');
  const crossvenue = manifest('borg/experiments/crossvenue-exact-rule-convergence-v7.json');
  const options = manifest('borg/experiments/options-exact-expiry-residual-v4.json');
  for (const item of [h43, structural, crossvenue, options]) {
    assert.equal(item.paper_only, true);
    assert.equal(item.live_order_path, 'disabled');
    assert.equal(item.status, 'frozen');
  }
  assert.equal(h43.frozen_mechanics.strategy_code_changed, false);
  assert.equal(h43.frozen_mechanics.thresholds_changed, false);
  assert.equal(h43.strategy_bindings[0].strategy, 'H43_resolution_boundary_buffer');
});

test('fair-bound programme captures a frozen panel but cannot emit quotes', () => {
  const fair = manifest('borg/experiments/staged/fair-bound-passive-overlay-v1.json');
  const unit = read('ops/vps/borg-allmarket.service');
  assert.equal(fair.status, 'staged_not_collecting');
  assert.equal(fair.paper_only, true);
  assert.equal(fair.live_order_path, 'disabled');
  assert.match(unit, /Environment=ALLMARKET_PANEL_MODE=neglected/);
  assert.match(unit, /Environment=ALLMARKET_MAX_MARKETS=20/);
  assert.match(unit, /Environment=ALLMARKET_STRATEGY_SIGNALS_ENABLED=false/);
});

test('dashboard reports all five lanes without adding a live-order endpoint', () => {
  const report = read('borg/research/neglected-edge-report.js');
  const route = read('src/routes/borg.js');
  const dashboard = read('public/index.html');
  for (const program of [
    'resolver_boundary_transfer', 'certified_payoff_graph',
    'rule_aware_crossvenue', 'options_implied_binary_residual',
    'fair_bound_passive_overlay',
  ]) assert.match(report, new RegExp(program));
  assert.match(route, /research\/priority-lanes/);
  assert.match(route, /buildPriorityLaneStatus/);
  assert.match(dashboard, /id="priorityLanesBody"/);
  assert.doesNotMatch(route, /createAndPostOrder/);
});

test('structural dashboard reports use sparse positive evidence instead of full snapshot scans', () => {
  const report = read('borg/research/neglected-edge-report.js');
  const route = read('src/routes/borg.js');
  assert.match(report, /WITH positive AS MATERIALIZED/);
  assert.match(report, /e\.evaluated_at >= \$2/);
  assert.match(report, /e\.economic_candidate OR e\.qualified/);
  assert.match(route, /WHERE c\.universe_id=\$1\s+AND \(e\.economic_candidate OR e\.qualified\)/);
});

test('live lane status uses current heartbeats and sparse positive rows only', async () => {
  const now = new Date('2026-07-21T22:30:00.000Z');
  const heartbeatRows = [
    ['allmarket_lab', { collectionEpochId: 'epoch-v1',
      processStartedAt: new Date(now.getTime() - 120_000).toISOString(),
      lastEventAt: now.getTime(), panelMode: 'neglected',
      panelVersion: 'neglected-capacity-panel-v1', panelMembershipCount: 20,
      selectedMarkets: 20, subscribedTokens: 40, strategySignalsEnabled: false,
      decisions: 0, fills: 0 }],
    ['structural_scanner', { collectionEpochId: 'epoch-v1',
      processStartedAt: new Date(now.getTime() - 120_000).toISOString(),
      lastPersistedAt: now.toISOString(), candidates: 16, catalogCandidates: 100,
      tokens: 40, persistenceErrors: 0 }],
    ['crossvenue_lab', { collectionEpochId: 'epoch-v1',
      processStartedAt: new Date(now.getTime() - 120_000).toISOString(),
      lastEvaluationAt: now.getTime(), monitoredMatches: 44, approvedMatches: 2,
      paperApprovedMatches: 40, evaluations: 500, paperTradeLeads: 0,
      economicLeads: 0, lockableNonatomic: 0, kalshiErrors: 0 }],
    ['options_surface', { collectionEpochId: 'epoch-v1',
      processStartedAt: new Date(now.getTime() - 120_000).toISOString(),
      lastEventAt: now.getTime(), options: 38, targets: 10, polyTokens: 20,
      shadowMarks: 100, executableMarks: 0, flushRetries: 0,
      persistenceErrors: 0, parseErrors: 0, refreshErrors: 0 }],
  ].map(([component, meta]) => ({ component, meta, beat_at: now }));
  const fakePool = {
    query: async (sql) => {
      if (sql.includes('FROM system_heartbeats')) return { rows: heartbeatRows };
      if (sql.includes('FROM borg_collection_epochs')) {
        return { rows: [{ started_at: new Date(now.getTime() - 60_000) }] };
      }
      if (sql.includes('FROM borg_strategy_runtime')) {
        return { rows: [{ evaluations: '100', halted_evaluations: '0', actions: '1', errors: '0', last_evaluated_at: now }] };
      }
      if (sql.includes('FROM borg_structural_evaluations')) {
        return { rows: [{ economic: '0', qualified: '0', latest: null }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const status = await buildPriorityLaneStatus(fakePool, { now });
  assert.equal(status.format, 'borg-priority-lane-status-v1');
  assert.equal(status.lanes.length, 5);
  assert.equal(status.lanes[0].status, 'FORWARD_ACTIONS_COLLECTING');
  assert.equal(status.lanes[3].status, 'TARGETS_ACTIVE_NO_EXECUTABLE_MARKS');
  assert.equal(status.lanes[4].status, 'STAGED_CAPTURE_ACTIVE_STRATEGY_DISABLED');
  assert.equal(status.lanes[4].evidence.decisions, 0);
  assert.equal(status.liveAuthority, false);
});

test('a fresh crash-loop heartbeat cannot masquerade as active research', async () => {
  const now = new Date('2026-07-21T22:30:00.000Z');
  const heartbeatRows = [
    {
      component: 'allmarket_lab', beat_at: now,
      meta: {
        collectionEpochId: 'epoch-v1',
        processStartedAt: new Date(now.getTime() - 5_000).toISOString(),
        lastEventAt: null,
        panelMode: 'neglected',
        strategySignalsEnabled: false,
      },
    },
  ];
  const fakePool = {
    query: async (sql) => {
      if (sql.includes('FROM system_heartbeats')) return { rows: heartbeatRows };
      if (sql.includes('FROM borg_collection_epochs')) {
        return { rows: [{ started_at: new Date(now.getTime() - 60_000) }] };
      }
      if (sql.includes('FROM borg_strategy_runtime')) {
        return {
          rows: [{
            evaluations: '100', halted_evaluations: '0', actions: '1', errors: '0',
            last_evaluated_at: new Date(now.getTime() - 3_600_000),
          }],
        };
      }
      if (sql.includes('FROM borg_structural_evaluations')) return { rows: [{}] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const status = await buildPriorityLaneStatus(fakePool, { now });
  assert.equal(status.lanes[0].active, false);
  assert.equal(
    status.lanes[0].evidence.liveness.reason,
    'PROCESS_WARMING_OR_RESTARTING',
  );
  assert.equal(status.lanes[4].active, false);
});
