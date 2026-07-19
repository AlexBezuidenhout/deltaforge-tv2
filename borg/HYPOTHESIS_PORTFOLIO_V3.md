# BORG H14-H21 Research Portfolio

Created: 2026-07-15. Status: **PROVISIONAL FORWARD SHADOW PILOT / NO LIVE PATH / NOT PROFITABILITY EVIDENCE**.

These eight experiments extend BORG's mechanism-diverse shadow portfolio. They cannot submit an order: the modules have no wallet, signer, CLOB client, or import from the live executor. They emit intended orders to `borg_shadow_orders`, where the existing scorer waits 1.25 seconds and requires executable recorded depth at or below the submitted limit.

No threshold was selected from the current trade PnL. Parameters are broad mechanism discriminators: 2x published taker fees, at least two additional token ticks of residual edge, 2.5 robust-z for statistical anomalies, and execution-safe time bands. Every value is **PROVISIONAL** until frozen; a later change creates a new experiment and resets the evidence clock.

## What the Barclays report actually contributes

The reviewed source is Barclays, *U.S. Equity Derivatives Strategy: Impact of Retail Options Trading*, 14 September 2020. Relevant findings are on pages 12 and 19-21 of the [report PDF](https://amarketplaceofideas.com/wp-content/uploads/2021/08/Barclays_US_Equity_Derivatives_Strategy_Impact_of_Retail_Options_Trading.pdf).

The transferable lessons are narrower than “sell expensive volatility”:

1. Heavy speculative options activity raised short-dated implied volatility, but future realized volatility also rose. The volatility risk premium did not expand uniformly. Activity alone was not an edge.
2. Barclays selected cross-sectionally rather than shorting every high-volatility name. Its VolScore combined a stock-versus-sector implied-volatility spread with implied versus **adjusted** realized volatility.
3. Ordinary realized volatility was considered unreliable for this selection because a single large move can dominate the measure without representing persistent future volatility.

TV2 cannot reproduce a delta-hedged equity straddle with one 5-minute binary. The valid transfer is measurement methodology: estimate persistent realized variation robustly, infer the terminal variance embedded in the binary price, compare assets cross-sectionally, and trade only when an executable probability discrepancy remains. H14-H16 test exactly those propositions. They do not assume an equity volatility premium exists in Polymarket.

## Shared execution and evidence rules

- Shadow only; no live execution path exists.
- All takers use `execution_model=latency_1s`: the scorer waits 1.25 seconds and walks only surviving recorded asks at or below the original limit.
- Intended size is at most $10, no more than 20% of displayed touch, and no dust order below $1.
- Every intended order must retain at least 2 cents of probability edge after **2x** the current crypto taker fee curve.
- CEX volatility pilots exclude HYPE because its one-second Hyperliquid polling path does not expose the same completed-bar volatility profile.
- One intended order per strategy/market limits repeated-signal dependence. Statistical inference must still cluster by 5-minute window/day and common market event.
- All rows begin in `phase='pilot'`. Pilot rows validate machinery and starvation; they never enter a later evaluation result.
- Evaluation requires the longer of 500 fresh scored fills or 14 days after a frozen commit, both chronological halves positive, positive expectancy at 1x and 2x costs, and the global multiple-testing correction across every evaluated strategy family.

## The eight hypotheses

| ID | Root | Mechanism | Minimum tier | Principal falsifier |
|---|---|---|---|---|
| `H14_robust_volscore` | R5 | Infer the five-minute sigma embedded in a complement-consistent binary price and compare it with MAD-adjusted realized sigma | H | Binary-implied sigma is just noisy directional pricing; adjusted sigma does not improve fair probability |
| `H15_jump_adjusted_sigma` | R5/R2 | A single jump leaves EWMA sigma high after spot stabilizes, pulling Phi too close to 0.5; robust sigma may price the already-leading side better | H | Jumps cluster, so suppressing the first jump understates exactly the tail risk the market prices |
| `H16_cross_asset_volscore` | R5/R4 | Select extreme implied/robust-volatility ratios relative to contemporaneous crypto peers, analogous to stock-versus-sector VolScore selection | H | Cross-asset ratios are incomparable because assets have different jump/resolution microstructure |
| `H17_opening_basis_consensus` | R1 | Binance and Coinbase returns from their own captured window opens agree, reducing resolver-source basis risk | H | Both public venues still diverge from the Chainlink Data Stream at the decisive boundary |
| `H18_adaptive_beta_lag` | R1 | Estimate rolling BTC beta; trade only a 2.5-sigma alt catch-up gap rather than assuming one-for-one propagation | V | Any lead-lag is consumed before TV2's 1.25-second order-arrival model |
| `H19_clob_only_jump_fade` | R4 | Both complement books reprice together while spot and Phi stay flat, indicating prediction-market-specific attention/flow that may mean-revert | H/V | The CLOB move contains private/informed flow and fading it is adverse selection |
| `H20_cross_venue_basis_reversion` | R1/R5 | Binance and Coinbase window returns diverge, then begin converging; price the terminal event from their normalized consensus rather than Binance alone | V | The venue leading the divergence is informative and the average is a worse resolver proxy |
| `H21_complement_desync` | R1/R5 | One token book moves while the other token's economically equivalent UP probability and Phi remain stable | V | The apparent lag is an incomplete/damaged CLOB tape or disappears before executable arrival |

Tier H means the proposed information should persist long enough to test at roughly one-second collection and home latency. Tier V means the mechanism plausibly decays on a sub-second-to-few-second horizon; the current 1.25-second shadow model can reject slow survivability but cannot establish a 2 ms edge. Tier V claims remain provisional until the high-fidelity CLOB collector and measured VPS replay described in `RESEARCH_PLATFORM_AUDIT.md` are complete.

## Feature definitions

### Robust realized sigma

`BinanceRecon.getVolatilityProfile()` uses completed one-second bars only. Over a causal 120-second window it computes:

- existing 60-second-time-constant EWMA five-minute sigma;
- ordinary RMS five-minute sigma;
- median-absolute-deviation sigma, scaled by 1.4826 and `sqrt(300)`;
- the fraction of total squared return variation attributable to the largest one-second return.

The MAD series is not declared “true volatility.” It is a persistent-variation control that intentionally reacts less to one outlier. `maxVarianceShare` preserves the removed jump information so H15 can explicitly require, rather than hide, jump concentration.

### Binary-implied sigma

TV2's existing model is:

```text
P(UP) = Phi((spot - strike) / (strike * sigma5m * sqrt(tte / 300)))
```

H14/H16 invert this convention only when price and spot displacement imply the same direction and market probability is inside `[0.02, 0.98]`. UP midpoint and `1 - DOWN midpoint` must agree within eight cents. Invalid, boundary, direction-inconsistent, or near-0.5 inversions abstain.

### Cross-sectional VolScore

H16 uses `log(binary_implied_sigma / robust_realized_sigma)`. A target must be at least 2.5 robust standard deviations from the fresh peer median, where scale is `1.4826 * peer MAD`, with at least four peers. This is a generic outlier discriminator chosen before forward results, not a fitted alpha threshold.

### Adaptive beta

H18 pairs causal one-second BTC and target returns, estimates rolling covariance beta from at least 60 aligned observations, and compares the observed five-second target return with `beta * BTC return`. It requires both a three-basis-point economic gap and a 2.5-sigma residual. The hypothetical catch-up price is passed through the same digital model before costs are checked.

## Cheap falsification plan

### Pilot checks before any freeze

1. Confirm each strategy either produces plausible intended orders or is honestly classified `STARVED`.
2. Inspect every feature vector for causal timestamps, finite values, correct 0-1 token scale, and no use of an unavailable venue/open reference.
3. Verify non-fill rate and quote-survival outcomes. A strategy whose apparent wins disproportionately disappear after 1.25 seconds is not rescued by assuming fills.
4. Compare H14-H16 calibration against the ordinary EWMA Phi baseline before comparing PnL.
5. Exclude every CLOB-gap/reconnect window from H19/H21 analysis; the current incremental CLOB parser/reconnect defect can otherwise manufacture desynchronization.
6. Record order counts by asset and regime. One asset or one shock must not masquerade as a general mechanism.

### Frozen forward read

For each surviving experiment:

- freeze code, parameters, data-quality version, fee model and execution model;
- reset to zero fresh evaluation fills;
- run for at least 500 scored fills and 14 days, whichever is longer;
- report clustered/block uncertainty by 5-minute window and UTC day, not fill-level iid bootstrap alone;
- report 1x/2x costs, fill rate, partial fills, 5s/30s adverse markout, drawdown, asset concentration, both halves, and measured latency sensitivity;
- apply the global comparison correction to all attempted H1-H21 variants and discarded redesigns;
- call the result zero/unproven edge if the adjusted lower confidence bound does not exceed zero.

## Barclays-specific evaluation

The volatility transfer earns support only if all three conditions hold on fresh data:

1. Robust-sigma fair probabilities improve Brier/log loss over the ordinary EWMA Phi baseline in the regimes H14/H15 select.
2. H14/H16 implied-versus-robust spreads predict **future** realized variation or terminal calibration; they cannot merely explain contemporaneous market price.
3. Any resulting order expectancy survives the recorded ask, 1.25-second quote survival, 2x fees, independent-window inference, and global trial correction.

If robust sigma improves probability calibration but not executable PnL, it is a useful risk/filter feature, not a trading strategy. If neither calibration nor PnL improves, the Barclays idea does not transfer to this venue/horizon and H14-H16 should be retired.

## Current limitations

- The CLOB stream defect and frequent reconnects documented in `RESEARCH_PLATFORM_AUDIT.md` make H19/H21 especially vulnerable to false events. Their rows are pilot diagnostics until P0 collector repairs and hard gap quarantine are deployed.
- One-second source bars cannot prove a millisecond edge. H18/H20/H21 can test whether an opportunity survives 1.25 seconds; a sub-second VPS claim requires faster raw capture first.
- Coinbase is a resolver proxy, not Chainlink Data Streams. H17/H20 test whether an independent venue improves robustness, not whether Coinbase is the settlement source.
- A long single binary is not a delta-hedged straddle or pure variance position. H14-H16 remain probability-discrepancy experiments with volatility as the model input.

The expected honest result may be that every new effect is consumed by fees, latency, adverse selection, or already-efficient CLOB pricing. That is an acceptable and valuable outcome.
