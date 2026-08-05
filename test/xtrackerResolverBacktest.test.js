'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  firstArrival,
  postAtBoundary,
  renderMarkdown,
  summarize,
  terminalOutcome,
} = require('../scripts/xtracker-resolver-backtest');

test('historical arrival uses the first causal point after simulated latency', () => {
  const history = [
    { t: 100, p: '0.80' },
    { t: 101, p: '0.90' },
    { t: 102, p: '0.95' },
  ];
  assert.deepEqual(firstArrival(history, 100_500), { at: 101_000, price: 0.9 });
});

test('boundary source event and terminal state use monotone post counts', () => {
  const posts = Array.from({ length: 201 }, (_, index) => ({ id: index + 1 }));
  assert.equal(postAtBoundary(posts, { lower: 80, upper: 99 }).id, 100);
  assert.equal(postAtBoundary(posts, { lower: 200, upper: null }).id, 200);
  assert.equal(terminalOutcome({ lower: 80, upper: 99 }, 100), 'No');
  assert.equal(terminalOutcome({ lower: 200, upper: null }, 200), 'Yes');
});

test('summary separates tradable positive opportunities from diagnostic negative residuals', () => {
  const inputs = { trackings: [{ id: 't1' }], posts: [{ id: 'p1' }] };
  const built = {
    eventRows: [{ certificate: { certified: true } }],
    candidates: [{ id: 'c1' }, { id: 'c2' }],
    episodes: [
      {
        latencyMs: 100, trackingId: 't1', positiveAfterStress: true,
        nominalPnlUsd: 0.2, stressedPnlUsd: 0.1, trackerLagMs: 1000,
      },
      {
        latencyMs: 100, trackingId: 't1', positiveAfterStress: false,
        nominalPnlUsd: 0.05, stressedPnlUsd: -0.3, trackerLagMs: 2000,
      },
    ],
  };
  const settings = { latencyProfilesMs: [100], sourceRiskReserve: 0.01 };
  const report = summarize(inputs, built, settings);
  assert.equal(report.byLatency[0].positiveStressedPnlUsd, 0.1);
  assert.ok(Math.abs(report.byLatency[0].sumStressedResidualAllEpisodesUsd + 0.2) < 1e-12);
  assert.match(renderMarkdown(report), /market-efficiency diagnostic, not traded PnL/);
});
