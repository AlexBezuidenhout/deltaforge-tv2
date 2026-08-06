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
- preserves each executed quantity and worsens its execution price by one tick;
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

## Completed fleet replay — 6 August 2026

The corrected `borg-wal-full-depth-v2` replay evaluated every BORG cohort that
had either looked promising or had enough paper history to justify an
execution audit. The source interval was 26 July through 6 August 2026. It read
1,548 selected raw-WAL segments (8.24 GiB compressed; 85,729,208 records) with
zero malformed records, segment failures or sequence gaps. The published
report is
`/var/lib/deltaforge/research-reports/borg-execution-validation.json` on the
VPS.

| Exact frozen cohort | Intended markets | Minimum scoreable | Minimum coverage | Worst 2x-cost P&L | Worst 2x + one-tick P&L | L4 result |
|---|---:|---:|---:|---:|---:|---|
| `H54_dynamic_ofi_resolver_confirm` / `research-v7-h54-h63-paper-v1` / `resolver_and_venue_confirmed` | 30 | 27 | 90.0% | +$52.41 | +$49.94 | `ROBUST_POSITIVE` |
| `H43_resolution_boundary_buffer` / `research-h43-forward-v1` / `baseline` | 38 | 37 | 97.4% | -$19.85 | -$24.51 | `EXECUTION_NEGATIVE` |
| `NEXT_H7_btc_oracle_confirm_v1` / `worthy-paper-forward-2026-08-03-v1` | 32 | 30 | 93.8% | -$22.71 | -$25.48 | `EXECUTION_NEGATIVE` |
| `NEXT_H54_dynamic_ofi_resolver_confirm_v1` / `worthy-paper-forward-2026-08-03-v1` | 29 | 27 | 93.1% | -$24.73 | -$27.36 | `EXECUTION_NEGATIVE` |
| `H71_token_elasticity_residual` / `research-v8-h64-h73-paper-v1` | 109 | 108 | 99.1% | -$18.89 | -$29.27 | `EXECUTION_NEGATIVE` |
| `FWD_H7_btc_oracle_confirm_v1` / `promising-paper-forward-2026-07-25-v1` | 127 | 124 | 97.6% | -$74.63 | -$85.30 | `EXECUTION_NEGATIVE` |
| `FWD_H45_threshold_distance_velocity_v1` / `promising-paper-forward-2026-07-25-v1` | 355 | 120 | 33.8% | -$5.88 | -$16.05 | `INSUFFICIENT` |
| `H59_resolver_cross_persistence` / `research-v7-h54-h63-paper-v1` | 138 | 26 | 18.8% | -$36.90 | -$39.36 | `INSUFFICIENT` |

“Worst” means the least favourable result across the registered 100, 250 and
500 millisecond profiles. It is not the original paper score.

### What survived, and what did not

`H54_dynamic_ofi_resolver_confirm` is the only execution survivor. Its detailed
results were:

| Latency | Scoreable markets | Fills / non-fills | Filled notional | 2x-cost P&L | 2x + one-tick P&L | Stressed first / second half |
|---:|---:|---:|---:|---:|---:|---:|
| 100 ms | 27 | 25 / 2 | $123.99 | +$73.93 | +$71.23 | +$26.64 / +$44.59 |
| 250 ms | 27 | 24 / 3 | $128.79 | +$69.24 | +$66.54 | +$29.29 / +$37.25 |
| 500 ms | 27 | 23 / 4 | $117.51 | +$52.41 | +$49.94 | +$13.46 / +$36.49 |

This is encouraging but not proof of a deployable edge. At 250 ms, BTC
contributed $49.60 of the $69.24 doubled-cost P&L, while XRP lost $2.81. Two
UTC days contributed $51.20, roughly 74% of total P&L. More importantly, the
fresh, separately identified `NEXT_H54` successor is execution-negative. The
correct decision is therefore to preserve H54 as a frozen research hypothesis,
not tune it, annualise it, or send it live. It needs a newly registered forward
cohort and the full promotion sample before capital is considered.

H43 and every adequately covered H7/H71 cohort fail after causal depth and
costs. H45 and H59 do not have enough raw-book coverage to support a conclusion;
their missing observations are not silently treated as non-fills.

### Corrected stress invariant

An earlier v1 report was quarantined after review found that shifting a book
and re-walking it through the original limit could reduce the executed quantity
on losing trades. That model could make “adverse” stress improve P&L by assuming
the least attractive shares disappeared. Version 2 instead preserves every
executed quantity and worsens its price by one tick. It rejects a replay if
stressed P&L improves at the total or chronological-half level. The completed
fleet report has zero such invariant violations. The invalid report remains
quarantined as
`borg-execution-validation.invalid-nonmonotone-v1.json` for auditability.

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

Run large historical replays at low operating-system priority (`nice 19` and
idle I/O scheduling on Linux). The validator is research-only and must yield to
live collectors; saturating the four-core VPS can otherwise make an economic
feed fail its freshness budget even though the socket remains connected.

Staging switches from per-object `--no-traverse` lookup to `--fast-list` at 500
selected segments. This follows rclone's guidance for larger or mostly
unchanged copies: recursive listing uses more bounded memory but materially
fewer remote transactions. Override the crossover with
`--fast-list-threshold=<count>` when profiling a different archive layout.

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
