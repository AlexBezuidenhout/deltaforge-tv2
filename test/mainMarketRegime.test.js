'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const MainMarketRegime = require('../src/bot/MainMarketRegime');
const MainModelChallenger = require('../src/bot/MainModelChallenger');

test('MAIN regime classifier routes causal states to distinct evidence policies', () => {
  const impulse = MainMarketRegime.classify({
    scenario: 'LAG_EDGE', indicators: { regime: 'TREND_UP', trend: 'UP' }, btcDelta: 0.10,
  });
  assert.equal(impulse.mode, MainMarketRegime.MODES.DIRECTIONAL_IMPULSE);
  assert.equal(impulse.direction, 'YES');
  assert.equal(
    MainMarketRegime.policyFor(impulse.mode).policy,
    MainMarketRegime.POLICIES.RESIDUAL_EXECUTABLE_HURDLE,
  );

  const conflict = MainMarketRegime.classify({
    scenario: 'MOMENTUM_BREAKOUT', indicators: { regime: 'TREND_DOWN', trend: 'DOWN' }, btcDelta: 0.08,
  });
  assert.equal(conflict.mode, MainMarketRegime.MODES.REVERSAL_RISK);

  const expansion = MainMarketRegime.classify({
    scenario: 'VOLATILITY_EXPANSION', btcDelta: -0.05,
  });
  assert.equal(expansion.mode, MainMarketRegime.MODES.VOLATILITY_TRANSITION);
  assert.equal(
    MainMarketRegime.policyFor(expansion.mode).policy,
    MainMarketRegime.POLICIES.VOLATILITY_ENVELOPE_REQUIRED,
  );
  assert.equal(MainMarketRegime.policyFor(expansion.mode).paperEligible, false);
});

test('residual challenger clears costs only in an eligible mode and never creates an order', () => {
  const common = {
    marketProbability: 0.50,
    legacyProbability: 0.80,
    heuristicProbability: 0.80,
    phiProbability: 0.90,
    remainingSec: 120,
    sigma5min: 0.003,
    btcDelta: 0.10,
    yesAsk: 0.55,
    noAsk: 0.46,
  };
  const impulse = MainModelChallenger.evaluate({ ...common, scenario: 'LAG_EDGE' });
  const baseline = MainModelChallenger.evaluate({ ...common, scenario: 'NORMAL' });
  assert.equal(impulse.regimeChallengerEligible, true);
  assert.equal(impulse.regimeChallengerDirection, 'YES');
  assert.ok(impulse.regimeChallengerEdge > 0);
  assert.equal(baseline.regimeChallengerEligible, false);
  assert.equal('order' in impulse, false);
  assert.equal('size' in impulse, false);
});
