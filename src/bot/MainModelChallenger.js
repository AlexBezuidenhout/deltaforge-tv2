'use strict';

const model = require('./models/main-residual-v1.json');
const { predict } = require('./ResidualProbabilityModel');
const MainMarketRegime = require('./MainMarketRegime');

const CRYPTO_TAKER_RATE = 0.07;
const COST_MULTIPLIER = 2;
const TOKEN_TICK = 0.01;

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function edgeAfterStress(probability, ask) {
  if (!(probability > 0 && probability < 1) || !(ask > 0 && ask < 1)) return null;
  return probability - ask - COST_MULTIPLIER * CRYPTO_TAKER_RATE * ask * (1 - ask) - TOKEN_TICK;
}

function executableAssessment({ residualProbability, yesAsk, noAsk, regime }) {
  const candidates = [
    { direction: 'YES', probability: residualProbability, ask: finite(yesAsk) },
    { direction: 'NO', probability: 1 - residualProbability, ask: finite(noAsk) },
  ].map((candidate) => ({
    ...candidate,
    edgeAfter2xFeesAndTick: edgeAfterStress(candidate.probability, candidate.ask),
  })).filter((candidate) => candidate.edgeAfter2xFeesAndTick != null)
    .sort((left, right) => right.edgeAfter2xFeesAndTick - left.edgeAfter2xFeesAndTick);
  const selected = candidates[0] || null;
  const policy = MainMarketRegime.policyFor(regime.mode);
  const directionAligned = !regime.direction || selected?.direction === regime.direction;
  return {
    ...policy,
    direction: selected?.direction ?? null,
    executableAsk: selected?.ask ?? null,
    probability: selected?.probability ?? null,
    edgeAfter2xFeesAndTick: selected?.edgeAfter2xFeesAndTick ?? null,
    directionAligned,
    eligible: Boolean(
      policy.paperEligible &&
      selected &&
      directionAligned &&
      selected.edgeAfter2xFeesAndTick > 0
    ),
  };
}

/**
 * Paired forecasts only. This module has no order, sizing, gate or execution
 * dependency and cannot alter Main's current decision.
 */
function evaluate(input, observedAt = new Date()) {
  const marketProbability = finite(input.marketProbability);
  const legacyProbability = finite(input.legacyProbability);
  if (!(marketProbability > 0 && marketProbability < 1)) return null;
  const residualProbability = predict(model, {
    marketProbability,
    heuristicProbability: input.heuristicProbability,
    phiProbability: input.phiProbability,
    remainingSec: input.remainingSec,
    sigma5min: input.sigma5min,
  });
  const observedMs = new Date(observedAt).getTime();
  const evidenceStartMs = new Date(model.evidenceStart).getTime();
  const regime = MainMarketRegime.classify({
    scenario: input.scenario,
    indicators: input.indicators,
    indicatorRegime: input.indicatorRegime,
    indicatorTrend: input.indicatorTrend,
    btcDelta: input.btcDelta,
  });
  const executable = executableAssessment({
    residualProbability,
    yesAsk: input.yesAsk,
    noAsk: input.noAsk,
    regime,
  });
  return {
    experimentId: model.experimentId,
    evidenceEligible: Number.isFinite(observedMs) && observedMs >= evidenceStartMs,
    marketBaselineProbability: marketProbability,
    legacyProbability,
    residualProbability,
    residualModelVersion: model.modelVersion,
    marketMode: regime.mode,
    marketModeDirection: regime.direction,
    marketModeReason: regime.reason,
    marketModeModelVersion: regime.modelVersion,
    modePolicy: executable.policy,
    modePolicyRationale: executable.rationale,
    regimeChallengerDirection: executable.direction,
    regimeChallengerExecutableAsk: executable.executableAsk,
    regimeChallengerProbability: executable.probability,
    regimeChallengerEdge: executable.edgeAfter2xFeesAndTick,
    regimeChallengerDirectionAligned: executable.directionAligned,
    regimeChallengerEligible: executable.eligible,
  };
}

module.exports = {
  COST_MULTIPLIER,
  CRYPTO_TAKER_RATE,
  TOKEN_TICK,
  edgeAfterStress,
  evaluate,
  executableAssessment,
  model,
};
