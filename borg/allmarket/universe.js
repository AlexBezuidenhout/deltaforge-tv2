'use strict';

const crypto = require('node:crypto');

const CLOB = 'https://clob.polymarket.com';
const GAMMA = 'https://gamma-api.polymarket.com';

function finite(value, fallback = null) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) { return []; }
}

async function fetchJson(url, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timeout); }
}

async function concurrentMap(items, width, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor; cursor += 1;
      try { results[index] = await fn(items[index], index); } catch (_) { results[index] = null; }
    }
  }));
  return results.filter(Boolean);
}

function inferCategory(market) {
  const feeType = String(market?.feeType || market?.fee_type || market?.fee_schedule?.name || '').toLowerCase();
  const text = `${market?.question || ''} ${market?.slug || ''} ${market?.events?.[0]?.title || ''}`.toLowerCase();
  if (feeType.includes('sport') || /\b(nba|nfl|nhl|mlb|soccer|football|tennis|match|game|cup|league)\b/.test(text)) return 'sports';
  if (feeType.includes('crypto') || /\b(bitcoin|ethereum|solana|xrp|doge|crypto|btc|eth)\b/.test(text)) return 'crypto';
  if (/\b(weather|temperature|rain|snow|hurricane|storm)\b/.test(text)) return 'weather';
  if (/\b(election|president|prime minister|senate|congress|vote)\b/.test(text)) return 'politics';
  if (/\b(stock|nasdaq|s&p|fed|rate|gdp|inflation|finance)\b/.test(text)) return 'finance';
  return 'other';
}

function normalizeMarket(raw, reward = null) {
  const outcomes = parseArray(raw?.outcomes).length ? parseArray(raw.outcomes)
    : (raw?.tokens || []).map((token) => token.outcome);
  const tokenIds = parseArray(raw?.clobTokenIds).length ? parseArray(raw.clobTokenIds)
    : (raw?.tokens || []).map((token) => token.token_id);
  if (!raw?.conditionId && !raw?.condition_id) return null;
  if (outcomes.length !== 2 || tokenIds.length !== 2 || tokenIds.some((token) => !token)) return null;
  const prices = parseArray(raw?.outcomePrices).map((value) => finite(value));
  const feeSchedule = raw?.feeSchedule || raw?.fee_schedule || {};
  const rewards = Array.isArray(raw?.clobRewards) ? raw.clobRewards : [];
  const category = inferCategory(raw);
  const feesEnabled = raw?.feesEnabled === true || raw?.fees_enabled === true;
  const scheduledRate = finite(feeSchedule?.rate, finite(raw?.fee_rate));
  const rewardRate = finite(reward?.total_daily_rate,
    rewards.reduce((sum, item) => sum + finite(item?.rewardsDailyRate, 0), 0));
  const minSize = finite(reward?.rewards_min_size, finite(raw?.rewardsMinSize, 0));
  const maxSpread = finite(reward?.rewards_max_spread, finite(raw?.rewardsMaxSpread, 0));
  const rewardWindows = Array.isArray(reward?.rewards_config) ? reward.rewards_config : [];
  const rewardStarts = rewardWindows.map((item) => Date.parse(item?.start_date)).filter(Number.isFinite);
  const rewardEnds = rewardWindows.map((item) => Date.parse(item?.end_date)).filter(Number.isFinite);
  const conditionId = String(raw.conditionId || raw.condition_id);
  const event = raw?.events?.[0] || {};
  return {
    conditionId,
    gammaId: raw?.id == null ? null : String(raw.id),
    eventId: event?.id == null ? null : String(event.id),
    eventSlug: event?.slug || null,
    question: raw?.question || null,
    slug: raw?.slug || null,
    category,
    outcomes: outcomes.map(String),
    tokenIds: tokenIds.map(String),
    prices,
    tickSize: finite(raw?.orderPriceMinTickSize, finite(raw?.minimum_tick_size, 0.01)),
    orderMinSize: finite(raw?.orderMinSize, finite(raw?.minimum_order_size, 5)),
    liquidity: finite(raw?.liquidityNum, finite(raw?.liquidity, 0)),
    volume24h: finite(raw?.volume24hr, finite(raw?.volume_24h, 0)),
    active: raw?.active !== false,
    closed: raw?.closed === true,
    acceptingOrders: raw?.acceptingOrders !== false && raw?.accepting_orders !== false,
    endDate: raw?.endDate || raw?.end_date_iso || null,
    feesEnabled,
    // Missing fee metadata must never create free paper execution. 0.07 is
    // the highest current category rate and is a conservative fallback only.
    feeRate: feesEnabled ? (scheduledRate ?? 0.07) : 0,
    feeSource: feesEnabled ? (scheduledRate == null ? 'conservative_0.07_fallback' : 'gamma_fee_schedule') : 'fee_free',
    feeExponent: finite(feeSchedule?.exponent, 1),
    feeTakerOnly: feeSchedule?.takerOnly !== false,
    rebateRate: finite(feeSchedule?.rebateRate, finite(raw?.rebate_rate, 0)),
    rewardsDailyRate: rewardRate,
    rewardsMinSize: minSize,
    rewardsMaxSpread: maxSpread,
    rewardsStartDate: rewardStarts.length ? new Date(Math.min(...rewardStarts)).toISOString() : null,
    rewardsEndDate: rewardEnds.length ? new Date(Math.max(...rewardEnds)).toISOString() : null,
    gameStartTime: raw?.gameStartTime || raw?.game_start_time || event?.startDate || event?.start_date || null,
    raw,
  };
}

async function fetchRewardConfigurations(maxPages = 24) {
  const rows = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(`${CLOB}/rewards/markets/current`);
    url.searchParams.set('limit', '500');
    if (cursor) url.searchParams.set('next_cursor', cursor);
    const payload = await fetchJson(url);
    rows.push(...(payload?.data || []));
    cursor = payload?.next_cursor;
    if (!cursor || cursor === 'LTE=') break;
  }
  return rows;
}

async function fetchActiveGammaMarkets(maxPages = 20, concurrency = 6, maxWindows = 10) {
  const pageSize = 100; // Gamma currently caps responses at 100 even if 500 is requested.
  const rows = [];
  // Gamma rejects offsets above 2,000. Direct market pages capture the top
  // volume set; active event pages provide the exhaustive embedded market set.
  const cappedPages = Math.min(20, maxPages);
  for (let start = 0; start < cappedPages; start += concurrency) {
    const pages = Array.from({ length: Math.min(concurrency, cappedPages - start) }, (_, index) => start + index);
    const batches = await Promise.all(pages.map((page) => {
      const url = new URL(`${GAMMA}/markets`);
      for (const [key, value] of Object.entries({
        active: 'true', closed: 'false', limit: String(pageSize), offset: String(page * pageSize),
        order: 'volume24hr', ascending: 'false',
      })) url.searchParams.set(key, value);
      return fetchJson(url);
    }));
    for (const batch of batches) rows.push(...batch);
    if (batches.some((batch) => batch.length < pageSize)) break;
  }
  let endDateMin = null;
  for (let window = 0; window < maxWindows; window += 1) {
    const windowEvents = [];
    let reachedEnd = false;
    for (let start = 0; start < cappedPages; start += concurrency) {
      const pages = Array.from({ length: Math.min(concurrency, cappedPages - start) }, (_, index) => start + index);
      const batches = await Promise.all(pages.map((page) => {
        const url = new URL(`${GAMMA}/events`);
        const params = {
          active: 'true', closed: 'false', limit: String(pageSize), offset: String(page * pageSize),
          order: 'endDate', ascending: 'true',
        };
        if (endDateMin) params.end_date_min = endDateMin;
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
        return fetchJson(url);
      }));
      for (const events of batches) windowEvents.push(...events);
      if (batches.some((batch) => batch.length < pageSize)) { reachedEnd = true; break; }
    }
    for (const event of windowEvents) {
      for (const market of event.markets || []) {
        rows.push({ ...market, events: [{ id: event.id, slug: event.slug, title: event.title }] });
      }
    }
    if (reachedEnd || windowEvents.length < cappedPages * pageSize) break;
    const lastEndMs = Math.max(...windowEvents.map((event) => Date.parse(event.endDate)).filter(Number.isFinite));
    if (!Number.isFinite(lastEndMs)) break;
    endDateMin = new Date(lastEndMs + 1).toISOString();
  }
  return [...new Map(rows.map((market) => [String(market.conditionId || market.id), market])).values()];
}

// Compatibility name retained for existing callers; the all-market lab now
// paginates the complete active binary universe instead of stopping at 500.
async function fetchTopGammaMarkets(limit = 500) {
  return (await fetchActiveGammaMarkets(Math.max(1, Math.ceil(limit / 500)))).slice(0, limit);
}

function rewardDensity(reward) {
  const rate = finite(reward?.total_daily_rate, 0);
  const size = Math.max(1, finite(reward?.rewards_min_size, 1));
  return rate / size;
}

async function discoverUniverse(options = {}) {
  const rewardFetchLimit = Math.max(20, Number(options.rewardFetchLimit || 240));
  const [rewards, gamma] = await Promise.all([
    fetchRewardConfigurations(Number(options.rewardPages || 24)),
    fetchActiveGammaMarkets(
      Number(options.gammaPages || 20),
      Number(options.gammaConcurrency || 6),
      Number(options.gammaWindows || 10),
    ),
  ]);
  const rewardMap = new Map(rewards.map((row) => [String(row.condition_id), row]));
  const rewardLeaders = rewards
    .filter((row) => finite(row.rewards_min_size, Infinity) <= Number(options.maxRewardMinSize || 100))
    .sort((left, right) => rewardDensity(right) - rewardDensity(left)
      || finite(right.total_daily_rate, 0) - finite(left.total_daily_rate, 0))
    .slice(0, rewardFetchLimit);
  const gammaConditions = new Set(gamma.map((market) => String(market.conditionId || market.condition_id)));
  const missing = rewardLeaders.filter((row) => !gammaConditions.has(String(row.condition_id)));
  const rewardMarkets = await concurrentMap(missing, Number(options.fetchConcurrency || 12),
    (row) => fetchJson(`${CLOB}/markets/${row.condition_id}`));
  const normalized = [...gamma, ...rewardMarkets]
    .map((market) => normalizeMarket(market, rewardMap.get(String(market.conditionId || market.condition_id))))
    .filter((market) => market?.active && !market.closed && market.acceptingOrders);
  return [...new Map(normalized.map((market) => [market.conditionId, market])).values()];
}

function isCatalystGuarded(market, nowMs, guardHours) {
  const end = Date.parse(market?.endDate);
  if (!Number.isFinite(end)) return false;
  return end - nowMs <= guardHours * 3600_000;
}

/**
 * Deterministic, PnL-independent panel selection. The whole rewards directory
 * and top-volume Gamma universe are scanned; only a bounded category-balanced
 * panel is subscribed because public CLOB sockets and local CPU are finite.
 */
function selectRealtimePanel(markets, options = {}) {
  const nowMs = Number(options.nowMs || Date.now());
  const maxMarkets = Math.max(2, Number(options.maxMarkets || 12));
  const guardHours = Math.max(0, Number(options.catalystGuardHours ?? 6));
  const noFairFeedGuardHours = Math.max(guardHours, Number(options.noFairFeedGuardHours ?? 24));
  const fairFeedCategories = new Set(options.fairFeedCategories || []);
  const catalystCategories = new Set(['sports', 'politics', 'finance', 'weather']);
  const maxCapitalPerMarket = Math.max(1, Number(options.maxCapitalPerMarket || 50));
  const toxicity = options.toxicity || new Map();
  const eligible = markets.filter((market) => {
    const price = market.prices.find((value) => value > 0 && value < 1) ?? 0.5;
    const rewardShares = Math.max(market.orderMinSize || 5, market.rewardsMinSize || 0);
    const capital = rewardShares * Math.max(price, 1 - price);
    const effectiveGuard = catalystCategories.has(market.category) && !fairFeedCategories.has(market.category)
      ? noFairFeedGuardHours : guardHours;
    return market.active && !market.closed && market.acceptingOrders
      && market.tokenIds.length === 2 && capital <= maxCapitalPerMarket
      && !isCatalystGuarded(market, nowMs, effectiveGuard);
  });
  const ranked = eligible.map((market) => {
    const tox = Math.max(0, finite(toxicity.get(market.conditionId), 0));
    const density = market.rewardsDailyRate / Math.max(1, market.rewardsMinSize || market.orderMinSize || 1);
    return {
      ...market,
      toxicityPenalty: tox,
      rewardDensity: density,
      selectionScore: density / (1 + tox) + Math.log1p(market.volume24h) / 100,
    };
  }).sort((left, right) => left.toxicityPenalty - right.toxicityPenalty
    || right.rewardDensity - left.rewardDensity
    || right.volume24h - left.volume24h
    || left.conditionId.localeCompare(right.conditionId));

  const categories = [...new Set(ranked.map((market) => market.category))].sort();
  const groups = new Map(categories.map((category) => [category, ranked.filter((market) => market.category === category)]));
  const selected = [];
  while (selected.length < maxMarkets) {
    let advanced = false;
    for (const category of categories) {
      const next = groups.get(category).shift();
      if (!next) continue;
      selected.push({ ...next, selectionReason: `category_round_robin:${category}` });
      advanced = true;
      if (selected.length >= maxMarkets) break;
    }
    if (!advanced) break;
  }
  return selected;
}

const NEGLECTED_PANEL_VERSION = 'neglected-capacity-panel-v1';

function neglectedPanelHash(markets) {
  const identity = (Array.isArray(markets) ? markets : [])
    .map((market) => String(market.conditionId))
    .sort()
    .join('\n');
  return crypto.createHash('sha256').update(
    `${NEGLECTED_PANEL_VERSION}\n${identity}`,
  ).digest('hex');
}

/**
 * PnL-independent capture panel for the neglected-capacity programme.
 *
 * This is a data-selection policy, not a trading policy. It deliberately does
 * not accept historical toxicity, realized PnL, model score or win rate. The
 * strata cover the mechanisms we need to falsify: multi-contract event graphs,
 * reward-bearing small-inventory books, obscure low-activity contracts and a
 * liquid control group. A panel is frozen by collection epoch in PostgreSQL by
 * the collector so a restart cannot cherry-pick a new cohort.
 */
function selectNeglectedPanel(markets, options = {}) {
  const nowMs = Number(options.nowMs || Date.now());
  const maxMarkets = Math.max(8, Number(options.maxMarkets || 60));
  const maxCapitalPerMarket = Math.max(1, Number(options.maxCapitalPerMarket || 100));
  const guardHours = Math.max(0, Number(options.catalystGuardHours ?? 6));
  const noFairFeedGuardHours = Math.max(guardHours, Number(options.noFairFeedGuardHours ?? 24));
  const fairFeedCategories = new Set(options.fairFeedCategories || []);
  const catalystCategories = new Set(['sports', 'politics', 'finance', 'weather']);
  const eventSizes = new Map();
  for (const market of Array.isArray(markets) ? markets : []) {
    if (market?.eventId) eventSizes.set(
      String(market.eventId), (eventSizes.get(String(market.eventId)) || 0) + 1,
    );
  }
  const eligible = (Array.isArray(markets) ? markets : []).filter((market) => {
    const prices = market.prices.filter((value) => value > 0 && value < 1);
    const worstPrice = prices.length ? Math.max(...prices, ...prices.map((value) => 1 - value)) : 0.5;
    const minimumShares = Math.max(market.orderMinSize || 5, market.rewardsMinSize || 0);
    const minimumCapital = minimumShares * worstPrice;
    const effectiveGuard = catalystCategories.has(market.category) && !fairFeedCategories.has(market.category)
      ? noFairFeedGuardHours : guardHours;
    return market.active && !market.closed && market.acceptingOrders
      && market.tokenIds.length === 2 && minimumCapital <= maxCapitalPerMarket
      && !isCatalystGuarded(market, nowMs, effectiveGuard);
  }).map((market) => ({
    ...market,
    eventGroupSize: market.eventId ? eventSizes.get(String(market.eventId)) || 1 : 1,
    minimumCaptureCapital: Math.max(market.orderMinSize || 5, market.rewardsMinSize || 0)
      * Math.max(0.5, ...market.prices.filter((value) => value > 0 && value < 1)),
  }));

  const selected = [];
  const used = new Set();
  const take = (rows, quota, reason) => {
    for (const market of rows) {
      if (selected.length >= maxMarkets || quota <= 0) break;
      if (used.has(market.conditionId)) continue;
      used.add(market.conditionId);
      selected.push({ ...market, selectionReason: reason, selectionScore: maxMarkets - selected.length });
      quota -= 1;
    }
  };
  const quota = (share) => Math.max(1, Math.floor(maxMarkets * share));
  const stableId = (left, right) => left.conditionId.localeCompare(right.conditionId);

  take(eligible.filter((market) => market.eventGroupSize >= 2)
    .sort((left, right) => right.eventGroupSize - left.eventGroupSize
      || left.minimumCaptureCapital - right.minimumCaptureCapital || stableId(left, right)),
  quota(0.30), 'neglected:multi_contract_event_graph');
  take(eligible.filter((market) => market.rewardsDailyRate > 0)
    .sort((left, right) => (right.rewardsDailyRate / Math.max(1, right.rewardsMinSize || 1))
      - (left.rewardsDailyRate / Math.max(1, left.rewardsMinSize || 1))
      || left.minimumCaptureCapital - right.minimumCaptureCapital || stableId(left, right)),
  quota(0.20), 'neglected:reward_small_inventory');
  take(eligible.filter((market) => market.volume24h > 0 && market.liquidity > 0)
    .sort((left, right) => left.volume24h - right.volume24h
      || left.liquidity - right.liquidity || stableId(left, right)),
  quota(0.25), 'neglected:obscure_low_activity');
  take(eligible.filter((market) => market.volume24h > 0)
    .sort((left, right) => right.volume24h - left.volume24h
      || right.liquidity - left.liquidity || stableId(left, right)),
  quota(0.15), 'neglected:liquid_control');

  const remaining = eligible.filter((market) => !used.has(market.conditionId));
  const categories = [...new Set(remaining.map((market) => market.category))].sort();
  const groups = new Map(categories.map((category) => [category, remaining
    .filter((market) => market.category === category)
    .sort((left, right) => left.minimumCaptureCapital - right.minimumCaptureCapital
      || stableId(left, right))]));
  while (selected.length < maxMarkets) {
    let advanced = false;
    for (const category of categories) {
      const next = groups.get(category).shift();
      if (!next) continue;
      used.add(next.conditionId);
      selected.push({
        ...next,
        selectionReason: `neglected:category_balance:${category}`,
        selectionScore: maxMarkets - selected.length,
      });
      advanced = true;
      if (selected.length >= maxMarkets) break;
    }
    if (!advanced) break;
  }
  return selected;
}

module.exports = {
  CLOB,
  GAMMA,
  concurrentMap,
  discoverUniverse,
  fetchJson,
  fetchActiveGammaMarkets,
  fetchRewardConfigurations,
  fetchTopGammaMarkets,
  finite,
  inferCategory,
  isCatalystGuarded,
  normalizeMarket,
  NEGLECTED_PANEL_VERSION,
  neglectedPanelHash,
  parseArray,
  rewardDensity,
  selectNeglectedPanel,
  selectRealtimePanel,
};
