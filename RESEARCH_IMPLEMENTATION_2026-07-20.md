# Research implementation checkpoint — 20 July 2026

Evidence snapshot: 20 July 2026, 10:08 UTC. This is an implementation and
operational-acceptance record, not a profitability claim.

## Outcome

TV2 is the sole bot evaluator. DF2 is dashboard-only. The active research
universe now contains 11 live paper/protocol strategies; 52 falsified or
superseded specifications remain queryable but are not evaluated by default.
H45, cross-venue convergence and the combined resolver-boundary view have clean
prospective evidence boundaries. All capital paths remain paper-only.

The runtime and platform acceptance audits pass. All 11 expected strategies are
registered, with no stale eligible strategy, strategy error, missing collector
or stale process heartbeat. Raw-data durability and database-snapshot durability
now have independent receipts, so a slow recovery snapshot cannot halt the
irreplaceable event collectors or authorize its own deletion.

## Implemented controls

### One evaluator owner

- TV2 must acquire a session-scoped PostgreSQL advisory lock before starting
  Main or George.
- Loss of the lock session stops local evaluators; database failure is
  fail-closed rather than fail-open.
- Every Main and George heartbeat records `runtimeInstanceId`.
- DF2 rejects automatic and manual evaluator starts unless its separate runner
  switch is explicitly enabled. Its deployed service fixes that switch off.

Verified runtime state: TV2 owns the lock as instance `tv2`; Main and George
heartbeats both identify `tv2`; DF2 reports zero active bots and
`runnerEnabled=false`.

### Prospective H45 trial

`research-h45-forward-v1` preserves the exact pre-existing H45 30-second
threshold-distance velocity rule. It changes no threshold, asset, size,
execution model or entry rule. The 41 orders across 40 markets used to select
H45 are discovery data and are permanently excluded.

The forward protocol requires at least 300 independent markets, 14 calendar
days, positive doubled-cost P&L in both chronological halves and positive
market- and day-clustered lower bounds. Its first forward order has settled at
-$1.3959 under doubled costs. One observation is information, not evidence for
or against the mechanism.

### Rule-aware cross-venue convergence

`crossvenue-rule-aware-convergence-v4` began from zero and cannot be redirected
to an old cohort by an inherited environment variable. Historical reads still
accept an explicit CLI `--experiment` argument.

The report separates:

1. rule-document-hash and statewise-payoff-certified terminal locks; and
2. score-approved pairs, which are risky convergence tests and never labelled
   risk-free arbitrage.

Inference uses only the first eligible episode per `(match_id, direction, UTC
day)`. Cohort-specific duration—not unrelated diagnostic history—must satisfy
the minimum observation period. At this snapshot V4 had four independent
score-approved episodes, one profitable executable liquidation after about 53
seconds, and zero certified economic locks. It is not profitability proof.

### Resolver-boundary portfolio read

`node scripts/resolver-boundary-portfolio.js` and
`GET /api/borg/research/resolver-boundary` provide one read-only view of H43,
Flow final-10-second absorption and Pyth transfer. Evidence identities stay
separate and overlapping P&L is deliberately not summed.

Current doubled-cost reads are:

| Lane | Attempts | Scored | P&L 2x | Minimum read | Pass |
|---|---:|---:|---:|---:|---|
| H43 resolver buffer | 5 | 2 | +$0.8497 | 300 markets / 14 days | No |
| Flow final-10s | 5 | 3 | +$0.8828 | 300 markets / 30 days | No |
| Pyth transfer | 1 | 0 | $0.0000 | 300 markets / 14 days | No |

These positive tiny cohorts are hypotheses only.

### Research governance

- H52 15-minute favorite: `REJECTED_EARLY_KILL` after its pre-registered
  non-positive 2x-cost kill rule fired beyond 100 independent markets.
- H53 accidental five-minute favorite: `REJECTED_OUT_OF_SAMPLE` after more
  than 1,300 markets and negative P&L in both chronological halves. Live remains
  disabled.
- H41 cross-asset dispersion reversion: `NEGATIVE_CONTROL` after the unchanged
  forward cohort lost $30.8223 over 73 markets.
- H40 remains only because its frozen protocol is still being completed; it is
  not an alpha candidate.

Set `BORG_INCLUDE_PARKED_CONTROLS=true` only for an intentional telemetry run.
Any economic redesign requires a new strategy ID and a new evidence boundary.

### Certified payoff graph repair

The structural scanner was receiving books and writing WAL but failing every
V3 SQL evaluation. JavaScript's `&&` expression returned a SHA-256 string for
`passProof`; PostgreSQL correctly rejected that string for a boolean column.
Both proof fields are now strict booleans, candidate-panel replacement no
longer creates a false all-inactive interval, and the heartbeat exposes current
process persistence errors.

Post-fix verification produced 145 fresh persisted evaluations: all 145 had a
valid payoff proof and rule certification, zero were economic after the current
2x-cost/capacity checks, and zero qualified. That is a functioning scanner and
an honest null result—not a discovered lock.

### Storage durability

The raw WAL and verified database archive are copied before large database
snapshots. Transfers use a separate partial directory, size comparison and
whole-file replacement so a truncated file left by the old copier is repaired
rather than preserved by `--ignore-existing`, and an evicted iCloud placeholder
is never read as a delta basis.

The immutable WAL and raw-database archive tiers are reconciled and have a fresh
`raw-wal-and-db-archive` receipt on both iCloud and the VPS. Verified retention
then freed the VPS from about 19.4 GiB to about 28 GiB without touching an
unconfirmed snapshot.

The remaining 4.33 GB PostgreSQL snapshot is resuming in ordinary APFS staging
storage and is atomically published into iCloud only after the transfer
succeeds. Partial objects are excluded from receipt evidence. It receives a
separate `database-snapshots` receipt; snapshot deletion skips safely until that
receipt exists and is fresh. The persistent LaunchAgent owns the transfer.

## Safety and acceptance

- `paper_trading=true`.
- Main and George are active in paper mode.
- G late arb, H53 and Flow live switches are off; their observers report dry
  mode where applicable.
- Cross-venue and structural processes load no wallet and expose no live order
  path.
- Paper loss, drawdown, balance, exposure, concurrency and cooldown cutoffs are
  disabled as requested; duplicate/cycle guards remain because they define a
  valid independent execution sample.
- The public TV2 health endpoint returns HTTP 200.
- Local and VPS suites both pass 352/352 tests.

## Decision rule from here

Do not promote any lane from this snapshot. Continue H45, H43, Flow, Pyth,
cross-venue V4 and the certified payoff graph without changing their frozen
mechanics. Read them only after their declared independent-market and calendar
minimums. A result near zero or negative is a valid outcome and must not be
repaired by tuning the same cohort.

## Reviewable commits

- `635792b` — enforce single bot-runner ownership
- `4a3d394` — park falsified research strategies
- `4187ea9` — freeze clean H45 and cross-venue trials
- `43c07d8` — add unified resolver-boundary read
- `a18673e` — prioritize and repair off-host archive copies
- `d84b6d5` — restore certified structural evaluation persistence
- `4acd54d` — avoid iCloud metadata reconciliation
- `10abd25` — avoid iCloud delta-basis reads
- `2f707c8` — stage resumable snapshots outside iCloud
- `73e5ef2` — separate raw and snapshot retention receipts
- DF2 repository `af3c5af` — make DF2 dashboard-only by default
