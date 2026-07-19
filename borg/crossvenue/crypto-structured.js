'use strict';

/**
 * Structured Polymarket × Kalshi crypto pairing.
 *
 * Kalshi's crypto price series expose machine-readable strikes
 * (floor_strike/cap_strike/strike_type) and exact window timestamps, and
 * Polymarket's crypto series carry the same facts in slug/question/endDate.
 * That permits deterministic pairing on (asset, payoff form, deadline,
 * strike), unlike the token-text matcher whose false positives motivated the
 * manual identity gate.
 *
 * A structured pair is still NEVER identity-approved here: the venues use
 * different resolution indexes (CF Benchmarks RTI vs Polymarket's oracle),
 * so every candidate carries RESOLVER_SOURCE_DIFFERS and stays inside the
 * existing frozen-review governance. The goal of this module is capture:
 * structured candidates rank into dedicated monitored slots so synchronized
 * books and basis samples accrue on pairs whose payoff linkage is provable,
 * while approval remains a human act bound to rule hashes.
 */

const SERIES = Object.freeze([
  // Fifteen-minute up/down twins of Polymarket's direction_15m universe.
  { ticker: 'KXBTC15M', asset: 'btc', form: 'updown_15m' },
  { ticker: 'KXETH15M', asset: 'eth', form: 'updown_15m' },
  { ticker: 'KXSOL15M', asset: 'sol', form: 'updown_15m' },
  { ticker: 'KXXRP15M', asset: 'xrp', form: 'updown_15m' },
  { ticker: 'KXDOGE15M', asset: 'doge', form: 'updown_15m' },
  // Fixed-strike above/below ladders (hourly and daily cadence).
  { ticker: 'KXBTCD', asset: 'btc', form: 'threshold' },
  { ticker: 'KXETHD', asset: 'eth', form: 'threshold' },
  { ticker: 'KXSOLD', asset: 'sol', form: 'threshold' },
  { ticker: 'KXXRPD', asset: 'xrp', form: 'threshold' },
  { ticker: 'KXDOGED', asset: 'doge', form: 'threshold' },
  { ticker: 'BTCD', asset: 'btc', form: 'threshold' },
  { ticker: 'ETHD', asset: 'eth', form: 'threshold' },
  // Range ladders.
  { ticker: 'KXBTC', asset: 'btc', form: 'range' },
  { ticker: 'KXETH', asset: 'eth', form: 'range' },
  { ticker: 'KXSOL', asset: 'sol', form: 'range' },
  { ticker: 'KXXRP', asset: 'xrp', form: 'range' },
  { ticker: 'KXDOGE', asset: 'doge', form: 'range' },
  { ticker: 'BTC', asset: 'btc', form: 'range' },
  { ticker: 'ETH', asset: 'eth', form: 'range' },
]);

const POLY_ASSET_WORDS = Object.freeze({
  bitcoin: 'btc', btc: 'btc',
  ethereum: 'eth', eth: 'eth',
  solana: 'sol', sol: 'sol',
  xrp: 'xrp', ripple: 'xrp',
  dogecoin: 'doge', doge: 'doge',
});

// Strikes must agree exactly after canonicalization; the only permitted
// forgiveness is Kalshi's x.99 "greater" form of an integer ">= x+1" strike.
const STRIKE_TOLERANCE = 0.011;

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const parsed = typeof value === 'string' ? Number(value.replace(/[$,]/g, '')) : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Kalshi expresses "at or above 72,800" as floor_strike 72799.99 with
 * strike_type greater. Canonicalize to the inclusive boundary so both venues
 * key on the same number; keep the raw form in evidence for the reviewer.
 */
function canonicalKalshiStrike(floorStrike, strikeType) {
  const strike = finiteNumber(floorStrike);
  if (strike == null) return null;
  if (strikeType === 'greater') return Math.round((strike + 0.01) * 100) / 100;
  return strike;
}

function parseKalshiCrypto(market, series) {
  const closeMs = Date.parse(market?.closeTime || '');
  if (!Number.isFinite(closeMs)) return null;
  const base = {
    asset: series.asset, form: series.form, deadlineMs: closeMs,
    seriesTicker: series.ticker,
    rawFloorStrike: finiteNumber(market.floorStrike),
    rawCapStrike: finiteNumber(market.capStrike),
    strikeType: market.strikeType || null,
  };
  if (series.form === 'updown_15m') {
    // floor_strike is the window-open index print; identity of the window is
    // carried entirely by (asset, close time).
    return { ...base, strike: null, lower: null, upper: null };
  }
  if (series.form === 'threshold') {
    const strike = canonicalKalshiStrike(market.floorStrike, market.strikeType);
    if (strike == null) return null;
    return { ...base, strike, lower: null, upper: null };
  }
  const lower = finiteNumber(market.floorStrike);
  const upper = finiteNumber(market.capStrike);
  if (lower == null || upper == null) return null;
  return { ...base, strike: null, lower, upper };
}

function polyAsset(text) {
  for (const word of String(text || '').toLowerCase().split(/[^a-z]+/)) {
    if (POLY_ASSET_WORDS[word]) return POLY_ASSET_WORDS[word];
  }
  return null;
}

const UPDOWN_15M_SLUG = /-updown-15m-(\d{9,})/;
const ABOVE_RE = /\b(?:above|higher than|greater than|reach|hit)\s*\$?([\d,]+(?:\.\d+)?)/i;
const BETWEEN_RE = /between\s*\$?([\d,]+(?:\.\d+)?)\s*and\s*\$?([\d,]+(?:\.\d+)?)/i;

/**
 * Parse the structured payoff facts of a compact Polymarket record. Returns
 * null when the market is not a recognizable crypto price contract; parsing
 * failures must starve capture, never guess.
 */
function parsePolyCrypto(poly) {
  const slug = String(poly?.slug || '');
  const question = String(poly?.question || '');
  const endMs = Date.parse(poly?.endDate || '');
  if (!Number.isFinite(endMs)) return null;
  const slugMatch = UPDOWN_15M_SLUG.exec(slug);
  if (slugMatch) {
    const asset = polyAsset(slug.split('-updown-')[0]) || polyAsset(question);
    if (!asset) return null;
    return { asset, form: 'updown_15m', deadlineMs: endMs, strike: null, lower: null, upper: null };
  }
  const asset = polyAsset(question);
  if (!asset) return null;
  const between = BETWEEN_RE.exec(question);
  if (between) {
    const lower = finiteNumber(between[1]);
    const upper = finiteNumber(between[2]);
    if (lower == null || upper == null) return null;
    return { asset, form: 'range', deadlineMs: endMs, strike: null, lower, upper };
  }
  const above = ABOVE_RE.exec(question);
  if (above) {
    const strike = finiteNumber(above[1]);
    if (strike == null) return null;
    return { asset, form: 'threshold', deadlineMs: endMs, strike, lower: null, upper: null };
  }
  return null;
}

function strikesAgree(left, right) {
  if (left == null && right == null) return true;
  if (left == null || right == null) return false;
  return Math.abs(left - right) <= STRIKE_TOLERANCE;
}

function pairKey(parsed) {
  return [parsed.asset, parsed.form, parsed.deadlineMs].join('|');
}

/**
 * Deterministic pairing: exact (asset, form, deadline), then strike/bounds
 * agreement. Emits audit facts for every emitted pair; pairs that share a
 * key but disagree on strikes are dropped (ladder neighbors, not matches).
 */
function buildStructuredPairs(polyMarkets, kalshiMarkets) {
  const polyIndex = new Map();
  for (const poly of polyMarkets) {
    const parsed = parsePolyCrypto(poly);
    if (!parsed) continue;
    const key = pairKey(parsed);
    if (!polyIndex.has(key)) polyIndex.set(key, []);
    polyIndex.get(key).push({ poly, parsed });
  }
  const pairs = [];
  for (const kalshi of kalshiMarkets) {
    const series = SERIES.find((row) => row.ticker === kalshi.seriesTicker);
    if (!series) continue;
    const parsed = parseKalshiCrypto(kalshi, series);
    if (!parsed) continue;
    for (const entry of polyIndex.get(pairKey(parsed)) || []) {
      if (!strikesAgree(entry.parsed.strike, parsed.strike)) continue;
      if (!strikesAgree(entry.parsed.lower, parsed.lower)) continue;
      if (!strikesAgree(entry.parsed.upper, parsed.upper)) continue;
      pairs.push({
        poly: entry.poly, kalshi,
        structuredEvidence: {
          version: 'crossvenue-crypto-structured-v1',
          asset: parsed.asset, form: parsed.form,
          deadline: new Date(parsed.deadlineMs).toISOString(),
          polyParsed: entry.parsed, kalshiParsed: parsed,
          // The linkage below is provable; the resolver identity is not.
          reasons: [
            'RESOLVER_SOURCE_DIFFERS',
            ...(parsed.strikeType === 'greater' ? ['KALSHI_EXCLUSIVE_STRIKE_FORM'] : []),
          ],
        },
      });
    }
  }
  return pairs;
}

module.exports = {
  SERIES, STRIKE_TOLERANCE, buildStructuredPairs, canonicalKalshiStrike,
  parseKalshiCrypto, parsePolyCrypto, polyAsset,
};
