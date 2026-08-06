'use strict';

const { feeMetadata } = require('../pyth/universe');
const { jsonArray, resolutionSource } = require('../recon/research-universe');

const ZEC_TWAP_UNIVERSE = 'zec-chainlink-twap-capture-v1';
const SERIES = Object.freeze([
  { timeframeSec: 300, slugPrefix: 'zec-updown-5m', marketType: 'direction_5m',
    windowSeconds: 30, resolutionSource: 'chainlink_twap_30s' },
  { timeframeSec: 900, slugPrefix: 'zec-updown-15m', marketType: 'direction_15m',
    windowSeconds: 60, resolutionSource: 'chainlink_twap_60s' },
]);

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeZecTwapMarket(raw, series, epochSec) {
  const outcomes = jsonArray(raw?.outcomes).map(String);
  const tokenIds = jsonArray(raw?.clobTokenIds).map(String);
  const upIndex = outcomes.findIndex((value) => /^up$/i.test(value));
  const downIndex = outcomes.findIndex((value) => /^down$/i.test(value));
  const detectedSource = resolutionSource(null, raw, series.marketType);
  const fees = feeMetadata(raw);
  const checks = {
    exactSlug: String(raw?.slug || '') === `${series.slugPrefix}-${epochSec}`,
    exactSource: detectedSource === series.resolutionSource,
    exactBinary: upIndex >= 0 && downIndex >= 0 && tokenIds.length === outcomes.length
      && tokenIds[upIndex] && tokenIds[downIndex] && tokenIds[upIndex] !== tokenIds[downIndex],
    identifiers: Boolean(raw?.id && raw?.conditionId),
    accepting: raw?.active !== false && raw?.closed !== true && raw?.acceptingOrders !== false,
    feeSchedule: fees.known,
    minimumOrderSize: finite(raw?.orderMinSize ?? raw?.minimum_order_size) > 0,
  };
  const failures = Object.entries(checks).filter(([, pass]) => !pass).map(([key]) => key);
  return {
    universeId: ZEC_TWAP_UNIVERSE,
    slug: raw?.slug || null,
    gammaId: raw?.id == null ? null : String(raw.id),
    conditionId: raw?.conditionId || null,
    question: raw?.question || null,
    asset: 'zec', symbol: 'zec/usd',
    marketType: series.marketType, timeframeSec: series.timeframeSec,
    twapWindowSeconds: series.windowSeconds,
    resolutionSource: detectedSource,
    windowStart: new Date(epochSec * 1000),
    windowEnd: new Date((epochSec + series.timeframeSec) * 1000),
    upToken: tokenIds[upIndex] || null,
    downToken: tokenIds[downIndex] || null,
    upIndex, downIndex, fees,
    minimumOrderSize: finite(raw?.orderMinSize ?? raw?.minimum_order_size),
    checks, failures, certified: failures.length === 0, raw,
  };
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs || 10_000));
  try {
    const response = await (options.fetchImpl || fetch)(url, { signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`Gamma HTTP ${response.status}: ${text.slice(0, 160)}`);
    return JSON.parse(text);
  } finally { clearTimeout(timeout); }
}

async function discoverZecTwapMarkets(options = {}) {
  const nowMs = Number(options.nowMs ?? Date.now());
  const gamma = String(options.gamma || 'https://gamma-api.polymarket.com').replace(/\/$/, '');
  const rows = [];
  for (const series of SERIES) {
    const current = Math.floor(nowMs / 1000 / series.timeframeSec) * series.timeframeSec;
    for (const epochSec of [current, current + series.timeframeSec]) {
      const slug = `${series.slugPrefix}-${epochSec}`;
      const response = await fetchJson(`${gamma}/markets?slug=${encodeURIComponent(slug)}`, options);
      const market = Array.isArray(response) ? response[0] : null;
      if (!market) continue;
      rows.push(normalizeZecTwapMarket(market, series, epochSec));
    }
  }
  return rows.filter((row) => row.certified);
}

module.exports = {
  SERIES, ZEC_TWAP_UNIVERSE, discoverZecTwapMarkets, normalizeZecTwapMarket,
};
