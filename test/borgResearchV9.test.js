'use strict';

const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const makeV9 = require('../borg/shadow/research-v9');
const manifest = require('../borg/experiments/research-v9-h74-h75-paper-v1.json');
const { ExperimentRegistry } = require('../borg/research/experiment-registry');
const { dossierFor } = require('../borg/research/strategy-dossiers');

const {
  MinuteTape,
  STRATEGY_NAMES,
  incrementalResidualAction,
  leadLagProfile,
  markovProfile,
} = makeV9._test;

function book(bid, ask, size = 100, at = Date.now()) {
  return {
    bids: [[bid, size]],
    asks: [[ask, size]],
    at,
    sourceAt: at - 1,
    src: 'ws',
  };
}

function context(overrides = {}) {
  const now = overrides.now || Date.parse('2026-07-26T16:05:00.000Z');
  return {
    now,
    market: {
      id: 'v9-market',
      asset: 'btc',
      market_type: 'direction_15m',
      positive_label: 'UP',
      negative_label: 'DOWN',
      window_end: new Date(now + 300_000),
    },
    tteSec: 300,
    btc: 100,
    ref: 100,
    resolverRef: 100,
    resolverRefSource: 'chainlink_rtds_nearest_3s',
    sigma: 0.005,
    volatility: { robustSigma5m: 0.005, rmsSigma5m: 0.005 },
    rtdsChainlink: 100,
    rtdsChainlinkAgeMs: 10,
    venuePrice: 100,
    venueStale: false,
    hyperPrice: 100,
    hyperStale: false,
    upBook: book(0.45, 0.46, 100, now),
    downBook: book(0.53, 0.54, 100, now),
    triggerEvent: null,
    ...overrides,
  };
}

test('V9 registers two frozen paper-only strategies with no live-order dependency', () => {
  const strategies = makeV9();
  assert.deepEqual(strategies.map((strategy) => strategy.name), STRATEGY_NAMES);
  assert.ok(strategies.every((strategy) =>
    strategy.marketTypes.length === 1 && strategy.marketTypes[0] === 'direction_15m'));
  assert.equal(manifest.paper_only, true);
  assert.equal(manifest.live_order_path, 'disabled');
  assert.equal(manifest.strategy_bindings.length, 2);
  const source = fs.readFileSync(require.resolve('../borg/shadow/research-v9'), 'utf8');
  assert.doesNotMatch(source,
    /createAndPostOrder|process\.env\.(?:PRIVATE_KEY|POLYMARKET_PRIVATE_KEY)|@polymarket\/clob-client|require\(['"]ethers['"]\)/i);

  for (const strategy of strategies) {
    assert.deepEqual(strategy.evaluate(context(), {
      _coid: () => 'unused',
    }), []);
    const gate = strategy.diagnostics().gateDiagnostics;
    assert.equal(gate.evaluations, 1);
    assert.equal(gate.rejectedEvaluations, 1);
    assert.ok(gate.topRejection?.reason);
  }
});

test('V9 governance excludes development rows and keeps every asset arm', () => {
  assert.ok(Date.parse(manifest.evidence_started_at)
    > Date.parse(manifest.development_data_cutoff));
  assert.ok(manifest.strategy_bindings.every((binding) =>
    binding.min_independent_markets === 1200
      && binding.minimum_independent_markets_per_asset === 300
      && ['btc', 'eth', 'sol', 'xrp'].every((asset) => binding.assets.includes(asset))));
  assert.match(manifest.research_design.selection_correction, /No ETH-only arm/);
  assert.match(manifest.evaluation.multiple_testing, /H1-H75/);
  const registry = new ExperimentRegistry();
  for (const strategy of STRATEGY_NAMES) {
    const binding = registry.resolve(strategy);
    assert.equal(binding.experimentId, manifest.experiment_id);
    assert.equal(binding.phase, 'eval');
    assert.equal(binding.minIndependentMarkets, 1200);
  }
  const h74 = dossierFor(STRATEGY_NAMES[0]);
  const h75 = dossierFor(STRATEGY_NAMES[1]);
  assert.match(h74.priorOutcome, /development prior was negative/i);
  assert.match(h75.priorOutcome, /23 episodes/);
});

test('minute tape parses string fields, replaces repeated rows and exposes only complete minutes', () => {
  const tape = new MinuteTape();
  const base = Date.parse('2026-07-26T12:00:00.000Z');
  tape.observe(context({
    now: base + 10_000,
    market: { id: 1, asset: 'btc' },
    btc: '100.10',
    micro60: { flowImbalance: '0.20', trades: '10', volume: '4.5' },
  }));
  tape.observe(context({
    now: base + 59_000,
    market: { id: 1, asset: 'btc' },
    btc: '100.20',
    micro60: { flowImbalance: '0.30', trades: '12', volume: '5.5' },
  }));
  assert.equal(tape.complete('btc', base + 59_500).length, 0);
  const completed = tape.complete('btc', base + 61_000);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].close, 100.2);
  assert.equal(completed[0].flow, 0.3);
  assert.equal(completed[0].trades, 12);
  assert.equal(completed[0].volume, 5.5);
});

test('minute tape hydrates Postgres DECIMAL strings without inventing missing flow', () => {
  const tape = new MinuteTape();
  const accepted = tape.hydrate([
    {
      asset: 'eth',
      minute: '2026-07-26T12:00:00.000Z',
      close: '3000.25',
      buy_vol: '6.5',
      sell_vol: '3.5',
      n_trades: '42',
    },
    {
      asset: 'eth',
      minute: '2026-07-26T12:01:00.000Z',
      close: '3001.25',
      volume: '5',
      n_trades: '12',
    },
  ]);
  assert.equal(accepted, 2);
  const rows = tape.complete('eth', Date.parse('2026-07-26T12:02:00.000Z'));
  assert.equal(rows[0].flow, 0.3);
  assert.equal(rows[0].trades, 42);
  assert.equal(rows[1].flow, null);
});

test('Markov profile requires an identifiable state and a 99% directional bound', () => {
  const returns = [];
  for (let index = 0; index < 80; index += 1) {
    returns.push(
      -2 - (index % 3) * 0.01,
      2 + ((index % 5) - 2) * 0.5,
      2 + ((index % 7) - 3) * 0.5,
    );
  }
  returns.push(-2);
  const profile = markovProfile(returns);
  assert.ok(profile);
  assert.equal(profile.sign, 1);
  assert.ok(profile.stateTransitions >= 30);
  assert.ok(profile.transitionEntropy <= 0.90);
  assert.ok(profile.empiricalLower99Bps > 0);
  assert.ok(profile.conservativeForecastBps > 0);

  const noise = Array.from({ length: 240 }, (_, index) =>
    index % 2 ? 1 : -1);
  assert.equal(markovProfile(noise), null);
});

test('dynamic lead-lag selects a stable leader only after a liquidity-confirmed underresponse', () => {
  const rows = [];
  let previousBtc = 0;
  for (let index = 0; index < 241; index += 1) {
    const ordinaryBtc = (index % 11 - 5) * 0.3 + (index % 17 === 0 ? 2 : 0);
    const btc = index === 240 ? 10 : ordinaryBtc;
    const eth = index === 240
      ? 0
      : 0.8 * previousBtc + ((index % 5) - 2) * 0.01;
    const sol = ((index * 7) % 13 - 6) * 0.2;
    const xrp = ((index * 11) % 17 - 8) * 0.15;
    rows.push({
      minute: index * 60_000,
      returns: { btc, eth, sol, xrp },
      flow: {
        btc: index === 240 ? 0.9 : Math.max(-0.7, Math.min(0.7, btc / 3)),
        eth: index === 240 ? 0.1 : Math.max(-0.6, Math.min(0.6, eth / 3)),
        sol: 0.1,
        xrp: -0.1,
      },
    });
    previousBtc = btc;
  }
  const profile = leadLagProfile(rows, 'eth');
  assert.ok(profile);
  assert.equal(profile.leader, 'btc');
  assert.equal(profile.target, 'eth');
  assert.equal(profile.sign, 1);
  assert.ok(profile.lagBetaLower95 > 0);
  assert.ok(profile.lagCorrelationLower95 > 0);
  assert.ok(profile.conservativeForecastBps > 0);

  const noFlow = rows.map((row) => ({
    ...row,
    flow: { ...row.flow, btc: row.minute === 240 * 60_000 ? -0.9 : row.flow.btc },
  }));
  assert.equal(leadLagProfile(noFlow, 'eth'), null);
});

test('state forecast must create incremental edge and produces a bounded paper intent', () => {
  const engine = {
    sequence: 0,
    _coid(strategy) {
      this.sequence += 1;
      return `test-${strategy}-${this.sequence}`;
    },
  };
  const action = incrementalResidualAction({
    ctx: context(),
    engine,
    strategy: STRATEGY_NAMES[1],
    sign: 1,
    forecastBps: 8,
    note: 'synthetic lead-lag',
    features: { synthetic_test: true },
  });
  assert.ok(action);
  assert.equal(action.action, 'place');
  assert.equal(action.token, 'UP');
  assert.equal(action.features.paper_only, true);
  assert.ok(action.features.base_edge_2x_per_share < 0.01);
  assert.ok(action.features.shifted_edge_2x_per_share >= 0.01);
  assert.ok(action.features.simulated_notional_usd <= 10 + 1e-9);

  const alreadyQualified = incrementalResidualAction({
    ctx: context({ upBook: book(0.35, 0.36) }),
    engine,
    strategy: STRATEGY_NAMES[1],
    sign: 1,
    forecastBps: 8,
    note: 'already qualified',
    features: {},
  });
  assert.equal(alreadyQualified, null);
});
