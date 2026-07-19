# BORG research platform v2 — event capture and latency experiments

Date: 2026-07-15. Status: implemented, paper-only, forward collection required.

## Outcome

BORG now captures the information needed to test sub-second hypotheses rather
than inferring them from one-second snapshots. This is an instrumentation
upgrade, not evidence that a profitable edge exists. The first valid
event-versus-sampled read is blocked by the pre-registered requirement of 300
independent signaled markets per H2/H3/H6 strategy arm and at least 14 calendar
days. No live-order call site was changed.

## Root causes corrected

The Polymarket adapter was not following the current market-channel protocol:

- It parsed `changes[]`; the current event is `price_changes[]`. Deltas could
  therefore be ignored even while the socket appeared healthy.
- It sent WebSocket control-frame pings every 25 seconds. The documented
  application protocol is text `PING` every 10 seconds with text `PONG`.
- It resent an initial `type: market` subscription when the desired asset set
  changed. It now uses initial subscription once, then documented dynamic
  `subscribe`/`unsubscribe` operations.
- Collector startup connected before market discovery, so the first token set
  could incorrectly be sent as a dynamic operation without any initial market
  subscription. The adapter now enforces the required initial message even
  when discovery follows socket connection.
- Its eager heartbeat could still make `PING` the first application message
  before that delayed subscription. The first frame is now always the market
  subscription; heartbeat starts only afterward.
- REST recovery was checked in a five-second loop. Healthy books are now driven
  entirely by events; REST is stale-book recovery plus one-token-at-a-time hash
  validation.

Each compact `borg_clob_touch` row now includes source time, receive monotonic
time, connection epoch, sequence, WAL event ID, book hash and the reconstructed
best bid/ask with displayed size. Full raw frames remain in WAL while
`borg_clob_events` holds prints, gaps and repairs. This separation keeps every
execution-relevant touch without flooding Postgres with deep-book JSON. Those
fields make 100–500 ms quote-survival replay possible on newly collected data.

The collector subscribes active token books continuously and warms the next
window during its final 20 seconds. This preserves boundary coverage across two
discovery cycles while avoiding double normal traffic and WAL volume for data
that no strategy can act on. A controlled BTC-pair socket received 57,507
messages / 39.1 MB over 90 seconds with 12/12 PONGs and no close. The seven-
market stream repeatedly closed abnormally, so active markets now share two
isolated sockets (configurable with `BORG_CLOB_SHARDS`) and record the shard in
WAL/Postgres. Seven concurrent sockets were rejected in a synchronized burst
and are not the default. After fixing first-message ordering, two shards passed
a 139-second local soak with zero closes and 37,013 touch changes. Forward gap
rate remains a graded input rather than being hidden by REST repair.

## Capture architecture

Every raw Binance, Coinbase, Polymarket CLOB and Polymarket RTDS frame is
synchronously appended before JSON parsing to a source/day-partitioned WAL.
Segments rotate at 64 MiB or 15 minutes, group-sync every 250 ms, gzip, verify
by SHA-256, and retain a 10 GiB disk reserve. `BORG_WAL_MIRROR_DIR` enables a
second atomic copy on an off-host mounted volume.

Before subscription-load reduction, observed raw CLOB ingress was roughly
8–9 GiB/day compressed. With only about 34 GiB free on this Mac and a mandatory
10 GiB reserve, off-host mirroring is operationally urgent; local capture alone
is not a durable long-horizon archive.

Recorded provenance includes raw payload, source timestamps in the payload,
local receive wall and monotonic clocks, connection epoch, event sequence, and
host/process event identity. Postgres is the queryable derived layer, not the
only copy. CLOB and RTDS failed batches are retained for retry.

The free Polymarket RTDS Chainlink topic is captured for BTC, ETH, SOL and XRP.
Every shadow decision records Chainlink value, Binance-minus-Chainlink signed
difference, absolute basis points and tick age. It is resolver-risk telemetry;
an RTDS tick is not asserted to be the final settlement observation.

## Paper cadence experiment

H2, H3 and H6 each have `__sampled` and `__event` arms. FNV-1a of strategy name
and `market_id` assigns a market to exactly one arm. Both arms use identical
economic rules and a 250 ms paper order latency. The sampled arm evaluates on
the one-second timer. The event arm evaluates after a maximum 25 ms per-asset
coalescing delay on Binance or CLOB events. Decision features preserve the
trigger source, source/receive clocks, epoch, sequence and actual decision
delay.

The frozen manifest is `borg/experiments/cadence-h2-h3-h6-v1.json`. Dashboard
progress is distinct signaled markets, not raw ticks or correlated orders.
These remain pilot rows; no arm is promoted or retuned from early results.

## Shared execution and replay

`borg/research/execution-kernel.js` is a pure, side-effect-free accounting
kernel used by paper scoring and latency replay. It parses Postgres DECIMAL
strings, caps fills at displayed touch capacity, rejects connection gaps,
assigns A/B/C/F fidelity grades and applies the same binary payout and fee
equations. It contains no order method. The isolated live executor was not
modified; integrating this kernel there would require separate authorization.

`scripts/borg-latency-replay.js` evaluates 100, 250, 500, 1,000 and 2,000 ms
order latency separately from recorded information cadence. It uses a
repeatable-read database snapshot and reports quote survival, 1x/2x fee PnL,
quality grades and market/day-clustered intervals.

The legacy-data run is diagnostic, not a result:

- All taker strategies: 4,068 intended signals, but only 476 (11.7%) were
  replayable and every replayable row was B-grade; there were zero A-grade
  event states. The 100/250/500 ms outputs were therefore identical, proving
  the old data cannot resolve those latency differences.
- At 100 ms, pooled 1x PnL was -$32.36 and 2x-fee PnL was -$84.18; the
  market-clustered mean interval crossed zero. At 1,000 ms, 1x PnL was
  -$103.56; at 2,000 ms it was -$187.31. Only one UTC day had replayable data,
  so no day-clustered inference is possible.
- Legacy H2 alone looks positive in its 88 replayable markets, but 254 of 342
  signals are F-grade, all replayable data are B-grade and from one UTC day,
  and 100/250/500 ms remain indistinguishable. It is selection-biased pilot
  evidence and cannot support a profitability or VPS claim.

## Local benchmark

The read-only benchmark is stored in
`borg/benchmarks/mac-guernsey-2026-07-15-final.json`.

- Neon database host: AWS `us-east-1`; RTT 137.7 ms median, 225.7 ms p95, with
  a 1,025 ms maximum in 20 reads.
- Polymarket CLOB `/time`: 45.4 ms median, 48.8 ms p95 (130.2 ms max).
- Polymarket CLOB WebSocket: 135.6 ms connection setup; event inter-arrival 23
  ms median and 214 ms p95. Absolute source freshness has ±500 ms uncertainty
  because the public time endpoint is one-second quantized.
- Binance aggTrade observed freshness was 136 ms median after midpoint clock
  correction, with roughly 126 ms clock-calibration uncertainty on this route.
- RTDS Chainlink source-to-receive delay was 1.38 seconds median and 1.87
  seconds p95, with ±500 ms source-clock uncertainty. That lag is a feature to
  test, not a low-latency execution signal.
- Signed order acknowledgement was not measured because no diagnostic live
  order was authorized. Public HTTP RTT is only a route proxy.

A Dublin VPS cannot be valued from this Mac run. Run the identical read-only
script on Dublin and us-east hosts. Dublin wins only if CLOB/feed freshness and
the end-to-end paper execution profile improve. The current us-east database
dependency remains expensive from Dublin and must stay off an execution hot
path.

## Immutable archive

`scripts/parquet-mirror.js` converts verified archive and WAL segments to
Parquet on a required `BORG_PARQUET_MIRROR_DIR`. It writes through a temporary
file, records source and Parquet SHA-256 hashes, and refuses to overwrite an
existing path whose source hash differs. The converter is verified by reading
the result back in tests. No off-host path is configured on this Mac, so local
WAL is active but off-host durability remains operationally pending.

## Paid-data decision rule

Free Binance streams and Polymarket CLOB/RTDS are the baseline. A paid source
must be a blinded, forward arm under identical strategy, information/order
latency, fee, fill and quality rules. Purchase is justified only if incremental
post-fee PnL has a positive market/day-clustered interval after at least 300
independent markets and exceeds subscription and deployment cost. Better
timestamps or a prettier backtest are insufficient.

## Next operational reads

1. Keep the collector supervised and verify A-grade CLOB replay coverage and
   WAL freshness daily.
2. Run `npm run benchmark:infra` on Dublin and us-east candidates with the same
   duration and clock treatment.
3. Run `npm run replay:latency` only on frozen database snapshots; report
   missing/F-grade rows rather than imputing fills.
4. Mount an off-host volume and configure `BORG_WAL_MIRROR_DIR` and
   `BORG_PARQUET_MIRROR_DIR`; verify checksums before calling it durable.
5. At 300 independent markets per arm and 14 days, compare event minus sampled
   PnL, fill rate and adverse selection by asset/day. Accept that measured edge
   may be zero.
