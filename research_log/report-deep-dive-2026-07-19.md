# Deep dive — fleet state + Polymarket/Kalshi cross-venue verdict
**Date:** 2026-07-19 ~16:00Z · read-only SELECT on deltaforge-vps + local repo review

## Cross-venue (Polymarket × Kalshi) — the operator's hunch, tested against every row we have

**Scoreboard numbers are artifacts.** The dashboard's "$9,882 / 8,415% ROI" parity rows are
diagnostic controls, not opportunities. All 12,323 `economic=true` cv_opportunities rows sit on
MANUALLY_REJECTED or unapproved matches (NCSEN false-match alone averages a fictional +$103
stressed; a Poly NWSL-soccer market was text-matched to a Kalshi MLB game at score 0.6; one Poly
leg matched to TWO different MLB game dates). Zero economic rows are synchronized.

**Real pairs show no lock.** On monitored, non-rejected, synchronized fresh books (48h,
qty-5 probes): best-ever complementary entry $0.979/share (fleeting ~2c gross, consumed by
stress), p01 $1.002, median $1.09–1.20. Consistent with the 5m finding (complement ask-sum
median exactly 1.01). Terminal locks across the two venues effectively do not exist at
displayed depth.

**But the actual thesis has NEVER been tested:**
1. **0/747 matches are crypto.** The matcher never ingested Kalshi crypto series
   (KXBTC/KXBTCD/KXETH…). This is the one universe where identity is *provable
   programmatically* (same strike, same timestamp, explicit index) instead of fuzzy text.
   Note the payoff-type nuance: Poly `direction_*` (vs window open) ≠ Kalshi strike
   above/below — the matchable set is Poly `threshold_daily`/`range_daily` ↔ Kalshi
   daily/hourly strike ladders with exactly aligned strikes and times. Resolver indexes
   differ (Chainlink vs CF Benchmarks) — that residual IS the "resolver-source boundary"
   territory (edge-map rank #3), quantifiable near the strike.
2. **approvedMatches = 0 since birth.** The certified forward-episode pipeline
   (cv_relation_episodes = 0) has been starved by the manual identity-review step nobody has
   done. 7 STRONG_CANDIDATEs + 713 candidates sit in PENDING_REVIEW.
3. **Kalshi WS unconfigured** → REST 2s polling → 27,208 of 28,398 pair evaluations REJECTED
   for synchronization (96%). The evidence engine mostly discards its own input.
4. **No settlement capture** → the pre-registered predictive test (Kalshi fair vs Poly ask vs
   realized; UFC Jul-18 card now resolved) cannot be scored.

**Persistent basis is real** (from 07-18 report, unchanged): 17/25 matches with |median
basis| >1c, 9/12 sign-stable across halves, magnitudes 1.5–16c on liquid props, dwell p90
~16 min. That is a *convergence/fair-value-transfer* phenomenon on segmented capital (R3),
not an atomic arb. Whether it predicts resolution — the money question — is unscored.

## Fleet (7-day scored shadow, 1x)

Positives: H3_flow_confirmed +$96/148 ($0.65/fill) **but zero-latency arm only** — the
250ms latency arm is −$252/495 (−$0.51/fill): signal half-life is sub-second, not
live-viable. Same pattern in H12_cross_venue_consensus (Binance+Coinbase 10s consensus, not
Kalshi): base $1.75/fill (n=37) vs latency_1s $0.15 (n=61). The latency-arm instrumentation
is doing exactly its job: killing paper-only mirages before they reach live.

H52_15m_neareven_favorite_v2 (the current genuine candidate): 107 markets, 95 scored fills,
+$21.65 @1x / +$9.44 @2x, per-market mean +$0.235 (sd 4.6, 50/92 markets positive).
**Passed its pre-registered 100-market kill gate (2x positive) — eval continues to 300**
(~4–5 days at current flow). Fill-level CI still includes 0; no action before the gate.
Price-bucket read: 0.50–0.55 +$0.35, 0.55–0.60 +$0.27, >0.60 flat/negative — consistent
with the frozen mechanism, no tuning.

H43 resolution-boundary: +$14/16 fills lifetime, 23 markets — still starved but positive;
keep accruing. H28 +$9/6 fills (noise n).

H53_5m_neareven_favorite_live_v1 (operator-directed 5m canary of the accidental defective
rule): −$137/715 fills @1x, −$249 @2x in 7d — confirms the discovery-time finding that the
identical 5m cell is negative (n=1698, −$0.034/sh). **Recommend: kill the canary; the
question it was asking is answered.**

Everything else: ~45 directional/network variants between −$8 and −$1,607 each, fleet-wide
several −$1000s/wk — the "5m CLOB is efficient at every executable margin" verdict holds.
Pyth arms: 0 signals/markouts (feed restored 07-19 PM, watch for first rows). Options
surface: 768,858 marks collecting, still 0 executable A/B forward trades. Structural: 10,833
evals/24h, 0 economic, 0 qualified.

Daily-threshold events: **66 resolved clusters** (was 25 on 07-18) — the 100-event gate for
the ITM-pennies (+0.32c/sh, 68/68) and tail-overpricing retests arrives ~**Jul 21–22**, not
August.

## Ranked next steps (build order)

1. **Kalshi crypto ingestion + mechanical identity certifier** — add KXBTC*/KXETH* (and
   sol/xrp if listed) series to cv universe; certify identity by parsed (index, strike,
   deadline) equality, not text similarity; auto-approve only provable pairs. Unlocks the
   only self-certifying universe. ~1 wk capture to first basis read.
2. **Kalshi settlement capture (public REST)** + score the resolved sports matches now in
   hand: Kalshi fair vs Poly ask vs realized, Brier per match. Decides whether the
   persistent basis is predictive (which venue is the anchor) — the cheapest decisive test
   in the whole program, data already collected.
3. **Kalshi WS API key** (operator signup, read-only) → fixes the 96% synchronization
   rejection rate; without it forward evidence accrues ~25x too slowly.
4. **Operator review of the 7 STRONG_CANDIDATE identities** (30 min) so cv_relation_episodes
   can leave zero on sports pairs meanwhile.
5. **Fleet hygiene:** kill H53 canary (answered); retire the persistent-negative variants to
   controls; let H52 v2 run to its 300 gate untouched; ITM-pennies + tail retest fire
   automatically at 100 events (~Jul 21–22).
6. **Live-path reality check (before any Kalshi live leg):** Dublin host is hard-blocked
   (DUBLIN_HOST_DO_NOT_TRADE_KALSHI); operator eligibility/account for Kalshi from Guernsey
   is an open legal/ops question; convergence trades split capital across venues with no
   cross-margin. Research is paper-only and unaffected.

**Bottom line on the hunch:** nothing in the data supports an executable lock today, and the
scoreboard's big numbers are false-match artifacts — but the specific test that could vindicate
the hunch (crypto strike-ladder pairs with provable identity + settlement scoring + real
synchronization) has never been run, and it is one focused build away. The basis persistence
and sign-stability on liquid pairs is exactly what a real segmented-capital effect looks like.
Build items 1–3; judge on the pre-registered reads, not the dashboard.
