'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  compareContracts, evaluateBasisPair, evaluatePair, kalshiTakerFee, normalizeKalshiBook,
  optimizePair,
} = require('../borg/crossvenue/strategy');
const {
  buildCandidates, fetchJson, loadManualIdentityReviews, parseManualIdentityReviews,
  normalizeKalshiMarket, selectMonitoredCandidates,
} = require('../borg/crossvenue/universe');
const { summarizeConvergence } = require('../borg/crossvenue/convergence');
const { KalshiReadOnlyFeed, signHandshake } = require('../borg/crossvenue/kalshi-ws');
const {
  CROSSVENUE_RELATION_TYPES, compileCrossVenueRelation,
} = require('../borg/crossvenue/payoff-relations');
const {
  closeRelationEpisode, relationEpisodeId, updateRelationEpisode,
} = require('../borg/crossvenue/relation-episodes');
const {
  appendHistory, selectSynchronizedBooks,
} = require('../borg/crossvenue/synchronizer');
const {
  certifyIdentityBinding, ruleDocuments,
} = require('../borg/crossvenue/identity-certifier');
const {
  chunkKalshiTickers, KALSHI_ORDERBOOK_BATCH_SIZE,
} = require('../borg/crossvenue/collector');

test('cross-venue identity approval is bound to immutable rule hashes', () => {
  const poly = {
    conditionId: 'condition', gammaId: 'gamma', question: 'Will X happen?',
    description: 'Resolves Yes under rule A.', endDate: '2026-08-01T00:00:00Z',
  };
  const kalshi = {
    ticker: 'KXX-26', eventTicker: 'KXX', title: 'Will X happen?',
    rulesPrimary: 'Resolves Yes under rule A.', closeTime: '2026-08-01T00:00:00Z',
  };
  const rules = ruleDocuments(poly, kalshi);
  const review = {
    reviewed: true, approved: true, reviewedAt: '2026-07-18T00:00:00Z',
    ruleBinding: { snapshotHash: rules.snapshotHash },
  };
  assert.equal(certifyIdentityBinding(poly, kalshi, review).valid, true);
  const changed = certifyIdentityBinding({ ...poly, description: 'Resolves Yes under rule B.' }, kalshi, review);
  assert.equal(changed.valid, false);
  assert.ok(changed.reasons.includes('IDENTITY_SNAPSHOT_HASH_MISMATCH'));
  assert.equal(certifyIdentityBinding(poly, kalshi, { reviewed: true, approved: true }).valid, false);
});

test('book pairing uses only causal states inside the frozen receive-skew bound', () => {
  const book = (price) => ({ YES: { bids: [[price - 0.01, 10]], asks: [[price, 10]] },
    NO: { bids: [[0.99 - price, 10]], asks: [[1 - price, 10]] } });
  let poly = [];
  let kalshi = [];
  poly = appendHistory(poly, { receivedAt: 1000, books: book(0.40) }, { nowMs: 1100 });
  poly = appendHistory(poly, { receivedAt: 1300, books: book(0.42) }, { nowMs: 1300 });
  kalshi = appendHistory(kalshi, { receivedAt: 1080, books: book(0.41) }, { nowMs: 1100 });
  kalshi = appendHistory(kalshi, { receivedAt: 1400, books: book(0.43) }, { nowMs: 1400 });
  const causal = selectSynchronizedBooks({
    polyHistory: poly, kalshiHistory: kalshi, cutoffAt: 1200,
    maxSkewMs: 100, maxAgeMs: 500,
  });
  assert.equal(causal.synchronized, true);
  assert.equal(causal.poly.receivedAt, 1000);
  assert.equal(causal.kalshi.receivedAt, 1080);
  assert.equal(causal.pairSkewMs, 80);
  const unsynchronized = selectSynchronizedBooks({
    polyHistory: [{ receivedAt: 1000, books: book(0.4) }],
    kalshiHistory: [{ receivedAt: 1300, books: book(0.4) }],
    cutoffAt: 1400, maxSkewMs: 100, maxAgeMs: 1000,
  });
  assert.equal(unsynchronized.synchronized, false);
  assert.equal(unsynchronized.reason, 'PAIR_SKEW_EXCEEDED');
  const cannotUnsee = selectSynchronizedBooks({
    polyHistory: [
      { receivedAt: 1000, books: book(0.4) },
      { receivedAt: 1500, books: book(0.2) },
    ],
    kalshiHistory: [{ receivedAt: 1020, books: book(0.4) }],
    cutoffAt: 1550, maxSkewMs: 100, maxAgeMs: 1000,
  });
  assert.equal(cannotUnsee.synchronized, false);
  assert.equal(cannotUnsee.poly.receivedAt, 1500);
});

test('contract discovery never turns text similarity into automatic approval', () => {
  const audit = compareContracts({
    question: 'Will Bitcoin be above $100,000 on July 31, 2026?',
    endDate: '2026-07-31T23:59:00Z',
  }, {
    title: 'Will Bitcoin be above $100,000 on July 31, 2026?',
    expectedExpirationTime: '2026-07-31T23:59:00Z',
  });
  assert.ok(audit.score >= 0.8);
  assert.equal(audit.identityStatus, 'STRONG_CANDIDATE');
  assert.equal('identityApproved' in audit, false);
});

test('Kalshi event context survives compact normalization for full-universe matching', () => {
  const market = normalizeKalshiMarket({
    ticker: 'KXEXAMPLE-26-ALICE', event_ticker: 'KXEXAMPLE-26', market_type: 'binary',
    title: 'Will Alice win?', yes_sub_title: 'Alice', no_sub_title: 'Alice',
    rules_primary: 'If Alice wins, this resolves Yes.', status: 'active',
  }, {
    event_ticker: 'KXEXAMPLE-26', series_ticker: 'KXEXAMPLE',
    title: 'Who will win the example election?', sub_title: 'In 2026',
    category: 'Elections', mutually_exclusive: true,
    settlement_sources: [{ name: 'Official results', url: 'https://example.gov/results' }],
  });
  assert.equal(market.eventTitle, 'Who will win the example election?');
  assert.equal(market.eventSubTitle, 'In 2026');
  assert.equal(market.category, 'Elections');
  assert.equal(market.mutuallyExclusive, true);
  assert.equal(market.settlementSources[0].url, 'https://example.gov/results');
});

test('public-universe requests retry a rate limit without treating it as empty coverage', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) return {
      ok: false, status: 429, headers: { get: () => '0' },
      text: async () => '{"error":"too many requests"}',
    };
    return {
      ok: true, status: 200, headers: { get: () => null },
      text: async () => '{"events":[],"cursor":null}',
    };
  };
  try {
    const result = await fetchJson('https://example.test/events', {}, 1000, {
      maxAttempts: 2, baseDelayMs: 1,
    });
    assert.equal(calls, 2);
    assert.deepEqual(result.payload, { events: [], cursor: null });
  } finally { global.fetch = originalFetch; }
});

test('different thresholds are rejected even when titles otherwise overlap', () => {
  const audit = compareContracts({
    question: 'Will Bitcoin be above $100,000 on July 31, 2026?',
    endDate: '2026-07-31T23:59:00Z',
  }, {
    title: 'Will Bitcoin be above $110,000 on July 31, 2026?',
    expectedExpirationTime: '2026-07-31T23:59:00Z',
  });
  assert.equal(audit.identityStatus, 'REJECTED');
  assert.ok(audit.mismatches.includes('NUMERIC_OR_THRESHOLD_MISMATCH'));
});

test('family reviews can reject shared rule templates but can never approve them', () => {
  assert.throws(() => parseManualIdentityReviews({
    matches: [],
    rejectionFamilies: [{
      id: 'unsafe-family-approval', approved: true,
      polyEventTitle: 'Example', kalshiEventTicker: 'KXEXAMPLE', reasonCodes: ['TEST'],
    }],
  }), /cannot approve contracts/);

  const reviews = loadManualIdentityReviews();
  // 2026-07-19 operator review: people-sexiest-man-fallbacks family rejection
  // superseded by two exact-id approvals bound to rule hashes (see the
  // resolutionAudit of each match entry, which preserves the family verbatim).
  assert.equal(reviews.rejectionFamilies.length, 51);
  assert.equal(reviews.matches.length, 2);
  assert.equal(reviews.relations.length, 1);
  for (const match of reviews.matches) {
    assert.equal(match.approved, true);
    assert.ok(match.ruleBinding?.snapshotHash, 'approvals must be hash-bound');
  }
});

test('frozen Corales rule audit marks matching player labels manually rejected', () => {
  const rows = buildCandidates([{
    conditionId: 'poly-corales-nn',
    question: 'Will Niklas Norgaard Moller win the 2026 Corales Puntacana Championship?',
    eventTitle: 'PGA Tour: Corales Puntacana Championship Winner',
    description: 'Winner by July 25 or Other.', endDate: '2026-07-19T00:00:00Z',
    volume24h: 0,
  }], [{
    ticker: 'KXPGATOUR-COPC26-NNOR', eventTicker: 'KXPGATOUR-COPC26',
    title: 'Will Niklas Norgaard Moller win the Corales Puntacana Championship?',
    yesSubTitle: 'Niklas Norgaard Moller', expectedExpirationTime: '2026-07-19T00:00:00Z',
    volume24h: 0,
  }], { maxCandidates: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].identityStatus, 'MANUALLY_REJECTED');
  assert.equal(rows[0].identityApproved, false);
  assert.equal(rows[0].approvalSource, 'frozen_family_review');
  assert.equal(rows[0].resolutionAudit.reviewId, 'golf-corales-winner-fallbacks');
  assert.ok(rows[0].mismatches.includes('NO_RESULT_DEADLINE_MISMATCH'));
});

test('winner contracts cannot match top-finish contracts for the same player and event', () => {
  const audit = compareContracts({
    question: 'Will Alice Smith finish in the Top 10 at the Example Championship?',
    endDate: '2026-07-19T00:00:00Z',
  }, {
    title: 'Will Alice Smith win the Example Championship?',
    expectedExpirationTime: '2026-07-19T00:00:00Z',
  });
  assert.equal(audit.identityStatus, 'REJECTED');
  assert.ok(audit.mismatches.includes('OUTCOME_PREDICATE_MISMATCH'));
});

test('candidate screening rejects exact-score, wrong-participant, and settlement-template cross-products', () => {
  const exactScore = compareContracts({
    question: 'Exact Score: Bay FC 1 - 0 North Carolina Courage?',
    eventTitle: 'Bay FC vs. North Carolina Courage - Exact Score',
    description: 'NWSL exact score market.', endDate: '2026-07-18T20:00:00Z',
  }, {
    title: 'Bay FC vs North Carolina Courage Winner?', yesSubTitle: 'Bay FC',
    rulesPrimary: 'If Bay FC wins after 90 minutes, the market resolves to Yes.',
    rulesSecondary: 'Professional NWSL soccer game.',
    expectedExpirationTime: '2026-07-18T23:00:00Z',
  });
  assert.equal(exactScore.identityStatus, 'REJECTED');
  assert.ok(exactScore.mismatches.includes('OUTCOME_PREDICATE_MISMATCH'));

  const wrongPlayer = compareContracts({
    question: 'Will Kevin Yu win the Example Championship?',
    eventTitle: 'Example Championship Winner', endDate: '2026-07-19T00:00:00Z',
  }, {
    title: 'Will Kevin Roy win the Example Championship?', yesSubTitle: 'Kevin Roy',
    rulesPrimary: 'If Kevin Roy wins the Example Championship, this resolves Yes.',
    expectedExpirationTime: '2026-07-19T00:00:00Z',
  });
  assert.equal(wrongPlayer.identityStatus, 'REJECTED');
  assert.ok(wrongPlayer.mismatches.includes('OUTCOME_PARTICIPANT_MISMATCH'));

  const cancellation = compareContracts({
    question: 'Will Bay FC win on 2026-07-18?', eventTitle: 'Bay FC vs. North Carolina Courage',
    description: 'If the game is postponed, this market will remain open. If the game is canceled entirely, this market will resolve to No. NWSL soccer.',
    endDate: '2026-07-18T20:00:00Z',
  }, {
    title: 'Bay FC vs North Carolina Courage Winner?', yesSubTitle: 'Bay FC',
    rulesPrimary: 'If Bay FC wins the professional NWSL soccer game, this resolves Yes.',
    rulesSecondary: 'If the game is cancelled or rescheduled to over two weeks away, the market will resolve to a fair price.',
    expectedExpirationTime: '2026-07-18T23:00:00Z',
  });
  assert.equal(cancellation.identityStatus, 'REJECTED');
  assert.ok(cancellation.mismatches.includes('CANCELLATION_RESCHEDULE_RULE_MISMATCH'));
});

test('Kalshi YES and NO bids produce the correct opposite executable asks', () => {
  const books = normalizeKalshiBook({ orderbook_fp: {
    yes_dollars: [['0.44', '20'], ['0.40', '30']],
    no_dollars: [['0.53', '12'], ['0.50', '40']],
  } });
  assert.deepEqual(books.YES.asks[0], [0.47, 12]);
  assert.deepEqual(books.NO.asks[0], [0.56, 20]);
  assert.equal(books.YES.bids[0][0], 0.44);
  assert.equal(books.NO.bids[0][0], 0.53);
});

test('read-only Kalshi handshake uses RSA-PSS SHA256 over the documented path', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const timestamp = '1784300000000';
  const signature = Buffer.from(signHandshake(timestamp, privateKey.export({ type: 'pkcs8', format: 'pem' })), 'base64');
  assert.equal(crypto.verify('sha256', Buffer.from(`${timestamp}GET/trade-api/ws/v2`), {
    key: publicKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  }, signature), true);
});

test('read-only Kalshi stream appends raw frames before applying snapshot and deltas', () => {
  const order = []; const updates = [];
  const feed = new KalshiReadOnlyFeed({
    wal: { append: () => { order.push('wal'); return { event_id: 'wal-id' }; } },
    onBook: (state) => { order.push('book'); updates.push(state); },
  });
  feed.setTickers(['KXTEST']);
  feed.handleFrame(JSON.stringify({
    type: 'orderbook_snapshot', sid: 2, seq: 1,
    msg: { market_ticker: 'KXTEST', yes_dollars_fp: [['0.44', '20']], no_dollars_fp: [['0.53', '12']] },
  }));
  feed.handleFrame(JSON.stringify({
    type: 'orderbook_delta', sid: 2, seq: 2,
    msg: { market_ticker: 'KXTEST', side: 'yes', price_dollars: '0.44', delta_fp: '5', ts_ms: Date.now() },
  }));
  assert.deepEqual(order, ['wal', 'book', 'wal', 'book']);
  assert.deepEqual(updates[0].books.YES.asks[0], [0.47, 12]);
  assert.deepEqual(updates[1].books.YES.bids[0], [0.44, 25]);
  assert.equal(updates[1].transport, 'authenticated_readonly_ws');
  feed.close();
});

test('read-only Kalshi stream discards a sequence gap instead of applying it', () => {
  const feed = new KalshiReadOnlyFeed();
  feed.setTickers(['KXTEST']);
  feed.handleFrame(JSON.stringify({
    type: 'orderbook_snapshot', sid: 2, seq: 1,
    msg: { market_ticker: 'KXTEST', yes_dollars_fp: [['0.44', '20']], no_dollars_fp: [['0.53', '12']] },
  }));
  feed.handleFrame(JSON.stringify({
    type: 'orderbook_delta', sid: 2, seq: 3,
    msg: { market_ticker: 'KXTEST', side: 'yes', price_dollars: '0.44', delta_fp: '5' },
  }));
  assert.equal(feed.metrics.sequenceGaps, 1);
  assert.equal(feed.books.has('KXTEST'), false);
  feed.close();
});

test('Kalshi taker fee follows the current quadratic fee formula and centicent rounding', () => {
  assert.equal(kalshiTakerFee([{ price: 0.5, size: 100 }]), 1.75);
  assert.equal(kalshiTakerFee([{ price: 0.5, size: 1 }]), 0.0175);
});

test('video-style opposite-side lock reports return on deployed cash, not payout', () => {
  const rows = evaluatePair({
    quantities: [1], kalshiFeeMultiplier: 0, polyFeeRate: 0,
    polyBooks: {
      YES: { asks: [[0.60, 10]], bids: [[0.59, 10]] },
      NO: { asks: [[0.41, 10]], bids: [[0.40, 10]] },
    },
    kalshiBooks: {
      YES: { asks: [[0.66, 10]], bids: [[0.65, 10]] },
      NO: { asks: [[0.35, 10]], bids: [[0.34, 10]] },
    },
  });
  const row = rows.find((value) => value.direction === 'POLY_YES+KALSHI_NO');
  assert.equal(row.totalCost, 0.95);
  assert.ok(Math.abs(row.lockedProfitAfterBothFills - 0.05) < 1e-12);
  assert.ok(Math.abs(row.rawRoiPct - (100 * 0.05 / 0.95)) < 1e-10);
});

test('bankroll optimizer uses equal payout shares and executable depth', () => {
  const rows = optimizePair({
    quantities: [5, 10, 25, 100], minQuantity: 5, maxQuantity: 1000,
    totalCapitalUsd: 50, polyCapitalUsd: 25, kalshiCapitalUsd: 25,
    kalshiFeeMultiplier: 0, polyFeeRate: 0, polyTick: 0.01, kalshiTick: 0.01,
    polyBooks: {
      YES: { asks: [[0.40, 1000]], bids: [[0.39, 1000]] },
      NO: { asks: [[0.62, 1000]], bids: [[0.61, 1000]] },
    },
    kalshiBooks: {
      YES: { asks: [[0.63, 1000]], bids: [[0.62, 1000]] },
      NO: { asks: [[0.50, 1000]], bids: [[0.49, 1000]] },
    },
  });
  const row = rows.find((value) => value.direction === 'POLY_YES+KALSHI_NO');
  assert.equal(row.quantity, 50);
  assert.equal(row.polyCashRequired, 20);
  assert.equal(row.kalshiCashRequired, 25);
  assert.equal(row.totalCost, 45);
  assert.equal(row.lockedProfitAfterBothFills, 5);
  assert.equal(row.capacityLimitedBy, 'BANKROLL');
  assert.equal(row.sizingMethod, 'EQUAL_PAYOUT_DEPTH_BANKROLL_OPTIMIZED');
  assert.ok(row.worstImmediateOrphanUnwindPnl < 0);
});

test('reviewed mismatches may be sampled only as bounded diagnostic controls', () => {
  const candidates = [
    { matchId: 'approved', identityApproved: true, identityStatus: 'MANUALLY_APPROVED' },
    { matchId: 'pending', identityApproved: false, identityStatus: 'CANDIDATE' },
    { matchId: 'rejected-a', identityApproved: false, identityStatus: 'MANUALLY_REJECTED' },
    { matchId: 'rejected-b', identityApproved: false, identityStatus: 'REJECTED' },
  ];
  const selection = selectMonitoredCandidates(candidates, 4, 1);
  assert.deepEqual(selection.monitored.map((row) => row.matchId), ['approved', 'pending', 'rejected-a']);
  assert.equal(selection.diagnosticControls, 1);
});

test('cross-venue economics are lockable only after manual identity approval', () => {
  const polyBooks = {
    YES: { asks: [[0.40, 100]], bids: [[0.39, 100]] },
    NO: { asks: [[0.62, 100]], bids: [[0.61, 100]] },
  };
  const kalshiBooks = {
    YES: { asks: [[0.63, 100]], bids: [[0.62, 100]] },
    NO: { asks: [[0.52, 100]], bids: [[0.51, 100]] },
  };
  const indicative = evaluatePair({ quantities: [10], polyBooks, kalshiBooks,
    identityApproved: false, booksFresh: true, polyTick: 0.01, kalshiTick: 0.01 });
  const direction = indicative.find((row) => row.direction === 'POLY_YES+KALSHI_NO');
  assert.equal(direction.indicativeEconomic, true);
  assert.equal(direction.economic, false);
  assert.equal(direction.status, 'UNPROVEN_PAYOFF_CONTROL');
  assert.equal(direction.lockableAfterBothFills, false);
  assert.equal(direction.atomic, false);
  const approved = evaluatePair({ quantities: [10], polyBooks, kalshiBooks,
    identityApproved: true, booksFresh: true, polyTick: 0.001, kalshiTick: 0.001 });
  assert.equal(approved.find((row) => row.direction === 'POLY_YES+KALSHI_NO').lockableAfterBothFills, true);
});

test('score-approved pairs can emit stressed paper entries without becoming proved locks', () => {
  const rows = evaluatePair({
    quantities: [10], paperEvalApproved: true, booksFresh: true,
    polyTick: 0.01, kalshiTick: 0.01,
    polyBooks: {
      YES: { asks: [[0.40, 100]], bids: [[0.39, 100]] },
      NO: { asks: [[0.62, 100]], bids: [[0.61, 100]] },
    },
    kalshiBooks: {
      YES: { asks: [[0.63, 100]], bids: [[0.62, 100]] },
      NO: { asks: [[0.52, 100]], bids: [[0.51, 100]] },
    },
  });
  const paper = rows.find((row) => row.direction === 'POLY_YES+KALSHI_NO');
  assert.equal(paper.paperTradeEligible, true);
  assert.equal(paper.status, 'PAPER_ASSUMED_PARITY_STRESSED_EDGE');
  assert.equal(paper.economic, false);
  assert.equal(paper.relationApproved, false);
  assert.equal(paper.lockableAfterBothFills, false);
});

test('state-conditioned implication compiles only the mathematically safe bundle', () => {
  const relation = compileCrossVenueRelation({
    id: 'speech-implication', polyConditionId: 'poly-id', kalshiTicker: 'kalshi-id',
    relationType: CROSSVENUE_RELATION_TYPES.POLY_IMPLIES_KALSHI,
    reviewed: true, approved: true,
    stateRequirements: [{
      id: 'speech-started', satisfied: true,
      observedAt: '2026-07-17T01:00:00Z', source: 'manual-audit',
    }],
    resolutionAudit: { rationale: 'The Polymarket interval is no longer than the Kalshi interval.' },
  }, { nowMs: Date.parse('2026-07-17T01:01:00Z') });
  assert.equal(relation.relationApproved, true);
  assert.deepEqual(relation.validBundles.map((bundle) => bundle.direction), [
    'POLY_NO+KALSHI_YES',
  ]);
  assert.equal(relation.validBundles[0].guaranteedMinPayoutPerShare, 1);
  assert.deepEqual(relation.validBundles[0].payoffProof.payoffVector, [1, 2, 1]);
});

test('state-conditioned implication remains inactive before its evidence timestamp', () => {
  const relation = compileCrossVenueRelation({
    id: 'future-state', polyConditionId: 'poly-id', kalshiTicker: 'kalshi-id',
    relationType: CROSSVENUE_RELATION_TYPES.POLY_IMPLIES_KALSHI,
    reviewed: true, approved: true,
    stateRequirements: [{
      id: 'event-started', satisfied: true,
      observedAt: '2026-07-17T01:00:00Z', source: 'manual-audit',
    }],
    resolutionAudit: { rationale: 'State-dependent implication.' },
  }, { nowMs: Date.parse('2026-07-17T00:59:00Z') });
  assert.equal(relation.relationApproved, false);
  assert.equal(relation.relationStatus, 'PENDING_STATE');
});

test('relation-aware optimizer evaluates implication direction instead of parity directions', () => {
  const payoffRelation = compileCrossVenueRelation({
    id: 'implication', polyConditionId: 'poly-id', kalshiTicker: 'kalshi-id',
    relationType: CROSSVENUE_RELATION_TYPES.POLY_IMPLIES_KALSHI,
    reviewed: true, approved: true, stateRequirements: [],
    resolutionAudit: { rationale: 'A implies B.' },
  });
  const rows = optimizePair({
    payoffRelation, quantities: [10], minQuantity: 1, maxQuantity: 100,
    totalCapitalUsd: 100, polyCapitalUsd: 100, kalshiCapitalUsd: 100,
    kalshiFeeMultiplier: 0, polyFeeRate: 0, booksFresh: true,
    polyBooks: {
      YES: { asks: [[0.70, 100]], bids: [[0.69, 100]] },
      NO: { asks: [[0.20, 100]], bids: [[0.19, 100]] },
    },
    kalshiBooks: {
      YES: { asks: [[0.60, 100]], bids: [[0.59, 100]] },
      NO: { asks: [[0.50, 100]], bids: [[0.49, 100]] },
    },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].direction, 'POLY_NO+KALSHI_YES');
  assert.equal(rows[0].relationApproved, true);
  assert.equal(rows[0].economic, true);
});

test('approved relation lifecycle deduplicates quote flicker into one event row', () => {
  const identity = {
    matchId: 'match', relationId: 'relation', direction: 'POLY_NO+KALSHI_YES',
    activeFrom: '2026-07-18T00:00:00Z',
  };
  const episodeId = relationEpisodeId(identity);
  assert.equal(episodeId, relationEpisodeId(identity));
  let episode = updateRelationEpisode(null, {
    ...identity, episodeId, relationApproved: true,
    observedAt: '2026-07-18T00:00:01Z', economic: false,
    reason: 'NO_EXECUTABLE_DEPTH',
  });
  assert.equal(episode.lifecycleStatus, 'OBSERVED_NO_EDGE');
  episode = updateRelationEpisode(episode, {
    ...identity, episodeId, relationApproved: true,
    observedAt: '2026-07-18T00:00:02Z', economic: true,
    opportunityId: 'op-1', quantity: '25', totalCost: '20',
    rawProfit: '5', stressedProfit: '3', worstOrphanUnwindPnl: '-6',
    orphanUnwindAvailable: true,
  });
  assert.equal(episode.lifecycleStatus, 'OPEN_ECONOMIC');
  assert.equal(episode.economicObservations, 1);
  assert.equal(episode.maxStressedProfit, 3);
  assert.equal(episode.worstOrphanUnwindPnl, -6);
  episode = updateRelationEpisode(episode, {
    ...identity, episodeId, relationApproved: true,
    observedAt: '2026-07-18T00:00:03Z', economic: false,
    reason: 'EDGE_DISAPPEARED',
  });
  assert.equal(episode.lifecycleStatus, 'DISAPPEARED');
  assert.equal(episode.disappearances, 1);
  episode = updateRelationEpisode(episode, {
    ...identity, episodeId, relationApproved: true,
    observedAt: '2026-07-18T00:00:04Z', economic: true,
    opportunityId: 'op-2', quantity: 10, totalCost: 9,
    rawProfit: 1, stressedProfit: 0.5, worstOrphanUnwindPnl: -3,
    orphanUnwindAvailable: false,
  });
  assert.equal(episode.reappearances, 1);
  assert.equal(episode.maxStressedProfit, 3);
  assert.equal(episode.orphanUnwindUnavailableObservations, 1);
  const closed = closeRelationEpisode(episode, '2026-07-18T01:00:00Z');
  assert.equal(closed.lifecycleStatus, 'CLOSED_AFTER_OPPORTUNITY');
});

test('unapproved relations never enter the independent episode ledger', () => {
  assert.equal(updateRelationEpisode(null, {
    matchId: 'm', relationId: 'r', direction: 'd',
    observedAt: '2026-07-18T00:00:00Z', relationApproved: false, economic: true,
  }), null);
});

test('basis convergence charges executable asks, bids and all four fees', () => {
  const rows = evaluateBasisPair({
    quantity: 10,
    polyBooks: {
      YES: { asks: [[0.40, 20]], bids: [[0.39, 20]] },
      NO: { asks: [[0.62, 20]], bids: [[0.61, 20]] },
    },
    kalshiBooks: {
      YES: { asks: [[0.63, 20]], bids: [[0.62, 20]] },
      NO: { asks: [[0.50, 20]], bids: [[0.49, 20]] },
    },
    booksFresh: true, identityApproved: true,
  });
  const row = rows.find((value) => value.direction === 'POLY_YES+KALSHI_NO');
  assert.equal(row.entryEconomic, true);
  assert.ok(row.entryTotalCost > 9);
  assert.ok(row.netLiquidationProceeds < 8.8);
  assert.equal(row.immediateRoundTripPnl, row.netLiquidationProceeds - row.entryTotalCost);
  assert.ok(row.immediateRoundTripPnl < 0);
});

test('basis collector retains an entry when immediate liquidation depth is absent', () => {
  const rows = evaluateBasisPair({
    quantity: 5,
    polyBooks: {
      YES: { asks: [[0.40, 10]], bids: [] },
      NO: { asks: [[0.62, 10]], bids: [[0.61, 10]] },
    },
    kalshiBooks: {
      YES: { asks: [[0.63, 10]], bids: [[0.62, 10]] },
      NO: { asks: [[0.50, 10]], bids: [[0.49, 10]] },
    },
    booksFresh: true,
  });
  const row = rows.find((value) => value.direction === 'POLY_YES+KALSHI_NO');
  assert.equal(row.fullEntryDepth, true);
  assert.equal(row.fullExitDepth, false);
  assert.equal(row.netLiquidationProceeds, null);
  assert.equal(row.immediateRoundTripPnl, null);
});

test('convergence report measures first profitable liquidation and right-censors open positions', () => {
  const base = Date.parse('2026-07-01T00:00:00Z');
  const sample = (matchId, minutes, net) => ({
    observed_at: new Date(base + minutes * 60_000), match_id: matchId,
    direction: 'POLY_YES+KALSHI_NO', quantity: '10', entry_total_cost: '9.5',
    net_liquidation_proceeds: String(net), terminal_locked_profit: '0.5',
    immediate_round_trip_pnl: String(net - 9.5), entry_economic: true,
    identity_approved: true, books_fresh: true, full_entry_depth: true,
    full_exit_depth: true, data_quality_grade: 'B', execution_fidelity_grade: 'B',
  });
  const report = summarizeConvergence([
    sample('pair-a', 0, 9.2), sample('pair-a', 5, 9.6),
    sample('pair-b', 0, 9.2), sample('pair-b', 30, 9.4),
  ]);
  assert.equal(report.approvedEvidence.episodes, 2);
  assert.equal(report.approvedEvidence.observedProfitableExits, 1);
  assert.equal(report.approvedEvidence.rightCensored, 1);
  assert.equal(report.approvedEvidence.horizons.find((row) => row.label === '5m').probability, 0.5);
});

test('convergence reports score-approved paper assumptions separately from proved evidence', () => {
  const base = Date.parse('2026-07-01T00:00:00Z');
  const sample = (minutes, net) => ({
    observed_at: new Date(base + minutes * 60_000), match_id: 'paper-pair',
    direction: 'POLY_NO+KALSHI_YES', quantity: '5', entry_total_cost: '4.5',
    net_liquidation_proceeds: String(net), terminal_locked_profit: '0.5',
    immediate_round_trip_pnl: String(net - 4.5), entry_economic: false,
    paper_eval_approved: true, paper_entry_eligible: true,
    identity_approved: false, relation_approved: false, books_fresh: true,
    full_entry_depth: true, full_exit_depth: true,
    data_quality_grade: 'B', execution_fidelity_grade: 'B',
  });
  const report = summarizeConvergence([sample(0, 4.3), sample(5, 4.6)]);
  assert.equal(report.approvedEvidence.episodes, 0);
  assert.equal(report.paperEvaluation.episodes, 1);
  assert.equal(report.paperEvaluation.observedProfitableExits, 1);
  assert.equal(report.unapprovedDiagnostic.episodes, 0);
});

test('V6 convergence hard-vetoes score approval without a clean immutable rule key', () => {
  const base = Date.parse('2026-07-01T00:00:00Z');
  const sample = (matchId, minutes, overrides = {}) => ({
    observed_at: new Date(base + minutes * 60_000), match_id: matchId,
    direction: 'POLY_NO+KALSHI_YES', quantity: '5', entry_total_cost: '4.5',
    net_liquidation_proceeds: minutes ? '4.6' : '4.3',
    terminal_locked_profit: '0.5', entry_economic: false,
    paper_eval_approved: true, paper_entry_eligible: true,
    relation_approved: false, books_fresh: true,
    full_entry_depth: true, full_exit_depth: true,
    data_quality_grade: 'B', execution_fidelity_grade: 'B',
    exact_rule_key: `rule:${matchId}`, exact_rule_eligible: true,
    hard_mismatch: false,
    ...overrides,
  });
  const report = summarizeConvergence([
    sample('clean', 0), sample('clean', 5),
    sample('vetoed', 0, { hard_mismatch: true }),
    sample('vetoed', 5, { hard_mismatch: true }),
    sample('missing', 0, { exact_rule_key: null, exact_rule_eligible: false }),
    sample('missing', 5, { exact_rule_key: null, exact_rule_eligible: false }),
  ], { requireExactRule: true });
  assert.equal(report.paperEvaluation.episodes, 1);
  assert.equal(report.paperEvaluation.observedProfitableExits, 1);
  assert.equal(report.unapprovedDiagnostic.episodes, 2);
  assert.equal(report.coverage.samples, 2);
  assert.equal(report.diagnosticSamples, 4);
});

test('V6 convergence cannot use an exit mark from a changed rule key', () => {
  const base = Date.parse('2026-07-01T00:00:00Z');
  const row = (minutes, key, entryEligible, proceeds) => ({
    observed_at: new Date(base + minutes * 60_000), match_id: 'changed-rule',
    direction: 'POLY_YES+KALSHI_NO', quantity: '5', entry_total_cost: '4.5',
    net_liquidation_proceeds: String(proceeds), terminal_locked_profit: '0.5',
    paper_eval_approved: true, paper_entry_eligible: entryEligible,
    books_fresh: true, full_entry_depth: true, full_exit_depth: true,
    data_quality_grade: 'B', execution_fidelity_grade: 'B',
    exact_rule_key: key, exact_rule_eligible: true, hard_mismatch: false,
  });
  const report = summarizeConvergence([
    row(0, 'rule:a', true, 4.3),
    row(5, 'rule:b', false, 4.7),
  ], { requireExactRule: true });
  assert.equal(report.paperEvaluation.episodes, 1);
  assert.equal(report.paperEvaluation.observedProfitableExits, 0);
  assert.equal(report.paperEvaluation.rightCensored, 1);
});

test('cross-venue inference counts only the first episode per pair direction and UTC day', () => {
  const base = Date.parse('2026-07-01T00:00:00Z');
  const sample = (minutes, eligible, net) => ({
    observed_at: new Date(base + minutes * 60_000), match_id: 'serial-pair',
    direction: 'POLY_NO+KALSHI_YES', quantity: '5', entry_total_cost: '4.5',
    net_liquidation_proceeds: String(net), terminal_locked_profit: '0.5',
    entry_economic: false, paper_eval_approved: true,
    paper_entry_eligible: eligible, relation_approved: false,
    books_fresh: true, full_entry_depth: true, full_exit_depth: true,
    data_quality_grade: 'B', execution_fidelity_grade: 'B',
  });
  const report = summarizeConvergence([
    sample(0, true, 4.3), sample(5, true, 4.6),
    sample(10, false, 4.3),
    sample(15, true, 4.3), sample(20, true, 4.6),
  ]);
  assert.equal(report.paperEvaluation.rawEpisodes, 2);
  assert.equal(report.paperEvaluation.episodes, 1);
  assert.equal(report.paperEvaluation.repeatedSamePairDirectionDay, 1);
  assert.equal(report.paperEvaluation.independentPairDirectionDays, 1);
  assert.equal(report.paperEvaluation.spanDays, 0);
});

test('cross-venue readiness uses the qualifying cohort span rather than diagnostic history', () => {
  const base = Date.parse('2026-07-01T00:00:00Z');
  const row = (index, approved, paperApproved) => ({
    observed_at: new Date(base + index * 86_400_000),
    match_id: `pair-${index}`, direction: 'POLY_NO+KALSHI_YES', quantity: '5',
    entry_total_cost: '4.5', net_liquidation_proceeds: '4.3',
    terminal_locked_profit: '0.5', entry_economic: approved,
    relation_approved: approved, paper_eval_approved: paperApproved,
    paper_entry_eligible: paperApproved, books_fresh: true,
    full_entry_depth: true, full_exit_depth: true,
    data_quality_grade: 'B', execution_fidelity_grade: 'B',
  });
  const rows = Array.from({ length: 300 }, (_, index) => row(index, false, true));
  rows.push(...Array.from({ length: 300 }, (_, index) => ({
    ...row(index / 1000, true, false), match_id: `approved-${index}`,
  })));
  const report = summarizeConvergence(rows);
  assert.equal(report.approvedEvidence.independentPairDirectionDays, 300);
  assert.ok(report.coverage.spanDays > 14);
  assert.ok(report.approvedEvidence.spanDays < 1);
  assert.equal(report.evidenceReady, false);
});

test('cross-venue collector has no wallet, private key, or live-order dependency', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'borg', 'crossvenue', 'collector.js'), 'utf8');
  assert.doesNotMatch(source, /createAndPostOrder|ClobClient|PRIVATE_KEY|Wallet\s*\(/);
  assert.match(source, /PAPER ONLY/);
});

test('cross-venue collector does not open CLOB sockets without approved monitored tokens', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'borg', 'crossvenue', 'collector.js'), 'utf8');
  assert.match(source, /if \(this\.tokenMatches\.size > 0\) await this\.clob\.connect\(\);/);
  assert.match(source, /this\.installMonitoredMatches\(universe\.monitored\)/);
});

test('cross-venue collector batches public Kalshi orderbook requests', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'borg', 'crossvenue', 'collector.js'), 'utf8');
  assert.match(source, /markets\/orderbooks/);
  assert.match(source, /searchParams\.append\('tickers', ticker\)/);
  assert.match(source, /orderbooks_batch_rest/);
  const tickers = Array.from({ length: 205 }, (_, index) => `KX-${index}`);
  const batches = chunkKalshiTickers([...tickers, tickers[0]]);
  assert.equal(KALSHI_ORDERBOOK_BATCH_SIZE, 100);
  assert.deepEqual(batches.map((batch) => batch.length), [100, 100, 5]);
  assert.equal(new Set(batches.flat()).size, 205);
});

test('full-universe discovery runs outside the live collector event loop', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'borg', 'crossvenue', 'collector.js'), 'utf8');
  assert.match(source, /new Worker\(path\.join\(__dirname, 'discovery-worker\.js'\)/);
  assert.match(source, /await this\.runDiscovery\(/);
  assert.doesNotMatch(source, /await discoverCrossVenue\(/);
});

test('cross-venue CLI convergence report retains the paper cohort flags', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'crossvenue-backtest.js'), 'utf8');
  assert.match(source, /entry_economic,paper_eval_approved,paper_entry_eligible/);
  assert.match(source, /summarizeConvergence\(basis\.rows,\s*\{/);
  assert.match(source, /requireExactRule: experimentId === CURRENT_CROSSVENUE_EXPERIMENT_ID/);
});
