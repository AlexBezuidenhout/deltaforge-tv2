'use strict';

/**
 * Fresh, paper-only replication of the exact original G_late_arb rule on ETH.
 *
 * ETH was selected after inspecting historical results, so no historical G
 * observation is evidence for this strategy id. The distinct name and frozen
 * experiment manifest force the trial to begin prospectively. This module has
 * no wallet, signer, authenticated client, or order-posting path.
 */
const {
  RESEARCH_CAPITAL_VERSION,
  TARGET_STAKE_USD,
} = require('../research/capital-policy');

const ETH_G_LATE_EXACT_CFG = Object.freeze({
  tteMax: 75,
  tteMin: 5,
  minPhiCert: 0.88,
  minEdgeCents: 0.05,
  minAsk: 0.55,
  maxAsk: 0.96,
  stakeUsd: TARGET_STAKE_USD,
});

class EthGLateExactForward {
  constructor() {
    this.name = 'ETH_G_late_exact_forward_v1';
    this.marketTypes = ['direction_5m'];
    this.cfg = ETH_G_LATE_EXACT_CFG;
    this._fired = new Map();
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
    const { market, tteSec, phiFair, upBook, downBook } = ctx;
    if (!market || market.asset !== 'eth' || phiFair == null) return [];
    if (tteSec < this.cfg.tteMin || tteSec > this.cfg.tteMax) return [];

    const fired = this._fired.get(market.id) || new Set();
    const candidates = [];
    if (phiFair >= this.cfg.minPhiCert && !fired.has('UP')) {
      candidates.push({ token: 'UP', probability: phiFair, book: upBook });
    }
    if (phiFair <= 1 - this.cfg.minPhiCert && !fired.has('DOWN')) {
      candidates.push({ token: 'DOWN', probability: 1 - phiFair, book: downBook });
    }

    const actions = [];
    for (const candidate of candidates) {
      const [ask, askSize] = candidate.book?.asks?.[0] || [];
      if (!(askSize > 0) || ask < this.cfg.minAsk || ask > this.cfg.maxAsk) continue;
      const edge = candidate.probability - ask;
      if (edge < this.cfg.minEdgeCents) continue;
      fired.add(candidate.token);
      actions.push({
        action: 'place',
        side: 'BUY',
        token: candidate.token,
        price: ask,
        size: Math.min(this.cfg.stakeUsd / ask, askSize),
        kind: 'taker',
        coid: engine._coid(this.name),
        queueAhead: askSize,
        executionModel: 'latency_1s',
        thesisVersion: `eth-g-late-exact-forward-v1-${RESEARCH_CAPITAL_VERSION}`,
        note: [
          'fresh_forward_only=true',
          `phi=${candidate.probability.toFixed(3)}`,
          `ask=${ask.toFixed(3)}`,
          `edge=${edge.toFixed(3)}`,
          `tte=${Math.round(tteSec)}s`,
          `stake=$${this.cfg.stakeUsd}`,
        ].join(' '),
      });
    }

    if (fired.size) {
      this._fired.set(market.id, fired);
      if (this._fired.size > 500) this._fired.delete(this._fired.keys().next().value);
    }
    return actions;
  }
}

module.exports = {
  ETH_G_LATE_EXACT_CFG,
  EthGLateExactForward,
};
