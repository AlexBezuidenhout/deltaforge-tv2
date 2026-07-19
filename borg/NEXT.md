# BORG — Next Actions

_Living checklist. Updated 2026-07-11 ~14:05 UTC. Check items off as they
complete; dates are earliest-possible, not deadlines._

## 1. Recon adjudication — **from 2026-07-13 (13:36 UTC)**

The clean-collection clock started 2026-07-11 13:36 UTC (post-incident
restart). After 24–48h of clean data:

- [ ] Run the pre-registered queries in `recon/analysis/` (Q1–Q6).
- [ ] Fill in RECON.md **Findings** (methodology is frozen — no shopping).
      Q3 caution: prefer `binance_open_src='live'` markets; treat
      `kline_repair`/`kline_backfill` rows as a labeled second-class sample.
- [ ] Adjudicate each thesis in RECON.md: **BUILD / DEAD / STARVED**.
- [ ] Remove shadow strategy modules for DEAD theses; watch: if
      `D_consistency` has fired 0 shadow orders by adjudication, that is
      itself Q1 evidence toward DEAD.

## 2. Parameter freeze → evaluation window — after adjudication

- [ ] Calibrate the σ estimator on recon data (Q2 estimator comparison);
      freeze it.
- [ ] Fix strategy parameters in `shadow/strategies.js` for BUILD theses.
- [ ] Flip `PHASE` to `'eval'` in `shadow/engine.js`; **tag the commit**.
- [ ] Pilot rows (phase='pilot') are discarded from all results — they stay
      in the table, labeled.
- [ ] Evaluation runs ≥500 scored shadow trades **or** 14 days, whichever is
      LONGER (earliest end ~**2026-07-27/28**). Pass bar: EVAL_PROTOCOL §6
      (bootstrap CI excludes zero at Bonferroni α, survives 2× costs,
      both-halves sign check). Any param change resets that strategy's clock.
- [ ] **A_maker retired 2026-07-12 14:20Z** (verdict final: lifetime ≈ −$1,353,
      four independent losing eras after one lucky afternoon). A2 is BORG's
      only quoter; its n=300 judgment is **vs zero**, with A_maker's
      historical per-fill distribution as reference context. Current A2 tally
      at retirement: 87 fills, −$112 — if its CI at 300 excludes zero from
      below, Thesis A is dead entirely and BORG reverts to measurement-only.
- [ ] Per-asset note at the n=300 read: eth was positive for BOTH makers in
      the first multi-asset hours (+$58.6 A_maker / +$8.2 A2) — tiny n,
      do NOT act on it; just split the checkpoint stats per asset.
- [ ] Then: RESULTS.md + VERDICT.md. Only a PASS opens a capital discussion.

## 2a. G_late_arb LIVE (2026-07-13 ~19:51Z working; verdict CONFIRM n=308–309)

State as of 2026-07-13 ~21:30Z (session: go-live audit + hardening):

- **Verdict CONFIRMED for real** at n=308 (mean $0.82/fill, CI [$0.38, $1.23],
  worst market −$10.20); genuine stamp written by `g-verdict.js --stamp`
  (replaced the operator-override stamp). **Param freeze commit tagged
  `gla-param-freeze`** — G_late_arb shadow rows stamp `phase='eval'` from that
  commit; params in strategies.js must not change without a new pre-registered
  read. (Phase is per-strategy: Vasili stays 'pilot'.)
- **Working account**: signer 0x5966ffbA (EOA key), funder = fresh Polymarket
  deposit wallet 0x4c4a3e8b, sigType POLY_1271, collateral pUSD.
  **Auto-redemption works** on this wallet (Polymarket sweeps winnings back as
  pUSD within minutes) — the old EOA-route "manual CTF redeem" TODO is MOOT.
- **Rails (operator-raised 2026-07-13, bankroll ~$150)**: 300 orders/$3000/day
  as sanity ceilings (observed flow ~9/hr ≈ 220/day → non-binding); the real
  protection is the **realized-loss circuit breaker**: resolved live pnl today
  ≤ −$75 → halt until next UTC day (logged "DAILY LOSS HALT"). Stake stays
  $10/leg (pre-registered: 2x marginal negative). History: original
  pre-registered 30/$300 caps bound within ~3.5h; an undeployed 1000/$10k
  Desktop edit was found divergent from runtime and normalized first.
- [x] **Live-vs-shadow divergence read** — DONE early at n=135 (2026-07-14
      06:45Z overnight read, per-TITLE on-chain ground truth): live −$0.216/
      title vs shadow +$0.13/fill on the same window. Gap fully explained by
      **winner-censoring adverse selection**: 27/164 orders unfilled, all 27
      would have won (≈−$0.35/fill). Entry buckets: <0.85 +$21, ≥0.85 −$25.
      Also: shadow EVAL cohort itself (n=115) = $0.133 CI [−0.69,0.92] vs
      CONFIRM cohort $0.823 CI [0.39,1.24] — the edge is currently absent/
      weak; eval clock decides at n=300.
- [ ] **2026-07-14 profitability pass — pre-registered read at n=150
      post-change live fills**: shipped ENTRY_CEILING=0.85 (skip signals with
      recorded ask >0.85, logged SKIPPED_CEILING; shadow scores them so the
      counterfactual is free) + CHASE_TICKS=0.03 (limit = min(ask+3¢, 0.85);
      recovers runaway winners the +1-tick limit missed) + loss breaker
      restored (−$75/day realized). JUDGE: (a) per-fill live pnl vs the same
      window's shadow pnl — gap should shrink from −$0.35 toward −$0.10;
      (b) unfilled-would-win rate should drop from 16% (27/164) toward ≤5%;
      (c) SKIPPED_CEILING counterfactual (shadow pnl of skipped ids) should
      be ≤$0/fill, else loosen ceiling to 0.90. KILL live (not the strategy)
      if live pnl <−$0.15/fill at n≥150 post-change.
- **2026-07-14 ~08:10Z EDGE GATE live (2a5250a)** — post-change read came in
  fast: live −$19.54 vs shadow −$20.21 on the SAME 13 signals (mirror gap
  closed to ~$0.05/fill: execution fixed, signals losing). Ceiling
  counterfactual already −$11.94 on 13 skips (validated). EVAL ≤0.85 bucket
  went NEGATIVE (n=75, −$0.05/fill). Executor now pauses mirroring while
  trailing-100 scored core ≤0.85 fills mean <$0.10/fill and reopens at
  ≥$0.30 (hysteresis; closed below n=30; rows log SKIPPED_EDGE_GATE; check
  every 5min). Gate CLOSED at deploy (trailing $0.21). Also SKIPPED_HEDGE:
  one seat per market, first fill holds (6 both-sides pairs in 24h).
  Shadow scoring and the n=300 eval verdict are unaffected by the gate.
- **2026-07-14 ~12:30Z TRAILING GATE REFUTED → RE-CONFIRM GATE** (full live
  audit, 163 resolved titles, on-chain ground truth −$58.79 lifetime).
  Evidence against the trailing gate: corr(trailing-100 mean, next-fill
  pnl) = **−0.125** (trailing-50 −0.02, trailing-20 +0.03); gate simulation
  underperforms trade-all at every window; live log whipsaw confirmed
  (opened 09:57Z @$0.333 → ate the 10–11Z losing hours → closed 11:52Z
  @$0.048). Eval-era core ≤0.85 is n=89 +$0.26/fill **CI95 [−0.83,+1.32]**
  — statistically zero. REPLACEMENT (pre-registered): gate starts CLOSED;
  reopens ONLY when the most recent 50 scored core ≤0.85 fills, all after
  `bot_settings.gla_reconfirm_anchor` (set at every gate close, persisted),
  show **mean ≥$0.40/fill AND bootstrap CI low >0** — i.e. a regime of the
  strength that earned the original CONFIRM. Closes at trailing-50 mean
  <$0.10 and re-anchors. Expected reopen latency after a genuine regime
  start: 6–10h (5–9 core fills/hr). Also fixed **population mismatch**: the
  mirror now skips hype signals (SKIPPED_NON_CORE) — verdict/eval/gate are
  all core ex-hype, but 38 live hype titles (−$6.02) had been traded on a
  never-confirmed population. Feature autopsy for the record: no monotone
  pnl relationship for model edge, sigma, depth, spread, or gamma-phi
  divergence at current n; eval lead<2bp bucket worst (−$1.32/fill n=17,
  matches recon Q3 fiction zone) — candidate pre-registered min-lead filter
  if/when live re-opens; asset cuts (bnb/xrp negative, eth positive) are
  noise-lesson territory, do NOT act. Unfilled-would-win still 100%
  (29/29 lifetime; 2/2 post-chase at 9.1% unfilled vs ≤5% target). The
  n=150 post-change KILL read above stays armed and unchanged.
- Executor hardened: transient net/DNS errors absorbed (TRANSIENT_NET set +
  dbRetry on startup reads) — the 19:5x ENOTFOUND crash class is closed.
- Stale-mirror fix: shadow engine flushes G place rows immediately (was 5s
  batch → 7/21 mirrors died SKIPPED_STALE on batch delay alone).
- Live card shows **equity** (CLOB cash + data-api position value), not idle
  cash; components in `liveWallet.{cash,positions}`. Baseline pnl vs
  `live_gla_baseline_usdc` ($190.79). Re-baseline after deposits: set NULL.
- Geo warning in log ("orders may 403") is cosmetic — orders succeed from
  this network. If migrating to a VPS/datacenter IP, TEST FIRST: Polymarket
  blocks restricted jurisdictions (incl. US) and many datacenter ranges.

## 2b. A_maker/A2 fully superseded by G_late_arb — audit's A2-ex-btc ask deliberately not implemented

The 2026-07-13 three-bot audit (n=605 A2 fills, still-running framing)
recommended `a2_exclude_btc=true` as a new pre-registered experiment. **Not
implemented** — by the time that report's data was pulled, a separate prior
session had already retired the entire maker family (A_maker AND A2, commit
`47cc0fc`, 2026-07-12 21:41Z) in favor of `G_late_arb`, a structurally
different taker-side strategy. Reviving A2 would fight that decision, and
it's redundant: the audit's own cross-bot finding — "btc is maker-toxic and
(maybe) taker-viable" — is exactly why G, not a patched A2, is the right
btc vehicle. G's btc bucket is in fact one of its better performers so far
(+$25.35/18 fills, tiny n). If A2-ex-btc specifically is wanted anyway, it
needs an explicit operator ask — it won't get silently re-added.

**G_late_arb verdict machinery (2026-07-13): `node scripts/g-verdict.js`** —
the pre-registered read is now a mechanical script (thresholds frozen in
code; refuses to rule below core n=300, hype excluded per §2b). Interim view
at core n=208: mean $0.73/fill, bootstrap 95% CI [$0.16, $1.24] (excludes
zero), worst market −$10.20, marginal-size check still negative (1× stands),
near-flat cohort (Q3 flag) n=22 positive, hype ~flat (n=64). Tracking toward
CONFIRM; the read fires itself on facts when core crosses 300 — just run the
script. If CONFIRM: next step is parameter freeze (tagged commit,
PHASE→'eval') per EVAL_PROTOCOL before any further claims.

**G_late_arb status (audit 2026-07-13, n=183 at report time):** 89.6% win
rate, +$0.835/fill, but the marginal unit already loses (pnl_2x − pnl_1x =
−$30.94 — size is capacity-capped at 1×, never increase it) and the payoff
is penny-picking (164 small wins vs 19 losses averaging ~−$5 — one bad
regime can erase a week). Pre-registered: confirm at ≥300 fills (1× only)
if per-fill > $0.40 AND worst single-market P&L > −$30; kill if per-fill <
$0.10. hype is G's only negative asset (−$16.82/48, noise) — judge hype
separately at its own n=300, don't fold it into the aggregate verdict.

## 2c. Vasili (Thesis V) — live 2026-07-13, operator-requested

Mid-window momentum-follow, honest test of an external simulator's
+13,264%/30d claim (fixed-$0.50-fill fiction). Registered in THESES.md §V;
verdict frozen in `scripts/vasili-verdict.js` (core n≥300: CONFIRM
mean>$0.40 AND worst>−$30; KILL mean<$0.10). **Registered prediction:
direction accuracy high, profit ~zero — the ask already prices the lead.**
Runs alongside G (non-overlapping seats: 90–150s vs 5–75s). Appears
automatically in the BORG tab's per-strategy scoreboard.

## 3. Open decision for the operator — George live trading

`implementation_plan.md` (repo root, untracked) proposes making George trade
live and is **blocked on the wallet question**: main bot and George sharing
one Polymarket wallet will offset opposite positions (main bot's sells can
then fail). Option A (dedicated second wallet for George) is the safe answer.
Decide before any implementation.

## 3b. George resurrection experiment — pending operator decision

Own-signal kill executed 2026-07-13 (`george_own_signal_enabled=false`,
default). A separately pre-registered resurrection hypothesis exists behind
`george_resurrection_enabled` (default false): trade only when
`oracle_age_sec < 600 AND divergence_bps >= 30 AND entry ∈ [0.35, 0.65]`.
Parameters are motivated by the killed sample, so per the audit they may
**only be judged on fresh data** — kill at n=100 if Wilson upper < 55%
again. Flip the flag only on explicit operator instruction; it does nothing
on its own.

## 4. Optional hardening / ops notes

- [x] The :3004 dashboard server now runs under launchd
      (`com.deltaforge.server`, KeepAlive+RunAtLoad, from
      `~/.deltaforge-runtime` — same TCC-mirror pattern as BORG). Survives
      crashes, network outages, logout, and reboot. **Edits under `src/` or
      `public/` do nothing until `bash scripts/deploy-server.sh`.**
- Ops reminders: edits under `borg/` do nothing until `bash
  borg/recon/deploy.sh`; collector = launchd `com.borg.recon`
  (log `~/Library/Logs/borg-recon.log`); auto-scorer = `com.borg.score`
  every 5 min (log `borg-score.log`); dashboard = 🛰️ BORG tab on :3004.

## 5. Standing watch items (no action, just awareness)

- Q3 disagreements: 8/124 (~6%) — if it stays well above ~2% on
  live-captured boundaries, Thesis B's micro-form gets interesting at
  adjudication.
- Shadow §7 halt rule is firing correctly on brief CLOB reconnects
  (pause + resume logged, windows excluded).
- Pilot scoreboard PnL (e.g. A_maker's early fills) is **not evidence** —
  resist reading it. The old bot died of exactly this.
