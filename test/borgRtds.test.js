'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const RtdsRecon = require('../borg/recon/rtds');

test('RTDS Chainlink parser records source/receive clocks and divergence', () => {
  const order = [];
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
    topic: 'crypto_prices_chainlink', type: 'update', timestamp: 1770000000120,
    payload: { symbol: 'BTC/USD', timestamp: 1770000000100, value: '60000.25' },
  })));
  assert.deepEqual(order, ['wal', 'callback']);
  const rows = feed.drainRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceMs, 1770000000100);
  assert.equal(rows[0].value, 60000.25);
  assert.equal(rows[0].eventSequence, 9);
  assert.equal(rows[0].walEventId, 'rtds:1');
  const divergence = feed.getDivergence('btc', 60006.25);
  assert.ok(divergence.absBps > 0.9 && divergence.absBps < 1.1);
});

test('RTDS ignores unsupported symbols and accepts text PONG', () => {
  let writes = 0;
  const feed = new RtdsRecon(() => {}, {
    assets: ['btc'], wal: { append: () => { writes += 1; return {}; } },
  });
  feed._onMessage(Buffer.from('PONG'));
  feed._onMessage(Buffer.from(JSON.stringify({
    topic: 'crypto_prices_chainlink', payload: { symbol: 'DOGE/USD', value: 1 },
  })));
  assert.equal(writes, 2);
  assert.equal(feed.drainRows().length, 0);
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
