# DeltaForge opportunity review, afternoon session — 18 July 2026

Follow-up to `QUANT_EDGE_REVIEW_2026-07-18.md` (morning). Evidence cutoff
**~17:00 UTC**. This session hunted market universes and conditionings the
morning pass did not touch, audited experiment-arm logic, and shipped one new
frozen forward arm plus one data-integrity fix.

## Headline

**One new candidate edge was found, frozen and deployed: H52 — the hourly
near-even favorite.** It is the only positive executable cell found in any
scanned universe today, it replicates across days and entry timings, and its
negative control (the identical cell on 5-minute markets) is cleanly negative.
It is now accruing forward paper evidence under
`research-h52-hourly-neareven-favorite-v1`.

## 1. The H52 discovery (new)

The morning review scanned only 5-minute markets. TV2 has also captured
**~790 resolved 1-hour direction markets** (btc/eth/sol/xrp, since 07-15) with
172k book snapshots in their final five minutes. Calibration scan, one
snapshot per market, executable asks, crypto taker fee `0.07·p·(1−p)`:

| Cell (tte 60–300s, favorite = higher-ask side) | n | Fav WR | EV/share 1× | EV/share 2× |
|---|---:|---:|---:|---:|
| **1h, favorite ask 0.50–0.60** | **40** | **0.675** | **+0.110** | **+0.093** |
| 1h, favorite ask 0.60–0.70 | 62 | 0.677 | +0.008 | −0.008 |
| 1h, favorite ask 0.70+ | 381 | — | ≈ −0.01 to −0.03 | worse |
| 5m, favorite ask 0.50–0.60 (control) | 1698 | 0.527 | −0.034 | worse |

Robustness observed before freezing:

- Per-day: 07-17 n=21, +$0.099/share; 07-18 n=19, +$0.122/share.
- Entry timing: tte 240–300s +$0.110; tte 60–120s +$0.174 (n=27).
- Books are tight (~1¢ favorite spread; mean ask-sum 1.011) — these are real
  executable quotes, not wide-market artifacts.
- Complementary cut agrees: the 0.40–0.50 longshot side of the same markets is
  heavily overpriced (WR 0.326 at ask 0.449, −$0.14/share).
- Per-asset (0.50–0.70 pooled): btc +0.069 (n=33), eth +0.052 (25),
  xrp +0.221 (20), sol −0.131 (24). Treated as subgroup noise per the standing
  lesson; no asset excluded.

Honest weaknesses, all recorded in the manifest: two capture days only,
~1.7σ pooled against the priced probability, band and window chosen after
inspecting the table. That is why it is a **frozen forward eval**, not a
claim: 300 independent markets / 14 days / both halves positive at 2× /
market- and day-clustered lower bounds above zero / family-wise correction /
kill at n=150 if negative at 2×.

Mechanism hypothesis: quoting attention and HFT competition concentrate on the
5-minute markets; hourly books go stale in their final minutes, so terminal
favorites are underpriced exactly where the 5-minute equivalent is efficient.

**Deployed:** `borg/shadow/research-h52.js` + manifest, registered in
`strategies.js`, tests green (28/28 across related suites), collector
restarted 16:55Z, H52 evaluating on `direction_1h` with zero errors.
Economics if discovery holds: ~20–40 qualifying markets/day at ~$1.7/market at
2× costs on $10 stakes ≈ **$35–70/day paper**. That number exists to be
falsified by the eval, not banked.

## 2. Dead ends killed today (do not revisit without new data)

- **UP-bias / resolver tie rule:** p(UP) 0.46–0.51 everywhere; drift dominates.
  doge/sol/xrp have 4–6% exact-tie mass (coarse ticks, ties resolve UP), but
  the books already price it (doge near-zero displacement late: ask 0.600 vs
  truth 0.605). No cell.
- **Hour-of-day:** taker EV uniformly −2.4 to −2.9¢ across all 4-hour buckets
  on 5m. Nothing.
- **Ask-sum-conditioned favorite on 5m:** every sum bucket negative or ~0;
  the >1.05 bucket is the worst (wide books ≠ cheap favorites).
- **1h deep longshots (<0.10):** +1.2¢/share at 1×, ~0 at 2×, tiny per-market
  dollars. Not worth an arm.

## 3. Defects found and fixed

1. **1h Binance kline poisoning (fixed + repaired).** Hourly windows roll at
   :15/:30/:45, but `_kline()` floor-aligned to the calendar hour: offset
   windows carried the wrong candle open AND close — 33–41% resolution-sign
   mismatch vs ~1% on :00 windows. Outcomes were unaffected (Gamma-sourced);
   every Binance-reference feature/σ anchor on 1h markets was polluted.
   Fixed in `borg/recon/markets.js` (exact 1m candles), backfilled via
   `scripts/repair-1h-klines.js`.
2. **H44 is structurally starved.** Its band is tte 600–2400s on 1h markets,
   but the collector only tracks 1h markets inside their final ~300s. It has
   zero orders ever and can never fire. Either extend 1h tracking mid-window
   (CPU cost on a loaded box) or formally mark it STARVED in governance;
   leaving it nominally "running" misstates coverage.
3. **`live_gla_enabled` was still true** with the executor in dry mode —
   cleared to false (safe direction; executor unchanged).
4. **H41 eval arm is firing again** (14 eval orders today) — the silence
   flagged in the morning review resolved with the 12:40Z restart. H43 is
   alive (60k evaluations since restart) but genuinely selective: zero
   triggers in 22h of low-volatility tape is condition-scarcity, not a defect.

## 4. Status of the running money questions

- **Flow boundary V2 forward:** accruing (51 source markets of signals since
  13:30Z; boundary cohort itself 2 resolved markets — the 300-market clock is
  ~30 days by design). Early transit sensitivity is visible (250ms arm missed
  fills the 50ms arm took) — exactly what the eval is for.
- **Cross-venue:** unchanged — 0 forward episodes, 1 approved relation,
  102k opportunity observations in 24h with 0 economic. Kalshi feed still
  REST-batch (WS unconfigured). Breadth of proven relations remains the
  bottleneck, as the morning review said.
- **PMM v3-rewards:** still running 3 arms as a governed control (101 cycles
  today). Legitimate under the governance manifest, but it is ~6% CPU on a
  box whose latency telemetry is already polluted (allmarket reaction p95
  122ms, `reactionTargetMet: false`). Throttling controls on this box buys
  cleaner evidence for the arms that matter.
- **Structural scanner:** 0 economic candidates today across all proved
  evaluations. Consistent with the morning read.

## 5. Priority order as of tonight

1. Let **H52** run untouched to its n=150 kill-check (~4–7 days at observed
   rates), then n=300.
2. Keep **flow-boundary V2** and **H43** clocks running untouched.
3. Repair follow-through: any analysis that consumed 1h `binance_open/close`
   before today should be rerun before being cited.
4. Decide H44: extend 1h mid-window tracking or mark STARVED.
5. Cross-venue and daily-threshold programs: unchanged from the morning
   review (breadth and Deribit-surface reference model respectively).
