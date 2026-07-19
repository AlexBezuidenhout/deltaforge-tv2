# DeltaForge fleet audit — 2026-07-16

Audit snapshot: 2026-07-16 21:22 UTC. This report separates process health,
paper-simulation validity, and evidence of profitability. A process can be
working exactly as designed while correctly producing no trades or negative
research results.

## Executive conclusion

The fleet is operational and safely paper-only, but no strategy currently
meets the pre-registered standard for live capital. All 61 BORG strategies are
registered; 54 had an eligible market and were evaluating at the final check,
with no missing, stale, zero-eligible, or errored strategy. The strict
promotion report examined 109 registered arms and found zero arms eligible for
even a tiny live-canary review. The shared-$500 prospective evaluation
simulation ended at $155.38, a loss of $344.62. This is materially less
favourable than isolated per-bot balances and is the correct portfolio-level
read because it prevents strategies from reusing the same money, market, and
displayed liquidity.

Simply reversing losing BORG signals is not a profitable shortcut. An
executable inverse autopsy examined 17,607 modern candidate orders and found
zero inverted strategies that survived executable opposite asks, latency,
displayed depth, fills, 2x fees, chronological halves, a market-clustered lower
confidence bound, and Holm correction for all strategies inspected. No bot was
inverted or promoted.

## Operational acceptance

| Check | Final result |
|---|---:|
| TV2, DF2, BORG collector, all-market lab, Flow Lab, structural scanner, cross-venue lab, GLA mirror | Active, zero restart loops |
| Runtime audit | PASS |
| BORG registry | 61 expected / 61 registered |
| Strategies with an eligible market at snapshot | 54 |
| Missing / stale / errored | 0 / 0 / 0 |
| Core feed/table freshness | approximately 3–9 seconds |
| Local PostgreSQL query RTT | 0.424 ms median, 0.989 ms p95 |
| All-market internal reaction | 0.336 ms p50, 40.809 ms p95 |
| Free VPS disk | approximately 72 GB |
| Off-host archive | successful, source-cutoff receipt verified; 15-minute schedule |
| Automated tests | 162 passed, 0 failed |
| Live-order capability in BORG/Flow/all-market/cross-venue | Absent |
| DF2 / MAIN / George | paper trading |
| GLA executor | dry-run paper mirror |

The platform acceptance check is `DEGRADED`, not failed, solely because 3,936
immutable historical scores predate simulator-version stamping. New scores are
versioned. Rewriting those old rows would manufacture provenance and was not
done.

The current collection cohort is explicitly tagged
`dublin-local-pg-2026-07-16-v1`. It must not be pooled blindly with the older
Mac/remote-Neon latency regime.

## Profitability review

### Portfolio-level BORG result

The isolated strategy balances are not additive: every strategy starts from a
virtual $500 and can claim the same liquidity. The shared-capital simulator is
the decision-relevant result.

| Cohort | Start | End | P&L | Admitted positions | Win rate | Max drawdown |
|---|---:|---:|---:|---:|---:|---:|
| Prospective evaluation | $500.00 | $155.38 | **-$344.62** | 523 | 52.20% | -$377.22 |
| Pilot machinery | $500.00 | $190.21 | **-$309.79** | 1,734 | 43.48% | -$383.63 |

The evaluation portfolio lost despite winning slightly more often than it
lost. That is consistent with paying too much for winners and/or suffering
larger binary losses than gains; win rate alone is not edge.

### Registered evaluation arms

These rows use forward evidence dates, independent markets, A/B data-quality
screening, market-clustered confidence intervals, 2x costs, chronological
halves, and Holm family-wise correction across 109 arms.

| Strategy | Independent markets | Days | 2x-cost P&L | Clustered 95% interval | Verdict |
|---|---:|---:|---:|---:|---|
| G_late_arb | 366 | 2 | **-$206.97** | [-0.9076, -0.0650] | Insufficient sample; currently negative |
| MAIN V2 resolver quorum | 229 | 1 | **-$292.47** | [-2.0593, -0.5173] | Insufficient sample; currently negative |
| MAIN V3 robust source envelope | 235 | 1 | **-$113.53** | [-1.3734, 0.4284] | Insufficient sample; unproven |
| MAIN V4 warm-vol consensus | 189 | 1 | **-$114.50** | [-1.5957, 0.3873] | Insufficient sample; unproven |
| T-240 four-state residual | 87 | 1 | **-$109.04** | [-2.2475, -0.2812] | Insufficient sample; currently negative |
| ETH late taker | 24 | 2 | **+$6.40** | [-1.3406, 1.8077] | Insufficient sample; unproven |
| ETH late maker | 12 | 2 | **-$7.81** | [-1.9523, 0] | Insufficient sample |

Promotion-ledger totals: 73 arms are pilot-only and not evidence, 21 are
negative controls, 7 are insufficient-sample evaluation arms, 3 are
feature-only, 2 require redesign, 2 have invalidated cadence, and 1 is a
cost-fragile control. Zero passed.

### MAIN and George

- MAIN's old quote-relative paper executor is retired and is now a telemetry
  control. Its fresh executable-fill cohort is 82 trades, 40.2% wins and
  -$110.02. MAIN V2–V4 are the actual forward successors; all are negative at
  2x costs above.
- George's invalid legacy source is retired. Its dashboard balance of $509.38
  is not proof of edge; the resurrection cohort is 19 observations, 47.4%
  wins and -$56.58. Its RTDS successors H48 and H49 are also negative in pilot
  data. George remains telemetry-only.

### G_late_arb

The old pilot genuinely looked strong: 310 core fills, +$254.99 at 1x and
+$199.85 at 2x. The frozen evaluation did not reproduce it. Across all current
core evaluation rows it has 795 fills, -$231.10 at 1x and -$336.79 at 2x; the
strict forward ledger subset is -$206.97 at 2x. This is the classic reason a
pilot cannot authorize live trading.

HYPE is a separately pre-declared subcohort with 275 fills and +$71.45 at 1x.
It has not reached its own 300-fill read and cannot be selected after seeing
other assets lose. GLA therefore remains dry-run paper only.

### DF2

DF2 is active, receiving BTC and Chainlink prices, and writing decisions to its
own local PostgreSQL schema. Session 18 generated 147 filtered signals and no
trade at the audit snapshot. The dominant reasons were a BTC move below the
configured 0.015% minimum and a near-50-cent market with insufficient movement.
That is valid abstention, not a stuck bot.

Historical DF2 paper results are 63 closed trades, 31 wins, and **-$144.14**.
Close-reason attribution is:

| Close reason | Trades | Wins | P&L |
|---|---:|---:|---:|
| HARD_STOP_LOSS | 25 | 0 | -$368.00 |
| MARKET_RESOLVED_TIMEOUT | 2 | 1 | -$37.56 |
| MARKET_RESOLVED | 19 | 14 | -$22.51 |
| EV_FLIP | 1 | 0 | -$11.00 |
| PROFIT_LOCK | 16 | 16 | +$294.93 |

The exit-policy split is still tiny: `PROFIT_LOCK_ONLY` has 10/10 winners and
+$197.32, while `HOLD` has 10 trades and -$147.99. This is an experiment, not
a basis for selecting the winning arm after the fact. It must continue as a
frozen forward split before any policy conclusion.

### Flow, all-market making, structural, and cross-venue labs

- Flow V2 has only 27 A/B-grade evidence fills from 19 independent sweeps.
  Latency arms reuse the same triggers and cannot be summed. A few positive
  five-second markouts are far too small to establish edge.
- The all-market cost-confirmed taker correctly produced zero fills because no
  candidate survived its cost and execution checks. Its predictor control is
  negative at every latency arm. Passive maker variants have only four fills,
  all with negative five-second markout. This lab is functioning; the current
  result is “no demonstrated opportunity.”
- The structural scanner has live candidates and many displayed nested-threshold
  residuals, but **zero atomic-qualified bundles**. Displayed residual profit is
  not lockable profit when legs can fill separately.
- The Polymarket/Kalshi lab reviewed 15 candidate identities and rejected all
  15. With no approved identical contract it intentionally has zero monitored
  feeds and zero new trades. Historical leads had zero lockable observations.
  This is safe idling, not a feed failure.

## Why “flip every loser” does not work

For a binary market, the opposite outcome's executable ask is not
`1 - original fill price`. The relationship is closer to:

`YES ask + NO ask = 1 + two-sided spread and inventory premium`.

An inverse trade therefore pays another spread, its own slippage and fees, may
have different available depth, and may not fill at all. If the original
strategy's forecast is uninformative and its loss is transaction cost, both
directions lose. Adverse selection can also make both backtested sides look bad
because only quotes about to move against the order are available at arrival.

The executable inverse analysis preserved the original intended dollars and
price cushion, bought the complementary token from its recorded ask, used the
same information/order latency, walked displayed depth, modeled partial and
non-fills, charged 1x and 2x token fees, clustered by market, split time in
half, and corrected for searching many strategies.

Examples:

| Original strategy | Markets with usable inverse | Inverse 2x P&L | Key failure |
|---|---:|---:|---|
| G_late_arb eval | 135 | -$161.19 | Both halves/CI do not support inversion |
| MAIN V3 eval | 234 | -$246.66 | Clustered interval entirely negative |
| H14 robust VolScore | 509 | -$679.05 | Clustered interval entirely negative |
| H16 cross-asset VolScore | 239 | -$520.25 | Clustered interval entirely negative |
| H17 opening consensus | 228 | -$464.83 | Clustered interval entirely negative |
| H20 basis reversion | 41 | +$192.11 | CI lower bound -$0.17/market; Holm p=1; only 41 markets |
| MAIN V2 eval | 226 | +$55.80 | First half -$117.14, second +$172.94; Holm p=1 |

H20 is at most a discovery hypothesis for a separately frozen inverse paper
arm. Its inspected history must be excluded, and it would need at least 300
fresh independent markets plus a positive clustered lower bound in both time
halves. It is not evidence or live authorization.

## Defects fixed during this audit

1. Recovered collectors from a 20 GB WAL reserve restart loop. The immediate
   cause was more than 53 GB of reproducible local Parquet derivatives.
2. Added fail-closed retention: raw WAL can be removed only behind a recent,
   clean off-host source-cutoff receipt; reproducible Parquet has a short local
   lifetime.
3. Added bounded PostgreSQL hot-tier pruning and BRIN time indexes. Raw WAL,
   not SQL touch tables, remains the full-fidelity replay authority.
4. Sampled only the derived all-market SQL touches at 100 ms per token while
   preserving every raw event and every event-driven strategy evaluation.
5. Fixed an all-market poison batch where duplicate conflict keys caused the
   entire persistence buffer to retry forever.
6. Added collection epoch/run provenance to Flow, all-market, structural and
   cross-venue WALs.
7. Fixed Gamma research discovery's invalid `order=end_date` request. Gamma
   requires `order=endDate`; HTTP 422 warnings stopped and hourly/daily market
   discovery resumed.
8. Bounded acceptance-check scans, detected the production WAL root
   automatically, and measured warm database query RTT instead of including
   connection setup.
9. Migrated DF2 from remote Neon to its isolated local `df2` schema while
   retaining the final immutable dump and leaving Neon untouched as a backup.
10. Added the read-only executable inverse-signal autopsy. It has no order path
    and changes no strategy thresholds.

No strategy parameter was tuned from these results, no live-order call site was
changed, Gate 1 remains informational, Gate 2 remains primary, and paper mode
remains the default.

## Decision

Keep every current strategy in paper/shadow research. Do not reactivate GLA or
promote MAIN, George, DF2, Flow, all-market making, structural bundles, or any
BORG arm with real capital from this evidence. Continue the frozen forward
cohorts. A future candidate must clear its registered independent-market/day
minimum, positive 2x-cost P&L in both chronological halves, a positive
market-clustered lower confidence bound, and multiple-testing correction. A
valid final outcome remains that measured edge is approximately zero.

Reproducible commands:

```bash
npm test
npm run audit:runtime
npm run research:check
npm run research:promotion
npm run research:inverse
node scripts/g-verdict.js
```
