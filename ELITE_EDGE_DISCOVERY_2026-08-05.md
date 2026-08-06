# DeltaForge elite edge-discovery memorandum

**Research date:** 5 August 2026  
**Evidence cutoff:** 22:20 UTC, 5 August 2026  
**Mandate:** identify genuinely testable small-capital trading, arbitrage, market-making and AI-assisted edges using TV2, its collected data, the Dublin VPS and accessible venues.  
**Capital frame:** $500–$1,000. Paper testing remains the default. Nothing in this document is a recommendation to enable live order paths.

## Executive verdict

DeltaForge does **not** currently possess a proven, bankable strategy. The valid evidence does not support a $100–$200/day expectation from $500; that target implies 20–40% daily returns and would require extraordinary leverage, turnover or tail risk. A validated $2–$10/day strategy would already be an excellent result at this capital level.

The research did, however, uncover three substantially better experiments than another round of BTC-direction variants:

1. **Pyth-resolved daily equity binaries versus exact-expiry listed options.** Polymarket has active SPY daily thresholds and Up/Down contracts resolving from Pyth's 1-minute close, while listed SPY options expire on the same day and OCC determines moneyness from the 4:00 p.m. close. This creates a natural options-implied probability reference and, in some cases, a near-complement hedge. A one-time post-close snapshot showed headline costs below $1 at the $765 and $780 strikes, but the quotes were not synchronized while both venues were open and the result is therefore a discovery lead—not an arbitrage proof.
2. **A unified physical-game payoff graph across Polymarket's sibling sports events.** TV2 currently proves relationships only within one Gamma event. Polymarket frequently splits one physical match across separate moneyline, spread, total, exact-score, first-scorer and prop events linked by the same game/fixture identifier. Exact-score 0–0, “neither team scores first”, and Under 0.5 are the same terminal predicate when their rules agree. A live catalog scan found four unique static market states positive after ordinary fees, although none survived doubled-fee stress. This is the best pure structural-arbitrage research program.
3. **The new ZEC resolver transition.** A newly listed ZEC cohort switches five-minute contracts to a Chainlink 30-second TWAP and 15-minute contracts to a 60-second TWAP. The undocumented feeds are already observable through RTDS. A 15-minute probe measured spot/TWAP deviations as large as roughly 12 bps, but found no trades and almost unusable CLOB spreads. More importantly, all three resolver streams silently stopped updating on a long-lived socket and resumed immediately after reconnect. This is an urgent data-collection opportunity, not yet a trading edge.

The most important conclusion is methodological: **new product and rule transitions are a better hunting ground than generic crypto momentum.** The professional maker already prices common BTC signals. A small automated desk should instead target fragmented payoff identities, resolver-specific contracts, exact-expiry cross-instrument pricing and subsidy-supported liquidity where absolute capacity is too small or operationally awkward for a large firm.

## Evidence discipline

The labels used throughout are strict:

- **Observed:** directly measured in code, a live API, a captured event stream or the database.
- **Discovery lead:** a plausible mechanism with preliminary observations, but no untouched forward cohort.
- **Proven:** at least 300 fresh independent units, sufficient calendar duration, positive doubled-cost PnL in both chronological halves, clustered lower confidence bound above zero, multiple-testing correction, realistic execution and no concentration in one event/day/asset.

No item in this memorandum has reached **Proven**.

The current clean-evidence boundary is also not yet sufficient for promotion. The most recent runtime audit passed process-level checks, but the strict evidence epoch accumulated many stale/error samples and the shared $500 paper portfolio ended around $434.62 after 78 admitted trades. A profitable line in a dashboard is not evidence unless its market routing, independence, source freshness, fills and costs all survive audit.

Every lane should use the same executable benchmark. For bundle size \(q\):

\[
NetEdge(q)=\min_{\omega}Payoff(q,\omega)-WalkedAskCost(q)-Fees_{2x}(q)-LatencySlippage(q)-OrphanReserve(q).
\]

For a predictive single leg, replace the worst-state payoff with a conservative fair-value lower bound. A candidate is not an opportunity unless `NetEdge(q) > 0` at real displayed capacity. A one-cent anomaly with five shares is five cents, not a scalable strategy.

## Ranked research portfolio

| Priority | Program | Mechanism | Evidence now | Decision |
|---:|---|---|---|---|
| 1 | Pyth equity binary × exact-expiry options | Use an executable option surface to bound a same-day Pyth binary; test robust vertical-spread complements | New live contracts, exact expiry and two apparent post-close residuals; no synchronized forward replay | Build a paper collector immediately; no live capital |
| 2 | Cross-Gamma sports payoff graph | Prove equalities and implications across all markets for one physical game | 598 physical groups; 1,284 tested equality paths; four ordinary-fee positives, zero doubled-fee positives | Build event-driven proof/replay arm |
| 3 | ZEC Chainlink/TWAP resolver transition | Model only the residual tied to the exact resolver stream during a new market rollout | 173 active contracts in one search snapshot; observable 30s/60s TWAP; no CLOB trades; silent-stream hazard | Capture now; freeze before scoring |
| 4 | Adapter-aware NegRisk complete sets | Buy all exhaustive outcomes when worst-state payout exceeds executable bundle cost | One orphan-safe historical episode worth about $0.14 at tested size; extremely sparse | Continue low-cost scanning; passive-first variant |
| 5 | Fair-bound reward harvesting | Quote one side only when conservative fair value plus verified reward/rebate exceeds toxicity | Large advertised pools, but prior generic maker lost heavily and reward denominator is unknown | Rebuild as authenticated experiment, not generic making |
| 6 | Exact-source weather and scheduled-release bounds | Use the legal resolver source and deterministic remaining-time bounds | Free official data exists; many contracts resolve elsewhere, causing basis risk | Collect only exact-source markets |
| 7 | Exact-rule Polymarket/Kalshi identities | Trade only predicates with matching resolver, comparator, time zone and cancellation rules | Many arithmetic leads, zero certified lockable identities to date | Keep running cheaply; do not call convergence risk-free |
| 8 | Crypto options-implied residual | Use exact-expiry option CDF rather than DVOL or unsupported interpolation | 1,534 Deribit instruments observed, but zero exact expiry among 36 target contracts | Collect; do not score unsupported expiries |
| 9 | Deterministic public-information boundaries | React to official machine-readable releases only where the fact settles the predicate | Existing X/Truth-style lane is slow and negative; one-off positive is noise | Narrow to exact barriers; reject generic sentiment |
| 10 | Generic CEX/DEX/perp lead-lag | Exploit venue lag or funding dislocation | Existing BTC→alt, funding, factor and final-seconds tests are negative after costs | Negative control; no more variants without new data |

## Discovery 1 — Pyth equity binaries versus exact-expiry options

### Why this is structurally different

TV2's Deribit lane has a fundamental fidelity problem: none of the inspected Polymarket targets had an exact matching option expiry. The current equity cohort removes that problem.

On 5 August, Gamma exposed four active events under the `Equity Daily Pyth` tag:

- an 11-strike SPY close-above ladder for 6 August;
- SPY Up/Down for 6 August;
- EWY Up/Down for 6 August;
- SPY open Up/Down for 6 August.

The SPY threshold event had roughly $11,952 of reported liquidity. The single SPY Up/Down market had roughly $1,277. Each threshold contract carried a 4% taker-fee schedule and most advertised a $50/day liquidity-reward configuration with a 20-share minimum. The corresponding SPY options chain contained 6 August expiries with substantial volume and open interest around the relevant strikes.

The historical catalog shows that this is an established daily product rather than a one-day launch. Over the latest 90-calendar-day window available from Gamma, the tag contained 188 closed events across 60 trading days: 119 close Up/Down events, 60 threshold ladders and nine open Up/Down events. They represented 120 `symbol × day` clusters and only two underlyings, SPY and EWY. Recent SPY threshold ladders reported roughly $16,000–$72,000 of volume per day, while EWY was often sparse. At the present two-symbol cadence, 300 independent symbol-days would take about 150 trading days unless the universe expands. A retrospective study therefore needs legitimately licensed historical option quotes; otherwise the forward trial is a months-long program, not a quick promotion.

TV2 already subscribes to Pyth-backed equity RTDS symbols including SPY and EWY in `borg/pyth/rtds.js`, but `borg/pyth/universe.js` deliberately admits only single-market `Up|Down` events. The multi-strike daily close event is therefore outside the Pyth experiment, while the existing options collector is Deribit-only. The cross-instrument experiment is unbuilt.

There is also a lower-priority opening-auction sublane. Nine historical `SPY Opens Up or Down` events were found. In seven with a trade within two minutes of 9:30 a.m. ET, every such trade bought the eventual winner, but only at 0.99 or 0.999; there was no visible cheap post-fact fill. Public price history is sampled state rather than executable depth, so this does not prove absence of a sub-second stale quote, but it does show that the obvious version is already tightly priced and low capacity. The current price-to-beat endpoint also returns `Could not extract symbol from slug` for the opening-market slug, causing TV2's certificate-based Pyth universe to reject it. Keep this as a small collector/control arm, not a top strategy.

### Mathematical mapping

Let

- \(X_P\) be the Pyth close used by Polymarket;
- \(X_O\) be the underlying close used by OCC for option moneyness;
- \(A_K = 1\{X_P > K\}\) be a Polymarket YES token;
- \(V_P(K+1,K)\) be one normalized long \((K+1)\)-put / short \(K\)-put vertical.

If \(X_P=X_O\), then

\[
A_K + V_P(K+1,K) \ge 1
\]

for every terminal price. Below \(K\), the put spread pays one; above \(K\), the Polymarket token pays one; in the one-dollar overlap interval the combined payout is greater than one. Similarly, a Polymarket NO token can be paired with a normalized long \((K-1)\)-call / short \(K\)-call vertical.

This is not automatically risk-free because Pyth's final one-minute candle and OCC's 4:00 p.m. underlying close are different data products. Define the measured basis

\[
B_d = X_{P,d} - X_{O,d}.
\]

A robust hedge must use a pre-registered bound \(\epsilon\) derived from prior, untouched days and shift the option strikes so the guarantee survives \(|B_d|\le\epsilon\). Any day outside the bound is an explicit failure state, not silently excluded.

The equations describe intrinsic value at expiry. Listed SPY ETF options are American-style and physically settled, so an expiring vertical can create temporary SPY stock positions through exercise/assignment; contrary exercise and pin risk also break any naive cash-atomic interpretation. The experiment must either close the vertical at an executable bid before expiry or explicitly reserve and model assignment, stock financing and post-close unwind. Until that is done, this is an options-bounded relative-value trade—not a certified lock.

For a vertical width \(w\), the robust YES complement moves the put strikes outward to \((K+\epsilon+w,K+\epsilon)\); the robust NO complement uses calls at \((K-\epsilon-w,K-\epsilon)\). Strikes must be rounded outward on the listed strike lattice. The extra debit is part of the hedge cost, not a discretionary safety margin.

### One-time discovery snapshot

A one-time research query of Cboe's delayed chain at 22:13 UTC showed its option surface marked against SPY near $770.50 and reported the official cash close as $769.79. Polymarket's price-to-beat endpoint reported the Pyth close as $769.80846, a one-day difference of about $0.0185 or 0.24 bps. That small basis observation is encouraging but statistically meaningless. The following headline calculations use displayed asks, **double** the Polymarket fee, and executable option vertical debits, but exclude options commissions and settlement-basis reserve:

| Bundle, 100-token equivalent | Polymarket leg | Doubled Poly fee | Option vertical | Total | Headline residual |
|---|---:|---:|---:|---:|---:|
| SPY > $765 YES + 766/765 put spread | $79.00 | $1.3272 | $16.00 | $96.3272 | $3.6728 |
| SPY ≤ $780 NO + 779/780 call spread | $92.00 | $0.5888 | $5.00 | $97.5888 | $2.4112 |

These figures are **not a backtest and not an executable-arbitrage claim**:

1. the options market had closed while Polymarket continued to move, so the legs were not synchronized;
2. the inspected Cboe page is delayed and explicitly prohibits automated extraction;
3. one option spread has a 100-share multiplier, creating lumpy sizing;
4. brokerage commissions, exchange fees, assignment, borrow and capital use remain;
5. Pyth/OCC close-basis risk must be measured;
6. the option surface is risk-neutral, not automatically a physical-probability forecast;
7. two visible residuals selected from 11 strikes are a multiple-testing discovery sample.

The economics are highly tick-sensitive. A vertical contains two option contracts; at the current maximum low-volume IBKR commission of about $0.65/contract, $1.30 of the displayed residual is consumed before exchange/regulatory fees. One cent of additional vertical-spread slippage costs another $1 per 100-token bundle. The two headline residuals would therefore fall to roughly $2.37 and $1.11 after base option commission, and to $1.37 and $0.11 after one further option tick, before basis/orphan costs. Displayed Polymarket depth supported only about one natural 100-token bundle at each cited top ask. Still, the combination is unusually well grounded: the expiry matches, the underlying is the same ETF, the payoff can be bounded, and the natural bundle size is compatible with a $500 account.

### Correct experiment

Create a frozen `EQOPT_V1` paper experiment with these rules:

1. Ingest licensed real-time OPRA top-of-book, the underlying NBBO, Pyth RTDS, Polymarket CLOB L2 and the immutable contract rule at source time. Do not automate the Cboe delayed-quote webpage. Interactive Brokers currently lists OPRA L1 at about $1.50/month for qualifying non-professional accounts and requires roughly $500 account equity for market-data subscriptions.
2. Build bid/ask-consistent digital lower and upper bounds from adjacent vertical spreads. Do not use vendor delta as the executable fair value.
3. Measure Pyth-versus-OCC closing basis every day before any robust-lock label is allowed.
4. Score directional residuals only against the **executable Polymarket ask** and option hedge cost:

\[
EV_{lower}=P_{option,lower}-Ask_{poly}-Fee_{2x}-Slippage-Commission-BasisReserve.
\]

5. Replay information delay and order delay separately at 100, 250, 500, 1,000 and 2,000 ms. Also include a 15-minute delayed-data control.
6. Treat `symbol × trading day` as the independent cluster; strikes from one ladder are correlated. Require at least 300 fresh symbol-days and 30 calendar days before promotion.
7. Persist pre-expiry vertical liquidation bids as well as expiry intrinsic value; report both a tradeable-exit PnL and a fully financed assignment PnL.
8. First authenticated pilot, if the paper arm passes, is one spread and 100 offsetting Polymarket tokens only after both accounts can support orphan unwind and any temporary stock assignment. Neither leg may be assumed atomic.

### Falsification

Reject the program if any of the following holds:

- residual disappears under synchronized OPRA/CLOB quotes;
- Pyth/OCC basis reserve erases the residual;
- both chronological halves are not positive at doubled costs;
- fewer than 80% of signalled bundles are simultaneously executable at stated size;
- one earnings/news day contributes more than 20% of PnL;
- option commissions and orphan unwind reduce expected profit below $1 per bundle.

## Discovery 2 — unified sports payoff graph

### The missed universe

`borg/structural/condition-graph.js` loops over each Gamma event and builds complement, ordered threshold/range, same-event sports ladder and complete NegRisk identities. It never groups sibling Gamma events belonging to the same physical match.

A current scan of 1,938 active sports events produced 598 physical-game groups using shared `gameId`, `eventMetadata.opticOddsFixtureId`, scheduled time and teams. Of those groups, 279 had at least two sibling events and 112 had seven. This is a broad, deterministic mapping surface—not a fuzzy language-match problem.

### Exact soccer equivalences

For full-time score \((H,A)\), subject to identical overtime/cancellation/source rules:

\[
1\{H=0,A=0\}
=1\{FirstScorer=Neither\}
=1\{H+A<0.5\}.
\]

Other useful implications are generated mechanically:

- exact score \((h,a)\) implies the full-time result;
- exact score implies Over/Under, team totals and both-teams-to-score;
- exact score implies the applicable spread winner;
- a strict favorite spread implies a more lenient spread for the same team;
- moneyline favorite plus underdog spread has a minimum one-unit payoff and can pay two in the middle region.

For predicates \(A\) and \(B\):

- if \(A\Leftrightarrow B\), then YES(A)+NO(B) pays exactly one;
- if \(A\Rightarrow B\), then NO(A)+YES(B) pays at least one;
- if \(A\land B=0\), then NO(A)+NO(B) pays at least one.

The trade is valid only when the total executable ask, fee, slippage and orphan reserve are below the guaranteed payout.

### Current scan result

The static sibling scan evaluated:

| Equality family | Pairs | Directional paths | Gross-positive | Ordinary-fee positive | Doubled-fee positive |
|---|---:|---:|---:|---:|---:|
| 0–0 ↔ neither first scorer | 234 | 461 | 6 | 1 | 0 |
| 0–0 ↔ Under 0.5 | 209 | 418 | 2 | 1 | 0 |
| neither first scorer ↔ Under 0.5 | 206 | 405 | 11 | 4 | 0 |
| **Total / unique states** | — | **1,284** | **19** | **4** | **0** |

The family rows contain six ordinary-fee-positive path hits. Collapsing simultaneous paths from the same physical game and book state leaves four unique economic observations; that deduplicated count is shown in the total row. It is still a discovery scan, not four independent trades.

The best static example was Cruz Azul versus Philadelphia Union: `Neither NO + Under 0.5 YES` appeared at 0.94 + 0.05. At 87 displayed shares, the gross identity value was $0.87 and estimated ordinary fees were about $0.45, leaving roughly $0.42 before latency and slippage. A later synchronized query had reverted to parity. That makes it evidence of a transient catalog anomaly, not realized profit.

An academic 2026 NBA study reported 290 moneyline/spread episodes and about $560 aggregate gross profit under its assumptions, but its median edge was roughly 1.01%. Today's two-leg sports taker fees are large enough to erase that median before orphan risk. A current 13-relation scan found no gross-positive moneyline/spread bundle. This lane therefore needs passive-first execution rather than a copy of the paper.

### Build specification

1. Construct `physical_event_id = hash(sport, league, fixture_id, scheduled_start, normalized_participants)`.
2. Parse every sibling market into a typed predicate over a finite score-state DSL.
3. Hash exact rule fields: regular-time/overtime scope, cancellation, postponement, source, tie behavior, settlement time and venue-specific void rules.
4. Automatically veto any rule mismatch. An LLM may propose a parse, but a deterministic compiler must produce the payoff vector and worst-state proof.
5. Consume synchronized CLOB WebSocket books for every leg; Gamma prices are discovery metadata only.
6. Evaluate full depth at 5, 10, 25 and 100 shares with actual fee schedules.
7. Model FOK feasibility, leg-order choice, partial fill, cancellation acknowledgement and worst orphan unwind.
8. Run an aggressive control and a post-only/passive-first arm under one frozen manifest.

Promotion requires 300 independent physical games over at least 30 days, positive doubled-cost PnL in both halves, a game/day-clustered lower confidence bound above zero, and no league contributing more than 40% of profit.

## Discovery 3 — ZEC Chainlink/TWAP rollout

### New contract cohort

A 5 August Gamma search found 173 active ZEC direction events:

- 52 spot-Chainlink contracts;
- 91 five-minute contracts using a ZEC/USD 30-second TWAP;
- 30 15-minute contracts using a ZEC/USD 60-second TWAP.

The TWAP contracts were scheduled for 6 August. Their rules explicitly compare the final 30- or 60-second Chainlink TWAP with the opening reference. This differs materially from the older point-in-time close.

### Live 15-minute probe

From 21:59:45 to 22:14:45 UTC, a dedicated probe captured 11,499 Binance events, 1,592 RTDS resolver ticks, 14 CLOB touch changes and zero CLOB trades.

| Feed | Ticks | Source→Mac p50 | p90 | p99 | Publisher→Mac p50 |
|---|---:|---:|---:|---:|---:|
| Chainlink spot | 530 | 1,589 ms | 2,069 ms | 2,403 ms | 285 ms |
| Chainlink TWAP 30s | 531 | 1,733 ms | 2,184 ms | 2,574 ms | 352 ms |
| Chainlink TWAP 60s | 531 | 1,694 ms | 2,154 ms | 2,559 ms | 321 ms |

The distinction matters: most of the roughly 1.6–1.7 second source age existed before publication; Dublin network optimization cannot remove it. Publisher-to-receiver transport was roughly 0.3 seconds in this Mac probe.

For 529 aligned observations:

| Difference | Median | p90 | p99 | Min | Max |
|---|---:|---:|---:|---:|---:|
| spot − TWAP30 | −0.33 bps | +3.52 | +6.79 | −11.79 | +8.87 |
| spot − TWAP60 | −0.36 bps | +3.25 | +6.86 | −12.10 | +9.83 |

One fully observed point-close window moved −8.08 bps and resolved Down. This is not strategy evidence; it is one resolver-tape validation.

### The critical failure mode

All three RTDS streams stopped at approximately 22:09:20 while the WebSocket stayed open, Binance continued and no close event was emitted. The silent tail lasted about 324 seconds. A fresh connection immediately delivered a current 60-second history and resumed all three streams.

The production RTDS adapter has two related blind spots:

- `borg/recon/rtds.js` hardcodes BTC, ETH, SOL and XRP, so ZEC is discarded;
- its stale timer updates on any frame, including PONG/control traffic, rather than requiring a fresh per-asset source tick. A connected but economically silent socket can therefore look healthy.

The correct collector needs dedicated or tightly bounded subscriptions, per-topic/per-symbol source-time watchdogs, reconnect on three missed expected ticks, redundant sockets, connection epochs and a gap record that invalidates the affected window.

### Why this is not yet tradable

The live ZEC books were typically 0.01/0.99 or 0.02/0.98, reported liquidity was only a few dollars, and the probe saw no trades. A perfect resolver model cannot earn money without an executable counterparty. The direct Chainlink TWAP should also be consumed as published; its exact sampling, missing-input and rounding behavior is not sufficiently documented to justify a home-built replica.

Freeze three separate paper arms—spot, TWAP30 and TWAP60—with no parameter sharing. Use the market quote as the prior and forecast only a resolver-specific residual. Require 300 fresh windows, 14 days, valid source freshness and positive capacity after the 7% taker schedule before any promotion discussion.

## Existing structural lead — NegRisk complete sets

The existing scanner has evaluated hundreds of thousands of complete-set observations, but fees and orphan risk remove nearly all apparent locks. One historical Strait of Hormuz ship-count episode survived the implemented gates:

- 11.06 shares;
- cash cost about $9.94;
- terminal payout $11.06;
- gross residual about $1.12;
- worst incomplete-fill reserve about $0.99;
- orphan-safe residual about $0.14;
- episode duration about 1.34 seconds.

At five shares the safe residual was only about $0.07; at 20 shares it became negative. That is exactly the kind of low-capacity anomaly a small bot can pursue, but one episode is not an edge. The right extension is adapter-aware set construction, fee-aware token selection and passive conversion of one or more legs—not weaker proof gates.

## Reward-supported fair-bound making

The current rewards endpoint listed approximately 10,692 active configurations with about $140,895/day of **configured** rate. Median rate was $4/day, p90 $45 and p99 $100; the median minimum qualifying size was 20 shares. These are program caps, not what this wallet earns.

Polymarket allocates rewards by relative scoring, imposes minimum size/spread and duration conditions, and does not pay amounts below $1. Therefore expected reward requires the unknown competing-score denominator:

\[
E[R_i] = Pool_m\,E\left[\frac{Q_i}{Q_{total,m}}\right]Pr(scoring)Pr(payout\ge1).
\]

The public market-configuration response includes a `market_competitiveness` field, but the documentation does not define it as that denominator. It must not be reverse-labelled into expected revenue. The authenticated earnings endpoint exposes the wallet's realized `earning_percentage` and earnings; those observations—not the advertised pool—are the valid input for estimating reward share.

The prior all-market maker produced 156 modeled fills and roughly −$24 at five-second markout. The paired reward maker's modeled trading loss was about −$2,914 versus only about $75 of rewards. Generic two-sided quoting is falsified.

A valid successor must:

- quote only one side when a deterministic or externally bounded fair value protects it;
- verify every live order through the authenticated order-scoring endpoint;
- persist reward percentages and actual daily earnings;
- estimate queue ahead, partial fills, cancel latency and 1/5/30-second adverse selection;
- withdraw around scheduled catalysts unless an exact fair-value feed exists;
- require `expected reward + rebate + spread > adverse selection + inventory cost` under a lower confidence bound.

The new SPY/Pyth and exact-source weather markets are better substrates for this experiment than generic politics or crypto books because they provide an external fair-value boundary.

## Lanes that remain worth collecting, but not trading

### Exact-source weather

Official METAR is free and machine-readable, but many Polymarket temperature contracts resolve from Weather Underground or another named station/product. A beautiful forecast against the wrong legal source is basis risk. Test only contracts where the collector exactly matches the rule source, station, observation convention and daily-extremum definition. The useful mechanism is a deterministic remaining-time bound near the end of the observation day, preferably combined with a verified reward pool.

### Exact-rule Polymarket/Kalshi

The present cross-venue database contains hundreds of thousands of evaluations but no certified lockable terminal identity. Similar wording and temporary convergence are statistical trades, not risk-neutral arbitrage. The next clean experiment must key contracts by typed predicate, comparator, strike, resolver, deadline and time zone, with hard vetoes for cancellation or settlement mismatch. Persist Kalshi's actual per-market fee and replay depth at 5/10/25 shares. Do not fund both venues until 300 clean pair-days exist.

### Public-information reactions

The existing public-source lane observed 36 windows, 2,807 posts and 210 priced irreversible boundaries; the aggregate stressed result was about −$20.96. Import latency was roughly 161 seconds. The new licensed Truth Social API claims millisecond delivery but is a commercial product, while free scraping is restricted. With $500, generic sentiment classification is unlikely to repay the feed and selection costs. AI should monitor exact official declarations that deterministically settle a predicate, not infer vague mood.

### Crypto options

Continue the Deribit collector because the marginal storage cost is low, but score only exact expiry or a mathematically bounded interpolation. In the inspected universe there were 1,534 instruments and 36 target markets but no exact expiry. DVOL and unsupported short-horizon extrapolation are not an honest binary price.

## Falsified or unsupported directions

| Lane | Evidence | Decision |
|---|---|---|
| MAIN/BTC heuristic prediction | The Polymarket quote is better calibrated; valid forward controls remain negative | Keep as negative control |
| BTC→ETH/SOL/XRP lead-lag | 180-day tests were negative after doubled costs or generated almost no signal | Reject until a genuinely new causal feed exists |
| Funding and spot/perp carry | Binance/Hyperliquid and seven-day Poly/Binance tests were negative after realistic costs | Reject generic version |
| Final-10-second settlement reversal | 16 high-push windows produced negative stressed PnL | Use only as manipulation/adverse-selection guard |
| Generic flow/front-running | Prior flow lab did not establish positive post-cost markouts; public transactions are not atomic information | Reject |
| Generic passive market making | Strongly negative modeled fills and rewards far below adverse-selection loss | Reject |
| Blanket Kalshi parlay selling | 470 settled contracts: negative aggregate, negative second half, only 4/13 positive days | Reject |
| Signal inversion | Costs, fill selection and asymmetric binary payoff mean the opposite of a loser is not automatically profitable | Do not invert |
| High-leverage perps | No validated directional edge; leverage magnifies model error, liquidation and venue risk | Do not use as an edge substitute |
| DEX/CEX atomic arbitrage | TV2 lacks synchronized mempool, gas, private-orderflow and executable multi-venue depth needed to test it | Blocked on data and capital |

## AI's proper role

AI can create an advantage in **coverage and interpretation**, not waive the need for proof.

Use it for:

- proposing sibling events and cross-venue matches from thousands of obscure contracts;
- extracting candidate predicates, units, comparators, time zones, sources and cancellation clauses;
- identifying newly launched rule/feed cohorts such as ZEC TWAP or equity Pyth markets;
- classifying catalysts and linking official source documents;
- generating hypotheses for a pre-registered experiment queue.

Do not use it for:

- declaring two contracts equivalent;
- inventing a fair probability without calibration;
- changing thresholds in response to recent PnL;
- routing live capital to whichever strategy is on a short winning streak;
- proving a payoff identity.

The correct pipeline is:

```text
LLM candidate proposal
  -> typed predicate AST
  -> exact rule/source hash
  -> deterministic state enumeration
  -> payoff proof
  -> synchronized executable depth
  -> fee/slippage/orphan stress
  -> frozen paper experiment
```

Every model name, prompt, source document and parser version must be hashed into the experiment manifest. A future contextual router may allocate among strategies only after each component has independently passed; online winner-chasing across unproven arms is another multiple-testing machine.

## World-class execution and data kernel

One deterministic kernel should drive replay, paper and eventual live operation. Strategy code must never know which mode it is in.

### Required event record

Each source event needs:

- immutable source payload;
- source timestamp and provider-publish timestamp;
- local wall-clock receive time;
- monotonic receive time;
- connection epoch and shard;
- venue sequence or locally assigned sequence;
- clock uncertainty and stale flag;
- rule hash, fee-schedule hash and market-universe version.

Signal/risk state remains in memory. Decisions append to the local durable WAL before asynchronous local PostgreSQL persistence. PostgreSQL and the dashboard must never block order submission. Immutable segments are checksummed, compacted to ZSTD Parquet and archived off-host.

### Capture policy

Twenty-seven gigabytes/day is not inherently “world class”; it is waste if low-value duplicate full snapshots crowd out high-fidelity target data. Use tiers:

1. **Core always-on:** all BBO changes, trades, source timestamps and connection controls for the selected research panel.
2. **Candidate burst:** full L2 diffs and external-feed events from 10 minutes before to 10 minutes after a candidate.
3. **Control sample:** randomized full-depth windows with no signal, needed to estimate selection bias.
4. **Catalog:** low-frequency immutable rules, fees, rewards and market relationships.
5. **Discard/aggregate:** redundant unchanged snapshots after checksum and summary extraction.

Preserve raw data for the top experiments; downsample only after immutable archival. Data quality must be a column in every PnL table, not a dashboard banner detached from the result.

### Multi-leg state machine

```text
DISCOVERED
  -> CERTIFIED           exact payoff/rule proof
  -> QUOTED              all legs fresh and capacity known
  -> RESERVED            capital and orphan reserve locked
  -> LEG_A_SENT
      -> BOTH_FILLED     terminal/exit management
      -> A_FILLED_B_OPEN retry B within bounded price/time
      -> A_FILLED_B_GONE hedge/unwind A under worst-case policy
      -> A_REJECTED      release reservation
  -> RECONCILED          venue fills, fees and positions agree
```

The leg order minimizes expected orphan loss, not nominal latency. Every displayed opportunity must report the worst transition-state loss.

## Statistical operating system

Every new idea consumes a finite research budget. Use a frozen registry and online false-discovery control rather than spawning dozens of correlated variants.

Minimum promotion standard:

1. at least 300 fresh independent units;
2. at least 14 days for frequent resolver windows and 30 days for sports/cross-venue/options;
3. positive doubled-cost PnL in both chronological halves;
4. market/day-clustered lower confidence bound above zero;
5. Deflated Sharpe or an equivalent correction for the number/correlation of trials;
6. positive results at 100, 250 and 500 ms;
7. realistic non-fills, partial fills, queueing, depth and cancel acknowledgement;
8. positive capacity under one shared $500 portfolio;
9. no event, asset or day contributing more than 20–40%, as pre-registered;
10. an untouched successor cohort before live capital.

After passing, use a 50-fill authenticated pilot at $1–$2 per order. Scale only when real fill prices, rejection rates, markouts and PnL match paper. Cross-instrument bundles require enough uncommitted capital for the second leg and emergency unwind.

## Capital and realistic economics

No current result can be honestly annualized. Useful bounds are:

- the one orphan-safe NegRisk episode was worth about $0.14;
- the best transient sports equality was worth roughly $0.42 at ordinary fees and $0 at doubled-fee stress;
- the two SPY discovery bundles showed $2.41–$3.67 per 100-token bundle **before** brokerage costs, basis reserve and synchronized execution;
- ZEC showed $0 executable profit because no trades and nearly one-dollar spreads were observed;
- historical NBA moneyline/spread research implied about $19/day gross under older assumptions, but current fees likely erase much or all of it.

For a $500 account, initially reserve at least 50% for second legs and unwind. A sensible research capacity is one $75–$125 cross-instrument bundle or $5–$20 per single-venue opportunity. The objective is first to prove a few dollars/day with a lower confidence bound above zero. Scaling a false edge merely loses faster.

## Immediate experiment slate

### Next 24 hours

1. Freeze `EQOPT_V1`; capture tomorrow's SPY/EWY Pyth markets, CLOB L2, price-to-beat, Pyth ticks and licensed OPRA verticals while both venues are open.
2. Add a source-basis ledger comparing Pyth 3:59 candle, SIP/OCC 4:00 close and official exchange close.
3. Freeze `SPORT_GRAPH_V1`; group all sibling Gamma events by physical fixture and implement the 0–0/neither/Under-0.5 equivalence family first.
4. Enrol ZEC without changing BTC/ETH/etc. arms; collect spot, TWAP30 and TWAP60 on redundant, freshness-watched sockets.
5. Mark a new evidence epoch after collectors pass a 24-hour no-gap burn-in.

### Next 30 days

- expand sports predicates from exact equalities to score-derived implications;
- collect authenticated reward scoring and actual earnings on fair-bound paper quotes;
- run passive and aggressive arms without changing thresholds;
- retain exact-rule Poly/Kalshi and NegRisk scans as low-cost background programs;
- publish weekly cluster-level results including zero-trade and failed-data days.

### 30–90 days

- promote only a lane that passes the full standard;
- purchase faster or deeper data only after delayed/free-source ablation shows incremental post-cost PnL;
- if no lane has a positive clustered lower bound, conclude measured edge is approximately zero and stop funding execution optimization.

## Source and reproducibility notes

Primary venue documentation consulted:

- [Polymarket fees](https://docs.polymarket.com/trading/fees)
- [Polymarket RTDS](https://docs.polymarket.com/market-data/realtime-data)
- [Polymarket liquidity rewards](https://docs.polymarket.com/programs/liquidity-rewards)
- [Polymarket order scoring](https://docs.polymarket.com/api-reference/trade/get-order-scoring-status)
- [Polymarket authenticated reward earnings](https://docs.polymarket.com/api-reference/rewards/get-user-earnings-and-markets-configuration)
- [Polymarket order mechanics](https://docs.polymarket.com/trading/place-orders)
- [Polymarket resolution](https://docs.polymarket.com/concepts/resolution)
- [Cboe option settlement/trading-hours FAQ](https://www.cboe.com/document/tech-spec/document/technical-specifications/equity-options-extended-trading-hours-faq/)
- [Cboe delayed-quote page and automated-extraction restriction](https://www.cboe.com/delayed_quotes/API/quote_table)
- [OCC ETF options](https://www.theocc.com/clearance-and-settlement/clearing/etf-options)
- [Interactive Brokers market-data pricing](https://www.interactivebrokers.com/en/pricing/market-data-pricing.php?p=mktDataPricing)
- [Interactive Brokers US options commissions](https://www.interactivebrokers.com/en/pricing/commissions-options.php?re=amer)
- [Chainlink Data Streams documentation](https://docs.chain.link/data-streams)

Research references:

- [Arbitrage-free combinatorial market making via convex optimization](https://arxiv.org/abs/1606.02825)
- [Prediction-market arbitrage under NegRisk adapters](https://arxiv.org/abs/2608.00666)
- [Sports prediction-market moneyline/spread arbitrage study](https://arxiv.org/html/2605.00864)
- [Prediction markets versus options-implied binary prices](https://arxiv.org/abs/2606.19517)
- [High-frequency settlement-window behavior](https://arxiv.org/html/2606.31675)
- [Deflated Sharpe ratio](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf)
- [Probability of backtest overfitting](https://scholarworks.wmich.edu/math_pubs/42/)
- [Online false-discovery control](https://proceedings.mlr.press/v80/ramdas18a.html)

Local evidence sources include the current TV2 PostgreSQL tables, verified Parquet/WAL catalog, structural and cross-venue audit scripts, strategy manifests and direct 5 August live API/WebSocket observations. The temporary research probes are not production collectors and their observations must be re-established in a frozen, durable experiment.

## Final board conclusion

There is no defensible evidence that DeltaForge can currently earn $100–$200/day from $500, and the old profitable-looking BORG rows do not become real edges by relaunching, tuning or reversing them. The strongest path is now much more specific: use options to bound exact-expiry Pyth equity binaries; extend the formal payoff graph across every market representing the same physical sports event; and capture new resolver products at launch before liquidity and competition mature. These programs have real mechanisms, measurable failure states and capital-compatible capacity. They may still produce zero edge. That possibility must remain an acceptable—and valuable—research result.
