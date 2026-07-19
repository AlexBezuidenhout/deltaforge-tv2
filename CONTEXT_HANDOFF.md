# deltaforge — Full Context Handoff

**Written:** 2026-07-13 ~09:00 UTC, by Claude (Fable 5), for any AI picking this up cold.
**Purpose:** everything a fresh instance needs to understand this project, its history,
its current state, and — most importantly — the mistakes already made so they aren't
repeated. This project has fooled its own operator with fake profit numbers *twice*.
Read the incident log (§7) before trusting anything that looks good.

---

## 0. READ THIS FIRST — the prime directives

1. **This is paper/shadow trading only. Nothing may ever place a real order or touch
   real capital without the human operator explicitly, separately asking for it.**
   `paper_trading = true` in `bot_settings` for the main bot; George is paper-only by
   construction; BORG has no order-placement code path *at all* — it logs intended
   orders and scores them against recorded tape, structurally incapable of trading.
2. **Every "this looks profitable" claim in this system's history has needed a second
   look.** Two confirmed cases: (a) George's dashboard once showed +$287 that was
   duplicate rows from 3 concurrent server processes; (b) BORG's early +$287 "profit"
   was proven to be unbounded-inventory variance, not skill, once tape-verified. When
   a number looks good, the next step is to try to break it, not to report it.
3. **Nothing gets promoted from "looks good" to "confirmed" below ~300 trades/fills
   per bucket.** This is a hard rule established early and re-derived independently
   several times because smaller samples kept flipping sign. Any pattern reported on
   <300 n must be labeled provisional, full stop.
4. **No parameter may be fitted on a sample and judged on that same sample.** Every
   flag/threshold change in this codebase is paired with a pre-registered metric to
   be evaluated on *future* data only.
5. **Two separate runtime-mirror-under-launchd setups exist, and editing the repo
   does NOT change what's running.** See §3. This has caused real confusion — always
   deploy after editing, always verify the deployed code matches the repo before
   trusting a live number.

---

## 1. What this is

`~/Desktop/deltaforge` — a three-bot research/paper-trading system for Polymarket's
5-minute up/down binary markets (originally BTC-only, now multi-asset: btc, eth, sol,
bnb, doge, xrp, hype). Node.js/Express backend, Postgres (Neon, serverless, **512 MB
hard cap on this plan** — this has caused real incidents, see §7), single-page HTML
dashboard, served on **port 3004**.

Three bots, three different philosophies, deliberately kept structurally separate so
they can be compared honestly:

| Bot | Philosophy | Fill honesty | Status |
|---|---|---|---|
| **MAIN** | Φ-model + heuristic ensemble, 11-gate EV pipeline | Simulated ("strict fills": requires real price to trade through the limit, not just touch it) | Running, shows a real signal-level edge (see §4) |
| **GEORGE** | Chainlink-oracle-divergence anchor, flat stakes, hold to resolution | Simulated (pessimistic entry penalty) | Running but **own signal is dead** (kill executed 2026-07-13, see §5) |
| **BORG** | Shadow-only: logs intended orders, scores them against *real recorded tape* | The only genuinely rigorous one — back-of-queue fill simulation against actual CLOB print history | Running, one active strategy (`G_late_arb`), everything else tried has died (see §6) |

The project's own internal discipline document is `borg/EVAL_PROTOCOL.md` — read it,
it's short and it's the rulebook the whole system is supposed to obey (≥500 scored
trades or 14 days, Bonferroni-corrected significance, cost-grid sensitivity, no
mid-window parameter changes). MAIN and George don't formally follow EVAL_PROTOCOL but
have absorbed its spirit (300-trade bar, pre-registration) through repeated incidents.

---

## 2. Repository layout

```
~/Desktop/deltaforge/
  CLAUDE.md                 project context (Printer Blast / Polybot lineage — mostly
                             legacy detail, this handoff supersedes it for "what's true now")
  CONTEXT_HANDOFF.md         <- this file
  INTEGRITY.md               Phase-1 audit: duplicate-trade root cause, dedup, DB hygiene
  ANALYSIS.md                Phase-2 audit: fill-realism gap, calibration, A_maker autopsy
  IMPROVEMENTS.md            Phase-3 flagged changes + pre-registered metrics + verification log
  RELAUNCH.md                Phase-4 relaunch evidence, baseline snapshot, edge verdicts
  implementation_plan.md     UNRESOLVED: George-live-trading plan, blocked on wallet question (§8)

  src/                        MAIN + GEORGE + server (this is what runs on :3004)
    index.js                  Express app, /api/health, crash guards, launchd-friendly
    models/db.js               ALL schema migrations live here (one big idempotent SQL block)
    bot/
      BotInstance.js            MAIN bot: main loop, gates, paper-fill sim, exits
      GBMSignalEngine.js         MAIN's signal pipeline (scenario→micro→EV→gate3)
      GeorgeBotInstance.js       George: tick loop, kill-switch gate, position mgmt
      GeorgeSignalEngine.js      George's divergence-anchor probability model
      SignalEnsemble.js          Φ + heuristic blend (the clamp01 bug lived here, §7)
      PhiModel.js                closed-form Φ(BTC-move) fair-probability model
      PolymarketFeed.js          Gamma/CLOB discovery, multi-asset ASSET_DEFS registry
      BinanceFeed.js             per-symbol price feed (parametrized, multi-asset)
      ChainlinkFeed.js           per-asset on-chain oracle reader (parametrized)
      BotManager.js              owns bot instances, routes MAIN's 100%-conf signals
                                   to George's (now-dead) mirror path
    routes/
      user.js                    dashboard data, settings, strict-era P&L split
      bot.js, borg.js, claude.js  per-bot APIs; claude.js = 3-bot evidence-package analysis
    services/, middleware/       encryption, auth

  borg/                       shadow-only research system (NOT served by src/index.js)
    README.md, THESES.md, EVAL_PROTOCOL.md, RECON.md, SHADOW.md, NEXT.md
                               <- NEXT.md is BORG's own living checklist, read it
    recon/                     collector.js + per-asset feeds (binance.js, hyper.js,
                               feeds.js facade, markets.js, clob.js, chainlink.js, db.js)
    shadow/                    engine.js (order logger) + strategies.js (the strategy
                               graveyard + G_late_arb) + score.js (offline tape-replay scorer)

  scripts/
    q.js                       `node scripts/q.js "SELECT ..."` — quick DB query CLI, USE THIS
    deploy-server.sh            deploys src/+public/ to the launchd runtime mirror

  public/index.html           the ENTIRE dashboard frontend — one big file, no build step
```

---

## 3. Runtime & deployment — THE MOST IMPORTANT OPERATIONAL FACT

**macOS launchd cannot read `~/Desktop` (TCC sandboxing).** Both long-running
processes therefore run from *mirror* directories outside Desktop, kept in sync by
deploy scripts. **Editing files in the repo does nothing to the running system until
you deploy.** This has bitten every session that forgot it.

| Process | launchd label | Runs from | Deploy command | Log |
|---|---|---|---|---|
| Server (MAIN+George+dashboard+API) | `com.deltaforge.server` | `~/.deltaforge-runtime` | `bash scripts/deploy-server.sh` | `~/Library/Logs/deltaforge-server.log` |
| BORG collector + shadow engine | `com.borg.recon` | `~/.borg-runtime` | `bash borg/recon/deploy.sh` | `~/Library/Logs/borg-recon.log` |
| BORG scorer (5-min one-shot) | `com.borg.score` | `~/.borg-runtime` | (same deploy script) | `~/Library/Logs/borg-score.log` |

All three are `KeepAlive + RunAtLoad` — they survive crashes, network outages, logout,
and reboot. Verify a deploy actually landed with:
```sh
diff -rq ~/Desktop/deltaforge/src ~/.deltaforge-runtime/src
diff -rq ~/Desktop/deltaforge/borg/recon ~/.borg-runtime/borg/recon
diff -rq ~/Desktop/deltaforge/borg/shadow ~/.borg-runtime/borg/shadow
```
(empty output = in sync; a log-file-only diff is expected and fine).

**Restarting the server does NOT restart BORG and vice versa** — they're independent
launchd jobs. To force-restart either without redeploying: `launchctl kickstart -k
gui/501/com.deltaforge.server` (or `com.borg.recon`).

**In-memory vs DB state**: bot paper balances are cached in-memory inside the running
process. A raw `UPDATE bot_settings SET paper_balance=...` changes the DB but NOT the
number the bot reports live — you must restart the server process for it to reload.
This is a recurring footgun; always restart after a manual balance edit.

---

## 4. MAIN bot — deep dive

### Architecture
`GBMSignalEngine.evaluate()` runs a per-market gate pipeline: freshness → no-chase →
scenario filter (RANGE_CHOP/NEWS_SPIKE hard-blocked) → btcFlat precheck (now **per-asset**,
see multi-asset note below) → time gate → boundary-book guard → depth floor → **Gate 2
(EV floor, the primary filter)** → EV-decay → **Gate 3 (momentum direction)** →
confidence floor. Gate 1 (microstructure confidence) is **informational only by
design** — it never blocks a trade, this is intentional, do not "fix" it.

`SignalEnsemble.combine(pPhi, pHeur, {phiWeight})` blends Φ-model and a legacy
heuristic into `modelProb`. **`ensemble_phi_weight = 0.00`** currently (i.e. Φ is
muted — see the clamp01 bug in §7, this was fixed 2026-07-12; before the fix, "muted"
was a lie and Φ still leaked in). When muted, `modelProb` is exactly `p_heur`.

### Paper fill simulation ("strict fills")
`_checkPaperFill()` in `BotInstance.js`. For boundary-book (Gamma-sourced) markets —
the vast majority — a simulated resting limit is placed at (price + 1 tick); it only
counts as filled when the **real live Gamma price** trades **strictly through** the
limit (≥1 tick past it) for **2 consecutive ticks**. This is a proxy for "did a real
counterparty cross me," not a full order-book/tape replay (BORG's scorer does the
latter, more rigorously, with size-aware back-of-queue logic). `strict_paper_fills`
flag, default **true** since 2026-07-12. Before this fix, a flat market counted as an
instant fill — tape replay proved 9/25 trades would never have actually filled, 8 of
those 9 were "wins," i.e. the old number was a mirage.

**Cutoff for honest data: `created_at >= '2026-07-12T10:00:00Z'`.** Anything before
that used the old instant-fill sim and is an *upper bound*, not a result. This cutoff
is now hardcoded as `STRICT_FILL_LIVE_AT` in `src/routes/user.js` and surfaced
permanently on the dashboard as a separate "STRICT-FILL-ERA P&L" tile, deliberately
never merged into the all-time number.

### Current findings (as of 2026-07-13, n≈142 strict-era trades, growing)
- **Real signal-level edge, verified independently multiple times**: heuristic Brier
  0.2289 vs market price 0.2425 (n=1199 post-phi-mute signals). Small (~1.4 Brier
  points) but persistent across every re-sample this project has done.
- **Strict-era P&L is significantly positive**: ~+$375 over ~142 trades, ~$2.6/trade,
  t-stat ≈3.5 (p<0.001 against zero). Win rate ~65%, Wilson 95% CI roughly
  [56.6%, 72.2%], clears the ~55% breakeven implied by average entry price.
- **BIGGEST ACTIONABLE FINDING, not yet acted on**: counterfactual exit logging
  (added 2026-07-13, `_evaluateStopCounterfactuals()`, runs every 2 min) directly
  measures what holding every stopped/locked position to resolution would have paid,
  on the *same actual trades*. Both `HARD_STOP_LOSS` (n=27) and `PROFIT_LOCK` (n=25)
  **lose to simply holding** — combined −$175.90 versus what holding would have
  earned. Mechanism: 5-minute binaries have almost no "time value" to salvage by
  exiting early once a real edge exists; panic/lock exits just forfeit resolution
  value. `EV_FLIP` (closes a loser, reverses direction, `flip_threshold=5%`) is also a
  net loser (−$31.55/13 trades). **Proposed but not yet implemented**: a flagged
  `exits_hold_only_mode` that disables all three exit mechanisms for new positions,
  pre-registered kill/confirm at n≥150 combined (currently 52, need ~100 more). This
  is the single highest-confidence next code change in the whole system — ask the
  operator before implementing, it changes live trading behavior.
- **A correction to an earlier, wrong finding**: an earlier report recommended making
  `gate1_threshold` (0.45) a hard block based on a 40-trade window. Re-tested at
  n=142, it **reversed** — below/above 0.45 are now statistically indistinguishable.
  **Do not implement `gate1_blocking=true`.** Textbook example of why the 300-trade
  rule exists.
- `ev_adj` (the bot's own EV estimate, which drives Kelly position sizing) still shows
  ~zero correlation with realized P&L (r=0.0475, n=142, not significant) — odd given
  `p_heur` is provably better-calibrated than price; underpowered, not yet resolved.
  Worth revisiting as n grows.
- High-entry-price trades (≥0.80) remain a small consistent loser (n=7, avg
  −$4.67/trade) — same mechanism suspected (capped upside, same downside) as before,
  still too small (n<300) to act on.
- Per-asset splits exist now (multi-asset since 2026-07-12 PM) but are all <300 n,
  provisional only. LAG_EDGE scenario is the most-sampled scenario bucket (n=60,
  +$2.65/trade) and has survived 4× sample growth without degrading — most credible
  scenario candidate, still provisional.

### `close_reason` taxonomy (fixed a mislabeling bug 2026-07-13)
`HARD_STOP_LOSS` = genuine early exit at live/entry price. `LATE_STOP_RESOLVED` = new
label — the late-window stop branch can fetch the market's true resolution price as a
fallback; if the market had already settled *in your favor* between ticks, that's a
resolution capture, not a stop, and must not be counted as a loss-mechanism label.
(Bug instance found: a doge trade closed exit=1.00, pnl=+2.19, labeled
`HARD_STOP_LOSS` — nonsensical. Fixed.)

### Multi-asset (since 2026-07-12 PM)
One `BinanceFeed(symbol)` instance per enabled asset (`asset_config.enabled_main`),
one `MicrostructureEngine` per asset, per-market feed routing in the evaluate loop.
The btcFlat precheck is per-asset — a flat BTC no longer blocks an ETH signal. `trades`,
`signals`, `skipped_signals` all carry an `asset` column now.

---

## 5. GEORGE — deep dive

Chainlink-divergence model: computes `p(UP)` from the oracle's deviation-band/
heartbeat mechanics vs. the window-open anchor, compares to Gamma market price, trades
flat stakes, holds to resolution (no interim exits — this was deliberate by design,
never mid-window-exit George).

### The mirror-trade incident (root of the first fake-profit mirage)
`BotManager.js` used to auto-fire George into any of MAIN's 100%-confidence signals
(`forceTakeTrade`). This produced George's misleadingly good headline P&L
(+$267.99 at 12W/1L) — it was really just MAIN's best trades, double-staked, not an
independent signal. **Fixed**: `george_mirror_enabled` flag, default **false**,
quarantined. All-time George numbers still contain this historical contamination in
the aggregate — always split by `market_question LIKE '[MAIN BOT CONF 100%]%'` (mirror)
vs not (own signal) before trusting any George number.

### The kill (executed 2026-07-13)
George's **own** divergence signal (mirror excluded) hit its pre-registered kill
criterion: 71/158 = 44.9% win rate, Wilson 95% upper bound ≈52.6% < the 55% bar, at
n=158 > the pre-registered n=100 threshold. **`george_own_signal_enabled = false`**
(default) now gates capital — the engine still evaluates and logs every signal (full
visibility preserved), it just doesn't open positions. Verified live: zero own-signal
George trades opened since the flag went live.

### The resurrection experiment (pending operator decision, NOT active)
A separately, freshly pre-registered hypothesis exists behind
**`george_resurrection_enabled`** (default **false**): trade only when
`oracle_age_sec < 600 AND divergence_bps >= 30 AND entry ∈ [0.35, 0.65]`. Parameters
were motivated by the killed sample, so per discipline they may **only be judged on
fresh data** — same n=100 / Wilson-upper-55% kill applies independently. **Do nothing
here unless the operator explicitly asks to flip this flag on.**

### Diagnostics gathered (not yet actionable, n too small)
- "Longshot buying against a coin-flip model" (entering <0.40 price when
  p_model≈0.47–0.56, i.e. no real conviction): 9/9 losses in a 30-trade window, −$225.
  Logged, not yet a flag.
- sol oracle staleness was found to be a genuine pipeline bug (~17h stale average) —
  infrastructure issue, independent of George's signal death, worth fixing if anyone
  builds more Chainlink-anchored logic later.
- btc loses even with a *fresh* oracle (−$113/54, avg oracle age 1166s) — so
  staleness explains sol's badness specifically, not George's failure overall.

---

## 6. BORG — deep dive

The only structurally-honest measurement system in the project: `borg/recon/collector.js`
records real order-book snapshots, CLOB print tape, taker prints, and Binance/Hyperliquid
bars at 1s resolution for every configured asset, with **no order-placement code path
anywhere in the tree** — it cannot trade by construction. `borg/shadow/engine.js`
strategies log the *exact* order they'd place (side/price/size/full feature vector);
`borg/shadow/score.js` runs every 5 minutes, replays the recorded tape, and decides —
honestly, back-of-queue, size-aware — whether that hypothetical order would have
filled, and at what P&L, after a 2%-of-notional taker fee and a 0.5×/1×/2× cost-grid
sensitivity check.

**Everything BORG produces is `phase='pilot'`** until an operator explicitly freezes
parameters and flips `PHASE` to `'eval'` in `shadow/engine.js` (tagged commit). Per
`EVAL_PROTOCOL.md §3`, pilot data is machinery-tuning, not evidence, regardless of how
good or bad it looks. This has not happened yet — BORG's formal recon-adjudication
(§1 of `borg/NEXT.md`) is overdue as of this writing.

### Strategy graveyard (all retired, reasons kept for the record)
| Strategy | Verdict | Why |
|---|---|---|
| `F_yield` | DEAD | breakeven win rate needed 97% at fees, achieved 92.1% — arithmetic, not variance |
| `D_consistency` | DEAD | min-edge (1%) < round-trip taker cost (~2%) by construction |
| `A_maker` | DEAD, final | lifetime ≈ −$1,353 across ~1,100 fills. One lucky afternoon (+$282, unbounded same-side inventory in near-strike markets getting bailed out by outcome, proven luck via inventory-cap counterfactual: +$282 → +$7.56) followed by three consecutive losing eras. Toxicity/adverse-selection-by-taker-size hypothesis was tested and **refuted/inverted** — calm-market fills were worse, not fast-move fills. |
| `A2_maker_capped` | DEAD | inventory cap (40 tokens/side) + Φ-sanity band engineering *worked* (cut A_maker's per-fill loss ~72%) but still net negative at n=605 (−$0.52/fill). Concentrated in btc specifically (−$2.25/fill) vs near-breakeven elsewhere (−$0.04/fill). Fully retired 2026-07-12 21:41Z in favor of a structurally different approach (below) — **do not revive**, even though a later audit report (written before it knew of this retirement) recommended an "A2-ex-btc" re-test; that was deliberately not implemented, see `borg/NEXT.md §2b`. |

### The one live strategy: `G_late_arb` (Thesis G)
Structurally different from the maker family — it's a **taker**, not a resting quote.
Root insight: the maker strategies' entire problem was adverse selection (informed
takers crossing their resting quotes); G flips the dynamic by *becoming* the informed
taker. Fires in the last 5–75s of a window when Φ-fair implies ≥88% certainty on one
side and the CLOB ask lags that certainty by ≥5¢ (Polymarket's book is slow to reprice
near resolution). As of the last audit read: n=183, 89.6% win rate, +$0.835/fill,
positive on 6/7 assets. Two important caveats already measured: (a) **the marginal
unit already loses** — `pnl_2x − pnl_1x = −$30.94`, i.e. doubling size destroys ~20%
of profit, so this strategy has near-zero capacity beyond its current $10/leg stake,
**never increase size**; (b) payoff shape is penny-picking (many small wins, rare
~$5 losses) — one bad regime could erase a week, the loss-tail distribution isn't
characterized yet. Pre-registered: confirm at n≥300 (1× stake only, forever) if
per-fill > $0.40 AND worst single-market P&L > −$30; kill if per-fill < $0.10. `hype`
is G's only negative asset so far (n=48, small) — judge separately at its own n=300,
don't fold into the aggregate verdict.

### Multi-asset (since 2026-07-12 PM)
`asset_config` table (shared with MAIN/George — the single switchboard for all three
bots) drives which assets BORG watches. Binance multi-symbol combined WS stream +
Hyperliquid REST poller (`hyper.js`, for `hype`, which has no Binance listing) behind a
`Feeds` facade keyed by asset. §7 halt rule (pause quoting on stale feed) is per-asset
— a dead `hype` feed no longer cancels healthy `btc` quotes.

---

## 7. Incident log — chronological, with root causes (don't repeat these)

1. **Duplicate-trade P&L inflation** (root-caused 2026-07-12). THREE concurrent
   `node src/index.js` processes were running simultaneously (stale nohup'd instances
   never killed across sessions), each auto-starting both bots — every signal fired
   up to 3×, producing duplicate rows milliseconds apart. This is what made George's
   headline P&L look inflated (compounded with the separate mirror-trade issue, §5).
   **Fix**: Postgres advisory lock (`pg_try_advisory_lock`) — only the lock-winning
   process runs bots; losers boot as dashboard/API-only. Plus DB-level unique indexes
   (`george_trades_one_per_market`, `trades_one_open_per_market`) as a structural
   backstop. Verify no duplicates exist: dedup queries are in `INTEGRITY.md §1`.

2. **DB-full silent corruption** (2026-07-11). Neon's 512MB cap was hit; every write
   failed for **5 hours** with no alerting. BORG's tape tables were truncated to
   recover space, which also poisoned in-flight scoring (orders scored against empty
   tape silently read as `filled=false`). **Fix**: `/api/health` now runs a live
   1-row write probe, reports `dbWritable`/`writeErrors`/`dbSizeMb`, and the dashboard
   shows a sticky red banner within one 30s poll. Tape retention was cut from 48h → 6h
   → 2h as multi-asset multiplied ingest rate. Scorer prune now runs *after* scoring
   and never deletes tape newer than the oldest unscored order.

3. **BORG's early "+$287 profit" was luck, not skill** (proven 2026-07-12). See
   `A_maker` entry in §6's strategy graveyard. Same shape as incident #1: a good
   number that looked like an edge and wasn't, caught by tape-verified replay rather
   than trusting the raw P&L.

4. **The phi-mute clamp01 bug** (found & fixed 2026-07-12). `SignalEnsemble.combine()`
   clamped `phiWeight` through `clamp01()` — a helper meant for *probabilities*, whose
   floor is 0.01. Setting `ensemble_phi_weight=0` therefore silently became 0.01: Φ
   (Brier 0.31, worse than a coin) kept leaking into `modelProb`, and the
   agreement-based confidence multiplier (×1.10/×0.70) kept distorting position
   sizing, even though the operator believed Φ was fully muted. Verified via 10
   live signals showing `model_prob/p_heur` ratio was exactly 0.01, not 0. **Lesson**:
   a "weight = 0" flag doesn't disable a code path unless you check the actual
   arithmetic, not just the config value.

5. **Fill-realism inversion** (proven 2026-07-12, root of the "strict fills" fix, §4).
   Instant paper fills were optimistic by construction. Tape replay of overlapping
   trades flipped MAIN's paper P&L from +$10 to −$54 on the same 25 trades. Mechanism:
   a resting buy limit fills preferentially when the market moves *against* your
   signal (someone sells down through your price) — when the signal is right, price
   runs away and the order never fills. This is a structural property of the market,
   not a MAIN-specific bug, and it independently showed up in George's mirror-trade
   replay and in BORG's A_maker data too — three separate measurements of the same
   phenomenon.

6. **7-hour wedged Binance feed** (2026-07-12→13). In-process WS reconnect logic
   failed for 7 hours straight while a *fresh process* on the same host connected in
   2 seconds — cause never fully diagnosed (not an fd leak, not a network outage).
   In-process retries cannot fix a wedged process state. **Fix**: after ~5 minutes of
   continuous staleness, the collector now calls `process.exit(1)` and lets launchd's
   `KeepAlive` replace the whole process. Worst case is now a ~5 min gap, not hours.

7. **Overnight server death from an unhandled network error** (2026-07-13). A full
   network outage raised an unhandled socket `'error'` event (`EADDRNOTAVAIL`) that
   crashed the then-nohup'd server; it had no supervisor and stayed dead all night —
   the last unsupervised process in the system. **Fix, two-layer**: (a) transient
   network error codes are now caught and survived (every feed self-heals; anything
   else still `exit(1)`s); (b) the server now runs under `com.deltaforge.server`
   launchd (see §3), so even a hard crash resurrects it in <20s. SIGKILL-tested.

8. **Recurring false-positive "main_bot/george_bot silent" health banner**
   (2026-07-13). Heartbeats were written *inside* the tick body, at the top of the
   function. When a tick hung on a slow network call (RPC retries, Polymarket
   timeouts — exactly what a network blip causes), the re-entrance guard blocked
   every *subsequent* tick from even attempting a heartbeat write — so a single slow
   call read as "bot down" for as long as the hang lasted. Both bots share network
   dependencies, which is why the banner always fired for both simultaneously.
   **Fix**: heartbeats moved to independent 10-second timers, decoupled from tick
   completion; they carry `lastTickAgeSec` in their metadata so a genuinely wedged
   tick loop is still visible without false-redding on routine network noise.

9. **Exit close_reason mislabeling** (found & fixed 2026-07-13). The late-window
   stop-loss branch fetches the market's true resolution price as a fallback when
   available. If the market had already settled in the position's favor between
   ticks, the close was actually a resolution capture — but it was unconditionally
   labeled `HARD_STOP_LOSS` regardless of outcome. Concrete instance: a doge trade
   closed at exit=1.00, pnl=+$2.19, logged as a stop-loss. **Fix**: split into
   `HARD_STOP_LOSS` (genuine early exit) vs `LATE_STOP_RESOLVED` (closed at the real
   resolution price, may be a win) based on which price source was actually used.

**Meta-lesson across all nine**: every incident was caught by either (a) tape/data
replay against ground truth, (b) an independent second measurement disagreeing with
the first, or (c) actually reading the arithmetic instead of trusting a config flag's
name. None were caught by the number "looking wrong" — they all looked *fine* until
checked.

---

## 8. Open items / pending decisions (as of 2026-07-13 ~09:00 UTC)

1. **NEW, unflagged, found while writing this handoff**: `/api/health` shows 5 recent
   `readErrors`, all `column "is_admin" does not exist :: SELECT is_admin FROM users
   WHERE id = $1`, recurring every 10–15 minutes since 08:28Z. Source:
   `src/middleware/auth.js:69` and `src/routes/admin.js` reference a `users.is_admin`
   column that was never migrated into the schema (`src/models/db.js` has no
   `ADD COLUMN is_admin`). Something is polling an admin-gated route periodically.
   **Not yet investigated or fixed** — flagging for whoever picks this up next.
2. **MAIN's `exits_hold_only_mode` proposal** (§4) — highest-confidence pending code
   change in the system, not yet implemented, needs operator sign-off since it
   changes live trading behavior.
3. **George's resurrection experiment** — flag exists (`george_resurrection_enabled`),
   default off, needs an explicit operator decision to enable.
4. **BORG recon adjudication overdue** — `borg/NEXT.md §1`: pre-registered Q1–Q6
   queries against `borg/recon/analysis/` were supposed to run after 24–48h of clean
   data (clock restarted 2026-07-11 13:36 UTC after a data-quality incident); this
   has not been done. Needed before any BORG thesis can move from pilot toward a
   frozen evaluation window.
5. **George live-trading plan blocked** — `implementation_plan.md` (repo root,
   untracked) proposes making George trade with real capital, blocked on a wallet
   question: MAIN and George sharing one Polymarket wallet would let their opposite
   positions offset each other, potentially trapping MAIN unable to sell. Needs
   operator decision (safest option: a dedicated second wallet for George). This is
   the only path toward real capital anywhere in the project, and it's explicitly
   paused pending a decision, not in progress.
6. **`ev_adj`-vs-realized-P&L correlation** — still ~zero (r=0.0475, n=142,
   underpowered) despite `p_heur` having a real calibration edge. Worth re-checking
   as the sample grows; if it never firms up, the gates/multipliers on top of
   `p_heur` may be diluting a real signal into noise, which would itself be an
   actionable finding.

---

## 9. Ops cheat-sheet

```sh
# Quick DB query (from repo root)
node scripts/q.js "SELECT ..."

# Deploy code changes (REQUIRED after any src/ or public/ edit)
bash scripts/deploy-server.sh

# Deploy BORG changes (REQUIRED after any borg/ edit)
bash borg/recon/deploy.sh

# Check everything is healthy
curl -s http://localhost:3004/api/health | python3 -m json.tool

# Force-restart without redeploying (e.g. after a manual DB balance edit)
launchctl kickstart -k gui/501/com.deltaforge.server
launchctl kickstart -k gui/501/com.borg.recon

# Verify deployed code matches the repo (do this before trusting a live number
# after making edits — silently-stale deploys have happened before)
diff -rq ~/Desktop/deltaforge/src ~/.deltaforge-runtime/src
diff -rq ~/Desktop/deltaforge/borg/recon ~/.borg-runtime/borg/recon
diff -rq ~/Desktop/deltaforge/borg/shadow ~/.borg-runtime/borg/shadow

# Logs
tail -f ~/Library/Logs/deltaforge-server.log
tail -f ~/Library/Logs/borg-recon.log
tail -f ~/Library/Logs/borg-score.log

# Authenticated API call pattern (JWT signed locally, userId=1)
TOKEN=$(node -e "require('dotenv').config();console.log(require('jsonwebtoken').sign({userId:1},process.env.JWT_SECRET))")
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3004/api/user/dashboard
```

---

## 10. Current state snapshot (2026-07-13 08:55 UTC — WILL BE STALE, treat as a
     point-in-time reference only, always re-verify with the commands above)

- **Health**: `ok`, all 4 heartbeats fresh (main_bot 7s, george_bot 4s,
  borg_scorer 284s, borg_collector 2s), zero write errors, 5 unrelated read errors
  (see open item #1), DB 311 MB / 512 MB cap.
- **Paper balances**: MAIN $504.01, George $500.00, BORG $500.00 rebased (all reset
  to $500 at 2026-07-13T08:04:53Z per operator request; `pnl_reset_at` and
  `borg_paper_reset_at` both stamped then — daily/strict-era displays respect these
  markers without deleting any historical rows).
- **Key flags**: `paper_trading=true`, `strict_paper_fills=true`,
  `ensemble_phi_weight=0.00` (correctly muted post-clamp01-fix),
  `george_mirror_enabled=false`, `george_own_signal_enabled=false` (kill executed),
  `george_resurrection_enabled=false` (pending decision), `flip_threshold=5%`,
  `hard_stop_loss_pct=60`, `gate1_threshold=0.45` (informational only, not blocking),
  `gate2_ev_floor=0.80%`, `kelly_cap=10%`, `kelly_prob_shrink=0.5`,
  `max_trade_size=$12.50`, `max_daily_loss=$200`, `claude_model=claude-fable-5`.
- **Asset registry** (`asset_config`): btc/eth/sol/bnb enabled on all three bots;
  doge/xrp enabled on MAIN+BORG only (no verified ETH-mainnet Chainlink feed, so
  George skips them); hype enabled on BORG only (no Binance listing — priced via
  Hyperliquid REST — and not yet enabled for MAIN/George).
- **BORG active strategy**: `G_late_arb` only (A_maker and A2_maker_capped fully
  retired, code removed from the active strategy factory but kept in the file for
  the historical record).
- **Largest DB tables**: `borg_clob_events` 123.8MB, `borg_book_snaps` 93.6MB,
  `borg_taker_trades` 50.6MB (all tape, pruned on a rolling 2h window),
  `borg_shadow_orders` 10.9MB, `trades`/`signals`/`george_signals` all small (<3MB).

---

*End of handoff. If you're a fresh AI instance reading this: verify §10 immediately
with the commands in §9 before saying anything about current performance to the
operator — this file will already be somewhat stale by the time you read it. The
rest of the document (architecture, mechanics, incident log, discipline) should
still be accurate regardless of how much time has passed, unless you find evidence
otherwise in the code or git log.*
