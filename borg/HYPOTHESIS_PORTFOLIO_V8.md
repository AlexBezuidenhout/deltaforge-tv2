# BORG H64–H73 — frozen paper portfolio V8

Frozen 26 July 2026. Formal forward evidence begins at
`2026-07-26T15:00:00Z`. All ten strategies are paper-only and PROVISIONAL.
The code contains no authenticated execution path.

## Selection boundary

The ten mechanisms were selected after checking every H1–H63 premise and
implementation. They are not renamed versions of momentum, favourite buying,
static imbalance, three-tick persistence, signal inversion, generic making or
raw Phi-versus-midpoint divergence. No H64–H73 PnL existed when the rules were
frozen.

All directional entries use:

\[
\underline p_{\text{selected}}-a
-2(0.07)a(1-a) \ge 0.01,
\]

where \(a\) is the executable selected-token ask. Intended notional is the
smaller of $10 and 20% of displayed touch, with a $1 minimum. Polymarket’s
documented crypto taker fee is \(C\cdot0.07p(1-p)\), and its documentation
explicitly distinguishes the executable ask from the displayed midpoint:
[fees](https://docs.polymarket.com/trading/fees) and
[order book](https://docs.polymarket.com/trading/orderbook).

## The ten frozen mechanisms

| ID | Strategy | Mechanism | Pre-PnL falsifier |
|---|---|---|---|
| H64 | `H64_multivenue_cusum_break` | Page-CUSUM on the median of fresh Binance, Chainlink, Coinbase and Hyperliquid prices; the CUSUM only identifies a state change and a conservative terminal fair interval still prices the trade | CUSUM alarms are already reflected in the executable ask, or alarms are dominated by feed/clock faults |
| H65 | `H65_kalman_latent_consensus` | Adaptive scalar Kalman filter treats venue prints as noisy observations of a latent efficient spot and propagates a 99% measurement interval into binary fair value | Filter uncertainty is too wide to clear costs, or the direct market quote is already a better estimator |
| H66 | `H66_range_threshold_partition_lock` | For exact bounds \(L,U\), `RANGE_YES + NO(S≥L) + YES(S≥U)` partitions terminal states with payout 1; the complementary three-token bundle pays 2 | No synchronized bundle survives 2× fees, depth and orphan stress, or rule text fails exact identity certification |
| H67 | `H67_queue_depletion_hazard` | Estimates depletion-before-refill intensity from event-by-event queue changes rather than a static depth snapshot | Queue removal is cancellation/spoof noise and does not survive 250–500 ms arrival |
| H68 | `H68_multilevel_ofi_impact` | Five-level OFI is normalized by depth; its next-event logit impact coefficient is learned causally and must have a 99% positive slope test | Multi-level flow adds no out-of-sample information beyond the executable quote |
| H69 | `H69_quarticity_confidence_envelope` | Realized quarticity estimates the sampling error of realized variance; the binary must be cheap under both ends of a 99% sigma interval | Apparent Phi edge disappears once volatility-estimation error is admitted |
| H70 | `H70_stationary_block_bootstrap_digital` | At T-120, 512 deterministic centered stationary-bootstrap paths preserve empirical skew, tails and short dependence; two data-derived expected block lengths and Wilson intervals form the fair bound | Non-Gaussian pricing gives no executable improvement, or time dependence invalidates coverage |
| H71 | `H71_token_elasticity_residual` | Online regression learns each token’s own logit response to standardized resolver distance; only a 99% prediction residual can time an otherwise terminally supported entry | Elasticity is unstable, residuals are adverse selection, or the quote corrects before simulated arrival |
| H72 | `H72_crosshorizon_nested_lock` | Same-asset, same-expiry 5m and 15m Chainlink contracts are nested events when their trusted opening boundaries differ; buy YES at the lower boundary plus NO at the higher boundary | Rule/resolver semantics are not identical, or executable pair cost never falls below guaranteed payout after stress |
| H73 | `H73_market_prior_calibration_residual` | Frozen T-120 market-probability buckets map to positive-outcome Wilson intervals; fit target is calibration, never trading PnL | The short discovery-period map does not replicate, or conservative intervals cannot clear fees and asks |

## Research basis

- H64 uses recursive CUSUM because online change detection has a defined
  false-alarm/delay objective rather than an eyeballed momentum threshold.
  A modern non-parametric treatment is
  [Yu et al., 2020](https://arxiv.org/abs/2006.03283).
- H67 follows the queue-reactive view of a limit order book as a Markov
  queuing system:
  [Huang, Lehalle and Rosenbaum](https://arxiv.org/abs/1312.0563).
- H68 is separate from H54’s top-level OFI. Evidence for adding deeper levels
  comes from
  [Xu, Gould and Howison](https://arxiv.org/abs/1907.06230), which reports
  increasing out-of-sample fit as levels are added.
- H69 follows the realized-variance central-limit error estimate based on
  fourth-order power variation:
  [Barndorff-Nielsen and Shephard](https://ora.ox.ac.uk/objects/uuid%3A997044d9-d3c7-420e-aad2-f97ca039ba93).
- H70 is explicitly not labelled distribution-free. Time-series dependence
  breaks ordinary exchangeability; the implementation uses blocks and
  reports model uncertainty rather than claiming conformal coverage. See
  [Xu and Xie](https://arxiv.org/abs/2010.09107).
- H66 and H72 are payoff-algebra arms. The broader no-arbitrage projection
  basis is
  [Kroer et al.](https://arxiv.org/abs/1606.02825).
- H73 treats calibration as conditional on product and horizon. Recent
  large-scale prediction-market work reports material domain/horizon
  structure:
  [Le, 2026](https://arxiv.org/abs/2602.19520). TV2 does not import that
  paper’s coefficients; it estimates and freezes its own crypto T-120 map.

Polymarket’s market WebSocket carries full book, price-change and trade
events, which is required for H67/H68:
[market channel](https://docs.polymarket.com/market-data/websocket/market-channel).

## Testability audit before launch

- The current collector supplies event time, receive time, sequence,
  connection epoch, full CLOB depth, four spot sources and trusted opening
  boundaries needed by H64–H72.
- The database contains 172 historical same-expiry 5m/15m Chainlink pairs.
  In the current hot tier, 4,760 synchronized pair observations across 124
  pairs had a best doubled-fee residual of **−1.08 cents** and zero episodes
  above the one-cent entry hurdle. That proves H72 is measurable, not
  profitable.
- Metadata contains 87 historical exact range/two-threshold triads. The
  current hot tier had no synchronized three-book observation, so H66 starts
  as an opportunity-rate and capture test.
- H73’s artifact contains 1,744 independent BTC/ETH/SOL/XRP five-minute
  markets observed near T-120 between 25 and 26 July. This short,
  non-stationary discovery interval cannot establish edge. The complete
  bucket counts, Wilson limits, cutoff and hash are stored in
  `borg/research/models/h73-market-prior-calibration-2026-07-26.json`.

## Promotion rule

No strategy is eligible for real money until it has at least 300 fresh
independent markets, at least 14 days (30 days for H66/H72), positive doubled-
cost PnL in both chronological halves, market- and day-clustered lower
confidence bounds above zero, Holm correction across the entire H1–H73 search,
positive 100/250/500 ms replays, realistic non-fills/partial fills, no dominant
asset/day/event and positive capacity under one shared $500 bankroll.

Passing those tests authorizes only a separate $1–$2 authenticated pilot
review. It does not automatically enable live trading. All ten strategies may
correctly finish with approximately zero or negative edge.
