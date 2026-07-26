const test = require('node:test');
const assert = require('node:assert/strict');

const BinanceRecon = require('../borg/recon/binance');
const CoinbaseRecon = require('../borg/recon/coinbase');
const HyperliquidRecon = require('../borg/recon/hyper');

test('Binance causal micro summary survives persistence-buffer drains', () => {
  const feed = new BinanceRecon(() => {}, ['BTCUSDT']);
  const state = feed.bySymbol.get('BTCUSDT');
  state.depthImb = 0.25;
  for (let i = 0; i < 10; i++) {
    state._history.push({
      sec: i,
      open: 100 + i * 0.01,
      close: 100 + (i + 1) * 0.01,
      n: 10,
      buyVol: 7,
      sellVol: 3,
    });
  }
  state._bars.push({ symbol: 'BTCUSDT', sec: 9 });
  const before = feed.getMicro('BTCUSDT', 10);
  assert.ok(before.returnBps > 0);
  assert.equal(before.flowImbalance, 0.4);
  assert.equal(before.depthImbalance, 0.25);
  assert.equal(before.trades, 100);
  assert.equal(feed.drainBars().length, 1);
  assert.equal(feed.getMicro('BTCUSDT', 10).returnBps, before.returnBps);
});

test('Binance wall-clock micro does not turn sixty sparse event bars into sixty seconds', () => {
  const feed = new BinanceRecon(() => {}, ['XRPUSDT']);
  const state = feed.bySymbol.get('XRPUSDT');
  let price = 1;
  for (let sec = 0; sec <= 120; sec += 5) {
    const open = price;
    price *= Math.exp(0.2 / 10000);
    state._history.push({
      sec,
      open,
      close: price,
      n: 2,
      buyVol: sec >= 65 ? 3 : 1,
      sellVol: 1,
    });
  }
  const legacy = feed.getMicro('XRPUSDT', 60);
  const wallClock = feed.getWallClockMicro('XRPUSDT', 60);
  assert.equal(legacy, null); // only 25 event bars exist
  assert.ok(wallClock);
  assert.equal(wallClock.firstObservedBarSec, 65);
  assert.equal(wallClock.lastBarSec, 120);
  assert.equal(wallClock.observedBars, 12);
  assert.equal(wallClock.trades, 24);
  assert.ok(wallClock.returnBps > 2 && wallClock.returnBps < 3);
  assert.ok(wallClock.flowImbalance > 0);
});

test('Binance volatility profile separates a one-off jump from persistent variation', () => {
  const feed = new BinanceRecon(() => {}, ['BTCUSDT']);
  const state = feed.bySymbol.get('BTCUSDT');
  let price = 100;
  for (let i = 0; i < 121; i++) {
    const returnBps = i === 60 ? 20 : (i % 2 === 0 ? 0.5 : -0.5);
    const open = price;
    price *= Math.exp(returnBps / 10000);
    state._history.push({ sec: i, open, close: price, n: 1, buyVol: 1, sellVol: 1 });
  }
  state._ewmaVar = (0.0002 ** 2) / 300;
  const profile = feed.getVolatilityProfile('BTCUSDT', 120);
  assert.ok(profile);
  assert.equal(profile.observations, 120);
  assert.ok(profile.robustSigma5m > 0);
  assert.ok(profile.rmsSigma5m > profile.robustSigma5m);
  assert.ok(profile.maxVarianceShare > 0.5);
});

test('Hyperliquid micro summary never invents unavailable order flow', () => {
  const feed = new HyperliquidRecon(() => {}, ['HYPE']);
  const state = feed.byCoin.get('HYPE');
  for (let i = 0; i < 10; i++) {
    state._history.push({ sec: i, open: 40 + i * 0.01, close: 40 + (i + 1) * 0.01 });
  }
  const micro = feed.getMicro('HYPE', 10);
  assert.ok(micro.returnBps > 0);
  assert.equal(micro.flowImbalance, null);
  assert.equal(micro.depthImbalance, null);
  assert.equal(micro.trades, 0);
});

test('Coinbase control feed produces an independent causal return and persistence rows', () => {
  const feed = new CoinbaseRecon(() => {}, { btc: 'BTC-USD' });
  const start = Date.parse('2026-07-15T00:00:00.000Z');
  for (let i = 0; i <= 10; i++) {
    feed._onMessage(Buffer.from(JSON.stringify({
      type: 'ticker', product_id: 'BTC-USD', price: String(100 + i * 0.01),
      best_bid: String(99.99 + i * 0.01), best_ask: String(100.01 + i * 0.01),
      time: new Date(start + i * 1000).toISOString(),
    })));
  }
  const micro = feed.getMicro('btc', 10);
  assert.ok(micro.returnBps > 0);
  assert.equal(feed.getPrice('btc'), 100.10);
  assert.equal(feed.drainRows().length, 11);
  assert.equal(feed.drainRows().length, 0);
});

test('Coinbase captures 50ms level2 touch capacity and deduplicatable trades', () => {
  const feed = new CoinbaseRecon(() => {}, { btc: 'BTC-USD' }, {
    wal: { append: () => ({ event_id: 'cb:1', event_sequence: 11 }) },
  });
  feed.connectionEpoch = 2;
  feed._onMessage(Buffer.from(JSON.stringify({
    type: 'snapshot', product_id: 'BTC-USD',
    bids: [['65000', '0.5'], ['64999', '1']],
    asks: [['65001', '0.7'], ['65002', '2']],
    time: '2026-07-15T00:00:00.000Z',
  })));
  feed._onMessage(Buffer.from(JSON.stringify({
    type: 'l2update', product_id: 'BTC-USD',
    changes: [['buy', '65000', '0'], ['buy', '64999.5', '0.8']],
    time: '2026-07-15T00:00:00.050Z',
  })));
  feed._onMessage(Buffer.from(JSON.stringify({
    type: 'ticker', product_id: 'BTC-USD', trade_id: 55,
    price: '65001', last_size: '0.01', side: 'buy',
    best_bid: '64999.5', best_ask: '65001',
    time: '2026-07-15T00:00:00.060Z',
  })));
  const rows = feed.drainExternalRows();
  assert.equal(rows.touches.length, 2);
  assert.equal(rows.touches[0].bestBid, 65000);
  assert.equal(rows.touches[0].askSize, 0.7);
  assert.equal(rows.touches[1].bestBid, 64999.5);
  assert.equal(rows.touches[1].walEventId, 'cb:1');
  assert.equal(rows.trades.length, 1);
  assert.equal(rows.trades[0].dedupKey, 'coinbase:BTC-USD:55');
});
