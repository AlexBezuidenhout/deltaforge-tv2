# Research backlog implementation — 27 July 2026

## Scope and safety boundary

This change set implements four previously unbuilt paper-research lanes. It
does not add a wallet, signer, authenticated order channel or live-order call
site. Every new experiment is frozen under a new identifier and starts with no
inherited PnL:

- `crossvenue-exact-rule-convergence-v6`
- `structural-certified-payoff-graph-v5-orphan-reserve`
- `options-daily-threshold-surface-residual-v3`

The implementation freeze is `2026-07-27T13:05:00Z`. Earlier V5, V4 and V2
rows remain queryable but cannot contribute to these cohorts.

## 1. Exact-rule Polymarket/Kalshi convergence

Candidate discovery remains broad, but evidence is now fail-closed. A V6 pair
must have equal, complete values for:

- subject;
- predicate;
- comparator;
- strike;
- resolver;
- observation timestamp;
- timezone;
- fallback policy; and
- settlement precision.

Any conflict or missing dimension produces `hard_mismatch=true` and an
automatic veto. Text similarity and the old operator score cannot override the
veto. A complete exact key enters V6 without an unrelated title-score hurdle.

The forward protocol is frozen at five shares, a +1% executable net
liquidation target and a one-hour maximum hold. Its independent unit is the
first eligible entry for one match, direction and UTC day. The report does not
credit right-censored rows or rows without an executable timeout exit.

Run:

```bash
npm run research:crossvenue-exact -- --days=30
```

The report applies a second fee layer and one adverse tick per leg, reports
both chronological halves, and cannot pass before 300 fresh
match-direction-days and 30 calendar days.

### Current public-universe check

A full live discovery check on 27 July inspected 37,904 Polymarket records and
67,518 Kalshi market records. It produced 924 candidate overlaps, including 36
typed structured candidates, and zero complete exact-rule keys. The dominant
vetoes were resolver, fallback, observation-time, timezone and settlement-
precision differences or omissions. This is a valid zero-opportunity starting
state, not evidence of profitability or a reason to weaken the rule key.

## 2. Ordered-strike implication graph and orphan safety

The deterministic payoff compiler still enumerates terminal states for
ordered thresholds, disjoint ranges, complements and complete event sets.
The prior blanket `atomic === true` requirement has been replaced by an
explicit non-atomic reserve:

```text
orphan reserve = max(0, -worst executable proper-subset fill unwind PnL)

orphan-safe profit
  = displayed guaranteed profit after 2x fees
  - orphan reserve
```

A bundle qualifies only when the worst incomplete proper subset of filled legs
can be unwound through current displayed bid depth and orphan-safe profit remains above the frozen
capacity floor. The dashboard distinguishes raw economic leads from
orphan-safe qualified bundles.

The separate passive arm is deliberately limited to certified two-leg ordered
implications; complete multi-leg sets remain taker/FOK diagnostics until their
partial-batch state space is implemented. It joins one certified leg at the
best bid. Its fill model:

1. freezes the displayed queue ahead at placement;
2. gives no queue credit for cancellations;
3. consumes queue only with later public prints at or through the bid;
4. hedges every partial fill immediately through current ask depth;
5. charges 2x taker fees on hedge and unwind legs;
6. waives a passive fee only when venue metadata explicitly says the schedule
   is taker-only; and
7. immediately unwinds an unhedgeable passive fill when bid depth exists.

This arm is execution-fidelity C because public data cannot prove authenticated
queue position or cancel acknowledgement. Its output is a falsification lane,
not a certified lock.

## 3. Kalshi fees and capacity replay

Discovery now requests the current Kalshi series object for every monitored
series and persists:

- fee type;
- fee multiplier;
- source and observation time; and
- the complete normalized schedule.

Supported taker schedules use Kalshi's published quadratic formula, centicent
trade-fee rounding, and the conservative non-direct-member whole-cent balance
rounding. Entry debits and exit credits are rounded in the venue-documented
direction. Missing or unsupported schedules fail closed; they are not treated
as zero fees.

Every complete, non-vetoed V6 exact-rule pair emits explicit 5-, 10- and
25-share replay rows for both directions. A failed row remains in the tape with
a reason such as unknown fee, below venue minimum, insufficient entry depth or
missing exit depth. This prevents absent capacity from being mistaken for
unmeasured capacity.

References:

- Kalshi fee schedule:
  https://kalshi.com/docs/kalshi-fee-schedule.pdf
- Kalshi member-balance and per-order fee rounding:
  https://docs.kalshi.com/getting_started/fee_rounding
- Kalshi series fee metadata:
  https://docs.kalshi.com/api-reference/market/get-series
- Kalshi fixed-point order books:
  https://docs.kalshi.com/getting_started/orderbook_responses

## 4. Deribit daily-threshold reference surface

The option collector now admits resolver-certified BTC and ETH daily threshold
contracts when their target timestamp is either:

- exactly a listed Deribit expiry (fidelity A); or
- strictly bounded by listed lower and upper expiries (fidelity B).

Fidelity B interpolates total implied variance between the two listed terms.
Expiry extrapolation, DVOL substitution and missing bid/ask-IV bounds remain
forbidden. Marks now persist the surface mode, both expiry anchors, the
contemporaneous Polymarket midpoint and the option-surface residual.

The resolver certifier preserves the rule's actual Binance candle interval.
Current contracts name a Binance one-minute Close; older one-hour contracts
remain supported, but a one-minute contract is never rewritten as one hour.

A public Deribit/Gamma dry run on 27 July found:

- 1,496 listed option instruments;
- four relevant listed expiries inside the seven-day horizon;
- 130 Gamma events examined; and
- 44 resolver-certified daily threshold targets.

All 44 current targets were bounded term-interpolation targets. This proves the
lane has a live universe; it does not prove that its lower-bound residual
clears executable prices, fees, depth, hedge cost or residual risk.

References:

- Deribit order-book/IV fields:
  https://docs.deribit.com/api-reference/market-data/public-get_order_book
- Deribit instrument summaries:
  https://docs.deribit.com/api-reference/market-data/public-get_book_summary_by_instrument

## Dashboard and promotion interpretation

Book Lab now exposes:

- raw versus orphan-safe structural candidates;
- passive queue-paper fills, orphans and closed doubled-cost PnL;
- exact-rule versus hard-veto cross-venue counts;
- persisted Kalshi fee status; and
- 5/10/25-share capacity replay.

Runtime activity is not profitability evidence. None of the new lanes is
live-capital eligible. Promotion still requires the frozen independent-unit
minimum, both chronological halves positive, clustered lower confidence bounds
above zero, multiple-testing correction, realistic depth/non-fills, and
positive performance under the registered latency/cost stresses.
