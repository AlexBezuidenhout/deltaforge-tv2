# Genuine-edge research and first implementation

**Research date:** 6 August 2026  
**Scope:** DeltaForge / TV2, $500–$1,000 research bankroll  
**Authority:** paper research only; no live-order path was added or enabled

## Outcome first

The strongest next edge is not another generic BTC directional model. It is a small-capacity, rule-heavy payoff discrepancy that can be proved against executable depth. Two concrete versions now have implementation foundations:

1. a cross-event sports payoff graph that joins separate Polymarket events by an exact physical fixture identifier and proves the terminal payoff under completion and cancellation; and
2. a same-day Pyth equity threshold hedged by an exact-expiry listed-option vertical, with a frozen resolver/settlement basis bound.

The resolver-boundary lane remains a third priority, but a material measurement defect had to be fixed first: transport traffic could make a stale economic source look fresh, and one fresh asset could mask another stale asset. That is now fail-closed.

None of these programs is proven profitable. A current read-only sports scan found 101 rule-certified fixtures, but **zero** bundles positive after doubled fees and **zero** orphan-safe qualified bundles at the sampled books. The equity readiness scan found 11 exact SPY thresholds, but no licensed synchronized option feed and no 30-day Pyth/OCC basis sample. Those are honest research leads, not PnL claims.

## What a genuine edge must contain

An observed price discrepancy is not yet an edge. For a structural bundle of quantity \(q\), the relevant quantity is:

\[
E_{lock}(q)=\min_{\omega}Payoff(q,\omega)-C_{walked\ asks}(q)-Fees_{2x}(q)-Slippage(q)-OrphanReserve(q).
\]

For a predictive trade, replace the guaranteed terminal payoff with a conservative fair-value lower bound:

\[
E_{pred}(q)=q\,[p_{lower}-ask]-Fees_{2x}-Slippage-ModelRiskReserve.
\]

A genuine small-desk edge therefore needs all of the following:

- a causal information source or an exact payoff relation;
- the executable ask, not midpoint, last trade or displayed probability;
- synchronized depth at the intended quantity;
- current fee metadata and pessimistic slippage;
- explicit non-fill, partial-fill and orphan-leg states;
- enough absolute capacity to matter after fixed costs;
- independent forward observations, with correlated strikes and repeated ticks clustered together;
- a plausible reason the opportunity survives competition, such as low absolute capacity, rule complexity, fragmented capital, resolver friction or awkward execution.

The target should initially be a repeatable $2–$10/day at $500, not an assumed $100–$200/day. The latter is a 20–40% daily return on capital and would normally imply leverage, severe tail risk, exceptional turnover or a result that will not survive live execution.

## Where an amateur or bad algorithm fails

### 1. It predicts the outcome instead of beating the quote

Being directionally correct 70% of the time can still lose if the average winner was bought at 0.90. The market quote is the prior. The model must explain only a residual and clear the executable ask plus costs.

### 2. It treats a WebSocket heartbeat as fresh market information

PONG, subscription acknowledgements and unrelated asset ticks prove transport liveness, not economic freshness. A replayed source timestamp arriving now is still stale. Before this change, those conditions could contaminate resolver evidence.

### 3. It substitutes a similar resolver

Chainlink spot is not a 30-second or 60-second TWAP. Binance is not Chainlink. Pyth's final one-minute close is not necessarily OCC's underlying close. If the exact resolver feed is unavailable, the lane must abstain or carry a measured basis reserve.

### 4. It matches titles instead of legal predicates

“Team total over 0.5” is not “match total over 0.5.” Two contracts mentioning the same candidate or match can have different time zones, cancellation rules, comparators, sources or deadlines. Exact fixture IDs and machine-certified rule templates are mandatory; fuzzy matching may propose research candidates but may not certify them.

### 5. It assumes every token settles to zero or one

Polymarket contracts can settle 50/50 in cancellation or ambiguous states. A Boolean truth table can manufacture a false lock. The new proof engine supports explicit fractional payouts by terminal state.

### 6. It calls a sequential REST snapshot simultaneous

Fetching leg A and then leg B can create a historical price pair that never coexisted. Discovery scans are upper bounds. Executable evidence requires event clocks, local monotonic clocks, synchronized books and a latency replay.

### 7. It ignores atomicity

Two Polymarket orders and cross-venue legs are not one transaction. A profitable complete bundle can have a catastrophic proper subset. Qualification must subtract the worst executable unwind of every incomplete-fill state.

### 8. It confuses percentage edge with dollars

A 10% residual on three shares is not a scalable business. Rank by conservative dollars per unit of tied capital and duration, after book depth and venue minimums.

### 9. It backtests fills at midpoint or full displayed size

Midpoint is not a taker fill. A passive order starts behind queue-ahead and tends to fill when informed flow moves against it. Proper paper simulation needs queue depletion, partial fills, cancellation acknowledgement and 1/5/30-second adverse selection.

### 10. It overfits repeated observations

Thousands of ticks in one market are not thousands of independent trials. Multiple strikes on one event are correlated. Strategy selection across dozens of variants creates false winners. Freeze the rule, cluster by physical market/day and require an untouched successor.

### 11. It mixes price scales

Prediction tokens are 0–1 dollars per share. Options are dollars per underlying share with a contract multiplier, and BTC/ETH spot are native asset prices. Combining those numbers before explicit unit conversion can create enormous fictional edge.

### 12. It lets infrastructure sit on the order path

Waiting for PostgreSQL, a dashboard query or a remote database before submitting/cancelling destroys the value of a transient opportunity. Strategy state belongs in memory; decisions go to a durable local WAL first and persistence remains asynchronous.

## Implementation delivered

### A. Resolver evidence is now economically fresh, per asset

Changed components:

- `borg/recon/rtds.js`
- `borg/recon/rtds-multiplex.js`
- `borg/recon/research-universe.js`
- `borg/recon/markets.js`

The adapter now:

- records transport frames separately from accepted economic ticks;
- computes freshness from the worse of source age and local receive age;
- rejects replayed source timestamps even when they arrive on time;
- reports freshness independently for every configured asset and source;
- prevents one active symbol from masking a stale resolver symbol;
- recognizes ZEC as a research asset;
- distinguishes point/spot Chainlink rules from 30/60-second TWAP rules;
- refuses to use point-in-time RTDS evidence for a TWAP-resolved contract;
- clears historically contaminated point-source labels when discovery retypes a market as TWAP.

ZEC is deliberately **not** switched into the production multi-strategy collector yet. Doing that would silently change the population of frozen BTC/ETH/SOL/XRP hypotheses. It needs a dedicated capture-only service or a capture/evaluation split before deployment. A fresh official RTDS check also did not reproduce the earlier direct TWAP topics, so no spot proxy is permitted.

### B. Fractional terminal-state payoff proof

Changed components:

- `borg/research/payoff-proof.js`
- `borg/structural/condition-graph.js`

The proof compiler now accepts explicit per-predicate YES/NO payouts in each terminal state, validates complementary settlement, includes fractional states such as 0.5/0.5, computes a content-addressed proof and exposes the guaranteed minimum payout. The Boolean Bregman projection is not applied to those fractional states.

### C. Cross-event physical-game graph

New or changed components:

- `borg/structural/physical-event-graph.js`
- `borg/structural/scanner.js`
- `borg/structural/experiment.js`
- `borg/experiments/structural-sports-physical-floor-v1.json`
- `src/routes/borg.js`

The first deliberately narrow relation is:

\[
YES(ExactScore=0\!:\!0)+YES(MatchTotalGoals>0.5).
\]

For a completed match this pays exactly one in either state. Under the certified cancellation templates currently supported, exact score resolves to 0–0 and match total resolves 50/50, producing 1.5. The relation is admitted only when both contracts have:

- the same exact venue fixture ID;
- the same settlement time;
- full-time scope excluding extra time and penalties;
- the expected cancellation and postponement templates;
- identical official-statistics/fallback policy;
- immutable rule documents and content hashes.

Participant team totals are hard-vetoed. Candidates still pass through existing depth walk, fee stress, FOK feasibility and proper-subset orphan analysis. The scanner has no wallet, signer or order-submission dependency.

A current read-only scan produced:

- 1,830 Gamma events inspected;
- 104 candidate relations;
- 101 rule-certified relations;
- 3 rejected for mixed settlement time;
- 202/202 current books fetched;
- 0 positive after doubled fees;
- 0 orphan-safe qualified.

The nearest ordinary examples were approximately at parity before fees. This confirms that the graph is finding the intended contracts, but not that it has found money. The reason to run it event-driven is to measure whether short-lived, small-capacity states occur that a sequential REST snapshot misses.

### D. Exact Pyth equity threshold universe and robust option vertical

New components:

- `borg/equity-options/universe.js`
- `borg/equity-options/vertical-floor.js`
- `borg/experiments/equity-pyth-exact-expiry-v1.json`
- `scripts/equity-options-readiness.js`

The universe accepts only exact Pyth `Equity.US.*` close-above predicates, strict comparator semantics, a specified final regular-session minute, explicit no-session 50/50 handling, official fallback, corporate-action adjustment and known current fees.

The evaluator supports two robust complements:

- Polymarket NO plus a call vertical whose upper strike is below \(K\) by at least the frozen Pyth/OCC basis bound;
- Polymarket YES plus a put vertical whose lower strike is above \(K\) by at least that bound.

It keeps token and option price units separate, walks full Polymarket depth, uses exact-expiry timestamped option quotes, enforces American/physical/unadjusted contracts, charges doubled fees and commissions, adds one option tick per leg, reserves for assignment and evaluates every incomplete-fill subset. It refuses qualification without at least 30 untouched basis days, a regular-session print and corporate-action clearance.

The reproducible command is:

```bash
npm run research:equity-options-readiness
```

At 09:41 UTC on 6 August it found 11 certified SPY thresholds with a 4% fee coefficient and five-share venue minimum. It returned `TARGETS_READY_BUT_LICENSED_OPTIONS_ADAPTER_REQUIRED`: no OPRA adapter is configured and the basis sample is not ready. It did not score or invent PnL.

## Implementation completion update

The five items below are now implemented as a paper-only release candidate:

- the v1 cross-event sports floor remains frozen and the separate v2 graph
  adds exact-score implications for match result, BTTS and first scorer;
- a read-only IBKR Client Portal adapter captures licensed OPRA quotes and
  rejects delayed/frozen entitlement codes;
- a daily source-basis ledger accepts only the exact final Pyth one-minute
  candle and official primary-listing close; ordinary RTDS and broker-last
  controls are persisted but cannot qualify;
- a redundant ZEC observer consumes the documented Chainlink 30/60-second
  TWAP topics with exact E18 values and explicit source/publisher/local clocks;
- a shared execution-attribution table separates detection, simultaneous
  executability, cost qualification, orphan safety, paper submission, partial
  fill, full fill, cancellation and orphan states.

All three successor manifests start from zero. OPRA and exact-close collection
remain externally blocked until legitimate licensed endpoints are configured.
That is a visible prerequisite, not a software-created profitability result.

## Original implementation backlog (now addressed)

### 1. Event-driven sports forward experiment

Implemented in the structural scanner and frozen manifests. The independent unit remains `physical fixture × relation`, not a book tick.

### 2. Licensed equity-option adapter

Implemented as a read-only, entitlement-aware adapter and exact-source basis ledger. Legitimate external subscriptions/endpoints still have to be supplied by the operator.

### 3. Capture-only resolver rollout service

Implemented as an isolated capture service using the now-documented direct TWAP topics. Spot substitution remains impossible by construction.

### 4. More physical identities, one at a time

Exact score versus first scorer/result/BTTS is implemented as v2 with explicit cancellation states. Same-fixture spread implications remain a later, separately versioned hypothesis because score-to-spread settlement and push/cancellation rules need their own compiler.

### 5. Execution attribution

The canonical state ledger is implemented and exposed read-only in TV2. Fill markouts and capital-duration aggregation can only populate once forward paper submissions and fills exist.

## Promotion rule

No lane should receive live capital until it has at least 300 fresh independent units; 14 days for frequent crypto or 30 days for sports/cross-instrument work; positive doubled-cost PnL in both chronological halves; market/day-clustered lower confidence bounds above zero; multiple-testing correction; positive performance at 100, 250 and 500 ms; realistic non-fills and partial fills; positive capacity under the shared $500 bankroll; and no dominant event, day or asset.

After passing, begin with a 50-fill authenticated canary at $1–$2 per order. Paper mode remains the default, and this implementation does not authorize or add a live-order path.

## Verification

- `npm test`: **721 passed, 0 failed**.
- JavaScript syntax checks: passed for all new and modified runtime modules.
- `git diff --check`: passed.
- Current sports and equity checks were read-only; no orders or external state changes were made.

## Primary references

- Polymarket market WebSocket: https://docs.polymarket.com/market-data/websocket/market-channel
- Polymarket order-book structure: https://docs.polymarket.com/trading/orderbook
- Polymarket RTDS: https://docs.polymarket.com/market-data/websocket/rtds
- Polymarket fees: https://docs.polymarket.com/trading/fees
- Polymarket sports WebSocket: https://docs.polymarket.com/market-data/websocket/sports
- Polymarket order mechanics: https://docs.polymarket.com/trading/orders/create
- OCC ETF option characteristics: https://www.theocc.com/clearance-and-settlement/clearing/etf-options
- Interactive Brokers API and market-data subscriptions: https://ibkrcampus.com/campus/ibkr-api-page/cpapi-v1/ and https://ibkrcampus.com/campus/ibkr-api-page/market-data-subscriptions/
- Pyth historical price-feed API: https://docs.pyth.network/price-feeds/pro/api/history
- Chainlink Data Streams: https://docs.chain.link/data-streams
- Polymarket Chainlink TWAP streams: https://docs.polymarket.com/market-data/chainlink-twap
