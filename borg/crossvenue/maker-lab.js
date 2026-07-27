'use strict';

/**
 * Paper maker-capture laboratory.
 *
 * The taker version of the cross-venue trade is measured dead: crossing both
 * spreads costs more than the $1 complementary payout on every synchronized
 * book ever captured. The surviving hypothesis is the maker version — rest a
 * bid on each venue's complementary side and earn the spreads instead of
 * paying them. If both bids fill, the pair pays $1 at resolution for a
 * sub-$1 outlay; the unknown is the joint-fill rate and the orphan cost when
 * only one leg fills. This module measures exactly that, paper-only.
 *
 * Honesty rules, in the spirit of the shadow scorer:
 * - A virtual bid joins the current best bid, never improves it.
 * - A leg fills only when a later SYNCHRONIZED book shows that venue's ask
 *   at or below the resting price — the level must trade through, queue
 *   position is assumed worst-case. Touches don't fill.
 * - Requotes reset the clock: if the market walks away from a resting bid,
 *   repricing is logged and treated as a fresh quote.
 * - Orphans are closed by crossing the spread out at the current bid after
 *   a timeout, with the venue's full taker fee charged — no hold-and-hope.
 * - Fees on locked pairs are charged as if both fills were takers (upper
 *   bound; real maker fees are lower on both venues today).
 * - Stale or unsynchronized books freeze the lab for that match; nothing
 *   fills, nothing unwinds, staleness is counted.
 */

const { kalshiTakerFee, polymarketTakerFee, finite } = require('./strategy');

const DIRECTIONS = Object.freeze([
  { name: 'POLY_YES+KALSHI_NO', poly: 'YES', kalshi: 'NO' },
  { name: 'POLY_NO+KALSHI_YES', poly: 'NO', kalshi: 'YES' },
]);

class MakerLab {
  constructor(options = {}) {
    this.requoteTolerance = finite(options.requoteTolerance, 0.011);
    this.orphanTimeoutMs = Math.max(60_000, Number(options.orphanTimeoutMs || 600_000));
    this.staleAbandonMs = Math.max(60_000, Number(options.staleAbandonMs || 900_000));
    this.minQuote = 0.01;
    this.maxQuote = 0.99;
    this.states = new Map();
    this.emit = options.onEpisode || (() => {});
  }

  key(matchId, direction) { return `${matchId}:${direction}`; }

  /** Feed one observation. tops = { poly: {YES, NO}, kalshi: {YES, NO} },
   *  each side { bid, ask } in dollars. */
  observe(matchId, match, tops, { synchronized, booksFresh, now }) {
    for (const direction of DIRECTIONS) {
      const polyTop = tops.poly[direction.poly];
      const kalshiTop = tops.kalshi[direction.kalshi];
      if (!polyTop || !kalshiTop) continue;
      this.step(matchId, match, direction, polyTop, kalshiTop,
        { synchronized, booksFresh, now });
    }
  }

  step(matchId, match, direction, polyTop, kalshiTop, { synchronized, booksFresh, now }) {
    const key = this.key(matchId, direction.name);
    let state = this.states.get(key);
    if (match?.kalshi?.feeSchedule && match.kalshi.feeSchedule.supported !== true) return;
    if (!synchronized || !booksFresh) {
      if (state) {
        state.staleObservations += 1;
        if (state.lastFreshAt == null || now - state.lastFreshAt > this.staleAbandonMs) {
          this.close(state, 'ABANDONED_STALE', now, { polyTop, kalshiTop });
        }
      }
      return;
    }
    if (!state) {
      const polyQuote = finite(polyTop.bid);
      const kalshiQuote = finite(kalshiTop.bid);
      if (!(polyQuote >= this.minQuote && polyQuote <= this.maxQuote)
        || !(kalshiQuote >= this.minQuote && kalshiQuote <= this.maxQuote)) return;
      state = {
        key, matchId, direction, startedAt: now, lastFreshAt: now,
        legs: {
          poly: { venue: 'poly', price: polyQuote, quotedAt: now, filledAt: null },
          kalshi: { venue: 'kalshi', price: kalshiQuote, quotedAt: now, filledAt: null },
        },
        requotes: 0, observations: 0, staleObservations: 0,
        feeRate: finite(match.poly.feeRate, 0), feeExponent: finite(match.poly.feeExponent, 1),
        kalshiFeeSchedule: match?.kalshi?.feeSchedule ?? 1,
      };
      this.states.set(key, state);
    }
    state.observations += 1;
    state.lastFreshAt = now;
    const tops = { poly: polyTop, kalshi: kalshiTop };
    for (const legName of ['poly', 'kalshi']) {
      const leg = state.legs[legName];
      if (leg.filledAt) continue;
      const top = tops[legName];
      const ask = finite(top.ask);
      const bid = finite(top.bid);
      // Trade-through fill: the ask reached our resting level.
      if (ask != null && ask <= leg.price) {
        leg.filledAt = now;
        continue;
      }
      // Requote when the bid walks away from our level (either direction) and
      // no other leg is filled yet. After a first fill the survivor leg quote
      // is frozen: chasing after being half-filled is a different strategy.
      const anyFilled = state.legs.poly.filledAt || state.legs.kalshi.filledAt;
      if (!anyFilled && bid != null && Math.abs(bid - leg.price) > this.requoteTolerance
        && bid >= this.minQuote && bid <= this.maxQuote) {
        leg.price = bid;
        leg.quotedAt = now;
        state.requotes += 1;
      }
    }
    const polyLeg = state.legs.poly;
    const kalshiLeg = state.legs.kalshi;
    if (polyLeg.filledAt && kalshiLeg.filledAt) {
      this.close(state, 'LOCKED', now, { polyTop, kalshiTop });
      return;
    }
    const firstFillAt = polyLeg.filledAt || kalshiLeg.filledAt;
    if (firstFillAt && now - firstFillAt >= this.orphanTimeoutMs) {
      this.close(state, 'ORPHAN_UNWOUND', now, { polyTop, kalshiTop });
    }
  }

  fees(state) {
    // Upper bound: both fills charged as takers, one share per leg.
    const polyFee = polymarketTakerFee(
      [{ size: 1, price: state.legs.poly.price }], state.feeRate, state.feeExponent);
    const kalshiFee = kalshiTakerFee(
      [{ size: 1, price: state.legs.kalshi.price }],
      state.kalshiFeeSchedule,
    );
    return { polyFee, kalshiFee, total: polyFee + kalshiFee };
  }

  close(state, status, now, { polyTop, kalshiTop }) {
    this.states.delete(state.key);
    const fees = this.fees(state);
    const row = {
      episodeId: `cvmaker:${state.matchId}:${state.direction.name}:${state.startedAt}`,
      matchId: state.matchId, direction: state.direction.name,
      startedAt: state.startedAt, endedAt: now, status,
      polyQuote: state.legs.poly.price, kalshiQuote: state.legs.kalshi.price,
      polyFilledAt: state.legs.poly.filledAt, kalshiFilledAt: state.legs.kalshi.filledAt,
      requotes: state.requotes, observations: state.observations,
      staleObservations: state.staleObservations,
      lockedMargin: null, orphanLeg: null, orphanUnwindPnl: null,
      fees: fees.total,
      detail: {
        polyTop, kalshiTop, feeModel: 'both_legs_taker_upper_bound',
        fillModel: 'trade_through_only', quoteModel: 'join_bid_never_improve',
      },
    };
    if (status === 'LOCKED') {
      row.lockedMargin = +(1 - state.legs.poly.price - state.legs.kalshi.price
        - fees.total).toFixed(6);
    } else if (status === 'ORPHAN_UNWOUND') {
      const filled = state.legs.poly.filledAt ? 'poly' : 'kalshi';
      const top = filled === 'poly' ? polyTop : kalshiTop;
      const exitBid = finite(top?.bid, 0);
      const leg = state.legs[filled];
      const exitFee = filled === 'poly'
        ? polymarketTakerFee([{ size: 1, price: exitBid }], state.feeRate, state.feeExponent)
        : kalshiTakerFee(
          [{ size: 1, price: exitBid }],
          state.kalshiFeeSchedule,
          'sell',
        );
      row.orphanLeg = filled;
      row.orphanUnwindPnl = +(exitBid - leg.price - exitFee).toFixed(6);
    }
    this.emit(row);
  }

  /** Force-close everything (shutdown); unfilled quotes report UNFILLED. */
  drain(now) {
    for (const state of [...this.states.values()]) {
      const anyFill = state.legs.poly.filledAt || state.legs.kalshi.filledAt;
      this.close(state, anyFill ? 'ORPHAN_UNWOUND' : 'UNFILLED', now,
        { polyTop: null, kalshiTop: null });
    }
  }
}

module.exports = { DIRECTIONS, MakerLab };
