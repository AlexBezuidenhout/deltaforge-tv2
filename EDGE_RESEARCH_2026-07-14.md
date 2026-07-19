# Deltaforge edge research — 2026-07-14

Research cutoff: approximately 2026-07-14 12:52 UTC. This is an analysis of the database and collector as they existed at that cutoff. No live-order path, stake, live switch, or production threshold was changed.

## Executive verdict

There is no demonstrated general-purpose edge across the current bots. The best surviving hypothesis is **the existing G late-window signal restricted to ETH**: it is positive in development, the frozen shadow evaluation, and—most importantly—actual exchange fills. Those real ETH evaluation fills made **+$44.14 over 28 fills after the current crypto taker-fee curve**, with 26 wins and a maximum drawdown of -$9.88. Its ordinary 95% bootstrap interval is positive, but ETH was selected after comparing six assets; the six-asset Bonferroni-adjusted 99.17% interval is **[-$0.39, +$3.01] per fill**, so zero edge remains statistically plausible. This is a promising candidate for a fresh paper/shadow clock, not a confirmed production alpha and not a reason to increase live risk.

## Data state and integrity

At the cutoff, BORG contained 4,203 discovered markets, 4,188 resolutions, and 3,463 markets with live-captured opens. Binance, book, and CLOB-event collection were current within seconds. There were four book-snapshot gaps longer than five seconds in the preceding 24 hours. Raw `borg_book_snaps`, `borg_taker_trades`, and `borg_clob_events` are storage-capped and retain roughly two hours, so they are useful for recent execution checks but not long-horizon conclusions. Markets, resolutions, shadow orders, scores, signals, and trades persist.

The `chainlink_rounds` table is not treated as the resolution oracle. The earlier Chainlink push-feed premise was refuted: these markets use Chainlink Data Streams. The empirical outcome labels stored with the resolved markets are therefore the ground truth used below.

## Current strategy scoreboard

| System/cohort | Evidence at cutoff | Verdict |
|---|---:|---|
| BORG A maker | 1,142 filled, -$1,405.60 | Refuted; adverse selection dominates spread capture. |
| BORG A2 capped maker | 605 filled, -$316.83 | Refuted. |
| BORG D consistency | 18 filled, +$6.44 | Far too small to claim anything. |
| BORG F yield | 38 filled, -$9.72 | No evidence as parameterized. |
| Vasili, excluding HYPE | 983 filled, -$393.77; mean CI95 [-$0.72, -$0.08] | Refuted; stop collecting this as if it were promising. |
| G late arb, core pilot | 310 filled, +$254.99 | Development result only. |
| G late arb, frozen core eval | 181 filled, -$4.59; 2x-cost P&L -$37.52 | General cross-asset G edge did not reproduce. |
| George own signal | 173 closed across assets, approximately +$31, with large asset instability | Killed correctly; aggregate hides SOL -$173.58 and concentration in BTC/ETH. |
| George resurrection | 7 closed, -$27.56 | Too small and currently negative. Continue only as a new paper cohort. |
| MAIN heuristic/model | Brier 0.2156 versus market 0.2352 over 1,866 resolved markets | Predictive information may exist; executable edge has not been established. |

Pilot and evaluation results are deliberately not pooled. The old pooled G `CONFIRM` result is flattering because the pilot supplied nearly all the profit; the frozen evaluation cohort is approximately flat before stronger cost stress.

## Candidate edge: ETH late-window continuation

The candidate is not “buy ETH markets late.” It is the existing G conditional signal on ETH: a volatility-scaled Binance move indicates a highly likely terminal side while the corresponding Polymarket ask still leaves the required edge during the final 5–75 seconds.

### Backtest layers

| Layer | Trades/fills | Win rate | Net P&L | Mean/fill | Cost stress |
|---|---:|---:|---:|---:|---:|
| Pilot shadow, ETH | 68 | 94.1% | +$105.21 | +$1.55 | +$92.69 at BORG 2x costs |
| Frozen eval shadow, ETH | 45 | 93.3% | +$35.54 | +$0.79 | +$28.22 at BORG 2x costs |
| Actual exchange eval fills, ETH | 28 | 92.9% | +$44.14 | +$1.58 | $2.37 modeled taker fees already deducted |

Across all six assets, the actual G evaluation fills netted approximately **-$29.72** after the same modeled fees. ETH is a promising slice of an otherwise losing actual-fill cohort, not evidence that G as a whole is profitable.

The actual-fill calculation reconciles each accepted G order to authenticated CLOB trade history. Maker matches use the maker order's matched amount and price; taker matches use the trade size and price. Taker fees use `shares × 0.07 × price × (1-price)` and maker fees are set to zero, without adding possible maker rebates, following the current [Polymarket fee schedule](https://docs.polymarket.com/trading/fees).

Additional checks:

- Actual ETH maker fills: 10/10 wins, +$25.18. Actual ETH taker fills: 16/18 wins, +$18.96 after fees. Profit is therefore not solely a zero-fee maker artifact.
- The 28 fills split into two chronological halves of 14. Each half went 13/14 and was profitable (+$24.03, then +$20.12), although each half's individual interval still includes zero.
- Six ETH orders did not fill; all six would have won. The non-fill selection therefore hurt this sample rather than making it look better.
- Post-hoc TTE diagnostics were +$14.93 for 5–24 seconds (n=4), +$22.15 for 25–49 seconds (n=10), and +$7.06 for 50–75 seconds (n=14). These samples must **not** be used to retune the TTE window. They are logged only as hypotheses for a separately pre-declared future test.
- Both UP and DOWN sides were profitable. Restricting direction would be another unjustified post-hoc optimization.

### Why this could be a real mechanism

The collector's resolved-market comparison shows that Binance direction becomes highly reliable once the five-minute move is no longer settlement-scale noise: Binance sign disagreed with the resolved outcome on 29.83% of moves below 1 bp, 9.28% at 1–2 bp, 3.34% at 2–5 bp, 0.35% at 5–10 bp, and 0.09% at 10 bp or more. G attempts to buy only when volatility-scaled terminal certainty is high and the binary ask has not fully caught up.

ETH is plausibly slower to reprice than BTC because its five-minute market is less liquid, while still having enough participation to execute. The likely counterparties are stale cross-asset market makers and late profit-takers. However, the recent market-wide tape strongly rejects a generic ETH-late-buy story: over the rolling two-hour collector window, all late ETH BUY takers lost about $477 after the same fee curve. The candidate edge, if real, comes from G's selectivity—not from ETH or late buying alone.

### Why it is not yet proven

1. ETH was selected after inspecting six assets. The unadjusted actual-fill CI95 is approximately +$0.17 to +$2.70 per fill, but the six-asset-adjusted interval crosses zero.
2. There are only 28 actual ETH evaluation fills, well below the minimum fresh sample demanded by the project.
3. The general G signal decayed from +$254.99 in development to -$4.59 in frozen core evaluation. That is a direct warning about selection and regime effects.
4. Raw order-book retention is short, preventing a trustworthy historical replay outside the stored shadow/live cohorts.
5. The account's old wallet baseline has no stored timestamp, so it cannot be forced to reconcile with a precisely bounded order cohort. Per-order CLOB fills are the ground truth used here.

## MAIN: probability information, but no executable backtest yet

MAIN's current heuristic/model probability has a lower Brier score than the contemporaneous market probability across all six assets. The Phi-only model is worse (0.2577 overall), while the configured model and heuristic are identical because the current Phi ensemble weight is zero. This suggests the heuristic contains information about the eventual outcome.

The apparent paper trading profit is not proof of tradable alpha. Since the strict-era cutoff, 307 closed paper trades show +$701.82 recorded P&L, but the paper entry prices do not reliably match executable CLOB asks. In the current raw-tape overlap, seven paper entries had an average absolute paper-entry/actual-ask gap of 0.202 and a median gap of 0.140 on a 0–1 token scale. Only four were executable under the sampled ask rule; all four won, but that sample is statistical noise. MAIN needs a new exact-book, queue-aware forward shadow before its model advantage can be valued in dollars.

This is the second-best research direction: preserve the signal, discard the historical paper P&L as evidence, and measure entries at actual ask/depth with non-fills and current fees.

## Other brainstormed hypotheses

These are research candidates, not parameter recommendations:

1. **Maker-first ETH G execution.** Mechanism: preserve the same predictive signal while reducing taker fees. Evidence: ETH maker fills were 10/10 and +$25.18. Risk: severe fill selection and missed terminal jumps. Test as a separate randomized shadow execution arm against immediate-taker ETH, never by rewriting old fills.
2. **Large-move settlement convergence.** Mechanism: outcome/sign mismatch collapses above settlement-scale moves. A 5 bp floor is suggested by the collector, but is data-derived and therefore PROVISIONAL. Freeze it before a new cohort; do not mine a better cutoff from old G rows.
3. **Shorter-TTE ETH entries.** Mechanism: less time remains for reversal and stale asks can lag a terminal move. The current diagnostic is attractive but contains only 14 fills below 50 seconds. It is post-hoc and must remain off until independently tested.
4. **MAIN heuristic at real asks.** Mechanism: the heuristic's Brier improvement may translate into EV only where its calibrated probability exceeds an executable, fee-adjusted ask. This has the largest persistent probability sample but no honest execution sample yet.
5. **BNB late-flow anomaly.** The most recent two-hour market-wide tape was +7.1% for BNB late BUY takers. This is a short-retention regime observation, while G's BNB evaluation was negative. It is not an edge and should only be monitored for persistence.

No threshold above should be inserted into a bot based on this report. Every data-derived specialization is PROVISIONAL.

## Frozen forward evaluation for `ETH_G_LATE`

The clean next experiment is a new, read-only/shadow cohort beginning after this report's cutoff. It must not relabel old G rows or inherit pilot evidence as validation.

Freeze the candidate as:

- asset: ETH only;
- signal: unchanged G late-window logic;
- TTE: unchanged 5–75 seconds;
- Phi certainty: unchanged 0.88 minimum;
- model edge: unchanged 0.05 minimum;
- execution: one seat per market, exact displayed book/depth, queue-aware maker and taker arms recorded separately;
- costs: current taker curve, no maker rebate credit, plus the existing BORG 2x-cost stress;
- mode: paper/shadow only; no live stake increase.

Evaluate only after at least **500 fresh fills and 14 elapsed days** (which also exceeds the requested 300-trade minimum). Confirmation requires all of the following:

1. positive net P&L after exact fills and fees;
2. a six-comparison-adjusted confidence interval for mean P&L above zero;
3. positive P&L in both chronological halves;
4. positive P&L under the pre-declared 2x-cost stress;
5. no result dependence on one direction, one price bucket, or a handful of outliers;
6. stable fill rate and acceptable drawdown under a fixed $10 paper stake.

If the adjusted interval contains zero, or the mean decays toward zero as `n` grows, the honest conclusion is that the observed +$44.14 was selection plus noise. Do not rescue the thesis by changing thresholds on the same cohort.

## Reproducible commands

```bash
node scripts/edge-research.js
node scripts/live-fill-autopsy.js
```

`edge-research.js` is database-read-only and reproduces the cross-bot scoreboard, G pilot/eval separation, candidate screens, model calibration, George cohorts, settlement-sign analysis, and the current retained-tape flow check. `live-fill-autopsy.js` uses authenticated read methods only and reconciles accepted G orders to real exchange fills without printing keys, wallet addresses, order IDs, or trade IDs.

## Bottom line

The collector has found one credible place to keep testing: ETH-only G late-window continuation. It has a sensible market mechanism and survives real-fill reconciliation, unlike most of the system's apparent paper profits. It is not statistically confirmed after correcting for asset selection, and the broader G evaluation is flat-to-negative. The rational action is to freeze this exact hypothesis, test it for 500 fresh paper/shadow fills over at least 14 days, and simultaneously build honest execution measurement for MAIN. Everything else is currently noise, refuted, or too small to monetize.
