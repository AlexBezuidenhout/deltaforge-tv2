/**
 * Frozen H52 v2 — fifteen-minute near-even favorite forward arm.
 *
 * V2 supersedes H52_hourly_neareven_favorite_v1, which was DEFECTIVE as
 * deployed: the up/down event classifier typed 5m/15m/1h series identically,
 * so v1 placed 36/40 forward orders on direction_5m markets (the known
 * fee-negative cell) and its "1h" discovery cohort was actually 90%
 * fifteen-minute markets. Product-split discovery (2026-07-18, post-repair):
 * 15m markets, final 60-300s, favorite ask 0.50-0.60 -> 24/36 independent
 * markets, +$0.101/share at 1x fees; true-1h cell is n=4 (unusable).
 * Independent verification (report-h52-verifier-2026-07-18.md): clustered
 * p about 0.04-0.06 against the priced probability under a 52-hypothesis
 * search — consistent with selection; median touch depth ~$130. This arm
 * exists to settle exactly that question forward. Rules frozen in
 * research-h52-15m-neareven-favorite-v2.json; v1 rows are not evidence.
 */
'use strict';

const { TARGET_STAKE_USD } = require('../research/capital-policy');

const STRATEGY = 'H52_15m_neareven_favorite_v2';
const MARKET_TYPE = 'direction_15m';
const ASSETS = new Set(['btc', 'eth', 'sol', 'xrp']);
const FAIR_FAVORITE_PROBABILITY = 0.667; // frozen 15m-product discovery win rate, 24/36
const FAVORITE_ASK_MIN = 0.50;
const FAVORITE_ASK_MAX = 0.60;
const TTE_MIN_SEC = 60;
const TTE_MAX_SEC = 300;
const CRYPTO_TAKER_RATE = 0.07;
const FEE_MULTIPLIER = 2;
const EDGE_BUFFER = 0.01;
const DEPTH_PARTICIPATION = 0.20;

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function feePerShare(price, multiplier = FEE_MULTIPLIER) {
  return multiplier * CRYPTO_TAKER_RATE * price * (1 - price);
}

function quote(book) {
  return {
    bid: finite(book?.bids?.[0]?.[0]),
    ask: finite(book?.asks?.[0]?.[0]),
    askSize: finite(book?.asks?.[0]?.[1]),
  };
}

class FifteenMinNearEvenFavorite {
  constructor() {
    this.name = STRATEGY;
    this.marketTypes = [MARKET_TYPE];
    this.cadence = 'sampled';
    this._fired = new Set();
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
    // Defense in depth: the v1 defect was an engine-level dispatch leak via
    // mislabeled market records. Never rely on dispatch alone again.
    if ((ctx.market?.market_type || null) !== MARKET_TYPE) return [];
    const asset = String(ctx.market?.asset || '').toLowerCase();
    const marketId = ctx.market?.id;
    if (!ASSETS.has(asset) || marketId == null || this._fired.has(marketId)) return [];
    if (!(ctx.tteSec >= TTE_MIN_SEC && ctx.tteSec <= TTE_MAX_SEC)) return [];

    const up = quote(ctx.upBook);
    const down = quote(ctx.downBook);
    const bothQuoted = up.ask != null && down.ask != null &&
      up.ask >= 0.02 && up.ask <= 0.98 && down.ask >= 0.02 && down.ask <= 0.98;
    if (!bothQuoted || up.ask === down.ask) return [];

    const favoriteIsUp = up.ask > down.ask;
    const favorite = favoriteIsUp ? up : down;
    if (!(favorite.ask >= FAVORITE_ASK_MIN && favorite.ask <= FAVORITE_ASK_MAX)) return [];
    if (!(favorite.askSize > 0)) return [];

    const edge2x = FAIR_FAVORITE_PROBABILITY - favorite.ask - feePerShare(favorite.ask);
    if (edge2x < EDGE_BUFFER) return [];

    const shares = Math.min(TARGET_STAKE_USD / favorite.ask, favorite.askSize * DEPTH_PARTICIPATION);
    if (!(shares > 0) || shares * favorite.ask < 1) return [];

    const token = String((favoriteIsUp ? ctx.market?.positive_label : ctx.market?.negative_label)
      || (favoriteIsUp ? 'UP' : 'DOWN')).toUpperCase();
    this._fired.add(marketId);
    if (this._fired.size > 5000) this._fired.delete(this._fired.values().next().value);
    return [{
      action: 'place', side: 'BUY', token, price: favorite.ask, size: shares,
      kind: 'taker', coid: engine._coid(this.name), queueAhead: favorite.askSize,
      executionModel: 'latency_1s',
      thesisVersion: 'h52-15m-neareven-favorite-v2-frozen',
      features: {
        mechanism_family: 'short_window_terminal_favorite_calibration',
        benchmark: 'executable_ask',
        market_type: MARKET_TYPE,
        frozen_fair_favorite: FAIR_FAVORITE_PROBABILITY,
        favorite_ask: favorite.ask,
        underdog_ask: favoriteIsUp ? down.ask : up.ask,
        ask_sum: up.ask + down.ask,
        edge_2x_per_share: edge2x,
        displayed_touch_shares: favorite.askSize,
        depth_participation: DEPTH_PARTICIPATION,
        displayed_capacity_usd: favorite.ask * favorite.askSize,
        simulated_notional_usd: favorite.ask * shares,
        atomic_external_hedge: false,
      },
      note: `frozen H52v2 15m near-even favorite ask=${favorite.ask.toFixed(4)} ` +
        `sum=${(up.ask + down.ask).toFixed(4)} edge2x=${edge2x.toFixed(4)}`,
    }];
  }
}

module.exports = () => [new FifteenMinNearEvenFavorite()];
module.exports._test = {
  FAIR_FAVORITE_PROBABILITY,
  FAVORITE_ASK_MAX,
  FAVORITE_ASK_MIN,
  FifteenMinNearEvenFavorite,
  MARKET_TYPE,
  feePerShare,
};
