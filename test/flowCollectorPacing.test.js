'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FlowSocket,
  collectRecentTradePages,
  dataTradesUrl,
  latestSourceWindow,
  makeNonOverlappingTask,
  paperArrivalState,
  sourceCursorCutoff,
} = require('../borg/flow/collector');

test('closed Flow socket drops a queued frame after WAL shutdown', () => {
  let appends = 0;
  const socket = new FlowSocket(0, { append: () => { appends += 1; } }, () => {}, () => {});
  const ws = {};
  socket.ws = ws;
  socket.closed = true;
  socket._message(ws, Buffer.from('{}'));
  assert.equal(appends, 0);
});

test('global trade discovery uses only documented limit/offset parameters', () => {
  const url = new URL(dataTradesUrl(500, 1000));
  assert.equal(url.searchParams.get('limit'), '500');
  assert.equal(url.searchParams.get('offset'), '1000');
  assert.equal(url.searchParams.get('takerOnly'), 'true');
  assert.equal(url.searchParams.has('start'), false);
  assert.equal(url.searchParams.has('end'), false);
});

test('universe activity is anchored to latest API source time, not wall time', () => {
  const result = latestSourceWindow([
    { timestamp: '100', id: 'old' },
    { timestamp: '190', id: 'edge' },
    { timestamp: '280', id: 'latest' },
  ], 90);
  assert.equal(result.latestSourceSec, 280);
  assert.deepEqual(result.trades.map((row) => row.id), ['edge', 'latest']);
});

test('global cursor advances only in API source time', () => {
  assert.equal(sourceCursorCutoff(0), 0);
  assert.equal(sourceCursorCutoff('1784381000'), 1784380998);
});

test('bounded trade pagination stops at the causal cutoff and filters older rows', async () => {
  const pages = [
    [{ timestamp: '105', id: 'a' }, { timestamp: '104', id: 'b' }],
    [{ timestamp: '103', id: 'c' }, { timestamp: '99', id: 'old' }],
  ];
  const calls = [];
  const result = await collectRecentTradePages(async (offset, limit) => {
    calls.push({ offset, limit });
    return pages[calls.length - 1] || [];
  }, { sinceSec: 100, pageSize: 2, maxPages: 4 });

  assert.deepEqual(calls, [{ offset: 0, limit: 2 }, { offset: 2, limit: 2 }]);
  assert.deepEqual(result.trades.map((row) => row.id), ['a', 'b', 'c']);
  assert.equal(result.pages, 2);
  assert.equal(result.oldestSec, 99);
  assert.equal(result.saturated, false);
});

test('bounded trade pagination exposes an explicit coverage gap', async () => {
  const result = await collectRecentTradePages(async (offset) => [
    { timestamp: String(200 - offset), id: `${offset}:a` },
    { timestamp: String(199 - offset), id: `${offset}:b` },
  ], { sinceSec: 100, pageSize: 2, maxPages: 3 });

  assert.equal(result.pages, 3);
  assert.equal(result.saturated, true);
  assert.equal(result.trades.length, 6);
});

test('scheduled Flow work cannot overlap itself', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  let skips = 0;
  const run = makeNonOverlappingTask(async () => {
    calls += 1;
    await gate;
  }, () => { skips += 1; });

  const first = run();
  const second = await run();
  assert.equal(second, false);
  assert.equal(calls, 1);
  assert.equal(skips, 1);
  release();
  assert.equal(await first, true);
});

test('delayed paper arrival parses numeric strings and caps displayed capacity', () => {
  const state = paperArrivalState({
    availableMs: 1_000,
    boundaryMs: 2_000,
    delayMs: 250,
    observedAt: new Date(1_200).toISOString(),
    bestBid: '0.49',
    bidSize: '50',
    bestAsk: '0.50',
    askSize: '100',
    feeRate: '0.0156',
    targetStake: '10',
    touchParticipation: '0.20',
    sourceArmed: true,
    connectionGap: false,
  });

  assert.equal(state.filled, true);
  assert.equal(state.state_age_ms, 50);
  assert.equal(state.fill_price, 0.5);
  assert.equal(state.fill_size, 20);
  assert.equal(state.notional, 10);
  assert.ok(Math.abs(state.entry_fee - 0.078) < 1e-12);
});

test('delayed paper arrival never credits a post-boundary order', () => {
  const state = paperArrivalState({
    availableMs: 1_000,
    boundaryMs: 1_250,
    delayMs: 250,
    observedAt: new Date(1_200).toISOString(),
    bestAsk: '0.50',
    askSize: '100',
    sourceArmed: true,
    connectionGap: false,
  });

  assert.equal(state.filled, false);
  assert.equal(state.reason, 'arrival_at_or_after_resolution_boundary');
});

test('delayed paper arrival enforces the market-published minimum share size', () => {
  const state = paperArrivalState({
    availableMs: 1_000,
    boundaryMs: 2_000,
    delayMs: 250,
    observedAt: new Date(1_200).toISOString(),
    bestBid: '0.89',
    bidSize: '50',
    bestAsk: '0.90',
    askSize: '10',
    minimumOrderSize: '5',
    targetStake: '10',
    touchParticipation: '0.20',
    sourceArmed: true,
    connectionGap: false,
  });

  assert.equal(state.filled, false);
  assert.equal(state.reason, 'below_venue_minimum_size');
  assert.equal(state.candidate_size, 2);
});
