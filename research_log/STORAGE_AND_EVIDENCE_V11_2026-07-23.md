# Storage and evidence v11 — 23 July 2026

## Incident

The v10 evidence run is invalid. The 125 GiB VPS reached the WAL safety reserve:
PostgreSQL occupied approximately 54 GiB, the append-before-process WAL
approximately 28 GiB, and database snapshots approximately 6 GiB. Core
collectors then repeatedly restarted after `WAL disk reserve breached`, which
created 8,798 abandoned collector runs, 9,139 error events and roughly 96,000
small sealed WAL files on 23 July. Fresh heartbeat timestamps from those
short-lived processes made the dashboard look healthier than the underlying
domain data. No v10 PnL or opportunity count is admissible as forward evidence.

The raw records were already gzip-compressed NDJSON, not uncompressed text.
The storage failure came from duplicate hot representations and unbounded SQL
heaps, not from choosing `.txt` instead of `.csv`. CSV would lose nested event
metadata and would not materially solve the problem. Immutable gzip WAL is the
recovery source; Parquet is the efficient columnar research copy; PostgreSQL is
only the bounded recent query tier.

## Remediation

1. Drain all cohort-producing processes before moving the evidence boundary.
2. Produce a stopped-state custom-format PostgreSQL dump, SHA-256 sidecar and
   successful `pg_restore --list` validation.
3. Copy sealed WAL, raw-row archives and the verified dump off-host through an
   APFS staging directory. Publish per-pull SHA-256 manifests plus separate raw
   and snapshot receipts back to the VPS.
4. Convert the eleven largest replayable append-only SQL projections to UTC-day
   partitions. The one-time destructive conversion requires the matching
   off-host snapshot receipt. Preserve rare positive structural, options and
   cross-venue rows in compact retained tables.
5. Retain the current UTC day for the highest-rate CLOB, external-book and
   cross-venue snapshot/opportunity tables, and the current plus previous UTC
   day for the other partitioned projections. A wider tier would consume the
   disk reserve at the measured v10 rate. Drop a complete partition only when
   its end is covered by a fresh off-host raw/WAL receipt.
6. Remove CLOB/book duplicate database archiving. Those frames were already
   durable in the append-before-process WAL; making another gzip copy consumed
   the reserve required to run the archiver.
7. Treat collector liveness as heartbeat freshness **and** same-epoch process
   identity, at least 60 seconds of process uptime, and fresh domain progress.
   A crash-loop heartbeat is now reported as degraded.

The partition set is:

- `borg_clob_touch`, `borg_clob_events`
- `borg_book_snaps`
- `borg_external_book_touch`, `borg_external_trades`
- `borg_structural_evaluations`
- `borg_deribit_option_touch`, `borg_option_shadow_marks`
- `cv_book_snapshots`, `cv_opportunities`, `cv_basis_samples`

No user settings, real/paper trades, positions, balances, resolutions,
experiment manifests, scored orders or authenticated execution records are
truncated by this migration.

## Research cohorts after recovery

- H43 remains exactly `research-h43-forward-v1`. Its mechanics, thresholds,
  sizing and eligibility logic are unchanged. It remains paper-only and below
  the 300-independent-market/14-day requirement.
- The structural scanner starts a new
  `structural-certified-payoff-graph-v4-capacity` cohort. Only deterministic
  panel capacity changes (48 candidates, 128 tokens, four CLOB shards).
  Payoff proof, rule certification, fee stress, depth, FOK feasibility,
  orphan-risk and economic thresholds are unchanged.
- The options lane starts
  `options-implied-binary-v2-resolver-exact-expiry`. It admits every strike in
  an event only when the Polymarket boundary exactly equals a listed Deribit
  expiry and the explicit Binance one-hour-close rule is certified. Unknown
  resolver rules fail closed; Chainlink is never silently substituted for a
  Binance-resolved contract.

Historical v1/v3 rows are not relabelled into either successor cohort.

## v11 acceptance

The v11 timestamp is the start of a candidate evidence period, not proof of
health or profit. For the first 24 hours, every required health sample must
pass:

- all required services remain up without an abandoned/failed collector run;
- source and local receive timestamps advance;
- sequence-gap, stale-frame and persistence-error counters stay at zero;
- the off-host receipt remains fresh;
- archive and partition heartbeats remain fresh;
- at least 30 GiB remains free;
- all-market, flow and cross-venue universes remain non-empty.

Any failed sample invalidates the uninterrupted run. Research promotion remains
separate: H43 requires at least 300 fresh independent markets and 14 days;
options requires 300 markets and 30 days. Positive results must survive 2x
costs, chronological halves, clustered confidence bounds, multiple-testing
correction and the 100/250/500 ms profiles. A measured edge near zero is an
acceptable conclusion.
