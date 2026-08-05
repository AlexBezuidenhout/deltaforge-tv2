# Public-information strategy testability — 5 August 2026

## Decision

Live public-information research is feasible, but “Truth Social sentiment” is not one strategy and direct Truth Social scraping is not an acceptable data source. Truth Social's current terms prohibit automated/non-human access, systematic retrieval, bots and scraping. The usable route is Polymarket's public XTracker API for contracts that explicitly name XTracker as the primary resolver, plus official APIs for X, SEC EDGAR, government releases and weather data.

The strongest immediately testable social mechanism is not generic positive/negative sentiment. It is a **resolver-state barrier**: once XTracker's monotone post count passes a range's upper bound, that range's NO token is terminally correct; once it reaches an open-ended top bucket, that bucket's YES token is terminally correct. The only remaining questions are whether an executable ask survives the source delay and whether the displayed depth is real enough to fill.

## What TV2 can test now

| Rank | Strategy | Testability now | Existing causal data | Required next evidence | Disposition |
| ---: | --- | --- | --- | --- | --- |
| 1 | XTracker irreversible count boundary | Full forward L2 paper test | Public post creation/import timestamps, exact tracking windows, linked Gamma rules and CLOB books | 300 fresh tracking windows, 30 days, positive stressed PnL at 100/250/500 ms | **RUNNING PAPER LANE** |
| 2 | XTracker expanding-window count distribution | Historical discovery plus future paper | 36 completed Trump windows and 2,807 historical posts; public one-minute prices | Freeze one negative-binomial/seasonal model trained only on prior windows; no threshold search | **TESTABLE, REGISTER NEXT ONLY IF #1 SHOWS CAPACITY** |
| 3 | XTracker content-to-contract predicate | Collection and deterministic mapping | Post text plus source/import clocks; immutable Polymarket rule archive | Pre-register allowed predicate types; AI may propose but a rule verifier must approve; capture linked books before the post | **COLLECT NOW, NO TRADES YET** |
| 4 | Official X account event mapper | Technically ready after credentials | No TV2 causal X tape yet | X API bearer token, account allow-list, monthly spend cap, exact rule mapping | **BLOCKED CREDENTIALS/COST** |
| 5 | SEC filing event residual | Technically ready from a free official API | Rule archive exists; no causal EDGAR tape | Append-before-parse EDGAR collector, CIK/entity map, filing acceptance clock, direct-contract predicates | **BEST NEXT NEW SOURCE** |
| 6 | Official weather observation versus exact threshold | Technically ready for supported resolver/station rules | 9,272 weather contracts in the local universe, but almost no live-book coverage | Parse exact station/source/time/rounding rule; collect the named resolver and selected L2 books | **HIGH-COVERAGE NEXT PROGRAM** |
| 7 | Official economic release direct threshold | Technically ready from BLS/BEA/Fed sources | Contract rules exist; no causal official-release tape | Scheduled release collector and exact series/vintage mapping | **TESTABLE, EXPECT HEAVY COMPETITION** |
| 8 | Federal Register/Congress action mapper | Technically ready from public official APIs | Rule archive exists; no causal action tape | Official publication/action clocks and deterministic bill/order predicates | **TESTABLE IN OBSCURE CONTRACTS** |
| 9 | Generic social sentiment to BTC/ETH | Technically measurable but weakly identified | XTracker is delayed and TV2 lacks a historical causal social/CEX joint tape | Official low-latency feed, frozen model/prompt and an event-study control for market/news regime | **LOW PRIORITY** |
| 10 | Direct Truth Social scraper | Not terms-compliant | None | Written permission or a licensed data feed | **DO NOT BUILD** |

## Implemented in this change

- `borg/publicinfo/collector.js` polls Polymarket XTracker, appends every HTTP payload before parsing, persists source creation time, XTracker import time, local wall/monotonic receipt, content hash and post text.
- The collector discovers active XTracker-linked Polymarket events, certifies the exact rule text, subscribes to their public CLOB books and records normalized L2 touches.
- An irreversible range transition schedules paper evaluations at 100, 250 and 500 ms. Each evaluation fetches a fresh public execution-confirmation book, walks actual ask depth and requires positive value after doubled fees, one tick and a provisional one-cent source/fallback reserve.
- `borg-public-info.service` runs only `TRUTH_SOCIAL` XTracker contracts initially. The process has no wallet, signer, authenticated client or live-order call.
- The frozen experiment is `xtracker-resolver-count-barrier-v1`; its independent unit is a tracking window, not each correlated range bin.

## Historical falsification result

The discovery replay used 36 completed Trump tracking windows, 2,807 XTracker posts and 221 irreversible range candidates. Of 210 candidates with a usable public one-minute price point, only **one** remained positive after doubled fees, one tick and a one-cent source reserve. At $10 sizing its stressed midpoint-based opportunity was approximately **$0.13**. The other 209 were non-positive; the sum of stressed residuals across all observations was approximately **−$20.96**.

This is evidence that the obvious boundary is usually priced before the public XTracker import reaches us. It is not evidence of a profitable strategy. The one positive row has no historical ask depth, so it may not have been executable. The forward L2 collector exists to determine whether rare small-capacity exceptions are real.

XTracker import latency also matters: the historical median across evaluated boundaries was about 161 seconds, and the 95th percentile was distorted by large delayed/backfilled imports. That latency makes generic headline or crypto sentiment trading through XTracker unattractive; the official X stream is the appropriate source if that separate mechanism is later pre-registered.

## Required testing protocol

### Resolver-state barrier

- Keep the rule, $10 target, 100/250/500 ms arms, doubled fees, one tick and source reserve unchanged.
- Cluster every result by tracking window and UTC day. Overlapping range bins are not independent.
- Report opportunities, displayed capacity, non-fills, tracker lag, book request latency and settlement correctness.
- Do not promote on a rare positive episode. Require the manifest's 300 fresh windows/30-day read and a positive lower confidence bound after costs.

### Count-distribution model

- Use expanding-window training only: a window may use earlier completed windows, never its own final count or later windows.
- Pre-register one model before inspecting paper PnL. A negative-binomial count process with time-of-week exposure is the defensible baseline; Poisson is the calibration control.
- Start from the executable market quote as the prior and predict only a residual. Do not manufacture edge by replacing price with an unconstrained count forecast.
- Score calibration, log loss and post-cost PnL, with one observation cluster per tracking window.

### Content/event mapping

- Prefer direct predicates (“announced”, “named”, “signed”, “met”, “posted N times”) over sentiment.
- Preserve original and edited/deleted content states. Model/prompt hash, start/end inference clocks and decision arrival are mandatory.
- AI may propose a market relationship; it may not certify rules or authorize a paper fill.

## Source and cost facts

- Polymarket XTracker documents public endpoints for X and Truth Social users, posts and tracking periods: https://xtracker.polymarket.com/docs
- Truth Social's terms prohibit automated access and systematic retrieval: https://help.truthsocial.com/legal/terms-of-service/
- X's official filtered stream is pay-per-use, delivers near-real-time posts and reports roughly 6–7 second P99 latency; post reads are currently listed at $0.005 each: https://docs.x.com/x-api/posts/filtered-stream/introduction and https://docs.x.com/x-api/getting-started/pricing
- SEC submissions require no API key, update in real time and typically appear in under one second; fair-access limits must be respected: https://www.sec.gov/search-filings/edgar-application-programming-interfaces
- NWS's API is free official open data with reasonable rate limits: https://www.weather.gov/documentation/services-web-api

## Honest conclusion

Public-information strategies are testable, and the exact-resolver data path is now materially better than TV2's previous “blocked data” status. The first backtest does **not** reveal meaningful bankable alpha: one discovery-grade 13-cent opportunity across 210 priced boundaries is closer to an efficient market plus missing-depth noise than a business. The sensible path is to let the new forward L2 lane falsify rare executable tails while building the SEC and exact-weather collectors. Paying for X is justified only after a pre-registered direct-predicate or event-study design, not to spray generic sentiment at crypto prices.
