# G_late_arb profitability audit

Cutoff: 2026-07-14 15:44 UTC. All figures are read-only calculations from the
current Postgres data and exchange trade history. No live-order path or strategy
threshold was changed during this audit.

## Executive verdict

`G_late_arb` is **not ready for real-money trading**. Its original CONFIRM was
valid for the historical pilot that selected/froze the strategy, but that result
did not persist in the frozen forward evaluation. The current all-core evaluation
has negative expectancy and an interval spanning material loss and profit. The
actual exchange-fill record is also negative. Keeping the executor in paper
dry-run is the correct decision.

There is one plausible descendant hypothesis: ETH-only late-window continuation.
ETH is positive in both the shadow evaluation and the actual exchange fills, but
it was selected after comparing assets and its six-asset-adjusted interval still
includes zero. It is therefore a fresh hypothesis, not permission to switch G to
ETH and declare success. The separately named `ETH_late_taker` and
`ETH_late_maker` forward arms are already the correct test.

## Phase separation: the apparent profit was misleading

| Cohort | Core fills | P&L at stored 1x costs | Mean/fill | Bootstrap interval | 2x-cost P&L |
|---|---:|---:|---:|---:|---:|
| Pilot / development | 310 | +$254.99 | +$0.823 | 95%: +$0.390 to +$1.234 | +$199.85 |
| Frozen evaluation | 227 | **-$34.31** | **-$0.151** | 95%: -$0.736 to +$0.409 | **-$72.91** |
| Frozen evaluation, adjusted for six asset looks | 227 | -$34.31 | -$0.151 | 99.17%: -$0.949 to +$0.589 | -$72.91 |

The old `g-verdict.js` and dashboard pooled these phases. That converted a
profitable development period followed by a losing evaluation into a lifetime
headline of roughly +$217. Pooling is invalid under `borg/EVAL_PROTOCOL.md` and
is the main reason G looked safer than it was.

The frozen evaluation began on 2026-07-13 at 21:18 UTC. It has neither 500 fresh
core fills nor 14 calendar days, and it currently fails the economic direction
of the pass criteria. More time could change the estimate, but the present data
does not support live deployment.

## Actual exchange-fill reconciliation

`node scripts/live-fill-autopsy.js` reconciles accepted G order IDs against
Polymarket's actual trade history and charges the crypto taker fee curve.

| Actual-fill view | n | Win rate | Net P&L | Mean/fill | 95% CI | Max drawdown |
|---|---:|---:|---:|---:|---:|---:|
| All exchange fills | 165 | 79.4% | **-$38.53** | **-$0.234** | -$1.015 to +$0.520 | -$54.17 |
| Frozen-eval core only | 122 | 79.5% | **-$18.89** | **-$0.155** | -$1.082 to +$0.723 | -$46.48 |

The user's roughly $60 wallet loss is directionally consistent with the audit.
It should not be forced to equal the CLOB-trade result exactly: the wallet
baseline can include a different start time, other account activity, open
positions, and redemption lag. The exchange-order reconciliation is the cleaner
strategy-level measure.

### Winner censoring and rested-order adverse selection

- 194 orders were accepted by the CLOB, but only 165 had an exchange fill.
- All 29 unfilled orders would eventually have won. They were not executable at
  the submitted limits, so shadow's assumed-at-ask fills overstate reachability.
- Among frozen-eval fills, delayed/resting maker-role fills were especially toxic
  outside ETH. BNB maker-role fills lost $30.33 and BTC maker-role fills lost
  $7.95. The order is filling after the market has moved against the signal.
- The 3-cent chase generation did not repair this in its first tiny sample:
  17 actual fills lost $30.97, versus 148 older/capped fills losing $7.57.
  This is diagnostic and too small/post-hoc to become a new threshold, but it
  certainly does not justify live reactivation.

Execution is not the only problem. The frozen shadow cohort itself is negative,
and the same matched order IDs had -$71.15 of shadow P&L versus -$38.53 actual.
In this period the signal/regime failed even before blaming live slippage.

## Root causes and risks

1. **Pilot/evaluation pooling.** Development profit was displayed as if it were
   current out-of-sample evidence. The dashboard and verdict tool are corrected
   to show the frozen eval separately.
2. **Regime decay.** Pilot mean was +$0.823/fill; frozen-eval mean is -$0.151.
   The mechanism is not stable across the two adjacent periods.
3. **Accepted is not filled.** `gla_live_orders.status='PLACED'` means the venue
   accepted a GTC order, not that it filled. Any live P&L or loss breaker based
   only on those rows can be wrong unless reconciled to exchange trades, partial
   fills, actual prices, and fees.
4. **Resting GTC selection.** A marketable limit that misses the touch can rest
   and fill later precisely when the signal has weakened. Immediate execution
   and resting execution are different strategies and must be evaluated as
   separate arms.
5. **Population mismatch.** Historical live trading included HYPE even though
   the original verdict excluded it. The executor now skips HYPE, but those old
   losses remain part of the live autopsy.
6. **Very low capacity.** The frozen pilot already showed negative marginal P&L
   from 1x to 2x. Increasing the $10 G stake is not justified.
7. **Re-confirmation is a safety gate, not alpha.** The current post-anchor
   qualifying sample is 26 fills, -$28.33 (-$1.089/fill), so the gate is closed.
   A trailing-performance gate was previously found to have no predictive value;
   no gate should be described as creating edge.

## Changes made by this audit

- The TV2 G card now shows only frozen-evaluation core fills and P&L. Pilot and
  HYPE rows are excluded from the current result.
- G progress now uses the full evaluation protocol: 500 fresh fills plus 14 days
  and a positive interval, rather than continuing to advertise the old n=300
  pilot CONFIRM.
- `scripts/g-verdict.js` now reports the historical pilot freeze and current
  frozen evaluation separately. Its stamp remains tied to the historical frozen
  pilot rule.
- `scripts/live-fill-autopsy.js` now reports actual-vs-shadow P&L, unfilled
  counterfactuals, execution generation, and the current eval-core subset.
- The real-money executor remains disabled; its process is paper dry-run only.

## Can this strategy family be made profitable?

There is no honest evidence-backed parameter edit that makes the all-asset G bot
profitable now. Changing asset, TTE, ask, edge, or chase thresholds on these same
losses would be retrospective fitting and would reset the experiment.

The justified path is:

1. Keep all-asset G as a paper measurement/control process. Do not reactivate it
   from the old pilot stamp or from a short hot streak.
2. Continue the separately named ETH taker/maker split at $3 per trade. It starts
   from zero evidence under those names and uses stable market assignment, so the
   comparison is not cherry-picked after fills.
3. Before any future live test, make actual exchange fills—not accepted order
   rows—the source of truth for P&L and the daily-loss breaker. Test immediate
   FAK/IOC-style execution and resting execution as separate forward arms.
4. Never increase size. The strategy's measured capacity is already below 2x.
5. Require at least 500 fresh fills and 14 days per ETH arm, positive P&L at 2x
   costs, a bootstrap interval above zero (including the multiple-testing-adjusted
   interval), both chronological halves positive, and an acceptable live/shadow
   execution gap before discussing capital.

## Forward projection scenarios for the ETH hypothesis

These are arithmetic scenarios from the guarded historical replay at a $3 stake,
not forecasts. Per 100 future fills: zero true edge gives $0; 50% persistence of
the observed guarded expectancy gives about +$15; full persistence gives about
+$30. The downside scenario—including measured edge being exactly zero or
negative—must remain the base case until the new ETH arms earn their own sample.

Reproduce the current reads with:

```bash
node scripts/g-verdict.js
node scripts/live-fill-autopsy.js
node scripts/edge-research.js
```
