require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { pool, initDB } = require('./models/db');
const BotManager = require('./bot/BotManager');
const { isAuthDisabled, isRegistrationAllowed } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

// --- Trust proxy (Railway sits behind a load balancer) ---
app.set('trust proxy', 1);

// --- Security ---
app.use(helmet({
  contentSecurityPolicy: false,
}));

// --- CORS: Exact origins only ---
// Same-origin requests need to be allowed explicitly — the browser sends
// Origin: http://localhost:<PORT> on XHR from the bundled HTML page.
// We add the current port automatically + a wide local-dev allowlist.
const allowedOrigins = [
  process.env.FRONTEND_URL,
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002',
  'http://localhost:3003',
  'http://localhost:3004',
  'http://localhost:5173',
].filter(Boolean).map(o => o.replace(/\/$/, ''));

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`[CORS] Blocked request from origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));

// --- Bot Manager (no global) ---
const botManager = new BotManager();
app.locals.botManager = botManager;

// --- Routes ---
app.use('/api/auth', require('./routes/auth'));
app.use('/api/bot', require('./routes/bot'));
app.use('/api/user', require('./routes/user'));
app.use('/api/copy', require('./routes/copy'));
app.use('/api/claude', require('./routes/claude'));
app.use('/api/trades', require('./routes/trades'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/backtest', require('./routes/backtest'));
app.use('/api/borg', require('./routes/borg')); // read-only view of borg_* (collector runs under launchd, not here)
app.use('/api/bots', require('./routes/bots')); // unified auto-discovering bot registry (dashboard overview)

// --- Health Check ---
let _dbReady = false;
app.get('/api/health', async (req, res) => {
  const { dbHealth, pool } = require('./models/db');
  let dbSizeMb = null, dbWritable = false, heartbeats = {};
  try {
    const r = await pool.query(
      "SELECT pg_database_size(current_database())/1048576 AS mb");
    dbSizeMb = Math.round(parseFloat(r.rows[0].mb));
    // A tiny write proves the 512MB cap isn't hit (DELETE keeps the table at 1 row)
    await pool.query(`CREATE TABLE IF NOT EXISTS health_probe (ts timestamptz);
      DELETE FROM health_probe; INSERT INTO health_probe VALUES (now())`);
    dbWritable = true;
  } catch (e) { /* dbWritable stays false */ }
  try {
    // Component heartbeats: bots + scorer from system_heartbeats, the BORG
    // collector from its own borg_events heartbeat stream.
    // Per-component staleness thresholds: the scorer is a 5-min one-shot
    // (launchd StartInterval=300), so 120s would false-red it on most polls;
    // 660s = two missed runs.
    const STALE_AFTER = { main_bot: 120, george_bot: 120, borg_scorer: 660, borg_collector: 120, gla_live: 120 };
    const hb = await pool.query(`
      SELECT component, ROUND(EXTRACT(EPOCH FROM now() - beat_at))::int AS age_sec, NULL AS msg
      FROM system_heartbeats
      UNION ALL
      SELECT 'borg_collector',
             ROUND(EXTRACT(EPOCH FROM now() - MAX(ts)))::int,
             (SELECT message FROM borg_events WHERE source='heartbeat' ORDER BY id DESC LIMIT 1)
      FROM borg_events WHERE source='heartbeat'`);
    for (const row of hb.rows) {
      const limit = STALE_AFTER[row.component] ?? 120;
      // A collector heartbeat that says "STALE: binance>10s" means the process
      // is alive but a feed is dead (the 2026-07-12 7h blind spot) — red it.
      const feedDegraded = row.component === 'borg_collector' && row.msg != null && row.msg !== 'ok';
      heartbeats[row.component] = {
        ageSec: row.age_sec,
        stale: row.age_sec == null || row.age_sec > limit || feedDegraded,
        ...(feedDegraded ? { feedStatus: row.msg } : {}),
      };
    }
  } catch (e) { /* tables may not exist yet */ }
  const staleComponents = Object.entries(heartbeats).filter(([, v]) => v.stale).map(([k]) => k);
  const degraded = !dbWritable || dbHealth.writeErrors > 0;
  res.status(degraded ? 503 : 200).json({
    status: degraded ? 'degraded' : 'ok',
    db: _dbReady ? 'ready' : 'initializing',
    dbWritable,
    dbSizeMb,
    writeErrors: dbHealth.writeErrors,
    readErrors: dbHealth.readErrors,
    lastDbErrorAt: dbHealth.lastErrorAt,
    recentDbErrors: dbHealth.recentErrors.slice(-5),
    heartbeats,
    staleComponents,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    activeBots: botManager.getActiveCount(),
    authDisabled: isAuthDisabled(),
    registrationAllowed: isRegistrationAllowed(),
  });
});

// --- Serve frontend static files ---
const path = require('path');
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- Root: serve dashboard (SPA fallback) ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// --- Auto-restart active bots on deploy ---
const autoRestartBots = async () => {
  try {
    // Restart signal bots
    const signalResult = await pool.query(`
      SELECT bs.*, u.email AS user_email 
      FROM bot_settings bs 
      JOIN users u ON bs.user_id = u.id 
      WHERE bs.is_active = true
    `);

    for (const settings of signalResult.rows) {
      try {
        console.log(`[AutoRestart] Starting signal bot for user ${settings.user_id} (${settings.user_email})`);
        await botManager.startBot(settings.user_id, settings);
      } catch (err) {
        console.error(`[AutoRestart] Failed to restart signal bot for user ${settings.user_id}:`, err.message);
      }
    }

    // Restart copy bots
    const copyResult = await pool.query(`
      SELECT DISTINCT ON (ct.user_id) ct.user_id, bs.*, u.email AS user_email
      FROM copy_targets ct 
      JOIN bot_settings bs ON ct.user_id = bs.user_id 
      JOIN users u ON ct.user_id = u.id
      WHERE ct.is_active = true AND bs.copy_bot_active = true
      ORDER BY ct.user_id, ct.updated_at DESC
    `);

    for (const settings of copyResult.rows) {
      try {
        console.log(`[AutoRestart] Starting copy bot for user ${settings.user_id} (${settings.user_email})`);
        await botManager.startCopyBot(settings.user_id, settings);
      } catch (err) {
        console.error(`[AutoRestart] Failed to restart copy bot for user ${settings.user_id}:`, err.message);
      }
    }

    // Restart George split-test bots (paper only)
    const georgeResult = await pool.query(`
      SELECT bs.*, u.email AS user_email
      FROM bot_settings bs
      JOIN users u ON bs.user_id = u.id
      WHERE bs.george_is_active = true
    `);
    for (const settings of georgeResult.rows) {
      try {
        console.log(`[AutoRestart] Starting George bot for user ${settings.user_id} (${settings.user_email})`);
        await botManager.startGeorgeBot(settings.user_id, settings);
      } catch (err) {
        console.error(`[AutoRestart] Failed to restart George bot for user ${settings.user_id}:`, err.message);
      }
    }

    const totalRestarted = signalResult.rows.length + copyResult.rows.length + georgeResult.rows.length;
    if (totalRestarted > 0) {
      console.log(`[AutoRestart] Restarted ${totalRestarted} bot(s)`);
    }
  } catch (err) {
    console.error('[AutoRestart] Error:', err.message);
  }
};

// --- Start Server ---
const startServer = async () => {
  try {
    // Start HTTP server immediately so Railway healthcheck passes
    const server = app.listen(PORT, HOST, () => {
      console.log(`[Server] PolyBot backend running on ${HOST}:${PORT}`);
      console.log(`[Server] Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`[Server] CORS origins: ${allowedOrigins.join(', ')}`);
    });

    // Init DB after server is up (healthcheck won't fail while DB connects)
    try {
      await initDB();
      _dbReady = true;
      console.log('[DB] Connected and initialized');
    } catch (dbErr) {
      console.error('[DB] Init failed:', dbErr.message);
      // Don't exit — let the server stay up so Railway doesn't retry-loop
    }

    // --- Single-instance guard (audit 2026-07-12) ---
    // On Jul 11 THREE copies of this server ran concurrently (:3004 nohup,
    // stale :47001, current :47000), each auto-starting the bots — every
    // signal executed up to 3×, duplicating trades milliseconds apart.
    // A session-level pg advisory lock makes that impossible: the bots only
    // start in the process holding the lock. The lock dies with the
    // connection, so a crashed holder frees it automatically.
    //
    // The lock MUST use a direct (non-pooler) connection: session-level
    // advisory locks through pgbouncer transaction pooling stick to an
    // arbitrary backend, not to this process. Standbys retry every 60s so
    // killing the holder promotes another instance automatically.
    const { Client } = require('pg');
    const directUrl = process.env.DATABASE_URL_DIRECT
      || (process.env.DATABASE_URL || '').replace('-pooler', '');
    let botsStarted = false;
    const tryAcquireBotLock = async () => {
      if (botsStarted) return;
      const client = new Client({
        connectionString: directUrl,
        ssl: directUrl ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true' } : false,
      });
      try {
        await client.connect();
        const { rows } = await client.query(
          "SELECT pg_try_advisory_lock(hashtext('deltaforge-bot-runner')) AS got");
        if (rows[0].got) {
          botsStarted = true;
          console.log('[Server] Bot-runner advisory lock acquired — this instance runs the bots');
          setTimeout(autoRestartBots, 3000);
          // Keep the lock connection alive; never block shutdown.
          setInterval(() => client.query('SELECT 1').catch(() => {}), 60000).unref();
        } else {
          await client.end();
          console.error('[Server] ⛔ Another instance holds the bot-runner lock — standing by (retry in 60s)');
        }
      } catch (lockErr) {
        try { await client.end(); } catch (_) {}
        if (!botsStarted) {
          console.error('[Server] Advisory lock check failed:', lockErr.message,
            '— starting bots anyway (fail-open, DB unique indexes are the backstop)');
          botsStarted = true;
          setTimeout(autoRestartBots, 3000);
        }
      }
    };
    await tryAcquireBotLock();
    setInterval(tryAcquireBotLock, 60000).unref();

    // --- Graceful Shutdown ---
    const shutdown = async (signal) => {
      console.log(`\n[Server] ${signal} received. Graceful shutdown starting...`);

      // Stop all bot instances
      try {
        console.log('[Server] Stopping all bot instances...');
        await botManager.stopAll();
        console.log('[Server] All bots stopped.');
      } catch (err) {
        console.error('[Server] Error stopping bots:', err.message);
      }

      // Close database pool
      try {
        await pool.end();
        console.log('[Server] Database pool closed.');
      } catch (err) {
        console.error('[Server] Error closing DB pool:', err.message);
      }

      // Close HTTP server
      server.close(() => {
        console.log('[Server] HTTP server closed.');
        process.exit(0);
      });

      // Force exit after 10s
      setTimeout(() => {
        console.error('[Server] Forced exit after timeout');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Crash guards (2026-07-13: an unhandled socket 'error' event —
    // EADDRNOTAVAIL during a full network outage — killed the process and
    // all bots stayed down overnight). Transient network-level errors are
    // logged and survived: every feed has its own reconnect logic, so the
    // process is healthier alive than restarted mid-outage. Anything else
    // still exits(1) — launchd (com.deltaforge.server, KeepAlive) restarts us.
    const TRANSIENT_NET = new Set(['EADDRNOTAVAIL', 'ETIMEDOUT', 'ECONNRESET',
      'ENETDOWN', 'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'ECONNREFUSED', 'EHOSTUNREACH']);
    process.on('unhandledRejection', (err) => {
      console.error('[Server] unhandledRejection:', err?.message || err);
    });
    process.on('uncaughtException', (err) => {
      console.error('[Server] uncaughtException:', err?.code, err?.message, err?.stack?.slice(0, 400));
      if (err && TRANSIENT_NET.has(err.code)) return; // feeds self-heal; stay up
      process.exit(1); // supervisor restarts us
    });

  } catch (err) {
    console.error('[Server] Fatal startup error:', err.message);
    process.exit(1);
  }
};

startServer();

module.exports = app;
