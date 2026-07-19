'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { binaryPnl, simulateTakerTouch } = require('../borg/research/execution-kernel');

test('shared execution kernel rejects gaps and uses only displayed touch capacity', () => {
  const good = simulateTakerTouch({
    limitPrice: '0.60', requestedSize: '10', bestAsk: '0.59', askSize: '4',
    stateSource: 'event', stateAgeMs: 100,
  });
  assert.equal(good.dataQualityGrade, 'A');
  assert.equal(good.fillSize, 4);
  assert.equal(good.partial, true);
  const gap = simulateTakerTouch({
    limitPrice: 0.60, requestedSize: 10, bestAsk: 0.59, askSize: 10,
    connectionGap: true, stateSource: 'event', stateAgeMs: 10,
  });
  assert.equal(gap.filled, false);
  assert.equal(gap.dataQualityGrade, 'F');
});

test('shared execution kernel parses DECIMAL strings and applies fee stress', () => {
  const one = binaryPnl({ token: 'UP', outcome: 'UP', fillPrice: '0.50', fillSize: '10', feeMultiplier: 1 });
  const two = binaryPnl({ token: 'UP', outcome: 'UP', fillPrice: '0.50', fillSize: '10', feeMultiplier: 2 });
  assert.equal(one.gross, 5);
  assert.ok(one.net < one.gross);
  assert.ok(two.net < one.net);
});
