'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const RtdsRecon = require('../borg/recon/rtds');
const RtdsMultiplex = require('../borg/recon/rtds-multiplex');

test('RTDS Chainlink parser records source/receive clocks and divergence', () => {
  const order = [];
  const now = Date.now();
  const feed = new RtdsRecon(() => {}, {
    assets: ['btc'],
    wal: { append: () => {
      order.push('wal');
      return { event_id: 'rtds:1', event_sequence: 9, connection_epoch: 2 };
    } },
    onMarketEvent: () => order.push('callback'),
  });
  feed.connectionEpoch = 2;
  feed._onMessage(Buffer.from(JSON.stringify({
    topic: 'crypto_prices_chainlink', type: 'update', timestamp: now,
    payload: { symbol: 'BTC/USD', timestamp: now - 20, value: '60000.25' },
  })));
  assert.deepEqual(order, ['wal', 'callback']);
  const rows = feed.drainRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceMs, now - 20);
  assert.equal(rows[0].value, 60000.25);
  assert.equal(rows[0].eventSequence, 9);
  assert.equal(rows[0].walEventId, 'rtds:1');
  const divergence = feed.getDivergence('btc', 60006.25);
  assert.ok(divergence.absBps > 0.9 && divergence.absBps < 1.1);
});

test('RTDS accepts configured expanded symbols, rejects unconfigured symbols and does not count PONG as data', () => {
  let writes = 0;
  const feed = new RtdsRecon(() => {}, {
    assets: ['btc', 'zec'], wal: { append: () => { writes += 1; return {}; } },
  });
  feed._onMessage(Buffer.from('PONG'));
  assert.equal(feed.lastMsgAt, 0, 'transport keepalive is not economic freshness');
  assert.ok(feed.lastFrameAt > 0);
  feed._onMessage(Buffer.from(JSON.stringify({
    topic: 'crypto_prices_chainlink', payload: {
      symbol: 'ZEC/USD', timestamp: Date.now(), value: 503.25,
    },
  })));
  feed._onMessage(Buffer.from(JSON.stringify({
    topic: 'crypto_prices_chainlink', payload: {
      symbol: 'AVAX/USD', timestamp: Date.now(), value: 25,
    },
  })));
  assert.equal(writes, 3);
  const rows = feed.drainRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].asset, 'zec');
  assert.equal(feed.getPrice('zec'), 503.25);
});

test('RTDS fails closed when a replayed source timestamp arrives on time', () => {
  const feed = new RtdsRecon(() => {}, { assets: ['btc'] });
  feed._onMessage(Buffer.from(JSON.stringify({
    topic: 'crypto_prices_chainlink',
    payload: { symbol: 'btc/usd', timestamp: Date.now() - 60_000, value: 60000 },
  })));
  assert.equal(feed.getPrice('btc', 10_000), null);
  assert.ok(feed.getAgeMs('btc') >= 59_000);
});

test('RTDS records the separately transported Binance topic without replacing Chainlink state', () => {
  const feed = new RtdsRecon(() => {}, { assets: ['btc'] });
  const base = Date.now() - 11000;
  feed._onMessage(Buffer.from(JSON.stringify({
    topic: 'crypto_prices', type: 'update', timestamp: base,
    payload: { symbol: 'btcusdt', timestamp: base, value: 60000 },
  })));
  feed._onMessage(Buffer.from(JSON.stringify({
    topic: 'crypto_prices', type: 'update', timestamp: base + 10000,
    payload: { symbol: 'btcusdt', timestamp: base + 10000, value: 60030 },
  })));
  feed._onMessage(Buffer.from(JSON.stringify({
    topic: 'crypto_prices_chainlink', type: 'update', timestamp: base + 10000,
    payload: { symbol: 'btc/usd', timestamp: base + 10000, value: 59990 },
  })));
  assert.equal(feed.getBinancePrice('btc'), 60030);
  assert.equal(feed.getPrice('btc'), 59990);
  assert.ok(feed.getMicro('btc', 'binance', 10).returnBps > 4.9);
  assert.equal(feed.drainRows().length, 3);
});

test('RTDS retains and retrieves the nearest resolver opening tick causally', () => {
  const feed = new RtdsRecon(() => {}, { assets: ['eth'] });
  const base = Date.now() - 5000;
  for (const [offset, value] of [[-1000, 1900], [100, 1901], [2500, 1902]]) {
    feed._onMessage(Buffer.from(JSON.stringify({
      topic: 'crypto_prices_chainlink',
      payload: { symbol: 'eth/usd', timestamp: base + offset, value },
    })));
  }
  assert.equal(feed.getPriceAtMs('eth', base, 500), 1901);
  assert.equal(feed.getPriceAtMs('eth', base - 10000, 500), null);
});

test('RTDS established disconnect is durable, cumulative and invalidates current quotes', () => {
  const writes = [];
  const feed = new RtdsRecon(() => {}, {
    assets: ['btc'],
    wal: { append: (raw, meta) => {
      writes.push({ raw: JSON.parse(raw), meta });
      return {};
    } },
  });
  feed.connectionEpoch = 4;
  feed._onMessage(Buffer.from(JSON.stringify({
    topic: 'crypto_prices_chainlink',
    payload: { symbol: 'btc/usd', timestamp: Date.now(), value: 60000 },
  })));
  assert.equal(feed.getPrice('btc'), 60000);

  assert.equal(feed._recordConnectionGap({ reason: 'test_close', code: 1006 }), true);
  assert.equal(feed.getPrice('btc'), null);
  assert.equal(feed.connectionGaps, 1);
  assert.equal(feed.health().connectionGaps, 1);
  assert.equal(feed.health().lastMessageAgeMs, null);
  assert.equal(writes.at(-1).raw.type, 'connection_gap');
  assert.equal(writes.at(-1).raw.connectionEpoch, 4);
  assert.equal(writes.at(-1).meta.channel, 'control');
});

test('RTDS startup unavailability is not misclassified as a lost evidence interval', () => {
  const writes = [];
  const feed = new RtdsRecon(() => {}, {
    wal: { append: (...args) => writes.push(args) },
  });
  assert.equal(feed._recordConnectionGap({ reason: 'construct_failure' }), false);
  assert.equal(feed.connectionGaps, 0);
  assert.equal(writes.length, 0);
});

test('redundant RTDS keeps coverage through one reconnect and records simultaneous loss', () => {
  const callbacks = [];
  const walRecords = [];
  const feed = new RtdsMultiplex(() => {}, {
    assets: ['btc'], pathCount: 2,
    wal: { append: (raw, meta) => {
      let parsed = null;
      try { parsed = JSON.parse(raw.toString()); } catch (_) {}
      walRecords.push({ raw: parsed, meta });
      return {};
    } },
    onMarketEvent: (event) => callbacks.push(event),
  });
  const sourceMs = Date.now();
  const frame = Buffer.from(JSON.stringify({
    topic: 'crypto_prices_chainlink',
    payload: { symbol: 'btc/usd', timestamp: sourceMs, value: 60000 },
  }));
  for (const path of feed.feeds) {
    path.connectionEpoch = 1;
    path._onMessage(frame);
  }
  assert.equal(callbacks.length, 1, 'duplicate transport copies produce one strategy event');
  assert.equal(feed.getPrice('btc'), 60000);

  feed.feeds[0]._recordConnectionGap({ reason: 'path_zero_close' });
  let health = feed.health();
  assert.equal(health.transportReconnects, 1);
  assert.equal(health.coverageGaps, 0);
  assert.equal(health.coveredAssets, 1);
  assert.equal(health.paths[0].connectionGaps, undefined);

  feed.feeds[1]._recordConnectionGap({ reason: 'path_one_close' });
  health = feed.health();
  assert.equal(health.coverageGaps, 1);
  assert.equal(health.coveredAssets, 0);
  assert.equal(walRecords.some((row) => row.raw?.type === 'coverage_gap'), true);
  feed.close();
});

test('redundant RTDS reports per-asset economic coverage instead of any-frame liveness', () => {
  const feed = new RtdsMultiplex(() => {}, {
    assets: ['btc', 'zec'], pathCount: 2, coverageMaxAgeMs: 10_000,
  });
  const frame = Buffer.from(JSON.stringify({
    topic: 'crypto_prices_chainlink',
    payload: { symbol: 'btc/usd', timestamp: Date.now(), value: 60000 },
  }));
  for (const path of feed.feeds) path._onMessage(frame);
  const health = feed.health();
  assert.equal(health.assetCoverage.btc.freshPaths, 2);
  assert.equal(health.assetCoverage.zec.freshPaths, 0);
  assert.equal(health.coveredAssets, 1);
  assert.equal(feed.getPrice('zec'), null);
  feed.close();
});
