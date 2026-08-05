/**
 * MAIN regime matched experiment.
 *
 * The control is a fresh identity-only copy of the executable video-parity
 * reconstruction. The challenger consumes the exact same first source intent
 * and retains it only when the pre-cutoff residual model clears the executable
 * ask after doubled fees and one tick in a causal directional-impulse mode.
 *
 * Both arms are keyless BORG shadow strategies. This module has no signer,
 * wallet or live-order dependency.
 */
'use strict';

const makeMainVideoParityStrategies = require('./main-video-parity');
const MainModelChallenger = require('../../src/bot/MainModelChallenger');

const { MainVideoParity } = makeMainVideoParityStrategies._test;

const CONTROL_NAME = 'MAIN_REGIME_CONTROL_V1';
const CHALLENGER_NAME = 'MAIN_REGIME_RESIDUAL_V1';
const STRATEGY_VERSION = 'main-regime-residual-v1';

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function midpoint(book) {
  const bid = finite(book?.bids?.[0]?.[0]);
  const ask = finite(book?.asks?.[0]?.[0]);
  return bid != null && ask != null && ask >= bid ? (bid + ask) / 2 : null;
}

function executableInput(ctx, action) {
  const sourceFeatures = action.features || {};
  return {
    marketProbability: finite(ctx.upMid) ?? midpoint(ctx.upBook) ?? finite(ctx.gammaUp),
    legacyProbability: sourceFeatures.model_probability,
    heuristicProbability: sourceFeatures.p_heuristic,
    phiProbability: sourceFeatures.p_phi,
    remainingSec: ctx.tteSec,
    sigma5min: ctx.sigma,
    scenario: sourceFeatures.scenario,
    btcDelta: sourceFeatures.btc_delta_pct_60s,
    yesAsk: ctx.upBook?.asks?.[0]?.[0],
    noAsk: ctx.downBook?.asks?.[0]?.[0],
  };
}

class MainRegimeArm {
  constructor({ challenger }) {
    this.name = challenger ? CHALLENGER_NAME : CONTROL_NAME;
    this.marketTypes = ['direction_5m'];
    this.cadence = 'sampled';
    this.challenger = challenger;
    this.source = new MainVideoParity({ executionArm: 'taker250' });
    this._counts = new Map();
    this._retained = 0;
  }

  _count(reason) {
    this._counts.set(reason, (this._counts.get(reason) || 0) + 1);
  }

  onHalt(ctx, engine) {
    this._count('FEED_HALT');
    return this.source.onHalt(ctx, engine);
  }

  diagnostics() {
    return {
      paperOnly: true,
      provisional: true,
      matchedExperiment: STRATEGY_VERSION,
      arm: this.challenger ? 'regime_residual' : 'unchanged_control',
      sourceStrategy: 'MAIN_VIDEO_PARITY_V1__taker250',
      sourceFirstIntentConsumedEvenWhenFiltered: true,
      retainedIntents: this._retained,
      outcomes: Object.fromEntries(this._counts),
      source: this.source.diagnostics(),
    };
  }

  evaluate(ctx, engine) {
    const actions = this.source.evaluate(ctx, engine);
    if (!actions.length) return [];
    const action = actions[0];
    if (!this.challenger) {
      this._retained += 1;
      this._count('CONTROL_INTENT');
      return [this._rewrite(action, engine, {
        mechanism_family: 'main_regime_matched_control',
        matched_arm: 'unchanged_control',
      })];
    }

    const assessment = MainModelChallenger.evaluate(executableInput(ctx, action), new Date(ctx.now));
    if (!assessment) {
      this._count('RESIDUAL_INPUT_UNAVAILABLE');
      return [];
    }
    this._count(`MODE_${assessment.marketMode}`);
    const expectedToken = assessment.regimeChallengerDirection === 'YES' ? 'UP'
      : assessment.regimeChallengerDirection === 'NO' ? 'DOWN' : null;
    if (!assessment.regimeChallengerEligible) {
      this._count(`POLICY_REJECT_${assessment.modePolicy}`);
      return [];
    }
    if (expectedToken !== action.token) {
      this._count('RESIDUAL_DISAGREES_WITH_SOURCE');
      return [];
    }

    this._retained += 1;
    this._count('CHALLENGER_INTENT');
    return [this._rewrite(action, engine, {
      mechanism_family: 'market_offset_residual_by_causal_regime',
      matched_arm: 'regime_residual',
      market_mode: assessment.marketMode,
      market_mode_direction: assessment.marketModeDirection,
      market_mode_model_version: assessment.marketModeModelVersion,
      mode_policy: assessment.modePolicy,
      residual_model_version: assessment.residualModelVersion,
      market_baseline_probability: assessment.marketBaselineProbability,
      residual_probability: assessment.residualProbability,
      residual_selected_probability: assessment.regimeChallengerProbability,
      residual_selected_direction: assessment.regimeChallengerDirection,
      residual_edge_after_2x_fees_and_tick: assessment.regimeChallengerEdge,
      residual_direction_aligned: assessment.regimeChallengerDirectionAligned,
      historical_mode_selection_disclosed: true,
      paper_only: true,
      live_order_path: false,
      minimum_fresh_independent_markets: 300,
      minimum_fresh_days: 14,
      counterfactual_latency_profiles_ms: [100, 250, 500],
    })];
  }

  _rewrite(action, engine, extraFeatures) {
    return {
      ...action,
      coid: engine._coid(this.name),
      thesisVersion: STRATEGY_VERSION,
      features: {
        ...(action.features || {}),
        ...extraFeatures,
        matched_experiment: STRATEGY_VERSION,
        source_strategy: 'MAIN_VIDEO_PARITY_V1__taker250',
        discovery_rows_reused: false,
      },
      note: `${this.name} ${action.note || ''}`.trim(),
    };
  }
}

function makeMainRegimeStrategies() {
  return [
    new MainRegimeArm({ challenger: false }),
    new MainRegimeArm({ challenger: true }),
  ];
}

module.exports = makeMainRegimeStrategies;
module.exports._test = {
  CHALLENGER_NAME,
  CONTROL_NAME,
  MainRegimeArm,
  STRATEGY_VERSION,
  executableInput,
  midpoint,
};
