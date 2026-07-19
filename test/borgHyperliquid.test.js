'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const HyperliquidRecon = require('../borg/recon/hyper');

test('Hyperliquid allMids parser WALs before mutation and exposes each configured coin', () => {
  const order = [];
  const feed = new HyperliquidRecon(() => {}, ['BTC', 'ETH'], {
    wal: { append: () => { order.push('wal'); return { event_id: 'hl:1', event_sequence: 7 }; } },
    onMarketEvent: (event) => order.push(event.coin),
  });
  feed.connectionEpoch = 3;
  feed._onMessage(Buffer.from(JSON.stringify({
    channel: 'allMids', data: { mids: { BTC: '65000.5', ETH: '1900.25' } },
  })));
  assert.deepEqual(order, ['wal', 'BTC', 'ETH']);
  assert.equal(feed.getPrice('BTC'), 65000.5);
  assert.equal(feed.getPrice('ETH'), 1900.25);
  assert.equal(feed.isStale(10000), false);
});

test('Hyperliquid parser ignores control responses without manufacturing prices', () => {
  const feed = new HyperliquidRecon(() => {}, ['BTC']);
  feed._onMessage(Buffer.from(JSON.stringify({ channel: 'subscriptionResponse', data: {} })));
  feed._onMessage(Buffer.from(JSON.stringify({ channel: 'pong' })));
  assert.equal(feed.getPrice('BTC'), null);
});

test('Hyperliquid captures executable BBO size and public trades with WAL provenance', () => {
  const feed = new HyperliquidRecon(() => {}, ['BTC'], {
    wal: { append: () => ({ event_id: 'hl:2', event_sequence: 9 }) },
  });
  feed.connectionEpoch = 4;
  feed._onMessage(Buffer.from(JSON.stringify({
    channel: 'bbo',
    data: {
      coin: 'BTC', time: 1770000000000,
      bbo: [{ px: '65000', sz: '0.5' }, { px: '65001', sz: '0.7' }],
    },
  })));
  feed._onMessage(Buffer.from(JSON.stringify({
    channel: 'trades',
    data: [{ coin: 'BTC', time: 1770000000010, tid: 123, px: '65001', sz: '0.01', side: 'B' }],
  })));
  const rows = feed.drainExternalRows();
  assert.equal(rows.touches.length, 1);
  assert.equal(rows.touches[0].bestAsk, 65001);
  assert.equal(rows.touches[0].askSize, 0.7);
  assert.equal(rows.touches[0].walEventId, 'hl:2');
  assert.equal(rows.trades.length, 1);
  assert.equal(rows.trades[0].dedupKey, 'hyperliquid:BTC:1770000000010:123');
  assert.deepEqual(feed.drainExternalRows(), { touches: [], trades: [] });
});
