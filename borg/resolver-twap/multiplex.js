'use strict';

const { TwapRtds, economicAgeMs } = require('./rtds');

class TwapMultiplex {
  constructor(options = {}) {
    this.symbols = options.symbols || ['zec/usd'];
    this.windows = options.windows || [30, 60];
    this.pathCount = Math.max(2, Math.min(4, Number(options.pathCount || 2)));
    this.coverageMaxAgeMs = Math.max(2000, Number(options.coverageMaxAgeMs || 10_000));
    this.onTick = options.onTick || (() => {});
    this.wal = options.wal || null;
    this.coverageGaps = 0;
    this.lastCoverageGapAt = null;
    this.seen = new Map();
    this.paths = Array.from({ length: this.pathCount }, (_, transportPath) => new TwapRtds({
      ...options, symbols: this.symbols, windows: this.windows, transportPath,
      onTick: (tick) => this.handleTick(tick),
      onGap: (event) => this.handlePathGap(transportPath, event),
    }));
  }

  handleTick(tick) {
    const key = `${tick.symbol}:${tick.windowSeconds}:${tick.sourceMs}:${tick.exactValue}`;
    if (this.seen.has(key)) return;
    this.seen.set(key, Date.now());
    if (this.seen.size > 20_000) {
      const cutoff = Date.now() - 60_000;
      for (const [candidate, seenAt] of this.seen) if (seenAt < cutoff) this.seen.delete(candidate);
    }
    this.onTick(tick);
  }

  freshTick(symbol, windowSeconds, excludedPath = null, now = Date.now()) {
    return this.paths.filter((path) => path.transportPath !== excludedPath)
      .map((path) => path.latest.get(`${symbol}:${windowSeconds}`))
      .filter((tick) => economicAgeMs(tick, now) <= this.coverageMaxAgeMs)
      .sort((left, right) => right.sourceMs - left.sourceMs)[0] || null;
  }

  handlePathGap(transportPath, event) {
    const uncovered = [];
    for (const symbol of this.symbols) for (const windowSeconds of this.windows) {
      if (!this.freshTick(symbol, windowSeconds, transportPath)) {
        uncovered.push(`${symbol}:${windowSeconds}`);
      }
    }
    if (!uncovered.length) return;
    this.coverageGaps += 1; this.lastCoverageGapAt = new Date().toISOString();
    this.wal?.append(JSON.stringify({
      type: 'twap_redundant_coverage_gap', observedAt: this.lastCoverageGapAt,
      transportPath, uncovered, pathEvent: event,
    }), { channel: 'control', connectionShard: transportPath });
  }

  async connect() {
    const results = await Promise.all(this.paths.map(async (path, index) => {
      if (index) await new Promise((resolve) => setTimeout(resolve, index * 250));
      return path.connect();
    }));
    return results.some(Boolean);
  }

  checkStale(maxAgeMs = this.coverageMaxAgeMs) {
    this.paths.forEach((path) => path.checkStale(maxAgeMs));
    return this.symbols.some((symbol) => this.windows.some((windowSeconds) =>
      !this.freshTick(symbol, windowSeconds)));
  }

  health(now = Date.now()) {
    const paths = this.paths.map((path) => path.health(now));
    const coverage = {};
    for (const symbol of this.symbols) for (const windowSeconds of this.windows) {
      const key = `${symbol}:${windowSeconds}`;
      const freshPaths = this.paths.filter((path) =>
        economicAgeMs(path.latest.get(key), now) <= this.coverageMaxAgeMs).length;
      const tick = this.freshTick(symbol, windowSeconds, null, now);
      coverage[key] = { freshPaths, expectedPaths: this.pathCount,
        freshestAgeMs: tick ? economicAgeMs(tick, now) : null };
    }
    return {
      expectedSockets: this.pathCount,
      activeSockets: paths.filter((path) => path.connected).length,
      coverageGaps: this.coverageGaps,
      lastCoverageGapAt: this.lastCoverageGapAt,
      coverage, paths,
    };
  }

  close() { this.paths.forEach((path) => path.close()); }
}

module.exports = TwapMultiplex;
