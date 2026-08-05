#!/usr/bin/env node
'use strict';

/**
 * Discovery-grade historical falsification for the XTracker count barrier.
 *
 * Public one-minute price history is a midpoint/mark series and contains no
 * contemporaneous depth. Results therefore cannot be promoted as executable
 * PnL. The forward collector is the authoritative L2 paper experiment.
 */

const fs = require('node:fs');
const path = require('node:path');

const { feePerShare } = require('../borg/allmarket/strategy');
const { normalizeMarket } = require('../borg/allmarket/universe');
const {
  GAMMA_BASE,
  XTRACKER_BASE,
  certifyTrackingEvent,
  eventSlugFromMarketLink,
  parseCountRange,
  payloadData,
  trackingWindow,
} = require('../borg/publicinfo/xtracker');

const CLOB_BASE = 'https://clob.polymarket.com';

function option(name, fallback) {
  const prefix = `--${name}=`;
  const item = process.argv.find((value) => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : fallback;
}

async function getJson(url, fetchImpl = global.fetch) {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json', 'user-agent': 'DeltaForge-Historical-Research/1.0' },
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return payloadData(await response.json());
}

async function concurrentMap(items, width, fn) {
  const output = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try { output[index] = await fn(items[index], index); } catch (error) {
        output[index] = { error: error.message, input: items[index] };
      }
    }
  }));
  return output;
}

function percentile(values, probability) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(probability * sorted.length))];
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function postAtBoundary(posts, bounds) {
  const index = bounds.upper == null ? bounds.lower - 1 : bounds.upper;
  return index >= 0 && index < posts.length ? posts[index] : null;
}

function terminalOutcome(bounds, finalCount) {
  return finalCount >= bounds.lower && (bounds.upper == null || finalCount <= bounds.upper)
    ? 'Yes' : 'No';
}

function firstArrival(history, availableAtMs) {
  return (Array.isArray(history) ? history : [])
    .map((point) => ({ at: Number(point.t) * 1000, price: parseFloat(point.p) }))
    .filter((point) => Number.isFinite(point.at) && Number.isFinite(point.price)
      && point.price > 0 && point.price < 1 && point.at >= availableAtMs)
    .sort((left, right) => left.at - right.at)[0] || null;
}

async function priceWindow(assetId, atMs, fetchImpl = global.fetch) {
  const url = new URL(`${CLOB_BASE}/prices-history`);
  url.searchParams.set('market', assetId);
  url.searchParams.set('startTs', String(Math.floor((atMs - 120_000) / 1000)));
  url.searchParams.set('endTs', String(Math.ceil((atMs + 15 * 60_000) / 1000)));
  url.searchParams.set('fidelity', '1');
  const payload = await getJson(url, fetchImpl);
  return payload?.history || [];
}

async function loadHistoricalInputs(options = {}) {
  const handle = options.handle || 'realDonaldTrump';
  const platform = options.platform || 'TRUTH_SOCIAL';
  const user = await getJson(`${XTRACKER_BASE}/users/${encodeURIComponent(handle)}?platform=${platform}`, options.fetchImpl);
  const maxTrackings = Math.max(1, Number(options.maxTrackings || 100));
  const now = Date.now();
  const trackings = (Array.isArray(user?.trackings) ? user.trackings : [])
    .filter((tracking) => tracking.marketLink && trackingWindow(tracking)
      && Date.parse(tracking.endDate) < now)
    .sort((left, right) => Date.parse(right.endDate) - Date.parse(left.endDate))
    .slice(0, maxTrackings)
    .sort((left, right) => Date.parse(left.startDate) - Date.parse(right.startDate));
  if (!trackings.length) return { user, trackings, posts: [] };
  const start = Math.min(...trackings.map((tracking) => Date.parse(tracking.startDate)));
  const end = Math.max(...trackings.map((tracking) => Date.parse(tracking.endDate)));
  const postUrl = new URL(`${XTRACKER_BASE}/users/${encodeURIComponent(handle)}/posts`);
  postUrl.searchParams.set('platform', platform);
  postUrl.searchParams.set('startDate', new Date(start).toISOString());
  postUrl.searchParams.set('endDate', new Date(end).toISOString());
  const posts = await getJson(postUrl, options.fetchImpl);
  return { user, trackings, posts: Array.isArray(posts) ? posts : [] };
}

async function buildEpisodes(inputs, options = {}) {
  const latencyProfilesMs = options.latencyProfilesMs || [100, 250, 500];
  const sourceRiskReserve = Number(options.sourceRiskReserve ?? 0.01);
  const targetUsd = Number(options.targetUsd || 10);
  const eventRows = await concurrentMap(inputs.trackings, Number(options.concurrency || 8), async (tracking) => {
    const eventSlug = eventSlugFromMarketLink(tracking.marketLink);
    const event = await getJson(`${GAMMA_BASE}/events/slug/${encodeURIComponent(eventSlug)}`, options.fetchImpl);
    const certificate = certifyTrackingEvent(tracking, event);
    const window = trackingWindow(tracking);
    const posts = inputs.posts.filter((post) => {
      const at = Date.parse(post.createdAt);
      return at >= window.startsAt && at <= window.endsAt;
    }).sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    return { tracking, event, certificate, posts, finalCount: posts.length };
  });

  const candidates = [];
  for (const row of eventRows.filter((item) => item && !item.error)) {
    if (!row.certificate.certified) continue;
    for (const rawMarket of Array.isArray(row.event?.markets) ? row.event.markets : []) {
      const bounds = parseCountRange(rawMarket);
      const market = normalizeMarket(rawMarket);
      if (!bounds || !market) continue;
      const trigger = postAtBoundary(row.posts, bounds);
      if (!trigger) continue;
      const guaranteedOutcome = bounds.upper == null ? 'Yes' : 'No';
      if (terminalOutcome(bounds, row.finalCount) !== guaranteedOutcome) continue;
      const tokenIndex = market.outcomes.findIndex((outcome) =>
        String(outcome).toLowerCase() === guaranteedOutcome.toLowerCase());
      if (tokenIndex < 0) continue;
      const importedAtMs = Date.parse(trigger.importedAt);
      if (!Number.isFinite(importedAtMs)) continue;
      candidates.push({
        tracking: row.tracking,
        certificate: row.certificate,
        finalCount: row.finalCount,
        bounds,
        market,
        guaranteedOutcome,
        assetId: String(market.tokenIds[tokenIndex]),
        trigger,
        importedAtMs,
      });
    }
  }

  const histories = await concurrentMap(candidates, Number(options.concurrency || 8), async (candidate) => ({
    candidate,
    history: await priceWindow(candidate.assetId, candidate.importedAtMs, options.fetchImpl),
  }));
  const episodes = [];
  for (const item of histories.filter((row) => row && !row.error)) {
    for (const latencyMs of latencyProfilesMs) {
      const arrival = firstArrival(item.history, item.candidate.importedAtMs + latencyMs);
      if (!arrival) continue;
      const { candidate } = item;
      const feeRate = candidate.market.feesEnabled ? candidate.market.feeRate : 0;
      const feeExponent = candidate.market.feeExponent;
      const entryFee = feePerShare(arrival.price, feeRate, feeExponent) || 0;
      const fee2x = 2 * entryFee;
      const tick = candidate.market.tickSize || 0.01;
      const shares = Math.max(candidate.market.orderMinSize || 5, targetUsd / arrival.price);
      const nominalPnl = shares * (1 - arrival.price - entryFee);
      const stressedPnl = shares * (1 - arrival.price - fee2x - tick - sourceRiskReserve);
      episodes.push({
        trackingId: candidate.tracking.id,
        trackingTitle: candidate.tracking.title,
        trackingStart: candidate.tracking.startDate,
        trackingEnd: candidate.tracking.endDate,
        eventSlug: eventSlugFromMarketLink(candidate.tracking.marketLink),
        conditionId: candidate.market.conditionId,
        groupLabel: candidate.bounds.label,
        guaranteedOutcome: candidate.guaranteedOutcome,
        finalCount: candidate.finalCount,
        sourceCreatedAt: candidate.trigger.createdAt,
        xtrackerImportedAt: candidate.trigger.importedAt,
        trackerLagMs: Date.parse(candidate.trigger.importedAt) - Date.parse(candidate.trigger.createdAt),
        latencyMs,
        historicalPointAt: new Date(arrival.at).toISOString(),
        historicalPrice: arrival.price,
        priceProxy: 'public_1m_price_history_no_depth',
        shares,
        tickStressPerShare: tick,
        fee2xPerShare: fee2x,
        sourceRiskReservePerShare: sourceRiskReserve,
        nominalPnlUsd: nominalPnl,
        stressedPnlUsd: stressedPnl,
        positiveAfterStress: stressedPnl > 0,
        ruleHash: candidate.certificate.ruleHash,
      });
    }
  }
  return { eventRows, candidates, episodes };
}

function summarize(inputs, built, settings) {
  const byLatency = settings.latencyProfilesMs.map((latencyMs) => {
    const rows = built.episodes.filter((row) => row.latencyMs === latencyMs);
    return {
      latencyMs,
      episodes: rows.length,
      trackingWindows: new Set(rows.map((row) => row.trackingId)).size,
      positiveEpisodes: rows.filter((row) => row.positiveAfterStress).length,
      positiveNominalPnlUsd: rows.filter((row) => row.positiveAfterStress)
        .reduce((sum, row) => sum + row.nominalPnlUsd, 0),
      positiveStressedPnlUsd: rows.filter((row) => row.positiveAfterStress)
        .reduce((sum, row) => sum + row.stressedPnlUsd, 0),
      sumNominalResidualAllEpisodesUsd: rows.reduce((sum, row) => sum + row.nominalPnlUsd, 0),
      sumStressedResidualAllEpisodesUsd: rows.reduce((sum, row) => sum + row.stressedPnlUsd, 0),
      meanStressedPnlUsd: average(rows.map((row) => row.stressedPnlUsd)),
    };
  });
  const trackerLags = built.episodes
    .filter((row) => row.latencyMs === settings.latencyProfilesMs[0])
    .map((row) => row.trackerLagMs).filter(Number.isFinite);
  return {
    generatedAt: new Date().toISOString(),
    evidenceGrade: 'DISCOVERY_C_NO_EXECUTABLE_DEPTH',
    source: 'Polymarket XTracker public API plus Polymarket public one-minute price history',
    completedTrackingWindowsFetched: inputs.trackings.length,
    certifiedTrackingWindows: built.eventRows.filter((row) => row?.certificate?.certified).length,
    totalPostsFetched: inputs.posts.length,
    barrierCandidates: built.candidates.length,
    settings,
    trackerLagMs: {
      count: trackerLags.length,
      p50: percentile(trackerLags, 0.50),
      p95: percentile(trackerLags, 0.95),
      max: trackerLags.length ? Math.max(...trackerLags) : null,
    },
    byLatency,
    hardLimitations: [
      'Historical price points are not executable asks.',
      'Historical depth, queue, partial-fill and non-fill state are absent.',
      'Tracking windows overlap, so range episodes are not independent observations.',
      'This mechanism was selected before this PnL run, but every historical row remains discovery-only.',
      'Only the fresh forward L2 collector can create promotion evidence.',
    ],
  };
}

function money(value) {
  return value == null ? '—' : `${value < 0 ? '-' : ''}$${Math.abs(value).toFixed(2)}`;
}

function renderMarkdown(report) {
  const rows = report.byLatency.map((row) => `| ${row.latencyMs} ms | ${row.episodes} | ${row.trackingWindows} | ${row.positiveEpisodes} | ${money(row.positiveStressedPnlUsd)} | ${money(row.sumStressedResidualAllEpisodesUsd)} |`).join('\n');
  return `# XTracker resolver-count barrier — historical falsification\n\nGenerated: ${report.generatedAt}. Evidence grade: **${report.evidenceGrade}**.\n\nThis is a discovery screen, not a live-PnL claim. It aligns XTracker's historical import timestamp with Polymarket's public one-minute token price series. That price series has no contemporaneous executable ask or depth.\n\n## Coverage\n\n- Completed tracking windows fetched: ${report.completedTrackingWindowsFetched}\n- Rule-certified tracking windows: ${report.certifiedTrackingWindows}\n- Historical posts fetched: ${report.totalPostsFetched}\n- Irreversible boundary/token candidates: ${report.barrierCandidates}\n- XTracker import lag: p50 ${report.trackerLagMs.p50 == null ? '—' : (report.trackerLagMs.p50 / 1000).toFixed(1)}s; p95 ${report.trackerLagMs.p95 == null ? '—' : (report.trackerLagMs.p95 / 1000).toFixed(1)}s\n\n## Discovery PnL proxy\n\n| Simulated information latency | Episodes with a price point | Tracking windows | Positive after stress | Sum of positive stressed opportunities | Sum of residuals across all observations (diagnostic) |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${rows}\n\nThe strategy would skip non-positive observations; the final column is therefore a market-efficiency diagnostic, not traded PnL. The stressed proxy includes doubled fees, one tick and a ${(report.settings.sourceRiskReserve * 100).toFixed(1)}¢ per-share resolver/fallback reserve. It still omits historical spread and depth, so even the positive-opportunity sum only justifies fresh L2 paper collection.\n\n## Hard limitations\n\n${report.hardLimitations.map((item) => `- ${item}`).join('\n')}\n`;
}

async function run(options = {}) {
  const settings = {
    maxTrackings: Number(options.maxTrackings || option('max-trackings', 100)),
    concurrency: Number(options.concurrency || option('concurrency', 8)),
    latencyProfilesMs: options.latencyProfilesMs || String(option('latencies', '100,250,500'))
      .split(',').map(Number).filter(Number.isFinite),
    sourceRiskReserve: Number(options.sourceRiskReserve ?? option('source-reserve', 0.01)),
    targetUsd: Number(options.targetUsd || option('target-usd', 10)),
  };
  const inputs = await loadHistoricalInputs({ ...settings, fetchImpl: options.fetchImpl });
  const built = await buildEpisodes(inputs, { ...settings, fetchImpl: options.fetchImpl });
  return { report: summarize(inputs, built, settings), episodes: built.episodes };
}

async function main() {
  const outDir = path.resolve(option('out-dir', path.join(__dirname, '..')));
  const { report, episodes } = await run();
  fs.mkdirSync(outDir, { recursive: true });
  const jsonFile = path.join(outDir, 'XTRACKER_RESOLVER_BACKTEST.json');
  const markdownFile = path.join(outDir, 'XTRACKER_RESOLVER_BACKTEST.md');
  fs.writeFileSync(jsonFile, `${JSON.stringify({ report, episodes }, null, 2)}\n`);
  fs.writeFileSync(markdownFile, renderMarkdown(report));
  console.log(JSON.stringify({ ...report, jsonFile, markdownFile }, null, 2));
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

module.exports = {
  buildEpisodes,
  firstArrival,
  loadHistoricalInputs,
  postAtBoundary,
  renderMarkdown,
  run,
  summarize,
  terminalOutcome,
};
