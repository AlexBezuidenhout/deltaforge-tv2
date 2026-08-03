'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildScenarios,
  eligible,
  renderReport,
} = require('../scripts/edge-portfolio-report');

function row(overrides = {}) {
  return {
    id: 1, strategy: 'H43X_chainlink_tail_residual_v1', market_id: 10,
    token: 'yes', available_at: '2026-08-03T12:00:00.000Z',
    fill_ts: '2026-08-03T12:00:00.100Z', fill_price: '0.50', fill_size: '20',
    filled: true, pnl_2x: '1.00', window_end: '2026-08-03T12:05:00.000Z',
    data_quality_grade: 'A', execution_fidelity_grade: 'B', features: {}, detail: {},
    ...overrides,
  };
}

test('edge portfolio uses joint A/B evidence and never scales above recorded shares', () => {
  assert.equal(eligible(row()), true);
  assert.equal(eligible(row({ execution_fidelity_grade: 'F' })), false);
  const scenarios = buildScenarios([row()], new Date('2026-08-03T13:00:00.000Z'));
  assert.equal(scenarios[500]['6h'].realizedPnl1x, 1);
  assert.equal(scenarios[1000]['6h'].realizedPnl1x, 1);
  assert.equal(scenarios[500]['6h'].admittedOrders, 1);
});

test('edge portfolio report rejects live interpretation and linear capital extrapolation', () => {
  const portfolio = {
    admittedOrders: 0, settledPositions: 0, realizedPnl1x: 0,
    endingBankroll: 500, maxDrawdownUsd: 0, averageGrossUtilization: 0,
  };
  const report = {
    generatedAt: '2026-08-03T15:00:00.000Z',
    evidenceEpoch: { id: 'v19', startedAt: '2026-08-03T13:20:00.000Z', codeVersion: 'abc' },
    accounting: 'doubled costs', statistical: [],
    portfolioScenarios: {
      500: { '6h': portfolio, '24h': portfolio, '7d': portfolio },
      1000: { '6h': { ...portfolio, endingBankroll: 1000 }, '24h': { ...portfolio, endingBankroll: 1000 }, '7d': { ...portfolio, endingBankroll: 1000 } },
    },
    deterministicLanes: [],
    resolverTimestampPrecision: {
      status: 'FALSIFIED', positiveDoubledCostEpisodes: 0, executableCapacityUsd: 0,
    },
    conclusion: 'No lane passes.',
  };
  const markdown = renderReport(report);
  assert.match(markdown, /does not upscale beyond captured displayed fill capacity/);
  assert.match(markdown, /No result in this report authorizes live trading/);
});
