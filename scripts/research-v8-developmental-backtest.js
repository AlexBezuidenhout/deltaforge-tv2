#!/usr/bin/env node
/**
 * Development-only replay for the V8 mechanisms that the normalized sampled
 * hot tier can reconstruct honestly.
 *
 * H64/H65 require synchronized source age/sequence state and H67/H68 require
 * event-level queue transitions, so this script deliberately reports them as
 * unsupported instead of fabricating an event backtest from sampled rows. Their forward
 * scorer and raw-WAL replay are the valid evidence paths.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const serviceEnv = process.env.TV2_ENV_FILE || '/etc/deltaforge/tv2.env';
if (!process.env.DATABASE_URL && fs.existsSync(serviceEnv)) {
  require('dotenv').config({ path: serviceEnv });
}
const { Pool } = require('pg');
const makeV8 = require('../borg/shadow/research-v8');

const {
  QuarticityConfidenceEnvelope,
  RangeThresholdPartitionLock,
  StationaryBlockBootstrapDigital,
  TokenElasticityResidual,
  CrossHorizonNestedLock,
  MarketPriorCalibrationResidual,
} = makeV8._test;

const TAKER_RATE = 0.07;
const ARRIVAL_MS = 1250;
const QUOTE_WINDOW_MS = 2000;

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integer(value) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function topBook(bid, bidSize, ask, askSize, at, source) {
  return {
    bids: bid > 0 && bidSize > 0 ? [[bid, bidSize]] : [],
    asks: ask > 0 && askSize > 0 ? [[ask, askSize]] : [],
    at,
    sourceAt: at,
    src: source,
  };
}

function normalize(row) {
  const ts = new Date(row.ts).getTime();
  return {
    id: integer(row.id),
    ts,
    marketId: integer(row.market_id),
    tteSec: finite(row.tte_sec),
    upBid: finite(row.up_best_bid),
    upBidSize: finite(row.up_best_bid_size),
    upAsk: finite(row.up_best_ask),
    upAskSize: finite(row.up_best_ask_size),
    downBid: finite(row.down_best_bid),
    downBidSize: finite(row.down_best_bid_size),
    downAsk: finite(row.down_best_ask),
    downAskSize: finite(row.down_best_ask_size),
    upMid: finite(row.up_mid),
    price: finite(row.btc_price),
    ref: finite(row.btc_ref),
    sigma: finite(row.sigma5m_ewma),
    phi: finite(row.phi_fair),
    chainlink: finite(row.rtds_chainlink),
    bookSrc: row.book_src || null,
  };
}

function lowerBound(rows, timestamp) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (rows[middle].ts < timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

function latencyFill(order, rowsByMarket) {
  const rows = rowsByMarket.get(order.marketId) || [];
  const earliest = order.ts + ARRIVAL_MS;
  const index = lowerBound(rows, earliest);
  const snapshot = rows[index];
  if (!snapshot || snapshot.ts > earliest + QUOTE_WINDOW_MS
      || /stale/i.test(snapshot.bookSrc || '')) return null;
  const positive = order.token === order.positiveLabel;
  const ask = positive ? snapshot.upAsk : snapshot.downAsk;
  const askSize = positive ? snapshot.upAskSize : snapshot.downAskSize;
  if (!(ask > 0 && askSize > 0) || ask > order.limitPrice + 1e-9) return null;
  const shares = Math.min(order.size, askSize);
  return shares > 0 ? { shares, price: ask, ts: snapshot.ts } : null;
}

function scoreOrder(order) {
  if (!order.fill) return null;
  const win = order.outcome === order.token;
  const payout = win ? 1 : 0;
  const gross = order.fill.shares * (payout - order.fill.price);
  const fee2x = order.fill.shares * 2 * TAKER_RATE
    * order.fill.price * (1 - order.fill.price);
  return {
    win,
    pnl2x: gross - fee2x,
    notional: order.fill.shares * order.fill.price,
  };
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function summarize(strategy, orders) {
  const strategyOrders = orders.filter((row) => row.strategy === strategy);
  const grouped = new Map();
  for (const order of strategyOrders) {
    const key = order.groupId || `single:${order.id}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(order);
  }
  const units = [];
  for (const [key, legs] of grouped) {
    const structural = !key.startsWith('single:');
    const complete = structural
      ? legs.every((leg) => leg.fill && leg.fill.shares >= leg.size - 1e-9)
      : Boolean(legs[0].fill);
    if (!complete) {
      units.push({ key, filled: false, marketKey: legs.map((leg) => leg.marketId).sort().join(':') });
      continue;
    }
    const scores = legs.map(scoreOrder);
    units.push({
      key,
      filled: true,
      marketKey: legs.map((leg) => leg.marketId).sort().join(':'),
      win: scores.every((score) => score.win),
      pnl2x: sum(scores.map((score) => score.pnl2x)),
      notional: sum(scores.map((score) => score.notional)),
      at: Math.max(...legs.map((leg) => leg.fill.ts)),
    });
  }
  const fills = units.filter((unit) => unit.filled).sort((a, b) => a.at - b.at);
  const half = Math.ceil(fills.length / 2);
  return {
    strategy,
    intendedUnits: units.length,
    filledUnits: fills.length,
    fillRatePct: units.length ? +(100 * fills.length / units.length).toFixed(1) : null,
    independentMarketRelationships: new Set(units.map((unit) => unit.marketKey)).size,
    winningUnits: fills.filter((unit) => unit.win).length,
    pnl2x: +sum(fills.map((unit) => unit.pnl2x)).toFixed(2),
    firstHalfPnl2x: +sum(fills.slice(0, half).map((unit) => unit.pnl2x)).toFixed(2),
    secondHalfPnl2x: +sum(fills.slice(half).map((unit) => unit.pnl2x)).toFixed(2),
    filledNotional: +sum(fills.map((unit) => unit.notional)).toFixed(2),
  };
}

async function load(pool) {
  const { rows: marketRows } = await pool.query(`
    SELECT id,asset,market_type,positive_label,negative_label,outcome,
           window_end,event_id,strike,lower_bound,upper_bound,
           resolution_source,chainlink_open,chainlink_open_src
      FROM borg_markets
     WHERE outcome IS NOT NULL
       AND market_type IN (
         'direction_5m','direction_15m','threshold_daily','range_daily'
       )
  `);
  const markets = new Map(marketRows.map((row) => [integer(row.id), {
    id: integer(row.id),
    asset: row.asset,
    market_type: row.market_type,
    positive_label: String(row.positive_label || 'UP').toUpperCase(),
    negative_label: String(row.negative_label || 'DOWN').toUpperCase(),
    outcome: String(row.outcome || '').toUpperCase(),
    window_end: new Date(row.window_end),
    event_id: row.event_id,
    strike: finite(row.strike),
    lower_bound: finite(row.lower_bound),
    upper_bound: finite(row.upper_bound),
    resolution_source: row.resolution_source,
    chainlink_open: finite(row.chainlink_open),
    chainlink_open_src: row.chainlink_open_src,
  }]));
  const { rows } = await pool.query(`
    SELECT b.id,b.ts,b.market_id,b.tte_sec,b.up_best_bid,b.up_best_ask,b.up_mid,
           b.down_best_ask,b.book_src,b.btc_price,b.btc_ref,
           b.up_bids->0->>1 AS up_best_bid_size,
           b.up_asks->0->>1 AS up_best_ask_size,
           b.down_bids->0->>0 AS down_best_bid,
           b.down_bids->0->>1 AS down_best_bid_size,
           b.down_asks->0->>1 AS down_best_ask_size,
           b.sigma5m_ewma,b.phi_fair,b.rtds_chainlink
      FROM borg_book_snaps b
      JOIN borg_markets m ON m.id=b.market_id
     WHERE m.outcome IS NOT NULL
       AND (
         (m.market_type IN ('direction_5m','direction_15m')
           AND b.tte_sec BETWEEN 1 AND 300)
         OR m.market_type IN ('threshold_daily','range_daily')
       )
     ORDER BY b.ts,b.market_id,b.id
  `);
  return {
    markets,
    rows: rows.map(normalize).filter((row) =>
      row.marketId != null && Number.isFinite(row.ts)),
  };
}

async function run(pool) {
  const { markets, rows } = await load(pool);
  const rowsByMarket = new Map();
  for (const row of rows) {
    if (!rowsByMarket.has(row.marketId)) rowsByMarket.set(row.marketId, []);
    rowsByMarket.get(row.marketId).push(row);
  }
  const strategies = [
    new RangeThresholdPartitionLock(),
    new QuarticityConfidenceEnvelope(),
    new StationaryBlockBootstrapDigital(),
    new TokenElasticityResidual(),
    new CrossHorizonNestedLock(),
    new MarketPriorCalibrationResidual(),
  ];
  const intended = [];
  const engine = {
    sequence: 0,
    _coid(strategy) {
      this.sequence += 1;
      return `v8-replay-${strategy}-${this.sequence}`;
    },
  };
  for (const row of rows) {
    const market = markets.get(row.marketId);
    if (!market || /stale/i.test(row.bookSrc || '') || !(row.price > 0)) continue;
    const upBook = topBook(row.upBid, row.upBidSize, row.upAsk,
      row.upAskSize, row.ts, row.bookSrc);
    const downBook = topBook(row.downBid, row.downBidSize, row.downAsk,
      row.downAskSize, row.ts, row.bookSrc);
    const context = {
      now: row.ts,
      market,
      marketType: market.market_type,
      tteSec: row.tteSec,
      upBook,
      downBook,
      upMid: row.upMid,
      btc: row.price,
      ref: row.ref,
      cexRef: row.ref,
      resolverRef: market.chainlink_open_src === 'chainlink_rtds_nearest_3s'
        ? market.chainlink_open : null,
      resolverRefSource: market.chainlink_open_src,
      sigma: row.sigma,
      phiFair: row.phi,
      modelFairPositive: row.phi,
      volatility: {
        robustSigma5m: row.sigma,
        rmsSigma5m: row.sigma,
      },
      rtdsChainlink: row.chainlink,
      // Snapshot rows do not preserve source age. Fail closed instead of
      // pretending the historical Chainlink observation was fresh.
      rtdsChainlinkAgeMs: null,
      venueStale: true,
      hyperStale: true,
      strike: market.strike,
      lowerBound: market.lower_bound,
      upperBound: market.upper_bound,
      triggerEvent: null,
    };
    for (const strategy of strategies) {
      if (!strategy.marketTypes.includes(market.market_type)) continue;
      for (const action of strategy.evaluate(context, engine) || []) {
        if (action.action !== 'place') continue;
        const targetMarket = markets.get(action.marketId ?? market.id);
        if (!targetMarket) continue;
        intended.push({
          id: intended.length + 1,
          strategy: strategy.name,
          ts: row.ts,
          marketId: targetMarket.id,
          positiveLabel: targetMarket.positive_label,
          outcome: targetMarket.outcome,
          token: action.token,
          limitPrice: finite(action.price),
          size: finite(action.size),
          groupId: action.groupId || null,
          features: action.features || {},
        });
      }
    }
  }
  for (const order of intended) order.fill = latencyFill(order, rowsByMarket);
  const results = strategies.map((strategy) => summarize(strategy.name, intended));
  return {
    format: 'research-v8-developmental-replay-v1',
    generatedAt: new Date().toISOString(),
    discoveryOnly: true,
    forwardEvidence: false,
    rows: rows.length,
    markets: rowsByMarket.size,
    firstTimestamp: rows.length ? new Date(rows[0].ts).toISOString() : null,
    lastTimestamp: rows.length ? new Date(rows.at(-1).ts).toISOString() : null,
    fillModel:
      '1.25s arrival; next recorded top ask within 2s; limit survival; displayed size; structural bundles require complete equal-share fills',
    feeModel: '2 × shares × 0.07 × p × (1-p)',
    unsupported: {
      H64_multivenue_cusum_break:
        'Normalized snapshots omit per-source age/sequence state.',
      H65_kalman_latent_consensus:
        'Normalized snapshots omit per-source age/sequence state.',
      H67_queue_depletion_hazard:
        'Sampled snapshots cannot reconstruct event queue hazards.',
      H68_multilevel_ofi_impact:
        'The normalized replay intentionally does not relabel sampled snapshots as CLOB events.',
    },
    results,
    disclosure: [
      'These rows were available during mechanism development and are not forward evidence.',
      'Zero orders can mean the executable hurdle correctly rejected every historical quote.',
      'Positive discovery PnL cannot be promoted or used to tune V8; the frozen post-cutoff cohort starts at zero.',
    ],
  };
}

async function main() {
  const localSocket = !process.env.DATABASE_URL && fs.existsSync('/var/run/postgresql');
  if (!process.env.DATABASE_URL && !localSocket) {
    throw new Error(`DATABASE_URL is missing; set it in .env or ${serviceEnv}`);
  }
  const local = localSocket
    || /(?:localhost|127\.0\.0\.1|\/deltaforge)/i.test(process.env.DATABASE_URL);
  const pool = new Pool(localSocket
    ? { host: '/var/run/postgresql', database: 'deltaforge', max: 2 }
    : {
        connectionString: process.env.DATABASE_URL,
        ssl: local ? false : { rejectUnauthorized: false },
        max: 2,
      });
  try {
    const report = await run(pool);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = {
  latencyFill,
  normalize,
  run,
  scoreOrder,
  summarize,
};
