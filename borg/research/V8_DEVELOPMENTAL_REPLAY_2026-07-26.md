# V8 developmental replay — 26 July 2026

This is a discovery-only engineering check, not forward evidence and not a
promotion result. It uses rows that existed while H64–H73 were being designed.
The frozen paper cohort starts at `2026-07-26T15:00:00.000Z` with every
strategy at zero.

## Replay contract

- Generated: `2026-07-26T13:26:11.007Z`
- Source: 782,615 normalized sampled book rows across 2,912 markets
- Tape span: `2026-07-25T00:00:00.412Z` through
  `2026-07-26T13:24:55.335Z`
- Fill model: 1.25-second order arrival; first recorded quote no more than two
  seconds later; limit-price survival; displayed touch depth; no fill otherwise
- Structural bundles: all equal-share legs must fill completely
- Fee stress: twice the crypto taker curve on entry

| Strategy | Intended units | Filled units | Fill rate | 2x-cost PnL | First half | Second half |
|---|---:|---:|---:|---:|---:|---:|
| `H66_range_threshold_partition_lock` | 0 | 0 | — | $0.00 | $0.00 | $0.00 |
| `H69_quarticity_confidence_envelope` | 676 | 498 | 73.7% | -$260.35 | -$105.37 | -$154.99 |
| `H70_stationary_block_bootstrap_digital` | 239 | 177 | 74.1% | -$143.52 | -$88.14 | -$55.38 |
| `H71_token_elasticity_residual` | 1,188 | 670 | 56.4% | -$498.47 | -$131.99 | -$366.48 |
| `H72_crosshorizon_nested_lock` | 1 | 0 | 0.0% | $0.00 | $0.00 | $0.00 |
| `H73_market_prior_calibration_residual` | 36 | 14 | 38.9% | -$8.18 | -$2.97 | -$5.20 |

## Interpretation

H69, H70, H71 and H73 are negative on this development tape in both
chronological halves where the sample is material. That is evidence against
the present specifications, not permission to alter thresholds after seeing
PnL. They remain unchanged in the forward cohort so the prospective result is
not contaminated.

H66 did not find a three-market partition that cleared executable asks and
doubled costs. H72 found one intended relationship but could not fill both
non-atomic legs under the replay contract. Neither is evidence of a realizable
lock.

H64 and H65 require synchronized per-source ages and sequence state. H67 and
H68 require event-level queue transitions. The sampled SQL projection cannot
reconstruct those facts, so the replay explicitly leaves them unsupported
instead of manufacturing historical fills. Their first valid result must come
from forward collection or a later raw-WAL replay.

At deployment checkpoint `2026-07-26T13:26:25.671Z`, all ten strategies were
registered and actively evaluated in the paper-only collector. The collector
had no signer, wallet or live-order path. No strategy had a forward order or
fill before the frozen evidence start.
