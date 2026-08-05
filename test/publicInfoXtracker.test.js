'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  barrierOutcome,
  barrierTransition,
  certifyTrackingEvent,
  eventSlugFromMarketLink,
  fetchRawJson,
  normalizePost,
  parseCountRange,
  plainText,
} = require('../borg/publicinfo/xtracker');
const { paperBarrierFill } = require('../borg/publicinfo/strategy');
const { normalizeBookSnapshot } = require('../borg/publicinfo/collector');

const ROOT = path.join(__dirname, '..');

test('XTracker market links and count ranges are parsed without price-scale mixing', () => {
  assert.equal(eventSlugFromMarketLink(
    'https://polymarket.com/event/donald-trump-posts-august-4-august-11?x=1',
  ), 'donald-trump-posts-august-4-august-11');
  assert.deepEqual(parseCountRange({ groupItemTitle: '<20' }), { lower: 0, upper: 19, label: '<20' });
  assert.deepEqual(parseCountRange({ groupItemTitle: '80-99' }), { lower: 80, upper: 99, label: '80-99' });
  assert.deepEqual(parseCountRange({ groupItemTitle: '200+' }), { lower: 200, upper: null, label: '200+' });
  assert.deepEqual(parseCountRange({
    question: 'Will Donald Trump post 120-139 Truth Social posts from August 4 to August 11?',
  }), { lower: 120, upper: 139, label: '120-139' });
});

test('resolver certificate fails closed unless exact XTracker monotonic rule text is present', () => {
  const tracking = {
    id: 'tracking-1',
    title: 'Donald Trump # Truth Social posts August 4 - August 11, 2026?',
    marketLink: 'https://polymarket.com/event/trump-truths-august-4-11',
    startDate: '2026-08-04T16:00:00.000Z',
    endDate: '2026-08-11T15:59:59.000Z',
  };
  const event = {
    slug: 'trump-truths-august-4-11',
    title: tracking.title,
    description: 'The Post Counter at https://xtracker.polymarket.com is the resolution source. Deleted posts will count.',
  };
  const certified = certifyTrackingEvent(tracking, event);
  assert.equal(certified.certified, true);
  assert.match(certified.ruleHash, /^[a-f0-9]{64}$/);
  const rejected = certifyTrackingEvent(tracking, { ...event, description: 'Use social media.' });
  assert.equal(rejected.certified, false);
  assert.ok(rejected.reasons.includes('XTRACKER_NOT_PRIMARY_RULE_TEXT'));
  assert.ok(rejected.reasons.includes('MONOTONE_DELETE_RULE_MISSING'));
});

test('only irreversible range transitions create a guaranteed token outcome', () => {
  const finiteRange = { lower: 80, upper: 99 };
  assert.equal(barrierOutcome(99, finiteRange), null);
  assert.deepEqual(barrierTransition(99, 100, finiteRange), {
    outcome: 'No', kind: 'UPPER_BOUND_CROSSED',
  });
  assert.equal(barrierTransition(100, 101, finiteRange), null);
  const openUpper = { lower: 200, upper: null };
  assert.deepEqual(barrierTransition(199, 200, openUpper), {
    outcome: 'Yes', kind: 'OPEN_UPPER_LOWER_BOUND_REACHED',
  });
});

test('normalized posts preserve source, upstream and local clocks plus immutable content', () => {
  const post = normalizePost({
    id: 'post-1',
    platformId: 'native-1',
    content: '<p>Hello &amp; goodbye</p>',
    createdAt: '2026-08-05T12:00:00.000Z',
    importedAt: '2026-08-05T12:02:00.000Z',
    metrics: { favourites_count: 2 },
  }, {
    id: 'source-1', platform: 'TRUTH_SOCIAL', handle: 'realDonaldTrump',
  }, {
    receiveWallMs: Date.parse('2026-08-05T12:02:03.000Z'),
    receiveMonoNs: '123456789',
    envelope: { event_id: 'wal-1' },
  });
  assert.equal(post.contentText, 'Hello & goodbye');
  assert.equal(post.trackerLagMs, 120000);
  assert.equal(post.localPollLagMs, 3000);
  assert.equal(post.rawWalEventId, 'wal-1');
  assert.match(post.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(plainText('<p>A<br>B</p>'), 'A\nB');
});

test('HTTP source response is appended before malformed JSON is rejected', async () => {
  const calls = [];
  const wal = { append(raw, meta) { calls.push({ raw, meta }); return { event_id: 'wal-raw' }; } };
  await assert.rejects(fetchRawJson('https://example.test/source', {
    wal,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{bad json' }),
  }), /invalid JSON/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].raw, '{bad json');
});

test('paper barrier fill walks displayed depth and requires positive doubled-cost stress', () => {
  const profitable = paperBarrierFill({
    book: {
      asks: [[0.90, 5], [0.91, 10]],
      bids: [[0.88, 10]],
    },
    targetUsd: 9,
    minimumOrderSize: 5,
    tickSize: 0.01,
    feeRate: 0.07,
    feeExponent: 1,
    sourceRiskReserve: 0.01,
  });
  assert.equal(profitable.qualified, true);
  assert.ok(profitable.requestedShares > 9);
  assert.ok(profitable.averageFillPrice > 0.90);
  assert.ok(profitable.stressedTerminalPnlUsd > 0);

  const tooExpensive = paperBarrierFill({
    book: { asks: [[0.995, 100]], bids: [[0.99, 100]] },
    targetUsd: 10,
    tickSize: 0.01,
    sourceRiskReserve: 0.01,
  });
  assert.equal(tooExpensive.qualified, false);
  assert.equal(tooExpensive.reason, 'NON_POSITIVE_STRESSED_EDGE');

  const noDepth = paperBarrierFill({
    book: { asks: [[0.90, 1]], bids: [[0.89, 1]] },
    targetUsd: 10,
    minimumOrderSize: 5,
  });
  assert.equal(noDepth.reason, 'INSUFFICIENT_DISPLAYED_DEPTH');
});

test('execution confirmation parses every CLOB decimal string before use', () => {
  const book = normalizeBookSnapshot({
    timestamp: '2026-08-05T12:00:00.000Z',
    bids: [{ price: '0.87', size: '4.5' }, { price: '0.88', size: '2' }],
    asks: [{ price: '0.92', size: '6' }, { price: '0.91', size: '3.5' }],
    hash: 'book-hash',
  }, Date.parse('2026-08-05T12:00:00.100Z'));
  assert.deepEqual(book.bids, [[0.88, 2], [0.87, 4.5]]);
  assert.deepEqual(book.asks, [[0.91, 3.5], [0.92, 6]]);
  assert.equal(book.hash, 'book-hash');
});

test('public-information service and collector remain paper-only', () => {
  const collector = fs.readFileSync(path.join(ROOT, 'borg/publicinfo/collector.js'), 'utf8');
  const service = fs.readFileSync(path.join(ROOT, 'ops/vps/borg-public-info.service'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'borg/experiments/xtracker-resolver-count-barrier-v1.json'), 'utf8',
  ));
  assert.doesNotMatch(collector, /createAndPostOrder|privateKey|Wallet\s*\(/);
  assert.match(collector, /paperOnly:\s*true/);
  assert.match(service, /PUBLIC_INFO_PLATFORMS=TRUTH_SOCIAL/);
  assert.equal(manifest.paper_only, true);
  assert.equal(manifest.live_order_path, 'disabled');
  assert.equal(manifest.promotion_contract.minimum_fresh_independent_tracking_windows, 300);
});
