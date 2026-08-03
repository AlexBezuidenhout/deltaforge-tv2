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
