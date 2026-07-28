'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ShadowEngine = require('../borg/shadow/engine');
const {
  buildPerformanceSnapshot,
} = require('../borg/research/meta-champion-performance');
const makeMetaStrategies = require('../borg/shadow/meta-champion-streak');
const {
  MetaChampionStreak,
  STRATEGY_NAME,
} = makeMetaStrategies._test;
const {
  ExperimentRegistry,
  readExperimentManifests,
} = require('../borg/research/experiment-registry');

const SOURCE_A = 'FWD_H24_hourly_flow_breakout_v1';
const SOURCE_B = 'FWD_H40_directional_entropy_breakout_v1';
const BASE_TIME = Date.parse('2026-07-28T08:00:00.000Z');

function outcomes(strategy, count, return2x, {
  start = BASE_TIME - 3_600_000,
  prefix = strategy,
} = {}) {
  return Array.from({ length: count }, (_, index) => ({
    strategy,
    market_id: `${prefix}-${index + 1}`,
    outcome_at: new Date(start + index * 60_000),
    pnl_2x: return2x * 10,
    entry_cash: '10.00',
    fills: '1',
  }));
}

function actionSource(name = SOURCE_A, actionFactory = null) {
  return {
    name,
    cadence: 'sampled',
    marketTypes: ['direction_5m'],
    onHalt: () => [],
    evaluate(ctx, engine) {
      if (actionFactory) return actionFactory(ctx, engine);
      return [{
        action: 'place',
        side: 'BUY',
        token: 'UP',
        price: 0.5,
        size: 20,
        kind: 'taker',
        queueAhead: 100,
        coid: engine._coid(name),
        executionModel: 'latency_1s',
      }];
    },
  };
}

function activate(strategy, rows, at = BASE_TIME) {
  strategy.updatePerformanceRows(rows.slice(0, -1), {
    asOfMs: at - 60_000,
    loadedAtMs: at - 60_000,
  });
  strategy.updatePerformanceRows(rows, {
    asOfMs: at,
    loadedAtMs: at,
  });
}

function healthyContext(now = BASE_TIME) {
  return {
    now,
    market: {
      id: 'current-market',
      asset: 'btc',
      market_type: 'direction_5m',
    },
    tteSec: 120,
    feedStale: false,
    upBook: {
      bids: [[0.49, 100]],
      asks: [[0.50, 100]],
      at: now,
      src: 'test',
    },
    downBook: {
      bids: [[0.49, 100]],
      asks: [[0.50, 100]],
      at: now,
      src: 'test',
    },
  };
}

test('performance summary parses DB strings and qualifies only stable independent outcomes', () => {
  const rows = outcomes(SOURCE_A, 20, 0.10);
  // A duplicate fill in one market changes that market's aggregate, not n.
  rows.push({
    ...rows[0],
    pnl_2x: '0.50',
    entry_cash: '5.00',
    fills: '1',
  });
  const snapshot = buildPerformanceSnapshot(rows, {
    sourceStrategies: [SOURCE_A],
    asOfMs: BASE_TIME,
  });
  const summary = snapshot.byStrategy.get(SOURCE_A);
  assert.equal(summary.independentMarkets, 20);
  assert.equal(summary.qualifies, true);
  assert.equal(summary.winStreak, 20);
  assert.ok(summary.lowerBoundReturn2x > 0);
  assert.equal(snapshot.ranked[0].strategy, SOURCE_A);
});

test('activation needs two distinct outcomes from the same candidate', () => {
  const strategy = new MetaChampionStreak({ sourceStrategies: [SOURCE_A, SOURCE_B] });
  const a20 = outcomes(SOURCE_A, 20, 0.10);
  const b1 = outcomes(SOURCE_B, 1, 0.30);

  strategy.updatePerformanceRows(a20, {
    asOfMs: BASE_TIME,
    loadedAtMs: BASE_TIME,
  });
  assert.equal(strategy.diagnostics().leader, null);
  assert.equal(strategy.diagnostics().pending.confirmations, 1);

  // The global snapshot changed, but SOURCE_A did not produce new evidence.
  strategy.updatePerformanceRows([...a20, ...b1], {
    asOfMs: BASE_TIME + 60_000,
    loadedAtMs: BASE_TIME + 60_000,
  });
  assert.equal(strategy.diagnostics().leader, null);
  assert.equal(strategy.diagnostics().pending.confirmations, 1);

  strategy.updatePerformanceRows([
    ...a20,
    ...outcomes(SOURCE_A, 1, 0.10, {
      start: BASE_TIME + 120_000,
      prefix: 'a-new',
    }),
    ...b1,
  ], {
    asOfMs: BASE_TIME + 120_000,
    loadedAtMs: BASE_TIME + 120_000,
  });
  assert.equal(strategy.diagnostics().leader.strategy, SOURCE_A);
});

test('engine evaluates ordinary sources before meta and records a paper-only mirrored intent', () => {
  const meta = new MetaChampionStreak({ sourceStrategies: [SOURCE_A] });
  activate(meta, outcomes(SOURCE_A, 21, 0.10));
  const source = actionSource();
  const engine = new ShadowEngine({
    clob: null,
    insertRows: async () => 0,
    logEvent: () => {},
    // Registration order intentionally puts the meta strategy first.
    strategies: [meta, source],
    collectionEpochId: 'meta-test-v1',
    collectorRunId: 'run-meta-test',
  });

  engine.tick(healthyContext(), 'sampled');
  assert.deepEqual(engine.buf.map((row) => row[1]), [SOURCE_A, STRATEGY_NAME]);
  const stored = JSON.parse(engine.buf[1][13]);
  assert.equal(stored.paper_only, true);
  assert.equal(stored.dynamic_meta_strategy, true);
  assert.equal(stored.meta_source_strategy, SOURCE_A);
  assert.equal(stored.execution_model, 'latency_1s');
  assert.ok(engine.buf[1][8] * engine.buf[1][9] <= 10);
  assert.ok(engine.buf[1][9] <= 20, 'meta participates in no more than 20% of touch');
});

test('a newly scored loss breaks the streak and immediately deactivates the leader', () => {
  const strategy = new MetaChampionStreak({ sourceStrategies: [SOURCE_A] });
  const winning = outcomes(SOURCE_A, 21, 0.10);
  activate(strategy, winning);
  assert.equal(strategy.diagnostics().leader.strategy, SOURCE_A);

  strategy.updatePerformanceRows([
    ...winning,
    ...outcomes(SOURCE_A, 1, -0.20, {
      start: BASE_TIME + 60_000,
      prefix: 'loss',
    }),
  ], {
    asOfMs: BASE_TIME + 60_000,
    loadedAtMs: BASE_TIME + 60_000,
  });
  assert.equal(strategy.diagnostics().leader, null);
  assert.equal(strategy.diagnostics().eligibleSources.length, 0);
});

test('switching requires minimum dwell, a material margin and two candidate outcomes', () => {
  const strategy = new MetaChampionStreak({
    sourceStrategies: [SOURCE_A, SOURCE_B],
    config: { minimumDwellMs: 1_000 },
  });
  const a21 = outcomes(SOURCE_A, 21, 0.10);
  const b19 = outcomes(SOURCE_B, 19, 0.30);
  strategy.updatePerformanceRows([...a21.slice(0, 20), ...b19], {
    asOfMs: BASE_TIME - 60_000,
    loadedAtMs: BASE_TIME - 60_000,
  });
  strategy.updatePerformanceRows([...a21, ...b19], {
    asOfMs: BASE_TIME,
    loadedAtMs: BASE_TIME,
  });
  assert.equal(strategy.diagnostics().leader.strategy, SOURCE_A);

  const b20 = outcomes(SOURCE_B, 20, 0.30);
  strategy.updatePerformanceRows([...a21, ...b20], {
    asOfMs: BASE_TIME + 2_000,
    loadedAtMs: BASE_TIME + 2_000,
  });
  assert.equal(strategy.diagnostics().leader.strategy, SOURCE_A);
  assert.equal(strategy.diagnostics().pending.strategy, SOURCE_B);

  const b21 = outcomes(SOURCE_B, 21, 0.30);
  strategy.updatePerformanceRows([...a21, ...b21], {
    asOfMs: BASE_TIME + 62_000,
    loadedAtMs: BASE_TIME + 62_000,
  });
  assert.equal(strategy.diagnostics().leader.strategy, SOURCE_B);
  assert.equal(strategy.diagnostics().outcomes.sourceSwitches, 1);
});

test('multi-leg, maker and stale-snapshot source actions are never mirrored', () => {
  for (const sourceActions of [
    [
      { action: 'place', side: 'BUY', token: 'UP', price: 0.5, size: 2, kind: 'taker', queueAhead: 10 },
      { action: 'place', side: 'BUY', token: 'DOWN', price: 0.5, size: 2, kind: 'taker', queueAhead: 10 },
    ],
    [
      { action: 'place', side: 'BUY', token: 'UP', price: 0.49, size: 2, kind: 'maker', queueAhead: 10 },
    ],
  ]) {
    const strategy = new MetaChampionStreak({ sourceStrategies: [SOURCE_A] });
    activate(strategy, outcomes(SOURCE_A, 21, 0.10));
    const result = strategy.evaluate(healthyContext(), {
      sourceActionsForTick: () => sourceActions,
      _coid: () => 'meta-test',
    });
    assert.deepEqual(result, []);
  }

  const stale = new MetaChampionStreak({ sourceStrategies: [SOURCE_A] });
  activate(stale, outcomes(SOURCE_A, 21, 0.10), BASE_TIME - 300_000);
  assert.deepEqual(stale.evaluate(healthyContext(BASE_TIME), {
    sourceActionsForTick: () => [],
  }), []);
  assert.equal(stale.diagnostics().lastReason, 'performance_snapshot_stale');
});

test('experiment registry freezes the selector as paper-only forward evidence', () => {
  const registry = new ExperimentRegistry(readExperimentManifests());
  const binding = registry.resolve(STRATEGY_NAME);
  assert.equal(binding.experimentId, 'meta-champion-streak-v1');
  assert.equal(binding.phase, 'eval');
  assert.equal(binding.minIndependentMarkets, 300);
  assert.equal(binding.minDays, 14);
});
