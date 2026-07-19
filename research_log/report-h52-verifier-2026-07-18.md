# H52 Independent Verification — Adversarial Report

**Verifier:** independent fresh-context session, read-only, 2026-07-18 (~18:10Z)
**Claim under attack (H52):** direction_1h, final 60–300s, favorite (higher best ask) with ask in [0.50, 0.60] won 27/40; +$0.110/share net of 1x fees (0.07·p·(1−p)); deployed as frozen paper arm `H52_hourly_neareven_favorite_v1` (experiment `research-h52-hourly-neareven-favorite-v1`, fair=0.675).
**Method:** all SQL written from scratch (not reused from the discovery session), run via `ssh deltaforge-vps` → `psql -d deltaforge`, SELECT only.

**Headline verdict: WEAKENED on the hypothesis — and the deployed arm is BROKEN as implemented (92% of its forward orders are on direction_5m, not direction_1h) and must be killed/redeployed.**

---

## 0. Data context (matters for everything below)

- `borg_book_snaps` spans **2026-07-17 01:14Z → 2026-07-18 17:55Z only** (1.40M rows). The "two capture days" are not a robustness split — they are the entire dataset.
- Snap cadence is ~1 s per market; 647 resolved 1h markets have snaps in tte [60,300], 164 do not.
- book_src: ws 80%, rest_stale/ws_stale/etc ~17% — but see §2: all 40 cell entries are `ws`.
- Daily UP rates (all resolved 1h markets): 07-17 per asset 0.484–0.500; 07-18: btc 0.583, eth 0.472, sol 0.514, xrp 0.514. **No one-sided trend regime on either day.**

## 1. From-scratch reproduction + snapshot-choice sensitivity

One snapshot per resolved 1h market, tte ∈ [60,300], favorite = higher best ask, band [0.50, 0.60], PnL = 1{win} − ask − fee.

| Run | n | wins | net 1x | net 2x | net 1x @ ask+1¢ |
|---|---|---|---|---|---|
| FIRST snap in window (≈tte 300) | 40 | 28 | **+0.135** | +0.118 | +0.125 |
| LAST snap in window (≈tte 60) | 21 | 13 | **+0.048** | +0.031 | +0.038 |

- FIRST-snap **replicates** the claim (28/40 vs their 27/40; small tie-break diff). Avg ask 0.5475, avg ask-sum 1.010 (matches their 1.011).
- LAST-snap **collapses**: only 21 markets still in-band at the end of the same 4-minute window, and net drops 64%. The result is highly sensitive to which snapshot inside the claimed window you take.

**Entry-time structure (band applied at the first snap of each tte sub-window):**

| tte bucket | n | wins | net 1x |
|---|---|---|---|
| 240–300 | 40 | 28 | +0.135 |
| 180–240 | 30 | 17 | **−0.001** |
| 120–180 | 35 | 21 | +0.033 |
| 60–120 | 28 | 20 | +0.146 |

This is a **zigzag, not a gradient**. A real terminal-convergence edge should be monotone (or at least consistent) as expiry approaches; here the same cell is dead flat at 180–240s and positive on both sides of it. The session's "later entry +0.174 vs earlier +0.110" claim picks the two positive buckets while the middle buckets (~65 overlapping markets) show ≈0. This is the signature of a 40-market sample sliced until sub-cells wiggle, not of structure.

**Statistics.** Null = book-implied favorite prob ≈ ask/ask-sum ≈ 0.542 (also ≈ the 5m favorite's realized 52.8%):
- 28/40, p0=0.542 → exact one-sided **p = 0.031**.
- The 40 entries are **not independent** (claim says they are): they fall in 34 distinct entry timestamps; 6 same-minute cross-asset pairs of which 5 resolved identically (09:10 L/L, 09:25 W/W, 21:25 W/W, 01:10 W/W, 13:40 W/W, 15:25 W/L); plus same-asset overlapping hourly windows (e.g. btc entries 06:10/06:25/06:40 share 45+ min of path). Cluster-collapsed 24/34 → **p = 0.039**; effective-n ≈ 30 → **p = 0.059**.
- H52 is (at least) the 52nd hypothesis screened, on top of within-hypothesis selection (band × tte × market-type × favorite/dog). A p ≈ 0.03–0.06 best cell under that search intensity is **fully consistent with the null**.
- Negative control at scale replicates: direction_5m, same construction, n=1,720, 909 wins (52.8%), **−0.033/share** (their −0.034) — the identical mechanism is fairly priced/fee-negative where n is large.

## 2. Stale-book artifact — attack FAILS (mostly)

- All 40 FIRST-cell entries are `book_src='ws'`; gap to next snap ≤ 1.2 s (median ~0.1–0.3 s); 200–290 snaps follow each entry. Quoted books are live, not stale REST caches.
- **Delayed-fill simulation** (pay the favorite's ask at the first snap ≥ entry + N s, same side): N=5s → +0.142; N=10s → +0.144; N=30s → +0.141 (all 40, avg pay ~0.54). The entry does not depend on hitting a fleeting quote.
- Caveat (adverse selection): winners' asks tend to run away (mean fraction of the following 60 s with fav ask ≤ entry+1 tick: 0.56 winners vs 0.63 losers; 6/28 winners ≤0.20 vs 1/12 losers), so slow execution skews fills toward losers — second-order at 5–30 s latencies per the simulation.
- **Depth is thin:** ask-side depth at the 40 entries: min $12, p25 $98, median $130, max $2,419. Capacity ≈ $50–200/entry at the touch.
- The platform's own execution model marks 6/34 (~17%) of forward orders unfilled (see §7) — displayed asks are not always takeable.

## 3. Momentum confound — untestable with this data; session's displacement claims used a broken column

- **`btc_ref` is NOT the market's window open.** Markets 52284 (window open 05:15, binance_open 63434.05) and 52421 (window open 05:30, binance_open 63206.68) show the **same** `btc_ref` = 63486.01 at their snaps. Any displacement analysis built on `btc_ref` is invalid.
- `btc_price` is actually the asset's spot (xrp markets show ~1.09), so displacement can be computed vs `borg_markets.binance_open` — but the stored candles are themselves unreliable: **203/813 (25%) of resolved 1h markets have sign(binance_close − binance_open) contradicting `outcome`** (e.g. 52421: open 63206.68, close 62931.23, outcome UP, Gamma ["0.9995","0.0005"]). `outcome` itself is trustworthy — 0/813 disagreements vs Gamma `outcome_prices` — but the platform's reference-price capture does not match the resolution reference. [Coordinator note: the 1m-candle repair was mid-flight while this verifier ran; recheck mismatch on repaired rows only.]
- Best-effort conditioning (btc_price vs binance_open at entry): all-market displaced-side win rates: |disp|<5bps 58.5%, 5–15 60.9%, 15–40 71.8%, ≥40bps 69.4% — only ~70% at ≥40 bps with ≤5 min left is itself evidence the reference data is polluted. Cell split: fav = displaced side → 12/20, **+0.033**; fav ≠ displaced → 16/20, **+0.238**. The claimed edge concentrates entirely in the sub-sample where the DB's displacement measure disagrees with the book, i.e. exactly where reference data is least trustworthy.
- Conclusion: the effect is not a simple trend-regime artifact (both days ~50/50), but the "survives displacement conditioning" robustness pillar is untestable/invalid and should be struck.

## 4. Band-edge sensitivity — partial pass

| band (fav ask) | n | wins | net 1x |
|---|---|---|---|
| 0.45–0.60 | 40 | 28 | +0.135 (no fav asks < 0.50 exist) |
| 0.48–0.58 | 38 | 27 | +0.148 |
| 0.50–0.55 | 19 | 14 | +0.194 |
| 0.52–0.62 | 39 | 27 | +0.109 |
| 0.55–0.60 | 21 | 14 | +0.082 |
| 0.50–0.65 | 73 | 48 | +0.056 |
| 0.60–0.70 | 63 | 43 | +0.012 |

Decay with ask level is smooth (0.194 → 0.082 → 0.012) and the book is calibrated at 0.60–0.70 (n=63, ≈0) — the strongest point in the discovery's favor. But sub-cells are n≈20, and widening to [0.50,0.65] dilutes the headline to +0.056.
Per-asset: btc +0.188 (9/12), eth +0.204 (7/9), xrp +0.193 (6/8), **sol −0.021 (6/11)**. Per-day: +0.131 / +0.139 — but two days is all the data (§0).

## 5. Fee/tick realism — attack FAILS

At avg entry 0.5475: 1x fee ≈ $0.0173/share; 2x ≈ $0.0347. Net 2x = +0.118; **net at ask+1 tick (1x) = +0.125**; ask+2 ticks ≈ +0.115. The claimed edge is ~8x the fee; fee/tick details cannot flip the sign. (Live Polymarket fee schedule not independently verifiable from the VPS — pin `fee_model_version`.) The binding constraint is depth (§2), not fees.

## 6. Snapshot-coverage bias — attack FAILS (benign)

All 164 resolved-without-snaps markets are explained by collector start: 24 on 07-15, 116 on 07-16, 24 on 07-17 (window_end hours 00–01, before first snap 01:14Z), **0 on 07-18**. No vol-correlated dropout; no cell bias.

## 7. Forward rows — the deployed arm is NOT testing H52 (deployment bug)

39 orders under `strategy LIKE 'H52%'`, 17:00:15Z–18:05:23Z on 07-18:

- **36/39 orders are on `market_type='direction_5m'`; only 3 on `direction_1h`** (join `borg_shadow_orders.market_id` → `borg_markets.market_type`; e.g. order 17:00:18 on market 79426 btc, window_end 17:05 — a 5-minute market). The universe filter evidently keys on tte/band only, not market_type: the arm named "hourly_neareven_favorite" is overwhelmingly trading the exact cell the discovery session itself measured at **−$0.034/share on n≈1,700**.
- Order rate corroborates: ~39 orders in 65 min vs the backtest cell rate of ~1/hr (40 entries in ~41 h).
- Early tape: 34 scored, 28 filled (6 unfilled, ~17%), 16W/12L, **sum pnl_1x ≈ −$3.8** (direction_5m −$2.80 / 26 fills; direction_1h −$1.01 / 2 fills). Fidelity grades A/B with some B/C.
- Consequence: the experiment as deployed generates **zero valid evidence about H52** — it will measure the known-negative 5m result or an uninterpretable blend.

## 8. Verdict

**WEAKENED (hypothesis) + BROKEN (deployment).**

Not a stale-book, fee, tick, trend-regime, or coverage artifact — those attacks fail; the cell replicates from scratch with smooth band decay and delay-robust paper fills. But: (1) p ≈ 0.03 uncorrected, ≈ 0.04–0.06 after clustering, against ≥52 screened hypotheses and heavy cell selection — consistent with pure selection; (2) the tte zigzag (+0.135/−0.001/+0.033/+0.146) is implausible for a real edge and the "later entry better" claim is a cherry-picked bucket; (3) the displacement-robustness claim rests on a broken `btc_ref` column and 25% candle/outcome disagreement; (4) "both days positive" is vacuous — two days is the whole dataset; (5) capacity ≈ $100/entry (median touch depth $130).

**Actions:** kill/redeploy the arm with `market_type='direction_1h'` in the universe filter (v2); exclude the 36 direction_5m rows from H52 scoring; pre-register entry (first snap tte 240–300, band [0.50,0.60], 1x fee at ask+1 tick) and a kill threshold (net ≤ 0 at n≥100 forward 1h markets); watch sol (negative in-sample), win-rate vs implied 0.542, and unfilled-order asymmetry. Separately, fix reference-price ingestion (`btc_ref`, binance candles) — 25% candle/outcome disagreement is a data-integrity issue bigger than H52.
