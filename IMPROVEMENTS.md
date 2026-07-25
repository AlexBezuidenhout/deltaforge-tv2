# IMPROVEMENTS.md — Phase 3 Changes (2026-07-12)

Each change is tied to a Phase 2 finding (ANALYSIS.md), sits behind a config
flag, and has a pre-registered success metric evaluated ONLY on new data. The
prior audit's document is preserved at `docs/IMPROVEMENTS-2026-07-10.md`.

---

## MAIN

### 1. Strict paper fills — `strict_paper_fills` (bot_settings, default TRUE)
**Finding:** the Gamma-path fill sim filled when the price merely *sat at* the
limit for 2 ticks — true at placement by construction (limit = gamma + 1 tick),
so a flat market counted as a fill. Tape replay: 9 of 25 trades would never
fill, 8 of those 9 were paper wins; achievable P&L flipped +$10 → −$54.
**Change** (`src/bot/BotInstance.js` `_checkPaperFill`): fill now requires the
gamma-derived token price to trade **strictly below** the limit (≥1 tick
through), i.e. evidence a counterparty actually crossed. Real-CLOB-book path
unchanged (marketable-limit-vs-displayed-ask semantics + SlippageEngine already
model that case).
**Success metric:** over the next ≥300 paper entries, paper fill rate should
drop to ≈ the tape-replay rate (~60-65%), and time-to-fill should average
~90-100 s not ~0. Kill criterion: if the strict sim still shows a materially
positive P&L while a live tape replay of the same trades does not, the sim is
still dishonest — tighten again.

### 2. Φ removed from the ensemble — `ensemble_phi_weight = 0` (operator row + new-user default)
**Finding:** Φ Brier 0.3132 vs coin 0.25 on 231 resolved signals
(anti-informative); ensemble (0.2465) dragged below the price baseline (0.2372)
by Φ; heuristic alone 0.2197.
**Change:** weight set to 0. `SignalEnsemble.combine` gains a weight-0 path
that also neutralizes the AGREE ×1.10 / DISAGREE ×0.70 confidence multiplier
(previously Φ distorted sizing even at weight 0). Φ **stays computed and
logged** (`p_phi` on every signal) so it keeps being measured.
**Success metric:** over the next ≥300 resolved TRADE signals: Brier(model_prob)
should equal Brier(p_heur) and both should beat Brier(yes_price). Reinstate Φ
(weight > 0) only if Brier(p_phi) < Brier(yes_price) on that fresh sample.
Kill criterion for MAIN itself: if Brier(p_heur) ≥ Brier(yes_price) on ≥300
fresh signals, the bot has no probability edge at all — stop iterating on
gates and rethink the signal.

## GEORGE

### 3. Mirror trades OFF — `george_mirror_enabled` (bot_settings, default FALSE)
**Finding:** all of George's profit was mirrored MAIN trades (12W/1L +$268);
his own divergence signal is 18W/20L −$27.48. With mirroring on, George is just
MAIN with extra stake and his own signal can't be judged.
**Change** (`src/bot/BotManager.js`): `forceTakeTrade` fires only when the flag
is explicitly true.
**Success metric:** next ≥100 George-own closed trades (now uncontaminated):
win rate and total P&L with a Wilson 95% CI. Kill criterion: CI upper bound
< 55% win rate at his ~even-money average entries → divergence signal has no
edge; retire George or re-derive the signal.

### 4. Oracle age logged at entry — `george_trades.oracle_age_sec`
**Finding:** retro-reconstruction of oracle staleness was inconclusive (36/39
entries >120 s — normal for a deviation feed). A hard skip is NOT yet justified.
**Change** (`GeorgeBotInstance._openPosition`): Chainlink `lastUpdate` age
recorded per trade.
**Pre-registered test:** at ≥100 new trades, compare loss rate for entries with
`oracle_age_sec > 120` vs ≤ 120 (Fisher exact, α=0.05). Only add a staleness
skip if it separates.

## BORG

### 5. A2_maker_capped — new pilot strategy alongside A_maker (control)
**Finding:** A_maker's loss is unbounded same-side inventory (9 markets, 11-21
fills each, −$757) plus quoting around a Φ-fair that disagrees with the market
by >15¢ on 66% of fills (agree-band fills ≈ breakeven). Cap-2 counterfactual:
−$360 → −$82 total; pre-incident +$282 → +$7.56 (the "good" period was luck).
**Change** (`borg/shadow/strategies.js`, `clob.js`, `collector.js`):
- ClobRecon keeps a 15-min in-memory print tape; ctx gains `prints()` accessor.
- `A2_maker_capped`: identical quoting to A_maker plus (a) online back-of-queue
  fill estimation (same math as the scorer) with a hard **40-token/side/market
  cap** (≈2 fills), and (b) quotes only while **|phiFair − gammaUp| ≤ 0.05**.
- A_maker keeps running unchanged as the concurrent control.
**Success metric (pre-registered, EVAL_PROTOCOL-compatible):** ≥300 A2 fills:
mean pnl_1x/fill with bootstrap 95% CI, judged against (a) zero and (b)
A_maker's same-window mean. Honest expectation from the counterfactual:
≈ breakeven — the cap removes catastrophe, it does not manufacture alpha. If
the CI excludes zero from below, A2 is dead too and Thesis A with it.

### 6. F_yield and D_consistency retired
F_yield: breakeven win rate at 1× costs is **97.0%** vs 92.1% achieved —
arithmetic, not variance; no parameterization fixes a payoff structure that
risks 0.97 to win 0.03. D_consistency: minEdge (1%) < round-trip taker cost
(~2%) by construction; 18 fills of noise. Classes remain in the file
unregistered, with the verdicts documented.

### 7. Scorer integrity (committed in Phase 1, deploys with Phase 4)
Tape-coverage marking (`detail.tape_blind`), prune AFTER scoring with an
unscored-order guard, correct `ts` column for `borg_binance_1s`.

## SYSTEM

### 8. Single-instance guard — pg advisory lock
**Finding:** THREE concurrent server processes each ran the bots → duplicate
trades ms apart (INTEGRITY.md §1).
**Change** (`src/index.js`): bots start only in the process that wins
`pg_try_advisory_lock(hashtext('deltaforge-bot-runner'))`; losers boot as
dashboard/API-only and log loudly. Lock auto-releases if the holder dies
(session-scoped); fail-open if the check itself errors (unique indexes remain
the backstop).

### 9. Heartbeats + red dashboard within 2 minutes
- `system_heartbeats` table; `main_bot` and `george_bot` upsert every tick
  (~10 s), `borg_scorer` on every 5-min run; the BORG collector is read from
  its existing `borg_events` heartbeat stream.
- `/api/health` reports per-component `ageSec` + `stale` (>120 s), a live DB
  **write probe**, `dbSizeMb`, and pool-level write-error counters; HTTP 503
  when degraded.
- Dashboard polls `/api/health` every 30 s and shows a sticky red banner naming
  the dead component / DB condition. Detection latency for the two silent
  failures that occurred (DB-full: 5 h, scorer: 2 h) drops to ≤ 2 min.
- Scorer auto-restart: launchd `StartInterval=300` already relaunches it (it is
  a one-shot by design); collector plist verified to carry `KeepAlive`.

---

## Verification pass (2026-07-12 ~10:00Z) — second auditor, fresh data

Every Phase 1–3 claim was re-verified ~8 h after implementation. Confirmed:
zero new duplicates, unique indexes live, prune bounding tape at 6 h, mirror
quarantine (0 mirror trades), oracle-age logging, F/D retired, A2 running
(early read +$11.74/10 fills vs A_maker −$186/83 same window). Calibration
reproduced on n=242: Φ 0.3149 / heur 0.2176 / ensemble 0.2466 / price 0.2354.
George own-signal deteriorated further: 18W/23L −$102.48 all-time.

**Three defects found during verification, fixed:**

### 10. Φ-mute was dead code — `clamp01` floor bug (`07b3c15`)
`SignalEnsemble.combine` clamped `phiWeight` through `clamp01` (a probability
clamp with a 0.01 floor), so `phiWeight === 0` never fired: Φ still leaked 1%
into `model_prob` (verified on 10 live post-audit signals — ratio exactly
0.01) and the ×1.10/×0.70 agreement multiplier still distorted sizing.
Weight now clamps [0,1]. Improvement #2's success metric
(Brier(model_prob) == Brier(p_heur)) only starts counting from this fix.

### 11. Wedged-feed escalation — collector exit(1) after ~5 min (`3000195`)
The Binance WS died 03:00Z and every in-process reconnect failed for 7 h
while a fresh process connected in 2 s (cause unknown; no fd leak). BORG
placed zero orders 02:59→09:58Z. The watchdog now exits the process after
10 consecutive stale cycles; launchd KeepAlive restarts it. Max outage ~5 min.

### 12. Health blind spots (`e33acf7`)
- `borg_scorer` false-redded on ~60% of polls (120 s threshold vs 5-min
  one-shot cadence) → per-component thresholds, scorer 660 s.
- A collector heartbeat saying `STALE: binance>10s` counted as healthy —
  the exact alive-but-blind state of incident #11 → any non-'ok' heartbeat
  message now reds `borg_collector` with `feedStatus`.

### Not reproducible, flagged
The Phase 2 tape-replay (fill-realism) window was pruned by the 6 h retention
before this verification — the +$10→−$54 inversion can't be recomputed from
raw data. Its conclusion is now tested prospectively by `strict_paper_fills`
(improvement #1's success metric), which is the better test anyway.

---

## Fine-tune pass 2026-07-13 (split-half validated, n=1,712 signals)

Method: all analysis on the post-phi-mute signal dataset split chronologically
(era A = first 856, era B = second 856); anything derived on A was judged
only on B; only changes consistent across BOTH eras with a mechanism shipped.

**Findings that held in both eras (the stable core):**
- Heuristic-vs-price Brier edge is positive for **all 6 assets in both eras**
  (12/12 cells) — the edge is structural, not asset luck.
- `ev_adj` VINDICATED: corr(ev_adj, sim outcome) = +0.154 (era A) / +0.139
  (era B) at signal level. The earlier "useless" verdict (r≈0.05 on trades)
  was strict-fill censoring — when the signal is right, price runs and the
  fill never triggers, censoring good signals out of the trade sample.
  Kelly/EV sizing stays; record corrected.
- Directional value ordering by entry price: cheap > mid > expensive in both
  eras (0.02–0.4: +$4.2/+$4.1 per $10; 0.6–0.8: +$2.7/+$0.7 — decaying).

**Shipped #13 — execution-time entry ceiling (enforcement fix, not tuning):**
`max_entry_price=0.65` was only checked at SIGNAL time against the smoothed
price; the execution path then paid the real/synthetic ask, which leaked 13
fills at 0.78–0.92 (net −$28.73, wins capped ~+$1–3, losses −$6–8). The
ceiling is now also enforced against the actual fill price at execution;
blocked entries are logged to skipped_signals (`exec_entry_ceiling`) where
the counterfactual evaluator scores what skipping cost.
**Pre-registered:** at ≥50 blocked entries, if the blocked cohort's simulated
P&L is ≥ +$1/trade, the exec ceiling is wrong — loosen it; if ≤ $0, keep.

**Shipped #14 — skip-direction instrumentation (pure measurement):**
1,364 historical skips had direction=NULL (early gates fire before a
direction exists) so the counterfactual evaluator scored none of them — the
gate-autopsy dataset was empty. Skips now fall back to the p_heur-implied
side, making every future skip evaluable. Gate tuning (gate2_ev_floor,
neutralBlock, scenarioFilter) is DEFERRED until this data exists — there is
currently no counterfactual evidence either way.

**Deliberately NOT shipped (evidence said no):**
- **Platt calibration stretch on p_heur**: fit on era A gave −0.0048 Brier
  in-sample but only −0.0010 out-of-sample on era B (80% of the gain was
  overfit), and the miscalibration is era-stable only below p=0.5 (the
  0.5–0.6 bucket flipped 0.585→0.482 across eras). Not worth a moving part;
  re-examine at n≥4,000 signals.
- **Loosening max_entry_price 0.65→0.80**: the 0.6–0.8 band is positive in
  both eras but decayed 4× in era B, on optimistic-fill sims. No stable
  basis to move an existing parameter either direction.
- **Any gate threshold change**: zero counterfactual data existed (see #14).
  Tuning gates without would-win data would be fitting on executed-trade
  noise — the exact gate1 mistake this project already made once.

## What was deliberately NOT done

- **No minimum time-remaining tightening for MAIN** — the entry-timing
  histogram showed no monotone effect; `min_entry_remaining_sec=60` stands.
- **No new Kelly shrink parameter** — would be fitted on the same sample that
  motivated it; `kelly_prob_shrink=0.5` stands until the post-Φ-removal
  calibration is measured.
- **No George staleness skip** — evidence inconclusive; logging first.
- **No BORG phase flip to 'eval'** — freezing parameters is an operator
  decision per EVAL_PROTOCOL §3; A2 runs as pilot until you freeze it.
- **Nothing that enables live order placement** — paper/shadow only,
  everywhere, unchanged.

## Elite pass — 2026-07-13 (shipped #15, #16)

Research basis (full strict-era data + BORG tape cross-checks):
- Funnel: 1,759 TRADE signals → 186 executed (10.6%). Non-executed flow is
  equal quality (sim WR 62.5% vs 64.2%, +$2.29 vs +$2.79 per $10, n=1,560 vs
  190) → the GLOBAL 90s cooldown was discarding ~89% of equal-edge signal
  flow across assets. Q3 fiction-zone check: MAIN barely trades <2bp moves
  (n=4) — existing gates already avoid it; no change needed there.
- Fill calibration vs real tape (20 matched fills ±3s): paper entry averaged
  +3.15¢ ABOVE the real recorded ask (median +3.5¢). The gamma+5-tick
  synthetic premium double-counts; Q1 (n=36k snaps) shows real spreads ≈1¢.

**#15 per_market_cooldown (default ON):** 90s duplicate-order guard now scopes
to the market instead of blocking all assets. Risk rails unchanged (30%
directional exposure cap, daily loss limit, one-open-per-market, one entry
per tick). NOTE: trade frequency will rise materially — this is intended.
- Pre-registered read at n=300 post-change closed trades: keep if avg
  pnl/trade > $0.40; KILL (revert flag) early if avg pnl/trade < $0 at n=150.
- Confound guard: evaluate per-trade expectancy, not daily P&L (frequency ↑
  mechanically scales daily variance).

**#16 fill_ref_borg_book (default ON):** when the direct CLOB book is
unavailable, fill at BORG's freshest recorded real ask (≤6s old) +1 tick,
falling back to gamma+5 ticks only if no snap exists. This is measurement
calibration, not strategy fitting — recorded P&L will mechanically improve
because fills stop paying a phantom ~3¢ premium; do NOT read that lift as
new edge.
- Pre-registered check at 50 matched fills post-change: median |paper−real
  ask| must be ≤1 tick (re-run the elite2.sql calibration join).

Direction asymmetry NOT acted on (third sign flip observed: YES now the H2
loser after NO was the loser on 07-11 — direction-conditioned tuning at
n≤100 is confirmed noise).

---

## Three-candidate portfolio pass — 2026-07-14

### #17 MAIN executable-book and executable-EV repair

**Mechanism:** a probability quote is not liquidity. Real side-specific CLOB
books now survive the signal pipeline, and Gate 2 is recomputed at the ask the
bot would pay, including the crypto taker curve. The paper depth walk plus
latency tick receives a second Gate 2 check.

**Risk:** trade count may fall sharply; that is the honest cost of removing
non-executable paper fills. A one-time `main_exec_honest_anchor` isolates the
fresh cohort. Disable only by reverting code; there is intentionally no flag
that restores dishonest execution.

**Evaluate:** n≥500 fresh closes over ≥14 days. Require positive expectancy at
1× and 2× costs, model Brier below executable-price baseline, and monotonic
EV-to-return relationship. Current executable reconstruction is n=3 and has no
inferential value.

### #18 Current fee basis — `paper_taker_fee_rate` (default 0.07)

**Mechanism:** protocol taker fee is `shares × rate × p × (1-p)`, not flat 20bp
and not a percentage of winnings. Entry taker fees always apply; a non-terminal
taker exit pays the curve again; settlement does not. Maker rebates are zeroed.

**Risk:** market-specific fee parameters may change. Check Polymarket market
metadata before any future promotion and update the configurable coefficient.

**Evaluate:** reconcile at least 100 paper fills against SDK/CLOB fee records;
absolute modeled-vs-actual fee error should be below $0.01 per $10 trade.

### #19 ETH late continuation split — `ETH_late_taker`, `ETH_late_maker`

**Mechanism:** actual ETH G fills were the only asset subset positive in pilot,
frozen shadow evaluation and live execution. Because the asset selection is
post-hoc, two new strategy names start a forward-only evaluation. Both inherit
G's signal thresholds; a stable market hash assigns exactly one arm. Taker pays
the ask; maker joins best bid with back-of-queue tape scoring and zero rebate.
The 45-second minimum is the pre-registered binary-jump guard.

**Risk:** historical guarded evidence is only n=17 and the 95% expectancy CI
crosses zero. The maker implementation has no exact historical backtest.

**Config/disable:** remove either name from the strategy factory to stop its
shadow study; no live executor is connected. Frozen policy is ETH, TTE 45–75s,
Φ certainty ≥0.88, ask 0.55–0.85, edge-at-ask ≥0.05, $10 stake.

**Evaluate:** n≥500 fresh fills per arm over ≥14 days. Taker must remain positive
at 2× fees/slippage. Maker must have positive P&L conditional on back-of-queue
fill and non-negative 5s/30s adverse selection. Report both unadjusted and
six-hypothesis-adjusted intervals; do not tune on the evaluation cohort.

### #20 Shared candidate risk — `candidate_portfolio_enabled`

With `portfolio_bankroll_usdc=500`, paper MAIN is capped at $10, max 3
positions/$30 gross, rolling loss -$30 and hard drawdown -$50. The ETH arms use
the same $10 stake in shadow. This is bankroll protection, not an edge claim.
It is deliberately not inherited by the live path; promotion needs a separate
reviewed shared-wallet rail. `paper_trading` still defaults true.

Effective with research cohort `500usd-v1`, all active BORG orders persist the
starting bankroll, 2% target risk and $10 target stake in their feature JSON.
Legacy $3 rows remain in the database but are excluded from current-cohort
dashboard totals.

---

## Forward research integrity pass — 2026-07-16

### #21 Main/George paper-fill parity adapter repaired

`borg_shadow_orders(intent_id)` uses a partial unique index. The legacy-paper
adapter now supplies the matching `WHERE intent_id IS NOT NULL` predicate in
its `ON CONFLICT` target. This restores independent quote-survival scoring for
new and checkpointed Main/George paper fills without touching either bot's
order code. A polling-path regression test freezes the SQL contract.

### #22 Collector-host WAL attestation and off-host receipt

Every raw WAL publishes append time, sync time, source, epoch/run identity,
disk reserve and mirror state in the collector heartbeat. The platform check
uses that attestation when the collector host differs from the checker host,
so an intentionally inactive Mac WAL can no longer hide or falsely imply VPS
health. The hourly iCloud `LAST_SUCCESS.txt` receipt is auto-discovered and
remains the independent durability proof. Acceptance fails closed when a
remote collector does not publish WAL health.

### #23 Main probability challenger — `main-model-challenger-v1`

Main's current heuristic remains the only execution decision. Each future
signal additionally records three paired forecasts on the same market:

- current legacy `model_prob`;
- executable market-price baseline;
- `main-residual-offset-logit-v1`, a regularized correction to market
  log-odds.

The residual artifact was trained on 3,598 resolved markets ending at the
Dublin boundary (`2026-07-15T22:26:55.888Z`). Its fixed chronological 70/30
development diagnostic was Brier 0.2083, versus 0.2169 for the legacy
heuristic and 0.2373 for market price. That is development evidence only.
Promotion evidence begins `2026-07-16T08:30:00Z`; earlier rows are stamped
ineligible. The challenger module has no direction, sizing, gate or order
dependency.

**Minimum read:** at least 300 independently resolved forward markets and 14
calendar days. Require residual Brier and log-loss to beat the paired market
baseline in both halves. If it does not, measured probability alpha is zero
and the residual model stays telemetry-only.

### #24 George legacy source retired

George's own and resurrection hypotheses use Ethereum-mainnet Chainlink push
feeds, while these markets resolve from Chainlink Data Streams. Both entry
modes are now suppressed before `_openPosition`, regardless of stale settings.
The evaluator continues as telemetry. BORG H48/H49 are named as the correctly
sourced RTDS successors; H48's current specification is itself marked
`REDESIGN_REQUIRED`, so this retirement does not manufacture a replacement
winner.

### #25 Immutable BORG governance dispositions

Failed strategies are recorded by a separate frozen governance manifest.
Their observations and multiple-testing burden remain intact, and they may
continue as negative controls, but the promotion report returns statuses such
as `NEGATIVE_CONTROL`, `FEATURE_ONLY`, `REDESIGN_REQUIRED` or
`COST_FRAGILE_CONTROL` instead of allowing a later lucky interval to promote
the old specification. Any redesigned mechanism requires a new strategy ID
and fresh evidence start.

No live-order call site, paper default, Gate 1 semantics, H49 parameters, or
historical observation was changed in this pass.

### #26 Main V2 resolver-quorum reconstruction

Legacy Main's executable-book forward cohort is negative and its quote-relative
heuristic manufactures claimed EV mechanically. Its paper executor is therefore
retired by default with `main_legacy_execution_enabled=false`; it remains a
telemetry control. This flag is paper-only and cannot suppress or alter a live
order path.

The replacement hypothesis, `MAIN_V2_resolver_quorum`, is keyless BORG shadow
research. It trades only when fresh Chainlink RTDS and Coinbase form a resolver
quorum and direct Binance is the lagging outlier, then requires a real CLOB ask,
2×-fee edge, 250 ms quote survival, no more than 20% displayed touch, and a $10
cap from the frozen $500 bankroll. It holds to resolution and emits at most one
intent per market.

**Mechanism:** resolver/source disagreement can briefly move faster than the
binary book; unlike legacy Main, the probability displacement is sourced from
an independently observed cross-venue residual rather than added to the market
quote by construction.

**Risk:** the H49 precursor's apparent gain was unstable and its confidence
interval crossed zero. Resolver timestamp error, shared upstream pricing,
adverse selection and fee curvature can eliminate all apparent edge. Main V2
must be assumed unprofitable until its own forward cohort passes.

**Config/disable:** remove `MAIN_V2_resolver_quorum` from the shadow factory to
stop collection. Setting `main_legacy_execution_enabled=true` restores legacy
paper execution for a deliberate control experiment; it does not affect live
mode. Neither setting enables live trading.

**Evaluate:** run `node scripts/main-v2-report.js`. Wait for at least 500 fresh
independent markets and 14 days. Require ≥90% non-F quality, positive 2×-cost
PnL in both halves, an adjusted market-clustered lower CI above zero, and
non-negative adverse-selection marks. The expected result may be measured edge
approximately zero. Any parameter change creates a new strategy ID and resets
the evidence clock.

---

## #27 Institutional evidence platform v2 — 2026-07-21

**Mechanism:** a strategy cannot be evaluated from a tape that silently stops
when disk, WAL, WebSocket or database pressure rises. The VPS now uses a local
append-before-process WAL, verified gzip-NDJSON database drainage, an off-host
immutable mirror, an incremental Parquet research projection and a bounded
local PostgreSQL hot tier. The Mac mirror ignores mutable archive state and
issues a remote deletion receipt only after a clean immutable traversal.

**Risk:** iCloud is a convenient off-host copy, not an institutional object
store with immutable retention guarantees. Raw gzip/WAL objects remain the
authority; Parquet can always be regenerated. A stale receipt fails closed and
temporarily increases VPS use rather than deleting unmirrored data.

**Config/disable:** `BORG_ARCHIVE_DIR`, `BORG_WAL_DIR`, the `*_SQL_HOT_HOURS`
variables, `DELTAFORGE_VPS_RAW_RETENTION_HOURS` and
`DELTAFORGE_PARQUET_MAX_FILES_PER_PULL`. The new evidence epoch refuses to
start below 30 GiB free.

**Evaluate:** the first epoch must accumulate 24 continuous hours with health
samples no more than 120 seconds apart, zero failed samples, zero collector/WAL
errors, zero reported sequence gaps, fresh required heartbeats and non-empty
all-market/flow/cross-venue coverage. Run
`node scripts/evidence-epoch-status.js`; no strategy may promote while it says
`PENDING_24H` or `FAILED`.

## #28 Frozen research fleet and four-program allocation

**Mechanism:** producing variants until one line is positive is selection, not
alpha. Governance v4 parks the failed fleet and prevents old definitions from
promotion. All-market and Flow continue as high-fidelity data lanes with signal
generation disabled; paired maker and old canaries are stopped. Engineering is
concentrated on resolver-boundary residuals, certified payoff identities,
rule-aware cross-venue convergence and exact/bounded Deribit surfaces.

**Risk:** fewer strategies means fewer exciting dashboard rows. That is the
intended consequence of preserving statistical power. H43's small discovery
gain can still disappear; the Chainlink and CF arms may remain blocked; a
cross-venue spread can be negative after rule mismatch, leg risk and capital
duration; and options residuals can be swallowed by binary gamma and resolver
basis.

**Config/disable:** `ALLMARKET_STRATEGY_SIGNALS_ENABLED=false`,
`FLOW_STRATEGY_SIGNALS_ENABLED=false`, and
`BORG_INCLUDE_PARKED_CONTROLS=false`. Each research product has its own frozen
manifest and paper-only contract. H43's rule and parameters were not changed.

**Evaluate:** do not pool the products. Resolver arms require at least 300 fresh
independent markets and 14 days; cross-venue and options require at least 300
and 30 days. Report certified terminal locks separately from similar-contract
convergence. A missing exact resolver source is a blocked experiment, not an
excuse to substitute a convenient proxy.

## #29 Desk-wide promotion policy and shared $500 capacity

**Mechanism:** `scripts/promotion-report.js` now evaluates every collecting
confirmatory arm with doubled fees/slippage, both chronological halves,
market/day clustered uncertainty, Holm family-wise correction, A/B data and
execution grades, 100/250/500 ms latency profiles, leave-largest-contributor
tests, and a single chronological $500 bankroll shared across strategies.
Legacy manifests cannot weaken these desk-wide gates.

**Risk:** the standard is intentionally difficult to pass and can conclude that
measured edge is approximately zero. A positive paper result still does not
prove exchange authentication, rejection or fill parity.

**Config/disable:** this is a research-governance invariant rather than a
trading threshold. Changing it requires a documented policy version, not a
runtime toggle.

**Evaluate:** every gate must pass before human review. Then run exactly 50
authenticated live fills at $1–$2, exclude those fills from paper evidence, and
reconcile submitted limit, actual fill, partial/non-fill rate, rejection,
fees and realised PnL. Scale to $5–$10 only if that canary remains consistent.
For multi-leg trades, reserve second-leg and emergency-unwind capital inside
the same $500 envelope. Failure is the default conclusion; no automatic live
promotion exists.

## #30 Transactional evidence-epoch activation

**Mechanism:** cohort boundaries are now operational transactions. The launcher
drains old collectors and cohort timers before timestamping, starts every
approved collector under the new immutable epoch, runs the scorer and verified
archiver immediately, and waits for a completely green unrecorded preflight.
Only then is the first health sample written. Heartbeats from an earlier epoch,
shutdown errors, real coverage gaps and protocol-only controls cannot leak into
the successor cohort.

**Risk:** fail-closed startup can leave collectors running under an invalid
epoch if a required feed never becomes healthy; it deliberately does not
pretend that interval is clean. Starting a replacement epoch discards that
interval from promotion evidence but does not delete its raw data.

**Config/disable:** `BORG_EPOCH_WARMUP_TIMEOUT_SEC` defaults to 240 seconds,
`BORG_EPOCH_MIN_FREE_GIB` defaults to 30, and
`BORG_INCLUDE_PARKED_CONTROLS=false`. `PROTOCOL_COMPLETION_ONLY` is a parked
disposition. These controls affect paper research and evidence accounting, not
any live-order call site.

**Evaluate:** `money-finding-2026-07-21-v8` must retain PASS samples no more
than 120 seconds apart for 24 continuous hours, with no failed sample, error,
coverage/sequence gap, stale source, WAL/archive failure or disk-reserve
breach. A successful 24-hour burn-in only validates the measuring instrument;
each strategy must still satisfy its 300-market, 14/30-day, doubled-cost,
clustered-confidence and shared-capacity gates.

v5 failed honestly after structural Gamma timeouts; v6 was rejected when
archive startup raced the CLOB writer; v7 failed on a single-attempt Flow REST
timeout. None is relabelled or used for promotion. Gamma and Flow discovery now
use bounded retries, and the epoch launcher seeds verified archival before
starting hot writers.

## #31 Neglected-capacity opportunity standard and frozen capture panel

**Mechanism:** every structural, cross-venue and options candidate is now
comparable under one cash identity: lower-bound payout minus executable
principal, doubled fees, slippage stress and a full failure-risk reserve. The
report also charges capital duration and refuses to call a non-atomic bundle a
certified pre-trade lock. A staged all-market panel covers multi-contract event
graphs, small-inventory reward books, obscure contracts and liquid controls;
membership is PnL-independent, content-hashed and frozen by collection epoch.

**Risk:** a full failure reserve can be too conservative for a well-controlled
multi-leg state machine, while a smaller expected reserve would require a
forward estimate of fill/failure probability that does not yet exist. The
panel can also discover no opportunities. Generic and paired maker history is
decisively negative and remains a control; only a fair-bound passive overlay is
staged for a future epoch.

**Config/disable:** `ALLMARKET_PANEL_MODE=legacy` remains the active default.
`ALLMARKET_PANEL_MODE=neglected` requires a marked collection epoch and loads
the immutable `neglected-capacity-panel-v1` membership from
`am_panel_memberships`. Strategy signals remain independently disabled with
`ALLMARKET_STRATEGY_SIGNALS_ENABLED=false`.

**Evaluate:** run `npm run research:neglected-edge`. At the implementation
snapshot it reported zero paper-test-eligible candidate economics and zero
certified locks. H43 remained the only positive lead, but its execution-grade
coverage was incomplete. Do not activate the staged panel or
`fair-bound-passive-overlay-v1` inside the running v8 epoch; begin a new epoch
after the 24-hour platform burn-in and scale capture from 20 to at most 60
markets only when sequence, WAL, CPU and persistence checks remain clean.

## #32 Focused five-lane paper programme

**Mechanism:** the research fleet is now concentrated on unchanged H43
resolver-boundary transfer, deterministic certified payoff graphs, rule-aware
Polymarket/Kalshi relations, Deribit options-implied binary residuals and a
capture-only fair-bound passive overlay. The all-market socket subscribes to a
content-hashed 20-market neglected-capacity panel selected without PnL or
toxicity. Generic maker and paired-complete-set controls remain retired.

**Risk:** broader capture consumes disk/CPU and may still discover no certified
bound. A cross-venue relation is non-atomic, an options bound retains binary
gamma/resolver risk, and H43 remains underpowered. Dashboard visibility must
not be confused with a live-trading promotion.

**Config/disable:** the VPS unit sets `ALLMARKET_PANEL_MODE=neglected`,
`ALLMARKET_MAX_MARKETS=20` and
`ALLMARKET_STRATEGY_SIGNALS_ENABLED=false`. Restoring `legacy` changes the
capture population and requires a new evidence epoch. Enabling strategy
signals is explicitly outside this programme. Options persistence uses one
in-flight deterministic flush with four bounded transient-DB attempts.

**Evaluate:** `money-finding-2026-07-21-v10` began at
`2026-07-21T22:25:22.489Z`. Require 24 clean infrastructure hours before using
any row as promotion evidence. Then apply the frozen per-lane 300-market and
14/30-day rules. Fair-bound making remains staged until an independently
certified A/B lower bound maps to a live token and clears doubled fees, one
adverse tick, queue delay and full failure reserve.
