# Edge portfolio report

Generated 2026-08-03 16:20 UTC. Evidence epoch `priority-forward-2026-08-03-v19` began at `2026-08-03T13:20:03.780Z` on production release `priority-research-v14` / deployed code `98c4d02`.

This report uses only fresh-epoch rows, joint A/B data-and-execution fidelity, doubled costs, shared capital and recorded displayed fill capacity. It is paper research, not live-trading authorization.

## Fresh statistical lanes

| Lane | A/B fills | Markets | Days | 2× P&L | First / second half | Market-cluster LCB | Holm p |
|---|---:|---:|---:|---:|---:|---:|---:|
| Resolver Chainlink tail V1 (`H43-X`) | 18 | 18 | 1 | **-$16.21** | -$18.53 / +$2.31 | -$2.61 | 1.0000 |
| MAIN longshot successor | 3 | 3 | 1 | **-$27.23** | -$8.49 / -$18.74 | -$11.15 | 1.0000 |

Neither result is statistically mature. H43-X's initial positive three-fill line reversed as the untouched cohort accrued; that is evidence against treating the discovery effect as stable. The longshot control has begun with three large tail losses. Both remain frozen so the predefined read can continue without threshold rescue.

## Shared-bankroll doubled-cost replay

The two strategy arms can target the same market. The shared simulator assigns one owner per market, does not reuse displayed liquidity and does not upscale beyond captured fill size.

| Capital | Horizon | Admitted / settled | 2× P&L | End balance | Max drawdown | Average gross-limit use |
|---:|---:|---:|---:|---:|---:|---:|
| $500 | 6h | 20 / 20 | **-$42.64** | $457.36 | -$43.40 | 34.54% |
| $500 | 24h | 20 / 20 | **-$42.64** | $457.36 | -$43.40 | 34.54% |
| $500 | 7d | 20 / 20 | **-$42.64** | $457.36 | -$43.40 | 34.54% |
| $1,000 | 6h | 20 / 20 | **-$43.71** | $956.29 | -$44.49 | 17.90% |
| $1,000 | 24h | 20 / 20 | **-$43.71** | $956.29 | -$44.49 | 17.90% |
| $1,000 | 7d | 20 / 20 | **-$43.71** | $956.29 | -$44.49 | 17.90% |

All three horizons contain the same v19 cohort because the epoch is only about three hours old. This is not seven days of evidence. The small difference between capital cases comes from using more of already-recorded displayed size in the $1,000 scenario; no unobserved depth is invented.

## Deterministic and collection lanes

| Program | Runtime | Current state |
|---|---|---|
| Resolver-boundary transfer | Active | Forward actions collecting; no promotion evidence |
| Certified payoff graph | Active | Zero economic/orphan-safe qualified candidates |
| Rule-aware cross-venue | Active | Zero complete exact-rule keys |
| Options-implied binary | Active | Targets active; zero executable A-grade marks |
| Fair-bound passive overlay | Capture only | Strategy deliberately disabled until an independent lower bound exists |
| Resolver timestamp precision | Completed falsification | 87,729 rules scanned; zero certified timing units and $0 capacity |

## Investment conclusion

No lane currently meets the promotion contract and there is no evidence of deployable edge. The present fresh portfolio lost about $43–$44 after doubled costs, while deterministic lanes found no executable lock. H43-X remains the most defensible statistical mechanism but its clean cohort is now negative; continued unchanged collection, rather than retuning, is the correct test. $100/day on $500 is a 20% daily return and is not a planning assumption.

Reproduce the live report with:

```bash
npm run research:edge-portfolio
```
