/**
 * Bounded discovery for the forward-only H22-H31 research universe.
 *
 * Gamma exposes many thousands of active crypto contracts. Subscribing to all
 * of them would damage the event tape we are trying to measure, so this module
 * selects a pre-declared, capacity-bounded panel:
 *   - current + next one-hour Up/Down contracts for BTC/ETH/SOL/XRP;
 *   - five near-spot daily threshold contracts and four near-spot disjoint
 *     buckets for every configured asset with a fresh resolver price.
 *
 * The v2 panel expansion is an infrastructure/capture decision frozen before
 * its cohort. It is not a PnL-selected market filter. Missing spot data fails
 * closed so token prices (0-1) can never be mistaken for crypto spot.
 */
'use strict';

const ASSET_NAMES = Object.freeze({
  bitcoin: 'btc',
  ethereum: 'eth',
  solana: 'sol',
  xrp: 'xrp',
  dogecoin: 'doge',
  bnb: 'bnb',
  hype: 'hype',
  hyperliquid: 'hype',
});

const DEFAULT_HOURLY_ASSETS = Object.freeze(['btc', 'eth', 'sol', 'xrp']);
const DEFAULT_DAILY_ASSETS = Object.freeze(['btc', 'eth', 'sol', 'xrp']);

function jsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function assetFromTitle(title) {
  const first = String(title || '').trim().split(/\s+/)[0].toLowerCase();
  return ASSET_NAMES[first] || null;
}

function numericLabel(value) {
  const normalized = String(value || '')
    .toLowerCase()
    .replace(/\$/g, '')
    .replace(/,/g, '')
    .replace(/pt/g, '.')
    .trim();
  const number = parseFloat(normalized.match(/-?\d+(?:\.\d+)?/)?.[0]);
  return Number.isFinite(number) ? number : null;
}

function rangeLabel(value) {
  const normalized = String(value || '')
    .toLowerCase()
    .replace(/\$/g, '')
    .replace(/,/g, '')
    .replace(/pt/g, '.')
    .trim();
  const values = normalized.match(/\d+(?:\.\d+)?/g)?.map(Number) || [];
  if (normalized.startsWith('<') && values.length) return { lower: null, upper: values[0] };
  if (normalized.startsWith('>') && values.length) return { lower: values[0], upper: null };
  if (values.length >= 2) return { lower: values[0], upper: values[1] };
  return null;
}

function eventType(event) {
  const title = String(event?.title || '');
  if (/\bup or down\b/i.test(title)) return 'direction_window';
  if (/\babove\s+___\b/i.test(title)) return 'threshold_daily';
  if (/\bprice on\b/i.test(title)) return 'range_daily';
  return null;
}

/**
 * Polymarket runs 5m, 15m and 1h "Up or Down" series under near-identical
 * event titles; only the market slug is authoritative. Typing every up/down
 * event as hourly (pre-2026-07-18 behavior) mislabeled 539 fifteen-minute
 * markets as direction_1h with a window_start 45 minutes early, and created
 * duplicate in-memory records for 5m markets that leaked hourly-gated
 * strategies onto the 5m universe.
 */
function directionMarketType(slug) {
  const s = String(slug || '');
  if (s.includes('updown-5m')) return null; // primary 5m discovery owns these
  if (s.includes('updown-15m')) return 'direction_15m';
  return 'direction_1h';
}

function resolutionSource(event, market, type) {
  if (type === 'direction_1h') return 'binance_1h_candle';
  if (type === 'direction_15m') return 'chainlink_rtds_15m';
  const text = `${event?.description || ''} ${market?.description || ''} ${
    event?.resolutionSource || ''} ${market?.resolutionSource || ''}`.toLowerCase();
  if (/\bbinance\b/.test(text)) {
    if (/\b1\s*(?:hour|hr)\b/.test(text)) return 'binance_1h_close';
    if (/\b1\s*(?:minute|min)\b/.test(text)) return 'binance_1m_close';
    return 'binance_close';
  }
  if (/\bchainlink\b/.test(text)) return 'chainlink';
  if (/\bcoinbase\b/.test(text)) return 'coinbase';
  return 'unknown';
}

function marketRecord(event, market, requestedType) {
  const asset = assetFromTitle(event?.title);
  const end = new Date(market?.endDate || event?.endDate);
  if (!asset || !Number.isFinite(end.getTime())) return null;
  const type = requestedType === 'direction_window'
    ? directionMarketType(market?.slug || event?.slug)
    : requestedType;
  if (!type) return null;
  const outcomes = jsonArray(market?.outcomes);
  const tokenIds = jsonArray(market?.clobTokenIds);
  if (outcomes.length < 2 || tokenIds.length < 2) return null;

  const positiveIndex = outcomes.findIndex((outcome) => /^(up|yes)$/i.test(outcome));
  const negativeIndex = outcomes.findIndex((outcome) => /^(down|no)$/i.test(outcome));
  const pos = positiveIndex >= 0 ? positiveIndex : 0;
  const neg = negativeIndex >= 0 ? negativeIndex : 1;
  const start = type === 'direction_1h' ? new Date(end.getTime() - 3600_000)
    : type === 'direction_15m' ? new Date(end.getTime() - 900_000)
    : new Date(event?.startDate || end.getTime() - 24 * 3600_000);
  const label = market?.groupItemTitle || market?.question || '';
  const bounds = type === 'range_daily' ? rangeLabel(label) : null;
  const strike = type === 'threshold_daily' ? numericLabel(label) : null;

  return {
    slug: market?.slug || event?.slug,
    asset,
    gamma_id: String(market?.id ?? ''),
    condition_id: market?.conditionId || null,
    question: market?.question || event?.title || null,
    window_start: start,
    window_end: end,
    up_token_id: tokenIds[pos] || null,
    down_token_id: tokenIds[neg] || null,
    positive_label: String(outcomes[pos] || (type.startsWith('direction') ? 'UP' : 'YES')).toUpperCase(),
    negative_label: String(outcomes[neg] || (type.startsWith('direction') ? 'DOWN' : 'NO')).toUpperCase(),
    positive_outcome_index: pos,
    negative_outcome_index: neg,
    market_type: type,
    timeframe_sec: Math.max(1, Math.round((end.getTime() - start.getTime()) / 1000)),
    event_id: String(event?.id ?? ''),
    event_slug: event?.slug || null,
    strike,
    lower_bound: bounds?.lower ?? null,
    upper_bound: bounds?.upper ?? null,
    resolution_source: resolutionSource(event, market, type),
    accepting_orders: market?.acceptingOrders !== false && market?.closed !== true,
    raw: { ...market, _event: {
      id: event?.id, slug: event?.slug, title: event?.title,
      startDate: event?.startDate, endDate: event?.endDate,
      description: event?.description,
    } },
  };
}

function rangeDistance(record, spot) {
  if (!(spot > 0)) return Infinity;
  const lo = record.lower_bound;
  const hi = record.upper_bound;
  if ((lo == null || spot >= lo) && (hi == null || spot < hi)) return 0;
  if (lo != null && spot < lo) return lo - spot;
  if (hi != null && spot >= hi) return spot - hi;
  return Infinity;
}

function uniqueBySlug(records) {
  return [...new Map(records.filter((record) => record?.slug).map((record) => [record.slug, record])).values()];
}

function selectResearchMarkets(events, prices = {}, nowMs = Date.now(), options = {}) {
  const hourlyAssets = new Set(options.hourlyAssets || DEFAULT_HOURLY_ASSETS);
  const configuredDailyAssets = options.dailyAssets || DEFAULT_DAILY_ASSETS;
  const selectedDailyAssets = options.dailyAsset
    ? [String(options.dailyAsset).toLowerCase()]
    : [...configuredDailyAssets];
  const thresholdCount = Math.max(2, Number(options.thresholdCount || 5));
  const rangeCount = Math.max(2, Number(options.rangeCount || 4));
  const parsed = [];

  for (const event of Array.isArray(events) ? events : []) {
    const type = eventType(event);
    const asset = assetFromTitle(event?.title);
    if (!type || !asset) continue;
    for (const market of event?.markets || []) {
      const record = marketRecord(event, market, type);
      if (record?.accepting_orders) parsed.push(record);
    }
  }

  const selected = [];
  for (const asset of hourlyAssets) {
    for (const windowType of ['direction_1h', 'direction_15m']) {
      const windows = parsed
        .filter((record) => record.asset === asset && record.market_type === windowType &&
          record.window_end.getTime() > nowMs - 60_000 && record.window_start.getTime() <= nowMs + 3600_000)
        .sort((a, b) => a.window_end - b.window_end);
      const current = windows.find((record) => record.window_start.getTime() <= nowMs && record.window_end.getTime() > nowMs);
      const upcoming = windows.find((record) => record.window_start.getTime() > nowMs);
      if (current) selected.push(current);
      if (upcoming) selected.push(upcoming);
    }
  }

  const skippedMissingSpot = [];
  for (const selectedDailyAsset of selectedDailyAssets) {
    const spot = Number(prices[selectedDailyAsset]);
    // Never choose a ladder by lexical/strike order when the resolver feed is
    // unavailable. The next discovery cycle can populate it; guessing here
    // would bias moneyness and risks mixing 0-1 token prices with spot.
    if (!(spot > 1)) {
      skippedMissingSpot.push(selectedDailyAsset);
      continue;
    }
    const futureDaily = parsed.filter((record) => record.asset === selectedDailyAsset
      && record.window_end.getTime() > nowMs);
    for (const type of ['threshold_daily', 'range_daily']) {
      const candidates = futureDaily.filter((record) => record.market_type === type);
      if (!candidates.length) continue;
      const nearestEnd = Math.min(...candidates.map((record) => record.window_end.getTime()));
      const sameEvent = candidates.filter((record) => record.window_end.getTime() === nearestEnd);
      if (type === 'threshold_daily') {
        sameEvent
          .filter((record) => Number.isFinite(record.strike))
          .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot) || a.strike - b.strike)
          .slice(0, thresholdCount)
          .forEach((record) => selected.push(record));
      } else {
        sameEvent
          .sort((a, b) => rangeDistance(a, spot) - rangeDistance(b, spot) ||
            (a.lower_bound ?? -Infinity) - (b.lower_bound ?? -Infinity))
          .slice(0, rangeCount)
          .forEach((record) => selected.push(record));
      }
    }
  }

  return {
    selected: uniqueBySlug(selected),
    meta: {
      selectedDailyAsset: options.dailyAsset || null,
      selectedDailyAssets,
      hourlyAssets: [...hourlyAssets],
      dailyAssets: [...configuredDailyAssets],
      skippedMissingSpot,
      thresholdCount,
      rangeCount,
      universeVersion: 'daily-structural-universe-v2',
      selectionRule: 'current+next hourly; per asset: 5 nearest thresholds + 4 nearest ranges at nearest future expiry; fresh spot required',
    },
  };
}

module.exports = {
  DEFAULT_DAILY_ASSETS,
  DEFAULT_HOURLY_ASSETS,
  assetFromTitle,
  eventType,
  jsonArray,
  marketRecord,
  numericLabel,
  rangeLabel,
  resolutionSource,
  selectResearchMarkets,
};
