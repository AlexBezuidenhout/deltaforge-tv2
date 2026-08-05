# MAIN/MBots regime and performance audit — 5 August 2026

## Executive finding

MAIN is not currently demonstrated profitable. The apparently profitable legacy history predates the executable-book repair and does not survive honest post-repair execution accounting. Every previously deployed MAIN/BORG reconstruction is negative after actual or replayed asks, doubled fees and a one-tick stress. Market behaviour can be separated causally into useful descriptive modes, but no mode has yet shown a bankable executable edge. Legacy MAIN execution therefore remains disabled while a frozen, matched paper experiment compares the unchanged video-parity control with a selective regime/residual challenger.

This change improves measurement and prevents known-bad trades. It does not manufacture or claim alpha.

## Evidence boundaries

- Executable-book repair: `2026-07-15T22:26:55.888Z`.
- Current clean collection epoch: `worthy-forward-2026-08-04-v34`, beginning `2026-08-04T08:55:02.890Z`.
- Independent unit for legacy calibration: first `TRADE` intent per resolved market.
- Clean replay: nearest BORG book at or after 250 ms, at least $10 available at touch, actual ask plus one tick, and doubled `7% * p * (1-p)` crypto taker fees.
- Clean replay is a conservative diagnostic, not proof of authenticated fills. It currently spans only two days.
- All PostgreSQL decimal values are converted to numbers before arithmetic.

## Historical MAIN performance

| Cohort | Trades | Independent markets | Wins | Net PnL | Return on staked capital |
|---|---:|---:|---:|---:|---:|
| Before executable-book repair — contaminated | 470 | 457 | 282 | +$805.94 | +16.11% |
| After executable-book repair — usable | 82 | 82 | 33 | -$110.02 | -14.64% |

The sign reversal is decisive. The old positive balance is not reliable evidence of edge because its fills and executable-price assumptions precede the repair.

## MAIN/BORG executable results

All values below use doubled fees plus a one-tick stress.

| Strategy | Fills | Days | Win rate | PnL | First half | Second half | Clustered 95% CI per fill |
|---|---:|---:|---:|---:|---:|---:|---:|
| MAIN V2 resolver quorum | 598 | 5 | 45.99% | -$561.20 | -$351.34 | -$209.86 | [-$1.44, -$0.45] |
| MAIN V3 source envelope | 2,098 | 5 | 38.70% | -$1,579.20 | -$898.21 | -$680.99 | [-$1.04, -$0.47] |
| MAIN V4 temporal consensus | 1,457 | 5 | 37.34% | -$1,092.79 | -$658.52 | -$434.28 | [-$1.10, -$0.39] |
| Video parity, taker 250 ms | 1,367 | 8 | 54.65% | -$1,104.72 | -$783.19 | -$321.53 | [-$1.29, -$0.32] |
| Video parity, post-only | 1,560 | 8 | 47.56% | -$906.85 | -$437.27 | -$469.58 | [-$0.96, -$0.19] |
| MAIN longshot successor | 20 | 3 | 10.00% | -$66.17 | -$88.94 | +$22.77 | [-$9.29, +$4.88] |

The post-only arm loses less than the taker arm, but its confidence interval remains wholly below zero. This does not justify live passive making.

## Forecast calibration

The post-repair calibration cohort contains 24,269 resolved markets over 22 days.

| Probability source | Brier score | Log loss |
|---|---:|---:|
| Executable market quote | 0.237524 | 0.668082 |
| Phi model | 0.331742 | 1.350881 |
| Heuristic | 0.228403 | 0.649339 |
| Ensemble | 0.228403 | 0.649339 |
| Frozen market-offset residual | 0.228924 | 0.650528 |

The heuristic/residual has some probability-calibration information relative to the market midpoint, especially in `LAG_EDGE`, but calibration improvement is not tradable edge. The ask, spread, fees, depth and selection cost consume more than that improvement.

## Clean executable replay

The current clean epoch produced 947 executable independent markets from 1,467 candidate observations over two days:

- Win rate: 65.68%.
- PnL: **-$670.57**.
- First half: -$295.07; second half: -$375.50.
- Mean PnL: -$0.708 per fill.
- Market-clustered 95% interval: [-$1.184, -$0.234] per fill.

Every scenario was negative. A high binary win rate is compatible with large losses because MAIN often buys expensive favourites: the payoff asymmetry, executable ask and fees matter more than hit rate.

## Causal market modes

`MainMarketRegime` now classifies only information available at decision time, using the existing scenario plus ATR/ADX trend state. It does not inspect future outcomes or PnL.

| Mode | Interpretation | Current policy |
|---|---|---|
| `DATA_UNREADY` | Missing/stale indicators | Observe only |
| `CHOP` | Weak/noisy directional structure | Observe only |
| `DIRECTIONAL_IMPULSE` | Short impulse aligned with usable trend context | Frozen residual executable-hurdle paper test |
| `ESTABLISHED_TREND` | Trend already reflected/extended | Observe only |
| `VOLATILITY_TRANSITION` | Rapid volatility expansion | Requires a separately validated uncertainty envelope; currently observe only |
| `TREND_DECAY` | Momentum fading | Observe only |
| `REVERSAL_RISK` | Signal/trend conflict or fake-breakout state | Observe only |
| `BASELINE` | No special causal state | Observe only |

The clean replay remained negative in every mode. `DIRECTIONAL_IMPULSE` was least bad, not profitable: 362 fills, 68.78% wins, -$164.73, with a confidence interval spanning zero. A retrospective residual filter was also negative: 428 fills over eight days, -$417.44, both halves negative, clustered interval [-$1.66, -$0.30]. It is explicitly labelled in-sample selection evidence and cannot validate the new arm.

## Changes implemented

1. Added causal regime classification and policy mapping in `src/bot/MainMarketRegime.js`.
2. Extended the frozen market-offset challenger to measure directional residual edge against the actual executable ask after doubled fees and one tick.
3. Persisted indicator state, mode, policy, model version, executable YES/NO asks and capacity, challenger direction, edge and eligibility on every MAIN signal.
4. Added `scripts/main-regime-autopsy.js` for reproducible legacy, calibration, clean-replay, mode and challenger analysis.
5. Added matched paper arms:
   - `MAIN_REGIME_CONTROL_V1`: unchanged executable video-parity source.
   - `MAIN_REGIME_RESIDUAL_V1`: consumes the same first source intent, retaining it only in `DIRECTIONAL_IMPULSE` when the frozen residual agrees and clears conservative executable costs.
6. The first source intent is consumed even when the challenger rejects it, preventing later-quote cherry-picking.
7. Added a frozen experiment manifest, dossiers, active policy registration and automated tests.

No live-order call site was changed. Gate 1 remains informational. Gate 2 remains the primary filter. No existing threshold was tuned from these outcomes.

## Forward experiment and promotion rule

Both arms began at zero on `2026-08-05T17:23:27Z` and are `COLLECTING` in paper mode. Required evidence:

- At least 300 fresh independent markets per arm and at least 14 calendar days.
- Positive doubled-cost PnL in both chronological halves.
- Market/day-clustered lower confidence bound above zero.
- Positive incremental PnL versus the matched unchanged control.
- Holm multiple-testing correction.
- Positive replay at 100, 250 and 500 ms.
- Realistic depth, partial/non-fill and shared-$500-capacity results.
- No dominant asset, market or day.

If those criteria fail, MAIN stays disabled. The expected honest null is approximately zero or negative edge.

## Deployment status at handoff

- Release: `bb4727a`.
- `deltaforge-tv2`, dashboard and BORG collector: active.
- Runtime audit: `PASS`, no critical findings or warnings.
- Both arms are registered, evaluated and error-free.
- `paper_trading=true`; legacy MAIN paper execution remains disabled.
- All real-money strategy flags remain disabled.

