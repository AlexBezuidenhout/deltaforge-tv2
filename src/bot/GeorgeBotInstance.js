/**
 * GeorgeBotInstance — legacy Chainlink-mainnet evaluator retained for
 * telemetry. Its own/resurrection entry hypotheses are retired because
 * Polymarket crypto resolution uses Chainlink Data Streams, not this push
 * feed. Correctly sourced resolver research lives in BORG H48/H49.
 *
 * Deliberately minimal so the split test isolates SIGNAL quality:
 *   - Legacy own/resurrection entries are suppressed before _openPosition.
 *   - FLAT STAKE (george_trade_size, default $10). Kelly sizing on an unvalidated
 *     model confounds signal quality with sizing luck; flat stakes make win rate
 *     and PnL directly interpretable.
 *   - HOLD TO RESOLUTION. No stops, no flips, no profit locks. Every exit is the
 *     market's terminal 0/1 (or a timeout force-close, flagged). Exit policy is the
 *     main bot's experiment; George measures whether the model picks the right side.
 *   - Pessimistic fills: entry at Gamma price + 2 ticks; current crypto taker
 *     curve charged on the entry fill.
 *   - Own tables (george_trades / george_signals): zero interference with the main
 *     bot's one-position and daily-loss queries.
 *
 * Risk: one open position at a time, one cycle per market, george_max_daily_loss
 * (24h rolling realized, fail-closed).
 */

const { pool } = require('../models/db');
const GeorgeSignalEngine = require('./GeorgeSignalEngine');
const BinanceFeed = require('./BinanceFeed');
const ChainlinkFeed = require('./ChainlinkFeed');
const PolymarketFeed = require('./PolymarketFeed');
const { calculateCryptoTakerFeeUsd } = require('./tradeExecutionRules');
const { riskWindowFloor } = require('./PortfolioRiskPolicy');
const { decrypt } = require('../services/encryption');

const TICK = 0.01;
const ENTRY_PENALTY_TICKS = 2;
const LOOP_MS = 5000;
const CHAINLINK_POLL_MS = 10000; // George needs a tighter view of rounds than the main bot's 30s
const LEGACY_GEORGE_SOURCE_RETIRED = true;

class GeorgeBotInstance {
  constructor(userId, settings) {
    this.userId = userId;
    this.settings = settings;
    this.isRunning = false;
    this._loopRunning = false;
    this.loopInterval = null;

    this.binance = new BinanceFeed();
    this.chainlink = new ChainlinkFeed();
    this.polymarket = null;
    this.engine = null;

    const bal = parseFloat(settings.george_paper_balance);
    this.paperBalance = Number.isFinite(bal) ? bal : 500;
    this.paperRiskLimitsEnabled = settings.paper_risk_limits_enabled === true;

    this._completedMarketIds = new Set();
    this.decisionLog = [];
    this.maxLogEntries = 120;
    this._lastSnapshot = null;
    this._dailyLossHaltedAt = null;
  }

  _log(level, message) {
    const entry = { timestamp: new Date().toISOString(), level, message };
    console.log(`[george:u${this.userId}] [${level}] ${message}`);
    this.decisionLog.push(entry);
    if (this.decisionLog.length > this.maxLogEntries) this.decisionLog.shift();
  }

  async start() {
    if (this.isRunning) return;
    const isLive = !this.settings.paper_trading;
    const modeText = isLive ? 'LIVE TRADING' : 'PAPER ONLY';
    this._log('INFO', `Starting George (Chainlink-anchored split test, ${modeText})...`);
    
    if (isLive) {
      let privateKey = null;
      if (this.settings.encrypted_private_key) {
        try { privateKey = decrypt(this.settings.encrypted_private_key); } catch (e) {}
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
    } else {
      // Read-only Polymarket access — no keys, George never places orders in paper mode.
      this.polymarket = new PolymarketFeed(null, null, null, null, null, 'EOA', null);
    }
    await this.polymarket.initialize();
    // Multi-asset (2026-07-12): one Binance feed + one Chainlink anchor per
    // enabled_george asset (requires a verified ETH-mainnet CL feed — DOGE/
    // XRP/HYPE have none and stay George-disabled in asset_config).
    this.feeds = { btc: this.binance };
    this.chainlinks = { btc: this.chainlink };
    try {
      const { rows } = await pool.query(
        "SELECT * FROM asset_config WHERE enabled_george = true AND chainlink_feed IS NOT NULL AND binance_symbol IS NOT NULL ORDER BY asset");
      for (const a of rows) {
        if (a.asset === 'btc') continue;
        this.feeds[a.asset] = new BinanceFeed(a.binance_symbol);
        this.chainlinks[a.asset] = new ChainlinkFeed(a.chainlink_feed);
      }
    } catch (e) {
      this._log('WARN', `asset_config unavailable (${e.message}) — BTC-only`);
    }
    await Promise.all(Object.values(this.feeds).map((f) => f === this.binance ? f.connect() : f.connect()));
    await Promise.all(Object.entries(this.chainlinks).map(([k, c]) => c === this.chainlink ? c.start(CHAINLINK_POLL_MS) : c.start(CHAINLINK_POLL_MS)));
    this._log('INFO', `George asset feeds: ${Object.keys(this.feeds).join(', ')}`);
    this.engine = new GeorgeSignalEngine(this.polymarket, this.binance, this.chainlink, this.settings);
    this.engine.setFeeds(this.feeds, this.chainlinks);
    if (this.polymarket.setAssets) this.polymarket.setAssets(Object.keys(this.feeds));
    this.isRunning = true;
    this.loopInterval = setInterval(() => this._tick(), LOOP_MS);

    // Heartbeat on its OWN timer, independent of the tick body (2026-07-13:
    // in-tick writes go silent for as long as any single tick hangs on a
    // slow network call — same root cause and fix as BotInstance.js).
    this._lastTickAt = Date.now();
    this.heartbeatInterval = setInterval(() => {
      pool.query(
        `INSERT INTO system_heartbeats (component, beat_at, meta) VALUES ('george_bot', now(), $1)
         ON CONFLICT (component) DO UPDATE SET beat_at = now(), meta = $1`,
        [JSON.stringify({ pid: process.pid, userId: this.userId, lastTickAgeSec: Math.round((Date.now() - this._lastTickAt) / 1000) })]
      ).catch(() => {});
    }, 10000);
    await pool.query('UPDATE bot_settings SET george_is_active = true WHERE user_id = $1', [this.userId]).catch(() => {});
    this._log('INFO', `✅ George started. Flat stake $${this._stake().toFixed(2)}, balance $${this.paperBalance.toFixed(2)}. CL(open) anchors become available ~1 window after start.`);
  }

  async stop(preserveActive = false) {
    this.isRunning = false;
    if (this.loopInterval) { clearInterval(this.loopInterval); this.loopInterval = null; }
    clearInterval(this.heartbeatInterval); this.heartbeatInterval = null;
    if (this.binance) this.binance.disconnect();
    if (this.chainlink) this.chainlink.stop();
    if (!preserveActive) {
      await pool.query('UPDATE bot_settings SET george_is_active = false WHERE user_id = $1', [this.userId]).catch(() => {});
    }
    this._log('INFO', '🛑 George stopped');
  }

  _stake() {
    const raw = parseFloat(this.settings.george_trade_size);
    return Number.isFinite(raw) && raw >= 1 ? raw : 10;
  }

  _feeRate() {
    const raw = parseFloat(this.settings.paper_taker_fee_rate);
    return Number.isFinite(raw) && raw >= 0 && raw < 1 ? raw : 0.07;
  }

  async _tick() {
    if (!this.isRunning || this._loopRunning) return;
    this._loopRunning = true;
    this._lastTickAt = Date.now();
    try {
      await this._manageOpenPositions();

      const halted = await this._checkDailyLoss();
      if (halted) return;

      const open = await pool.query(
        "SELECT market_id FROM george_trades WHERE user_id=$1 AND status='open'", [this.userId]);
      const excluded = new Set(this._completedMarketIds);
      for (const r of open.rows) excluded.add(String(r.market_id));
      if (open.rows.length > 0) return; // one position at a time — evaluation not needed

      const signal = await this.engine.evaluate(excluded);
      if (signal.verdict === 'TRADE') this._lastSnapshot = signal;
      else if (signal.lastSnapshot) this._lastSnapshot = signal.lastSnapshot;
      await this._logSignal(signal);
      if (signal.verdict !== 'TRADE') return;

      if (LEGACY_GEORGE_SOURCE_RETIRED) {
        this._log(
          'INFO',
          `[SUPPRESSED — INVALID RESOLUTION SOURCE] Would-be ${signal.direction} @ ${signal.yesPrice?.toFixed?.(3)}. ` +
          'George mainnet-push own/resurrection hypotheses are retired; use BORG H48/H49 RTDS evidence.'
        );
        return;
      }

      // George's OWN divergence signal hit its pre-registered kill criterion
      // (audit 2026-07-13: 71/158 = 44.9% wins, Wilson 95% upper ≈52.6% < the
      // 55% bar at n=158 > the pre-registered n=100). Executing a triggered
      // kill is the point of pre-registering it — default OFF, not deleted.
      // george_resurrection_enabled is a SEPARATE, freshly pre-registered
      // hypothesis (oracle_age<600s AND divergence≥30bps AND entry∈[0.35,0.65]);
      // its own kill (Wilson upper <55% at n=100) applies independently and
      // only counts trades it actually opens. Signals are still logged either
      // way — this only gates capital, never visibility.
      const ownEnabled = this.settings.george_own_signal_enabled === true;
      const resurrectionEnabled = this.settings.george_resurrection_enabled === true;
      let entryMode = 'own';
      if (!ownEnabled) {
        if (!resurrectionEnabled) {
          this._log('INFO', `[SUPPRESSED — own signal killed 2026-07-13] Would-be ${signal.direction} @ ${signal.yesPrice?.toFixed?.(3)} p(UP)=${signal.pUp} — george_own_signal_enabled=false`);
          return;
        }
        const entry = signal.direction === 'YES' ? signal.yesPrice : 1 - signal.yesPrice;
        const passes = Number.isFinite(signal.clAgeSec) && signal.clAgeSec < 600
          && Number.isFinite(signal.divergenceBps) && signal.divergenceBps >= 30
          && Number.isFinite(entry) && entry >= 0.35 && entry <= 0.65;
        if (!passes) {
          this._log('INFO', `[SUPPRESSED — resurrection filter] entry=${entry?.toFixed?.(3)} oracleAge=${signal.clAgeSec}s div=${signal.divergenceBps}bps`);
          return;
        }
        this._log('INFO', `🔬 [RESURRECTION] filter passed — entry=${entry.toFixed(3)} oracleAge=${signal.clAgeSec}s div=${signal.divergenceBps}bps`);
        entryMode = 'resurrection';
      }

      signal._entryMode = entryMode;
      await this._openPosition(signal);
    } catch (err) {
      this._log('ERROR', `tick error: ${err.message}`);
    } finally {
      this._loopRunning = false;
    }
  }

  async forceTakeTrade(mainSignal) {
    if (!this.isRunning || this._loopRunning) return;
    this._loopRunning = true;
    try {
      // Check Active Trade Lock
      const open = await pool.query(
        "SELECT market_id FROM george_trades WHERE user_id=$1 AND status='open'", [this.userId]);
      if (open.rows.length > 0) return;

      // Check if we've already traded this market
      if (this._completedMarketIds.has(String(mainSignal.marketId))) return;

      this._log('INFO', `🔥 Auto-taking main bot 100% confidence trade for market ${String(mainSignal.marketId).slice(0, 12)}`);

      const endMs = mainSignal.market?.end_date_iso
        ? new Date(mainSignal.market.end_date_iso).getTime()
        : Date.now() + 300000;

      const mappedSig = {
        marketId: mainSignal.marketId,
        question: `[MAIN BOT CONF 100%] ${mainSignal.market?.question || `Market ${mainSignal.marketId}`}`,
        direction: mainSignal.direction,
        yesPrice: mainSignal.yesPrice,
        pUp: mainSignal.modelProb ?? null,
        pUpdate: null,
        clOpen: null,
        clNow: mainSignal.log?.chainlinkPrice ?? null,
        spotNow: mainSignal.log?.btcPrice ?? null,
        sigma5min: mainSignal.phi?.sigma5min ?? null,
        divergenceBps: mainSignal.oracleDivergenceBps ?? null,
        remainingSec: mainSignal.remainingSec ?? mainSignal.log?.gates?.timeGate?.remaining ?? null,
        endMs,
        yesTokenId: mainSignal.market?.tokens?.[0]?.token_id,
        noTokenId: mainSignal.market?.tokens?.[1]?.token_id,
        _entryMode: 'mirror'
      };

      await this._openPosition(mappedSig);
    } catch (err) {
      this._log('ERROR', `forceTakeTrade error: ${err.message}`);
    } finally {
      this._loopRunning = false;
    }
  }

  async _openPosition(sig) {
    const isLive = !this.settings.paper_trading;
    const stake = this._stake();

    // 1. Conflict Guard: Prevent entering opposite direction to MainBot
    // Only applies in LIVE mode to prevent wallet token offset. In paper mode, George acts freely.
    if (isLive) {
      const mainTrades = await pool.query(
        "SELECT direction FROM trades WHERE user_id=$1 AND status IN ('open','pending') AND market_id=$2",
        [this.userId, sig.marketId]
      );
      if (mainTrades.rows.length > 0) {
        const mainDir = mainTrades.rows[0].direction;
        if (mainDir !== sig.direction) {
          this._log('WARN', `[SKIP] Main bot holds ${mainDir}. Skipping George ${sig.direction} to prevent wallet token offset.`);
          return;
        }
      }
    }

    let entry = 0;
    let actualTokenId = sig.direction === 'YES' ? sig.yesTokenId : sig.noTokenId;

    if (isLive) {
      // LIVE TRADING EXECUTION
      const balanceRes = await this.polymarket.fetchBalance();
      const liveBal = balanceRes ? parseFloat(balanceRes.usdc) : 0;
      if (liveBal < stake) {
        this._log('WARN', `Insufficient LIVE balance $${liveBal.toFixed(2)} < stake $${stake}`);
        return;
      }
      if (!actualTokenId) {
        this._log('WARN', `Missing token ID for ${sig.marketId} - cannot place live order`);
        return;
      }

      const outcomePrice = sig.direction === 'YES' ? sig.yesPrice : 1 - sig.yesPrice;
      const expectedTokens = stake / outcomePrice;

      this._log('INFO', `⚡ [GEORGE/LIVE] Routing FAK BUY order for ${sig.direction} ($${stake.toFixed(2)})`);
      try {
        const orderRes = await this.polymarket.placeOrder(
          actualTokenId,
          'BUY',
          outcomePrice,
          expectedTokens,
          { isFak: true } // Execute Fill-And-Kill
        );
        if (!orderRes || !orderRes.orderID) throw new Error("Order rejected or missing ID");
        
        // Assume filled at our expected price since it's FAK
        entry = outcomePrice;
        this._log('INFO', `⚡ [GEORGE/LIVE] Filled ${sig.direction} @ ${entry.toFixed(3)} (Order ${orderRes.orderID})`);
      } catch (err) {
        this._log('ERROR', `Live order failed: ${err.message}`);
        return; // Halt if live order fails
      }
    } else {
      // PAPER TRADING EXECUTION
      if (this.paperRiskLimitsEnabled && this.paperBalance < stake) {
        this._log('WARN', `Insufficient George balance $${this.paperBalance.toFixed(2)} < stake $${stake}`);
        return;
      }
      
      // Pessimistic paper fill: pay the outcome-token price + penalty ticks.
      const TICK = 0.001;
      const ENTRY_PENALTY_TICKS = 2;
      const outcomePrice = sig.direction === 'YES' ? sig.yesPrice : 1 - sig.yesPrice;
      entry = Math.min(0.99, parseFloat((outcomePrice + ENTRY_PENALTY_TICKS * TICK).toFixed(4)));
      if (entry <= 0.02 || entry >= 0.98) {
        this._log('INFO', `[SKIP] Entry ${entry.toFixed(3)} outside tradeable band after penalty`);
        return;
      }
      this.paperBalance -= stake;
      await pool.query(
        'UPDATE bot_settings SET george_paper_balance=$1 WHERE user_id=$2',
        [this.paperBalance, this.userId]).catch(() => {});
    }

    // Oracle age at entry — logged so staleness-vs-loss clustering can be
    // tested prospectively (retro reconstruction was inconclusive; ANALYSIS.md).
    const _cl = this.chainlinks?.[sig.asset] || this.chainlink;
    const oracleAgeSec = _cl?.lastUpdate
      ? Math.round((Date.now() - _cl.lastUpdate.getTime()) / 1000)
      : null;

    await pool.query(`
      INSERT INTO george_trades (
        user_id, market_id, market_question, direction, entry_price, trade_size, status,
        p_model, p_update, chainlink_open, chainlink_at_entry, spot_at_entry,
        sigma_5min, divergence_bps, remaining_sec_at_entry, market_end_at, token_id, oracle_age_sec, asset, entry_mode
      ) VALUES ($1,$2,$3,$4,$5,$6,'open',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
    `, [
      this.userId, sig.marketId, sig.question, sig.direction, entry, stake,
      sig.pUp, sig.pUpdate, sig.clOpen, sig.clNow, sig.spotNow,
      sig.sigma5min, sig.divergenceBps, sig.remainingSec,
      new Date(sig.endMs).toISOString(),
      actualTokenId || null, oracleAgeSec, sig.asset || 'btc', sig._entryMode || 'own'
    ]);
    
    const modeStr = isLive ? 'LIVE' : 'PAPER';
    this._log('INFO', `✅ [GEORGE/${modeStr}] ${sig.direction} @ ${entry.toFixed(3)} stake $${stake.toFixed(2)} — p(UP)=${sig.pUp} price=${sig.yesPrice} pUpdate=${sig.pUpdate} (${sig.question?.slice(0, 40)})`);
  }

  async _manageOpenPositions() {
    const { rows } = await pool.query(
      "SELECT * FROM george_trades WHERE user_id=$1 AND status='open'", [this.userId]);
    for (const t of rows) {
      const endMs = t.market_end_at ? new Date(t.market_end_at).getTime() : null;
      const pastEnd = endMs != null && Date.now() > endMs + 20000; // give the oracle 20s
      const ageMin = (Date.now() - new Date(t.created_at).getTime()) / 60000;
      if (!pastEnd && ageMin < 6) continue; // hold to resolution — no interim exits by design

      const outcome = await this._fetchResolution(t.market_id);
      if (outcome != null) {
        const win = t.direction === 'NO' ? 1 - outcome : outcome;
        await this._close(t, win, 'MARKET_RESOLVED');
      } else if (ageMin >= 15) {
        // UMA never resolved for us — close flat and FLAG it; do not fabricate a PnL.
        await this._close(t, null, 'RESOLUTION_TIMEOUT');
      }
    }
  }

  async _close(t, winBinary, reason) {
    const entry = parseFloat(t.entry_price);
    const stake = parseFloat(t.trade_size);
    let pnl = 0, exitPrice = entry, result = 'FLAT';
    if (winBinary != null && Number.isFinite(entry) && entry > 0) {
      exitPrice = winBinary; // terminal 0 or 1
      const shares = stake / entry;
      const gross = shares * winBinary - stake;
      pnl = gross - calculateCryptoTakerFeeUsd(shares, entry, this._feeRate());
      result = pnl >= 0 ? 'WIN' : 'LOSS';
    }
    await pool.query(`
      UPDATE george_trades SET status='closed', exit_price=$1, pnl=$2, result=$3, close_reason=$4, closed_at=NOW()
      WHERE id=$5
    `, [exitPrice, pnl, result, reason, t.id]);
    const nextBalance = this.paperBalance + stake + pnl;
    this.paperBalance = this.paperRiskLimitsEnabled ? Math.max(0, nextBalance) : nextBalance;
    await pool.query('UPDATE bot_settings SET george_paper_balance=$1 WHERE user_id=$2',
      [this.paperBalance, this.userId]).catch(() => {});
    this._completedMarketIds.add(String(t.market_id));
    if (this._completedMarketIds.size > 100) {
      this._completedMarketIds = new Set([...this._completedMarketIds].slice(-50));
    }
    this._log('INFO', `${pnl >= 0 ? '🟢' : '🔴'} [GEORGE] Closed #${t.id} ${t.direction} [${reason}] entry=${entry.toFixed(3)} exit=${exitPrice} pnl=$${pnl.toFixed(2)} balance=$${this.paperBalance.toFixed(2)}`);
  }

  async _fetchResolution(marketId) {
    try {
      const r = await fetch(`https://gamma-api.polymarket.com/markets/${marketId}`, {
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) return null;
      const m = await r.json();
      let op = m.outcomePrices;
      if (typeof op === 'string') { try { op = JSON.parse(op); } catch (_) { return null; } }
      if (!Array.isArray(op) || op.length < 2) return null;
      const yes = parseFloat(op[0]);
      if (yes >= 0.9) return 1;
      if (yes <= 0.1) return 0;
      return null;
    } catch (_) { return null; }
  }

  async _checkDailyLoss() {
    if (this.settings.paper_trading !== false && !this.paperRiskLimitsEnabled) {
      this._dailyLossHaltedAt = null;
      return false;
    }
    try {
      const limRaw = parseFloat(this.settings.george_max_daily_loss);
      const lim = Number.isFinite(limRaw) ? Math.abs(limRaw) : 50;
      const riskFloor = riskWindowFloor(Date.now(), this.settings.paper_risk_epoch_anchor);
      const r = await pool.query(`
        SELECT COALESCE(SUM(pnl),0) AS p FROM george_trades
        WHERE user_id=$1 AND status='closed' AND closed_at > $2
      `, [this.userId, riskFloor]);
      const daily = parseFloat(r.rows[0].p) || 0;
      if (daily <= -lim) {
        if (!this._dailyLossHaltedAt) {
          this._dailyLossHaltedAt = Date.now();
          this._log('CRITICAL', `🛑 GEORGE DAILY LOSS HALT: since ${riskFloor.toISOString()} $${daily.toFixed(2)} ≤ -$${lim.toFixed(2)} — entries blocked`);
        }
        return true;
      }
      this._dailyLossHaltedAt = null;
      return false;
    } catch (e) {
      this._log('ERROR', `George daily loss check failed (${e.message}) — failing closed`);
      return true;
    }
  }

  async _logSignal(signal) {
    // Compact decision log — one row per evaluation that produced a snapshot, rate-
    // limited to one row/market/60s so the table stays analyzable, not spammed.
    const snap = signal.verdict === 'TRADE' ? signal : signal.lastSnapshot;
    if (!snap?.marketId) return;
    if (!this._sigLogAt) this._sigLogAt = new Map();
    const last = this._sigLogAt.get(snap.marketId) || 0;
    if (signal.verdict !== 'TRADE' && Date.now() - last < 60000) return;
    this._sigLogAt.set(snap.marketId, Date.now());
    await pool.query(`
      INSERT INTO george_signals (
        user_id, market_id, verdict, reason, direction, p_model, p_update,
        chainlink_open, chainlink_now, spot_now, yes_price, sigma_5min,
        divergence_bps, remaining_sec
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    `, [
      this.userId, snap.marketId, signal.verdict, (signal.log?.reason || '').slice(0, 300),
      snap.direction ?? null, snap.pUp ?? null, snap.pUpdate ?? null,
      snap.clOpen ?? null, snap.clNow ?? null, snap.spotNow ?? null,
      snap.yesPrice ?? null, snap.sigma5min ?? null,
      snap.divergenceBps ?? null, snap.remainingSec ?? null,
    ]).catch((e) => this._log('WARN', `george_signals insert failed: ${e.message}`));
  }

  getStatus() {
    const isLive = !this.settings.paper_trading;
    return {
      isRunning: this.isRunning,
      bot: 'george',
      paperOnly: !isLive,
      paperBalance: this.paperBalance,
      stake: this._stake(),
      chainlink: {
        price: this.chainlink?.getPrice() ?? null,
        lastUpdate: this.chainlink?.lastUpdate ?? null,
        roundsObserved: this.chainlink?.roundHistory?.length ?? 0,
      },
      binancePrice: this.binance?.getLastKnownPrice() ?? null,
      ewmaSigma5min: this.engine ? this.engine.ewmaSigma5min() : null,
      lastSnapshot: this._lastSnapshot,
      dailyLossHalted: !!this._dailyLossHaltedAt,
      paperRiskEpochAnchor: this.settings.paper_risk_epoch_anchor || null,
      paperRiskLimitsEnabled: this.paperRiskLimitsEnabled,
      legacySourceRetired: LEGACY_GEORGE_SOURCE_RETIRED,
      rtdsSuccessors: ['H48_network_chainlink_resolver_basis', 'H49_network_coinbase_chainlink_quorum'],
      recentLogs: this.decisionLog.slice(-25),
    };
  }
}

module.exports = GeorgeBotInstance;
module.exports.LEGACY_GEORGE_SOURCE_RETIRED = LEGACY_GEORGE_SOURCE_RETIRED;
