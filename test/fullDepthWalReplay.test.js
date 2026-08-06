'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  FULL_DEPTH_REPLAY_VERSION,
  FullDepthWalReconstructor,
  adverseFillStress,
  attachPnl,
  orderAssetId,
  summarizeFullDepthReplays,
  walkDepth,
} = require('../borg/research/full-depth-wal-replay');
const {
  acquireArchiveLock,
  assertRemoteRunIdentity,
  coalesceWindows,
  parseProfiles,
  parseSegmentStart,
  selectSegments,
  stagingTraversalArgs,
  utcDaysBetween,
} = require('../scripts/h43-full-depth-replay');

const BASE = Date.parse('2026-08-06T12:00:00.000Z');
const order = {
  id: '43', market_id: '91', side: 'BUY', token: 'UP',
  positive_label: 'Up', price: '0.56', size: '10',
  up_token_id: 'up-asset', down_token_id: 'down-asset',
  outcome: 'UP', order_kind: 'taker',
};

function envelope(sequence, shard, raw, offsetMs = sequence, overrides = {}) {
  return {
    event_id: `event-${sequence}`,
    collector_run_id: 'run-one',
    receive_wall_timestamp_ms: BASE + offsetMs,
    receive_monotonic_ns: String(10_000 + sequence),
    connection_epoch: 1,
    connection_shard: shard,
    event_sequence: sequence,
    raw: typeof raw === 'string' ? raw : JSON.stringify(raw),
    ...overrides,
  };
}

function book(asset = 'up-asset', asks = [['0.54', '4'], ['0.55', '9']], bids = [['0.53', '8']]) {
  return { event_type: 'book', asset_id: asset, timestamp: String(BASE), asks, bids };
}

test('asset selection handles positive and negative labels without stringifying undefined', () => {
  assert.equal(orderAssetId(order), 'up-asset');
  assert.equal(orderAssetId({ ...order, token: 'DOWN' }), 'down-asset');
  assert.equal(orderAssetId({ ...order, up_token_id: null }), '');
});

test('full-depth walk parses decimal strings, consumes levels and limits partial size', () => {
  const state = { asks: [['0.54', '4'], ['0.55', '9'], ['0.57', '20']], bids: [] };
  const fill = walkDepth(order, state);
  assert.equal(fill.filled, true);
  assert.equal(fill.full, true);
  assert.equal(fill.fillSize, 10);
  assert.equal(fill.levelsConsumed, 2);
  assert.ok(Math.abs(fill.fillPrice - 0.546) < 1e-12);
  assert.equal(fill.availableSize, 13);

  const partial = walkDepth({ ...order, size: '20' }, state);
  assert.equal(partial.partial, true);
  assert.equal(partial.fillSize, 13);
});

test('one-tick stress shifts executable depth pessimistically', () => {
  const state = { asks: [[0.54, 4], [0.55, 9]], bids: [] };
  const exact = walkDepth({ ...order, price: 0.55 }, state);
  const stressed = walkDepth({ ...order, price: 0.55 }, state, { tickSize: 0.01 });
  assert.equal(exact.fillSize, 10);
  assert.equal(stressed.fillSize, 4);
  assert.equal(stressed.partial, true);
  assert.equal(stressed.fillPrice, 0.55);
});

test('execution PnL stress preserves the filled quantity and is monotone adverse', () => {
  const exact = walkDepth({ ...order, price: 0.55 }, {
    asks: [[0.54, 4], [0.55, 9]], bids: [],
  });
  const stressed = adverseFillStress(order, exact, 0.01);
  assert.equal(stressed.fillSize, exact.fillSize);
  assert.ok(stressed.fillPrice > exact.fillPrice);
  assert.equal(stressed.stressBasis, 'fixed_executed_quantity');

  const replay = new FullDepthWalReconstructor();
  replay.applyEnvelope(envelope(1, 0, book(), 10));
  const result = replay.replay(order, BASE + 100);
  assert.equal(result.detail.one_tick_stress.fillSize, result.fillSize);
  const winner = attachPnl(order, result);
  const loser = attachPnl({ ...order, outcome: 'DOWN' }, result);
  assert.ok(winner.pnl2xOneTick <= winner.pnl2x);
  assert.ok(loser.pnl2xOneTick <= loser.pnl2x);
});

test('two agreeing redundant paths produce an A-grade causal L4 fill', () => {
  const replay = new FullDepthWalReconstructor();
  replay.applyEnvelope(envelope(1, 0, book(), 10));
  replay.applyEnvelope(envelope(2, 1, book(), 20));
  replay.applyEnvelope(envelope(3, 0, 'PONG', 80));
  replay.applyEnvelope(envelope(4, 1, 'PONG', 90));
  const result = replay.replay(order, BASE + 100);
  assert.equal(result.replayVersion, FULL_DEPTH_REPLAY_VERSION);
  assert.equal(result.executionState, 'ELIGIBLE_FILL');
  assert.equal(result.fillSize, 10);
  assert.ok(Math.abs(result.fillPrice - 0.546) < 1e-12);
  assert.equal(result.dataQualityGrade, 'A');
  assert.equal(result.executionFidelityGrade, 'A');
  assert.equal(result.fidelityLevel, 'L4');
  assert.equal(result.detail.path_count, 2);
});

test('one valid path is B-grade and disagreeing redundant paths fail closed', () => {
  const onePath = new FullDepthWalReconstructor();
  onePath.applyEnvelope(envelope(1, 0, book(), 10));
  const valid = onePath.replay(order, BASE + 100);
  assert.equal(valid.executionState, 'ELIGIBLE_FILL');
  assert.equal(valid.dataQualityGrade, 'B');

  const divergent = new FullDepthWalReconstructor();
  divergent.applyEnvelope(envelope(1, 0, book(), 10));
  divergent.applyEnvelope(envelope(2, 1, book('up-asset', [['0.56', '20']]), 20));
  const rejected = divergent.replay(order, BASE + 100);
  assert.equal(rejected.executionState, 'INVALID_REDUNDANT_PATH_DIVERGENCE');
  assert.equal(rejected.dataQualityGrade, 'F');
});

test('raw sequence gaps invalidate prior state until a fresh full book arrives', () => {
  const replay = new FullDepthWalReconstructor();
  replay.applyEnvelope(envelope(1, 0, book(), 10));
  replay.applyEnvelope(envelope(3, 0, 'PONG', 30));
  const invalid = replay.replay(order, BASE + 40);
  assert.equal(invalid.executionState, 'UNSCOREABLE_FULL_DEPTH_BOOK');
  assert.equal(invalid.detail.sequence_gaps_seen, 1);

  replay.applyEnvelope(envelope(4, 0, book(), 50));
  const recovered = replay.replay(order, BASE + 60);
  assert.equal(recovered.executionState, 'ELIGIBLE_FILL');
});

test('an intentional bounded-window reset is not counted as a raw sequence gap', () => {
  const replay = new FullDepthWalReconstructor();
  replay.applyEnvelope(envelope(100, 0, book(), 10));
  replay.beginSelectionWindow();
  replay.applyEnvelope(envelope(900, 0, book(), 50));
  assert.equal(replay.sequenceGaps, 0);
  assert.equal(replay.replay(order, BASE + 60).executionState, 'ELIGIBLE_FILL');
});

test('future-applied state and stale transport are never treated as genuine non-fills', () => {
  const future = new FullDepthWalReconstructor();
  future.applyEnvelope(envelope(1, 0, book(), 200));
  assert.equal(future.replay(order, BASE + 100).executionState, 'UNSCOREABLE_FULL_DEPTH_BOOK');

  const stale = new FullDepthWalReconstructor({ maxTransportSilenceMs: 50 });
  stale.applyEnvelope(envelope(1, 0, book(), 10));
  assert.equal(stale.replay(order, BASE + 100).executionState, 'UNSCOREABLE_FULL_DEPTH_BOOK');
});

test('PnL and summaries exclude unscoreable rows while retaining partial fills', () => {
  const replay = new FullDepthWalReconstructor();
  replay.applyEnvelope(envelope(1, 0, book(), 10));
  const filled = attachPnl(order, replay.replay(order, BASE + 100));
  assert.ok(filled.pnl2x > 0);
  const rows = [
    { ...filled, orderId: '43', marketId: '91', latencyMs: 100 },
    {
      orderId: '44', marketId: '92', latencyMs: 100,
      executionState: 'PROVEN_NONFILL', dataQualityGrade: 'B',
      detail: {}, pnl1x: 0, pnl2x: 0, pnl2xOneTick: 0,
    },
    {
      orderId: '45', marketId: '93', latencyMs: 100,
      executionState: 'UNSCOREABLE_ARCHIVE_MISSING', dataQualityGrade: 'F',
      detail: {}, pnl1x: 999, pnl2x: 999, pnl2xOneTick: 999,
    },
  ];
  const summary = summarizeFullDepthReplays(rows, [100])[0];
  assert.equal(summary.intents, 3);
  assert.equal(summary.scoreable, 2);
  assert.equal(summary.fullFills, 1);
  assert.equal(summary.provenNonfills, 1);
  assert.equal(summary.unscoreable, 1);
  assert.equal(summary.pnl2x, filled.pnl2x);
  assert.deepEqual(summary.rejectionReasons, { UNSCOREABLE_ARCHIVE_MISSING: 1 });
});

test('archive selector parses WAL names, coalesces windows and retains the predecessor', () => {
  const stamp = (seconds) => ({
    relative: `2026-08-06/2026-08-06T12-00-${String(seconds).padStart(2, '0')}-000Z__host__1__1.ndjson.gz`,
    startMs: BASE + seconds * 1000,
  });
  assert.equal(parseSegmentStart(stamp(5).relative), BASE + 5000);
  const merged = coalesceWindows([
    { startMs: BASE + 20_000, endMs: BASE + 30_000 },
    { startMs: BASE + 25_000, endMs: BASE + 40_000 },
  ]);
  assert.deepEqual(merged, [{ startMs: BASE + 20_000, endMs: BASE + 40_000 }]);
  const selected = selectSegments(
    [stamp(0), stamp(10), stamp(20), stamp(30), stamp(50)],
    [{ startMs: BASE + 25_000, endMs: BASE + 35_000 }],
  );
  assert.deepEqual(selected.map((row) => row.startMs), [BASE + 20_000, BASE + 30_000]);
});

test('CLI profile and UTC-day parsing is deterministic and bounded', () => {
  assert.deepEqual(parseProfiles('500,100,250,100,-1,10001,nope'), [100, 250, 500]);
  assert.deepEqual(
    utcDaysBetween(Date.parse('2026-08-05T23:59:00Z'), Date.parse('2026-08-07T00:01:00Z')),
    ['2026-08-05', '2026-08-06', '2026-08-07'],
  );
});

test('archive lease releases cleanly before a second remote reader proceeds', async (t) => {
  if (!fs.existsSync('/usr/bin/flock')) return t.skip('flock is unavailable');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-archive-lock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const options = {
    source: 'remote',
    archiveLockFile: path.join(directory, 'archive.lock'),
    archiveLockWaitSec: 2,
  };
  const first = await acquireArchiveLock(options);
  assert.equal(first.acquired, true);
  await first.release();
  const second = await acquireArchiveLock(options);
  assert.equal(second.acquired, true);
  await second.release();
});

test('remote replay refuses root so OAuth refresh cannot lock out production', () => {
  assert.throws(
    () => assertRemoteRunIdentity({ source: 'remote', processUid: 0 }),
    /service user, not root/,
  );
  assert.doesNotThrow(
    () => assertRemoteRunIdentity({ source: 'remote', processUid: 1000 }),
  );
  assert.doesNotThrow(
    () => assertRemoteRunIdentity({ source: 'local', processUid: 0 }),
  );
});

test('large or resumed archive sets use recursive listing instead of one API lookup per object', () => {
  assert.deepEqual(stagingTraversalArgs(20, 500), ['--no-traverse']);
  assert.deepEqual(stagingTraversalArgs(500, 500), ['--fast-list']);
  assert.deepEqual(stagingTraversalArgs(1_544, 500), ['--fast-list']);
});
