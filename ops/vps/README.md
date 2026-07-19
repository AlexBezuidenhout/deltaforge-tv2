# Dublin VPS operations

The VPS is the hot event-capture and paper/shadow execution host. It is not a
live-trading authorization boundary: database paper flags and the existing
application live locks remain authoritative.

## Runtime layout

- `/opt/deltaforge/tv2/current` — TV2 application and BORG research code
- `/opt/deltaforge/df2/current` — isolated DF2 application
- `/etc/deltaforge/*.env` — mode `0640`, not stored in Git
- `/var/lib/deltaforge/wal/borg` — append-before-process event WAL
- `/var/lib/deltaforge/archive/borg-raw` — immutable database-prune archive
- `/var/lib/deltaforge/parquet` — immutable compacted research datasets
- `/var/lib/deltaforge/db-snapshots` — verified daily local-Postgres snapshots

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

The Mac launch agent maintains that tunnel. A separate hourly launch agent
pulls sealed WAL/archive files, Parquet and database snapshots into iCloud
Drive. It never uses `--delete`, so source retention cannot propagate deletions
to historical storage. VPS retention refuses to delete when that receipt is
missing or older than three hours.

For normal use, double-click `TV2 Dashboard.webloc` or `DF2 Dashboard.webloc`
on the Mac Desktop. They open `http://localhost:3004/` and
`http://localhost:3005/`; the launch agent reconnects the encrypted tunnel
automatically after login or a network interruption. The passwordless GUIs
must never be exposed directly on a public interface. VPS systemd units bind
TV2 to loopback and UFW permits inbound SSH only.

The archive script is installed under `~/.deltaforge-vps`, not run from the
Desktop checkout, because background launch agents do not have reliable macOS
TCC access to Desktop.

`gla-paper.service` runs the G-late-arbitrage mirror with a minimal environment
containing only `DATABASE_URL` and an explicit `LIVE_TRADING_ENABLED=0`. It
keeps the dry-run audit and heartbeat alive without putting wallet credentials
in that process or granting live-order authority.

`flow-boundary-canary.service` consumes only causal V3 final-ten-second intents.
It is installed as a dry observer and has no wallet on the VPS by default. Four
independent gates are required to arm it; live hard rails are $10/order, three
orders/$30 spend per UTC day and an exact arrival-ask FAK price guard. Use
`scripts/flow-boundary-canary-control.sh`; never edit the unit to bypass gates.

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
run, and performs old pilot-order hygiene. Raw-tape archival is isolated in
`deltaforge-raw-archive.service`, so a large CLOB backlog cannot delay scoring.
That worker prioritizes up to 24 verified 5k `borg_clob_touch` batches and four
batches from each lower-rate source per pass. Every batch is fsynced,
hash-verified and only then deleted from PostgreSQL; the cutoff also remains at
least one hour before the oldest unscored order. A manual
`node borg/shadow/score.js` retains the complete report and legacy unbounded
catch-up archive behavior.

## Service checks

```bash
ssh deltaforge-vps 'systemctl --no-pager --failed'
ssh deltaforge-vps 'systemctl status deltaforge-tv2 borg-collector'
ssh deltaforge-vps 'systemctl status gla-paper'
ssh deltaforge-vps 'systemctl status flow-boundary-canary'
ssh deltaforge-vps 'systemctl status borg-allmarket borg-paired-maker borg-structural-scanner borg-pyth-boundary'
ssh deltaforge-vps 'journalctl -u borg-collector -n 100 --no-pager'
ssh deltaforge-vps 'systemctl list-timers borg-score.timer deltaforge-raw-archive.timer deltaforge-health.timer'
ssh deltaforge-vps 'cd /opt/deltaforge/tv2/current && npm run audit:runtime'
```

Raw SQL tables target a 24-hour query window. Sealed VPS files are pruned only
through the fail-closed off-host receipt policy; the iCloud copy is append-only.
