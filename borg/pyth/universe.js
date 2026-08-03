'use strict';

const crypto = require('node:crypto');
const { extractExactPythFeedSymbol } = require('./hermes');

const GAMMA = 'https://gamma-api.polymarket.com';
const PRICE_TO_BEAT = 'https://polymarket.com/api/equity/price-to-beat';
const FINANCE_UPDOWN_TAG = '104152';

function finite(value, fallback = null) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; }
  catch (_) { return []; }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
}

async function fetchJson(url, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = await response.text();
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status} ${body.slice(0, 120)}`);
    return JSON.parse(body);
  } finally { clearTimeout(timer); }
}

function sourceText(event, market) {
  return [event?.resolutionSource, event?.rules, event?.description,
    market?.resolutionSource, market?.rules, market?.description].filter(Boolean).join('\n');
}

function feedSymbolMatchesEndpoint(feedSymbol, endpointSymbol) {
  const [qualifiedBase, quote] = String(feedSymbol || '').toUpperCase().split('/');
  const base = String(qualifiedBase || '').split('.').at(-1);
  const endpoint = String(endpointSymbol || '').trim().toUpperCase();
  return Boolean(base && quote && endpoint
    && (endpoint === base || endpoint === `${base}${quote}`));
}

function feeMetadata(market) {
  const schedule = market?.feeSchedule || market?.fee_schedule || {};
  const enabled = market?.feesEnabled === true || market?.fees_enabled === true
    || finite(schedule.rate ?? market?.fee_rate) > 0;
  const rate = enabled ? finite(schedule.rate ?? market?.fee_rate) : 0;
  const exponent = enabled ? finite(schedule.exponent) : 1;
  return { enabled, rate, exponent, known: !enabled || (rate >= 0 && exponent > 0) };
}

function normalizeCandidate(event, priceToBeat) {
  const markets = Array.isArray(event?.markets) ? event.markets : [];
  if (markets.length !== 1) return null;
  const market = markets[0];
  const outcomes = parseArray(market?.outcomes);
  const tokenIds = parseArray(market?.clobTokenIds);
  const source = sourceText(event, market);
  const question = String(market?.question || event?.title || '');
  const slug = String(market?.slug || event?.slug || '');
  const endpointSymbol = String(priceToBeat?.symbol || '').trim().toUpperCase();
  const pythFeedSymbol = extractExactPythFeedSymbol(source);
  const boundary = finite(priceToBeat?.priceToBeat);
  const startMs = Date.parse(priceToBeat?.eventStartTime || event?.startDate || market?.startDate);
  const endMs = Date.parse(priceToBeat?.endDate || event?.endDate || market?.endDate);
  const conditionId = market?.conditionId || market?.condition_id;
  const gammaId = market?.id;
  const eventId = event?.id;
  const explicitPyth = /pyth/i.test(source);
  const exactBinary = outcomes.length === 2 && outcomes.map((value) => String(value).toLowerCase()).join('|') === 'up|down';
  const endpointMatchesSlug = priceToBeat?.slug == null || String(priceToBeat.slug) === slug;
  const titleMatches = /\bup or down\b/i.test(question);
  const timingValid = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;
  const fees = feeMetadata(market);
  const minimumOrderSize = finite(market?.orderMinSize ?? market?.minimum_order_size);
  const ruleDocument = {
    experiment: 'pyth-resolver-boundary-transfer-v4-frozen-observation-window',
    eventId: eventId == null ? null : String(eventId),
    gammaId: gammaId == null ? null : String(gammaId), conditionId: conditionId == null ? null : String(conditionId),
    slug, question, outcomes: outcomes.map(String), tokenIds: tokenIds.map(String),
    resolutionSourceText: source, endpoint: {
      slug: priceToBeat?.slug || null, symbol: endpointSymbol, priceToBeat: boundary,
      timestamp: finite(priceToBeat?.timestamp), eventStartTime: priceToBeat?.eventStartTime || null,
      endDate: priceToBeat?.endDate || null,
      pythFeedSymbol,
    },
  };
  const failures = [];
  if (!conditionId || !gammaId || !eventId) failures.push('MISSING_EXACT_IDENTIFIERS');
  if (!explicitPyth) failures.push('NOT_EXPLICITLY_PYTH_RESOLVED');
  if (!pythFeedSymbol || !feedSymbolMatchesEndpoint(pythFeedSymbol, endpointSymbol)) {
    failures.push('MISSING_OR_MISMATCHED_EXACT_PYTH_FEED_SYMBOL');
  }
  if (!titleMatches || !exactBinary || tokenIds.length !== 2 || tokenIds.some((value) => !value)) failures.push('NOT_EXACT_UP_DOWN_BINARY');
  if (!endpointSymbol || !(boundary > 0) || !endpointMatchesSlug || !timingValid) failures.push('INVALID_PRICE_TO_BEAT_CERTIFICATE');
  if (!(minimumOrderSize > 0)) failures.push('UNKNOWN_MINIMUM_ORDER_SIZE');
  if (!fees.known) failures.push('UNKNOWN_FEE_SCHEDULE');
  return {
    eventId: eventId == null ? null : String(eventId),
    gammaId: gammaId == null ? null : String(gammaId),
    conditionId: conditionId == null ? null : String(conditionId),
    slug, question, symbol: endpointSymbol, pythFeedSymbol, boundary, startMs, endMs,
    upToken: tokenIds[0] == null ? null : String(tokenIds[0]),
    downToken: tokenIds[1] == null ? null : String(tokenIds[1]),
    minimumOrderSize, fees, active: event?.active !== false && market?.active !== false,
    closed: event?.closed === true || market?.closed === true,
    acceptingOrders: market?.acceptingOrders !== false && market?.accepting_orders !== false,
    ruleDocument, ruleHash: sha256(ruleDocument), certified: failures.length === 0, failures,
    raw: { event, priceToBeat, pythFeedSymbol },
  };
}

async function discoverPythUniverse(options = {}) {
  const getJson = options.fetchJson || fetchJson;
  const nowMs = Number(options.nowMs || Date.now());
  const maxPages = Math.max(1, Number(options.maxPages || 4));
  const events = [];
  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(`${GAMMA}/events`);
    Object.entries({
      tag_id: FINANCE_UPDOWN_TAG, active: 'true', closed: 'false',
      limit: '100', offset: String(page * 100), order: 'endDate', ascending: 'true',
    }).forEach(([key, value]) => url.searchParams.set(key, value));
    const rows = await getJson(url.toString());
    if (!Array.isArray(rows)) throw new Error('Gamma Pyth universe response is not an array');
    events.push(...rows);
    if (rows.length < 100) break;
  }
  const out = [];
  for (const event of events) {
    const market = Array.isArray(event?.markets) && event.markets.length === 1 ? event.markets[0] : null;
    const slug = market?.slug || event?.slug;
    if (!slug) continue;
    // Reject unrelated finance-tag markets before touching the specialized
    // endpoint. This keeps universe discovery bounded and avoids accidentally
    // treating a generic Pyth threshold contract as this exact experiment.
    const outcomes = parseArray(market?.outcomes).map((value) => String(value).toLowerCase());
    const question = String(market?.question || event?.title || '');
    if (!/\bup or down\b/i.test(question) || outcomes.join('|') !== 'up|down'
        || !/pyth/i.test(sourceText(event, market))) continue;
    let endpoint = null;
    try { endpoint = await getJson(`${PRICE_TO_BEAT}/${encodeURIComponent(slug)}`); }
    catch (_) { endpoint = null; }
    const candidate = normalizeCandidate(event, endpoint);
    if (candidate?.certified && candidate.active && !candidate.closed
        && candidate.acceptingOrders && candidate.endMs > nowMs) out.push(candidate);
  }
  return [...new Map(out.map((row) => [row.conditionId, row])).values()];
}

module.exports = {
  FINANCE_UPDOWN_TAG, GAMMA, PRICE_TO_BEAT, discoverPythUniverse, feeMetadata,
  feedSymbolMatchesEndpoint, fetchJson, finite, normalizeCandidate, parseArray, sha256, stableJson,
};
