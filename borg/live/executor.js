#!/usr/bin/env node
/**
 * G_late_arb LIVE EXECUTOR — mirror pattern (2026-07-13).
 *
 * Design: this process contains NO strategy logic. It watches
 * borg_shadow_orders for fresh G_late_arb 'place' rows (the frozen,
 * pre-registered pilot emits them from real tape) and mirrors each one as a
 * real Polymarket order. Live therefore trades EXACTLY the audited strategy —
 * same signals, same prices — while shadow scoring continues as the control.
 *
 * ── HARD GATES (ALL must hold or the process exits without trading) ──
 *  1. borg/live/VERDICT_CONFIRMED exists and contains 'CONFIRM'
 *     (written only by `node scripts/g-verdict.js --stamp` after the frozen
 *      n=300 core read prints CONFIRM — cannot be stamped early).
 *  2. env LIVE_TRADING_ENABLED === '1'          (operator, per-run intent)
 *  3. env POLYMARKET_PRIVATE_KEY is set          (operator-supplied wallet)
 *  4. bot_settings.live_gla_enabled = true       (operator, DB switch)
 *  5. borg/live/KILL does not exist              (touch it to halt instantly)
 * Without gates 2–3 the process runs in DRY-RUN: it logs exactly what it
 * would place and places nothing. This file is NOT wired into launchd —
 * starting it is always a deliberate operator action.
 *
 * ── RISK RAILS (hardcoded on purpose — edit requires a code change) ──
 *   stake $10/leg (same as scored pilot), max 30 live orders/day,
 *   daily spend cap $300, order must be ≤5s old (no stale mirroring),
 *   GTC marketable limit at recorded ask +1 tick ceiling — if the ask moved
 *   past the limit it rests unfilled until the 5-min market resolves; it can
 *   never fill worse than the limit. (FOK is not usable on this account type.)
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const VERDICT_FILE = path.join(__dirname, 'VERDICT_CONFIRMED');
// KILL switch is honored at BOTH paths: the mirror-local file and a stable
// home-dir file that no rsync --delete can ever clobber. The stable one is
// what the dashboard/runbook advertise.
const KILL_FILES = [
  path.join(__dirname, 'KILL'),
  path.join(require('os').homedir(), '.deltaforge-live/KILL'),
];
const killed = () => KILL_FILES.some((f) => fs.existsSync(f));
const STAKE_USD = 10;
// Rails raised on operator instruction 2026-07-13 (bankroll ~$150): mirror
// every signal instead of idling at the original 30/$300 pre-registered caps.
// Count/spend ceilings are now sanity bounds (observed flow ~9 signals/hr ≈
// 220/day); the rail that fits a fast-recycling $10-stake bankroll is the
// REALIZED-LOSS halt below. Change here AND deploy (deploy-server.sh), never
// one without the other — an undeployed edit here once sat divergent from the
// running copy.
// Daily count/spend stay open (operator 2026-07-13: never block a signal);
// the loss breaker is back on per the 2026-07-14 profitability pass — it
// does not throttle trading, it only stops a catastrophic day.
const MAX_ORDERS_PER_DAY = 10000;
const MAX_SPEND_PER_DAY_USD = 100000;
// Circuit breaker: if today's REALIZED live pnl (resolved fills, resolution
// math: win pays stake/price − stake, loss = −stake) drops below this, stop
// placing until the next UTC day. Open positions and redemption lag don't
// distort this — only resolved outcomes count. ~Half the bankroll.
const MAX_DAILY_REALIZED_LOSS_USD = 75;
const MAX_SIGNAL_AGE_MS = 5000;

// ── 2026-07-14 profitability pass (overnight read, 135 resolved titles) ──
// ENTRY CEILING: entries <0.85 made +$21; entries ≥0.85 made −$25 (0.92+
// bucket −$0.76/mkt at 87% WR — high win rate, negative expectancy). Signals
// whose recorded ask can't fill inside the ceiling are skipped and logged
// (SKIPPED_CEILING); shadow still scores them, so the counterfactual accrues
// for free. Pre-registered read in borg/NEXT.md §2a.
const ENTRY_CEILING = 0.85;
// WINNER CHASE: 27/164 orders never filled and ALL 27 would have won — at
// ask+1 tick the runaway winners escape before the order lands (~−$0.35/fill
// adverse-selection toll). Chase up to +3 ticks (never past the ceiling):
// orders that filled before still fill at the same real ask; the wider limit
// only adds fills in the runaway band, which the data says are winners.
const CHASE_TICKS = 0.03;

// ── RE-CONFIRM GATE (2026-07-14 PM — replaces the trailing-100 edge gate) ──
// The trailing-mean gate was REFUTED by its own live run: corr(trailing-100
// mean, next-fill pnl) = −0.125, gate simulations underperform trade-all at
// every window length, and the live log shows the whipsaw (opened 09:57Z at
// $0.333, ate the two worst hours of the day, closed 11:52Z at $0.048). At
// ~5–9 core fills/hr a 100-fill window spans 15–20h while the regime
// half-life is a few hours — a trailing mean is a rear-view mirror.
// New standard: live resumes ONLY on a fresh re-CONFIRM — the most recent
// RECONFIRM_N scored core fills, all AFTER the anchor set at the last gate
// close, must show mean ≥ RECONFIRM_MEAN with bootstrap CI low > 0. That is
// roughly the bar the original n=300 CONFIRM cleared, and only a regime like
// the one that earned it (Jul-13 morning, ~$2.5/fill) can clear it again.
// The anchor lives in bot_settings.gla_reconfirm_anchor so restarts cannot
// resurrect pre-close evidence. Shadow keeps scoring everything regardless.
const RECONFIRM_N = 50;           // fresh scored core fills required
const RECONFIRM_MEAN = 0.40;      // $/fill floor for the fresh window
const RECONFIRM_BOOT = 2000;      // bootstrap resamples for the CI
const EDGE_GATE_CLOSE_AT = 0.10;  // trailing-RECONFIRM_N mean below this closes (and re-anchors)

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ── Transient-network survival (same incident class as the main server's
// 04f4c83 overnight outage: one DNS/socket blip must not kill a real-money
// process; launchd would restart it, but a flapping network means crash-loop
// throttling and missed mirrors). Transient codes are absorbed and logged;
// anything else still exits 1 so launchd restarts us into a clean state.
const TRANSIENT_NET = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED',
  'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EADDRNOTAVAIL']);
const isTransient = (e) => e && (TRANSIENT_NET.has(e.code) || TRANSIENT_NET.has(e.errno));
pool.on('error', (e) => log('pg pool error (absorbed):', e.code || e.message));
process.on('uncaughtException', (e) => {
  if (isTransient(e)) return log('transient net error (absorbed):', e.code, e.message);
  console.error('FATAL uncaught:', e); process.exit(1);
});
process.on('unhandledRejection', (e) => {
  if (isTransient(e)) return log('transient net rejection (absorbed):', e && e.code, e && e.message);
  console.error('FATAL unhandled rejection:', e); process.exit(1);
});

// Startup DB reads retry instead of crashing: a boot during a network blip
// (the exact 19:5x 2026-07-13 ENOTFOUND) should wait it out, not thrash launchd.
async function dbRetry(fn, what, tries = 12, delayMs = 5000) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries || !isTransient(e)) throw e;
      log(`${what} failed (${e.code || e.message}) — retry ${i}/${tries} in ${delayMs / 1000}s`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// Dashboard liveness: the LIVE badge on /api/bots is driven by this heartbeat,
// so the UI can never claim real-money trading is running unless this process
// actually is. The row is DELETED on every refusal/kill exit so a parked
// executor doesn't leave a stale heartbeat behind (no false SYSTEM DEGRADED).
const beat = (meta) => pool.query(
  `INSERT INTO system_heartbeats (component, beat_at, meta) VALUES ('gla_live', now(), $1)
   ON CONFLICT (component) DO UPDATE SET beat_at = now(), meta = $1`,
  [JSON.stringify(meta || {})]).catch(() => {});
const clearBeatAndExit = async (code) => {
  try { await pool.query(`DELETE FROM system_heartbeats WHERE component = 'gla_live'`); } catch (_) {}
  process.exit(code);
};

async function main() {
  // Gate 1 — pre-registered verdict stamp
  if (!fs.existsSync(VERDICT_FILE) || !fs.readFileSync(VERDICT_FILE, 'utf8').includes('CONFIRM')) {
    log('REFUSING TO START: no CONFIRM verdict stamp.');
    log('The frozen n=300 core read must print CONFIRM first:');
    log('  node scripts/g-verdict.js          # check');
    log('  node scripts/g-verdict.js --stamp  # stamps only on CONFIRM');
    return clearBeatAndExit(1);
  }
  if (killed()) { log('KILL file present — exiting.'); return clearBeatAndExit(1); }

  // Gate 4 — DB switch
  const st = await dbRetry(() => pool.query(`SELECT live_gla_enabled FROM bot_settings WHERE user_id = 1`), 'gate-4 settings read');
  if (st.rows[0]?.live_gla_enabled !== true) {
    log('REFUSING TO START: bot_settings.live_gla_enabled is not true.');
    return clearBeatAndExit(1);
  }

  // Gates 2–3 — live vs dry-run.
  // Key can come from env POLYMARKET_PRIVATE_KEY or a chmod-600 file at
  // POLYMARKET_KEY_FILE (default ~/.deltaforge-live/wallet.json, written by
  // make-wallet.js) — file wins the fallback so the key never has to appear
  // in shell history.
  let privateKey = process.env.POLYMARKET_PRIVATE_KEY || null;
  let signerAddress = null;
  let funder = process.env.POLYMARKET_FUNDER_ADDRESS || null;
  // signatureType: 'EOA' = fresh standalone wallet; 'POLY_1271' = Polymarket
  // email/deposit-flow account (exported key + proxy funder); 'POLY_PROXY' /
  // 'GNOSIS_SAFE' for older proxy accounts. See RUNBOOK "Which wallet".
  let sigType = process.env.POLYMARKET_SIGNATURE_TYPE || null;
  // Key files: polymarket-account.json (option A) wins over wallet.json
  // (option B fresh EOA) unless POLYMARKET_KEY_FILE says otherwise.
  const home = require('os').homedir();
  // active-account.json is THE switchboard for which wallet trades live.
  // (polymarket-account.json is retired: its old-gen proxy is not controllable
  // by the exported key — see RUNBOOK "Which wallet".)
  const keyFile = process.env.POLYMARKET_KEY_FILE
    || [path.join(home, '.deltaforge-live/active-account.json'),
        path.join(home, '.deltaforge-live/wallet.json')].find((f) => fs.existsSync(f));
  if (!privateKey && keyFile && fs.existsSync(keyFile)) {
    try {
      const w = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
      privateKey = w.privateKey || null;
      signerAddress = w.address || null;
      funder = funder || w.funderAddress || null;
      if (!sigType && w.signatureType != null) sigType = String(w.signatureType);
      if (privateKey) log(`Loaded key for ${signerAddress || 'unknown address'} from ${keyFile} (sigType=${sigType}, funder=${funder || '—'})`);
    } catch (e) { log(`WARN: could not parse ${keyFile}: ${e.message}`); }
  }
  if (sigType === '1') sigType = 'POLY_1271'; // legacy numeric from earlier key files
  if (sigType && !['EOA', '0'].includes(sigType) && !funder && privateKey) {
    log(`REFUSING TO START: signatureType ${sigType} (Polymarket proxy account) requires the proxy/funder address (POLYMARKET_FUNDER_ADDRESS or funderAddress in the key file).`);
    process.exit(1);
  }
  const DRY = process.env.LIVE_TRADING_ENABLED !== '1' || !privateKey;
  // Reuse the repo's battle-tested CLOB path (v2 SDK init, signature-type
  // failover, geo-block relay, tick snapping, 5-token minimum) instead of
  // talking to the SDK directly.
  let feed = null;
  if (!DRY) {
    const PolymarketFeed = require('../../src/bot/PolymarketFeed');
    if (!signerAddress) signerAddress = new (require('ethers').Wallet)(privateKey).address;
    feed = new PolymarketFeed(privateKey, signerAddress, null, null, null, sigType || 'EOA', funder);
    await feed.initialize(); // derives L2 API creds; throws if the key is bad
    if (!feed.clobClient) { log('REFUSING TO START: CLOB client failed to initialize.'); process.exit(1); }
    log(`CLOB client ready (signer ${signerAddress}, funder ${funder || signerAddress})`);
  }
  log(`G_late_arb live executor started — mode: ${DRY ? 'DRY-RUN (no keys / not enabled)' : '*** LIVE ***'}`);

  await dbRetry(() => pool.query(`CREATE TABLE IF NOT EXISTS gla_live_orders (
    id SERIAL PRIMARY KEY, shadow_order_id INT UNIQUE, token_id TEXT, token TEXT,
    price DECIMAL, size DECIMAL, dry_run BOOLEAN, clob_order_id TEXT,
    status TEXT, error TEXT, ts TIMESTAMPTZ DEFAULT now())`), 'orders table ensure');

  let lastSeenId = (await dbRetry(() => pool.query(`SELECT COALESCE(max(id),0) m FROM borg_shadow_orders WHERE strategy='G_late_arb'`), 'lastSeenId read')).rows[0].m;

  await beat({ pid: process.pid, dry: DRY, startedAt: new Date().toISOString() });
  setInterval(() => beat({ pid: process.pid, dry: DRY }), 10000);

  // Realized-loss circuit breaker state: refreshed at most every 30s (it joins
  // three tables), logged once per halt transition so the log isn't spammed.
  let dailyRealized = 0, lastLossCheckAt = 0, lossHaltLogged = false;

  // Re-confirm gate state. The anchor (last gate close) is DB-persisted;
  // NULL means never closed — initialize it to now() so the first window
  // starts fresh at deploy, not on stale history.
  await dbRetry(() => pool.query(`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS gla_reconfirm_anchor TIMESTAMPTZ`), 'anchor column ensure');
  await dbRetry(() => pool.query(`UPDATE bot_settings SET gla_reconfirm_anchor = now() WHERE user_id = 1 AND gla_reconfirm_anchor IS NULL`), 'anchor init');
  let gateOpen = false, lastGateCheckAt = 0;
  const bootCiLow = (a) => {
    const n = a.length, means = new Array(RECONFIRM_BOOT);
    for (let b = 0; b < RECONFIRM_BOOT; b++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += a[(Math.random() * n) | 0];
      means[b] = s / n;
    }
    means.sort((x, y) => x - y);
    return means[Math.floor(RECONFIRM_BOOT * 0.025)];
  };
  const gateCheck = async () => {
    const anchor = (await pool.query(`SELECT gla_reconfirm_anchor a FROM bot_settings WHERE user_id = 1`)).rows[0].a;
    const r = await pool.query(`
      SELECT s.pnl_1x::float pnl FROM borg_shadow_orders o
      JOIN borg_shadow_scores s ON s.order_id = o.id AND s.filled
      JOIN borg_markets m ON m.id = o.market_id
      WHERE o.strategy='G_late_arb' AND o.action='place'
        AND m.asset <> 'hype' AND o.price <= ${ENTRY_CEILING}
        AND ($1::timestamptz IS NULL OR o.ts > $1)
      ORDER BY o.ts DESC LIMIT ${RECONFIRM_N}`, [anchor]);
    const a = r.rows.map((x) => x.pnl);
    const m = a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
    if (!gateOpen) {
      if (a.length < RECONFIRM_N) return; // not enough fresh evidence yet — stay closed silently
      const ciLow = bootCiLow(a);
      if (m >= RECONFIRM_MEAN && ciLow > 0) {
        gateOpen = true;
        log(`RE-CONFIRM GATE: OPEN — fresh-${a.length} shadow mean $${m.toFixed(3)}/fill, CI low $${ciLow.toFixed(3)} (bar: mean ≥$${RECONFIRM_MEAN} AND CI low >0)`);
      }
      return;
    }
    if (m < EDGE_GATE_CLOSE_AT) {
      gateOpen = false;
      await pool.query(`UPDATE bot_settings SET gla_reconfirm_anchor = now() WHERE user_id = 1`);
      log(`RE-CONFIRM GATE: CLOSED — trailing-${a.length} shadow mean $${m.toFixed(3)}/fill < $${EDGE_GATE_CLOSE_AT}; anchor reset, needs a fresh ${RECONFIRM_N}-fill re-confirm to reopen`);
    }
  };

  // Re-entrance guard. Without it, a tick that is still awaiting a slow CLOB
  // round-trip overlaps the next tick; both read the same lastSeenId and the
  // tail rows of a multi-signal burst get placed TWICE at the exchange, while
  // the duplicate's INSERT dies silently on ON CONFLICT (proven live
  // 2026-07-13: doubled eth orders 20:38Z and 21:18Z, DB sequence gaps 46/48/
  // 50/58). Same bug class as BotInstance's documented _loopRunning fix.
  let ticking = false;

  setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      if (killed()) { log('KILL file — halting.'); return clearBeatAndExit(0); }

      // Caps count only PLACED orders — rejected orders cost nothing and must
      // not eat the daily budget (13 auth-rejections once phantom-consumed $147).
      const day = await pool.query(`SELECT count(*) n, COALESCE(sum(price*size),0) spend
        FROM gla_live_orders WHERE NOT dry_run AND status = 'PLACED' AND ts > date_trunc('day', now())`);
      if (+day.rows[0].n >= MAX_ORDERS_PER_DAY || +day.rows[0].spend >= MAX_SPEND_PER_DAY_USD) {
        return; // daily sanity ceiling hit — idle until tomorrow
      }

      if (Date.now() - lastLossCheckAt > 30000) {
        lastLossCheckAt = Date.now();
        const loss = await pool.query(`
          SELECT COALESCE(sum(CASE WHEN upper(m.outcome) = upper(g.token)
                                   THEN ${STAKE_USD}/g.price - ${STAKE_USD} ELSE -${STAKE_USD} END), 0) pnl
          FROM gla_live_orders g
          JOIN borg_shadow_orders o ON o.id = g.shadow_order_id
          JOIN borg_markets m ON m.id = o.market_id
          WHERE g.status = 'PLACED' AND NOT g.dry_run
            AND m.outcome IS NOT NULL AND g.ts > date_trunc('day', now())`);
        dailyRealized = parseFloat(loss.rows[0].pnl);
      }
      if (dailyRealized <= -MAX_DAILY_REALIZED_LOSS_USD) {
        if (!lossHaltLogged) {
          lossHaltLogged = true;
          log(`DAILY LOSS HALT: realized $${dailyRealized.toFixed(2)} ≤ −$${MAX_DAILY_REALIZED_LOSS_USD} — no more orders until next UTC day.`);
        }
        return;
      }
      lossHaltLogged = false;

      if (Date.now() - lastGateCheckAt > 300000) {
        lastGateCheckAt = Date.now();
        await gateCheck().catch((e) => log('gate check error:', e.message));
      }

      const fresh = await pool.query(`
        SELECT o.id, o.market_id, o.token, o.price, o.size, o.ts, m.asset,
               CASE WHEN o.token='UP' THEN m.up_token_id ELSE m.down_token_id END token_id
        FROM borg_shadow_orders o JOIN borg_markets m ON m.id = o.market_id
        WHERE o.strategy='G_late_arb' AND o.action='place' AND o.id > $1
        ORDER BY o.id`, [lastSeenId]);

      for (const row of fresh.rows) {
        lastSeenId = row.id;
        // Population-mismatch fix (2026-07-14 audit): the verdict, the eval
        // clock, and the gate metric are all CORE = ex-hype — but the mirror
        // was placing every G signal, so 38 live hype titles (−$6.02) traded
        // on a population no verdict ever covered. Live trades core only.
        if (row.asset === 'hype') {
          await pool.query(`INSERT INTO gla_live_orders (shadow_order_id, token_id, token, price, size, dry_run, status)
            VALUES ($1,$2,$3,$4,$5,$6,'SKIPPED_NON_CORE') ON CONFLICT DO NOTHING`,
            [row.id, row.token_id, row.token, row.price, row.size, DRY]);
          continue;
        }
        const ageMs = Date.now() - new Date(row.ts).getTime();
        if (ageMs > MAX_SIGNAL_AGE_MS) {
          await pool.query(`INSERT INTO gla_live_orders (shadow_order_id, token_id, token, price, size, dry_run, status)
            VALUES ($1,$2,$3,$4,$5,$6,'SKIPPED_STALE') ON CONFLICT DO NOTHING`,
            [row.id, row.token_id, row.token, row.price, row.size, DRY]);
          continue;
        }
        const ask = parseFloat(row.price);
        if (ask > ENTRY_CEILING) {
          await pool.query(`INSERT INTO gla_live_orders (shadow_order_id, token_id, token, price, size, dry_run, status)
            VALUES ($1,$2,$3,$4,$5,$6,'SKIPPED_CEILING') ON CONFLICT DO NOTHING`,
            [row.id, row.token_id, row.token, ask, row.size, DRY]);
          continue;
        }
        if (!gateOpen) {
          await pool.query(`INSERT INTO gla_live_orders (shadow_order_id, token_id, token, price, size, dry_run, status)
            VALUES ($1,$2,$3,$4,$5,$6,'SKIPPED_EDGE_GATE') ON CONFLICT DO NOTHING`,
            [row.id, row.token_id, row.token, ask, row.size, DRY]);
          continue;
        }
        // One seat per market: G re-evaluates every second and can flip sides
        // when the market swings; mirroring both sides is a self-hedge with a
        // guaranteed friction band (6 such pairs in the first 24h live).
        // First fill holds the seat.
        const hedge = await pool.query(`SELECT 1 FROM gla_live_orders g
          JOIN borg_shadow_orders o2 ON o2.id = g.shadow_order_id
          WHERE o2.market_id = $1 AND g.token <> $2 AND NOT g.dry_run
            AND g.status IN ('PLACED','PLACING') LIMIT 1`, [row.market_id, row.token]);
        if (hedge.rowCount > 0) {
          await pool.query(`INSERT INTO gla_live_orders (shadow_order_id, token_id, token, price, size, dry_run, status)
            VALUES ($1,$2,$3,$4,$5,$6,'SKIPPED_HEDGE') ON CONFLICT DO NOTHING`,
            [row.id, row.token_id, row.token, ask, row.size, DRY]);
          continue;
        }
        const price = +Math.min(ask + CHASE_TICKS, ENTRY_CEILING).toFixed(2); // marketable limit: chase runaway winners, never past the ceiling
        const size = +(STAKE_USD / price).toFixed(2); // token qty, not dollars
        if (DRY) {
          log(`DRY-RUN would place: BUY ${row.token} token=${String(row.token_id).slice(0, 12)}… limit=${price} size=${size} (shadow #${row.id}, age ${ageMs}ms)`);
          await pool.query(`INSERT INTO gla_live_orders (shadow_order_id, token_id, token, price, size, dry_run, status)
            VALUES ($1,$2,$3,$4,$5,true,'DRY_RUN') ON CONFLICT DO NOTHING`,
            [row.id, row.token_id, row.token, price, size]);
          continue;
        }
        // CLAIM the signal in the DB BEFORE touching the exchange: the row is
        // inserted as PLACING and the unique(shadow_order_id) index arbitrates
        // — whoever fails the insert does NOT place. Belt to the re-entrance
        // guard's braces: makes mirroring idempotent even across two executor
        // processes, and a claimed-but-crashed order shows up as a stuck
        // PLACING row instead of an invisible duplicate.
        const claim = await pool.query(`INSERT INTO gla_live_orders (shadow_order_id, token_id, token, price, size, dry_run, status)
          VALUES ($1,$2,$3,$4,$5,false,'PLACING') ON CONFLICT (shadow_order_id) DO NOTHING RETURNING id`,
          [row.id, row.token_id, row.token, price, size]);
        if (claim.rowCount === 0) { log(`shadow #${row.id} already claimed — skipping (duplicate prevented)`); continue; }
        try {
          // GTC marketable limit at recorded ask +1 tick (feed ceils to tick).
          // If the ask moved past the limit, the order rests unfilled and only
          // locks funds until the 5-min market resolves — never fills worse
          // than `price`.
          const resp = await feed.placeOrder(row.token_id, 'BUY', STAKE_USD, price);
          log(`LIVE placed: BUY ${row.token} @ ${price} x${size} → ${resp?.orderID || JSON.stringify(resp).slice(0, 120)}`);
          await pool.query(`UPDATE gla_live_orders SET status='PLACED', clob_order_id=$2 WHERE id=$1`,
            [claim.rows[0].id, resp?.orderID || null]);
        } catch (err) {
          log(`LIVE ORDER FAILED (shadow #${row.id}): ${err.message}`);
          await pool.query(`UPDATE gla_live_orders SET status='ERROR', error=$2 WHERE id=$1`,
            [claim.rows[0].id, err.message.slice(0, 300)]);
        }
      }
    } catch (err) {
      log('tick error:', err.message);
    } finally {
      ticking = false;
    }
  }, 1000);
}

main().catch((e) => { console.error(e); process.exit(1); });
