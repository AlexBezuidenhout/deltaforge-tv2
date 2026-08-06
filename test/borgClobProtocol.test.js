'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const WebSocket = require('ws');
const ClobRecon = require('../borg/recon/clob');

test('CLOB applies documented price_changes and preserves frame provenance', () => {
  const order = [];
  const wal = {
    append(raw, meta) {
      order.push('wal');
      assert.match(raw.toString(), /price_changes/);
      return {
        event_id: 'wal:1', event_sequence: 11, connection_epoch: 3,
        receive_wall_timestamp_ms: meta.receiveWallMs,
        receive_monotonic_ns: meta.receiveMonoNs,
      };
    },
  };
  const events = [];
  const clob = new ClobRecon(() => 42, {
    wal,
    onMarketEvent(event) { order.push('callback'); events.push(event); },
  });
  clob.connectionEpoch = 3;
  clob._handleEvent({
    event_type: 'book', asset_id: 'UP', hash: 'h1', timestamp: '1770000000000',
    bids: [{ price: '0.45', size: '10' }], asks: [{ price: '0.55', size: '12' }],
  }, {
    event_id: 'seed', event_sequence: 10, connection_epoch: 3,
    receive_wall_timestamp_ms: 1770000000001, receive_monotonic_ns: '100',
  });
  order.length = 0;
  clob._onMessage(Buffer.from(JSON.stringify({
    event_type: 'price_change', timestamp: '1770000000010', hash: 'h2',
    price_changes: [{ asset_id: 'UP', price: '0.46', size: '7', side: 'BUY', best_bid: '0.46', best_ask: '0.55' }],
  })));

  assert.deepEqual(order, ['wal', 'callback']);
  assert.deepEqual(clob.getBook('UP').bids, [[0.46, 7], [0.45, 10]]);
  assert.equal(clob.getBook('UP').hash, 'h2');
  assert.equal(events.at(-1).eventSequence, 11);
  const row = clob.touchBuf.at(-1);
  assert.equal(row[2], 42);
  assert.equal(row[3], 'UP');
  assert.equal(row[1].getTime(), 1770000000010);
  assert.equal(row[9], 3);
  assert.equal(row[10], 0);
  assert.equal(row[11], 11);
  assert.equal(row[12], 'wal:1');
  assert.equal(row[13], 'h2');
  assert.equal(row[14], 'price_change');
});

test('CLOB uses official initial and dynamic subscription messages', () => {
  const sent = [];
  const clob = new ClobRecon(() => null);
  clob.ws = { readyState: WebSocket.OPEN, send: (message) => sent.push(JSON.parse(message)) };
  clob._sendInitialSubscribe(['A', 'B']);
  clob.subscribe(['B', 'C']);
  assert.deepEqual(sent, [
    { type: 'market', assets_ids: ['A', 'B'], custom_feature_enabled: true },
    { assets_ids: ['C'], operation: 'subscribe', custom_feature_enabled: true },
    { assets_ids: ['A'], operation: 'unsubscribe', custom_feature_enabled: true },
  ]);
  clob.close();
});

test('CLOB sends the required initial market message when discovery follows connect', () => {
  const sent = [];
  const clob = new ClobRecon(() => null);
  clob.ws = { readyState: WebSocket.OPEN, send: (message) => sent.push(JSON.parse(message)) };

  clob.subscribe(['A', 'B']);
  clob.subscribe(['B', 'C']);

  assert.deepEqual(sent, [
    { type: 'market', assets_ids: ['A', 'B'], custom_feature_enabled: true },
    { assets_ids: ['C'], operation: 'subscribe', custom_feature_enabled: true },
    { assets_ids: ['A'], operation: 'unsubscribe', custom_feature_enabled: true },
  ]);
  clob.close();
});

test('CLOB does not send PING before an initial market subscription', () => {
  const sent = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send: (message) => sent.push(message),
  };
  const clob = new ClobRecon(() => null);
  clob.ws = socket;

  assert.equal(clob._sendHeartbeat(socket), false);
  assert.deepEqual(sent, []);

  clob.subscribe(['A']);
  assert.equal(clob._sendHeartbeat(socket), true);
  assert.deepEqual(JSON.parse(sent[0]), {
    type: 'market', assets_ids: ['A'], custom_feature_enabled: true,
  });
  assert.equal(sent[1], 'PING');
  clob.close();
});

test('CLOB accepts text PONG as healthy traffic without JSON parsing', () => {
  let appends = 0;
  const clob = new ClobRecon(() => null, { wal: { append: () => { appends += 1; return {}; } } });
  clob._onMessage(Buffer.from('PONG'));
  assert.equal(appends, 1);
  assert.ok(Date.now() - clob.lastWsMsgAt < 1000);
});

test('CLOB disconnects are durable gap counters and invalidate stale books', () => {
  const clob = new ClobRecon(() => 42);
  clob.subscribe(['YES']);
  clob.connectionEpoch = 2;
  clob.books.set('YES', { bids: [[0.49, 10]], asks: [[0.51, 10]], at: Date.now() });
  clob._pendingSqlTouch.set('YES', []);

  assert.equal(clob._recordConnectionGap({ reason: 'test_close' }), true);
  assert.equal(clob.connectionGaps, 1);
  assert.equal(clob.books.size, 0);
  assert.equal(clob._pendingSqlTouch.size, 0);
  assert.equal(clob.eventBuf.at(-1)[3], 'connection_gap');
  assert.equal(clob.health().connectionGaps, 1);
});

test('an idle CLOB socket with no desired assets cannot create an evidence gap', () => {
  const clob = new ClobRecon(() => null);
  clob.connectionEpoch = 2;
  assert.equal(clob._recordConnectionGap({ reason: 'idle_close' }), false);
  assert.equal(clob.connectionGaps, 0);
});

test('CLOB REST validation lets an in-flight WS update win without a false gap', async () => {
  const originalFetch = global.fetch;
  let requests = 0;
  global.fetch = async () => {
    requests += 1;
    return {
      ok: true,
      json: async () => ({
        hash: 'h2', timestamp: Date.now(),
        bids: [{ price: '0.49', size: '10' }],
        asks: [{ price: '0.51', size: '10' }],
      }),
    };
  };
  try {
    const clob = new ClobRecon(() => 1, { hashValidationGraceMs: 20 });
    const at = Date.now();
    clob.books.set('YES', {
      hash: 'h1', src: 'ws', at,
      bids: [[0.48, 10]], asks: [[0.52, 10]],
    });
    setTimeout(() => clob.books.set('YES', {
      hash: 'h2', src: 'ws', at: Date.now(),
      bids: [[0.49, 10]], asks: [[0.51, 10]],
    }), 5);

    await clob.pollBook('YES', { forceValidate: true });

    assert.equal(requests, 1);
    assert.equal(clob.bookStateGaps, 0);
    assert.equal(clob.getBook('YES').src, 'ws');
    assert.equal(clob.getBook('YES').hash, 'h2');
  } finally {
    global.fetch = originalFetch;
  }
});

test('CLOB REST validation records only a mismatch that survives grace and confirmation', async () => {
  const originalFetch = global.fetch;
  let requests = 0;
  global.fetch = async () => {
    requests += 1;
    return {
      ok: true,
      json: async () => ({
        hash: 'h2', timestamp: Date.now(),
        bids: [{ price: '0.49', size: '10' }],
        asks: [{ price: '0.51', size: '10' }],
      }),
    };
  };
  try {
    const clob = new ClobRecon(() => 1, { hashValidationGraceMs: 0 });
    clob.books.set('YES', {
      hash: 'h1', src: 'ws', at: Date.now(),
      bids: [[0.48, 10]], asks: [[0.52, 10]],
    });

    await clob.pollBook('YES', { forceValidate: true });

    assert.equal(requests, 2);
    assert.equal(clob.bookStateGaps, 1);
    assert.equal(clob.getBook('YES').src, 'rest_hash_repair');
    assert.equal(clob.getBook('YES').hash, 'h2');
  } finally {
    global.fetch = originalFetch;
  }
});

test('CLOB propagates documented tick-size changes to event-driven strategies', () => {
  const events = [];
  const clob = new ClobRecon(() => 42, { onMarketEvent: (event) => events.push(event) });
  const provenance = {
    receive_wall_timestamp_ms: 1770000000001,
    receive_monotonic_ns: '100', event_sequence: 1,
  };
  clob._handleEvent({
    event_type: 'book', asset_id: 'YES', timestamp: '1770000000000',
    bids: [{ price: '0.959', size: '10' }], asks: [{ price: '0.961', size: '10' }],
  }, provenance);
  clob._handleEvent({
    event_type: 'tick_size_change', asset_id: 'YES', timestamp: '1770000000010',
    old_tick_size: '0.01', new_tick_size: '0.001',
  }, { ...provenance, event_sequence: 2, receive_wall_timestamp_ms: 1770000000011 });
  assert.equal(clob.getBook('YES').tickSize, 0.001);
  assert.equal(events.at(-1).eventType, 'tick_size_change');
  assert.equal(events.at(-1).book.tickSize, 0.001);
});

test('CLOB keeps deep deltas in WAL but persists only execution-relevant touch changes', () => {
  let callbacks = 0;
  const clob = new ClobRecon(() => 1, { onMarketEvent: () => { callbacks += 1; } });
  const provenance = { receive_wall_timestamp_ms: Date.now(), receive_monotonic_ns: '1' };
  clob._handleEvent({
    event_type: 'book', asset_id: 'UP',
    bids: [{ price: '0.50', size: '10' }, { price: '0.49', size: '5' }],
    asks: [{ price: '0.51', size: '10' }, { price: '0.52', size: '5' }],
  }, provenance);
  const beforeRows = clob.touchBuf.length;
  const beforeCallbacks = callbacks;
  clob._handleEvent({
    event_type: 'price_change',
    price_changes: [{ asset_id: 'UP', side: 'BUY', price: '0.49', size: '4' }],
  }, provenance);
  assert.equal(clob.touchBuf.length, beforeRows);
  assert.equal(callbacks, beforeCallbacks);
  assert.deepEqual(clob.getBook('UP').bids, [[0.50, 10], [0.49, 4]]);
});

test('derived SQL touches coalesce while event callbacks retain every touch change', () => {
  let callbacks = 0;
  const clob = new ClobRecon(() => 1, {
    sqlTouchMinIntervalMs: 250,
    onMarketEvent: () => { callbacks += 1; },
  });
  const provenance = {
    receive_wall_timestamp_ms: 1000,
    receive_monotonic_ns: '1',
  };
  clob._handleEvent({
    event_type: 'book', asset_id: 'UP',
    bids: [{ price: '0.50', size: '10' }],
    asks: [{ price: '0.51', size: '10' }],
  }, provenance);
  clob._handleEvent({
    event_type: 'price_change',
    price_changes: [{ asset_id: 'UP', side: 'BUY', price: '0.50', size: '9' }],
  }, { ...provenance, receive_wall_timestamp_ms: 1100, event_sequence: 2 });
  clob._handleEvent({
    event_type: 'price_change',
    price_changes: [{ asset_id: 'UP', side: 'BUY', price: '0.50', size: '8' }],
  }, { ...provenance, receive_wall_timestamp_ms: 1200, event_sequence: 3 });

  assert.equal(callbacks, 3);
  assert.equal(clob.touchBuf.length, 1);
  assert.equal(clob._pendingSqlTouch.size, 1);
  assert.equal(clob._drainMaturedPendingTouches(1249), 0);
  assert.equal(clob._drainMaturedPendingTouches(1250), 1);
  assert.equal(clob.touchBuf.length, 2);
  assert.equal(clob.touchBuf.at(-1)[0].getTime(), 1200);
  assert.equal(clob.touchBuf.at(-1)[5], 8);
});

test('dedicated collectors can suppress duplicate derived rows and opt into trade callbacks', () => {
  const events = [];
  const clob = new ClobRecon(() => null, {
    persistDerivedEvents: false,
    emitTradeEvents: true,
    maxPrintAssets: 80,
    onMarketEvent: (event) => events.push(event),
  });
  clob._handleEvent({
    event_type: 'book', asset_id: 'YES', timestamp: Date.now(),
    bids: [{ price: '0.49', size: '10' }], asks: [{ price: '0.51', size: '10' }],
  });
  clob._handleEvent({
    event_type: 'last_trade_price', asset_id: 'YES', timestamp: Date.now(),
    price: '0.49', size: '7', side: 'SELL',
  });
  assert.equal(clob.eventBuf.length, 0);
  assert.equal(clob.touchBuf.length, 0);
  assert.equal(events.at(-1).eventType, 'last_trade_price');
  assert.equal(clob.printsSince('YES', 0).length, 1);
  assert.equal(clob.maxPrintAssets, 80);
});
