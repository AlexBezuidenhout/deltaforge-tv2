/**
 * PhiModel — closed-form fair probability for BTC up/down binary markets.
 *
 *   P(UP wins) = Φ((btc_now − ref) / (σ × √(tte / windowSec)))
 *
 * As tte → 0 with btc > ref, z → ∞ and P → 1. As tte → 0 with btc < ref, P → 0.
 *
 * Replaces the v2 heuristic `modelProb = yesPrice + btcEdge` which ignored
 * time-to-resolve. A 0.05% BTC move 5 s before close is decisive; the same
 * move 240 s before close is noise. Φ encodes that.
 *
 * Inputs (all SI / decimals — caller must coerce):
 *   btcPrice   current BTC spot price (USD)
 *   refPrice   BTC at market open (open of the 5m kline that covers start)
 *   ttseSec    seconds until resolution
 *   sigma5min  empirical 5-min log-return stdev (rolling, dynamic)
 *   windowSec  full market window length (default 300 for 5m markets)
 */

const DEFAULT_SIGMA_5MIN = 0.0028;
const DEFAULT_WINDOW_SEC = 300;
const MIN_TTE_SEC = 0.5;
const PROB_CLAMP = 1e-4;

class PhiModel {
  static evaluate({ btcPrice, refPrice, ttseSec, sigma5min, windowSec } = {}) {
    if (!Number.isFinite(btcPrice) || btcPrice <= 0) return null;
    if (!Number.isFinite(refPrice) || refPrice <= 0) return null;
    if (!Number.isFinite(ttseSec)) return null;

    const sigma = Number.isFinite(sigma5min) && sigma5min > 0 ? sigma5min : DEFAULT_SIGMA_5MIN;
    const window = Number.isFinite(windowSec) && windowSec > 0 ? windowSec : DEFAULT_WINDOW_SEC;
    const tte = Math.max(MIN_TTE_SEC, ttseSec);

    const fracDelta = (btcPrice - refPrice) / refPrice;
    const sigmaRem = sigma * Math.sqrt(tte / window);
    if (!Number.isFinite(sigmaRem) || sigmaRem <= 0) {
      return { pUp: fracDelta > 0 ? 1 - PROB_CLAMP : PROB_CLAMP, z: fracDelta > 0 ? Infinity : -Infinity };
    }

    const z = fracDelta / sigmaRem;
    const pUpRaw = PhiModel.normalCdf(z);
    const pUp = Math.min(1 - PROB_CLAMP, Math.max(PROB_CLAMP, pUpRaw));
    return { pUp, z };
  }

  /** Abramowitz & Stegun 26.2.17 normal CDF approximation. Error < 7.5e-8 for |z| ≤ 6. */
  static normalCdf(z) {
    if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
    if (z < -6) return 0;
    if (z > 6) return 1;
    const t = 1.0 / (1.0 + 0.2316419 * Math.abs(z));
    const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    const pdf = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
    const cdf = 1.0 - pdf * poly;
    return z >= 0 ? cdf : 1.0 - cdf;
  }
}

module.exports = PhiModel;
module.exports.DEFAULT_SIGMA_5MIN = DEFAULT_SIGMA_5MIN;
module.exports.DEFAULT_WINDOW_SEC = DEFAULT_WINDOW_SEC;
