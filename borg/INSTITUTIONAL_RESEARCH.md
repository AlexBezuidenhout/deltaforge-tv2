# BORG institutional research workflow

This platform is an experiment system, not a bot leaderboard. Its purpose is
to reject false edges cheaply and preserve enough causal evidence to decide
whether a surviving effect deserves a separately authorized tiny live canary.
`paper_trading` remains the default and BORG has no signing or order-posting
dependency.

## Evidence classes

| Class | Meaning | Permitted claim |
|---|---|---|
| L0 | Retrospective outcome re-filter | Scenario/sanity check only |
| L1 | Decision-time touch assumption | Execution-naive paper telemetry |
| L2 | Latency-adjusted snapshots and depth walk | Conservative paper estimate |
| L3 | Event quote survival or print queue replay | Forward shadow evidence, subject to data grade |
| L4 | Full event-book and queue-state replay | High-fidelity counterfactual execution |
| L5 | Exchange acknowledgement and fill telemetry | Tiny-canary execution evidence |

Every new score stores its data grade, execution grade, fidelity level,
simulator version, and fee-model version. F-grade rows remain visible and are
excluded from evidence rather than silently assumed filled.

## Frozen experiment lifecycle

1. Write a manifest under `borg/experiments/` before the forward cohort.
2. Give every changed hypothesis, threshold, universe, capital rule, data
   source, or execution model a new `experiment_id`.
3. Collector boot hashes and registers manifests append-only. Editing a
   registered manifest in place is a startup error.
4. Pilot rows tune machinery only. Evaluation begins at the trial ledger's
   `evidence_started_at`; old rows are never imported.
5. Read `npm run research:promotion` only after the manifest minimum. The
   report aggregates repeated orders to independent markets, splits those
   markets chronologically, reports separate market- and UTC-day-clustered
   intervals, applies Holm correction, requires both halves positive, checks
   the manifest's 2×-cost primary metric and data quality, and can only return
   `ELIGIBLE_FOR_TINY_CANARY_REVIEW`—never an automatic live promotion.

The board-review boundary is encoded, rather than left as dashboard prose:
`research-h43-forward-v1` starts H43 from zero fresh evaluation markets without
changing its model; `research-daily-structural-universe-v2` widens deterministic
capture but remains pilot-only; and the dated governance manifest labels
failed specifications as rejected controls rather than alpha candidates.

The Main and George adapter is forward-only. On first boot it checkpoints the
current source-table maxima. It then observes only new paper fills and asks
whether the common BORG depth/latency/fee scorer corroborates them. It has no
Polymarket client or order method. This is the safe bridge toward eventual
kernel parity; changing the existing live-order call sites requires a separate
explicit authorization and canary design.

## Shared capital and capacity

Run `npm run research:portfolio`. Pilot and evaluation are simulated
separately with one $500 account, a 2% ($10 initial) target, 6% ($30) gross
cap, capital locked to resolution, one owner per market, and displayed
liquidity consumed once across competing bots. The report includes rejected
orders, drawdown, strategy concentration, and daily strategy correlations.
It replaces the economically impossible practice of adding every standalone
bot balance together.

## Latency and host testing

Capture on each host with the same command:

```bash
npm run benchmark:infra -- --location measured-mac --out artifacts/mac.json
npm run benchmark:infra -- --location measured-dublin --out artifacts/dublin.json
npm run benchmark:infra -- --location measured-us-east --out artifacts/us-east.json
npm run benchmark:compare-hosts -- --mac artifacts/mac.json --dublin artifacts/dublin.json --us-east artifacts/us-east.json
```

Then replay identical orders at fixed 100/250/500/1000/2000 ms and measured
profiles with `npm run replay:latency`. Information latency and order latency
remain separate. A VPS is justified only by improved quote-survival-adjusted,
post-fee results; a marketing ping or faster REST response is not alpha.

## Data durability and acceptance

Raw source frames are append-before-process WAL records with source time,
receive wall time, monotonic time, sequence, connection epoch, and event ID.
Set `BORG_WAL_MIRROR_DIR` to a genuinely off-host mounted path. Parquet
archives are immutable analysis datasets, not a substitute for the raw WAL.

Before trusting a collection window:

```bash
npm run research:check
npm run research:check -- --strict
```

The check validates frozen manifests, database schema/RTT, feed and heartbeat
freshness, raw WAL, disk reserve, off-host mirroring, 48-hour provenance, and
score versioning. A clean infrastructure window does not prove an edge.

## Paid data gate

Free event streams remain the baseline. A paid source is admitted only as a
pre-registered, blinded arm over the same independent markets, with identical
strategy and execution code. The incremental post-fee PnL interval must be
positive after market/day clustering and multiple-testing correction. Until
such a cohort exists, buying a feed is an untested cost, not an improvement.

The acceptable final result is that every measured strategy has approximately
zero post-cost edge. The platform is working when it says that plainly.
