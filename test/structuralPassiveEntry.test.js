'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createPassiveQuoteState, proposePassiveQuotes, updatePassiveQuoteState,
} = require('../borg/structural/passive-entry');

function candidate() {
  return {
    candidateId: 'candidate',
    structureType: 'nested_threshold',
    guaranteedMinPayout: 1,
    payoffProof: { valid: true, proofHash: 'proof' },
    ruleCertification: { valid: true, certificationHash: 'rules' },
    legs: [
      {
        tokenId: 'low-yes', outcome: 'YES', orderMinSize: 5,
        feeRate: 0, feeExponent: 1, feeTakerOnly: true, feeScheduleKnown: true,
      },
      {
        tokenId: 'high-no', outcome: 'NO', orderMinSize: 5,
        feeRate: 0, feeExponent: 1, feeTakerOnly: true, feeScheduleKnown: true,
      },
    ],
  };
}

function books(now, passiveAsk = 0.45, hedgeAsk = 0.45) {
  return new Map([
    ['low-yes', {
      bids: [[0.44, 20]], asks: [[passiveAsk, 20]], at: now,
    }],
    ['high-no', {
      bids: [[0.44, 20]], asks: [[hedgeAsk, 20]], at: now,
    }],
  ]);
}

test('passive structural arm joins the bid and records queue ahead', () => {
  const now = Date.now();
  const proposals = proposePassiveQuotes(candidate(), books(now), now, {
    targetNotionalUsd: 10,
    minCapacityProfitUsd: 0.05,
  });
  assert.equal(proposals.length, 2);
  assert.equal(proposals[0].eligible, true);
  assert.equal(proposals[0].quotePrice, 0.44);
  assert.equal(proposals[0].queueAheadShares, 20);
  assert.equal(proposals[0].shares, 5);
  assert.ok(proposals[0].orphanSafeProfitUsd > 0);
});

test('maker-bearing metadata applies the 2x fee with the correct parameter order', () => {
  const now = Date.now();
  const withFees = candidate();
  withFees.legs[0] = {
    ...withFees.legs[0],
    feeRate: 0.1,
    feeExponent: 1,
    feeTakerOnly: false,
  };
  const proposal = proposePassiveQuotes(withFees, books(now), now, {
    targetNotionalUsd: 10,
    minCapacityProfitUsd: 0,
  }).find((row) => row.passiveLegIndex === 0);
  const expectedPassiveFee = 5 * 2 * 0.1 * 0.44 * (1 - 0.44);
  assert.ok(Math.abs(
    proposal.cashRequired - (5 * 0.44 + expectedPassiveFee + 5 * 0.45),
  ) < 1e-12);
  assert.equal(proposal.makerFeeMode, 'UNKNOWN_OR_MAKER_FEE_CHARGED_2X');
});

test('passive entry is limited to two-leg ordered implications', () => {
  const now = Date.now();
  const completeSet = candidate();
  completeSet.structureType = 'complete_mutually_exclusive_set';
  assert.deepEqual(proposePassiveQuotes(completeSet, books(now), now), []);
  const threeLeg = candidate();
  threeLeg.legs.push({ ...threeLeg.legs[0], tokenId: 'third' });
  const withThird = books(now);
  withThird.set('third', { bids: [[0.04, 20]], asks: [[0.05, 20]], at: now });
  assert.deepEqual(proposePassiveQuotes(threeLeg, withThird, now), []);
});

test('a crossed snapshot cannot fill; public volume must consume queue and order size', () => {
  const now = Date.now();
  const proposal = proposePassiveQuotes(candidate(), books(now), now, {
    targetNotionalUsd: 10,
    minCapacityProfitUsd: 0.05,
  })[0];
  const state = createPassiveQuoteState(proposal, now, { timeoutMs: 60_000 });
  const touch = updatePassiveQuoteState(
    state, candidate(), books(now + 1000, 0.44), now + 1000,
  );
  assert.equal(touch.status, 'RESTING');
  assert.equal(touch.passiveFilledShares, 0);
  const queueConsumed = updatePassiveQuoteState(
    touch, candidate(), books(now + 2000, 0.45, 0.46), now + 2000,
    { prints: [[now + 1500, 0.44, 20]] },
  );
  assert.equal(queueConsumed.status, 'RESTING');
  assert.equal(queueConsumed.passiveFilledShares, 0);
  const filled = updatePassiveQuoteState(
    queueConsumed, candidate(), books(now + 3000, 0.45, 0.46), now + 3000,
    { prints: [[now + 2500, 0.44, 5]] },
  );
  assert.equal(filled.status, 'FILLED_HEDGED_POSITIVE');
  assert.equal(filled.hedgeFullDepth, true);
  assert.ok(filled.lockedPnl2xUsd > 0);
});

test('an unhedgeable passive fill is scored as an orphan, never a lock', () => {
  const now = Date.now();
  const proposal = proposePassiveQuotes(candidate(), books(now), now, {
    targetNotionalUsd: 10,
    minCapacityProfitUsd: 0.05,
  })[0];
  const state = createPassiveQuoteState(proposal, now, { timeoutMs: 60_000 });
  const after = books(now + 1000, 0.44);
  after.set('high-no', { bids: [[0.40, 20]], asks: [], at: now + 1000 });
  const filled = updatePassiveQuoteState(state, candidate(), after, now + 1000, {
    prints: [[now + 500, 0.44, 25]],
  });
  assert.equal(filled.status, 'FILLED_ORPHAN_UNWOUND');
  assert.equal(filled.hedgeFullDepth, false);
  assert.ok(Number.isFinite(filled.orphanUnwindPnl2xUsd));
});

test('collector closes stale RESTING paper quotes across process boundaries', () => {
  const source = fs.readFileSync(path.join(
    __dirname, '..', 'borg', 'structural', 'scanner.js',
  ), 'utf8');
  assert.match(source, /ABANDONED_PROCESS_RESTART/);
  assert.match(source, /'closedByRunId',\$1::text/);
  assert.match(source, /CANCELLED_UNFILLED_PROCESS_STOP/);
  assert.match(source, /runId: state\.runId/);
});
