'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MakerLab } = require('../borg/crossvenue/maker-lab');

const MATCH = { poly: { feeRate: 0, feeExponent: 1 } };

function tops(polyYesBidAsk, kalshiNoBidAsk, polyNo = [0.5, 0.55], kalshiYes = [0.4, 0.45]) {
  return {
    poly: {
      YES: { bid: polyYesBidAsk[0], ask: polyYesBidAsk[1] },
      NO: { bid: polyNo[0], ask: polyNo[1] },
    },
    kalshi: {
      YES: { bid: kalshiYes[0], ask: kalshiYes[1] },
      NO: { bid: kalshiNoBidAsk[0], ask: kalshiNoBidAsk[1] },
    },
  };
}

function lab(options = {}) {
  const episodes = [];
  const instance = new MakerLab({ onEpisode: (row) => episodes.push(row), ...options });
  return { instance, episodes };
}

const FRESH = { synchronized: true, booksFresh: true };

test('both legs trading through locks the pair with taker-upper-bound fees', () => {
  const { instance, episodes } = lab();
  // Quote joins bids: poly YES 0.42, kalshi NO 0.56.
  instance.observe('m1', MATCH, tops([0.42, 0.44], [0.56, 0.58]), { ...FRESH, now: 1000 });
  // Poly ask trades through 0.42; kalshi not yet.
  instance.observe('m1', MATCH, tops([0.40, 0.42], [0.56, 0.58]), { ...FRESH, now: 2000 });
  // Kalshi ask trades through 0.56 → LOCKED.
  instance.observe('m1', MATCH, tops([0.40, 0.42], [0.54, 0.56]), { ...FRESH, now: 3000 });
  const locked = episodes.find((row) => row.direction === 'POLY_YES+KALSHI_NO');
  assert.ok(locked);
  assert.equal(locked.status, 'LOCKED');
  // margin = 1 − 0.42 − 0.56 − kalshiTakerFee(0.56) (poly feeRate 0)
  assert.ok(locked.lockedMargin > 0 && locked.lockedMargin < 0.02 - 0);
  assert.ok(locked.fees > 0, 'kalshi taker fee must be charged');
});

test('a touch at the resting level does not fill; only trade-through does', () => {
  const { instance, episodes } = lab();
  instance.observe('m2', MATCH, tops([0.42, 0.44], [0.56, 0.58]), { ...FRESH, now: 1000 });
  // Ask drops to exactly one tick above our level — no fill.
  instance.observe('m2', MATCH, tops([0.42, 0.43], [0.56, 0.57]), { ...FRESH, now: 2000 });
  assert.equal(episodes.length, 0);
});

test('orphan leg is unwound at the bid with fees after the timeout', () => {
  const { instance, episodes } = lab({ orphanTimeoutMs: 60_000 });
  instance.observe('m3', MATCH, tops([0.42, 0.44], [0.56, 0.58]), { ...FRESH, now: 0 });
  // Poly fills; kalshi never does. Poly bid decays to 0.30.
  instance.observe('m3', MATCH, tops([0.35, 0.42], [0.56, 0.58]), { ...FRESH, now: 1000 });
  instance.observe('m3', MATCH, tops([0.30, 0.33], [0.56, 0.58]), { ...FRESH, now: 61_500 });
  const orphan = episodes.find((row) => row.direction === 'POLY_YES+KALSHI_NO');
  assert.ok(orphan);
  assert.equal(orphan.status, 'ORPHAN_UNWOUND');
  assert.equal(orphan.orphanLeg, 'poly');
  // Bought 0.42, unwound at bid 0.30 → −0.12 (poly fee 0 at feeRate 0).
  assert.ok(Math.abs(orphan.orphanUnwindPnl - -0.12) < 1e-9);
});

test('requotes chase the bid before any fill and freeze after the first fill', () => {
  const { instance, episodes } = lab({ orphanTimeoutMs: 60_000 });
  instance.observe('m4', MATCH, tops([0.42, 0.44], [0.56, 0.58]), { ...FRESH, now: 0 });
  // Bid walks up 2 ticks pre-fill → requote to 0.44.
  instance.observe('m4', MATCH, tops([0.44, 0.46], [0.56, 0.58]), { ...FRESH, now: 1000 });
  // Kalshi fills at 0.56; poly bid then walks — quote must NOT chase anymore.
  instance.observe('m4', MATCH, tops([0.44, 0.46], [0.54, 0.56]), { ...FRESH, now: 2000 });
  instance.observe('m4', MATCH, tops([0.48, 0.50], [0.54, 0.56]), { ...FRESH, now: 3000 });
  instance.observe('m4', MATCH, tops([0.48, 0.50], [0.54, 0.56]), { ...FRESH, now: 63_000 });
  const orphan = episodes.find((row) => row.direction === 'POLY_YES+KALSHI_NO');
  assert.ok(orphan);
  assert.equal(orphan.requotes >= 1, true);
  assert.equal(orphan.orphanLeg, 'kalshi');
  assert.equal(orphan.polyFilledAt, null, 'frozen poly quote at 0.44 must not fill at ask 0.46+');
});

test('stale books freeze the lab and eventually abandon the episode', () => {
  const { instance, episodes } = lab({ staleAbandonMs: 60_000 });
  instance.observe('m5', MATCH, tops([0.42, 0.44], [0.56, 0.58]), { ...FRESH, now: 0 });
  // Ask crosses our level while UNSYNCHRONIZED — must not fill.
  instance.observe('m5', MATCH, tops([0.38, 0.40], [0.50, 0.52]),
    { synchronized: false, booksFresh: false, now: 1000 });
  assert.equal(episodes.length, 0);
  instance.observe('m5', MATCH, tops([0.38, 0.40], [0.50, 0.52]),
    { synchronized: false, booksFresh: false, now: 62_000 });
  assert.equal(episodes.length, 2, 'both directions abandoned');
  assert.ok(episodes.every((row) => row.status === 'ABANDONED_STALE'));
});
