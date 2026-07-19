# Lesson: hourly near-even favorites are the one soft cell (H52)

**Summary:** In direction_1h markets during the final 60–300s, the favorite
token quoted 0.50–0.60 at the executable ask won 27/40 independent markets
(+$0.110/share at 1×, +$0.093 at 2× fees); the identical direction_5m cell is
negative (n=1,698, −$0.034). Attention concentrates on 5m; hourly books go
stale near resolution. Frozen forward eval `research-h52-hourly-neareven-favorite-v1`
is running — treat as unproven until it passes.

**Actionable rule (frozen):** buy the higher-ask side once per market when its
ask ∈ [0.50, 0.60] and tte ∈ [60, 300]s on btc/eth/sol/xrp 1h markets; hold to
resolution; 20% displayed-touch participation.

**Reproduction:** one snapshot per resolved market from `borg_book_snaps`
(first with tte 60–300s) joined to `borg_markets` outcomes; favorite =
`greatest(up_best_ask, down_best_ask)`; EV = win − ask − 0.07·ask·(1−ask)·mult.
See QUANT_EDGE_REVIEW_2026-07-18_PM.md §1 for the full tables.

**Why it was missed:** every prior calibration scan filtered
`market_type='direction_5m'`. The 1h universe (~790 resolved markets) was
captured but never queried.
