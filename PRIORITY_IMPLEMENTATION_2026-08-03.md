# Priority research implementation — 3 August 2026

This change set implements the actions in
`QUANT_EDGE_REVIEW_2026-08-03.md`. It changes no authenticated or live-order
path. Every strategy below is paper-only, starts under a fresh experiment
identity and inherits no discovery P&L.

## Implemented controls

### Research isolation

All high-cost research scripts use a single read-only connection with bounded
statement and lock timeouts. They prefer `ANALYTICS_DATABASE_URL`, then
`RESEARCH_DATABASE_URL`, and only fall back to the primary `DATABASE_URL` when
no research copy is configured. This prevents a report from holding the hot
ingestion database behind a long analytical scan.

The primary shadow allowlist is now restricted to the unchanged H43 control,
H43-X and the exact longshot successor. Historical MAIN and discovery variants
remain immutable and reportable, but no longer generate fresh multiple-testing
rows in the priority epoch.

### H43-X resolver-tail successor

`H43X_chainlink_tail_residual_v1` requires:

- a market whose rule resolves from Chainlink;
- an opening reference captured from `chainlink_rtds_nearest_3s`;
- a current Chainlink RTDS tick no more than three seconds old;
- a frozen pre-cutoff empirical 99.5% terminal-move envelope with at least 300
  observations in the asset or pooled horizon bucket;
- a Wilson lower probability bound above the executable ask after doubled
  crypto fees and one token tick; and
- no more than $10 or 20% of displayed touch.

The strategy fails closed when the model artifact is absent, sparse, altered
or trained beyond `2026-08-03T12:37:57Z`. Build the deterministic artifact with:

```bash
npm run research:h43x-train -- \
  --cutoff 2026-08-03T12:37:57.000Z \
  --days 30 \
  --out /var/lib/deltaforge/models/h43x-resolver-tail-v1.json
```

H43 remains unchanged as a control. H43-X is a separately selected,
PROVISIONAL hypothesis requiring 300 fresh markets and 14 days.

### Exact MAIN longshot successor

`MAIN_LONGSHOT_0_20_V1` delegates to the unchanged 250 ms MAIN video-parity
taker rule and retains its first market intent only when the executable price
is at most $0.20. An excluded first intent still consumes the source rule's
one-intent-per-market state, so the wrapper cannot search later prices for a
favourable entry. The 29 discovery fills are disclosed and excluded.

### Typed Polymarket/Kalshi rules

Cross-venue V7 classifies every rule dimension as:

- `CERTIFIED_EQUAL` — eligible only when all dimensions have this state;
- `CERTIFIED_DIFFERENT` — hard mismatch and automatic veto; or
- `UNKNOWN` — retained in the review/collection queue but prohibited from the
  exact-rule paper experiment.

Missing wording is no longer falsely described as proof of difference. It is
still never permission to trade. V7 also preserves per-market Kalshi fee
metadata and synchronized 5/10/25-share depth replays.

### Exact-expiry Deribit residual

Options V4 admits only exact listed-expiry, A-fidelity bid/ask-IV surfaces as
executable evidence. Bounded term interpolation remains visible but carries
the barrier `TERM_INTERPOLATION_DIAGNOSTIC_ONLY`.

Raw Deribit, CLOB and resolver frames remain append-before-parse WAL events.
The derived PostgreSQL tier now stores initial state, stable barrier/surface/
executability transitions, 60-second executable heartbeats and five-minute
diagnostic heartbeats. A 250 ms dwell suppresses opportunities that cannot
survive the registered execution profile. This removes repetitive derived
rows without destroying deterministic replay.

### Archive/retention atomicity

Google Drive enumeration tolerates an already-receipted file disappearing
between directory traversal and metadata capture, treating it as omitted from
the new traversal rather than as proof. More importantly, the uploader and
local-retention process now share an exclusive filesystem lock for the entire
copy/hash/remote-verification interval, so retention cannot unlink a frozen
source inode while a new receipt is being constructed.

### Ordered-strike implication trial

The existing finite-state payoff compiler and orphan-safe kernel are retained.
Nested crypto thresholds now write a fresh
`structural-ordered-strike-orphan-safe-v1` identity. The bundle is:

```text
K_low < K_high
buy YES(S > K_low) + NO(S > K_high)
worst-state equal-share payout >= $1
```

It qualifies only after exact rule certification, full displayed depth,
doubled current fees, venue minimums and a reserve for the worst executable
incomplete-leg unwind. The passive arm receives no cancellation queue credit
and immediately crosses the hedge after every public-print-proved partial
fill. Run its read with `npm run research:ordered-strike`.

## Evidence and promotion contract

No positive discovery result is carried forward. A strategy remains
PROVISIONAL until its own manifest minimum is met and both chronological
halves, doubled-cost P&L, market/day clustered lower bounds, concentration
tests, multiple-testing correction and 100/250/500 ms profiles pass under a
shared $500 bankroll. Zero orders or approximately zero edge is an admissible
result. Thresholds must not be changed on the new cohort to manufacture P&L.

Only after a full paper pass may a separate review authorize 50 authenticated
$1–$2 fills. This implementation does not grant that authorization.

## Deployment verification

The paper fleet was deployed to Dublin as release `98c4d02`. Evidence epoch
`priority-forward-2026-08-03-v19` began at `2026-08-03T13:20:03.780Z` and is
`PENDING_24H`. Its first four recorded samples were `PASS`; all required
collectors were active, the Google Drive receipt was fresh, disk reserve was
approximately 39.5 GiB, and the three active strategies had current runtime
registrations with zero evaluation errors. No authenticated/live executor was
enabled or changed.

## Master edge-discovery extension — 3 August 2026, 15:42 UTC

The broader research mandate is now implemented as a bounded ten-lane funnel rather than another strategy zoo. `EDGE_MECHANISM_MAP.md` registers and scores 118 materially distinct mechanisms. `TOP_EDGE_EXPERIMENTS.md` freezes ten selected lanes and records a disposition and reopening gate for every one of the 108 non-selected mechanisms. Every selected experiment now has a root-level content-hashed manifest; all are paper, scanner, collection or observation only and every live-order path is disabled.

Two cheap falsifications completed without manufacturing trades:

- R07 resolver timestamp precision scanned 87,729 rule documents and found zero machine-certifiable terminal-tick units, zero proved episodes and $0 executable capacity under the current wording.
- N09 semantic proposal parsed 19,848 immutable rules and produced 998 abstract within-event implications, but zero novel cross-event, rule-certified or executable relationships. AI output remains proposal-only and cannot certify a payoff or submit an order.

The verified replay lake is active as an isolated research service. Batches `76ba651b576861e5dfcc0dd5be44f009` and `1485186d236e2a5712fe5c36117c2a4b` SHA-verified 50 raw WAL segments, reconstructed 2,255,941 causal envelopes, wrote 23 ZSTD Parquet partitions, uploaded them directly from the VPS to Google Drive and passed remote checksum plus DuckDB readback across 19 source families. Runs are bounded to 25 segments/128 MiB compressed, reserve 24 times input working space, preserve at least 15 GiB free and cap the local verified cache at 10 GiB. State, receipt and staging paths are service-owned; a verified checkpoint can recover its receipt after a process interruption.

The second run initially exposed a replay-parser defect rather than source corruption: Node `readline` split a valid JSON string at Unicode paragraph separator `U+2028`. Byte-level decompression and SHA verification proved the 30,908-event source object intact. Research release `15c11c9` now uses strict LF-byte NDJSON framing in Parquet, WAL recovery and historical replay tools. Genuinely invalid checksum-stable objects have a content-addressed quarantine and catalog warning; the current quarantine count is zero, so no evidence was silently discarded.

The web dashboard is now a separate dashboard-only process on loopback port 3014, release `1e5021f`. Caddy routes the public TV2 URL to it. `BOT_RUNNER_ENABLED=false` is enforced in `ExecStart`, after a pre-traffic test caught that the shared environment file otherwise overrides service-level values. The original TV2 runner and BORG collector remain release `98c4d02`, PIDs 408248/408247, with zero restarts since the v19 epoch began. This lets read-only research UI releases change without contaminating the collector process or evidence identity.

At 16:22 UTC the final full platform acceptance check passed with no criticals or warnings: core feed freshness was below five seconds, sampled CLOB/external provenance was 100%, local database RTT median was 0.43 ms, the Google Drive receipt was fresh and disk reserve was 36.66 GiB. After the replay-framing regression work, the complete repository suite passed 612/612 tests. At 16:20 UTC the fresh shared-bankroll portfolio remained negative (-$42.64 at $500 and -$43.71 at $1,000 after doubled costs); no strategy is a promotion candidate.

### Deployment and rollback record

- Production collector/runner: unchanged `/opt/deltaforge/tv2/releases/98c4d02`; epoch `priority-forward-2026-08-03-v19` remains continuous.
- Research tools: `/var/lib/deltaforge/research-tools/current` points to isolated release `15c11c9`; the Parquet timer invokes this path without restarting TV2.
- Dashboard: `/opt/deltaforge/tv2-dashboard/current` points to release `1e5021f`; `deltaforge-tv2-dashboard.service` is enabled and Caddy proxies TV2 to `127.0.0.1:3014`.
- Dashboard rollback: restore `/etc/caddy/Caddyfile.pre-dashboard-20260803`, validate/reload Caddy, then stop `deltaforge-tv2-dashboard.service`. The untouched port-3004 runner continues serving the prior dashboard throughout.
- Parquet rollback: stop/disable `deltaforge-parquet-lake.timer`, point `/var/lib/deltaforge/research-tools/current` to the prior release, and leave verified Google Drive objects/state intact. Incomplete staging is disposable; verified objects and manifests are immutable.
