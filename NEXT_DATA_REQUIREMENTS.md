# Next data requirements

Snapshot date: 3 August 2026. These requirements are ordered by the decision they unlock, not by novelty. “Collect more” is not a substitute for fixing a rule, identity or execution-model defect.

## P0 — make existing evidence queryable and durable

### Verified Parquet replay lake — implemented, burn-in required

- **Existing source:** SHA-256-attested Google Drive WAL under `VPS Data`; 94,455 verified objects and 165.87 GiB at the 16:20 UTC catalog snapshot.
- **Implemented fields:** source, event date/hour, source segment and SHA-256, source row, event type, source time, receive wall time, receive monotonic time, sequence, connection epoch, collection epoch and raw JSON.
- **Implementation:** direct VPS-to-Google-Drive staging, raw SHA verification, Zstandard Parquet partitions, remote checksum verification, a 10 GiB rolling hot cache and DuckDB query/hydration commands.
- **Targeted materialization:** `node scripts/parquet-lake.js materialize --sources <source[,source]> --from YYYY-MM-DD --to YYYY-MM-DD --oldest --max-batches <N> --max-minutes <N>` converts only a predeclared hypothesis window. Every bounded batch still performs source SHA verification, disk-reserve preflight, immutable upload and remote checksum verification. This is the supported way to make older evidence queryable; blindly duplicating the full 165+ GiB bronze archive is neither required nor storage-efficient.
- **Safety bound:** 25 segments or 128 MiB compressed per run, a 24× working-expansion reserve and a hard 15 GiB free-disk floor. The first 250-segment trial was stopped before publication when it demonstrated excessive temporary expansion.
- **Verified recurrence:** batches `76ba651b576861e5dfcc0dd5be44f009` and `1485186d236e2a5712fe5c36117c2a4b` remotely verified 50 raw segments, 2,255,941 events and 23 ZSTD partitions (about 207 MiB plus manifests) on 3 August 2026. DuckDB read 19 source families back successfully. A valid structural-rule string containing Unicode `U+2028` exposed and then regression-tested a framing defect; strict LF-only NDJSON parsing now preserves it across compaction, recovery and replay. Zero source objects are quarantined.
- **Accrual clock:** no new data is needed; require 24 hours of successful timer runs and receipts before using Parquet as the default research surface.
- **Machine gate (implemented 3 August):** the one-minute evidence monitor now verifies recurrent batches, matching fresh state/receipt/report, SHA-256/ZSTD/queryable outputs, remote checksum verification and zero quarantine, then maintains a separate rolling 24-hour clean Parquet clock. This is no longer a prose-only requirement.
- **Operational dependency:** the current rclone remote still uses rclone's shared Google OAuth client, which reports retirement during 2026. Before that cutoff, provision a project-owned Google OAuth client for `team@leadlabs.design`, change only the remote credential, and pass a fresh upload/check/receipt cycle. The present archive is healthy; this is continuity risk, not evidence loss.
- **Storage decision:** retain immutable bronze events off-host; keep only bounded recent Parquet locally. Do not keep repetitive second-by-second derived marks in PostgreSQL when they can be reconstructed.
- **Unlocks:** full causal replay without contending with the 64.95 GiB hot PostgreSQL database.

The archive averaged roughly 20 GiB/day over the catalog interval, with higher bursts previously observed. That rate is not a research virtue. Most of the bulk came from broad CLOB capture and repetitive options decision state. Capture raw source changes at fidelity, but persist derived state only on transition plus a bounded heartbeat.

## P1 — data needed by the selected research slate

| Programme | Exact missing fields or condition | Existing coverage | Minimum accrual | Approximate incremental storage | Decision unlocked |
|---|---|---|---|---:|---|
| H43-X Chainlink tail | Fresh Chainlink source tick, local receipt/monotonic clock, sequence/epoch, exact market boundary, full executable token depth, current fee/minimum/tick and actual terminal outcome | Available for BTC/ETH/SOL/XRP; current clean cohort has 18 markets and is negative | 300 markets and at least 14 days, unchanged | Already in current WAL budget | Accept/reject the only still-plausible resolver residual |
| Certified payoff graph | Immutable rule versions, typed predicates, exhaustive terminal states, synchronized depth on every leg, effective fee schedule, FOK capacity and every proper-subset orphan unwind | Rule/payoff scanner is active; no current orphan-safe positive bundle | 30 calendar days of scanner coverage; no outcome forecast sample required for a proved identity | Mostly compact gold facts; raw books already captured | Determine whether any logical anomaly has fundable dollars rather than arithmetic-only spread |
| Exact Polymarket/Kalshi terminal identity | Predicate, subject, comparator, strike, observation instant, timezone, rounding, resolver, fallback/dispute/void clauses and source-rule hashes on both venues; synchronized 5/10/25-share depth; per-market Kalshi fee formula/effective time | Most fields are captured; zero complete exact-rule key today | 300 certified pair-direction-days and at least 30 days after the first eligible pair | Historical cross-venue raw rate was about 0.3–0.4 GiB/day | True terminal lock if one exists; otherwise a clean null result |
| Risky cross-venue convergence | All identity fields above plus basis entry/exit, both executable books, four fee legs, capital occupancy, stale-leg and mismatch settlement stress | Replayable, but previous broad cohort was polluted by rule mismatch | 300 exact-rule pair-direction-days, 30 days | Same cross-venue tape; no duplicate collector | Estimate convergence P&L/half-life without calling it risk-free |
| Deribit exact-expiry digital residual | Exact target expiry equals listed option expiry; sequenced option bid/ask price and IV, strike neighbours, forward/discount input, resolver basis interval, executable Polymarket depth and executable perpetual hedge spread/funding | Large surface tape exists; zero exact-expiry A-grade target/mark | 30 days after first exact target; time alone cannot create a target whose expiries do not overlap | Current options family has been several GiB/day; transition-only gold facts should reduce this materially | Test whether an option-implied lower bound adds residual information after hedge/costs |
| Fair-bound passive observation | A content-addressed lower/upper fair bound from one of the four certified sources; full public queue, prints, quote/cancel timing, partial fills, tick/fee/minimum and 1/5/30-second markouts | Neglected-market panel is captured; strategy intentionally disabled | 300 simulated fills and 30 days after first qualifying independent fair bound | Existing bounded panel; target well below 1 GiB/day | Reject or advance one-sided passive making before an authenticated canary |
| Semantic relationship proposer | Immutable rule text/hash, canonical entities, predicates, numeric boundaries, observation/resolver/fallback metadata and deterministic verifier result | Rule snapshots exist; proposal tooling is the missing layer | Measure 100 reviewed proposals; zero false deterministic proofs required | Compact proposals only, negligible | Expand obscure condition-graph coverage without allowing AI to certify trades |
| Resolver timestamp precision | Explicit rule-level source timestamp unit and terminal tick selection (last `<=`, first `>=`, exact, nearest, fixing or window), not merely an ISO `endDate` | 87,729 rules scanned; zero machine-certified timing units | No amount of additional ticks fixes ambiguous rules | None | Reopen R07 only if a new rule family publishes precise semantics |

### Pyth-specific blocker

`borg_pyth_ticks` has no usable normalized tick cohort despite rule and arrival metadata. A viable Pyth arm requires non-historical source ticks with `source_ts`, provider receive time, local receive/monotonic time, sequence/epoch, carried-forward flag and exact symbol-to-contract resolver certification. First prove 24 hours of non-empty source events, then start a fresh 300-market/14-day clock. A heartbeat alone does not count.

## P2 — cheap collectors that expand the opportunity set

### Venue funding and executable carry

Capture funding announcement/effective timestamps, predicted and realized funding, executable spot/perpetual BBO and depth, maker/taker tiers, borrow rate/availability, margin requirement, liquidation schedule, deposits/withdrawals and inventory location for each permitted venue. Expected storage is small—normally tens of MiB/month for funding and bounded BBO transitions. This unlocks honest basis/funding replays; current spot/perpetual prices alone do not.

### Public news/social event tape

Only build after obtaining terms-compliant causal access. Preserve post/publication ID, original publication and edit times, local receipt and monotonic times, source authenticity, raw text/media hash, model start/end, decision and simulated arrival. Start with official government/company/RSS sources before paid firehoses. Storage is likely below 1 GiB/month for text, excluding media. The decision is whether reaction persists after realistic source and inference latency—not whether an LLM can explain an event after the market moved.

### On-chain/DEX execution tape

This is not supported by current data. A credible lane needs block/slot, transaction ordering visible under applicable terms, pool state before/after, gas/base/priority fee, route quote and expiry, simulated inclusion, failure/revert, MEV loss, bridge/rebalance latency and pre-funded inventory. Run a one-week bounded chain/venue capture first and estimate all-in opportunity frequency before operating nodes or buying private order flow. Do not infer 2026 viability from a 2020 DEX-arbitrage anecdote.

### Sportsbook relative value

Requires licensed or terms-compliant odds histories with source/receive clocks, full outcome set, limits, stake rejection, account eligibility, vig, settlement/void rules and payout timing. Prediction-market books alone cannot backtest sportsbook execution. Start with one sport and one bookmaker only if data rights and account rules are clear.

## Data not worth buying yet

- A faster generic crypto price API: current event-driven Binance/Coinbase/Hyperliquid feeds already cover the tested horizons; no ablation shows a paid feed adds post-cost P&L.
- A generic sentiment score: it lacks causal source provenance and an executable benchmark.
- More historical midpoint candles: the bottleneck is executable depth, rule identity and resolver fidelity.
- Millisecond REST polling: use event-driven books; faster polling does not create queue or atomicity evidence.

No paid source should be purchased until a blinded source-ablation states the exact incremental decision, latency improvement, monthly cost and minimum post-cost P&L needed to pay for it.

## Retention policy

1. Bronze: immutable verified raw source events in Google Drive, with Parquet as a query projection rather than a replacement authority.
2. Silver: source-normalized event changes and causal clocks in Parquet; only the recent operational window in PostgreSQL.
3. Gold: one row per decision, transition, fill, terminal score, relationship proof or health failure—not a repeated recalculation every second.
4. Hot local reserve: at least 15 GiB free at all times; 10 GiB maximum verified Parquet cache; incomplete compaction work is disposable.
5. Research reads: DuckDB/Parquet or a replica, read-only and bounded. Never run unbounded analytics against ingestion PostgreSQL.
