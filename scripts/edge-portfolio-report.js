#!/usr/bin/env node
'use strict';

require('dotenv').config();

const { createResearchPool } = require('./lib/research-pool');
const { summarizeArm } = require('./borg-profitability-audit');
const { simulatePortfolio } = require('../borg/research/portfolio-simulator');
const { holmAdjust } = require('../borg/research/statistics');
const { buildPriorityLaneStatus } = require('../borg/research/priority-lane-status');

const STATISTICAL_LANES = Object.freeze([
  {
    laneId: 'resolver-chainlink-tail-v1',
    experimentId: 'h43x-chainlink-tail-residual-v1',
    strategy: 'H43X_chainlink_tail_residual_v1',
  },
  {
    laneId: 'main-longshot-successor-v1',
    experimentId: 'main-longshot-0-20-v1',
    strategy: 'MAIN_LONGSHOT_0_20_V1',
  },
]);

const HORIZONS = Object.freeze([
  ['6h', 6 * 60 * 60 * 1000],
  ['24h', 24 * 60 * 60 * 1000],
  ['7d', 7 * 24 * 60 * 60 * 1000],
]);

const CAPITAL_SCENARIOS = Object.freeze([500, 1000]);

function finite(value, fallback = 0) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function money(value) {
  const parsed = finite(value);
  return `${parsed < 0 ? '-' : '+'}$${Math.abs(parsed).toFixed(2)}`;
}

function eligible(row) {
  return row.filled === true
    && ['A', 'B'].includes(row.data_quality_grade)
    && ['A', 'B'].includes(row.execution_fidelity_grade);
}

function toSimulationRecord(row) {
  return {
    orderId: String(row.id), strategy: row.strategy,
    marketId: String(row.market_id), token: row.token,
    ts: row.ts, availableAt: row.available_at,
    sourceEventId: row.source_event_id,
    filled: eligible(row), fillTs: row.fill_ts,
    fillPrice: row.fill_price, fillSize: row.fill_size,
    // The common simulator releases `pnl1x`; remap the already-computed 2x
    // cost result so portfolio cash, drawdown and occupancy share one path.
    pnl1x: row.pnl_2x, pnl2x: row.pnl_2x,
    detail: row.detail,
    capacityAtArrival: row.detail?.capacity_at_arrival,
    capacityKey: row.detail?.clob_event_sequence != null
      ? `${row.market_id}:${row.token}:${row.detail.clob_connection_epoch}:${row.detail.clob_event_sequence}`
      : null,
    groupId: row.features?.group_id,
    windowEnd: row.window_end, resolvedAt: row.resolved_at,
  };
}

function buildScenarios(rows, now = new Date()) {
  const nowMs = now.getTime();
  const output = {};
  for (const capital of CAPITAL_SCENARIOS) {
    output[capital] = {};
    for (const [label, duration] of HORIZONS) {
      const cohort = rows.filter((row) => {
        const at = new Date(row.available_at).getTime();
        return Number.isFinite(at) && at >= nowMs - duration && at <= nowMs;
      }).map(toSimulationRecord);
      output[capital][label] = simulatePortfolio(cohort, { startingBankroll: capital });
    }
  }
  return output;
}

function summarizeStrategies(rows, now = new Date()) {
  const summaries = STATISTICAL_LANES.map((lane) => {
    const laneRows = rows.filter((row) => row.strategy === lane.strategy);
    const summary = summarizeArm(laneRows, {
      strategy: lane.strategy, phase: 'eval', status: 'COLLECTING',
    }, now, { scope: 'current' });
    return { ...lane, ...summary };
  });
  const adjusted = holmAdjust(summaries.map((row) => row.conservativeOneSidedP));
  summaries.forEach((row, index) => { row.holmAdjustedP = adjusted[index]; });
  return summaries;
}

async function loadRows(pool, epoch) {
  const experimentIds = STATISTICAL_LANES.map((row) => row.experimentId);
  const { rows } = await pool.query(`
    SELECT o.id,o.strategy,o.experiment_id,o.phase,o.market_id,o.token,o.ts,
           o.available_at,o.source_event_id,o.features,
           s.filled,s.fill_ts,s.fill_price,s.fill_size,s.pnl_1x,s.pnl_2x,s.detail,
           COALESCE(s.data_quality_grade,'F') data_quality_grade,
           COALESCE(s.execution_fidelity_grade,'F') execution_fidelity_grade,
           m.window_end,m.resolved_at,COALESCE(m.asset,'unknown') asset
      FROM borg_shadow_orders o
      LEFT JOIN borg_shadow_scores s ON s.order_id=o.id
      LEFT JOIN borg_markets m ON m.id=o.market_id
     WHERE o.action='place'
       AND o.experiment_id=ANY($1::text[])
       AND o.features->>'collection_epoch_id'=$2
       AND COALESCE(o.available_at,o.ts)>=$3
     ORDER BY COALESCE(o.available_at,o.ts),o.id
  `, [experimentIds, epoch.id, epoch.startedAt]);
  return rows;
}

async function currentEpoch(pool) {
  const { rows } = await pool.query(`
    SELECT r.epoch_id id,e.started_at,r.code_version
      FROM borg_collector_runs r
      JOIN borg_collection_epochs e ON e.epoch_id=r.epoch_id
     WHERE r.status='RUNNING'
     ORDER BY r.started_at DESC LIMIT 1
  `);
  if (!rows[0]) throw new Error('No RUNNING collector evidence epoch');
  return {
    id: rows[0].id,
    startedAt: new Date(rows[0].started_at).toISOString(),
    codeVersion: rows[0].code_version,
  };
}

async function buildReport(pool, options = {}) {
  const now = options.now || new Date();
  const epoch = options.epoch || await currentEpoch(pool);
  const [rows, priority] = await Promise.all([
    loadRows(pool, epoch),
    buildPriorityLaneStatus(pool, { now }),
  ]);
  const statistical = summarizeStrategies(rows, now);
  return {
    format: 'deltaforge-edge-portfolio-report-v1',
    generatedAt: now.toISOString(),
    evidenceEpoch: epoch,
    accounting: 'Fresh epoch only; joint A/B fills; doubled costs; shared capital; no upward extrapolation beyond displayed recorded fill capacity.',
    statistical,
    portfolioScenarios: buildScenarios(rows, now),
    deterministicLanes: priority.lanes,
    resolverTimestampPrecision: {
      experimentId: 'resolver-timestamp-precision-audit-v1',
      evidenceAt: '2026-08-03T14:49:03.716Z',
      scannedRules: 87729,
      certifiedUnits: 0,
      positiveDoubledCostEpisodes: 0,
      executableCapacityUsd: 0,
      status: 'FALSIFIED_UNDER_CURRENT_RULE_WORDING',
    },
    promotionReady: false,
    conclusion: 'No lane currently meets the promotion contract. Positive small-sample lines remain hypotheses; zero-entry deterministic lanes remain valid scanner results.',
  };
}

function renderReport(report) {
  const lines = [
    '# Edge portfolio report',
    '',
    `Generated ${report.generatedAt}; epoch \`${report.evidenceEpoch.id}\` began ${report.evidenceEpoch.startedAt} on ${report.evidenceEpoch.codeVersion || 'unknown release'}.`,
    '',
    report.accounting,
    '',
    '## Fresh statistical lanes',
    '',
    '| Lane | A/B fills | Markets | Days | 2× P&L | First / second half | Market LCB | Holm p |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const row of report.statistical) {
    lines.push(`| ${row.laneId} | ${row.eligibleFills} | ${row.independentMarkets} | ${row.calendarDays} | ${money(row.pnl2x)} | ${money(row.firstHalfPnl2x)} / ${money(row.secondHalfPnl2x)} | ${row.marketClusteredMeanCi95[0] == null ? '—' : money(row.marketClusteredMeanCi95[0])} | ${finite(row.holmAdjustedP, 1).toFixed(4)} |`);
  }
  lines.push(
    '',
    '## Shared-bankroll doubled-cost replay',
    '',
    '| Capital | Horizon | Admitted | Settled | 2× P&L | End balance | Max drawdown | Avg gross-limit use |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|',
  );
  for (const capital of CAPITAL_SCENARIOS) {
    for (const [label] of HORIZONS) {
      const row = report.portfolioScenarios[capital][label];
      lines.push(`| $${capital} | ${label} | ${row.admittedOrders} | ${row.settledPositions} | ${money(row.realizedPnl1x)} | $${finite(row.endingBankroll).toFixed(2)} | ${money(row.maxDrawdownUsd)} | ${(100 * finite(row.averageGrossUtilization)).toFixed(2)}% |`);
    }
  }
  lines.push(
    '',
    'The $1,000 case does not upscale beyond captured displayed fill capacity. Equal P&L across capital cases means no additional measured capacity—not that returns scale linearly.',
    '',
    '## Non-statistical lanes',
    '',
    '| Program | Runtime | Current state |',
    '|---|---|---|',
  );
  for (const lane of report.deterministicLanes) {
    lines.push(`| ${lane.program} | ${lane.active ? 'ACTIVE' : 'INACTIVE/STAGED'} | ${lane.status} |`);
  }
  lines.push(
    `| resolver_timestamp_precision | INACTIVE AUDIT | ${report.resolverTimestampPrecision.status}; ${report.resolverTimestampPrecision.positiveDoubledCostEpisodes} positive episodes; $${report.resolverTimestampPrecision.executableCapacityUsd.toFixed(2)} capacity |`,
    '',
    `**Investment conclusion:** ${report.conclusion}`,
    '',
    '$100/day on $500 is a 20% daily return and is not a planning assumption. No result in this report authorizes live trading.',
    '',
  );
  return lines.join('\n');
}

async function main() {
  const pool = createResearchPool({
    applicationName: 'edge-portfolio-report', statementTimeoutMs: 60000,
  });
  try {
    const report = await buildReport(pool);
    console.log(process.argv.includes('--json') ? JSON.stringify(report, null, 2) : renderReport(report));
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

module.exports = {
  CAPITAL_SCENARIOS,
  HORIZONS,
  STATISTICAL_LANES,
  buildReport,
  buildScenarios,
  eligible,
  renderReport,
  summarizeStrategies,
  toSimulationRecord,
};
