'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildFleetValidation,
  classifyProfiles,
  cohortKey,
  summarizeCohort,
} = require('../borg/research/execution-validation');
const {
  manifestForOrders,
  parseStrategyList,
} = require('../scripts/borg-full-depth-fleet-replay');

function rowsFor(options = {}) {
  const strategy = options.strategy || 'H_TEST';
  const experimentId = options.experimentId || 'frozen-v1';
  const profiles = options.profiles || [100, 250, 500];
  const count = options.count || 20;
  return profiles.flatMap((latencyMs) => Array.from({ length: count }, (_, index) => {
    const pnl = typeof options.pnl === 'function'
      ? options.pnl(latencyMs, index) : Number(options.pnl ?? 1);
    const state = typeof options.state === 'function'
      ? options.state(latencyMs, index) : 'ELIGIBLE_FILL';
    return {
      strategy,
      experimentId,
      arm: 'baseline',
      phase: 'eval',
      orderId: `${latencyMs}-${index}`,
      marketId: `market-${index}`,
      availableAt: new Date(Date.parse('2026-08-01T00:00:00Z') + index * 60_000).toISOString(),
      latencyMs,
      executionState: state,
      fillPrice: 0.5,
      fillSize: state === 'ELIGIBLE_FILL' ? 2 : 0,
      gross: pnl,
      pnl1x: pnl,
      pnl2x: pnl,
      pnl2xOneTick: pnl,
      detail: { full: true, tick_stress_available: true },
    };
  }));
}

test('cohort identity is collision safe and keeps experiment arms separate', () => {
  assert.notEqual(
    cohortKey({ strategy: 'ab', experimentId: 'c', arm: 'd', phase: 'e' }),
    cohortKey({ strategy: 'a', experimentId: 'bc', arm: 'd', phase: 'e' }),
  );
  assert.notEqual(
    cohortKey({ strategy: 'H1', experimentId: 'v1', arm: 'control', phase: 'eval' }),
    cohortKey({ strategy: 'H1', experimentId: 'v1', arm: 'challenger', phase: 'eval' }),
  );
});

test('robust positive requires all latency, doubled-cost, tick and half checks', () => {
  const summary = summarizeCohort(rowsFor(), { minMarkets: 20, minCoveragePct: 80 });
  assert.equal(summary.classification, 'ROBUST_POSITIVE');
  assert.equal(summary.executionValidated, true);
  assert.equal(summary.liveReady, false);
  assert.equal(summary.minimumScoreableMarkets, 20);
  assert.equal(summary.profiles.length, 3);
  assert.ok(summary.profiles.every((profile) => profile.pnl2xHalves.first > 0));
  assert.ok(summary.profiles.every((profile) => profile.pnl2xHalves.second > 0));
});

test('positive total is fragile when a chronological half or tick stress fails', () => {
  const halfFragile = summarizeCohort(rowsFor({
    pnl: (_latency, index) => index < 10 ? -0.25 : 1,
  }), { minMarkets: 20 });
  assert.equal(halfFragile.profiles[0].pnl2x > 0, true);
  assert.equal(halfFragile.classification, 'FRAGILE_POSITIVE');

  const profiles = halfFragile.profiles.map((profile) => ({
    ...profile,
    pnl2x: 1,
    pnl2xOneTick: 0,
    pnl2xHalves: { n: 20, first: 0.5, second: 0.5 },
    pnl2xOneTickHalves: { n: 20, first: 0, second: 0 },
  }));
  assert.equal(classifyProfiles(profiles).classification, 'FRAGILE_POSITIVE');
});

test('non-positive doubled-cost replay is execution negative', () => {
  const summary = summarizeCohort(rowsFor({
    pnl: (latencyMs) => latencyMs === 500 ? -1 : 1,
  }), { minMarkets: 20 });
  assert.equal(summary.classification, 'EXECUTION_NEGATIVE');
  assert.match(summary.reason, /500ms/);
});

test('missing archive rows do not become non-fills or meet the evidence minimum', () => {
  const summary = summarizeCohort(rowsFor({
    state: (_latency, index) => index < 5
      ? 'UNSCOREABLE_ARCHIVE_MISSING' : 'ELIGIBLE_FILL',
  }), { minMarkets: 20, minCoveragePct: 80 });
  assert.equal(summary.classification, 'INSUFFICIENT');
  assert.equal(summary.minimumScoreableMarkets, 15);
  assert.equal(summary.profiles[0].provenNonfills, 0);
  assert.equal(summary.profiles[0].unscoreable, 5);
});

test('fleet ranking is classification-first and never pools frozen cohorts', () => {
  const robust = rowsFor({ strategy: 'ROBUST', pnl: 1 });
  const negative = rowsFor({ strategy: 'NEGATIVE', pnl: -1 });
  const secondExperiment = rowsFor({
    strategy: 'ROBUST', experimentId: 'frozen-v2', count: 10, pnl: 2,
  });
  const report = buildFleetValidation([...negative, ...secondExperiment, ...robust], {
    minMarkets: 20,
  });
  assert.equal(report.cohorts.length, 3);
  assert.equal(report.cohorts[0].strategy, 'ROBUST');
  assert.equal(report.cohorts[0].experimentId, 'frozen-v1');
  assert.equal(report.cohorts[1].classification, 'EXECUTION_NEGATIVE');
  assert.equal(report.cohorts[2].classification, 'INSUFFICIENT');
});

test('fleet manifest and strategy CLI parsing are deterministic', () => {
  const orders = [
    {
      id: '2', strategy: 'H2', experiment_id: 'v1', arm: 'baseline', phase: 'eval',
      market_id: 'm2', available_at: '2026-08-02T00:00:00Z',
    },
    {
      id: '1', strategy: 'H2', experiment_id: 'v1', arm: 'baseline', phase: 'eval',
      market_id: 'm1', available_at: '2026-08-01T00:00:00Z',
    },
  ];
  const manifest = manifestForOrders(orders);
  assert.equal(manifest[0].independentMarkets, 2);
  assert.equal(manifest[0].firstAt, '2026-08-01T00:00:00.000Z');
  assert.deepEqual(parseStrategyList(' H2,H1,H2, '), ['H2', 'H1']);
});
