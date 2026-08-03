# Frozen edge experiment slate

Frozen: 2026-08-03T14:20:00.000Z; manifest SHA-256: `674b25c62248960a7c0ea8b028d258da627dd51f52b9154a79940de24b87b2ba`.

This is the maximum ten-lane incubator. It contains deterministic scanners and collection lanes as well as statistical forward tests; it does **not** authorize ten trading bots. Only H43-X and the exact longshot successor currently emit paper intents. No lane authorizes authenticated or live orders.

| Rank | Lane | Mechanism | Mode | Current status | Primary metric |
| --- | --- | --- | --- | --- | --- |
| 1 | resolver-chainlink-tail-v1 | R01 | FROZEN_FORWARD_PAPER | ACTIVE_UNCHANGED | net_pnl_2x_clustered_by_market_day |
| 2 | structural-ordered-strike-v1 | S03 | DETERMINISTIC_CONTINUOUS_SCANNER | ACTIVE_NO_QUALIFYING_ECONOMICS | worst_state_profit_2x_after_orphan_reserve |
| 3 | structural-certified-graph-v5 | S01 | DETERMINISTIC_CONTINUOUS_SCANNER | ACTIVE_NO_QUALIFYING_ECONOMICS | worst_state_profit_after_2x_costs_and_orphan_reserve |
| 4 | crossvenue-certified-terminal-v1 | X01 | DETERMINISTIC_CONTINUOUS_SCANNER | ACTIVE_BLOCKED_NO_CERTIFIED_EQUAL_PAIR | worst_state_profit_2x_cost_orphan_stressed |
| 5 | crossvenue-exact-convergence-v7 | X03 | FROZEN_FORWARD_PAPER_WHEN_ELIGIBLE | ACTIVE_ZERO_ELIGIBLE_ENTRIES | net_convergence_pnl_2x_cost_one_tick |
| 6 | options-exact-expiry-v4 | O01 | COLLECT_ONLY_UNTIL_A_GRADE | ACTIVE_COLLECTOR_ZERO_EXECUTABLE_TARGETS | realized_pnl_after_2x_fees_depth_and_hedge_cost |
| 7 | resolver-timestamp-precision-v1 | R07 | CHEAP_FALSIFICATION_ONLY | FROZEN_NOT_STARTED | count_and_capacity_of_statewise_proved_precision_dislocations |
| 8 | semantic-condition-proposer-v1 | N09 | DISCOVERY_TOOL_NO_TRADING | FROZEN_BUILD_NEXT | verified_novel_relationships_per_100_reviewed_with_zero_false_proofs |
| 9 | fair-bound-passive-observation-v1 | M01 | OBSERVATION_ONLY | FROZEN_BUILD_AFTER_REPLAY | queue_stressed_5s_and_30s_markout_after_actual_fee_reward |
| 10 | main-longshot-successor-v1 | Q02 | FROZEN_FORWARD_PAPER_CONTROL | ACTIVE_UNCHANGED_LOW_PRIORITY | net_pnl_2x_clustered_by_market_day |

## Common promotion and rejection contract

- Minimum fresh independent units: 300.
- Minimum duration: 14 days for frequent crypto; 30 days for cross-venue/options/making.
- Positive doubled-cost P&L in both chronological halves; market/day-clustered lower confidence bound above zero; family-wise multiple-testing correction.
- Positive execution at 100/250/500 ms with realistic non-fills, partial fills, queue and depth.
- Shared finite bankroll replays at $500 and $1000; no dominant event, asset or day.
- Only after a separate approval: 50 authenticated $1–$2 fills, then reassess.

## 1. resolver-chainlink-tail-v1

Mechanism: R01 — H43-X Chainlink tail residual. Existing/new experiment identity: `h43x-chainlink-tail-residual-v1`.

Status: **ACTIVE_UNCHANGED**; mode: **FROZEN_FORWARD_PAPER**.

- Entry authority: paper intents only through the existing H43-X kernel
- Independent unit: one resolved market; minimum duration: 14 days.
- Prerequisite: Fresh Chainlink RTDS, certified resolver, frozen q99.5 artifact and executable book.
- Primary metric: net_pnl_2x_clustered_by_market_day
- Frozen kill/rejection rule: Do not tune. Reject at the registered read if either half is non-positive, clustered LCB is not above zero, or latency/capacity fails.
- Evidence note: Current positive result is tiny and not promotion evidence.

## 2. structural-ordered-strike-v1

Mechanism: S03 — Ordered-strike YES-low plus NO-high. Existing/new experiment identity: `structural-ordered-strike-orphan-safe-v1`.

Status: **ACTIVE_NO_QUALIFYING_ECONOMICS**; mode: **DETERMINISTIC_CONTINUOUS_SCANNER**.

- Entry authority: none until finite-state proof, walked depth and orphan reserve are all positive
- Independent unit: one certified strike relationship/event; minimum duration: 30 days.
- Prerequisite: Exact predicate/resolver/time/precision identity and all terminal states compiled.
- Primary metric: worst_state_profit_2x_after_orphan_reserve
- Frozen kill/rejection rule: A candidate with any negative terminal state, stale leg, insufficient depth or negative orphan-stressed economics is vetoed.
- Evidence note: A scanner may run continuously because it proves identities rather than mining outcome P&L.

## 3. structural-certified-graph-v5

Mechanism: S01 — Complete mutually-exclusive ask bundle. Existing/new experiment identity: `structural-certified-payoff-graph-v5-orphan-reserve`.

Status: **ACTIVE_NO_QUALIFYING_ECONOMICS**; mode: **DETERMINISTIC_CONTINUOUS_SCANNER**.

- Entry authority: none until statewise and executable proof
- Independent unit: one certified condition graph/event; minimum duration: 30 days.
- Prerequisite: Exhaustive state space, immutable rule hashes, current fees, synchronized depth.
- Primary metric: worst_state_profit_after_2x_costs_and_orphan_reserve
- Frozen kill/rejection rule: UNKNOWN rule state, uncovered payoff state or non-positive stressed capacity is an automatic veto.
- Evidence note: Arithmetic anomalies without executable economics count as zero opportunities.

## 4. crossvenue-certified-terminal-v1

Mechanism: X01 — Certified terminal complement lock. Existing/new experiment identity: `crossvenue-certified-terminal-lock-v5`.

Status: **ACTIVE_BLOCKED_NO_CERTIFIED_EQUAL_PAIR**; mode: **DETERMINISTIC_CONTINUOUS_SCANNER**.

- Entry authority: paper only after every identity dimension is CERTIFIED_EQUAL
- Independent unit: one certified pair-direction-day; minimum duration: 30 days.
- Prerequisite: Subject, predicate, comparator, strike, resolver, instant, timezone, precision and fallback all equal.
- Primary metric: worst_state_profit_2x_cost_orphan_stressed
- Frozen kill/rejection rule: CERTIFIED_DIFFERENT or UNKNOWN is a hard veto; no risk-free label without a terminal payoff proof.
- Evidence note: No cross-venue atomicity is assumed.

## 5. crossvenue-exact-convergence-v7

Mechanism: X03 — Typed near-identity convergence. Existing/new experiment identity: `crossvenue-exact-rule-convergence-v7`.

Status: **ACTIVE_ZERO_ELIGIBLE_ENTRIES**; mode: **FROZEN_FORWARD_PAPER_WHEN_ELIGIBLE**.

- Entry authority: five-share paper state machine only for fully certified pairs
- Independent unit: first eligible pair/direction/UTC day; minimum duration: 30 days.
- Prerequisite: Synchronized A/B books, per-market Kalshi fees and 5/10/25-share replays.
- Primary metric: net_convergence_pnl_2x_cost_one_tick
- Frozen kill/rejection rule: Do not broaden semantic matching to create trades. Reject if 300 clean pair-days fail post-four-fee P&L and mismatch stress.
- Evidence note: Convergence is risky statistical arbitrage, never automatically risk-free.

## 6. options-exact-expiry-v4

Mechanism: O01 — Exact-expiry digital probability interval. Existing/new experiment identity: `options-exact-expiry-residual-v4`.

Status: **ACTIVE_COLLECTOR_ZERO_EXECUTABLE_TARGETS**; mode: **COLLECT_ONLY_UNTIL_A_GRADE**.

- Entry authority: none for term interpolation; paper only after exact-expiry A-grade mapping
- Independent unit: one exact-expiry prediction market; minimum duration: 30 days.
- Prerequisite: Exact expiry/observation mapping, sequenced bid/ask IV and executable perpetual hedge.
- Primary metric: realized_pnl_after_2x_fees_depth_and_hedge_cost
- Frozen kill/rejection rule: DVOL or unsupported interpolation remains diagnostic and cannot count as a trade.
- Evidence note: The current zero-entry result is the honest result, not a collector failure.

## 7. resolver-timestamp-precision-v1

Mechanism: R07 — Timestamp precision mismatch. Existing/new experiment identity: `resolver-timestamp-precision-audit-v1`.

Status: **FROZEN_NOT_STARTED**; mode: **CHEAP_FALSIFICATION_ONLY**.

- Entry authority: none; audit/scanner output only
- Independent unit: one unique rule/cutoff/source combination; minimum duration: 30 days.
- Prerequisite: Machine-readable cutoff inclusivity, source timestamp precision and terminal tick provenance.
- Primary metric: count_and_capacity_of_statewise_proved_precision_dislocations
- Frozen kill/rejection rule: Reject if rules are ambiguous or no positive doubled-cost statewise proof exists in a bounded 30-day scan.
- Evidence note: This is selected for cheap falsification, not because it has observed P&L.

## 8. semantic-condition-proposer-v1

Mechanism: N09 — AI relationship proposal plus deterministic proof. Existing/new experiment identity: `semantic-condition-graph-proposer-v1`.

Status: **FROZEN_BUILD_NEXT**; mode: **DISCOVERY_TOOL_NO_TRADING**.

- Entry authority: none; AI can propose but never certify or trade
- Independent unit: one proposed relationship before deterministic verification; minimum duration: 30 days.
- Prerequisite: Immutable source rules and deterministic finite-state verifier.
- Primary metric: verified_novel_relationships_per_100_reviewed_with_zero_false_proofs
- Frozen kill/rejection rule: Any unverified AI relation is discarded; measured value is verifier-approved coverage, not model confidence.
- Evidence note: This expands neglected-contract coverage without weakening proof standards.

## 9. fair-bound-passive-observation-v1

Mechanism: M01 — Fair-bound one-sided passive making. Existing/new experiment identity: `fair-bound-one-sided-passive-observation-v1`.

Status: **FROZEN_BUILD_AFTER_REPLAY**; mode: **OBSERVATION_ONLY**.

- Entry authority: none until public replay passes; later paper quotes still receive zero queue credit by default
- Independent unit: one flat-to-flat quote episode/market session; minimum duration: 30 days.
- Prerequisite: Independent fair interval, queue-ahead, partial-fill and cancel-ack model.
- Primary metric: queue_stressed_5s_and_30s_markout_after_actual_fee_reward
- Frozen kill/rejection rule: Reject if lower-bound spread/reward does not exceed adverse markout at 100/250/500 ms.
- Evidence note: Generic public-flow and symmetric maker results remain negative controls.

## 10. main-longshot-successor-v1

Mechanism: Q02 — Exact 0–20¢ longshot successor. Existing/new experiment identity: `main-longshot-0-20-v1`.

Status: **ACTIVE_UNCHANGED_LOW_PRIORITY**; mode: **FROZEN_FORWARD_PAPER_CONTROL**.

- Entry authority: paper intents only through the exact first-intent wrapper
- Independent unit: one resolved market; minimum duration: 14 days.
- Prerequisite: Unchanged source intent and executable price in the frozen 1–20¢ interval.
- Primary metric: net_pnl_2x_clustered_by_market_day
- Frozen kill/rejection rule: No price-band retuning. Evaluate only at 300 markets/14 days with family-wise correction across every inspected MAIN band.
- Evidence note: Fresh evidence currently starts with a loss; discovery profit is excluded.

