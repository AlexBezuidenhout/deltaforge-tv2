# BORG H54-H63 — frozen paper research portfolio

Evidence starts at `2026-07-26T01:34:42.000Z`. These are exactly ten new
paper/shadow strategies. None has a signer, wallet dependency, live mirror or
order-posting path. All thresholds are **PROVISIONAL** until the frozen
promotion protocol is satisfied.

## Why these ten

The prior fleet already tests generic CEX momentum, favorite buying, naive
signal inversion, midpoint divergence, late-window certainty, ordinary
two-sided making and basic cross-feed agreement. Those mechanisms are not
duplicated here.

The new portfolio targets measurable operational frictions:

1. dynamic CLOB order-flow and cancellation pressure;
2. fill toxicity in narrowly selected passive liquidity;
3. clustered public-print arrivals;
4. venue leadership learned causally rather than assumed;
5. resolver events arriving before the CLOB reprices;
6. persistent resolver boundary crossings;
7. jump-versus-continuous volatility uncertainty;
8. short-versus-long volatility regime uncertainty;
9. monotonicity violations in ordered threshold contracts; and
10. sub-simplex violations across deterministically disjoint ranges.

The research basis is:

- Cont, Kukanov and Stoikov show that short-horizon price changes are linked
  more directly to order-flow imbalance—including limit orders and
  cancellations—than to trade volume alone:
  <https://arxiv.org/abs/1011.6402>.
- Gould and Bonart study queue imbalance as a one-tick-ahead price predictor:
  <https://arxiv.org/abs/1512.03492>.
- Hawkes-process order-book research motivates measuring clustered event
  arrivals, but H56 deliberately uses an auditable excitation proxy rather
  than claiming a fitted Hawkes model:
  <https://arxiv.org/abs/2107.09629>.
- Barndorff-Nielsen and Shephard's bipower variation separates a
  jump-robust continuous component from total realized variation:
  <https://scholar.harvard.edu/files/power.pdf>.
- Abernethy, Chen and Wortman Vaughan formulate combinatorial prediction
  market arbitrage as projection onto coherent price sets:
  <https://arxiv.org/abs/1606.02825>.
- Polymarket's market WebSocket exposes book and price-change events; the
  executable order-book ask, not the displayed midpoint, is the entry
  benchmark:
  <https://docs.polymarket.com/market-data/websocket/market-channel> and
  <https://docs.polymarket.com/trading/orderbook>.
- Polymarket's current crypto taker schedule is
  `shares × 0.07 × p × (1-p)`; the manifest doubles that curve for stress:
  <https://docs.polymarket.com/trading/fees>.
- Pyth's documentation explains why confidence width and stale source data
  should be treated as uncertainty rather than silently averaged away:
  <https://docs.pyth.network/price-feeds/pro/understanding-price-data>.

## Common execution contract

- Benchmark: executable token ask on the 0-1 price scale.
- Costs: two times `0.07 × p × (1-p)` per share plus a one-cent edge buffer.
- Capacity: at most $10 intended notional, at most 20% of displayed touch,
  and no sub-$1 intent.
- Event strategies: scored with order arrival and quote-survival simulation.
- Sampled strategies: scored after the frozen one-second information delay.
- Passive strategy: back-of-queue model, partial fills, cancel timing and
  adverse-selection marks.
- One terminal position per strategy and market.
- Postgres numerics are parsed before arithmetic.

These assumptions are intentionally pessimistic. They do not make a result
live-realistic by themselves; authenticated fill behavior remains a later
stage.

## Selection diagnostics

The available collection covers roughly fifteen days of five-minute crypto
markets, ten days of 15-minute/hourly markets, and the current event-level
CLOB/external-feed hot tape. It is not a clean historical backtest for all ten
new mechanisms because older high-rate books have already moved to immutable
archives and the exact multi-asset resolver opening-reference field begins
with this release.

One apparent candidate illustrates why the forward design is strict. A
T-240 Phi-shrink screen looked like `+$56.89` over 508 observations when
credited at the contemporaneous ask. Requiring causal arrival and quote
survival changed that specification to `-$93.28` over 393 fills. A narrower
version was `-$2.54` over 317 fills, split approximately `+$107/-$109` between
chronological halves. It was excluded rather than tuned.

Broad fixed-time leader and direct Chainlink-versus-Binance rules were also
predominantly negative after executable asks and 2x fees. The ten selected
rules therefore start at zero; none inherits a positive historical line.

## Frozen mechanisms

### H54 — dynamic OFI + resolver confirmation

Computes top-level OFI from bid/ask price and size changes over two seconds,
then normalizes by average displayed depth. It enters only when OFI, the
Chainlink ten-second return and the direct venue ten-second return agree, and
the conservative terminal-value lower bound clears the executable ask after
2x fees.

Risk: public depth can be cancelled, spoofed or already reflected in price.
Falsifier: no positive 2x result at 100/250/500 ms, or negative 1/5/30-second
adverse-selection marks.

### H55 — OFI-guarded one-sided passive maker

Quotes only one token at its best bid after at least four supportive queue
observations spanning 750 ms. It cancels on adverse OFI, a queue flip, loss of
conservative fair-value edge, eight seconds of age, or T-45.

Risk: fills are selected precisely when the quote is wrong; queue position and
cancel acknowledgement dominate gross spread.
Falsifier: net spread capture is non-positive after adverse-selection and
2x-cost stress.

### H56 — print-excitation continuation

Compares the latest three seconds of token prints with the preceding
27-second baseline. It requires at least five recent prints, a standardized
arrival excess of two, a one-cent token-price continuation and resolver
agreement.

Risk: this is a Hawkes-style proxy, not a fitted Hawkes intensity; wash flow
or reaction lag may reverse the sign.
Falsifier: the burst has no incremental PnL over its resolver/fair-value
hurdle.

### H57 — adaptive venue leader residual

Records isolated two-basis-point moves and observes whether two other venues
follow within two seconds. A source cannot generate a paper intent before 30
completed episodes and a 95% Wilson lower bound above 50%.

Risk: leadership is regime-dependent and process-local learning restarts
conservatively after deployment.
Falsifier: online leadership fails to persist out of sample or executable
quotes vanish before the 250 ms arrival.

### H58 — fresh resolver event versus stale CLOB quote

Requires a Chainlink-resolved 5- or 15-minute contract, an exact RTDS opening
reference, a fresh Chainlink event, and a CLOB quote timestamp that predates
that event by no more than three seconds. Binance and Coinbase must already
be on the same side of the resolver boundary.

Risk: non-atomic event ordering, timestamp uncertainty and tiny displayed
capacity can erase the residual.
Falsifier: no surviving executable quote or negative post-fee terminal PnL.

### H59 — persistent resolver crossing

Requires three distinct Chainlink source ticks over at least 500 ms on the
same side of the exact opening reference, plus Binance and Coinbase
confirmation.

Risk: persistence sacrifices speed and may enter only after makers reprice.
Falsifier: the confirmation delay consumes all executable edge.

### H60 — bipower jump envelope

When total realized volatility is at least 1.25 times jump-robust bipower
volatility, terminal probability must clear the ask under both volatility
estimates and all fresh spot/reference candidates.

Risk: one-second sampling and microstructure noise can bias both estimators.
Falsifier: probability bounds are still miscalibrated in jump regimes.

### H61 — short/long volatility regime envelope

When 30-second and 180-second volatility differ by at least 1.5 times, both
estimates—plus the existing robust and RMS estimates—must support the trade.
It covers 5-minute, 15-minute and hourly direction markets.

Risk: conservative envelopes may correctly produce no trades; that is not a
system failure.
Falsifier: surviving signals do not remain positive across chronological
halves and latency profiles.

### H62 — ordered-threshold isotonic residual

Groups same-event threshold contracts, checks that probability should be
non-increasing with strike, and projects observed probabilities onto the
weighted isotonic cone. It trades only when the analytic binary model agrees
with the projection and the selected executable token clears costs.

Risk: this is statistical convergence, not a guaranteed lock; settlement
wording, quote asynchrony and non-atomic legs remain.
Falsifier: violations disappear at synchronized executable depth or do not
converge before resolution.

### H63 — disjoint-range sub-simplex residual

Deterministically verifies that same-event ranges do not overlap. Their
probabilities cannot sum above one even if the listed buckets are not
exhaustive. When the observed sum exceeds 1.03, it projects onto the simplex
and tests only the overpriced/NO direction, with analytic range fair in
agreement.

Risk: this is not represented as true arbitrage because it opens one token
rather than atomically acquiring a certified payoff bundle.
Falsifier: executable asks and 2x fees remove the projected residual.

## Promotion and honest interpretation

Each frequent crypto arm requires at least 300 fresh independent markets and
14 days. H62 and H63 require at least 300 markets and 30 days. Every arm must
also have:

- positive 2x-cost PnL in both chronological halves;
- market- and day-clustered lower confidence bounds above zero;
- family-wise multiple-testing correction across H1-H63 and every variant;
- positive replay at 100, 250 and 500 ms;
- realistic non-fills, depth, partial fills, queueing and cancel latency;
- positive capacity with one shared $500 bankroll; and
- no dominant asset, event or day.

Even if one arm passes, it only qualifies for a separate 50-fill authenticated
$1-$2 pilot review. The valid conclusion may be that all ten edges are
approximately zero.

Run the checkpoint with:

```bash
npm run research:v7
```
