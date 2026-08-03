# Priority research lanes

This is the active money-finding programme. It separates four forward paper
experiments from one capture-only prerequisite. None of these processes has a
wallet, signer or live-order path.

| Priority | Programme | Runtime contract | Frozen experiment | Promotion unit |
|---:|---|---|---|---|
| 1 | Resolver-boundary transfer | H43 runs unchanged inside the BORG shadow engine | `research-h43-forward-v1` | first order per independent market |
| 2 | Certified payoff graph | deterministic rule snapshots, finite-state payoff proof, synchronized executable depth, full orphan reserve and a queue-aware passive arm; nested crypto strikes receive a fresh dedicated evidence identity | `structural-certified-payoff-graph-v5-orphan-reserve` + `structural-ordered-strike-orphan-safe-v1` | certified event/candidate |
| 3 | Rule-aware Polymarket/Kalshi | complete exact-rule keys only; proven conflicts are hard vetoes and missing fields remain non-trading review items | `crossvenue-exact-rule-convergence-v7` | first pair/direction/UTC day |
| 4 | Deribit options-implied residual | exact-expiry A-fidelity surfaces only for evidence; bounded interpolation is diagnostic and unsupported extrapolation fails closed | `options-exact-expiry-residual-v4` | first market/side observation |
| 5 | Fair-bound passive making | **capture only** on a frozen, PnL-independent neglected-market panel; quote signals are disabled | `fair-bound-passive-overlay-v1` (staged) | no evidence until a certified bound exists |

## Runtime boundary

`borg-allmarket.service` captures 20 category-balanced neglected markets under
`neglected-capacity-panel-v1`. Membership is frozen by collection epoch and is
selected without historical PnL, win rate or toxicity. It records public CLOB
events and prints for later queue replay. `ALLMARKET_STRATEGY_SIGNALS_ENABLED`
remains `false`: the negative generic-maker and paired-complete-set controls are
not restarted, and no fair-bound quote is manufactured from midpoint,
imbalance, last trade or reward estimates.

The fair-bound arm may become active only after an independently certified A/B
lower bound maps to a current Polymarket token. Its registered benchmark is:

```text
fair lower bound
- non-crossing executable quote
- 2x current fees
- one adverse unwind tick
- back-of-queue/partial-fill cost
- full failure-risk reserve
> 0
```

## Evidence standard

Every lane remains provisional until its manifest's independent-unit and day
minimums are met. The common promotion floor is at least 300 fresh independent
units, both chronological halves positive at 2x costs, clustered lower bounds
above zero, Holm correction, realistic depth/non-fills, and positive results at
100/250/500 ms using a shared $500 bankroll. A zero-candidate or zero-edge
result is valid and must not trigger threshold tuning on the same cohort.

The dashboard exposes the current five-lane state at
`/api/borg/research/priority-lanes` and in Book Lab. The command-line equivalent
is `npm run research:priority-lanes`.

Cross-venue V7 uses exactly five shares, a provisional +1% executable
liquidation target and a one-hour maximum hold. It also records explicit
5/10/25-share capacity failures and the observed Kalshi series fee schedule.
Run its forward read with `npm run research:crossvenue-exact -- --days=30`.

The structural passive arm is intentionally C-grade: public prints consume a
frozen queue-ahead and each partial fill is hedged at current asks, but public
data cannot prove authenticated queue position or cancel acknowledgement.

## Current evidence epoch

The authoritative cohort is `priority-forward-2026-08-03-v19`, started at
`2026-08-03T13:20:03.780Z` on immutable release `98c4d02`. Its first four
health samples passed with no sequence, persistence or archive errors and all
three active shadow strategies registered and evaluating. It is
`PENDING_24H`, not clean evidence yet. The superseded v18 startup is rejected:
its health process reconstructed the old 38-strategy fleet instead of reading
the collector's frozen three-strategy allowlist. v19 persists that allowlist
inside the collector-run record and validates the same contract.

At startup, typed cross-venue certification contained 11,193 `UNKNOWN`, 1,219
`CERTIFIED_DIFFERENT` and zero `CERTIFIED_EQUAL` identities. Unknown rules stay
blocked. Options V4 had zero exact-expiry targets, so its 44 term-interpolated
targets remain diagnostic. The Pyth public RTDS transport was connected but
returned no equity ticks even for the official single-symbol example; the lane
is therefore visibly degraded and cannot contribute evidence until the
external stream resumes.
