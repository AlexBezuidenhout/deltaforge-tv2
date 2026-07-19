#!/usr/bin/env node
'use strict';

/**
 * Executable opposite-signal autopsy for BORG taker hypotheses.
 *
 * This is deliberately read-only and discovery-only. It buys the complement
 * token at the recorded opposite ask, applies the original order's latency and
 * price cushion, caps fills at recorded depth, holds intended dollars constant,
 * and charges the same Polymarket fee curve. Negating historical PnL would skip
 * every one of those frictions and is not a tradable counterfactual.
 */
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const { binaryPnl, simulateTakerTouch } = require('../borg/research/execution-kernel');

const EXCLUDED_STRATEGIES = new Set(['H1_pair_arb_2x']);

function number(value, fallback = null) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isPositiveToken(token, positiveLabel) {
  const value = String(token || '').toUpperCase();
  const configured = String(positiveLabel || '').toUpperCase();
  return value === 'UP' || value === 'YES' || (configured && value === configured);
}

function levels(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.map((level) => ({
    price: number(Array.isArray(level) ? level[0] : level?.price),
    size: number(Array.isArray(level) ? level[1] : level?.size),
  })).filter((level) => level.price != null && level.size > 0)
    .sort((left, right) => left.price - right.price);
}

function walkBook(bookLevels, requestedSize, limitPrice) {
  const requested = number(requestedSize, 0);
  const limit = number(limitPrice);
  let filled = 0;
  let cost = 0;
  let capacity = 0;
  if (!(requested > 0) || limit == null) return { filled: false, fillSize: 0, fillPrice: null, capacity: 0 };
  for (const level of levels(bookLevels)) {
    if (level.price > limit + 1e-9) break;
    capacity += level.size;
    const take = Math.min(level.size, requested - filled);
    filled += take;
    cost += take * level.price;
    if (filled >= requested - 1e-9) break;
  }
  return {
    filled: filled > 0,
    fillSize: filled,
    fillPrice: filled > 0 ? cost / filled : null,
    capacity,
    partial: filled > 0 && filled + 1e-9 < requested,
  };
}

function inverseTerms(row, originalDecisionAsk, inverseDecisionAsk) {
  const originalLimit = number(row.price);
  const originalSize = number(row.size);
  const originalAsk = number(originalDecisionAsk);
  const inverseAsk = number(inverseDecisionAsk);
  if (!(originalLimit > 0) || !(originalSize > 0)) return { reason: 'invalid_original_order' };
  if (!(originalAsk > 0 && originalAsk < 1)) return { reason: 'original_decision_ask_missing' };
  if (!(inverseAsk > 0 && inverseAsk < 1)) return { reason: 'inverse_decision_ask_missing' };
  const intendedNotional = originalLimit * originalSize;
  const priceCushion = Math.max(0, originalLimit - originalAsk);
  const limitPrice = Math.min(0.999, inverseAsk + priceCushion);
  return {
    intendedNotional,
    priceCushion,
    limitPrice,
    requestedSize: intendedNotional / inverseAsk,
  };
}

function eventCounterfactual(row, terms) {
  const arrivalAsk = number(row.event_inverse_arrival_ask);
  const arrivalSize = number(row.event_inverse_arrival_size, 0);
  if (row.event_inverse_arrival_at == null) return { reason: 'inverse_arrival_touch_missing' };
  const arrivalMs = new Date(row.arrival_at).getTime();
  const stateMs = new Date(row.event_inverse_arrival_at).getTime();
  const simulated = simulateTakerTouch({
    limitPrice: terms.limitPrice,
    requestedSize: terms.requestedSize,
    bestAsk: arrivalAsk,
    askSize: arrivalSize,
    stateSource: 'event',
    stateAgeMs: arrivalMs - stateMs,
  });
  if (!simulated.filled) return {
    filled: false,
    noFillReason: simulated.quoteSurvived ? 'inverse_capacity_zero' : 'inverse_quote_did_not_survive',
    quality: simulated.dataQualityGrade,
  };
  return {
    filled: true,
    fillPrice: simulated.fillPrice,
    fillSize: simulated.fillSize,
    partial: simulated.partial,
    capacity: simulated.capacityAtArrival,
    quality: simulated.dataQualityGrade,
  };
}

function latencyCounterfactual(row, terms, inversePositive) {
  if (row.arrival_snap_at == null) return { reason: 'inverse_arrival_snapshot_missing' };
  const asks = inversePositive ? row.arrival_up_asks : row.arrival_down_asks;
  const walked = walkBook(asks, terms.requestedSize, terms.limitPrice);
  if (!walked.filled) return { ...walked, noFillReason: 'inverse_quote_did_not_survive' };
  return walked;
}

function makeRng(seed = 0x51f15e) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function quantile(sorted, probability) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * probability))];
}

function clusterInference(marketPnls, iterations = 5000, seed = 0x51f15e) {
  if (!marketPnls.length) return { mean: null, ci95: [null, null], pOneSided: null };
  const rng = makeRng(seed);
  const boot = [];
  let nullAtLeastObserved = 0;
  const observed = marketPnls.reduce((sum, value) => sum + value, 0) / marketPnls.length;
  for (let i = 0; i < iterations; i += 1) {
    let resampled = 0;
    let signed = 0;
    for (let j = 0; j < marketPnls.length; j += 1) {
      resampled += marketPnls[Math.floor(rng() * marketPnls.length)];
      const value = marketPnls[j];
      signed += rng() < 0.5 ? value : -value;
    }
    boot.push(resampled / marketPnls.length);
    if (signed / marketPnls.length >= observed - 1e-12) nullAtLeastObserved += 1;
  }
  boot.sort((a, b) => a - b);
  return {
    mean: observed,
    ci95: [quantile(boot, 0.025), quantile(boot, 0.975)],
    pOneSided: (nullAtLeastObserved + 1) / (iterations + 1),
  };
}

function holmAdjust(items) {
  const sorted = items.filter((item) => item.p != null).sort((a, b) => a.p - b.p);
  let running = 0;
  sorted.forEach((item, index) => {
    running = Math.max(running, Math.min(1, item.p * (sorted.length - index)));
    item.adjusted = running;
  });
  return Object.fromEntries(sorted.map((item) => [item.key, item.adjusted]));
}

const QUERY = `
  WITH candidates AS (
    SELECT o.id,o.strategy,o.phase,o.market_id,o.ts,
           COALESCE(o.available_at,o.ts) available_at,
           o.token,o.price,o.size,o.features,
           COALESCE(o.features->>'execution_model',o.execution_model_version,'') execution_model,
           CASE
             WHEN COALESCE(o.features->>'execution_model',o.execution_model_version,'')='latency_1s' THEN 1250
             WHEN COALESCE(o.features->>'execution_model',o.execution_model_version,'') ~ '^event_order_[0-9]+ms$'
               THEN substring(COALESCE(o.features->>'execution_model',o.execution_model_version,'') from 'event_order_([0-9]+)ms')::int
             ELSE NULL
           END latency_ms,
           s.filled original_filled,s.fill_price original_fill_price,s.fill_size original_fill_size,
           COALESCE(s.pnl_1x,0)::float original_pnl_1x,COALESCE(s.pnl_2x,0)::float original_pnl_2x,
           s.data_quality_grade,s.execution_fidelity_grade,s.simulator_version,
           m.outcome,m.positive_label,m.negative_label,m.up_token_id,m.down_token_id,m.window_end
      FROM borg_shadow_orders o
      JOIN borg_shadow_scores s ON s.order_id=o.id
      JOIN borg_markets m ON m.id=o.market_id
     WHERE o.action='place' AND o.side='BUY' AND o.order_kind='taker'
       AND s.simulator_version IS NOT NULL
       AND s.data_quality_grade IN ('A','B')
       AND COALESCE(s.execution_fidelity_grade,'F') <> 'F'
       AND m.outcome IS NOT NULL
  ), timed AS (
    SELECT c.*,c.available_at + make_interval(secs => c.latency_ms / 1000.0) arrival_at,
           CASE WHEN upper(c.token) IN ('UP','YES',upper(COALESCE(c.positive_label,'')))
                THEN c.up_token_id ELSE c.down_token_id END original_asset_id,
           CASE WHEN upper(c.token) IN ('UP','YES',upper(COALESCE(c.positive_label,'')))
                THEN c.down_token_id ELSE c.up_token_id END inverse_asset_id
      FROM candidates c WHERE c.latency_ms IS NOT NULL
  )
  SELECT t.*,
         eos.best_ask event_original_decision_ask,
         eis.best_ask event_inverse_decision_ask,
         eia.ts event_inverse_arrival_at,eia.best_ask event_inverse_arrival_ask,
         eia.ask_size event_inverse_arrival_size,
         ds.ts decision_snap_at,ds.up_best_ask decision_up_ask,ds.down_best_ask decision_down_ask,
         ars.ts arrival_snap_at,ars.up_asks arrival_up_asks,ars.down_asks arrival_down_asks
    FROM timed t
    LEFT JOIN LATERAL (
      SELECT best_ask FROM borg_clob_touch
       WHERE t.execution_model LIKE 'event_order_%'
         AND market_id=t.market_id AND asset_id=t.original_asset_id
         AND ts <= t.available_at AND ts > t.available_at-interval '1500 milliseconds'
         AND best_ask IS NOT NULL ORDER BY ts DESC LIMIT 1
    ) eos ON true
    LEFT JOIN LATERAL (
      SELECT best_ask FROM borg_clob_touch
       WHERE t.execution_model LIKE 'event_order_%'
         AND market_id=t.market_id AND asset_id=t.inverse_asset_id
         AND ts <= t.available_at AND ts > t.available_at-interval '1500 milliseconds'
         AND best_ask IS NOT NULL ORDER BY ts DESC LIMIT 1
    ) eis ON true
    LEFT JOIN LATERAL (
      SELECT ts,best_ask,ask_size FROM borg_clob_touch
       WHERE t.execution_model LIKE 'event_order_%'
         AND market_id=t.market_id AND asset_id=t.inverse_asset_id
         AND ts > t.available_at AND ts <= t.arrival_at
         AND best_ask IS NOT NULL ORDER BY ts DESC LIMIT 1
    ) eia ON true
    LEFT JOIN LATERAL (
      SELECT ts,up_best_ask,down_best_ask FROM borg_book_snaps
       WHERE t.execution_model='latency_1s' AND market_id=t.market_id
         AND ts <= t.available_at AND ts > t.available_at-interval '1500 milliseconds'
       ORDER BY ts DESC LIMIT 1
    ) ds ON true
    LEFT JOIN LATERAL (
      SELECT ts,up_asks,down_asks FROM borg_book_snaps
       WHERE t.execution_model='latency_1s' AND market_id=t.market_id
         AND ts >= t.available_at AND ts <= t.arrival_at
       ORDER BY ts DESC LIMIT 1
    ) ars ON true
   ORDER BY t.id
`;

function evaluateRow(row) {
  if (EXCLUDED_STRATEGIES.has(row.strategy)) return { reason: 'multi_leg_strategy_excluded' };
  const originalPositive = isPositiveToken(row.token, row.positive_label);
  const inversePositive = !originalPositive;
  const originalDecisionAsk = row.execution_model === 'latency_1s'
    ? (originalPositive ? row.decision_up_ask : row.decision_down_ask)
    : row.event_original_decision_ask;
  const inverseDecisionAsk = row.execution_model === 'latency_1s'
    ? (inversePositive ? row.decision_up_ask : row.decision_down_ask)
    : row.event_inverse_decision_ask;
  const terms = inverseTerms(row, originalDecisionAsk, inverseDecisionAsk);
  if (terms.reason) return terms;
  const fill = row.execution_model === 'latency_1s'
    ? latencyCounterfactual(row, terms, inversePositive)
    : eventCounterfactual(row, terms);
  if (fill.reason) return { ...fill, ...terms };
  if (!fill.filled) return { ...fill, ...terms, pnl1x: 0, pnl2x: 0 };
  const inverseToken = inversePositive
    ? (row.positive_label || 'UP') : (row.negative_label || 'DOWN');
  const one = binaryPnl({
    side: 'BUY', token: inverseToken, outcome: row.outcome,
    fillPrice: fill.fillPrice, fillSize: fill.fillSize,
    orderKind: 'taker', feeMultiplier: 1,
  });
  const two = binaryPnl({
    side: 'BUY', token: inverseToken, outcome: row.outcome,
    fillPrice: fill.fillPrice, fillSize: fill.fillSize,
    orderKind: 'taker', feeMultiplier: 2,
  });
  return { ...terms, ...fill, inverseToken, pnl1x: one.net, pnl2x: two.net };
}

function round(value, digits = 4) {
  return value == null ? null : +value.toFixed(digits);
}

function aggregate(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.strategy}\u0000${row.phase}`;
    if (!groups.has(key)) groups.set(key, {
      strategy: row.strategy, phase: row.phase, orders: 0, eligible: 0,
      originalFills: 0, inverseFills: 0, originalPnl1x: 0, originalPnl2x: 0,
      inversePnl1x: 0, inversePnl2x: 0, markets: new Map(), reasons: {},
      firstAt: row.ts, lastAt: row.ts,
    });
    const group = groups.get(key);
    group.orders += 1;
    group.firstAt = new Date(row.ts) < new Date(group.firstAt) ? row.ts : group.firstAt;
    group.lastAt = new Date(row.ts) > new Date(group.lastAt) ? row.ts : group.lastAt;
    const inverse = evaluateRow(row);
    if (inverse.reason) {
      group.reasons[inverse.reason] = (group.reasons[inverse.reason] || 0) + 1;
      continue;
    }
    if (inverse.noFillReason) {
      group.reasons[inverse.noFillReason] = (group.reasons[inverse.noFillReason] || 0) + 1;
    }
    group.eligible += 1;
    if (row.original_filled) group.originalFills += 1;
    if (inverse.filled) group.inverseFills += 1;
    group.originalPnl1x += number(row.original_pnl_1x, 0);
    group.originalPnl2x += number(row.original_pnl_2x, 0);
    group.inversePnl1x += inverse.pnl1x || 0;
    group.inversePnl2x += inverse.pnl2x || 0;
    const market = group.markets.get(row.market_id) || { end: row.window_end, pnl2x: 0 };
    market.pnl2x += inverse.pnl2x || 0;
    group.markets.set(row.market_id, market);
  }

  const results = [...groups.values()].map((group, index) => {
    const marketValues = [...group.markets.values()];
    const inference = clusterInference(marketValues.map((market) => market.pnl2x), 5000, 0x51f15e + index);
    const chronological = marketValues.sort((a, b) => new Date(a.end) - new Date(b.end));
    const midpoint = Math.floor(chronological.length / 2);
    const sum = (items) => items.reduce((total, item) => total + item.pnl2x, 0);
    return {
      strategy: group.strategy, phase: group.phase, orders: group.orders,
      eligible: group.eligible, markets: group.markets.size,
      originalFills: group.originalFills, inverseFills: group.inverseFills,
      originalPnl1x: round(group.originalPnl1x), originalPnl2x: round(group.originalPnl2x),
      inversePnl1x: round(group.inversePnl1x), inversePnl2x: round(group.inversePnl2x),
      inverseMarketMean2x: round(inference.mean),
      inverseMarketCi95_2x: inference.ci95.map((value) => round(value)),
      pOneSided: inference.pOneSided,
      firstHalfInversePnl2x: round(sum(chronological.slice(0, midpoint))),
      secondHalfInversePnl2x: round(sum(chronological.slice(midpoint))),
      coveragePct: group.orders ? round(100 * group.eligible / group.orders, 1) : 0,
      reasons: group.reasons, firstAt: group.firstAt, lastAt: group.lastAt,
    };
  });
  const adjusted = holmAdjust(results.map((row) => ({ key: `${row.strategy}\u0000${row.phase}`, p: row.pOneSided })));
  for (const row of results) row.holmP = adjusted[`${row.strategy}\u0000${row.phase}`] ?? null;
  return results.sort((a, b) => a.inversePnl2x - b.inversePnl2x);
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 1,
  });
  try {
    const { rows } = await pool.query(QUERY);
    const results = aggregate(rows);
    const systematicLosers = results.filter((row) => row.markets >= 20 && row.originalPnl2x < 0);
    const viableInverseDiscovery = systematicLosers.filter((row) =>
      row.inversePnl2x > 0
      && row.inverseMarketCi95_2x[0] > 0
      && row.firstHalfInversePnl2x > 0
      && row.secondHalfInversePnl2x > 0
      && row.holmP < 0.05);
    const report = {
      format: 'borg-executable-inverse-autopsy-v1',
      generatedAt: new Date().toISOString(),
      methodology: {
        scope: 'modern A/B-data-quality single-leg BUY takers with resolved outcomes',
        counterfactual: 'buy complement at recorded executable ask; same latency, dollar intent, price cushion, displayed depth and fee curve',
        inference: 'market-cluster bootstrap CI; one-sided clustered sign randomization; Holm correction across inspected strategy/phase rows',
        warning: 'All history inspected here is discovery data. A promising inverse requires a frozen forward-only paper arm and >=300 fresh independent markets; it is not authorization for live trading.',
      },
      candidateOrders: rows.length,
      systematicLosers,
      viableInverseDiscovery,
      allStrategies: results,
    };
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(report.methodology.warning);
    console.table(systematicLosers.map((row) => ({
      strategy: row.strategy, phase: row.phase, markets: row.markets,
      coverage: `${row.coveragePct}%`, original2x: row.originalPnl2x,
      inverse2x: row.inversePnl2x, inverseCiLow: row.inverseMarketCi95_2x[0],
      firstHalf: row.firstHalfInversePnl2x, secondHalf: row.secondHalfInversePnl2x,
      holmP: row.holmP == null ? null : round(row.holmP, 5),
    })));
    console.log(`Executable inverse discoveries passing every screen: ${viableInverseDiscovery.length}`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

module.exports = {
  aggregate, clusterInference, evaluateRow, holmAdjust, inverseTerms,
  isPositiveToken, levels, makeRng, walkBook,
};
