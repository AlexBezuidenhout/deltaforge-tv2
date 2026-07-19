const test = require('node:test');
const assert = require('node:assert/strict');

const makeV3Strategies = require('../borg/shadow/research-v3');
const {
  AdaptiveBetaLag,
  ClobOnlyJumpFade,
  ComplementDesync,
  CrossAssetVolScore,
  CrossVenueBasisReversion,
  JumpAdjustedSigma,
  OpeningBasisConsensus,
  RobustVolScore,
  binaryFair,
  digitalImpliedSigma,
  inverseNormalCdf,
  normalCdf,
} = makeV3Strategies._test;

function engine() {
  return { seq: 0, _coid(name) { this.seq += 1; return `${name}-${this.seq}`; } };
}

function booksForUpMid(mid, spread = 0.02, size = 100) {
  const upBid = mid - spread / 2;
  const upAsk = mid + spread / 2;
  const downMid = 1 - mid;
  return {
    upBook: { bids: [[upBid, size]], asks: [[upAsk, size]] },
    downBook: { bids: [[downMid - spread / 2, size]], asks: [[downMid + spread / 2, size]] },
    upMid: mid,
  };
}

function ctx(overrides = {}) {
  const now = Date.now();
  return {
    now,
    market: { id: 'eth-v3-1', asset: 'eth' },
    tteSec: 120,
    btc: 100.5,
    ref: 100,
    sigma: 0.02,
    phiFair: 0.65,
    gammaUp: 0.55,
    micro10: { returnBps: 1, flowImbalance: 0.2, depthImbalance: 0.1 },
    micro30: { returnBps: 5, flowImbalance: 0.2, depthImbalance: 0.1 },
    venuePrice: 200,
    venue10: { returnBps: 1 },
    venueStale: false,
    volatility: {
      observations: 120,
      robustSigma5m: 0.01,
      rmsSigma5m: 0.02,
      ewmaSigma5m: 0.02,
      ewmaToRobust: 2,
      maxVarianceShare: 0.50,
    },
    ...booksForUpMid(0.55),
    ...overrides,
  };
}

test('v3 registers eight forward-only shadow pilots', () => {
  assert.deepEqual(makeV3Strategies().map((strategy) => strategy.name), [
    'H14_robust_volscore',
    'H15_jump_adjusted_sigma',
    'H16_cross_asset_volscore',
    'H17_opening_basis_consensus',
    'H18_adaptive_beta_lag',
    'H19_clob_only_jump_fade',
    'H20_cross_venue_basis_reversion',
    'H21_complement_desync',
  ]);
});

test('normal inverse and digital implied sigma are internally consistent', () => {
  for (const p of [0.05, 0.25, 0.55, 0.75, 0.95]) {
    assert.ok(Math.abs(normalCdf(inverseNormalCdf(p)) - p) < 1e-5);
  }
  const fair = binaryFair(100.5, 100, 0.02, 120);
  const implied = digitalImpliedSigma(fair, 100.5, 100, 120);
  assert.ok(Math.abs(implied - 0.02) < 1e-5);
});

test('robust VolScore trades only a material implied-versus-robust discrepancy', () => {
  const e = engine();
  const rich = new RobustVolScore().evaluate(ctx({ market: { id: 'h14-rich', asset: 'eth' } }), e);
  assert.equal(rich.length, 1);
  assert.equal(rich[0].token, 'UP');
  assert.equal(rich[0].executionModel, 'latency_1s');

  const robustFair = binaryFair(100.5, 100, 0.01, 120);
  const aligned = new RobustVolScore().evaluate(ctx({
    market: { id: 'h14-aligned', asset: 'eth' },
    ...booksForUpMid(robustFair),
  }), e);
  assert.equal(aligned.length, 0);
});

test('jump-adjusted sigma requires both outlier concentration and post-jump stability', () => {
  const good = new JumpAdjustedSigma().evaluate(ctx({
    market: { id: 'h15-good', asset: 'btc' },
    micro10: { returnBps: 1 },
  }), engine());
  assert.equal(good.length, 1);
  assert.equal(good[0].token, 'UP');

  const persistent = new JumpAdjustedSigma().evaluate(ctx({
    market: { id: 'h15-no-jump', asset: 'btc' },
    volatility: { ...ctx().volatility, maxVarianceShare: 0.10 },
  }), engine());
  assert.equal(persistent.length, 0);
});

test('cross-asset VolScore selects only a robust peer outlier', () => {
  const bot = new CrossAssetVolScore();
  const e = engine();
  const now = Date.now();
  const peerSigmas = [0.0085, 0.0095, 0.0105, 0.0115, 0.0125];
  for (const [i, asset] of ['btc', 'sol', 'bnb', 'doge', 'xrp'].entries()) {
    const probability = binaryFair(100.5, 100, peerSigmas[i], 120);
    bot.evaluate(ctx({
      now, market: { id: `peer-${asset}`, asset },
      ...booksForUpMid(probability),
    }), e);
  }
  const actions = bot.evaluate(ctx({
    now: now + 500,
    market: { id: 'h16-outlier', asset: 'eth' },
    ...booksForUpMid(0.55),
  }), e);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].token, 'UP');
});

test('opening-basis consensus uses independent venue opens and abstains on disagreement', () => {
  const e = engine();
  const goodBot = new OpeningBasisConsensus();
  const now = Date.now();
  assert.equal(goodBot.evaluate(ctx({
    now, tteSec: 295, market: { id: 'h17-good', asset: 'btc' },
    btc: 100, ref: 100, venuePrice: 200,
  }), e).length, 0);
  const good = goodBot.evaluate(ctx({
    now: now + 60000, tteSec: 235, market: { id: 'h17-good', asset: 'btc' },
    btc: 100.06, ref: 100, venuePrice: 200.12,
    ...booksForUpMid(0.44),
  }), e);
  assert.equal(good.length, 1);
  assert.equal(good[0].token, 'UP');

  const badBot = new OpeningBasisConsensus();
  badBot.evaluate(ctx({
    now, tteSec: 295, market: { id: 'h17-bad', asset: 'btc' },
    btc: 100, ref: 100, venuePrice: 200,
  }), e);
  const bad = badBot.evaluate(ctx({
    now: now + 60000, tteSec: 235, market: { id: 'h17-bad', asset: 'btc' },
    btc: 100.06, ref: 100, venuePrice: 199.88,
  }), e);
  assert.equal(bad.length, 0);
});

test('adaptive beta lag learns a causal beta before predicting catch-up', () => {
  const bot = new AdaptiveBetaLag();
  const baseSec = Math.floor(Date.now() / 1000) - 80;
  const btcSeries = [];
  const ethSeries = [];
  let btc = 100;
  let eth = 100;
  for (let i = 0; i < 75; i++) {
    const normalRet = ((i % 5) - 2) * 0.35;
    const btcRet = i >= 70 ? 1.2 : normalRet;
    const ethRet = i >= 70 ? 0 : normalRet + (i % 2 ? 0.05 : -0.05);
    btc *= Math.exp(btcRet / 10000);
    eth *= Math.exp(ethRet / 10000);
    btcSeries.push({ sec: baseSec + i, price: btc });
    ethSeries.push({ sec: baseSec + i, price: eth });
  }
  bot._series.set('btc', btcSeries);
  bot._series.set('eth', ethSeries);
  const actions = bot.evaluate(ctx({
    now: (baseSec + 74) * 1000 + 500,
    market: { id: 'h18-lag', asset: 'eth' },
    btc: eth,
    ref: eth * 0.999,
    sigma: 0.01,
    ...booksForUpMid(0.45),
  }), engine());
  assert.equal(actions.length, 1);
  assert.equal(actions[0].token, 'UP');
});

test('CLOB-only jump fade requires both token books to move coherently', () => {
  const bot = new ClobOnlyJumpFade();
  const e = engine();
  const now = Date.now();
  bot.evaluate(ctx({
    now, market: { id: 'h19-jump', asset: 'eth' }, btc: 100, phiFair: 0.50,
    ...booksForUpMid(0.50),
  }), e);
  const actions = bot.evaluate(ctx({
    now: now + 6000, market: { id: 'h19-jump', asset: 'eth' }, btc: 100, phiFair: 0.50,
    ...booksForUpMid(0.60),
  }), e);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].token, 'DOWN');
});

test('cross-venue basis reversion requires the opening gap to be closing', () => {
  const bot = new CrossVenueBasisReversion();
  const e = engine();
  const now = Date.now();
  bot.evaluate(ctx({
    now, tteSec: 295, market: { id: 'h20-basis', asset: 'btc' },
    btc: 100, ref: 100, venuePrice: 200,
  }), e);
  const actions = bot.evaluate(ctx({
    now: now + 90000, tteSec: 205, market: { id: 'h20-basis', asset: 'btc' },
    btc: 100.30, ref: 100, venuePrice: 199.80,
    micro10: { returnBps: -1 }, venue10: { returnBps: 1 },
    ...booksForUpMid(0.68),
  }), e);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].token, 'DOWN');
});

test('complement desync trades the moved cheap book against stable Phi and complement view', () => {
  const bot = new ComplementDesync();
  const e = engine();
  const now = Date.now();
  bot.evaluate(ctx({
    now, market: { id: 'h21-desync', asset: 'eth' }, phiFair: 0.50,
    ...booksForUpMid(0.50),
  }), e);
  const actions = bot.evaluate(ctx({
    now: now + 5000, market: { id: 'h21-desync', asset: 'eth' }, phiFair: 0.50,
    upMid: 0.40,
    upBook: { bids: [[0.39, 100]], asks: [[0.41, 100]] },
    downBook: { bids: [[0.49, 100]], asks: [[0.51, 100]] },
  }), e);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].token, 'UP');
});
