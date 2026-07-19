# Structural data and latency audit

> Historical research baseline. This report preserves the measured pre-cutover
> latency analysis and its caveats; it is not a current profitability claim.
> See `BOARD_STRATEGY_REVIEW_2026-07-17.md` for the latest promotion decisions.

Generated 2026-07-15. This is a read-only architecture and retained-event replay audit. It does not authorize a strategy for live trading, does not change any live-order path, and does not change the default `paper_trading=true` setting.

## Executive conclusion

DeltaForge does not primarily suffer from a lack of millisecond market data. The BORG collector already receives free, event-driven Binance and Polymarket WebSocket data. The largest delays are created after receipt: BORG strategies evaluate on a one-second timer, the G executor polls PostgreSQL once per second, and the main/DF2 bot evaluates every ten seconds while fetching executable books over HTTP. Main/DF2 also fail to parse the official Polymarket WebSocket book shapes correctly, so their apparent real-time cache is mostly a last-trade cache rather than a reliable executable-price cache.

The retained CLOB replay confirms that speed can matter: the median displayed best-ask state lasted only 109 ms, and 47.7% lasted under 100 ms. It does **not** establish that making every strategy faster creates profit. G late-arb lost more at 100 ms than at the 1,250 ms baseline. H2, H3, and H6 show provisional speed-sensitive uplifts, but those are exploratory, in-sample results with unadjusted confidence intervals and overlapping markets. They require a pre-registered forward paper split over at least 300 independent resolved markets per strategy and arm. No paid API is currently justified. The best first investment is a correct event-driven hot path, precise latency telemetry, and resolver-aligned Chainlink data.

## Current architecture

### BORG / TV2 shadow path

```text
Binance aggTrade + bookTicker + depth10@100ms (WebSocket)
Coinbase ticker (WebSocket, reference venue)
Polymarket L2 books/trades (WebSocket)
                         |
                         v
           in-memory books + completed 1s CEX bars
                         |
                  1s strategy timer
                         |
          shadow row; G immediately flushes to DB
                         |
        remote Neon PostgreSQL (AWS us-east-1)
                         |
                  1s G executor poll
                         |
             atomic DB claim -> CLOB order API
```

This path is safe against duplicate live orders because the executor claims each shadow signal in PostgreSQL before placing it. That safety property should be retained. The database and its polling cadence are nevertheless in the latency-critical path.

### Main TV2 / DF2 path

```text
Binance @ticker (1,000 ms updates) + 1m REST klines every 30s
Ethereum-mainnet Chainlink push feed polled every 30s
Polymarket WebSocket cache (incorrect book/delta parser)
                         |
                 10s main decision timer
                         |
        market discovery + YES/NO HTTP book requests
                         |
       Phi/heuristic -> ensemble -> gates -> sizing
                         |
               paper execution or live FAK path
```

The dashboard's 200 ms stream and one-second order-book refresher are display loops; they do not make the trading loop faster.

## Measured latency budget

Measurements were taken from this Mac and the retained collector data on 2026-07-15. They are not universal endpoint SLAs.

| Segment | Observed latency | Interpretation |
|---|---:|---|
| Polymarket CLOB event timestamp to local receipt | p50 12 ms; p90 87 ms; p99 355 ms | Includes local clock skew; inbound CLOB WebSocket is already fast enough to expose sub-second quote churn. |
| Binance aggregate trade timestamp to local receipt | p50 about 113 ms; p90 about 200 ms | Public WebSocket, measured over BTC/ETH/SOL/XRP. Network and timestamp semantics dominate, not the collector timer. |
| CLOB `/book` HTTP request | p50 50.5 ms; p90 127.3 ms | Acceptable for recovery, inferior to an already-open event stream for the hot path. |
| Remote pooled PostgreSQL `SELECT 1` | p50 114.6 ms; p90 181.4 ms | Database is in AWS us-east-1. A Dublin VPS would still cross the Atlantic if this DB remains in the hot path. |
| G signal timestamp to DB claim, all eligible rows | p50 937 ms; p90 2,804 ms | Includes immediate shadow flush, remote DB visibility, and the executor's one-second poll. |
| G signal timestamp to claim, actually placed live rows | p50 895 ms; p90 2,022 ms | This excludes the preceding wait for the collector's next one-second strategy evaluation. |
| Main/DF2 timer detection delay | expected about 5s; worst nearly 10s | Current `snipe_timer_seconds` is 10. This dwarfs feed and VPS differences. |

Local CPU is not the bottleneck: the host has ten cores and the observed Node processes had ample headroom. Rewriting the system in Rust or buying a faster CPU before removing the timers and HTTP fallbacks would be premature.

## Structural findings

### 1. Main/DF2 Polymarket WebSocket handling is not an executable-book feed

`src/bot/PolymarketPriceFeed.js` only accepts a top-level `asset_id` plus `price`. Official `book` messages carry `bids[]` and `asks[]`, while official `price_change` messages carry nested `price_changes[]`. Consequently, full books are ignored and the cache generally represents last trades, not the current best executable bid/ask.

The feed also sends only newly seen token IDs in a fresh initial-style subscription object. The documented dynamic protocol requires `operation: "subscribe"`. Unsubscribe only mutates local memory and sends no server message. The implementation uses a WebSocket control ping every 30 seconds, while the documented market/user heartbeat is text `PING` every 10 seconds. These are correctness and reliability defects, not tuning questions.

The signal engine masks the defect by fetching both YES and NO books over HTTP on every evaluation. That preserves some price correctness but discards the latency benefit of the socket.

Relevant code:

- `src/bot/PolymarketPriceFeed.js:54-59,107-123,143-170`
- `src/bot/GBMSignalEngine.js:295-344`
- The same feed implementation exists in DF2.

Official references: [Polymarket WebSocket overview](https://docs.polymarket.com/market-data/websocket/overview), [market-channel message formats](https://docs.polymarket.com/market-data/websocket/market-channel), and [order-book guidance](https://docs.polymarket.com/trading/orderbook).

### 2. Main/DF2 intentionally throw away most timing information

The main bot uses Binance `@ticker`, whose documented update speed is 1,000 ms, and stores 120 nominal one-second observations. It then evaluates on the ten-second `snipe_timer_seconds` loop. BORG already has the better free inputs: real-time `aggTrade` and `bookTicker`, plus depth at 100 ms. No paid Binance feed is needed to make this first improvement.

Relevant code:

- `src/bot/BinanceFeed.js:12-13,120+`
- `src/bot/BotInstance.js:244-268`
- `borg/recon/binance.js`

Official stream timing: [Binance Spot WebSocket streams](https://developers.binance.com/zh-CN/docs/products/spot/testnet/web-socket-streams).

### 3. BORG receives events quickly but evaluates features once per second

The collector updates its in-memory trade and book state on WebSocket messages, but microstructure is exposed through completed one-second bars and all shadow strategies are invoked by the collector's one-second timer. The hot strategies therefore cannot react to a move that occurs between ticks until the next second boundary.

Persistence batching is not the source of G's full five-second delay: `G_late_arb` is in the live-mirrored set and its place rows trigger an immediate fire-and-forget flush. The subsequent remote DB trip and one-second executor polling remain material.

Relevant code:

- `borg/recon/collector.js:106-178`
- `borg/recon/binance.js:139+`
- `borg/shadow/engine.js:128-168`
- `borg/live/executor.js:278-410`

### 4. The Chainlink feed is not the resolver-quality stream the comments imply

Main/DF2 poll an Ethereum-mainnet aggregator contract every 30 seconds. That is a push-oracle view and is not equivalent to consuming the Chainlink Data Stream used for a fast crypto-market resolution path. The comments therefore overstate the feed's resolver alignment. BORG's status showed this source more than 2,500 seconds stale while Binance, Coinbase, and CLOB remained current.

Polymarket now exposes free RTDS Binance and Chainlink topics. A direct 30-second probe of `crypto_prices_chainlink` produced roughly one update per second per supported asset, with approximately 1.3 seconds median embedded-timestamp age at this Mac. That is useful for measuring Binance/Chainlink divergence and abstaining near ambiguous boundaries; it is not a sub-millisecond feed. Polymarket also links sponsored Chainlink onboarding, which should only be considered after the free stream's incremental value is measured.

Relevant code: `src/bot/ChainlinkFeed.js:24-65` and `src/bot/BotInstance.js:214`.

Official references: [Polymarket RTDS](https://docs.polymarket.com/market-data/websocket/rtds), [Chainlink Data Streams](https://data.chain.link/streams), and [Chainlink Data Streams documentation](https://docs.chain.link/data-streams).

### 5. The collector's fallback design is mostly sound, with one parser hazard

BORG treats the CLOB WebSocket as authoritative, polling REST only when a book is older than three seconds and no more than once per token per 15 seconds. That is the correct relationship between streaming and polling.

However, its `price_change` branch reads `ev.changes`; the documented field is `ev.price_changes`. The currently observed venue behavior re-broadcasts full `book` messages on changes, which hides this defect. The parser should support both shapes before relying on incremental L2 state.

Relevant code: `borg/recon/clob.js:130-190,231-260`.

### 6. Millisecond REST polling is the wrong design

Polymarket explicitly recommends WebSockets rather than polling for real-time order books. Faster REST polling adds rate-limit queuing, connection overhead, stale responses racing newer responses, and unnecessary load. The correct design is one normalized in-memory L2 state per asset, sequence/hash validation, and REST snapshots only for startup or gap recovery.

Polymarket's public market socket supplies full books, price-level changes, top-of-book changes, trades, tick-size changes, new-market events, and resolutions. The authenticated user socket supplies order and trade lifecycle updates. Using those free streams removes more delay and uncertainty than increasing REST request frequency.

## Retained-event latency replay

### Method

`scripts/latency-sweep.js` performs a read-only replay over the retained `borg_clob_events` archive and resolved taker shadow signals.

- Coverage at the captured run (2026-07-15T15:08:36Z): 479 gzip archives, 2,087,086 archive rows scanned, 1,861 unique strategy/market/token signals, 1,042 tokens, about 23 hours 50 minutes.
- Repeated one-second emissions are deduplicated to the first strategy/market/token signal.
- At each synthetic downstream delay from 0 to 3,000 ms, the script checks whether the original marketable limit is still executable at the observed best ask.
- A fill is capped by displayed top-ask size and charged the official crypto taker fee curve with rate 0.07.
- The comparison baseline is 1,250 ms.
- The paired confidence interval aggregates PnL differences by market.

The replay does not reconstruct maker queue position, fills that rest and execute later, exchange acknowledgement delay, or signals that an event-driven strategy might have generated between the existing one-second CEX feature ticks. Those exclusions prevent false precision.

Run it with:

```bash
cd /Users/alexbezuidenhout/Desktop/deltaforge
node scripts/latency-sweep.js
```

Fee reference: [Polymarket fees](https://docs.polymarket.com/trading/fees).

### Market-state lifetime

Across 462,192 observed best-ask state durations:

| Metric | Duration |
|---|---:|
| p10 | 2 ms |
| p50 | 109 ms |
| p90 | 1,066 ms |
| States under 100 ms | 47.7% |
| States under 500 ms | 81.5% |

This proves that a one-second decision/execution path frequently sees a different quote. It does not prove that the newer or older quote is more profitable.

### All taker strategies combined

This aggregation is diagnostic only. Strategies overlap on the same markets and cannot be treated as an independently deployable portfolio.

| Synthetic delay | Immediate fills | Fill rate | Retrospective PnL | Difference vs 1,250 ms | Unadjusted paired 95% CI |
|---:|---:|---:|---:|---:|---:|
| 0 ms | 942 | 55.2% | $193.61 | +$147.93 | +$1.03 to +$294.83 |
| 100 ms | 903 | 52.9% | $175.10 | +$129.42 | -$10.75 to +$269.59 |
| 500 ms | 813 | 47.6% | $61.17 | +$15.49 | -$101.97 to +$132.94 |
| 1,250 ms | 722 | 42.3% | $45.68 | baseline | — |
| 2,000 ms | 662 | 38.8% | $115.57 | +$69.89 | -$26.45 to +$166.23 |

The non-monotonic PnL and wide intervals are evidence against converting the aggregate difference into a daily profit projection. Even the nominally positive zero-millisecond interval is not a portfolio confidence interval: the aggregation counts multiple strategies on the same underlying markets and does not model their cross-strategy correlation.

### Strategy-level result at 100 ms versus 1,250 ms

| Strategy | PnL at 100 ms | PnL at 1,250 ms | Paired delta | Unadjusted 95% CI | Finding |
|---|---:|---:|---:|---:|---|
| G_late_arb | -$40.92 | -$23.42 | **-$17.50** | -$102.53 to +$67.53 | Faster adds losing fills; no latency case. |
| ETH_late_taker | -$15.37 | -$12.95 | -$2.42 | includes zero | No latency case. |
| H2_cex_impulse_lag | $79.17 | $27.73 | +$51.44 | +$2.45 to +$100.43 | Nominally positive, but exploratory and not multiple-test adjusted. |
| H3_flow_confirmed | $101.26 | $45.84 | +$55.42 | +$6.84 to +$104.00 | Mechanistically speed-sensitive, but exploratory and not multiple-test adjusted. |
| H6_phi_overreaction | $41.36 | -$7.43 | +$48.79 | +$7.75 to +$89.84 | Suggestive, exploratory, and not multiple-test adjusted. |
| H1_pair_arb_2x | $36.07 | $31.27 | +$4.80 | includes zero | Little evidence at 100 ms; 2,000 ms was materially worse in this sample. |
| H9_dual_book_microprice | $8.54 | $17.91 | -$9.37 | includes zero | Better synchronization may matter; raw speed is unproven. |
| H12_cross_venue_consensus | $42.71 | $36.31 | +$6.40 | includes zero | Too few observations for a conclusion. |
| H10/H11/H13/H4/H5 | — | — | — | — | Small and/or negative samples; no latency investment case. |

At least 14 delays and many strategies were inspected. The intervals above are unadjusted for that search. H3 and H6's nominally positive intervals are hypotheses to forward-test, not proof.

### Why G does not improve with speed

G's thesis is not simply “buy before a stale quote moves.” Faster execution captures additional signals that the slower path misses, but those incremental fills were adverse in this tape. That agrees with the observed live latency buckets, which were non-monotonic rather than showing faster orders earning more. Lower latency cannot repair a negative or mis-specified entry rule; it can make it lose sooner and more often.

## Which changes could create structural edge?

### High-value, free prerequisites

1. **Repair and normalize the Polymarket market socket.** Parse `book`, `price_changes[]`, `best_bid_ask`, `last_trade_price`, and `tick_size_change`; use documented dynamic subscribe/unsubscribe messages and ten-second heartbeats. Maintain an executable local L2 book and validate snapshots by hash/age.
2. **Use event-driven Binance inputs.** Reuse BORG's `aggTrade`, `bookTicker`, and `depth@100ms` streams for main/DF2 instead of `@ticker`. Update rolling features incrementally.
3. **Separate the hot path from persistence.** Market events should update memory, trigger only affected strategies, pass the existing risk gates, and submit through a single-flight order service. Database/event archive writes can remain asynchronous, but the atomic idempotency guarantee must be preserved with a durable local outbox or a same-region direct database claim.
4. **Replace fixed hot-path polling with bounded event triggers.** For H2/H3/H6, coalesce bursts with a small engineering debounce and enforce one evaluation/order seat per market. Slow statistical indicators may remain on one-second bars. This is an architecture mechanism, not a fitted trading threshold.
5. **Consume the authenticated Polymarket user socket.** Order/fill/cancel lifecycle events should replace ten-second status observation and improve non-fill/adverse-selection measurement.
6. **Record a complete latency trace.** Every decision needs source-event time, local receive time, feature-ready time, decision time, intent-claim time, send start, acknowledgement, and fill time. Without this, VPS ROI remains speculation.
7. **Record raw sub-second CEX and Chainlink events.** The current CLOB tape can replay quote survival, but it cannot regenerate an event-driven strategy. Compact raw trades, depth deltas, RTDS Chainlink ticks, and sequence/gap markers are required for an honest millisecond strategy backtest.

### Paid services: current verdict

| Service | Likely value now | Verdict |
|---|---|---|
| Paid Binance market data / institutional SBE or FIX | Public aggregate trades and top-of-book are already real-time; internal 1s/10s loops dominate. | **Do not buy now.** Reconsider only after the Node hot path is measured in low milliseconds and capital/edge justify operational complexity. |
| Chainlink sponsored/direct Data Streams | Could improve resolver alignment and boundary abstention versus the roughly 1 Hz free RTDS stream. | **Benchmark, then decide.** Buy only if a blinded ablation proves incremental post-fee PnL or materially fewer resolver-basis losses. |
| Paid Polygon RPC | Helps on-chain balance, approval, redemption, and transaction reliability; CLOB matching and order placement are off-chain APIs. | **No CLOB latency edge.** Operational benefit only. |
| More Polymarket REST requests | WebSocket already carries the real-time book and REST is recommended for recovery/snapshots. | **Do not do this.** |
| Same-region/low-latency PostgreSQL | Removes roughly 100+ ms from each critical database round trip. | **Useful after architecture cleanup.** Keep the atomic claim, but colocate DB and executor or use a durable local outbox. |
| Trading VPS | Can reduce network variance and keep the collector continuously online. It cannot remove ten-second logic or a transatlantic DB dependency. | **Potential operational improvement, not proven alpha.** Benchmark actual CLOB POST, WebSocket receipt age, Binance receipt age, and DB RTT in at least Dublin and us-east before choosing. |

## Target architecture

```text
Free event streams
  Binance aggTrade/bookTicker/depth
  Coinbase reference
  Polymarket market WS
  Polymarket RTDS Chainlink
                 |
                 v
Normalized sequenced in-memory state
  local L2 books, CEX trades, resolver price, source timestamps
                 |
          affected-market triggers
  fast lane H2/H3/H6       slow lane Phi/indicators
  coalesced + single-flight  completed bars / scheduled state
                 \             /
                  existing gates and risk
                         |
           durable idempotent intent claim
                         |
                 CLOB order submission
                         |
                Polymarket user WS
                         |
          asynchronous DB/archive/analytics
```

The fast lane should be limited to hypotheses with a mechanism that decays with latency. Running every strategy on every book event would create correlated duplicate decisions, event-loop pressure, and more adverse fills without evidence of edge.

## Forward validation before any live use

The next experiment should be pre-registered before implementation results are inspected:

1. Select only H2, H3, and H6. Keep G and ETH late-taker in the existing lane as negative controls.
2. Assign each new market deterministically by market ID to a current-cadence arm or event-driven arm. Never choose the arm after seeing the quote or result.
3. Require at least **300 independent resolved markets per strategy per arm**. Multiple signals in one market count as one experimental unit.
4. Use the exact same signal logic, risk constraints, fee model, stake policy, and one-seat-per-market rule. The only treatment is event-to-decision/submission latency.
5. Simulate real non-fills and top-of-book depth. Record one-second and five-second post-fill markouts to distinguish faster capture from faster adverse selection.
6. Primary endpoint: paired post-fee PnL per market. Secondary endpoints: executable fill rate, price improvement/slippage, non-fill rate, acknowledgement latency, and adverse-selection markout.
7. A speed upgrade passes only if the event-driven arm has a positive paired confidence interval **and** the underlying strategy itself is positive after fees. A faster version of a losing strategy is still rejected.
8. Evaluate Chainlink RTDS as a blinded ablation: record it for all markets, then compare a pre-declared divergence abstention rule without selecting the threshold on the same sample.
9. Evaluate VPS regions with identical 24-hour probes. Select on measured p90 end-to-end order acknowledgement and feed freshness, not advertised ping.

The honest null outcome is important: after 300+ fresh markets, the apparent H2/H3/H6 uplift may disappear and measured structural edge may be approximately zero.

## Decision

- **Do not increase REST polling to milliseconds.**
- **Do not buy a paid market-data API yet.**
- **Do not make G faster in expectation of profit.** The retained replay points the other way.
- **Do build a correct event-driven paper lane for H2/H3/H6**, after fixing socket parsing and latency instrumentation.
- **Do collect raw sub-second CEX, CLOB, order-lifecycle, and resolver events** so the next backtest can reproduce signals rather than merely test quote survival.
- **Do not interpret the retrospective dollar deltas as daily profit projections.** There is not yet statistically defensible out-of-sample evidence for that conversion.
