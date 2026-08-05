'use strict';

const MODEL_VERSION = 'main-market-regime-v1';

const MODES = Object.freeze({
  DATA_UNREADY: 'DATA_UNREADY',
  CHOP: 'CHOP',
  DIRECTIONAL_IMPULSE: 'DIRECTIONAL_IMPULSE',
  ESTABLISHED_TREND: 'ESTABLISHED_TREND',
  VOLATILITY_TRANSITION: 'VOLATILITY_TRANSITION',
  TREND_DECAY: 'TREND_DECAY',
  REVERSAL_RISK: 'REVERSAL_RISK',
  BASELINE: 'BASELINE',
});

const POLICIES = Object.freeze({
  OBSERVE_ONLY: 'OBSERVE_ONLY',
  RESIDUAL_EXECUTABLE_HURDLE: 'RESIDUAL_EXECUTABLE_HURDLE',
  VOLATILITY_ENVELOPE_REQUIRED: 'VOLATILITY_ENVELOPE_REQUIRED',
});

function normalized(value) {
  return value == null ? null : String(value).trim().toUpperCase();
}

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Causal market-state label for MAIN telemetry and its paper-only challenger.
 *
 * This classifier deliberately reuses pre-existing scenario/indicator states;
 * it does not contain a PnL-selected numerical threshold. A mode determines
 * which evidence model is admissible, never a looser legacy EV threshold.
 */
function classify(input = {}) {
  const scenario = normalized(input.scenario);
  const indicatorRegime = normalized(input.indicatorRegime ?? input.indicators?.regime);
  const indicatorTrend = normalized(input.indicatorTrend ?? input.indicators?.trend);
  const btcDelta = finite(input.btcDelta);

  if (!scenario && !indicatorRegime) {
    return {
      mode: MODES.DATA_UNREADY,
      direction: null,
      reason: 'scenario and candle regime are unavailable',
      modelVersion: MODEL_VERSION,
    };
  }

  if (['NEWS_SPIKE', 'FAKE_BREAKOUT', 'MEAN_REVERSION'].includes(scenario)) {
    return {
      mode: MODES.REVERSAL_RISK,
      direction: null,
      reason: `scenario=${scenario} has path-dependent reversal/jump risk`,
      modelVersion: MODEL_VERSION,
    };
  }

  if (scenario === 'RANGE_CHOP' || scenario === 'RANGE_CHOP_GAMMA_OVERRIDE' ||
      indicatorRegime === 'CHOP') {
    return {
      mode: MODES.CHOP,
      direction: null,
      reason: `scenario=${scenario || 'n/a'} indicator=${indicatorRegime || 'n/a'}`,
      modelVersion: MODEL_VERSION,
    };
  }

  if (scenario === 'VOLATILITY_EXPANSION' || indicatorRegime === 'EXPANSION') {
    return {
      mode: MODES.VOLATILITY_TRANSITION,
      direction: btcDelta == null || btcDelta === 0 ? null : (btcDelta > 0 ? 'YES' : 'NO'),
      reason: `scenario=${scenario || 'n/a'} indicator=${indicatorRegime || 'n/a'}`,
      modelVersion: MODEL_VERSION,
    };
  }

  if (scenario === 'MOMENTUM_FADE') {
    return {
      mode: MODES.TREND_DECAY,
      direction: btcDelta == null || btcDelta === 0 ? null : (btcDelta > 0 ? 'YES' : 'NO'),
      reason: 'short-horizon impulse is losing strength',
      modelVersion: MODEL_VERSION,
    };
  }

  if (scenario === 'LAG_EDGE' || scenario === 'MOMENTUM_BREAKOUT') {
    const direction = btcDelta == null || btcDelta === 0 ? null : (btcDelta > 0 ? 'YES' : 'NO');
    const indicatorDirection = indicatorTrend === 'UP' ? 'YES'
      : indicatorTrend === 'DOWN' ? 'NO' : null;
    if (direction && indicatorDirection && direction !== indicatorDirection) {
      return {
        mode: MODES.REVERSAL_RISK,
        direction: null,
        reason: `short impulse ${direction} conflicts with candle trend ${indicatorDirection}`,
        modelVersion: MODEL_VERSION,
      };
    }
    return {
      mode: MODES.DIRECTIONAL_IMPULSE,
      direction: direction || indicatorDirection,
      reason: `scenario=${scenario} with no observed higher-horizon contradiction`,
      modelVersion: MODEL_VERSION,
    };
  }

  if (indicatorRegime === 'TREND_UP' || indicatorRegime === 'TREND_DOWN') {
    return {
      mode: MODES.ESTABLISHED_TREND,
      direction: indicatorRegime === 'TREND_UP' ? 'YES' : 'NO',
      reason: `indicator=${indicatorRegime}`,
      modelVersion: MODEL_VERSION,
    };
  }

  return {
    mode: MODES.BASELINE,
    direction: null,
    reason: `scenario=${scenario || 'n/a'} indicator=${indicatorRegime || 'n/a'}`,
    modelVersion: MODEL_VERSION,
  };
}

/**
 * The current forward prior supports exactly one active paper policy. All
 * other modes abstain or demand a separate uncertainty model. This prevents
 * post-hoc mode slicing from silently becoming production logic.
 */
function policyFor(mode) {
  if (mode === MODES.DIRECTIONAL_IMPULSE) {
    return {
      policy: POLICIES.RESIDUAL_EXECUTABLE_HURDLE,
      paperEligible: true,
      rationale: 'test a market-offset residual only when the causal impulse is coherent',
    };
  }
  if (mode === MODES.VOLATILITY_TRANSITION) {
    return {
      policy: POLICIES.VOLATILITY_ENVELOPE_REQUIRED,
      paperEligible: false,
      rationale: 'a single sigma estimate is inadmissible during a volatility transition',
    };
  }
  return {
    policy: POLICIES.OBSERVE_ONLY,
    paperEligible: false,
    rationale: 'no fresh evidence currently supports paying the executable spread in this mode',
  };
}

module.exports = {
  MODEL_VERSION,
  MODES,
  POLICIES,
  classify,
  policyFor,
};
