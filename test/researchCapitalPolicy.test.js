const test = require('node:test');
const assert = require('node:assert/strict');

const ShadowEngine = require('../borg/shadow/engine');
const {
  RESEARCH_CAPITAL_VERSION,
  STARTING_BANKROLL_USD,
  RISK_PER_TRADE_PCT,
  TARGET_STAKE_USD,
  MAX_GROSS_EXPOSURE_PCT,
} = require('../borg/research/capital-policy');

test('freezes all current research sizing to a $500, 2% cohort', () => {
  assert.equal(RESEARCH_CAPITAL_VERSION, '500usd-v1');
  assert.equal(STARTING_BANKROLL_USD, 500);
  assert.equal(RISK_PER_TRADE_PCT, 0.02);
  assert.equal(TARGET_STAKE_USD, 10);
  assert.equal(MAX_GROSS_EXPOSURE_PCT, 0.06);
});

test('persists research-capital attribution on every shadow decision', () => {
  const engine = new ShadowEngine({
    clob: null,
    insertRows: async () => 0,
    logEvent: () => {},
    strategies: [],
    collectionEpochId: 'dublin-test-v1',
    collectorRunId: 'run-test-1',
  });
  const features = engine._features({
    now: Date.now(),
    market: { asset: 'btc' },
    upBook: { bids: [], asks: [], at: Date.now() },
    downBook: { bids: [], asks: [], at: Date.now() },
  });
  assert.equal(features.research_capital_version, RESEARCH_CAPITAL_VERSION);
  assert.equal(features.research_starting_bankroll_usd, 500);
  assert.equal(features.research_target_stake_usd, 10);
  assert.equal(features.collection_epoch_id, 'dublin-test-v1');
  assert.equal(features.collector_run_id, 'run-test-1');
});

test('proves every eligible shadow strategy is being evaluated even when it stays quiet', () => {
  const quiet = {
    name: 'quiet_strategy', cadence: 'sampled', marketTypes: ['direction_5m'],
    evaluate: () => [], onHalt: () => [],
    diagnostics: () => ({ outcomes: { NO_ACTION: 1 } }),
  };
  const engine = new ShadowEngine({
    clob: null, insertRows: async () => 0, logEvent: () => {}, strategies: [quiet],
  });
  const now = Date.now();
  engine.tick({
    now,
    market: { id: 1, asset: 'btc', market_type: 'direction_5m' },
    feedStale: false,
    upBook: { bids: [], asks: [], at: now, src: 'test' },
    downBook: { bids: [], asks: [], at: now, src: 'test' },
  });
  const runtime = engine.runtimeStatus()[0];
  assert.equal(runtime.strategy, 'quiet_strategy');
  assert.equal(runtime.evaluations, 1);
  assert.equal(runtime.actions, 0);
  assert.equal(runtime.errors, 0);
  assert.equal(runtime.lastEvaluatedAt.getTime(), now);
  assert.deepEqual(runtime.diagnostics, { outcomes: { NO_ACTION: 1 } });
});

test('a missing complementary book halts evaluation instead of creating one-sided evidence', () => {
  let evaluated = 0;
  let halted = 0;
  const strategy = {
    name: 'two_book_strategy', cadence: 'sampled', marketTypes: ['direction_5m'],
    evaluate: () => { evaluated += 1; return []; },
    onHalt: () => { halted += 1; return []; },
  };
  const engine = new ShadowEngine({
    clob: null, insertRows: async () => 0, logEvent: () => {}, strategies: [strategy],
  });
  const now = Date.now();
  engine.tick({
    now, market: { id: 2, asset: 'btc', market_type: 'direction_5m' },
    feedStale: false,
    upBook: { bids: [[0.49, 10]], asks: [[0.51, 10]], at: now },
    downBook: null,
  });
  assert.equal(evaluated, 0);
  assert.equal(halted, 1);
  assert.equal(engine.runtimeStatus()[0].haltedEvaluations, 1);
});

test('appends a canonical decision before asynchronous database persistence', () => {
  const appended = [];
  const engine = new ShadowEngine({
    clob: null,
    insertRows: async () => 0,
    logEvent: () => {},
    strategies: [],
    decisionWal: { append: (raw) => appended.push(JSON.parse(raw)) },
  });
  const now = Date.now();
  engine._record('test_strategy', {
    now,
    tteSec: 240,
    market: { id: 9 },
  }, {
    action: 'place', side: 'BUY', token: 'UP', price: 0.55, size: 2,
    kind: 'taker', coid: 'decision-test', queueAhead: 10,
  }, {});
  assert.equal(appended.length, 1);
  assert.equal(appended[0].type, 'order_intent');
  assert.equal(appended[0].intent.price, 0.55);
  assert.equal(engine.buf.length, 1);
});
