const test = require('node:test');
const assert = require('node:assert/strict');

const makeStrategies = require('../borg/shadow/strategies');
const {
  EthLateMaker,
  EthLateTaker,
  ETH_PORTFOLIO_CFG,
  qualifyEthLate,
  stableArm,
} = makeStrategies._test;

const engine = {
  seq: 0,
  _coid(name) { this.seq += 1; return `${name}-${this.seq}`; },
};

function ctx(id = 'market-1', overrides = {}) {
  return {
    now: Date.now(),
    market: { id, asset: 'eth' },
    tteSec: 50,
    phiFair: 0.95,
    upBook: { bids: [[0.74, 20]], asks: [[0.75, 20]], at: Date.now() },
    downBook: { bids: [[0.24, 20]], asks: [[0.25, 20]], at: Date.now() },
    ...overrides,
  };
}

test('ETH portfolio stake is 2% of the frozen $500 bankroll', () => {
  assert.equal(ETH_PORTFOLIO_CFG.stakeUsd, 10);
});

test('late qualification preserves G parameters and rejects other assets', () => {
  const qualified = qualifyEthLate(ctx());
  assert.equal(qualified.token, 'UP');
  assert.equal(qualified.ask, 0.75);
  assert.equal(qualifyEthLate(ctx('btc', { market: { id: 'btc', asset: 'btc' } })), null);
  assert.equal(qualifyEthLate(ctx('late', { tteSec: 4 })), null);
  assert.equal(qualifyEthLate(ctx('expensive', {
    upBook: { bids: [[0.85, 20]], asks: [[0.86, 20]] },
  })), null);
});

test('stable market assignment admits exactly one maker/taker arm', () => {
  for (let i = 0; i < 40; i++) {
    const id = `eth-market-${i}`;
    const taker = new EthLateTaker();
    const maker = new EthLateMaker();
    const actions = [
      ...taker.evaluate(ctx(id), engine),
      ...maker.evaluate(ctx(id), engine),
    ];
    assert.equal(actions.length, 1);
    assert.equal(actions[0].kind, stableArm(id));
    assert.ok(actions[0].price > 0 && actions[0].price < 1);
    assert.ok(actions[0].price * actions[0].size <= 10 + 1e-9);
  }
});

test('maker quote is back-of-queue and cancels when signal disappears', () => {
  let id = null;
  for (let i = 0; i < 20 && id == null; i++) {
    const candidate = `maker-${i}`;
    if (stableArm(candidate) === 'maker') id = candidate;
  }
  assert.ok(id);
  const maker = new EthLateMaker();
  const placed = maker.evaluate(ctx(id), engine);
  assert.equal(placed.length, 1);
  assert.equal(placed[0].action, 'place');
  assert.equal(placed[0].price, 0.74);
  assert.equal(placed[0].queueAhead, 20);

  const cancelled = maker.evaluate(ctx(id, { phiFair: 0.5 }), engine);
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].action, 'cancel');
  assert.equal(cancelled[0].note, 'signal_lost');
});
