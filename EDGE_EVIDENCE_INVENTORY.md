# DeltaForge edge evidence inventory — 3 August 2026

Evidence cut-off: 3 August 2026, 13:57 UTC. Authoritative forward boundary:
`priority-forward-2026-08-03-v19`, started at
`2026-08-03T13:20:03.780Z` on release `98c4d02`. This is a paper-research
inventory, not permission to trade real money.

## Investment conclusion at this boundary

No strategy has demonstrated deployable positive expected value. The fresh
v19 cohort is operationally healthy but less than one hour old. The only
positive fresh line is H43-X at **+$0.63 after doubled costs over three A/B
fills**, all on one day; its Holm-adjusted result is non-significant and its
day-concentration gate fails. The fresh longshot successor has one loss of
**-$8.49**. These observations are useful because they are execution-honest,
not because their signs are yet informative.

## Admitted evidence layers

1. **Fresh confirmatory v19:** exact experiment identity, v19 epoch stamp,
   first independent market intent, joint A/B data and execution fidelity,
   terminal score and doubled costs. This is the only layer that can
   eventually contribute to promotion.
2. **Older A/B diagnostics:** row-level causally eligible fills from earlier
   epochs. These can motivate one successor but cannot be pooled into v19 or
   relabelled as confirmation.
3. **Discovery/legacy diagnostics:** post-hoc buckets, contaminated paper fills,
   B/C execution, arithmetic anomalies and old strategy variants. These remain
   queryable negative controls and selection-burden records.

Repeated ticks and orders are never treated as independent trials. Positive
win rate is not interpreted without entry-price payoff asymmetry. Strategy
variants that share markets, tape or capital are not summed.

## Fresh v19 statistical trials

| Strategy | Fresh A/B fills | Markets | Days | P&L 1x | P&L 2x | Read |
|---|---:|---:|---:|---:|---:|---|
| `H43X_chainlink_tail_residual_v1` | 3 | 3 | 1 | +$0.67 | **+$0.63** | Three wins; Wilson win-rate interval 43.9–100%; one-day concentration fails; Holm-adjusted p=1. |
| `MAIN_LONGSHOT_0_20_V1` | 1 | 1 | 1 | -$7.99 | **-$8.49** | One binary tail loss; too small to accept or reject, but discovery P&L is correctly excluded. |
| `H43_resolution_boundary_buffer` | 0 | 0 | 0 | $0.00 | **$0.00** | Unchanged control is evaluating but has no fresh eligible fill yet. |

All three runtime registrations were current and had zero evaluation errors at
the snapshot. A quiet strategy is not assumed stopped when its evaluator
heartbeat is fresh.

## Older mechanism evidence that may be reused only for hypothesis selection

| Mechanism | Admissible diagnostic | Binding failure |
|---|---|---|
| H43 resolver boundary | Strict A/B: 26 fills, 26 markets, six days, +$14.70 at 2x costs. | Under 300/14-day minimum; day concentration is severe; current v19 control has no fill. The broader +$36.48 line includes lower execution fidelity. |
| MAIN deep longshot discovery | 29 post-hoc 0–20 cent fills, +$95.62 at 2x costs in the prior audit. | Selected after inspecting buckets and 142 current strategy/phase arms; seven tail wins drive it. Only the fresh frozen successor counts now. |
| H54 dynamic OFI/resolver | Historical current-identity diagnostic +$34.68 over 13 A/B fills and six days. | One prior market dominated; slower replay failed in the formal audit; not active in the focused v19 fleet. |
| H45 threshold velocity | Historical diagnostic +$18.39 over 19 A/B fills and eight days. | Prior second half and latency cells failed; no untouched evidence in v19. |
| H52 hourly near-even favorite | Historical diagnostic +$55.34 over 65 fills on one day. | Accidental five-minute routing; exact successor failed out of sample. Status `REJECTED_OUT_OF_SAMPLE`. |
| H40 entropy breakout | Historical diagnostic +$45.24 over 25 markets. | Forward/cluster evidence failed; retained as protocol-completion control only. |

The complete 142-arm table, including negative and zero lines, is retained in
the machine snapshot. No historical positive line currently passes the
promotion contract.

## Deterministic and cross-market lanes

### Ordered-strike payoff graph

`structural-ordered-strike-orphan-safe-v1` evaluated roughly 2,300 observations
at each of 20/50/100/250/500 ms across nine current candidates. Payoff and rule
proofs passed, but **zero** observations were arithmetic-economic and **zero**
were orphan-safe. Best orphan-safe residual was approximately **-$0.1102**.
No passive quote qualified. This is a valid falsification result; proof, fee or
orphan gates must not be weakened to manufacture activity.

### Polymarket/Kalshi

`crossvenue-exact-rule-convergence-v7` has **zero entries, zero realized
episodes and zero pair-direction-days**. It therefore has no P&L conclusion.
The collector is functioning; rule certification remains the bottleneck.
Risky convergence is a separate statistical product and is never described as
risk-free. The current common-opportunity read saw 907 observations across
nine pairs, no trade-eligible episode, and a best approved stressed residual
of **-$0.175**.

### Options-implied binaries

The V4 collector had captured 129,265 Deribit touches across 151 instruments
since its evidence start. It produced 28,256 B-grade term-interpolated marks,
but **zero exact-expiry A-grade marks and zero executable observations**. Its
modeled P&L is therefore correctly $0 rather than an interpolation backtest.

### Fair-bound passive making

The 20-market neglected panel is capture-only. Generic maker controls remain
negative: the two all-market controls showed approximately -$1.87 and -$24.00
at five-second markout, while paired making lost roughly $3,064 before any
unearned reward claim. No quote may be generated until an independent fair
bound exists.

## Reusable cohorts and invalid shortcuts

The following are reusable:

- v19 raw WAL and normalized rows after the exact epoch start;
- verified raw objects selected by checksum and reconstructed causally;
- H43's older strict A/B rows for mechanism diagnostics only;
- the longshot discovery bucket solely as the disclosed reason for the frozen
  successor;
- typed rule snapshots, deterministic payoff proofs and negative execution
  economics as scanner validation.

The following are not reusable as confirmatory P&L:

- synthetic-book MAIN fills, lower-fidelity H43 rows, failed evidence epochs,
  interpolated options marks, asynchronous cross-venue snapshots, public-print
  maker fills, and any old strategy line selected after viewing its P&L;
- inverse versions of losing strategies unless the opposite executable trade
  is replayed separately with its own payoff and fee asymmetry;
- a portfolio formed by adding mutually exclusive or liquidity-competing arms.

## Reproduction

Run on the research host with the read-only research pool:

```bash
npm run research:profitability -- --json
npm run research:neglected-edge
npm run research:crossvenue-exact -- --days=30
npm run research:ordered-strike
npm run research:options-surface -- --json
npm run research:resolver-boundary -- --json
```

The immutable raw outputs and their SHA-256 values are listed in
[`research/snapshots/2026-08-03/README.md`](research/snapshots/2026-08-03/README.md).

