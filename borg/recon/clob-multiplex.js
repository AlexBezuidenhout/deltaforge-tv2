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
    const configured = Number(options.shardCount ?? process.env.BORG_CLOB_SHARDS ?? 2);
    this.shardCount = Math.max(1, Math.min(16, Math.trunc(configured) || 2));
    this._marketShard = new Map();
    this._nextShard = 0;
    this._validationShard = 0;
    this.shards = Array.from({ length: this.shardCount }, (_, connectionShard) =>
      new ClobRecon(resolveMarketId, { ...options, connectionShard }));
  }

  _shardIndex(assetId) {
    const marketId = this.resolveMarketId(assetId);
    if (marketId != null) {
      const key = String(marketId);
      if (!this._marketShard.has(key)) {
        this._marketShard.set(key, this._nextShard % this.shardCount);
        this._nextShard += 1;
      }
      return this._marketShard.get(key);
    }
    return stableHash(assetId) % this.shardCount;
  }

  _shardFor(assetId) {
    return this.shards[this._shardIndex(assetId)];
  }

  get lastWsMsgAt() {
    const active = this.shards.filter((shard) => shard.subscribed.size > 0);
    if (!active.length || active.some((shard) => shard.lastWsMsgAt <= 0)) return 0;
    return Math.min(...active.map((shard) => shard.lastWsMsgAt));
  }

  async connect() {
    const results = await Promise.all(this.shards.map((shard) => shard.connect()));
    return results.every(Boolean);
  }

  subscribe(assetIds) {
    const groups = Array.from({ length: this.shardCount }, () => []);
    for (const assetId of new Set(assetIds.filter(Boolean))) {
      groups[this._shardIndex(assetId)].push(assetId);
    }
    for (let index = 0; index < this.shardCount; index += 1) {
      this.shards[index].subscribe(groups[index]);
    }
  }

  getBook(assetId) {
    return this._shardFor(assetId).getBook(assetId);
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
    const shards = this.shards.map((shard) => shard.health(now));
    return {
      expectedSockets: shards.length,
      activeSockets: shards.filter((shard) => shard.connected).length,
      connectionGaps: shards.reduce((sum, shard) => sum + shard.connectionGaps, 0),
      bookStateGaps: shards.reduce((sum, shard) => sum + shard.bookStateGaps, 0),
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
