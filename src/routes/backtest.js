const express = require('express');
const router = express.Router();
const { pool } = require('../models/db');
const { authMiddleware } = require('../middleware/auth');
const { Parser } = require('json2csv');

router.post('/run', authMiddleware, async (req, res) => {
  try {
    const {
      gate1Threshold = 0.450,
      gate2EvFloor = 3.00,
      kellyCap = 0.10,
      maxTradeSize = 10.00,
      initialBalance = 500.00,
      days = 7
    } = req.body;

    // Fetch evaluated skipped signals and closed trades
    // We union them to reconstruct the full sequence of market opportunities
    const query = `
      SELECT created_at, market_id, market_question, direction, entry_price, ev_adj, confidence, btc_delta, resolved_price, would_win, sim_pnl, NULL as spread_pct, 'skipped' as source
      FROM skipped_signals 
      WHERE user_id = $1 AND evaluated_at IS NOT NULL AND created_at > NOW() - ($2 || ' days')::INTERVAL
      
      UNION ALL
      
      SELECT created_at, market_id, market_question, direction, entry_price, ev_adj, signal_confidence as confidence, NULL as btc_delta, exit_price as resolved_price, (result='WIN') as would_win, pnl as sim_pnl, slippage as spread_pct, 'trade' as source
      FROM trades 
      WHERE user_id = $1 AND status = 'closed' AND result IN ('WIN', 'LOSS', 'CLOSED') AND created_at > NOW() - ($2 || ' days')::INTERVAL
      
      ORDER BY created_at ASC
    `;
    
    const { rows } = await pool.query(query, [req.userId, days]);
    
    let balance = parseFloat(initialBalance);
    let peakBalance = balance;
    let maxDrawdown = 0;
    let wins = 0;
    let losses = 0;
    const simulatedTrades = [];
    const equityCurve = [{ ts: new Date(Date.now() - days * 86400000), balance }];
    
    for (const row of rows) {
      const ev = parseFloat(row.ev_adj || 0);
      const conf = parseFloat(row.confidence || 0);
      const entry = parseFloat(row.entry_price || 0.5);
      
      // Simulate Gate Logic
      let passesGate1 = conf >= parseFloat(gate1Threshold);
      let passesGate2 = ev >= parseFloat(gate2EvFloor);
      // Gate 3 usually involves btc_delta, but for backtesting we'll use a simplified check if available
      // or assume it passes if it was a trade, or if btc_delta > some threshold.
      
      if (passesGate1 && passesGate2) {
        // Calculate Kelly size
        let prob = entry + (ev / 100);
        let q = 1 - prob;
        let odds = (1 / entry) - 1;
        let kellyPct = 0;
        
        if (odds > 0) {
           kellyPct = (prob - (q / odds));
        }
        
        if (kellyPct <= 0) continue; // Edge too small
        
        // Cap Kelly
        let sizePct = Math.min(kellyPct, parseFloat(kellyCap));
        let sizeUsd = balance * sizePct;
        sizeUsd = Math.min(sizeUsd, parseFloat(maxTradeSize));
        if (sizeUsd < 5) continue; // Minimum trade size
        
        // Outcome
        const won = row.would_win;
        // Re-calculate PnL based on the simulated size instead of the historical size
        const shares = sizeUsd / entry;
        const fee = shares * 0.07 * entry * (1 - entry);
        let pnl = 0;
        
        if (won) {
          const payout = shares * 1.0;
          pnl = payout - sizeUsd - fee;
          wins++;
          balance += pnl;
        } else {
          pnl = -sizeUsd - fee;
          losses++;
          balance += pnl;
        }
        
        if (balance > peakBalance) peakBalance = balance;
        const drawdown = ((peakBalance - balance) / peakBalance) * 100;
        if (drawdown > maxDrawdown) maxDrawdown = drawdown;
        
        equityCurve.push({ ts: row.created_at, balance: parseFloat(balance.toFixed(2)), pnl: parseFloat(pnl.toFixed(2)) });
        simulatedTrades.push({
          ts: row.created_at,
          market: row.market_question,
          direction: row.direction,
          ev: ev.toFixed(2),
          confidence: conf.toFixed(3),
          size: sizeUsd.toFixed(2),
          pnl: pnl.toFixed(2),
          result: won ? 'WIN' : 'LOSS'
        });
      }
    }
    
    const totalTrades = wins + losses;
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const totalPnl = balance - initialBalance;
    
    res.json({
      evidenceClass: 'L0_RETROSPECTIVE_OUTCOME_SCENARIO',
      causal: false,
      executionReplay: false,
      warning: 'This re-filters already observed outcomes. It has no event-time book replay, quote-survival model, queue model, or independent holdout and must not be treated as a deployable backtest.',
      summary: {
        totalTrades,
        wins,
        losses,
        winRate: winRate.toFixed(1),
        totalPnl: totalPnl.toFixed(2),
        finalBalance: balance.toFixed(2),
        maxDrawdown: maxDrawdown.toFixed(2),
      },
      equityCurve,
      simulatedTrades
    });
    
  } catch (err) {
    console.error('[Backtest] Error:', err);
    res.status(500).json({ error: 'Failed to run backtest' });
  }
});

router.post('/export', authMiddleware, async (req, res) => {
   try {
      const days = req.body.days || 7;
      const query = `
      SELECT created_at, market_id, market_question, direction, entry_price, ev_adj, confidence, btc_delta, resolved_price, would_win, sim_pnl, NULL as spread_pct, 'skipped' as source
      FROM skipped_signals 
      WHERE user_id = $1 AND evaluated_at IS NOT NULL AND created_at > NOW() - ($2 || ' days')::INTERVAL
      UNION ALL
      SELECT created_at, market_id, market_question, direction, entry_price, ev_adj, signal_confidence as confidence, NULL as btc_delta, exit_price as resolved_price, (result='WIN') as would_win, pnl as sim_pnl, slippage as spread_pct, 'trade' as source
      FROM trades 
      WHERE user_id = $1 AND status = 'closed' AND result IN ('WIN', 'LOSS', 'CLOSED') AND created_at > NOW() - ($2 || ' days')::INTERVAL
      ORDER BY created_at ASC
    `;
    const { rows } = await pool.query(query, [req.userId, days]);
    
    if (rows.length === 0) {
       return res.status(404).send('No data available for the specified period.');
    }
    
    const parser = new Parser();
    const csv = parser.parse(rows);
    
    res.header('Content-Type', 'text/csv');
    res.attachment('backtest-data.csv');
    return res.send(csv);
   } catch (err) {
      console.error('[Export] Error:', err);
      res.status(500).json({ error: 'Failed to export data' });
   }
});

router.post('/export-ticks', authMiddleware, async (req, res) => {
   try {
      const type = req.body.type || 'all';
      const days = req.body.days || 7;
      
      let queryParams = [req.userId];
      let whereClause = "user_id = $1";
      
      if (type === 'session') {
         const sessionRow = await pool.query(
            `SELECT id FROM trading_sessions WHERE user_id=$1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
            [req.userId]
         );
         const activeSession = sessionRow.rows[0];
         if (!activeSession) {
            return res.status(404).send('No active session found.');
         }
         whereClause += " AND session_id = $2";
         queryParams.push(activeSession.id);
      } else {
         whereClause += " AND created_at > NOW() - ($2 || ' days')::INTERVAL";
         queryParams.push(days);
      }
      
      const query = `
      SELECT created_at, session_id, market_id, market_question, verdict, reason, direction, confidence, ev_raw, ev_adj, ema_edge, btc_edge, micro_edge, model_prob, ensemble_delta, btc_price, chainlink_price, poly_yes_price, poly_no_price, spread_pct, oracle_divergence_bps, remaining_sec, lag_age_sec, gate_failed
      FROM signals 
      WHERE ${whereClause}
      ORDER BY created_at ASC
    `;
    const { rows } = await pool.query(query, queryParams);
    
    if (rows.length === 0) {
       return res.status(404).send('No data available for the specified criteria.');
    }
    
    const parser = new Parser();
    const csv = parser.parse(rows);
    
    res.header('Content-Type', 'text/csv');
    res.attachment(`backtest-ticks-${type}.csv`);
    return res.send(csv);
   } catch (err) {
      console.error('[Export Ticks] Error:', err);
      res.status(500).json({ error: 'Failed to export ticks' });
   }
});

module.exports = router;
