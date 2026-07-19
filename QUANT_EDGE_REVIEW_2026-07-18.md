# DeltaForge money-making opportunity review — 18 July 2026

Quantitative evidence cutoff: **18 July 2026, 13:14 UTC**; runtime health was
re-verified at **13:37 UTC**. This review uses the Dublin VPS PostgreSQL hot
tier, immutable Flow/BORG WAL, official venue APIs, and fresh backtests added
during the review. It distinguishes realized history, counterfactual paper
fills, retrospective discovery, and prospective evidence.

## 16:43 UTC implementation addendum

The first registered V2 boundary read produced two independent resolved source
markets. At the primary 250 ms order-transit profile, both had **zero executable
fill and $0 PnL** because displayed 20%-touch capacity was below the modeled
$1 minimum. The 50 ms descriptive control had two fills, one win and +$4.38 at
2× fees; the 500 ms control had two fills, one win and −$0.40. This tiny result
does not support the discovery run-rate.

A venue audit then found a stricter omitted rule: current CLOB metadata publishes
a five-share `minimum_order_size`. V2 is not rewritten. V3 starts from zero,
enforces that minimum at confirmation and arrival, persists real-time causal
intents, and supplies a separate disabled-by-default $10 protected-FAK canary.
The old +$31.95 remains discovery only.

H41 is also **not live-ready**. Its frozen forward arm is +$10.88 after 2× costs
across 14 markets/two days, but ETH contributes +$25.47 while every other asset
combined contributes −$14.59. The first half is −$0.61, its market-clustered
95% interval is approximately [−$2.24, +$5.12] per market and its Holm-adjusted
p-value is 1. It remains shadow-only until the pre-registered 300-market/14-day
read is complete.

## Board answer

There is **one newly discovered high-upside mechanism worth a frozen forward
test**, one older mechanism already worth completing, and one low-return carry
trade with genuine external-market evidence. None is yet ready for unrestricted
live capital.

| Rank | Opportunity | What the data says | Decision now |
|---:|---|---|---|
| 1 | **Final-10-second absorbed-flow boundary trade** | Discovery: 18/18 independent BTC markets, +$34.32 after exact entry fees / +$31.95 with fees doubled on $126.86 turnover. Entry-validated WAL subset remained +$12.87 at 250 ms extra order transit | **Highest-priority fresh paper evaluation.** Instrumented identity frozen at 13:36 UTC; all prior rows excluded |
| 2 | **H43 volatility-and-resolver boundary buffer** | 16 fills, +$14.15 at 1× / +$12.49 at 2× costs. Small sample; confidence interval crosses zero | **Complete the untouched 300-market evaluation.** Runtime binding defect fixed at 12:40 UTC |
| 3 | **State-conditioned cross-venue payoff relations** | One retrospective executable relation made +$55.59 stressed; zero forward episodes | **Keep and broaden discovery.** It is rare-event alpha, not daily income today |
| 4 | **HYPE spot/perpetual funding carry** | 365-day public funding history: 11.37% simple annualized funding; ~$55 net / $52.66 stressed on $500 notional backed by $1,000 capital | **Real but small.** Diversifier, not a $100/day strategy; requires synchronized basis and custody validation |
| 5 | **Pyth-resolved equity/commodity boundary transfer** | Same resolver-boundary mechanism as rank 1; Polymarket now publishes sub-second Pyth reference streams and price-to-beat endpoints, but no matched DeltaForge history exists | **Highest-priority adjacent forward test**, not a claimed win |

The honest executive summary is: **the existing fleet does not demonstrate a
funded-ready edge, but the final-10-second absorption/boundary interaction is a
real, falsifiable lead rather than another arbitrary bot variant.** Its discovery
economics could correspond to roughly $10–20/day at the observed $10 capacity
if they persisted, but the result is post-selected, only 18 markets, and its
statistical lower bound is fractionally below fee-adjusted break-even. The right
response is not to dismiss it or deploy it—it is to freeze it, simulate actual
order transit, collect 300 fresh independent markets, and let the result decide.

## 1. The opportunity with the strongest current ground

### Final-10-second absorbed-flow boundary trade

The broad Flow V2 headline initially looked like a five-second scalp:
`absorption_reversal_v2` at 500 ms showed +$15.25 after exact taker fees. A
proper decomposition changes the interpretation:

- Whole 500 ms arm: **+$15.25 at exact costs, −$9.93 at 2× costs**.
- Fills with more than ten seconds remaining: **−$20.61 exact, −$42.42 at
  2× costs**.
- Fills with zero to ten seconds remaining: **+$35.86 exact five-second
  markout, +$32.49 at 2× costs**.

This is not general public-flow scalping. The candidate mechanism is much more
specific:

1. A completed public taker sweep goes in one direction.
2. The opposing token subsequently improves by at least one tick, its bid queue
   is at least its ask queue, and observed sweep displacement covers spread and
   fees.
3. This absorption/reversal confirmation occurs inside the final ten seconds.
4. Buy the opposite token once, at displayed arrival capacity, then hold to the
   official terminal outcome.

The first fill per market at the existing 500 ms information delay produced:

| Discovery metric | Result |
|---|---:|
| Independent markets | 18 |
| Terminal wins | 18/18 |
| Average executable entry | 0.8139 |
| Entry turnover | $126.86 |
| Terminal P&L, exact entry fee | **+$34.32** |
| Terminal P&L, doubled entry fee | **+$31.95** |
| Mean 2× P&L per market | **+$1.78** |
| Probability of 18/18 under each quoted entry probability | 1.66% |
| Conservative 24-cell Bonferroni bound | 39.9% |
| Wilson 95% win-rate lower bound | 82.412% |
| Fee-adjusted break-even at average entry | 82.450% |

That last comparison is the disciplined read. Even 18/18 does **not** yet put
the lower confidence bound above break-even, and the TTE band was found after
inspecting multiple arms, latencies and horizons. It is promising discovery,
not proof.

#### Does the Dublin VPS latency destroy it?

A new immutable-WAL replay rebuilt target books from raw full snapshots and
price deltas, then applied an additional order-transit delay after the existing
500 ms information wait. Full-cohort replay validation failed—11/18 fills were
recovered and 9/11 recovered entry prices exactly matched storage—so the replay
cannot be used as confirmatory evidence. The exact-entry-matched sensitivity
subset was:

| Extra order transit | Fills | Wins | 2× entry-fee P&L |
|---:|---:|---:|---:|
| 0 ms | 9 | 9 | +$19.53 |
| 50 ms | 9 | 9 | +$15.73 |
| 100 ms | 9 | 9 | +$15.13 |
| **250 ms** | **8** | **8** | **+$12.87** |
| 500 ms | 7 | 7 | +$3.45 |

This says the lead is **not obviously a sub-2-ms mirage**, but coverage is only
61%, so it does not establish executability. The forward manifest therefore
uses 250 ms—not the historically best cell—as its primary transit stress,
rejects any order arriving at or after the resolver boundary, permits one entry
per market, and requires 300 fresh markets / 30 days / both halves positive /
market- and day-clustered lower bounds above zero / family-wise correction.

The executable evidence specification is
`borg/flow/experiments/flow-late-absorption-boundary-v2.json`. V1 captured the
post-selected idea but was not armed because delayed arrival books were not yet
durably stored; it contributes no forward evidence. V2 began only after every
score persisted its 50/100/250/500 ms causal touch, capacity, fee, boundary and
rejection reason. It remains explicitly **PROVISIONAL** because ten seconds was
selected after discovery. At that evidence cutoff no live-order path existed;
the addendum above records the later, independently gated canary implementation.

At the first post-deployment read (13:41 UTC), V2 had zero independent source
markets and zero resolved outcomes. That zero is expected and important: none
of the 18 discovery wins leaked into the forward dashboard.

#### Realistic economics

The 18 discovery markets occurred over roughly 39 hours. The raw discovery
run-rate is therefore about 11 independent opportunities and $20 of paper P&L
per day at observed capacity. That is an upper-bound observation, not a return
forecast. One loss at an 81¢ average entry costs about five average wins; the
100% observed win rate will not persist indefinitely. Scaling from $10 to $50
before measuring book impact, order acknowledgement and terminal rejection
would turn a useful experiment into an expensive coin toss.

### H43 boundary buffer

H43 is the clean companion test. It acts earlier, with 20–75 seconds remaining,
and only when spot displacement exceeds both remaining volatility and
Binance/Chainlink resolver divergence buffers. It has 16 fills, +$14.15 at 1×
and +$12.49 at 2× costs. It remains small-n and family-wise p=1.

The fresh H43 evaluation manifest was deployed after the BORG process had
started. Experiment bindings load only on process startup, so no order could
enter the new identity. The collector was restarted at 12:40 UTC and now
resolves H43 to `research-h43-forward-v1`, phase `eval`, without changing any
strategy threshold. This is a corrected evidence clock, not tuning.

H43 and the new final-ten-second arm must not be summed as independent profit:
they can act on the same resolver state and capital. If both eventually pass,
the portfolio test must allocate one market to one arm or treat the pair as a
single clustered strategy family.

## 2. What is not currently making money

### Fleet-level result

Quality-valid BORG paper scoring currently contains **27,699 fills** and
**−$13,333.80 at 1× / −$17,567.20 at 2× costs**. The last 24 hours alone are
−$3,957.22 at 2×. This total is not a simulated bankroll loss because arms reuse
markets and capital, but it is decisive falsification evidence.

### MAIN

MAIN's apparently profitable history is not evidence of an edge:

| Cohort | Trades | Win rate | P&L | Read |
|---|---:|---:|---:|---|
| Legacy, before executable-book repair | 470 | 60.0% | +$805.94 | Contaminated by optimistic execution |
| Legacy, repaired forward book cohort | 82 | 40.2% | **−$110.02** | Relevant legacy result |
| MAIN V2 resolver quorum | 358 fills / 392 markets | — | **−$356.52 1× / −$420.83 2×** | Both halves negative; clustered CI [−1.83, −0.54] per fill |

MAIN should remain paper-only and should not be “rebuilt for profit” by changing
thresholds against this same history. Its useful output is now the negative
control proving that generic five-minute direction plus resolver quorum does not
cover executable costs.

### Paired maker and Book Lab

The paired complete-set maker's main reward arm has 132 cycles, 84 scored
cycles and only an 9.3% merge rate. Locked spread is +$9.36, orphan P&L is
−$719.33, realized P&L is **−$709.97**, and even the unverified public-L2 reward
estimate only improves it to **−$695.07**. Two-times execution stress is
−$820.50 with a clustered 95% interval wholly below zero. This mechanism is
rejected.

All-Market/Book Lab confirms the same adverse-selection problem:

- Passive maker: 9 fills, seven markets, **−$2.44 at five seconds**.
- Reward passive maker: 78 fills, 41 markets, **−$12.97**.
- Cost-confirmed taker: ~5,860 intents per latency and **zero fills**.
- L2 predictor controls: roughly −$2,500 to −$2,785 per latency at five seconds.

Polymarket officially charges makers no fee and funds maker rebates from taker
fees, but free fees do not neutralize toxic fills. Current category rates and
the fee formula are documented by [Polymarket](https://docs.polymarket.com/trading/fees),
and liquidity reward scoring is documented separately in its
[reward methodology](https://docs.polymarket.com/market-makers/liquidity-rewards).
DeltaForge's measured orphan/adverse-selection cost is far larger than modeled
rewards.

### Cross-venue Polymarket/Kalshi

The relation engine now has 65,046 snapshots, 41 pairs and three days, but its
mean paired observation skew is 41.9 seconds and p95 is 157.9 seconds. It has:

- one approved state-conditioned payoff relation;
- zero forward approved episodes;
- one retrospective episode with **+$55.59 stressed P&L**;
- 58 unapproved diagnostic convergence episodes, of which 11 became profitable,
  but the contracts are not proven payoff equivalents.

The one retrospective result is a credible example of what rare relation alpha
could look like; it is not a daily strategy. Kalshi now exposes public archived
trades and historical candlesticks, according to its
[official API changelog](https://docs.kalshi.com/changelog), so backfilling
price histories is possible. Historical trades still cannot reconstruct
synchronized L2, queue, partial fills or non-atomic leg risk. Forward WebSocket
books remain mandatory for executable evidence.

### Structural arbitrage

The repaired deterministic payoff scanner evaluated more than 30,000 fully
proved bundles and found zero economic candidates. Earlier large profits came
from a parser/proof bug and are excluded. The engine is worth keeping because
mathematical payoff identities can create true locks, but current opportunity
frequency is zero, not hidden profit.

### DVOL-to-threshold test

A new causal backtest joined fixed 60/30/15/5-minute Polymarket threshold
snapshots to the latest available one-minute Deribit DVOL close, converted DVOL
to a lognormal digital probability, walked up to $10 through 20% of displayed
ask depth, charged exact crypto fees, and selected one best strike per expiry.

Result: 12 selected trades across eight expiry events, 12/12 wins, but only
**+$0.11 on $120 turnover** because every “edge” was essentially buying a 99.9¢
certainty. This is economically useless. A 30-day volatility index is not a
strike/expiry surface. Deribit provides real-time option bid/ask IV and book
data through its [public market API](https://docs.deribit.com/api-reference/market-data/public-get_book_summary_by_currency)
and historical DVOL candles through
[`get_volatility_index_data`](https://docs.deribit.com/api-reference/market-data/public-get_volatility_index_data).
Collecting the full skew is still sensible; claiming the DVOL proxy as edge is
not.

### Funding carry and cross-venue funding

Fresh public-API backtests give a realistic non-prediction-market benchmark.
Hyperliquid settles funding hourly and documents both its
[funding calculation](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding)
and [base fee schedule](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees).
With $1,000 capital, $500 equal spot/short-perpetual notional, 10 bp spot taker,
4.5 bp perp taker, 2 bp slippage per leg, and a doubled-cost plus 10 bp basis
stress:

| Asset/history | Gross annualized funding | Net P&L | Stressed P&L |
|---|---:|---:|---:|
| BTC, 90 days | 5.25% | $4.62 | $2.27 |
| ETH, 90 days | 5.84% | $5.35 | $3.00 |
| SOL, 90 days | 2.04% | $0.66 | −$1.69 |
| **HYPE, 365 days** | **11.37%** | **$55.01** | **$52.66** |

This is funding-only reconstruction; synchronized spot/perp basis, custody,
liquidation and venue access are not observed. HYPE is the only line worth a
full basis collector, and even it is roughly $0.15/day at this capital.

A separate Binance-versus-Hyperliquid perp differential used the official
[Binance funding history endpoint](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data#get-funding-rate-history)
and Hyperliquid hourly history. Fixed long-Binance/short-Hyperliquid earned only
$3.18 BTC and $7.61 ETH per $500 notional over 180 days after estimated entry
and exit costs. A causal prior-seven-day switching rule had positive gross
funding but lost **−$19.52 BTC / −$8.83 ETH / −$23.63 SOL** after turnover.
This is not an income engine.

## 3. Where I would look next

These are ranked research programmes, not invented P&L projections.

### A. Transfer the resolver-boundary test to equities and commodities

Polymarket's official RTDS now streams Pyth-sourced equities, ETFs, FX, metals
and commodities up to five times per second, preserves source and receive time,
flags carried-forward prices when markets are closed, and exposes a
market-specific price-to-beat endpoint
([official RTDS specification](https://docs.polymarket.com/market-data/websocket/rtds)).
That creates a direct, testable extension of the only positive mechanism found
here: compare the authoritative reference path with the executable token ask in
the final boundary interval.

This is not permission to copy the BTC ten-second threshold. Freeze a new
paper-only family by resolver source and asset class, record the exact contract
boundary and carried-forward state, and test one fixed information/order-latency
profile against terminal outcomes. The mechanism has ground because resolver
state is directly observed; it can still fail if makers consume the feed faster,
the contract uses a different reference timestamp, or spreads dominate.

### B. Full option-surface residuals for crypto event markets

Replace rolling realized sigma and DVOL with an arbitrage-aware distribution
from actual Deribit option bid/ask IV by strike and expiry. Price Polymarket
thresholds, ranges and ordered ladders from one coherent implied CDF. Reject any
trade unless model uncertainty plus Polymarket ask, fee and displayed depth are
covered. Test monotonicity and butterfly bounds before trading.

Why it has ground: liquid options are the market's priced distribution, while
Polymarket daily strikes are retail binary slices of the same terminal variable.
Why it can fail: settlement timestamps/sources differ, options skew is itself
wide, and current threshold books may already follow the surface. The DVOL proxy
showed no useful edge, so only a full surface can revive the idea.

### C. Sports exchange residuals, not text-match “arbitrage”

Use Betfair Exchange or another liquid exchange as the reference probability,
de-vig if necessary, and compare against executable Polymarket/Kalshi asks for
the exact same settlement state. Model lineups, postponements, overtime and
void rules as payoff states. Betfair offers time-stamped historical price and
settlement data specifically for backtesting through its
[Historical Data service](https://developer.betfair.com/historical-data-services-api/).

Start with historical samples and Kalshi's public archive; do **not** pay
Betfair's full activation/data cost until a trade-level replay clears 2× costs.
The VPS advantage is uptime and event-driven repricing, not a guaranteed 2 ms
cross-Atlantic race.

### D. Weather probability residuals

Build location/station-specific distributions from archived NWS forecasts and
observations, then map them deterministically to weather contracts. The
[NWS API](https://www.weather.gov/documentation/services-web-api) is free and
provides forecast grids, hourly forecasts, observations and alerts. NWS notes
that some observations may be delayed by up to 20 minutes, so this is a
forecast-calibration strategy, not observation front-running.

The edge hypothesis is model calibration and contract-rule literacy in thinner
markets. The falsification test is simple: frozen forecast vintage versus
executable ask and final station outcome, clustered by weather system/day.

### E. Broader state-conditioned relation graph

AI is useful here for proposing semantic relationships and extracting contract
clauses, but it must not authorize a trade. A deterministic payoff compiler and
human review should prove implication, exclusion or equivalence across every
state. Expand from exact copies to relationships such as “A implies B” and
time-conditioned subsets. The retrospective +$55.59 speech relation shows the
payoff scale; zero forward episodes shows why breadth is the bottleneck.

### F. Scheduled-release residuals

For inflation, rates, elections and economic data, capture the official release
timestamp, revision policy, consensus distribution, liquid futures reaction and
prediction-market book. CME offers a cloud WebSocket top-of-book API, but its
official product is [conflated to 500 ms](https://www.cmegroup.com/market-data/real-time-futures-and-options-data-api.html),
so it is a fair-value reference rather than a guaranteed HFT feed. This strategy
needs precise contract interpretation and pre-event position limits; generic
LLM sentiment is not an edge.

### G. Commercialize the research feed

If trading alpha remains near zero, DeltaForge's durable event capture,
cross-venue contract graph and falsification reports can be sold as alerts,
research or a data API. That is a business hypothesis, not a backtested trading
strategy, but it may monetize the platform more reliably than forcing another
five-minute directional model.

## 4. What the VPS and AI actually add

The Dublin VPS is valuable for continuous collection, deterministic timestamps,
local PostgreSQL, WAL durability and fast reaction to Polymarket/European data.
It does not create alpha by itself.

- **Latency-sensitive:** final-boundary entries, book cancellation, passive
  maker toxicity, true simultaneous cross-venue locks.
- **Mostly latency-insensitive:** HYPE carry, daily option-surface residuals,
  weather forecasts, multi-hour relation convergence.
- **AI-sensitive:** contract parsing, relation proposal, source extraction,
  anomaly triage.
- **AI-dangerous:** unconstrained fair-value forecasts, automatic contract
  equivalence, or trading on generated explanations.

All eight core services were active at the health cutoff. VPS load was ~2.0 on
four cores after the WAL replay and collector repair, materially better than the
earlier 6–8 load but still not a reason to cite 20 ms reaction guarantees
without per-decision scheduler-delay telemetry.

The final verification found and fixed a material Flow collection defect. The
global Data API adapter was sending unsupported `start`/`end` parameters,
requesting 10,000 rows every second, and allowing slow calls to overlap. That
caused repeated 408/429 responses and made the broad discovery tape incomplete.
The official endpoint exposes `limit` and `offset`, not a global time cursor
([Data API trade parameters](https://docs.polymarket.com/api-reference/core/get-trades-for-a-user-or-markets)).
The adapter now uses bounded pagination, an API-source-time cursor, explicit
coverage-gap counters, and non-overlapping jobs at two seconds. The Data API is
currently minutes behind wall time, so it remains D-grade discovery data. The
causal experiment plane is unaffected in design: it consumes documented
`last_trade_price` and book events from the public
[CLOB market channel](https://docs.polymarket.com/market-data/websocket/market-channel).
The scorer now also separates a connection gap before entry from a later gap in
the markout interval; the old combined flag used future connection state to
retroactively cancel a paper entry. That look-ahead affected only new paper
scoring logic and no historical row was rewritten.
After deployment, both sockets were current, four markets were selected, 251
realtime trades and two eligible sweeps arrived in the first minute, scores
continued, and the process reported zero errors.

## 5. Concrete 30-day plan

1. **Do not change the new boundary specification.** Collect at least 300 fresh
   independent markets from 13:36:24 UTC, with one position per market, 250 ms
   primary order transit, exact and 2× fees, arrival before boundary, and
   terminal outcomes.
2. **Complete H43 unchanged.** The experiment binding now works. Report overlap
   with the final-ten-second arm rather than double-counting markets.
3. **Audit delayed-arrival coverage weekly.** The registered 50/100/250/500 ms
   states are now persisted in each score row before hot-touch pruning. Require
   at least 90% reconstructable 250 ms arrivals and investigate any rejection
   distribution shift; the retrospective WAL replay recovered only 61%.
4. **Start a separate Pyth boundary cohort** for supported equity, ETF, FX,
   metal and commodity markets. Preserve RTDS source/receive clocks,
   carried-forward flags, price-to-beat and exact contract boundary; do not
   reuse the BTC ten-second rule.
5. **Collect the full Deribit BTC/ETH option surface** alongside every daily
   threshold/range book. Freeze a CDF construction before looking at P&L.
6. **Backfill Kalshi public historical trades** for approved relations and move
   the live collector to authenticated WebSocket books where legally and
   operationally available. Measure episodes/week before optimizing execution.
7. **Start one external-source lab:** weather first if free data is preferred;
   sports first if paying for a reference exchange is acceptable. Require exact
   settlement mapping and executable asks.
8. **Stop interpreting raw bot count as diversification.** Archive or throttle
   decisively negative controls after their governance obligations are met;
   spend CPU and review time on independent mechanisms.

## 6. Capital and return expectations

With roughly $1,000 available, the evidence does not support $100–200/day. That
target is a 10–20% daily return and requires either much more capital, a rare
large structural event, or an edge far stronger than anything confirmed here.

| Candidate | Observed point economics | Honest current expectation |
|---|---|---|
| Final-10-second absorption | Discovery ~$1.78/market at 2× entry fees; ~11 markets/day observed | **Potentially $10–20/day**, but current defensible interval includes zero and rule is post-selected |
| H43 | +$12.49 over 16 fills in ~2 days | **Potentially single-digit dollars/day**, unproven and overlapping with boundary risk |
| Cross-venue relation | One +$55.59 retrospective event | **Lumpy; currently 0 forward opportunities/day** |
| HYPE carry | ~$52.66 stressed per year on $500 notional | **~$0.14/day**, before unobserved basis/custody risk |
| MAIN / makers / broad BORG | Large, persistent negative results | **Negative; do not fund** |

If the final-boundary arm or H43 passes the full rule, the next step is a
separate live canary at **$10 per independent market**, not immediate $50–100
stakes. Measure authenticated order acknowledgement, actual fill, rejected
post-boundary orders and live-minus-paper P&L for another 100 markets. Scale
only if that live implementation gap is smaller than the market-clustered lower
edge bound.

## 7. New reproducible tooling from this review

- `node scripts/flow-evidence-report.js` — all Flow V2 arms/horizons, exact and
  2× fees, halves, concentration, clustered intervals and Holm correction.
- `node scripts/flow-boundary-report.js` — untouched V2 forward cohort,
  persisted 50/100/250/500 ms arrivals, terminal P&L and the frozen pass/fail
  rule; the 250 ms line is primary.
- `node scripts/flow-wal-latency-replay.js` — reconstructs raw Flow books and
  separates information delay from order transit.
- `node scripts/funding-carry-backtest.js --days=365 --capital=1000 --coins=HYPE`
  — public Hyperliquid funding carry reconstruction.
- `node scripts/cross-venue-funding-backtest.js --days=180 --capital=1000` —
  Binance/Hyperliquid differential and causal trailing-regime control.
- `node scripts/dvol-threshold-backtest.js` — causal Deribit DVOL versus
  executable Polymarket threshold books.

Every script parses PostgreSQL numerics with `parseFloat`, keeps token and
underlying price scales separate, and has unit tests. None touches a live-order
path.

## Final decision

**Fund the measurement, not the story.** Continue the final-ten-second
absorption and H43 evaluations; broaden relation discovery; collect full option
surfaces and one non-crypto reference domain. Do not fund MAIN, paired maker,
generic Flow scalp, inverse losers or the mass BORG fleet. If the two boundary
tests fail prospectively, accept that the current five-minute Polymarket edge is
approximately zero and move the platform to slower reference-priced markets
rather than manufacturing another backtest.
