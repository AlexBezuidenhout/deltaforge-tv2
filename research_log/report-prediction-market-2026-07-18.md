# Prediction-Market Analyst report — daily thresholds, cross-strike coherence, Kalshi basis
**Date:** 2026-07-18 · **Access:** read-only psql on deltaforge-vps · 5m universe untouched per mandate.

## 0. Data inventory & reconciliation (checkpoints)
| Step | Got | Note |
|---|---|---|
| Resolved daily markets | **129** (121 threshold_daily: btc 73, eth 39, sol 6, xrp 3; 8 range_daily) | grew since brief |
| Expiry-event clusters (asset, window_end) | **28** resolved (25 with usable snaps) | span 2026-07-16 16:00 → 07-18 17:00 UTC (~2 days); window_ends are hourly (07:00–17:00 ET series) |
| Snapshots for resolved dailies | **237,644** rows, 114 markets → `daily_snaps_all.csv` (233,232 threshold rows, 112 markets, 25 events) | |
| tte coverage | **max tte = 2,840 s (47 min), median 21 min** | requested 6h/3h/1h lookaheads DO NOT EXIST in capture |
| Calibration extract (nearest snap to tte 120–2400 s, ±60 s) | **698 rows**, 113 markets, 25 events → `calib_snaps.csv`; 1,010 buy-at-ask legs / 173 deduped market-sides → `calib_legs.csv` | |
| cv_basis_samples | **142,866** rows, 28 matches, all UNREVIEWED, qty=5 → `cv_samples.csv`; 70,395 direction-paired obs → `cv_paired.csv` | |
| Structural evals | nested_threshold 147,978 total; crypto_ordered subset 3,315 nested + 2,608 disjoint | H26 IS evaluated |

**Global caveats:** 25 clusters ≪ 100 → per house rules every subgroup below is formally under the noise threshold. Spot trended up over the whole sample (UP/DOWN asymmetries confounded with drift). `ask_depth_usd` (aggregate displayed ask depth) has **median $2–4 per market** in the final 45 min — this universe is capacity-starved regardless of edge.

## Finding 1 — Daily threshold calibration in the final 45 min (first-ever)
Method: nearest snap to tte ∈ {2400,1800,1200,900,600,300,120} s; executable test = BUY at best ask per side; fee/share = 0.07·p·(1−p) at 1x/2x; z = ln(strike/spot)/(σ5m·√(tte/300)); dedup to one row per (market, side) at ~30 min; clusters = (asset, window_end).

By ask bucket (legs n=1,010): ≤5c: 412 legs/24 ev, win .000, EV1x −3.9c · 5–15c: 60/19, win .050, −2.2c · 15–35c: 18/6, −3.0c · 35–65c: 51/6, win .078, **−49c but median depth $0** · 65–85c: 9/4, +9.9c · 85–95c: 14/5, −35c · ≥95c: 446/24, win .937, −6.0c (depth>0 filter: win .986, **−1.1c**, n=72).

- **Where the book is soft:** near-ATM asks are grotesquely off but hollow (zero displayed depth) — vacant books, not tradeable mispricing. **NOISE.**
- **1a Tails overpriced:** deduped 58 tail sides (avg ask 3.5c, 17 events), expected wins Σask=2.04, **actual 0** (H1 0/0.91, H2 0/1.13). P≈e^−2.04≈**0.13** — not significant; shorting the tail = buying ≥95c complement at −1.1c EV. **SUGGESTIVE direction, not monetizable; re-test at ≥100 events.**
- **1b ITM-pennies** (buy near-certain side, |z|>3, ask<1.00): n=68 sides/23 events, **win 68/68**, avg ask .9966, EV1x **+0.32c/sh**, EV2x +0.30c, positive both halves (+0.21/+0.42c). Edge concentrated in asks ≤.99 (+1.05c, n=6). Break-even failure prob 0.33%; one loss erases ~3× accumulated edge. **Capacity: depth quartiles $1.9/$3.1/$110, ~$144/event, ~$3.3k total sample. SUGGESTIVE — no pilot before ≥100 events + fat-tail stress.**
- **1c UP+EV mid-z** (+10c, 12 events): uptrend confound. **NOISE — recheck on a down week.** Range_daily (n=8): DATA-INSUFFICIENT.

Repro SQL (extract):
```sql
COPY (WITH mk AS (SELECT id,asset,market_type,strike,window_end,outcome FROM borg_markets
 WHERE market_type IN ('threshold_daily','range_daily') AND outcome IS NOT NULL),
t(tgt) AS (VALUES (2400),(1800),(1200),(900),(600),(300),(120))
SELECT mk.*,t.tgt,s.* FROM mk CROSS JOIN t CROSS JOIN LATERAL (
 SELECT ts,tte_sec,up_best_bid,up_best_ask,down_best_bid,down_best_ask,btc_price,sigma5m_ewma,ask_depth_usd,bid_depth_usd
 FROM borg_book_snaps sn WHERE sn.market_id=mk.id AND sn.tte_sec BETWEEN t.tgt-60 AND t.tgt+60
 ORDER BY abs(sn.tte_sec-t.tgt) LIMIT 1) s) TO STDOUT WITH CSV HEADER;
```

## Finding 2 — Cross-strike coherence: NO executable violations
All strike pairs within multi-strike events (25 events, 3–6 strikes, mean 4.5), 10 s alignment; lock = YES@k_lo ask + NO@k_hi ask (min payout 1), fees per leg.
- **24,486 pairs → 0 executable locks at 1x fees** (a fortiori 2x). Adjacent-strike lock cost: n=11,143, **min 1.000**, p01 1.029, median 1.049 (~3–5c coherence cushion).
- 707 mid-price monotonicity violations in 12 events — all hollow-book artifacts (bid .001/ask .999); none survive at asks.
- **H26 scanner check:** crypto_ordered bundles ARE evaluated (`borg_structural_evaluations` ⋈ `borg_structural_candidates.universe_class='crypto_ordered'`: 3,315 nested + 2,608 disjoint evals, **0 economic, 0 qualified**). Global nested_threshold pool: 69,184 economic_candidate, 0 qualified, all blocked at `pass_orphan_risk=false`/`pass_proof=false`; top rows show the known **$73.38 parser-bug signature** (political date-nested pairs) — left flagged, not re-investigated per known-results.
**Verdict: NOISE — ladders coherent net of spread; scanner covers this plane; nothing to build.**
```sql
SELECT e.structure_type,count(*),count(*) FILTER (WHERE e.economic_candidate),count(*) FILTER (WHERE e.qualified)
FROM borg_structural_evaluations e JOIN borg_structural_candidates c USING (candidate_id)
WHERE c.universe_class='crypto_ordered' GROUP BY 1;
```

## Finding 3 — Kalshi basis: idiosyncratic per-match, persistent — but ZERO crypto matches
Signed mid-basis per (match, ts): pair both directions, (c1−c2)/2 = poly_mid − kalshi_mid on YES terms (spread asymmetry cancels to first order); 70,395 paired obs.
- **Headline: 0 of 28 matches are crypto** (12 UFC Jul-18 KO/TKO props, 5 World Cup, 7 PGA, 4 politics/misc). The target test — Kalshi-implied fair vs Polymarket ask predicting resolution on matched **crypto** contracts — is **DATA-INSUFFICIENT: the cv matcher never ingested Kalshi crypto series (KXBTC/KXBTCD/KXETH…)**. Highest-value capture gap found today.
- Distribution: overall median +1.0c, mean −0.3c, p05 −12c / p95 +16.4c → **no systematic venue-level rich/cheap side**. Per-match it is real: **17/25 matches |median basis| > 1c** (10 rich-poly, 7 cheap-poly); **9/12** matches alive in both halves keep the same sign; magnitudes 1.5–16c on liquid UFC props.
- Dwell: 885 episodes |basis|>2c, median 8 s, **p90 ≈ 16 min**, max ~22 h — quotable, not latency phenomena; 789 rich-poly vs 96 cheap-poly episodes.
- NCSEN match at −42c median = near-certain bad text match (identity_approved=f, different resolution criteria) — matcher-quality warning, and the source of all negative lock-cost tails (consistent with cv_opportunities economic=false throughout). Grades: 125,842 B / 16,440 F / 584 C (F not excluded; re-run filtered before decisions).
- Predictive scoring impossible today: none of the 28 matches resolved as of query time. **UFC card resolves tonight — re-score within 48 h** (Kalshi fair vs poly ask vs realized, Brier per match).
**Verdict: SUGGESTIVE as a fair-value mechanism; DATA-INSUFFICIENT for the predictive test.**

## Ranked summary
| # | Finding | Verdict | Capacity | Next gate |
|---|---|---|---|---|
| 1 | Kalshi crypto match gap (0/28 crypto) | **DATA-INSUFFICIENT (capture-gap, bug-level)** | n/a | add KXBTC*/KXETH* to cv matcher; ~1 wk capture for first crypto basis read |
| 2 | Persistent per-match Kalshi basis (1–16c, 9/12 sign-stable, p90 dwell 16 min) | SUGGESTIVE | qty-5 sampled; depth uncaptured | score vs resolutions Jul 19–20; relation review (1 approved) |
| 3 | ITM-pennies: 68/68 wins, +0.3c/sh at 1x and 2x | SUGGESTIVE | **~$144/event (~$3.3k sample)** | ≥100 events + fat-tail stress; no pilot yet |
| 4 | Tail overpricing (0 wins vs 2.04 expected, both halves) | SUGGESTIVE, not monetizable | complement −1.1c EV | recheck ~100 events (~Aug 1–5) |
| 5 | Near-ATM ask softness (−49c) | NOISE (zero-depth hollow books) | $0 | none |
| 6 | Cross-strike locks | NOISE (0/24,486; H26 scanner-covered) | $0 | none |
| 7 | UP-side +EV mid-z | NOISE (uptrend confound, 12 events) | — | re-test on down week |

## Missing capture / when n suffices
1. **Long-lookahead snaps don't exist** — dailies snapped only from ~47 min out; 6h/3h/1h calibration impossible until borg snaps dailies ≥6 h before window_end.
2. **Event count** — 25 usable clusters, ~14/day accruing → **~100 events around Aug 1–5**; all threshold claims formally noise until then.
3. **Kalshi crypto matching** — zero coverage; target 3's core question permanently unanswerable without it.
4. **Depth** — only aggregate `ask_depth_usd` used; per-level `up_asks` jsonb exists and should back future capacity claims.
