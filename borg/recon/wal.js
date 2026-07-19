/**
 * Append-before-process raw event WAL.
 *
 * Every market-data adapter writes the received frame here before parsing or
 * mutating in-memory state. Writes are synchronous; fdatasync is group-committed
 * on a short interval to avoid one disk flush per high-frequency Binance trade.
 * Rotated segments are gzip-compressed, checksum-verified and optionally copied
 * to BORG_WAL_MIRROR_DIR (a mounted/off-host directory).
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const fsp = fs.promises;

function safeStamp(ms = Date.now()) {
  return new Date(ms).toISOString().replace(/[:.]/g, '-');
}

async function atomicWrite(file, bytes) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const handle = await fsp.open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, file);
}

class RawWal {
  constructor(source, options = {}) {
    if (!/^[a-z0-9_-]+$/i.test(source)) throw new Error(`invalid WAL source: ${source}`);
    this.source = source;
    this.root = options.root || process.env.BORG_WAL_DIR || path.join(os.homedir(), '.deltaforge-wal', 'borg');
    this.mirrorRoot = options.mirrorRoot ?? process.env.BORG_WAL_MIRROR_DIR ?? null;
    this.rotateBytes = options.rotateBytes ?? Number(process.env.BORG_WAL_ROTATE_MB || 64) * 1024 ** 2;
    this.rotateMs = options.rotateMs ?? Number(process.env.BORG_WAL_ROTATE_MIN || 15) * 60 * 1000;
    this.syncEveryMs = options.syncEveryMs ?? Number(process.env.BORG_WAL_SYNC_MS || 250);
    this.minFreeBytes = (options.minFreeGb ?? Number(process.env.BORG_WAL_MIN_FREE_GB || 10)) * 1024 ** 3;
    this.host = os.hostname();
    this.collectionEpochId = options.collectionEpochId
      ?? process.env.BORG_COLLECTION_EPOCH_ID
      ?? 'legacy-unmarked';
    this.collectorRunId = options.collectorRunId
      ?? process.env.BORG_COLLECTOR_RUN_ID
      ?? null;
    this.seq = 0;
    this.segmentSeq = 0;
    this.fd = null;
    this.file = null;
    this.bytes = 0;
    this.openedAt = 0;
    this.lastSyncAt = 0;
    this.lastDiskCheckAt = 0;
    this._compressChain = Promise.resolve();
    this.metrics = {
      records: 0,
      bytes: 0,
      segments: 0,
      lastAppendAt: 0,
      lastSyncAt: 0,
      mirroredSegments: 0,
      lastMirrorAt: 0,
    };
    this._recoverOpenSegments();
    this._openSegment();
  }

  _sourceDir(ms = Date.now()) {
    return path.join(this.root, this.source, new Date(ms).toISOString().slice(0, 10));
  }

  _recoverOpenSegments() {
    const sourceRoot = path.join(this.root, this.source);
    if (!fs.existsSync(sourceRoot)) return;
    for (const day of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
      if (!day.isDirectory()) continue;
      const dir = path.join(sourceRoot, day.name);
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.open')) continue;
        const file = path.join(dir, name);
        const recovered = file.replace(/\.open$/, '.recovered.ndjson');
        try {
          fs.renameSync(file, recovered);
          this._queueCompression(recovered);
        } catch (_) { /* another process may own/recover it */ }
      }
    }
  }

  _checkDisk() {
    const now = Date.now();
    if (now - this.lastDiskCheckAt < 10000) return;
    this.lastDiskCheckAt = now;
    const stat = fs.statfsSync(this.root);
    const free = Number(stat.bavail) * Number(stat.bsize);
    if (free < this.minFreeBytes) {
      throw new Error(
        `WAL disk reserve breached: ${(free / 1024 ** 3).toFixed(1)} GiB free, ` +
        `${(this.minFreeBytes / 1024 ** 3).toFixed(1)} GiB required`,
      );
    }
  }

  _openSegment() {
    const now = Date.now();
    const dir = this._sourceDir(now);
    fs.mkdirSync(dir, { recursive: true });
    this.segmentSeq += 1;
    this.file = path.join(
      dir,
      `${safeStamp(now)}__${this.host.replace(/[^a-z0-9_.-]/gi, '_')}__${process.pid}__${this.segmentSeq}.open`,
    );
    this.fd = fs.openSync(this.file, 'ax', 0o600);
    this.bytes = 0;
    this.openedAt = now;
    this.lastSyncAt = now;
    const header = `${JSON.stringify({
      _borg_wal: {
        format: 'borg-event-wal-v2', source: this.source, host: this.host,
        pid: process.pid, opened_at: new Date(now).toISOString(), schema_version: 2,
        collection_epoch_id: this.collectionEpochId,
        collector_run_id: this.collectorRunId,
      },
    })}\n`;
    fs.writeSync(this.fd, header);
    this.bytes += Buffer.byteLength(header);
  }

  _rotateIfNeeded(nextBytes) {
    if (this.bytes + nextBytes < this.rotateBytes && Date.now() - this.openedAt < this.rotateMs) return;
    this._sealSegment();
    this._openSegment();
  }

  _sealSegment() {
    if (this.fd == null) return null;
    fs.fdatasyncSync(this.fd);
    fs.closeSync(this.fd);
    const sealed = this.file.replace(/\.open$/, '.ndjson');
    fs.renameSync(this.file, sealed);
    this.fd = null;
    this.file = null;
    this.metrics.segments += 1;
    this.metrics.lastSyncAt = Date.now();
    this._queueCompression(sealed);
    return sealed;
  }

  _queueCompression(file) {
    this._compressChain = this._compressChain
      .then(() => this._compressAndMirror(file))
      .catch((err) => {
        // Preserve the uncompressed segment on any compression/mirror error.
        console.warn(`[wal:${this.source}] segment preservation warning: ${err.message}`);
      });
  }

  async _compressAndMirror(file) {
    const plain = await fsp.readFile(file);
    const sha256 = crypto.createHash('sha256').update(plain).digest('hex');
    const packed = await gzip(plain, { level: 6 });
    const gzipFile = `${file}.gz`;
    await atomicWrite(gzipFile, packed);
    const check = await gunzip(await fsp.readFile(gzipFile));
    const verified = crypto.createHash('sha256').update(check).digest('hex');
    if (verified !== sha256) throw new Error(`gzip checksum mismatch for ${file}`);
    if (this.mirrorRoot) {
      const relative = path.relative(this.root, gzipFile);
      await atomicWrite(path.join(this.mirrorRoot, relative), packed);
      this.metrics.mirroredSegments += 1;
      this.metrics.lastMirrorAt = Date.now();
    }
    await fsp.unlink(file);
  }

  /**
   * Small, JSON-safe durability attestation for the collector heartbeat.
   * The acceptance checker may run on a different host, so it must not infer
   * remote WAL health from its own filesystem.
   */
  health(now = Date.now()) {
    let freeGb = null;
    try {
      const stat = fs.statfsSync(this.root);
      freeGb = Number(stat.bavail) * Number(stat.bsize) / 1024 ** 3;
    } catch (_) { /* reported as null; acceptance decides severity */ }
    return {
      source: this.source,
      host: this.host,
      collectionEpochId: this.collectionEpochId,
      collectorRunId: this.collectorRunId,
      checkedAt: new Date(now).toISOString(),
      activeFile: this.file,
      records: this.metrics.records,
      bytes: this.metrics.bytes,
      sealedSegments: this.metrics.segments,
      lastAppendAt: this.metrics.lastAppendAt
        ? new Date(this.metrics.lastAppendAt).toISOString() : null,
      lastSyncAt: this.metrics.lastSyncAt
        ? new Date(this.metrics.lastSyncAt).toISOString() : null,
      freeGb: Number.isFinite(freeGb) ? +freeGb.toFixed(2) : null,
      requiredReserveGb: +(this.minFreeBytes / 1024 ** 3).toFixed(2),
      mirrorConfigured: !!this.mirrorRoot,
      mirroredSegments: this.metrics.mirroredSegments,
      lastMirrorAt: this.metrics.lastMirrorAt
        ? new Date(this.metrics.lastMirrorAt).toISOString() : null,
    };
  }

  /** Append raw text/Buffer before the caller parses it. Returns provenance. */
  append(raw, meta = {}) {
    if (this.fd == null) throw new Error(`WAL ${this.source} is closed`);
    this._checkDisk();
    const receiveWallMs = meta.receiveWallMs || Date.now();
    const receiveMonoNs = meta.receiveMonoNs || process.hrtime.bigint().toString();
    this.seq += 1;
    const envelope = {
      event_id: `${this.host}:${process.pid}:${this.source}:${meta.connectionEpoch || 0}:${this.seq}`,
      schema_version: 2,
      collection_epoch_id: meta.collectionEpochId || this.collectionEpochId,
      collector_run_id: meta.collectorRunId || this.collectorRunId,
      source: this.source,
      channel: meta.channel || null,
      source_timestamp_ms: Number.isFinite(Number(meta.sourceMs)) ? Number(meta.sourceMs) : null,
      receive_wall_timestamp_ms: receiveWallMs,
      receive_monotonic_ns: String(receiveMonoNs),
      connection_epoch: meta.connectionEpoch || 0,
      connection_shard: Number.isInteger(meta.connectionShard) ? meta.connectionShard : null,
      event_sequence: this.seq,
      raw: Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw),
    };
    const line = `${JSON.stringify(envelope)}\n`;
    const size = Buffer.byteLength(line);
    this._rotateIfNeeded(size);
    fs.writeSync(this.fd, line);
    this.bytes += size;
    this.metrics.records += 1;
    this.metrics.bytes += size;
    this.metrics.lastAppendAt = receiveWallMs;
    if (receiveWallMs - this.lastSyncAt >= this.syncEveryMs) {
      fs.fdatasyncSync(this.fd);
      this.lastSyncAt = receiveWallMs;
      this.metrics.lastSyncAt = receiveWallMs;
    }
    return envelope;
  }

  async close() {
    if (this.fd == null) {
      await this._compressChain;
      return;
    }
    this._sealSegment();
    await this._compressChain;
  }
}

module.exports = RawWal;
