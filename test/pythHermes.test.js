'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  HermesPythStream, SseDecoder, extractExactPythFeedSymbol,
  parseHermesUpdate, pythValue,
} = require('../borg/pyth/hermes');

test('exact Pyth feed identity comes only from an explicit explore path', () => {
  assert.equal(extractExactPythFeedSymbol(
    'Resolution: https://pythdata.app/explore/Equity.US.GOOGL%2FUSD?t=123',
  ), 'Equity.US.GOOGL/USD');
  assert.equal(extractExactPythFeedSymbol(
    'Resolution: https://pythdata.app/explore?search=WTI',
  ), null);
});

test('Hermes parsed prices preserve the exact feed id and source clock', () => {
  const id = 'a'.repeat(64);
  const rows = parseHermesUpdate(JSON.stringify({ parsed: [{
    id,
    price: { price: '30411591', conf: '16267', expo: -5, publish_time: 1785786623 },
    metadata: { proof_available_time: 1785786624 },
  }] }), new Map([[id, { symbol: 'GOOGL', feedSymbol: 'Equity.US.GOOGL/USD' }]]), {
    receiveWallMs: 1785786624500,
    receiveMonoNs: '100',
    connectionEpoch: 2,
    eventSequence: 7,
  });
  assert.equal(rows.length, 1);
  assert.ok(Math.abs(rows[0].value - 304.11591) < 1e-10);
  assert.ok(Math.abs(rows[0].confidence - 0.16267) < 1e-10);
  assert.equal(rows[0].sourceMs, 1785786623000);
  assert.equal(rows[0].providerReceivedMs, 1785786624000);
  assert.equal(rows[0].feedId, id);
  assert.equal(rows[0].transportSource, 'pyth-hermes-core');
  assert.equal(pythValue({ price: '1', expo: -2 }), 0.01);
});

test('SSE decoder preserves split JSON events and ignores comments', () => {
  const decoder = new SseDecoder();
  assert.deepEqual(decoder.push(': keepalive\n\ndata:{"a"'), []);
  assert.deepEqual(decoder.push(':1}\n\ndata: {"b":2}\r\n\r\n'), [
    '{"a":1}', '{"b":2}',
  ]);
});

test('Hermes catalog resolution is exact and never selects session variants', async () => {
  const regularId = 'b'.repeat(64);
  const postId = 'c'.repeat(64);
  const duplicateOne = 'd'.repeat(64);
  const duplicateTwo = 'e'.repeat(64);
  const walRows = [];
  const stream = new HermesPythStream({
    wal: { append: (raw, meta) => { walRows.push({ raw, meta }); return {}; } },
    fetchImpl: async () => ({
      ok: true,
      text: async () => JSON.stringify([
        { id: postId, attributes: { symbol: 'Equity.US.GOOGL/USD.POST' } },
        { id: regularId, attributes: { symbol: 'Equity.US.GOOGL/USD' } },
        { id: duplicateOne, attributes: { symbol: 'Equity.US.AAPL/USD' } },
        { id: duplicateTwo, attributes: { symbol: 'Equity.US.AAPL/USD' } },
      ]),
    }),
  });
  const selection = await stream.setFeeds([
    { symbol: 'GOOGL', feedSymbol: 'Equity.US.GOOGL/USD' },
    { symbol: 'WTI', feedSymbol: 'Commodities.UNKNOWN/USD' },
    { symbol: 'AAPL', feedSymbol: 'Equity.US.AAPL/USD' },
  ]);
  assert.equal(selection.resolved, 1);
  assert.deepEqual(selection.unresolved, ['Commodities.UNKNOWN/USD', 'Equity.US.AAPL/USD']);
  assert.equal(stream.feedById.has(regularId), true);
  assert.equal(stream.feedById.has(postId), false);
  assert.equal(walRows.length, 1);
  assert.match(walRows[0].raw, /exactMatchOnly/);

  const now = 1785787000000;
  stream.latest.set('GOOGL', { receiveWallMs: now, sourceMs: now - 60_000 });
  assert.equal(stream.health(now).coveredFeeds, 0,
    'a repeatedly delivered stale source value is not live feed coverage');
});

test('Hermes catalog transport failures are counted and fail closed', async () => {
  const stream = new HermesPythStream({
    fetchImpl: async () => { throw new Error('catalog unavailable'); },
  });
  await assert.rejects(
    stream.setFeeds([{ symbol: 'GOOGL', feedSymbol: 'Equity.US.GOOGL/USD' }]),
    /catalog unavailable/,
  );
  assert.equal(stream.metrics.catalogFailures, 1);
  assert.equal(stream.feedById.size, 0);
});
