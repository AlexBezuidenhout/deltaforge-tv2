const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? {
    rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true'
  } : false,
  max: 20,
  // Keep connections alive for 10 minutes — the bot ticks every 8-10s so a
  // 30s idle timeout caused constant connect/disconnect churn (new client log every 20s).
  idleTimeoutMillis: 600000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

// --- Write-failure instrumentation (audit 2026-07-12) ---
// The Neon 512MB-full incident silently dropped writes for ~5 hours. Every
// failed INSERT/UPDATE/DELETE now increments a counter and lands in a ring
// buffer, both exposed via /api/health so the dashboard can go red in minutes.
const dbHealth = {
  writeErrors: 0,
  readErrors: 0,
  lastErrorAt: null,
  recentErrors: [], // ring buffer of { at, message, snippet }
};
const _origQuery = pool.query.bind(pool);
pool.query = function instrumentedQuery(...args) {
  const sql = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].text) || '';
  const isWrite = /^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|TRUNCATE)/i.test(sql);
  const result = _origQuery(...args);
  if (result && typeof result.catch === 'function') {
    result.catch((err) => {
      if (isWrite) dbHealth.writeErrors++; else dbHealth.readErrors++;
      dbHealth.lastErrorAt = new Date().toISOString();
      dbHealth.recentErrors.push({
        at: dbHealth.lastErrorAt,
        message: err.message,
        snippet: sql.replace(/\s+/g, ' ').slice(0, 120),
      });
      if (dbHealth.recentErrors.length > 50) dbHealth.recentErrors.shift();
      console.error(`[DB] ${isWrite ? 'WRITE' : 'READ'} FAILED: ${err.message} :: ${sql.slice(0, 80)}`);
    });
  }
  return result;
};

pool.on('connect', () => {
  console.log('[DB] New client connected to pool');
});

// Initialize tables
const initDB = async () => {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'user',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS bot_settings (
        id SERIAL PRIMARY KEY,
        user_id INTEGER UNIQUE REFERENCES users(id),
        paper_trading BOOLEAN DEFAULT true,
        paper_balance DECIMAL(20, 2) DEFAULT 500.00,
        is_active BOOLEAN DEFAULT false,
        copy_bot_active BOOLEAN DEFAULT false,
        gate1_threshold DECIMAL(5, 3) DEFAULT 0.450,
        gate2_ev_floor DECIMAL(5, 2) DEFAULT 3.00,
        gate3_enabled BOOLEAN DEFAULT true,
        gate3_min_edge DECIMAL(5, 2) DEFAULT 5.00,
        kelly_cap DECIMAL(5, 2) DEFAULT 0.10,
        max_daily_loss DECIMAL(20, 2) DEFAULT 50.00,
        max_drawdown_pct DECIMAL(5, 2) DEFAULT 15.00,
        candidate_portfolio_enabled BOOLEAN DEFAULT true,
        portfolio_bankroll_usdc DECIMAL(20, 2) DEFAULT 500.00,
        main_exec_honest_anchor TIMESTAMPTZ,
        main_legacy_execution_enabled BOOLEAN DEFAULT false,
        paper_risk_epoch_anchor TIMESTAMPTZ,
        paper_risk_limits_enabled BOOLEAN DEFAULT false,
        snipe_timer_seconds INTEGER DEFAULT 10,
        stale_lag_seconds INTEGER DEFAULT 20,
        chase_threshold DECIMAL(5, 2) DEFAULT 8.00,
        whale_convergence BOOLEAN DEFAULT false,
        encrypted_private_key TEXT,
        polymarket_wallet_address VARCHAR(255),
        claude_api_key_encrypted TEXT,
        claude_auto_analysis BOOLEAN DEFAULT false,
        claude_last_analysis TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS trades (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        market_id VARCHAR(255),
        market_question TEXT,
        token_id VARCHAR(255),
        direction VARCHAR(10),
        entry_price DECIMAL(20, 8),
        exit_price DECIMAL(20, 8),
        trade_size DECIMAL(20, 2),
        pnl DECIMAL(20, 2),
        status VARCHAR(50) DEFAULT 'open',
        trade_type VARCHAR(50) DEFAULT 'signal',
        signal_confidence DECIMAL(5, 3),
        ev_adj DECIMAL(10, 4),
        gate1_score DECIMAL(5, 3),
        gate2_score DECIMAL(10, 4),
        gate3_score DECIMAL(10, 4),
        close_reason VARCHAR(100),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        closed_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS signals (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        market_id VARCHAR(255),
        market_question TEXT,
        verdict VARCHAR(50),
        reason TEXT,
        direction VARCHAR(10),
        confidence DECIMAL(5, 3),
        ev_raw DECIMAL(10, 4),
        ev_adj DECIMAL(10, 4),
        ema_edge DECIMAL(10, 4),
        gate1_passed BOOLEAN,
        gate2_passed BOOLEAN,
        gate3_passed BOOLEAN,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS copy_targets (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        wallet_address VARCHAR(255) NOT NULL,
        label VARCHAR(255),
        multiplier DECIMAL(5, 2) DEFAULT 1.00,
        max_trade_size DECIMAL(20, 2) DEFAULT 100.00,
        min_whale_score DECIMAL(5, 2) DEFAULT 0.50,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS copy_trades (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        copy_target_id INTEGER REFERENCES copy_targets(id),
        source_wallet VARCHAR(255),
        market_id VARCHAR(255),
        token_id VARCHAR(255),
        direction VARCHAR(10),
        entry_price DECIMAL(20, 8),
        trade_size DECIMAL(20, 2),
        whale_score DECIMAL(5, 2),
        status VARCHAR(50) DEFAULT 'executed',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS claude_analyses (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        analysis TEXT,
        feedback TEXT,
        trade_count INTEGER DEFAULT 0,
        signal_count INTEGER DEFAULT 0,
        total_pnl DECIMAL(20,2) DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS admin_logs (
        id SERIAL PRIMARY KEY,
        admin_user_id INTEGER REFERENCES users(id),
        action VARCHAR(255),
        target_user_id INTEGER,
        details JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER UNIQUE REFERENCES users(id),
        token TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    // Add columns that may not exist in older deployments (safe to run multiple times)
    await client.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'user',
        -- is_admin (2026-07-13): auth.js adminMiddleware + routes/admin.js have
        -- always read users.is_admin, but only 'role' was ever migrated — every
        -- admin-route poll produced a recurring read error. Backfilled from role.
        ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false;
      UPDATE users SET is_admin = true WHERE role = 'admin' AND is_admin IS DISTINCT FROM true;

      ALTER TABLE trades
        ADD COLUMN IF NOT EXISTS status        VARCHAR(50)    DEFAULT 'open',
        ADD COLUMN IF NOT EXISTS trade_size    DECIMAL(20,2),
        ADD COLUMN IF NOT EXISTS size          DECIMAL(20,2),
        ADD COLUMN IF NOT EXISTS market_id     VARCHAR(255),
        ADD COLUMN IF NOT EXISTS market_question TEXT,
        ADD COLUMN IF NOT EXISTS trade_type    VARCHAR(50)    DEFAULT 'signal',
        ADD COLUMN IF NOT EXISTS signal_confidence DECIMAL(5,3),
        ADD COLUMN IF NOT EXISTS ev_adj        DECIMAL(10,4),
        ADD COLUMN IF NOT EXISTS gate1_score   DECIMAL(5,3),
        ADD COLUMN IF NOT EXISTS gate2_score   DECIMAL(10,4),
        ADD COLUMN IF NOT EXISTS gate3_score   DECIMAL(10,4),
        ADD COLUMN IF NOT EXISTS close_reason  VARCHAR(100),
        ADD COLUMN IF NOT EXISTS closed_at     TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS result        VARCHAR(20),
        ADD COLUMN IF NOT EXISTS slippage      DECIMAL(10,6),
        ADD COLUMN IF NOT EXISTS lag_age_sec   INTEGER,
        ADD COLUMN IF NOT EXISTS exit_price    DECIMAL(20,8),
        ADD COLUMN IF NOT EXISTS token_id      VARCHAR(255),
        ADD COLUMN IF NOT EXISTS model_prob    DECIMAL(5,3);

      ALTER TABLE copy_targets
        ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ DEFAULT NOW();

      ALTER TABLE bot_settings
        ADD COLUMN IF NOT EXISTS copy_bot_active    BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS gate1_threshold    DECIMAL(5,3) DEFAULT 0.450,
        ADD COLUMN IF NOT EXISTS gate2_ev_floor     DECIMAL(5,2) DEFAULT 2.00,
        ADD COLUMN IF NOT EXISTS gate3_enabled      BOOLEAN DEFAULT true,
        ADD COLUMN IF NOT EXISTS gate3_min_edge     DECIMAL(5,2) DEFAULT 5.00,
        ADD COLUMN IF NOT EXISTS snipe_timer_seconds INTEGER DEFAULT 10,
        ADD COLUMN IF NOT EXISTS stale_lag_seconds  INTEGER DEFAULT 20,
        ADD COLUMN IF NOT EXISTS chase_threshold    DECIMAL(5,2) DEFAULT 8.00,
        ADD COLUMN IF NOT EXISTS whale_convergence  BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS max_drawdown_pct   DECIMAL(5,2) DEFAULT 15.00,
        ADD COLUMN IF NOT EXISTS claude_auto_analysis BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS claude_last_analysis TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS claude_api_key_encrypted TEXT,
        ADD COLUMN IF NOT EXISTS encrypted_polymarket_api_key TEXT,
        ADD COLUMN IF NOT EXISTS cached_polymarket_balance DECIMAL(20,2),
        ADD COLUMN IF NOT EXISTS cached_balance_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS min_edge DECIMAL(5,4) DEFAULT 0.05,
        ADD COLUMN IF NOT EXISTS snipe_before_close_sec INTEGER DEFAULT 10,
        ADD COLUMN IF NOT EXISTS order_timeout_sec INTEGER DEFAULT 60,
        ADD COLUMN IF NOT EXISTS adverse_ticks INTEGER DEFAULT 8,
        ADD COLUMN IF NOT EXISTS gate3_min_delta DECIMAL(5,4) DEFAULT 0.05,
        ADD COLUMN IF NOT EXISTS require_whale_convergence BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS max_trade_size DECIMAL(20,2) DEFAULT 100.00,
        ADD COLUMN IF NOT EXISTS min_ev_threshold DECIMAL(5,2) DEFAULT 3.00,
        ADD COLUMN IF NOT EXISTS min_prob_diff DECIMAL(5,3) DEFAULT 0.050,
        ADD COLUMN IF NOT EXISTS direction_filter VARCHAR(10) DEFAULT 'BOTH',
        ADD COLUMN IF NOT EXISTS market_prob_min DECIMAL(5,3) DEFAULT 0.10,
        ADD COLUMN IF NOT EXISTS market_prob_max DECIMAL(5,3) DEFAULT 0.90,
        ADD COLUMN IF NOT EXISTS claude_model VARCHAR(100),
        ADD COLUMN IF NOT EXISTS paper_balance_initialized BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS kelly_mode VARCHAR(10) DEFAULT 'manual',
        ADD COLUMN IF NOT EXISTS flip_threshold DECIMAL(5,2) DEFAULT 5.00,
        ADD COLUMN IF NOT EXISTS ev_decay_ratio DECIMAL(5,2) DEFAULT 2.00,
        ADD COLUMN IF NOT EXISTS early_skip_sec INTEGER DEFAULT 100,
        ADD COLUMN IF NOT EXISTS late_skip_sec INTEGER DEFAULT 600,
        ADD COLUMN IF NOT EXISTS early_window_sec INTEGER DEFAULT 100,
        ADD COLUMN IF NOT EXISTS late_window_sec INTEGER DEFAULT 600,
        ADD COLUMN IF NOT EXISTS min_remaining_sec INTEGER DEFAULT 400,
        ADD COLUMN IF NOT EXISTS min_btc_delta DECIMAL(8,5) DEFAULT 0.01500,
        ADD COLUMN IF NOT EXISTS geo_block_token TEXT,
        ADD COLUMN IF NOT EXISTS clob_proxy_url TEXT,
        ADD COLUMN IF NOT EXISTS min_confidence DECIMAL(5,3) DEFAULT 0.150,
        ADD COLUMN IF NOT EXISTS min_strong_btc_delta DECIMAL(8,5) DEFAULT 0.02000,
        ADD COLUMN IF NOT EXISTS range_chop_gamma_override DECIMAL(5,3) DEFAULT 0.045,
        ADD COLUMN IF NOT EXISTS signature_type VARCHAR(32) DEFAULT 'EOA',
        ADD COLUMN IF NOT EXISTS funder_address VARCHAR(255),
        ADD COLUMN IF NOT EXISTS builder_code VARCHAR(64),
        -- Printer Blast: Φ-model + ensemble + new metrics
        ADD COLUMN IF NOT EXISTS phi_enabled BOOLEAN DEFAULT true,
        ADD COLUMN IF NOT EXISTS phi_sigma_5min DECIMAL(8,6) DEFAULT 0.002800,
        ADD COLUMN IF NOT EXISTS ensemble_phi_weight DECIMAL(4,2) DEFAULT 0.60,
        ADD COLUMN IF NOT EXISTS min_depth_usdc DECIMAL(10,2) DEFAULT 100.00,
        ADD COLUMN IF NOT EXISTS fillprob_floor DECIMAL(5,3) DEFAULT 0.250,
        ADD COLUMN IF NOT EXISTS slip_check_size_usd DECIMAL(10,2) DEFAULT 5.00,
        ADD COLUMN IF NOT EXISTS oracle_lag_max_ms INTEGER DEFAULT 5000,
        ADD COLUMN IF NOT EXISTS volume_spike_ratio DECIMAL(5,2) DEFAULT 2.00,
        -- Optional alternate strategy mode (disabled by default)
        ADD COLUMN IF NOT EXISTS latency_arb_enabled BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS latency_arb_edge_pp DECIMAL(6,4) DEFAULT 0.1000,
        ADD COLUMN IF NOT EXISTS latency_arb_preclose_sec INTEGER DEFAULT 180,
        ADD COLUMN IF NOT EXISTS latency_arb_slope_guard_sec INTEGER DEFAULT 30,
        ADD COLUMN IF NOT EXISTS simple_last_minute_mode BOOLEAN DEFAULT false,
        -- Operator kill switch for the daily loss circuit breaker (referenced by
        -- routes/user.js and BotInstance._checkDailyLossLimit)
        ADD COLUMN IF NOT EXISTS override_daily_loss BOOLEAN DEFAULT false,
        -- PROVISIONAL (audit §2.6): consecutive ticks the early stop-loss condition
        -- must hold before firing (flicker guard on boundary-book mid prices)
        ADD COLUMN IF NOT EXISTS stop_confirm_ticks INTEGER DEFAULT 2,
        -- Phase 2 (simulation honesty). NULL = skip disabled (log-only, PROVISIONAL):
        ADD COLUMN IF NOT EXISTS max_oracle_divergence_bps DECIMAL(10,2),
        -- Paper-fill realism knobs: penalty ticks added to simulated entry fills,
        -- haircut ticks removed from simulated non-terminal exits, fee rate applied
        -- to positive gross PnL at close (previously hardcoded 0.02):
        ADD COLUMN IF NOT EXISTS paper_fill_penalty_ticks INTEGER DEFAULT 1,
        ADD COLUMN IF NOT EXISTS paper_exit_haircut_ticks INTEGER DEFAULT 1,
        ADD COLUMN IF NOT EXISTS paper_fee_rate DECIMAL(6,4) DEFAULT 0.0200,
        -- Current protocol crypto taker fee coefficient. Kept separate from
        -- paper_fee_rate because that legacy column represented 2% of gains,
        -- which is a different (and incorrect) fee basis.
        ADD COLUMN IF NOT EXISTS paper_taker_fee_rate DECIMAL(6,4) DEFAULT 0.0700,
        -- Phase 4 (PROVISIONAL — see IMPROVEMENTS.md):
        -- kelly_prob_shrink: p' = 0.5 + k(p−0.5) before Kelly; 1.0 = raw model
        ADD COLUMN IF NOT EXISTS kelly_prob_shrink DECIMAL(4,2) DEFAULT 0.50,
        -- ev_band_ceiling: skip trades claiming EV above this (%); NULL = disabled
        ADD COLUMN IF NOT EXISTS ev_band_ceiling DECIMAL(10,2),
        -- min_entry_remaining_sec: no NEW entries with less than this remaining
        ADD COLUMN IF NOT EXISTS min_entry_remaining_sec INTEGER DEFAULT 60;

      ALTER TABLE trades
        -- Phase 2 (audit): resolution-source risk telemetry, captured at entry
        ADD COLUMN IF NOT EXISTS oracle_divergence_bps DECIMAL(10,2),
        ADD COLUMN IF NOT EXISTS oracle_lag_ms INTEGER;

      -- Backfill NULLs only. Never rewrite a value the operator saved:
      -- COALESCE keeps non-NULL values, and the WHERE targets NULL rows explicitly
      -- so this statement can never stomp user settings on boot.
      UPDATE bot_settings SET
        min_btc_delta            = COALESCE(min_btc_delta, 0.01500),
        gate2_ev_floor           = COALESCE(gate2_ev_floor, 2.20),
        min_confidence           = COALESCE(min_confidence, 0.420),
        min_strong_btc_delta     = COALESCE(min_strong_btc_delta, 0.02000),
        range_chop_gamma_override = COALESCE(range_chop_gamma_override, 0.045)
      WHERE min_btc_delta IS NULL OR gate2_ev_floor IS NULL OR min_confidence IS NULL
         OR min_strong_btc_delta IS NULL OR range_chop_gamma_override IS NULL;

      ALTER TABLE signals
        ADD COLUMN IF NOT EXISTS gate_failed   DECIMAL(5,2),
        ADD COLUMN IF NOT EXISTS lag_age_sec   INTEGER,
        ADD COLUMN IF NOT EXISTS spread_pct    DECIMAL(10,4),
        ADD COLUMN IF NOT EXISTS session_id    INTEGER,
        ADD COLUMN IF NOT EXISTS scenario      VARCHAR(32),
        -- Audit Phase 3.3: per-signal edge decomposition so calibration.js and
        -- ev-autopsy.js can attribute claimed edge to its components
        ADD COLUMN IF NOT EXISTS model_prob    DECIMAL(6,4),
        ADD COLUMN IF NOT EXISTS p_phi         DECIMAL(6,4),
        ADD COLUMN IF NOT EXISTS p_heur        DECIMAL(6,4),
        ADD COLUMN IF NOT EXISTS btc_edge      DECIMAL(8,5),
        ADD COLUMN IF NOT EXISTS micro_edge    DECIMAL(8,5),
        ADD COLUMN IF NOT EXISTS ensemble_delta DECIMAL(7,4),
        ADD COLUMN IF NOT EXISTS yes_price     DECIMAL(6,4),
        ADD COLUMN IF NOT EXISTS sigma_5min    DECIMAL(10,7),
        ADD COLUMN IF NOT EXISTS sigma_source  VARCHAR(10),
        ADD COLUMN IF NOT EXISTS oracle_divergence_bps DECIMAL(10,2),
        ADD COLUMN IF NOT EXISTS remaining_sec INTEGER,
        ADD COLUMN IF NOT EXISTS btc_price DECIMAL(20, 8),
        ADD COLUMN IF NOT EXISTS chainlink_price DECIMAL(20, 8),
        ADD COLUMN IF NOT EXISTS poly_yes_price DECIMAL(10, 4),
        ADD COLUMN IF NOT EXISTS poly_no_price DECIMAL(10, 4),
        ADD COLUMN IF NOT EXISTS model_challenger_experiment_id TEXT,
        ADD COLUMN IF NOT EXISTS model_challenger_evidence_eligible BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS market_baseline_prob DECIMAL(6,4),
        ADD COLUMN IF NOT EXISTS residual_prob DECIMAL(6,4),
        ADD COLUMN IF NOT EXISTS residual_model_version TEXT,
        -- MAIN regime experiment telemetry. These fields are measurement-only:
        -- the legacy/live order path does not read them. Persisting executable
        -- asks fixes the historical inability to distinguish model edge from a
        -- midpoint/last-trade illusion.
        ADD COLUMN IF NOT EXISTS indicator_regime TEXT,
        ADD COLUMN IF NOT EXISTS indicator_trend TEXT,
        ADD COLUMN IF NOT EXISTS indicator_adx DECIMAL(10,4),
        ADD COLUMN IF NOT EXISTS indicator_atr_pct DECIMAL(12,8),
        ADD COLUMN IF NOT EXISTS indicator_rsi DECIMAL(10,4),
        ADD COLUMN IF NOT EXISTS indicator_plus_di DECIMAL(10,4),
        ADD COLUMN IF NOT EXISTS indicator_minus_di DECIMAL(10,4),
        ADD COLUMN IF NOT EXISTS indicator_realized_vol DECIMAL(14,8),
        ADD COLUMN IF NOT EXISTS indicator_klines_age_sec INTEGER,
        ADD COLUMN IF NOT EXISTS main_market_mode TEXT,
        ADD COLUMN IF NOT EXISTS main_mode_policy TEXT,
        ADD COLUMN IF NOT EXISTS main_mode_model_version TEXT,
        ADD COLUMN IF NOT EXISTS executable_yes_ask DECIMAL(8,5),
        ADD COLUMN IF NOT EXISTS executable_no_ask DECIMAL(8,5),
        ADD COLUMN IF NOT EXISTS executable_yes_ask_usd DECIMAL(20,4),
        ADD COLUMN IF NOT EXISTS executable_no_ask_usd DECIMAL(20,4),
        ADD COLUMN IF NOT EXISTS regime_challenger_direction VARCHAR(10),
        ADD COLUMN IF NOT EXISTS regime_challenger_edge DECIMAL(10,6),
        ADD COLUMN IF NOT EXISTS regime_challenger_eligible BOOLEAN DEFAULT false;

      ALTER TABLE trades
        ADD COLUMN IF NOT EXISTS scenario          VARCHAR(32),
        ADD COLUMN IF NOT EXISTS execution_type    VARCHAR(20) DEFAULT 'LIVE',
        ADD COLUMN IF NOT EXISTS order_placed_at   TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS time_to_fill_sec  DECIMAL(8,2),
        ADD COLUMN IF NOT EXISTS fill_slippage_ticks DECIMAL(6,2),
        ADD COLUMN IF NOT EXISTS is_virtual        BOOLEAN DEFAULT false;

      ALTER TABLE bot_settings
        ADD COLUMN IF NOT EXISTS virtual_loss_enabled  BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS virtual_loss_required INTEGER DEFAULT 2,
        ADD COLUMN IF NOT EXISTS virtual_loss_count    INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS virtual_loss_armed    BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS virtual_paper_balance DECIMAL(20,2);

      ALTER TABLE copy_targets
        ADD COLUMN IF NOT EXISTS min_confirmations INTEGER DEFAULT 1;

    `);

    // trading_sessions — one row per bot start/stop cycle, scopes all trades/signals
    await client.query(`
      CREATE TABLE IF NOT EXISTS trading_sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        started_at TIMESTAMPTZ DEFAULT NOW(),
        ended_at TIMESTAMPTZ,
        paper_trading BOOLEAN DEFAULT true,
        initial_balance DECIMAL(20,2),
        final_balance DECIMAL(20,2),
        total_trades INTEGER DEFAULT 0,
        wins INTEGER DEFAULT 0,
        losses INTEGER DEFAULT 0,
        total_pnl DECIMAL(20,4) DEFAULT 0,
        win_rate DECIMAL(5,2) DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON trading_sessions(user_id);
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS session_id INTEGER REFERENCES trading_sessions(id);
    `);

    // whale_performance — tracks historical performance per copy target address
    await client.query(`
      CREATE TABLE IF NOT EXISTS whale_performance (
        id SERIAL PRIMARY KEY,
        target_address VARCHAR(255) NOT NULL UNIQUE,
        total_trades INTEGER DEFAULT 0,
        win_trades INTEGER DEFAULT 0,
        total_pnl DECIMAL DEFAULT 0,
        avg_latency_ms INTEGER DEFAULT 0,
        last_updated TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_whale_perf_address ON whale_performance(target_address);
    `);

    // skipped_signals — tracks every SKIP for post-hoc analysis
    // Evaluated after market resolution to measure missed-opportunity cost per filter
    await client.query(`
      CREATE TABLE IF NOT EXISTS skipped_signals (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        market_id VARCHAR(255) NOT NULL,
        market_question TEXT,
        skip_reason VARCHAR(64),        -- gate name that blocked: btcFlat, G1, G2, G3, evTrend, etc.
        skip_detail TEXT,               -- full reason string
        direction VARCHAR(10),          -- YES/NO — direction signal would have taken
        entry_price DECIMAL(10,6),      -- Gamma price at skip time
        ev_adj DECIMAL(10,4),           -- EV_adj at skip time (if computed)
        confidence DECIMAL(5,3),
        btc_delta DECIMAL(8,5),
        remaining_sec INTEGER,
        scenario VARCHAR(32),
        -- Resolution fields (filled in later by evaluator)
        resolved_price DECIMAL(10,6),   -- 0.01 (lost) or 0.99 (won) from Gamma
        would_win BOOLEAN,              -- true if direction was correct
        sim_pnl DECIMAL(10,4),          -- simulated P&L = shares*(resolved-entry) - fee
        evaluated_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_skipped_user_time ON skipped_signals(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_skipped_market ON skipped_signals(market_id);
      CREATE INDEX IF NOT EXISTS idx_skipped_unevaluated ON skipped_signals(evaluated_at) WHERE evaluated_at IS NULL;
    `);

    // Ensure legacy 'size' column has no NOT NULL constraint (old schema had it; new schema uses trade_size)
    try {
      await client.query(`ALTER TABLE trades ALTER COLUMN size DROP NOT NULL`);
    } catch (_) { /* column may not exist or constraint already dropped — safe to ignore */ }

    // Close any legacy open trades that pre-date the token_id column
    const legacy = await client.query(`
      UPDATE trades SET status = 'closed', close_reason = 'LEGACY_NO_TOKEN_ID', closed_at = NOW()
      WHERE token_id IS NULL AND status = 'open'
    `);
    if (legacy.rowCount > 0) {
      console.log(`[DB] Closed ${legacy.rowCount} legacy trade(s) with no token_id`);
    }

    // NOTE: an earlier migration here reset gate2_ev_floor to 2.00 for any row >= 5.00
    // on EVERY boot, silently stomping operator-saved floors. Removed: set-if-NULL only.
    await client.query(`
      UPDATE bot_settings SET gate2_ev_floor = 2.00 WHERE gate2_ev_floor IS NULL
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS redeem_log (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        market_id VARCHAR(255) NOT NULL,
        tx_hash VARCHAR(128),
        status VARCHAR(20) NOT NULL,
        error_detail TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, market_id)
      );
      CREATE INDEX IF NOT EXISTS idx_redeem_log_user ON redeem_log(user_id);
    `);

    await client.query(`
      ALTER TABLE bot_settings
        ADD COLUMN IF NOT EXISTS auto_redeem_enabled BOOLEAN DEFAULT true;
      ALTER TABLE bot_settings
        ADD COLUMN IF NOT EXISTS auto_redeem_interval_sec INTEGER DEFAULT 600;
    `);

    // Backfill defaults for NULL columns only (Printer CLOB v2 / polybot-backend parity).
    // Every assignment is COALESCE(col, default): a value the operator saved is NEVER
    // overwritten on boot. (CLAUDE.md previously described this as a "reset every boot"
    // strict migration — that is not, and must not be, what this does.)
    await client.query(`
      UPDATE bot_settings SET
        min_confidence            = COALESCE(min_confidence, 0.150),
        min_btc_delta             = COALESCE(min_btc_delta, 0.00500),
        min_strong_btc_delta      = COALESCE(min_strong_btc_delta, 0.05000),
        snipe_timer_seconds       = COALESCE(snipe_timer_seconds, 5),
        range_chop_gamma_override = COALESCE(range_chop_gamma_override, 0.010),
        gate2_ev_floor            = COALESCE(gate2_ev_floor, 0.80),
        phi_enabled               = COALESCE(phi_enabled, true),
        phi_sigma_5min            = COALESCE(phi_sigma_5min, 0.002800),
        -- Φ weight default 0 since audit 2026-07-12: Brier 0.313 vs coin 0.25 on
        -- 231 resolved signals — anti-informative. Φ stays computed + logged
        -- (phi_enabled), it just gets no vote. Raise only if the next ≥300
        -- signals show Φ beating the price baseline.
        ensemble_phi_weight       = COALESCE(ensemble_phi_weight, 0.00),
        min_depth_usdc            = COALESCE(min_depth_usdc, 100.00),
        fillprob_floor            = COALESCE(fillprob_floor, 0.250),
        slip_check_size_usd       = COALESCE(slip_check_size_usd, 5.00),
        oracle_lag_max_ms         = COALESCE(oracle_lag_max_ms, 5000),
        volume_spike_ratio        = COALESCE(volume_spike_ratio, 2.00),
        paper_trading             = COALESCE(paper_trading, true)
      WHERE true
    `);

    // ── George split-test bot (Chainlink-anchored model, paper only) ──────────
    // Own tables by design: the main bot's one-position / daily-loss / dedup queries
    // must never see George's rows, and vice versa.
    await client.query(`
      CREATE TABLE IF NOT EXISTS george_trades (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        market_id VARCHAR(255) NOT NULL,
        market_question TEXT,
        direction VARCHAR(10),
        entry_price DECIMAL(10,6),
        exit_price DECIMAL(10,6),
        trade_size DECIMAL(20,2),
        pnl DECIMAL(20,4),
        status VARCHAR(20) DEFAULT 'open',
        result VARCHAR(10),
        close_reason VARCHAR(50),
        p_model DECIMAL(6,4),
        p_update DECIMAL(6,4),
        chainlink_open DECIMAL(20,8),
        chainlink_at_entry DECIMAL(20,8),
        spot_at_entry DECIMAL(20,8),
        sigma_5min DECIMAL(10,7),
        divergence_bps DECIMAL(10,2),
        remaining_sec_at_entry INTEGER,
        market_end_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        closed_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_george_trades_user ON george_trades(user_id, status);

      CREATE TABLE IF NOT EXISTS george_signals (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        market_id VARCHAR(255),
        verdict VARCHAR(20),
        reason TEXT,
        direction VARCHAR(10),
        p_model DECIMAL(6,4),
        p_update DECIMAL(6,4),
        chainlink_open DECIMAL(20,8),
        chainlink_now DECIMAL(20,8),
        spot_now DECIMAL(20,8),
        yes_price DECIMAL(6,4),
        sigma_5min DECIMAL(10,7),
        divergence_bps DECIMAL(10,2),
        remaining_sec INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_george_signals_user ON george_signals(user_id, created_at DESC);

      -- Audit 2026-07-12 (ANALYSIS.md): prospective-measurement columns + flags
      ALTER TABLE george_trades
        ADD COLUMN IF NOT EXISTS oracle_age_sec INTEGER;
      ALTER TABLE bot_settings
        ADD COLUMN IF NOT EXISTS strict_paper_fills BOOLEAN DEFAULT true,
        ADD COLUMN IF NOT EXISTS george_mirror_enabled BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS pnl_reset_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS borg_paper_reset_at TIMESTAMPTZ,
        -- Audit 2026-07-13: George's own divergence signal hit its
        -- pre-registered kill (71/158=44.9%, Wilson upper ~52.6%<55% at
        -- n=158>100). Default OFF — a triggered kill is executed, not
        -- renegotiated. george_resurrection_enabled is a SEPARATE, freshly
        -- pre-registered hypothesis (oracle_age<600s AND divergence>=30bps
        -- AND entry in [0.35,0.65]); also default OFF pending an explicit
        -- operator decision to run it.
        ADD COLUMN IF NOT EXISTS george_own_signal_enabled BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS george_resurrection_enabled BOOLEAN DEFAULT false;

      -- exits_hold_only_mode (2026-07-13, operator-approved): counterfactual
      -- logging proved BOTH exit mechanisms lose to holding in 5-min binaries
      -- (HARD_STOP_LOSS n=27: -$61.95 vs hold; PROFIT_LOCK n=25: -$113.95 vs
      -- hold; EV_FLIP n=13: -$2.43/trade). When ON: early stop / trailing stop /
      -- profit lock / EV flip do NOT close positions — they record the would-be
      -- exit (first trigger only) and let the position ride to resolution.
      -- LATE_STOP_RESOLVED (settlement capture) still closes — it's not an exit.
      -- Pre-registered read at n>=150 would-exits: bootstrap CI of
      -- (actual_pnl - would_exit_pnl); CI>0 keep, CI<0 revert.
      ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS exits_hold_only_mode BOOLEAN DEFAULT false;
      -- Elite pass 2026-07-13: per-market cooldown (global form discarded 89%
      -- of equal-quality signal flow) + BORG real-book fill referencing
      -- (gamma+5tick synthetic paid median 3.5c over the real recorded ask).
      ALTER TABLE bot_settings
        ADD COLUMN IF NOT EXISTS per_market_cooldown BOOLEAN DEFAULT true,
        ADD COLUMN IF NOT EXISTS fill_ref_borg_book BOOLEAN DEFAULT true;
      -- G_late_arb live-executor DB switch (gate 4 of 5; see borg/live/RUNBOOK.md).
      -- Default FALSE: live trading requires a deliberate operator UPDATE.
      ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS live_gla_enabled BOOLEAN DEFAULT false;
      -- H53 accidental five-minute favorite has its own independent opt-in.
      -- Default FALSE; the operator explicitly arms it only in conjunction
      -- with the H53 executor acknowledgement and external key file.
      ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS live_h53_enabled BOOLEAN DEFAULT false;
      -- ETH-only G-late live canary has a separate, default-off gate. It never
      -- changes paper_trading and cannot arm the rejected all-asset G executor.
      ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS live_eth_g_late_enabled BOOLEAN DEFAULT false;
      -- Live P&L baseline: wallet USDC at first funded observation after
      -- go-live. Live session pnl = current wallet - baseline. Reset to NULL
      -- after a manual deposit to re-baseline.
      ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS live_gla_baseline_usdc DECIMAL;
      ALTER TABLE trades
        ADD COLUMN IF NOT EXISTS would_exit_reason TEXT,
        ADD COLUMN IF NOT EXISTS would_exit_price NUMERIC,
        ADD COLUMN IF NOT EXISTS would_exit_pnl NUMERIC,
        ADD COLUMN IF NOT EXISTS would_exit_at TIMESTAMPTZ;

      -- Resurrection experiment enabled 2026-07-13 (operator decision). Tag
      -- each george_trades row with which gate admitted it so the fresh-n=100
      -- evaluation is unambiguous even if the flag gets toggled again later —
      -- do not infer entry mode from timestamps, read this column.
      ALTER TABLE george_trades
        ADD COLUMN IF NOT EXISTS entry_mode TEXT,
        ADD COLUMN IF NOT EXISTS token_id TEXT;

      -- Multi-asset (2026-07-12): per-asset attribution + the asset registry.
      -- Registry is the single switchboard for all three bots; seeds are the
      -- verified matrix (Gamma slugs probed, Binance symbols confirmed,
      -- Chainlink feeds verified on-chain). Existing rows backfill to 'btc'.
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS asset TEXT DEFAULT 'btc';
      ALTER TABLE signals ADD COLUMN IF NOT EXISTS asset TEXT DEFAULT 'btc';
      ALTER TABLE george_trades ADD COLUMN IF NOT EXISTS asset TEXT DEFAULT 'btc';
      ALTER TABLE skipped_signals ADD COLUMN IF NOT EXISTS asset TEXT DEFAULT 'btc';

      -- Counterfactual exit measurement (audit 2026-07-13): for every stop-loss
      -- or profit-lock close, record what holding to resolution would have paid.
      -- Pure measurement — populated asynchronously after the market resolves,
      -- never read by any trading decision.
      ALTER TABLE trades
        ADD COLUMN IF NOT EXISTS counterfactual_resolution_price NUMERIC,
        ADD COLUMN IF NOT EXISTS counterfactual_pnl NUMERIC,
        ADD COLUMN IF NOT EXISTS counterfactual_evaluated_at TIMESTAMPTZ;
      CREATE TABLE IF NOT EXISTS asset_config (
        asset TEXT PRIMARY KEY,
        slug_prefix TEXT NOT NULL,
        binance_symbol TEXT,
        price_source TEXT NOT NULL DEFAULT 'binance',
        hl_coin TEXT,
        chainlink_feed TEXT,
        enabled_main BOOLEAN DEFAULT true,
        enabled_george BOOLEAN DEFAULT true,
        enabled_borg BOOLEAN DEFAULT true
      );
      INSERT INTO asset_config (asset, slug_prefix, binance_symbol, price_source, hl_coin, chainlink_feed, enabled_main, enabled_george, enabled_borg) VALUES
        ('btc',  'btc-updown-5m',  'BTCUSDT',  'binance', NULL,  '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c', true,  true,  true),
        ('eth',  'eth-updown-5m',  'ETHUSDT',  'binance', NULL,  '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', true,  true,  true),
        ('sol',  'sol-updown-5m',  'SOLUSDT',  'binance', NULL,  '0x4ffC43a60e009B551865A93d232E33Fce9f01507', true,  true,  true),
        ('bnb',  'bnb-updown-5m',  'BNBUSDT',  'binance', NULL,  '0x14e613AC84a31f709eadbdF89C6CC390fDc9540A', true,  true,  true),
        ('doge', 'doge-updown-5m', 'DOGEUSDT', 'binance', NULL,  NULL, true,  false, true),
        ('xrp',  'xrp-updown-5m',  'XRPUSDT',  'binance', NULL,  NULL, true,  false, true),
        ('hype', 'hype-updown-5m', NULL,       'hyperliquid', 'HYPE', NULL, false, false, true)
      ON CONFLICT (asset) DO NOTHING;

      -- Process supervision: every long-running component upserts its row;
      -- /api/health + dashboard flag anything silent for >120s.
      CREATE TABLE IF NOT EXISTS system_heartbeats (
        component TEXT PRIMARY KEY,
        beat_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        meta      JSONB
      );

      ALTER TABLE bot_settings
        ADD COLUMN IF NOT EXISTS george_is_active BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS george_paper_balance DECIMAL(20,2) DEFAULT 500.00,
        ADD COLUMN IF NOT EXISTS george_trade_size DECIMAL(20,2) DEFAULT 10.00,
        ADD COLUMN IF NOT EXISTS george_max_daily_loss DECIMAL(20,2) DEFAULT 50.00,
        ADD COLUMN IF NOT EXISTS george_min_edge DECIMAL(6,4) DEFAULT 0.0500,
        ADD COLUMN IF NOT EXISTS george_cost_buffer DECIMAL(6,4) DEFAULT 0.0300,
        ADD COLUMN IF NOT EXISTS george_min_sigma DECIMAL(10,7) DEFAULT 0.0005000,
        ADD COLUMN IF NOT EXISTS george_max_sigma DECIMAL(10,7) DEFAULT 0.0200000,
        ADD COLUMN IF NOT EXISTS george_entry_min_remaining INTEGER DEFAULT 75,
        ADD COLUMN IF NOT EXISTS george_entry_max_remaining INTEGER DEFAULT 300,
        ADD COLUMN IF NOT EXISTS george_cl_deviation_pct DECIMAL(6,3) DEFAULT 0.500;

      -- PROVISIONAL risk flags (2026-07-10, red-flag remediation). NULL defaults:
      -- NULL hard_stop_loss_pct = original tiered stop; NULL multiplier = 1.0.
      ALTER TABLE bot_settings
        ADD COLUMN IF NOT EXISTS hard_stop_loss_pct DECIMAL(6,2),
        ADD COLUMN IF NOT EXISTS yes_trade_size_multiplier DECIMAL(4,2),
        ADD COLUMN IF NOT EXISTS max_entry_price DECIMAL(4,3) DEFAULT 0.65,
        ADD COLUMN IF NOT EXISTS macro_trend_window_sec INTEGER DEFAULT 600,
        ADD COLUMN IF NOT EXISTS macro_trend_threshold_pct DECIMAL(6,4) DEFAULT 0.10,
        -- Capital-preservation envelope for the fresh three-candidate study.
        -- This does not enable live trading; paper_trading remains the authority.
        ADD COLUMN IF NOT EXISTS candidate_portfolio_enabled BOOLEAN DEFAULT true,
        ADD COLUMN IF NOT EXISTS portfolio_bankroll_usdc DECIMAL(20,2) DEFAULT 500.00,
        -- One-time cohort boundary. It is set on the first boot containing the
        -- executable-book fix, so legacy synthetic-entry P&L cannot leak into
        -- the new MAIN card or its promotion evidence.
        ADD COLUMN IF NOT EXISTS main_exec_honest_anchor TIMESTAMPTZ,
        -- The legacy quote-relative heuristic remains a paper telemetry control.
        -- It is not permitted to create new paper positions unless explicitly
        -- re-enabled; live mode does not consult this paper-only flag.
        ADD COLUMN IF NOT EXISTS main_legacy_execution_enabled BOOLEAN DEFAULT false,
        -- Paper-only risk cohort boundary. Live risk always remains a rolling
        -- 24h window and never consults this field.
        ADD COLUMN IF NOT EXISTS paper_risk_epoch_anchor TIMESTAMPTZ;

      ALTER TABLE bot_settings
        -- Research mode must keep observing after an imaginary ledger loss.
        -- This flag affects paper paths only; live risk checks ignore it.
        ADD COLUMN IF NOT EXISTS paper_risk_limits_enabled BOOLEAN DEFAULT false;

      UPDATE bot_settings SET
        candidate_portfolio_enabled = COALESCE(candidate_portfolio_enabled, true),
        portfolio_bankroll_usdc = COALESCE(portfolio_bankroll_usdc, 500.00),
        main_exec_honest_anchor = COALESCE(main_exec_honest_anchor, now()),
        main_legacy_execution_enabled = COALESCE(main_legacy_execution_enabled, false),
        paper_risk_epoch_anchor = COALESCE(paper_risk_epoch_anchor, main_exec_honest_anchor, now()),
        paper_risk_limits_enabled = COALESCE(paper_risk_limits_enabled, false)
      WHERE candidate_portfolio_enabled IS NULL
         OR portfolio_bankroll_usdc IS NULL
         OR main_exec_honest_anchor IS NULL
         OR main_legacy_execution_enabled IS NULL
         OR paper_risk_epoch_anchor IS NULL
         OR paper_risk_limits_enabled IS NULL;
    `);

    console.log('[DB] Tables initialized successfully');
  } catch (err) {
    console.error('[DB] Table initialization error:', err.message);
  } finally {
    client.release();
  }
};

module.exports = { pool, initDB, dbHealth };
