'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  accrueModeledReward,
  acknowledgeCancels,
  buildInitialPairQuotes,
  buildRepairQuote,
  closeCycle,
  consumeMakerPrints,
  createPairCycle,
  floorToTick,
  installRepairQuote,
  liquidateOrphan,
  mergeCompleteSets,
  orphanPosition,
  requestCancel,
  rewardOrderScore,
  rewardQuoteSnapshot,
  settleOrphanAtResolution,
} = require('../borg/pairedmaker/strategy');
const { pairedCategory, pairedMarketPhase, selectPairedPanel } = require('../borg/pairedmaker/universe');
const { summarize: summarizePairedMaker } = require('../scripts/paired-maker-report');

const NOW = 1_000_000;
const market = {
  conditionId: 'condition',
  tickSize: 0.01,
  orderMinSize: 5,
  feeRate: 0.04,
  feeExponent: 1,
  feeTakerOnly: true,
};
const books = [
  { at: NOW, bids: [[0.42, 50], [0.41, 100]], asks: [[0.43, 50], [0.44, 100]] },
  { at: NOW, bids: [[0.57, 50], [0.56, 100]], asks: [[0.58, 50], [0.59, 100]] },
];
const metas = [
  { assetId: 'yes', outcome: 'Yes' },
  { assetId: 'no', outcome: 'No' },
];

function proposal(edge = 0.01) {
  return buildInitialPairQuotes({
    market, books, minPairEdge: edge, targetPairUsd: 10,
    nowMs: NOW, staleMs: 750, maxBookSkewMs: 250,
  });
}

function cycle(edge = 0.01) {
  return createPairCycle({
    cycleId: 'cycle', runId: 'run', experimentId: 'experiment',
    strategy: 'PMM_wallet_mechanism_v2', arm: 'test', market, metas,
    proposal: proposal(edge), placedAtMs: NOW, initialQuoteLifetimeMs: 900_000,
    repairTimeoutMs: 60_000,
    cancelAckMs: 50,
  });
}

test('one-cent complete-set spread qualifies while two-cent control stays inactive', () => {
  const oneTick = proposal(0.01);
  assert.equal(oneTick.qualified, true);
  assert.equal(oneTick.pairCost, 0.99);
  assert.equal(+oneTick.grossEdgePerShare.toFixed(2), 0.01);
  assert.equal(+oneTick.reservedCost.toFixed(2), 10);

  const twoTick = proposal(0.02);
  assert.equal(twoTick.qualified, false);
  assert.equal(twoTick.reason, 'PAIR_EDGE_TOO_SMALL');
});

test('cycle preserves the frozen persistent-queue lifetime', () => {
  assert.equal(cycle().initialQuoteLifetimeMs, 900_000);
});

test('reward-aware sizing meets venue minimum but refuses more than the arm reserve', () => {
  const sized = buildInitialPairQuotes({
    market, books, minPairEdge: 0.01, targetPairUsd: 10,
    minimumShares: 50, maxReservedUsd: 50,
    nowMs: NOW, staleMs: 750, maxBookSkewMs: 250,
  });
  assert.equal(sized.qualified, true);
  assert.equal(sized.targetShares, 50);
  const rejected = buildInitialPairQuotes({
    market, books, minPairEdge: 0.01, targetPairUsd: 10,
    minimumShares: 300, maxReservedUsd: 250,
    nowMs: NOW, staleMs: 750, maxBookSkewMs: 250,
  });
  assert.equal(rejected.reason, 'PAIR_RESERVE_EXCEEDS_CAPITAL');
});

test('liquidity reward mark is quadratic, two-sided and never enters realized PnL', () => {
  assert.equal(rewardOrderScore(5, 0, 10), 10);
  assert.equal(rewardOrderScore(5, 5, 10), 0);
  assert.equal(rewardOrderScore(5, 6, 10), 0);
  const rewardMarket = {
    ...market, rewardsDailyRate: 100, rewardsMinSize: 5, rewardsMaxSpread: 5,
    rewardsStartDate: new Date(NOW - 86_400_000).toISOString(),
    rewardsEndDate: new Date(NOW + 86_400_000).toISOString(),
  };
  const state = createPairCycle({
    cycleId: 'reward-cycle', runId: 'run', experimentId: 'v3',
    strategy: 'PMM_wallet_mechanism_v3_reward_aware', arm: 'test', market: rewardMarket, metas,
    proposal: buildInitialPairQuotes({ market: rewardMarket, books, minPairEdge: 0.01,
      targetPairUsd: 10, minimumShares: 5, nowMs: NOW, staleMs: 750, maxBookSkewMs: 250 }),
    placedAtMs: NOW, initialQuoteLifetimeMs: 900_000, repairTimeoutMs: 60_000, cancelAckMs: 50,
  });
  const mark = rewardQuoteSnapshot(state, books, { nowMs: NOW + 1_000, staleMs: 2_000, maxBookSkewMs: 250 });
  assert.equal(mark.qualified, true);
  assert.ok(mark.modeledShareFloor > 0 && mark.modeledShareFloor < 1);
  const accrued = accrueModeledReward(state, books, { nowMs: NOW + 1_000, staleMs: 2_000, maxBookSkewMs: 250 });
  assert.ok(accrued.accrued > 0);
  closeCycle(state, 'NO_FILL', NOW + 1_001);
  assert.equal(state.totalPnl, 0);
  assert.ok(state.modeledRewardAccrual > 0);
});

test('maker-charged fee schedules are included before an edge can qualify', () => {
  const feeMarket = { ...market, feeTakerOnly: false };
  const result = buildInitialPairQuotes({
    market: feeMarket, books, minPairEdge: 0.01, targetPairUsd: 10,
    nowMs: NOW, staleMs: 750, maxBookSkewMs: 250,
  });
  assert.equal(result.qualified, false);
  assert.equal(result.reason, 'PAIR_EDGE_TOO_SMALL');
  assert.ok(result.pairCost > result.rawPairCost);
});

test('pair books must be fresh and synchronized', () => {
  const stale = [{ ...books[0], at: NOW - 1000 }, books[1]];
  const result = buildInitialPairQuotes({
    market, books: stale, minPairEdge: 0.01, targetPairUsd: 10,
    nowMs: NOW, staleMs: 750, maxBookSkewMs: 250,
  });
  assert.equal(result.qualified, false);
  assert.equal(result.reason, 'STALE_BOOK');
});

test('maker fills stay behind displayed queue and cancel acknowledgements are delayed', () => {
  const state = cycle();
  const queue = state.legs[0].quote.queue.queueAheadInitial;
  assert.equal(consumeMakerPrints(state, 0, [[NOW + 1, 0.42, queue]], NOW + 1).filledShares, 0);
  const fill = consumeMakerPrints(state, 0, [[NOW + 2, 0.42, 2]], NOW + 2);
  assert.equal(fill.filledShares, 2);
  assert.equal(orphanPosition(state).shares, 2);

  requestCancel(state, 'FIRST_FILL', 'REPAIR', NOW + 2);
  assert.equal(acknowledgeCancels(state, NOW + 51).complete, false);
  assert.equal(acknowledgeCancels(state, NOW + 52).complete, true);
});

test('equal complementary fills merge to exact locked complete-set PnL', () => {
  const state = cycle();
  const leftQueue = state.legs[0].quote.queue.queueAheadInitial;
  const rightQueue = state.legs[1].quote.queue.queueAheadInitial;
  consumeMakerPrints(state, 0, [[NOW + 1, 0.42, leftQueue + 5]], NOW + 1);
  consumeMakerPrints(state, 1, [[NOW + 2, 0.57, rightQueue + 5]], NOW + 2);
  const merged = mergeCompleteSets(state);
  assert.equal(merged.mergedShares, 5);
  assert.equal(+merged.lockedPnl.toFixed(2), 0.05);
  assert.equal(orphanPosition(state), null);
  closeCycle(state, 'LOCKED', NOW + 3);
  assert.equal(+state.totalPnl.toFixed(2), 0.05);
});

test('repair quote never spends the locked edge and never rounds a small orphan up', () => {
  const state = cycle();
  const queue = state.legs[0].quote.queue.queueAheadInitial;
  consumeMakerPrints(state, 0, [[NOW + 1, 0.42, queue + 5]], NOW + 1);
  state.legs.forEach((leg) => { leg.quote.active = false; });
  const repair = buildRepairQuote({ cycle: state, books, nowMs: NOW + 2, staleMs: 750, maxBookSkewMs: 250 });
  assert.equal(repair.qualified, true);
  assert.equal(repair.quote.price, 0.57);
  assert.ok(0.42 + repair.quote.price <= 0.99 + 1e-9);
  const installed = installRepairQuote(state, repair, NOW + 2);
  assert.equal(installed.quote.size, 5);

  const tiny = cycle();
  tiny.legs[0].shares = 2;
  tiny.legs[0].cost = 0.84;
  tiny.legs.forEach((leg) => { leg.quote.active = false; });
  const rejected = buildRepairQuote({ cycle: tiny, books, nowMs: NOW + 2, staleMs: 750, maxBookSkewMs: 250 });
  assert.equal(rejected.reason, 'ORPHAN_BELOW_ORDER_MINIMUM');
});

test('orphan liquidation walks full depth, worsens one tick, and charges taker fees', () => {
  const state = cycle();
  state.legs.forEach((leg) => { leg.quote.active = false; });
  state.legs[0].shares = 10;
  state.legs[0].cost = 4.2;
  const exitBooks = [
    { at: NOW + 100, bids: [[0.41, 5], [0.40, 5]], asks: [[0.42, 20]] },
    books[1],
  ];
  const exit = liquidateOrphan(state, exitBooks, { nowMs: NOW + 100, staleMs: 750, adverseTicks: 1 });
  assert.equal(exit.filled, true);
  assert.equal(+exit.depthVwap.toFixed(3), 0.405);
  assert.equal(exit.exitPrice, 0.39);
  assert.ok(exit.fee > 0);
  assert.ok(exit.pnl < -0.3);
  closeCycle(state, 'ORPHAN_LIQUIDATED', NOW + 101);
  assert.equal(state.totalPnl, state.orphanPnl);
});

test('orphan liquidation refuses unsupported displayed depth', () => {
  const state = cycle();
  state.legs.forEach((leg) => { leg.quote.active = false; });
  state.legs[0].shares = 10;
  state.legs[0].cost = 4.2;
  const result = liquidateOrphan(state, [
    { at: NOW, bids: [[0.41, 9]], asks: [[0.42, 20]] }, books[1],
  ], { nowMs: NOW, staleMs: 750 });
  assert.equal(result.filled, false);
  assert.equal(result.reason, 'INSUFFICIENT_EXIT_DEPTH');
  assert.equal(orphanPosition(state).shares, 10);
});

test('orphan liquidation refuses a book with no receive timestamp', () => {
  const state = cycle();
  state.legs.forEach((leg) => { leg.quote.active = false; });
  state.legs[0].shares = 5;
  state.legs[0].cost = 2.1;
  const result = liquidateOrphan(state, [
    { bids: [[0.41, 10]], asks: [[0.42, 20]] }, books[1],
  ], { nowMs: NOW, staleMs: 750 });
  assert.equal(result.reason, 'STALE_EXIT_BOOK');
});

test('an untradeable orphan is scored at the public resolution winner', () => {
  const state = cycle();
  state.legs.forEach((leg) => { leg.quote.active = false; });
  state.legs[0].shares = 5;
  state.legs[0].cost = 2.1;
  const winner = settleOrphanAtResolution(state, 'yes');
  assert.equal(winner.settled, true);
  assert.equal(winner.payoutPrice, 1);
  assert.equal(+winner.pnl.toFixed(2), 2.9);
  closeCycle(state, 'MARKET_RESOLVED_ORPHAN', NOW + 1);
  assert.equal(+state.totalPnl.toFixed(2), 2.9);
});

test('prices are floored on the token scale, never rounded above an edge cap', () => {
  assert.equal(floorToTick('0.579', '0.01'), 0.57);
  assert.equal(floorToTick('0.009', '0.01'), null);
});

test('paired universe identifies esports and ranks without historical PnL', () => {
  assert.equal(pairedCategory({ question: 'CS2: Spirit vs Vitality' }), 'esports');
  const base = {
    active: true, closed: false, acceptingOrders: true, tokenIds: ['yes', 'no'],
    orderMinSize: '5', endDate: new Date(NOW + 86400_000).toISOString(),
    liquidity: '1000', volume24h: '10000', category: 'sports',
  };
  const panel = selectPairedPanel([
    { ...base, conditionId: 'sports', question: 'Will Spain win?' },
    { ...base, conditionId: 'esports', question: 'Valorant: A vs B?', volume24h: '5000' },
    { ...base, conditionId: 'too_large', question: 'Will France win?', orderMinSize: '20' },
  ], { nowMs: NOW, maxMarkets: 2, targetPairUsd: 10 });
  assert.deepEqual(new Set(panel.map((row) => row.category)), new Set(['sports', 'esports']));
  assert.equal(panel.some((row) => row.conditionId === 'too_large'), false);
});

test('reward-aware panel requires funded rewards and classifies pregame versus live', () => {
  const base = {
    active: true, closed: false, acceptingOrders: true, tokenIds: ['yes', 'no'],
    orderMinSize: '5', endDate: new Date(NOW + 86400_000).toISOString(),
    gameStartTime: new Date(NOW + 3_600_000).toISOString(),
    liquidity: '1000', volume24h: '10000', category: 'sports',
    rewardsDailyRate: '70', rewardsMinSize: '20', rewardsMaxSpread: '4.5',
  };
  assert.equal(pairedMarketPhase(base, NOW), 'PREGAME');
  assert.equal(pairedMarketPhase(base, NOW + 7_200_000), 'LIVE_OR_POST_START');
  const panel = selectPairedPanel([
    { ...base, conditionId: 'funded', question: 'Will Spain win?' },
    { ...base, conditionId: 'zero', question: 'Will France win?', rewardsDailyRate: '0' },
    { ...base, conditionId: 'oversized', question: 'Will Italy win?', rewardsMinSize: '300' },
  ], { nowMs: NOW, maxMarkets: 3, rewardOnly: true, requireKnownGameStart: true,
    targetPairUsd: 25, maxReservedUsd: 250, minPairEdge: 0.01 });
  assert.deepEqual(panel.map((row) => row.conditionId), ['funded']);
});

test('paired-maker collector cannot import a wallet or submit a live order', () => {
  const collector = path.join(__dirname, '..', 'borg', 'pairedmaker', 'collector.js');
  if (!fs.existsSync(collector)) return;
  const source = fs.readFileSync(collector, 'utf8');
  assert.doesNotMatch(source, /createAndPostOrder|createOrder|postOrder|ClobClient|PRIVATE_KEY|ethers/);
  assert.match(source, /paperOnly: true/);
  assert.match(source, /walletLoaded: false/);
});

test('paired-maker report parses DECIMAL strings and excludes open orphan PnL', () => {
  const report = summarizePairedMaker([
    {
      arm: 'one_cent_repair_60s', condition_id: 'm1',
      first_fill_at: '2026-07-17T00:00:00Z', closed_at: '2026-07-17T00:01:00Z',
      total_pnl: '0.10', locked_pnl: '0.15', orphan_pnl: '-0.05',
      merged_shares: '10', orphan_exit_price: '0.40', orphan_exit_fees: '0.01',
      maker_fees: '0', exit_shares: '1', tick_size: '0.01',
    },
    {
      arm: 'one_cent_repair_60s', condition_id: 'm2',
      first_fill_at: '2026-07-18T00:00:00Z', closed_at: null,
      total_pnl: null, locked_pnl: '0', orphan_pnl: '0', merged_shares: '0',
      orphan_exit_price: null, orphan_exit_fees: '0', exit_shares: '0', tick_size: '0.01',
    },
  ]);
  const arm = report.arms[0];
  assert.equal(arm.realizedPnl, 0.1);
  assert.equal(arm.pnl2xExecutionStress, 0.08);
  assert.equal(arm.unscoredOrOpenCycles, 1);
  assert.equal(arm.promotionRead, 'NOT_VALIDATED');
});
