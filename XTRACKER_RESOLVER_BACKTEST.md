# XTracker resolver-count barrier — historical falsification

Generated: 2026-08-05T14:57:30.845Z. Evidence grade: **DISCOVERY_C_NO_EXECUTABLE_DEPTH**.

This is a discovery screen, not a live-PnL claim. It aligns XTracker's historical import timestamp with Polymarket's public one-minute token price series. That price series has no contemporaneous executable ask or depth.

## Coverage

- Completed tracking windows fetched: 36
- Rule-certified tracking windows: 36
- Historical posts fetched: 2807
- Irreversible boundary/token candidates: 221
- XTracker import lag: p50 160.8s; p95 57575.5s

## Discovery PnL proxy

| Simulated information latency | Episodes with a price point | Tracking windows | Positive after stress | Sum of positive stressed opportunities | Sum of residuals across all observations (diagnostic) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 100 ms | 210 | 34 | 1 | $0.13 | -$20.96 |
| 250 ms | 210 | 34 | 1 | $0.13 | -$20.96 |
| 500 ms | 210 | 34 | 1 | $0.13 | -$20.96 |

The strategy would skip non-positive observations; the final column is therefore a market-efficiency diagnostic, not traded PnL. The stressed proxy includes doubled fees, one tick and a 1.0¢ per-share resolver/fallback reserve. It still omits historical spread and depth, so even the positive-opportunity sum only justifies fresh L2 paper collection.

## Hard limitations

- Historical price points are not executable asks.
- Historical depth, queue, partial-fill and non-fill state are absent.
- Tracking windows overlap, so range episodes are not independent observations.
- This mechanism was selected before this PnL run, but every historical row remains discovery-only.
- Only the fresh forward L2 collector can create promotion evidence.
