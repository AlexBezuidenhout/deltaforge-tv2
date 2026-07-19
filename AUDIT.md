# AUDIT.md — Deltaforge / Printer Blast Bot Audit

Audit date: 2026-07-10. Data basis: live Neon DB (53 closed paper trades, 4,186 signals,
all from 2026-07-09) plus a full read of `src/bot/*`, `src/models/db.js`, `src/routes/*`.

---

## 1. Phase 0 — Life of one trade (as the code actually executes)

### 1.1 Tick loop

`BotInstance.start()` schedules `_mainLoop()` every `snipe_timer_seconds` (DB value: **5s**).
A `_loopRunning` re-entrance guard skips overlapping ticks.

Per tick, in order:

1. **`_monitorPendingOrders()`** — advances resting entry orders (live GTC or legacy paper
   pendings). *Note: with the current market-style entry path, paper entries never create
   pending orders — they fill instantly in step 8.*
2. **`_monitorPendingExits()`** — live only.
3. **`signalEngine.evaluate()`** — the whole signal pipeline (below). Returns one signal
   (first market to pass all gates) or SKIP.
4. **`_logSignal(signal)`** — INSERT into `signals` **every tick**, including repeated
   TRADE verdicts for a market we already hold (root cause of the "duplicate TRADE every
   5s" decision-stream spam — see §2.5).
5. Staleness guard (10s), flip-record housekeeping.
6. **`_manageOpenPositions(signal)`** — exits (see 1.4).
7. If verdict ≠ TRADE → done. Otherwise: `min_confidence` re-check → directional-exposure
   cap (30% hardcoded) → drawdown breaker → **daily loss limit** → flip check → 90s
   post-attempt cooldown → global one-open-position check → `_executeTrade`.

### 1.2 Signal pipeline (`GBMSignalEngine.evaluate()`)

Binance tick (WS `btcusdt@ticker`, 1s history buffer, 120 ticks) →

1. `simple_last_minute_mode` branch (off).
2. **btcPrecheck (hard)**: `|Δ60s| < min_btc_delta` (0.005%) → skip entire scan.
3. `fetchActiveBTCMarkets()` (Gamma slug `btc-updown-5m-<epoch>`).
4. Per market: price waterfall **WS → CLOB YES mid (spread≤10%) → CLOB NO mid → Gamma
   live → Gamma cached**; near-resolved skip (price outside 0.12–0.88); CLOB-only sanity
   filter (>25% jump); adaptive-EMA smoothing (α .25/.40/.65, bypass <60s).
5. Freshness (`stale_lag_seconds` 20), no-chase (`chase_threshold` 8%).
6. Microstructure composite (imbalance/whale/depth/latency → confidence 0–1). On
   Gamma-synthetic books `bidSize/askSize` are undefined → imbalance 0, whale 0, so
   confidence ≈ depth+latency terms only (explains the constant `gate1_score=0.200`).
7. Scenario classifier (10 regimes) → hard skips: `NEWS_SPIKE`, `RANGE_CHOP` (unless
   Gamma displaced ≥ `range_chop_gamma_override`).
8. **btcFlat (hard)**: `|Δ| < min_btc_delta` AND Gamma within 2¢ of 0.5.
9. **neutralBlock (hard)**: price within 3¢ of 0.5 AND `|Δ| < min_strong_btc_delta`.
10. Indicators (ATR/RSI/ADX/MACD/BB/vol-spike from 1m klines), dynamic σ (20×1m
    realized vol scaled to 5min), Φ model anchored at 5m kline open.
11. Heuristic: `btcEdge = min(|Δ|·0.5, 0.15)`, `microEdge = micro.confidence·0.10`,
    `pHeur = yesPrice ± (btcEdge+microEdge)`. **Note: `lagBonus` is NOT added to the
    heuristic edge anymore** — `hasLag` only eases the EV floor (×0.8, elapsed<60s).
12. Ensemble: `modelProb = 0.6·pPhi + 0.4·pHeur` (weight from `ensemble_phi_weight`),
    AGREE ×1.10 / DISAGREE ×0.70 confidence multiplier.
13. Gate 1 microstructure — **informational only** (by design; preserved).
14. Time gates: pre-open skip, expired skip, `remaining > 300s` skip (hardcoded
    `TRADE_WINDOW_SEC=300`; `early_window_sec`/`late_window_sec` settings are **dead**).
15. Boundary-book guard (spread ≥ 0.90), depth floor (`min_depth_usdc` 100),
    fillProb `= min(1, depth/500 · max(0,1−5·spread))` ≥ `fillprob_floor` (0.25).
16. **Gate 2 (hard, primary)**: `evaluateBothSides(modelProb, yesPrice, costs)` where
    `costs = { spread: 0, estimatedSlippage: 0.005, fees: 0.002 }` (hardcoded) →
    `bestEV ≥ gate2_ev_floor` (0.80%) with scenario multipliers ×0.65 (LAG_EDGE) /
    ×0.80 (MOMENTUM_BREAKOUT) / ×0.90 (VOL_EXPANSION) / ×1.50 (FAKE_BREAKOUT), lag ×0.8.
17. evTrend filter (velocity < −8·`ev_decay_ratio`... see §3 #9 — DB value 2.00 makes
    the effective floor −2, not the −8 the code comment claims).
18. Gate 3 (direction): 60s btcDelta must match direction unless `|Δ| < gate3_min_delta`
    (0.05) in which case the check is waived.
19. Confidence composite (momentum .45 / EV .30 / conviction .15 / time .05 / micro .05,
    scenario and ensemble multipliers) → **min_confidence gate** (DB: 0.150).

### 1.3 Sizing and execution

- Kelly: `b=(1/lastTradePrice)−1`, `f=(mProb·b−(1−mProb))/b`, capped by `kelly_cap`
  (0.10), ×fillProb, floored at $1, capped by **`max_trade_size` (DB: $100 — README
  claims a $5 cap; see §3)**. On the $10k paper balance the $100 cap binds on 35/53
  trades → every conviction trade is a max-size trade.
- Entry price: real CLOB `bestAsk` if spread < 0.90, else **synthetic ask =
  outcome price + 5 ticks** (Gamma/WS boundary books), min $0.40 rule.
- Paper: **instant fill** at that entry price, `_recordFilledTrade` INSERTs the trade.
  `SlippageEngine` is computed and logged in the signal but **never applied to fills**.
- Live: FAK market buy (read-only for this audit; untouched).

### 1.4 Position management → exit → DB

Each tick with the fresh signal price (smoothed for decisions, raw for PnL):

- resolution detection (price ≥0.92/≤0.08, age ≥4.5min via Gamma, stale/orphan checks)
- **early stop-loss**, tiered by time left: −42% (>180s), −38% (>120s), −35% (>60s),
  −32% (30–60s) — README still documents "−20% hard stop"
- late stop-loss: <30s remaining and PnL ≤ −15%
- profit lock +35% (>60s left); trailing stop (peak ≥35%, giveback ≥15, remaining ≤10)
- negative-EV exit **disabled** (dead `if (false && ...)` block)
- otherwise hold to resolution.

Close: `shares = size/entry`, `gross = shares·exit − size`, **fee = 2% of positive gross
only**, `pnl = gross − fee` → UPDATE trades, balance update, one-cycle-per-market lock.

### 1.5 Where every `bot_settings` key is read — and what overrides it

| Setting (DB value) | Read at | Hardcoded overrides / duplicates |
|---|---|---|
| `snipe_timer_seconds` (5) | BotInstance.start | fallback 8s |
| `min_btc_delta` (0.005) | engine ×2 (precheck + btcFlat) | fallback 0.015 |
| `min_strong_btc_delta` (0.05) | neutralBlock | fallback 0.05 |
| `range_chop_gamma_override` (0.010) | scenario | fallback 0.045 |
| `stale_lag_seconds` (20) | freshness | fallback 20 |
| `chase_threshold` (8) | no-chase | fallback 8 |
| `gate1_threshold` (0.45) | Gate 1 (informational) | fallback 0.45 |
| `gate2_ev_floor` (0.80) | Gate 2 | fallback 2.2; scenario ×0.65–×1.5 hardcoded |
| `ev_decay_ratio` (2.00) | evTrend | code fallback 8.0 — DB 2.0 silently wins |
| `gate3_enabled` (true), `gate3_min_delta` (0.05) | Gate 3 | fallback 0.01 (≠ DB default 0.05) |
| `min_confidence` (0.150) | engine + `_mainLoop` | fallback 0.42; `\|\| 0.42` treats 0 as unset |
| `kelly_cap` (0.10), `kelly_mode`, `max_trade_size` (100) | sizing | half-Kelly cap 25%, $1 floor hardcoded |
| `max_daily_loss` (50) | `_checkDailyLossLimit` | fallback 50 |
| `max_drawdown_pct` (15) | drawdown breaker | fallback 15 |
| `order_timeout_sec`, `adverse_ticks` | pending-order monitor | 30s expiry buffer hardcoded |
| `min_depth_usdc` (100), `fillprob_floor` (0.25), `slip_check_size_usd` (5) | engine | fillProb `/500` scale hardcoded |
| `phi_enabled`, `phi_sigma_5min`, `ensemble_phi_weight` | Φ/ensemble | σ fallback 0.0028 |
| `flip_threshold` (5) | flip | `FLIP_HYSTERESIS=6.0`, +1%/flip escalation, 2-min hold hardcoded |
| `paper_trading`, `paper_balance`, virtual-loss keys | lifecycle | — |
| `simple_last_minute_mode`, `latency_arb_*` | alt modes (off) | — |

Hardcoded constants with no setting at all: EV costs `{0, 0.005, 0.002}`; close-time fee
2% of gains; `TRADE_WINDOW_SEC=300`; boundary 0.90; synthetic-ask +5 ticks; <60s
no-new-entry gate; 90s post-attempt cooldown; 10s market cooldown; stop tiers
−42/−38/−35/−32 and late −15; profit lock 35; trailing (35/15/10/60); near-resolved bands
0.12/0.88 and 0.92/0.08; `MIN_MARKET_ENTRY=0.40`; directional-exposure 30%; confidence
weights.

**Dead settings** (exist in DB, never read by bot code): `oracle_lag_max_ms`,
`volume_spike_ratio`, `min_remaining_sec`, `early_window_sec`, `late_window_sec`,
`min_ev_threshold`, `min_prob_diff`, `market_prob_min/max`, `min_edge`,
`direction_filter`, `snipe_before_close_sec`, `gate3_min_edge`, `whale_convergence`.

**Dead code**: `_dipWatchAndExecute` (never called); disabled NEGATIVE_EV_EXIT block;
`_checkPaperFill`'s resting-limit simulation (paper entries no longer create pendings).

---

## 2. Phase 1 — Bugs, with root causes from the live data

### 2.1 `gate3_score` is 0.0000 on every trade (and `model_prob` is NULL)

**Data**: all 53 trades have `gate3_score=0.0000` and `model_prob=NULL`, while the
`signals` rows for the same instants have `ema_edge` populated (±0.01…±0.06, never 0/NULL)
and `ev_raw − ev_adj = 0.70` exactly (matching this code's 0.5%+0.2% cost model).

**Root cause, two layers:**
1. **Code defect (present in this tree)**: `_recordFilledTrade` writes
   `signal.emaEdge || signal.log?.gates?.gate3?.btcDelta || 0` — `||` coerces any falsy
   value (a legitimate 0.0 delta) to 0, and what is stored is the *raw 60s btcDelta in
   percent*, not a Gate-3 score. Values like 0.005–0.05 also visually round to ~0 at the
   UI's 4dp. Not a scale regression of the old `minEdge/100` bug — that fix
   (`emaEdge < minEdge` compared directly) is still in place.
2. **Build mismatch (the observed zeros)**: the writer that produced these 53 rows also
   left `model_prob` NULL, which this tree's INSERT always populates. The signals it
   wrote match this tree's cost model, so the running build was a close sibling that
   lacked the `emaEdge`/`model_prob` fields in the trade INSERT. `skipped_signals` being
   empty (0 rows against 3,314 SKIPs, with the INSERT wrapped in `.catch(() => {})`)
   corroborates a writer that either lacked the feature or silently failed the insert.

**Fix (implemented)**: persist `gate3_score` from the actual Gate-3 evaluation with
null-safe `??` semantics, always persist `model_prob`, and log a WARN if either is
missing at record time so a regression is visible instead of silent.

### 2.2 `min_confidence` not enforced (trades at 0.150–0.186)

The engine *does* gate on confidence and `_mainLoop` re-checks it. The trades at 0.15
were **legal under the configured threshold**, because:

1. `db.js` seeds `min_confidence = 0.150` ("polybot parity" migration).
2. **The settings API cannot change it** — `PUT /api/user/settings` has no
   `min_confidence` field (nor `min_strong_btc_delta`, `range_chop_gamma_override`,
   `phi_*`, `ensemble_phi_weight`, `min_depth_usdc`, `fillprob_floor`,
   `max_drawdown_pct`, `stale_lag_seconds`, `chase_threshold`). Whatever the operator
   types in the UI silently evaporates; DB stays 0.150 forever.
3. `parseFloat(x) || 0.42` treats a stored 0 as "unset".

**Fix (implemented)**: `min_confidence` (and the other orphaned knobs) added to the
settings route; both checks use null-safe parsing; the pre-execution check logs a
structured skip reason.

### 2.3 `max_daily_loss` ($50) failed to halt at −$108

**Data**: realized cumulative PnL on 2026-07-09 reached **−$342** intraday (14:29 UTC)
and trades kept opening. Under this tree the check would have halted new entries at the
first close ≤ −$50 — more evidence the running build differed — but the audit still found
real defects in the current implementation:

1. **Mode mixing**: sums `pnl` across ALL closed trades — paper (`SIMULATED`), live
   (`LIVE`) and `is_virtual` rows all count in one bucket. Virtual wins can mask real
   losses and vice versa.
2. **Fail-open**: any query error returns `false` (= keep trading).
3. **Realized-only**: an open $100 position's unrealized loss is invisible; with
   `max_trade_size=$100` (2× the $50 budget!) a single trade blows through the limit
   before the accumulator can see it.
4. **No halt state or log line**: it logs a WARN each blocked tick but records no
   explicit HALT event, and bypass paths exist (deferred flip leg
   `_completeDeferredFlipLegIfAny` calls `_executeTrade` directly).
5. Window is 24h-rolling, not calendar-day — acceptable, but undocumented.

**Fix (implemented)**: scope the sum to the current mode and exclude virtual trades;
include open-position worst-case exposure; fail-closed after repeated errors; a single
CRITICAL "TRADING HALTED" log + halt timestamp; the check also runs inside
`_executeTradeInner` so flip/deferred paths cannot bypass it.

### 2.4 `db.js` boot-time settings reset

The headline `UPDATE bot_settings … WHERE true` (line ~397) already COALESCEs every key —
it only fills NULLs. **But two other statements do stomp user values on every boot:**

1. `UPDATE bot_settings SET gate2_ev_floor = 2.00 WHERE gate2_ev_floor >= 5.00` — an
   operator who deliberately sets a ≥5% floor gets silently reset each boot.
2. The "balanced thresholds" UPDATE guarded by
   `WHERE min_btc_delta <= 0.005 OR gate2_ev_floor <= 0.50` can rewrite rows the operator
   configured to those exact values.

Also, CLAUDE.md *documents* the strict migration as "reset every boot", so the docs and
code disagree with each other in both directions.

**Fix (implemented)**: both statements converted to NULL-only backfills; the strict
migration kept as pure COALESCE; CLAUDE.md corrected.

### 2.5 Duplicate TRADE signals every 5s

**Data**: up to 31 TRADE-verdict `signals` rows for one market inside 3–5 minutes
(e.g. market 2846244: 31 rows 15:50–15:54). **No duplicate positions exist** — the trades
table has exactly one row per market; the one-position rule, per-market cooldown, atomic
execution lock and one-cycle-per-market lock all work. The spam is the *decision stream*:
`evaluate()` knows nothing about open positions, so it keeps re-emitting TRADE for a
market we already hold, and `_logSignal` inserts every one.

**Fix (implemented)**: `_mainLoop` passes an exclusion set (open/pending/cycle-locked
market ids) into `evaluate()`; the engine skips those markets with an explicit
`positionOpen` gate log. The decision stream now reflects what the bot can actually do,
and each blocked market saves 2–3 API calls per tick.

### 2.6 Stop-loss autopsy: the stop is NOT the problem

Counterfactual on all 24 HARD_STOP_LOSS trades (Gamma resolution fetched per market):

| Strategy | PnL |
|---|---|
| Actual (tiered stop as coded) | **−$808** |
| Hold every stopped trade to resolution | **−$943** |

Only 8/24 stopped trades would have recovered (33%); 16/24 resolved to $0. At the point
the stop fires (≥32% down), the position is genuinely ~2:1 to lose. The stop is
protective in aggregate — **the losses come from the entries, not the exits** (see §4:
the model's claimed EV is uncalibrated). This directly contradicts the "stops are firing
on book noise" hypothesis and is reported as found.

Two real defects remain and were fixed:
- the trigger uses the **raw** (unsmoothed) price on boundary books that tick ±1–2¢, so a
  single flicker can fire it → added a 2-consecutive-tick confirmation for the early stop
  (config `stop_confirm_ticks`, default 2, **PROVISIONAL**);
- tradeoff documented: on a binary market an interim −40% at T−2min still resolves 0 or
  1; the tiers already encode this, and the counterfactual shows removing the stop
  entirely would have cost another $135 on this sample.

---

## 3. CLAUDE.md / README vs code — all discrepancies found

1. **README "Hard Trade Cap $5"** vs DB default `max_trade_size = 100.00` (and 35/53
   trades sized at exactly $100). The two −$100 wipeouts are this discrepancy in action.
2. **README "Max Daily Loss $70,000"** vs DB default $50.
3. **README "Kelly Cap 25%"** vs DB default 0.10.
4. **README "Hard Stop −20%"** vs coded tiers −42/−38/−35/−32 early, −15 late (<30s).
5. **CLAUDE.md strict migration "reset every boot"** vs code COALESCE (NULL-only) — but
   two *other* statements do reset values (§2.4).
6. **CLAUDE.md pipeline "modelProb = yesPrice + btcEdge + micro + lag"** — lagBonus no
   longer exists in the heuristic; lag only eases the EV floor. Φ/ensemble now dominates.
7. **CLAUDE.md "EV_adj = raw − spread − slippage − fees"** — spread cost is hardcoded 0.
8. **CLAUDE.md says Gate 3 uses 30s window** — code uses `getWindowDeltaScore(60)`.
9. **evTrend**: code comment says "raised default floor to 8.0" but the DB column default
   (2.00) wins over the `|| 8.0` fallback → effective velocity floor −2, not −8.
10. **`gate3_min_delta`** code fallback 0.01 vs DB default 0.05.
11. **CLAUDE.md references a `bot_decisions` table** — does not exist in the schema.
12. **README paper-fill model "entry = ask + 25% of spread"** — actual code fills
    instantly at bestAsk (real book) or Gamma+5 ticks (boundary); the 25%-of-spread and
    resting-GTC-2-tick models are legacy text / dead code.
13. **docs/pipeline.md is a different bot** — random-draw fill probability, dynamic
    TP 20–40% / SL −4…−8%, `min_edge` gate, EMA-cross Gate 3, `snipe_before_close_sec`
    pre-filter: none of this exists in the code.
14. **`skipped_signals` analysis loop** (`_evaluateSkippedSignals`) runs every 2 min but
    the table has 0 rows — the writer's INSERT is fire-and-forget with a swallowed catch.
15. **`oracle_lag_max_ms` (5000)** exists in DB + CLAUDE.md parameter table but is never
    read; oracle lag is logged on signals only.
16. **Port/stack notes**: CLAUDE.md says DB shared with "Printer Mix" — meaning other
    writers may touch the same tables; relevant to §2.1's build-mismatch evidence.

---

## 4. What the data says about the edge (preview of Phase 3 tooling output)

- 53 closed paper trades, net **−$236**, win rate 49% — indistinguishable from a fair
  coin at these entry prices (Wilson 95% CI on 26/53 ≈ [36%, 62%]).
- Claimed-EV inversion is real in this sample: EV 2–5% bucket +$105 (n=5); EV >15%
  bucket (n=32!) −$177 with 40% wins. 60% of all trades claimed >15% edge — in an
  efficient 5-minute binary market that is a model error, not an opportunity.
- The heuristic manufactures divergence mechanically: `pHeur = yesPrice ± totalEdge` ⇒
  EV_heur ≈ totalEdge − costs regardless of whether the market is wrong. Through the 0.4
  ensemble weight, every 1pt of btcEdge/microEdge adds ~0.4pt of "claimed EV" by
  construction (quantified in `scripts/ev-autopsy.js`).
- `model_prob` was never persisted, so Φ-vs-heuristic calibration on historical trades is
  impossible — fixed going forward; `scripts/calibration.js` reports per-bucket Wilson
  CIs and will say "insufficient data" honestly until ≥300 fresh trades exist.

Everything actionable from this section is implemented behind config flags and marked
**PROVISIONAL pending ≥300 fresh paper trades** — see IMPROVEMENTS.md.

---

## 5. Current-state addendum — 2026-07-14

The original sections above are a point-in-time audit and must not be read as
the current production map. The full current-state research report is
`THREE_BOT_REPORT.md`. New findings from the larger collector dataset:

1. **MAIN paper-entry contamination:** `GBMSignalEngine` replaced real YES/NO
   books with a synthetic WS/Gamma `mid ± 1¢` object. `BotInstance` then read
   that object as executable liquidity. Recent matched examples paid 0.52 in
   paper against a 0.96 venue ask. Fix: signals retain side-specific real books,
   and Gate 2 is recomputed at actual ask after depth walk and latency penalty.
2. **Legacy P&L quarantined:** `main_exec_honest_anchor` is set once on the first
   corrected boot. MAIN dashboard evidence and history start at that anchor;
   the prior cohort is labelled execution-contaminated.
3. **Fees were still inconsistent:** signal EV subtracted a flat 20bp and close
   P&L charged 2% of positive gains. Current crypto taker fees are now modeled as
   `shares × 0.07 × p × (1-p)` at each taker match. Resolution has no exit fee;
   maker rebates are never credited.
4. **Current calibration:** Φ Brier 0.2706 (worse than 0.2495 base-rate),
   heuristic 0.2171, ensemble 0.2137. The broad MAIN signal has directional
   information, but executed-trade Brier 0.2311 is worse than that selected
   cohort's 0.2214 base-rate reference.
5. **Claimed EV is not calibrated to return:** on 408 closed trades,
   `corr(EV_adj, realized ROI)=0.027`; the heuristic's mechanical construction
   remains a source of claimed rather than demonstrated edge.
6. **Three-candidate forward study:** MAIN EXEC-HONEST plus mutually exclusive
   ETH late taker/maker arms. ETH parameters are forward-frozen at 45–75
   seconds remaining. The original developmental evidence used $3 per fill;
   the current capital-versioned forward cohort uses $10. Historical
   candidate-compatible ETH evidence is
   n=17, +$5.11 at $3 sizing, mean 95% CI `[-$0.379,+$0.821]`.
7. **Shared $500 envelope (current `500usd-v1` cohort):** $10 stake, max 3
   positions/$30 gross, rolling loss
   halt -$30 and hard drawdown -$50. These are capital-preservation limits, not
   fitted alpha thresholds.

No live-order call site changed. `paper_trading` remains default true.

---

## 6. Main reconstruction addendum — 2026-07-16

The corrected Dublin cohort invalidates the idea that Main became profitable
after paper-fill repair: at the reconstruction cutoff, 82 independent closed
markets had lost $110.02 with a 40.2% win rate. Seventy-three
`MARKET_RESOLVED` exits had lost $90.79, so the principal
failure is entry selection, not interim stop logic. Both directions were
negative. The untouched residual challenger also lost $56.20 at 2× costs over
47 candidate markets. Neither is eligible for live trading.

Legacy Main's paper executor is now retired by default and clearly labelled as
a telemetry control. `MAIN_V2_resolver_quorum` starts a distinct frozen,
zero-history, paper/shadow-only forward test using fresh Chainlink RTDS +
Coinbase agreement, a Binance residual, actual CLOB depth and a 2×-cost gate.
Prior H49 observations are disclosed as mechanism-selection data and excluded
from evidence. See `MAIN_V2_AUDIT.md` and `scripts/main-v2-report.js` for the
full specification and promotion rule.
