/**
 * Sharded Polymarket market-channel adapter.
 *
 * A single BTC token pair produced ~640 frames/s in a controlled probe. Seven
 * simultaneous crypto markets on one TCP/WebSocket stream repeatedly ended in
 * abnormal 1006 closes despite healthy application PONGs. Keep each market's
 * complementary tokens together, but spread independent markets over a small
 * number of isolated sockets. A seven-socket deployment was rejected in a
 * synchronized burst by the venue/IP path; two concurrent sockets passed the
 * control constraint and remain the conservative default. The facade preserves
 * the ClobRecon API used by collector/shadow.
 */
'use strict';

const ClobRecon = require('./clob');

function stableHash(value) {
  let hash = 2166136261;
  for (const ch of String(value)) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

class ClobMultiplex {
  constructor(resolveMarketId, options = {}) {
    this.resolveMarketId = resolveMarketId;
    this.shardIndexForAsset = typeof options.shardIndexForAsset === 'function'
      ? options.shardIndexForAsset
      : null;
    this.shardIndexesForAsset = typeof options.shardIndexesForAsset === 'function'
      ? options.shardIndexesForAsset
      : null;
    this.describeAsset = typeof options.describeAsset === 'function'
      ? options.describeAsset
      : null;
    this.wal = options.wal || null;
    const configured = Number(options.shardCount ?? process.env.BORG_CLOB_SHARDS ?? 2);
    this.shardCount = Math.max(1, Math.min(16, Math.trunc(configured) || 2));
    this.redundantRouting = Boolean(this.shardIndexesForAsset);
    this.coverageMaxAgeMs = Math.max(250, Number(options.coverageMaxAgeMs || 3000));
    this.connectStaggerMs = Math.max(0, Number(
      options.connectStaggerMs ?? (this.redundantRouting ? 250 : 0),
    ) || 0);
    this.coverageGaps = 0;
    this.bookStateGaps = 0;
    this.lastCoverageGapAt = null;
    this.lastBookStateGapAt = null;
    this._marketShards = new Map();
    this._nextShard = 0;
    this._validationShard = 0;
    const callerAcceptDerived = typeof options.acceptDerivedAsset === 'function'
      ? options.acceptDerivedAsset : () => true;
    const callerConnectionGap = typeof options.onConnectionGap === 'function'
      ? options.onConnectionGap : () => {};
    const callerBookStateGap = typeof options.onBookStateGap === 'function'
      ? options.onBookStateGap : () => {};
    this.shards = Array.from({ length: this.shardCount }, (_, connectionShard) =>
      new ClobRecon(resolveMarketId, {
        ...options,
        connectionShard,
        acceptDerivedAsset: (assetId) =>
          this._shardIndex(assetId) === connectionShard && callerAcceptDerived(assetId),
        onConnectionGap: (event) => {
          this._onConnectionGap(connectionShard, event);
          callerConnectionGap(event);
        },
        onBookStateGap: (event) => {
          this._onBookStateGap(connectionShard, event);
          callerBookStateGap(event);
        },
      }));
  }

  _normalizeIndexes(values) {
    return [...new Set((Array.isArray(values) ? values : [values])
      .map((value) => Number(value))
      .filter(Number.isInteger)
      .map((value) => ((value % this.shardCount) + this.shardCount) % this.shardCount))];
  }

  _shardIndexes(assetId) {
    const marketId = this.resolveMarketId(assetId);
    const key = marketId != null ? String(marketId) : `token:${assetId}`;
    if (!this._marketShards.has(key)) {
      let requested = this._normalizeIndexes(
        this.shardIndexesForAsset?.(assetId, marketId),
      );
      if (!requested.length) {
        requested = this._normalizeIndexes(this.shardIndexForAsset?.(assetId, marketId));
      }
      if (!requested.length) {
        requested = [marketId != null
          ? this._nextShard % this.shardCount
          : stableHash(assetId) % this.shardCount];
        if (marketId != null) this._nextShard += 1;
      }
      this._marketShards.set(key, requested);
    }
    return this._marketShards.get(key);
  }

  _shardIndex(assetId) {
    return this._shardIndexes(assetId)[0];
  }

  _shardFor(assetId) {
    return this.shards[this._shardIndex(assetId)];
  }

  _freshAlternate(assetId, excludedShard, now = Date.now()) {
    return this._shardIndexes(assetId)
      .filter((index) => index !== excludedShard)
      .some((index) => {
        const book = this.shards[index].getBook(assetId);
        return book && now - book.at <= this.coverageMaxAgeMs;
      });
  }

  _recordAggregateGap(type, connectionShard, assetIds, detail = {}) {
    if (!assetIds.length) return false;
    const at = new Date().toISOString();
    if (type === 'book_state_gap') {
      this.bookStateGaps += 1;
      this.lastBookStateGapAt = at;
    } else {
      this.coverageGaps += 1;
      this.lastCoverageGapAt = at;
    }
    this.wal?.append(JSON.stringify({
      type,
      source: 'polymarket_clob_redundant_coverage',
      at,
      connectionShard,
      assetIds,
      detail,
    }), { channel: 'control', connectionShard });
    return true;
  }

  _onConnectionGap(connectionShard, event = {}) {
    if (!this.redundantRouting) return;
    const now = Date.now();
    const uncovered = (event.subscribedAssets || [])
      .filter((assetId) => !this._freshAlternate(assetId, connectionShard, now));
    this._recordAggregateGap('coverage_gap', connectionShard, uncovered, event.detail);
  }

  _onBookStateGap(connectionShard, event = {}) {
    if (!this.redundantRouting || !event.assetId) return;
    if (!this._freshAlternate(event.assetId, connectionShard)) {
      this._recordAggregateGap(
        'book_state_gap', connectionShard, [event.assetId], event.detail,
      );
    }
  }

  get lastWsMsgAt() {
    const assets = [...new Set(this.shards.flatMap((shard) => [...shard.subscribed]))];
    if (!assets.length) return 0;
    const coveredAt = assets.map((assetId) => Math.max(
      ...this._shardIndexes(assetId).map((index) => this.shards[index].lastWsMsgAt || 0),
    ));
    return coveredAt.some((value) => value <= 0) ? 0 : Math.min(...coveredAt);
  }

  async connect() {
    const results = await Promise.all(this.shards.map(async (shard, index) => {
      if (this.connectStaggerMs && index) {
        await new Promise((resolve) => setTimeout(resolve, index * this.connectStaggerMs));
      }
      return shard.connect();
    }));
    return results.every(Boolean);
  }

  subscribe(assetIds) {
    const groups = Array.from({ length: this.shardCount }, () => []);
    for (const assetId of new Set(assetIds.filter(Boolean))) {
      for (const index of this._shardIndexes(assetId)) groups[index].push(assetId);
    }
    for (let index = 0; index < this.shardCount; index += 1) {
      this.shards[index].subscribe(groups[index]);
    }
  }

  getBook(assetId) {
    return this._shardIndexes(assetId)
      .map((index) => this.shards[index].getBook(assetId))
      .filter(Boolean)
      .sort((left, right) => right.at - left.at)[0] || null;
  }

  pollBook(assetId, options) {
    return this._shardFor(assetId).pollBook(assetId, options);
  }

  validateNextBook() {
    const shard = this.shards[this._validationShard % this.shardCount];
    this._validationShard = (this._validationShard + 1) % this.shardCount;
    return shard.validateNextBook();
  }

  checkStale() {
    for (const shard of this.shards) shard.checkStale();
  }

  health(now = Date.now()) {
    const rawShards = this.shards.map((shard) => shard.health(now));
    const shards = rawShards.map((health, index) => {
      const decorated = this.describeAsset ? {
        ...health,
        subscriptionGroups: [...new Set([...this.shards[index].subscribed]
          .map((assetId) => this.describeAsset(assetId))
          .filter(Boolean))].sort(),
      } : health;
      if (!this.redundantRouting) return decorated;
      const { connectionGaps, bookStateGaps, ...rest } = decorated;
      return {
        ...rest,
        transportReconnects: connectionGaps,
        transportBookRepairs: bookStateGaps,
      };
    });
    if (!this.redundantRouting) {
      return {
        expectedSockets: shards.length,
        activeSockets: shards.filter((shard) => shard.connected).length,
        connectionGaps: rawShards.reduce((sum, shard) => sum + shard.connectionGaps, 0),
        bookStateGaps: rawShards.reduce((sum, shard) => sum + shard.bookStateGaps, 0),
        routingMode: this.shardIndexForAsset ? 'explicit' : 'balanced-market',
        shards,
      };
    }
    const assets = [...new Set(this.shards.flatMap((shard) => [...shard.subscribed]))];
    const assetCoverage = Object.fromEntries(assets.map((assetId) => {
      const routes = this._shardIndexes(assetId);
      const freshRoutes = routes.filter((index) => {
        const book = this.shards[index].getBook(assetId);
        return book && now - book.at <= this.coverageMaxAgeMs;
      });
      return [assetId, { routes: routes.length, freshRoutes: freshRoutes.length }];
    }));
    return {
      expectedSockets: shards.length,
      activeSockets: shards.filter((shard) => shard.connected).length,
      expectedAssets: assets.length,
      coveredAssets: Object.values(assetCoverage)
        .filter((row) => row.freshRoutes > 0).length,
      transportReconnects: rawShards.reduce((sum, shard) => sum + shard.connectionGaps, 0),
      transportBookRepairs: rawShards.reduce((sum, shard) => sum + shard.bookStateGaps, 0),
      coverageGaps: this.coverageGaps,
      bookStateGaps: this.bookStateGaps,
      lastCoverageGapAt: this.lastCoverageGapAt,
      lastBookStateGapAt: this.lastBookStateGapAt,
      routingMode: 'redundant-explicit',
      assetCoverage,
      shards,
    };
  }

  // Taker polling is REST-based. Run it once, then scan all shard-local print
  // tapes because returned token IDs need not hash like a condition ID.
  pollTakerTrades(conditionId) {
    return this.shards[0].pollTakerTrades(conditionId);
  }

  printsSince(assetId, sinceMs) {
    return this.shards
      .flatMap((shard) => shard.printsSince(assetId, sinceMs))
      .sort((a, b) => a[0] - b[0]);
  }

  async flushEvents() {
    const counts = await Promise.all(this.shards.map((shard) => shard.flushEvents()));
    return counts.reduce((sum, count) => sum + count, 0);
  }

  close() {
    for (const shard of this.shards) shard.close();
  }
}

module.exports = ClobMultiplex;
module.exports.stableHash = stableHash;
