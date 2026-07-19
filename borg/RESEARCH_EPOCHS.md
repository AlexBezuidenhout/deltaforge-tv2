# Research collection epochs

## Dublin VPS epoch 1

- Epoch ID: `dublin-vps-2026-07-15-v1`
- Boundary: `2026-07-15T22:26:55.888Z`
- Location: Dublin VPS
- Research bankroll convention: $500 starting notional, $10 target stake
- Mode: paper/shadow only
- Raw contract: `borg-event-wal-v2`

This boundary separates the Mac/Guernsey cohort from continuously supervised
Dublin capture. Historical rows are never deleted or relabelled. Database
research can classify every observation by timestamp against the immutable
epoch boundary; raw WAL events and shadow decisions created by the v2 runtime
also carry `collection_epoch_id` and `collector_run_id` directly.

Paper balance, daily-loss and drawdown cutoffs are disabled for research. The
ledger can become negative and position sizing continues from the frozen $500
research notional. This avoids survivorship bias from stopping a bad strategy
early. It does not remove execution-validity controls: one open position per
market, duplicate prevention, stale-feed pauses, displayed-liquidity limits,
fees, latency and non-fill logic remain. Live-mode risk controls are unchanged.

## Measured Mac versus Dublin difference

The comparison uses the same read-only benchmark on both hosts. Lower is
better. No signed order was sent, so these numbers are not order acknowledgments.

| Metric | Mac / Guernsey | Dublin VPS | Change |
|---|---:|---:|---:|
| Neon DB RTT p50 | 137.727 ms | 76.890 ms | 44.2% lower |
| Neon DB RTT p95 | 225.718 ms | 78.002 ms | 65.4% lower |
| Polymarket CLOB HTTP p50 | 45.418 ms | 20.069 ms | 55.8% lower |
| Polymarket CLOB HTTP p95 | 48.803 ms | 20.986 ms | 57.0% lower |
| Polymarket WebSocket connect | 135.555 ms | 46.939 ms | 65.4% lower |
| Binance event freshness p50 | 136.0 ms | 134.5 ms | 1.1% lower |
| Binance event freshness p95 | 169.0 ms | 135.5 ms | 19.8% lower |
| Chainlink RTDS freshness p50 | 1380 ms | 1384 ms | 0.3% higher |
| Chainlink RTDS freshness p95 | 1865 ms | 1689 ms | 9.4% lower |
| Polymarket source freshness p95 | 57 ms | 14 ms | 75.4% lower* |

`*` The Polymarket source clock is quantized to one second and the Dublin sample
was only 14 events, so this last percentage is directional rather than a precise
latency estimate. The robust result is the roughly 56–57% improvement in the
CLOB HTTP path and the substantially tighter database tail. The VPS is not
actually “sub-2 ms” end-to-end: measured CLOB HTTP p50 is about 20 ms and Neon
DB p50 is about 77 ms.

## Capture contract for forward backtesting

The platform now preserves:

- full Polymarket CLOB events and depth, plus periodic execution snapshots;
- Binance aggregate trades, BBO and depth-10 at 100 ms for all configured assets;
- Coinbase 50 ms level-2 book changes, BBO capacity and public trade tape;
- Hyperliquid BBO capacity, public trades and all-mids for all configured assets;
- Polymarket RTDS Chainlink and separately transported Binance resolver topics;
- source time, local receive wall time, monotonic time, sequence, connection
  epoch, WAL event ID, collection epoch and collector run provenance;
- market discovery, outcome labels, resolution timing, order intents, queue
  ahead, fee model, latency profile and tape-scored fills;
- one runtime row per registered strategy, including quiet evaluations, halt
  observations, actions and exceptions.

This is sufficient for event-driven Polymarket research and small-stake
cross-venue lead/confirmation tests. Cross-network trading remains explicitly
non-atomic: a result is not executable arbitrage until both legs are replayed
with venue-specific fees, capacity, clock uncertainty and order acknowledgement.
