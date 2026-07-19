# Local research hot tier and structural forward tests

## Production state

On 2026-07-16 TV2, DF2, BORG, Flow Lab and the dry-run G-late process moved
from the US-east Neon database to PostgreSQL 18 on the Dublin VPS. The final
consistent Neon dump began at `2026-07-16T13:08:10.944Z`; the first healthy
local collector run began at `2026-07-16T13:30:02.126Z`. That interval is an
explicit collection gap, not continuous evidence. New events carry collection
epoch `dublin-local-pg-2026-07-16-v1` and a new collector run ID.

Measured on the same VPS, database query RTT changed from 77.729 ms median /
86.327 ms p95 to 1.801 ms median / 9.492 ms p95. Three serial database round
trips therefore save about 228 ms. This does not make the venue path 2 ms: the
same read-only benchmark measured Polymarket CLOB HTTP near 20 ms.

## Data path

1. Market adapters append source frames to the synchronous local event WAL
   before parsing or mutating in-memory state.
2. Signal, order-intent and risk state stay in process memory. BORG appends a
   canonical `OrderIntent` to `strategy-decisions` WAL before adding it to the
   asynchronous PostgreSQL batch.
3. PostgreSQL on `127.0.0.1` is the dashboard, scoring and recent-query hot
   tier. Raw queryable tables retain 24 hours by default.
4. Before raw SQL rows are pruned they are written to checksum-verified,
   immutable gzip NDJSON. Sealed WAL/archive files are also compacted to
   immutable Parquet.
5. A daily custom-format PostgreSQL snapshot is list-verified before publish.
6. The Mac launch agent copies WAL, archives, Parquet and database snapshots to
   iCloud with append-only `rsync --ignore-existing` and no delete propagation.
7. VPS sealed files may be removed after two days only when a successful
   off-host receipt is less than three hours old. Missing/stale receipts fail
   closed.

`OFFHOST_DATABASE_URL` retains the pre-cutover Neon endpoint as an off-host
reference. It is not on the decision path and is not currently an asynchronous
row replica. A future London Neon project can replace that endpoint, but the
raw immutable archive already leaves the VPS independently.

The live order call sites were not modified. The safety constraint forbids
changing them, and all runtime controls remain paper: `paper_trading=true`,
legacy MAIN execution disabled in paper mode, G-late dry-run only, and the
structural scanner has no wallet/signing/order dependency.

## Frozen T-240 forward arm

`T240_four_state_residual_v1` is a paper-only, sampled arm matching the
discovery observation cadence:

- one causal observation per five-minute market near T-240;
- frozen 60-second CEX direction × market-side-of-0.5 state model;
- frozen coefficients in `borg/experiments/t240-four-state-residual-v1.json`;
- exact displayed ask, 2× crypto taker fees and a $0.01/share edge buffer;
- at most $10 and 20% of displayed touch depth;
- all seven declared assets; asset is reporting-only, not a selection filter;
- at least 300 fresh independent markets and 14 calendar days;
- positive 2×-fee PnL in both chronological halves and market-clustered lower
  confidence bound above zero, with Holm selection correction.

The updated discovery read had 64 trades, only +$1.47 at 2× fees, a negative
second half and a confidence interval spanning zero. All 64 are excluded. The
arm is a test of an unproven hypothesis, not evidence of current alpha.

## Structural condition graph

The paper-only scanner builds 3,382 current payoff identities from explicit
Gamma event structure at the initial post-cutover read: binary complements,
nested thresholds, disjoint ranges and explicit `negRisk` mutually-exclusive
sets. The bounded 16-identity/48-token live panel is deterministically
stratified across all four families and consumes event-driven CLOB books rather
than one-second REST polling. The cap follows a measured storage-rate check; it
is an infrastructure bound, not a performance-selected market filter.

Every evaluation records separate results for stale legs, valid quotes, 2×
fees, $10 per-leg FOK depth, displayed capacity and orphan-leg risk. A bundle
can be economically positive while remaining `qualified=false` because
cross-market orders are not atomic. Raw CLOB WAL permits later replay; negative
SQL controls are sampled every five seconds to avoid multiplying every book
frame by every graph edge.

## Operations

```bash
ssh deltaforge-vps 'systemctl --failed --no-pager'
ssh deltaforge-vps 'systemctl status postgresql borg-collector borg-structural-scanner'
ssh deltaforge-vps 'cd /opt/deltaforge/tv2/current && npm run audit:runtime'
ssh deltaforge-vps 'systemctl list-timers borg-score.timer deltaforge-db-snapshot.timer deltaforge-parquet.timer deltaforge-hot-retention.timer'
```

The dashboards remain loopback-only on the VPS and are reached through the Mac
SSH tunnel at `http://localhost:3004/` and `http://localhost:3005/`.
