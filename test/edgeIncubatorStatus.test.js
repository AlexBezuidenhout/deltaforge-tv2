'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  composeEdgeIncubatorStatus,
  loadStrategyRows,
} = require('../borg/research/edge-incubator-status');

test('incubator exposes exactly ten honest lifecycle rows with no live authority', () => {
  const priority = { lanes: [
    { program: 'certified_payoff_graph', active: true, status: 'ZERO_ECONOMIC', evidence: { qualified: 0 } },
    { program: 'rule_aware_crossvenue', active: true, status: 'ZERO_EXACT', evidence: { exactRuleMatches: 0 } },
    { program: 'options_implied_binary_residual', active: true, status: 'COLLECTING', evidence: { executable: 0 } },
    { program: 'fair_bound_passive_overlay', active: false, status: 'CAPTURE_ONLY', evidence: { decisions: 0 } },
  ] };
  const report = composeEdgeIncubatorStatus({
    priority,
    strategyRows: [
      { strategy: 'H43X_chainlink_tail_residual_v1', runtime_active: true,
        evaluations: '10', actions: '1', errors: '0', fills: '3', markets: '3', days: '1', pnl_2x: '-1.5' },
      { strategy: 'MAIN_LONGSHOT_0_20_V1', runtime_active: true,
        evaluations: '10', actions: '0', errors: '0', fills: '0', markets: '0', days: '0', pnl_2x: '0' },
    ],
    now: '2026-08-03T15:00:00.000Z',
  });
  assert.equal(report.lanes.length, 10);
  assert.equal(report.liveAuthority, false);
  assert.ok(report.lanes.every((lane) => lane.paperOnly && !lane.liveAuthority));
  assert.equal(report.lanes.find((lane) => lane.mechanismId === 'R07').lifecycle, 'DEAD');
  assert.equal(report.lanes.find((lane) => lane.mechanismId === 'N09').evidence.crossEventProposals, 0);
  assert.equal(report.lanes.find((lane) => lane.laneId === 'resolver-chainlink-tail-v1').evidence.pnl2x, -1.5);
  const h43 = report.lanes.find((lane) => lane.laneId === 'resolver-chainlink-tail-v1');
  assert.equal(h43.readiness.decisionState, 'ACCRUING_FROZEN_EVIDENCE');
  assert.equal(h43.readiness.gates.find((gate) => gate.id === 'independent_units').current, 3);
  assert.equal(h43.readiness.gates.find((gate) => gate.id === 'independent_units').target, 300);
  assert.equal(report.lanes.find((lane) => lane.mechanismId === 'R07').readiness.decisionState,
    'FALSIFIED');
});

test('dashboard edge-incubator route remains read-only', () => {
  const fs = require('node:fs');
  const route = fs.readFileSync(require('node:path').join(__dirname, '..', 'src/routes/borg.js'), 'utf8');
  assert.match(route, /research\/edge-incubator/);
  assert.match(route, /research\/evidence-epoch/);
  assert.doesNotMatch(route, /edge-incubator[\s\S]{0,300}createAndPostOrder/);
});

test('incubator strategy query binds exact frozen strategy and experiment identities', async () => {
  let params;
  const pool = {
    query: async (sql, values) => {
      assert.match(sql, /unnest\(\$1::text\[\],\$2::text\[\]\)/);
      assert.match(sql, /n\.experiment_id=o\.experiment_id/);
      params = values;
      return { rows: [] };
    },
  };
  await loadStrategyRows(pool);
  assert.equal(params.length, 2);
  assert.deepEqual(params[0].sort(), [
    'H43X_chainlink_tail_residual_v1',
    'MAIN_LONGSHOT_0_20_V1',
  ].sort());
  assert.deepEqual(params[1].sort(), [
    'h43x-chainlink-tail-residual-v1',
    'main-longshot-0-20-v1',
  ].sort());
});
