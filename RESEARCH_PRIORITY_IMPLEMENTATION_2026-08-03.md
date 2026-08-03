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

Collector and dashboard release `831462a` started v20. Independent research
tooling then added source/date-bounded Parquet materialization, separate
global/scoped backlog accounting and a compact decision/proof nearline policy.
`priority-forward-2026-08-03-v20` started at `2026-08-03T16:52:57.428Z`.

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

v20 subsequently failed honestly at 17:20 UTC. `pm_flow_trades` archival used
primary-key order even though retained signals protect a large prefix of old
trade IDs. Under maintenance load the query scanned that prefix until its
45-second statement timeout. The failed sample and v20 remain immutable.

Release `1696810` changes only that selection mechanism to use the existing
`(observed_at)` index with deterministic `id` ties. The production plan executed
in 632 ms under load, and successive full archive jobs passed in 4.1 and 1.2
seconds. The release also caps continuous Parquet work at 12 segments/64 MiB,
2 GiB memory pressure and 3 GiB hard memory, and drains off-host/Parquet
maintenance during evidence-epoch startup.

`priority-forward-2026-08-03-v21` started from release `1696810` at
`2026-08-03T17:28:38.415Z` and also failed honestly. At the five-minute Data
API cache rollover, its 10,000-row offset-zero rescue ended 65 source seconds
after the prior cursor (`oldest_sec=1785777873`, cursor cutoff
`1785777808`). The cause was source capacity, not SQL: Polymarket sends
`cache-control: public, max-age=300` on this endpoint, and more than 10,000
global trades occurred inside that cache generation.

Release `aa398d1` replaced the single rescue with two concurrent documented
overlapping pages. Coverage is accepted only when at least 100 exact trade
identities overlap and the joined tail reaches the previous source cursor;
cache skew or insufficient depth still increments `globalCoverageGaps`. Its
first production rollover caught a second CDN failure mode rather than hiding
it: the head URL refreshed while the tail briefly served an older cache
generation, producing zero exact overlap.

Release `b4e8d95` therefore rotates the common rescue page size
deterministically from 9,900 to 9,999 once per five-minute cache bucket. The
two valid `limit`/`offset` URLs are requested concurrently and become
origin-fresh together; exact overlap and cursor reach remain mandatory. A
production origin probe returned exactly the designed 1,000-row overlap. The
evidence contract also fails if fewer than all expected public-flow CLOB
sockets are open or any socket reconnects during the epoch. v19, v20 and v21
remain preserved as failed evidence.

`priority-forward-2026-08-03-v22` started from collector release `b4e8d95` at
`2026-08-03T17:59:41.485Z`. Its first production cache rollover captured
11,927 new rows beyond bootstrap through one overlap-proved rescue, with zero
global gaps, zero CLOB reconnects, 2/2 sockets and a fully drained SQL queue.
The first five evidence samples all passed with a 60.479-second maximum gap.
Its status is `PENDING_24H`, not passed; the earliest possible clean result is
after 4 August 2026 18:00 UTC and only if every subsequent sample remains
healthy.

Independent evidence-tool release `e9b867b` also fixes a burn-in accounting
dead end: a monitoring pause longer than 120 seconds now begins a new clean
suffix at the first returning sample instead of poisoning every future Parquet
window forever. It does not forgive the gap or credit the earlier interval;
v22's Parquet clock restarted at `2026-08-03T18:00:56.360Z` and still requires
24 uninterrupted hours.

Cross-venue V7 still has zero eligible entries and the options lane still has
zero exact-expiry executable targets; neither is a profit result.

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
