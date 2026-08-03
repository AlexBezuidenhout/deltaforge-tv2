'use strict';

const crypto = require('node:crypto');

const HERMES_URL = 'https://hermes.pyth.network';
const FEED_CATALOG_PATH = '/v2/price_feeds';
const STREAM_PATH = '/v2/updates/price/stream';
const DEFAULT_STALE_MS = 20_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

function finite(value, fallback = null) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeFeedId(value) {
  const id = String(value || '').trim().toLowerCase().replace(/^0x/, '');
  return /^[a-f0-9]{64}$/.test(id) ? id : null;
}

function pythValue(price) {
  const mantissa = finite(price?.price);
  const exponent = finite(price?.expo);
  if (mantissa == null || exponent == null) return null;
  const value = mantissa * (10 ** exponent);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function extractExactPythFeedSymbol(source) {
  const text = String(source || '');
  const match = text.match(/https?:\/\/pythdata\.app\/explore\/([^\s?#"')]+)/i);
  if (!match) return null;
  let decoded;
  try { decoded = decodeURIComponent(match[1]); } catch (_) { return null; }
  const symbol = decoded.replace(/[.,;:]+$/, '');
  return /^[A-Za-z0-9_.-]+(?:\.[A-Za-z0-9_.-]+)*\/[A-Za-z0-9_.-]+$/.test(symbol)
    ? symbol : null;
}

function parseHermesUpdate(raw, feedById, envelope = {}) {
  let message;
  try { message = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch (_) { return []; }
  const rows = Array.isArray(message?.parsed) ? message.parsed : [];
  return rows.map((row) => {
    const id = normalizeFeedId(row?.id);
    const mapping = id ? feedById.get(id) : null;
    const value = pythValue(row?.price);
    const publishTime = finite(row?.price?.publish_time);
    if (!mapping || value == null || publishTime == null) return null;
    return {
      symbol: mapping.symbol,
      feedSymbol: mapping.feedSymbol,
      feedId: id,
      value,
      confidence: finite(row?.price?.conf) == null
        ? null : finite(row.price.conf) * (10 ** finite(row.price.expo, 0)),
      sourceMs: publishTime * 1000,
      providerReceivedMs: finite(row?.metadata?.proof_available_time) == null
        ? null : finite(row.metadata.proof_available_time) * 1000,
      carriedForward: false,
      historical: false,
      transportSource: 'pyth-hermes-core',
      raw: row,
      ...envelope,
    };
  }).filter(Boolean);
}

class SseDecoder {
  constructor() { this.buffer = ''; }

  push(chunk) {
    this.buffer += chunk;
    const events = [];
    while (true) {
      const match = this.buffer.match(/\r?\n\r?\n/);
      if (!match) break;
      const block = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const data = block.split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart()).join('\n');
      if (data) events.push(data);
    }
    return events;
  }
}

class HermesPythStream {
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || process.env.PYTH_HERMES_URL || HERMES_URL)
      .replace(/\/$/, '');
    this.accessToken = options.accessToken || process.env.PYTH_API_KEY || null;
    this.fetchImpl = options.fetchImpl || fetch;
    this.wal = options.wal || null;
    this.onTick = options.onTick || (() => {});
    this.onStatus = options.onStatus || (() => {});
    this.userAgent = options.userAgent || 'DeltaForge-Research/1.0';
    this.staleMs = Math.max(5_000, Number(options.staleMs || DEFAULT_STALE_MS));
    this.requestTimeoutMs = Math.max(1_000,
      Number(options.requestTimeoutMs || process.env.PYTH_HERMES_CONNECT_TIMEOUT_MS
        || DEFAULT_REQUEST_TIMEOUT_MS));
    this.catalog = null;
    this.catalogHash = null;
    this.feedById = new Map();
    this.latest = new Map();
    this.abortController = null;
    this.closed = false;
    this.connected = false;
    this.connecting = false;
    this.connectionEpoch = 0;
    this.eventSequence = 0;
    this.reconnectDelay = 1_000;
    this.reconnectTimer = null;
    this.lastMessageAt = 0;
    this.lastOpenAt = 0;
    this.metrics = {
      catalogFetches: 0, catalogFailures: 0, unresolvedFeeds: 0,
      rawEvents: 0, ticks: 0, staleSourceTicks: 0, parseErrors: 0, connectionGaps: 0,
      reconfigurationGaps: 0, connectFailures: 0, reconnects: 0,
    };
  }

  headers(extra = {}) {
    return {
      'User-Agent': this.userAgent,
      ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
      ...extra,
    };
  }

  async loadCatalog() {
    if (this.catalog) return this.catalog;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${FEED_CATALOG_PATH}`, {
        headers: this.headers({ Accept: 'application/json' }),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`Pyth Hermes catalog HTTP ${response.status}: ${text.slice(0, 160)}`);
      }
      let rows;
      try { rows = JSON.parse(text); } catch (_) {
        throw new Error('Pyth Hermes catalog returned invalid JSON');
      }
      if (!Array.isArray(rows)) throw new Error('Pyth Hermes catalog is not an array');
      this.metrics.catalogFetches += 1;
      this.catalogHash = crypto.createHash('sha256').update(text).digest('hex');
      this.catalog = rows;
      return rows;
    } catch (error) {
      this.metrics.catalogFailures += 1;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async setFeeds(specifications) {
    const requested = [...new Map((specifications || [])
      .filter((row) => row?.symbol && row?.feedSymbol)
      .map((row) => [String(row.feedSymbol), {
        symbol: String(row.symbol).toUpperCase(), feedSymbol: String(row.feedSymbol),
      }])).values()];
    const catalog = await this.loadCatalog();
    const exact = new Map();
    for (const row of catalog) {
      const feedSymbol = String(row?.attributes?.symbol || '');
      const id = normalizeFeedId(row?.id);
      if (!feedSymbol || !id) continue;
      if (!exact.has(feedSymbol)) exact.set(feedSymbol, []);
      exact.get(feedSymbol).push({ id, row });
    }
    const next = new Map();
    const unresolved = [];
    const selected = [];
    for (const request of requested) {
      const matches = exact.get(request.feedSymbol) || [];
      if (matches.length !== 1) { unresolved.push(request.feedSymbol); continue; }
      const [match] = matches;
      next.set(match.id, { ...request, attributes: match.row.attributes });
      selected.push({ id: match.id, symbol: request.symbol,
        feedSymbol: request.feedSymbol, attributes: match.row.attributes });
    }
    this.metrics.unresolvedFeeds = unresolved.length;
    const changed = [...next.keys()].sort().join(',') !== [...this.feedById.keys()].sort().join(',');
    this.feedById = next;
    this.wal?.append(JSON.stringify({
      type: 'pyth_hermes_feed_selection', observedAt: new Date().toISOString(),
      endpoint: `${this.baseUrl}${FEED_CATALOG_PATH}`, catalogSha256: this.catalogHash,
      requested: requested.map((row) => row.feedSymbol), selected, unresolved,
      exactMatchOnly: true,
    }), { channel: 'feed-catalog', receiveWallMs: Date.now() });
    if (changed && this.connected) {
      this.metrics.reconfigurationGaps += 1;
      this.restart();
    }
    return { requested: requested.length, resolved: selected.length, unresolved };
  }

  streamUrl() {
    const url = new URL(`${this.baseUrl}${STREAM_PATH}`);
    for (const id of this.feedById.keys()) url.searchParams.append('ids[]', id);
    url.searchParams.set('parsed', 'true');
    url.searchParams.set('allow_unordered', 'true');
    url.searchParams.set('benchmarks_only', 'false');
    return url.toString();
  }

  async connect() {
    if (this.closed || this.connecting || this.connected || !this.feedById.size) return false;
    this.connecting = true;
    const controller = new AbortController();
    this.abortController = controller;
    const connectTimer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(this.streamUrl(), {
        headers: this.headers({ Accept: 'text/event-stream', 'Cache-Control': 'no-cache' }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const body = await response.text().catch(() => '');
        throw new Error(`Pyth Hermes stream HTTP ${response.status}: ${body.slice(0, 160)}`);
      }
      clearTimeout(connectTimer);
      this.connectionEpoch += 1;
      this.eventSequence = 0;
      this.connected = true;
      this.connecting = false;
      this.lastOpenAt = Date.now();
      this.lastMessageAt = Date.now();
      this.reconnectDelay = 1_000;
      this.onStatus('OPEN', { connectionEpoch: this.connectionEpoch, feeds: this.feedById.size });
      this.consume(response, controller).catch((error) => this.connectionEnded(controller, error));
      return true;
    } catch (error) {
      clearTimeout(connectTimer);
      if (controller !== this.abortController || this.closed) return false;
      this.connecting = false;
      this.connected = false;
      this.metrics.connectFailures += 1;
      this.onStatus('CONNECT_FAILED', { message: error.message });
      this.scheduleReconnect();
      return false;
    }
  }

  async consume(response, controller) {
    const decoder = new TextDecoder();
    const sse = new SseDecoder();
    for await (const chunk of response.body) {
      if (this.closed || controller !== this.abortController) return;
      for (const data of sse.push(decoder.decode(chunk, { stream: true }))) {
        this.onEvent(data);
      }
    }
    for (const data of sse.push(decoder.decode())) this.onEvent(data);
    if (!this.closed && controller === this.abortController) {
      throw new Error('Pyth Hermes SSE ended');
    }
  }

  onEvent(data) {
    const receiveWallMs = Date.now();
    const receiveMonoNs = process.hrtime.bigint().toString();
    this.eventSequence += 1;
    // Append-before-parse: malformed or newly introduced payloads remain in
    // the immutable source tape even when this parser cannot understand them.
    const provenance = this.wal?.append(data, {
      channel: 'hermes_sse', receiveWallMs, receiveMonoNs,
      connectionEpoch: this.connectionEpoch,
    }) || { event_sequence: this.eventSequence, event_id: null };
    this.metrics.rawEvents += 1;
    this.lastMessageAt = receiveWallMs;
    const preview = parseHermesUpdate(data, this.feedById, {
      receiveWallMs, receiveMonoNs, connectionEpoch: this.connectionEpoch,
      eventSequence: provenance.event_sequence ?? this.eventSequence,
      walEventId: provenance.event_id || null,
    });
    if (!preview.length) this.metrics.parseErrors += 1;
    for (const tick of preview) {
      const value = {
        ...tick,
        eventSequence: provenance.event_sequence ?? tick.eventSequence,
        walEventId: provenance.event_id || null,
      };
      this.latest.set(value.symbol, value);
      this.metrics.ticks += 1;
      this.onTick(value);
    }
  }

  connectionEnded(controller, error) {
    if (controller !== this.abortController || this.closed) return;
    const wasConnected = this.connected;
    this.connected = false;
    this.connecting = false;
    this.abortController = null;
    if (wasConnected) this.metrics.connectionGaps += 1;
    this.onStatus('CLOSED', { message: error?.message || 'stream ended',
      connectionEpoch: this.connectionEpoch });
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.closed || this.reconnectTimer || !this.feedById.size) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(30_000, delay * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.metrics.reconnects += 1;
      this.connect().catch(() => this.scheduleReconnect());
    }, delay);
    this.reconnectTimer.unref?.();
  }

  restart() {
    const controller = this.abortController;
    this.abortController = null;
    this.connected = false;
    this.connecting = false;
    try { controller?.abort(); } catch (_) {}
    this.scheduleReconnect();
  }

  checkStale(expectedLive = true) {
    if (!expectedLive || !this.connected || !this.lastMessageAt) return;
    if (Date.now() - this.lastMessageAt <= this.staleMs) return;
    this.onStatus('STALE', { ageMs: Date.now() - this.lastMessageAt });
    const controller = this.abortController;
    try { controller?.abort(); } catch (_) {}
  }

  health(now = Date.now()) {
    const feedCoverage = Object.fromEntries([...this.feedById.entries()].map(([id, mapping]) => {
      const tick = this.latest.get(mapping.symbol);
      return [mapping.feedSymbol, {
        id, symbol: mapping.symbol,
        lastTickAgeMs: tick ? Math.max(0, now - tick.receiveWallMs) : null,
        lastSourceAgeMs: tick?.sourceMs ? Math.max(0, now - tick.sourceMs) : null,
      }];
    }));
    return {
      connected: this.connected,
      connecting: this.connecting,
      connectionEpoch: this.connectionEpoch,
      expectedFeeds: this.feedById.size,
      coveredFeeds: Object.values(feedCoverage)
        .filter((row) => row.lastTickAgeMs != null && row.lastTickAgeMs <= this.staleMs
          && row.lastSourceAgeMs != null && row.lastSourceAgeMs <= this.staleMs).length,
      lastMessageAt: this.lastMessageAt || null,
      lastMessageAgeMs: this.lastMessageAt ? Math.max(0, now - this.lastMessageAt) : null,
      catalogSha256: this.catalogHash,
      feedCoverage,
      metrics: { ...this.metrics },
    };
  }

  close() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const controller = this.abortController;
    this.abortController = null;
    this.connected = false;
    this.connecting = false;
    try { controller?.abort(); } catch (_) {}
  }
}

module.exports = {
  DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_STALE_MS, FEED_CATALOG_PATH, HERMES_URL, HermesPythStream,
  SseDecoder, STREAM_PATH, extractExactPythFeedSymbol, finite, normalizeFeedId,
  parseHermesUpdate, pythValue,
};
