# DeltaForge data and backtest catalog — 17 July 2026

Snapshot: 17 July 2026, 17:28 UTC. This catalog describes what is physically
stored, what can be replayed honestly, and what the current history cannot
support. Counts from PostgreSQL statistics are approximate; strategy evidence
counts come from the frozen report scripts.

## Executive read

DeltaForge now has a useful short-horizon research tape, not a mature historical
dataset. Local PostgreSQL contains 42.79 GB, the immutable write-ahead log is
about 15 GB, and the collection stack is receiving event-driven Polymarket,
Binance, Coinbase, Hyperliquid and Polymarket RTDS data. Five-minute market
labels cover roughly five to six days; the high-fidelity Dublin event tape is
mostly two days old; hourly, all-market, structural and cross-venue histories
are shorter still. That is enough to debug execution models, reject grossly
negative ideas and replay measured latency. It is not enough to estimate a
stable annual return, news-regime behavior, seasonal capacity, or a production
Sharpe ratio.

The raw WAL is the replay authority. PostgreSQL is a rolling hot query tier;
its sampled or compacted tables must not be mistaken for the complete source
tape. CSV or text would generally increase storage, not reduce it. Compressed
Parquet is the right cold format, with immutable off-host copies and manifests.

## Physical inventory

### Local PostgreSQL

Database size at the snapshot was **42,789,000,895 bytes**. The largest tables
were:

| Table | Approximate live rows | Total relation size | Research role |
|---|---:|---:|---|
| `borg_clob_touch` | 33.540m | 17.36 GB | Event-driven Polymarket best bid/ask, source/receive clocks and sequence provenance |
| `am_book_touches` | 8.107m | 11.55 GB | Broad all-market L2 touch and maker/taker research state |
| `pm_flow_trades` | 2.651m | 4.76 GB | Public Polymarket trades and wallet-flow observations |
| `borg_external_book_touch` | 8.670m | 2.51 GB | Executable external-venue touch, principally Binance/Coinbase/Hyperliquid |
| `borg_external_trades` | 3.676m | 1.46 GB | External prints with source and receive timestamps |
| `borg_book_snaps` | 0.651m | 1.25 GB | Strategy-ready crypto book/fair snapshots |
| `borg_clob_events` | 0.980m | 0.94 GB | Incremental Polymarket CLOB events |
| `borg_structural_evaluations` | 0.337m | 0.91 GB | Structural candidate evaluations; legacy parser rows are not evidence |
| `borg_taker_trades` | 0.317m | 0.49 GB | Deduplicated Polymarket taker/public-flow tape |
| `borg_rtds_ticks` | 0.652m | 0.36 GB | Binance and Chainlink RTDS resolver/reference ticks |
| `pm_flow_touches` | 0.439m | 0.36 GB | Flow-lab book state around observed trades |
| `am_order_intents` | 67,898 | 96.20 MB | Cost-confirmed all-market paper intents |
| `borg_shadow_orders` | 48,700 | 93.20 MB | Frozen BORG paper/shadow decisions |
| `pm_flow_scores` | 51,774 | 85.06 MB | Fixed-horizon flow markouts |
| `pm_flow_signals` | 52,458 | 84.19 MB | Flow hypotheses and controls |
| `cv_opportunities` | 37,626 | 74.29 MB | Cross-venue derived observations, not independent trades |
| `borg_binance_1s` | 0.386m | 64.81 MB | Causal one-second Binance features |
| `cv_basis_samples` | 37,604 | 50.68 MB | Relative-value convergence samples |
| `borg_markets` | 10,789 | 42.08 MB | Rules, labels, tokens, windows and resolved outcomes |
| `cv_book_snapshots` | 20,623 | 17.88 MB | Synchronized Polymarket/Kalshi research snapshots |

Sizes include indexes and TOAST storage. Row counts are PostgreSQL's live-row
estimates, so they can lag inserts or pruning.

### Filesystem tiers

| Tier | Snapshot size | Purpose and limitation |
|---|---:|---|
| Immutable local WAL | about 15 GB | Highest-fidelity replay source; retain until a verified off-host cutoff receipt exists |
| Local archive | 181 MB | Compacted source archive; not yet a complete substitute for the WAL |
| Local Parquet | 1.5 MB | Small current rolling derivative; cold compaction is not yet complete |
| Local DB snapshots | 3.1 GB | Operational recovery copies, including a 2.8 GB 17 July snapshot |
| Final Neon migration dump | 329 MB | Cutover recovery artifact; not a current research tape |
| iCloud Dublin-VPS archive | 1.5 GB / 19,293 files | Useful second copy, but presently much smaller than the live corpus and not sufficient by itself |
| VPS filesystem | 133.16 GB total / 72.04 GB used / 54.33 GB free | Adequate rolling hot tier; not adequate as the sole permanent archive |

An iCloud-synced folder is convenient, but sync is not the same as immutable
object storage: deletions and corruption may propagate. Each archive batch
should have a content hash, source cutoff, row/event count, schema version and
independently verified remote receipt.

## Market and label coverage

Resolved labels in `borg_markets` at the snapshot were:

| Contract family | Asset | Markets | Resolved | Stored window coverage |
|---|---|---:|---:|---|
| 5-minute direction | BTC | 1,779 | 1,777 | 11–17 July |
| 5-minute direction | BNB | 1,430 | 1,428 | 12–17 July |
| 5-minute direction | DOGE | 1,428 | 1,426 | 12–17 July |
| 5-minute direction | ETH | 1,428 | 1,426 | 12–17 July |
| 5-minute direction | HYPE | 1,427 | 1,425 | 12–17 July |
| 5-minute direction | SOL | 1,427 | 1,424 | 12–17 July |
| 5-minute direction | XRP | 1,427 | 1,425 | 12–17 July |
| 1-hour direction | BTC | 106 | 105 | 15–17 July |
| 1-hour direction | ETH | 105 | 104 | 15–17 July |
| 1-hour direction | SOL | 106 | 105 | 15–17 July |
| 1-hour direction | XRP | 106 | 105 | 15–17 July |
| Daily threshold | ETH/SOL/XRP | 12 total | 12 | Sparse, 9–17 July |
| Daily range | ETH/SOL/XRP | 8 total | 8 | Sparse, 9–17 July |

Market labels are broader than high-fidelity replay coverage. A resolved market
does not imply that complete pre-trade L2, external feeds and connection health
exist for its whole life.

## Feed provenance and clocks

The modern Dublin cohort preserves, where supplied by the source:

- source timestamp;
- local wall-clock receive timestamp;
- local monotonic receive time;
- connection epoch and shard;
- source/event sequence identifier;
- raw-WAL event ID and book hash;
- collection run and epoch identifiers;
- data-quality and execution-fidelity grades.

This is the minimum useful structure for latency replay. The explicit Dublin
cohort must not be pooled blindly with Mac/Neon observations because the
transport, database path and collection cadence differ.

The current external network panel includes direct Binance trades/book ticker
and depth, Coinbase, Hyperliquid, Polymarket RTDS Binance, and Polymarket RTDS
Chainlink for BTC, ETH, SOL and XRP where supported. BNB, DOGE and HYPE have
partial independent-venue coverage. The collector's raw event stream is more
granular than its one-second feature bars.

## What can be backtested now

| Research question | Current capability | Honest interpretation |
|---|---|---|
| Five-minute crypto terminal-direction signals | Resolved labels across seven assets plus event books and external feeds | Useful for causal replay and rapid falsification; only a few days and highly overlapping market regimes |
| Measured execution latency | Replay information and order latency separately on the Dublin raw tape | Can compare 20/50/100/250/500 ms and 1/2 s counterfactuals when the quote path exists; cannot create information that arrived before collection began |
| Quote survival and depth | Walk recorded asks/bids, cap by displayed depth, model partial/non-fill and adverse ticks | Better than midpoint backtests; still cannot know hidden liquidity or exact queue position |
| Passive making | Back-of-queue public-tape approximation, cancel latency and 1/5/30-second markouts | A research lower-fidelity estimate until authenticated user-channel fills and queue-ahead reconciliation exist |
| Resolver divergence | Binance/Chainlink RTDS basis at signal time | Suitable as a filter/feature study for supported assets; two-day regime coverage is too short for a hard production threshold |
| Cross-asset and cross-network hypotheses | Synchronized direct and RTDS feeds with executable Polymarket asks | Suitable for forward pilot rejection; all current H47–H51 pilots are negative after 2× costs |
| MAIN/George/G/ETH/BORG strategy accounting | Frozen manifests, independent-market clustering, chronological halves, 2× costs and shared-$500 portfolio simulation | Suitable for deciding that current variants are not ready; not sufficient to estimate long-run returns |
| All-market public flow | Millions of public trades and book touches, wallet IDs where public | Suitable for markout/toxicity and mechanism studies; public trade-side inference and survivorship require care |
| Structural same-venue payoffs | Typed price predicates plus deterministic terminal-state proofs | Correctly tests displayed identities; cross-token execution remains non-atomic and no current bundle is qualified |
| Polymarket/Kalshi relations | 20,623 synchronized snapshots, 41 discovered pairs and approved relation metadata | Two days and one retrospectively selected implication event; no forward expectancy evidence |
| Daily ordered strikes/ranges | Rule metadata and a very small panel | Machinery validation only; 20 contracts cannot support inference |
| Public wallet mechanism analysis | Public positions, trades and market state | Can classify maker/inventory/complete-set behavior; cannot copy private queue placement, hedges or capital constraints |

## What cannot be claimed from the stored data

The current corpus cannot honestly establish:

- a daily, weekly or annual profit projection;
- an 85% durable win rate or $100–$200 daily income from a $1,000 bankroll;
- robustness across weekends, major news, volatility regimes or market-rule
  changes;
- exact fill probability for passive orders without authenticated queue and user
  events;
- atomic execution of two Polymarket legs or two venues;
- historical sub-millisecond performance before source/receive clocks were
  collected;
- scalability beyond displayed depth, or access to another wallet's private
  maker economics;
- Kalshi executability from a restricted location or account eligibility;
- selection-adjusted profitability from one event found after reviewing many
  bots, pairs and horizons.

Snapshot observations are not independent trades. Five quote updates in one
market remain one terminal event cluster; 48 positive quotes around one speech
relation remain one opportunity.

## Backtest acceptance standard

Every decision report should include:

1. a frozen experiment manifest and code commit;
2. discovery, pilot and fresh evaluation cohorts kept separate;
3. one row of inference per independent market/event, not per quote;
4. executable ask/bid depth, partial and non-fills, venue fees, one-tick stress
   and 2× cost stress;
5. information latency and order latency modeled separately;
6. measured Mac, measured Dublin and fixed 100/250/500 ms and 1/2 s profiles;
7. first/second chronological halves and asset/day concentration;
8. market-clustered confidence intervals and family-wise correction across all
   attempted strategies and variants;
9. orphan-leg and immediate-unwind loss for every multi-leg strategy;
10. data-quality and execution-fidelity grades, with gaps failed closed.

The default promotion minimum remains at least 300 fresh independent markets
and 14 calendar days, positive 2×-cost P&L in both halves, a clustered lower
confidence bound above zero, and multiple-testing survival. More observations
are required for rare event-state or cross-venue relations.

## Storage actions

The correct next storage work is:

- keep the 100 GB-class VPS disk as a bounded hot tier;
- compact closed WAL segments to partitioned Zstandard Parquet by source/date;
- verify row/event counts and hashes before deleting any source segment;
- archive to an immutable off-host store and retain iCloud as an additional
  human-convenient copy, not the only backup;
- snapshot schema, experiment manifests and code commit beside every partition;
- retain raw source/receive/sequence fields even when derived SQL touches are
  downsampled;
- monitor free space and fail collection loudly before the disk fills.

Plain text and CSV repeat field names/delimiters and discard efficient typed
encoding. They are valuable interchange formats for small extracts, but are
usually substantially larger and slower than compressed Parquet for this tape.

## Bottom line

The platform now measures short-lived crypto and prediction-market mechanics
far better than the original one-second/remote-database setup. Its strongest
current use is falsification and forward experiment design. The database is
large because event tapes are large; the statistically independent history is
still small. Any report that treats gigabytes, quote rows or paper balances as
years of independent edge evidence is wrong.
