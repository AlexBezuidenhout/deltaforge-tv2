#!/usr/bin/env node
/**
 * H53 accidental five-minute favorite — independently gated live mirror.
 *
 * Signal discovery remains in the keyless BORG shadow process. This executor
 * mirrors only fresh H53 shadow intents and contains no model thresholds.
 * LIVE requires all of:
 *   1. H53_LIVE_ENABLED=1
 *   2. H53_LIVE_ACK=I_ACCEPT_UNPROVEN_H53_5M_LIVE
 *   3. bot_settings.live_h53_enabled=true
 *   4. a chmod-600 wallet key file (or POLYMARKET_PRIVATE_KEY)
 *   5. no global/H53 KILL file
 *
 * The operator explicitly requested live operation before the registered
 * evidence minimum. Hard execution invariants preserve the accidental rule:
 * exact shadow notional (never increased), <=$10, exact decision ask as the
 * FAK worst price, no chase, one live order per market, and hold to resolution.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');

const PolymarketFeed = require('../../src/bot/PolymarketFeed');
const RawWal = require('../recon/wal');

const STRATEGY = 'H53_5m_neareven_favorite_live_v1';
const EXPERIMENT_ID = 'research-h53-5m-neareven-favorite-live-v1';
const LIVE_ACK = 'I_ACCEPT_UNPROVEN_H53_5M_LIVE';
const HEARTBEAT_COMPONENT = 'h53_live';
const MAX_ORDER_USD = 10;
const MAX_SIGNAL_AGE_MS = 2500;
const MIN_VENUE_SHARES = 5;
const FEE_RATE = 0.07;
const FEE_EXPONENT = 1;
const POLL_MS = 100;
const MAX_CONCURRENT_ORDERS = 4;
const QUOTE_ROUNDING_TOLERANCE_USD = 0.00001;
const PRICE_INVARIANT_TOLERANCE = 0.0001;
const ASSETS = new Set(['btc', 'eth', 'sol', 'xrp']);
const TICK_SIZES = new Set(['0.1', '0.01', '0.001', '0.0001']);
const KILL_FILES = [
  path.join(__dirname, 'H53_KILL'),
  path.join(os.homedir(), '.deltaforge-live', 'KILL'),
  path.join(os.homedir(), '.deltaforge-live', 'H53_KILL'),
];

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function venueUnits(value) {
  const parsed = finite(value);
  if (parsed == null || parsed < 0) return null;
  return parsed > 10_000 ? parsed / 1_000_000 : parsed;
}

function candidateNotional(row) {
  const price = finite(row?.price);
  const size = finite(row?.size);
  return price != null && size != null ? price * size : null;
}

function takerFee(shares, price, feeRate = FEE_RATE, feeExponent = FEE_EXPONENT) {
  const parsedShares = finite(shares);
  const parsedPrice = finite(price);
  const parsedRate = finite(feeRate);
  const parsedExponent = finite(feeExponent);
  if (!(parsedShares >= 0) || !(parsedPrice > 0 && parsedPrice < 1)
    || !(parsedRate >= 0) || !(parsedExponent >= 0)) return null;
  return parsedShares * parsedRate * Math.pow(parsedPrice * (1 - parsedPrice), parsedExponent);
}

/**
 * CLOB market-BUY responses are the authoritative fill receipt:
 * makingAmount is quote collateral spent (before fee) and takingAmount is
 * outcome shares received. getOrder().price is only the signed worst limit and
 * must never be mistaken for average execution price.
 */
function parseMarketBuyFill(response, requestedNotional, worstPrice, executionInfo = {}) {
  const matchedNotional = venueUnits(response?.makingAmount);
  const matchedShares = venueUnits(response?.takingAmount);
  if (!(matchedNotional > 0) || !(matchedShares > 0)) return null;

  const requested = finite(requestedNotional);
  const limit = finite(worstPrice);
  if (!(requested > 0) || !(limit > 0 && limit < 1)) {
    throw new Error('fill_invariant_invalid_request');
  }
  if (matchedNotional > requested + QUOTE_ROUNDING_TOLERANCE_USD) {
    throw new Error(
      `fill_invariant_overspend actual=${matchedNotional.toFixed(6)} requested=${requested.toFixed(6)}`,
    );
  }

  const averageFillPrice = matchedNotional / matchedShares;
  if (!(averageFillPrice > 0 && averageFillPrice < 1)) {
    throw new Error(`fill_invariant_invalid_average price=${averageFillPrice}`);
  }
  if (averageFillPrice > limit + PRICE_INVARIANT_TOLERANCE) {
    throw new Error(
      `fill_invariant_price_breach average=${averageFillPrice.toFixed(6)} worst=${limit.toFixed(6)}`,
    );
  }

  const feeRate = finite(executionInfo.feeRate) ?? FEE_RATE;
  const feeExponent = finite(executionInfo.feeExponent) ?? FEE_EXPONENT;
  const feePaid = takerFee(matchedShares, averageFillPrice, feeRate, feeExponent);
  const roundedRequested = Math.floor((requested + 1e-9) * 100) / 100;
  const status = matchedNotional + QUOTE_ROUNDING_TOLERANCE_USD < roundedRequested
    ? 'PARTIAL'
    : 'MATCHED';
  return {
    status,
    matchedShares,
    matchedNotional,
    averageFillPrice,
    feePaid,
    feeRate,
    feeExponent,
    economicCost: matchedNotional + feePaid,
  };
}

function validateExecutionInfo(row, executionInfo) {
  if (!executionInfo || executionInfo.tokenVerified !== true) return 'market_metadata_unverified';
  if (!TICK_SIZES.has(String(executionInfo.tickSize))) {
    return 'tick_size_unverified';
  }
  if (executionInfo.acceptingOrders === false) return 'venue_not_accepting_orders';
  const minOrderSize = finite(executionInfo.minOrderSize);
  if (minOrderSize != null && finite(row?.size) + 1e-9 < minOrderSize) {
    return 'venue_minimum_dynamic';
  }

  // The frozen signal was admitted with the 7%/exponent-1 fee curve. A venue
  // schedule that is more expensive invalidates that admission; never trade it
  // blindly. A cheaper schedule does not alter the signal population.
  const price = finite(row?.price);
  const actualRate = finite(executionInfo.feeRate);
  const actualExponent = finite(executionInfo.feeExponent);
  if (!(price > 0 && price < 1) || !(actualRate >= 0) || !(actualExponent >= 0)) {
    return 'fee_schedule_unverified';
  }
  const modeledFeePerShare = FEE_RATE * price * (1 - price);
  const actualFeePerShare = actualRate * Math.pow(price * (1 - price), actualExponent);
  if (actualFeePerShare > modeledFeePerShare + 1e-9) return 'fee_schedule_exceeds_frozen_model';
  return null;
}

async function runWithConcurrency(rows, limit, worker) {
  let cursor = 0;
  const failures = [];
  const count = Math.min(Math.max(1, limit), rows.length);
  const runners = Array.from({ length: count }, async () => {
    while (cursor < rows.length) {
      const index = cursor;
      cursor += 1;
      try {
        await worker(rows[index]);
      } catch (error) {
        failures.push(error);
      }
    }
  });
  await Promise.all(runners);
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} concurrent H53 candidate(s) failed`);
  }
}

function isExpectedFakNonFill(error) {
  const message = String(error?.message || error || '');
  return /no orders found to match with FAK order/i.test(message)
    || /FAK order.*(?:partially filled or killed|no match)/i.test(message);
}

function validateCandidate(row, nowMs = Date.now()) {
  if (!row || row.strategy !== STRATEGY) return 'wrong_strategy';
  if (row.experiment_id !== EXPERIMENT_ID) return 'wrong_experiment';
  if (row.action !== 'place' || String(row.side || '').toUpperCase() !== 'BUY') return 'wrong_action';
  if (row.market_type !== 'direction_5m') return 'wrong_market_type';
  if (!ASSETS.has(String(row.asset || '').toLowerCase())) return 'unsupported_asset';
  if (!row.token_id) return 'missing_token_id';

  const availableAt = new Date(row.available_at || row.ts).getTime();
  const ageMs = nowMs - availableAt;
  if (!Number.isFinite(ageMs) || ageMs < -100 || ageMs > MAX_SIGNAL_AGE_MS) return 'stale_signal';
  const windowEnd = new Date(row.window_end).getTime();
  if (!Number.isFinite(windowEnd) || nowMs >= windowEnd) return 'market_closed';

  const tte = finite(row.tte_sec);
  const price = finite(row.price);
  const size = finite(row.size);
  const notional = candidateNotional(row);
  if (!(tte >= 60 && tte <= 300)) return 'outside_frozen_tte';
  if (!(price >= 0.50 && price <= 0.60)) return 'outside_frozen_price';
  if (!(size > 0) || !(notional >= 1 && notional <= MAX_ORDER_USD + 1e-6)) return 'invalid_frozen_size';
  if (size + 1e-9 < MIN_VENUE_SHARES) return 'venue_minimum';

  const features = row.features || {};
  if (Math.abs(finite(features.frozen_fair_favorite) - 0.675) > 1e-9) return 'wrong_frozen_fair';
  if (Math.abs(finite(features.depth_participation) - 0.20) > 1e-9) return 'wrong_depth_participation';
  const edge2x = 0.675 - price - 2 * FEE_RATE * price * (1 - price);
  if (edge2x < 0.01 - 1e-9) return 'wrong_edge_hurdle';
  return null;
}

function poolConfig() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const local = /(?:localhost|127\.0\.0\.1|\/deltaforge)/i.test(connectionString);
  return { connectionString, ssl: local ? false : { rejectUnauthorized: false }, max: 6 };
}

function loadWallet() {
  let privateKey = process.env.POLYMARKET_PRIVATE_KEY || null;
  let signerAddress = null;
  let funderAddress = process.env.POLYMARKET_FUNDER_ADDRESS || null;
  let signatureType = process.env.POLYMARKET_SIGNATURE_TYPE || null;
  const keyFile = process.env.POLYMARKET_KEY_FILE
    || path.join(os.homedir(), '.deltaforge-live', 'active-account.json');
  if (!privateKey && fs.existsSync(keyFile)) {
    const stat = fs.statSync(keyFile);
    if ((stat.mode & 0o077) !== 0) throw new Error(`${keyFile} must be chmod 600`);
    const wallet = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    privateKey = wallet.privateKey || null;
    signerAddress = wallet.address || null;
    funderAddress = funderAddress || wallet.funderAddress || null;
    if (signatureType == null && wallet.signatureType != null) signatureType = String(wallet.signatureType);
  }
  if (signatureType === '1') signatureType = 'POLY_1271';
  return { privateKey, signerAddress, funderAddress, signatureType: signatureType || 'EOA', keyFile };
}

let pool = null;
let feed = null;
let dryRun = true;
let startedAt = new Date();
let polling = false;
let lastBalance = null;
let lastBalanceAt = 0;
let balanceRefreshPromise = null;
let reservedCollateral = 0;
let executionHaltReason = null;
let executionWal = null;
let errors = 0;
const processing = new Set();
const log = (...args) => console.log(new Date().toISOString(), ...args);
const killed = () => KILL_FILES.some((file) => fs.existsSync(file));

async function ensureSchema() {
  await pool.query(`ALTER TABLE bot_settings
    ADD COLUMN IF NOT EXISTS live_h53_enabled BOOLEAN DEFAULT false`);
  await pool.query(`CREATE TABLE IF NOT EXISTS h53_live_orders (
    id BIGSERIAL PRIMARY KEY,
    shadow_order_id BIGINT UNIQUE NOT NULL REFERENCES borg_shadow_orders(id),
    market_id INT NOT NULL REFERENCES borg_markets(id),
    condition_id TEXT,
    token_id TEXT NOT NULL,
    token TEXT NOT NULL,
    signal_price NUMERIC NOT NULL,
    signal_size NUMERIC NOT NULL,
    requested_notional NUMERIC NOT NULL,
    worst_price NUMERIC NOT NULL,
    dry_run BOOLEAN NOT NULL,
    status TEXT NOT NULL,
    clob_order_id TEXT,
    response JSONB,
    acknowledged_at TIMESTAMPTZ,
    acknowledgement_latency_ms INT,
    matched_shares NUMERIC,
    matched_notional NUMERIC,
    average_fill_price NUMERIC,
    fee_paid NUMERIC,
    fee_rate NUMERIC,
    fee_exponent NUMERIC,
    tick_size NUMERIC,
    resolved_outcome TEXT,
    realized_pnl NUMERIC,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`ALTER TABLE h53_live_orders
    ADD COLUMN IF NOT EXISTS fee_rate NUMERIC,
    ADD COLUMN IF NOT EXISTS fee_exponent NUMERIC,
    ADD COLUMN IF NOT EXISTS tick_size NUMERIC`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS h53_live_orders_one_live_market
    ON h53_live_orders(market_id) WHERE NOT dry_run`);
  await pool.query(`CREATE INDEX IF NOT EXISTS h53_live_orders_created
    ON h53_live_orders(created_at DESC)`);
}

async function heartbeat(extra = {}) {
  await pool.query(`
    INSERT INTO system_heartbeats(component,beat_at,meta)
    VALUES($1,now(),$2::jsonb)
    ON CONFLICT(component) DO UPDATE SET beat_at=now(),meta=EXCLUDED.meta`, [
    HEARTBEAT_COMPONENT,
    JSON.stringify({
      pid: process.pid,
      dryRun,
      strategy: STRATEGY,
      experimentId: EXPERIMENT_ID,
      balanceUsdc: lastBalance,
      errors,
      executionHaltReason,
      reservedCollateralUsd: reservedCollateral,
      startedAt: startedAt.toISOString(),
      ...extra,
    }),
  ]).catch(() => {});
}

async function heartbeatCycle() {
  if (!dryRun) {
    try {
      await refreshBalance(true);
    } catch (error) {
      errors += 1;
      log(`balance heartbeat refresh failed: ${error.message}`);
    }
  }
  await heartbeat();
}

async function record(row, status, error = null, isDry = dryRun) {
  const notional = Math.min(MAX_ORDER_USD, candidateNotional(row) || 0);
  await pool.query(`INSERT INTO h53_live_orders(
      shadow_order_id,market_id,condition_id,token_id,token,signal_price,signal_size,
      requested_notional,worst_price,dry_run,status,error)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT(shadow_order_id) DO NOTHING`, [
    row.id, row.market_id, row.condition_id, row.token_id, row.token,
    finite(row.price) || 0, finite(row.size) || 0, notional,
    finite(row.price) || 0, isDry, status, error,
  ]);
}

async function refreshBalance(force = false) {
  if (!feed) return null;
  if (!force && Date.now() - lastBalanceAt < 1000) return lastBalance;
  if (balanceRefreshPromise) return balanceRefreshPromise;
  balanceRefreshPromise = (async () => {
    const result = await PolymarketFeed.fetchBalance(
      feed.privateKey, feed.walletAddress, feed.signatureType, feed.funderAddress,
    );
    lastBalance = finite(result?.usdc);
    lastBalanceAt = Date.now();
    return lastBalance;
  })();
  try {
    return await balanceRefreshPromise;
  } finally {
    balanceRefreshPromise = null;
  }
}

function reserveBalance(balance, amount) {
  if (!(balance >= 0) || !(amount > 0) || balance - reservedCollateral + 1e-9 < amount) return false;
  reservedCollateral += amount;
  return true;
}

function releaseBalance(amount) {
  reservedCollateral = Math.max(0, reservedCollateral - amount);
}

async function claimLive(row, notional) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(7053001)');
    const existing = await client.query(`SELECT 1 FROM h53_live_orders
      WHERE market_id=$1 AND NOT dry_run LIMIT 1`, [row.market_id]);
    if (existing.rowCount > 0) {
      await client.query('ROLLBACK');
      return { claimId: null, duplicateMarket: true };
    }
    const claim = await client.query(`INSERT INTO h53_live_orders(
        shadow_order_id,market_id,condition_id,token_id,token,signal_price,signal_size,
        requested_notional,worst_price,dry_run,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,false,'PLACING')
      ON CONFLICT DO NOTHING RETURNING id`, [
      row.id, row.market_id, row.condition_id, row.token_id, row.token,
      row.price, row.size, notional, row.price,
    ]);
    await client.query('COMMIT');
    return { claimId: claim.rows[0]?.id || null, duplicateMarket: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function persistFill(liveOrderId, fill, status = fill?.status) {
  if (!fill) return;
  await pool.query(`UPDATE h53_live_orders SET
    status=$2,matched_shares=$3,matched_notional=$4,average_fill_price=$5,
    fee_paid=$6,fee_rate=$7,fee_exponent=$8,updated_at=now() WHERE id=$1`, [
    liveOrderId, status, fill.matchedShares, fill.matchedNotional,
    fill.averageFillPrice, fill.feePaid, fill.feeRate, fill.feeExponent,
  ]);
}

function haltExecution(error) {
  if (executionHaltReason) return;
  executionHaltReason = String(error?.message || error).slice(0, 500);
  errors += 1;
  log(`H53 EXECUTION HALTED: ${executionHaltReason}`);
}

function appendExecutionWal(event, payload) {
  if (!executionWal) throw new Error('H53 execution WAL is unavailable');
  return executionWal.append(JSON.stringify({
    event,
    recordedAt: new Date().toISOString(),
    strategy: STRATEGY,
    ...payload,
  }), { channel: event });
}

async function reconcileFill(liveOrderId, orderId) {
  if (!feed || !orderId) return;
  try {
    const stored = await pool.query(`SELECT response,requested_notional,worst_price,
      fee_rate,fee_exponent FROM h53_live_orders WHERE id=$1`, [liveOrderId]);
    const row = stored.rows[0];
    if (!row) return;
    const responseFill = parseMarketBuyFill(
      row.response,
      row.requested_notional,
      row.worst_price,
      { feeRate: row.fee_rate, feeExponent: row.fee_exponent },
    );
    if (responseFill) {
      await persistFill(liveOrderId, responseFill);
      return;
    }

    const order = await feed.fetchOrder(orderId);
    if (!order) return;
    const matchedShares = venueUnits(order.size_matched ?? order.sizeMatched);
    // `order.price` is the worst-price limit, not an execution average. If the
    // response receipt was absent and the API exposes no true average, retain
    // matched size/status but leave cost pending rather than inventing PnL.
    const fillPrice = finite(order.avg_price ?? order.average_price);
    const matchedNotional = matchedShares != null && fillPrice > 0 ? matchedShares * fillPrice : null;
    const feeRate = finite(row.fee_rate) ?? FEE_RATE;
    const feeExponent = finite(row.fee_exponent) ?? FEE_EXPONENT;
    const fee = matchedShares > 0 && fillPrice > 0
      ? takerFee(matchedShares, fillPrice, feeRate, feeExponent)
      : null;
    const originalShares = venueUnits(order.original_size ?? order.size);
    const status = matchedShares > 0
      ? (fillPrice == null
        ? 'MATCHED_RECONCILIATION_PENDING'
        : (originalShares != null && originalShares > matchedShares + 1e-9 ? 'PARTIAL' : 'MATCHED'))
      : String(order.status || 'UNFILLED').toUpperCase();
    await pool.query(`UPDATE h53_live_orders SET
      status=$2,matched_shares=$3,matched_notional=$4,average_fill_price=$5,
      fee_paid=$6,fee_rate=$7,fee_exponent=$8,updated_at=now() WHERE id=$1`, [
      liveOrderId, status, matchedShares || null, matchedNotional, fillPrice, fee,
      feeRate, feeExponent,
    ]);
  } catch (error) {
    if (/^fill_invariant_/.test(String(error?.message || ''))) haltExecution(error);
    else errors += 1;
    log(`fill reconciliation failed for ${String(orderId).slice(0, 14)}: ${error.message}`);
  }
}

async function processCandidate(row) {
  const key = String(row.id);
  if (processing.has(key)) return;
  processing.add(key);
  try {
    const invalid = validateCandidate(row);
    if (invalid) {
      await record(row, `SKIPPED_${invalid.toUpperCase()}`, invalid);
      log(`skip shadow #${row.id}: ${invalid}`);
      return;
    }
    if (killed()) {
      await record(row, 'SKIPPED_KILL_SWITCH', 'kill_switch');
      return;
    }
    if (executionHaltReason) {
      await record(row, 'SKIPPED_EXECUTION_INVARIANT', executionHaltReason, false);
      return;
    }
    const gate = await pool.query(`SELECT live_h53_enabled FROM bot_settings WHERE user_id=1`);
    if (!dryRun && gate.rows[0]?.live_h53_enabled !== true) {
      await record(row, 'SKIPPED_DB_GATE_CLOSED', 'db_gate_closed', false);
      return;
    }
    if (dryRun) {
      await record(row, 'DRY_RUN_READY');
      log(`DRY H53 #${row.id}: BUY ${row.token} $${candidateNotional(row).toFixed(2)} FAK worst=${finite(row.price).toFixed(2)}`);
      return;
    }

    const notional = +candidateNotional(row).toFixed(6);
    const [balance, executionInfo] = await Promise.all([
      refreshBalance(false),
      feed.fetchMarketExecutionInfo(row.condition_id, row.token_id),
    ]);
    const metadataInvalid = validateExecutionInfo(row, executionInfo);
    if (metadataInvalid) {
      await record(row, `SKIPPED_${metadataInvalid.toUpperCase()}`, metadataInvalid, false);
      log(`skip shadow #${row.id}: ${metadataInvalid}`);
      return;
    }
    const feeCushion = notional * 0.04;
    const collateralReservation = notional + feeCushion;
    if (balance == null || !reserveBalance(balance, collateralReservation)) {
      await record(row, 'SKIPPED_INSUFFICIENT_BALANCE',
        `balance=${balance == null ? 'unknown' : balance.toFixed(4)} reserved=${reservedCollateral.toFixed(4)} ` +
        `required=${collateralReservation.toFixed(4)}`, false);
      log(`skip shadow #${row.id}: insufficient collateral (${balance == null ? 'unknown' : '$' + balance.toFixed(2)})`);
      return;
    }
    try {
      const { claimId, duplicateMarket } = await claimLive(row, notional);
      if (duplicateMarket) {
        await record(row, 'SKIPPED_DUPLICATE_MARKET', 'one_live_order_per_market', false);
        return;
      }
      if (!claimId) return;

      const preSendInvalid = validateCandidate(row);
      if (preSendInvalid || killed() || executionHaltReason) {
        const reason = preSendInvalid || (killed() ? 'kill_switch' : 'execution_invariant');
        await pool.query(`UPDATE h53_live_orders SET status=$2,error=$3,updated_at=now() WHERE id=$1`, [
          claimId, `SKIPPED_${reason.toUpperCase()}`, reason,
        ]);
        return;
      }

      const sentAt = Date.now();
      let acknowledged = null;
      try {
        try {
          appendExecutionWal('order_intent', {
            shadowOrderId: row.id,
            liveOrderId: claimId,
            marketId: row.market_id,
            conditionId: row.condition_id,
            tokenId: row.token_id,
            token: row.token,
            requestedNotional: notional,
            worstPrice: finite(row.price),
            executionInfo,
          });
        } catch (walError) {
          haltExecution(new Error(`execution_wal_before_order: ${walError.message}`));
          throw walError;
        }
        const response = await feed.placeMarketBuyOrder(
          row.token_id, notional, finite(row.price), executionInfo,
        );
        const acknowledgedAt = Date.now();
        const orderId = response?.orderID || response?.order_id || response?.id || null;
        acknowledged = { response, acknowledgedAt, orderId };
        try {
          appendExecutionWal('order_acknowledgement', {
            shadowOrderId: row.id,
            liveOrderId: claimId,
            marketId: row.market_id,
            conditionId: row.condition_id,
            tokenId: row.token_id,
            sentAt: new Date(sentAt).toISOString(),
            acknowledgedAt: new Date(acknowledgedAt).toISOString(),
            acknowledgementLatencyMs: acknowledgedAt - sentAt,
            response,
            executionInfo,
          });
        } catch (walError) {
          haltExecution(new Error(`execution_wal_after_ack: ${walError.message}`));
        }
        let fill = null;
        let fillError = null;
        try {
          fill = parseMarketBuyFill(response, notional, finite(row.price), executionInfo);
        } catch (error) {
          fillError = error;
          haltExecution(error);
        }
        const venueStatus = fill?.status
          || (fillError ? 'MATCHED_FILL_INVARIANT' : String(response?.status || 'SUBMITTED').toUpperCase());
        const persistedResponse = { ...(response || {}), _deltaforgeExecution: executionInfo };
        await pool.query(`UPDATE h53_live_orders SET status=$2,clob_order_id=$3,response=$4::jsonb,
          acknowledged_at=$5,acknowledgement_latency_ms=$6,matched_shares=$7,
          matched_notional=$8,average_fill_price=$9,fee_paid=$10,fee_rate=$11,
          fee_exponent=$12,tick_size=$13,error=$14,updated_at=now() WHERE id=$1`, [
          claimId, venueStatus, orderId, JSON.stringify(persistedResponse),
          new Date(acknowledgedAt), acknowledgedAt - sentAt,
          fill?.matchedShares ?? null, fill?.matchedNotional ?? null,
          fill?.averageFillPrice ?? null, fill?.feePaid ?? null,
          finite(executionInfo.feeRate), finite(executionInfo.feeExponent),
          finite(executionInfo.tickSize), fillError ? String(fillError.message).slice(0, 500) : null,
        ]);
        log(`LIVE H53 #${row.id}: ${venueStatus} BUY ${row.token} $${notional.toFixed(2)} ` +
          `worst=${finite(row.price).toFixed(2)}${fill ? ` actual=${fill.averageFillPrice.toFixed(4)} cost=$${fill.economicCost.toFixed(4)}` : ''} ` +
          `ack=${acknowledgedAt - sentAt}ms order=${String(orderId || 'none').slice(0, 14)}`);
        if (orderId) {
          for (const delay of [500, 2000, 7500]) {
            setTimeout(() => reconcileFill(claimId, orderId), delay);
          }
        }
        lastBalanceAt = 0;
        setTimeout(() => refreshBalance(true).catch(() => {}), 1000);
      } catch (error) {
        const expectedNonFill = isExpectedFakNonFill(error);
        const failedAfterAck = acknowledged != null;
        const status = expectedNonFill
          ? 'UNFILLED_FAK'
          : (failedAfterAck ? 'ERROR_AFTER_ORDER_ACK' : 'ERROR');
        if (failedAfterAck) {
          haltExecution(new Error(`post_order_audit_failure: ${error.message}`));
        } else if (!expectedNonFill && !executionHaltReason) {
          errors += 1;
        }
        const persistedResponse = acknowledged?.response
          ? { ...acknowledged.response, _deltaforgeExecution: executionInfo }
          : null;
        await pool.query(`UPDATE h53_live_orders SET status=$2,error=$3,
          clob_order_id=COALESCE($4,clob_order_id),response=COALESCE($5::jsonb,response),
          acknowledged_at=COALESCE($6,acknowledged_at),
          acknowledgement_latency_ms=COALESCE($7,acknowledgement_latency_ms),updated_at=now()
          WHERE id=$1`, [
          claimId, status, String(error.message || error).slice(0, 500),
          acknowledged?.orderId || null,
          persistedResponse ? JSON.stringify(persistedResponse) : null,
          acknowledged ? new Date(acknowledged.acknowledgedAt) : null,
          acknowledged ? acknowledged.acknowledgedAt - sentAt : null,
        ]);
        log(`LIVE H53 #${row.id} ${expectedNonFill ? 'not filled at frozen FAK price' : 'failed'}: ${error.message}`);
      }
    } finally {
      releaseBalance(collateralReservation);
    }
  } finally {
    processing.delete(key);
  }
}

async function pollCandidates() {
  if (polling) return;
  polling = true;
  try {
    const { rows } = await pool.query(`
      SELECT o.id,o.ts,o.available_at,o.strategy,o.experiment_id,o.action,o.side,o.token,
             o.price,o.size,o.tte_sec,o.market_id,o.features,
             m.condition_id,m.asset,m.market_type,m.window_end,m.accepting_orders,
             CASE
               WHEN upper(o.token)=upper(COALESCE(m.positive_label,'UP')) THEN m.up_token_id
               WHEN upper(o.token)=upper(COALESCE(m.negative_label,'DOWN')) THEN m.down_token_id
               ELSE NULL
             END token_id
      FROM borg_shadow_orders o
      JOIN borg_markets m ON m.id=o.market_id
      LEFT JOIN h53_live_orders h ON h.shadow_order_id=o.id
      WHERE o.strategy=$1 AND o.action='place' AND h.id IS NULL
        AND o.ts >= $2 AND o.ts > now()-interval '5 seconds'
      ORDER BY o.id LIMIT 20`, [STRATEGY, new Date(startedAt.getTime() - MAX_SIGNAL_AGE_MS)]);
    await runWithConcurrency(rows, MAX_CONCURRENT_ORDERS, processCandidate);
  } catch (error) {
    errors += 1;
    log(`candidate poll failed: ${error.message}`);
  } finally {
    polling = false;
  }
}

async function reconcileResolutions() {
  await pool.query(`UPDATE h53_live_orders l SET
      resolved_outcome=m.outcome,
      realized_pnl=CASE
        WHEN upper(COALESCE(o.token,''))=upper(COALESCE(m.outcome,''))
          THEN l.matched_shares-l.matched_notional-COALESCE(l.fee_paid,0)
        ELSE -l.matched_notional-COALESCE(l.fee_paid,0)
      END,
      updated_at=now()
    FROM borg_shadow_orders o
    JOIN borg_markets m ON m.id=o.market_id
    WHERE l.shadow_order_id=o.id AND NOT l.dry_run AND l.matched_shares>0
      AND m.outcome IS NOT NULL AND l.resolved_outcome IS NULL`);
}

async function main() {
  pool = new Pool(poolConfig());
  await ensureSchema();
  const requestedLive = process.env.H53_LIVE_ENABLED === '1';
  const acknowledged = process.env.H53_LIVE_ACK === LIVE_ACK;
  const dbGate = (await pool.query(`SELECT live_h53_enabled FROM bot_settings WHERE user_id=1`))
    .rows[0]?.live_h53_enabled === true;
  const wallet = requestedLive ? loadWallet() : { privateKey: null };
  dryRun = !(requestedLive && acknowledged && dbGate && wallet.privateKey && !killed());
  if (requestedLive && dryRun) {
    log('H53 LIVE request refused; observer remains DRY.', {
      acknowledged, dbGate, walletLoaded: Boolean(wallet.privateKey), killed: killed(),
    });
  }
  if (!dryRun) {
    executionWal = new RawWal('h53-live-execution', { syncEveryMs: 0 });
    let signerAddress = wallet.signerAddress;
    if (!signerAddress) signerAddress = new (require('ethers').Wallet)(wallet.privateKey).address;
    feed = new PolymarketFeed(
      wallet.privateKey, signerAddress, null, null, null,
      wallet.signatureType, wallet.funderAddress,
    );
    await feed.initialize();
    if (!feed.clobClient) throw new Error('CLOB client did not initialize');
    const balance = await refreshBalance(true);
    if (!(balance > 0)) throw new Error(`No spendable Polymarket collateral detected (${balance})`);
  }

  startedAt = new Date();
  setInterval(() => pollCandidates().catch(() => {}), POLL_MS);
  setInterval(() => reconcileResolutions().catch((error) => {
    errors += 1; log(`resolution reconciliation failed: ${error.message}`);
  }), 30_000);
  setInterval(() => heartbeatCycle().catch(() => {}), 10_000);
  await heartbeat({ status: 'ready' });
  log(`H53 executor started — ${dryRun ? 'DRY OBSERVER' : '*** LIVE UNPROVEN OVERRIDE ***'}; ` +
    `exact shadow notional <=$${MAX_ORDER_USD}, FAK/no-chase, one order/market, wallet $${lastBalance == null ? '—' : lastBalance.toFixed(2)}`);
}

async function shutdown() {
  try { await pool?.query(`DELETE FROM system_heartbeats WHERE component=$1`, [HEARTBEAT_COMPONENT]); } catch (_) {}
  await executionWal?.close().catch(() => {});
  await pool?.end().catch(() => {});
  process.exit(0);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = {
  EXPERIMENT_ID,
  LIVE_ACK,
  MAX_ORDER_USD,
  MAX_SIGNAL_AGE_MS,
  MIN_VENUE_SHARES,
  STRATEGY,
  candidateNotional,
  isExpectedFakNonFill,
  parseMarketBuyFill,
  runWithConcurrency,
  takerFee,
  validateCandidate,
  validateExecutionInfo,
  venueUnits,
};
