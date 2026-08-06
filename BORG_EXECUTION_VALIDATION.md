# BORG full-depth execution validation

## Purpose

The normal BORG scoreboard answers whether a frozen paper rule produced a
profitable score under its original execution model. It does not prove that
the displayed order book could have filled the order after real information
and order latency. The fleet validator closes that specific gap without
changing a strategy, a score, a trial status, or any live-order path.

`scripts/borg-full-depth-fleet-replay.js` reconstructs Polymarket books from
the append-before-process raw CLOB WAL. For each exact
`strategy × experiment × arm × phase` cohort it selects the first resolved
taker intent per market and replays it at 100, 250 and 500 milliseconds after
the stored `available_at` decision clock.

The replay:

- uses raw local receive timestamps, connection epochs and event sequences;
- consumes all displayed ask levels through the original frozen limit;
- retains partial fills and proves non-fills separately from missing data;
- fails closed on sequence gaps, stale transport and redundant-path disagreement;
- calculates P&L after doubled modelled taker fees;
- reruns each fill with one adverse tick per leg;
- splits every latency profile into chronological halves.

This is counterfactual L4 evidence. It is not L5 exchange acknowledgement and
cannot observe hidden liquidity, wallet rejection, matching-engine races or
the exact queue state at a live order acknowledgement.

## Classifications

| Label | Meaning |
|---|---|
| `ROBUST_POSITIVE` | At least 20 causal scoreable markets, at least 80% archive coverage, positive doubled-cost and one-tick P&L at every latency, and both chronological halves positive. |
| `FRAGILE_POSITIVE` | Raw doubled-cost P&L is positive at every latency, but one-tick stress, stress coverage or a chronological half fails. |
| `EXECUTION_NEGATIVE` | Adequate causal evidence exists, but doubled-cost P&L is non-positive at one or more latency profiles. |
| `INSUFFICIENT` | Fewer than 20 causal scoreable markets or less than 80% archive coverage. |
| `UNSCOREABLE` | No causal A/B full-depth evidence is available. |

These are execution-audit labels, not promotion decisions. Even a
`ROBUST_POSITIVE` reused cohort remains paper-only and not live-ready. Formal
promotion still requires at least 300 fresh independent markets, the required
day span, positive chronological halves under the registered primary metric,
multiple-testing correction, shared-capital capacity, and a 50-fill
authenticated live pilot.

## Running the validator

Inventory the database without listing or downloading raw archives:

```bash
npm run replay:borg-fleet -- --inventory-only
```

Plan a bounded replay before transferring data:

```bash
npm run replay:borg-fleet -- \
  --strategies=H43_resolution_boundary_buffer,H54_dynamic_ofi_resolver_confirm \
  --lookback-ms=60000 \
  --plan-only
```

Publish the report consumed by the dashboard:

```bash
npm run replay:borg-fleet -- \
  --strategies=H43_resolution_boundary_buffer,H54_dynamic_ofi_resolver_confirm \
  --lookback-ms=60000 \
  --max-bytes=9663676416 \
  --json-out=/var/lib/deltaforge/research-reports/borg-execution-validation.json
```

On the VPS, invoke the command as the `deltaforge` service user. Never run a
remote replay as root: rclone can refresh its OAuth token and rewrite the shared
config with root-only ownership, locking out the production archive service.
Large transfers may use `--stage-root=/var/lib/deltaforge/research-cache/<run>`;
an interrupted download is then retained and checksum-resumed, while a complete
replay removes the bounded stage after publishing its report.

The process is read-only against PostgreSQL. Remote raw segments are copied to
a bounded temporary directory only after the plan passes the byte and free-disk
guards, then removed in a `finally` block. Missing archive rows remain
unscoreable and never become zero-PnL non-fills.

On the VPS, remote cataloguing and bounded staging cooperate with the production
Google Drive archive through its advisory lock. A replay waits while an archive
is active, holds the lock only for remote discovery and download, and releases
it before local decompression and simulation. Research therefore cannot start a
second competing Drive transfer or delay the collector's in-memory/WAL path.

## Dashboard

The BORG ledger has two independent state systems:

- **Lifecycle** says whether a rule is live, testing, stale, paused or dead.
- **Execution truth** says whether the exact current frozen cohort has passed a
  bounded causal full-depth audit.

The execution-truth strip filters the ledger. The L4 column ranks exact current
cohorts and shows minimum scoreable markets, worst doubled-cost P&L and the
250ms one-tick result. Opening a strategy row shows all three profiles,
coverage, fills/non-fills, stress P&L and chronological halves. A historical
replay is never silently attached to a newer experiment identity.
