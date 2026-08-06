/**
 * Redundant Polymarket RTDS adapter.
 *
 * Two independent WebSocket transports carry the same Chainlink/Binance RTDS
 * topics. Individual reconnects remain observable transport telemetry, while
 * the evidence-breaking counter advances only when every path loses fresh
 * Chainlink coverage for at least one configured asset. Both copies stay in
 * the raw WAL so the overlap is independently auditable.
 */
'use strict';

const RtdsRecon = require('./rtds');
const { DEFAULT_ASSETS, tickAgeMs } = require('./rtds');

class RtdsMultiplex {
  constructor(onGap, options = {}) {
    this.onGap = onGap || (() => {});
    this.wal = options.wal || null;
    this.onMarketEvent = options.onMarketEvent || (() => {});
    this.assets = [...new Set((options.assets || DEFAULT_ASSETS)
      .map((asset) => String(asset || '').toLowerCase().trim())
      .filter(Boolean))];
    this.pathCount = Math.max(2, Math.min(4, Math.trunc(Number(
      options.pathCount ?? process.env.BORG_RTDS_PATHS ?? 2,
    ) || 2)));
    this.coverageMaxAgeMs = Math.max(1000, Number(options.coverageMaxAgeMs || 10000));
    this.connectStaggerMs = Math.max(0, Number(options.connectStaggerMs ?? 250) || 0);
    this.coverageGaps = 0;
    this.lastCoverageGapAt = null;
    this.lastCoverageGapAssets = [];
    this._restoredRows = [];
    this._eventKeys = new Map();
    this.feeds = Array.from({ length: this.pathCount }, (_, transportPath) =>
      new RtdsRecon(this.onGap, {
        ...options,
        assets: this.assets,
        transportPath,
        onConnectionGap: (event) => this._onConnectionGap(transportPath, event),
        onMarketEvent: (event) => this._onMarketEvent(event),
      }));
  }

  async connect() {
    const results = await Promise.all(this.feeds.map(async (feed, index) => {
      if (index && this.connectStaggerMs) {
        await new Promise((resolve) => setTimeout(resolve, index * this.connectStaggerMs));
      }
      return feed.connect();
    }));
    return results.some(Boolean);
  }

  _onMarketEvent(event) {
    const key = [event.source, event.asset, event.sourceMs, event.value].join('|');
    const now = Date.now();
    if (this._eventKeys.has(key)) return;
    this._eventKeys.set(key, now);
    if (this._eventKeys.size > 20000) {
      const cutoff = now - 60_000;
      for (const [candidate, seenAt] of this._eventKeys) {
        if (seenAt < cutoff) this._eventKeys.delete(candidate);
      }
    }
    this.onMarketEvent(event);
  }

  _freshTick(asset, source = 'chainlink', maxAgeMs = this.coverageMaxAgeMs, excluded = null) {
    const now = Date.now();
    return this.feeds
      .filter((feed) => feed.transportPath !== excluded)
      .map((feed) => feed.latest.get(`${source}:${asset}`))
      .filter((tick) => tickAgeMs(tick, now) <= maxAgeMs)
      .sort((left, right) => right.receiveWallMs - left.receiveWallMs)[0] || null;
  }

  _onConnectionGap(transportPath, event = {}) {
    const uncovered = this.assets.filter((asset) =>
      !this._freshTick(asset, 'chainlink', this.coverageMaxAgeMs, transportPath));
    if (!uncovered.length) return;
    const at = new Date().toISOString();
    this.coverageGaps += 1;
    this.lastCoverageGapAt = at;
    this.lastCoverageGapAssets = uncovered;
    this.wal?.append(JSON.stringify({
      type: 'coverage_gap',
      source: 'polymarket_rtds_redundant_coverage',
      at,
      transportPath,
      assets: uncovered,
      detail: event.detail || null,
    }), { channel: 'control', connectionShard: transportPath });
  }

  getPrice(asset, maxAgeMs = 10000, source = 'chainlink') {
    return this._freshTick(asset, source, maxAgeMs)?.value ?? null;
  }

  getBinancePrice(asset, maxAgeMs = 10000) {
    return this.getPrice(asset, maxAgeMs, 'binance');
  }

  getAgeMs(asset, source = 'chainlink') {
    const tick = this._freshTick(asset, source, Number.MAX_SAFE_INTEGER);
    const age = tickAgeMs(tick);
    return Number.isFinite(age) ? age : null;
  }

  _history(asset, source = 'chainlink') {
    const rows = this.feeds.flatMap((feed) => feed.history.get(`${source}:${asset}`) || []);
    const unique = new Map(rows.map((row) => [`${row.at}|${row.value}`, row]));
    return [...unique.values()].sort((left, right) => left.at - right.at);
  }

  getPriceAtMs(asset, targetMs, toleranceMs = 3000, source = 'chainlink') {
    const target = Number(targetMs);
    const tolerance = Math.max(0, Number(toleranceMs) || 0);
    if (!Number.isFinite(target)) return null;
    let best = null;
    let distance = Infinity;
    for (const row of this._history(asset, source)) {
      const candidate = Math.abs(row.at - target);
      if (candidate <= tolerance && candidate < distance) {
        best = row;
        distance = candidate;
      }
    }
    return best?.value ?? null;
  }

  getMicro(asset, source = 'chainlink', lookbackSec = 10) {
    const rows = this._history(asset, source);
    const latest = rows.at(-1);
    if (!latest) return null;
    const target = latest.at - Math.max(2, lookbackSec) * 1000;
    const first = [...rows].reverse().find((row) => row.at <= target);
    if (!first || latest.at - first.at > (lookbackSec + 2) * 1000 || !(first.value > 0)) {
      return null;
    }
    return {
      lookbackSec,
      returnBps: 10000 * Math.log(latest.value / first.value),
      firstPrice: first.value,
      lastPrice: latest.value,
      firstAt: first.at,
      lastAt: latest.at,
    };
  }

  getDivergence(asset, venuePrice, maxAgeMs = 10000) {
    const tick = this._freshTick(asset, 'chainlink', maxAgeMs);
    const venue = Number(venuePrice);
    if (!tick || !(tick.value > 0) || !(venue > 0)) return null;
    return {
      chainlink: tick.value,
      venue,
      signed: venue - tick.value,
      absBps: Math.abs(venue - tick.value) / tick.value * 10000,
      chainlinkSourceMs: tick.sourceMs,
      chainlinkReceiveMs: tick.receiveWallMs,
      ageMs: tickAgeMs(tick),
    };
  }

  drainRows() {
    const rows = this._restoredRows.concat(this.feeds.flatMap((feed) => feed.drainRows()));
    this._restoredRows = [];
    return rows;
  }

  restoreRows(rows) {
    this._restoredRows = rows.concat(this._restoredRows);
    if (this._restoredRows.length > 200000) this._restoredRows.length = 200000;
  }

  checkStale(maxAgeMs = 15000) {
    for (const feed of this.feeds) feed.checkStale(maxAgeMs);
    return this.assets.some((asset) => !this._freshTick(asset, 'chainlink', maxAgeMs));
  }

  health(now = Date.now()) {
    const rawPaths = this.feeds.map((feed) => feed.health(now));
    const paths = rawPaths.map(({ connectionGaps, ...path }) => ({
      ...path,
      transportReconnects: connectionGaps,
    }));
    const assetCoverage = Object.fromEntries(this.assets.map((asset) => [asset, {
      freshPaths: this.feeds.filter((feed) => {
        const tick = feed.latest.get(`chainlink:${asset}`);
        return tickAgeMs(tick, now) <= this.coverageMaxAgeMs;
      }).length,
      freshestAgeMs: (() => {
        const ages = this.feeds.map((feed) =>
          tickAgeMs(feed.latest.get(`chainlink:${asset}`), now)).filter(Number.isFinite);
        return ages.length ? Math.min(...ages) : null;
      })(),
      paths: this.pathCount,
    }]));
    return {
      expectedSockets: this.pathCount,
      activeSockets: paths.filter((path) => path.connected).length,
      expectedAssets: this.assets.length,
      coveredAssets: Object.values(assetCoverage).filter((row) => row.freshPaths > 0).length,
      transportReconnects: rawPaths.reduce((sum, path) => sum + path.connectionGaps, 0),
      coverageGaps: this.coverageGaps,
      lastCoverageGapAt: this.lastCoverageGapAt,
      lastCoverageGapAssets: this.lastCoverageGapAssets,
      assetCoverage,
      paths,
    };
  }

  close() {
    for (const feed of this.feeds) feed.close();
  }
}

module.exports = RtdsMultiplex;
