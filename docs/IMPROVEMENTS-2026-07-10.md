# IMPROVEMENTS.md — what changed, why, and how to judge it

Companion to AUDIT.md. Every change below is one commit (`git log --oneline`).
Data basis for all claims: 53 closed paper trades + 4,186 signals from 2026-07-09,
plus counterfactual resolutions fetched from Gamma per market.

---

## 1. Executive summary (honest)

**There is no evidence of real, exploitable edge in this strategy as built.** The 53-trade
history is a 49% win rate and −$236 net — statistically indistinguishable from a fair coin
paying binary odds minus costs (Wilson 95% CI on the win rate: ~36–62%). More damning than
the sample size: the model's own claimed EV has **zero correlation with realized returns**
(Pearson −0.014; OLS slope −0.082 where a calibrated model requires ≈ +1), and 60% of all
trades claimed >15% edge — a number an actively market-made 5-minute binary essentially
never leaves on the table — while that bucket averaged −5.4% ROI. The claimed edge is
largely *manufactured by construction*: the heuristic sets `modelProb = price ± totalEdge`,
so EV grows with BTC delta whether or not the market is wrong (corr 0.332 across 932 TRADE
signals). The exits are not the problem — holding every trade to resolution would have lost
$268 *more*. Current PnL is consistent with noise plus miscalibration, not with a
suppressed edge. The work in this audit makes the next 300 paper trades *measurable*
(honest fills, decomposed edge logging, calibration tooling); it does not, and cannot,
manufacture an edge.

---

## 2. Correctness fixes (Phase 1)

| Commit | Change | Root cause |
|---|---|---|
| `fix(db)` | Boot migrations strictly set-if-NULL | `gate2_ev_floor=2.00 WHERE >=5.00` stomped operator values every boot |
| `fix(settings)` | `min_confidence` + 12 other knobs now saveable; null-safe enforcement | Settings route silently dropped them; DB stayed at migration-seeded 0.150 |
| `fix(trades)` | `gate3_score`/`model_prob` persisted with `??` semantics + WARN on gaps | `\|\|` coerced falsy values; historical writer dropped the fields entirely |
| `fix(risk)` | Daily loss: mode-scoped, excludes virtuals, includes open-position mark-to-market, fail-closed, one CRITICAL halt line, flip-leg bypass closed | Realized −$342 against a $50 limit on 2026-07-09 |
| `fix(signals)` | One TRADE row per market per 60s; engine skips cycle-locked markets | Up to 31 identical TRADE rows per market per 5 min |
| `fix(exits)` | Early stop needs smoothed-price trigger + `stop_confirm_ticks` (2) consecutive ticks | Raw boundary-book mids flicker ±1–2¢/tick |

**Stop-loss verdict (against the brief's hypothesis):** the stop is *not* firing mainly on
noise. Counterfactual on all 24 HARD_STOP_LOSS exits: actual −$808 vs −$943 held to
resolution; only 8/24 would have recovered. The stop was kept; only the flicker guard was
added.

## 3. Simulation honesty (Phase 2)

- **Entries** on real CLOB books now walk actual ask depth (`SlippageEngine`, previously
  computed but never applied), size down to available liquidity, skip when the book can't
  absorb $1, and add `paper_fill_penalty_ticks` (default 1). Boundary-book entries keep
  the existing +5-tick synthetic ask (already pessimistic).
- **Exits**: non-terminal paper exits (stops/locks/flips) take a
  `paper_exit_haircut_ticks` haircut (default 1). Resolutions settle exactly at 0/1.
- **Fees**: close-time fee is now `paper_fee_rate` (default 0.02 of positive gross —
  unchanged behavior). **Known basis mismatch, documented not hidden:** `EV_adj` subtracts
  0.2% *of notional* as fees while realized PnL subtracts 2% *of gains*. These are
  different quantities; whichever matches Polymarket's actual fee schedule for these
  markets should win, and both knobs now exist to align them.
- **Resolution-source risk**: every signal/trade now records
  `oracle_divergence_bps` (|Binance − Chainlink| at entry) and `oracle_lag_ms`. The hard
  skip `max_oracle_divergence_bps` ships **disabled (NULL)** — enable only if
  `ev-autopsy` §4 shows loss clustering after ≥300 fresh trades.

Net effect: paper results are now biased slightly *against* the strategy. If the next 300
trades are profitable under these fills, that means more than the old numbers did.

## 4. Measurement tooling (Phase 3)

- `node scripts/calibration.js` — per-bucket calibration (predicted vs realized UP
  frequency) with counts and Wilson 95% CIs, Brier score and log-loss, computed
  separately for Φ alone, heuristic alone, ensemble, and executed trades. One
  observation per market (5s signal spam would fake tight CIs). Refuses to conclude
  below ~100 resolved observations.
- `node scripts/ev-autopsy.js` — claimed EV vs realized ROI (buckets, correlation, OLS),
  hold-to-resolution counterfactual per close reason, mechanical-EV test, oracle
  divergence clustering, instant-vs-rested fill comparison.
- Every signal now persists its edge decomposition (`p_phi`, `p_heur`, `model_prob`,
  `btc_edge`, `micro_edge`, `ensemble_delta`, `yes_price`, `sigma_5min`, `sigma_source`,
  `remaining_sec`) so the next autopsy can attribute losses to a component.

**Hypothesis findings (from code + data, per the brief §Phase 3.4):**
- **(a) CONFIRMED.** `pHeur = yesPrice ± totalEdge` ⇒ heuristic claimed EV ≈ totalEdge −
  costs by construction; through the 0.4 ensemble weight every point of btcEdge/microEdge
  mechanically adds ~0.4pt of claimed EV. corr(|btcDelta|, claimed EV) = 0.332 (n=932),
  while corr(claimed EV, realized ROI) = −0.014 (n=53). The edge is manufactured.
- **(b) PLAUSIBLE, now measurable.** Dynamic σ comes from a 20-minute rolling window of
  1m closes: after a vol regime shift it underestimates σ for ~10 minutes, inflating |z|
  and Φ confidence exactly when markets are moving. `sigma_5min`/`sigma_source` are now
  logged per signal; the calibration report will show it as Φ overconfidence in the tail
  buckets. Not "fixed" blind — needs the data first.
- **(c) NOT TESTABLE YET.** All 53 paper entries filled instantly (`time_to_fill_sec=0`);
  there are no rested fills to compare. The autopsy reports this honestly.

## 5. Strategy changes (Phase 4) — all PROVISIONAL

| Flag | Default | Mechanism | Risk |
|---|---|---|---|
| `kelly_prob_shrink` | 0.5 | Kelly is exponentially sensitive to estimation error; measured probabilities are overconfident (implied 55–70% win, realized 41–49%). `p' = 0.5 + k(p−0.5)` shrinks stake, never trade selection. Standard fractional-Kelly argument, not curve-fit to the 53 trades. | Undersizing if the model is actually calibrated (disprovable via calibration.js) |
| `min_entry_remaining_sec` | 60 (existing behavior, now configurable) | Binary jump risk: near expiry the token gaps to 0/1 with no time to manage; both −$100 wipeouts rode late entries to resolution. | Misses genuinely late information edges (latency-arb mode exists separately for that) |
| `ev_band_ceiling` | **NULL = off** | Efficient-market prior: >15% claimed EV on an actively made 5-min binary is a model error, not free money; historical >15% bucket lost −$177 at 41% wins. Off by default per the no-tuning-on-50-trades rule. | If the model ever finds real fat edges, the ceiling censors the best trades |
| `stop_confirm_ticks` | 2 | Filters single-tick mid flickers from the early stop; late (<30s) stop unchanged. | One extra tick (~5s) of adverse drift on true collapses |
| `max_oracle_divergence_bps` | **NULL = off** | Resolution happens on Chainlink, signals on Binance; large divergence means the model's anchor is wrong. | None while off; enabling too tight starves the bot |

**Deliberately not done:** per-component edge caps (no attribution data exists yet — the
columns are new); any re-tuning of `gate2_ev_floor`, `min_btc_delta`, scenario
multipliers, or ensemble weight (50 trades is noise; the constraint in the brief is
correct).

## 5b. George — the split test (added 2026-07-10)

A second, paper-only bot ("George" tab in the dashboard) runs the audit's alpha thesis
head-to-head against the main bot: it models the **Chainlink resolution print** (deviation
band ~0.5%, heartbeat 3600s) instead of Binance spot, uses a fast EWMA σ, no heuristic,
flat $10 stakes, holds to resolution, and only trades when model-vs-price edge exceeds
5 points *after* a 3-point cost buffer. Own tables (`george_trades`/`george_signals`), so
neither bot's risk logic sees the other's positions.

**How to judge the split test:** both bots watch the same markets over the same period.
After ≥100 George trades compare (a) win rate vs the entry-price-implied rate, (b) PnL
per $ staked vs the main bot's, (c) calibration of `p_model` in `george_trades` against
resolutions. George trading *rarely* is expected — selectivity is the design. George
trading *never* means the edge floor is above what the model finds; check
`george_signals` for near-misses before loosening `george_min_edge`.

## 6. How to evaluate over the next ≥300 paper trades

Reset nothing; let the bot accumulate ≥300 *fresh* closed trades under the new fill model,
then:

1. **`node scripts/calibration.js`** — the single most important output.
   - If realized win frequency is ~flat across modelProb buckets (all Wilson CIs
     overlapping the base rate) ⇒ **modelProb is uninformative; stop trading this signal
     and redesign the model.** That outcome is entirely possible and must be accepted.
   - If buckets are monotone but compressed (e.g. bucket 70% realizes 55%), set
     `kelly_prob_shrink` ≈ the fitted slope of realized-vs-predicted (regress around 0.5).
2. **`node scripts/ev-autopsy.js`**:
   - §1: OLS slope of realized ROI on claimed EV. Success = slope significantly > 0.
     Slope ≈ 0 again ⇒ the EV pipeline (heuristic + scenario multipliers) is decorative.
   - §3: with decomposition populated, check which component (btcEdge, microEdge,
     |Φ−price|) correlates with *realized* ROI, not claimed EV. Cap or remove components
     that only predict claimed EV.
   - §4: if above-median divergence trades underperform materially, set
     `max_oracle_divergence_bps` near the observed 75th percentile.
3. **Stop-loss guard**: compare HARD_STOP_LOSS frequency and the stopped-then-won rate vs
   the 8/24 baseline. If the confirm-tick guard didn't reduce false stops, revert it
   (`stop_confirm_ticks=1`).
4. **Risk plumbing**: verify exactly one `DAILY LOSS HALT` CRITICAL line appears if the
   24h PnL breaches the limit, and that no entries follow it. Also reconsider
   `max_trade_size=$100` against `max_daily_loss=$50` — a 2:1 ratio of per-trade risk to
   daily budget makes the limit largely ceremonial, and `override_daily_loss=true`
   (currently honored but warned about) disables it entirely.
5. **Success criterion for the strategy as a whole**: after ≥300 trades, net PnL > 0
   *under pessimistic fills* AND calibration slope > 0 AND EV-autopsy slope > 0. Anything
   less is noise + miscalibration, and the honest move is to keep it in paper mode or
   retire the heuristic component.

## 7. Red-flag remediation (2026-07-10 PM, operator-ordered)

Operator directed: "fix all of the issues in the red flag summary" (from the two
built-in Claude analyses run earlier that day). Disposition of each flag — fixes are
PROVISIONAL where they set thresholds; re-evaluate all of them at the §6 checkpoint.

| Flag | Verdict | Action |
|---|---|---|
| Gate 1 dead (score always 0.200) | **Real bug** | Synthetic WS/Gamma price objects carried no book fields → imbalance/whale terms 0, depth term saturated = constant 0.200. Composite now reads the real CLOB `yesBook`; `composite()` defaults missing fields to 0. Gate stays informational (engagement constraint). |
| Confidence inversely predictive | **Not supported** | The two analyses found OPPOSITE confidence-PnL signs on near-identical data; calibration Brier ≈ base rate. No inversion/filter applied. `kelly_prob_shrink=0.5` already discounts model confidence in sizing. |
| Stop loss destroying edge | **Unstable evidence** | Fresh-cohort counterfactual: holding 29 stops saves ~$710; historical cohort said the opposite. Neither "tighten" (analysis 1) nor "disable" (analysis 2) defensible. New `hard_stop_loss_pct` setting (flat override of tiered stops), set 75 → stop now catches only catastrophic moves. NULL reverts to tiered behavior. |
| Max daily loss not enforced | **Operator override** | `override_daily_loss` was `true` (the kill switch added mid-audit). Set back to `false` — 24h rolling limit re-armed. Enforcement code itself was verified correct (fail-closed, mark-to-market). |
| YES trades hemorrhaging | **Consistent across cohorts** | New `yes_trade_size_multiplier` (size-only haircut, never changes which trades fire), set 0.50. |
| Position sizing vs edge | **Agreed** | `max_trade_size` $100 → $25 (also fixes the ceremonial 2:1 per-trade-risk vs daily-budget ratio from §6.4). `kelly_cap` untouched — with shrink 0.5 the binding constraint is now the $25 cap. |
| EV model miscalibrated | **Known, structural** | Claimed EV is manufactured by construction (corr 0.989 with |Φ−price|); no floor value fixes that. `gate2_ev_floor` left at 0.80 — both analyses' proposed floors (15 vs 25) would have cut different "best" buckets on different snapshots. Real fix = George split test + §6 verdict. |
| EMA edge / Gate 3 inverted | **Not a bug** | Gate 3 is a direction check; `gate3_score` = signed btcDelta, negative EXPECTED on NO trades. `gate3_min_edge` is a dead column that was exported to the Claude analysis route — that misreporting (not the gate) caused the misdiagnosis. Route now reports `gate3_min_delta` + architecture facts so future analyses stop rediscovering phantom bugs. |
| Over-polling | **Agreed, partially** | `snipe_timer_seconds` 5 → 15 (not 30: position management shares the tick; at 30s the <30s late-stop window would see ≤1 tick and `stop_confirm_ticks=2` would take 60s). |
| Open trade with negative gate3 | **N/A** | Sign convention (see Gate 3 above); zero open trades at remediation time. |

Requires a full process restart to take effect (code + in-memory settings).

## 8. Symmetric sizing + declined tunings (2026-07-11, ~01:30 BST)

Operator requested a performance pass off a 30-trade dashboard analysis (ids 138–167)
recommending: NO-side size haircut, per-direction/raised EV floor, and
`gate3_min_delta` 0.05 → 0.03.

**Context that dominates everything else: the direction split sign-flipped between
cohorts.** §7 added `yes_trade_size_multiplier=0.50` because YES was net negative in
both cohorts available on 2026-07-10. The current cohort is YES +$83.41 (12/16),
NO −$75.10 (4/13) — the exact opposite. This is a live demonstration that
direction-conditioned tuning on ≤100-trade samples chases noise.

### Applied (live via settings PUT, no restart needed — the PUT handler refreshes `bot.settings`)
| Setting | Was | Now | Rationale |
|---|---|---|---|
| `max_trade_size` | $25.00 | **$12.50** | Cap both directions at what YES was already capped at. NO tail risk halved (the two −$25 full losses become −$12.50). Risk symmetry, not direction prediction. |
| `yes_trade_size_multiplier` | 0.50 | **1.00** | Remove the direction asymmetry outright. YES max size unchanged ($25×0.5 = $12.50×1.0). |

Net effect: identical YES sizing, NO sizing halved, book-level max per trade risk
halved, zero direction-conditioned parameters remain.

### Declined (same class of error §7 already documented)
- **Per-direction EV floor / floor raise to 3.00** — would encode "NO is bad" off
  n=13; the sign flip above shows how that ends. `gate2_ev_floor` stays 0.80.
- **`gate3_min_delta` 0.05 → 0.03** — NO trades lost at similar rates whether the
  direction check fired (1W/4L) or was skipped (3W/5L); the gate is not the variable.
- **NO-side multiplier** — strictly dominated by the symmetric cap applied above.

### Cohort reset warning
The trades table was truncated between 2026-07-10 ~14:00 and now: ids 54–137 (the
71-trade fresh cohort, +$448.62 at last reading) are gone; the table now starts at
id 138 (2026-07-10 14:46 UTC). **The §6 ≥300-trade clock restarted from zero.** Do
not wipe `trades`/`signals` again before the §6 checkpoint — every wipe resets the
only evidence base this project has.

### Current-cohort measurements (scripts run 2026-07-11, all n-limited)
- Ensemble calibration (n=70 resolved): **Brier 0.1894 vs base-rate 0.2492** — first
  better-than-base-rate reading for any estimator in this project. Provisional (<100).
- claimed-EV → realized-ROI (n=29): slope **+1.14**, corr 0.19 (audit-day value: −0.08).
- Exit-policy counterfactual (n=29): exits **added +$13.02** vs hold-to-resolution
  (EV_FLIP +$40.07 saved, hard stops −$14.01 cost). Sign flipped again vs both prior
  cohorts → `stop_confirm_ticks` / `hard_stop_loss_pct` stay PROVISIONAL.

### Also in the tree, uncommitted, not from this pass (review + commit or revert)
Live since the 01:13 BST restart: macro-trend filter (`macro_trend_*`, 10-min
counter-trend block), `max_entry_price` ceiling 0.65, late stop widened −15% → −45%,
`hard_stop_loss_pct` 75 → 60 in DB, paper-balance defaults 1000 → 500. Zero
macro-trend or ceiling blocks have fired yet. All are threshold changes made below
the §6 evidence bar — treat as PROVISIONAL like everything else.
