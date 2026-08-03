'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { GAMMA, normalizeMarket } = require('../allmarket/universe');
const { compareContracts, finite, tokens } = require('./strategy');
const { compareExactRuleKeys } = require('./exact-rule-key');
const { normalizeKalshiFeeSchedule } = require('./kalshi-fees');
const {
  compileCrossVenueRelation, exactIdentityRelation, validateManualRelation,
} = require('./payoff-relations');
const { certifyIdentityBinding } = require('./identity-certifier');
const { SERIES: CRYPTO_SERIES, buildStructuredPairs } = require('./crypto-structured');
const { SERIES: SPORT_SERIES, buildStructuredSportsPairs } = require('./sports-structured');

const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const MATCH_FILE = path.join(__dirname, 'matches.json');

async function fetchJson(url, options = {}, timeoutMs = 20_000, retryOptions = {}) {
  const maxAttempts = Math.max(1, Math.min(6, Number(retryOptions.maxAttempts || 4)));
  const baseDelayMs = Math.max(1, Number(retryOptions.baseDelayMs || 500));
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const body = await response.text();
      if (!response.ok) {
        const error = new Error(`${url}: HTTP ${response.status} ${body.slice(0, 160)}`);
        error.status = response.status;
        const retryAfter = response.headers?.get?.('retry-after');
        const retrySeconds = parseFloat(retryAfter);
        error.retryAfterMs = Number.isFinite(retrySeconds) ? Math.max(0, retrySeconds * 1000) : null;
        throw error;
      }
      return { payload: JSON.parse(body), raw: body, latencyMs: Date.now() - started };
    } catch (error) {
      lastError = error;
      const retryable = error?.status === 429 || error?.status >= 500 || error?.status == null;
      if (!retryable || attempt + 1 >= maxAttempts) throw error;
      const exponential = baseDelayMs * (2 ** attempt);
      const delayMs = Math.min(10_000, error.retryAfterMs ?? exponential);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    } finally { clearTimeout(timeout); }
  }
  throw lastError;
}

function normalizeKalshiMarket(raw, event = null) {
  if (!raw?.ticker || raw?.market_type !== 'binary') return null;
  return {
    ticker: String(raw.ticker),
    eventTicker: raw.event_ticker ? String(raw.event_ticker)
      : event?.event_ticker ? String(event.event_ticker) : null,
    seriesTicker: event?.series_ticker ? String(event.series_ticker)
      : String(raw.ticker).split('-')[0] || null,
    eventTitle: event?.title || null,
    eventSubTitle: event?.sub_title || null,
    category: event?.category || null,
    settlementSources: Array.isArray(event?.settlement_sources)
      ? event.settlement_sources : [],
    mutuallyExclusive: event?.mutually_exclusive === true,
    title: raw.title || null,
    subtitle: raw.subtitle || null,
    yesSubTitle: raw.yes_sub_title || null,
    noSubTitle: raw.no_sub_title || null,
    rulesPrimary: raw.rules_primary || null,
    rulesSecondary: raw.rules_secondary || null,
    closeTime: raw.close_time || null,
    openTime: raw.open_time || null,
    expectedExpirationTime: raw.expected_expiration_time || null,
    latestExpirationTime: raw.latest_expiration_time || null,
    floorStrike: finite(raw.floor_strike, null),
    capStrike: finite(raw.cap_strike, null),
    strikeType: raw.strike_type || null,
    yesBid: finite(raw.yes_bid_dollars),
    yesAsk: finite(raw.yes_ask_dollars),
    noBid: finite(raw.no_bid_dollars),
    noAsk: finite(raw.no_ask_dollars),
    liquidity: finite(raw.liquidity_dollars, 0),
    volume24h: finite(raw.volume_24h_fp, 0),
    status: raw.status || null,
    canCloseEarly: raw.can_close_early === true,
    provisional: raw.is_provisional === true,
    feeSchedule: raw.fee_type || raw.fee_multiplier != null
      ? normalizeKalshiFeeSchedule(raw, {
        seriesTicker: event?.series_ticker || String(raw.ticker).split('-')[0] || null,
        source: 'kalshi_market_payload',
      }) : null,
  };
}

async function fetchKalshiSeriesFeeSchedules(seriesTickers, options = {}) {
  const tickers = [...new Set((seriesTickers || []).map(String).filter(Boolean))].sort();
  const paceMs = Math.max(0, Number(options.paceMs ?? 250));
  const observedAt = new Date().toISOString();
  const schedules = new Map();
  for (const ticker of tickers) {
    if (paceMs) await new Promise((resolve) => setTimeout(resolve, paceMs));
    try {
      const { payload } = await fetchJson(`${KALSHI}/series/${encodeURIComponent(ticker)}`);
      const raw = payload?.series || payload || {};
      schedules.set(ticker, normalizeKalshiFeeSchedule(raw, {
        seriesTicker: ticker,
        source: 'kalshi_get_series',
        observedAt,
      }));
    } catch (error) {
      schedules.set(ticker, normalizeKalshiFeeSchedule({}, {
        seriesTicker: ticker,
        source: `kalshi_get_series_error:${error?.status || error?.code || 'unknown'}`,
        observedAt,
      }));
      options.onError?.(ticker, error);
    }
  }
  return schedules;
}

function normalizePolyMarket(market) {
  const yesIndex = market.outcomes.findIndex((outcome) => String(outcome).toUpperCase() === 'YES');
  const noIndex = market.outcomes.findIndex((outcome) => String(outcome).toUpperCase() === 'NO');
  if (yesIndex < 0 || noIndex < 0) return null;
  const raw = market.raw || {};
  const event = raw.events?.[0] || {};
  return {
    conditionId: String(market.conditionId), gammaId: market.gammaId,
    slug: market.slug || raw.slug || null,
    question: market.question, eventTitle: event.title || null,
    description: raw.description || event.description || null,
    resolutionSource: raw.resolutionSource || event.resolutionSource || null,
    resolvedBy: raw.resolvedBy || null,
    endDate: market.endDate, category: market.category,
    yesToken: String(market.tokenIds[yesIndex]), noToken: String(market.tokenIds[noIndex]),
    tickSize: finite(market.tickSize, 0.01), feeRate: finite(market.feeRate, 0),
    orderMinSize: finite(market.orderMinSize, 5),
    feeExponent: finite(market.feeExponent, 1), liquidity: finite(market.liquidity, 0),
    volume24h: finite(market.volume24h, 0),
  };
}

async function fetchKalshiUniverse(options = {}) {
  const maxPages = Math.max(1, Number(options.maxPages || 20));
  const limit = Math.max(100, Math.min(1000, Number(options.limit || 1000)));
  const rows = []; let cursor = null;
  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(`${KALSHI}/markets`);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('status', 'open');
    url.searchParams.set('mve_filter', 'exclude');
    if (cursor) url.searchParams.set('cursor', cursor);
    const { payload } = await fetchJson(url);
    for (const raw of payload.markets || []) {
      const market = normalizeKalshiMarket(raw);
      if (market) rows.push(market);
    }
    cursor = payload.cursor;
    if (!cursor || (payload.markets || []).length < limit) break;
  }
  return rows;
}

/**
 * Fetch the complete open Kalshi universe by event, retaining event context.
 * The legacy /markets sweep is ordered such that a fixed page cap can omit
 * tens of thousands of active markets. /events with nested markets is capped
 * at 200 events per page and exposes the canonical event title/category needed
 * for cross-venue identity discovery.
 */
async function fetchKalshiEventUniverse(options = {}) {
  const maxPages = Math.max(1, Math.min(250, Number(options.maxPages || 100)));
  const limit = Math.max(1, Math.min(200, Number(options.limit || 200)));
  const paceMs = Math.max(0, Number(options.paceMs ?? 100));
  const statuses = Array.isArray(options.statuses) && options.statuses.length
    ? options.statuses : ['open'];
  const rows = []; const seen = new Set();
  let eventCount = 0; let pageCount = 0; let truncated = false;
  for (const status of statuses) {
    let cursor = null;
    for (let page = 0; page < maxPages; page += 1) {
      const url = new URL(`${KALSHI}/events`);
      url.searchParams.set('status', status);
      url.searchParams.set('with_nested_markets', 'true');
      url.searchParams.set('limit', String(limit));
      if (cursor) url.searchParams.set('cursor', cursor);
      const { payload } = await fetchJson(url);
      const events = Array.isArray(payload.events) ? payload.events : [];
      pageCount += 1;
      eventCount += events.length;
      for (const event of events) {
        for (const raw of event.markets || []) {
          const marketStatus = String(raw.status || '').toLowerCase();
          if (status === 'open' && marketStatus && !['active', 'open'].includes(marketStatus)) continue;
          if (raw.result) continue;
          const market = normalizeKalshiMarket(raw, event);
          if (!market || seen.has(market.ticker)) continue;
          seen.add(market.ticker);
          rows.push(market);
        }
      }
      options.onPage?.({ status, page: page + 1, events: eventCount, markets: rows.length });
      cursor = payload.cursor || null;
      if (!cursor || events.length < limit) break;
      if (page + 1 >= maxPages) truncated = true;
      if (paceMs) await new Promise((resolve) => setTimeout(resolve, paceMs));
    }
  }
  Object.defineProperty(rows, 'scan', {
    value: { pageCount, eventCount, truncated }, enumerable: false,
  });
  return rows;
}

/**
 * Fetch specific Kalshi series directly by series_ticker. The broad
 * /markets sweep is capped at maxPages*limit rows and fast-churning series
 * (crypto ladders, weekend game slates) routinely fall outside that
 * window — this path guarantees their capture. Includes not-yet-open
 * windows inside the horizon so short-lived contracts are already matched
 * and monitored when trading begins.
 */
async function fetchKalshiSeriesUniverse(seriesTickers, options = {}) {
  const horizonMs = Math.max(900_000, Number(options.horizonMs || 3 * 3600_000));
  const paceMs = Math.max(0, Number(options.paceMs ?? 350));
  const cutoff = Date.now() + horizonMs;
  const rows = []; const seen = new Set();
  for (const ticker of seriesTickers) {
    for (const status of ['open', 'unopened']) {
      let cursor = null;
      for (let page = 0; page < 3; page += 1) {
        // Kalshi's public tier rate-limits bursts; ~3 requests/second keeps
        // the whole sweep (~40 pages) under it.
        if (paceMs) await new Promise((resolve) => setTimeout(resolve, paceMs));
        const url = new URL(`${KALSHI}/markets`);
        url.searchParams.set('series_ticker', ticker);
        url.searchParams.set('status', status);
        url.searchParams.set('limit', '200');
        if (cursor) url.searchParams.set('cursor', cursor);
        let payload;
        try { ({ payload } = await fetchJson(url)); } catch (error) {
          if (options.onError) options.onError(ticker, error);
          break;
        }
        for (const raw of payload.markets || []) {
          const market = normalizeKalshiMarket(raw);
          if (!market || seen.has(market.ticker)) continue;
          // Sports close_time is padded weeks past the game; the expected
          // expiration is the real deadline. Use the earliest known one.
          const deadlineMs = Math.min(...[market.expectedExpirationTime, market.closeTime]
            .map((value) => Date.parse(value || '')).filter(Number.isFinite));
          if (!Number.isFinite(deadlineMs) || deadlineMs > cutoff || deadlineMs < Date.now()) continue;
          seen.add(market.ticker);
          rows.push(market);
        }
        cursor = payload.cursor;
        if (!cursor || (payload.markets || []).length < 200) break;
      }
    }
  }
  return rows;
}

function fetchKalshiCryptoUniverse(options = {}) {
  return fetchKalshiSeriesUniverse(CRYPTO_SERIES.map((row) => row.ticker), options);
}

function fetchKalshiSportsUniverse(options = {}) {
  return fetchKalshiSeriesUniverse(SPORT_SERIES.map((row) => row.ticker), {
    // Weekend slates post a day or two ahead; a short horizon would miss
    // tomorrow's games that Polymarket already quotes.
    horizonMs: Number(options.horizonMs || 48 * 3600_000),
    ...options,
  });
}

/**
 * Stream Gamma event windows into compact normalized records. The general
 * all-market discovery intentionally retains rich raw metadata; doing that for
 * two complete venues at once costs close to a gigabyte. This path retains only
 * fields required for identity and execution research.
 */
async function fetchPolyUniverseCompact(options = {}) {
  const pageSize = 100;
  const maxPages = Math.max(1, Math.min(20, Number(options.maxPages || 20)));
  const maxWindows = Math.max(1, Number(options.maxWindows || 10));
  const concurrency = Math.max(1, Math.min(10, Number(options.concurrency || 6)));
  const compact = new Map(); let endDateMin = null;
  let eventCount = 0; let pageCount = 0; let windowsScanned = 0;
  let complete = false; let truncated = false;
  for (let window = 0; window < maxWindows; window += 1) {
    windowsScanned += 1;
    let reachedEnd = false; let eventsInWindow = 0; let lastEndMs = null;
    for (let start = 0; start < maxPages; start += concurrency) {
      const pages = Array.from({ length: Math.min(concurrency, maxPages - start) }, (_, index) => start + index);
      const batches = await Promise.all(pages.map(async (page) => {
        const url = new URL(`${GAMMA}/events`);
        for (const [key, value] of Object.entries({
          active: 'true', closed: 'false', limit: String(pageSize), offset: String(page * pageSize),
          order: 'endDate', ascending: 'true', ...(endDateMin ? { end_date_min: endDateMin } : {}),
        })) url.searchParams.set(key, value);
        return (await fetchJson(url)).payload;
      }));
      pageCount += batches.length;
      for (const events of batches) {
        eventCount += events.length;
        eventsInWindow += events.length;
        if (events.length < pageSize) reachedEnd = true;
        for (const event of events) {
          const endMs = Date.parse(event.endDate);
          if (Number.isFinite(endMs)) lastEndMs = Math.max(lastEndMs || endMs, endMs);
          for (const raw of event.markets || []) {
            const normalized = normalizeMarket({
              ...raw,
              events: [{
                id: event.id, slug: event.slug, title: event.title,
                description: event.description, resolutionSource: event.resolutionSource,
              }],
            });
            if (!normalized?.active || normalized.closed || !normalized.acceptingOrders) continue;
            const market = normalizePolyMarket(normalized);
            if (market) compact.set(market.conditionId, market);
          }
        }
      }
      if (reachedEnd) break;
    }
    if (reachedEnd || eventsInWindow < maxPages * pageSize) { complete = true; break; }
    if (!Number.isFinite(lastEndMs)) { truncated = true; break; }
    if (window + 1 >= maxWindows) { truncated = true; break; }
    endDateMin = new Date(lastEndMs + 1).toISOString();
  }
  const rows = [...compact.values()];
  Object.defineProperty(rows, 'scan', {
    value: {
      source: 'gamma_events_end_date_windows', pageCount, eventCount,
      windowCount: windowsScanned, truncated: truncated || !complete,
    },
    enumerable: false,
  });
  return rows;
}

function parseManualIdentityReviews(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('crossvenue matches.json must contain an object');
  }
  if (!Array.isArray(parsed.matches)) {
    throw new Error('crossvenue matches.json requires a matches array');
  }
  const rejectionFamilies = Array.isArray(parsed.rejectionFamilies)
    ? parsed.rejectionFamilies : [];
  const relations = Array.isArray(parsed.relations) ? parsed.relations : [];
  const ids = new Set();
  for (const review of rejectionFamilies) {
    if (!review?.id || ids.has(review.id)) {
      throw new Error('crossvenue rejection families require unique ids');
    }
    ids.add(review.id);
    if (review.approved === true) {
      throw new Error(`family review ${review.id} cannot approve contracts; approvals require exact ids`);
    }
    if (!review.polyEventTitle || !review.kalshiEventTicker) {
      throw new Error(`family review ${review.id} requires polyEventTitle and kalshiEventTicker`);
    }
    if (!Array.isArray(review.reasonCodes) || !review.reasonCodes.length) {
      throw new Error(`family review ${review.id} requires reasonCodes`);
    }
  }
  for (const relation of relations) {
    validateManualRelation(relation);
    if (ids.has(relation.id)) throw new Error(`duplicate cross-venue review id ${relation.id}`);
    ids.add(relation.id);
  }
  return {
    matches: parsed.matches,
    relations,
    rejectionFamilies,
    reviewedAt: parsed.reviewedAt || null,
    sourceSnapshot: parsed.sourceSnapshot || null,
  };
}

function loadManualIdentityReviews() {
  return parseManualIdentityReviews(JSON.parse(fs.readFileSync(MATCH_FILE, 'utf8')));
}

function loadManualMatches() {
  return loadManualIdentityReviews().matches;
}

function candidateId(polyConditionId, kalshiTicker) {
  return `cv:${polyConditionId}:${kalshiTicker}`;
}

function familyReviewKey(polyEventTitle, kalshiEventTicker) {
  return `${String(polyEventTitle || '')}\u0000${String(kalshiEventTicker || '')}`;
}

function isRejectedIdentity(row) {
  return row?.identityStatus === 'REJECTED' || row?.identityStatus === 'MANUALLY_REJECTED';
}

function selectMonitoredCandidates(candidates, maxMonitored, rejectedControlLimit = 0) {
  const limit = Math.max(1, Number(maxMonitored || 1));
  const primary = candidates.filter((row) => row.relationApproved || !isRejectedIdentity(row)).slice(0, limit);
  const controlSlots = Math.max(0, Math.min(
    limit - primary.length,
    Number(rejectedControlLimit || 0),
  ));
  const controls = candidates.filter((row) => isRejectedIdentity(row) && !row.relationApproved)
    .slice(0, controlSlots);
  return { monitored: [...primary, ...controls], diagnosticControls: controls.length };
}

/**
 * Operator-approved paper enrollment is deliberately weaker than a payoff
 * relation approval. It may widen live-data collection and arm a convergence
 * simulation, but it can never set identityApproved/relationApproved or turn
 * an assumed $1 parity into a certified terminal lock.
 */
function applyPaperEvaluationPolicy(candidate, options = {}) {
  const floor = Math.max(0, Math.min(1, finite(options.paperScoreFloor, 0.8)));
  const exactRuleApproval = options.exactRuleApproval === true;
  const scoreApproval = options.paperScoreApproval === true
    && finite(candidate?.score, 0) > floor;
  const approved = (exactRuleApproval || scoreApproval)
    && !isRejectedIdentity(candidate)
    && candidate.exactRuleEligible === true
    && candidate.hardMismatch !== true;
  const approvedAt = Number.isFinite(Date.parse(options.paperApprovedAt || ''))
    ? new Date(options.paperApprovedAt).toISOString() : null;
  return {
    ...candidate,
    paperEvalApproved: approved,
    paperEvalStatus: approved ? exactRuleApproval
      ? 'EXACT_RULE_KEY_APPROVED_PAPER_ONLY' : 'OPERATOR_APPROVED_PAPER_ONLY'
      : candidate.hardMismatch === true ? 'HARD_RULE_MISMATCH_VETO'
        : candidate.ruleComparisonStatus === 'UNKNOWN' ? 'RULE_FIELDS_UNKNOWN_REVIEW_REQUIRED'
        : isRejectedIdentity(candidate) ? 'IDENTITY_REJECTED' : 'NOT_APPROVED',
    paperEvalSource: approved ? exactRuleApproval
      ? 'frozen_exact_rule_key_v2' : 'exact_rule_key_v2_and_operator_score_threshold'
      : null,
    paperEvalApprovedAt: approved ? approvedAt : null,
    paperEvalScoreAtApproval: approved ? finite(candidate.score, 0) : null,
    paperEvalThreshold: approved && exactRuleApproval ? null : floor,
  };
}

function selectPaperMonitoredCandidates(candidates, options = {}) {
  const maxMonitored = Math.max(1, Number(options.maxMonitored || 1));
  const exploratoryLimit = Math.max(0, Number(options.exploratoryMonitored || 0));
  const rejectedControlLimit = Math.max(0, Number(options.rejectedControlLimit || 0));
  const structuredLimit = Math.max(0, Math.min(maxMonitored,
    Number(options.structuredMonitored ?? Math.ceil(maxMonitored / 2))));
  const required = candidates.filter((row) => row.relationApproved || row.paperEvalApproved)
    .sort((left, right) => Number(right.exactRuleEligible) - Number(left.exactRuleEligible)
      || Number(right.relationApproved) - Number(left.relationApproved)
      || Number(right.paperEvalApproved) - Number(left.paperEvalApproved)
      || finite(right.score, 0) - finite(left.score, 0));
  const requiredIds = new Set(required.map((row) => row.matchId));

  // Preserve the original family-balanced reserve for exploratory rows. A
  // frozen paper approval bypasses this reserve because the operator asked for
  // every member of that cohort to be observed.
  const byDeadline = (left, right) => Date.parse(left.structuredEvidence?.deadline || 0)
    - Date.parse(right.structuredEvidence?.deadline || 0);
  const structuredRows = candidates.filter((row) =>
    row.identityStatus === 'STRUCTURED_CANDIDATE' && !requiredIds.has(row.matchId));
  const sportsRows = structuredRows.filter((row) =>
    row.structuredEvidence?.version === 'crossvenue-sports-structured-v1').sort(byDeadline);
  const cryptoRows = structuredRows.filter((row) =>
    row.structuredEvidence?.version !== 'crossvenue-sports-structured-v1').sort(byDeadline);
  const sportsQuota = Math.min(sportsRows.length, Math.ceil(structuredLimit / 2));
  const structuredChosen = new Set([
    ...sportsRows.slice(0, sportsQuota),
    ...cryptoRows.slice(0, structuredLimit - sportsQuota),
  ].map((row) => row.matchId));
  const optionalPool = candidates.filter((row) => !requiredIds.has(row.matchId)
    && (row.identityStatus !== 'STRUCTURED_CANDIDATE' || structuredChosen.has(row.matchId)));
  const optionalSlots = Math.max(0, Math.min(
    exploratoryLimit,
    maxMonitored - Math.min(maxMonitored, required.length),
  ));
  const optional = optionalSlots > 0
    ? selectMonitoredCandidates(optionalPool, optionalSlots, rejectedControlLimit)
    : { monitored: [], diagnosticControls: 0 };
  const monitored = [...required.slice(0, maxMonitored), ...optional.monitored]
    .slice(0, maxMonitored);
  const paperApproved = candidates.filter((row) => row.paperEvalApproved).length;
  const paperMonitored = monitored.filter((row) => row.paperEvalApproved).length;
  return {
    monitored,
    diagnosticControls: optional.diagnosticControls,
    paperApproved,
    paperMonitored,
    paperOverflow: Math.max(0, paperApproved - paperMonitored),
  };
}

function applyFamilyRejection(candidate, review, reviewSet) {
  if (!review) return candidate;
  const reasons = [...new Set([...(candidate.mismatches || []), ...review.reasonCodes])];
  return {
    ...candidate,
    identityStatus: 'MANUALLY_REJECTED',
    identityApproved: false,
    approvalSource: 'frozen_family_review',
    mismatches: reasons,
    resolutionAudit: {
      decision: 'REJECTED',
      scope: 'event_family',
      reviewId: review.id,
      reviewedAt: review.reviewedAt || reviewSet.reviewedAt,
      sourceSnapshot: reviewSet.sourceSnapshot,
      dimensions: review.dimensions || [],
      rationale: review.rationale,
    },
  };
}

function buildCandidates(polyMarkets, kalshiMarkets, options = {}) {
  const maxCandidates = Math.max(1, Number(options.maxCandidates || 250));
  const manualReviews = loadManualIdentityReviews();
  const familyReviews = new Map(manualReviews.rejectionFamilies.map((review) => [
    familyReviewKey(review.polyEventTitle, review.kalshiEventTicker), review,
  ]));
  const polyById = new Map(polyMarkets.map((market) => [market.conditionId, market]));
  const kalshiByTicker = new Map(kalshiMarkets.map((market) => [market.ticker, market]));
  const tokenIndex = new Map();
  for (const market of polyMarkets) {
    for (const token of tokens(`${market.question || ''} ${market.eventTitle || ''}`)) {
      if (!tokenIndex.has(token)) tokenIndex.set(token, []);
      tokenIndex.get(token).push(market);
    }
  }
  const candidates = new Map();
  for (const kalshi of kalshiMarkets) {
    const counts = new Map();
    for (const token of tokens([
      kalshi.title, kalshi.eventTitle, kalshi.eventSubTitle, kalshi.yesSubTitle,
    ].filter(Boolean).join(' '))) {
      const bucket = tokenIndex.get(token) || [];
      // Very common words are poor identifiers and create quadratic work.
      if (bucket.length > 1000) continue;
      for (const poly of bucket) counts.set(poly.conditionId, (counts.get(poly.conditionId) || 0) + 1);
    }
    const shortlist = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
    for (const [conditionId] of shortlist) {
      const poly = polyById.get(conditionId);
      const audit = compareContracts(poly, kalshi);
      if (audit.identityStatus === 'UNMATCHED' || audit.identityStatus === 'REJECTED') continue;
      const id = candidateId(poly.conditionId, kalshi.ticker);
      candidates.set(id, {
        matchId: id, poly, kalshi, ...audit,
        identityApproved: false, approvalSource: null, resolutionAudit: null,
        identityCertification: certifyIdentityBinding(poly, kalshi, null),
        relationType: 'UNREVIEWED', relationApproved: false,
        relationStatus: 'PENDING_REVIEW', relationProof: null,
        relationResolutionAudit: null, stateEvidence: null,
      });
    }
  }

  // Structured crypto pairs are deterministic (asset, payoff form, deadline,
  // strike) matches — no token similarity involved. They outrank text
  // candidates for monitoring because their payoff linkage is provable, but
  // they are never identity-approved here: the resolver indexes differ, and
  // approval stays a frozen manual act.
  const structuredPairs = [
    ...buildStructuredPairs(polyMarkets, kalshiMarkets),
    ...buildStructuredSportsPairs(polyMarkets, kalshiMarkets),
  ];
  for (const pair of structuredPairs) {
    const audit = compareContracts(pair.poly, pair.kalshi);
    const id = candidateId(pair.poly.conditionId, pair.kalshi.ticker);
    const deadline = pair.structuredEvidence.deadline
      || pair.kalshi.expectedExpirationTime || pair.kalshi.closeTime;
    const hoursToDeadline = Math.max(0,
      (Date.parse(deadline) - (options.nowMs ?? Date.now())) / 3_600_000);
    candidates.set(id, {
      matchId: id, poly: pair.poly, kalshi: pair.kalshi, ...audit,
      identityStatus: 'STRUCTURED_CANDIDATE',
      score: +(0.99 - Math.min(0.09, hoursToDeadline * 0.005)).toFixed(6),
      mismatches: [...new Set([...(audit.mismatches || []), ...pair.structuredEvidence.reasons])],
      structuredEvidence: { ...pair.structuredEvidence, deadline },
      identityApproved: false, approvalSource: null, resolutionAudit: null,
      identityCertification: certifyIdentityBinding(pair.poly, pair.kalshi, null),
      relationType: 'UNREVIEWED', relationApproved: false,
      relationStatus: 'PENDING_REVIEW', relationProof: null,
      relationResolutionAudit: null, stateEvidence: null,
    });
  }

  for (const [id, candidate] of candidates) {
    const review = familyReviews.get(familyReviewKey(
      candidate.poly.eventTitle, candidate.kalshi.eventTicker,
    ));
    if (review) candidates.set(id, applyFamilyRejection(candidate, review, manualReviews));
  }

  for (const manual of manualReviews.matches) {
    const poly = polyById.get(String(manual.polyConditionId));
    const kalshi = kalshiByTicker.get(String(manual.kalshiTicker));
    if (!poly || !kalshi) continue;
    const audit = compareContracts(poly, kalshi);
    const id = candidateId(poly.conditionId, kalshi.ticker);
    const familyReview = familyReviews.get(familyReviewKey(poly.eventTitle, kalshi.eventTicker));
    if (manual.approved === true && familyReview) {
      throw new Error(`manual approval ${id} conflicts with rejected family ${familyReview.id}`);
    }
    const explicitlyRejected = manual.reviewed === true && manual.approved === false;
    const certification = certifyIdentityBinding(poly, kalshi, manual);
    const boundApproval = manual.approved === true && certification.valid;
    candidates.set(id, {
      matchId: id, poly, kalshi, ...audit,
      identityStatus: boundApproval ? 'MANUALLY_APPROVED'
        : manual.approved === true ? 'REQUIRES_RULE_HASH_REVIEW'
        : explicitlyRejected ? 'MANUALLY_REJECTED' : audit.identityStatus,
      identityApproved: boundApproval,
      identityCertification: certification,
      approvalSource: boundApproval || explicitlyRejected ? 'frozen_matches_json' : null,
      resolutionAudit: manual.resolutionAudit || null,
      mismatches: [...new Set([...(audit.mismatches || []), ...(manual.reasonCodes || [])])],
      relationType: boundApproval ? 'EQUIVALENT' : 'UNREVIEWED',
      relationApproved: boundApproval,
      relationStatus: boundApproval ? 'MANUALLY_APPROVED'
        : manual.approved === true ? 'REQUIRES_RULE_HASH_REVIEW' : 'PENDING_REVIEW',
      relationProof: boundApproval
        ? { ...exactIdentityRelation(id, manual.resolutionAudit || null),
          activeFrom: certification.activeFrom,
          identityCertification: certification }
        : null,
      relationResolutionAudit: boundApproval ? manual.resolutionAudit || null : null,
      stateEvidence: null,
    });
  }

  // Non-identical contracts may still have a formally proved implication,
  // mutual exclusion, or exhaustiveness relationship. Exact ids and a frozen
  // manual review are mandatory; title similarity can never create one.
  for (const manual of manualReviews.relations) {
    const poly = polyById.get(String(manual.polyConditionId));
    const kalshi = kalshiByTicker.get(String(manual.kalshiTicker));
    if (!poly || !kalshi) continue;
    const id = candidateId(poly.conditionId, kalshi.ticker);
    const audit = compareContracts(poly, kalshi);
    let candidate = candidates.get(id) || {
      matchId: id, poly, kalshi, ...audit,
      identityApproved: false, approvalSource: null, resolutionAudit: null,
      identityCertification: certifyIdentityBinding(poly, kalshi, null),
      mismatches: audit.mismatches || [],
    };
    const familyReview = familyReviews.get(familyReviewKey(poly.eventTitle, kalshi.eventTicker));
    if (familyReview) candidate = applyFamilyRejection(candidate, familyReview, manualReviews);
    const relation = compileCrossVenueRelation(manual, { nowMs: options.nowMs ?? Date.now() });
    const certification = certifyIdentityBinding(poly, kalshi, manual);
    const relationApproved = relation.relationApproved && certification.valid;
    const relationStatus = relationApproved ? relation.relationStatus
      : relation.relationApproved ? 'REQUIRES_RULE_HASH_REVIEW' : relation.relationStatus;
    const activeTimes = [relation.activeFrom, certification.activeFrom]
      .map((value) => Date.parse(value)).filter(Number.isFinite);
    const certifiedRelation = {
      ...relation, relationApproved, relationStatus,
      activeFrom: activeTimes.length ? new Date(Math.max(...activeTimes)).toISOString() : null,
      identityCertification: certification,
    };
    candidates.set(id, {
      ...candidate,
      relationType: relation.relationType,
      relationApproved,
      relationStatus,
      relationProof: certifiedRelation,
      relationResolutionAudit: relation.resolutionAudit,
      stateEvidence: relation.stateEvidence,
      identityCertification: certification,
      approvalSource: relationApproved
        ? 'frozen_payoff_relation_review' : candidate.approvalSource,
    });
  }
  return [...candidates.values()].map((candidate) => {
    const audit = compareExactRuleKeys(
      candidate.poly, candidate.kalshi, candidate.structuredEvidence,
    );
    return {
      ...candidate,
      exactRuleKey: audit.candidateKey,
      exactRuleEligible: audit.exactRuleEligible,
      ruleComparisonStatus: audit.comparisonStatus,
      hardMismatch: audit.hardMismatch,
      hardMismatchReasons: audit.hardMismatchReasons,
      unknownRuleReasons: audit.unknownRuleReasons,
      exactRuleReviewKey: audit.reviewKey,
      exactRuleAudit: audit,
    };
  }).sort((left, right) =>
    Number(right.relationApproved) - Number(left.relationApproved)
    || Number(right.identityApproved) - Number(left.identityApproved)
    || Number(right.exactRuleEligible) - Number(left.exactRuleEligible)
    || Number(!isRejectedIdentity(right)) - Number(!isRejectedIdentity(left))
    // Within the same confidence decile, collect the pair with greater
    // observable capacity rather than wasting scarce sockets on empty books.
    || Math.floor(right.score * 10) - Math.floor(left.score * 10)
    || (right.poly.volume24h + right.kalshi.volume24h) - (left.poly.volume24h + left.kalshi.volume24h)
    || right.score - left.score
    || left.matchId.localeCompare(right.matchId)).slice(0, maxCandidates);
}

async function discoverCrossVenue(options = {}) {
  const polyPromise = fetchPolyUniverseCompact({
    maxPages: Number(options.gammaPages || 20),
    maxWindows: Number(options.gammaWindows || 10),
    concurrency: Number(options.gammaConcurrency || 6),
  }).then((value) => ({ value }), (error) => ({ error }));
  const kalshiEventPromise = fetchKalshiEventUniverse({
    maxPages: Number(options.kalshiEventPages || 100),
    paceMs: Number(options.kalshiEventPaceMs ?? 250),
    onPage: options.onKalshiEventPage,
  }).catch(async (error) => {
    options.onCryptoError?.('full_event_universe', error);
    const fallback = await fetchKalshiUniverse({ maxPages: Number(options.kalshiPages || 20) });
    Object.defineProperty(fallback, 'scan', {
      value: { pageCount: null, eventCount: null, truncated: true, source: 'markets_fallback' },
      enumerable: false,
    });
    return fallback;
  });
  // The event scan and two targeted series scans share one public Kalshi rate
  // budget. Complete the exhaustive open-event pass first, then run the two
  // small unopened-window supplements at a conservative combined pace.
  const kalshiBroad = await kalshiEventPromise;
  const [polyResult, kalshiCrypto, kalshiSports] = await Promise.all([
    polyPromise,
    fetchKalshiCryptoUniverse({
      horizonMs: Number(options.cryptoHorizonMs || 3 * 3600_000),
      paceMs: Number(options.kalshiSeriesPaceMs ?? 500),
      onError: options.onCryptoError,
    }),
    fetchKalshiSportsUniverse({
      horizonMs: Number(options.sportsHorizonMs || 48 * 3600_000),
      paceMs: Number(options.kalshiSeriesPaceMs ?? 500),
      onError: options.onCryptoError,
    }),
  ]);
  if (polyResult.error) throw polyResult.error;
  const poly = polyResult.value;
  const polyScan = { source: 'gamma_events_end_date_windows', ...(poly.scan || {}) };
  const kalshiScan = { source: 'events_with_nested_markets', ...(kalshiBroad.scan || {}) };
  const kalshiByTicker = new Map(kalshiBroad.map((market) => [market.ticker, market]));
  for (const market of [...kalshiCrypto, ...kalshiSports]) kalshiByTicker.set(market.ticker, market);
  // Manually reviewed pairs must always have both legs present: the broad
  // sweep truncates at its page cap and long-dated contracts fall outside
  // it, which would silently prevent a frozen approval from ever binding.
  const manualReviews = loadManualIdentityReviews();
  const polyIds = new Set(poly.map((market) => market.conditionId));
  for (const entry of [...manualReviews.matches, ...manualReviews.relations]) {
    const ticker = String(entry.kalshiTicker || '');
    if (ticker && !kalshiByTicker.has(ticker)) {
      try {
        const { payload } = await fetchJson(`${KALSHI}/markets/${ticker}`);
        const market = normalizeKalshiMarket(payload?.market);
        if (market && !payload?.market?.result) kalshiByTicker.set(market.ticker, market);
      } catch (error) { if (options.onCryptoError) options.onCryptoError(ticker, error); }
    }
    const conditionId = String(entry.polyConditionId || '');
    if (conditionId && !polyIds.has(conditionId)) {
      try {
        const url = new URL(`${GAMMA}/markets`);
        url.searchParams.set('condition_ids', conditionId);
        const { payload } = await fetchJson(url);
        for (const raw of Array.isArray(payload) ? payload : []) {
          const normalized = normalizeMarket({ ...raw, events: raw.events || [] });
          if (!normalized?.active || normalized.closed || !normalized.acceptingOrders) continue;
          const market = normalizePolyMarket(normalized);
          if (market) { poly.push(market); polyIds.add(market.conditionId); }
        }
      } catch (error) { if (options.onCryptoError) options.onCryptoError(conditionId, error); }
    }
  }
  const kalshi = [...kalshiByTicker.values()];
  const candidates = buildCandidates(poly, kalshi, options)
    .map((row) => applyPaperEvaluationPolicy(row, options));
  const maxMonitored = Math.max(1, Number(options.maxMonitored || 6));
  const eligible = candidates.filter((row) => !isRejectedIdentity(row));
  const selection = selectPaperMonitoredCandidates(candidates, {
    maxMonitored,
    exploratoryMonitored: Number(options.exploratoryMonitored || 0),
    rejectedControlLimit: Number(options.rejectedControlLimit || 0),
    structuredMonitored: Number(options.structuredMonitored ?? Math.ceil(maxMonitored / 2)),
  });
  const feeSchedules = await fetchKalshiSeriesFeeSchedules(
    selection.monitored.map((row) => row.kalshi.seriesTicker),
    {
      paceMs: Number(options.kalshiFeePaceMs ?? 250),
      onError: options.onCryptoError,
    },
  );
  for (const candidate of candidates) {
    const schedule = feeSchedules.get(candidate.kalshi.seriesTicker)
      || candidate.kalshi.feeSchedule
      || normalizeKalshiFeeSchedule({}, {
        seriesTicker: candidate.kalshi.seriesTicker,
        source: 'not_monitored_not_fetched',
      });
    candidate.kalshi.feeSchedule = schedule;
  }
  return {
    polyCount: poly.length, kalshiCount: kalshi.length,
    polyEventCount: polyScan.eventCount,
    polyEventPages: polyScan.pageCount,
    polyUniverseTruncated: polyScan.truncated === true,
    polyUniverseSource: polyScan.source,
    kalshiEventCount: kalshiScan.eventCount,
    kalshiEventPages: kalshiScan.pageCount,
    kalshiUniverseTruncated: kalshiScan.truncated === true,
    kalshiUniverseSource: kalshiScan.source,
    kalshiCryptoCount: kalshiCrypto.length,
    structuredCount: candidates.filter((row) => row.identityStatus === 'STRUCTURED_CANDIDATE').length,
    candidates,
    pendingCount: eligible.filter((row) => !row.identityApproved && !row.relationApproved).length,
    reviewedRejectedCount: candidates.filter(isRejectedIdentity).length,
    monitored: selection.monitored,
    diagnosticControls: selection.diagnosticControls,
    paperApprovedCount: selection.paperApproved,
    paperMonitoredCount: selection.paperMonitored,
    paperOverflowCount: selection.paperOverflow,
  };
}

module.exports = {
  KALSHI, MATCH_FILE, buildCandidates, candidateId, discoverCrossVenue,
  fetchKalshiSeriesFeeSchedules,
  fetchJson, fetchKalshiCryptoUniverse, fetchKalshiEventUniverse, fetchKalshiSeriesUniverse,
  fetchKalshiSportsUniverse, fetchKalshiUniverse,
  fetchPolyUniverseCompact, isRejectedIdentity,
  loadManualIdentityReviews, loadManualMatches, normalizeKalshiMarket, normalizePolyMarket,
  parseManualIdentityReviews, selectMonitoredCandidates,
  applyPaperEvaluationPolicy, selectPaperMonitoredCandidates,
};
