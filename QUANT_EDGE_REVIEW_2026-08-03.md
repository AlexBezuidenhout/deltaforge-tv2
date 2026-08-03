# DeltaForge / TV2 quantitative edge review — 3 August 2026

Evidence cut-off: 3 August 2026, approximately 12:05 UTC. This is a read-only investment-committee review. No live-order path was changed and no result below authorizes live trading.

## Executive conclusion

There is no strategy in TV2 that currently demonstrates bankable positive expected value. The broad MAIN logic is now decisively falsified: its post-only and 250 ms taker implementations lost about **$904** and **$1,131** respectively after doubled-cost accounting across roughly 1,350–1,550 A/B-quality fills. The market itself is a better probability estimator than every current MAIN model. The strongest mechanism-level lead remains resolver-boundary trading, but its admissible H43 subset is only 26 fills over six days, with 94% of profit coming from one day; the clean current cohort has only two fills. A newly identified deep-longshot subset is sufficiently interesting to deserve one untouched successor trial, but it is post-hoc and high variance. Exact-rule Polymarket/Kalshi arbitrage has not actually been tested because the rule engine vetoes every candidate. With $500, a validated **$2–$10/day** low-capacity edge would be an excellent outcome. There is no defensible route from the present evidence to **$100–$200/day**; that target is a 20–40% daily return and would require far more validated turnover, capacity, capital, or risk.

## 1. What data was admitted

Three evidence layers were kept separate:

1. **Current row-level evidence:** current experiment identity, one independent market/window, A/B data quality, A/B execution fidelity, causal fill simulation, and doubled costs.
2. **Older forward diagnostics:** frozen post-discovery cohorts that remain useful for hypothesis generation but predate the current clean-evidence epoch or include lower-fidelity execution.
3. **Operationally clean slice:** the collector run beginning `2026-08-02T00:00:24Z`, which had remained continuously active for about 36 hours at the cut-off.

The formal epoch `backlog-forward-2026-07-27-v17` is **FAILED**, not clean. It contains 4,079 abandoned collector runs, 8,032 error/critical events, and 9,027 failed health samples out of 9,328. A/B fill coverage improved from roughly 61–80% earlier in the period to 83.8% on 3 August, but the epoch never achieved admissible uninterrupted coverage. Row-level A/B observations can be inspected, but no strategy can pass promotion while the epoch remains contaminated.

There are 186 registered trials and 137 multiple-testing arms. None has passed the desk promotion policy.

## 2. Current strategy P&L

The table uses only the current trial cohort and doubled-cost P&L. “Why it is not edge” is the binding failure, not a cosmetic caveat.

| Strategy | A/B fills | Days | P&L 2x | Read |
|---|---:|---:|---:|---|
| H54 dynamic OFI + resolver | 7 | 4 | +$33.26 | One market supplied +$30.60; 500 ms replay was −$5.74 |
| H45 threshold velocity | 17 | 7 | +$13.46 | Second half −$3.57; without best market −$7.04; all latency replays negative |
| H71 token elasticity | 11 | 4 | +$10.20 | Without XRP −$10.56; without best market −$5.68 |
| H67 queue depletion | 13 | 6 | +$7.31 | Without best market −$12.05; without BTC −$17.84 |
| H7 oracle confirm | 10 | 5 | +$2.99 | 100/250/500 ms counterfactuals all substantially negative |
| H43 resolver boundary | 2 | 1 | +$1.35 | Clean current sample is effectively absent |
| H1 pair arb | 4 | 3 | +$0.54 | First half −$6.73; slower profiles negative |
| H60 bipower jump | 3 | 3 | −$1.32 | Insufficient and second half negative |
| H69 quarticity | 10 | 3 | −$8.79 | First half −$10.18 |
| H20 basis reversion | 5 | 4 | −$14.69 | No positive mechanism read |
| H72 nested lock | 20 | 8 | −$19.13 | Day-clustered interval is below zero |
| H65 Kalman consensus | 140 | 8 | −$20.28 | Negative and highly latency-fragile |
| ETH late-window exact | 61 | 8 | −$27.54 | Both halves negative; old “$22/day” discovery did not replicate |
| H40 entropy breakout | 16 | 5 | −$34.02 | Market/day evidence is negative |
| H61 volatility regime | 58 | 8 | −$46.11 | First half −$51.03 |
| H15 jump sigma | 87 | 8 | −$57.63 | Both halves negative |
| H38 passive flow divergence | 36 | 8 | −$62.88 | Both halves negative |
| H24 hourly breakout | 76 | 7 | −$80.92 | First half −$120.56; unstable sign |
| H44 hourly reversal | 29 | 8 | −$113.53 | Both cluster confidence intervals strictly negative |
| H73 market-prior residual | 44 | 8 | −$141.94 | Both cluster confidence intervals strictly negative |
| MAIN post-only | 1,548 | 8 | **−$904.27** | Both halves and both clustered intervals strictly negative |
| MAIN taker 250 ms | 1,352 | 8 | **−$1,131.22** | Both halves and all 100/250/500 ms profiles negative |

The shared-$500 counterfactual that admitted all collecting strategies ended at $1.53, for −$498.47 and a −$521.65 maximum drawdown. This is not a proposed portfolio—it intentionally combines many negative controls—but it proves that indiscriminately combining “promising” lines is not diversification.

## 3. Forecasting autopsy

### Paired calibration on resolved markets

The raw Polymarket quote is a better forecast than Φ, the heuristic, the ensemble, and the residual challenger. Lower is better.

| Stable slice since 2 Aug | n | Brier | Log-loss |
|---|---:|---:|---:|
| Raw Polymarket quote | 1,616 | **0.2104** | **0.6093** |
| Ensemble | 1,579 | 0.2229 | 0.6379 |
| Heuristic | 1,597 | 0.2233 | 0.6389 |
| Φ model | 1,597 | 0.3006 | 1.1465 |

The same ordering holds in the earlier part of the 14-day window. The ensemble-minus-market paired Brier disadvantage is +0.0103 earlier and +0.0133 in the stable slice. The newer challenger also fails: raw market Brier was 0.2197, versus 0.2298 for legacy, 0.2300 for the residual, and 0.2386 for the transformed “market baseline.”

The Φ model is especially dangerous at the extremes. Across the joined resolved sample, Φ’s 0–20% bucket realized UP about 43%, while its 80–100% bucket realized UP only about 58%. By contrast, Polymarket’s 0–20% bucket predicted 16.15% and realized 16.32%.

### Consequence

MAIN must not generate fair value independently and then call the distance to market “edge.” The only defensible architecture is:

`fair log-odds = executable-market-prior log-odds + small prequential residual`

The residual must be trained only on prior data, regularized strongly toward zero, and traded only when a conservative lower bound clears the executable ask, doubled fees, slippage, and failure reserve. Existing H73 attempted a residual approach but did not satisfy this standard and lost $141.94.

## 4. The two empirical leads

### 4.1 H43 resolver-boundary transfer

The headline cohort contains 81 attempts, 47 terminal-scored fills, 45 wins, and +$36.48 after doubled costs. That headline includes B/C execution fidelity.

The strict A/B subset is:

- 26 fills, 24 wins, +$14.70 after doubled costs.
- Chronological halves: +$12.52 / +$2.18.
- Six trading days; best day +$13.87.
- P&L excluding the best day: only +$0.83.
- Day-clustered t-style lower 95% bound: −$3.50 per day.
- BTC −$4.92, ETH +$17.23, SOL +$1.82, XRP +$0.57.
- Two failures lost −$2.60 and −$10.27; one ordinary late jump can erase many high-price wins.

The source-specific current cohort is smaller still: only two strict A/B Chainlink-referenced fills, for +$1.35 on one day. At 100/250/500 ms the current counterfactual totals were −$0.64, −$1.89, and +$3.97, all with inadequate quality coverage.

Verdict: **best existing mechanism, not validated edge**. Keep H43 unchanged as a control. Register a separate event-driven successor that uses the exact resolver feed and a conservative remaining-time tail bound. Do not select ETH or discard BTC from the old cohort; that would be post-hoc asset tuning.

### 4.2 Deep-longshot MAIN residual — newly discovered, provisional

The broad MAIN taker arm is dead, but its fixed 0–20¢ analysis bucket produced:

- 29 independent A/B fills over eight days.
- Seven wins; 24.1% win rate, Wilson 95% interval 12.2–42.1%.
- Mean intended price approximately 12.8¢.
- +$95.62 after doubled costs.
- Chronological halves +$66.09 / +$29.53.
- Largest trade +$51.32; P&L without it +$44.30.

This is worth a fresh test because the exact taker implementation, not a backfilled midpoint, generated the fills. It is not proof because:

- The bucket was found after inspecting five price buckets and 137 strategy arms.
- Only seven tail wins drive the result.
- Four of eight calendar days were negative.
- The broad 100/250/500 ms strategy is negative at every latency.
- The general market longshot bucket is almost perfectly calibrated, so there is no generic “cheap longshots” effect.
- Capacity at 5/10/25 shares and the conditional 100/250/500 ms replay have not been reported.

Verdict: register one **paper-only, frozen, explicitly PROVISIONAL** successor. Preserve the current model and fill mechanics, restrict the pre-registered arm to the discovered state, cap stake at $10, and collect 300 fresh markets. Do not backfill this rule into the 29 discovery trades or scale it from the discovery P&L.

## 5. Structural and cross-venue lanes

### Exact-rule Polymarket/Kalshi

The collector produced 334,072 synchronized observations across 88 pairs in about 36 hours, but the exact-rule forward report contains zero entries. All 12,411 catalogued candidates are marked `hard_mismatch`; none is `exact_rule_eligible`.

The dominant vetoes are missing or unresolved observation time, resolver, fallback, strike, and settlement-precision fields. Missing evidence and contradictory evidence are currently collapsed into the same hard-veto state. That is safe for trading but makes the research experiment impossible.

This lane therefore has **no P&L conclusion**. It has not shown zero edge; it has not run. The repair is a typed rule grammar with three states per field:

- `CERTIFIED_EQUAL`
- `CERTIFIED_DIFFERENT`
- `UNKNOWN`

Only `CERTIFIED_DIFFERENT` is a hard mismatch. `UNKNOWN` remains blocked from terminal-arbitrage execution but goes to a finite review queue. Rule snapshots, timezone, comparator, rounding, resolver, fallback and market close must be hashed. Risky convergence must remain a separate product and must never be called risk-free.

### Certified payoff graph

The recent structural scanner evaluated approximately 490,000 states on 2 August and 187,000 on 3 August, covering about 301 distinct current candidates. All passed the deterministic proof/rule machinery, but **zero** were economic or orphan-safe after doubled fees. The best orphan-safe residual remained negative.

The passive structural lane has 902 unfilled timeouts, 211 rule-change cancellations, 25 process-restart abandonments, and no completed fill. Ten quotes were resting at the cut-off.

Verdict: the scanner is correctly rejecting arithmetic mirages. Keep it as a low-cost monitor. The most useful extension is the ordered-strike implication bundle: for `K1 < K2`, `YES(S>K1) + NO(S>K2)` has worst-state payout at least $1. It qualifies only when both rule hashes match and its walked, orphan-reserved cost is below $1. A passive-first variant may reduce fee drag, but no current tape proves that it fills safely.

## 6. Options, flow and making

### Deribit options-implied binary

The current hot tier contains roughly 36,900 repeated executable marks but only about 13 independent markets. Only one resolved A-grade exact-surface event was scoreable, for roughly +$0.15 modeled P&L. Most current marks use B-grade term interpolation and remain unresolved; the runtime exact-expiry counter was zero at the evidence snapshot.

This is a data lane, not a strategy result. Keep only exact-expiry or mathematically bounded bid/ask interpolation. Fair value must be an interval derived from executable option quotes, not DVOL or mark IV. A perpetual hedge should be charged at executable spread plus funding and used only if it reduces total residual variance.

### Public-flow scalping

Both primary flow mechanisms are negative after doubled fees at every latency:

- Absorption reversal, 5-second mark: −$11.06 / −$3.62 / −$9.43 at 100/250/500 ms.
- Cost-confirmed continuation, 5-second mark: −$6.36 / −$2.77 / −$14.57.

Fill rates are below 1% and filled orders are adversely selected. More latency engineering will not rescue this mechanism.

### Paired maker

The main control completed only 17.3% of filled cycles. Locked spread was +$84.82, while orphan exits lost −$2,998.54. Stressed P&L was **−$3,400.42**, negative in both halves, with a clustered interval entirely below zero. Modeled rewards were only about $75 and were neither authenticated nor claimed.

Verdict: generic paired making is decisively dead. A one-sided fair-bound maker may eventually be tested inside a validated resolver strategy, but not as a standalone spread harvester.

## 7. Capital and realistic P&L

| Read | Observed discovery rate | Bankable rate today | Capital comment |
|---|---:|---:|---|
| H43 strict A/B | +$14.70 / 13 elapsed days (~$1.13/day) | $0/day | $500 is already enough; opportunities and tail risk are limiting |
| H43 all fidelity | +$36.48 / 13 days (~$2.81/day) | $0/day | Lower-fidelity fills cannot be monetized as evidence |
| Deep-longshot subset | +$95.62 / 8 days (~$11.95/day) | $0/day | Discovery-only; high variance and capacity not replayed |
| Exact cross-venue | No admitted entries | $0/day | Would require capital on both venues and orphan reserve |
| Structural payoff | Zero economic candidates | $0/day | Capital is not the bottleneck |
| Exact options | One scored event | $0/day | Too little evidence |

The correct planning range, conditional on one lane actually passing, is initially **$2–$10/day on $500**, not $100–$200/day. A $100/day target is a 20% daily return. Linear extrapolation from H43 would imply tens of thousands of dollars before considering depth, but the observed opportunities are explicitly low capacity, so linear scaling is invalid. Increasing stake from $10 to $50 or $100 before depth replay would multiply the binary tail losses without proving that the quote could fill.

## 8. Biggest shortfalls

1. **The evidence epoch is invalid.** Process liveness is not evidence integrity.
2. **The model fights the market prior.** The raw quote is materially better calibrated.
3. **Execution truth is incomplete.** No strategy has a 50-fill authenticated $1–$2 canary reconciled against paper.
4. **Cross-venue identity is stalled.** Missing rule fields are treated as contradictions, yielding zero exact pairs.
5. **Derived data overwhelms useful data.** `borg_option_shadow_marks` used 27 GB on 2 August and another 14 GB by noon on 3 August—about 27–30 GB/day for repeated derived states.
6. **Analytics runs on the hot execution database.** A full-table options report spilled to disk and held relation locks long enough to queue partition DDL and writers. Reports must never share the latency-critical database path.
7. **Replay availability is incomplete.** The hot `borg_book_snaps` table retains only 2–3 August. Raw CLOB WAL exists in Google Drive, but the latest upload report was incomplete, and there was no directly usable archived `borg_book_snaps` replay set.
8. **Capacity is not independently measured.** A positive $10 paper fill says nothing about a $50 order.
9. **Too many arms, too little independent evidence.** 137 inspected arms make attractive small samples expected even under zero edge.
10. **Security hygiene:** credentials were present in plaintext service environment output during this audit. Rotate the exposed API/JWT/encryption/database secrets; do not copy their old values into reports or repositories.

## 9. Storage and research architecture

At the cut-off the 125 GB VPS disk had about 39 GB free. The options-derived mark table alone occupied about 41 GB across 2–3 August. This is not world-class capture; it is expensive duplication.

The target architecture is:

1. Append raw source events once to compressed WAL with source time, receive wall time, monotonic time, sequence, and connection epoch.
2. Persist normalized hot state and only **state transitions**, first executable intent, barrier changes, and terminal scores.
3. Do not persist every recomputed option mark after every equivalent trigger. Rebuild derived marks deterministically from raw events and a frozen manifest.
4. Compact immutable raw events to partitioned Parquet by source/date/hour, using dictionary encoding and Zstandard compression.
5. Keep 24–48 hours of hot PostgreSQL partitions. Archive before detaching.
6. Build small research fact tables: one row per independent market/strategy/latency, one row per cross-venue pair-direction-day, and one row per options event.
7. Run reports against Parquet or a read replica, never the execution database.
8. Replace rclone’s retiring shared Google client ID with a dedicated client and require a verified receipt before pruning.

This should cut derived-write volume by well over 90% without losing replayability.

## 10. Prioritized next experiments

### Priority 1 — H43-X exact resolver tail bound

- Preserve H43 unchanged as control.
- New identity; exact Chainlink resolver contract only.
- Event-driven 100/250/500 ms randomized arrival arms.
- One first attempt per market.
- Fair starts from executable market price; residual is the exact resolver/open displacement bounded by remaining-time jump risk estimated only from prior days.
- FOK depth walk, doubled fee, one-tick stress, authenticated-source age, no proxy resolver.
- $10 maximum and 20% displayed-depth participation.
- 300 fresh markets, 14 days, both halves positive, market/day lower bounds above zero, latency robustness, and no event/asset/day dominance.

### Priority 2 — provisional deep-longshot successor

- Freeze the discovered 0–20¢ state exactly; do not optimize it further.
- Preserve the existing model and 250 ms taker rule; add 100/500 ms counterfactuals.
- Report 5/10/25-share capacity and quote survival.
- $10 cap, one trade per market, no pyramiding.
- Discovery rows excluded; 300 fresh markets and 14 days.
- Explicit null: the 29-trade result may be tail luck and the true edge may be zero.

### Priority 3 — exact-rule cross-venue certification

- Separate `UNKNOWN` from `DIFFERENT`.
- Canonical key: predicate, subject, comparator, strike, observation instant, timezone, settlement precision, resolver and fallback.
- Deterministic terminal payoff proof and rule-document hash.
- Replay 5/10/25 shares using synchronized depth and per-market Kalshi fees.
- Separate terminal lock from risky convergence.
- 300 pair-direction-days and 30 calendar days before any canary.

### Priority 4 — exact-expiry options residual

- Persist one independent event record, not millions of repeated marks.
- Require exact expiry or bounded bid/ask interpolation.
- Use executable digital bounds and charged hedge cost.
- 300 markets and 30 days.

### Priority 5 — ordered-strike passive implication

- Only certified same-resolver/same-time strike ladders.
- Worst-state payout proof, passive queue model, immediate FOK hedge, full orphan reserve.
- Remains dormant unless cost after all stresses is below guaranteed payout.

## 11. What to stop spending time on

- Broad MAIN Φ/heuristic/ensemble directional trading.
- ETH late-window as currently defined.
- H44, H73 and H40; their clustered evidence is already negative.
- Generic public-flow front-running/scalping.
- Generic paired making.
- Inverting losing bots without constructing the executable opposite trade.
- Meta-selecting the recent “winner”; the current streak selector correctly emits no action because no source qualifies.
- More strategy proliferation before the five experiments above produce independent evidence.

## 12. Immediate sequence

1. Reduce options-derived persistence and move analytics off the hot database.
2. Verify Google Drive receipts and replayability, then mark a new evidence epoch.
3. Run 24 uninterrupted hours with no sequence gaps, persistence failures, lock convoys or restarts.
4. Freeze H43-X and the deep-longshot successor; do not alter their rules for 300 markets.
5. Repair the cross-venue typed rule grammar and measure how many pairs become `CERTIFIED_EQUAL`, `UNKNOWN`, and `CERTIFIED_DIFFERENT`.
6. At 14 days, publish the pre-specified reads including a zero-edge conclusion if warranted.
7. Only after a full pass, run 50 authenticated live fills at $1–$2. Scale to $5–$10 only if actual fill price, non-fill rate, rejection rate and post-fee P&L agree with paper.

## External mechanics checked

- Polymarket’s current fee rule is `shares × feeRate × p × (1-p)` and crypto taker fee rate is 0.07; makers are not charged. See [Polymarket fees](https://docs.polymarket.com/trading/fees).
- Polymarket exposes event-driven L2 and authenticated fill/order lifecycle streams; FOK is all-or-nothing and post-only orders reject if marketable. See [WebSocket overview](https://docs.polymarket.com/market-data/websocket/overview), [user channel](https://docs.polymarket.com/market-data/websocket/user-channel), and [order types](https://docs.polymarket.com/trading/orders/overview).
- Kalshi supports FOK/IOC, post-only and execution-reported fees; its fee and rounding behavior must be persisted per fill, not represented by one global constant. See [Kalshi order entry](https://docs.kalshi.com/fix/order-entry), [V2 order API](https://docs.kalshi.com/api-reference/orders/create-order-v2), and [fee rounding](https://docs.kalshi.com/getting_started/fee_rounding).
- Deribit recommends JSON-RPC WebSocket for real-time options data. See [Deribit API documentation](https://docs.deribit.com/).

