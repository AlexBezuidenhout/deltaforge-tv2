/**
 * SignalEnsemble — combines two independent probability estimates (Φ-model and
 * the legacy heuristic) into one `modelProb` plus an agreement flag.
 *
 * Mode B (parallel + combine):
 *   pPhi        from PhiModel    (mathematically grounded, time-aware)
 *   pHeur       from old yesPrice + btcEdge logic (momentum-driven)
 *
 *   modelProb  = blend(pPhi, pHeur, weight)
 *   agreement  = 'AGREE' if both > 0.5 or both < 0.5
 *                'NEUTRAL' if one of them is in [0.45, 0.55]
 *                'DISAGREE' if they pick opposite sides with |Δ| > disagreeThreshold
 *
 *   confidence multiplier:
 *     AGREE   → ×1.10
 *     NEUTRAL → ×1.00
 *     DISAGREE → ×0.70 (lower confidence; still emit signal so operator can see)
 *
 * The ensemble does NOT block trades on its own — it produces a single
 * `modelProb` for the downstream EV calculation and a `votes` object that the
 * signal log carries for the UI / manual operator.
 */

const PHI_WEIGHT_DEFAULT = 0.60;
const DISAGREE_DELTA = 0.10;
const NEUTRAL_LOW = 0.45;
const NEUTRAL_HIGH = 0.55;

class SignalEnsemble {
  /**
   * @param {number|null} pPhi    Φ-model P(UP), may be null if Φ unavailable
   * @param {number|null} pHeur   heuristic P(UP), should always be available
   * @param {object} [opts]
   * @param {number} [opts.phiWeight=0.6]  weight of Φ in the blend (0..1)
   * @param {number} [opts.disagreeDelta=0.10]  abs diff over which both sides are flagged DISAGREE
   * @returns {{ modelProb:number, modelProbSource:string, votes:object, confidenceMul:number }}
   */
  static combine(pPhi, pHeur, opts = {}) {
    // Weight is clamped to [0,1] — NOT through clamp01, whose 0.01 floor is for
    // probabilities. Reusing it here silently turned weight 0 into 0.01, which
    // kept Φ in the blend AND kept the ×1.10/×0.70 agreement multiplier alive —
    // the phi-mute (audit 2026-07-12) was dead code until this fix.
    const rawWeight = opts.phiWeight != null ? opts.phiWeight : PHI_WEIGHT_DEFAULT;
    const phiWeight = Math.min(1, Math.max(0, rawWeight));
    const disagreeDelta = Number.isFinite(opts.disagreeDelta) ? opts.disagreeDelta : DISAGREE_DELTA;

    const hasPhi = Number.isFinite(pPhi);
    const hasHeur = Number.isFinite(pHeur);

    if (!hasPhi && !hasHeur) {
      return {
        modelProb: 0.5,
        modelProbSource: 'fallback_neutral',
        votes: { phi: null, heuristic: null, agreement: 'NONE', delta: null },
        confidenceMul: 0.7,
      };
    }

    if (hasPhi && !hasHeur) {
      return {
        modelProb: clamp01(pPhi),
        modelProbSource: 'phi_only',
        votes: { phi: pPhi, heuristic: null, agreement: 'PHI_ONLY', delta: null },
        confidenceMul: 1.0,
      };
    }

    if (!hasPhi && hasHeur) {
      return {
        modelProb: clamp01(pHeur),
        modelProbSource: 'heuristic_only',
        votes: { phi: null, heuristic: pHeur, agreement: 'HEUR_ONLY', delta: null },
        confidenceMul: 0.9,
      };
    }

    // phiWeight === 0 → Φ is measurement-only: logged in votes but with zero
    // influence on modelProb AND on the confidence multiplier (audit 2026-07-12:
    // Φ Brier 0.313 vs coin 0.25 — anti-informative; the ×1.10/×0.70 agreement
    // scaling would otherwise let it distort sizing even at weight 0).
    if (phiWeight === 0) {
      return {
        modelProb: clamp01(pHeur),
        modelProbSource: 'heuristic_only_w0',
        votes: { phi: pPhi, heuristic: pHeur, agreement: 'PHI_MUTED', delta: pPhi - pHeur },
        confidenceMul: 1.0,
      };
    }

    // Both available — blend.
    const blended = phiWeight * pPhi + (1 - phiWeight) * pHeur;
    const delta = pPhi - pHeur;

    const phiInNeutral = pPhi >= NEUTRAL_LOW && pPhi <= NEUTRAL_HIGH;
    const heurInNeutral = pHeur >= NEUTRAL_LOW && pHeur <= NEUTRAL_HIGH;

    let agreement;
    let confidenceMul = 1.0;
    if (phiInNeutral || heurInNeutral) {
      agreement = 'NEUTRAL';
      confidenceMul = 1.0;
    } else if ((pPhi - 0.5) * (pHeur - 0.5) > 0) {
      // same side
      agreement = 'AGREE';
      confidenceMul = 1.10;
    } else if (Math.abs(delta) >= disagreeDelta) {
      agreement = 'DISAGREE';
      confidenceMul = 0.70;
    } else {
      agreement = 'WEAK_DISAGREE';
      confidenceMul = 0.85;
    }

    return {
      modelProb: clamp01(blended),
      modelProbSource: 'ensemble',
      votes: { phi: pPhi, heuristic: pHeur, agreement, delta },
      confidenceMul,
    };
  }
}

function clamp01(x) {
  return Math.min(0.99, Math.max(0.01, x));
}

module.exports = SignalEnsemble;
module.exports.PHI_WEIGHT_DEFAULT = PHI_WEIGHT_DEFAULT;
module.exports.DISAGREE_DELTA = DISAGREE_DELTA;
