# Priority research lanes

This is the active money-finding programme. It separates four forward paper
experiments from one capture-only prerequisite. None of these processes has a
wallet, signer or live-order path.

| Priority | Programme | Runtime contract | Frozen experiment | Promotion unit |
|---:|---|---|---|---|
| 1 | Resolver-boundary transfer | H43 runs unchanged inside the BORG shadow engine | `research-h43-forward-v1` | first order per independent market |
| 2 | Certified payoff graph | deterministic rule snapshots, finite-state payoff proof, synchronized executable depth, full orphan reserve and a queue-aware passive arm | `structural-certified-payoff-graph-v5-orphan-reserve` | certified event/candidate |
| 3 | Rule-aware Polymarket/Kalshi | complete exact-rule keys only; any missing/conflicting rule dimension is a hard veto | `crossvenue-exact-rule-convergence-v6` | first pair/direction/UTC day |
| 4 | Deribit options-implied residual | exact-expiry or bounded total-variance surfaces only; unsupported extrapolation fails closed | `options-daily-threshold-surface-residual-v3` | first market/side observation |
| 5 | Fair-bound passive making | **capture only** on a frozen, PnL-independent neglected-market panel; quote signals are disabled | `fair-bound-passive-overlay-v1` (staged) | no evidence until a certified bound exists |

## Runtime boundary

`borg-allmarket.service` captures 20 category-balanced neglected markets under
`neglected-capacity-panel-v1`. Membership is frozen by collection epoch and is
selected without historical PnL, win rate or toxicity. It records public CLOB
events and prints for later queue replay. `ALLMARKET_STRATEGY_SIGNALS_ENABLED`
remains `false`: the negative generic-maker and paired-complete-set controls are
not restarted, and no fair-bound quote is manufactured from midpoint,
imbalance, last trade or reward estimates.

The fair-bound arm may become active only after an independently certified A/B
lower bound maps to a current Polymarket token. Its registered benchmark is:

```text
fair lower bound
- non-crossing executable quote
- 2x current fees
- one adverse unwind tick
- back-of-queue/partial-fill cost
- full failure-risk reserve
> 0
```

## Evidence standard

Every lane remains provisional until its manifest's independent-unit and day
minimums are met. The common promotion floor is at least 300 fresh independent
units, both chronological halves positive at 2x costs, clustered lower bounds
above zero, Holm correction, realistic depth/non-fills, and positive results at
100/250/500 ms using a shared $500 bankroll. A zero-candidate or zero-edge
result is valid and must not trigger threshold tuning on the same cohort.

The dashboard exposes the current five-lane state at
`/api/borg/research/priority-lanes` and in Book Lab. The command-line equivalent
is `npm run research:priority-lanes`.

Cross-venue V6 uses exactly five shares, a provisional +1% executable
liquidation target and a one-hour maximum hold. It also records explicit
5/10/25-share capacity failures and the observed Kalshi series fee schedule.
Run its forward read with `npm run research:crossvenue-exact -- --days=30`.

The structural passive arm is intentionally C-grade: public prints consume a
frozen queue-ahead and each partial fill is hedged at current asks, but public
data cannot prove authenticated queue position or cancel acknowledgement.

## Current evidence epoch

The authoritative cohort is `money-finding-2026-07-21-v10`, started at
`2026-07-21T22:25:22.489Z`. v8 is rejected because overlapping options SQL
flushes deadlocked; v9 is rejected because its first heartbeat contract omitted
the new persistence-error counter. Neither interval is relabelled. v10 started
with zero critical conditions, and a forced hot-tier maintenance overlap passed
without a deadlock or dropped observation. It remains provisional until the
24-hour clean-infrastructure gate and each strategy's own sample rules pass.
