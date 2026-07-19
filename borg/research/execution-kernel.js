/**
 * Deterministic, side-effect-free execution accounting shared by shadow
 * scoring and counterfactual replay. It contains no network or order methods.
 */
'use strict';

const CRYPTO_TAKER_RATE = 0.07;
const SIMULATOR_VERSION = 'borg-execution-v2';
const FEE_MODEL_VERSION = 'polymarket-crypto-v1';

const FIDELITY_LEVELS = Object.freeze({
  L0: 'retrospective outcome scenario; no causal execution',
  L1: 'decision-time touch assumption',
  L2: 'latency-adjusted snapshot and displayed-depth walk',
  L3: 'event-time quote survival or print-based queue replay',
  L4: 'full order-book event replay with queue state',
  L5: 'exchange acknowledgement and live fill telemetry',
});

function number(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function qualityGrade({ connectionGap, stateSource, stateAgeMs }) {
  if (connectionGap || !Number.isFinite(stateAgeMs)) return 'F';
  if (stateSource === 'event' && stateAgeMs <= 500) return 'A';
  if (stateAgeMs <= 1500) return 'B';
  if (stateAgeMs <= 3000) return 'C';
  return 'F';
}

function executionFidelity({ model, dataQualityGrade = 'F', fullDepth = false, queueReplay = false, exchangeAck = false }) {
  if (exchangeAck) return { fidelityLevel: 'L5', executionFidelityGrade: dataQualityGrade === 'F' ? 'F' : 'A' };
  if (model === 'full_event_book') return { fidelityLevel: 'L4', executionFidelityGrade: dataQualityGrade === 'F' ? 'F' : 'A' };
  if (String(model || '').startsWith('event_order_') || queueReplay) {
    return { fidelityLevel: 'L3', executionFidelityGrade: dataQualityGrade === 'F' ? 'F' : (dataQualityGrade === 'A' ? 'A' : 'B') };
  }
  if (model === 'latency_1s' || fullDepth) {
    return { fidelityLevel: 'L2', executionFidelityGrade: dataQualityGrade === 'F' ? 'F' : (dataQualityGrade === 'A' ? 'B' : 'C') };
  }
  if (model === 'touch_immediate') return { fidelityLevel: 'L1', executionFidelityGrade: dataQualityGrade === 'F' ? 'F' : 'D' };
  return { fidelityLevel: 'L0', executionFidelityGrade: 'F' };
}

function simulateTakerTouch({ limitPrice, requestedSize, bestAsk, askSize, connectionGap = false, stateSource, stateAgeMs }) {
  const limit = number(limitPrice);
  const requested = number(requestedSize);
  const ask = number(bestAsk);
  const displayed = number(askSize);
  const grade = qualityGrade({ connectionGap, stateSource, stateAgeMs });
  const quoteSurvived = grade !== 'F' && ask != null && limit != null && ask <= limit + 1e-9;
  const fillSize = quoteSurvived && requested > 0 && displayed > 0 ? Math.min(requested, displayed) : 0;
  const fidelity = executionFidelity({ model: 'event_order_touch', dataQualityGrade: grade });
  return {
    filled: fillSize > 0,
    fillPrice: fillSize > 0 ? ask : null,
    fillSize,
    quoteSurvived,
    partial: fillSize > 0 && fillSize + 1e-9 < requested,
    dataQualityGrade: grade,
    executionFidelityGrade: fidelity.executionFidelityGrade,
    fidelityLevel: fidelity.fidelityLevel,
    capacityAtArrival: displayed && displayed > 0 ? displayed : 0,
  };
}

function binaryPnl({ side = 'BUY', token, outcome, fillPrice, fillSize, orderKind = 'taker', feeMultiplier = 1 }) {
  const price = number(fillPrice);
  const size = number(fillSize);
  if (price == null || size == null) return { gross: 0, fee: 0, net: 0 };
  const payout = outcome === token ? 1 : 0;
  const gross = side === 'BUY' ? size * (payout - price) : size * (price - payout);
  const fee = orderKind === 'taker'
    ? size * CRYPTO_TAKER_RATE * price * (1 - price) * feeMultiplier
    : 0;
  return { gross, fee, net: gross - fee };
}

module.exports = {
  CRYPTO_TAKER_RATE,
  SIMULATOR_VERSION,
  FEE_MODEL_VERSION,
  FIDELITY_LEVELS,
  binaryPnl,
  executionFidelity,
  qualityGrade,
  simulateTakerTouch,
};
