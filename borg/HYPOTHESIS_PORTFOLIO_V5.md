# BORG H32-H51 Mechanism and Cross-Network Research Portfolio

## Status and safety

H32-H51 are forward-only `phase='pilot'` shadow strategies. They have no
wallet, signer, order client, or route to live execution. Their $500 balances
are independent virtual research cohorts, with a maximum intended stake of
$10 per signal and no more than 20% of displayed touch.

No existing history may be used as evidence for these strategies. Their data
begins when this collector version is deployed. Pilot PnL validates machinery;
it is not a profitability claim. A parameter freeze starts a new evaluation
clock of at least 300 independent market events and 14 calendar days.

## Execution assumptions

- Every candidate must show at least $0.02/share after twice the current
  crypto taker curve, `2 × 0.07 × p × (1-p)`.
- H32-H46 use the pessimistic 1.25-second quote-survival model.
- H47-H51 evaluate on coalesced raw events and add 250 ms paper order latency.
- Missing, stale, or disagreeing required feeds cause abstention.
- PostgreSQL numeric fields are parsed before arithmetic.
- All signals preserve network values, source/receive clocks, execution model,
  thesis version, and the fact that no atomic external hedge exists.

Polymarket documents both its public Chainlink and Binance RTDS topics and the
five-second connection heartbeat. Hyperliquid documents its public `allMids`
WebSocket and heartbeat. Coinbase's public WebSocket is an independent venue,
not the Polymarket resolver. See:

- <https://docs.polymarket.com/market-data/websocket/rtds>
- <https://docs.polymarket.com/market-data/websocket/overview>
- <https://docs.polymarket.com/trading/fees>
- <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions>
- <https://docs.cdp.coinbase.com/exchange/websocket-feed/overview>

## Fifteen distinct market mechanisms

| ID | Strategy | Mechanism | Primary falsification |
|---|---|---|---|
| H32 | `H32_opening_gap_repair` | First 45 seconds fail to absorb displacement from the captured resolver open | Gap vanishes before a 1.25 s order arrives |
| H33 | `H33_signed_semivariance` | Up/down semivariance asymmetry makes a symmetric digital sigma misprice the terminal tail | Adjusted fair is less calibrated than the symmetric baseline |
| H34 | `H34_flow_absorption_reversal` | Aggressive flow without spot progress is absorbed; a token following that flow overreacts | Absorption does not predict reversal after executable costs |
| H35 | `H35_depth_convexity_breakout` | Shallow ask path plus deep bid support exposes a directional book vacuum | Static depth is spoofed or disappears before arrival |
| H36 | `H36_sweep_replenishment_reversal` | Replenishment after a CLOB sweep signals resilience and reversal | Replenishment is merely informed inventory reload |
| H37 | `H37_spread_shock_reversion` | A temporary spread shock closes while terminal fair remains stable | Executable ask never retains post-fee edge |
| H38 | `H38_passive_flow_divergence` | Price moving against aggressor flow reveals informed passive liquidity | Flow/price divergence has no terminal information |
| H39 | `H39_autocorrelation_regime` | Causal one-second autocorrelation selects continuation versus fade | Serial dependence is unstable or latency-arbitraged away |
| H40 | `H40_directional_entropy_breakout` | Low sign entropy identifies persistent one-sided discovery | Low entropy is only a late, already-priced move |
| H41 | `H41_crossasset_dispersion_reversion` | Extreme five-minute cross-sectional displacement begins converging to peers | Residuals reflect true asset news rather than temporary dispersion |
| H42 | `H42_book_trade_disagreement` | Recent prints disagree with a replenished book and terminal fair | Prints are more informed than replenished quotes |
| H43 | `H43_resolution_boundary_buffer` | Near-resolution certainty is traded only beyond volatility and resolver basis buffers | Jump/oracle risk still dominates the apparent certainty |
| H44 | `H44_hourly_midwindow_reversal` | Large hourly displacement reverses with confirming aggressor flow | Reversal is a pause before continuation |
| H45 | `H45_threshold_distance_velocity` | Same-event threshold books lag sustained strike-distance velocity | Linear projection creates model error near jumps |
| H46 | `H46_range_boundary_migration` | A confirmed crossing into/out of a daily bucket reprices slowly | Boundary whipsaw and close-definition risk remove expectancy |

## Five cross-network arbitrage mechanisms

These are entirely arbitrage/dislocation based, but they are not described as
risk-free. A one-legged Polymarket order plus an observed external-network
dislocation is exposed to resolver basis, transport latency, book withdrawal,
and non-atomic hedging. A true locked arbitrage would require an executable,
semantically identical external contract and atomic fills; that infrastructure
does not currently exist in BORG.

| ID | Strategy | Networks | Tested dislocation |
|---|---|---|---|
| H47 | `H47_network_binance_transport_arb` | Direct Binance ↔ Polymarket RTDS Binance | Same source arrives through two transport paths; direct path leads the token and RTDS copy |
| H48 | `H48_network_chainlink_resolver_basis` | Chainlink RTDS ↔ direct Binance | Actual resolver proxy moves ahead of the Binance-derived fair |
| H49 | `H49_network_coinbase_chainlink_quorum` | Coinbase + Chainlink ↔ Binance | Two independent networks agree while Binance is the lagging/outlier observation |
| H50 | `H50_network_hyperliquid_chainlink_arb` | Hyperliquid + Chainlink ↔ Polymarket | Decentralized venue and resolver network agree before the binary reprices |
| H51 | `H51_network_four_feed_median_arb` | Binance + Coinbase + Hyperliquid + Chainlink | Robust network median rejects one bad feed and trades only a three-of-four directional quorum |

Hyperliquid reference data is now event-driven `allMids` for all seven tracked
assets. RTDS records Chainlink and Binance topics separately. Each raw frame is
written to the WAL before parsing, and each derived order records the network
set and `atomic_external_hedge=false`.

## Evaluation

For each strategy:

1. Confirm healthy raw and derived coverage before interpreting any zero count.
2. Freeze mechanism thresholds and market population in a new manifest/commit;
   discard all current pilot rows as evidence.
3. Require at least 300 independent events and 14 days after the freeze.
4. Report 1× and 2× fee PnL, quote survival, partial fills, data/fidelity grades,
   adverse selection, drawdown, and clustered confidence intervals.
5. Correct for all H1-H51 hypotheses and discarded variants. The search family
   is now large; nominal 95% intervals are not sufficient.
6. Replay survivors under 100/250/500 ms, 1/2 s, measured Mac, and measured VPS
   profiles. Network strategies must remain positive when information latency
   and order latency are varied independently.
7. A strategy is not promotable unless its lower multiple-comparison-adjusted
   clustered confidence bound remains positive after 2× costs and no single
   asset, day, or network outage supplies the result.

The expected result may be that all twenty edges are approximately zero after
costs. That is a valid research outcome.
