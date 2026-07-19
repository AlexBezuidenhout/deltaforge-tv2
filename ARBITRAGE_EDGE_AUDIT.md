# TV2 structural arbitrage and edge audit

Generated 2026-07-16. All monetary results below are paper/shadow research,
not evidence that live execution will reproduce them.

## Executive conclusion

There are not literally zero market inefficiencies. There are many transient
price relationships and weak lead/lag effects, but almost none are *locked,
executable arbitrage* after spread, taker fees, depth, latency, and orphan-leg
risk. Across 15.3 hours of exact archived books, the same-market complement
scanner found only one buy-pair episode and two sell-pair episodes after 2x
fees, with a combined **$0.60 naive top-level profit upper bound**. The five
cross-network strategies lost **$785.48 at the 2x-fee setting** across 2,210
scored fills. The only new candidate worth a clean forward test is a
four-state residual model at four minutes to expiry: its chronological holdout
made **$46.95 on 41 trades**, but its clustered 95% mean-PnL interval was
**[-$1.21, +$3.17] per trade**, so zero/negative edge remains entirely
plausible. It is a hypothesis, not a profitable bot.

The user's $100-$200/day goal from $500 requires 20%-40% daily returns. The
four-minute candidate's selected point estimate happens to fall in that range
when extrapolated, but doing so would be statistically indefensible: it was the
best of four inspected horizons, has only 28 independent five-minute window
clusters, and its confidence interval includes losses.

## Dataset and method

The new read-only analysis tool is
`scripts/structural-edge-audit.js`. It scanned:

- 178 immutable `borg_book_snaps` archive files;
- the rolling PostgreSQL tail;
- 858,456 one-second snapshots, of which 338,836 belonged to resolved,
  eligible five-minute markets;
- 2026-07-15 20:11:18 UTC through 2026-07-16 11:28:58 UTC;
- BTC, ETH, SOL, XRP, DOGE, BNB, and HYPE;
- exact displayed asks and touch sizes, capped at $10 and 20% of displayed
  touch;
- the published crypto taker curve stressed to 2x, plus a one-cent-per-share
  hurdle;
- one observation per market at 240, 180, 120, and 60 seconds to expiry;
- a chronological 60% train / 40% holdout split by five-minute window, so
  assets from the same window cannot straddle train and test.

Polymarket's current fee documentation gives the crypto taker curve as
`shares * 0.07 * price * (1-price)` and zero maker fee, with part of taker fees
funding maker rebates: [fees](https://docs.polymarket.com/trading/fees).
Displayed midpoint is not an executable buy price; a taker pays the ask:
[prices and order book](https://docs.polymarket.com/concepts/prices-orderbook).

## 1. Locked same-market arbitrage

A matched YES+NO share can be merged into one unit of collateral. The merge
itself is atomic once both tokens are held:
[merge tokens](https://docs.polymarket.com/trading/ctf/merge). Acquiring both
legs is not atomic. FOK protects each individual order, but Polymarket does not
offer a two-token all-or-none group order:
[order types](https://docs.polymarket.com/trading/orders/overview).

After two times the taker fee curve:

| Identity | Episodes | Markets | Duration p50 / p95 | Best edge/share | Naive displayed-profit upper bound |
|---|---:|---:|---:|---:|---:|
| Buy equal UP+DOWN, then merge | 1 | 1 | 0s / 0s | 1.11c | $0.22 |
| Pre-split inventory, sell both bids | 2 | 2 | 7.0s / 13.3s | 3.12c | $0.38 |

This is an upper bound. Snapshot pairing cannot prove that both legs remained
available through two order acknowledgements, and sell-side identity requires
capital already tied up in split inventory. It is nowhere near the required
daily capacity.

The older `H1_pair_arb_2x` paper pilot looked busier: 131 groups, 92 complete
and 37 single-leg fills. Complete pairs made $19.15 at 2x costs; single legs
lost $2.59 in aggregate. Much of that cohort used REST or stale/repaired book
state, including apparent opportunities with book age above three seconds.
Only two H1 legs were replayable in the recent event archive. It must not be
read as proof of frequent live arbitrage.

## 2. Cross-network lead/lag is predictive, not arbitrage

Trading Binance, Coinbase, Hyperliquid, or Chainlink information against a
Polymarket binary does not lock a payout. The CEX hedge has a continuous payoff;
the Polymarket token has a discontinuous terminal payoff and may resolve from a
different source. This is a forecast plus basis risk.

Current scored results at the stressed 2x fee setting:

| Strategy | Fills | PnL 2x |
|---|---:|---:|
| H47 Binance transport | 372 | -$190.81 |
| H48 Chainlink resolver basis | 323 | -$185.13 |
| H49 Coinbase + Chainlink quorum | 177 | -$57.28 |
| H50 Hyperliquid + Chainlink | 296 | -$80.35 |
| H51 four-feed median | 455 | -$271.91 |
| **Total** | **2,210** | **-$785.48** |

In the latest two-hour raw cross-correlation sample, a 10-second CEX shock had
only 0.00-0.08 correlation with the next five-second Polymarket midpoint move.
The signed average repricing ranged from effectively zero to 2.58 cents. A
five-second taker round trip was still negative on every asset: approximately
-0.44 cents for BTC and -3.2 to -11.2 cents elsewhere.

The Dublin host is useful infrastructure, but it does not manufacture the
residual. Measured Polymarket HTTP RTT is about 20ms and websocket receipt is
roughly 9ms median, while the remote Neon database is about 77ms. The database
is off the decision path. A latency replay showed faster quote survival in the
pooled portfolio, but its reconstructed state was frequently tens of seconds
older than the decision quote and contradicted the scored PnL sign for multiple
strategies. It is sensitivity telemetry, not a valid alpha backtest. For the
named network strategies, the 0ms-vs-1250ms PnL deltas all had intervals that
included zero.

## 3. The legacy EV model was benchmarked against a stale price

The legacy engine computes its heuristic from an EMA-smoothed token price, but
`poly_yes_price` records the contemporaneous raw Polymarket quote. Across 4,233
resolved markets:

| Probability | Brier score (lower is better) |
|---|---:|
| Raw Polymarket quote | **0.2026** |
| Legacy model / heuristic | 0.2139 |
| EMA-smoothed market baseline | 0.2342 |

The model-minus-raw Brier difference was +0.0113 with an approximate 95%
half-width of 0.0039, so the raw market was materially better. The apparent
model advantage existed only against its own lagging benchmark. Raw versus
smoothed token price differed by 5.84 cents at the median, 10.0 cents on
average, and 36 cents at the 95th percentile.

The current execution layer already re-evaluates Gate 2 at the actual ask and
again after depth/latency penalty. That is why many visible `TRADE` decisions
correctly do not become fills. Across all legacy `TRADE` signal rows, only
48.3% retained positive model edge at the raw quote after one fee and the
median raw edge was -0.81 cents/share.

Historical closed-trade PnL is positive in aggregate, but claimed EV barely
ranks returns: Pearson correlation between `EV_adj` and realized ROI is 0.057
on 552 trades. The database also spans different code/execution versions. The
positive aggregate therefore deserves investigation, but it is not validation
of the EV numbers or a stable forecast.

`scripts/calibration.js` now prints the raw Polymarket probability benchmark so
future reports cannot repeat the smoothed-baseline mistake.

## 4. Four-state / Markov-style residual test

The tested state is deliberately simple and causal:

1. Measure the underlying's 60-second direction.
2. Classify Polymarket as above or below 50%.
3. Form four states: CEX up/market up, CEX up/market down, CEX down/market up,
   and CEX down/market down.
4. Fit a logistic residual on the training period *after including the market
   log-odds*, then trade the holdout only when predicted fair exceeds the exact
   displayed ask by two fees plus one cent.

This is the important modeling principle: a state model must predict what the
market price missed. Predicting the outcome without conditioning on market
price is not alpha.

| Entry time | Test markets | Raw / state Brier | Trades | PnL 2x | Clustered mean-PnL 95% CI | Halves |
|---|---:|---:|---:|---:|---:|---:|
| T-240s | 407 | 0.1958 / 0.1948 | 41 | **+$46.95** | **[-$1.21, +$3.17]** | +$25.24 / +$21.71 |
| T-180s | 504 | 0.1610 / 0.1656 | 182 | -$106.11 | [-$1.60, +$0.40] | -$21.16 / -$84.95 |
| T-120s | 476 | 0.1387 / 0.1396 | 141 | +$15.20 | [-$1.50, +$1.79] | -$43.12 / +$58.32 |
| T-60s | 356 | 0.1401 / 0.1429 | 39 | -$74.81 | [-$4.56, +$0.96] | -$63.63 / -$11.18 |

The exact-book replay falsified the initially attractive T-60 proxy result.
T-240 is the only coherent candidate: positive PnL in both halves and a tiny
probability-score improvement. It is still selected from four horizons, has
only 41 trades / 28 window clusters, and its interval crosses zero. The honest
label is **PROVISIONAL DISCOVERY CANDIDATE**.

## 5. Spread capture and cross-market structures

Naive market making has failed badly:

| Maker strategy | Fills | PnL |
|---|---:|---:|
| A_maker | 1,142 | -$1,405.60 |
| A2_maker_capped | 605 | -$316.83 |
| H8_informed_maker | 43 | -$31.48 |
| ETH_late_maker | 6 | -$9.22 |

The spread is compensation for adverse selection and inventory risk, not free
money. Being fast enough to post a quote is different from being able to cancel
before informed flow reaches it.

The current hourly panel also has no survivor. H22, H23, H24, H25, and H31 are
all negative, totaling about -$343.64 at 2x costs. The structural cross-market
bundle arms H26/H27 have no resolved groups yet because collection currently
contains very few daily threshold/range contracts. This is a genuine coverage
gap: logical arbitrage across nested thresholds, disjoint ranges, or mutually
exclusive event outcomes is more promising structurally than inventing more
directional CEX models, but it needs a much broader condition graph and enough
resolved contracts.

## What is actually missing

1. **Atomicity.** Cross-venue trades and two Polymarket token orders are not one
   atomic transaction. A displayed identity can become a naked binary position.
2. **The right benchmark.** Alpha is forecast minus the *executable ask*, not
   forecast minus an EMA, midpoint, or last trade.
3. **Capacity accounting.** A one-cent anomaly with five shares is five cents,
   not a scalable strategy.
4. **Selection correction.** Dozens of bots and four inspected horizons create
   many chances to find a lucky positive line.
5. **Market-maker competition.** “Crypto cowboys” can coexist with professional
   automated makers. Obvious CEX moves and complement identities are the first
   relationships those makers neutralize.
6. **More structural contracts.** TV2 is excellent on five-minute direction
   markets but still shallow on ordered strikes, disjoint ranges, and complete
   mutually-exclusive event sets where payoff algebra can create real locks.

## Recommended next experiment

Freeze a new paper-only `T-240 four-state residual` arm without changing its
model, edge hurdle, horizon, fee stress, or sizing. The 41 discovery trades in
this report must be excluded. Require at least 300 fresh independent markets,
14 calendar days, positive 2x-cost PnL in both halves, and a market-clustered
lower confidence bound above zero. Also report asset concentration: in the
discovery holdout, DOGE and SOL were negative while ETH, XRP, and BTC supplied
most of the profit. Do not select only those assets until the forward arm tests
the pre-registered interaction.

In parallel, broaden the structural scanner to build a condition graph for
nested thresholds, disjoint ranges, and mutually exclusive crypto events. Each
candidate bundle must be evaluated as a payoff identity, then independently
failed for stale legs, 2x fees, FOK feasibility, displayed capacity, and orphan
risk. That is the most credible path to true arbitrage. The four-state arm is
the most credible path to small predictive alpha. Neither is ready for live
capital today.

