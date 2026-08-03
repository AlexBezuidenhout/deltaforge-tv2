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
That initial result was later invalidated rather than promoted: the separate
primary strategy-book adapter had recorded five abnormal WebSocket closes and
ten REST hash repairs by 18:28 UTC, but did not expose either counter in its
heartbeat. The raw events preserved the defect while the old evidence query
missed it. Research release `2b11591` recorded a terminal failed v22 sample
with `primary CLOB socket coverage telemetry is missing`; v22 remains immutable
and is not clean evidence.

Independent evidence-tool release `e9b867b` also fixes a burn-in accounting
dead end: a monitoring pause longer than 120 seconds now begins a new clean
suffix at the first returning sample instead of poisoning every future Parquet
window forever. It does not forgive the gap or credit the earlier interval;
v22's Parquet clock restarted at `2026-08-03T18:00:56.360Z` and still requires
24 uninterrupted hours.

Release `2b11591` closes the primary-book monitoring hole. Each CLOB shard now
reports active/expected sockets, connection epochs, connection-gap counts and
REST hash-repair gaps. Every established disconnect clears its in-memory books
immediately, so no evaluator can consume a pre-disconnect quote while the
socket reconnects. Both `connectionGaps` and `bookStateGaps` are hard evidence
failures, including the public-flow adapter's existing
`realtimeConnectionGaps` counter.

The primary collector is now scoped to `direction_5m`, the only market family
used by the frozen H43, H43-X and MAIN-longshot strategy set, and spreads that
small panel across three sockets. Hourly, ordered-threshold and range authority
continues in the dedicated all-market, options and structural collectors; it
was removed only from the duplicate primary subscription that had overloaded
one socket. This is a feed-integrity mechanism change, not a PnL-derived
trading parameter change.

`priority-forward-2026-08-03-v23` started at
`2026-08-03T18:29:16.782Z` from immutable release `2b11591`. Its first recorded
sample passed, but the new counters then caught the mechanism: every shard
carrying two high-rate markets was eventually closed with code 1006 and one
causally confirmed REST repair was required. v23 is therefore preserved as
failed, not pending.

Release `4f3d203` routed BTC, ETH, SOL and XRP to four deterministic sockets and
confirmed a REST hash mismatch only after a 750-ms grace plus a second REST
snapshot. Release `3d30abd` also disabled the dormant live canary in every
evidence launch. `priority-forward-2026-08-03-v24` started at
`2026-08-03T18:44:51.474Z`. Its four CLOB paths remained stable, but the shared
Google OAuth client hit `rateLimitExceeded` and the primary RTDS socket was
silent for more than 15 seconds at `18:50:58Z`. Release `c19a1a9` recorded the
retained stale heartbeat as a terminal failed sample; a later green heartbeat
cannot erase a transient outage.

Releases `b340e25`, `c19a1a9` and `cd9f43f` made native release dependencies,
Google Drive failures, Parquet failures and transport gaps fail closed. The
Google uploader now uses a 500-object/4-GiB cap, two transfers and four TPS. A
production recovery uploaded 93 new immutable objects (128,586,326 bytes),
remotely verified all 290 in-scope raw objects and published a fresh manifest
and receipt. The current shared rclone OAuth client still has a 2026 retirement
warning; a project-owned Google client remains an external requirement.

`priority-forward-2026-08-03-v25` started at
`2026-08-03T19:09:10.536Z` and correctly failed warm-up: one BTC CLOB socket and
the only RTDS socket each reconnected. This demonstrated that “no physical
socket ever reconnects for 24 hours” is not a viable coverage design. Release
`c1fcec2` therefore keeps two independently WAL'd routes per primary token and
two RTDS transports. Five staggered CLOB sockets isolate BTC twice and place
ETH/SOL/XRP on a lower-rate redundancy ring. Individual transport churn is
reported as `transportReconnects`; only simultaneous loss of every fresh path
increments the evidence-breaking `coverageGaps` counter.

The redundancy canary ran inside already-failed v25. One RTDS path naturally
reconnected at `19:25:49Z` and one CLOB path at `19:27:27Z`; all assets remained
covered, both aggregate coverage counters stayed zero and subsequent
heartbeats remained healthy. Release `97578af` additionally freezes maintenance
timers before testing their services, restores them through an EXIT trap on any
failure, and treats a successfully recorded failed cohort as monitor data
rather than a crashed systemd service. The interrupted Parquet job was rerun:
12 immutable sources became seven ZSTD files containing 58,111 rows, with all
eight remote objects verified.

`priority-forward-2026-08-03-v26` started from release `97578af` at
`2026-08-03T19:29:20.324Z`. Its first sample passed, but the public-flow adapter
still had one physical path per token and later recorded two transport gaps.
v26 is failed evidence.

Release `9431b8a` added independently WAL'd public-flow routes and deterministic
derived authority. `backlog-forward-2026-08-03-v27` began at
`2026-08-03T19:44:00.514Z`; both public-flow paths were initially complete with
zero gaps. It was superseded after the Pyth lane exposed a separate source
contract defect: Polymarket's documented `equity_prices` RTDS accepted the
subscription and exchanged pings, but supplied no usable equity price payloads.
An open socket was therefore not evidence of resolver-price coverage.

Release `7b32e50` implements
`pyth-resolver-boundary-transfer-v3-hermes-exact-feed`. A market is eligible
only when its immutable rule contains an explicit
`pythdata.app/explore/<feed-symbol>` identity matching the price-to-beat symbol.
Search pages, fuzzy catalog matches and duplicate catalog identities are hard
vetoes. That exact symbol is resolved to one Hermes Core feed ID and streamed
over SSE. Every raw envelope is appended before parsing with Pyth publish time,
proof-available time, local wall/monotonic clocks, connection epoch and event
sequence. Repeated post-session values are rejected by source-clock age even
when newly received. The Polymarket RTDS remains a diagnostic WAL only and can
never trigger a v3 signal.

`backlog-forward-2026-08-03-v28` started at
`2026-08-03T20:13:19.871Z`. Hermes resolved every requested exact identity with
no catalog, parse or connection failures, but two public-flow paths carrying
the same token set reset close together. Four of eight books became uncovered;
v28 is failed evidence. Release `9a8b766` added a third path, missing-snapshot
rehydration and a stable complete Pyth rule-feed superset. v29 began at
`20:25:28.812Z`, but all three copies of one high-rate shard were reset
together; v29 is failed evidence.

Release `39c32ad` split the four-market flow panel into four logical shards and
required a post-60-second flow heartbeat before launch acceptance. v30 began at
`20:29:25.105Z`. Two duplicate paths for the same markets still reset together
and created two aggregate coverage gaps. v30 is failed evidence. These trials
show that same-IP duplicate Polymarket sockets are not independent enough to
certify this retired flow experiment; adding sockets spends bandwidth without
creating true redundancy.

Release `6966d88` therefore converts Flow Lab to broad public Data API and
market-metadata capture only. Its generic continuation/scalp strategies remain
paused negative controls, CLOB capture is disabled, no strategy signal can be
created, and historical raw data is preserved. This removes the largest
unstable duplicate-book stream without reducing the five priority programs:
H43/Pyth use their certified resolver and primary books, the payoff graph has
its own scanner, cross-venue has synchronized venue collectors, options has its
own CLOB/surface collector, and staged fair-bound capture comes from the
all-market panel. Global Data API gaps, SQL lag, WAL failures and collector
errors remain evidence-breaking; only the disabled flow-socket counters are
out of scope.

`backlog-forward-2026-08-03-v31` started from immutable release `6966d88` at
`2026-08-03T20:35:59.369Z`. Initial status is `PENDING_24H`, not passed: no
critical findings, sequence gaps or error counters; Flow is capture-only with
zero sockets/signals; and exactly three frozen BORG strategies are registered
and evaluating. The earliest possible clean result is after
`2026-08-04T20:35:59Z`, only if every subsequent sample and the independent
Parquet continuity clock remain healthy.

The post-cutover Google Drive run uploaded 106 new immutable objects
(194,960,382 bytes), remotely verified all 330 selected raw objects plus the
database archive and manifest, and published a fresh receipt. The complete
suite passes 650/650 tests on release `6966d88`. The first five-minute Pyth
universe rotation retained the 29-feed exact-rule superset without reopening
Hermes: 13/13 in-window feeds were live, with zero catalog/connection/parse/
reconfiguration failures. At `20:42:02Z`, v31 had five passing evidence samples,
12 verified Parquet batches containing 5,273,650 rows, no failed systemd units
and 34.09 GiB of hot-tier free space.

The public HTTPS process remains execution-isolated. Dashboard release
`f872166` now reports the healthy port-3004 lock owner and MAIN/George fleet
heartbeats instead of its deliberately empty local runner map. Historical
strategy names without a fresh runtime row are PAUSED/DEAD rather than falsely
labelled active. The authenticated registry therefore reports five running
items: paper MAIN, paper George and the three frozen shadow strategies.

Cross-venue V7 still has zero eligible entries and the options lane still has
zero exact-expiry executable targets; neither is a profit result.

### v31 autopsy, resolver protocol correction and operations UI

v31 did not remain pending. A real VPS network interruption from approximately
21:24–21:29 UTC made Binance, Coinbase and Hyperliquid stale, closed a primary
CLOB path and silenced RTDS. Those gaps remain immutable failures. The same
cohort also exposed two separate Pyth observer defects: it required fresh
resolver ticks throughout an entire daily contract, even though every frozen
checkpoint is inside the final 300 seconds, and it restarted the Hermes URL as
future Gamma feed identities changed. v31 finished with 91 failed samples and
non-zero Hermes reconfiguration, CLOB coverage and RTDS coverage counters. It
must never be used as promotion evidence.

`pyth-resolver-boundary-transfer-v4-frozen-observation-window` corrects the
protocol under a new experiment identity. The initial exact Hermes feed set is
frozen for the process lifetime; later feed discoveries are disclosed and
deferred to the next cohort. Signals and fresh-tick requirements apply only
inside the final 300-second resolver observation window. Raw transport gaps
remain evidence-breaking at all times. V4 reuses no V3 rows and retains the
same 300-independent-market, 14-day, doubled-cost, chronological-half,
clustered-bound and 100/250/500-ms requirements.

The epoch launcher now requires 120 uninterrupted green seconds after the
existing one-minute process-age gate. One bad preflight resets that clock and
non-zero process counters cannot recover in place. The cross-venue settlement
oneshot now treats the launcher's deliberate SIGTERM drain as a clean stop;
its next poll must still exit zero, so real settlement failures remain visible.

Collector release `4c4202e` started
`backlog-forward-2026-08-03-v32` at `2026-08-03T22:37:22.217Z`. The controlled
launch passed its uninterrupted preflight. Its first recorded sample was
`PENDING_24H` with zero failed samples, zero stale-feed records, zero sequence
or collector error counters, approximately 33.0 GiB free, 16 verified Parquet
batches and a fresh verified Google Drive receipt. The Pyth heartbeat reported
the V4 experiment, a 300-second observation window, a process-lifetime feed
freeze at `2026-08-03T22:37:28.170Z`, zero reconfiguration gaps and
`AWAITING_WINDOW` because no certified market was inside its final five
minutes. MAIN and George were active in paper mode; every live canary flag was
false. This is launch acceptance only—not a clean 24-hour result or evidence
of profitability.

The dashboard was rebuilt as a light, high-contrast research operations shell
with grouped navigation, stable page transitions, keyboard-focus visibility,
responsive layouts and contextual help. A persistent evidence ribbon keeps
runtime liveness separate from cohort validity and surfaces storage and archive
state globally. Dense legacy tables remain horizontally contained. The public
dashboard-only process runs release `47e03ff`; it reports `Operational`,
`Collecting`, about 33 GiB free and `Verified` without owning a bot runner.
The complete repository suite passes 654/654 tests.

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
- Google Drive continuity: the current direct VPS-to-Drive archive is verified,
  but rclone's shared OAuth client is being retired during 2026. A project-owned
  client for `team@leadlabs.design` requires account-side credentials and
  consent; that external migration cannot be fabricated in code.

No result in this implementation is evidence of a deployable edge. The purpose
is to make the next null or positive result trustworthy.
