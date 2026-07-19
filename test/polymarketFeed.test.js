const test = require('node:test');
const assert = require('node:assert/strict');
const PolymarketFeed = require('../src/bot/PolymarketFeed');

test('getOrderBook derives top of book instead of trusting CLOB array order', async () => {
  const feed = new PolymarketFeed();
  feed.clobClient = {
    getOrderBook: async () => ({
      bids: [
        { price: '0.01', size: '100' },
        { price: '0.48', size: '7' },
        { price: '0.45', size: '10' },
      ],
      asks: [
        { price: '0.99', size: '100' },
        { price: '0.52', size: '8' },
        { price: '0.55', size: '10' },
      ],
    }),
  };

  const book = await feed.getOrderBook('token');

  assert.equal(book.bestBid, 0.48);
  assert.equal(book.bestAsk, 0.52);
  assert.ok(Math.abs(book.spread - 0.04) < 1e-12);
  assert.equal(book.midPrice, 0.5);
  assert.deepEqual(book.bidLevels.map((level) => level.price), [0.48, 0.45, 0.01]);
  assert.deepEqual(book.askLevels.map((level) => level.price), [0.52, 0.55, 0.99]);
  assert.equal(book.bestBidUsd, 0.48 * 7);
  assert.equal(book.bestAskUsd, 0.52 * 8);
});

test('FAK market buy can carry an explicit worst-price guard', () => {
  const order = PolymarketFeed.buildMarketBuyOrder(
    'token', 10, '0.52', { BUY: 'BUY' }, { FAK: 'FAK' },
  );
  assert.equal(order.amount, 10);
  assert.equal(order.price, 0.52);
  assert.equal(order.orderType, 'FAK');
  assert.throws(() => PolymarketFeed.buildMarketBuyOrder(
    'token', 10, '1.01', { BUY: 'BUY' }, { FAK: 'FAK' },
  ), /Invalid FAK worst price/);
});

test('execution metadata verifies token identity and exposes dynamic fee/tick fields', async () => {
  const feed = new PolymarketFeed();
  feed.clobClient = {
    getClobMarketInfo: async (conditionId) => ({
      c: conditionId,
      t: [{ t: 'token-up', o: 'Up' }, { t: 'token-down', o: 'Down' }],
      mts: 0.001,
      nr: false,
      fd: { r: 0.07, e: 1, to: true },
      mos: 5,
      ao: true,
    }),
  };

  const info = await feed.fetchMarketExecutionInfo('condition', 'token-up');
  assert.deepEqual(info, {
    conditionId: 'condition',
    tokenId: 'token-up',
    tokenVerified: true,
    tickSize: '0.001',
    negRisk: false,
    feeRate: 0.07,
    feeExponent: 1,
    feesEnabled: true,
    minOrderSize: 5,
    acceptingOrders: true,
  });
  await assert.rejects(
    () => feed.fetchMarketExecutionInfo('condition', 'not-a-market-token'),
    /does not belong to condition/,
  );
});
