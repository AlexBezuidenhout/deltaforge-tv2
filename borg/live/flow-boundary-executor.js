#!/usr/bin/env node
/**
 * Final-10s absorption canary executor.
 *
 * This process contains no signal discovery logic. The paper-only Flow
 * collector publishes a durable, causal READY intent only after the frozen
 * 500ms confirmation plus 250ms order-transit book has been captured. This
 * process mirrors a fresh READY intent with a price-protected FAK BUY.
 *
 * LIVE requires every independent gate below. The shipped/default systemd
 * service satisfies none of them and therefore records DRY_RUN_READY only:
 *   1. FLOW_BOUNDARY_LIVE_ENABLED=1
 *   2. FLOW_BOUNDARY_LIVE_ACK=I_ACCEPT_UNPROVEN_FLOW_CANARY
 *   3. bot_settings.live_flow_boundary_enabled=true
 *   4. a chmod-600 private-key file or POLYMARKET_PRIVATE_KEY
 *   5. no global or strategy KILL file
 *
 * Hard live rails: <=$10/order, <=3 submissions and <=$30 gross spend per UTC
 * day, one intent/market, no stale/post-boundary order, and worst execution
 * price equal to the causal arrival ask. These rails do not affect paper
 * collection and cannot be raised by environment variables.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');

const PolymarketFeed = require('../../src/bot/PolymarketFeed');
const { BOUNDARY_EXPERIMENT_ID } = require('../flow/boundary-canary');

const LIVE_ACK = 'I_ACCEPT_UNPROVEN_FLOW_CANARY';
const MAX_ORDER_USD = 10;
const MAX_ORDERS_PER_UTC_DAY = 3;
const MAX_SPEND_PER_UTC_DAY = 30;
const MAX_INTENT_AGE_MS = 750;
const MIN_BOUNDARY_BUFFER_MS = 150;
const HEARTBEAT_COMPONENT = 'flow_boundary_canary';
const KILL_FILES = [
  path.join(__dirname, 'FLOW_BOUNDARY_KILL'),
  path.join(os.homedir(), '.deltaforge-live', 'KILL'),
  path.join(os.homedir(), '.deltaforge-live', 'FLOW_BOUNDARY_KILL'),
];

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function venueShares(value) {
  const parsed = finite(value);
  if (parsed == null || parsed < 0) return null;
  // CLOB V2 wire responses may expose 6-decimal fixed integers, while SDK
  // normalized responses expose decimal shares. A $10 canary cannot own
  // 10,000 shares, making this distinction unambiguous here.
  return parsed > 10_000 ? parsed / 1_000_000 : parsed;
}

function poolConfig() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const local = /(?:localhost|127\.0\.0\.1|\/deltaforge)/i.test(connectionString);
  return { connectionString, ssl: local ? false : { rejectUnauthorized: false }, max: 4 };
}

function validateIntent(row, nowMs = Date.now()) {
  if (!row || row.experiment_id !== BOUNDARY_EXPERIMENT_ID) return 'wrong_experiment';
  if (row.status !== 'READY') return 'intent_not_ready';
  const arrivalMs = new Date(row.intended_arrival_at).getTime();
  const boundaryMs = new Date(row.boundary_at).getTime();
  const ageMs = nowMs - arrivalMs;
  if (!Number.isFinite(ageMs) || ageMs < -50 || ageMs > MAX_INTENT_AGE_MS) return 'stale_intent';
  if (!Number.isFinite(boundaryMs) || boundaryMs - nowMs < MIN_BOUNDARY_BUFFER_MS) return 'insufficient_boundary_buffer';
  const price = finite(row.arrival_ask);
  const notional = finite(row.requested_notional);
  const shares = finite(row.requested_size);
  const minimumShares = Math.max(0, finite(row.minimum_order_size) || 0);
  if (!(price > 0 && price < 1)) return 'invalid_worst_price';
  if (!(notional >= 1 && notional <= MAX_ORDER_USD + 1e-9)) return 'invalid_notional';
  if (!(shares > 0) || (minimumShares > 0 && shares + 1e-9 < minimumShares)) {
    return 'below_venue_minimum_size';
  }
  return null;
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
const log = (...args) => console.log(new Date().toISOString(), ...args);
const killed = () => KILL_FILES.some((file) => fs.existsSync(file));
let feed = null;
let dryRun = true;
let listener = null;
let processing = new Set();
let startedAt = new Date();

async function heartbeat(extra = {}) {
  await pool.query(`
    INSERT INTO system_heartbeats (component,beat_at,meta)
    VALUES ($1,now(),$2::jsonb)
    ON CONFLICT (component) DO UPDATE SET beat_at=now(),meta=EXCLUDED.meta`, [
    HEARTBEAT_COMPONENT,
    JSON.stringify({ pid: process.pid, dryRun, experimentId: BOUNDARY_EXPERIMENT_ID, ...extra }),
  ]).catch(() => {});
}

async function recordSkip(row, reason) {
  await pool.query(`
    INSERT INTO flow_boundary_canary_orders (
      intent_id,condition_id,token_id,target_outcome,dry_run,requested_notional,worst_price,status,error)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (intent_id) DO NOTHING`, [
    row.id, row.condition_id, row.token_id, row.target_outcome, dryRun,
    finite(row.requested_notional) || 0, finite(row.arrival_ask) || 0,
    `SKIPPED_${reason.toUpperCase()}`, reason,
  ]);
}

async function claimLive(row, notional) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize the daily cap across accidental duplicate executor processes.
    await client.query('SELECT pg_advisory_xact_lock(704109)');
    const { rows } = await client.query(`
      SELECT count(*)::int orders,COALESCE(sum(requested_notional),0)::float spend
        FROM flow_boundary_canary_orders
       WHERE NOT dry_run AND created_at>=date_trunc('day',now())
         AND status NOT LIKE 'SKIPPED_%'`);
    const capacity = rows[0] || { orders: 0, spend: 0 };
    if (capacity.orders >= MAX_ORDERS_PER_UTC_DAY
      || capacity.spend + notional > MAX_SPEND_PER_UTC_DAY + 1e-9) {
      await client.query('ROLLBACK');
      return { capacity, claimId: null };
    }
    const claim = await client.query(`
      INSERT INTO flow_boundary_canary_orders (
        intent_id,condition_id,token_id,target_outcome,dry_run,requested_notional,worst_price,status)
      VALUES ($1,$2,$3,$4,false,$5,$6,'PLACING')
      ON CONFLICT (intent_id) DO NOTHING RETURNING id`, [
      row.id, row.condition_id, row.token_id, row.target_outcome,
      notional, row.arrival_ask,
    ]);
    await client.query('COMMIT');
    return { capacity, claimId: claim.rows[0]?.id || null, duplicate: claim.rows.length === 0 };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function processIntent(intentId) {
  const key = String(intentId);
  if (processing.has(key)) return;
  processing.add(key);
  try {
    const { rows } = await pool.query(`
      SELECT i.* FROM pm_flow_boundary_intents i
      LEFT JOIN flow_boundary_canary_orders o ON o.intent_id=i.id
      WHERE i.id=$1 AND o.id IS NULL`, [intentId]);
    if (!rows.length) return;
    const row = rows[0];
    const invalid = validateIntent(row);
    if (invalid) {
      await recordSkip(row, invalid);
      log(`skip intent #${row.id}: ${invalid}`);
      return;
    }
    if (killed()) {
      await recordSkip(row, 'kill_switch');
      log(`skip intent #${row.id}: KILL switch`);
      return;
    }
    const dbGate = await pool.query(`
      SELECT live_flow_boundary_enabled FROM bot_settings WHERE user_id=1`);
    if (!dryRun && dbGate.rows[0]?.live_flow_boundary_enabled !== true) {
      await recordSkip(row, 'db_gate_closed');
      log(`skip intent #${row.id}: live_flow_boundary_enabled is false`);
      return;
    }
    if (dryRun) {
      await pool.query(`
        INSERT INTO flow_boundary_canary_orders (
          intent_id,condition_id,token_id,target_outcome,dry_run,requested_notional,worst_price,status)
        VALUES ($1,$2,$3,$4,true,$5,$6,'DRY_RUN_READY')
        ON CONFLICT (intent_id) DO NOTHING`, [
        row.id, row.condition_id, row.token_id, row.target_outcome,
        row.requested_notional, row.arrival_ask,
      ]);
      log(`DRY RUN intent #${row.id}: BUY ${row.target_outcome || 'token'} ` +
        `$${finite(row.requested_notional).toFixed(2)} FAK worst=${finite(row.arrival_ask).toFixed(3)}`);
      return;
    }

    const notional = finite(row.requested_notional);
    const { capacity, claimId, duplicate } = await claimLive(row, notional);
    if (duplicate) return;
    if (!claimId) {
      await recordSkip(row, 'daily_canary_cap');
      log(`skip intent #${row.id}: daily canary cap (${capacity.orders} orders, $${capacity.spend.toFixed(2)})`);
      return;
    }

    const sentAt = Date.now();
    try {
      const response = await feed.placeMarketBuyOrder(
        row.token_id, +notional.toFixed(6), finite(row.arrival_ask),
      );
      const acknowledgedAt = Date.now();
      const orderId = response?.orderID || response?.order_id || response?.id || null;
      const venueStatus = String(response?.status || 'submitted').toUpperCase();
      await pool.query(`
        UPDATE flow_boundary_canary_orders SET status=$2,clob_order_id=$3,response=$4::jsonb,
          acknowledged_at=$5,acknowledgement_latency_ms=$6,updated_at=now()
        WHERE id=$1`, [
        claimId, venueStatus, orderId, JSON.stringify(response || {}),
        new Date(acknowledgedAt), acknowledgedAt - sentAt,
      ]);
      log(`LIVE intent #${row.id}: ${venueStatus} order=${String(orderId || 'none').slice(0, 14)} ` +
        `$${notional.toFixed(2)} worst=${finite(row.arrival_ask).toFixed(3)} ack=${acknowledgedAt - sentAt}ms`);
      if (orderId) setTimeout(() => reconcileFill(claimId, orderId, finite(row.arrival_ask)), 750);
    } catch (error) {
      await pool.query(`UPDATE flow_boundary_canary_orders
        SET status='ERROR',error=$2,updated_at=now() WHERE id=$1`, [
        claimId, String(error.message || error).slice(0, 500),
      ]);
      log(`LIVE intent #${row.id} failed: ${error.message}`);
    }
  } finally {
    processing.delete(key);
  }
}

async function reconcileFill(canaryOrderId, orderId, fallbackPrice) {
  try {
    const order = await feed?.fetchOrder(orderId);
    if (!order) return;
    const matchedShares = venueShares(order.size_matched ?? order.sizeMatched);
    const fillPrice = finite(order.avg_price ?? order.average_price ?? order.price) || fallbackPrice;
    const matchedNotional = matchedShares != null && fillPrice > 0 ? matchedShares * fillPrice : null;
    const originalShares = venueShares(order.original_size ?? order.size);
    const status = matchedShares > 0
      ? (originalShares > matchedShares + 1e-9 ? 'PARTIAL' : 'MATCHED')
      : String(order.status || 'UNFILLED').toUpperCase();
    await pool.query(`UPDATE flow_boundary_canary_orders SET
      status=$2,matched_shares=$3,matched_notional=$4,average_fill_price=$5,updated_at=now()
      WHERE id=$1`, [canaryOrderId, status, matchedShares || null, matchedNotional, fillPrice]);
  } catch (error) {
    log(`fill reconciliation failed for ${String(orderId).slice(0, 14)}: ${error.message}`);
  }
}

async function reconcileResolutions() {
  await pool.query(`
    UPDATE flow_boundary_canary_orders o SET
      resolved_outcome=m.outcome,
      realized_pnl=CASE
        WHEN upper(COALESCE(o.target_outcome,''))=upper(COALESCE(m.outcome,''))
          THEN o.matched_shares-o.matched_notional-
            COALESCE(o.matched_shares*i.fee_rate*o.average_fill_price*(1-o.average_fill_price),0)
        ELSE -o.matched_notional-
          COALESCE(o.matched_shares*i.fee_rate*o.average_fill_price*(1-o.average_fill_price),0)
      END,
      updated_at=now()
    FROM pm_flow_boundary_intents i
    JOIN borg_markets m ON m.condition_id=i.condition_id
    WHERE o.intent_id=i.id AND NOT o.dry_run AND o.matched_shares>0
      AND m.outcome IS NOT NULL AND o.resolved_outcome IS NULL`);
}

async function catchUp() {
  const { rows } = await pool.query(`
    SELECT i.id FROM pm_flow_boundary_intents i
    LEFT JOIN flow_boundary_canary_orders o ON o.intent_id=i.id
    WHERE i.status='READY' AND o.id IS NULL
      AND i.arrival_captured_at >= $1
      AND i.intended_arrival_at > now()-interval '1 second'
    ORDER BY i.id LIMIT 20`, [startedAt]);
  await Promise.all(rows.map((row) => processIntent(row.id)));
}

async function main() {
  pool = new Pool(poolConfig());
  const requestedLive = process.env.FLOW_BOUNDARY_LIVE_ENABLED === '1';
  const acknowledged = process.env.FLOW_BOUNDARY_LIVE_ACK === LIVE_ACK;
  const wallet = requestedLive ? loadWallet() : { privateKey: null };
  const dbGate = (await pool.query(`
    SELECT live_flow_boundary_enabled FROM bot_settings WHERE user_id=1`)).rows[0]?.live_flow_boundary_enabled === true;
  dryRun = !(requestedLive && acknowledged && dbGate && wallet.privateKey && !killed());
  if (requestedLive && dryRun) {
    log('LIVE request refused; observer remains DRY.', {
      acknowledged, dbGate, walletLoaded: Boolean(wallet.privateKey), killed: killed(),
    });
  }
  if (!dryRun) {
    let signerAddress = wallet.signerAddress;
    if (!signerAddress) signerAddress = new (require('ethers').Wallet)(wallet.privateKey).address;
    feed = new PolymarketFeed(
      wallet.privateKey, signerAddress, null, null, null,
      wallet.signatureType, wallet.funderAddress,
    );
    await feed.initialize();
    if (!feed.clobClient) throw new Error('CLOB client did not initialize');
  }

  startedAt = new Date();
  listener = await pool.connect();
  await listener.query('LISTEN flow_boundary_ready');
  listener.on('notification', (message) => {
    if (message.channel === 'flow_boundary_ready' && /^\d+$/.test(message.payload || '')) {
      processIntent(message.payload).catch((error) => log('notification processing error:', error.message));
    }
  });
  listener.on('error', (error) => {
    log('LISTEN connection failed:', error.message);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 50);
  });
  setInterval(() => catchUp().catch((error) => log('catch-up error:', error.message)), 250);
  setInterval(() => reconcileResolutions().catch((error) => log('resolution reconciliation error:', error.message)), 30_000);
  setInterval(() => heartbeat().catch(() => {}), 10_000);
  await heartbeat({ startedAt: startedAt.toISOString() });
  log(`Flow boundary executor started — ${dryRun ? 'DRY observer' : '*** LIVE CANARY ***'}; ` +
    `hard rails $${MAX_ORDER_USD}/order, ${MAX_ORDERS_PER_UTC_DAY}/day, $${MAX_SPEND_PER_UTC_DAY}/day`);
}

async function shutdown() {
  try { await pool?.query(`DELETE FROM system_heartbeats WHERE component=$1`, [HEARTBEAT_COMPONENT]); } catch (_) {}
  if (listener) listener.release();
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
  LIVE_ACK,
  MAX_INTENT_AGE_MS,
  MAX_ORDER_USD,
  MAX_ORDERS_PER_UTC_DAY,
  MAX_SPEND_PER_UTC_DAY,
  validateIntent,
  venueShares,
};
