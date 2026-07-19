'use strict';

const model = require('./models/main-residual-v1.json');
const { predict } = require('./ResidualProbabilityModel');

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
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
  return {
    experimentId: model.experimentId,
    evidenceEligible: Number.isFinite(observedMs) && observedMs >= evidenceStartMs,
    marketBaselineProbability: marketProbability,
    legacyProbability,
    residualProbability,
    residualModelVersion: model.modelVersion,
  };
}

module.exports = { evaluate, model };
