'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const makePrioritySuccessors = require('../borg/shadow/priority-successors');
const { buildTailModel } = require('../scripts/train-h43x-tail-model');
const { ExperimentRegistry, readExperimentManifests } =
  require('../borg/research/experiment-registry');

const {
  H43XChainlinkTailResidual,
  H43X_NAME,
  LONGSHOT_NAME,
  MainLongshotSuccessor,
  MODEL_CUTOFF,
  validateTailModel,
} = makePrioritySuccessors._test;

function engine() {
  return { n: 0, _coid(name) { this.n += 1; return `${name}-${this.n}`; } };
}

function tailSamples(n = 400, move = 2) {
  const rows = [];
  for (const asset of ['btc', 'eth', 'sol', 'xrp']) {
    for (const horizonSec of [20, 45, 75]) {
      for (let index = 0; index < n; index += 1) {
        rows.push({ asset, horizonSec, terminalMoveBps: index % 2 ? move : -move });
      }
    }
  }
  return rows;
}

function model() {
  return buildTailModel(tailSamples(), { cutoff: MODEL_CUTOFF, days: 30 });
}

function context(overrides = {}) {
  const now = Date.now();
  return {
    now,
    market: {
      id: 'h43x-1',
      asset: 'btc',
      market_type: 'direction_5m',
      resolution_source: 'polymarket_crypto_5m',
    },
    tteSec: 40,
    resolverRef: 100,
    resolverRefSource: 'chainlink_rtds_nearest_3s',
    rtdsChainlink: 100.10,
    rtdsChainlinkAgeMs: 25,
    upBook: { bids: [[0.80, 100]], asks: [[0.81, 100]], at: now },
    downBook: { bids: [[0.18, 100]], asks: [[0.19, 100]], at: now },
    ...overrides,
  };
}

test('H43-X emits only when the frozen empirical lower bound clears executable costs', () => {
  const strategy = new H43XChainlinkTailResidual({ model: model() });
  const [action] = strategy.evaluate(context(), engine());
  assert.equal(strategy.name, H43X_NAME);
  assert.equal(action.token, 'UP');
  assert.equal(action.kind, 'taker');
  assert.equal(action.executionModel, 'event_order_250ms');
  assert.equal(action.features.paper_only, true);
  assert.ok(action.features.empirical_observations >= 300);
  assert.ok(action.features.edge_lower_after_2x_fees_and_tick > 0);
  assert.ok(action.price * action.size <= 10 + 1e-12);
  assert.equal(strategy.evaluate(context(), engine()).length, 0);
});

test('H43-X fails closed on future-trained, sparse, stale or untrusted resolver data', () => {
  const future = model();
  future.trainedThrough = '2026-08-04T00:00:00.000Z';
  future.sha256 = undefined;
  assert.equal(validateTailModel(future).valid, false);
  assert.equal(new H43XChainlinkTailResidual({ model: future })
    .evaluate(context(), engine()).length, 0);

  const sparse = buildTailModel(tailSamples(20), { cutoff: MODEL_CUTOFF, days: 30 });
  assert.equal(new H43XChainlinkTailResidual({ model: sparse })
    .evaluate(context(), engine()).length, 0);
  assert.equal(new H43XChainlinkTailResidual({ model: model() })
    .evaluate(context({ rtdsChainlinkAgeMs: 3001 }), engine()).length, 0);
  assert.equal(new H43XChainlinkTailResidual({ model: model() })
    .evaluate(context({ resolverRefSource: 'binance_1m_kline' }), engine()).length, 0);
});

test('longshot successor filters the first source intent without searching later quotes', () => {
  const calls = [];
  const source = {
    onHalt: () => [],
    diagnostics: () => ({ source: true }),
    evaluate() {
      calls.push(true);
      return [{ action: 'place', side: 'BUY', token: 'DOWN', price: 0.20, size: 10,
        kind: 'taker', coid: 'source', features: { paper_only: true }, note: 'source' }];
    },
  };
  const strategy = new MainLongshotSuccessor({ source });
  const [action] = strategy.evaluate(context(), engine());
  assert.equal(action.price, 0.20);
  assert.match(action.coid, new RegExp(`^${LONGSHOT_NAME}`));
  assert.equal(action.features.source_rule_unchanged, true);
  assert.equal(calls.length, 1);

  source.evaluate = () => [{ action: 'place', price: 0.21 }];
  assert.equal(strategy.evaluate(context({ market: { ...context().market, id: 'later' } }), engine()).length, 0);
});

test('priority successors have fresh paper-only 300-market registry bindings', () => {
  const registry = new ExperimentRegistry(readExperimentManifests());
  for (const name of [H43X_NAME, LONGSHOT_NAME]) {
    const binding = registry.resolve(name);
    assert.ok(binding.experimentId);
    assert.equal(binding.phase, 'eval');
    assert.equal(binding.minIndependentMarkets, 300);
    assert.equal(binding.minDays, 14);
  }
});
