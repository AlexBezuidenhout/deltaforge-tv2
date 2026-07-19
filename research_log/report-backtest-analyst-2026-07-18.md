# Backtest Analyst — Shared Covariates of Losses in Shadow Fills
**Date:** 2026-07-18 · **Analyst:** Backtest Analyst subagent (read-only SELECT on deltaforge-vps)

## Scope and reconciliation
- `borg_shadow_orders` 56,220 rows; `borg_shadow_scores` 55,547; `borg_markets` 13,349; `pm_flow_signals` 75,564; `pm_flow_scores` 75,561.
- Base population: **34,965 filled + scored fills** across **8,492 independent markets**, 2026-07-11 13:42Z → 2026-07-18 17:47Z.
- Chronological halves split at the fill-median timestamp **2026-07-16 16:31:33Z** (H1 = before, H2 = after). The whole dataset is ~7 days; "day-of-week" is indistinguishable from individual calendar days.
- Feature coverage: `features->sigma/book_age_ms/...` present on 34,639/34,965 fills (99%). `detail->state_age_ms` 29,008; `order_latency_ms` 29,008.
- Where noted, per-fill pnl is **strategy-demeaned** ("excess") to remove strategy-mix confounding — the single biggest trap in this pool (see Finding 7).

Context: almost every strategy in the pool is net-negative. Skip rules are ranked by whether the flagged cluster is *reliably worse than the same strategies' other fills* (both halves, adequate independent-market n) — real conditional structure, not just "everything loses".

---

## Finding 1 — Fade/reversion family on BTC (ACTIONABLE)
**Skip rule: for the jump-fade/reversion family (H19_clob_only_jump_fade, H32_opening_gap_repair, H33_signed_semivariance, H34_flow_absorption_reversal, H36_sweep_replenishment_reversal, H37_spread_shock_reversion), skip all `asset='btc'` markets.**

| cell | fills | independent mkts | $/mkt @1x | $/mkt @2x |
|---|---|---|---|---|
| BTC, H1 | 712 | **265** | **-4.562** | **-5.364** |
| BTC, H2 | 613 | **255** | **-2.488** | **-3.229** |
| non-BTC, H1 | 3,728 | 1,455 | -0.819 | -1.131 |
| non-BTC, H2 | 4,706 | 1,995 | -0.787 | -1.053 |

- BTC is ~3–5.5x worse per market than the same strategies on other assets, **in both halves**, on 520 independent BTC markets.
- Per-strategy split (H19, H32, H33, H36 × two halves): BTC underperforms non-BTC in **8 of 8 cells** (e.g. H33 H1: -3.07 vs -0.05/fill; H19 H2: -1.72 vs -0.31).
- NOT a general BTC effect: arb/transport strategies (H47, G_late_arb, H14, Vasili, H35-H2) are flat-to-*better* on BTC. Mechanism: BTC 5m jumps continue more often than they revert; alt jumps revert more.
- In-sample effect of the skip: ≈ **+$2,780 @1x / +$3,525 @2x** over the week.
- Interaction with Finding 4: fade-family high-sigma fills are *not* worse — the family's problem is asset-conditional, not vol-conditional.

```sql
WITH base AS (
  SELECT o.strategy, o.market_id, m.asset, s.pnl_1x, s.pnl_2x,
         o.ts < '2026-07-16 16:31:33Z'::timestamptz h1
  FROM borg_shadow_orders o
  JOIN borg_shadow_scores s ON s.order_id=o.id
  JOIN borg_markets m ON m.id=o.market_id
  WHERE s.filled AND o.strategy IN ('H19_clob_only_jump_fade','H32_opening_gap_repair',
    'H33_signed_semivariance','H36_sweep_replenishment_reversal',
    'H34_flow_absorption_reversal','H37_spread_shock_reversion'))
SELECT (asset='btc') is_btc, h1, count(*) n, count(DISTINCT market_id) mkts,
       sum(pnl_1x)/count(DISTINCT market_id) perm1x,
       sum(pnl_2x)/count(DISTINCT market_id) perm2x
FROM base GROUP BY 1,2 ORDER BY 1,2;
```
**Verdict: ACTIONABLE** (both halves, 520 independent markets, 8/8 per-strategy cells, coherent mechanism).

---

## Finding 2 — Early entries into "1h" markets / poisoned-open quarantine (ACTIONABLE as quarantine)
**Rule: quarantine all `tte_sec > 300` entries (all labeled direction_1h, plus 9 threshold_daily markets) and all offset-window results until rescored against repaired references.**

| cell | fills | independent mkts | $/mkt @1x | $/mkt @2x | avg/fill @1x |
|---|---|---|---|---|---|
| tte>300, H1 | 514 | 94 | -6.545 | -7.427 | -1.197 |
| tte>300, H2 | 36 | 15 | -5.282 | -5.672 | -2.201 |

- Worst per-market cluster found anywhere, negative in both halves, but total n = **109 independent markets**.
- Confound: window-open references for the labeled-1h universe were poisoned for the entire sample period. [Coordinator addendum: the root cause is worse than wrong candles — 539 of these "1h" markets are mislabeled 15-minute markets; see report-oracle-arb-2026-07-18.md F1 and the 2026-07-18 PM classifier fix.]
- Concurrent-period check (H2 only): offset-window fills -0.286/fill (719 fills, 265 mkts) vs +0.101/fill top-of-hour (81 fills, 35 mkts) — consistent with the poisoning story; top-of-hour n far below the bar.
**Verdict: ACTIONABLE as quarantine/rescore trigger; NOT a validated alpha filter** (n=109 mkts; mechanism is data corruption).

---

## Finding 3 — pm_flow continuation arm: large trigger notional kills the follow (ACTIONABLE within flow-lab)
**Rule (flow-lab, arm='continuation'): skip when `features->trigger_notional > $100`; concentrate on $10–25 triggers.**

Fee-net pnl_10s per fill (fee-net verified via `markouts`, `polymarket-token-fee-endpoint-v1`, fee_rate 0.10), fixed arm and latency:

| latency | notional quartile | fills | condition_ids | avg pnl_10s | win rate |
|---|---|---|---|---|---|
| 250ms | q1 $10–25 | 268 | 53+10 (2 halves) | -0.15 / -0.12 | 36% / 23% |
| 250ms | q4 >$112 | 268 | 39+13 | **-1.12 / -0.87** | 21% / 15% |
| 25ms | q1 $10–25 | 337 | 65 | -0.13 | 35% |
| 25ms | q4 >$107 | 337 | 52 | **-0.87** | 21% |

- Monotone across quartiles, consistent at two latencies and both intra-day halves (split 2026-07-16 12:45Z). Mechanism: big sweeps already exhausted the move.
- Caveats: single day, 93 condition_ids, **no bucket positive at 10% fees** — separates less-bad from worse. fade_control shows no notional gradient. 15–24% of fills have null pnl_10s (tape blind), excluded — selection risk.
```sql
WITH base AS (
  SELECT g.arm, g.condition_id, g.decision_at, sc.pnl_10s,
         (g.features->>'trigger_notional')::float notional
  FROM pm_flow_signals g JOIN pm_flow_scores sc ON sc.signal_id=g.id
  WHERE sc.filled AND sc.pnl_10s IS NOT NULL AND g.arm='continuation' AND g.latency_ms=250),
q AS (SELECT *, ntile(4) OVER (ORDER BY notional) qn FROM base)
SELECT qn, count(*), count(DISTINCT condition_id), avg(pnl_10s),
       avg((pnl_10s>0)::int) FROM q GROUP BY 1 ORDER BY 1;
```
**Verdict: ACTIONABLE as a flow-lab filter** (paired design, monotone, replicated), but only reduces losses at current fees; re-verify — 93 condition_ids, one day.

---

## Finding 4 — High sigma hurts non-reversion strategies only (SUGGESTIVE→ACTIONABLE)
**Rule: for strategies OUTSIDE the fade family, skip entries when `features->sigma` (sigma5m_ewma) > 0.002 (≈ pooled 70th percentile).**

| cell | fills | mkts | avg/fill @1x | $/mkt @1x | $/mkt @2x |
|---|---|---|---|---|---|
| non-fade, sigma>0.002, H1 | 2,877 | 1,191 | -0.627 | -1.516 | -1.845 |
| non-fade, sigma>0.002, H2 | 3,444 | 1,074 | -0.807 | -2.588 | -3.068 |
| non-fade, sigma≤0.002, H1 | 9,840 | 3,570 | -0.443 | — | — |
| non-fade, sigma≤0.002, H2 | 8,800 | 2,513 | -0.260 | — | — |
| fade family, sigma>0.002 | 3,856 | 1,613 | -0.29 to -0.51 | — | — |

- High-sigma worse than same-strategy low-sigma fills in both halves (Δ/fill -0.18 H1, -0.55 H2). Pooled loss-rate by sigma decile is monotone (40% d1-2 → 67% d8-10).
- Fade family shows the opposite/flat — reversion wants vol. Apply per-family, not globally.
- Sign stable, size unstable (3x between halves). Threshold 0.002 is in-sample-chosen.
**Verdict: SUGGESTIVE→ACTIONABLE** (sign stable both halves on >1,000 mkts per cell).

---

## Finding 5 — Latency-conditional losses: borg labels cannot answer it; pm_flow can (mechanism finding)
- **`latency_profile` in borg_shadow_orders is NOT an A/B.** Every strategy's NULL-profile rows end at 2026-07-15 ~19:25Z and profiled rows begin minutes later (checked G_late_arb, H19, H33, H36, H2__event, H6__sampled: zero market overlap between variants). All apparent "latency flips sign" contrasts (e.g. H19 NULL +$29 vs latency_1s -$1,277) are **period-confounded**. Retract any narrative built on these labels.
- **pm_flow is a true paired latency replay** (same signals at 25/100/250/500/1000/2000ms, 2026-07-16, 89–93 condition_ids):
  - `fade_control`: pnl_10s **improves** with latency: -1.289 @25ms → -1.000 @1000ms.
  - `continuation`: pnl_10s **degrades** with latency: -0.457 @25ms → -0.689 @2000ms.
  - No sign flip anywhere (all cells negative at 10% fee). Continuation mechanisms are latency-sensitive (perishable gross edge); fade mechanisms latency-insensitive/anti-sensitive.
```sql
SELECT g.arm, g.latency_ms, count(*) FILTER (WHERE sc.filled),
       avg(sc.pnl_10s) FILTER (WHERE sc.filled)
FROM pm_flow_signals g JOIN pm_flow_scores sc ON sc.signal_id=g.id
WHERE g.arm IN ('fade_control','continuation') GROUP BY 1,2 ORDER BY 1,2;
```
**Verdict: confound finding is FIRM (design fact). pm_flow gradient SUGGESTIVE** (89–93 condition_ids, one day). Recommend a real parallel-latency-arm borg experiment.

---

## Finding 6 — Wide spread (>8¢) at entry, fade family + G_late_arb (SUGGESTIVE)
**Candidate rule: skip entries when quoted spread on the traded token > $0.08.**
- Pooled strategy-demeaned excess: **-0.295/fill (H1, 709 mkts), -0.217/fill (H2, 491 mkts)** @1x; -0.266/-0.175 @2x — the only spread band negative-excess in both halves (2–8¢ bands are positive-excess).
- Fade family + G_late_arb: $/mkt -1.001 (H1, 193 mkts) / -0.929 (H2, 239 mkts) @1x; consistent per-strategy in G_late_arb, H19, H33, H36 (both halves each).
- Not universal: H47 is *better* on wide spreads both halves; H42 flips. Apply per-family if at all.
**Verdict: SUGGESTIVE.**

---

## Finding 7 — Checked, did NOT clear the bar
- **Longshot entry (<$0.20): pooled effect is a strategy-mix artifact.** Pooled demeaned excess negative both halves BUT sign-flips per strategy: H19 cheap fills strongly *positive* (+1.87/+1.99 per fill both halves). NOISE as a global rule.
- **|rtds_divergence_bps| ≥ 20 at entry**: aggregate -2.91/fill (49 mkts), monotone band gradient — but feed exists only from ~07-16 and the effect **flips sign across sub-periods**. NOISE — recheck at ≥100 mkts per sub-period.
- **book_age_ms**: inverted — >1s-stale-book fills have *positive* excess (~1,400 mkts). Maker/quote-refresh artifact, not a rule.
- **Day-of-week**: one week of data. NOT EVALUABLE.
- **data_quality_grade B vs A**: B worse both halves, weak — hygiene, not a finding.
- **halted flag**: no filled fills with halted=true.
- **Favorites ≥$0.60**: positive excess both halves — mirror of the mix artifact; no new action.
- **fade_control notional gradient**: flat — the notional effect is continuation-specific.

## Method notes / caveats
- All queries index-bounded; borg_clob_touch and am_book_touches never touched. Row counts reconciled at each step.
- "Excess" = pnl minus strategy mean; removes strategy mix, not within-strategy time drift.
- Everything is in-sample over 7 days on a platform where nearly all strategies are net losers; thresholds (0.002 sigma, $0.08 spread, $100 notional) chosen from the same data. All rules are candidates for the frozen-eval protocol, not deployable edges.
