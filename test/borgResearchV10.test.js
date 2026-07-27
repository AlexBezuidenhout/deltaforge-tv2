'use strict';

const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const makeV10 = require('../borg/shadow/research-v10');
const manifest = require('../borg/experiments/research-h58-source-causal-residual-v2.json');
const { ExperimentRegistry } = require('../borg/research/experiment-registry');

const {
  ResolverSourceCausalResidualV2,
  SOURCE_CLOCK_UNCERTAINTY_MS,
  STRATEGY_NAME,
} = makeV10._test;

const engine = { _coid: (strategy) => `test-${strategy}` };

function book(bid, ask, sourceAt, receiveAt, size = 100) {
  return {
    bids: [[bid, size]],
    asks: [[ask, size]],
    sourceAt,
    at: receiveAt,
    src: 'ws',
  };
}

function context(overrides = {}) {
  const sourceMs = overrides.triggerEvent?.sourceMs
    ?? Date.parse('2026-07-27T02:00:02.000Z');
  const receiveWallMs = overrides.triggerEvent?.receiveWallMs ?? sourceMs + 100;
  return {
    now: receiveWallMs,
    market: {
      id: 'h58v2-market',
      asset: 'btc',
      market_type: 'direction_5m',
      positive_label: 'UP',
      negative_label: 'DOWN',
      resolution_source: 'polymarket_crypto_5m',
    },
    tteSec: 90,
    upBook: book(0.19, 0.20, sourceMs - 1500, receiveWallMs - 20),
    downBook: book(0.79, 0.80, sourceMs - 1500, receiveWallMs - 20),
    resolverRef: 100,
    resolverRefSource: 'chainlink_rtds_nearest_3s',
    sigma: 0.01,
    volatility: { robustSigma5m: 0.008, rmsSigma5m: 0.012 },
    rtdsChainlink: 101,
    micro10: { returnBps: 2 },
    venue10: { returnBps: 2 },
    venueStale: false,
    triggerEvent: {
      source: 'chainlink_rtds',
      sourceMs,
      receiveWallMs,
      eventSequence: 2,
    },
    ...overrides,
  };
}

function warm(strategy, sourceMs) {
  return strategy.evaluate(context({
    now: sourceMs + 100,
    rtdsChainlink: 100,
    triggerEvent: {
      source: 'chainlink_rtds',
      sourceMs,
      receiveWallMs: sourceMs + 100,
      eventSequence: 1,
    },
  }), engine);
}

test('H58 v2 is a separately registered paper-only eight-arm successor', () => {
  const strategies = makeV10();
  assert.deepEqual(strategies.map((strategy) => strategy.name), [STRATEGY_NAME]);
  assert.equal(manifest.paper_only, true);
  assert.equal(manifest.live_order_path, 'disabled');
  assert.equal(manifest.parent_evidence_reused, false);
  const binding = manifest.strategy_bindings[0];
  assert.equal(binding.asset_timeframe_reporting_arms.length, 8);
  assert.equal(binding.minimum_independent_markets_per_asset_timeframe_arm, 300);
  assert.equal(binding.min_independent_markets, 2400);
  const registry = new ExperimentRegistry();
  assert.equal(registry.resolve(STRATEGY_NAME).experimentId, manifest.experiment_id);
  const source = fs.readFileSync(require.resolve('../borg/shadow/research-v10'), 'utf8');
  assert.doesNotMatch(source,
    /createAndPostOrder|process\.env\.(?:PRIVATE_KEY|POLYMARKET_PRIVATE_KEY)|@polymarket\/clob-client|require\(['"]ethers['"]\)/i);
});

test('H58 v2 rejects a book that only predates local RTDS receipt', () => {
  const strategy = new ResolverSourceCausalResidualV2();
  const previousMs = Date.parse('2026-07-27T02:00:00.000Z');
  assert.deepEqual(warm(strategy, previousMs), []);
  const currentMs = previousMs + 2000;
  const receiveMs = currentMs + 1560;
  const actions = strategy.evaluate(context({
    now: receiveMs,
    rtdsChainlink: 101,
    upBook: book(0.19, 0.20, currentMs + 1500, receiveMs - 10),
    downBook: book(0.79, 0.80, currentMs + 1500, receiveMs - 10),
    triggerEvent: {
      source: 'chainlink_rtds',
      sourceMs: currentMs,
      receiveWallMs: receiveMs,
      eventSequence: 2,
    },
  }), engine);
  assert.deepEqual(actions, []);
  const diagnostics = strategy.diagnostics().gateDiagnostics;
  assert.equal(diagnostics.rejectionCounts.book_not_source_causally_stale, 1);
});

test('H58 v2 uses the executable ask as prior after certified source ordering', () => {
  const strategy = new ResolverSourceCausalResidualV2();
  const previousMs = Date.parse('2026-07-27T02:00:00.000Z');
  warm(strategy, previousMs);
  const currentMs = previousMs + 2500;
  const receiveMs = currentMs + 100;
  const bookSourceMs = currentMs - SOURCE_CLOCK_UNCERTAINTY_MS - 100;
  const actions = strategy.evaluate(context({
    now: receiveMs,
    rtdsChainlink: 101,
    upBook: book(0.19, 0.20, bookSourceMs, receiveMs - 20),
    downBook: book(0.79, 0.80, bookSourceMs, receiveMs - 20),
    triggerEvent: {
      source: 'chainlink_rtds',
      sourceMs: currentMs,
      receiveWallMs: receiveMs,
      eventSequence: 2,
    },
  }), engine);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].features.paper_only, true);
  assert.equal(actions[0].features.market_prior_probability, actions[0].price);
  assert.equal(actions[0].features.market_prior_source, 'selected_executable_ask');
  assert.equal(actions[0].features.absolute_terminal_model_not_used_for_edge, true);
  assert.ok(actions[0].features.resolver_residual_lower > 0);
  assert.equal(
    actions[0].features.fair_lower_selected,
    actions[0].price + actions[0].features.resolver_residual_lower,
  );
});
