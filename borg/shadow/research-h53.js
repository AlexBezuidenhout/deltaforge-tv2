/**
 * Frozen H53 — accidental five-minute near-even favorite replication.
 *
 * H52 v1 accidentally evaluated this exact rule on true direction_5m
 * markets because those records were mislabeled direction_1h in memory.
 * H53 preserves the rule without tuning and makes the intended population
 * explicit. The only differences from the historical H52 v1 implementation
 * are the strategy/provenance labels and the defense-in-depth 5m type guard.
 *
 * This is an operator-directed, unproven live canary. Shadow scoring remains
 * the research control and no H52 v1 row is reused as confirmatory evidence.
 */
'use strict';

const { TARGET_STAKE_USD } = require('../research/capital-policy');

const STRATEGY = 'H53_5m_neareven_favorite_live_v1';
const MARKET_TYPE = 'direction_5m';
const ASSETS = new Set(['btc', 'eth', 'sol', 'xrp']);
const FAIR_FAVORITE_PROBABILITY = 0.675;
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

class FiveMinuteNearEvenFavorite {
  constructor() {
    this.name = STRATEGY;
    this.marketTypes = [MARKET_TYPE];
    this.cadence = 'sampled';
    this._fired = new Set();
  }

  onHalt() { return []; }

  evaluate(ctx, engine) {
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
      thesisVersion: 'h53-5m-neareven-favorite-live-v1-frozen',
      features: {
        mechanism_family: 'accidental_5m_terminal_favorite_replication',
        benchmark: 'executable_ask',
        source_strategy: 'H52_hourly_neareven_favorite_v1',
        source_cohort_disposition: 'discovery_only_defective_routing',
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
        operator_live_override: true,
        evidence_status: 'unproven',
      },
      note: `frozen H53 5m accidental-rule replication ask=${favorite.ask.toFixed(4)} ` +
        `sum=${(up.ask + down.ask).toFixed(4)} edge2x=${edge2x.toFixed(4)}`,
    }];
  }
}

module.exports = () => [new FiveMinuteNearEvenFavorite()];
module.exports._test = {
  DEPTH_PARTICIPATION,
  EDGE_BUFFER,
  FAIR_FAVORITE_PROBABILITY,
  FAVORITE_ASK_MAX,
  FAVORITE_ASK_MIN,
  FiveMinuteNearEvenFavorite,
  MARKET_TYPE,
  STRATEGY,
  TTE_MAX_SEC,
  TTE_MIN_SEC,
  feePerShare,
};
