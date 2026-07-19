# BORG — Evaluation Protocol (pre-registered)

**Fixed 2026-07-11, before any strategy code exists and before recon data was
examined.** Changes to this protocol after evaluation begins reset the clock
for the affected strategy. This document exists so that BORG cannot lie to its
operator: the bar was set before anyone knew what the data would say.

## 1. Evaluation mode

Primary mode is **shadow execution**: the strategy logs the exact order it
would place (side, price, size, timestamp, full feature vector), and a scorer
later replays the subsequently observed tape to decide whether that order
would have filled, at what queue position, and what it would have earned.
Paper fills that assume instant execution at mid or at touch are **not
evidence** and appear nowhere in results.

## 2. Sample size (per strategy)

Whichever is LONGER:
- **≥ 500 scored shadow trades**, or
- **14 calendar days** of continuous shadow operation.

For maker strategies, a "trade" is a completed round-trip (fill + flatten or
resolution). Windows with feed gaps > 5s inside the strategy's active period
are excluded from the sample and counted in a data-quality appendix.

## 3. Frozen parameters

- The fair-value model (σ estimator choice, EWMA constants, tie-rule handling)
  is calibrated on recon data, then **FROZEN** in a tagged commit before the
  evaluation window opens. Recalibration only on a pre-scheduled cadence
  (weekly), never mid-window, never in response to results.
- Strategy parameters (δ, thresholds, sizes) are fixed in the strategy's
  config at window open. Any change ⇒ that strategy's clock resets to zero.
  The old sample is reported as a discarded pilot, not pooled.

## 4. Cost model (pessimistic by construction)

Applied to every scored shadow trade:
- Taker fee at the venue's published rate; if ambiguous, **2%** of notional.
- Maker fills modeled at **back-of-queue**: a resting order fills only when
  the tape shows cumulative traded size at its price level exceeding the size
  already posted at that level in the book snapshot when the order was placed
  (plus our own size).
- Partial fills: filled quantity capped at tape volume through our level.
- Adverse selection: entry marked against fair value 5s and 30s after fill;
  reported, not assumed away.
- Sensitivity grid: every expectancy reported at **0.5× / 1× / 2×** assumed
  costs. A strategy whose edge dies at 2× is flagged as cost-fragile; a
  strategy whose edge dies at 1× is dead.

## 5. Success metrics

Per strategy, reported with uncertainty:
- **Expectancy per trade** after 1× pessimistic costs, with 95% CI from
  bootstrap (10,000 resamples) — not normal-approx, PnL is fat-tailed.
- **Brier score** of the fair-value model over the same window vs the
  price-implied baseline and the base-rate baseline.
- Maker only: **net capture** = gross spread capture − adverse selection −
  fees, per $100 quoted, plus fill rate vs naive fill rate.
- **Capacity**: max deployable size before modeled self-impact (our fills
  consuming tape volume) cuts expectancy by 50%.
- Max drawdown in shadow PnL; longest losing streak (for operator sanity).

## 6. Pass bar

A strategy PASSES only if ALL hold:
1. Bootstrap 95% CI for expectancy after 1× costs excludes zero (positive).
2. Expectancy remains > 0 at 2× costs (else "cost-fragile", conditional pass
   requiring live-fee verification before any capital discussion).
3. Effect visible in both halves of the window (first half vs second half
   same sign) — cheap regime-luck screen.
4. **Multiple-comparisons correction**: with k strategies evaluated, the
   per-strategy significance level is Bonferroni-adjusted (α = 0.05/k). With
   ~5 strategies, a strategy needs to clear α = 0.01 — i.e. its bootstrap
   99% CI excludes zero. One-in-five "winners" at nominal α=0.05 is exactly
   what noise produces.

## 7. Kill / halt rules during evaluation

- Feed staleness (Binance > 10s, book > 15s) ⇒ strategy pauses, windows
  excluded, event logged.
- Shadow drawdown > 3× the strategy's projected daily edge ⇒ early review
  allowed (review may kill early; it may NOT extend or modify a live window).
- Any evidence of lookahead or scoring bug ⇒ entire window void, fix, restart.

## 8. Reporting

RESULTS.md carries, per strategy: sample size, expectancy ± CI at the cost
grid, calibration table, capacity, drawdown, verdict (PASS / FAIL /
COST-FRAGILE / VOID), and a data-quality appendix (gaps, excluded windows).
VERDICT.md states plainly which theses have defensible edge, at what capacity,
and which are dead. "No retail-achievable edge exists" is an acceptable and
complete primary finding.
