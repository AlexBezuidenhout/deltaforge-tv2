const express = require('express');
const router = express.Router();
const { pool } = require('../models/db');
const { authMiddleware } = require('../middleware/auth');
const { decrypt } = require('../services/encryption');

// --- Test Claude API Key (uses stored key, not raw body) ---
router.post('/test', authMiddleware, async (req, res) => {
  try {
    const settings = await pool.query(
      'SELECT claude_api_key_encrypted, claude_model FROM bot_settings WHERE user_id = $1',
      [req.userId]
    );

    if (!settings.rows[0]?.claude_api_key_encrypted) {
      return res.status(400).json({ error: 'Claude API key not configured. Save it in settings first.' });
    }

    const apiKey = decrypt(settings.rows[0].claude_api_key_encrypted);
    const model = settings.rows[0].claude_model || 'claude-fable-5';

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        // Fable 5 thinking is always on and counts toward max_tokens — a
        // 10-token cap would be all thinking; 64 still proves the key works
        max_tokens: 64,
        messages: [{ role: 'user', content: 'ping' }]
      })
    });

    if (response.ok) {
      res.json({ success: true, message: 'Claude API key is valid and working' });
    } else {
      const errData = await response.json().catch(() => ({}));
      res.status(400).json({
        success: false,
        error: errData.error?.message || `API returned status ${response.status}`
      });
    }
  } catch (err) {
    console.error('[Claude] Test error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Run Analysis ---
router.post('/analyze', authMiddleware, async (req, res) => {
  try {
    const settings = await pool.query(
      'SELECT claude_api_key_encrypted, claude_model FROM bot_settings WHERE user_id = $1',
      [req.userId]
    );

    if (!settings.rows[0]?.claude_api_key_encrypted) {
      return res.status(400).json({ error: 'Claude API key not configured' });
    }

    const apiKey = decrypt(settings.rows[0].claude_api_key_encrypted);
    const model = settings.rows[0].claude_model || 'claude-fable-5';

    // ── Three-bot evidence package (2026-07-12): MAIN + GEORGE + BORG ──────
    // Aggregates computed in SQL; small raw samples for texture. The audit's
    // established facts ride along so the analysis hunts for NEW patterns
    // instead of re-deriving known mirages.
    const q = (sql, params = [req.userId]) => pool.query(sql, params).then((r) => r.rows).catch((e) => [{ _error: e.message }]);

    const [
      botSettingsRows, mainByAsset, mainTrades, mainCalib,
      georgeSplit, georgeByAsset, georgeTrades,
      borgByStrategy, borgByAsset, borgWorstMarkets, borgA2vsA,
    ] = await Promise.all([
      q(`SELECT gate1_threshold, gate2_ev_floor, gate3_enabled, gate3_min_delta, kelly_cap, kelly_prob_shrink,
                max_trade_size, max_daily_loss, strict_paper_fills, ensemble_phi_weight, george_mirror_enabled
         FROM bot_settings WHERE user_id = $1`),
      q(`SELECT COALESCE(asset,'btc') asset, count(*) FILTER (WHERE status='closed') closed,
                count(*) FILTER (WHERE status='closed' AND pnl>0) wins,
                round(COALESCE(sum(pnl) FILTER (WHERE status='closed'),0)::numeric,2) pnl
         FROM trades WHERE user_id=$1 AND id > 53 GROUP BY 1 ORDER BY 1`),
      q(`SELECT COALESCE(asset,'btc') asset, direction, entry_price, exit_price, pnl, trade_size,
                signal_confidence, ev_adj, model_prob, scenario, close_reason,
                to_char(created_at,'MM-DD HH24:MI') at
         FROM trades WHERE user_id=$1 AND status='closed' AND id > 53
         ORDER BY created_at DESC LIMIT 40`),
      q(`WITH s AS (
           SELECT sg.p_phi, sg.p_heur, sg.model_prob, sg.yes_price,
                  CASE WHEN bm.outcome='UP' THEN 1.0 ELSE 0.0 END y
           FROM signals sg JOIN borg_markets bm ON bm.gamma_id = sg.market_id::text AND bm.outcome IS NOT NULL
           WHERE sg.verdict='TRADE' AND sg.p_phi IS NOT NULL AND sg.p_heur IS NOT NULL AND sg.yes_price IS NOT NULL)
         SELECT count(*) n,
                round(avg(power(p_phi-y,2))::numeric,4)  brier_phi,
                round(avg(power(p_heur-y,2))::numeric,4) brier_heur,
                round(avg(power(model_prob-y,2))::numeric,4) brier_ensemble,
                round(avg(power(yes_price-y,2))::numeric,4) brier_market_price
         FROM s`, []),
      q(`SELECT CASE WHEN market_question LIKE '[MAIN BOT CONF 100%]%' THEN 'mirror(now off)' ELSE 'own_divergence_signal' END src,
                count(*) FILTER (WHERE status='closed') closed,
                count(*) FILTER (WHERE status='closed' AND pnl>0) wins,
                round(COALESCE(sum(pnl) FILTER (WHERE status='closed'),0)::numeric,2) pnl
         FROM george_trades WHERE user_id=$1 GROUP BY 1`),
      q(`SELECT COALESCE(asset,'btc') asset, count(*) FILTER (WHERE status='closed') closed,
                count(*) FILTER (WHERE status='closed' AND pnl>0) wins,
                round(COALESCE(sum(pnl) FILTER (WHERE status='closed'),0)::numeric,2) pnl,
                round(avg(oracle_age_sec) FILTER (WHERE oracle_age_sec IS NOT NULL)::numeric,0) avg_oracle_age_s
         FROM george_trades WHERE user_id=$1 AND market_question NOT LIKE '[MAIN BOT CONF 100%]%' GROUP BY 1 ORDER BY 1`),
      q(`SELECT COALESCE(asset,'btc') asset, direction, entry_price, exit_price, pnl, p_model, p_update,
                divergence_bps, oracle_age_sec, remaining_sec_at_entry, result,
                to_char(created_at,'MM-DD HH24:MI') at
         FROM george_trades WHERE user_id=$1 AND status='closed' AND market_question NOT LIKE '[MAIN BOT CONF 100%]%'
         ORDER BY created_at DESC LIMIT 30`),
      q(`SELECT o.strategy, count(*) FILTER (WHERE s.filled) fills,
                count(*) FILTER (WHERE s.filled AND s.pnl_1x>0) wins,
                round(COALESCE(sum(s.pnl_1x) FILTER (WHERE s.filled),0)::numeric,2) pnl_1x,
                round(COALESCE(sum(s.pnl_2x) FILTER (WHERE s.filled),0)::numeric,2) pnl_2x,
                round(avg(s.pnl_1x) FILTER (WHERE s.filled)::numeric,3) per_fill
         FROM borg_shadow_orders o JOIN borg_shadow_scores s ON s.order_id=o.id
         GROUP BY 1 ORDER BY 1`, []),
      q(`SELECT m.asset, o.strategy, count(*) FILTER (WHERE s.filled) fills,
                round(COALESCE(sum(s.pnl_1x) FILTER (WHERE s.filled),0)::numeric,2) pnl_1x
         FROM borg_shadow_orders o JOIN borg_shadow_scores s ON s.order_id=o.id
         JOIN borg_markets m ON m.id = o.market_id
         GROUP BY 1,2 HAVING count(*) FILTER (WHERE s.filled) > 0 ORDER BY 1,2`, []),
      q(`SELECT m.asset, o.market_id, o.strategy, count(*) fills, round(sum(s.pnl_1x)::numeric,1) pnl
         FROM borg_shadow_orders o JOIN borg_shadow_scores s ON s.order_id=o.id
         JOIN borg_markets m ON m.id = o.market_id
         WHERE s.filled GROUP BY 1,2,3 ORDER BY sum(s.pnl_1x) ASC LIMIT 8`, []),
      q(`SELECT o.strategy, count(*) FILTER (WHERE s.filled) fills,
                round(COALESCE(sum(s.pnl_1x) FILTER (WHERE s.filled),0)::numeric,2) pnl_1x
         FROM borg_shadow_orders o JOIN borg_shadow_scores s ON s.order_id=o.id
         WHERE o.strategy IN ('A_maker','A2_maker_capped') AND o.ts > '2026-07-12T02:00Z'
         GROUP BY 1`, []),
    ]);

    const prompt = `You are a quantitative trading analyst auditing a THREE-BOT Polymarket 5-minute binary trading system (all paper/shadow). Your job: find GENUINE winning patterns worth amplifying and concrete improvements — while refusing to bless noise. This system has fooled its operator twice before (duplicated P&L, partial-scoring mirage); skepticism is a feature.

## The three bots
- MAIN: heuristic+phi ensemble, 11-gate EV pipeline, paper trades with STRICT fill simulation (entry only when a counterparty crosses). Multi-asset since 2026-07-12: btc/eth/sol/doge/xrp/bnb.
- GEORGE: Chainlink-divergence anchor, flat stakes, hold to resolution. Mirror-of-MAIN path is OFF (quarantined). Assets: btc/eth/sol/bnb.
- BORG: shadow maker system scored back-of-queue against real tape (the only fill-honest measurement). Strategies: A_maker (dead, kept as control), A2_maker_capped (inventory cap + phi-band). F_yield and D_consistency are RETIRED. Assets: all 7 incl. hype.

## Established audit facts — do NOT re-derive these; build on them
- Instant paper fills were proven dishonest: tape replay flipped MAIN +$10 to -$54 on the overlap sample (resting buys fill preferentially when the signal is wrong). Strict fills in effect since 2026-07-12 ~10:00Z — trades before that are upper bounds, not results.
- Calibration n=242: phi Brier 0.315 (worse than a coin — muted, weight truly 0 since commit 07b3c15), heuristic 0.218 (only estimator beating market price 0.235), ensemble 0.247. The heuristic edge is ~1.2 sigma — a hypothesis, not a conclusion.
- George's own divergence signal is a net loser all-time; his old headline profit was the (now off) mirror path. Pre-registered kill: Wilson CI upper < 55% at n=100 own trades.
- BORG A_maker is dead (mean -$0.83/fill, CI excludes 0; cause = unbounded same-side inventory in near-strike markets, NOT flow toxicity — that hypothesis was tested and REFUTED; calm-market fills were the worst). A2 caps inventory at 40 tokens/side and quotes only when |phi - market| <= 5 cents.
- ALL BORG data is phase='pilot' — machinery tuning, not evidence (EVAL_PROTOCOL section 3). Maker requote params changed to 2c/15s at the multi-asset launch — pilot clocks restarted then.
- Buckets under ~300 trades/fills are provisional noise. Say so explicitly whenever it applies.
- Gate 1 is informational by design; gate3_score is signed (negative on NO trades is correct); MAIN trades id <= 53 are an older build and already excluded from the data below.

## Settings (the engine actually reads these)
${JSON.stringify(botSettingsRows[0] || {}, null, 1)}

## MAIN — per-asset results (deduped, post-audit build)
${JSON.stringify(mainByAsset, null, 1)}
Calibration (all resolved TRADE signals): ${JSON.stringify(mainCalib[0] || {})}
Last 40 closed trades: ${JSON.stringify(mainTrades)}

## GEORGE — signal-source split (all-time)
${JSON.stringify(georgeSplit, null, 1)}
Own-signal per asset: ${JSON.stringify(georgeByAsset, null, 1)}
Last 30 own-signal closed trades: ${JSON.stringify(georgeTrades)}

## BORG — shadow (fill-honest, pilot)
Per strategy (all-time): ${JSON.stringify(borgByStrategy, null, 1)}
Per asset x strategy: ${JSON.stringify(borgByAsset, null, 1)}
Worst 8 market blowups: ${JSON.stringify(borgWorstMarkets, null, 1)}
A2 vs A_maker since 2026-07-12T02:00Z (same window): ${JSON.stringify(borgA2vsA, null, 1)}

## Deliver, per bot AND cross-bot:
1. **Genuine winning patterns**: which specific conditions (asset, scenario, confidence band, entry timing, phi-agreement, oracle age, inventory state) show wins that survive (a) honest-fill logic, (b) sample-size discipline, (c) the known mirage mechanisms? Distinguish "real candidate" from "noise" explicitly.
2. **Losing patterns to cut**: conditions that concentrate losses — with the exact filter/flag you would add.
3. **Cross-asset read**: do the new assets (eth/sol/doge/xrp/bnb/hype) behave differently from btc in ways worth exploiting or guarding against? (Careful: days-old samples.)
4. **Concrete improvements**: each tied to evidence above, behind a config flag, with the pre-registered metric on the NEXT >=300 trades/fills that would confirm or kill it. No parameter may be fitted on the sample that motivated it and judged on that same sample.
5. **Verdict per bot**: does the evidence support a genuine edge net of honest fills — yes/no/insufficient, with the single most informative number.

Be specific with numbers. "No genuine pattern yet" is an acceptable and valuable answer where the data says so.`;

    // Fable 5: safety classifiers can decline a request (HTTP 200 with
    // stop_reason 'refusal'); opt into the server-side fallback so the same
    // request is retried on Opus 4.8 in one round trip. Thinking is always on
    // and counts toward max_tokens, so give it real headroom.
    const isFable = model.startsWith('claude-fable');
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        ...(isFable ? { 'anthropic-beta': 'server-side-fallback-2026-06-01' } : {})
      },
      body: JSON.stringify({
        model,
        max_tokens: isFable ? 16000 : 4000,
        ...(isFable ? { fallbacks: [{ model: 'claude-opus-4-8' }] } : {}),
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      return res.status(400).json({ error: errData.error?.message || 'Claude API request failed' });
    }

    const result = await response.json();
    if (result.stop_reason === 'refusal') {
      // with fallbacks enabled this means the whole chain declined
      const category = result.stop_details?.category;
      return res.status(400).json({
        error: `Claude declined this request (safety classifier${category ? `: ${category}` : ''}). Retry, or switch model in settings.`
      });
    }
    const analysis = result.content?.find((b) => b.type === 'text')?.text || 'No analysis generated';

    // History record: counts across all three bots
    const mainClosed = mainByAsset.reduce((s, r) => s + (parseInt(r.closed) || 0), 0);
    const mainPnl = mainByAsset.reduce((s, r) => s + (parseFloat(r.pnl) || 0), 0);
    const georgeClosed = georgeByAsset.reduce((s, r) => s + (parseInt(r.closed) || 0), 0);
    const borgFills = borgByStrategy.reduce((s, r) => s + (parseInt(r.fills) || 0), 0);

    // Persist analysis to claude_analyses table (trade_count = all-bot units analyzed)
    await pool.query(
      `INSERT INTO claude_analyses (user_id, analysis, feedback, trade_count, signal_count, total_pnl)
       VALUES ($1, $2, $2, $3, $4, $5)`,
      [req.userId, analysis, mainClosed + georgeClosed + borgFills, mainCalib[0]?.n || 0, mainPnl]
    );

    // Update last analysis timestamp
    await pool.query(
      'UPDATE bot_settings SET claude_last_analysis = NOW() WHERE user_id = $1',
      [req.userId]
    );

    res.json({
      success: true,
      analysis,
      tradesAnalyzed: mainClosed + georgeClosed + borgFills,
      signalsAnalyzed: parseInt(mainCalib[0]?.n) || 0,
      breakdown: { mainClosed, georgeClosed, borgFills },
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('[Claude] Analysis error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/claude/latest-feedback — return most recent stored analysis
router.get('/latest-feedback', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT analysis, created_at FROM claude_analyses
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [req.userId]
    );
    if (!result.rows.length) return res.json({ analysis: null });
    res.json({ analysis: result.rows[0].analysis, timestamp: result.rows[0].created_at });
  } catch (err) {
    res.json({ analysis: null });
  }
});

// GET /api/claude/history — return list of past analyses
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const result = await pool.query(
      `SELECT id, analysis AS feedback, trade_count, signal_count, total_pnl, created_at
       FROM claude_analyses WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [req.userId, limit]
    );
    res.json(result.rows);
  } catch (err) {
    res.json([]);
  }
});

module.exports = router;
