# Neglected-capacity edge programme

Evidence snapshot: 21 July 2026. All strategies described here remain paper or
shadow only. This document grants no live-order authority.

## Objective

TV2 should not try to out-predict professional makers in the most liquid BTC
five-minute book. It should search for small opportunities whose absolute
capacity, rule work, fragmented capital or operational overhead makes them
unattractive to a large desk.

Every candidate is evaluated on one equation:

```text
lower-bound payout
- executable principal
- 2x fee stress
- slippage / one-tick stress
- full failure-risk reserve
> 0
```

The output is conservative dollars at executable capacity, not a model
probability, midpoint edge or annualized return. Capital duration is reported
separately because a $2 profit that locks $100 for a month is not equivalent to
a $2 profit that releases capital in ten minutes.

Run the unified read-only report with:

```bash
npm run research:neglected-edge
```

## Research queue

### 1. Resolver-boundary transfer

Keep `H43_resolution_boundary_buffer` exactly unchanged. It is the only current
positive forward lead, but it is not validated. At 21 July 2026 16:29 UTC the
frozen forward cohort had 15 independent markets, ten simulated fills and
+$8.16 at 2x costs, while the separate arrival-book replay covered only four
of 36 total H43 signals at A/B quality. These counts will change as collection
continues. The next engineering task is evidence fidelity, not threshold
tuning: bind each decision to the causal source event and replay executable
depth at 100, 250 and 500 ms.

Chainlink, Pyth and any future CF-resolver arms remain separate trials. They may
share infrastructure but must not pool outcomes or inherit H43's result.

### 2. Certified payoff graph

Continue scanning nested thresholds, disjoint ranges, mutually exclusive sets
and complete event sets. AI may propose a relation, but only content-addressed
rules and deterministic finite-state payoff proof can certify it. Current
arithmetic residuals are not trades: no observed candidate passes rule proof,
executable depth and non-atomic orphan risk together.

Rank candidates by conservative dollars after the full orphan reserve. Do not
sum repeated book flickers. One certified relation/event is one independent
unit.

### 3. Rule-aware Polymarket/Kalshi

Maintain two products:

- Certified terminal identities can be called a payoff lock only after both
  legs fill and the worst-state payout is proved.
- Similar-contract convergence is statistical arbitrage. It retains resolver,
  basis, non-convergence and capital-duration risk.

The v5 collector has synchronized executable depth, fee and one-tick stress,
but currently has zero trade-eligible proved episodes. Keep right-censored
positions in the survival analysis; dropping pairs that never reconverge would
manufacture profitability.

### 4. Options-implied binary residual

Keep the Deribit strike/expiry surface lane running because its marginal data
cost is low. Score only exact expiries or bounded total-variance interpolation
with complete bid/ask IV envelopes. The lower-bound edge must also pay for the
perpetual hedge and residual scenario CVaR. There are currently no matching
active Polymarket threshold targets, so the collector is building an archive,
not producing trade evidence.

### 5. Fair-bound passive overlay

Generic passive making and complementary-token making remain negative
controls. Historical all-market maker fills lost at both five- and 30-second
executable marks; complete-set gains were overwhelmed by orphan liquidation.
Do not invert or cosmetically filter those strategies.

The only justified next maker experiment is
`borg/experiments/staged/fair-bound-passive-overlay-v1.json`: quote post-only
only when one of the four programmes above supplies an independently certified
lower fair-value bound. It remains staged until a new evidence epoch.

## Capture infrastructure

The next epoch can use `ALLMARKET_PANEL_MODE=neglected` with strategy signals
disabled. `neglected-capacity-panel-v1` selects a fixed PnL-independent panel
from four mechanism strata:

1. multi-contract event graphs;
2. reward-bearing books with no more than $100 minimum inventory;
3. obscure, low-activity contracts;
4. liquid controls.

Membership is written once to `am_panel_memberships` under the collection epoch
and a SHA-256 panel hash. A restart reloads the same cohort rather than selecting
new winners. Historical PnL and toxicity are not selection inputs.

Raw public CLOB events continue to land in the append-before-process WAL with
source time, local receive time, monotonic time, sequence, connection epoch and
collector epoch. PostgreSQL remains the recent hot/query tier; immutable raw
segments are compacted and copied off-host. WebSocket books remain the primary
feed, consistent with the [Polymarket order-book guidance](https://docs.polymarket.com/trading/orderbook).

The next epoch also activates a 24-hour normalized SQL tier for full-rate
external-book, external-trade and negative structural-evaluation rows. Their
immutable source/decision WAL remains authoritative; rare positive or qualified
structural cells remain in PostgreSQL. This prevents replayable normalized
duplicates from consuming the 100 GB capture disk. It is staged during v8 and
must not be deployed into that running cohort.

## Activation sequence

Do not alter the running `money-finding-2026-07-21-v8` epoch. v5 failed after
structural Gamma refresh timeouts, v6 failed archive preflight, and v7 failed a
single-attempt Flow REST timeout. None is promotion evidence. v8 started at
`2026-07-21T16:51:05.602Z` after bounded Gamma/Flow retry and
archive-before-writer startup were verified.

After it has at least 24 clean hours:

1. Run the evidence-epoch and platform acceptance reports.
2. Benchmark current CPU, memory, WAL growth and sequence gaps.
3. Create a new marked epoch; do not reuse the v8 timestamp.
4. Start the neglected panel at 20 markets for a one-hour capacity test, then
   increase to 40 and at most 60 only if no sequence, persistence or WAL faults
   appear. This is infrastructure sizing, not strategy tuning.
5. Keep `ALLMARKET_STRATEGY_SIGNALS_ENABLED=false` during the capture test.
6. Freeze and activate the fair-bound overlay only after its required source
   adapters and queue replay pass tests.
7. Restart the 24-hour clean-platform clock after any cohort or mechanism
   change.

## Promotion

No strategy receives live capital before at least 300 fresh independent
markets and its specified 14- or 30-day minimum, positive 2x-cost PnL in both
chronological halves, market/day clustered lower bounds above zero, Holm
correction, positive 100/250/500 ms results, realistic partial/non-fills and
positive shared-$500 capacity. A passing strategy starts with 50 authenticated
$1-$2 fills and is reconciled against paper before any scale increase.

The acceptable final finding is that every measured edge is approximately
zero. The programme exists to reject false positives cheaply, not to guarantee
a profitable strategy.
