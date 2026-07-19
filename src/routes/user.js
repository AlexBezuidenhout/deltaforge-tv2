const express = require('express');
const { pool } = require('../models/db');
const { authMiddleware } = require('../middleware/auth');
const { encrypt, decrypt } = require('../services/encryption');

const router = express.Router();
router.use(authMiddleware);

// Free public Polygon RPCs (no API key needed) — tried in order
const POLYGON_RPCS = [
  process.env.POLYGON_RPC_URL,
  'https://polygon-bor-rpc.publicnode.com',
  'https://1rpc.io/matic',
  'https://polygon.drpc.org',
].filter(Boolean);

async function getPolygonUsdcBalance(walletAddress) {
  const { ethers } = require('ethers');
  const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];
  // CLOB v2 collateral is pUSD, but some wallets can still hold USDC/USDC.e.
  // Check all three to avoid false 0 balances after migration.
  const TOKENS = [
    // pUSD (CollateralToken proxy) — official Polymarket contracts docs
    { addr: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB', decimals: 6, name: 'pUSD' },
    { addr: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6, name: 'USDC' },
    { addr: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', decimals: 6, name: 'USDC.e' },
  ];
  for (const rpc of POLYGON_RPCS) {
    try {
      const provider = new ethers.JsonRpcProvider(rpc);
      let total = 0;
      let anyReadSucceeded = false;
      for (const token of TOKENS) {
        try {
          const contract = new ethers.Contract(token.addr, ERC20_ABI, provider);
          const raw = await Promise.race([
            contract.balanceOf(walletAddress),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))
          ]);
          anyReadSucceeded = true;
          total += parseFloat(ethers.formatUnits(raw, token.decimals));
        } catch (_) {}
      }
      // Return 0 only if at least one token contract read actually succeeded.
      // Otherwise continue to next RPC and eventually return null (RPC failure).
      if (anyReadSucceeded) return parseFloat(total.toFixed(4));
    } catch (e) {
      console.warn(`[Balance] RPC ${rpc} failed: ${e.message}`);
    }
  }
  return null;
}

async function getClobUsdcBalance(privateKey, walletAddress, signatureType = 'EOA', funderAddress = null) {
  if (!privateKey || !walletAddress) return null;
  try {
    const PolymarketFeed = require('../bot/PolymarketFeed');
    const result = await PolymarketFeed.fetchBalance(privateKey, walletAddress, signatureType, funderAddress);
    const usdc = parseFloat(result?.usdc);
    return Number.isFinite(usdc) ? usdc : null;
  } catch (e) {
    console.warn(`[Balance] CLOB fetch failed: ${e.message}`);
    return null;
  }
}

async function getProxyWalletAddress(address) {
  if (!address) return null;
  try {
    const url = `https://gamma-api.polymarket.com/public-profile?address=${encodeURIComponent(address)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    const proxy = data?.proxyWallet || null;
    if (proxy && /^0x[a-fA-F0-9]{40}$/.test(proxy)) return proxy;
    return null;
  } catch (_) {
    return null;
  }
}

// GET /api/user/settings
router.get('/settings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM bot_settings WHERE user_id = $1', [req.userId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Settings not found' });
    const settings = result.rows[0];
    const hasKey = !!settings.encrypted_private_key;
    const hasApiKey = !!settings.encrypted_polymarket_api_key;
    const hasClaudeKey = !!settings.claude_api_key_encrypted;
    const hasGeoToken = !!settings.geo_block_token;
    delete settings.encrypted_private_key;
    delete settings.encrypted_polymarket_api_key;
    delete settings.claude_api_key_encrypted;
    // Don't send the raw geo token to the frontend — just signal presence
    delete settings.geo_block_token;
    if (req.readOnly) {
      // Strategy parameters remain visible, but operational wallet/proxy
      // metadata is not part of a research viewer's access.
      delete settings.polymarket_wallet_address;
      delete settings.funder_address;
      delete settings.builder_code;
      delete settings.clob_proxy_url;
    }
    res.json({
      ...settings,
      has_private_key: req.readOnly ? false : hasKey,
      has_polymarket_api_key: req.readOnly ? false : hasApiKey,
      has_claude_api_key: req.readOnly ? false : hasClaudeKey,
      has_geo_token: req.readOnly ? false : hasGeoToken,
    });
  } catch (err) {
    console.error('Settings GET error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/user/settings
router.put('/settings', async (req, res) => {
  const {
    private_key, polymarket_api_key, polymarket_wallet_address, kelly_cap, max_daily_loss, max_trade_size,
    min_ev_threshold, min_prob_diff, direction_filter,
    market_prob_min, market_prob_max, paper_trading, override_daily_loss, min_edge, snipe_before_close_sec, require_whale_convergence,
    claude_api_key, claude_model, auto_claude_analysis,
    gate1_threshold, gate2_ev_floor, gate3_enabled, gate3_min_delta,
    order_timeout_sec, adverse_ticks, kelly_mode, snipe_timer_seconds,
    flip_threshold, ev_decay_ratio,
    min_btc_delta, early_window_sec, late_window_sec,
    geo_block_token, clob_proxy_url,
    signature_type, funder_address, builder_code,
    auto_redeem_enabled, auto_redeem_interval_sec,
    latency_arb_enabled, latency_arb_edge_pp, latency_arb_preclose_sec, latency_arb_slope_guard_sec,
    simple_last_minute_mode,
    // Signal-quality knobs that previously could NOT be saved through this route at all
    // (the DB migration default therefore stayed in force forever — audit bug 2.2)
    min_confidence, min_strong_btc_delta, range_chop_gamma_override,
    phi_enabled, phi_sigma_5min, ensemble_phi_weight,
    min_depth_usdc, fillprob_floor, slip_check_size_usd, oracle_lag_max_ms,
    max_drawdown_pct, stale_lag_seconds, chase_threshold,
    // Audit Phase 1/2 knobs
    stop_confirm_ticks, max_oracle_divergence_bps,
    paper_fill_penalty_ticks, paper_exit_haircut_ticks, paper_fee_rate, paper_taker_fee_rate,
    // Audit Phase 4 knobs (PROVISIONAL)
    kelly_prob_shrink, ev_band_ceiling, min_entry_remaining_sec,
    // George split-test knobs
    george_trade_size, george_min_edge, george_max_daily_loss,
    george_min_sigma, george_max_sigma, george_cost_buffer,
    george_entry_min_remaining, george_entry_max_remaining, george_cl_deviation_pct,
    paper_balance, george_paper_balance
  } = req.body;

  // Numeric parse that treats 0 as a real value (never `|| null` on these — a saved 0
  // must round-trip, and parseFloat('') is NaN which maps to null = keep existing).
  const num = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = parseFloat(String(v));
    return Number.isFinite(n) ? n : null;
  };
  const intOrNull = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = parseInt(String(v), 10);
    return Number.isFinite(n) ? n : null;
  };

  try {
    let encryptedKey = null;
    if (private_key) {
      if (!private_key.startsWith('0x') || private_key.length !== 66) {
        return res.status(400).json({ error: 'Invalid private key format (must be 0x + 64 hex chars)' });
      }
      encryptedKey = encrypt(private_key);
    }

    let encryptedApiKey = null;
    if (polymarket_api_key) {
      // Basic validation — should be non-empty
      if (polymarket_api_key.trim().length === 0) {
        return res.status(400).json({ error: 'Polymarket API key cannot be empty' });
      }
      encryptedApiKey = encrypt(polymarket_api_key);
    }

    let encryptedClaudeKey = null;
    if (claude_api_key) {
      if (claude_api_key.trim().length === 0) {
        return res.status(400).json({ error: 'Claude API key cannot be empty' });
      }
      encryptedClaudeKey = encrypt(claude_api_key);
    }

    await pool.query(`
      INSERT INTO bot_settings (user_id, encrypted_private_key, encrypted_polymarket_api_key, polymarket_wallet_address, kelly_cap, max_daily_loss, max_trade_size,
        min_ev_threshold, min_prob_diff, direction_filter, market_prob_min, market_prob_max, paper_trading, override_daily_loss, min_edge, snipe_before_close_sec, require_whale_convergence,
        claude_api_key_encrypted, claude_model, claude_auto_analysis, gate1_threshold, gate2_ev_floor, gate3_enabled, gate3_min_delta,
        order_timeout_sec, adverse_ticks, kelly_mode, snipe_timer_seconds, flip_threshold, ev_decay_ratio,
        min_btc_delta, early_window_sec, late_window_sec, geo_block_token, clob_proxy_url, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        encrypted_private_key = COALESCE($2, bot_settings.encrypted_private_key),
        encrypted_polymarket_api_key = COALESCE($3, bot_settings.encrypted_polymarket_api_key),
        polymarket_wallet_address = COALESCE($4, bot_settings.polymarket_wallet_address),
        kelly_cap = COALESCE($5, bot_settings.kelly_cap),
        max_daily_loss = COALESCE($6, bot_settings.max_daily_loss),
        max_trade_size = COALESCE($7, bot_settings.max_trade_size),
        min_ev_threshold = COALESCE($8, bot_settings.min_ev_threshold),
        min_prob_diff = COALESCE($9, bot_settings.min_prob_diff),
        direction_filter = COALESCE($10, bot_settings.direction_filter),
        market_prob_min = COALESCE($11, bot_settings.market_prob_min),
        market_prob_max = COALESCE($12, bot_settings.market_prob_max),
        paper_trading = COALESCE($13, bot_settings.paper_trading),
        override_daily_loss = COALESCE($14, bot_settings.override_daily_loss),
        min_edge = COALESCE($15, bot_settings.min_edge),
        snipe_before_close_sec = COALESCE($16, bot_settings.snipe_before_close_sec),
        require_whale_convergence = COALESCE($17, bot_settings.require_whale_convergence),
        claude_api_key_encrypted = COALESCE($18, bot_settings.claude_api_key_encrypted),
        claude_model = COALESCE($19, bot_settings.claude_model),
        claude_auto_analysis = COALESCE($20, bot_settings.claude_auto_analysis),
        gate1_threshold = COALESCE($21, bot_settings.gate1_threshold),
        gate2_ev_floor = COALESCE($22, bot_settings.gate2_ev_floor),
        gate3_enabled = COALESCE($23, bot_settings.gate3_enabled),
        gate3_min_delta = COALESCE($24, bot_settings.gate3_min_delta),
        order_timeout_sec = COALESCE($25, bot_settings.order_timeout_sec),
        adverse_ticks = COALESCE($26, bot_settings.adverse_ticks),
        kelly_mode = COALESCE($27, bot_settings.kelly_mode),
        snipe_timer_seconds = COALESCE($28, bot_settings.snipe_timer_seconds),
        flip_threshold = COALESCE($29, bot_settings.flip_threshold),
        ev_decay_ratio = COALESCE($30, bot_settings.ev_decay_ratio),
        min_btc_delta = COALESCE($31, bot_settings.min_btc_delta),
        early_window_sec = COALESCE($32, bot_settings.early_window_sec),
        late_window_sec = COALESCE($33, bot_settings.late_window_sec),
        geo_block_token = COALESCE($34, bot_settings.geo_block_token),
        clob_proxy_url = COALESCE($35, bot_settings.clob_proxy_url),
        updated_at = NOW()
    `, [
      req.userId, encryptedKey, encryptedApiKey, polymarket_wallet_address || null,
      kelly_cap || null, max_daily_loss || null, max_trade_size || null,
      min_ev_threshold || null, min_prob_diff || null, direction_filter || null,
      market_prob_min || null, market_prob_max || null,
      paper_trading !== undefined ? paper_trading : null,
      override_daily_loss !== undefined ? !!override_daily_loss : null,
      min_edge || null, snipe_before_close_sec || null,
      require_whale_convergence !== undefined ? require_whale_convergence : null,
      encryptedClaudeKey, claude_model || null,
      auto_claude_analysis !== undefined ? auto_claude_analysis : null,
      gate1_threshold || null, gate2_ev_floor || null,
      gate3_enabled !== undefined ? gate3_enabled : null,
      gate3_min_delta || null,
      order_timeout_sec || null, adverse_ticks || null,
      kelly_mode || null, snipe_timer_seconds || null,
      flip_threshold || null, ev_decay_ratio || null,
      min_btc_delta || null, early_window_sec || null, late_window_sec || null,
      geo_block_token || null, clob_proxy_url || null
    ]);

    await pool.query(`
      UPDATE bot_settings
      SET
        signature_type = COALESCE($2, signature_type),
        funder_address = COALESCE($3, funder_address),
        builder_code = COALESCE($4, builder_code),
        auto_redeem_enabled = COALESCE($5, auto_redeem_enabled),
        auto_redeem_interval_sec = COALESCE($6, auto_redeem_interval_sec),
        latency_arb_enabled = COALESCE($7, latency_arb_enabled),
        latency_arb_edge_pp = COALESCE($8, latency_arb_edge_pp),
        latency_arb_preclose_sec = COALESCE($9, latency_arb_preclose_sec),
        latency_arb_slope_guard_sec = COALESCE($10, latency_arb_slope_guard_sec),
        simple_last_minute_mode = COALESCE($11, simple_last_minute_mode),
        updated_at = NOW()
      WHERE user_id = $1
    `, [
      req.userId,
      signature_type || null,
      funder_address || null,
      builder_code || null,
      auto_redeem_enabled !== undefined ? !!auto_redeem_enabled : null,
      auto_redeem_interval_sec != null && auto_redeem_interval_sec !== ''
        ? Math.max(120, parseInt(String(auto_redeem_interval_sec), 10) || 600)
        : null,
      latency_arb_enabled !== undefined ? !!latency_arb_enabled : null,
      latency_arb_edge_pp != null && latency_arb_edge_pp !== ''
        ? Math.max(0.01, Math.min(0.50, parseFloat(String(latency_arb_edge_pp)) || 0.10))
        : null,
      latency_arb_preclose_sec != null && latency_arb_preclose_sec !== ''
        ? Math.max(30, Math.min(300, parseInt(String(latency_arb_preclose_sec), 10) || 180))
        : null,
      latency_arb_slope_guard_sec != null && latency_arb_slope_guard_sec !== ''
        ? Math.max(5, Math.min(120, parseInt(String(latency_arb_slope_guard_sec), 10) || 30))
        : null,
      simple_last_minute_mode !== undefined ? !!simple_last_minute_mode : null
    ]);

    // Signal-quality knobs (audit fix): each is set-if-provided, keep-existing otherwise.
    await pool.query(`
      UPDATE bot_settings
      SET
        min_confidence            = COALESCE($2,  min_confidence),
        min_strong_btc_delta      = COALESCE($3,  min_strong_btc_delta),
        range_chop_gamma_override = COALESCE($4,  range_chop_gamma_override),
        phi_enabled               = COALESCE($5,  phi_enabled),
        phi_sigma_5min            = COALESCE($6,  phi_sigma_5min),
        ensemble_phi_weight       = COALESCE($7,  ensemble_phi_weight),
        min_depth_usdc            = COALESCE($8,  min_depth_usdc),
        fillprob_floor            = COALESCE($9,  fillprob_floor),
        slip_check_size_usd       = COALESCE($10, slip_check_size_usd),
        oracle_lag_max_ms         = COALESCE($11, oracle_lag_max_ms),
        max_drawdown_pct          = COALESCE($12, max_drawdown_pct),
        stale_lag_seconds         = COALESCE($13, stale_lag_seconds),
        chase_threshold           = COALESCE($14, chase_threshold),
        override_daily_loss       = COALESCE($15, override_daily_loss),
        stop_confirm_ticks        = COALESCE($16, stop_confirm_ticks),
        max_oracle_divergence_bps = COALESCE($17, max_oracle_divergence_bps),
        paper_fill_penalty_ticks  = COALESCE($18, paper_fill_penalty_ticks),
        paper_exit_haircut_ticks  = COALESCE($19, paper_exit_haircut_ticks),
        paper_fee_rate            = COALESCE($20, paper_fee_rate),
        paper_taker_fee_rate      = COALESCE($21, paper_taker_fee_rate),
        kelly_prob_shrink         = COALESCE($22, kelly_prob_shrink),
        ev_band_ceiling           = COALESCE($23, ev_band_ceiling),
        min_entry_remaining_sec   = COALESCE($24, min_entry_remaining_sec),
        paper_balance             = COALESCE($25, paper_balance),
        updated_at = NOW()
      WHERE user_id = $1
    `, [
      req.userId,
      num(min_confidence),
      num(min_strong_btc_delta),
      num(range_chop_gamma_override),
      phi_enabled !== undefined ? !!phi_enabled : null,
      num(phi_sigma_5min),
      num(ensemble_phi_weight),
      num(min_depth_usdc),
      num(fillprob_floor),
      num(slip_check_size_usd),
      intOrNull(oracle_lag_max_ms),
      num(max_drawdown_pct),
      intOrNull(stale_lag_seconds),
      num(chase_threshold),
      override_daily_loss !== undefined ? !!override_daily_loss : null,
      intOrNull(stop_confirm_ticks),
      num(max_oracle_divergence_bps),
      intOrNull(paper_fill_penalty_ticks),
      intOrNull(paper_exit_haircut_ticks),
      num(paper_fee_rate),
      num(paper_taker_fee_rate),
      num(kelly_prob_shrink),
      num(ev_band_ceiling),
      intOrNull(min_entry_remaining_sec),
      num(paper_balance)
    ]);

    // George split-test knobs — same set-if-provided semantics
    await pool.query(`
      UPDATE bot_settings
      SET
        george_trade_size          = COALESCE($2,  george_trade_size),
        george_min_edge            = COALESCE($3,  george_min_edge),
        george_max_daily_loss      = COALESCE($4,  george_max_daily_loss),
        george_min_sigma           = COALESCE($5,  george_min_sigma),
        george_max_sigma           = COALESCE($6,  george_max_sigma),
        george_cost_buffer         = COALESCE($7,  george_cost_buffer),
        george_entry_min_remaining = COALESCE($8,  george_entry_min_remaining),
        george_entry_max_remaining = COALESCE($9,  george_entry_max_remaining),
        george_cl_deviation_pct    = COALESCE($10, george_cl_deviation_pct),
        george_paper_balance       = COALESCE($11, george_paper_balance),
        updated_at = NOW()
      WHERE user_id = $1
    `, [
      req.userId,
      num(george_trade_size),
      num(george_min_edge),
      num(george_max_daily_loss),
      num(george_min_sigma),
      num(george_max_sigma),
      num(george_cost_buffer),
      intOrNull(george_entry_min_remaining),
      intOrNull(george_entry_max_remaining),
      num(george_cl_deviation_pct),
      num(george_paper_balance),
    ]);

    const {
      virtual_loss_enabled,
      virtual_loss_required,
    } = req.body;
    if (virtual_loss_enabled !== undefined || virtual_loss_required !== undefined) {
      if (virtual_loss_enabled === true) {
        await pool.query(
          `UPDATE bot_settings SET virtual_paper_balance = COALESCE(virtual_paper_balance, paper_balance) WHERE user_id = $1`,
          [req.userId]
        );
      }
      await pool.query(
        `UPDATE bot_settings SET
          virtual_loss_enabled = COALESCE($2, virtual_loss_enabled),
          virtual_loss_required = COALESCE($3, virtual_loss_required),
          updated_at = NOW()
         WHERE user_id = $1`,
        [
          req.userId,
          virtual_loss_enabled !== undefined ? !!virtual_loss_enabled : null,
          virtual_loss_required != null && virtual_loss_required !== ''
            ? Math.max(1, Math.min(10, parseInt(String(virtual_loss_required), 10) || 2))
            : null,
        ]
      );
      const bot = req.app.locals.botManager?.getBot(req.userId);
      if (bot?.virtualLoss) {
        const fresh = await pool.query('SELECT * FROM bot_settings WHERE user_id = $1', [req.userId]);
        if (fresh.rows[0]) {
          bot.virtualLoss.reload(fresh.rows[0]);
        }
      }
    }

    const bot = req.app.locals.botManager?.getBot(req.userId);
    if (bot) {
      const fresh = await pool.query('SELECT * FROM bot_settings WHERE user_id = $1', [req.userId]);
      if (fresh.rows[0]) {
        bot.settings = { ...bot.settings, ...fresh.rows[0] };
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Settings update error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/user/dashboard
router.get('/dashboard', async (req, res) => {
  try {
    const settingsResult = await pool.query(
      `SELECT polymarket_wallet_address, encrypted_private_key, signature_type, funder_address,
        paper_trading, paper_balance, virtual_paper_balance, virtual_loss_enabled, virtual_loss_required,
        virtual_loss_count, virtual_loss_armed, cached_polymarket_balance, cached_balance_at, pnl_reset_at
       FROM bot_settings WHERE user_id = $1`,
      [req.userId]
    );
    const walletAddress = settingsResult.rows[0]?.polymarket_wallet_address || null;
    // A viewer can inspect the public wallet balance without ever causing the
    // server to decrypt or use the operator's authenticated CLOB credentials.
    const encryptedPrivateKey = req.readOnly
      ? null
      : (settingsResult.rows[0]?.encrypted_private_key || null);
    const signatureType = settingsResult.rows[0]?.signature_type || 'EOA';
    const configuredFunder = settingsResult.rows[0]?.funder_address || null;
    const isPaperMode = settingsResult.rows[0]?.paper_trading !== false;
    const row0 = settingsResult.rows[0] || {};
    const paperBalance = parseFloat(row0.paper_balance) || 0;
    const virtualPaperBalance = parseFloat(row0.virtual_paper_balance);
    const vlEnabled = row0.virtual_loss_enabled === true;
    const cachedBalance = settingsResult.rows[0]?.cached_polymarket_balance;
    const cachedAt = settingsResult.rows[0]?.cached_balance_at;

    // Fetch on-chain USDC balance from Polygon (no L2 API credentials needed)
    let balance = null;
    if (walletAddress) {
      const proxyWallet = await getProxyWalletAddress(walletAddress);
      const walletsToCheck = [...new Set([walletAddress, proxyWallet].filter(Boolean))];
      let best = null;
      let bestWallet = walletAddress;
      for (const w of walletsToCheck) {
        const onchainUsdc = await getPolygonUsdcBalance(w);
        let clobUsdc = null;
        if (encryptedPrivateKey) {
          const privateKey = decrypt(encryptedPrivateKey);
          clobUsdc = await getClobUsdcBalance(privateKey, w, signatureType, configuredFunder || w);
        }
        const hasAnySource = onchainUsdc !== null || clobUsdc !== null;
        const candidate = hasAnySource ? Math.max(onchainUsdc ?? 0, clobUsdc ?? 0) : null;
        if (candidate !== null && (best === null || candidate > best)) {
          best = candidate;
          bestWallet = w;
        }
      }
      const usdc = best;
      if (usdc !== null) {
        balance = { usdc_balance: usdc, address: bestWallet };
      } else if (cachedBalance != null) {
        balance = { usdc_balance: parseFloat(cachedBalance), address: walletAddress };
      }
    }

    // ?since=<ISO> scopes the trade stats (dashboard "this session" toggle).
    // Balances stay cumulative — they are account values, not window stats.
    const since = req.query.since && !isNaN(Date.parse(req.query.since)) ? new Date(req.query.since) : null;
    // "Today's P&L" counts from the later of (now - 24h) and the operator's
    // last P&L reset (pnl_reset_at) — display-only; no historical rows touched.
    const pnlResetAt = row0.pnl_reset_at ? new Date(row0.pnl_reset_at).getTime() : 0;
    const dailySince = new Date(Math.max(Date.now() - 24 * 3600 * 1000, pnlResetAt));
    const stats = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'closed' AND result IN ('WIN','LOSS','CLOSED')) as total_trades,
        COUNT(*) FILTER (WHERE status = 'closed' AND (result = 'WIN' OR (result = 'CLOSED' AND pnl > 0))) as wins,
        COUNT(*) FILTER (WHERE status = 'closed' AND (result = 'LOSS' OR (result = 'CLOSED' AND pnl <= 0))) as losses,
        COALESCE(SUM(pnl) FILTER (WHERE status = 'closed' AND ABS(pnl) < 100000), 0) as total_pnl,
        COALESCE(SUM(trade_size) FILTER (WHERE status = 'closed' AND trade_size < 10000), 0) as total_invested,
        COALESCE(AVG(trade_size) FILTER (WHERE status = 'closed' AND trade_size < 10000), 0) as avg_trade_size,
        COALESCE(MAX(pnl) FILTER (WHERE status = 'closed' AND ABS(pnl) < 100000), 0) as best_trade,
        COALESCE(MIN(pnl) FILTER (WHERE status = 'closed' AND ABS(pnl) < 100000), 0) as worst_trade,
        COALESCE(SUM(pnl) FILTER (WHERE status = 'closed' AND created_at >= ${since ? '$3' : '$2'}::timestamptz AND ABS(pnl) < 100000), 0) as daily_pnl
      FROM trades WHERE user_id = $1 ${since ? 'AND created_at >= $2' : ''}
    `, since ? [req.userId, since, dailySince] : [req.userId, dailySince]);

    const s = stats.rows[0];
    const winRate = s.total_trades > 0 ? (s.wins / s.total_trades * 100).toFixed(1) : 0;
    const roi = s.total_invested > 0 ? (s.total_pnl / s.total_invested * 100).toFixed(2) : 0;

    // Strict-fill-era P&L (audit 2026-07-13): all-time P&L mixes pre-strict
    // (instant-fill, proven optimistic) and post-strict trades in one number.
    // STRICT_FILL_LIVE_AT is the deploy that activated strict_paper_fills for
    // real (RELAUNCH.md) — permanent split, reported alongside all-time so
    // neither number is presented alone as "the" headline.
    const STRICT_FILL_LIVE_AT = '2026-07-12T10:00:00Z';
    const strictStats = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'closed' AND result IN ('WIN','LOSS','CLOSED')) as trades,
        COUNT(*) FILTER (WHERE status = 'closed' AND (result = 'WIN' OR (result = 'CLOSED' AND pnl > 0))) as wins,
        COALESCE(SUM(pnl) FILTER (WHERE status = 'closed' AND ABS(pnl) < 100000), 0) as pnl
      FROM trades WHERE user_id = $1 AND created_at >= $2::timestamptz
    `, [req.userId, STRICT_FILL_LIVE_AT]);
    const ss = strictStats.rows[0];

    res.json({
      strict_era: {
        since: STRICT_FILL_LIVE_AT,
        trades: parseInt(ss.trades),
        wins: parseInt(ss.wins),
        win_rate: ss.trades > 0 ? +((ss.wins / ss.trades) * 100).toFixed(1) : 0,
        pnl: parseFloat(ss.pnl),
        pnl_per_trade: ss.trades > 0 ? +(parseFloat(ss.pnl) / ss.trades).toFixed(2) : 0,
      },
      polymarket_balance: balance?.usdc_balance ?? null, // null = unknown, 0 = confirmed zero
      paper_trading: isPaperMode,
      paper_balance: paperBalance,
      dry_paper_balance: paperBalance,
      virtual_paper_balance: Number.isFinite(virtualPaperBalance) ? virtualPaperBalance : paperBalance,
      virtual_loss_enabled: vlEnabled,
      virtual_loss_required: parseInt(row0.virtual_loss_required, 10) || 2,
      virtual_loss_count: parseInt(row0.virtual_loss_count, 10) || 0,
      virtual_loss_armed: row0.virtual_loss_armed === true,
      wallet_address: req.readOnly ? null : walletAddress,
      total_trades: parseInt(s.total_trades),
      wins: parseInt(s.wins),
      losses: parseInt(s.losses),
      win_rate: parseFloat(winRate),
      total_pnl: parseFloat(s.total_pnl),
      total_invested: parseFloat(s.total_invested),
      daily_pnl: parseFloat(s.daily_pnl),
      roi: parseFloat(roi)
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/user/stats
router.get('/stats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'closed' AND result IN ('WIN','LOSS','CLOSED')) as total_trades,
        COUNT(*) FILTER (WHERE status = 'closed' AND (result = 'WIN' OR (result = 'CLOSED' AND pnl > 0))) as wins,
        COUNT(*) FILTER (WHERE status = 'closed' AND (result = 'LOSS' OR (result = 'CLOSED' AND pnl <= 0))) as losses,
        COALESCE(SUM(pnl) FILTER (WHERE status = 'closed' AND ABS(pnl) < 100000), 0) as total_pnl,
        COALESCE(SUM(trade_size) FILTER (WHERE status = 'closed' AND trade_size < 10000), 0) as total_invested,
        COALESCE(AVG(trade_size) FILTER (WHERE status = 'closed' AND trade_size < 10000), 0) as avg_trade_size,
        COALESCE(MAX(pnl) FILTER (WHERE status = 'closed' AND ABS(pnl) < 100000), 0) as best_trade,
        COALESCE(MIN(pnl) FILTER (WHERE status = 'closed' AND ABS(pnl) < 100000), 0) as worst_trade,
        COALESCE(SUM(pnl) FILTER (WHERE status = 'closed' AND created_at >= NOW() - INTERVAL '24 hours' AND ABS(pnl) < 100000), 0) as daily_pnl
      FROM trades WHERE user_id = $1
    `, [req.userId]);

    const stats = result.rows[0];
    const winRate = stats.total_trades > 0
      ? (stats.wins / stats.total_trades * 100).toFixed(1) : 0;
    const roi = stats.total_invested > 0
      ? (stats.total_pnl / stats.total_invested * 100).toFixed(2) : 0;

    res.json({ ...stats, win_rate: parseFloat(winRate), roi: parseFloat(roi) });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/user/reset-paper-balance — Reset the paper research account to $500
router.post('/reset-paper-balance', async (req, res) => {
  try {
    await pool.query(
      'UPDATE bot_settings SET paper_balance = 500, virtual_paper_balance = 500, paper_balance_initialized = true WHERE user_id = $1',
      [req.userId]
    );

    // Also sync the live bot instance in memory — DB update alone doesn't affect
    // the running bot's this.paperBalance which was set at construction time
    const botManager = req.app.locals.botManager;
    if (botManager) {
      const bot = botManager.getBot(req.userId);
      if (bot) {
        bot.paperBalance = 500;
        bot.virtualPaperBalance = 500;
        console.log(`[User] Paper balance reset in-memory for bot ${req.userId}`);
      }
    }

    res.json({ success: true, message: 'Paper balance reset to $500' });
  } catch (err) {
    console.error('Reset paper balance error:', err);
    res.status(500).json({ error: 'Failed to reset paper balance' });
  }
});

// GET /api/user/polymarket-balance — on-chain USDC balance on Polygon (no L2 creds needed)
router.get('/polymarket-balance', async (req, res) => {
  try {
    const settingsResult = await pool.query(
      'SELECT polymarket_wallet_address, encrypted_private_key, signature_type, funder_address FROM bot_settings WHERE user_id = $1',
      [req.userId]
    );
    const walletAddress = settingsResult.rows[0]?.polymarket_wallet_address;
    const encryptedPrivateKey = req.readOnly
      ? null
      : (settingsResult.rows[0]?.encrypted_private_key || null);
    const signatureType = settingsResult.rows[0]?.signature_type || 'EOA';
    const configuredFunder = settingsResult.rows[0]?.funder_address || null;
    if (!walletAddress) {
      return res.json({ balance: null, error: 'No wallet address configured' });
    }

    const proxyWallet = await getProxyWalletAddress(walletAddress);
    const walletsToCheck = [...new Set([walletAddress, proxyWallet].filter(Boolean))];
    let bestBalance = null;
    let bestWallet = walletAddress;
    const diagnostics = [];
    for (const w of walletsToCheck) {
      const onchainBalance = await getPolygonUsdcBalance(w);
      let clobBalance = null;
      if (encryptedPrivateKey) {
        const privateKey = decrypt(encryptedPrivateKey);
        clobBalance = await getClobUsdcBalance(privateKey, w, signatureType, configuredFunder || w);
      }
      const hasAnySource = onchainBalance !== null || clobBalance !== null;
      const candidate = hasAnySource ? Math.max(onchainBalance ?? 0, clobBalance ?? 0) : null;
      diagnostics.push(`${w}:onchain=${onchainBalance},clob=${clobBalance},final=${candidate}`);
      if (candidate !== null && (bestBalance === null || candidate > bestBalance)) {
        bestBalance = candidate;
        bestWallet = w;
      }
    }
    const balance = bestBalance;
    console.log(
      `[BalanceDebug] user=${req.userId} configured=${walletAddress} proxy=${proxyWallet || 'none'} picked=${bestWallet} ${diagnostics.join(' | ')}`
    );
    if (balance === null) {
      return res.json({ balance: null, error: 'All balance sources failed (Polygon RPC + CLOB)' });
    }

    if (!req.readOnly) {
      await pool.query(
        'UPDATE bot_settings SET cached_polymarket_balance=$1, cached_balance_at=NOW() WHERE user_id=$2',
        [balance, req.userId]
      );
    }

    res.json({
      balance,
      address: req.readOnly ? null : bestWallet,
      configured_wallet: req.readOnly ? null : walletAddress,
      proxy_wallet: req.readOnly ? null : proxyWallet,
    });
  } catch (err) {
    console.error('Polymarket balance route error:', err.message);
    res.json({ balance: null, error: err.message });
  }
});

module.exports = router;
