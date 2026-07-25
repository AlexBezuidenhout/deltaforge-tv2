#!/usr/bin/env node
/**
 * ETH G-late exact-rule live canary.
 *
 * Signal discovery remains in the keyless BORG shadow collector. This process
 * can only mirror a fresh ETH_G_late_exact_forward_v1 shadow intent carrying
 * the frozen manifest hash. The historical ETH slice remains discovery data;
 * live fills are written to a separate table and never count toward the
 * forward paper trial.
 *
 * LIVE requires every independent gate:
 *   1. ETH_G_LATE_LIVE_ENABLED=1
 *   2. ETH_G_LATE_LIVE_ACK=I_ACCEPT_UNPROVEN_POSTHOC_ETH_G_LATE_LIVE
 *   3. bot_settings.live_eth_g_late_enabled=true
 *   4. a chmod-600 wallet key file
 *   5. no global/strategy KILL file
 *   6. Polymarket's official geoblock endpoint explicitly returns blocked=false
 *
 * The live canary deliberately does not copy the $10 research stake. It buys
 * only the venue-minimum number of shares, capped at $5, using FAK at the exact
 * captured ask (no chase and no resting-order adverse selection). Hard caps:
 * five submissions/$25 gross spend per UTC day, -$10 resolved PnL per UTC day,
 * fifty submissions total, and one live order per market.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');

const PolymarketFeed = require('../../src/bot/PolymarketFeed');
const RawWal = require('../recon/wal');
const {
  isExpectedFakNonFill,
  parseMarketBuyFill,
  takerFee,
  venueUnits,
} = require('./h53-executor');

const STRATEGY = 'ETH_G_late_exact_forward_v1';
const EXPERIMENT_ID = 'eth-g-late-exact-forward-v1';
const MANIFEST_HASH = '561b5cad1fe1338254c63776f41dee8293f3103313a33c8a70449d76de2c9c35';
const STRATEGY_VERSION = 'exact-original-g-rule-eth-only-v1';
const LIVE_ACK = 'I_ACCEPT_UNPROVEN_POSTHOC_ETH_G_LATE_LIVE';
const HEARTBEAT_COMPONENT = 'eth_g_late_live';
const GEO_ENDPOINT = 'https://polymarket.com/api/geoblock';
const MAX_ORDER_USD = 5;
const MAX_ORDERS_PER_UTC_DAY = 5;
const MAX_SPEND_PER_UTC_DAY = 25;
const MAX_RESOLVED_LOSS_PER_UTC_DAY = 10;
const MAX_PILOT_SUBMISSIONS = 50;
const MAX_SIGNAL_AGE_MS = 2500;
const MIN_VENUE_SHARES = 5;
const FEE_RATE = 0.07;
const FEE_EXPONENT = 1;
const POLL_MS = 100;
const TICK_SIZES = new Set(['0.1', '0.01', '0.001', '0.0001']);
const KILL_FILES = [
  path.join(__dirname, 'ETH_G_LATE_KILL'),
  path.join(os.homedir(), '.deltaforge-live', 'KILL'),
  path.join(os.homedir(), '.deltaforge-live', 'ETH_G_LATE_KILL'),
];

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sourceNotional(row) {
  const price = finite(row?.price);
  const size = finite(row?.size);
  return price != null && size != null ? price * size : null;
}

function tokenProbability(row) {
  const phi = finite(row?.features?.phi_fair);
  if (!(phi >= 0 && phi <= 1)) return null;
  const token = String(row?.token || '').toUpperCase();
  if (token === String(row?.positive_label || 'UP').toUpperCase()) return phi;
  if (token === String(row?.negative_label || 'DOWN').toUpperCase()) return 1 - phi;
  return null;
}

function pilotNotional(row, executionInfo = {}) {
  const price = finite(row?.price);
  const dynamicMinimum = finite(executionInfo.minOrderSize);
  const minimumShares = Math.max(MIN_VENUE_SHARES, dynamicMinimum || 0);
  if (!(price > 0 && price < 1) || !(minimumShares > 0)) return null;
  // BUY amount is quote notional. Round upward to cents so amount / worst
  // price cannot fall a fraction below the venue's share minimum.
  const notional = Math.ceil(minimumShares * price * 100 - 1e-9) / 100;
  const feeRate = finite(executionInfo.feeRate) ?? FEE_RATE;
  const feeExponent = finite(executionInfo.feeExponent) ?? FEE_EXPONENT;
  const estimatedShares = notional / price;
  const estimatedFee = takerFee(estimatedShares, price, feeRate, feeExponent);
  return estimatedFee != null && notional + estimatedFee <= MAX_ORDER_USD + 1e-9
    ? notional
    : null;
}

function validateCandidate(row, nowMs = Date.now()) {
  if (!row || row.strategy !== STRATEGY) return 'wrong_strategy';
  if (row.experiment_id !== EXPERIMENT_ID) return 'wrong_experiment';
  if (row.manifest_hash !== MANIFEST_HASH) return 'wrong_manifest_hash';
  if (row.strategy_version !== STRATEGY_VERSION) return 'wrong_strategy_version';
  if (row.action !== 'place' || String(row.side || '').toUpperCase() !== 'BUY') {
    return 'wrong_action';
  }
  if (String(row.asset || '').toLowerCase() !== 'eth') return 'wrong_asset';
  if (row.market_type !== 'direction_5m') return 'wrong_market_type';
  if (!row.token_id || !row.condition_id) return 'missing_market_identity';
  if (row.accepting_orders === false) return 'venue_not_accepting_orders';

  const availableAt = new Date(row.available_at || row.ts).getTime();
  const ageMs = nowMs - availableAt;
  if (!Number.isFinite(ageMs) || ageMs < -100 || ageMs > MAX_SIGNAL_AGE_MS) {
    return 'stale_signal';
  }
  const windowEnd = new Date(row.window_end).getTime();
  if (!Number.isFinite(windowEnd) || nowMs >= windowEnd) return 'market_closed';

  const tte = finite(row.tte_sec);
  const price = finite(row.price);
  const sourceSize = finite(row.size);
  const notional = sourceNotional(row);
  if (!(tte >= 5 && tte <= 75)) return 'outside_frozen_tte';
  if (!(price >= 0.55 && price <= 0.96)) return 'outside_frozen_price';
  if (!(sourceSize > 0) || !(notional > 0 && notional <= 10 + 1e-6)) {
    return 'invalid_source_size';
  }

  const probability = tokenProbability(row);
  if (!(probability >= 0.88)) return 'outside_frozen_phi';
  if (probability - price < 0.05 - 1e-9) return 'outside_frozen_edge';

  const features = row.features || {};
  if (features.fresh_forward_only !== true
    && !String(features.note || '').includes('fresh_forward_only=true')) {
    return 'missing_forward_attestation';
  }
  if (features.book_src !== 'ws') return 'wrong_book_source';
  if (features.venue_stale === true) return 'stale_venue_source';
  const bookAgeMs = finite(features.book_age_ms);
  if (bookAgeMs == null || bookAgeMs < 0 || bookAgeMs > 500) return 'stale_book';
  if (features.resolution_source !== 'polymarket_crypto_5m') return 'wrong_resolution_source';

  const token = String(row.token || '').toUpperCase();
  const expectedAsk = token === String(row.positive_label || 'UP').toUpperCase()
    ? finite(features.up_ba)
    : finite(features.down_ba);
  if (expectedAsk == null || Math.abs(expectedAsk - price) > 0.0001) {
    return 'signal_ask_mismatch';
  }
  return null;
}

function validateExecutionInfo(row, executionInfo) {
  if (!executionInfo || executionInfo.tokenVerified !== true) return 'market_metadata_unverified';
  if (!TICK_SIZES.has(String(executionInfo.tickSize))) return 'tick_size_unverified';
  if (executionInfo.acceptingOrders === false) return 'venue_not_accepting_orders';
  const actualRate = finite(executionInfo.feeRate);
  const actualExponent = finite(executionInfo.feeExponent);
  const price = finite(row?.price);
  if (!(actualRate >= 0) || !(actualExponent >= 0) || !(price > 0 && price < 1)) {
    return 'fee_schedule_unverified';
  }
  const modeledFeePerShare = FEE_RATE * Math.pow(price * (1 - price), FEE_EXPONENT);
  const actualFeePerShare = actualRate * Math.pow(price * (1 - price), actualExponent);
  if (actualFeePerShare > modeledFeePerShare + 1e-9) {
    return 'fee_schedule_exceeds_frozen_model';
  }
  if (pilotNotional(row, executionInfo) == null) return 'venue_minimum_exceeds_canary_cap';
  return null;
}

function geoblockAllowsTrading(result) {
  return result?.blocked === false;
}

function geoBypassConfigured(env = process.env) {
  return Boolean(String(env.CLOB_PROXY_URL || '').trim()
    || String(env.POLYMARKET_GEO_TOKEN || '').trim());
}

async function fetchGeoblock(fetchImpl = global.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetchImpl(GEO_ENDPOINT, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`geoblock_http_${response.status}`);
    const value = await response.json();
    if (typeof value?.blocked !== 'boolean') throw new Error('geoblock_invalid_payload');
    return {
      blocked: value.blocked,
      country: value.country || null,
      region: value.region || null,
      checkedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function poolConfig() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const local = /(?:localhost|127\.0\.0\.1|\/deltaforge)/i.test(connectionString);
  return { connectionString, ssl: local ? false : { rejectUnauthorized: false }, max: 4 };
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
    if (signatureType == null && wallet.signatureType != null) {
      signatureType = String(wallet.signatureType);
    }
  }
  if (signatureType === '1') signatureType = 'POLY_1271';
  return {
    privateKey,
    signerAddress,
    funderAddress,
    signatureType: signatureType || 'EOA',
    keyFile,
  };
}

let pool = null;
let feed = null;
let executionWal = null;
let dryRun = true;
let mode = 'DRY';
let startedAt = new Date();
let polling = false;
let lastBalance = null;
let lastBalanceAt = 0;
let geoblock = null;
let executionHaltReason = null;
let errors = 0;
const processing = new Set();
const log = (...args) => console.log(new Date().toISOString(), ...args);
const killed = () => KILL_FILES.some((file) => fs.existsSync(file));

async function ensureSchema() {
  await pool.query(`ALTER TABLE bot_settings
    ADD COLUMN IF NOT EXISTS live_eth_g_late_enabled BOOLEAN DEFAULT false`);
  await pool.query(`CREATE TABLE IF NOT EXISTS eth_g_late_live_orders (
    id BIGSERIAL PRIMARY KEY,
    shadow_order_id BIGINT UNIQUE NOT NULL REFERENCES borg_shadow_orders(id),
    market_id INT NOT NULL REFERENCES borg_markets(id),
    condition_id TEXT NOT NULL,
    token_id TEXT NOT NULL,
    token TEXT NOT NULL,
    signal_price NUMERIC NOT NULL,
    source_size NUMERIC NOT NULL,
    source_notional NUMERIC NOT NULL,
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
    geoblock_country TEXT,
    resolved_outcome TEXT,
    realized_pnl NUMERIC,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS eth_g_late_one_live_market
    ON eth_g_late_live_orders(market_id) WHERE NOT dry_run`);
  await pool.query(`CREATE INDEX IF NOT EXISTS eth_g_late_live_created
    ON eth_g_late_live_orders(created_at DESC)`);
}

async function heartbeat(extra = {}) {
  await pool.query(`
    INSERT INTO system_heartbeats(component,beat_at,meta)
    VALUES($1,now(),$2::jsonb)
    ON CONFLICT(component) DO UPDATE SET beat_at=now(),meta=EXCLUDED.meta`, [
    HEARTBEAT_COMPONENT,
    JSON.stringify({
      pid: process.pid,
      strategy: STRATEGY,
      experimentId: EXPERIMENT_ID,
      dryRun,
      mode,
      balanceUsdc: lastBalance,
      geoblock,
      errors,
      executionHaltReason,
      startedAt: startedAt.toISOString(),
      ...extra,
    }),
  ]).catch(() => {});
}

function haltExecution(error) {
  if (executionHaltReason) return;
  executionHaltReason = String(error?.message || error).slice(0, 500);
  errors += 1;
  log(`ETH G-late EXECUTION HALTED: ${executionHaltReason}`);
}

function appendExecutionWal(event, payload) {
  if (!executionWal) throw new Error('ETH G-late execution WAL is unavailable');
  return executionWal.append(JSON.stringify({
    event,
    recordedAt: new Date().toISOString(),
    strategy: STRATEGY,
    experimentId: EXPERIMENT_ID,
    ...payload,
  }), { channel: event });
}

async function refreshBalance(force = false) {
  if (!feed) return null;
  if (!force && Date.now() - lastBalanceAt < 1000) return lastBalance;
  const result = await PolymarketFeed.fetchBalance(
    feed.privateKey, feed.walletAddress, feed.signatureType, feed.funderAddress,
  );
  lastBalance = finite(result?.usdc);
  lastBalanceAt = Date.now();
  return lastBalance;
}

async function record(row, status, error = null, requestedNotional = null, isDry = dryRun) {
  const canaryNotional = requestedNotional ?? pilotNotional(row) ?? 0;
  await pool.query(`INSERT INTO eth_g_late_live_orders(
      shadow_order_id,market_id,condition_id,token_id,token,signal_price,
      source_size,source_notional,requested_notional,worst_price,dry_run,status,
      geoblock_country,error)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT(shadow_order_id) DO NOTHING`, [
    row.id,
    row.market_id,
    row.condition_id || '',
    row.token_id || '',
    row.token || '',
    finite(row.price) || 0,
    finite(row.size) || 0,
    sourceNotional(row) || 0,
    canaryNotional,
    finite(row.price) || 0,
    isDry,
    status,
    geoblock?.country || null,
    error,
  ]);
}

async function claimLive(row, notional) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(7054011)');
    const existing = await client.query(`SELECT 1 FROM eth_g_late_live_orders
      WHERE market_id=$1 AND NOT dry_run LIMIT 1`, [row.market_id]);
    if (existing.rowCount > 0) {
      await client.query('ROLLBACK');
      return { claimId: null, reason: 'duplicate_market' };
    }
    const { rows } = await client.query(`SELECT
        count(*) FILTER (WHERE NOT dry_run AND status NOT LIKE 'SKIPPED_%')::int total_submissions,
        count(*) FILTER (WHERE NOT dry_run AND created_at>=date_trunc('day',now())
          AND status NOT LIKE 'SKIPPED_%')::int daily_orders,
        COALESCE(sum(requested_notional) FILTER (WHERE NOT dry_run
          AND created_at>=date_trunc('day',now()) AND status NOT LIKE 'SKIPPED_%'),0)::float daily_spend,
        COALESCE(sum(realized_pnl) FILTER (WHERE NOT dry_run
          AND created_at>=date_trunc('day',now())),0)::float daily_realized
      FROM eth_g_late_live_orders`);
    const capacity = rows[0] || {};
    if (capacity.total_submissions >= MAX_PILOT_SUBMISSIONS) {
      await client.query('ROLLBACK');
      return { claimId: null, reason: 'pilot_submission_cap', capacity };
    }
    if (capacity.daily_orders >= MAX_ORDERS_PER_UTC_DAY
      || capacity.daily_spend + notional > MAX_SPEND_PER_UTC_DAY + 1e-9) {
      await client.query('ROLLBACK');
      return { claimId: null, reason: 'daily_spend_cap', capacity };
    }
    if (capacity.daily_realized <= -MAX_RESOLVED_LOSS_PER_UTC_DAY) {
      await client.query('ROLLBACK');
      return { claimId: null, reason: 'daily_loss_cap', capacity };
    }
    const claim = await client.query(`INSERT INTO eth_g_late_live_orders(
        shadow_order_id,market_id,condition_id,token_id,token,signal_price,
        source_size,source_notional,requested_notional,worst_price,dry_run,status,
        geoblock_country)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,'PLACING',$11)
      ON CONFLICT DO NOTHING RETURNING id`, [
      row.id,
      row.market_id,
      row.condition_id,
      row.token_id,
      row.token,
      row.price,
      row.size,
      sourceNotional(row),
      notional,
      row.price,
      geoblock?.country || null,
    ]);
    await client.query('COMMIT');
    return {
      claimId: claim.rows[0]?.id || null,
      reason: claim.rows.length ? null : 'duplicate_shadow_order',
      capacity,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function persistFill(liveOrderId, fill, status = fill?.status) {
  if (!fill) return;
  await pool.query(`UPDATE eth_g_late_live_orders SET
    status=$2,matched_shares=$3,matched_notional=$4,average_fill_price=$5,
    fee_paid=$6,fee_rate=$7,fee_exponent=$8,updated_at=now() WHERE id=$1`, [
    liveOrderId,
    status,
    fill.matchedShares,
    fill.matchedNotional,
    fill.averageFillPrice,
    fill.feePaid,
    fill.feeRate,
    fill.feeExponent,
  ]);
}

async function reconcileFill(liveOrderId, orderId) {
  if (!feed || !orderId) return;
  try {
    const stored = await pool.query(`SELECT response,requested_notional,worst_price,
      fee_rate,fee_exponent FROM eth_g_late_live_orders WHERE id=$1`, [liveOrderId]);
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
    const averageFillPrice = finite(order.avg_price ?? order.average_price);
    const matchedNotional = matchedShares > 0 && averageFillPrice > 0
      ? matchedShares * averageFillPrice
      : null;
    const feeRate = finite(row.fee_rate) ?? FEE_RATE;
    const feeExponent = finite(row.fee_exponent) ?? FEE_EXPONENT;
    const feePaid = matchedShares > 0 && averageFillPrice > 0
      ? takerFee(matchedShares, averageFillPrice, feeRate, feeExponent)
      : null;
    const originalShares = venueUnits(order.original_size ?? order.size);
    const status = matchedShares > 0
      ? (averageFillPrice == null
        ? 'MATCHED_RECONCILIATION_PENDING'
        : (originalShares != null && originalShares > matchedShares + 1e-9
          ? 'PARTIAL'
          : 'MATCHED'))
      : String(order.status || 'UNFILLED').toUpperCase();
    await pool.query(`UPDATE eth_g_late_live_orders SET
      status=$2,matched_shares=$3,matched_notional=$4,average_fill_price=$5,
      fee_paid=$6,fee_rate=$7,fee_exponent=$8,updated_at=now() WHERE id=$1`, [
      liveOrderId,
      status,
      matchedShares || null,
      matchedNotional,
      averageFillPrice,
      feePaid,
      feeRate,
      feeExponent,
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
      log(`skip ETH G-late shadow #${row.id}: ${invalid}`);
      return;
    }
    if (killed()) {
      await record(row, 'SKIPPED_KILL_SWITCH', 'kill_switch');
      return;
    }
    if (executionHaltReason) {
      await record(row, 'SKIPPED_EXECUTION_HALT', executionHaltReason, null, false);
      return;
    }
    if (dryRun) {
      await record(row, 'DRY_RUN_READY');
      log(`DRY ETH G-late #${row.id}: BUY ${row.token} $${pilotNotional(row).toFixed(2)} ` +
        `FAK worst=${finite(row.price).toFixed(3)} (${mode})`);
      return;
    }

    const gate = await pool.query(`SELECT live_eth_g_late_enabled
      FROM bot_settings WHERE user_id=1`);
    if (gate.rows[0]?.live_eth_g_late_enabled !== true) {
      await record(row, 'SKIPPED_DB_GATE_CLOSED', 'db_gate_closed', null, false);
      return;
    }
    if (!geoblockAllowsTrading(geoblock)) {
      haltExecution('geo_eligibility_not_explicitly_allowed');
      await record(row, 'SKIPPED_GEO_BLOCK', 'geo_blocked_or_unknown', null, false);
      return;
    }

    const [balance, executionInfo] = await Promise.all([
      refreshBalance(false),
      feed.fetchMarketExecutionInfo(row.condition_id, row.token_id),
    ]);
    const executionInvalid = validateExecutionInfo(row, executionInfo);
    if (executionInvalid) {
      await record(row, `SKIPPED_${executionInvalid.toUpperCase()}`, executionInvalid, null, false);
      log(`skip ETH G-late shadow #${row.id}: ${executionInvalid}`);
      return;
    }
    const notional = pilotNotional(row, executionInfo);
    const feeCushion = notional * 0.04;
    if (balance == null || balance + 1e-9 < notional + feeCushion) {
      await record(row, 'SKIPPED_INSUFFICIENT_BALANCE',
        `balance=${balance == null ? 'unknown' : balance.toFixed(4)} required=${(notional + feeCushion).toFixed(4)}`,
        notional,
        false);
      return;
    }

    const { claimId, reason } = await claimLive(row, notional);
    if (!claimId) {
      await record(row, `SKIPPED_${String(reason || 'claim_failed').toUpperCase()}`,
        reason || 'claim_failed', notional, false);
      return;
    }

    const preSendInvalid = validateCandidate(row);
    if (preSendInvalid || killed() || executionHaltReason || !geoblockAllowsTrading(geoblock)) {
      const reasonNow = preSendInvalid
        || (killed() ? 'kill_switch' : executionHaltReason || 'geo_blocked_or_unknown');
      await pool.query(`UPDATE eth_g_late_live_orders
        SET status=$2,error=$3,updated_at=now() WHERE id=$1`, [
        claimId,
        `SKIPPED_${String(reasonNow).toUpperCase()}`,
        String(reasonNow).slice(0, 500),
      ]);
      return;
    }

    const sentAt = Date.now();
    let acknowledgement = null;
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
          sourceNotional: sourceNotional(row),
          worstPrice: finite(row.price),
          executionInfo,
          geoblock,
        });
      } catch (error) {
        haltExecution(new Error(`execution_wal_before_order: ${error.message}`));
        throw error;
      }

      const response = await feed.placeMarketBuyOrder(
        row.token_id,
        +notional.toFixed(6),
        finite(row.price),
        executionInfo,
      );
      const acknowledgedAt = Date.now();
      const orderId = response?.orderID || response?.order_id || response?.id || null;
      acknowledgement = { response, acknowledgedAt, orderId };
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
      } catch (error) {
        haltExecution(new Error(`execution_wal_after_ack: ${error.message}`));
      }

      let fill = null;
      let fillError = null;
      try {
        fill = parseMarketBuyFill(response, notional, finite(row.price), executionInfo);
      } catch (error) {
        fillError = error;
        haltExecution(error);
      }
      const status = fill?.status
        || (fillError ? 'MATCHED_FILL_INVARIANT' : String(response?.status || 'SUBMITTED').toUpperCase());
      const persistedResponse = { ...(response || {}), _deltaforgeExecution: executionInfo };
      await pool.query(`UPDATE eth_g_late_live_orders SET
        status=$2,clob_order_id=$3,response=$4::jsonb,acknowledged_at=$5,
        acknowledgement_latency_ms=$6,matched_shares=$7,matched_notional=$8,
        average_fill_price=$9,fee_paid=$10,fee_rate=$11,fee_exponent=$12,
        tick_size=$13,error=$14,updated_at=now() WHERE id=$1`, [
        claimId,
        status,
        orderId,
        JSON.stringify(persistedResponse),
        new Date(acknowledgedAt),
        acknowledgedAt - sentAt,
        fill?.matchedShares ?? null,
        fill?.matchedNotional ?? null,
        fill?.averageFillPrice ?? null,
        fill?.feePaid ?? null,
        finite(executionInfo.feeRate),
        finite(executionInfo.feeExponent),
        finite(executionInfo.tickSize),
        fillError ? String(fillError.message).slice(0, 500) : null,
      ]);
      log(`LIVE ETH G-late #${row.id}: ${status} BUY ${row.token} $${notional.toFixed(2)} ` +
        `worst=${finite(row.price).toFixed(3)}${fill ? ` actual=${fill.averageFillPrice.toFixed(4)}` : ''} ` +
        `ack=${acknowledgedAt - sentAt}ms order=${String(orderId || 'none').slice(0, 14)}`);
      if (orderId) {
        for (const delay of [500, 2000, 7500]) {
          setTimeout(() => reconcileFill(claimId, orderId), delay);
        }
      }
      lastBalanceAt = 0;
    } catch (error) {
      const expectedNonFill = isExpectedFakNonFill(error);
      const failedAfterAck = acknowledgement != null;
      const status = expectedNonFill
        ? 'UNFILLED_FAK'
        : (failedAfterAck ? 'ERROR_AFTER_ORDER_ACK' : 'ERROR');
      if (failedAfterAck) haltExecution(new Error(`post_order_audit_failure: ${error.message}`));
      else if (!expectedNonFill) errors += 1;
      await pool.query(`UPDATE eth_g_late_live_orders SET status=$2,error=$3,
        clob_order_id=COALESCE($4,clob_order_id),response=COALESCE($5::jsonb,response),
        acknowledged_at=COALESCE($6,acknowledged_at),
        acknowledgement_latency_ms=COALESCE($7,acknowledgement_latency_ms),
        updated_at=now() WHERE id=$1`, [
        claimId,
        status,
        String(error.message || error).slice(0, 500),
        acknowledgement?.orderId || null,
        acknowledgement?.response ? JSON.stringify(acknowledgement.response) : null,
        acknowledgement ? new Date(acknowledgement.acknowledgedAt) : null,
        acknowledgement ? acknowledgement.acknowledgedAt - sentAt : null,
      ]);
      log(`LIVE ETH G-late #${row.id} ${expectedNonFill ? 'did not fill' : 'failed'}: ${error.message}`);
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
      SELECT o.id,o.ts,o.available_at,o.strategy,o.experiment_id,o.manifest_hash,
             o.strategy_version,o.action,o.side,o.token,o.price,o.size,o.tte_sec,
             o.market_id,o.features,m.condition_id,m.asset,m.market_type,m.window_end,
             m.accepting_orders,m.positive_label,m.negative_label,
             CASE
               WHEN upper(o.token)=upper(COALESCE(m.positive_label,'UP')) THEN m.up_token_id
               WHEN upper(o.token)=upper(COALESCE(m.negative_label,'DOWN')) THEN m.down_token_id
               ELSE NULL
             END token_id
      FROM borg_shadow_orders o
      JOIN borg_markets m ON m.id=o.market_id
      LEFT JOIN eth_g_late_live_orders l ON l.shadow_order_id=o.id
      WHERE o.strategy=$1 AND o.action='place' AND l.id IS NULL
        AND o.ts >= $2 AND o.ts > now()-interval '4 seconds'
      ORDER BY o.id LIMIT 10`, [
      STRATEGY,
      new Date(startedAt.getTime() - MAX_SIGNAL_AGE_MS),
    ]);
    for (const row of rows) await processCandidate(row);
  } catch (error) {
    errors += 1;
    log(`candidate poll failed: ${error.message}`);
  } finally {
    polling = false;
  }
}

async function reconcileResolutions() {
  await pool.query(`UPDATE eth_g_late_live_orders l SET
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

async function refreshGeoblock() {
  try {
    geoblock = await fetchGeoblock();
    if (!dryRun && !geoblockAllowsTrading(geoblock)) {
      haltExecution(`geo_eligibility_lost country=${geoblock.country || 'unknown'}`);
    }
  } catch (error) {
    geoblock = {
      blocked: null,
      country: null,
      region: null,
      checkedAt: new Date().toISOString(),
      error: String(error.message || error).slice(0, 200),
    };
    if (!dryRun) haltExecution('geo_eligibility_check_failed');
  }
}

async function main() {
  pool = new Pool(poolConfig());
  await ensureSchema();
  await refreshGeoblock();

  const requestedLive = process.env.ETH_G_LATE_LIVE_ENABLED === '1';
  const acknowledged = process.env.ETH_G_LATE_LIVE_ACK === LIVE_ACK;
  const dbGate = (await pool.query(`SELECT live_eth_g_late_enabled
    FROM bot_settings WHERE user_id=1`)).rows[0]?.live_eth_g_late_enabled === true;
  const wallet = requestedLive ? loadWallet() : { privateKey: null };
  const geoAllowed = geoblockAllowsTrading(geoblock);
  const directExecution = !geoBypassConfigured();
  dryRun = !(requestedLive && acknowledged && dbGate && wallet.privateKey
    && !killed() && geoAllowed && directExecution);
  mode = !requestedLive
    ? 'DRY'
    : !geoAllowed
      ? 'REFUSED_GEO'
      : !directExecution
        ? 'REFUSED_RELAY'
      : dryRun
        ? 'REFUSED_GATES'
        : 'LIVE';

  if (requestedLive && dryRun) {
    log('ETH G-late LIVE request refused; observer remains DRY.', {
      acknowledged,
      dbGate,
      walletLoaded: Boolean(wallet.privateKey),
      killed: killed(),
      geoblock,
      directExecution,
    });
  }
  if (!dryRun) {
    executionWal = new RawWal('eth-g-late-live-execution', { syncEveryMs: 0 });
    let signerAddress = wallet.signerAddress;
    if (!signerAddress) signerAddress = new (require('ethers').Wallet)(wallet.privateKey).address;
    feed = new PolymarketFeed(
      wallet.privateKey,
      signerAddress,
      null,
      null,
      null,
      wallet.signatureType,
      wallet.funderAddress,
    );
    await feed.initialize();
    if (!feed.clobClient) throw new Error('CLOB client did not initialize');
    const balance = await refreshBalance(true);
    if (!(balance > 0)) throw new Error(`No spendable Polymarket collateral detected (${balance})`);
  }

  startedAt = new Date();
  setInterval(() => pollCandidates().catch(() => {}), POLL_MS);
  setInterval(() => reconcileResolutions().catch((error) => {
    errors += 1;
    log(`resolution reconciliation failed: ${error.message}`);
  }), 30_000);
  setInterval(() => refreshGeoblock().catch(() => {}), 300_000);
  setInterval(() => heartbeat().catch(() => {}), 10_000);
  await heartbeat({
    status: 'ready',
    requestedLive,
    acknowledged,
    dbGate,
    walletLoaded: Boolean(wallet.privateKey),
    directExecution,
  });
  log(`ETH G-late executor started — ${mode}; venue-minimum shares, <=$${MAX_ORDER_USD}/order, ` +
    `${MAX_ORDERS_PER_UTC_DAY}/day, <=$${MAX_SPEND_PER_UTC_DAY}/day, ` +
    `<=${MAX_PILOT_SUBMISSIONS} pilot submissions`);
}

async function shutdown() {
  try {
    await pool?.query(`DELETE FROM system_heartbeats WHERE component=$1`, [HEARTBEAT_COMPONENT]);
  } catch (_) {}
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
  MANIFEST_HASH,
  MAX_ORDER_USD,
  MAX_ORDERS_PER_UTC_DAY,
  MAX_PILOT_SUBMISSIONS,
  MAX_RESOLVED_LOSS_PER_UTC_DAY,
  MAX_SIGNAL_AGE_MS,
  MAX_SPEND_PER_UTC_DAY,
  MIN_VENUE_SHARES,
  STRATEGY,
  STRATEGY_VERSION,
  fetchGeoblock,
  geoblockAllowsTrading,
  geoBypassConfigured,
  pilotNotional,
  sourceNotional,
  tokenProbability,
  validateCandidate,
  validateExecutionInfo,
};
