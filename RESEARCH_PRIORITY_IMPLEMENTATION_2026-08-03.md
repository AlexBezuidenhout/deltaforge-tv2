# Research priority implementation — 3 August 2026

This change set implements the next operational requirements without enabling
authenticated trading. Every strategy remains paper-only and no
`createAndPostOrder` call site was changed.

## What was implemented

### 1. Machine-enforced Parquet burn-in

The one-minute evidence monitor now fails closed unless the replay lake has:

- at least two independently verified batches;
- a state and receipt in the expected versioned formats;
- a receipt matching the latest verified state batch;
- SHA-256-attested, remotely verified ZSTD outputs with non-zero rows;
- no quarantined raw input;
- a fresh successful compaction report and receipt (90-minute maximum age).

Parquet has a separate rolling 24-hour clean clock. The dashboard exposes that
clock alongside the collection-epoch result. A healthy current receipt is not
enough to pass: the monitored recurrence window must also be continuous.

The evidence service now runs from the independently deployed research-tools
release. Research health-contract upgrades therefore do not require a collector
restart or relabel an existing cohort.

### 2. Global public-flow coverage repair

Root cause of the v19 coverage failure: the two-second global Data API sampler
waited for a synchronous PostgreSQL insert of a rescue snapshot as large as
10,000 rows. That blocked subsequent network polls for minutes; the next rescue
could no longer reach the prior source-time cursor. Three real
`globalCoverageGaps` were recorded, so v19 is invalid for promotion evidence.

The raw source batch is now appended to the durable WAL first, the source-time
cursor advances immediately, and derived D-grade SQL rows drain on a separate
500-row/500-ms bounded queue. Queue depth, high-water mark, persisted rows and
oldest-row age are emitted in the heartbeat. Evidence fails if the queue exceeds
5,000 rows or its oldest row exceeds 120 seconds. This preserves raw authority
while preventing PostgreSQL from controlling feed coverage.

### 3. Options derived-row suppression

The options SQL projection had become an anti-pattern: 12,078 rows were written
in a 13-minute sample across only 132 market-side keys. Most were alternating
non-executable surface/quality classifications, not new evidence. Raw Deribit,
Polymarket and resolver events were already present in the WAL.

Execution eligibility transitions retain the frozen 250-ms dwell. Purely
diagnostic non-executable transitions must now remain stable for 30 seconds;
unchanged diagnostics retain the five-minute heartbeat. This changes only the
query projection, not pricing, eligibility, fills, PnL or the frozen V4
experiment manifest.

The options report also uses the active collection epoch as an evidence floor,
preventing pre-repair rows under the same experiment identifier from leaking
into a successor cohort.

### 4. Honest lane readiness

Every row in the ten-lane dashboard now carries a machine-readable readiness
contract:

- lifecycle and decision state;
- independent-unit progress against the frozen target;
- UTC-day progress against the frozen duration;
- earliest possible calendar read;
- explicit pending gates for doubled costs, chronological halves, clustered
  lower bounds, multiple testing, 100/250/500-ms latency, and shared-bankroll
  capacity.

Meeting the count and duration gates triggers a formal audit; it does not
automatically label a strategy profitable or live-ready.

## Controlled deployment boundary

Because v19 already contains three recorded coverage gaps, these collector-side
repairs require a new evidence epoch. Deploy the immutable release, install the
updated evidence service, then use `ops/vps/start-evidence-epoch.sh` once. Do not
delete or rewrite v19; it remains an auditable failed cohort.

The fresh epoch must pass 24 uninterrupted hours with no feed gaps, collector
errors, WAL failures, derived persistence backlog, stale archive receipts or
Parquet failures before it can become the default research surface.

## Deployment acceptance

Release `831462a` was deployed to the collector, independent research-tools and
dashboard release roots. `priority-forward-2026-08-03-v20` started at
`2026-08-03T16:52:57.428Z`; v19 remains preserved as failed evidence.

Initial production acceptance:

- collector, MAIN/George runner, all-market, cross-venue, options, Pyth,
  structural, public-flow, dashboard and maintenance timers are active;
- collector, options and flow processes show zero restarts;
- the first five recorded v20 health samples passed, with a 65.004-second
  maximum sample gap, zero feed sequence gaps and zero collector errors;
- the initial 9,571-row derived global-flow backlog drained to zero while the
  source cursor stayed live;
- options persisted 132 initial states, four stable transitions and 130 bounded
  five-minute heartbeats in the first observation interval, instead of the
  prior subsecond diagnostic churn;
- Parquet attests three verified batches, 75 source segments, 3,374,275 events,
  37 ZSTD files, zero invalid outputs and zero quarantined sources;
- authenticated dashboard checks returned HTTP 200 for both evidence and
  ten-lane incubator reports, and every lane reported paper-only/no live
  authority.

The current status is `PENDING_24H`, not passed. The earliest possible clean
read is after 4 August 2026 16:54 UTC, and only if every subsequent sample
continues to pass. Cross-venue V7 still has zero eligible entries and the
options lane still has zero exact-expiry executable targets; neither is a
profit result.

## What remains external or accrual-bound

- H43-X: 300 fresh independent markets and at least 14 days, unchanged.
- Exact Polymarket/Kalshi: the clean V7 cohort currently has zero entries; no
  semantic broadening is permitted to manufacture sample size.
- Certified payoff graph: continue until a fully rule-certified,
  statewise-positive, depth-walked and orphan-reserved bundle exists.
- Options: zero exact-expiry executable target remains a valid result; time
  cannot create an expiry overlap that the venues do not list.
- Semantic proposer: 100 human-reviewed proposals are still required; AI may
  propose but never certify.
- Google Drive continuity: a project-owned OAuth client for
  `team@leadlabs.design` requires account-side credentials and consent. The
  current archive is healthy, but that external migration cannot be fabricated
  in code.

No result in this implementation is evidence of a deployable edge. The purpose
is to make the next null or positive result trustworthy.
