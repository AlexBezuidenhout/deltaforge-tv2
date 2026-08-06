/**
 * BORG recon — Polymarket CLOB: order books, tape, taker prints.
 *
 * Three independent capture paths (redundancy is deliberate — recon data
 * quality is the whole game):
 *  1. WS market channel (wss://ws-subscriptions-clob.polymarket.com/ws/market):
 *     'book' full snapshots + 'price_change' level deltas + 'last_trade_price'
 *     prints. ALL events stored raw in borg_clob_events — the tape for Q4/Q5.
 *  2. REST /book recovery + paced hash validation — repairs gaps without
 *     turning the venue into a millisecond polling API.
 *  3. data-api /trades poll (30s) — taker prints with wallet + aggressor side
 *     (Q5 counterparty patterns, Q6 taker PnL). Deduped by tx/asset key.
 */
const WebSocket = require('ws');
const crypto = require('crypto');
const { insertRows, logEvent } = require('./db');

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const CLOB = 'https://clob.polymarket.com';
const DATA_API = 'https://data-api.polymarket.com';

async function fetchJson(url, timeoutMs = 5000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function normLevels(levels) {
  // Accept [{price,size}] or [[p,s]]; emit [[price,size]] floats sorted best-first later
  if (!Array.isArray(levels)) return [];
  return levels
    .map((l) => (Array.isArray(l) ? [parseFloat(l[0]), parseFloat(l[1])] : [parseFloat(l.price), parseFloat(l.size)]))
    .filter(([p, s]) => Number.isFinite(p) && Number.isFinite(s) && s > 0);
}

function epochMs(value) {
  if (value == null) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

class ClobRecon {
  constructor(resolveMarketId, options = {}) {
    this.resolveMarketId = resolveMarketId; // (assetId) -> borg market id | null
    this.wal = options.wal || null;
    this.onMarketEvent = options.onMarketEvent || (() => {});
    this.onConnectionGap = options.onConnectionGap || (() => {});
    this.onBookStateGap = options.onBookStateGap || (() => {});
    this.acceptDerivedAsset = typeof options.acceptDerivedAsset === 'function'
      ? options.acceptDerivedAsset
      : () => true;
    // Dedicated research processes may keep their own namespaced derived
    // tables while still sharing this hardened public WebSocket adapter and
    // raw WAL contract. Defaults preserve every legacy collector behavior.
    this.persistDerivedEvents = options.persistDerivedEvents !== false;
    this.emitTradeEvents = options.emitTradeEvents === true;
    this.maxPrintAssets = Math.max(40, Number(options.maxPrintAssets || 40));
    this.ws = null;
    this.subscribed = new Set(); // desired assets (kept for API compatibility)
    this.activeSubscriptions = new Set();
    this.books = new Map(); // assetId -> { bids:[[p,s]], asks:[[p,s]], at, src }
    this.eventBuf = [];     // rows for borg_clob_events
    this.touchBuf = [];     // compact rows for borg_clob_touch
    // PostgreSQL is a bounded query tier; the append-before-process WAL keeps
    // every frame. Coalesce only derived SQL touches so sub-second replay
    // fidelity remains recoverable without duplicating every quote mutation
    // in a 100+ byte indexed row.
    this.sqlTouchMinIntervalMs = Math.max(0, Number(
      options.sqlTouchMinIntervalMs
        ?? process.env.BORG_CLOB_SQL_TOUCH_MIN_INTERVAL_MS
        ?? 0,
    ) || 0);
    this._lastSqlTouchAt = new Map();
    this._pendingSqlTouch = new Map();
    this._flushPromise = null;
    this.lastWsMsgAt = 0;
    this._reconnectDelay = 2000;
    this._pingTimer = null;
    this._reconnectTimer = null;
    this._closed = false;
    this._initialSubscriptionSent = false;
    this.connectionEpoch = 0;
    this.connectionShard = Number.isInteger(options.connectionShard) ? options.connectionShard : 0;
    this.connectionGaps = 0;
    this.bookStateGaps = 0;
    this.lastConnectionGapAt = null;
    this.lastBookStateGapAt = null;
    this.frameSequence = 0;
    this.frameCount = 0;
    this.frameBytes = 0;
    this.startedAt = Date.now();
    this.lastPingAt = 0;
    this.lastPongAt = 0;
    this.hashValidationGraceMs = Math.max(0, Number(
      options.hashValidationGraceMs
        ?? process.env.BORG_CLOB_HASH_VALIDATION_GRACE_MS
        ?? 750,
    ) || 0);
    this._validationCursor = 0;
    // REST is only a WS recovery path. Without these rails the 7-asset loop
    // bursts 14 requests every 5s even while WS books are fresh, triggering
    // Cloudflare 429s and eventually local EADDRNOTAVAIL socket exhaustion.
    this._restBookInFlight = 0;
    this._restBookLastPoll = new Map();
    this._restBookBackoffUntil = 0;
    this._lastRestBackoffLogAt = 0;
  }

  connect() {
    return new Promise((resolve) => {
      let ws;
      try {
        ws = new WebSocket(WS_URL);
      } catch (err) {
        this._scheduleReconnect();
        return resolve(false);
      }
      this.ws = ws;
      const to = setTimeout(() => { try { ws.terminate(); } catch (_) {} resolve(false); }, 15000);
      ws.on('open', () => {
        if (ws !== this.ws) return;
        clearTimeout(to);
        this._reconnectDelay = 2000;
        this.connectionEpoch += 1;
        this.frameSequence = 0;
        this.lastWsMsgAt = Date.now();
        this.activeSubscriptions.clear();
        this._initialSubscriptionSent = false;
        if (this.subscribed.size) this._sendInitialSubscribe([...this.subscribed]);
        // The market channel protocol uses literal text PING/PONG, not a
        // WebSocket control-frame ping. Ten seconds is the documented maximum
        // cadence; use 8s plus an immediate first heartbeat to tolerate event-
        // loop jitter under full-book bursts.
        const heartbeat = () => this._sendHeartbeat(ws);
        // The initial market subscription must be the first application
        // message. Collector discovery can populate IDs just after `open`, so
        // do not lead with PING on an as-yet unsubscribed connection.
        if (this._initialSubscriptionSent) heartbeat();
        this._pingTimer = setInterval(heartbeat, 8000);
        resolve(true);
      });
      ws.on('message', (buf) => { if (ws === this.ws) this._onMessage(buf); });
      ws.on('close', (code, reason) => {
        clearTimeout(to);
        if (ws !== this.ws) return;
        clearInterval(this._pingTimer);
        if (this._closed) return;
        const close = {
          code,
          reason: reason?.toString() || null,
          msSincePing: this.lastPingAt ? Date.now() - this.lastPingAt : null,
          msSincePong: this.lastPongAt ? Date.now() - this.lastPongAt : null,
          desiredAssets: this.subscribed.size,
          connectionShard: this.connectionShard,
        };
        logEvent('WARN', 'clob', `ws closed (${code}${close.reason ? `: ${close.reason}` : ''}) — reconnecting`, close);
        this._recordConnectionGap({ reason: 'ws_close', ...close });
        this.activeSubscriptions.clear();
        this._scheduleReconnect();
      });
      ws.on('error', () => { /* close follows */ });
    });
  }

  _sendHeartbeat(socket) {
    // The venue requires the initial market subscription to be the first
    // application frame. A capture-only lane can legitimately have no active
    // markets for part of the day, so an idle socket must not lead with PING
    // and trigger a 1008 invalid-subscription reconnect loop. Once discovery
    // supplies IDs, subscribe() sends the initial frame and heartbeats begin.
    if (this.ws !== socket || socket?.readyState !== WebSocket.OPEN
        || !this._initialSubscriptionSent) return false;
    socket.send('PING');
    this.lastPingAt = Date.now();
    return true;
  }

  _recordConnectionGap(detail = {}) {
    // A socket that never reached OPEN is startup unavailability, not a lost
    // interval. An idle socket with zero desired assets also carries no market
    // evidence, so its transport lifecycle cannot create a false data gap.
    // Once an epoch has subscribed assets, every disconnect creates an
    // unobservable interval and must remain a non-zero evidence counter.
    if (this.connectionEpoch <= 0 || this.subscribed.size === 0) return false;
    this.connectionGaps += 1;
    this.lastConnectionGapAt = new Date().toISOString();
    this._bufferEvent(null, 'connection_gap', null, null, null, detail);

    // Never let evaluators consume a pre-disconnect book during reconnect.
    // Fresh WS snapshots or explicit REST recovery must repopulate state.
    this.books.clear();
    this._lastTouch?.clear();
    this._pendingSqlTouch.clear();
    this.onConnectionGap({
      connectionShard: this.connectionShard,
      subscribedAssets: [...this.subscribed],
      at: this.lastConnectionGapAt,
      detail,
    });
    return true;
  }

  health(now = Date.now()) {
    return {
      connectionShard: this.connectionShard,
      connected: this.ws?.readyState === WebSocket.OPEN,
      connectionEpoch: this.connectionEpoch,
      connectionGaps: this.connectionGaps,
      bookStateGaps: this.bookStateGaps,
      lastConnectionGapAt: this.lastConnectionGapAt,
      lastBookStateGapAt: this.lastBookStateGapAt,
      desiredAssets: this.subscribed.size,
      activeSubscriptions: this.activeSubscriptions.size,
      lastWsMessageAgeMs: this.lastWsMsgAt > 0 ? Math.max(0, now - this.lastWsMsgAt) : null,
      frames: this.frameCount,
      frameBytes: this.frameBytes,
      framesPerSecond: this.startedAt < now
        ? this.frameCount / ((now - this.startedAt) / 1000)
        : 0,
    };
  }

  _scheduleReconnect() {
    if (this._closed || this._reconnectTimer) return;
    const delay = this._reconnectDelay;
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, 30000);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect().then((ok) => { if (!ok) this._scheduleReconnect(); }).catch(() => this._scheduleReconnect());
    }, delay);
  }

  /**
   * Set the full desired subscription set. The collector normally supplies
   * active tokens plus a short pre-boundary warm-up set. The initial connection
   * uses `type: market`; changes on an open connection use the documented
   * subscribe/unsubscribe operations.
   */
  subscribe(assetIds) {
    const want = assetIds.filter(Boolean);
    const changed = want.length !== this.subscribed.size || want.some((id) => !this.subscribed.has(id));
    this.subscribed = new Set(want);
    if (changed && this.ws?.readyState === WebSocket.OPEN) {
      // The first application message on a fresh market-channel connection
      // must be the documented `{type:'market', assets_ids:[...]}` shape.
      // Collector startup connects before discovery, so the first IDs arrive
      // here rather than in the socket's `open` callback.
      if (!this._initialSubscriptionSent && want.length) {
        this._sendInitialSubscribe(want);
        return;
      }
      const add = want.filter((id) => !this.activeSubscriptions.has(id));
      const remove = [...this.activeSubscriptions].filter((id) => !this.subscribed.has(id));
      if (add.length) this._sendSubscriptionChange('subscribe', add);
      if (remove.length) this._sendSubscriptionChange('unsubscribe', remove);
    }
  }

  /** Self-heal half-open sockets: no WS traffic for 120s ⇒ force reconnect. */
  checkStale() {
    // 45s (was 120s): reconnect BEFORE the heartbeat's 60s stale flag fires,
    // so routine WS silences self-heal without paging the dashboard banner.
    if (this.lastWsMsgAt && Date.now() - this.lastWsMsgAt > 45000) {
      logEvent('WARN', 'clob', 'ws silent >45s — forcing reconnect');
      this.lastWsMsgAt = Date.now(); // avoid retrigger while reconnecting
      try { this.ws?.terminate(); } catch (_) {} // close handler reconnects
    }
  }

  _sendInitialSubscribe(ids) {
    try {
      this.ws.send(JSON.stringify({
        type: 'market', assets_ids: ids, custom_feature_enabled: true,
      }));
      this.activeSubscriptions = new Set(ids);
      this._initialSubscriptionSent = true;
    } catch (e) {
      logEvent('WARN', 'clob', `subscribe failed: ${e.message}`);
    }
  }

  _sendSubscriptionChange(operation, ids) {
    try {
      this.ws.send(JSON.stringify({
        assets_ids: ids, operation, custom_feature_enabled: true,
      }));
      for (const id of ids) {
        if (operation === 'subscribe') this.activeSubscriptions.add(id);
        else this.activeSubscriptions.delete(id);
      }
    } catch (e) {
      logEvent('WARN', 'clob', `${operation} failed: ${e.message}`);
    }
  }

  _onMessage(buf) {
    const receiveWallMs = Date.now();
    const receiveMonoNs = process.hrtime.bigint().toString();
    this.frameSequence += 1;
    this.frameCount += 1;
    this.frameBytes += Buffer.byteLength(buf);
    const provenance = this.wal?.append(buf, {
      channel: 'market', receiveWallMs, receiveMonoNs,
      connectionEpoch: this.connectionEpoch,
      connectionShard: this.connectionShard,
    }) || {
      event_id: null, receive_wall_timestamp_ms: receiveWallMs,
      receive_monotonic_ns: receiveMonoNs, connection_epoch: this.connectionEpoch,
      connection_shard: this.connectionShard,
      event_sequence: this.frameSequence,
    };
    this.lastWsMsgAt = receiveWallMs;
    if (buf.toString() === 'PONG') {
      this.lastPongAt = receiveWallMs;
      return;
    }
    let msgs;
    try { msgs = JSON.parse(buf); } catch (_) { return; }
    for (const ev of Array.isArray(msgs) ? msgs : [msgs]) this._handleEvent(ev, provenance);
  }

  _handleEvent(ev, provenance = {}) {
    if (!ev || typeof ev !== 'object') return;
    const type = ev.event_type || ev.type || 'unknown';
    const assetId = ev.asset_id || null;

    if (type === 'book' && assetId) {
      const bids = normLevels(ev.bids || ev.buys).sort((a, b) => b[0] - a[0]);
      const asks = normLevels(ev.asks || ev.sells).sort((a, b) => a[0] - b[0]);
      const receivedAt = provenance.receive_wall_timestamp_ms || Date.now();
      this.books.set(assetId, {
        bids, asks, at: receivedAt, src: 'ws', hash: ev.hash || null,
        minOrderSize: parseFloat(ev.minimum_order_size ?? ev.min_order_size),
        sourceAt: epochMs(ev.timestamp), connectionEpoch: this.connectionEpoch,
        connectionShard: this.connectionShard,
      });
      // Full levels are captured by the 1s snapshotter. The tape row stays slim
      // but carries the touch — sub-second best bid/ask changes are what the
      // Q4 queue simulation needs most (observed live: venue re-broadcasts the
      // full book per change and sends no price_change deltas).
      // Touch-dedupe: the venue re-broadcasts identical books constantly;
      // unchanged-touch rebroadcasts carry no tape information beyond the 1s
      // snapshots and were ~600MB/day of storage. Store touch CHANGES only.
      const touch = [bids[0]?.[0], bids[0]?.[1], asks[0]?.[0], asks[0]?.[1]];
      if (!this._touchChanged(assetId)) return;
      this._bufferEvent(assetId, type, null, null, null, {
        hash: ev.hash || null, ts: ev.timestamp || null,
        bb: touch[0] ?? null, bbs: touch[1] ?? null,
        ba: touch[2] ?? null, bas: touch[3] ?? null,
      }, provenance, ev.timestamp, ev.hash);
      this._bufferTouch(assetId, type, provenance, ev.timestamp, ev.hash);
      this._emitMarketEvent(assetId, type, provenance);
      return;
    }
    if (type === 'price_change') {
      // Current protocol: price_changes[]. Keep `changes` as a legacy reader
      // so old replay fixtures remain usable.
      const changes = Array.isArray(ev.price_changes)
        ? ev.price_changes
        : Array.isArray(ev.changes) ? ev.changes : [ev];
      const lastChangeByAsset = new Map();
      for (const ch of changes) {
        const aid = ch.asset_id || assetId;
        if (!aid) continue;
        this._applyDelta(aid, ch, provenance, ev);
        lastChangeByAsset.set(aid, ch);
      }
      // The WAL retains every depth delta. The queryable tape stores only a
      // post-event touch change per asset: those are the states that can alter
      // a taker fill or trigger H2/H3/H6. Deep-level churn is reconstructible
      // from WAL and must not consume the entire rolling Postgres budget.
      for (const [aid, ch] of lastChangeByAsset) {
        if (!this._touchChanged(aid)) continue;
        this._bufferTouch(aid, 'price_change', provenance,
          ev.timestamp ?? ch.timestamp, ev.hash ?? ch.hash);
        this._emitMarketEvent(aid, type, provenance);
      }
      return;
    }
    if (type === 'last_trade_price' && assetId) {
      this._bufferEvent(assetId, type, parseFloat(ev.price), parseFloat(ev.size), ev.side || null,
        ev, provenance, ev.timestamp, ev.hash);
      this._recordPrint(assetId, parseFloat(ev.price), parseFloat(ev.size));
      if (this.emitTradeEvents) this._emitMarketEvent(assetId, type, provenance);
      return;
    }
    if (type === 'tick_size_change' && assetId) {
      this._bufferEvent(assetId, type, null, null, null, ev, provenance, ev.timestamp, ev.hash);
      const nextTick = parseFloat(ev.new_tick_size);
      const book = this.books.get(assetId);
      if (book && Number.isFinite(nextTick) && nextTick > 0 && nextTick < 1) {
        book.tickSize = nextTick;
        book.at = provenance.receive_wall_timestamp_ms || Date.now();
        book.sourceAt = epochMs(ev.timestamp) || book.sourceAt;
        this._emitMarketEvent(assetId, type, provenance);
      }
    }
  }

  _touchChanged(assetId) {
    const book = this.books.get(assetId);
    if (!book) return false;
    const key = [
      book.bids?.[0]?.[0] ?? null, book.bids?.[0]?.[1] ?? null,
      book.asks?.[0]?.[0] ?? null, book.asks?.[0]?.[1] ?? null,
    ].join('|');
    if (!this._lastTouch) this._lastTouch = new Map();
    if (this._lastTouch.get(assetId) === key) return false;
    this._lastTouch.set(assetId, key);
    return true;
  }

  _applyDelta(assetId, ch, provenance = {}, parent = {}) {
    const book = this.books.get(assetId);
    if (!book || book.src !== 'ws') return; // only patch WS-sourced books
    const price = parseFloat(ch.price);
    const size = parseFloat(ch.size);
    if (!Number.isFinite(price) || !Number.isFinite(size)) return;
    const side = /buy|bid/i.test(ch.side || '') ? 'bids' : /sell|ask/i.test(ch.side || '') ? 'asks' : null;
    if (!side) return;
    const levels = book[side].filter(([p]) => p !== price);
    if (size > 0) levels.push([price, size]);
    levels.sort((a, b) => (side === 'bids' ? b[0] - a[0] : a[0] - b[0]));
    book[side] = levels;
    book.at = provenance.receive_wall_timestamp_ms || Date.now();
    book.sourceAt = epochMs(parent.timestamp ?? ch.timestamp) || book.sourceAt;
    book.hash = parent.hash ?? ch.hash ?? book.hash;
    book.connectionEpoch = this.connectionEpoch;
  }

  _emitMarketEvent(assetId, eventType, provenance) {
    if (!this.acceptDerivedAsset(assetId)) return;
    try {
      this.onMarketEvent({
        source: 'clob', assetId, marketId: this.resolveMarketId(assetId), eventType,
        book: this.books.get(assetId) || null,
        receiveWallMs: provenance.receive_wall_timestamp_ms || Date.now(),
        receiveMonoNs: provenance.receive_monotonic_ns || null,
        connectionEpoch: this.connectionEpoch,
        connectionShard: this.connectionShard,
        eventSequence: provenance.event_sequence || this.frameSequence,
        walEventId: provenance.event_id || null,
        sourceMs: this.books.get(assetId)?.sourceAt || null,
      });
    } catch (err) {
      logEvent('WARN', 'clob', `event callback failed: ${err.message}`);
    }
  }

  // In-memory print tape (last 15 min per asset) — lets shadow strategies do
  // ONLINE back-of-queue fill estimation (audit 2026-07-12: A_maker's losses
  // came from unbounded same-side inventory; capping needs live fill awareness).
  _recordPrint(assetId, price, size) {
    if (!this.acceptDerivedAsset(assetId)) return;
    if (!Number.isFinite(price) || !Number.isFinite(size)) return;
    if (!this._prints) this._prints = new Map();
    let arr = this._prints.get(assetId);
    if (!arr) { arr = []; this._prints.set(assetId, arr); }
    arr.push([Date.now(), price, size]);
    const cutoff = Date.now() - 15 * 60 * 1000;
    while (arr.length && arr[0][0] < cutoff) arr.shift();
    if (this._prints.size > this.maxPrintAssets) {
      // drop the oldest asset key (markets churn every 5 min)
      this._prints.delete(this._prints.keys().next().value);
    }
  }

  /** Prints for an asset since a wall-clock ms timestamp: [[ts, price, size], ...] */
  printsSince(assetId, sinceMs) {
    const arr = (this._prints && this._prints.get(assetId)) || [];
    return arr.filter(([ts]) => ts > sinceMs);
  }

  _bufferEvent(assetId, type, price, size, side, raw, provenance = {}, sourceTimestamp = null, bookHash = null) {
    if (!this.persistDerivedEvents) return;
    if (assetId && !this.acceptDerivedAsset(assetId) && type !== 'book_hash_repair') return;
    const receivedAt = provenance.receive_wall_timestamp_ms || Date.now();
    const book = assetId ? this.books.get(assetId) : null;
    this.eventBuf.push([
      new Date(receivedAt),
      this.resolveMarketId(assetId),
      assetId,
      type,
      Number.isFinite(price) ? price : null,
      Number.isFinite(size) ? size : null,
      side,
      JSON.stringify(raw),
      epochMs(sourceTimestamp) ? new Date(epochMs(sourceTimestamp)) : null,
      String(provenance.receive_monotonic_ns || process.hrtime.bigint()),
      provenance.connection_epoch ?? this.connectionEpoch,
      provenance.connection_shard ?? this.connectionShard,
      provenance.event_sequence ?? this.frameSequence,
      provenance.event_id || null,
      bookHash || null,
      book?.bids?.[0]?.[0] ?? null,
      book?.bids?.[0]?.[1] ?? null,
      book?.asks?.[0]?.[0] ?? null,
      book?.asks?.[0]?.[1] ?? null,
    ]);
    // Raw frames remain durable in the WAL. Bound only the derived DB retry
    // queue so a long database outage cannot exhaust process memory.
    if (this.eventBuf.length > 100000) this.eventBuf.splice(0, 50000);
  }

  _bufferTouch(assetId, eventType, provenance = {}, sourceTimestamp = null, bookHash = null) {
    if (!this.persistDerivedEvents) return;
    if (!this.acceptDerivedAsset(assetId)) return;
    const book = this.books.get(assetId);
    if (!book) return;
    const receivedAt = provenance.receive_wall_timestamp_ms || Date.now();
    const row = [
      new Date(receivedAt),
      epochMs(sourceTimestamp) ? new Date(epochMs(sourceTimestamp)) : null,
      this.resolveMarketId(assetId), assetId,
      book.bids?.[0]?.[0] ?? null, book.bids?.[0]?.[1] ?? null,
      book.asks?.[0]?.[0] ?? null, book.asks?.[0]?.[1] ?? null,
      String(provenance.receive_monotonic_ns || process.hrtime.bigint()),
      provenance.connection_epoch ?? this.connectionEpoch,
      provenance.connection_shard ?? this.connectionShard,
      provenance.event_sequence ?? this.frameSequence,
      provenance.event_id || null,
      bookHash || book.hash || null,
      eventType,
    ];
    const previousAt = this._lastSqlTouchAt.get(assetId);
    if (!this.sqlTouchMinIntervalMs
        || previousAt == null
        || receivedAt - previousAt >= this.sqlTouchMinIntervalMs) {
      this.touchBuf.push(row);
      this._lastSqlTouchAt.set(assetId, receivedAt);
      this._pendingSqlTouch.delete(assetId);
    } else {
      // Keep the most recent state inside the interval. The next eligible
      // event or scheduled flush emits this trailing state; intermediate
      // states remain losslessly available in the raw WAL.
      this._pendingSqlTouch.set(assetId, row);
    }
    if (this.touchBuf.length > 200000) this.touchBuf.splice(0, 100000);
  }

  _drainMaturedPendingTouches(now = Date.now()) {
    if (!this.sqlTouchMinIntervalMs || !this._pendingSqlTouch.size) return 0;
    let drained = 0;
    for (const [assetId, row] of this._pendingSqlTouch) {
      const previousAt = this._lastSqlTouchAt.get(assetId);
      if (previousAt != null && now - previousAt < this.sqlTouchMinIntervalMs) continue;
      this.touchBuf.push(row);
      // Use the drain clock as the next rate-limit boundary. The row itself
      // retains the true receive timestamp of the last state in the interval.
      this._lastSqlTouchAt.set(assetId, now);
      this._pendingSqlTouch.delete(assetId);
      drained += 1;
    }
    return drained;
  }

  /** REST book poll — authoritative snapshot for one token. */
  async pollBook(assetId, options = {}) {
    const now = Date.now();
    const current = this.books.get(assetId);
    const forceValidate = options.forceValidate === true;
    if (!forceValidate && current && now - current.at <= 3000) return; // healthy WS is authoritative
    if (now < this._restBookBackoffUntil) return;
    if (now - (this._restBookLastPoll.get(assetId) || 0) < (forceValidate ? 30000 : 15000)) return;
    if (this._restBookInFlight >= 3) return;

    this._restBookLastPoll.set(assetId, now);
    this._restBookInFlight += 1;
    try {
      const requestHash = current?.hash || null;
      const b = await fetchJson(`${CLOB}/book?token_id=${assetId}`);
      const bids = normLevels(b.bids).sort((x, y) => y[0] - x[0]);
      const asks = normLevels(b.asks).sort((x, y) => x[0] - y[0]);
      const prev = this.books.get(assetId);
      const wsDidNotAdvance = !prev || prev.hash === requestHash;
      let hashMismatch = Boolean(forceValidate && requestHash && b.hash && requestHash !== b.hash && wsDidNotAdvance);
      let recoveryBook = b;
      if (hashMismatch) {
        // REST and WebSocket observations are not causally simultaneous. A
        // one-shot mismatch on a fast book often means REST saw the next state
        // a few milliseconds before its WS frame arrived; treating that race
        // as a gap both creates false evidence failures and replaces the live
        // WS book with a REST state. Give the socket a bounded chance to catch
        // up, then confirm against a fresh REST snapshot while ensuring the WS
        // state did not advance during either request.
        const requestAt = prev?.at || current?.at || null;
        if (this.hashValidationGraceMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.hashValidationGraceMs));
        }
        const afterGrace = this.books.get(assetId);
        const wsStillAtRequest = afterGrace
          && afterGrace.hash === requestHash
          && (requestAt == null || afterGrace.at === requestAt);
        if (!wsStillAtRequest) {
          hashMismatch = false;
        } else {
          recoveryBook = await fetchJson(`${CLOB}/book?token_id=${assetId}`);
          const afterConfirm = this.books.get(assetId);
          hashMismatch = Boolean(
            afterConfirm
            && afterConfirm.hash === requestHash
            && (requestAt == null || afterConfirm.at === requestAt)
            && recoveryBook.hash
            && recoveryBook.hash !== requestHash,
          );
        }
      }
      // REST overrides only a stale/absent WS state or a stable hash mismatch.
      if (!prev || Date.now() - prev.at > 3000 || hashMismatch) {
        const snapshot = hashMismatch ? recoveryBook : b;
        const snapshotBids = hashMismatch
          ? normLevels(snapshot.bids).sort((x, y) => y[0] - x[0])
          : bids;
        const snapshotAsks = hashMismatch
          ? normLevels(snapshot.asks).sort((x, y) => x[0] - y[0])
          : asks;
        this.books.set(assetId, {
          bids: snapshotBids, asks: snapshotAsks, at: Date.now(), src: hashMismatch ? 'rest_hash_repair' : 'rest',
          minOrderSize: parseFloat(snapshot.minimum_order_size ?? snapshot.min_order_size),
          hash: snapshot.hash || null, sourceAt: epochMs(snapshot.timestamp), connectionEpoch: this.connectionEpoch,
          connectionShard: this.connectionShard,
        });
        if (hashMismatch) {
          this.bookStateGaps += 1;
          this.lastBookStateGapAt = new Date().toISOString();
          await logEvent('WARN', 'clob', 'book hash mismatch repaired from REST', {
            assetId, wsHash: requestHash, restHash: snapshot.hash,
            confirmationGraceMs: this.hashValidationGraceMs,
          });
          this._bufferEvent(assetId, 'book_hash_repair', null, null, null, {
            ws_hash: requestHash, rest_hash: snapshot.hash,
          }, {}, snapshot.timestamp, snapshot.hash);
          this.onBookStateGap({
            connectionShard: this.connectionShard,
            assetId,
            at: this.lastBookStateGapAt,
            detail: { wsHash: requestHash, restHash: snapshot.hash },
          });
        }
      }
    } catch (err) {
      if (/HTTP 429/.test(err.message)) {
        this._restBookBackoffUntil = Date.now() + 30000;
        if (Date.now() - this._lastRestBackoffLogAt > 30000) {
          this._lastRestBackoffLogAt = Date.now();
          logEvent('WARN', 'clob', 'REST book backup rate-limited — pausing all backup polls for 30s');
        }
      } else if (!/HTTP 404/.test(err.message)) {
        logEvent('WARN', 'clob', `book poll ${assetId.slice(0, 12)}…: ${err.message}`);
      }
    } finally {
      this._restBookInFlight = Math.max(0, this._restBookInFlight - 1);
      if (this._restBookLastPoll.size > 100) {
        const cutoff = Date.now() - 30 * 60 * 1000;
        for (const [id, at] of this._restBookLastPoll) {
          if (at < cutoff) this._restBookLastPoll.delete(id);
        }
      }
    }
  }

  /** Validate one desired token per call, pacing REST to avoid request bursts. */
  validateNextBook() {
    const ids = [...this.subscribed];
    if (!ids.length) return Promise.resolve();
    const assetId = ids[this._validationCursor % ids.length];
    this._validationCursor = (this._validationCursor + 1) % Math.max(ids.length, 1);
    return this.pollBook(assetId, { forceValidate: true });
  }

  getBook(assetId) {
    return this.books.get(assetId) || null;
  }

  async flushEvents() {
    if (this._flushPromise) return this._flushPromise;
    this._flushPromise = this._flushBatches();
    try { return await this._flushPromise; } finally { this._flushPromise = null; }
  }

  async _flushBatches() {
    this._drainMaturedPendingTouches();
    const rows = this.eventBuf;
    this.eventBuf = [];
    const touches = this.touchBuf;
    this.touchBuf = [];
    let inserted = 0;
    if (rows.length) {
      try {
        inserted += await insertRows(
          'borg_clob_events',
          ['ts', 'market_id', 'asset_id', 'event_type', 'price', 'size', 'side', 'raw',
            'source_ts', 'receive_monotonic_ns', 'connection_epoch', 'connection_shard',
            'event_sequence', 'wal_event_id', 'book_hash',
            'best_bid', 'bid_size', 'best_ask', 'ask_size'],
          rows
        );
      } catch (err) {
        this.eventBuf = rows.concat(this.eventBuf);
        if (this.eventBuf.length > 100000) this.eventBuf.length = 100000;
        await logEvent('ERROR', 'clob', `event flush failed (${rows.length} rows retained for retry): ${err.message}`);
      }
    }
    if (touches.length) {
      try {
        inserted += await insertRows('borg_clob_touch', [
          'ts', 'source_ts', 'market_id', 'asset_id',
          'best_bid', 'bid_size', 'best_ask', 'ask_size',
          'receive_monotonic_ns', 'connection_epoch', 'connection_shard', 'event_sequence',
          'wal_event_id', 'book_hash', 'event_type',
        ], touches);
      } catch (err) {
        this.touchBuf = touches.concat(this.touchBuf);
        if (this.touchBuf.length > 200000) this.touchBuf.length = 200000;
        await logEvent('ERROR', 'clob', `touch flush failed (${touches.length} rows retained for retry): ${err.message}`);
      }
    }
    return inserted;
  }

  /** data-api taker prints for a condition id; dedup on stable key. */
  async pollTakerTrades(conditionId) {
    if (!conditionId) return;
    let trades;
    try {
      trades = await fetchJson(`${DATA_API}/trades?market=${conditionId}&limit=300`);
    } catch (err) {
      await logEvent('WARN', 'clob', `taker trades poll failed: ${err.message}`);
      return;
    }
    if (!Array.isArray(trades) || !trades.length) return;
    const rows = trades.map((t) => {
      const key = crypto
        .createHash('md5')
        .update([t.transactionHash, t.asset, t.proxyWallet, t.side, t.price, t.size, t.timestamp].join('|'))
        .digest('hex');
      return [
        key,
        t.conditionId || conditionId,
        t.asset || null,
        t.timestamp ? new Date(Number(t.timestamp) * (String(t.timestamp).length > 12 ? 1 : 1000)) : null,
        t.side || null,
        Number.isFinite(parseFloat(t.price)) ? parseFloat(t.price) : null,
        Number.isFinite(parseFloat(t.size)) ? parseFloat(t.size) : null,
        t.proxyWallet || null,
        JSON.stringify(t),
      ];
    });
    try {
      await insertRows(
        'borg_taker_trades',
        ['dedup_key', 'condition_id', 'asset_id', 'ts', 'side', 'price', 'size', 'wallet', 'raw'],
        rows,
        'ON CONFLICT (dedup_key) DO NOTHING'
      );
    } catch (err) {
      await logEvent('ERROR', 'clob', `taker trades insert failed: ${err.message}`);
    }
  }

  close() {
    this._closed = true;
    clearInterval(this._pingTimer);
    clearTimeout(this._reconnectTimer);
    const ws = this.ws;
    this.ws = null; // reject already-queued frames before the WAL is sealed
    try { ws?.terminate(); } catch (_) {}
  }
}

module.exports = ClobRecon;
