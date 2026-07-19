'use strict';

/** Pure causal pairing for independently arriving venue books. */

function finite(value, fallback = null) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cloneLevels(levels) {
  return (Array.isArray(levels) ? levels : []).map((level) => [
    finite(level?.[0]), finite(level?.[1]),
  ]).filter(([price, size]) => price > 0 && price < 1 && size > 0);
}

function cloneBooks(books) {
  return Object.fromEntries(['YES', 'NO'].map((outcome) => [outcome, {
    bids: cloneLevels(books?.[outcome]?.bids),
    asks: cloneLevels(books?.[outcome]?.asks),
  }]));
}

function appendHistory(history, state, options = {}) {
  if (!state || !Number.isFinite(finite(state.receivedAt))) return history || [];
  const nowMs = finite(options.nowMs, Date.now());
  const maxAgeMs = Math.max(1000, finite(options.maxAgeMs, 30_000));
  const maxEntries = Math.max(2, Math.trunc(finite(options.maxEntries, 256)));
  const rows = Array.isArray(history) ? history : [];
  rows.push({ ...state, books: cloneBooks(state.books), receivedAt: finite(state.receivedAt) });
  const cutoff = nowMs - maxAgeMs;
  while (rows.length && (rows[0].receivedAt < cutoff || rows.length > maxEntries)) rows.shift();
  return rows;
}

function causalRows(history, cutoffAt) {
  return (Array.isArray(history) ? history : [])
    .filter((state) => Number.isFinite(finite(state.receivedAt)) && state.receivedAt <= cutoffAt)
    .sort((left, right) => right.receivedAt - left.receivedAt);
}

function selectSynchronizedBooks(options = {}) {
  const cutoffAt = finite(options.cutoffAt, Date.now());
  const maxSkewMs = Math.max(0, finite(options.maxSkewMs, 250));
  const maxAgeMs = Math.max(maxSkewMs, finite(options.maxAgeMs, 5000));
  const polyRows = causalRows(options.polyHistory, cutoffAt);
  const kalshiRows = causalRows(options.kalshiHistory, cutoffAt);
  const latestPoly = polyRows[0] || null;
  const latestKalshi = kalshiRows[0] || null;
  const pairSkewMs = latestPoly && latestKalshi
    ? Math.abs(latestPoly.receivedAt - latestKalshi.receivedAt) : null;
  const latestFresh = latestPoly && latestKalshi
    && cutoffAt - latestPoly.receivedAt <= maxAgeMs
    && cutoffAt - latestKalshi.receivedAt <= maxAgeMs;
  // Never search backward for a prettier pair. At the causal decision cut the
  // latest state from each venue is already known and may not be "unseen".
  if (latestFresh && pairSkewMs <= maxSkewMs) {
    const jointAvailableAt = Math.max(latestPoly.receivedAt, latestKalshi.receivedAt);
    return {
      synchronized: true, reason: 'CAUSAL_RECEIVE_CUT', cutoffAt,
      maxSkewMs, maxAgeMs, poly: latestPoly, kalshi: latestKalshi,
      pairSkewMs, jointAvailableAt,
      polyAgeMs: Math.max(0, cutoffAt - latestPoly.receivedAt),
      kalshiAgeMs: Math.max(0, cutoffAt - latestKalshi.receivedAt),
    };
  }
  let reason = 'MISSING_VENUE_STATE';
  if (latestPoly && latestKalshi) {
    reason = cutoffAt - latestPoly.receivedAt > maxAgeMs
      || cutoffAt - latestKalshi.receivedAt > maxAgeMs
      ? 'STALE_VENUE_STATE' : pairSkewMs > maxSkewMs ? 'PAIR_SKEW_EXCEEDED' : 'NO_CAUSAL_PAIR';
  }
  return {
    synchronized: false, reason, cutoffAt, maxSkewMs, maxAgeMs,
    poly: latestPoly, kalshi: latestKalshi,
    pairSkewMs,
    jointAvailableAt: latestPoly && latestKalshi
      ? Math.max(latestPoly.receivedAt, latestKalshi.receivedAt) : null,
    polyAgeMs: latestPoly ? Math.max(0, cutoffAt - latestPoly.receivedAt) : null,
    kalshiAgeMs: latestKalshi ? Math.max(0, cutoffAt - latestKalshi.receivedAt) : null,
  };
}

module.exports = { appendHistory, cloneBooks, cloneLevels, selectSynchronizedBooks };
