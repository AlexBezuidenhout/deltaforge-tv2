# Theory primer for DeltaForge

This is the minimum conceptual background needed to review the code and results
without mistaking a paper artifact for tradable edge.

## Binary contracts and executable value

A YES token pays $1 if its proposition resolves true and $0 otherwise. A NO
token has the complementary payoff. Token prices therefore live on the 0–1
scale; BTC, ETH and other spot prices do not. Mixing those scales is a critical
error.

If a calibrated model assigns probability `p` and a YES share can actually be
bought at ask `a`, gross expected profit per share is:

```text
EV_yes = p × (1 - a) - (1 - p) × a = p - a
```

For NO at executable ask `n`, use model probability `1-p`:

```text
EV_no = (1 - p) - n
```

The benchmark is the executable ask for entry and executable bid or terminal
payout for exit. Midpoint, last trade, EMA and Gamma display price are not fills.
Fees, spread, depth slippage, non-fills and adverse selection must be deducted.

## Forecasting is not automatically alpha

The original heuristic added BTC movement, order-book confidence and a lag bonus
to the market price. That can manufacture a probability divergence
mechanically: a larger BTC move creates a larger claimed edge even when the
market is already efficient. A forecast becomes alpha only if it is calibrated
to terminal outcomes and still beats executable prices after costs out of sample.

Calibration is checked with probability buckets, realized frequencies, Brier
score and log loss. A model can predict direction better than chance yet still
lose money by buying the right outcome at the wrong price.

## Resolver risk

Crypto signals often come from Binance, but the contract may resolve from a
Chainlink or other specified oracle. The relevant state is the rulebook's
resolver, timestamp and comparison convention—not the most convenient CEX
print. Binance/Chainlink divergence and oracle age are therefore first-class
features, especially near the resolution boundary.

## Market microstructure

The order book contains bids, asks and displayed size. A realistic taker fill
walks depth until the requested quantity is covered; if depth is absent, the
trade is infeasible. A passive order joins a queue. It fills only after enough
eligible volume trades ahead of it, and a fill can be bad news because informed
flow chose to trade through the quote.

For every fill, measure markout after 1, 5 and 30 seconds. Consistently negative
markout means adverse selection is consuming the spread. Faster reaction helps
only when an edge decays inside the latency saved; latency is not alpha by itself.

## Paper, shadow and backtest

- **Paper trading** follows a bot's live decision path but replaces real order
  submission with simulated fills and P&L.
- **Shadow trading** records hypothetical orders independently of operator bot
  state, then scores them later against observed books and outcomes. BORG uses
  this for many parallel frozen hypotheses.
- **Retrospective filtering** re-slices previously generated trades. It is useful
  diagnostics but not a causal backtest.
- **Event replay** reprocesses immutable timestamped events through the same
  strategy/execution kernel under explicit information and order-latency profiles.

The environment stores source time, local receive time, monotonic time, sequence
IDs, connection epochs and clock uncertainty so replay can distinguish market
latency from collector or database delay.

## Structural arbitrage

True arbitrage comes from terminal payoff algebra, not two charts that tend to
converge.

For complementary YES and NO shares on one binary event, buying both below $1
after all costs locks a minimum $1 payout. Ordered thresholds and disjoint ranges
can create similar complete bundles if the rulebooks make their state sets
mutually exclusive or exhaustive.

If event `A` logically implies event `B`, the bundle `NO(A) + YES(B)` pays at
least $1 in every allowed state:

| State | NO(A) | YES(B) | Total |
|---|---:|---:|---:|
| A false, B false | 1 | 0 | 1 |
| A false, B true | 1 | 1 | 2 |
| A true, B true | 0 | 1 | 1 |

The forbidden state `A=true, B=false` must be impossible under both rulebooks
and the observable event state. Similar titles, dates or topics do not prove it.

## Cross-venue risk

Two orders on Polymarket and Kalshi are not atomic. One leg may fill while the
other rejects, reprices or becomes stale. A displayed lock is tradable only if
both books have synchronized full-depth capacity and the result remains positive
after fees, adverse ticks and immediate orphan unwind stress.

Settlement wording, cancellation rules, deadlines, venue eligibility, funding
and withdrawal constraints can break an apparent identity. Generic convergence
between related contracts is a risky basis trade, not a risk-neutral position.

## Position sizing and capacity

Kelly sizing assumes the probability estimate is calibrated. With uncertain or
small-sample probabilities, shrink toward 0.5 and cap exposure. More size can
reduce fixed cost per dollar, but it normally increases depth slippage, queue
time and orphan risk. A one-cent edge on five available shares is five cents of
capacity, not a scalable strategy.

Strategy balances cannot simply be added when bots compete for the same cash,
market and displayed liquidity. DeltaForge uses shared-capital portfolio
simulation for the decision-relevant result.

## Statistical discipline

Five-minute ticks are not independent trials. Cluster by market window and day.
Correct for the fact that many strategies, assets, thresholds and horizons were
inspected. Require forward data collected after the hypothesis and parameters
were frozen.

A useful promotion rule is:

- at least 300 fresh independent markets and 14 calendar days;
- positive 2×-cost P&L in both chronological halves;
- market-clustered lower confidence bound above zero;
- no single asset, event or day dominating;
- data-quality and execution-fidelity grades of A/B;
- no unresolved orphan or settlement mismatch.

An honest outcome is that measured edge is approximately zero. The research
system is successful when it rejects attractive-looking false edges quickly.

## Current interpretation

The existing evidence says low latency materially improves measurement quality
and may improve fills for a valid short-lived mechanism. It did not make direct
CEX-lead strategies profitable: H47–H51 were negative after executable costs.
The most credible next paths are sparse structural/state-conditioned bundles and
two small frozen predictive pilots, H41 and H43. None is ready for live capital.
