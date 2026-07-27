# Dublin VPS operations

The VPS is the hot event-capture and paper/shadow execution host. It is not a
live-trading authorization boundary: database paper flags and the existing
application live locks remain authoritative.

## Runtime layout

- `/opt/deltaforge/tv2/current` — TV2 application and BORG research code
- `/opt/deltaforge/df2/current` — isolated DF2 application
- `/etc/deltaforge/*.env` — mode `0640`, not stored in Git
- `/var/lib/deltaforge/wal/borg` — append-before-process event WAL
- `/var/lib/deltaforge/archive/borg-raw` — immutable archive for raw rows that
  are not already represented in the append-before-process WAL
- `/var/lib/deltaforge/parquet` — short-lived local Parquet build tier; the
  permanent copy is off-host
- `/var/lib/deltaforge/db-snapshots` — temporary verified daily PostgreSQL
  recovery dumps, removed locally only after an independent off-host receipt

PostgreSQL 18 runs on loopback and is the hot dashboard/scoring database. The
former US-east Neon URL is retained only as `OFFHOST_DATABASE_URL`; it is not
on a decision or order path. The measured median query RTT fell from 77.729 ms
to 1.801 ms at the 2026-07-16 cutover.

The first Dublin cohort is permanently registered as
`dublin-vps-2026-07-15-v1`, starting at `2026-07-15T22:26:55.888Z`. Raw WAL
v2 records and shadow decisions carry both the collection epoch and collector
run IDs. `borg_collection_epochs` is insert-only by application convention;
restarts create new `borg_collector_runs` without moving the cohort boundary.
The local-database cohort is `dublin-local-pg-2026-07-16-v1`. The consistent
dump pause (`13:08:10.944Z` to the first healthy run at `13:30:02.126Z`) is an
explicit data gap.

Only SSH is exposed by the firewall. Dashboards use local forwarding:

```bash
ssh -NT \
  -L 3004:127.0.0.1:3004 \
  -L 3005:127.0.0.1:3005 \
  deltaforge-vps
```

The Mac launch agent maintains the dashboard tunnel. The former Mac/iCloud
archive relay is disabled: it consumed the Mac's disk and home bandwidth, and a
copy into an iCloud File Provider directory did not prove that Apple had
completed an off-host upload.

The canonical archive path is now direct from the VPS to the operator's Google
Drive through `deltaforge-google-drive-archive.{service,timer}`. Its rclone
remote is required to use the least-privilege `drive.file` OAuth scope, so it
cannot read unrelated Drive contents. Closed immutable files are copied with
`--immutable`, verified against Google Drive's MD5 metadata with `rclone check`,
and listed in a SHA-256 manifest. Raw and snapshot retention receipts are
published only after a frozen traversal is complete. The transport never uses
`sync` or remote deletion; VPS retention remains fail-closed when the receipt
is missing, stale, empty, or older than three hours.

For normal use, double-click `TV2 Dashboard.webloc` or `DF2 Dashboard.webloc`
on the Mac Desktop. They open `http://localhost:3004/` and
`http://localhost:3005/`; the launch agent reconnects the encrypted tunnel
automatically after login or a network interruption. The passwordless GUIs
must never be exposed directly on a public interface. VPS systemd units bind
TV2 to loopback and UFW permits inbound SSH only.

The legacy Mac relay is retained only as a disaster-recovery fallback under
`~/.deltaforge-vps`; it must remain disabled during normal operation.

Install the root-owned, mode-`0600` environment as
`/etc/deltaforge/google-drive-archive.env`. The refreshable rclone token lives
at `/var/lib/deltaforge/google-drive-archive/rclone.conf`, owned by
`deltaforge:deltaforge` with mode `0600`; this lets rclone rotate short-lived
access tokens without making `/etc` writable. The remote must be named
`deltaforge-gdrive`, use `type = drive`, and use `scope = drive.file`.

For an archive independent of the Mac, install
`deltaforge-object-store-archive.{service,timer}` and create the root-owned,
mode-`0600` file `/etc/deltaforge/object-store.env`:

```dotenv
ARCHIVE_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
ARCHIVE_S3_REGION=auto
ARCHIVE_S3_BUCKET=deltaforge-research
ARCHIVE_S3_PREFIX=dublin
ARCHIVE_S3_ACCESS_KEY_ID=replace_me
ARCHIVE_S3_SECRET_ACCESS_KEY=replace_me
```

The timer is inert while that file is absent. It supports any S3-compatible
store, multipart-uploads large dumps, verifies remote size and SHA-256
metadata, and publishes the same raw/snapshot receipts as the iCloud pull only
after a complete traversal. The two transports may coexist; neither may issue
a receipt from an unverified or partial copy.

`gla-paper.service` runs the G-late-arbitrage mirror with a minimal environment
containing only `DATABASE_URL` and an explicit `LIVE_TRADING_ENABLED=0`. It
keeps the dry-run audit and heartbeat alive without putting wallet credentials
in that process or granting live-order authority.

`flow-boundary-canary.service` consumes only causal V3 final-ten-second intents.
It is installed as a dry observer and has no wallet on the VPS by default. Four
independent gates are required to arm it; live hard rails are $10/order, three
orders/$30 spend per UTC day and an exact arrival-ask FAK price guard. Use
`scripts/flow-boundary-canary-control.sh`; never edit the unit to bypass gates.

`eth-g-late-canary.service` mirrors only fresh
`ETH_G_late_exact_forward_v1` intents with the frozen manifest hash. It remains
a dry observer by default. A live override uses venue-minimum shares (hard $5
cap), exact-ask FAK/no-chase execution, five orders/$25 spend and -$10 resolved
loss per UTC day, 50 submissions total, an append-before-send WAL, and a
fail-closed official geoblock check. Historical ETH selection P&L is never
pooled into the fresh paper trial or the live canary. Use
`scripts/eth-g-late-canary-control.sh`; the control script refuses to arm when
the execution IP is not explicitly eligible.

`borg-allmarket.service` is a separate public-data, paper-only process for
all-market L2 prediction and passive-making research. It has no wallet, signer,
authenticated CLOB client, or order-posting dependency. Books and simulated
orders remain in memory; raw frames and decisions are appended to the local
WAL, and PostgreSQL persistence is asynchronous. `borg-structural-scanner`
uses the same 20/50/100/250/500 ms latency cohort across all active market
categories, while continuing to reject every non-atomic bundle as true locked
arbitrage.

`borg-paired-maker.service` is an isolated condition-level paper experiment
inspired by the observed two-sided inventory/merge mechanism of a large public
Polymarket operation. It never copy-trades that wallet and has no authenticated
order path. Equal complementary fills are netted at $1; unmatched shares remain
explicit orphan inventory and exit only through displayed bid depth with a
one-tick adverse adjustment and taker fees. Locked spread PnL, orphan PnL, and
unscored interruptions are separate dashboard fields. Its three arms reuse the
same public prints and must never be summed as one portfolio.

`borg-score.service` uses `--scheduled`: it scores only newly resolved orders,
omits the expensive full-history bootstrap, emits a heartbeat throughout the
run, and performs old pilot-order hygiene. Raw-row archival is isolated in
`deltaforge-raw-archive.service`, so it cannot delay scoring. CLOB events,
touches, books, external feeds, structural evaluations, option marks and
cross-venue samples are not archived a second time from PostgreSQL: their
source/decision frames already exist in the append-before-process WAL. The SQL
copies are daily partitions used only as the bounded dashboard/research hot
tier. Lower-rate rows without an equivalent WAL representation are gzip
written, fsynced, hash-verified and only then deleted.

The primary collector coalesces only its derived `borg_clob_touch` query rows
to one state per token per 250 ms plus the trailing state. This does not change
in-memory strategy reaction time and does not discard source evidence: every
WebSocket frame and depth delta remains timestamped and sequenced in the
compressed immutable WAL. Sub-250 ms tests therefore replay WAL/Parquet rather
than treating the sampled PostgreSQL projection as the source tape.

`deltaforge-hot-partitions.timer` runs every five minutes, creates the next seven UTC-day partitions and
drops only complete old partitions covered by a fresh off-host raw/WAL receipt.
At the measured v10 write rate, a nominal three-day query tier would itself
consume most of the 125 GiB disk. The highest-rate CLOB, external-book and
cross-venue snapshot/opportunity tables therefore retain the current UTC day;
the remaining partitioned projections retain the current and previous UTC
days. Rare positive structural, options and cross-venue rows are copied into
compact retained tables before a partition is dropped. There is intentionally
no default partition: if partition maintenance dies for more than seven days,
writes fail visibly instead of silently creating an unbounded heap.

The one-time conversion of an existing heap requires a fresh checksum-matching
off-host database snapshot and an explicit operator confirmation:

```bash
sudo -u deltaforge bash -lc '
  set -a
  source /etc/deltaforge/tv2.env
  set +a
  cd /opt/deltaforge/tv2/current
  DELTAFORGE_PARTITION_MIGRATION_CONFIRM=verified-offhost-snapshot \
    /usr/local/bin/node scripts/hot-tier-partitions.js --migrate --truncate
'
```

This operation is appropriate only for replayable paper/research projections.
It is never applied to user settings, trades, positions, trial manifests,
scores, resolutions, or authenticated execution records.

## Service checks

```bash
ssh deltaforge-vps 'systemctl --no-pager --failed'
ssh deltaforge-vps 'systemctl status deltaforge-tv2 borg-collector'
ssh deltaforge-vps 'systemctl status gla-paper'
ssh deltaforge-vps 'systemctl status flow-boundary-canary'
ssh deltaforge-vps 'systemctl status eth-g-late-canary'
ssh deltaforge-vps 'systemctl status borg-allmarket borg-paired-maker borg-structural-scanner borg-pyth-boundary'
ssh deltaforge-vps 'journalctl -u borg-collector -n 100 --no-pager'
ssh deltaforge-vps 'systemctl list-timers borg-score.timer deltaforge-raw-archive.timer deltaforge-hot-partitions.timer deltaforge-health.timer'
ssh deltaforge-vps 'cd /opt/deltaforge/tv2/current && npm run audit:runtime'
```

Use `ops/vps/start-evidence-epoch.sh <epoch-id>` only after the storage and
off-host checks pass. It drains the full collector fleet, writes one new epoch
boundary, seeds partition/archive health, starts all required paper collectors,
and waits for process stability plus real domain progress. A fresh epoch is
`PENDING_24H`; it is not clean evidence until 24 uninterrupted hours have
fresh heartbeats, no sequence gaps, no persistence failures, complete health
samples and at least 30 GiB free.

Sealed VPS files are pruned only through the fail-closed off-host receipt
policy; the iCloud copy is append-only. CSV is not used as an archival
optimization: compressed NDJSON preserves raw event fidelity and Parquet is the
compact columnar backtest format.
