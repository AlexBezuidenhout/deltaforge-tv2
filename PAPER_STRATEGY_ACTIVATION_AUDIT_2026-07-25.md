# Paper strategy activation audit — 25 July 2026

Evidence snapshot: 25 July 2026, 16:27 UTC. Accounting uses only A/B-quality
tape-scored fills, actual executable asks, the existing non-fill/partial-fill
model and doubled transaction-cost PnL. The 99 inspected strategy/phase arms
are overlapping experiments, so their PnL must never be added together.
Family-wise Holm-adjusted p-values were 1.0 for every positive diagnostic.
Nothing in this audit is proof of profitability or permission for live orders.

## Activation decision

The following unchanged rules are activated under new `FWD_*` identities in
the frozen `promising-paper-forward-2026-07-25-v1` experiment. Every arm starts
from zero. Its historical source rows, PnL and governance status are excluded.
The six-hour read is an operational checkpoint only; the promotion requirement
remains at least 300 independent markets and 14 calendar days.

| Tier | Fresh paper strategy | Historical source | Markets | 2x-cost PnL | Half 1 / half 2 | Audit interpretation |
|---|---|---:|---:|---:|---:|---|
| A | `FWD_H24_hourly_flow_breakout_v1` | H24 | 66 | +$93.19 | +$33.30 / +$59.90 | Best diagnostic: positive leave-one-market/day/asset-out totals, but only three days and no untouched successor. |
| A | `FWD_H40_directional_entropy_breakout_v1` | H40 | 25 | +$45.24 | +$22.38 / +$22.86 | Internally balanced but far too small; prior governance records negative early observations. |
| A | `FWD_H44_hourly_midwindow_reversal_v1` | H44 | 29 | +$99.08 | +$8.64 / +$90.44 | Profit was dominated by one day and ETH; fresh replication is essential. |
| B | `FWD_H38_passive_flow_divergence_v1` | H38 | 46 | +$27.95 | +$30.63 / -$2.68 | Positive headline weakened out of sample and failed day concentration. |
| B | `FWD_H15_jump_adjusted_sigma_v1` | H15 | 96 | +$16.40 | +$20.35 / -$3.94 | Largest sample among positives, but the second half was negative. |
| C | `FWD_H45_threshold_distance_velocity_v1` | H45 | 8 | +$13.11 | -$4.20 / +$17.31 | Feature-level hypothesis with an extremely small sample. |
| C | `FWD_H46_range_boundary_migration_v1` | H46 | 2 | +$27.19 | +$11.34 / +$15.84 | Mechanistically plausible but two markets contain almost no statistical information. |
| C | `FWD_H20_cross_venue_basis_reversion_v1` | H20 | 12 | +$5.04 | +$28.68 / -$23.64 | Highly unstable sign; activated only to measure opportunity frequency prospectively. |
| C | `FWD_H7_btc_oracle_confirm_v1` | H7 | 1 | +$2.36 | $0.00 / +$2.36 | One fill is not evidence; starvation is an acceptable result. |
| C | `FWD_H1_pair_arb_2x_v1` | H1 | 3 | +$1.29 | +$0.23 / +$1.07 | Deterministic complement mechanism, but no repeatable fee-safe lock has yet appeared. |

`H43_resolution_boundary_buffer` remains active under its existing frozen
forward identity so its 300-market clock is not fractured. Its historical
diagnostic was +$13.35 at doubled cost over 24 markets, while the current clean
epoch was negative at the latest read. `ETH_G_late_exact_forward_v1` also
remains active as an already-frozen post-hoc replication; it has no eligible
fills yet.

## Explicit exclusions

| Strategy/family | Why it is not reactivated |
|---|---|
| H52 hourly V1 | Ninety-five of 105 original orders were accidentally routed to five-minute markets. The result does not test its stated hourly mechanism. |
| H52 15-minute V2 | Its pre-registered early-kill rule fired after more than 100 independent markets. Selecting only its positive A/B subset would violate the frozen protocol. |
| H53 exact five-minute successor | The exact forward successor lost materially at doubled costs, and its authenticated live pilot also lost money. |
| H41 cross-asset dispersion | The unchanged forward arm reversed the discovery result and was negative over 57 eligible markets. |
| MAIN V2–V4, G late, generic flow, generic maker and paired maker | Their forward evidence is negative or cost-fragile; opposite signals are not economically equivalent trades. |
| H45/H46 original IDs | Their old IDs remain feature-only governance records. Only the new zero-history aliases evaluate prospective actions. |

## Other potential research lanes

These continue in their dedicated paper/research processes and are not mixed
into the BORG PnL table:

- Certified payoff graph: active scanner; only deterministic payoff proofs
  with synchronized executable depth qualify.
- Rule-aware Polymarket/Kalshi convergence: active paper monitoring; similar
  wording remains risky statistical convergence unless terminal identity is
  certified.
- Resolver-source transfer: H43 and the dedicated Pyth collector are active.
- Deribit options-implied binary residual: exact-expiry surface collection and
  scoring remain active.
- All-market fair-bound passive making remains data collection only. No
  category-specific fair-value feed is configured, so enabling quote signals
  would reactivate a falsified generic maker rather than the proposed
  fair-bound strategy.

## Six-hour read

The six-hour checkpoint must report, per fresh identity:

1. evaluator heartbeat, evaluations, errors and market families observed;
2. intended orders, scored fills, pending outcomes and non-fill rate;
3. 1x and doubled-cost PnL using only A/B data/execution grades;
4. market, asset and UTC-day concentration;
5. feed gaps, persistence failures and scoring lag.

Zero orders is a valid finding for rare structural rules. Positive six-hour
PnL is not a promotion result. The experiment stays paper-only and has no
wallet, signer or order-posting path.
