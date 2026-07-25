const { pool } = require('../models/db');
const { EventEmitter } = require('events');
const GBMSignalEngine = require('./GBMSignalEngine');
const BinanceFeed = require('./BinanceFeed');
const ChainlinkFeed = require('./ChainlinkFeed');
const PolymarketFeed = require('./PolymarketFeed');
const PolymarketPriceFeed = require('./PolymarketPriceFeed');
const EVEngine = require('./EVEngine');
const { decrypt } = require('../services/encryption');
const { runAutoRedeemPass } = require('../services/autoRedeem');
const VirtualLossManager = require('./VirtualLossManager');
const SlippageEngine = require('./SlippageEngine');
const MainModelChallenger = require('./MainModelChallenger');
const { buildPortfolioPolicy, canOpenPortfolioPosition, riskWindowFloor } = require('./PortfolioRiskPolicy');
const {
  calculateCryptoTakerFeeUsd,
  calculateExecutionAdjustedEV,
  calculateSlippageTicks,
  DEFAULT_MIN_MARKET_ENTRY,
  getRawOutcomePrice,
  isEntryPriceAllowed,
  shouldTriggerTrailingStop,
  withDipOutcomePrice,
} = require('./tradeExecutionRules');
const axios = require('axios');

/** Gamma/API may return market id as number or string — normalize so Map keys and === checks dedupe correctly. */
function normMarketId(id) {
  if (id == null || id === '') return null;
  return String(id);
}

/** Postgres DECIMAL / API values often arrive as string — never trust raw parseFloat. */
function parseMoneyField(v) {
  if (v == null || v === '') return NaN;
  const n = parseFloat(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : NaN;
}

/** Hard stop (early branch only; caller requires marketEndSec > 30): wider threshold when more time left. */
function _hardStopEarlyThresholdPct(marketEndSec) {
  if (marketEndSec > 180) return -42;
  if (marketEndSec > 120) return -38;
  if (marketEndSec > 60) return -35;
  return -32; // (30, 60]
}

class BotInstance extends EventEmitter {
  constructor(userId, settings) {
    super();
    this.userId = userId;
    this.settings = settings;
    // Use email prefix as label (e.g. "mereeffet" from "mereeffet@gmail.com")
    this.userLabel = settings.email ? settings.email.split('@')[0] : `user${userId}`;
    this.isRunning = false;
    this.loopInterval = null;
    this._loopRunning = false; // re-entrance guard: prevents overlapping tick executions

    // Data feeds — this.binance is BTC (back-compat); this.feeds holds one
    // BinanceFeed per enabled_main asset from asset_config (multi-asset 2026-07-12)
    this.binance = new BinanceFeed();
    this.feeds = { btc: this.binance };
    this.chainlink = new ChainlinkFeed();
    this.polymarket = null;
    this.priceFeed = new PolymarketPriceFeed(); // real-time WS price feed
    this.signalEngine = null;
    this.evEngine = new EVEngine();

    // Paper trading — paper_balance = dry (real trades only); virtual_paper_balance includes virtual path
    const dryBal = parseFloat(settings.paper_balance) || 500;
    this.paperBalance = dryBal;
    const vpRaw = parseFloat(settings.virtual_paper_balance);
    this.virtualPaperBalance = Number.isFinite(vpRaw) ? vpRaw : dryBal;

    this.virtualLoss = new VirtualLossManager(settings);
    this.virtualLoss.setPersistCallback(() => this._persistVirtualLossState());

    // Risk management
    // Shared $500 candidate envelope. This is a capital-preservation policy,
    // not an alpha parameter, and never changes paper/live mode.
    this.portfolioPolicy = settings.candidate_portfolio_enabled === true
      && settings.paper_trading !== false
      ? buildPortfolioPolicy(settings.portfolio_bankroll_usdc || 500)
      : null;
    this.peakBalance = this.settings.paper_trading ? this.paperBalance : null;
    this.drawdownCooldownUntil = null;
    this.paperRiskLimitsEnabled = settings.paper_risk_limits_enabled === true;

    // Flip tracking (EV-driven, not cooldown-driven)
    this.recentFlips = []; // timestamps of recent flips
    this.flipEVEscalation = 0; // increases required EV differential after rapid flips

    // Slippage tracking
    this.slippageHistory = []; // { expected, actual, difference, timestamp }

    // Pending orders — placed but not yet confirmed filled or cancelled
    // Map<orderId, { orderId, isPaper, tokenId, side, limitPrice, referencePrice,
    //                dollarSize, direction, market, signal, placedAt, lastCheckedPrice }>
    this._pendingOrders = new Map();

    // Logs
    this.decisionLog = [];
    this.maxLogEntries = 100;

    // Real-time streaming (SSE) — emits 'state' events every 200ms while running
    this.streamEmitter = new EventEmitter();
    this.streamEmitter.setMaxListeners(50); // allow many concurrent SSE clients
    this.streamInterval   = null;
    this._obFetchInterval = null; // 1s async loop that fetches YES/NO order books
    this._skipEvalInterval = null; // 2min loop that evaluates resolved skipped_signals
    this._lastOrderBooks = {}; // tokenId -> { midPrice, spread, bidDepth, askDepth }
    // Last computed microstructure + EV data for broadcasting
    this._lastStreamState = {};

    // Suppress repeated balance-error retries — set to future timestamp when balance is insufficient
    this._balanceErrorUntil = null;
    // Suppress repeated geo-block errors — set to future timestamp on 403 geo-block
    this._geoBlockErrorUntil = null;
    this._lastTradeAttemptAt = null; // timestamp of last trade attempt — 90s cooldown guard
    // Atomic execution lock — Set of marketIds currently inside _executeTrade async body.
    // Prevents a second tick from entering _executeTrade for the same market while the
    // first is still awaiting placeOrder (relay round-trip). Cleared on exit.
    this._executingMarkets = new Set();
    // Cooldown map to prevent duplicate entries on the same market for 10s
    this._marketCooldowns = new Map();
    // Price dip tracker — waits for a local minimum before entering
    // Map<marketId, { signal, minPrice, minPriceTick, watchSince, lastPrice }>
    this._dipWatcher = new Map();
    // Profit peak tracker — persists across ticks (DB rows are re-fetched each tick)
    // Map<tradeId, peakPnlPct>
    this._profitPeaks = new Map();
    // Prevent duplicate live exit orders for the same trade while an async close is in-flight.
    this._closingTrades = new Set();

    // Pending exit orders for Live mode (non-EV_FLIP exits) — async cascade retry across ticks.
    // Map<tradeId, { orderId, trade, targetPrice, reason, attempts, tierStartedAt, currentOrderPrice, isNuclear }>
    // Populated by _closePosition; consumed and cleared by _monitorPendingExits.
    this._pendingExits = new Map();

    // Policy: one entry cycle per market_id per window (in-memory; pruned when market drops from cache).
    this._completedMarketCycleIds = new Set();
    // Policy: at most one successful EV flip per market_id per window (paired with flip exit).
    this._flipCountByMarketId = new Map();

    this._autoRedeemInterval = null;
    this._autoRedeemRunning = false;
  }

  async _runAutoRedeem() {
    if (this.settings.paper_trading !== false) return;
    if (this.settings.auto_redeem_enabled === false) return;
    if (this._autoRedeemRunning) return;
    this._autoRedeemRunning = true;
    try {
      let pk = null;
      if (this.settings.encrypted_private_key) {
        try { pk = decrypt(this.settings.encrypted_private_key); } catch (_) {}
      }
      if (!pk) return;

      const log = (level, msg) => this._log(level, msg);
      const result = await runAutoRedeemPass({ userId: this.userId, privateKey: pk, log });
      if (result.redeemed > 0) {
        this._log('INFO', `[AutoRedeem] pass complete — redeemed ${result.redeemed} market(s)`);
      }
    } catch (e) {
      this._log('WARN', `[AutoRedeem] ${e.message}`);
    } finally {
      this._autoRedeemRunning = false;
    }
  }

  async start() {
    if (this.isRunning) {
      this._log('WARN', 'Bot already running');
      return;
    }

    try {
      this._log('INFO', `Starting bot for user ${this.userId}...`);

      // Initialize Polymarket feed
      let privateKey = null;
      if (this.settings.encrypted_private_key) {
        privateKey = decrypt(this.settings.encrypted_private_key);
      }
      this.polymarket = new PolymarketFeed(
        privateKey,
        this.settings.polymarket_wallet_address,
        this.settings.geo_block_token || null,
        this.settings.clob_proxy_url || null,
        this.settings.builder_code || null,
        this.settings.signature_type || 'EOA',
        this.settings.funder_address || this.settings.polymarket_wallet_address || null
      );
      await this.polymarket.initialize();

      // Connect data feeds
      // Multi-asset: build per-asset feeds from asset_config (enabled_main).
      // Failure to load the registry degrades to BTC-only, never blocks boot.
      let assetRows = [];
      try {
        const { pool } = require('../models/db');
        assetRows = (await pool.query(
          "SELECT * FROM asset_config WHERE enabled_main = true AND price_source = 'binance' AND binance_symbol IS NOT NULL ORDER BY asset"
        )).rows;
      } catch (e) {
        console.warn(`[Bot] asset_config unavailable (${e.message}) — BTC-only`);
      }
      for (const a of assetRows) {
        if (a.asset === 'btc' || this.feeds[a.asset]) continue;
        this.feeds[a.asset] = new BinanceFeed(a.binance_symbol);
      }
      await Promise.all(Object.values(this.feeds).map((f) => f.connect()));
      console.log(`[Bot] price feeds connected: ${Object.keys(this.feeds).join(', ')}`);
      await this.chainlink.start(30000);

      // Connect real-time Polymarket price feed (non-blocking — bot still works if WS fails)
      this.priceFeed.connect().catch(err => {
        this._log('WARN', `PolymarketPriceFeed connect failed: ${err.message} — falling back to HTTP`);
      });

      // Wait for initial price
      await this._waitForPrice(15000);

      // Initialize signal engine with WS price feed
      this.signalEngine = new GBMSignalEngine(
        this.polymarket,
        this.binance,
        this.chainlink,
        this.settings,
        this.priceFeed
      );
      this.signalEngine.setFeeds(this.feeds);
      if (this.polymarket?.setAssets) this.polymarket.setAssets(Object.keys(this.feeds));

      this.isRunning = true;

      this.virtualLoss.reload(this.settings);
      const vpStart = parseFloat(this.settings.virtual_paper_balance);
      if (Number.isFinite(vpStart)) this.virtualPaperBalance = vpStart;

      // Start a new trading session — closes lingering open trades, records initial balance
      await this._startSession();

      // Main loop — NOT high-frequency, appropriate for prediction market strategy
      const intervalMs = (this.settings.snipe_timer_seconds || 8) * 1000;
      this.loopInterval = setInterval(() => this._mainLoop(), intervalMs);

      // Heartbeat on its OWN timer, independent of the tick body (2026-07-13:
      // a heartbeat written inside _mainLoop goes silent for as long as any
      // single tick hangs on a slow network call — the re-entrance guard then
      // blocks every subsequent tick from even attempting a write, so a 10s
      // RPC/API stall reads as "main_bot down" for the whole stall. This
      // timer reports process liveness; it also carries lastTickAt so a
      // genuinely wedged tick loop is still visible in the heartbeat meta,
      // just without false-redding the health banner over routine network noise.
      this._lastTickAt = Date.now();
      this.heartbeatInterval = setInterval(() => {
        pool.query(
          `INSERT INTO system_heartbeats (component, beat_at, meta) VALUES ('main_bot', now(), $1)
           ON CONFLICT (component) DO UPDATE SET beat_at = now(), meta = $1`,
          [JSON.stringify({ pid: process.pid, userId: this.userId,
            runtimeInstanceId: process.env.DELTAFORGE_INSTANCE_ID || null,
            lastTickAgeSec: Math.round((Date.now() - this._lastTickAt) / 1000) })]
        ).catch(() => {});
      }, 10000);

      // Real-time streaming loop — 200ms interval, non-blocking, for SSE clients
      this.streamInterval   = setInterval(() => this._broadcastState(), 200);
      // Order book fetcher — 1s async loop, populates YES/NO prices for stream
      this._obFetchInterval = setInterval(() => this._fetchActiveOrderBooks(), 1000);
      // Skip evaluator — every 2 min, resolve any pending skipped_signals
      this._skipEvalInterval = setInterval(() => this._evaluateSkippedSignals(), 120000);

      // Stop/lock counterfactual evaluator — every 2 min (audit 2026-07-13):
      // pure measurement, never touches trading decisions.
      this._stopCounterfactualInterval = setInterval(() => this._evaluateStopCounterfactuals(), 120000);

      // On-chain redeem for resolved markets (LIVE only — spends MATIC gas)
      if (!this.settings.paper_trading && this.settings.auto_redeem_enabled !== false && privateKey) {
        const sec = Math.max(120, parseInt(this.settings.auto_redeem_interval_sec, 10) || 600);
        this._autoRedeemInterval = setInterval(() => {
          this._runAutoRedeem().catch(() => {});
        }, sec * 1000);
        setTimeout(() => this._runAutoRedeem().catch(() => {}), 15000);
        this._log('INFO', `Auto-redeem: every ${sec}s (Polygon)`);
      }

      this._log('INFO', `✅ Bot started. Interval: ${intervalMs / 1000}s, Paper: ${this.settings.paper_trading}`);

      await pool.query('UPDATE bot_settings SET is_active = true WHERE user_id = $1', [this.userId]);

    } catch (err) {
      this._log('ERROR', `Failed to start bot: ${err.message}`);
      await this.stop();
      throw err;
    }
  }

  async stop(preserveActive = false) {
    this._log('INFO', 'Stopping bot...');
    this.isRunning = false;

    // Save session summary before teardown
    await this._endSession();

    if (this.loopInterval) {
      clearInterval(this.loopInterval);
      this.loopInterval = null;
    }
    clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = null;
    clearInterval(this._stopCounterfactualInterval);
    this._stopCounterfactualInterval = null;
    if (this.streamInterval) {
      clearInterval(this.streamInterval);
      this.streamInterval = null;
    }
    if (this._obFetchInterval) {
      clearInterval(this._obFetchInterval);
      this._obFetchInterval = null;
    }
    if (this._skipEvalInterval) {
      clearInterval(this._skipEvalInterval);
      this._skipEvalInterval = null;
    }
    if (this._autoRedeemInterval) {
      clearInterval(this._autoRedeemInterval);
      this._autoRedeemInterval = null;
    }

    if (this.binance) this.binance.disconnect();
    if (this.chainlink) this.chainlink.stop();
    if (this.priceFeed) this.priceFeed.disconnect();

    // preserveActive=true on graceful shutdown so auto-restart works after deploy
    if (!preserveActive) {
      try {
        await pool.query('UPDATE bot_settings SET is_active = false WHERE user_id = $1', [this.userId]);
      } catch (err) {
        console.error(`[${this.userLabel}] DB update failed on stop:`, err.message);
      }
    }

    this._log('INFO', '🛑 Bot stopped');
  }

  async _mainLoop() {
    if (!this.isRunning) return;
    // Re-entrance guard: if previous tick is still executing (e.g. slow API calls),
    // skip this tick rather than running two evaluate() pipelines in parallel.
    // This prevents duplicate signals, double-fills, and split-brain pricing.
    if (this._loopRunning) return;
    this._loopRunning = true;
    this._lastTickAt = Date.now();

    try {
      // --- Risk checks ---
      // Drawdown + daily loss cooldowns evaluated after open position management


      // Pending orders FIRST — even if evaluate() is slow or returns stale, paper/live fills must advance.
      // (Previously, a stale early-return skipped monitoring and could strand duplicate resting orders.)
      await this._monitorPendingOrders();

      // Advance any in-flight Live exit orders (reprice/nuclear cascade, fill detection).
      // Runs before signal evaluation so a newly-filled exit is visible to position management.
      if (!this.settings.paper_trading) await this._monitorPendingExits();

      // --- Evaluate signal — establishes the single authoritative price for this tick ---
      // Cycle-locked markets (position already closed this window) are excluded inside
      // the engine: no re-entry is possible, so signals for them are pure noise.
      const signal = await this.signalEngine.evaluate(this._completedMarketCycleIds);
      await this._logSignal(signal);

      // Staleness guard: if evaluate() threw (caught internally) and returned a stale
      // signal, or if the timestamp is too old, skip position management this tick.
      // Without this, a slow evaluate() could pass a 30s-old price to stop-loss logic.
      const SIGNAL_MAX_AGE_MS = 10000;
      if (!signal?.timestamp || Date.now() - signal.timestamp > SIGNAL_MAX_AGE_MS) {
        this._log('WARN', `[_mainLoop] Signal stale (age=${signal?.timestamp ? Date.now() - signal.timestamp : 'no ts'}ms) — skipping position management`);
        return;
      }

      // Housekeeping — purge expired tried-markets and old flip records
      this._cleanOldFlips();
      this._pruneMarketPolicyState();

      // --- Manage open positions (EV-based exits + flips) — uses signal.yesPrice ---
      await this._manageOpenPositions(signal);

      // Only proceed to execution on a real TRADE signal
      if (signal.verdict !== 'TRADE') return;

      // Hard confidence gate enforcement right before trade execution.
      // Null-safe parse: a stored 0 is a real threshold, only NULL/absent falls back.
      const minConfRaw = parseFloat(this.settings.min_confidence);
      const minConf = Number.isFinite(minConfRaw) ? minConfRaw : 0.42;
      const sigConf = Number.isFinite(signal.confidence) ? signal.confidence : 0;
      if (sigConf < minConf) {
        this._log('WARN', `⛔ [SKIP:min_confidence] confidence=${sigConf.toFixed(3)} < min_confidence=${minConf} — trade blocked pre-execution (market=${String(signal.marketId).slice(0, 12)}, dir=${signal.direction}, evAdj=${Number(signal.evAdj ?? 0).toFixed(2)}%)`);
        return;
      }

      // MAIN V2 migration: the legacy model remains a telemetry/control arm,
      // but no longer creates PAPER positions by default. This is deliberately
      // paper-only: live behavior and every live order call site are unchanged.
      // Lock the market after its first qualifying legacy signal so the control
      // produces one independent observation instead of repeated 8s spam.
      if (this._shouldSuppressLegacyPaperExecution()) {
        const legacyMarketId = normMarketId(signal.marketId ?? signal.market?.id ?? signal.market?.condition_id);
        if (legacyMarketId) this._completedMarketCycleIds.add(legacyMarketId);
        this._log('INFO', `🧪 [MAIN LEGACY CONTROL] Would trade ${signal.direction} ` +
          `market=${String(legacyMarketId || 'unknown').slice(0, 12)} ` +
          `EV=${Number(signal.evAdj ?? 0).toFixed(2)}% confidence=${sigConf.toFixed(3)} — ` +
          'paper execution retired; MAIN V2 resolver-quorum evidence runs in BORG');
        return;
      }

      const unboundedPaperResearch = this._isUnboundedPaperResearch();

      // Capital-preservation controls are useful for live deployment rehearsal,
      // but must not censor the signal sample in an unlimited paper experiment.
      // Same-market duplicate/order locks still run inside _executeTrade().
      if (!unboundedPaperResearch) {
        const overexposed = await this._checkDirectionalExposure(signal.direction);
        if (overexposed) return;
      }

      const canTrade = await this._checkDrawdownCircuitBreaker();
      if (!canTrade) return;

      const dailyLimitHit = await this._checkDailyLossLimit();
      if (dailyLimitHit) return;

      // EV_FLIP: only allowed when existing position is losing (pnlPct < 0).
      // Profitable positions hold to resolution — flipping a winner burns fees needlessly.
      const flipped = await this._checkForFlip(signal);
      if (flipped) return;

      // Hard cooldown: guard against relay latency causing duplicate orders.
      // PER-MARKET since 2026-07-13 (flag per_market_cooldown, default ON):
      // the global form was a single-asset-era relic — one BTC attempt blocked
      // ETH/SOL/etc for 90s, discarding 89% of qualifying signal flow (1,560
      // of 1,750 TRADE signals unexecuted, carrying the SAME edge as the
      // executed subset: 62.5% vs 64.2% sim win rate). Duplicates are a
      // per-market phenomenon; the guard now scopes to the market. All other
      // risk rails unchanged (directional exposure cap, daily loss limit,
      // one-open-per-market unique index, one entry per tick).
      if (!unboundedPaperResearch) {
        const perMarketCooldown = this.settings.per_market_cooldown !== false;
        if (!this._tradeAttemptAtByMarket) this._tradeAttemptAtByMarket = new Map();
        const cooldownKey = String(signal.marketId ?? '');
        const lastAttempt = perMarketCooldown
          ? this._tradeAttemptAtByMarket.get(cooldownKey)
          : this._lastTradeAttemptAt;
        if (lastAttempt && Date.now() - lastAttempt < 90000) {
          const secsLeft = Math.ceil((90000 - (Date.now() - lastAttempt)) / 1000);
          this._log('INFO', `⏸ Trade cooldown${perMarketCooldown ? ` [${cooldownKey.slice(0, 10)}]` : ''}: ${secsLeft}s remaining — waiting before next entry`);
          return;
        }

        // Deployment-risk envelope: one total open/pending position. Unlimited
        // paper research instead relies on the per-market atomic/DB locks below.
        if (this._pendingOrders.size > 0) {
          this._log('INFO', `⏸ Already have ${this._pendingOrders.size} pending order(s) — waiting for fill before new entry`);
          return;
        }
        const openCount = await pool.query(
          "SELECT COUNT(*) FROM trades WHERE user_id=$1 AND status IN ('open','pending')",
          [this.userId]
        );
        const numOpen = parseInt(openCount.rows[0].count);
        if (numOpen > 0) {
          this._log('INFO', `⏸ Already have ${numOpen} open/pending position(s) — waiting for exit before new entry`);
          return;
        }
      }

      // --- Open new position immediately ---
      // Live: cooldown is set right before placeOrder (relay latency). Not here — skips would still burn 90s.
      if (signal.confidence === 1.0) {
        this.emit('high_conviction_trade', signal);
      }
      await this._executeTrade(signal);

    } catch (err) {
      this._log('ERROR', `Main loop error: ${err.message}`);
    } finally {
      this._loopRunning = false;
    }
  }

  // ==========================================
  // EV-DRIVEN FLIP LOGIC
  // ==========================================

  async _checkForFlip(newSignal) {
    try {
      // Find open position in the same market
      const result = await pool.query(
        "SELECT * FROM trades WHERE user_id = $1 AND status = $2 AND market_id = $3",
        [this.userId, 'open', newSignal.marketId]
      );

      if (result.rows.length === 0) return false; // No existing position

      const existingTrade = result.rows[0];
      const currentDirection = existingTrade.direction;

      // Async EV_FLIP exit already queued — wait for fill before opening opposite leg
      if (this._pendingExits.has(existingTrade.id)) {
        const pe = this._pendingExits.get(existingTrade.id);
        if (pe?.deferredFlip) {
          this._log('INFO', `⏳ EV_FLIP exit in flight for #${existingTrade.id} — waiting for fill before opposite leg`);
          return true;
        }
      }

      const flipMarketKey = normMarketId(newSignal.marketId);
      if (flipMarketKey && (this._flipCountByMarketId.get(flipMarketKey) || 0) >= 1) {
        this._log('INFO', `⛔ Flip limit: max 1 EV flip per market (already used for ${flipMarketKey.slice(0, 12)})`);
        return false;
      }

      // If signal says same direction, no flip needed
      if (newSignal.direction === currentDirection) return false;

      // Minimum hold time — don't flip a position < 2 minutes old.
      // BTC oscillates ±0.03% naturally every 30s; without this, flips fire on noise.
      const holdTimeMin = (Date.now() - new Date(existingTrade.created_at).getTime()) / 60000;
      if (holdTimeMin < 2.0) {
        // Rate-limit this log to once per minute per trade — it fires every tick otherwise
        const suppressKey = `flipSuppress_${existingTrade.id}`;
        const lastLog = this._flipSuppressLogAt?.[suppressKey] || 0;
        if (Date.now() - lastLog > 60000) {
          this._log('INFO', `⏳ Flip suppressed — position ${holdTimeMin.toFixed(1)}min old (min 2min to reduce noise flips)`);
          if (!this._flipSuppressLogAt) this._flipSuppressLogAt = {};
          this._flipSuppressLogAt[suppressKey] = Date.now();
        }
        return false;
      }

      // Only flip when the existing position is currently losing.
      // A winning position should hold to resolution — flipping burns fees unnecessarily.
      const cachedForFlip = this.signalEngine?._priceCache?.get(existingTrade.market_id);
      if (cachedForFlip?.smoothedPrice != null) {
        const cachedYes = cachedForFlip.smoothedPrice;
        const currentTokenPrice = existingTrade.direction === 'NO' ? 1 - cachedYes : cachedYes;
        const entryP = parseFloat(existingTrade.entry_price);
        const pnlPct = entryP > 0 ? (currentTokenPrice - entryP) / entryP * 100 : 0;
        if (pnlPct >= 0) {
          this._log('INFO', `⏳ Flip skipped — position is profitable (PnL=${pnlPct.toFixed(1)}%), holding to resolution`);
          return false;
        }
        this._log('INFO', `🔻 Position losing (PnL=${pnlPct.toFixed(1)}%) — evaluating flip`);
      }

      // EV-driven flip evaluation with hysteresis (prevents whipsaw)
      const flipThreshold = this._getFlipThreshold();
      const currentEV = currentDirection === 'YES' ? newSignal.evYes : newSignal.evNo;
      const oppositeEV = newSignal.evAdj;

      // Hysteresis: require 6% EV gain (up from 3%) — round-trip cost is ~1.4% so need real edge
      // BTC 30s oscillation creates 3-4% EV swings; 6% threshold filters out noise flips
      const FLIP_HYSTERESIS = 6.0;
      const evGain = oppositeEV - currentEV;

      this._log('INFO', `🔄 Flip evaluation: ${currentDirection} EV=${currentEV.toFixed(2)}%, ${newSignal.direction} EV=${oppositeEV.toFixed(2)}%, gain=${evGain.toFixed(2)}%, threshold=${flipThreshold.toFixed(2)}%`);

      // BTC confirmation: only flip if BTC momentum supports the new direction
      // emaEdge = btcDelta (30s window); prevents flipping against momentum
      const btcDelta = newSignal.emaEdge || 0;
      const btcSupportsFip = newSignal.direction === 'YES' ? btcDelta > 0 : btcDelta < 0;
      if (!btcSupportsFip) {
        this._log('INFO', `⛔ Flip rejected — BTC direction (${btcDelta.toFixed(3)}%) contradicts ${newSignal.direction}`);
        return false;
      }

      // Flip condition: opposite side has significantly better EV AND positive edge.
      // oppositeEV must be > 0 — flipping into a zero/negative-EV trade just burns fees.
      if (evGain > flipThreshold && evGain > FLIP_HYSTERESIS && oppositeEV > 0) {
        this._log('INFO', `✅ EV-driven flip: ${currentDirection} → ${newSignal.direction} (EV gain: +${evGain.toFixed(2)}%)`);

        // Close at the old trade's market price — NOT the new signal's market price.
        // newSignal is for the new market; existingTrade.market_id may differ.
        // Use _priceCache for the old market, fall back to new signal price only if same market.
        let flipLivePriceYes = null;
        if (newSignal.marketId === existingTrade.market_id && newSignal.rawPrice != null) {
          flipLivePriceYes = newSignal.rawPrice; // use raw (unsmoothed) for accurate close price
        } else {
          const cached = this.signalEngine?._priceCache?.get(existingTrade.market_id);
          flipLivePriceYes = cached?.rawPrice ?? cached?.smoothedPrice ?? null;
        }
        const flipTokenPrice = existingTrade.direction === 'NO'
          ? (flipLivePriceYes != null ? 1 - flipLivePriceYes : null)
          : flipLivePriceYes;
        const livePrice = flipTokenPrice ?? parseFloat(existingTrade.entry_price);
        // Hold-only: record the would-be flip exit and keep the position.
        // Return true = "flip handled" so no opposite leg opens this tick.
        if (await this._holdOnlyIntercept(existingTrade, 'EV_FLIP', livePrice)) return true;
        const flipExitResult = await this._closePosition(existingTrade, livePrice, 'EV_FLIP', {
          newSignal,
          flipMarketKey,
        });

        // false = blocking + async queue both failed — retry on a later tick; do not open opposite
        if (flipExitResult === false) {
          this._log('WARN', `⛔ EV_FLIP: выход не выполнен (blocking + очередь) — повторим на следующем тике`);
          return false;
        }

        // 'deferred' = async exit queued; opposite opens from _monitorPendingExits after fill
        if (flipExitResult === 'deferred') {
          this._log('INFO', `📋 EV_FLIP: выход в очереди CLOB — противоположная нога откроется после филла`);
          return true;
        }

        // Record flip (sync path completed)
        this.recentFlips.push(Date.now());
        this._cleanOldFlips();

        // Open opposite position — mark as flip so the one-per-market guard doesn't block it
        const flipLegQueued = await this._executeTrade(newSignal, { isFlip: true });
        if (flipLegQueued && flipMarketKey) {
          this._flipCountByMarketId.set(flipMarketKey, (this._flipCountByMarketId.get(flipMarketKey) || 0) + 1);
        }
        return true;
      }

      return false;

    } catch (err) {
      this._log('ERROR', `Flip check error: ${err.message}`);
      return false;
    }
  }

  /**
   * Unlimited paper research uses the frozen $500 sizing notional but never
   * stops because an imaginary ledger, exposure cap or concurrency budget was
   * exhausted. Live mode can never enter this branch.
   */
  _isUnboundedPaperResearch() {
    return this.settings.paper_trading !== false && !this.paperRiskLimitsEnabled;
  }

  /**
   * Retire only the legacy MAIN paper executor. Live mode deliberately never
   * enters this branch, irrespective of the telemetry-control setting.
   */
  _shouldSuppressLegacyPaperExecution() {
    return this.settings.paper_trading !== false &&
      this.settings.main_legacy_execution_enabled !== true;
  }

  /**
   * Directional exposure: prevent over-concentration in one direction
   * Max net directional position = 30% of balance
   */
  async _checkDirectionalExposure(newDirection) {
    if (this._isUnboundedPaperResearch()) return false;
    try {
      const result = await pool.query(
        "SELECT direction, SUM(trade_size) as total FROM trades WHERE user_id=$1 AND status='open' GROUP BY direction",
        [this.userId]
      );
      const balance = this.settings.paper_trading ? this.paperBalance : await this._getLiveBalance();
      const maxNet = balance * 0.30;

      let yesExposure = 0, noExposure = 0;
      for (const row of result.rows) {
        if (row.direction === 'YES') yesExposure = parseFloat(row.total);
        else noExposure = parseFloat(row.total);
      }

      const netExposure = Math.abs(yesExposure - noExposure);
      const dominantDir = yesExposure >= noExposure ? 'YES' : 'NO';

      if (netExposure >= maxNet && newDirection === dominantDir) {
        this._log('WARN', `Directional exposure limit: net ${dominantDir} $${netExposure.toFixed(2)} >= $${maxNet.toFixed(2)} — skipping`);
        return true; // overexposed
      }
      return false;
    } catch (err) {
      return false; // don't block on error
    }
  }

  /**
   * Dynamic flip threshold — increases if flipping too rapidly
   * This is secondary to EV logic, not the primary guard
   */
  _getFlipThreshold() {
    this._cleanOldFlips();
    const recentFlipCount = this.recentFlips.length;

    // Base threshold from settings (default 5% — BTC oscillation creates 3-4% noise swings)
    // Escalation: +1% per recent flip (last 10 minutes) to suppress whipsaw
    const baseThreshold = parseFloat(this.settings.flip_threshold) || 5.0;
    const escalation = recentFlipCount * 1.0;

    return baseThreshold + escalation;
  }

  _cleanOldFlips() {
    const tenMinutesAgo = Date.now() - (10 * 60 * 1000);
    this.recentFlips = this.recentFlips.filter(t => t > tenMinutesAgo);
  }

  /**
   * Drop one-cycle / flip-limit state for markets no longer in discovery cache
   * (avoids unbounded growth; do not prune when cache is empty — transient).
   */
  _pruneMarketPolicyState() {
    const cache = this.polymarket?.marketsCache;
    if (!Array.isArray(cache) || cache.length === 0) return;
    const active = new Set(
      cache.map(x => normMarketId(x.id ?? x.condition_id)).filter(Boolean)
    );
    for (const mid of [...this._completedMarketCycleIds]) {
      if (!active.has(mid)) this._completedMarketCycleIds.delete(mid);
    }
    for (const mid of [...this._flipCountByMarketId.keys()]) {
      if (!active.has(mid)) this._flipCountByMarketId.delete(mid);
    }
  }

  /**
   * After a position fully closes: block fresh entries in this market for the rest of the window.
   * Skip when closing is the EV_FLIP exit leg (opposite opens same tick) or duplicate dedup / data errors.
   */
  _policyOnMarketClosed(trade, closeReason) {
    const mid = normMarketId(trade?.market_id);
    if (!mid) return;
    const r = String(closeReason || '');
    if (r === 'EV_FLIP') return;
    if (r.includes('DUPLICATE')) return;
    if (r.includes('DATA_ERROR')) return;
    this._completedMarketCycleIds.add(mid);
    this._log('INFO', `[Policy] One-cycle lock: market ${mid.slice(0, 12)} (reason=${closeReason})`);
  }

  // ==========================================
  // TRADE EXECUTION — ORDER LIFECYCLE
  //
  // Flow: signal → _executeTrade → (paper) immediate fill at market price OR (live) FAK market buy
  //               → _recordFilledTrade → trades DB
  //
  // Entries use the current best ask (or Gamma synthetic ask), not resting GTC limits.
  // Skips when the buyable token is priced strictly below $0.40.
  // ==========================================

  // ─────────────────────────────────────────────────────────────────────
  // DIP WATCHER — waits up to N ticks for a local price minimum before entry
  // For boundary-book (Gamma) markets: price ticks ±1-2% each interval.
  // We watch for the price to start rising after dipping — enter at the dip.
  // Timeout: enter anyway after DIP_WATCH_TICKS ticks to avoid missing the market.
  // ─────────────────────────────────────────────────────────────────────
  async _dipWatchAndExecute(signal) {
    const DIP_WATCH_TICKS = 4;   // max ticks to watch before forcing entry
    const marketId = signal.marketId;
    const currentPrice = signal.direction === 'NO'
      ? (1 - (signal.rawPrice ?? signal.yesPrice))
      : (signal.rawPrice ?? signal.yesPrice);

    const existing = this._dipWatcher.get(marketId);

    if (!existing) {
      // First tick seeing this signal — start watching
      this._dipWatcher.set(marketId, {
        signal,
        minPrice: currentPrice,
        minPriceTick: 0,
        watchSince: Date.now(),
        tickCount: 1,
        lastPrice: currentPrice,
      });
      this._log('INFO', `👀 Dip-watch started: ${signal.direction} price=${currentPrice.toFixed(3)} market=${marketId?.slice(0,12)}`);
      return; // don't enter yet
    }

    // Update watcher
    existing.tickCount += 1;
    const prevLast = existing.lastPrice;
    existing.lastPrice = currentPrice;

    if (currentPrice < existing.minPrice) {
      existing.minPrice = currentPrice;
      existing.minPriceTick = existing.tickCount;
      this._log('INFO', `👀 Dip-watch: new low=${currentPrice.toFixed(3)} (tick ${existing.tickCount})`);
    }

    // Entry trigger: price rising after a dip (local minimum confirmed)
    const priceRising = currentPrice > prevLast;
    const baselinePrice = existing.signal.direction === 'NO'
      ? (1 - (existing.signal.rawPrice ?? existing.signal.yesPrice))
      : (existing.signal.rawPrice ?? existing.signal.yesPrice);
    const hadDip = existing.minPrice < baselinePrice;
    const timedOut = existing.tickCount >= DIP_WATCH_TICKS;

    if (priceRising && hadDip) {
      this._log('INFO', `✅ Dip confirmed: observed low=${existing.minPrice.toFixed(3)} (current=${currentPrice.toFixed(3)}) — executing at market`);
    } else if (timedOut) {
      this._log('INFO', `⏰ Dip-watch timeout (${DIP_WATCH_TICKS} ticks) — executing at current market ${currentPrice.toFixed(3)}`);
    } else {
      return; // keep watching
    }

    const dipMid = normMarketId(marketId);
    if (dipMid && this._completedMarketCycleIds.has(dipMid)) {
      this._dipWatcher.delete(marketId);
      this._log('INFO', `[SKIP] Dip-watch cancelled — one-cycle lock for market ${dipMid.slice(0, 12)}`);
      return;
    }

    // Clear watcher and execute with the best (minimum) price observed
    this._dipWatcher.delete(marketId);
    // Preserve rawPrice in YES-price space; store outcome-token dip separately.
    const bestSignal = withDipOutcomePrice(existing.signal, existing.minPrice);
    await this._executeTrade(bestSignal);
  }

  _shouldTradeVirtually() {
    return this.virtualLoss?.shouldExecuteVirtual() === true;
  }

  /** Current Polymarket crypto taker coefficient (fee = shares*r*p*(1-p)). */
  _paperTakerFeeRate() {
    const raw = parseFloat(this.settings.paper_taker_fee_rate);
    return Number.isFinite(raw) && raw >= 0 && raw < 1 ? raw : 0.07;
  }

  /**
   * Entry is a taker fill, so its fee is always paid. A non-terminal paper
   * exit is another taker fill and pays the curve again; resolution itself
   * is not a trade and has no exit fee. Maker rebates are never assumed.
   */
  _paperTradeFees(shares, entryPrice, exitPrice = null, exitShares = shares) {
    const rate = this._paperTakerFeeRate();
    const entryFee = calculateCryptoTakerFeeUsd(shares, entryPrice, rate);
    const exitFee = exitPrice != null
      ? calculateCryptoTakerFeeUsd(exitShares, exitPrice, rate)
      : 0;
    return entryFee + exitFee;
  }

  async _persistVirtualLossState() {
    if (!this.virtualLoss) return;
    const st = this.virtualLoss.getStatus();
    try {
      await pool.query(
        `UPDATE bot_settings SET virtual_loss_count=$1, virtual_loss_armed=$2, virtual_paper_balance=$3 WHERE user_id=$4`,
        [st.count, st.armed, this.virtualPaperBalance, this.userId]
      );
    } catch (e) {
      this._log('WARN', `Virtual loss persist failed: ${e.message}`);
    }
  }

  async _applyBalancesAfterClose(trade, tradeSize, pnl, result) {
    const isVirtual = trade.is_virtual === true;
    if (isVirtual) {
      const next = this.virtualPaperBalance + tradeSize + pnl;
      this.virtualPaperBalance = this.paperRiskLimitsEnabled ? Math.max(0, next) : next;
      await pool.query(
        'UPDATE bot_settings SET virtual_paper_balance=$1 WHERE user_id=$2',
        [this.virtualPaperBalance, this.userId]
      );
    } else {
      if (this.settings.paper_trading !== false) {
        const next = this.paperBalance + tradeSize + pnl;
        this.paperBalance = this.paperRiskLimitsEnabled ? Math.max(0, next) : next;
        await pool.query(
          'UPDATE bot_settings SET paper_balance=$1 WHERE user_id=$2',
          [this.paperBalance, this.userId]
        );
      }
      if (this.virtualLoss?.enabled) {
        const next = this.virtualPaperBalance + tradeSize + pnl;
        this.virtualPaperBalance = this.paperRiskLimitsEnabled ? Math.max(0, next) : next;
        await pool.query(
          'UPDATE bot_settings SET virtual_paper_balance=$1 WHERE user_id=$2',
          [this.virtualPaperBalance, this.userId]
        );
      }
    }
    if (this.virtualLoss) await this.virtualLoss.onTradeClosed(trade, result);
  }

  async _executeTrade(signal, { isFlip = false } = {}) {
    const midKey = normMarketId(signal.marketId ?? signal.market?.id ?? signal.market?.condition_id);

    if (midKey && this._marketCooldowns.has(midKey) && Date.now() < this._marketCooldowns.get(midKey)) {
      this._log('INFO', `[SKIP] Market ${midKey.slice(0, 12)} trade recently attempted — cooldown active`);
      return;
    }
    if (midKey) this._marketCooldowns.set(midKey, Date.now() + 10000);

    // Atomic lock: block concurrent calls for the same market across ticks/code paths.
    // This prevents duplicate async placeOrder calls for the same market.
    if (midKey && this._executingMarkets.has(midKey)) {
      this._log('INFO', `[SKIP] Already executing trade for market ${midKey.slice(0, 12)} — concurrent call blocked`);
      return;
    }
    if (midKey) this._executingMarkets.add(midKey);

    const virtualOnly = this._shouldTradeVirtually();
    if (virtualOnly) {
      this._log('INFO', `🧠 Virtual Loss: simulating entry (${this.virtualLoss.count}/${this.virtualLoss.required} losses, not armed)`);
    }

    try {
      return await this._executeTradeInner(signal, { isFlip, virtualOnly });
    } finally {
      if (midKey) this._executingMarkets.delete(midKey);
    }
  }

  async _executeTradeInner(signal, { isFlip = false, virtualOnly = false } = {}) {
    const { direction, tokenId, market, evAdj, modelProb, marketId, fillProb } = signal;
    const isSimpleLast = signal.simpleLastMinute === true;
    const midKey = normMarketId(marketId ?? market?.id ?? market?.condition_id);
    const TICK = 0.01;

    // Diagnostic: log signal state at execution time
    // `signal.orderBook` used to be a synthetic last-trade±1¢ object when the
    // model price came from WS/Gamma. Execution must inspect the venue book,
    // never that probability quote. New signals carry the actual books
    // separately; the fallback preserves old in-flight signal compatibility.
    const ob = signal.executionBooks?.yes || signal.orderBook;
    const obDesc = signal.priceSource === 'gamma'
      ? `gamma=${signal.yesPrice?.toFixed(3)} (boundary book — market-style fill at quoted price)`
      : `bestBid=${ob?.bestBid} bestAsk=${ob?.bestAsk} mid=${ob?.midPrice}`;
    console.log(`[_executeTrade] direction=${direction} src=${signal.priceSource} ${obDesc}`);

    // ── 1. Token ID safety check ──────────────────────────────────────────────
    if (!tokenId || tokenId === 'undefined' || tokenId === 'null') {
      this._log('WARN', `[SKIP] No valid tokenId for ${direction} trade — marketId=${midKey}`);
      return;
    }

    // ── 1b. Time gate — default: no new entries with <60s remaining (flips exempt).
    // Simple last-minute mode: only entries inside the final 60s (inverse rule).
    if (!isFlip) {
      const remainingSec = signal.market?.end_date_iso
        ? (new Date(signal.market.end_date_iso).getTime() - Date.now()) / 1000
        : 999;
      if (isSimpleLast) {
        if (remainingSec > 60 || remainingSec <= 0) {
          this._log(
            'INFO',
            `[SKIP] Simple last-minute mode: need 0<remaining≤60s, got ${Math.round(remainingSec)}s`
          );
          return;
        }
      } else {
        // Time-to-resolution guard: near expiry a binary is a pure jump — the token
        // gaps to 0 or 1 with no time to manage the position (both historical −$100
        // wipeouts were late entries). Configurable via min_entry_remaining_sec;
        // default keeps the existing 60s block (stricter than the 45s floor the
        // audit brief suggested — loosening it needs fresh-data evidence).
        const minRemainRaw = parseInt(this.settings.min_entry_remaining_sec, 10);
        const minRemain = Number.isFinite(minRemainRaw) && minRemainRaw >= 0 ? minRemainRaw : 60;
        if (remainingSec < minRemain) {
          this._log('INFO', `[SKIP] Too late to enter: ${Math.round(remainingSec)}s remaining — new entries blocked <${minRemain}s (min_entry_remaining_sec)`);
          return;
        }
      }
    }

    // ── 1c. One-cycle-per-market: no new entry after we closed a position here (EV_FLIP re-entry exempt) ──
    if (!isFlip && midKey && this._completedMarketCycleIds.has(midKey)) {
      this._log('INFO', `[SKIP] One-cycle policy: market ${midKey.slice(0, 12)} — no new entry after prior close in this window`);
      return;
    }

    // ── 1d. Daily loss limit — defense in depth. _mainLoop already checks, but flip
    // legs (_checkForFlip / _completeDeferredFlipLegIfAny) call _executeTrade directly
    // and previously bypassed the halt entirely.
    if (await this._checkDailyLossLimit()) {
      this._log('WARN', `[SKIP] Daily loss halt active — entry blocked (${isFlip ? 'flip leg' : 'new position'})`);
      return;
    }

    // ── 2. Prevent duplicate pending orders for the same token OR same market ──
    const pendingMid = (o) =>
      normMarketId(o.signal?.marketId ?? o.market?.id ?? o.market?.condition_id);
    const alreadyPending = [...this._pendingOrders.values()].some(
      (o) => o.tokenId === tokenId || (midKey != null && pendingMid(o) === midKey)
    );
    if (alreadyPending) {
      this._log('INFO', `[SKIP] Pending order already exists for token ${tokenId?.slice(0,12)}... — skipping duplicate`);
      return;
    }

    // ── 2b. Prevent multiple open positions in the same market ───────────────
    // Check both DB (open trades) AND in-memory pending orders to catch races
    // where two fills arrive before the second DB insert has committed.
    if (midKey) {
      const hasPendingForMarket = [...this._pendingOrders.values()].some((o) => pendingMid(o) === midKey);
      if (hasPendingForMarket) {
        this._log('INFO', `[SKIP] Pending order already exists for market ${midKey.slice(0, 12)} — skipping`);
        return;
      }
      const existing = await pool.query(
        "SELECT id FROM trades WHERE user_id=$1 AND status='open' AND market_id::text=$2",
        [this.userId, midKey]
      );
      if (existing.rows.length > 0) {
        this._log('INFO', `[SKIP] Already have ${existing.rows.length} open position(s) in market ${midKey.slice(0, 12)} — skipping`);
        return;
      }
    }

    // ── 3. Price from signal engine (single source of truth) ────────────────
    // signal.yesPrice is the smoothed, sanity-checked price from GBMSignalEngine.
    // We never call getLastTradePrice() or Gamma here — that was the source of the
    // split-brain pricing bug (0.505 vs 0.700) and fake stop-losses from Gamma jumps.
    const signalYesPrice = signal.yesPrice; // EMA-smoothed — used for Kelly sizing
    if (!signalYesPrice || !Number.isFinite(signalYesPrice)) {
      this._log('WARN', `[SKIP] Invalid signal.yesPrice=${signalYesPrice} — skipping`);
      return;
    }
    if (!isSimpleLast && (signalYesPrice <= 0.02 || signalYesPrice >= 0.98)) {
      this._log('WARN', `[SKIP] Invalid signal.yesPrice=${signalYesPrice} — skipping`);
      return;
    }
    if (isSimpleLast && (signalYesPrice < 0.001 || signalYesPrice > 0.999)) {
      this._log('WARN', `[SKIP] Simple mode: yesPrice out of band ${signalYesPrice}`);
      return;
    }
    // rawYesPrice = current YES price, unsmoothed — used for limit price calculation.
    // EMA can lag 5-10 ticks on fast-moving markets, causing stale limit prices.
    // Execution must be anchored to NOW, not the smoothed signal price.
    const rawYesPrice = signal.rawPrice ?? signalYesPrice;
    const rawOutcomePrice = getRawOutcomePrice(signal);
    // For Kelly: smoothed price (stable sizing)
    const lastTradePrice = direction === 'NO' ? (1 - signalYesPrice) : signalYesPrice;
    // For execution reference: raw/current price of the outcome token we actually buy.
    const execOutcomePrice = Number.isFinite(rawOutcomePrice)
      ? rawOutcomePrice
      : (direction === 'NO' ? (1 - rawYesPrice) : rawYesPrice);

    // ── 5. Tradeable range check (already covered above, kept for clarity) ───

    const configuredMaxTrade = Math.max(1, parseFloat(this.settings.max_trade_size) || 5.00);
    const maxTradeDollars = this.portfolioPolicy
      ? Math.min(configuredMaxTrade, this.portfolioPolicy.stakeUsd)
      : configuredMaxTrade;
    const unlimitedPaperResearch = this.settings.paper_trading !== false
      && !this.paperRiskLimitsEnabled;
    const researchNotional = this.portfolioPolicy?.bankrollUsdc
      || parseFloat(this.settings.portfolio_bankroll_usdc)
      || 500;
    const balance = unlimitedPaperResearch
      ? researchNotional
      : virtualOnly
        ? this.virtualPaperBalance
        : (this.settings.paper_trading !== false ? this.paperBalance : await this._getLiveBalance());
    if (!balance || isNaN(balance) || balance <= 0) {
      this._log('WARN', `Invalid balance=${balance} — skipping`);
      return;
    }

    let kellyFraction;
    let tradeSize;

    if (isSimpleLast) {
      kellyFraction = Math.min(0.2, Math.max(0.02, parseFloat(this.settings.kelly_cap) || 0.1));
      tradeSize = Math.min(maxTradeDollars, Math.max(1, parseFloat((balance * kellyFraction).toFixed(2))));
    } else {
      // ── 6. Kelly position sizing ──────────────────────────────────────────────
      // Probability shrinkage before Kelly (PROVISIONAL): p' = 0.5 + k·(p − 0.5).
      // Mechanism: Kelly is exponentially sensitive to estimation error and this
      // model's probabilities are measurably overconfident (calibration: implied
      // 55–70% win, realized ~41–49%). Fractional-Kelly-via-shrinkage is the
      // standard correction and changes only SIZE, never which trades fire.
      // kelly_prob_shrink: 1.0 = trust raw model (old behavior), 0 = never bet.
      // Default 0.5; re-derive from scripts/calibration.js after ≥300 fresh trades.
      const shrinkRaw = parseFloat(this.settings.kelly_prob_shrink);
      const probShrink = Number.isFinite(shrinkRaw) && shrinkRaw >= 0 && shrinkRaw <= 1 ? shrinkRaw : 0.5;
      const rawProbUp = modelProb || lastTradePrice;
      const shrunkProbUp = 0.5 + probShrink * (rawProbUp - 0.5);
      const mProb = direction === 'NO'
        ? Math.min(0.99, Math.max(0.01, 1 - shrunkProbUp))
        : Math.min(0.99, Math.max(0.01, shrunkProbUp));
      const b = (1 / lastTradePrice) - 1;
      kellyFraction = b > 0 ? Math.max(0, (mProb * b - (1 - mProb)) / b) : 0;

      let kellyCap = parseFloat(this.settings.kelly_cap) || 0.10;
      if (this.settings.kelly_mode === 'adaptive') {
        const adaptiveKelly = await this._computeAdaptiveKelly();
        if (adaptiveKelly !== null) {
          kellyCap = adaptiveKelly;
          this._log('INFO', `[Kelly] Adaptive mode: cap=${(kellyCap * 100).toFixed(1)}% (from trade stats)`);
        }
      }
      kellyFraction = Math.min(kellyFraction, kellyCap);
      kellyFraction *= (fillProb || 1.0);

      if (kellyFraction <= 0) {
        this._log('WARN', `[SKIP] Kelly=0 at lastTrade=${lastTradePrice.toFixed(4)}`);
        return;
      }

      tradeSize = Math.min(parseFloat((balance * kellyFraction).toFixed(2)), maxTradeDollars);
      if (tradeSize < 1) {
        if (balance >= 1) {
          this._log('INFO', `Kelly produced $${tradeSize.toFixed(2)} — flooring to $1 minimum`);
          tradeSize = 1.0;
        } else {
          this._log('WARN', `[SKIP] Trade size $${tradeSize.toFixed(2)} < $1 minimum (balance $${balance.toFixed(2)})`);
          return;
        }
      }
    }
    // yes_trade_size_multiplier (PROVISIONAL, 2026-07-10): YES was net negative in
    // BOTH the historical and fresh cohorts while NO was positive. Until ≥300 fresh
    // trades confirm or kill the skew, haircut YES size instead of filtering the
    // direction outright. NULL/1.0 = no haircut. Size only — never changes which
    // trades fire.
    if (direction === 'YES') {
      const yesMultRaw = parseFloat(this.settings.yes_trade_size_multiplier);
      const yesMult = Number.isFinite(yesMultRaw) && yesMultRaw > 0 && yesMultRaw <= 1 ? yesMultRaw : 1.0;
      if (yesMult < 1) {
        tradeSize = Math.max(1, parseFloat((tradeSize * yesMult).toFixed(2)));
        this._log('INFO', `[Sizing] YES haircut ×${yesMult} → $${tradeSize.toFixed(2)} (yes_trade_size_multiplier, PROVISIONAL)`);
      }
    }

    if (!unlimitedPaperResearch && virtualOnly && this.virtualPaperBalance < tradeSize) {
      this._log('WARN', `Insufficient virtual balance $${this.virtualPaperBalance.toFixed(2)} < $${tradeSize.toFixed(2)}`);
      return;
    }
    if (!unlimitedPaperResearch && !virtualOnly && this.settings.paper_trading !== false && this.paperBalance < tradeSize) {
      this._log('WARN', `Insufficient paper balance $${this.paperBalance.toFixed(2)} < $${tradeSize.toFixed(2)}`);
      return;
    }

    // Shared candidate capacity rail. Constructor enables this for paper mode
    // only; live promotion requires a separate explicit review and does not
    // inherit new behavior through this audit change.
    if (this.portfolioPolicy && !virtualOnly && !unlimitedPaperResearch) {
      const mode = this.settings.paper_trading !== false ? 'SIMULATED' : 'LIVE';
      const open = await pool.query(`
        SELECT count(*)::int AS n, COALESCE(sum(trade_size), 0) AS exposure
        FROM trades
        WHERE user_id=$1 AND status='open' AND COALESCE(is_virtual, false)=false
          AND COALESCE(execution_type, 'LIVE')=$2
      `, [this.userId, mode]);
      const capacity = canOpenPortfolioPosition({
        policy: this.portfolioPolicy,
        openPositions: parseInt(open.rows[0]?.n, 10) || 0,
        grossExposureUsd: parseFloat(open.rows[0]?.exposure) || 0,
        proposedStakeUsd: tradeSize,
      });
      if (!capacity.allowed) {
        this._log('CRITICAL', `[PORTFOLIO HALT] ${capacity.reason}: proposed $${tradeSize.toFixed(2)}, open=${open.rows[0]?.n || 0}, gross=$${(parseFloat(open.rows[0]?.exposure) || 0).toFixed(2)}, cap=$${this.portfolioPolicy.maxGrossExposureUsd.toFixed(2)}`);
        return;
      }
    }

    // Entry price = price of the token we BUY (YES or NO) at execution time — market / best ask.
    // Priority 1: real CLOB book (spread < 0.90) → bestAsk
    // Priority 2: Gamma / WS boundary-book → synthetic ask near live mid (same as prior limit target)
    const MIN_MARKET_ENTRY = DEFAULT_MIN_MARKET_ENTRY; // do not buy the outcome token below 40¢
    let marketEntryPrice = null;

    let entryBook = null; // real CLOB book for the bought token — used by paper depth-walk
    let hasExecutableQuote = false; // direct CLOB or fresh collector ask, never Gamma/WS synthetic
    if (direction === 'NO' && signal.noTokenId) {
      try {
        const noOb = await this.polymarket.getOrderBook(signal.noTokenId);
        const noSpread = noOb?.bestAsk != null && noOb?.bestBid != null ? noOb.bestAsk - noOb.bestBid : 1;
        if (noOb?.bestAsk != null && noSpread < 0.90) {
          marketEntryPrice = parseFloat(Math.max(0.01, noOb.bestAsk).toFixed(2));
          entryBook = noOb;
          hasExecutableQuote = true;
        }
      } catch (_) {}
    } else if (direction === 'YES') {
      const yesSpread = ob?.bestAsk != null && ob?.bestBid != null ? ob.bestAsk - ob.bestBid : 1;
      if (ob?.bestAsk != null && yesSpread < 0.90) {
        marketEntryPrice = parseFloat(Math.max(0.01, ob.bestAsk).toFixed(2));
        entryBook = ob;
        hasExecutableQuote = true;
      }
    }

    // BORG real-book fill reference (2026-07-13, flag fill_ref_borg_book,
    // default ON): the collector snapshots REAL CLOB books for every active
    // market at 1s cadence in this same database. Calibration vs 20 matched
    // fills: the gamma+5-tick synthetic path paid a median 3.5¢ MORE than
    // the real ask (Q1: real spreads are 1¢ — the 'boundary-only books' lore
    // is stale). Use the real recorded ask (+1 tick latency penalty) whenever
    // a fresh snap (≤6s) exists; gamma+5 stays as the final fallback.
    if (marketEntryPrice == null && this.settings.fill_ref_borg_book !== false) {
      try {
        const snap = await pool.query(`
          SELECT CASE WHEN $2 = 'YES' THEN s.up_best_ask ELSE s.down_best_ask END AS ask, s.ts
          FROM borg_book_snaps s JOIN borg_markets m ON m.id = s.market_id
          WHERE m.gamma_id = $1 AND s.ts > now() - interval '6 seconds'
          ORDER BY s.ts DESC LIMIT 1`,
          [String(signal.marketId ?? ''), direction]);
        const realAsk = parseFloat(snap.rows[0]?.ask);
        if (Number.isFinite(realAsk) && realAsk > 0.01 && realAsk < 0.99) {
          marketEntryPrice = parseFloat(Math.min(0.98, realAsk + TICK).toFixed(2));
          hasExecutableQuote = true;
          this._log('INFO', `[borg_book] Real-ask fill reference: ${marketEntryPrice.toFixed(2)} (recorded ask=${realAsk.toFixed(3)} +1 tick)`);
        }
      } catch (_) { /* fall through to synthetic */ }
    }

    if (marketEntryPrice == null && (signal.priceSource === 'gamma' || signal.priceSource === 'ws')) {
      const slipTicks = isSimpleLast ? 1 : 5;
      const hiCap = isSimpleLast ? 0.995 : 0.98;
      marketEntryPrice = parseFloat(
        Math.min(hiCap, Math.max(0.02, execOutcomePrice + slipTicks * TICK)).toFixed(2)
      );
      this._log(
        'INFO',
        `[${signal.priceSource}] Synthetic ask (boundary book): ${marketEntryPrice.toFixed(2)} (outcome=${execOutcomePrice.toFixed(3)} rawYes=${rawYesPrice.toFixed(3)} emaYes=${signalYesPrice.toFixed(3)})`
      );
    }

    if (marketEntryPrice == null) {
      this._log('WARN', `[SKIP] no_real_liquidity for ${direction} — no CLOB book and no Gamma price`);
      return;
    }

    if (!isEntryPriceAllowed(marketEntryPrice, MIN_MARKET_ENTRY)) {
      this._log(
        'INFO',
        `[SKIP] Entry price ${marketEntryPrice.toFixed(3)} < ${MIN_MARKET_ENTRY.toFixed(2)} — only taking outcomes at or above 40¢`
      );
      return;
    }

    // Execution-time entry ceiling (audit 2026-07-13): max_entry_price was
    // only enforced at SIGNAL time against the smoothed price — the real
    // ask / synthetic ask paid here ran up to 27 ticks higher (13 leaked
    // fills at 0.78–0.92; net −$28.73 with the classic capped-upside/full-
    // downside signature; Gate 2's EV was computed at the signal price, so
    // the justifying edge no longer exists at this fill price). This is
    // enforcement of an existing parameter at the layer that leaked, not a
    // new fitted threshold. Blocked entries land in skipped_signals so the
    // counterfactual evaluator scores what skipping cost.
    {
      const maxEntryRaw = parseFloat(this.settings.max_entry_price);
      const maxEntry = Number.isFinite(maxEntryRaw) && maxEntryRaw > 0 ? maxEntryRaw : 0.65;
      if (marketEntryPrice > maxEntry) {
        this._log('INFO', `[SKIP] Exec entry ceiling: fill would be ${marketEntryPrice.toFixed(3)} > max ${maxEntry} (signal-side was within ceiling — book/raw drift) — aborting entry`);
        pool.query(`
          INSERT INTO skipped_signals
            (user_id, market_id, market_question, skip_reason, skip_detail, direction, entry_price,
             ev_adj, confidence, remaining_sec, scenario, asset)
          VALUES ($1,$2,$3,'exec_entry_ceiling',$4,$5,$6,$7,$8,$9,$10,$11)
        `, [this.userId, String(signal.marketId ?? market?.id ?? ''), market?.question ?? null,
            `exec fill ${marketEntryPrice.toFixed(3)} > ${maxEntry}`,
            direction, marketEntryPrice,
            Number.isFinite(parseFloat(evAdj)) ? parseFloat(evAdj) : null,
            Number.isFinite(parseFloat(signal.confidence)) ? parseFloat(signal.confidence) : null,
            Number.isFinite(signal.remainingSec) ? Math.round(signal.remainingSec) : null,
            signal.log?.scenario ?? null,
            market?.asset ?? 'btc']).catch(() => {});
        return;
      }
    }

    // Gate 2 must be re-evaluated at the executable ask. The signal engine's
    // market probability / last-trade price is useful for prediction, but a
    // taker earns q-ASK, not q-mid. This closes the paper-profit leak where a
    // 0.52 synthetic quote passed EV while the venue ask was 0.96.
    let executionEV = null;
    let executionEVFloor = null;
    if (!isSimpleLast) {
      const parsedModelProb = parseFloat(modelProb);
      executionEV = calculateExecutionAdjustedEV({
        modelProb: parsedModelProb,
        direction,
        fillPrice: marketEntryPrice,
      });
      const signalFloor = parseFloat(signal.log?.gates?.gate2?.evFloor);
      const settingFloor = parseFloat(this.settings.gate2_ev_floor);
      executionEVFloor = Number.isFinite(signalFloor)
        ? signalFloor
        : (Number.isFinite(settingFloor) ? settingFloor : 0.8);
      if (!Number.isFinite(executionEV) || executionEV < executionEVFloor) {
        this._log('INFO', `[SKIP] Executable EV ${Number.isFinite(executionEV) ? executionEV.toFixed(2) : 'n/a'}% below Gate 2 floor ${executionEVFloor.toFixed(2)}% at ask ${marketEntryPrice.toFixed(3)} — signal/mid EV=${Number(evAdj ?? 0).toFixed(2)}%`);
        return;
      }
    }

    const executionSignal = Number.isFinite(executionEV)
      ? {
          ...signal,
          evAdj: executionEV,
          signalEvAdj: evAdj,
          log: {
            ...signal.log,
            gates: {
              ...(signal.log?.gates || {}),
              executionEV: {
                passed: true,
                value: executionEV,
                floor: executionEVFloor,
                fillPrice: marketEntryPrice,
              },
            },
          },
        }
      : signal;

    this._log(
      'INFO',
      `📊 ${direction} "${market.question?.slice(0, 40)}" — ref=${lastTradePrice.toFixed(4)} market=${marketEntryPrice.toFixed(2)} size=$${tradeSize.toFixed(2)} kelly=${(kellyFraction * 100).toFixed(1)}% EV_exec=${Number(executionEV ?? evAdj ?? 0).toFixed(2)}%`
    );

    const placedAt = Date.now();
    const pendingBase = {
      tokenId,
      side: 'BUY',
      limitPrice: marketEntryPrice, // legacy field name — used as fill reference in logs / slippage
      referencePrice: execOutcomePrice,
      dollarSize: tradeSize,
      direction,
      market,
      signal: executionSignal,
      placedAt,
      orderPlacedAt: new Date(placedAt).toISOString(),
      lastCheckedPrice: lastTradePrice,
    };

    if (virtualOnly || this.settings.paper_trading !== false) {
      if (!hasExecutableQuote) {
        this._log('INFO', `[PAPER] SKIP — no executable CLOB/collector ask for ${direction}; synthetic ${signal.priceSource || 'unknown'} quote is signal telemetry only`);
        return;
      }
      // ── Paper fill realism (audit Phase 2.1) ────────────────────────────────
      // Optimistic paper fills are the #1 source of fake edge in this bot class.
      // Two corrections, both pessimistic-biased:
      //  1. Real CLOB book: bestAsk assumes the WHOLE order fills at top of book.
      //     Walk actual ask depth with SlippageEngine; use the depth-weighted
      //     average, and shrink the order to what the book can actually absorb.
      //     Then add paper_fill_penalty_ticks (default 1) for queue/latency cost.
      //  2. Gamma boundary book: the synthetic ask (+5 ticks over outcome price)
      //     already embeds a pessimistic slip — no extra penalty stacked on top.
      let paperFillPrice = marketEntryPrice;
      let paperFillSize = tradeSize;
      if (entryBook && Array.isArray(entryBook.askLevels) && entryBook.askLevels.length > 0) {
        const walk = SlippageEngine.estimate(entryBook.askLevels, tradeSize, 'buy');
        if (walk && walk.avgFillPrice != null && Number.isFinite(walk.avgFillPrice)) {
          paperFillPrice = Math.max(paperFillPrice, walk.avgFillPrice);
          if (!walk.fillable) {
            const fillableUsd = walk.sharesFilled * walk.avgFillPrice;
            if (fillableUsd < 1) {
              this._log('WARN', `[PAPER] SKIP — book cannot absorb even $1 of a $${tradeSize.toFixed(2)} ${direction} order (fillable=$${fillableUsd.toFixed(2)})`);
              return;
            }
            paperFillSize = parseFloat(Math.min(tradeSize, fillableUsd).toFixed(2));
            this._log('WARN', `[PAPER] Partial liquidity: book absorbs $${paperFillSize.toFixed(2)} of $${tradeSize.toFixed(2)} — sizing down (levels=${walk.levelsConsumed})`);
          }
        }
        const penaltyTicksRaw = parseInt(this.settings.paper_fill_penalty_ticks, 10);
        const penaltyTicks = Number.isFinite(penaltyTicksRaw) && penaltyTicksRaw >= 0 ? penaltyTicksRaw : 1;
        paperFillPrice = Math.min(0.99, paperFillPrice + penaltyTicks * TICK);
      }
      paperFillPrice = parseFloat(paperFillPrice.toFixed(4));

      if (!isSimpleLast) {
        const finalPaperEV = calculateExecutionAdjustedEV({
          modelProb: parseFloat(modelProb),
          direction,
          fillPrice: paperFillPrice,
        });
        if (!Number.isFinite(finalPaperEV) || finalPaperEV < executionEVFloor) {
          this._log('INFO', `[PAPER] SKIP — depth/latency fill ${paperFillPrice.toFixed(4)} leaves EV ${Number.isFinite(finalPaperEV) ? finalPaperEV.toFixed(2) : 'n/a'}% below ${executionEVFloor.toFixed(2)}%`);
          return;
        }
        pendingBase.signal = {
          ...executionSignal,
          evAdj: finalPaperEV,
          log: {
            ...executionSignal.log,
            gates: {
              ...(executionSignal.log?.gates || {}),
              executionEV: {
                passed: true,
                value: finalPaperEV,
                floor: executionEVFloor,
                fillPrice: paperFillPrice,
              },
            },
          },
        };
      }

      const timeToFillSec = 0;
      const slipTicks = calculateSlippageTicks(paperFillPrice, execOutcomePrice, TICK);
      const execType = virtualOnly ? 'VIRTUAL' : 'SIMULATED';
      await this._recordFilledTrade(
        { ...pendingBase, orderId: `${virtualOnly ? 'virtual' : 'paper'}_mkt_${Date.now()}`, isPaper: true, isVirtual: virtualOnly },
        paperFillPrice,
        paperFillSize,
        { executionType: execType, timeToFillSec, fillSlippageTicks: slipTicks }
      );
      this._log(
        'INFO',
        virtualOnly
          ? `✅ [VIRTUAL] Simulated fill: ${direction} @ ${paperFillPrice.toFixed(4)} size=$${paperFillSize.toFixed(2)}`
          : `✅ [PAPER] Market fill: ${direction} @ ${paperFillPrice.toFixed(4)} (quoted ask ${marketEntryPrice.toFixed(2)}) size=$${paperFillSize.toFixed(2)}`
      );
      return true;
    }

    // Live: FAK market buy (immediate fill against the book; no resting entry order)
    if (this._balanceErrorUntil && Date.now() < this._balanceErrorUntil) {
      const secsLeft = Math.ceil((this._balanceErrorUntil - Date.now()) / 1000);
      this._log('WARN', `[LIVE] Skipping order — insufficient balance cooldown (${secsLeft}s left). Deposit USDC to resume.`);
      return false;
    }
    if (this._geoBlockErrorUntil && Date.now() < this._geoBlockErrorUntil) {
      const secsLeft = Math.ceil((this._geoBlockErrorUntil - Date.now()) / 1000);
      this._log('WARN', `[LIVE] Skipping order — geo-block cooldown (${secsLeft}s left). Set CLOB Proxy URL in Settings to fix.`);
      return false;
    }

    try {
      this._lastTradeAttemptAt = Date.now();
      if (this._tradeAttemptAtByMarket && signal?.marketId != null) {
        this._tradeAttemptAtByMarket.set(String(signal.marketId), Date.now());
        if (this._tradeAttemptAtByMarket.size > 200) {
          const cutoff = Date.now() - 600000;
          for (const [k, ts] of this._tradeAttemptAtByMarket) if (ts < cutoff) this._tradeAttemptAtByMarket.delete(k);
        }
      }
      const resp = await this.polymarket.placeMarketBuyOrder(tokenId, tradeSize);
      const orderId = resp?.orderID || resp?.order_id || resp?.id;
      let fillPx = marketEntryPrice;
      let fillUsd = tradeSize;

      if (orderId) {
        await new Promise((r) => setTimeout(r, 450));
        const ord = await this.polymarket.fetchOrder(orderId);
        if (ord) {
          const matched = parseFloat(ord.size_matched ?? ord.sizeMatched ?? 0);
          const reported = parseFloat(ord.price ?? ord.avg_price ?? ord.average_price ?? NaN);
          if (matched > 0) {
            if (Number.isFinite(reported) && reported > 0) fillPx = reported;
            fillUsd = Math.min(tradeSize, parseFloat((matched * fillPx).toFixed(2)));
          }
        }
      }

      if (!Number.isFinite(fillUsd) || fillUsd < 0.5) {
        this._log('WARN', `[LIVE] Market buy produced negligible fill (orderId=${String(orderId).slice(0, 12)}) — not recording`);
        return false;
      }

      const timeToFillSec = parseFloat(((Date.now() - placedAt) / 1000).toFixed(2));
      const slipTicks = calculateSlippageTicks(fillPx, execOutcomePrice, TICK);
      await this._recordFilledTrade(
        { ...pendingBase, orderId: orderId || `live_mkt_${Date.now()}`, isPaper: false },
        fillPx,
        fillUsd,
        { executionType: 'LIVE', timeToFillSec, fillSlippageTicks: slipTicks }
      );
      this._balanceErrorUntil = null;
      this._log('INFO', `✅ [LIVE] Market fill: ${direction} @ ${fillPx.toFixed(4)} size=$${fillUsd.toFixed(2)} order=${String(orderId).slice(0, 12)}`);
      return true;
    } catch (err) {
      const errBody = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      if (errBody.includes('not enough balance') || errBody.includes('balance is not enough')) {
        this._balanceErrorUntil = Date.now() + 2 * 60 * 1000;
        this._log('WARN', `[LIVE] Insufficient balance — pausing order placement for 2 min. Deposit USDC to resume.`);
      } else if (errBody.includes('Trading restricted') || errBody.includes('geoblock') || (err.response?.status === 403 && errBody.includes('region'))) {
        this._geoBlockErrorUntil = Date.now() + 5 * 60 * 1000;
        this._log('ERROR', `[LIVE] Geo-blocked (403) — pausing for 5 min. Set CLOB Proxy URL in Settings → Advanced to fix.`);
      } else if (errBody.includes('incorrect header check') || errBody.includes('HMAC') || errBody.includes('header check')) {
        this._lastTradeAttemptAt = Date.now();
      if (this._tradeAttemptAtByMarket && signal?.marketId != null) {
        this._tradeAttemptAtByMarket.set(String(signal.marketId), Date.now());
        if (this._tradeAttemptAtByMarket.size > 200) {
          const cutoff = Date.now() - 600000;
          for (const [k, ts] of this._tradeAttemptAtByMarket) if (ts < cutoff) this._tradeAttemptAtByMarket.delete(k);
        }
      }
        this._log('ERROR', `[LIVE] HMAC/relay error — cooldown 60s: ${errBody}`);
      } else if (errBody.includes('ECONNREFUSED') || errBody.includes('actively refused') || errBody.includes('connect ECONNREFUSED')) {
        this._lastTradeAttemptAt = Date.now();
      if (this._tradeAttemptAtByMarket && signal?.marketId != null) {
        this._tradeAttemptAtByMarket.set(String(signal.marketId), Date.now());
        if (this._tradeAttemptAtByMarket.size > 200) {
          const cutoff = Date.now() - 600000;
          for (const [k, ts] of this._tradeAttemptAtByMarket) if (ts < cutoff) this._tradeAttemptAtByMarket.delete(k);
        }
      }
        this._log('ERROR', `[LIVE] Relay connection refused — cooldown 60s. Check your tunnel is running.`);
      } else {
        this._log('ERROR', `[LIVE] placeMarketBuyOrder failed: ${errBody}`);
      }
      return false;
    }
  }

  // ==========================================
  // ORDER MONITORING — fill, cancel, adverse selection
  // Called every main loop tick (first in _mainLoop so fills progress even if evaluate is slow/stale).
  // ==========================================

  /** Canonical market id for a resting entry order (Map dedupe + DB delete). */
  _pendingEntryMarketId(pending) {
    return normMarketId(
      pending.market?.id ?? pending.market?.condition_id ?? pending.signal?.marketId
    );
  }

  /**
   * Remove a stale resting BUY: market no longer in discovery cache (rolled to next window).
   * Only runs when cache is non-empty so we do not cancel during a transient empty refresh.
   */
  async _cancelStalePendingEntry(orderId, pending, logReason) {
    if (!pending.isPaper) {
      try { await this.polymarket.cancelOrder(orderId); } catch (_) {}
      const mid = this._pendingEntryMarketId(pending);
      if (mid) {
        try {
          await pool.query(
            "DELETE FROM trades WHERE user_id=$1 AND status='pending' AND market_id::text=$2",
            [this.userId, mid]
          );
        } catch (_) {}
      }
    }
    this._pendingOrders.delete(orderId);
    this._log('WARN', `⏱️ Order ${String(orderId).slice(0, 12)}... cancelled — ${logReason}`);
  }

  async _monitorPendingOrders() {
    if (this._pendingOrders.size === 0) return;

    const CONFIGURED_TIMEOUT_MS = (parseInt(this.settings.order_timeout_sec) || 60) * 1000;
    const TICK = 0.01;
    const ADVERSE_TICKS = parseInt(this.settings.adverse_ticks) || 8;

    for (const [orderId, pending] of this._pendingOrders) {
      const age = Date.now() - pending.placedAt;
      const pendingMid = this._pendingEntryMarketId(pending);
      const cache = this.polymarket?.marketsCache;
      const cacheOk = Array.isArray(cache) && cache.length > 0;
      const stillListed =
        pendingMid &&
        cacheOk &&
        cache.some((x) => normMarketId(x.id ?? x.condition_id) === pendingMid);

      if (cacheOk && pendingMid && !stillListed) {
        await this._cancelStalePendingEntry(
          orderId,
          pending,
          `market left discovery (orphan pending ${pendingMid.slice(0, 12)})`
        );
        continue;
      }

      // ── Timeout: cancel based on market time remaining, not wall clock alone ──
      // On 5-min binary markets, CLOB liquidity is thin for the first 2-3 minutes
      // then builds as expiry approaches. A 10s timeout cancels before any real
      // liquidity appears. Instead: hold up to the configured timeout OR until
      // the market has < 30s remaining (no time to fill before resolution).
      //
      // Effective timeout = min(configuredTimeout, timeUntilMarketExpiry - 30s)
      // This means: on a fresh 5-min market, hold up to 60s (or configured value).
      // With <30s left, cancel immediately if still unfilled — won't resolve in time.
      const marketRemainingSec = await this._getMarketRemaining(
        pending.market?.id ?? pending.market?.condition_id ?? pending.signal?.marketId
      );
      const marketExpiryBufferMs = 30 * 1000; // cancel 30s before expiry regardless
      const effectiveTimeoutMs = Number.isFinite(marketRemainingSec)
        ? Math.min(CONFIGURED_TIMEOUT_MS, Math.max(0, marketRemainingSec * 1000 - marketExpiryBufferMs))
        : CONFIGURED_TIMEOUT_MS;

      if (age > effectiveTimeoutMs) {
        if (!pending.isPaper) {
          // Check final status before cancelling — order may have filled during the timeout window
          try {
            const finalStatus = await this.polymarket.getOrderStatus(orderId);
            if (finalStatus?.isFilled) {
              const fillDollars = (finalStatus.sizeMatched || pending.dollarSize / pending.limitPrice) * pending.limitPrice;
              const timeToFillSec = parseFloat((age / 1000).toFixed(2));
              this._log('INFO', `✅ [LIVE] Order ${orderId.slice(0,12)} filled at timeout — $${fillDollars.toFixed(2)}`);
              await this._recordFilledTrade(pending, pending.limitPrice, fillDollars, { executionType: 'LIVE', timeToFillSec });
              this._pendingOrders.delete(orderId);
              continue;
            }
            if (finalStatus?.isPartial && finalStatus.sizeMatched > 0) {
              const fillDollars = finalStatus.sizeMatched * pending.limitPrice;
              const timeToFillSec = parseFloat((age / 1000).toFixed(2));
              this._log('INFO', `📊 [LIVE] Partial fill at timeout ${orderId.slice(0,12)}: $${fillDollars.toFixed(2)}`);
              try { await this.polymarket.cancelOrder(orderId); } catch (_) {}
              await this._recordFilledTrade(pending, pending.limitPrice, fillDollars, { executionType: 'LIVE', timeToFillSec });
              this._pendingOrders.delete(orderId);
              continue;
            }
          } catch (_) {}
          try { await this.polymarket.cancelOrder(orderId); } catch (_) {}
        }
        const reason = marketRemainingSec != null && marketRemainingSec < 35
          ? `market expires in ${Math.round(marketRemainingSec)}s`
          : `timeout after ${(age/1000).toFixed(0)}s`;
        this._log('WARN', `⏱️ Order ${orderId.slice(0,12)}... cancelled — ${reason}`);
        this._pendingOrders.delete(orderId);
        // Delete the pending DB row so it doesn't permanently block new entries
        if (!pending.isPaper) {
          const mid = this._pendingEntryMarketId(pending);
          if (mid) {
            try {
              await pool.query(
                "DELETE FROM trades WHERE user_id=$1 AND status='pending' AND market_id::text=$2",
                [this.userId, mid]
              );
            } catch (_) {}
          }
        }
        continue;
      }

      if (pending.isPaper) {
        await this._checkPaperFill(orderId, pending, TICK, ADVERSE_TICKS);
      } else {
        await this._checkLiveFill(orderId, pending, TICK, ADVERSE_TICKS);
      }
    }
  }

  // Paper fill simulation — checks whether the market price has crossed our limit.
  //
  // Fill logic: a passive buy limit fills when the market offer comes down to our price.
  // For YES: filled when signal.yesPrice <= limitPrice (market offered at our bid)
  // For NO:  filled when signal.noPrice  <= limitPrice
  //
  // Using signal.yesPrice (from the current tick's evaluate() call) ensures the
  // fill simulation reflects the same price that every other component sees.
  async _checkPaperFill(orderId, pending, TICK, ADVERSE_TICKS) {
    const isGamma = pending.signal?.priceSource === 'gamma';

    if (isGamma) {
      // ── Gamma-sourced order: BTC 5-min boundary-book market ──────────────────
      // Fill simulation: poll Gamma outcomePrices as the live market price.
      // A resting GTC limit at gammaPrice+1tick fills when a counterparty crosses it.
      // Simulate: fill if Gamma price stays within ±2 ticks of our limit for ≥2 ticks.
      // Cancel: if price moves > ADVERSE_TICKS away OR market expires.
      const marketId = pending.signal?.marketId;
      const gp = await this.polymarket.getLivePriceFromGamma(marketId, pending.tokenId);
      if (gp == null) return; // no price yet — wait

      const gammaToken = pending.direction === 'NO' ? 1 - gp : gp;
      const ticksFromLimit = (gammaToken - pending.limitPrice) / TICK;

      // Adverse: price moved strongly against our limit
      if (ticksFromLimit > ADVERSE_TICKS) {
        const ageSec = ((Date.now() - pending.placedAt) / 1000).toFixed(1);
        this._log('WARN', `🚫 [PAPER/SIM] Missed trade — adverse move: limit=${pending.limitPrice.toFixed(2)} gamma=${gammaToken.toFixed(3)} (+${ticksFromLimit.toFixed(1)} ticks) age=${ageSec}s`);
        this._pendingOrders.delete(orderId);
        return;
      }

      // Fill condition.
      // strict_paper_fills (default ON, audit 2026-07-12): the limit was placed at
      // gamma+1 tick, so `gammaToken <= limit` is true at placement — the old rule
      // filled on a FLAT market. Tape replay of 25 trades showed 9 would never
      // fill (8 of them paper wins). A resting buy fills only when a counterparty
      // trades DOWN through the level: require gamma strictly below the limit.
      const strictFills = this.settings.strict_paper_fills !== false;
      const atPrice = strictFills
        ? gammaToken <= pending.limitPrice - TICK
        : gammaToken <= pending.limitPrice;
      if (atPrice) {
        pending.fillConfirmTicks = (pending.fillConfirmTicks || 0) + 1;
      } else {
        pending.fillConfirmTicks = 0;
      }

      this._log('INFO', `📊 [PAPER/SIM] Fill check: limit=${pending.limitPrice.toFixed(2)} gamma=${gammaToken.toFixed(3)} ticks=${ticksFromLimit.toFixed(1)} confirmTicks=${pending.fillConfirmTicks}/2`);

      if (pending.fillConfirmTicks >= 2) {
        const fillPrice = parseFloat(pending.limitPrice.toFixed(2));
        const timeToFillSec = parseFloat(((Date.now() - pending.placedAt) / 1000).toFixed(2));
        const slippageTicks = parseFloat(((fillPrice - pending.referencePrice) / TICK).toFixed(2));
        this._log('INFO', `✅ [PAPER/SIM] Filled: ${pending.direction} @ ${fillPrice.toFixed(4)} gamma=${gammaToken.toFixed(3)} ttf=${timeToFillSec}s slip=${slippageTicks > 0 ? '+' : ''}${slippageTicks} ticks`);
        await this._recordFilledTrade(pending, fillPrice, pending.dollarSize, {
          executionType: 'SIMULATED',
          timeToFillSec,
          fillSlippageTicks: slippageTicks
        });
        this._pendingOrders.delete(orderId);
      }
      return;
    }

    // ── Real CLOB book path ───────────────────────────────────────────────────
    let ob;
    try {
      ob = await this.polymarket.getOrderBook(pending.tokenId);
    } catch (_) {}

    if (!ob) return;

    const spread = ob.bestAsk != null && ob.bestBid != null ? ob.bestAsk - ob.bestBid : 1;
    if (spread >= 0.90) {
      // Book became boundary-only — cancel (can't simulate a real fill)
      this._log('WARN', `🚫 [PAPER] Cancel ${orderId.slice(0,12)} — book became boundary-only (spread=${(spread*100).toFixed(0)}%)`);
      this._pendingOrders.delete(orderId);
      return;
    }

    const bestAsk = ob.bestAsk;
    if (bestAsk == null || bestAsk <= 0) return;

    if (bestAsk > pending.limitPrice + ADVERSE_TICKS * TICK) {
      this._log('WARN', `🚫 [PAPER] Adverse selection: limit=${pending.limitPrice.toFixed(2)} bestAsk=${bestAsk.toFixed(3)} (+${((bestAsk - pending.limitPrice)/TICK).toFixed(0)} ticks) — cancelling`);
      this._pendingOrders.delete(orderId);
      return;
    }

    const atPrice = bestAsk <= pending.limitPrice;
    if (atPrice) {
      pending.fillConfirmTicks = (pending.fillConfirmTicks || 0) + 1;
    } else {
      pending.fillConfirmTicks = 0;
    }

    this._log('INFO', `📊 [PAPER] Fill check: limit=${pending.limitPrice.toFixed(2)} bestAsk=${bestAsk.toFixed(3)} spread=${(spread*100).toFixed(0)}% confirmTicks=${pending.fillConfirmTicks}/2`);

    if (pending.fillConfirmTicks >= 2) {
      const fillPrice = parseFloat(pending.limitPrice.toFixed(2));
      const timeToFillSec = parseFloat(((Date.now() - pending.placedAt) / 1000).toFixed(2));
      const slippageTicks = parseFloat(((fillPrice - pending.referencePrice) / TICK).toFixed(2));
      this._log('INFO', `✅ [PAPER] Filled: ${pending.direction} @ ${fillPrice.toFixed(4)} bestAsk=${bestAsk.toFixed(3)} ttf=${timeToFillSec}s slip=${slippageTicks > 0 ? '+' : ''}${slippageTicks} ticks`);
      await this._recordFilledTrade(pending, fillPrice, pending.dollarSize, {
        executionType: 'SIMULATED',
        timeToFillSec,
        fillSlippageTicks: slippageTicks
      });
      this._pendingOrders.delete(orderId);
    }
  }

  // Live fill check — poll order status + adverse selection cancel
  async _checkLiveFill(orderId, pending, TICK, ADVERSE_TICKS) {
    try {
      const status = await this.polymarket.getOrderStatus(orderId);
      if (!status) return;

      if (status.isFilled) {
        const fillDollars = status.sizeMatched * pending.limitPrice;
        const timeToFillSec = parseFloat(((Date.now() - pending.placedAt) / 1000).toFixed(2));
        this._log('INFO', `✅ [LIVE] Order ${orderId.slice(0,12)} MATCHED @ ${pending.limitPrice.toFixed(4)} — $${fillDollars.toFixed(2)} ttf=${timeToFillSec}s`);
        await this._recordFilledTrade(pending, pending.limitPrice, fillDollars, { executionType: 'LIVE', timeToFillSec });
        this._pendingOrders.delete(orderId);
        return;
      }

      if (status.status === 'CANCELLED') {
        this._log('WARN', `🚫 [LIVE] Order ${orderId.slice(0,12)} was cancelled externally`);
        this._pendingOrders.delete(orderId);
        try { await pool.query("DELETE FROM trades WHERE user_id=$1 AND status='pending' AND market_id=$2", [this.userId, pending.market?.id || pending.market?.condition_id]); } catch (_) {}
        return;
      }

      if (status.isPartial) {
        // Partial fill — accept what we got, cancel the rest
        const fillDollars = status.sizeMatched * pending.limitPrice;
        const timeToFillSec = parseFloat(((Date.now() - pending.placedAt) / 1000).toFixed(2));
        this._log('INFO', `📊 [LIVE] Partial fill ${orderId.slice(0,12)}: ${status.sizeMatched.toFixed(2)}/${status.sizeTotal.toFixed(2)} tokens = $${fillDollars.toFixed(2)} ttf=${timeToFillSec}s`);
        try { await this.polymarket.cancelOrder(orderId); } catch (_) {}
        await this._recordFilledTrade(pending, pending.limitPrice, fillDollars, { executionType: 'LIVE', timeToFillSec });
        this._pendingOrders.delete(orderId);
        return;
      }

      // Still LIVE (resting) — check for adverse selection
      // For boundary-book markets (priceSource=gamma): use Gamma price since CLOB mid=0.5 always
      // For real-book markets: use CLOB mid
      let currentPrice = null;
      if (pending.signal?.priceSource === 'gamma') {
        try {
          const gp = await this.polymarket.getLivePriceFromGamma(pending.signal?.marketId, pending.tokenId);
          currentPrice = gp != null ? (pending.direction === 'NO' ? 1 - gp : gp) : null;
        } catch (_) {}
      }
      if (currentPrice == null) {
        const liveBook = await this.polymarket.getOrderBook(pending.tokenId);
        currentPrice = liveBook?.midPrice ?? null;
      }
      if (currentPrice && currentPrice > pending.limitPrice + ADVERSE_TICKS * TICK) {
        this._log('WARN', `🚫 [LIVE] Adverse selection: limit=${pending.limitPrice.toFixed(2)} market=${currentPrice.toFixed(3)} (+${((currentPrice - pending.limitPrice)/TICK).toFixed(0)} ticks) — cancelling order ${orderId.slice(0,12)}`);
        try { await this.polymarket.cancelOrder(orderId); } catch (_) {}
        this._pendingOrders.delete(orderId);
        try { await pool.query("DELETE FROM trades WHERE user_id=$1 AND status='pending' AND market_id=$2", [this.userId, pending.market?.id || pending.market?.condition_id]); } catch (_) {}
      }

    } catch (err) {
      this._log('WARN', `Order status check failed ${orderId.slice(0,12)}: ${err.message}`);
    }
  }

  // Write confirmed fill to DB and update balance.
  // execInfo: { executionType, timeToFillSec, fillSlippageTicks } — optional, paper only
  async _recordFilledTrade(pending, fillPrice, fillDollars, execInfo = {}) {
    const { direction, market, signal, tokenId } = pending;
    const { confidence, evAdj } = signal;
    const marketIdRaw = market?.id || market?.condition_id;
    const mid = normMarketId(marketIdRaw ?? signal?.marketId);

    const executionType = execInfo.executionType || (pending.isPaper ? 'SIMULATED' : 'LIVE');
    const timeToFillSec = execInfo.timeToFillSec ?? null;
    const fillSlippageTicks = execInfo.fillSlippageTicks ?? null;

    const fp = parseMoneyField(fillPrice);
    const fd = parseMoneyField(fillDollars);
    if (!(fp > 0 && fd > 0)) {
      this._log('WARN', `[${executionType}] Rejecting fill — invalid price/notional (price=${fillPrice}, dollars=${fillDollars}) market=${mid}`);
      if (!pending.isPaper) {
        const qm = mid || String(marketIdRaw ?? '');
        try {
          await pool.query(
            `DELETE FROM trades WHERE user_id=$1 AND status='pending' AND market_id::text=$2`,
            [this.userId, qm]
          );
        } catch (_) {}
      }
      return;
    }

    const isVirtual = pending.isVirtual === true;

    // Gate/model fields — null-safe (?? not ||): a legitimate 0.0 btcDelta must persist
    // as 0, not be coerced away, and a missing field must be loud, not silently 0.
    // gate3_score = the 60s btcDelta (%) the Gate-3 direction check actually evaluated.
    const gate1Score = signal.log?.gates?.gate1?.confidence ?? 0;
    const gate2Score = signal.log?.gates?.gate2?.bestEV ?? 0;
    const gate3Score = signal.log?.gates?.gate3?.btcDelta ?? signal.emaEdge ?? null;
    const modelProbPersist = Number.isFinite(signal.modelProb) ? signal.modelProb : null;
    if (gate3Score == null || modelProbPersist == null) {
      this._log('WARN', `[${executionType}] Signal snapshot incomplete at record time: gate3Score=${gate3Score} modelProb=${modelProbPersist} (source=${signal.modelProbSource ?? 'n/a'}) — persisting NULL, check signal builder`);
    }

    if (pending.isPaper && mid) {
      const dup = await pool.query(
        `SELECT 1 FROM trades WHERE user_id=$1 AND status='open' AND market_id::text=$2 LIMIT 1`,
        [this.userId, mid]
      );
      if (dup.rows.length > 0) {
        this._log('WARN', `[${executionType}] Duplicate fill ignored — open position already exists for market ${mid}`);
        return;
      }
    }

    if (isVirtual) {
      this.virtualPaperBalance -= fd;
      await pool.query(
        'UPDATE bot_settings SET virtual_paper_balance=$1 WHERE user_id=$2',
        [this.virtualPaperBalance, this.userId]
      );
    } else if (pending.isPaper) {
      this.paperBalance -= fd;
      await pool.query('UPDATE bot_settings SET paper_balance=$1 WHERE user_id=$2', [this.paperBalance, this.userId]);
    }

    // Upgrade the pending DB row to open — avoids creating duplicate rows.
    // For paper trades there is no pending row, so INSERT directly.
    let rowsUpdated = 0;
    if (!pending.isPaper) {
      const upd = await pool.query(`
        UPDATE trades SET
          status='open', entry_price=$1, trade_size=$2, size=$2,
          signal_confidence=$3, ev_adj=$4,
          gate1_score=$5, gate2_score=$6, gate3_score=$7, scenario=$8,
          time_to_fill_sec=$9, fill_slippage_ticks=$10, model_prob=$11,
          oracle_divergence_bps=$12, oracle_lag_ms=$13
        WHERE user_id=$14 AND status='pending' AND market_id::text=$15
      `, [
        fp, fd, confidence, evAdj,
        gate1Score,
        gate2Score,
        gate3Score,
        signal.log?.scenario || null,
        timeToFillSec, fillSlippageTicks, modelProbPersist,
        signal.oracleDivergenceBps ?? null,
        signal.oracleLagMs != null ? Math.round(signal.oracleLagMs) : null,
        this.userId, mid || String(marketIdRaw ?? '')
      ]);
      rowsUpdated = upd.rowCount;
    }
    if (rowsUpdated === 0) {
      // No pending row found (paper trade, or pending row was missing) — INSERT
      await pool.query(`
        INSERT INTO trades (
          user_id, session_id, market_id, market_question, token_id, direction,
          entry_price, trade_size, size, status, trade_type,
          signal_confidence, ev_adj, gate1_score, gate2_score, gate3_score, scenario,
          execution_type, order_placed_at, time_to_fill_sec, fill_slippage_ticks, is_virtual, model_prob,
          oracle_divergence_bps, oracle_lag_ms, asset
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,'open','signal',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
      `, [
        this.userId, this.sessionId || null, mid || marketIdRaw, market?.question, tokenId, direction,
        fp, fd, confidence, evAdj,
        gate1Score,
        gate2Score,
        gate3Score,
        signal.log?.scenario || null,
        executionType,
        pending.orderPlacedAt || null,
        timeToFillSec, fillSlippageTicks,
        isVirtual, modelProbPersist,
        signal.oracleDivergenceBps ?? null,
        signal.oracleLagMs != null ? Math.round(signal.oracleLagMs) : null,
        market?.asset || signal.market?.asset || 'btc'
      ]);
    }

    this._recordSlippage(pending.referencePrice, fp);

    const slipTicks = fillSlippageTicks ?? (Math.abs(fp - pending.referencePrice) / 0.01);
    this._log('INFO', `📝 [${executionType}] Trade recorded: ${direction} fill=${fp.toFixed(4)} ref=${pending.referencePrice.toFixed(4)} slip=${slipTicks.toFixed(1)}t ttf=${timeToFillSec != null ? timeToFillSec+'s' : 'n/a'} size=$${fd.toFixed(2)} balance=$${(pending.isPaper ? this.paperBalance : 0).toFixed(2)}`);
  }

  // ==========================================
  // POSITION MANAGEMENT — EV-BASED EXITS
  // ==========================================

  async _manageOpenPositions(signal) {
    try {
      const result = await pool.query(
        "SELECT * FROM trades WHERE user_id = $1 AND status = $2",
        [this.userId, 'open']
      );

      if (result.rows.length === 0) return;

      for (const trade of result.rows) {
        // Close legacy trades that pre-date the token_id column — can't manage them
        if (!trade.token_id) {
          this._log('WARN', `Closing legacy trade ${trade.id} — no token_id`);
          await this._closePosition(trade, parseFloat(trade.entry_price), 'LEGACY_NO_TOKEN_ID');
          continue;
        }

        const tradeAgeMin = (Date.now() - new Date(trade.created_at).getTime()) / 60000;

        // ── Single source of truth: signal.yesPrice / signal.rawPrice ──────────
        // signal is evaluated once per tick at the top of _mainLoop.
        //
        // livePrice (smoothed) → all decisions: EV, gates, stop-loss trigger
        // rawLivePrice (unsmoothed) → PnL marking only (more reactive to real moves)
        //
        // For YES trades: token price = yesPrice
        // For NO trades:  token price = noPrice (= 1 - yesPrice)
        let livePrice = null;
        let rawLivePrice = null;
        let livePriceSrc = null;
        // Only use signal prices if this signal is for THIS trade's market.
        // Signal is evaluated per-market; using a different market's price gives wrong PnL.
        const signalIsForThisMarket = signal?.marketId != null && signal.marketId === trade.market_id;
        if (signalIsForThisMarket && signal.yesPrice != null) {
          livePrice    = trade.direction === 'NO' ? signal.noPrice          : signal.yesPrice;
          rawLivePrice = trade.direction === 'NO' ? 1 - (signal.rawPrice ?? signal.yesPrice)
                                                  : (signal.rawPrice ?? signal.yesPrice);
          livePriceSrc = signal.priceSource || 'signal';

          // Desync guard: log if smoothed price jumped >10% relative vs last tick.
          if (trade._cachedLivePrice != null) {
            const relDivergence = Math.abs(trade._cachedLivePrice - livePrice) / trade._cachedLivePrice;
            if (relDivergence > 0.10) {
              this._log('WARN', `⚠️ Desync on trade #${trade.id}: prev=${trade._cachedLivePrice.toFixed(3)} signal=${livePrice.toFixed(3)} divergence=${(relDivergence*100).toFixed(1)}% src=${livePriceSrc}`);
            }
          }
          trade._cachedLivePrice = livePrice;
        }

        // Fallback 1: signal engine price cache — updated every tick for all active markets.
        if (!livePrice && this.signalEngine?._priceCache?.has(trade.market_id)) {
          const cached = this.signalEngine._priceCache.get(trade.market_id);
          if (cached?.smoothedPrice != null) {
            const cachedYes = cached.smoothedPrice;
            livePrice    = trade.direction === 'NO' ? (1 - cachedYes) : cachedYes;
            rawLivePrice = livePrice;
            livePriceSrc = `cache(${cached.priceSource || 'gamma'})`;
            trade._cachedLivePrice = livePrice;
          }
        }

        // Fallback 2: Gamma API direct fetch — for markets not in current signal window.
        if (!livePrice && trade.market_id) {
          try {
            const gp = await this.polymarket.getLivePriceFromGamma(trade.market_id, trade.token_id);
            if (gp != null) {
              livePrice    = gp;
              rawLivePrice = gp;
              livePriceSrc = 'gamma_direct';
              trade._cachedLivePrice = livePrice;
            }
          } catch (_) {}
        }

        // Fallback 3: last known price from cache — prevents src=null on ticks where
        // Gamma API is slow or market just left discovery window.
        if (!livePrice && trade._cachedLivePrice != null) {
          livePrice    = trade._cachedLivePrice;
          rawLivePrice = livePrice;
          livePriceSrc = 'cached_last';
        }

        if (!livePrice) {
          // No price from signal this tick (signal returned SKIP with yesPrice=null).
          // Check for expired market before giving up.
          if (tradeAgeMin >= 5.5) {
            const resolvedAt = await this._getResolutionPrice(trade.market_id, trade.token_id);
            if (resolvedAt !== null) {
              // Gamma confirmed resolution outcome (clear 1.0 or 0.0)
              this._log('INFO', `⏱️ Market expired — trade #${trade.id} age=${tradeAgeMin.toFixed(1)}min, resolvedAt=${resolvedAt.toFixed(3)}`);
              await this._closePosition(trade, resolvedAt, 'MARKET_RESOLVED');
              this.evEngine.clearMarket(trade.market_id);
              this.signalEngine.clearMarket(trade.market_id);
            } else {
              // Gamma ambiguous (UMA challenge period / outcomePrices=[0.5,0.5]).
              // BTC 5-min markets typically resolve within 3-5 min of expiry via UMA.
              // Wait up to 15min before forcing close — avoids $0 P&L from premature exit.
              const fallback = trade._cachedLivePrice ?? null;
              if (tradeAgeMin >= 15.0) {
                // Last resort: close at cached price before market entry if possible.
                // cachedLivePrice was last known token price before resolution — better than entry.
                const closePrice = fallback ?? parseFloat(trade.entry_price);
                this._log('WARN', `⏱️ Force-closing trade #${trade.id} at ${closePrice.toFixed(3)} (Gamma unresolved at ${tradeAgeMin.toFixed(1)}min, fallback=${fallback != null ? 'cached' : 'entry'})`);
                await this._closePosition(trade, closePrice, 'MARKET_RESOLVED_TIMEOUT');
                this.evEngine.clearMarket(trade.market_id);
                this.signalEngine.clearMarket(trade.market_id);
              } else {
                this._log('INFO', `⏳ Waiting for Gamma resolution on trade #${trade.id} (age=${tradeAgeMin.toFixed(1)}min)`);
              }
            }
          } else {
            this._log('WARN', `No price in signal for trade #${trade.id} (age=${tradeAgeMin.toFixed(1)}min) — holding`);
          }
          continue;
        }

        // ── Stale/orphan trade check: market no longer in active discovery ───────
        // If the market has expired (not in marketsCache → remaining=0) and the
        // trade is older than 5 min, resolve via Gamma or force-close.
        // This handles re-adopted trades from previous sessions whose markets have
        // long since expired — without this check they block new entries indefinitely.
        const remainingForClose = await this._getMarketRemaining(trade.market_id);
        if (remainingForClose === 0 && tradeAgeMin >= 5.0) {
          // Always do a fresh Gamma fetch here — the price cache may be stale for
          // an expired market (e.g. 0.505 cached while real price is 0.885 resolved).
          let freshPrice = null;
          try {
            freshPrice = await this.polymarket.getLivePriceFromGamma(trade.market_id, trade.token_id);
          } catch (_) {}
          // If Gamma returns a near-resolved price, treat as resolved
          if (freshPrice != null && (freshPrice >= 0.88 || freshPrice <= 0.12)) {
            const resolvedAt = freshPrice >= 0.88 ? 1.0 : 0.0;
            this._log('INFO', `⏱️ Stale trade #${trade.id} — near-resolved via fresh Gamma: ${freshPrice.toFixed(3)} → closing at ${resolvedAt}`);
            await this._closePosition(trade, resolvedAt, 'MARKET_RESOLVED');
            this.evEngine.clearMarket(trade.market_id);
            this.signalEngine.clearMarket(trade.market_id);
            continue;
          }
          const resolvedAt = await this._getResolutionPrice(trade.market_id, trade.token_id);
          if (resolvedAt !== null) {
            this._log('INFO', `⏱️ Stale trade #${trade.id} — market expired, resolved at ${resolvedAt.toFixed(3)}`);
            await this._closePosition(trade, resolvedAt, 'MARKET_RESOLVED');
          } else if (tradeAgeMin >= 10.0) {
            // UMA challenge period is typically 3-8min. Force-close at 10min with best available price.
            const closePrice = freshPrice ?? trade._cachedLivePrice ?? livePrice ?? parseFloat(trade.entry_price);
            this._log('WARN', `⏱️ Force-closing stale trade #${trade.id} at ${closePrice.toFixed(3)} — market expired ${tradeAgeMin.toFixed(1)}min ago, Gamma unresolved`);
            await this._closePosition(trade, closePrice, 'MARKET_RESOLVED_TIMEOUT');
          } else {
            this._log('INFO', `⏳ Stale trade #${trade.id} — market expired, waiting for Gamma resolution (age=${tradeAgeMin.toFixed(1)}min)`);
            continue;
          }
          this.evEngine.clearMarket(trade.market_id);
          this.signalEngine.clearMarket(trade.market_id);
          continue;
        }

        // Near-resolution detection: token price approaching 0 or 1 = market settling
        if (livePrice >= 0.92 || livePrice <= 0.08) {
          const resolvedAt = livePrice >= 0.92 ? 1.0 : 0.0;
          this._log('INFO', `🏁 Near-resolution detected: price=${livePrice.toFixed(3)} — closing trade #${trade.id} at ${resolvedAt}`);
          await this._closePosition(trade, resolvedAt, 'MARKET_RESOLVED');
          this.evEngine.clearMarket(trade.market_id);
          this.signalEngine.clearMarket(trade.market_id);
          continue;
        }

        // Time-based close at 4.5 min
        if (tradeAgeMin >= 4.5) {
          const resolvedAt = await this._getResolutionPrice(trade.market_id, trade.token_id);
          if (resolvedAt !== null) {
            this._log('INFO', `⏳ Pre-expiry close: trade #${trade.id} age=${tradeAgeMin.toFixed(1)}min resolvedAt=${resolvedAt.toFixed(3)}`);
            await this._closePosition(trade, resolvedAt, 'MARKET_RESOLVED');
            this.evEngine.clearMarket(trade.market_id);
            this.signalEngine.clearMarket(trade.market_id);
            continue;
          }
        }

        const entryPrice = parseFloat(trade.entry_price);
        const marketId = trade.market_id;

        // --- EV-based exit (uses same livePrice from signal) ---
        const btcDelta = this.binance.getWindowDeltaScore(30);
        const latency = this.signalEngine?.microEngine?.detectLatency() || 0;
        const exitLagEdge = latency > 0.3 ? 0.05 : 0;
        const exitBtcEdge = Math.min(Math.abs(btcDelta) * 0.5, 0.15);
        const exitTotalEdge = exitBtcEdge + exitLagEdge;
        const exitBullish = btcDelta > 0;
        const currentModelProb = Math.min(0.99, Math.max(0.01,
          exitBullish ? livePrice + exitTotalEdge : livePrice - exitTotalEdge
        ));

        const currentEV = this.evEngine.calculateAdjustedEV(
          currentModelProb, livePrice,
          trade.direction,
          { spread: 0.01, estimatedSlippage: 0.005, takerFeeRate: 0.07 }
        );

        this.evEngine.recordEV(marketId, currentEV, trade.direction);

        // PnL uses rawLivePrice (unsmoothed) — the smoothed price lags real moves
        // and would understate losses near resolution. Decisions still use livePrice.
        const pnlPct = (((rawLivePrice ?? livePrice) - entryPrice) / entryPrice) * 100;
        this._log('INFO', `📍 Holding ${trade.direction} on "${trade.market_question?.slice(0,40)}" — EV=${currentEV.toFixed(2)}% smoothed=${livePrice.toFixed(3)} raw=${(rawLivePrice ?? livePrice).toFixed(3)} PnL=${pnlPct.toFixed(1)}% src=${livePriceSrc}`);

        // EXIT CONDITION 1: Time-gated stop-loss
        // pnlPct = (currentTokenPrice - entryPrice) / entryPrice * 100
        // This is a relative price move on the token (0–1 scale), NOT % of bankroll.
        // Example: entry=0.50, current=0.425 → pnlPct = -15%
        //
        // Binary markets naturally swing ±10–20% mid-window. Only stop-loss when:
        //   (a) < 30s remaining — market is nearly resolved, no time to recover
        //   (b) token price dropped > 15% relative — position is structurally wrong
        //
        // The previous -20% threshold was fine as a relative token threshold but
        // with <30s gate it's already too late at -20%. -15% relative with <30s
        // remaining is the appropriate cut: still generous enough to avoid noise
        // closes, tight enough to salvage value before resolution.
        const marketEndSec = trade.market_id
          ? await this._getMarketRemaining(trade.market_id)
          : 300;

        // EXIT CONDITION 1a: Early stop-loss — tiered by time left (wider when more time to recover).
        // Thresholds: >180s → −42%, >120s → −38%, >60s → −35%, else (30,60] → −32% (_hardStopEarlyThresholdPct).
        //
        // Flicker guard (PROVISIONAL, audit §2.6): boundary-book mids tick ±1–2¢ per
        // tick, so the trigger uses the SMOOTHED decision price and must hold for
        // `stop_confirm_ticks` consecutive ticks (default 2 ≈ 10s at a 5s interval)
        // before firing. The <30s late stop below stays immediate — no time to confirm.
        // Counterfactual on the 24 historical stops: holding to resolution was WORSE
        // (−$943 vs −$808), so the stop itself is kept; this guard only targets the
        // single-tick-noise subset. Evaluate over the next ≥300 paper trades.
        // hard_stop_loss_pct (PROVISIONAL, 2026-07-10): flat override of the tiered
        // thresholds. Fresh-cohort counterfactual (29 stops, ids 54–124) shows holding
        // to resolution would have saved ~$710 — the OPPOSITE of the historical cohort,
        // where holding lost more. Sign instability across cohorts means neither
        // "tight" nor "disabled" is defensible; a wide flat stop keeps catastrophic-
        // loss protection while stopping far less. NULL = original tiered behavior.
        // Re-derive from scripts/ev-autopsy.js §2 after ≥300 fresh trades.
        const stopOverrideRaw = parseFloat(this.settings.hard_stop_loss_pct);
        const earlyStopPct = Number.isFinite(stopOverrideRaw) && stopOverrideRaw > 0
          ? -Math.abs(stopOverrideRaw)
          : _hardStopEarlyThresholdPct(marketEndSec);
        const decisionPnlPct = ((livePrice - entryPrice) / entryPrice) * 100;
        if (!this._stopConfirm) this._stopConfirm = new Map();
        if (decisionPnlPct <= earlyStopPct && marketEndSec > 30) {
          const confirmNeededRaw = parseInt(this.settings.stop_confirm_ticks, 10);
          const confirmNeeded = Number.isFinite(confirmNeededRaw) && confirmNeededRaw >= 1 ? confirmNeededRaw : 2;
          const seen = (this._stopConfirm.get(trade.id) || 0) + 1;
          this._stopConfirm.set(trade.id, seen);
          if (seen < confirmNeeded) {
            this._log('WARN', `🛑 Early stop-loss pending confirmation (${seen}/${confirmNeeded}): smoothed PnL ${decisionPnlPct.toFixed(1)}% ≤ ${earlyStopPct}% (raw ${pnlPct.toFixed(1)}%) — waiting one more tick`);
            continue;
          }
          this._stopConfirm.delete(trade.id);
          if (await this._holdOnlyIntercept(trade, 'HARD_STOP_LOSS', rawLivePrice ?? livePrice)) continue;
          this._log('WARN', `🛑 Early stop-loss: smoothed PnL ${decisionPnlPct.toFixed(1)}% ≤ ${earlyStopPct}% for ${confirmNeeded} ticks — closing at ${(rawLivePrice ?? livePrice).toFixed(3)} with ${Math.round(marketEndSec)}s remaining`);
          await this._closePosition(trade, rawLivePrice ?? livePrice, 'HARD_STOP_LOSS');
          this.evEngine.clearMarket(marketId);
          this.signalEngine.clearMarket(marketId);
          continue;
        }
        // Condition not met this tick — reset the consecutive-tick counter
        if (this._stopConfirm.has(trade.id)) this._stopConfirm.delete(trade.id);

        // EXIT CONDITION 1b: Late stop-loss — near resolution, catastrophic loss only.
        // Previously -15%, which cut positions at near-neutral prices and let normal
        // mid-window noise trigger exits before resolution. Widened to -45% so only
        // near-total losses exit early; everything else resolves naturally.
        if (marketEndSec < 30 && pnlPct <= -45) {
          let resolvedPrice = null;
          try {
            resolvedPrice = await this._getResolutionPrice(trade.market_id, trade.token_id);
          } catch (_) {}
          const stableLive = rawLivePrice ?? livePrice;
          let stopPrice = resolvedPrice;
          // Mislabeling fix (audit 2026-07-13): a deeply-negative-PnL trigger can
          // still be sitting in queue when the market actually settles between
          // ticks — _getResolutionPrice then returns the TRUE 0/1 outcome, which
          // may be a win. That is a resolution capture, not a stop-loss; label
          // it as such so 'HARD_STOP_LOSS' always means a genuine early exit at
          // a live/entry price, never a market that resolved in our favor after
          // the stop condition fired. (Observed: doge trade closed exit=1.00
          // pnl=+2.19 logged HARD_STOP_LOSS.)
          const usedResolution = stopPrice != null && Number.isFinite(parseMoneyField(stopPrice));
          if (!usedResolution) {
            stopPrice = stableLive;
          }
          if (stopPrice == null || !Number.isFinite(parseMoneyField(stopPrice))) {
            stopPrice = parseMoneyField(trade.entry_price);
          }
          const sp = parseMoneyField(stopPrice);
          const closeReason = usedResolution ? 'LATE_STOP_RESOLVED' : 'HARD_STOP_LOSS';
          // Hold-only: LATE_STOP_RESOLVED closes at the true settlement price —
          // that's resolution, not an early exit, so it always proceeds.
          if (closeReason === 'HARD_STOP_LOSS'
              && await this._holdOnlyIntercept(trade, 'HARD_STOP_LOSS', sp)) continue;
          this._log('WARN', `🛑 Time-gated stop-loss: PnL ${pnlPct.toFixed(1)}% with ${Math.round(marketEndSec)}s remaining — closing at ${Number.isFinite(sp) ? sp.toFixed(3) : 'entry'} (${closeReason})`);
          await this._closePosition(trade, Number.isFinite(sp) ? sp : parseMoneyField(trade.entry_price), closeReason);
          this.evEngine.clearMarket(marketId);
          this.signalEngine.clearMarket(marketId);
          continue;
        }

        // EXIT CONDITION 2: PROFIT LOCK / TRAILING STOP
        // On boundary-book markets, token can swing 52¢ → 80¢+ mid-window.
        // Lock profit when:
        //   (a) PnL ≥ +35% relative AND remaining > 60s (hard profit lock)
        //   (b) trailing stop only after a larger peak, a deeper giveback, and when
        //       the remaining profit has already compressed toward flat.
        // This keeps the stop from cutting positions that are still comfortably green.
        const prevPeak = this._profitPeaks.get(trade.id) || 0;
        const newPeak = Math.max(prevPeak, pnlPct);
        this._profitPeaks.set(trade.id, newPeak);
        const peakFallback = newPeak - pnlPct;
        const PROFIT_LOCK_PCT = 35;    // lock if up 35%+ relative (e.g. 0.52 → 0.70)

        if (pnlPct >= PROFIT_LOCK_PCT && marketEndSec > 60) {
          if (await this._holdOnlyIntercept(trade, 'PROFIT_LOCK', rawLivePrice ?? livePrice)) continue;
          this._log('INFO', `💰 Profit lock: PnL=${pnlPct.toFixed(1)}% ≥ ${PROFIT_LOCK_PCT}% — selling at ${(rawLivePrice ?? livePrice).toFixed(3)}`);
          this._profitPeaks.delete(trade.id);
          await this._closePosition(trade, rawLivePrice ?? livePrice, 'PROFIT_LOCK');
          this.evEngine.clearMarket(marketId);
          this.signalEngine.clearMarket(marketId);
          continue;
        }
        if (shouldTriggerTrailingStop({ peakPnlPct: newPeak, pnlPct, marketEndSec })) {
          if (await this._holdOnlyIntercept(trade, 'TRAILING_STOP', rawLivePrice ?? livePrice)) continue;
          this._log('INFO', `📉 Trailing stop: peak=${newPeak.toFixed(1)}% fell ${peakFallback.toFixed(1)}% to ${pnlPct.toFixed(1)}% — selling at ${(rawLivePrice ?? livePrice).toFixed(3)}`);
          this._profitPeaks.delete(trade.id);
          await this._closePosition(trade, rawLivePrice ?? livePrice, 'TRAILING_STOP');
          this.evEngine.clearMarket(marketId);
          this.signalEngine.clearMarket(marketId);
          continue;
        }

        // EXIT CONDITION 4: DISABLED — NEGATIVE_EV_EXIT
        // DB analysis: 29 exits, 22 at zero P&L (price unchanged on boundary books),
        // avg hold 180s cutting trades that would have resolved naturally at 556s.
        // Binary markets resolve in ≤5 min — hold to resolution captures real edge.
        // EV oscillates on boundary books — a -8% dip is noise, not structural.
        if (false && currentEV < -8) {
          this._log('WARN', `📉 Edge gone: EV=${currentEV.toFixed(2)}% — closing`);
          await this._closePosition(trade, livePrice, 'NEGATIVE_EV_EXIT');
          this.evEngine.clearMarket(marketId);
          this.signalEngine.clearMarket(marketId);
          continue;
        }

        // Otherwise: HOLD to resolution — let the binary market expire naturally.
      }
    } catch (err) {
      this._log('ERROR', `Position management error: ${err.message}`);
    }
  }

  // Returns seconds remaining for a market.
  // Returns 0 if the market has expired (not in cache = expired and dropped from discovery).
  // Returns 300 only if marketId is null/undefined (truly unknown).
  async _getMarketRemaining(marketId) {
    if (!marketId) return 300;
    try {
      const markets = this.polymarket?.marketsCache || [];
      const m = markets.find(x => (x.id || x.condition_id) === marketId);
      if (m?.end_date_iso) {
        return Math.max(0, new Date(m.end_date_iso).getTime() / 1000 - Date.now() / 1000);
      }
      // Market not in active cache — it has expired and been dropped from discovery.
      // Return 0 so age-based stop-loss and resolution checks trigger immediately.
      return 0;
    } catch (_) {}
    return 0;
  }

  // ==========================================
  // EXIT EXECUTION LAYER — LIVE MODE
  // ==========================================
  //
  // Architecture:
  //   _closePosition()          ← called by ALL strategies (unchanged signature)
  //     ├─ paper mode           → direct DB close, synchronous (unchanged behaviour)
  //     ├─ live + EV_FLIP       → _executeLiveExitBlocking() — cascade reprice, blocking
  //     │                          (must block so _executeTrade opens opposite immediately after)
  //     └─ live + other exits   → _placeExitOrderGTC() + register in _pendingExits
  //                                _monitorPendingExits() advances them each tick
  //
  //   _monitorPendingExits()    ← called each tick from _mainLoop (Live only)
  //     ├─ filled               → _recordExitClose() → DB closed
  //     ├─ partial fill         → accept, _recordExitClose() → DB closed
  //     ├─ order cancelled      → market-resolved path OR _escalateExitToNuclear()
  //     ├─ tier timeout         → cancel + reprice 1 tick lower, up to MAX_REPRICE_ATTEMPTS
  //     └─ attempts exhausted   → _escalateExitToNuclear() → GTC at bestBid
  //
  //   _escalateExitToNuclear()  ← last resort: aggressive GTC at bestBid
  //     └─ if bestBid fails     → _recordExitClose() at last known price (DB consistency)

  /** CLOB removed the book (expired/archived market) — cannot place SELL; must settle via DB. */
  _isClobBookUnavailableError(err) {
    const msg = String(err?.message ?? err ?? '');
    return /does not exist/i.test(msg)
      || /no orderbook/i.test(msg)
      || /orderbook.*not found/i.test(msg)
      || /inactive.*market/i.test(msg);
  }

  /**
   * When the CLOB has no orderbook, pick an exit price without SELL:
   * 1) Gamma / lastTrade via _getResolutionPrice (definitive 0/1 when available)
   * 2) else mark (strategy exit price from Gamma mid / stop) — DB-only; user redeems on-chain if needed
   * Returns { price, usedSettlement } or null.
   */
  async _resolveLiveCloblessExitPrice(trade, markExitPrice) {
    let r = null;
    try {
      r = await this._getResolutionPrice(trade.market_id, trade.token_id);
    } catch (_) {}
    if (r != null && Number.isFinite(r)) {
      if (r >= 0.99) return { price: 1.0, usedSettlement: true };
      if (r <= 0.01) return { price: 0.0, usedSettlement: true };
      return { price: r, usedSettlement: true };
    }
    const mark = parseFloat(markExitPrice);
    if (Number.isFinite(mark)) {
      if (mark <= 0.001) return { price: 0.0, usedSettlement: false };
      if (mark >= 0.999) return { price: 1.0, usedSettlement: false };
      if (mark > 0.01 && mark < 0.99) return { price: mark, usedSettlement: false };
    }
    return null;
  }

  /**
   * Place a single GTC SELL order for the trade at targetPrice.
   * Returns { orderId, limitPrice } on success, throws on failure.
   * This is a fire-and-forget placement — no polling here.
   */
  async _placeExitOrderGTC(trade, targetPrice) {
    const entryPrice = parseFloat(trade.entry_price);
    const tradeSize  = parseFloat(trade.trade_size ?? trade.size);
    const shares     = tradeSize / entryPrice;
    const sellNotional = Math.max(0.01, shares * targetPrice);

    const order    = await this.polymarket.placeOrder(trade.token_id, 'SELL', sellNotional, targetPrice);
    const orderId  = order?.orderID || order?.order_id || order?.id;
    if (!orderId) throw new Error('Exit order placed but no orderId returned');
    const limitPrice = parseFloat(order.price) || targetPrice;
    this._log('INFO', `📤 [LIVE] Exit GTC #${trade.id}: order=${String(orderId).slice(0, 12)} limitPrice=${limitPrice.toFixed(3)} target=${targetPrice.toFixed(3)}`);
    return { orderId, limitPrice };
  }

  /**
   * When blocking EV_FLIP SELL cascade fails, queue the same async exit path used for
   * other live exits. `deferredFlip` on the pending row opens the opposite leg after fill.
   */
  async _queueFlipExitFallback(tradeForExit, targetPrice, flipContext) {
    const tradeId = tradeForExit.id;
    if (this._pendingExits.has(tradeId)) {
      const ex = this._pendingExits.get(tradeId);
      if (ex?.deferredFlip) {
        this._log('INFO', `[LIVE] EV_FLIP fallback already queued for #${tradeId}`);
        return;
      }
    }

    let aggressive = parseMoneyField(targetPrice);
    if (!Number.isFinite(aggressive) || aggressive < 0.01) aggressive = 0.5;

    try {
      const ob = await this.polymarket.getOrderBook(tradeForExit.token_id);
      const bb = ob?.bestBid;
      if (bb != null && Number.isFinite(parseFloat(bb)) && parseFloat(bb) > 0.01) {
        const bid = parseFloat(parseFloat(bb).toFixed(2));
        aggressive = Math.min(aggressive, bid);
        aggressive = Math.max(0.01, aggressive);
      }
    } catch (_) { /* use targetPrice */ }

    const placeQueued = async (px) => {
      const placed = await this._placeExitOrderGTC(tradeForExit, px);
      this._pendingExits.set(tradeId, {
        orderId: placed.orderId,
        trade: tradeForExit,
        targetPrice: parseMoneyField(targetPrice),
        reason: 'EV_FLIP',
        attempts: 0,
        tierStartedAt: Date.now(),
        currentOrderPrice: placed.limitPrice,
        isNuclear: false,
        deferredFlip: {
          newSignal: flipContext.newSignal,
          flipMarketKey: flipContext.flipMarketKey,
        },
      });
      this._log(
        'INFO',
        `[LIVE] EV_FLIP async exit queued #${tradeId} order=${String(placed.orderId).slice(0, 12)} price=${placed.limitPrice.toFixed(3)} (blocking cascade did not fill)`
      );
    };

    try {
      await placeQueued(aggressive);
    } catch (err1) {
      this._log('WARN', `[LIVE] EV_FLIP fallback @ ${aggressive.toFixed(3)} failed: ${err1.message} — retrying at bestBid`);
      try {
        const ob = await this.polymarket.getOrderBook(tradeForExit.token_id);
        const bestBid = ob?.bestBid;
        if (bestBid && parseFloat(bestBid) > 0.01) {
          const ap = Math.max(0.01, parseFloat(parseFloat(bestBid).toFixed(2)));
          await placeQueued(ap);
          return;
        }
      } catch (err2) {
        this._log('ERROR', `[LIVE] EV_FLIP fallback nuclear retry failed: ${err2.message}`);
      }
      throw err1;
    }
  }

  /**
   * After a deferred EV_FLIP exit is written to the DB, open the opposite leg (same as sync flip).
   */
  async _completeDeferredFlipLegIfAny(pendingExit, recordedReason) {
    const def = pendingExit?.deferredFlip;
    if (!def?.newSignal) return;
    if (!String(recordedReason || '').startsWith('EV_FLIP')) return;

    const { newSignal, flipMarketKey } = def;
    try {
      this._log('INFO', `🔄 EV_FLIP deferred: opening opposite leg after exit [${recordedReason}]`);
      this.recentFlips.push(Date.now());
      this._cleanOldFlips();
      const flipLegQueued = await this._executeTrade(newSignal, { isFlip: true });
      if (flipLegQueued && flipMarketKey) {
        this._flipCountByMarketId.set(
          flipMarketKey,
          (this._flipCountByMarketId.get(flipMarketKey) || 0) + 1
        );
      }
    } catch (e) {
      this._log('ERROR', `EV_FLIP deferred opposite leg failed: ${e.message}`);
    }
  }

  /**
   * Blocking cascade exit — used only for EV_FLIP so the new opposite position
   * can open immediately after this returns.
   *
   * Tier 0  GTC at targetPrice,          15 s
   * Tier 1  GTC at targetPrice − 0.01,   12 s
   * Tier 2  GTC at targetPrice − 0.02,   12 s
   * Tier 3  GTC at targetPrice − 0.03,   12 s
   * Nuclear GTC at bestBid (marketable),  8 s
   *
   * Returns { filled, price, filledFraction }
   */
  async _executeLiveExitBlocking(trade, targetPrice) {
    // Token worth zero — skip SELL, close at 0 immediately (no counterparty would buy)
    if (targetPrice <= 0.01) {
      this._log('INFO', `[LIVE] EV_FLIP exit price ${targetPrice.toFixed(3)} ≤ 0.01 — closing at 0 (no SELL needed)`);
      return { filled: true, price: 0.0, filledFraction: 1.0 };
    }

    const entryPrice = parseFloat(trade.entry_price);
    const tradeSize  = parseFloat(trade.trade_size ?? trade.size);
    const shares     = tradeSize / entryPrice;

    const TIER_TIMEOUTS_MS   = [15000, 12000, 12000, 12000];
    const MAX_SLIPPAGE_TICKS = 5;
    const priceFloor = Math.max(0.01, parseFloat((targetPrice - MAX_SLIPPAGE_TICKS * 0.01).toFixed(2)));

    for (let attempt = 0; attempt < 4; attempt++) {
      const repricedTarget = parseFloat(Math.max(priceFloor, targetPrice - attempt * 0.01).toFixed(2));
      const timeoutMs      = TIER_TIMEOUTS_MS[attempt];
      let orderId = null;

      try {
        const placed = await this._placeExitOrderGTC(trade, repricedTarget);
        if (!placed) break;
        orderId = placed.orderId;
        this._log('INFO', `[LIVE] EV_FLIP exit attempt ${attempt + 1}/4: order=${orderId.slice(0, 12)} price=${repricedTarget.toFixed(3)} timeout=${timeoutMs / 1000}s`);

        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
          await new Promise(r => setTimeout(r, 1000));
          const status = await this.polymarket.getOrderStatus(orderId);
          if (status?.isFilled) {
            return { filled: true, price: repricedTarget, filledFraction: 1.0 };
          }
          if (status?.isPartial && status.sizeMatched > 0) {
            try { await this.polymarket.cancelOrder(orderId); } catch (_) {}
            const filledFraction = Math.min(1.0, status.sizeMatched / (status.sizeTotal || shares));
            this._log('INFO', `📊 [LIVE] EV_FLIP partial: ${(filledFraction * 100).toFixed(0)}% @ ${repricedTarget.toFixed(3)}`);
            return { filled: true, price: repricedTarget, filledFraction };
          }
          if (status?.status === 'CANCELLED') break;
        }

        // Tier timeout — cancel and reprice
        try { await this.polymarket.cancelOrder(orderId); } catch (_) {}
        this._log('INFO', `[LIVE] EV_FLIP attempt ${attempt + 1} timed out — repricing`);
      } catch (err) {
        this._log('WARN', `[LIVE] EV_FLIP attempt ${attempt + 1} error: ${err.message}`);
        if (orderId) try { await this.polymarket.cancelOrder(orderId); } catch (_) {}
        if (this._isClobBookUnavailableError(err)) {
          const sol = await this._resolveLiveCloblessExitPrice(trade, repricedTarget);
          if (sol) {
            this._log('INFO', `[LIVE] EV_FLIP exit without CLOB book #${trade.id} @ ${sol.price} (${sol.usedSettlement ? 'settlement' : 'mark'})`);
            return { filled: true, price: sol.price, filledFraction: 1.0 };
          }
        }
      }

      if (repricedTarget <= priceFloor) break; // don't go below slippage floor
    }

    // Nuclear: GTC at bestBid (marketable — fills if bid exists at that price)
    try {
      this._log('WARN', `[LIVE] EV_FLIP nuclear: aggressive GTC at bestBid for #${trade.id}`);
      const ob = await this.polymarket.getOrderBook(trade.token_id);
      const bestBid = ob?.bestBid;
      if (bestBid && bestBid > 0.01) {
        const aggressivePrice = Math.max(0.01, parseFloat(bestBid.toFixed(2)));
        const placed = await this._placeExitOrderGTC(trade, aggressivePrice);
        if (placed) {
          const startedAt = Date.now();
          while (Date.now() - startedAt < 8000) {
            await new Promise(r => setTimeout(r, 1000));
            const s = await this.polymarket.getOrderStatus(placed.orderId);
            if (s?.isFilled) return { filled: true, price: aggressivePrice, filledFraction: 1.0 };
            if (s?.isPartial && s.sizeMatched > 0) {
              try { await this.polymarket.cancelOrder(placed.orderId); } catch (_) {}
              const filledFraction = Math.min(1.0, s.sizeMatched / (s.sizeTotal || shares));
              return { filled: true, price: aggressivePrice, filledFraction };
            }
            if (s?.status === 'CANCELLED') break;
          }
          try { await this.polymarket.cancelOrder(placed.orderId); } catch (_) {}
        }
      }
    } catch (_) {}

    const noBookSol = await this._resolveLiveCloblessExitPrice(trade, targetPrice);
    if (noBookSol) {
      this._log('INFO', `[LIVE] EV_FLIP exit without CLOB (cascade exhausted) #${trade.id} @ ${noBookSol.price}`);
      return { filled: true, price: noBookSol.price, filledFraction: 1.0 };
    }

    this._log('ERROR', `[LIVE] EV_FLIP cascade exhausted for #${trade.id} — exit failed`);
    return { filled: false };
  }

  /**
   * Parse entry + USD notional for exits. Fills missing/zero trade_size with a bounded
   * minimum (never $0) when entry price is valid — pairs with _recordFilledTrade guards.
   */
  _normalizeCloseSizing(trade) {
    const entryPrice = parseMoneyField(trade.entry_price);
    let tradeSize = parseMoneyField(trade.trade_size ?? trade.size);
    const maxSz = Math.max(1, parseMoneyField(this.settings?.max_trade_size) || 5);
    let salvaged = false;
    if ((!Number.isFinite(tradeSize) || tradeSize <= 0) && Number.isFinite(entryPrice) && entryPrice > 0) {
      tradeSize = Math.min(maxSz, Math.max(1, entryPrice));
      salvaged = true;
    }
    const tradeForExit = salvaged ? { ...trade, trade_size: tradeSize, size: tradeSize } : trade;
    return { entryPrice, tradeSize, tradeForExit, salvaged };
  }

  /**
   * Write a confirmed exit to the database. Used by both the EV_FLIP blocking path
   * and the async _monitorPendingExits path.
   *
   * filledFraction: 1.0 for full fills, <1.0 for partial fills (remaining tokens forfeit).
   * For partial fills PnL = (filledFraction × shares × exitPrice) - tradeSize.
   * This is conservative — unmatched portion's residual value is absorbed into P&L.
   */
  async _recordExitClose(trade, exitPrice, reason, filledFraction = 1.0) {
    try {
      const { entryPrice, tradeSize, salvaged } = this._normalizeCloseSizing(trade);
      if (salvaged) {
        try {
          await pool.query('UPDATE trades SET trade_size=$1, size=$1 WHERE id=$2', [tradeSize, trade.id]);
        } catch (_) {}
        this._log('WARN', `_recordExitClose: patched zero/missing trade_size on #${trade.id} → $${tradeSize.toFixed(2)}`);
      }

      if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(tradeSize) || tradeSize <= 0) {
        this._log('ERROR', `_recordExitClose: invalid trade data #${trade.id} (entry=${entryPrice}, size=${tradeSize})`);
        const flatPx = parseMoneyField(exitPrice);
        try {
          await pool.query(
            `UPDATE trades SET status='closed', exit_price=$1, pnl=0, close_reason=$2, result='LOSS', closed_at=NOW() WHERE id=$3`,
            [Number.isFinite(flatPx) ? flatPx : 0.5, reason, trade.id]
          );
        } catch (_) {}
        return;
      }

      // exitPrice=0.0 (NO-win) is falsy — use null-coalescing, not || fallback
      const ex = parseMoneyField(exitPrice);
      const effectiveExit = (exitPrice != null && Number.isFinite(ex))
        ? ex
        : entryPrice;

      const shares   = tradeSize / entryPrice;
      // filledFraction < 1.0: sold only part of position; remaining tokens untracked
      const proceeds = shares * filledFraction * effectiveExit;
      const grossPnl = proceeds - tradeSize;
      const resolvesWithoutExit = /RESOLVED/.test(String(reason || ''))
        || effectiveExit <= 0.001 || effectiveExit >= 0.999;
      const fee = this._paperTradeFees(
        shares,
        entryPrice,
        resolvesWithoutExit ? null : effectiveExit,
        shares * filledFraction
      );
      const finalPnl = grossPnl - fee;

      if (!isFinite(finalPnl) || isNaN(finalPnl)) {
        this._log('ERROR', `_recordExitClose: invalid PnL for #${trade.id} (entry=${entryPrice}, exit=${effectiveExit}, fraction=${filledFraction})`);
        return;
      }

      // exit_price stored as effective per-share return so UI P&L display is consistent
      const storedExitPrice = proceeds / shares; // = filledFraction × effectiveExit

      this._log('INFO', `📊 PnL reconcile #${trade.id}: entry=${entryPrice.toFixed(4)} exit=${effectiveExit.toFixed(4)} filled=${(filledFraction * 100).toFixed(0)}% shares=${shares.toFixed(2)} gross=$${grossPnl.toFixed(4)} fee=$${fee.toFixed(4)} net=$${finalPnl.toFixed(4)} reason=${reason}`);

      const result = finalPnl >= 0 ? 'WIN' : 'LOSS';
      const upd = await pool.query(`
        UPDATE trades SET status = 'closed', exit_price = $1, pnl = $2, close_reason = $3, result = $4, closed_at = NOW()
        WHERE id = $5
      `, [storedExitPrice, finalPnl, reason, result, trade.id]);

      this._log('INFO', `✅ Closed #${trade.id} ${trade.direction} [${reason}] entry=${entryPrice.toFixed(3)} exit=${effectiveExit.toFixed(3)} filled=${(filledFraction * 100).toFixed(0)}% size=$${tradeSize.toFixed(2)} gross=$${grossPnl.toFixed(2)} fee=$${fee.toFixed(2)} net=$${finalPnl.toFixed(2)} (${((finalPnl / tradeSize) * 100).toFixed(1)}%)`);
      if (upd.rowCount > 0) {
        await this._applyBalancesAfterClose(trade, tradeSize, finalPnl, result);
        this._policyOnMarketClosed(trade, reason);
        if (!trade.is_virtual && this.virtualLoss?.armed && result === 'WIN') {
          this._log('INFO', '🧠 Virtual Loss reset — need virtual losses again before next real entry');
        }
      }
    } catch (err) {
      this._log('ERROR', `_recordExitClose failed for #${trade.id}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Main exit decision point — called by all strategy exit triggers.
   * Signature is identical for paper and live; behaviour diverges internally.
   *
   * Paper:        direct DB close, synchronous (unchanged from original)
   * Live EV_FLIP: _executeLiveExitBlocking — cascade reprice, blocks tick so opposite
   *               position can open immediately after this returns
   * Live other:   _placeExitOrderGTC → register in _pendingExits → return immediately;
   *               _monitorPendingExits() handles retry / reprice / nuclear on next ticks
   */
  /**
   * exits_hold_only_mode (2026-07-13, operator-approved experiment): the
   * counterfactual data proved every early-exit mechanism loses to holding in
   * a 5-minute binary (stops -$61.95, locks -$113.95, flips -$2.43/trade vs
   * hold, on the same trades). When the flag is ON, exit triggers do NOT
   * close the position — they record the would-be exit ONCE (first trigger,
   * matching what the old behavior would have done) and the position rides
   * to resolution. Pre-registered read at n>=150 recorded would-exits:
   * bootstrap CI of (actual_pnl - would_exit_pnl); CI>0 -> keep, CI<0 -> revert.
   * Returns true if intercepted (caller must NOT close), false to proceed.
   */
  async _holdOnlyIntercept(trade, reason, exitPrice) {
    if (this.settings.exits_hold_only_mode !== true) return false;
    if (!this._wouldExitRecorded) this._wouldExitRecorded = new Set();
    if (this._wouldExitRecorded.has(trade.id)) return true; // already recorded first trigger
    this._wouldExitRecorded.add(trade.id);
    if (this._wouldExitRecorded.size > 500) {
      // bounded memory; DB guard (would_exit_reason IS NULL) is the backstop
      this._wouldExitRecorded = new Set([...this._wouldExitRecorded].slice(-200));
    }
    try {
      const entryPrice = parseMoneyField(trade.entry_price);
      const tradeSize = parseMoneyField(trade.trade_size) || parseMoneyField(trade.size);
      let px = parseMoneyField(exitPrice);
      if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(tradeSize) || tradeSize <= 0 || !Number.isFinite(px)) {
        this._log('WARN', `[HOLD-ONLY] #${trade.id} ${reason} triggered but sizing unusable — logged without pnl`);
        await pool.query(
          `UPDATE trades SET would_exit_reason=$1, would_exit_at=NOW() WHERE id=$2 AND would_exit_reason IS NULL`,
          [reason, trade.id]);
        return true;
      }
      // Faithful to the real exit path: same haircut and entry+exit taker fees.
      const isTerminal = px <= 0.001 || px >= 0.999;
      if (!isTerminal) {
        const hc = parseInt(this.settings.paper_exit_haircut_ticks, 10);
        const ticks = Number.isFinite(hc) && hc >= 0 ? hc : 1;
        px = Math.max(0, parseFloat((px - ticks * 0.01).toFixed(4)));
      }
      const shares = tradeSize / entryPrice;
      const gross = shares * px - tradeSize;
      const fee = this._paperTradeFees(shares, entryPrice, isTerminal ? null : px);
      const wouldPnl = parseFloat((gross - fee).toFixed(4));
      await pool.query(
        `UPDATE trades SET would_exit_reason=$1, would_exit_price=$2, would_exit_pnl=$3, would_exit_at=NOW()
         WHERE id=$4 AND would_exit_reason IS NULL`,
        [reason, px, wouldPnl, trade.id]);
      this._log('INFO', `🧪 [HOLD-ONLY] #${trade.id} ${reason} would have exited @ ${px.toFixed(3)} (pnl $${wouldPnl.toFixed(2)}) — holding to resolution instead`);
    } catch (err) {
      this._log('WARN', `[HOLD-ONLY] record failed for #${trade.id}: ${err.message}`);
    }
    return true;
  }

  async _closePosition(trade, exitPrice, reason, flipContext = null) {
    try {
      const { entryPrice, tradeSize, tradeForExit, salvaged } = this._normalizeCloseSizing(trade);
      if (salvaged) {
        try {
          await pool.query('UPDATE trades SET trade_size=$1, size=$1 WHERE id=$2', [tradeSize, trade.id]);
        } catch (_) {}
        this._log('WARN', `Trade #${trade.id}: recovered missing/zero trade_size → $${tradeSize.toFixed(2)} for exit`);
      }

      let effectiveExit = parseMoneyField(exitPrice);
      if (exitPrice == null || !Number.isFinite(effectiveExit)) {
        effectiveExit = Number.isFinite(entryPrice) ? entryPrice : 0.5;
      }
      if (!Number.isFinite(effectiveExit)) effectiveExit = 0.5;

      const brokenSizing =
        !Number.isFinite(entryPrice) || entryPrice <= 0 ||
        !Number.isFinite(tradeSize) || tradeSize <= 0 ||
        !Number.isFinite(effectiveExit);

      const isVirtualTrade = trade.is_virtual === true;
      // Paper or virtual (live virtual = DB-only close, no CLOB SELL)
      if (this.settings.paper_trading !== false || isVirtualTrade) {
        // Exit-side realism (audit Phase 2.1): a real SELL crosses the spread down,
        // but paper exits previously closed at the mid/Gamma mark — optimistic on
        // every non-terminal exit. Haircut paper_exit_haircut_ticks (default 1)
        // from stop/lock/flip exits. Terminal resolutions settle exactly at 0/1
        // and administrative closes must not be distorted.
        const reasonStr = String(reason || '');
        const isAdministrative = /RESOLVED|LEGACY|DUPLICATE|DATA_ERROR/.test(reasonStr);
        const isTerminalPrice = effectiveExit <= 0.001 || effectiveExit >= 0.999;
        if (!isAdministrative && !isTerminalPrice) {
          const haircutRaw = parseInt(this.settings.paper_exit_haircut_ticks, 10);
          const haircutTicks = Number.isFinite(haircutRaw) && haircutRaw >= 0 ? haircutRaw : 1;
          if (haircutTicks > 0) {
            const before = effectiveExit;
            effectiveExit = Math.max(0, parseFloat((effectiveExit - haircutTicks * 0.01).toFixed(4)));
            this._log('INFO', `[PAPER] Exit haircut: ${before.toFixed(3)} → ${effectiveExit.toFixed(3)} (−${haircutTicks} tick(s), reason=${reasonStr})`);
          }
        }
        if (brokenSizing) {
          this._log('WARN', `Trade ${trade.id} unrecoverable sizing (entry=${entryPrice}, size=${tradeSize}, exit=${effectiveExit}) — closing flat`);
          await pool.query(
            `UPDATE trades SET status='closed', exit_price=$1, pnl=0, close_reason=$2, result='LOSS', closed_at=NOW() WHERE id=$3`,
            [Number.isFinite(effectiveExit) ? effectiveExit : 0.5, reason, trade.id]
          );
          return false;
        }

        const shares   = tradeSize / entryPrice;
        const grossPnl = shares * effectiveExit - tradeSize;
        const resolvesWithoutExit = /RESOLVED/.test(reasonStr) || isTerminalPrice;
        const fee = this._paperTradeFees(
          shares,
          entryPrice,
          resolvesWithoutExit ? null : effectiveExit
        );
        const pnl      = grossPnl - fee;

        if (!isFinite(pnl) || isNaN(pnl)) {
          this._log('ERROR', `Invalid PnL=${pnl} (entry=${entryPrice}, exit=${effectiveExit}, size=${tradeSize}) — skipping close`);
          return false;
        }

        // PnL reconciliation log — always emit so every close is auditable
        this._log('INFO', `📊 PnL reconcile #${trade.id}: entry=${entryPrice.toFixed(4)} exit=${effectiveExit.toFixed(4)} shares=${shares.toFixed(2)} gross=$${grossPnl.toFixed(4)} fee=$${fee.toFixed(4)} net=$${pnl.toFixed(4)} reason=${reason}`);

        const result = pnl >= 0 ? 'WIN' : 'LOSS';
        const paperUpd = await pool.query(`
          UPDATE trades SET status = 'closed', exit_price = $1, pnl = $2, close_reason = $3, result = $4, closed_at = NOW()
          WHERE id = $5
        `, [effectiveExit, pnl, reason, result, trade.id]);

        await this._applyBalancesAfterClose(trade, tradeSize, pnl, result);

        const modeTag = isVirtualTrade ? 'VIRTUAL' : 'PAPER';
        this._log('INFO', `✅ [${modeTag}] Closed #${trade.id} ${trade.direction} [${reason}] entry=${entryPrice.toFixed(3)} exit=${effectiveExit.toFixed(3)} size=$${tradeSize.toFixed(2)} gross=$${grossPnl.toFixed(2)} fee=$${fee.toFixed(2)} net=$${pnl.toFixed(2)} (${((pnl / tradeSize) * 100).toFixed(1)}%)`);
        if (isVirtualTrade && this.virtualLoss?.enabled) {
          const st = this.virtualLoss.getStatus();
          if (st.armed) {
            this._log('INFO', `🧠 Virtual Loss ARMED — next entries are REAL until 1 win`);
          } else if (result === 'LOSS') {
            this._log('INFO', `🧠 Virtual Loss: ${st.count}/${st.required} virtual losses (${st.lossesUntilArm} until arm)`);
          }
        }
        if (paperUpd.rowCount > 0) this._policyOnMarketClosed(trade, reason);
        return true;
      }

      // ── LIVE MODE: dedup guard ────────────────────────────────────────────────
      if (this._closingTrades.has(trade.id)) {
        this._log('INFO', `[LIVE] Close already in progress for #${trade.id} — skipping duplicate close`);
        return false;
      }
      this._closingTrades.add(trade.id);

      if (brokenSizing) {
        this._log('WARN', `[LIVE] Trade ${trade.id} unrecoverable sizing — closing flat`);
        await pool.query(
          `UPDATE trades SET status='closed', exit_price=$1, pnl=0, close_reason=$2, result='LOSS', closed_at=NOW() WHERE id=$3`,
          [Number.isFinite(effectiveExit) ? effectiveExit : 0.5, reason, trade.id]
        );
        this._closingTrades.delete(trade.id);
        return false;
      }

      // No token_id — can't place a SELL order; just close DB (legacy trade)
      if (!tradeForExit.token_id) {
        this._log('WARN', `[LIVE] Trade #${trade.id} has no token_id — closing DB record without SELL order`);
        await this._recordExitClose(tradeForExit, effectiveExit, reason, 1.0);
        this._closingTrades.delete(trade.id);
        return true;
      }

      // ── EV_FLIP: blocking cascade so opposite position opens immediately after ──
      if (reason === 'EV_FLIP') {
        try {
          const liveExit = await this._executeLiveExitBlocking(tradeForExit, effectiveExit);
          if (!liveExit?.filled) {
            if (flipContext?.newSignal) {
              try {
                await this._queueFlipExitFallback(tradeForExit, effectiveExit, flipContext);
                return 'deferred';
              } catch (qErr) {
                this._log('ERROR', `[LIVE] EV_FLIP async queue failed: ${qErr.message}`);
                return false;
              }
            }
            this._log('WARN', `[LIVE] EV_FLIP exit not filled for #${trade.id} — no flipContext for async retry`);
            return false;
          }
          await this._recordExitClose(tradeForExit, liveExit.price, reason, liveExit.filledFraction ?? 1.0);
          return true;
        } catch (liveErr) {
          this._log('WARN', `[LIVE] EV_FLIP exit failed for #${trade.id}: ${liveErr.message}. Trade remains open.`);
          return false;
        } finally {
          this._closingTrades.delete(trade.id);
        }
      }

      // ── Binary resolution (MARKET_RESOLVED*): outcome is $1 or $0 per share. CLOB limit prices must be
      //     in [0.01, 0.99] — SELL @ 1.00 rejects with "invalid price (1)". Close DB at true settlement;
      //     tokens are settled via redeem (Polymarket UI / on-chain), not an impossible limit order.
      const isResolutionReason =
        reason === 'MARKET_RESOLVED' || reason === 'MARKET_RESOLVED_TIMEOUT';
      const isBinaryTerminal = effectiveExit >= 0.999 || effectiveExit <= 0.001;
      if (isResolutionReason && isBinaryTerminal) {
        const resPx = effectiveExit >= 0.5 ? 1.0 : 0.0;
        this._log(
          'INFO',
          `[LIVE] Resolution settlement #${trade.id} [${reason}] @ ${resPx} — DB only (CLOB max 0.99)`
        );
        await this._recordExitClose(tradeForExit, resPx, reason, 1.0);
        this._closingTrades.delete(trade.id);
        return true;
      }

      // ── All other exits: async via _pendingExits ──────────────────────────────
      // Place first GTC order and return immediately. _monitorPendingExits() will
      // advance the cascade (reprice / nuclear / DB close) on subsequent ticks.
      try {
        const placed = await this._placeExitOrderGTC(tradeForExit, effectiveExit);
        this._pendingExits.set(trade.id, {
          orderId:           placed.orderId,
          trade:               tradeForExit,
          targetPrice:       effectiveExit,
          reason,
          attempts:          0,
          tierStartedAt:     Date.now(),
          currentOrderPrice: placed.limitPrice,
          isNuclear:         false,
        });
        this._log('INFO', `📋 [LIVE] Exit queued #${trade.id} [${reason}] order=${placed.orderId.slice(0, 12)} price=${placed.limitPrice.toFixed(3)}`);
        // _closingTrades entry stays until _monitorPendingExits resolves this exit
        return true;
      } catch (err) {
        this._log('WARN', `[LIVE] Initial exit placement failed #${trade.id} [${reason}]: ${err.message}`);
        this._closingTrades.delete(trade.id);
        return false;
      }

    } catch (err) {
      this._log('ERROR', `Close position failed: ${err.message}`);
      // Belt-and-suspenders cleanup so _closingTrades never leaks
      this._closingTrades.delete(trade.id);
      return false;
    }
  }

  /**
   * Per-tick monitor for all pending Live exit orders (non-EV_FLIP).
   * Called at the top of _mainLoop before signal evaluation.
   *
   * State machine per pending exit:
   *   MATCHED        → _recordExitClose → done
   *   partial fill   → accept, _recordExitClose → done
   *   CANCELLED      → if market-resolved: close at resolution; else escalate to nuclear
   *   LIVE + tier OK → wait (nothing to do)
   *   LIVE + timeout → cancel + reprice 1 tick lower (up to MAX_REPRICE_ATTEMPTS)
   *   attempts done  → _escalateExitToNuclear (GTC at bestBid)
   *   nuclear timeout→ force DB close at last known price
   */
  async _monitorPendingExits() {
    if (this._pendingExits.size === 0) return;

    const TIER_TIMEOUT_MS      = 15000; // wait 15 s per reprice tier
    const MAX_REPRICE_ATTEMPTS = 4;     // 4 reprices before nuclear
    const MAX_SLIPPAGE_TICKS   = 5;     // max price walk = 5 ticks = $0.05

    for (const [tradeId, pendingExit] of this._pendingExits) {
      try {
        const { orderId, trade, targetPrice, reason, attempts, tierStartedAt, currentOrderPrice } = pendingExit;

        const status = await this.polymarket.getOrderStatus(orderId);

        // ── FILLED ────────────────────────────────────────────────────────────
        if (status?.isFilled) {
          this._log('INFO', `✅ [LIVE] Exit filled #${trade.id} [${reason}] @ ${currentOrderPrice.toFixed(3)}`);
          await this._recordExitClose(trade, currentOrderPrice, reason, 1.0);
          await this._completeDeferredFlipLegIfAny(pendingExit, reason);
          this._pendingExits.delete(tradeId);
          this._closingTrades.delete(trade.id);
          continue;
        }

        // ── PARTIAL FILL ──────────────────────────────────────────────────────
        if (status?.isPartial && status.sizeMatched > 0) {
          try { await this.polymarket.cancelOrder(orderId); } catch (_) {}
          const entryPrice = parseFloat(trade.entry_price);
          const tradeSize  = parseFloat(trade.trade_size ?? trade.size);
          const shares     = tradeSize / entryPrice;
          const filledFraction = Math.min(1.0, status.sizeMatched / (status.sizeTotal || shares));
          this._log('INFO', `📊 [LIVE] Exit partial fill #${trade.id} [${reason}]: ${(filledFraction * 100).toFixed(0)}% @ ${currentOrderPrice.toFixed(3)} — closing position`);
          await this._recordExitClose(trade, currentOrderPrice, reason, filledFraction);
          await this._completeDeferredFlipLegIfAny(pendingExit, reason);
          this._pendingExits.delete(tradeId);
          this._closingTrades.delete(trade.id);
          continue;
        }

        // ── CANCELLED ─────────────────────────────────────────────────────────
        if (status?.status === 'CANCELLED') {
          // Try resolution price first (market may have resolved and auto-cancelled the order)
          const resolvedAt = await this._getResolutionPrice(trade.market_id, trade.token_id);
          if (resolvedAt !== null) {
            this._log('INFO', `[LIVE] Exit order market-cancelled #${trade.id} — resolved at ${resolvedAt.toFixed(3)}`);
            await this._recordExitClose(trade, resolvedAt, reason, 1.0);
            await this._completeDeferredFlipLegIfAny(pendingExit, reason);
            this._pendingExits.delete(tradeId);
            this._closingTrades.delete(trade.id);
          } else {
            // Unexpected cancel (e.g. external cancel via UI) — escalate to nuclear
            this._log('WARN', `[LIVE] Exit order cancelled unexpectedly #${trade.id} [${reason}] — escalating`);
            await this._escalateExitToNuclear(tradeId, pendingExit);
          }
          continue;
        }

        // ── getOrderStatus returned null (API error) ──────────────────────────
        if (status === null) {
          // Transient API error — wait for next tick; don't act on missing data
          continue;
        }

        // ── STILL RESTING (LIVE) — check tier timeout ─────────────────────────
        const tierAge = Date.now() - tierStartedAt;
        if (tierAge < TIER_TIMEOUT_MS) continue; // still within current tier — wait

        // Tier expired: cancel current order, then reprice or escalate
        try { await this.polymarket.cancelOrder(orderId); } catch (_) {}

        // Nuclear order also timed out → force DB close
        if (pendingExit.isNuclear) {
          this._log('ERROR', `[LIVE] Nuclear exit timed out #${trade.id} [${reason}] — forcing DB close @ ${currentOrderPrice.toFixed(3)}`);
          const forceReason = `${reason}_FORCE`;
          await this._recordExitClose(trade, currentOrderPrice, forceReason, 1.0);
          await this._completeDeferredFlipLegIfAny(pendingExit, forceReason);
          this._pendingExits.delete(tradeId);
          this._closingTrades.delete(trade.id);
          continue;
        }

        const priceFloor  = Math.max(0.01, parseFloat((targetPrice - MAX_SLIPPAGE_TICKS * 0.01).toFixed(2)));
        const nextPrice   = parseFloat(Math.max(priceFloor, currentOrderPrice - 0.01).toFixed(2));

        if (attempts >= MAX_REPRICE_ATTEMPTS || nextPrice <= priceFloor) {
          await this._escalateExitToNuclear(tradeId, pendingExit);
        } else {
          // Reprice down 1 tick
          try {
            const placed = await this._placeExitOrderGTC(trade, nextPrice);
            this._log('INFO', `[LIVE] Exit repriced #${trade.id} [${reason}] attempt ${attempts + 1}: ${currentOrderPrice.toFixed(3)} → ${nextPrice.toFixed(3)}`);
            pendingExit.orderId           = placed.orderId;
            pendingExit.currentOrderPrice = nextPrice;
            pendingExit.attempts          = attempts + 1;
            pendingExit.tierStartedAt     = Date.now();
          } catch (err) {
            this._log('WARN', `[LIVE] Exit reprice failed #${trade.id}: ${err.message} — escalating`);
            await this._escalateExitToNuclear(tradeId, pendingExit);
          }
        }

      } catch (err) {
        this._log('ERROR', `[LIVE] _monitorPendingExits error trade ${tradeId}: ${err.message}`);
      }
    }
  }

  /**
   * Last-resort exit: place a GTC SELL at the current bestBid (marketable order —
   * a SELL at or below the best bid fills immediately if liquidity exists).
   * If no bid or order fails, force-writes DB close at last known price to maintain
   * DB consistency (untracked tokens remain in wallet).
   */
  async _escalateExitToNuclear(tradeId, pendingExit) {
    const { trade, reason, currentOrderPrice } = pendingExit;
    this._log('WARN', `[LIVE] 🚨 Nuclear exit #${trade.id} [${reason}] — aggressive GTC at bestBid`);

    try {
      const ob      = await this.polymarket.getOrderBook(trade.token_id);
      const bestBid = ob?.bestBid;

      if (bestBid && bestBid > 0.01) {
        const aggressivePrice = Math.max(0.01, parseFloat(bestBid.toFixed(2)));
        const placed = await this._placeExitOrderGTC(trade, aggressivePrice);
        this._log('INFO', `[LIVE] Nuclear GTC placed #${trade.id}: order=${placed.orderId.slice(0, 12)} price=${aggressivePrice.toFixed(3)}`);
        // Let _monitorPendingExits handle this on the next tick; mark as nuclear
        pendingExit.orderId           = placed.orderId;
        pendingExit.currentOrderPrice = aggressivePrice;
        pendingExit.attempts         += 1;
        pendingExit.tierStartedAt     = Date.now();
        pendingExit.isNuclear         = true;
        return; // will be evaluated on the next tick
      }
    } catch (err) {
      this._log('WARN', `[LIVE] Nuclear order failed #${trade.id}: ${err.message}`);
    }

    // No bid available or placement failed — force DB close at last known price.
    // Untracked tokens (if any) remain in the Polymarket wallet.
    this._log('ERROR', `[LIVE] All exit attempts exhausted #${trade.id} [${reason}] — forcing DB close @ ${currentOrderPrice.toFixed(3)}`);
    try {
      const forceReason = `${reason}_FORCE`;
      await this._recordExitClose(trade, currentOrderPrice, forceReason, 1.0);
      await this._completeDeferredFlipLegIfAny(pendingExit, forceReason);
    } catch (_) {}
    this._pendingExits.delete(tradeId);
    this._closingTrades.delete(trade.id);
  }

  /**
   * Query Gamma API for the definitive market resolution price for a token.
   * Returns 0.99 (token won) or 0.01 (token lost), or null if market not yet resolved.
   * Polymarket CLOB books drain to empty at resolution — can't rely on cached order book prices.
   */
  async _getResolutionPrice(marketId, tokenId) {
    try {
      const r = await axios.get(`https://gamma-api.polymarket.com/markets/${marketId}`, { timeout: 5000 });
      const m = r.data;
      if (!m) return null;

      // outcomePrices: '["1","0"]' = YES won, '["0","1"]' = NO won
      let outcomePrices = m.outcomePrices;
      if (typeof outcomePrices === 'string') {
        try { outcomePrices = JSON.parse(outcomePrices); } catch (_) { outcomePrices = null; }
      }

      // clobTokenIds[0] = YES token, [1] = NO token
      let clobIds = m.clobTokenIds;
      if (typeof clobIds === 'string') {
        try { clobIds = JSON.parse(clobIds); } catch (_) { clobIds = null; }
      }

      if (Array.isArray(outcomePrices) && outcomePrices.length >= 2) {
        const yesPrice0 = parseFloat(outcomePrices[0]);
        // Only trust a clear winner: ≥0.9 = YES won, ≤0.1 = NO won
        // Avoid 0.5/0.5 which means UMA hasn't resolved yet (challenge period)
        if (yesPrice0 >= 0.9) {
          const isYesToken = clobIds?.[0] === tokenId;
          const isNoToken  = clobIds?.[1] === tokenId;
          if (isYesToken) return 1.0;
          if (isNoToken)  return 0.0;
        } else if (yesPrice0 <= 0.1) {
          const isYesToken = clobIds?.[0] === tokenId;
          const isNoToken  = clobIds?.[1] === tokenId;
          if (isYesToken) return 0.0;
          if (isNoToken)  return 1.0;
        }
      }

      // Gamma is ambiguous (outcomePrices=[0.5,0.5] during UMA challenge period).
      // Fall back to CLOB lastTradePrice — at settlement, the last trade IS the settlement price.
      // If the last trade was 0.99 or 0.01, the market has effectively resolved.
      if (tokenId && this.polymarket) {
        try {
          const lastPrice = await this.polymarket.getLastTradePrice(tokenId);
          if (lastPrice != null) {
            if (lastPrice >= 0.90) return 1.0;
            if (lastPrice <= 0.10) return 0.0;
          }
        } catch (_) {}
      }

      return null; // truly ambiguous — market still settling
    } catch (err) {
      this._log('WARN', `Gamma resolution lookup failed for ${marketId}: ${err.message}`);
      return null;
    }
  }

  // ==========================================
  // STOP/LOCK COUNTERFACTUAL EVALUATOR (audit 2026-07-13)
  // ==========================================

  /**
   * Runs every 2 minutes. For trades closed via HARD_STOP_LOSS,
   * LATE_STOP_RESOLVED, or PROFIT_LOCK, fetches the market's actual
   * resolution and records what holding to resolution would have paid,
   * using the same entry_price/trade_size/fee formula as the real close.
   * Pure measurement: never fed back into any trading decision.
   */
  async _evaluateStopCounterfactuals() {
    try {
      const pending = await pool.query(`
        SELECT id, market_id, token_id, direction, entry_price, trade_size, close_reason
        FROM trades
        WHERE user_id = $1
          AND status = 'closed'
          AND close_reason IN ('HARD_STOP_LOSS', 'LATE_STOP_RESOLVED', 'PROFIT_LOCK')
          AND counterfactual_evaluated_at IS NULL
          AND closed_at < NOW() - INTERVAL '6 minutes'
        ORDER BY closed_at ASC
        LIMIT 20
      `, [this.userId]);

      if (pending.rowCount === 0) return;

      for (const row of pending.rows) {
        try {
          const resolvedPrice = await this._getResolutionPrice(row.market_id, row.token_id);
          if (resolvedPrice == null) continue; // not resolved yet — retry next cycle

          const entryPrice = parseMoneyField(row.entry_price);
          const tradeSize = parseMoneyField(row.trade_size);
          if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(tradeSize) || tradeSize <= 0) {
            await pool.query(
              `UPDATE trades SET counterfactual_evaluated_at = NOW() WHERE id = $1`, [row.id]
            );
            continue;
          }
          const shares = tradeSize / entryPrice;
          const grossPnl = shares * resolvedPrice - tradeSize;
          const fee = this._paperTradeFees(shares, entryPrice);
          const counterfactualPnl = grossPnl - fee;

          await pool.query(`
            UPDATE trades
            SET counterfactual_resolution_price = $1, counterfactual_pnl = $2, counterfactual_evaluated_at = NOW()
            WHERE id = $3
          `, [resolvedPrice, parseFloat(counterfactualPnl.toFixed(4)), row.id]);
        } catch (err) {
          this._log('WARN', `Counterfactual eval failed for trade #${row.id}: ${err.message}`);
        }
      }
    } catch (err) {
      this._log('WARN', `_evaluateStopCounterfactuals error: ${err.message}`);
    }
  }

  // ==========================================
  // SKIP ANALYSIS — RESOLUTION EVALUATOR
  // ==========================================

  /**
   * Runs every 2 minutes. Finds skipped_signals that haven't been evaluated yet,
   * queries Gamma for resolution, and fills in would_win / sim_pnl.
   * Only evaluates markets that are old enough to have resolved (> 6 min since skip).
   */
  async _evaluateSkippedSignals() {
    try {
      const pending = await pool.query(`
        SELECT id, market_id, direction, entry_price, ev_adj
        FROM skipped_signals
        WHERE user_id = $1
          AND evaluated_at IS NULL
          AND direction IS NOT NULL
          AND entry_price IS NOT NULL
          AND created_at < NOW() - INTERVAL '6 minutes'
        LIMIT 20
      `, [this.userId]);

      if (pending.rowCount === 0) return;

      for (const row of pending.rows) {
        try {
          const r = await axios.get(`https://gamma-api.polymarket.com/markets/${row.market_id}`, { timeout: 4000 });
          const m = r.data;
          if (!m || (!m.closed && !m.resolved)) {
            // Not resolved yet — skip for now, will retry next cycle
            continue;
          }

          let outcomePrices = m.outcomePrices;
          if (typeof outcomePrices === 'string') {
            try { outcomePrices = JSON.parse(outcomePrices); } catch (_) { continue; }
          }
          if (!Array.isArray(outcomePrices) || outcomePrices.length < 2) continue;

          const yesResolved = parseFloat(outcomePrices[0]); // 1=YES won, 0=YES lost
          const resolvedPrice = row.direction === 'YES' ? yesResolved : (1 - yesResolved);
          // resolvedPrice: ~1 = token won, ~0 = token lost

          const entryPrice = parseFloat(row.entry_price);
          const tradeSize = 10; // simulate a standard $10 trade
          const shares = tradeSize / entryPrice;
          const grossPnl = shares * resolvedPrice - tradeSize;
          const fee = this._paperTradeFees(shares, entryPrice);
          const simPnl = grossPnl - fee;
          const wouldWin = simPnl > 0;

          await pool.query(`
            UPDATE skipped_signals
            SET resolved_price=$1, would_win=$2, sim_pnl=$3, evaluated_at=NOW()
            WHERE id=$4
          `, [resolvedPrice, wouldWin, parseFloat(simPnl.toFixed(4)), row.id]);
        } catch (_) {
          // Network error for this market — mark as evaluated with nulls so we don't retry forever
          await pool.query(`UPDATE skipped_signals SET evaluated_at=NOW() WHERE id=$1`, [row.id]).catch(() => {});
        }
      }
    } catch (err) {
      // Non-critical background job — log but never throw
      this._log('WARN', `[SkipEval] Error: ${err.message}`);
    }
  }

  // ==========================================
  // TRADING SESSION LIFECYCLE
  // ==========================================

  async _startSession() {
    try {
      // 1. Close any lingering open trades from a previous session.
      // Try to resolve each one at its actual market resolution price before falling back
      // to entry_price (which produces fake $0.00 P&L and distorts stats).
      const lingering = await pool.query(
        "SELECT id, market_id, token_id, entry_price, trade_size, direction, created_at FROM trades WHERE user_id=$1 AND status='open'",
        [this.userId]
      );
      if (lingering.rowCount > 0) {
        this._log('INFO', `🔄 Session reset: checking ${lingering.rowCount} lingering trade(s) from previous session`);
        for (const t of lingering.rows) {
          // First try to resolve at the actual market outcome
          let resolvedPrice = null;
          try {
            resolvedPrice = await this._getResolutionPrice(t.market_id, t.token_id);
          } catch (_) {}

          if (resolvedPrice != null) {
            // Market has resolved — close with real P&L
            const exitPrice = resolvedPrice;
            const tradeSize = parseFloat(t.trade_size);
            const entryPrice = parseFloat(t.entry_price);
            const pnl = isFinite(exitPrice) && isFinite(entryPrice) && entryPrice > 0
              ? (tradeSize / entryPrice) * exitPrice - tradeSize
              : 0;
            const result = pnl > 0 ? 'WIN' : 'LOSS';
            await pool.query(
              `UPDATE trades SET status='closed', close_reason=$1, exit_price=$2, pnl=$3, result=$4, closed_at=NOW() WHERE id=$5`,
              ['SESSION_RESET_RESOLVED', exitPrice, pnl, result, t.id]
            );
            this._log('INFO', `  └─ #${t.id} ${t.direction} entry=${entryPrice.toFixed(3)} exit=${exitPrice.toFixed(3)} pnl=$${pnl.toFixed(2)} [SESSION_RESET_RESOLVED]`);
          } else {
            // Market still live — re-adopt this trade into the new session (don't close it)
            // Update session_id so it belongs to this session, leave status='open'
            this._log('INFO', `  └─ #${t.id} ${t.direction} market still live — re-adopting into new session`);
            // (session_id update happens after session is created — handled below)
          }
        }
      }

      // 2. Clear in-memory state
      this._pendingOrders.clear();

      // 3. Determine initial balance
      const isPaper = this.settings.paper_trading !== false;
      let initialBalance = isPaper
        ? (this.paperBalance || parseFloat(this.settings.paper_balance) || 500)
        : (await this._getLiveBalance() || 0);

      // 4. Create session record
      const result = await pool.query(
        `INSERT INTO trading_sessions (user_id, paper_trading, initial_balance) VALUES ($1, $2, $3) RETURNING id`,
        [this.userId, isPaper, initialBalance]
      );
      this.sessionId = result.rows[0].id;
      this._log('INFO', `🟢 Session #${this.sessionId} started — ${isPaper ? 'PAPER' : 'LIVE'} — balance: $${initialBalance.toFixed(2)}`);

      // Re-adopt still-live trades into this session (don't re-close them)
      await pool.query(
        `UPDATE trades SET session_id=$1 WHERE user_id=$2 AND status='open' AND session_id IS DISTINCT FROM $1`,
        [this.sessionId, this.userId]
      );

      // Dedup: if more than one open trade exists for the same market, close the extras.
      // Keep the oldest (lowest id) — it has the most accurate entry price.
      // Duplicates can accumulate when re-entrance guard wasn't in place.
      const dups = await pool.query(`
        SELECT market_id, COUNT(*) as cnt, MIN(id) as keep_id
        FROM trades WHERE user_id=$1 AND status='open'
        GROUP BY market_id HAVING COUNT(*) > 1
      `, [this.userId]);
      for (const row of dups.rows) {
        const closed = await pool.query(
          `UPDATE trades SET status='closed', close_reason='DUPLICATE_DEDUP', exit_price=entry_price, pnl=0, result=NULL, closed_at=NOW()
           WHERE user_id=$1 AND status='open' AND market_id=$2 AND id != $3 RETURNING id`,
          [this.userId, row.market_id, row.keep_id]
        );
        if (closed.rowCount > 0) {
          this._log('WARN', `  🗑️ Deduped ${closed.rowCount} extra open position(s) in market ${row.market_id} — kept #${row.keep_id}`);
        }
      }
    } catch (err) {
      this._log('WARN', `Session start failed: ${err.message} — trades will have null session_id`);
      this.sessionId = null;
    }
  }

  async _endSession() {
    if (!this.sessionId) return;
    try {
      const stats = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status='closed') AS total_trades,
          COUNT(*) FILTER (WHERE status='closed' AND pnl > 0) AS wins,
          COUNT(*) FILTER (WHERE status='closed' AND pnl <= 0) AS losses,
          COALESCE(SUM(pnl) FILTER (WHERE status='closed'), 0) AS total_pnl
        FROM trades WHERE user_id=$1 AND session_id=$2
      `, [this.userId, this.sessionId]);

      const s = stats.rows[0];
      const total = parseInt(s.total_trades) || 0;
      const wins = parseInt(s.wins) || 0;
      const winRate = total > 0 ? parseFloat((wins / total * 100).toFixed(2)) : 0;

      const isPaper = this.settings.paper_trading !== false;
      const finalBalance = isPaper
        ? this.paperBalance
        : (await this._getLiveBalance().catch(() => null));

      await pool.query(`
        UPDATE trading_sessions
        SET ended_at=NOW(), final_balance=$1, total_trades=$2, wins=$3, losses=$4, total_pnl=$5, win_rate=$6
        WHERE id=$7
      `, [finalBalance, total, wins, parseInt(s.losses) || 0, parseFloat(s.total_pnl), winRate, this.sessionId]);

      this._log('INFO', `🔴 Session #${this.sessionId} ended — ${total} trades, PnL: $${parseFloat(s.total_pnl).toFixed(2)}, Win rate: ${winRate}%`);
      this.sessionId = null;
    } catch (err) {
      this._log('WARN', `Session end save failed: ${err.message}`);
    }
  }

  // ==========================================
  // SLIPPAGE TRACKING
  // ==========================================

  _recordSlippage(expectedPrice, actualPrice) {
    const slippage = {
      expected: expectedPrice,
      actual: actualPrice,
      difference: actualPrice - expectedPrice,
      pct: ((actualPrice - expectedPrice) / expectedPrice) * 100,
      timestamp: Date.now()
    };

    this.slippageHistory.push(slippage);

    // Keep last 100 entries
    if (this.slippageHistory.length > 100) {
      this.slippageHistory.shift();
    }
  }

  getAverageSlippage() {
    if (this.slippageHistory.length === 0) return 0;
    const sum = this.slippageHistory.reduce((acc, s) => acc + Math.abs(s.pct), 0);
    return sum / this.slippageHistory.length;
  }

  // ==========================================
  // RISK MANAGEMENT
  // ==========================================

  async _checkDrawdownCircuitBreaker() {
    if (this.settings.paper_trading !== false && !this.paperRiskLimitsEnabled) {
      this.drawdownCooldownUntil = null;
      return true;
    }
    if (this.drawdownCooldownUntil && Date.now() < this.drawdownCooldownUntil) {
      const remaining = Math.ceil((this.drawdownCooldownUntil - Date.now()) / 60000);
      this._log('WARN', `Drawdown cooldown: ${remaining}min remaining`);
      return false;
    }

    if (this.drawdownCooldownUntil && Date.now() >= this.drawdownCooldownUntil) {
      this.drawdownCooldownUntil = null;
      this._log('INFO', 'Drawdown cooldown expired. Resuming.');
    }

    const currentBalance = this.settings.paper_trading ? this.paperBalance : await this._getLiveBalance();

    if (this.peakBalance === null || currentBalance > this.peakBalance) {
      this.peakBalance = currentBalance;
    }

    if (this.peakBalance > 0) {
      const drawdownUsd = this.peakBalance - currentBalance;
      const drawdownPct = ((this.peakBalance - currentBalance) / this.peakBalance) * 100;
      const maxDrawdownPct = parseFloat(this.settings.max_drawdown_pct) || 15;
      const portfolioHalt = this.portfolioPolicy
        && drawdownUsd >= this.portfolioPolicy.hardDrawdownUsd;

      if (drawdownPct >= maxDrawdownPct || portfolioHalt) {
        const reason = portfolioHalt
          ? `$${drawdownUsd.toFixed(2)} >= portfolio $${this.portfolioPolicy.hardDrawdownUsd.toFixed(2)}`
          : `${drawdownPct.toFixed(1)}% >= ${maxDrawdownPct}%`;
        this._log('CRITICAL', `🛑 DRAWDOWN BREAKER: ${reason}. 1hr cooldown.`);
        this.drawdownCooldownUntil = Date.now() + (60 * 60 * 1000);
        return false;
      }
    }

    return true;
  }

  /**
   * Daily loss circuit breaker (24h ROLLING window, not calendar day — documented).
   *
   * Accumulator rules (audit fix — see AUDIT.md §2.3):
   *  - scoped to the CURRENT mode: paper counts SIMULATED closes, live counts LIVE.
   *    Previously paper/live/virtual PnL were summed in one bucket, so virtual or
   *    other-mode wins could mask real losses.
   *  - is_virtual trades never count: they are training-wheel simulations.
   *  - includes UNREALIZED mark-to-market of open positions (price cache when
   *    available). With max_trade_size ($100) larger than the loss budget ($50), a
   *    single open trade can blow through the limit before any close is recorded —
   *    realized-only accounting is structurally blind to that.
   *  - fail-CLOSED: if the query errors, entries halt. A risk check that fails open
   *    is not a risk check.
   *  - emits ONE CRITICAL halt line on transition (WARN per tick while halted).
   */
  async _checkDailyLossLimit() {
    if (this.settings.paper_trading !== false && !this.paperRiskLimitsEnabled) {
      if (!this._paperUnlimitedLogged) {
        this._paperUnlimitedLogged = true;
        this._log('INFO', '🧪 PAPER RESEARCH: balance, daily-loss, drawdown, exposure, concurrency and cooldown cutoffs disabled; live risk rails remain enforced');
      }
      this._dailyLossHaltedAt = null;
      return false;
    }
    if (this.settings.override_daily_loss && !this.portfolioPolicy) {
      // Operator kill switch. Honor it, but never silently: a disabled loss limit
      // must be visible in the log stream (rate-limited to once per 10 min).
      if (!this._overrideWarnAt || Date.now() - this._overrideWarnAt > 600000) {
        this._overrideWarnAt = Date.now();
        this._log('WARN', '⚠️ override_daily_loss=true — daily loss limit is DISABLED by operator setting');
      }
      return false;
    }
    if (this.settings.override_daily_loss && this.portfolioPolicy
        && (!this._overrideWarnAt || Date.now() - this._overrideWarnAt > 600000)) {
      this._overrideWarnAt = Date.now();
      this._log('WARN', `⚠️ override_daily_loss=true — configured limit bypassed, but the candidate portfolio $${this.portfolioPolicy.dailyLossUsd.toFixed(2)} rail remains enforced`);
    }
    try {
      const mdlRaw = parseFloat(this.settings.max_daily_loss);
      const configuredDailyLoss = Number.isFinite(mdlRaw) ? Math.abs(mdlRaw) : 50;
      const maxDailyLoss = this.portfolioPolicy
        ? Math.min(configuredDailyLoss, this.portfolioPolicy.dailyLossUsd)
        : configuredDailyLoss;
      const isPaper = this.settings.paper_trading !== false;
      const execType = isPaper ? 'SIMULATED' : 'LIVE';
      const riskFloor = riskWindowFloor(
        Date.now(),
        isPaper ? this.settings.paper_risk_epoch_anchor : null,
      );

      const realizedQ = await pool.query(`
        SELECT COALESCE(SUM(pnl), 0) AS daily_pnl
        FROM trades
        WHERE user_id = $1 AND status = 'closed'
          AND closed_at > $3
          AND COALESCE(is_virtual, false) = false
          AND COALESCE(execution_type, 'LIVE') = $2
      `, [this.userId, execType, riskFloor]);
      const realizedPnl = parseFloat(realizedQ.rows[0].daily_pnl) || 0;

      // Unrealized: mark open positions to the freshest cached price. A market with no
      // cached price contributes 0 (realized-only) rather than worst-case, so a cache
      // miss can't spuriously halt trading.
      let unrealizedPnl = 0;
      const openQ = await pool.query(`
        SELECT market_id, direction, entry_price, trade_size
        FROM trades
        WHERE user_id = $1 AND status = 'open' AND COALESCE(is_virtual, false) = false
          AND COALESCE(execution_type, 'LIVE') = $2
      `, [this.userId, execType]);
      for (const t of openQ.rows) {
        const entry = parseMoneyField(t.entry_price);
        const size = parseMoneyField(t.trade_size);
        const cached = this.signalEngine?._priceCache?.get(t.market_id);
        const yes = cached?.rawPrice ?? cached?.smoothedPrice;
        if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(size) || yes == null) continue;
        const tokenPrice = t.direction === 'NO' ? 1 - yes : yes;
        unrealizedPnl += (size / entry) * tokenPrice - size;
      }

      const dailyPnl = realizedPnl + unrealizedPnl;

      if (dailyPnl <= -maxDailyLoss) {
        if (!this._dailyLossHaltedAt) {
          this._dailyLossHaltedAt = Date.now();
          this._log('CRITICAL', `🛑 DAILY LOSS HALT: realized since ${riskFloor.toISOString()} $${realizedPnl.toFixed(2)} + unrealized $${unrealizedPnl.toFixed(2)} = $${dailyPnl.toFixed(2)} ≤ -$${maxDailyLoss.toFixed(2)} (${execType}). New entries blocked until the risk window recovers.`);
        } else {
          this._log('WARN', `Daily loss halt active: $${dailyPnl.toFixed(2)} ≤ -$${maxDailyLoss.toFixed(2)} (halted ${Math.round((Date.now() - this._dailyLossHaltedAt) / 60000)}min ago)`);
        }
        return true;
      }
      if (this._dailyLossHaltedAt) {
        this._log('INFO', `Daily loss halt lifted: 24h PnL $${dailyPnl.toFixed(2)} back above -$${maxDailyLoss.toFixed(2)}`);
        this._dailyLossHaltedAt = null;
      }
      return false;
    } catch (err) {
      this._log('ERROR', `Daily loss check failed (${err.message}) — failing CLOSED, entries blocked this tick`);
      return true;
    }
  }

  async _getLiveBalance() {
    // Cache balance for 60s — no need to hit RPC on every 10s tick
    if (this._balanceCache && (Date.now() - this._balanceCache.ts) < 60000) {
      return this._balanceCache.value;
    }
    try {
      if (this.settings.polymarket_wallet_address) {
        const { ethers } = require('ethers');
        const walletAddress = this.settings.polymarket_wallet_address;
        const privateKey = this.settings.encrypted_private_key ? decrypt(this.settings.encrypted_private_key) : null;
        const signatureType = this.settings.signature_type || 'EOA';
        const configuredFunder = this.settings.funder_address || null;

        // Resolve possible proxy wallet (V2 accounts may fund via proxy/deposit wallet).
        let proxyWallet = null;
        try {
          const profileUrl = `https://gamma-api.polymarket.com/public-profile?address=${encodeURIComponent(walletAddress)}`;
          const profileRes = await fetch(profileUrl, { signal: AbortSignal.timeout(5000) });
          if (profileRes.ok) {
            const profile = await profileRes.json();
            const p = profile?.proxyWallet;
            if (p && /^0x[a-fA-F0-9]{40}$/.test(p)) proxyWallet = p;
          }
        } catch (_) {}

        const walletsToCheck = [...new Set([walletAddress, proxyWallet].filter(Boolean))];
        // staticNetwork skips ethers v6 background network-detection retries (stops log spam)
        const POLYGON = ethers.Network.from(137);
        const rpcs = [
          process.env.POLYGON_RPC_URL,
          'https://polygon-bor-rpc.publicnode.com',
          'https://1rpc.io/matic',
          'https://polygon.drpc.org',
        ].filter(Boolean);
        const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];
        const TOKENS = [
          // V2 collateral token + legacy balances
          { addr: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB', decimals: 6 }, // pUSD
          { addr: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 }, // USDC
          { addr: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', decimals: 6 }, // USDC.e
        ];

        let best = null;
        for (const w of walletsToCheck) {
          let onchain = null;
          for (const rpc of rpcs) {
            try {
              const provider = new ethers.JsonRpcProvider(rpc, POLYGON, { staticNetwork: POLYGON });
              let total = 0;
              let anyRead = false;
              for (const t of TOKENS) {
                try {
                  const token = new ethers.Contract(t.addr, ERC20_ABI, provider);
                  const raw = await Promise.race([
                    token.balanceOf(w),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
                  ]);
                  anyRead = true;
                  total += parseFloat(ethers.formatUnits(raw, t.decimals));
                } catch (_) {}
              }
              if (anyRead) {
                onchain = parseFloat(total.toFixed(4));
                break;
              }
            } catch (_) { continue; }
          }

          let clob = null;
          if (privateKey) {
            try {
              const bal = await PolymarketFeed.fetchBalance(
                privateKey,
                w,
                signatureType,
                configuredFunder || w
              );
              const parsed = parseFloat(bal?.usdc);
              if (Number.isFinite(parsed)) clob = parsed;
            } catch (_) {}
          }

          const hasAny = onchain !== null || clob !== null;
          const candidate = hasAny ? Math.max(onchain ?? 0, clob ?? 0) : null;
          if (candidate !== null && (best === null || candidate > best)) {
            best = candidate;
          }
        }

        if (best !== null) {
          this._balanceCache = { value: best, ts: Date.now() };
          return best;
        }
      }
    } catch (err) {
      this._log('ERROR', `Live balance fetch failed: ${err.message}`);
    }
    return 0;
  }

  // ==========================================
  // ADAPTIVE KELLY
  // ==========================================

  // Compute optimal kelly fraction from last N closed trades.
  // Uses half-Kelly with a 25% hard cap for safety.
  // Returns null if insufficient trade history (< 10 trades).
  async _computeAdaptiveKelly() {
    try {
      const result = await pool.query(`
        SELECT pnl, result, trade_size
        FROM trades
        WHERE user_id = $1 AND result IN ('WIN', 'LOSS') AND pnl IS NOT NULL AND trade_size IS NOT NULL
        ORDER BY closed_at DESC LIMIT 50
      `, [this.userId]);

      const trades = result.rows;
      if (trades.length < 10) return null; // not enough data

      const wins = trades.filter(t => t.result === 'WIN');
      const losses = trades.filter(t => t.result === 'LOSS');
      const winRate = wins.length / trades.length;

      const avgWin = wins.length > 0
        ? wins.reduce((s, t) => s + Math.abs(parseFloat(t.pnl)) / parseFloat(t.trade_size), 0) / wins.length
        : 0;
      const avgLoss = losses.length > 0
        ? losses.reduce((s, t) => s + Math.abs(parseFloat(t.pnl)) / parseFloat(t.trade_size), 0) / losses.length
        : 1;

      if (avgLoss === 0 || avgWin === 0) return null;

      // Full Kelly: W/L - (1-W) where W=winRate, b=avgWin/avgLoss
      const b = avgWin / avgLoss;
      const fullKelly = (winRate * b - (1 - winRate)) / b;

      if (fullKelly <= 0) return 0.05; // losing strategy → minimum sizing

      // Half-Kelly for safety, capped at 25%
      const halfKelly = Math.min(fullKelly * 0.5, 0.25);
      // Floor at 5% — always allocate something if kelly is positive
      return Math.max(halfKelly, 0.05);
    } catch (err) {
      this._log('WARN', `Adaptive kelly computation failed: ${err.message}`);
      return null;
    }
  }

  // ==========================================
  // HELPERS
  // ==========================================

  async _waitForPrice(timeoutMs) {
    const start = Date.now();
    while (!this.binance.getPrice()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('Timed out waiting for BTC price');
      }
      await new Promise(r => setTimeout(r, 500));
    }
    this._log('INFO', `BTC price: $${this.binance.getPrice().toLocaleString()}`);
  }

  _log(level, message) {
    const entry = { timestamp: new Date().toISOString(), level, message, userId: this.userId };
    console.log(`[${this.userLabel}] [${level}] ${message}`);
    this.decisionLog.push(entry);
    if (this.decisionLog.length > this.maxLogEntries) this.decisionLog.shift();
  }

  async _logSignal(signal) {
    if (!signal?.log) return;
    if (!this.userId) {
      console.error('[SignalLog ERROR] Missing userId — cannot persist signal');
      return;
    }
    // Write all signals including summary SKIPs — the decision stream needs live data.

    try {
      const gates = signal.log?.gates || {};

      // Gate failure code mapping — includes all known pre-filters and gates
      let gateFailed = null;
      if (signal.verdict === 'SKIP') {
        if (gates.btcFlat        && !gates.btcFlat.passed)        gateFailed = 0.1;
        else if (gates.freshness     && !gates.freshness.passed)      gateFailed = 0.2;
        else if (gates.chase         && !gates.chase.passed)          gateFailed = 0.3;
        else if (gates.evTrend       && !gates.evTrend.passed)        gateFailed = 0.4;
        else if (gates.neutralBlock  && !gates.neutralBlock.passed)   gateFailed = 0.5;
        else if (gates.scenarioFilter && !gates.scenarioFilter.passed) gateFailed = 0.6;
        else if (gates.boundaryBook  && !gates.boundaryBook.passed)   gateFailed = 0.7;
        else if (gates.gate1         && !gates.gate1.passed)          gateFailed = 1;
        else if (gates.gate2         && !gates.gate2.passed)          gateFailed = 2;
        else if (gates.gate3         && !gates.gate3.passed)          gateFailed = 3;
      }

      const evAdjLogged  = signal.evAdj     ?? gates.gate2?.evReal ?? null;
      const spreadLogged = signal.orderBook?.spread ?? gates.gate2?.spread ?? null;
      const lagLogged    = gates.freshness?.lagAge != null ? Math.round(gates.freshness.lagAge) : null;

      console.log('[SignalLog ATTEMPT]', {
        verdict: signal.verdict,
        marketId: signal.marketId || null,
        gateFailed,
        evAdj: evAdjLogged,
        lag: lagLogged,
        spread: spreadLogged
      });

      const marketId = signal.market?.id || signal.marketId || null;
      const marketQuestion = signal.market?.question || null;

      // Decision-stream dedupe (audit §2.5): the engine re-emits TRADE for the same
      // market every tick while execution is blocked (one-position rule, 90s cooldown,
      // held position). Historical data: up to 31 identical TRADE rows per market in
      // 5 min. One row per market per 60s carries all the information — execution can
      // never fire faster than that anyway (90s post-attempt cooldown).
      if (signal.verdict === 'TRADE' && marketId != null) {
        if (!this._tradeLogAt) this._tradeLogAt = new Map();
        const key = String(marketId);
        const last = this._tradeLogAt.get(key) || 0;
        if (Date.now() - last < 60000) return;
        this._tradeLogAt.set(key, Date.now());
        if (this._tradeLogAt.size > 200) {
          const cutoff = Date.now() - 600000;
          for (const [k, ts] of this._tradeLogAt) if (ts < cutoff) this._tradeLogAt.delete(k);
        }
      }

      const lg = signal.log || {};
      const modelProbLogged = (Number.isFinite(signal.modelProb)
        ? signal.modelProb : gates.gate2?.modelProb) ?? null;
      const challenger = MainModelChallenger.evaluate({
        marketProbability: lg.yesPrice,
        legacyProbability: modelProbLogged,
        heuristicProbability: lg.ensemble?.pHeur,
        phiProbability: lg.ensemble?.pPhi,
        remainingSec: gates.timeGate?.remaining ?? gates.gate2?.remaining,
        sigma5min: lg.phi?.sigma5min,
      }, new Date());
      await pool.query(`
        INSERT INTO signals (user_id, market_id, market_question, verdict, reason, direction, confidence, ev_raw, ev_adj, ema_edge, gate1_passed, gate2_passed, gate3_passed, gate_failed, lag_age_sec, spread_pct, scenario,
          model_prob, p_phi, p_heur, btc_edge, micro_edge, ensemble_delta, yes_price, sigma_5min, sigma_source, oracle_divergence_bps, remaining_sec, btc_price, chainlink_price, poly_yes_price, poly_no_price, asset,
          model_challenger_experiment_id, model_challenger_evidence_eligible,
          market_baseline_prob, residual_prob, residual_model_version)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
          $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33,
          $34, $35, $36, $37, $38)
      `, [
        this.userId,
        marketId,
        marketQuestion,
        signal.verdict,
        lg.reason || '',
        signal.direction || null,
        signal.confidence || null,
        signal.evRaw     || null,
        evAdjLogged,
        signal.emaEdge   || null,
        gates.gate1?.passed ?? false,
        gates.gate2?.passed ?? false,
        gates.gate3?.passed ?? false,
        gateFailed,
        lagLogged,
        spreadLogged,
        lg.scenario || null,
        // Edge decomposition (audit Phase 3.3) — null-safe, 0 is a real value
        modelProbLogged,
        lg.ensemble?.pPhi ?? null,
        lg.ensemble?.pHeur ?? null,
        lg.edgeComponents?.btcEdge ?? null,
        lg.edgeComponents?.microEdge ?? null,
        lg.ensemble?.delta ?? null,
        lg.yesPrice ?? null,
        lg.phi?.sigma5min ?? null,
        lg.phi?.sigmaSource ?? null,
        lg.oracleDivergenceBps ?? null,
        gates.timeGate?.remaining ?? gates.gate2?.remaining ?? null,
        lg.btcPrice ?? null,
        lg.chainlinkPrice ?? null,
        lg.polyYesPrice ?? null,
        lg.polyNoPrice ?? null,
        signal.market?.asset ?? 'btc',
        challenger?.experimentId ?? null,
        challenger?.evidenceEligible ?? false,
        challenger?.marketBaselineProbability ?? null,
        challenger?.residualProbability ?? null,
        challenger?.residualModelVersion ?? null
      ]);

      // Store skipped signals with enough context for post-hoc analysis.
      // Only record when we have a market + direction + entry price — otherwise there's
      // nothing to evaluate against resolution.
      if (signal.verdict === 'SKIP' && marketId && signal.log?.yesPrice != null) {
        const skipReason = signal.log?.skipDetail || (gateFailed != null ? `gate_${gateFailed}` : 'unknown');
        // Direction fallback (audit 2026-07-13): early gates (neutralBlock,
        // scenarioFilter, gate1) skip before a direction exists, so 1,364
        // historical skips had direction=NULL and the counterfactual
        // evaluator could score NONE of them — the gate autopsy dataset was
        // empty. Fall back to the p_heur-implied side so every skip with a
        // price becomes evaluable. Pure measurement; feeds future gate
        // tuning with actual would-win data.
        const pHeurImplied = (signal.log?.ensemble?.pHeur != null && signal.log?.yesPrice != null)
          ? (signal.log.ensemble.pHeur > signal.log.yesPrice ? 'YES' : 'NO') : null;
        const direction = gates.gate2?.bestDirection || signal.direction || pHeurImplied;
        const entryPrice = direction === 'NO'
          ? (1 - signal.log.yesPrice)
          : signal.log.yesPrice;

        // Only record once per market per skip-reason per 30s window to avoid flooding
        pool.query(`
          INSERT INTO skipped_signals
            (user_id, market_id, market_question, skip_reason, skip_detail, direction, entry_price,
             ev_adj, confidence, btc_delta, remaining_sec, scenario, asset)
          SELECT $1::int, $2::varchar, $3::text, $4::varchar, $5::text, $6::varchar,
                 $7::numeric, $8::numeric, $9::numeric, $10::numeric, $11::int, $12::varchar, $13::text
          WHERE NOT EXISTS (
            SELECT 1 FROM skipped_signals
            WHERE user_id=$1 AND market_id=$2 AND skip_reason=$4
              AND created_at > NOW() - INTERVAL '30 seconds'
          )
        `, [
          this.userId,
          marketId,
          marketQuestion,
          skipReason,
          signal.log?.reason?.slice(0, 200) || null,
          direction,
          entryPrice,
          evAdjLogged,
          signal.confidence || gates.gate1?.confidence || null,
          signal.log?.btcDelta != null ? parseFloat(signal.log.btcDelta.toFixed(5)) : null,
          gates.timeGate?.remaining != null ? Math.round(gates.timeGate.remaining) : null,
          signal.log?.scenario || null,
          signal.market?.asset || 'btc'
        ]).catch(() => {}); // fire-and-forget, never block main flow
      }
    } catch (err) {
      console.error('[SignalLog ERROR]', {
        message: err.message,
        stack: err.stack,
        signal: { verdict: signal?.verdict, marketId: signal?.marketId, hasLog: !!signal?.log }
      });
    }
  }

  // ==========================================
  // REAL-TIME STATE BROADCAST (SSE)
  // ==========================================

  /**
   * Async 1s loop — fetches YES/NO order books for active markets.
   * Results stored in _lastOrderBooks so _broadcastState() can include them
   * without awaiting (keeps the 200ms broadcast synchronous).
   */
  async _fetchActiveOrderBooks() {
    if (!this.isRunning || !this.polymarket) return;
    try {
      // Refresh markets list every 30s so token prices stay current after market rotation
      const cacheAge = this.polymarket.lastMarketFetch ? Date.now() - this.polymarket.lastMarketFetch : Infinity;
      if (cacheAge > 25000) {
        await this.polymarket.fetchActiveBTCMarkets();
      }
      const markets = this.polymarket.marketsCache || [];
      for (const m of markets) {
        let clobIds = m.clobTokenIds || [];
        if (typeof clobIds === 'string') { try { clobIds = JSON.parse(clobIds); } catch (_) { clobIds = []; } }
        const yesId = m.tokens?.[0]?.token_id || clobIds[0];
        const noId  = m.tokens?.[1]?.token_id || clobIds[1];
        if (yesId) {
          const book = await this.polymarket.getOrderBook(yesId);
          if (book) this._lastOrderBooks[yesId] = book;
        }
        if (noId && noId !== yesId) {
          const book = await this.polymarket.getOrderBook(noId);
          if (book) this._lastOrderBooks[noId] = book;
        }
      }
    } catch (_) {}
  }

  /**
   * Builds and emits a lightweight state snapshot every 200ms.
   * SSE clients in bot.js subscribe to streamEmitter 'state' events.
   * Does NOT block the main loop — synchronous reads only.
   */
  _broadcastState() {
    if (!this.isRunning) return;
    try {
      const btcPrice  = this.binance?.getPrice() || null;
      const btcDelta  = btcPrice ? this.binance.getWindowDeltaScore(30) : null;
      const btcImbal  = btcPrice ? this.binance.getOrderBookImbalance() : null;

      // Markets from polymarket cache + last fetched order books (no awaits)
      const markets = (this.polymarket?.marketsCache || []).map(m => {
        let clobIds = m.clobTokenIds || [];
        if (typeof clobIds === 'string') { try { clobIds = JSON.parse(clobIds); } catch (_) { clobIds = []; } }
        const yesId  = m.tokens?.[0]?.token_id || clobIds[0];
        const noId   = m.tokens?.[1]?.token_id || clobIds[1];
        const yesBook = yesId ? this._lastOrderBooks[yesId] : null;
        const noBook  = noId  ? this._lastOrderBooks[noId]  : null;

        // Price from signal engine's per-tick live cache (freshest source).
        // _priceCache is updated every tick via getLivePriceFromGamma() — never stale.
        // Fall back to cached outcomePrices only if engine hasn't evaluated this market yet.
        const marketId = m.id || m.condition_id;
        const cachedEnginePrice = this.signalEngine?._priceCache?.get(marketId);
        let gammaYes = cachedEnginePrice?.smoothedPrice ?? null;
        let gammaNo  = gammaYes != null ? (1 - gammaYes) : null;
        if (gammaYes == null) {
          let op = m.outcomePrices;
          if (typeof op === 'string') { try { op = JSON.parse(op); } catch (_) { op = null; } }
          gammaYes = op ? parseFloat(op[0]) : null;
          gammaNo  = op ? parseFloat(op[1]) : null;
        }

        const clobSpread = yesBook?.spread ?? null;
        const isBoundary = clobSpread == null || clobSpread >= 0.90;

        // yesBid/yesAsk are the actual Polymarket order book prices (match what UI shows)
        // If CLOB is boundary-only, fall back to Gamma price for display
        return {
          id:         marketId,
          question:   m.question,
          endIso:     m.end_date_iso,
          startIso:   m.start_date_iso,
          yesPrice:   isBoundary ? (gammaYes ?? yesBook?.midPrice ?? null) : (yesBook?.midPrice ?? null),
          noPrice:    isBoundary ? (gammaNo  ?? noBook?.midPrice  ?? null) : (noBook?.midPrice  ?? null),
          yesBid:     yesBook?.bestBid   ?? null,
          yesAsk:     yesBook?.bestAsk   ?? null,
          noBid:      noBook?.bestBid    ?? null,
          noAsk:      noBook?.bestAsk    ?? null,
          spread:     clobSpread,
          bidDepth:   yesBook?.bidDepth  ?? null,
          askDepth:   yesBook?.askDepth  ?? null,
          isBoundary,
          gammaYes,
          gammaNo,
        };
      });

      // Sort markets: most interesting first (furthest from 0.5 = most resolved/active)
      markets.sort((a, b) => {
        const aPrice = a.yesPrice ?? 0.5;
        const bPrice = b.yesPrice ?? 0.5;
        return Math.abs(bPrice - 0.5) - Math.abs(aPrice - 0.5);
      });

      // EV stats per market from signal engine
      const evStats = {};
      for (const mkt of markets) {
        if (!mkt.id) continue;
        const stats = this.evEngine.getEVStats(mkt.id);
        if (stats.currentEV !== null) evStats[mkt.id] = stats;
      }

      const state = {
        ts:          Date.now(),
        btcPrice,
        btcDelta,
        btcImbalance: btcImbal,
        markets,
        evStats,
        paperTrading: this.settings.paper_trading !== false,
        paperBalance: this.paperBalance,
        dryPaperBalance: this.paperBalance,
        liveBalance: this.settings.paper_trading === false ? (this._balanceCache?.value ?? null) : null,
        virtualPaperBalance: this.virtualPaperBalance,
        virtualLoss: this.virtualLoss ? this.virtualLoss.getStatus() : null,
        peakBalance:  this.peakBalance,
        isRunning:    this.isRunning,
        flipCount:    this.recentFlips.length,
        drawdownActive: !!(this.drawdownCooldownUntil && Date.now() < this.drawdownCooldownUntil),
      };

      this._lastStreamState = state;
      this.streamEmitter.emit('state', state);
    } catch (err) {
      // Never crash main bot from broadcast errors
    }
  }

  getStatus() {
    // Summarise pending orders for dashboard display
    const pendingOrders = [...this._pendingOrders.values()].map(p => ({
      orderId: p.orderId.slice(0, 16),
      direction: p.direction,
      limitPrice: p.limitPrice,
      referencePrice: p.referencePrice,
      dollarSize: p.dollarSize,
      isPaper: p.isPaper,
      ageMs: Date.now() - p.placedAt,
      lastCheckedPrice: p.lastCheckedPrice
    }));

    return {
      isRunning: this.isRunning,
      userId: this.userId,
      paperTrading: this.settings.paper_trading,
      paperBalance: this.paperBalance,
      dryPaperBalance: this.paperBalance,
      liveBalance: this.settings.paper_trading === false ? (this._balanceCache?.value ?? null) : null,
      virtualPaperBalance: this.virtualPaperBalance,
      virtualLoss: this.virtualLoss ? this.virtualLoss.getStatus() : null,
      peakBalance: this.peakBalance,
      btcPrice: this.binance?.getPrice() || null,
      chainlinkPrice: this.chainlink?.getPrice() || null,
      flipCount: this.recentFlips.length,
      avgSlippage: this.getAverageSlippage(),
      drawdownCooldownUntil: this.drawdownCooldownUntil,
      dailyLossHalted: !!this._dailyLossHaltedAt,
      paperRiskEpochAnchor: this.settings.paper_risk_epoch_anchor || null,
      paperRiskLimitsEnabled: this.paperRiskLimitsEnabled,
      mainLegacyExecutionEnabled: this.settings.main_legacy_execution_enabled === true,
      unboundedPaperResearch: this._isUnboundedPaperResearch(),
      recentLogs: this.decisionLog.slice(-20),
      lastStreamState: this._lastStreamState,
      pendingOrders,
    };
  }
}

module.exports = BotInstance;
