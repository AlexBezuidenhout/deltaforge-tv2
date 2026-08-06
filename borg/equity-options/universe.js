'use strict';

/** Exact-rule Pyth daily equity threshold universe for listed-option research. */

const { extractExactPythFeedSymbol } = require('../pyth/hermes');
const { feeMetadata, parseArray, sha256 } = require('../pyth/universe');

const EQUITY_OPTION_UNIVERSE_VERSION = 'equity-pyth-exact-expiry-v1';

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sourceText(event, market) {
  return [event?.resolutionSource, event?.description,
    market?.resolutionSource, market?.description].filter(Boolean).join('\n');
}

function thresholdSymbol(source) {
  const feed = extractExactPythFeedSymbol(source);
  const match = /^Equity\.US\.([A-Z0-9.-]+)\/USD$/i.exec(String(feed || ''));
  return match ? { symbol: match[1].toUpperCase(), pythFeedSymbol: feed } : null;
}

function thresholdStrike(market) {
  const text = `${market?.groupItemTitle || ''} ${market?.question || ''}`
    .replace(/,/g, '');
  const match = text.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
  return match ? finite(match[1]) : null;
}

function normalizeEquityThreshold(event, market) {
  const source = sourceText(event, market);
  const identity = thresholdSymbol(source);
  const outcomes = parseArray(market?.outcomes).map(String);
  const tokenIds = parseArray(market?.clobTokenIds).map(String);
  const strike = thresholdStrike(market);
  const expiryMs = Date.parse(market?.endDate || event?.endDate);
  const text = source.toLowerCase().replace(/\s+/g, ' ');
  const fees = feeMetadata(market);
  const minimumOrderSize = finite(market?.orderMinSize ?? market?.minimum_order_size);
  const checks = {
    exactIdentifiers: Boolean(event?.id && market?.id && market?.conditionId),
    listedEquityFeed: Boolean(identity),
    closeAbovePredicate: /resolve to ["“]?yes["”]? if the close price/.test(text)
      && /higher than the listed price/.test(text),
    strictTieToNo: /exactly equal.*resolve to ["“]?no["”]?/.test(text),
    exactPythClose: /published by pyth/.test(text)
      && /1-minute candle.*final minute of regular trading hours/.test(text),
    regularSessionOnly: /regular trading hours/.test(text),
    noSessionFiftyFifty: /does not trade at all.*resolve 50(?:[-–]|\s)50/.test(text)
      && /not a trading day.*resolve 50(?:[-–]|\s)50/.test(text),
    officialFallback: /no valid pyth price.*official closing price/.test(text),
    corporateActionSpecified: /stock split.*target price will be adjusted proportionally/.test(text),
    exactBinary: outcomes.length === 2
      && outcomes.map((value) => value.toLowerCase()).join('|') === 'yes|no'
      && tokenIds.length === 2 && tokenIds[0] !== tokenIds[1],
    strikeAndExpiry: strike > 0 && Number.isFinite(expiryMs),
    feeScheduleKnown: fees.known,
    venueMinimumKnown: minimumOrderSize > 0,
  };
  const failures = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
  const ruleDocument = {
    version: EQUITY_OPTION_UNIVERSE_VERSION,
    eventId: event?.id == null ? null : String(event.id),
    gammaId: market?.id == null ? null : String(market.id),
    conditionId: market?.conditionId || null,
    eventSlug: event?.slug || null,
    marketSlug: market?.slug || null,
    question: market?.question || null,
    symbol: identity?.symbol || null,
    pythFeedSymbol: identity?.pythFeedSymbol || null,
    strike,
    expiryMs: Number.isFinite(expiryMs) ? expiryMs : null,
    outcomes,
    tokenIds,
    resolutionSourceText: source,
    checks,
  };
  return {
    eventId: ruleDocument.eventId,
    gammaId: ruleDocument.gammaId,
    conditionId: ruleDocument.conditionId,
    slug: market?.slug || event?.slug || null,
    question: market?.question || null,
    symbol: identity?.symbol || null,
    pythFeedSymbol: identity?.pythFeedSymbol || null,
    strike,
    expiryMs,
    yesToken: tokenIds[0] || null,
    noToken: tokenIds[1] || null,
    minimumOrderSize,
    fees,
    active: event?.active !== false && market?.active !== false,
    closed: event?.closed === true || market?.closed === true,
    acceptingOrders: market?.acceptingOrders !== false && market?.accepting_orders !== false,
    checks,
    failures,
    certified: failures.length === 0,
    ruleDocument,
    ruleHash: sha256(ruleDocument),
  };
}

function selectEquityThresholds(events, options = {}) {
  const symbols = new Set((options.symbols || ['SPY', 'EWY'])
    .map((value) => String(value).toUpperCase()));
  const nowMs = Number(options.nowMs ?? Date.now());
  const records = [];
  const rejected = {};
  for (const event of Array.isArray(events) ? events : []) {
    if (!/\bcloses above\b/i.test(String(event?.title || ''))) continue;
    for (const market of event?.markets || []) {
      const record = normalizeEquityThreshold(event, market);
      if (!record.certified) {
        for (const failure of record.failures) rejected[failure] = (rejected[failure] || 0) + 1;
        continue;
      }
      if (!symbols.has(record.symbol) || !record.active || record.closed
          || !record.acceptingOrders || !(record.expiryMs > nowMs)) continue;
      records.push(record);
    }
  }
  return {
    universeVersion: EQUITY_OPTION_UNIVERSE_VERSION,
    symbols: [...symbols],
    records: [...new Map(records.map((record) => [record.conditionId, record])).values()],
    rejected,
  };
}

module.exports = {
  EQUITY_OPTION_UNIVERSE_VERSION,
  normalizeEquityThreshold,
  selectEquityThresholds,
  thresholdStrike,
  thresholdSymbol,
};
