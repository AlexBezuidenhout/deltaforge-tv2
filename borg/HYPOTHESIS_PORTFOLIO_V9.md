# BORG H74–H75 — four-hour state-dependent paper portfolio

Freeze: 2026-07-26 14:40:42 UTC. Forward evidence begins at 16:00 UTC.
Everything before that boundary is development data and is excluded from the
evaluation cohort.

## Development verdict

The attractive retail story—BTC moves, then ETH, then SOL—does not describe
the four major Binance pairs on the 30-day development tape. The reproducible
study in `scripts/regime-leadlag-research.js` used 43,199 aligned official
Binance one-minute observations from 26 June through 26 July 2026:

| Relationship | Same minute | Leader at t, target at t+1 |
|---|---:|---:|
| BTC / ETH | 0.8504 | -0.0217 |
| BTC / SOL | 0.7787 | -0.0297 |
| ETH / SOL | 0.8063 | -0.0236 |

The unconditional three-state Markov forecasts were also uninformative. Across
BTC, ETH, SOL and XRP, the identifiable-state one-minute hit rates ranged from
39.7% to 48.8%. No Wilson lower bound cleared 50%, and signed future returns
were economically tiny or negative.

A dynamic leader graph produced one weak lead worth falsifying prospectively:
ETH catch-up over three minutes had 23 development episodes, 65.2% directional
hits and +2.645 bps mean signed underlying return. Its 95% Wilson interval was
44.9%–81.2%, so chance remains a live explanation. The effect is underlying
return, not executable Polymarket token P&L, and is smaller than the costs of
many token entries.

Replaying the final, stricter H74/H75 rules on the same tape confirmed that
selectivity is severe. H74 found only 7 BTC, 5 ETH, 7 SOL and 4 XRP underlying
states over 30 days; outcomes were mixed. H75 found exactly two episodes:
BTC→ETH was directionally correct (+4.61/+6.83/+8.79 bps after 1/3/5 minutes)
and SOL→XRP was wrong (-5.19/-9.52/-16.46 bps). These are opportunity-rate
diagnostics, not a profitable backtest. Applying historical Polymarket asks,
fees, quote survival and resolver data could only reduce the executable count,
and that synchronized historical book set is not available for the full
30-day Binance interval.

## Frozen variants

### H74 — `H74_markov_regime_residual`

H74 is a deliberately strict Markov falsification arm, not a claim that the
development result was profitable.

- One continuous four-hour tape of complete one-minute returns per asset.
- Three states: DOWN, NEUTRAL and UP at ±0.5 trailing standard deviation.
- The current state requires at least 30 observed transitions and normalized
  transition entropy no greater than 0.90.
- The transition-model forecast and the 99% lower/upper empirical
  state-conditioned bound must agree in sign.
- Only the conservative common magnitude shifts the spot envelope.
- The shift must create incremental executable edge; a quote already accepted
  by the unshifted terminal model is rejected from H74.

### H75 — `H75_4h_dynamic_liquidity_leadlag`

H75 avoids privileging BTC and tests a changing price-discovery network.

- BTC, ETH, SOL and XRP all remain eligible leaders and targets.
- Lag slope and correlation must be positive in each separate causal two-hour
  half, with both lag-correlation lower 95% bounds above zero.
- The current leader move must exceed its rolling 95th-percentile absolute
  return and receive same-direction 75th-percentile aggressor-flow support.
- The target must have delivered no more than half its fitted contemporaneous
  response and have less absolute aggressor flow.
- The conservative lower-95% lag beta supplies the one-minute residual.
- One episode per target per 15 minutes prevents a single shock from being
  counted repeatedly.
- The residual must create edge that was absent before the adjustment.

Both strategies trade only fifteen-minute crypto markets with 180–600 seconds
remaining. Intended stake is at most $10 and 20% of displayed touch. Paper
fills must survive the executable ask, doubled taker fees, a one-cent buffer,
quote survival, partial/non-fills and adverse-selection scoring.

## Situational treatment of rejected strategies

Past losses cannot be sliced by volatility, trend or time of day and relabelled
as a profitable regime. With dozens of earlier bots, almost any history has a
positive-looking conditional cell by chance. A situational reuse is valid only
as a fresh matched experiment:

1. Specify the state from market observables without consulting the source
   strategy’s conditional P&L.
2. Freeze an unchanged source arm and a state-gated successor simultaneously.
3. Start both at zero on untouched markets.
4. Require at least 300 independent markets per asset arm, 14 days, positive
   doubled-cost P&L in both chronological halves and clustered lower confidence
   bounds above zero.
5. Correct across the complete H1–H75 family and report no-trade regimes.

No H74/H75 development observation is promotion evidence. An empty or negative
forward cohort is a successful falsification result, not permission to loosen
the gates.

## Primary references

- Binance Spot market-data API and WebSocket specifications:
  <https://developers.binance.com/en/docs/products/spot/rest-api> and
  <https://developers.binance.com/zh-CN/docs/products/spot/testnet/web-socket-streams>
- Kurihara et al., *Price Transmission from Bitcoin to Altcoins:
  High-Frequency Evidence and Implications for Trading Strategy* (2026):
  <https://link.springer.com/article/10.1007/s10690-026-09589-z>
- Zheng, Du and Zhang, *Regime Switching in Bitcoin Prices: A Hidden Markov
  Model Approach*:
  <https://arxiv.org/abs/2107.05535>
- *Mapping the Crypto Influence Network* (dynamic leader hierarchy):
  <https://arxiv.org/abs/2606.25466>
