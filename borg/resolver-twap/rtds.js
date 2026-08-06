'use strict';

const WebSocket = require('ws');

const RTDS_URL = 'wss://ws-live-data.polymarket.com';
const TOPICS = Object.freeze({
  30: 'crypto_prices_twap_thirty',
  60: 'crypto_prices_twap_sixty',
});

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function epochMs(value) {
  const parsed = finite(value);
  if (parsed != null) return parsed < 1e12 ? parsed * 1000 : parsed;
  const date = Date.parse(value);
  return Number.isFinite(date) ? date : null;
}

function e18Decimal(value) {
  const raw = String(value || '').trim();
  if (!/^-?\d+$/.test(raw)) return null;
  const number = BigInt(raw);
  const negative = number < 0n;
  const absolute = negative ? -number : number;
  const whole = absolute / (10n ** 18n);
  const fraction = String(absolute % (10n ** 18n)).padStart(18, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function topicWindow(topic) {
  if (topic === TOPICS[30]) return 30;
  if (topic === TOPICS[60]) return 60;
  return null;
}

function parseTwapFrame(raw, envelope = {}) {
  let message;
  try {
    message = raw && typeof raw === 'object' && !Buffer.isBuffer(raw)
      ? raw : JSON.parse(String(raw));
  } catch (_) { return null; }
  const topic = String(message?.topic || '');
  const expectedWindow = topicWindow(topic);
  if (!expectedWindow || String(message?.type || '').toLowerCase() !== 'update') return null;
  const payload = message?.payload || message?.data;
  if (!payload || typeof payload !== 'object') return null;
  const symbol = String(payload.symbol || '').toLowerCase();
  const payloadWindow = Math.trunc(finite(payload.window_s ?? payload.windowSeconds) ?? 0);
  if (!symbol || payloadWindow !== expectedWindow) return null;
  const exactValue = e18Decimal(payload.full_accuracy_value)
    || (finite(payload.value) != null ? String(payload.value) : null);
  const value = finite(exactValue);
  const sourceMs = epochMs(payload.timestamp);
  if (!(value > 0) || sourceMs == null) return null;
  return {
    source: `chainlink_twap_${expectedWindow}s`,
    topic,
    symbol,
    asset: symbol.split('/')[0],
    windowSeconds: expectedWindow,
    exactValue,
    value,
    sourceMs,
    publisherMs: epochMs(message.timestamp),
    raw: message,
    ...envelope,
  };
}

function economicAgeMs(tick, now = Date.now()) {
  if (!tick || !Number.isFinite(tick.sourceMs) || !Number.isFinite(tick.receiveWallMs)) return Infinity;
  return Math.max(0, now - tick.sourceMs, now - tick.receiveWallMs);
}

class TwapRtds {
  constructor(options = {}) {
    this.url = options.url || RTDS_URL;
    this.symbols = [...new Set((options.symbols || ['zec/usd'])
      .map((value) => String(value).toLowerCase()).filter(Boolean))];
    this.windows = [...new Set((options.windows || [30, 60])
      .map(Number).filter((value) => TOPICS[value]))];
    this.transportPath = Number(options.transportPath || 0);
    this.wal = options.wal || null;
    this.onTick = options.onTick || (() => {});
    this.onGap = options.onGap || (() => {});
    this.onStatus = options.onStatus || (() => {});
    this.ws = null;
    this.closed = false;
    this.connectionEpoch = 0;
    this.eventSequence = 0;
    this.latest = new Map();
    this.lastFrameAt = 0;
    this.lastEconomicAt = 0;
    this.openedAt = 0;
    this.reconnectDelay = 1000;
    this.reconnectTimer = null;
    this.keepaliveTimer = null;
    this.awaitingPongSince = 0;
    this.metrics = { rawFrames: 0, ticks: 0, parseErrors: 0, controlFrames: 0,
      transportGaps: 0, economicGaps: 0, topicRejections: 0 };
  }

  subscriptions() {
    return this.windows.flatMap((windowSeconds) => this.symbols.map((symbol) => ({
      topic: TOPICS[windowSeconds], type: 'update', filters: JSON.stringify({ symbol }),
    })));
  }

  subscribe() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ action: 'subscribe', subscriptions: this.subscriptions() }));
  }

  connect() {
    return new Promise((resolve) => {
      let socket;
      try { socket = new WebSocket(this.url); } catch (_) { this.scheduleReconnect(); resolve(false); return; }
      this.ws = socket;
      const timeout = setTimeout(() => { try { socket.terminate(); } catch (_) {} resolve(false); }, 15_000);
      socket.on('open', () => {
        if (socket !== this.ws) return;
        clearTimeout(timeout); this.connectionEpoch += 1; this.reconnectDelay = 1000;
        this.openedAt = Date.now();
        this.subscribe(); this.startKeepalive(socket);
        this.onStatus('OPEN', { transportPath: this.transportPath,
          connectionEpoch: this.connectionEpoch });
        resolve(true);
      });
      socket.on('message', (raw) => { if (socket === this.ws) this.onMessage(raw); });
      socket.on('pong', () => { if (socket === this.ws) this.awaitingPongSince = 0; });
      socket.on('close', (code, reason) => {
        clearTimeout(timeout);
        if (socket !== this.ws || this.closed) return;
        this.stopKeepalive(); this.ws = null; this.metrics.transportGaps += 1;
        this.recordGap('TRANSPORT_CLOSE', { code, reason: String(reason || '') });
        this.scheduleReconnect();
      });
      socket.on('error', () => {});
    });
  }

  startKeepalive(socket) {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (socket !== this.ws || socket.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      if (this.awaitingPongSince && now - this.awaitingPongSince > 15_000) {
        try { socket.terminate(); } catch (_) {} return;
      }
      try { socket.send('PING'); socket.ping(); this.awaitingPongSince ||= now; }
      catch (_) { try { socket.terminate(); } catch (_) {} }
    }, 5000);
    this.keepaliveTimer.unref?.();
  }

  stopKeepalive() { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }

  recordGap(reason, detail = {}) {
    const event = {
      type: 'twap_gap', source: 'polymarket_rtds_chainlink_twap', reason,
      at: new Date().toISOString(), transportPath: this.transportPath,
      connectionEpoch: this.connectionEpoch, detail,
    };
    this.wal?.append(JSON.stringify(event), { channel: 'control',
      connectionShard: this.transportPath });
    this.onGap(event);
  }

  onMessage(raw) {
    const receiveWallMs = Date.now();
    const receiveMonoNs = process.hrtime.bigint().toString();
    const provenance = this.wal?.append(raw, {
      channel: 'chainlink-twap', receiveWallMs, receiveMonoNs,
      connectionEpoch: this.connectionEpoch, connectionShard: this.transportPath,
    }) || {};
    this.metrics.rawFrames += 1; this.lastFrameAt = receiveWallMs;
    const text = raw?.toString?.().trim?.() || '';
    if (!text || text.toUpperCase() === 'PONG') { this.metrics.controlFrames += 1; return; }
    let control;
    try { control = JSON.parse(text); } catch (_) { this.metrics.parseErrors += 1; return; }
    if (/topic not found/i.test(JSON.stringify(control))) {
      this.metrics.topicRejections += 1; this.recordGap('TOPIC_REJECTED', { response: control });
      try { this.ws?.terminate(); } catch (_) {} return;
    }
    this.eventSequence += 1;
    const tick = parseTwapFrame(control, {
      receiveWallMs, receiveMonoNs, transportPath: this.transportPath,
      connectionEpoch: this.connectionEpoch,
      eventSequence: provenance.event_sequence ?? this.eventSequence,
      walEventId: provenance.event_id || null,
    });
    if (!tick || !this.symbols.includes(tick.symbol) || !this.windows.includes(tick.windowSeconds)) {
      this.metrics.controlFrames += 1; return;
    }
    this.metrics.ticks += 1; this.lastEconomicAt = receiveWallMs;
    this.latest.set(`${tick.symbol}:${tick.windowSeconds}`, tick); this.onTick(tick);
  }

  checkStale(maxAgeMs = 10_000) {
    if (this.ws?.readyState !== WebSocket.OPEN) return true;
    // Give a newly subscribed path one full stale window to receive every
    // requested topic before classifying an economic gap.
    if (this.openedAt && Date.now() - this.openedAt <= maxAgeMs) return false;
    const stale = [];
    for (const symbol of this.symbols) for (const windowSeconds of this.windows) {
      const tick = this.latest.get(`${symbol}:${windowSeconds}`);
      if (economicAgeMs(tick) > maxAgeMs) stale.push(`${symbol}:${windowSeconds}`);
    }
    if (stale.length) {
      this.metrics.economicGaps += 1;
      this.recordGap('ECONOMIC_SOURCE_STALE', { stale, maxAgeMs });
      this.latest.clear();
      try { this.ws?.terminate(); } catch (_) {}
    }
    return stale.length > 0;
  }

  scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.reconnectDelay; this.reconnectDelay = Math.min(30_000, delay * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().then((ok) => { if (!ok) this.scheduleReconnect(); })
        .catch(() => this.scheduleReconnect());
    }, delay);
    this.reconnectTimer.unref?.();
  }

  health(now = Date.now()) {
    return {
      connected: this.ws?.readyState === WebSocket.OPEN,
      transportPath: this.transportPath, connectionEpoch: this.connectionEpoch,
      lastFrameAgeMs: this.lastFrameAt ? now - this.lastFrameAt : null,
      lastEconomicAgeMs: this.lastEconomicAt ? now - this.lastEconomicAt : null,
      coverage: Object.fromEntries(this.symbols.flatMap((symbol) => this.windows.map((windowSeconds) => {
        const tick = this.latest.get(`${symbol}:${windowSeconds}`);
        const ageMs = economicAgeMs(tick, now);
        return [`${symbol}:${windowSeconds}`, { ageMs: Number.isFinite(ageMs) ? ageMs : null }];
      }))),
      metrics: { ...this.metrics },
    };
  }

  close() {
    this.closed = true; clearTimeout(this.reconnectTimer); this.stopKeepalive();
    const socket = this.ws; this.ws = null; try { socket?.close(); } catch (_) {}
  }
}

module.exports = {
  RTDS_URL, TOPICS, TwapRtds, e18Decimal, economicAgeMs, parseTwapFrame,
};
