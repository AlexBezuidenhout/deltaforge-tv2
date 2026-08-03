# DeltaForge edge data catalog

Generated: 2026-08-03T13:54:20.687Z on `P8TFSF999N46RDW2MP1O.tradingvps.io`. Catalog SHA-256: `6c827f0817052143a11ea89eaa7e525a5a999dfe7f63b27406ebf5265f91e094`.

This is an evidence map, not a profitability report. PostgreSQL row counts are explicitly estimated. A durable raw archive is not labelled replay-ready until it has causal clocks, executable state and a queryable reconstruction path.

## Ground-truth snapshot

- Evidence boundary: `priority-forward-2026-08-03-v19` from 2026-08-03T13:20:03.780Z.
- Hot PostgreSQL: 63.51 GiB across 192 public tables.
- Local WAL: 28,315 files, 1.75 GiB.
- Verified off-host index: 93,775 / 93,775 objects, 163.65 GiB.
- VPS Parquet projection: 0 files.

## Binding warnings

- No Parquet research projection exists on the VPS; Google Drive raw objects are durable but not yet query-efficient.
- Hot PostgreSQL is 63.51 GiB; analytics must remain bounded/read-only until Parquet or a replica is active.

## Strategy/data eligibility

| Programme | Current readiness | What the stored data supports | What it cannot establish |
|---|---|---|---|
| Resolver-boundary transfer | **FORWARD_TESTABLE** | Exact captured resolver symbols with contemporaneous CLOB depth. | No substitution for a different contractual resolver; sparse/empty source symbols fail closed. |
| Certified payoff graph / ordered strikes | **SCANNER_READY** | Rule-hashed deterministic payoff proof and current executable economics. | Authenticated passive queue behavior and bundles without complete rule identity. |
| Polymarket/Kalshi exact-rule terminal lock | **COLLECTOR_READY_IDENTITY_BLOCKED** | Typed rule review, synchronized observations and stored depth replays. | No certified-equal pair means no terminal-arbitrage P&L experiment yet. |
| Polymarket/Kalshi risky convergence | **REPLAYABLE_WITH_RULE_RISK** | Basis dwell/half-life and liquidation-path simulation by rule-risk class. | Cannot be labelled risk-free; capital and resolver mismatch must remain charged. |
| Deribit options-implied binary residual | **COLLECTING_EXACT_EXPIRY_SPARSE** | Surface reconstruction from raw Deribit frames and mapped CLOB books. | Current term interpolation is diagnostic; exact-expiry overlap and hedge-cost data are sparse. |
| CEX lead-lag / state-space relative value | **CAUSAL_REPLAY_READY** | BTC/ETH/SOL/XRP event-time cross-venue and cross-asset signals. | No venue funding/fee/inventory series for a complete executable carry strategy. |
| Selective passive making | **CAPTURE_ONLY** | Public queue and adverse-selection diagnostics on the frozen panel. | Needs an independently certified fair bound and authenticated tiny-fill evidence. |
| News/social/event trading | **NO_CAUSAL_SOURCE_DATA** | None from the present catalog. | Requires publication/edit/receive/model/arrival timestamps and licensed source access. |
| DEX/CEX or cross-chain arbitrage | **NO_EXECUTABLE_ONCHAIN_DATA** | None from the present catalog beyond external CEX references. | Requires pool states, blocks, gas/priority fees, inclusion outcomes and inventory paths. |
| Sportsbook/prediction-market relative value | **NO_BOOKMAKER_TAPE** | Structural rule compiler can be reused after capture exists. | Requires bookmaker odds histories, limits, vig, rules and causal timestamps. |

## Local append-before-process WAL

| Source | Files | Compressed/on-disk size | First local object | Latest local object | Sampled data/execution grade | Replay profiles | Causal uses |
|---|---:|---:|---|---|---|---|---|
| `polymarket-clob` | 4,098 | 807.02 MiB | 2026-07-31T23:22:33.558Z | 2026-08-03T13:53:32.865Z | B/B_PUBLIC_BOOK | 100ms, 250ms, 500ms, 1s, 2s | full CLOB replay; depth/capacity; latency stress |
| `options-polymarket-clob` | 12 | 233.47 MiB | 2026-07-31T23:22:32.574Z | 2026-08-03T13:53:34.353Z | B/B_PUBLIC_BOOK | 100ms, 250ms, 500ms, 1s, 2s | options-to-binary executable mapping |
| `coinbase` | 4,010 | 129.73 MiB | 2026-07-31T23:22:33.534Z | 2026-08-03T13:53:33.813Z | B/NOT_EXECUTION_ALONE | 100ms, 250ms, 500ms, 1s, 2s | CEX lead-lag; cross-venue consensus |
| `options-decisions` | 15 | 117.51 MiB | 2026-07-31T23:22:32.282Z | 2026-08-03T13:53:32.105Z | B/NOT_EXECUTION_ALONE | 100ms, 250ms, 500ms, 1s, 2s | unclassified—review required |
| `polymarket-flow-clob` | 10 | 113.06 MiB | 2026-08-03T11:39:34.671Z | 2026-08-03T13:53:33.101Z | B/B_PUBLIC_BOOK | 100ms, 250ms, 500ms, 1s, 2s | public-flow and queue diagnostics |
| `binance` | 4,017 | 110.06 MiB | 2026-07-31T23:22:33.542Z | 2026-08-03T13:53:32.417Z | B/NOT_EXECUTION_ALONE | 100ms, 250ms, 500ms, 1s, 2s | CEX lead-lag; cross-asset state; external price discovery |
| `deribit-options` | 11 | 94.86 MiB | 2026-07-31T23:16:47.400Z | 2026-08-03T13:53:32.813Z | B/NOT_EXECUTION_ALONE | 100ms, 250ms, 500ms, 1s, 2s | options surface reconstruction |
| `structural-scanner` | 7 | 73.96 MiB | 2026-08-03T11:35:38.814Z | 2026-08-03T13:53:32.117Z | C/NOT_EXECUTION_ALONE | 1s, 2s | payoff graph reconstruction |
| `pyth-polymarket-clob` | 7 | 47.22 MiB | 2026-08-03T12:54:32.079Z | 2026-08-03T13:53:32.381Z | B/B_PUBLIC_BOOK | 100ms, 250ms, 500ms, 1s, 2s | unclassified—review required |
| `hyperliquid` | 4,008 | 25.24 MiB | 2026-07-31T23:22:33.390Z | 2026-08-03T13:53:33.285Z | B/NOT_EXECUTION_ALONE | 100ms, 250ms, 500ms, 1s, 2s | perpetual price discovery; cross-venue OFI diagnostics |
| `polymarket-global-trades` | 7 | 20.43 MiB | 2026-08-03T12:58:02.676Z | 2026-08-03T13:53:09.705Z | B/NOT_EXECUTION_ALONE | 100ms, 250ms, 500ms, 1s, 2s | all-market public trade flow |
| `polymarket-rtds-chainlink` | 4,016 | 9.48 MiB | 2026-07-31T23:22:33.486Z | 2026-08-03T13:53:34.017Z | B/NOT_EXECUTION_ALONE | 100ms, 250ms, 500ms, 1s, 2s | resolver-boundary transfer |
| `allmarket-clob` | 7 | 5.15 MiB | 2026-08-03T12:54:16.811Z | 2026-08-03T13:53:32.505Z | B/B_PUBLIC_BOOK | 100ms, 250ms, 500ms, 1s, 2s | neglected-market passive-making prerequisites |
| `options-rtds-chainlink` | 7 | 3.45 MiB | 2026-08-03T12:54:12.895Z | 2026-08-03T13:53:34.289Z | B/NOT_EXECUTION_ALONE | 100ms, 250ms, 500ms, 1s, 2s | options target resolver alignment |
| `strategy-decisions` | 4,022 | 1.39 MiB | 2026-07-31T23:22:25.413Z | 2026-08-03T13:53:16.785Z | A/NOT_EXECUTION_ALONE | 20ms, 50ms, 100ms, 250ms, 500ms, 1s, 2s | prequential strategy intent reconstruction |
| `research-control` | 4,020 | 1.29 MiB | 2026-07-31T23:17:18.108Z | 2026-08-03T13:20:24.479Z | B/NOT_EXECUTION_ALONE | 100ms, 250ms, 500ms, 1s, 2s | unclassified—review required |
| `crossvenue-poly` | 7 | 1.26 MiB | 2026-08-03T12:54:17.071Z | 2026-08-03T13:53:32.005Z | B/B_PUBLIC_BOOK | 100ms, 250ms, 500ms, 1s, 2s | Polymarket side of cross-venue replay |
| `crossvenue-decisions` | 7 | 1.00 MiB | 2026-08-03T12:54:17.611Z | 2026-08-03T13:53:31.645Z | A/NOT_EXECUTION_ALONE | 20ms, 50ms, 100ms, 250ms, 500ms, 1s, 2s | pairing and execution-state audit |
| `crossvenue-kalshi` | 7 | 639.45 KiB | 2026-08-03T12:54:08.871Z | 2026-08-03T13:53:31.393Z | A/B_PUBLIC_BOOK | 20ms, 50ms, 100ms, 250ms, 500ms, 1s, 2s | Kalshi side of cross-venue replay |
| `polymarket-flow-market-metadata` | 7 | 47.93 KiB | 2026-08-03T12:58:26.412Z | 2026-08-03T13:53:32.389Z | B/NOT_EXECUTION_ALONE | 100ms, 250ms, 500ms, 1s, 2s | unclassified—review required |
| `pyth-equity-rtds` | 4 | 2.31 KiB | 2026-08-03T13:08:04.235Z | 2026-08-03T13:30:28.902Z | B/NOT_EXECUTION_ALONE | 100ms, 250ms, 500ms, 1s, 2s | unclassified—review required |
| `polymarket-flow-boundary-intents` | 3 | 881 B | 2026-08-03T13:16:07.225Z | 2026-08-03T13:20:22.519Z | C/NOT_EXECUTION_ALONE | 1s, 2s | unclassified—review required |
| `allmarket-decisions` | 3 | 852 B | 2026-08-03T13:16:07.205Z | 2026-08-03T13:20:22.559Z | C/NOT_EXECUTION_ALONE | 1s, 2s | unclassified—review required |
| `pyth-boundary-decisions` | 3 | 801 B | 2026-08-03T13:16:07.345Z | 2026-08-03T13:20:22.495Z | C/NOT_EXECUTION_ALONE | 1s, 2s | unclassified—review required |

WAL sizes are physical bytes. Uncompressed size is deliberately left unknown unless a verified segment manifest supplies it; no compression ratio is invented.

## Google Drive raw/archive index

| Namespace | Source/table | Objects | Stored size | Checksum-attested | First object time | Latest object time |
|---|---|---:|---:|---:|---|---|
| wal | `polymarket-clob` | 14,986 | 79.75 GiB | 14,986 | 2026-07-26T19:41:00.508Z | 2026-08-03T13:39:55.804Z |
| wal | `options-decisions` | 7,052 | 14.98 GiB | 7,052 | 2026-07-27T13:39:36.631Z | 2026-08-03T13:35:27.947Z |
| wal | `polymarket-flow-clob` | 6,530 | 12.16 GiB | 6,530 | 2026-07-26T19:48:19.614Z | 2026-08-03T13:37:31.923Z |
| wal | `structural-scanner` | 1,514 | 5.46 GiB | 1,514 | 2026-07-26T19:44:54.377Z | 2026-08-03T13:35:25.823Z |
| wal | `binance` | 1,872 | 4.84 GiB | 1,872 | 2026-07-26T19:42:30.844Z | 2026-08-03T13:38:42.412Z |
| wal | `deribit-options` | 3,705 | 4.80 GiB | 3,705 | 2026-07-26T19:42:03.492Z | 2026-08-03T13:31:16.854Z |
| wal | `options-polymarket-clob` | 3,497 | 3.97 GiB | 3,497 | 2026-07-27T13:39:36.607Z | 2026-08-03T13:33:45.014Z |
| database-snapshots | `2026-07-30` | 2 | 3.94 GiB | 2 | 2026-07-30T02:48:48.469Z | 2026-07-30T02:49:36.146Z |
| database-snapshots | `2026-08-01` | 2 | 3.85 GiB | 2 | 2026-08-01T02:38:53.946Z | 2026-08-01T02:39:51.582Z |
| wal | `coinbase` | 876 | 3.78 GiB | 876 | 2026-07-26T19:41:23.768Z | 2026-08-03T13:33:25.638Z |
| database-snapshots | `2026-08-03` | 2 | 3.60 GiB | 2 | 2026-08-03T02:43:08.979Z | 2026-08-03T02:43:48.456Z |
| database-snapshots | `2026-08-02` | 2 | 3.46 GiB | 2 | 2026-08-02T02:43:55.835Z | 2026-08-02T02:44:36.371Z |
| database-snapshots | `2026-07-29` | 2 | 3.32 GiB | 2 | 2026-07-29T02:43:20.670Z | 2026-07-29T02:44:11.502Z |
| database-snapshots | `2026-07-31` | 2 | 3.27 GiB | 2 | 2026-07-31T02:40:51.628Z | 2026-07-31T02:41:35.061Z |
| database-snapshots | `2026-07-28` | 2 | 1.77 GiB | 2 | 2026-07-28T02:36:00.961Z | 2026-07-28T02:36:17.409Z |
| wal | `polymarket-global-trades` | 4,597 | 1.61 GiB | 4,597 | 2026-07-26T19:42:05.064Z | 2026-08-03T13:38:06.652Z |
| wal | `hyperliquid` | 841 | 1.38 GiB | 841 | 2026-07-26T19:42:24.480Z | 2026-08-03T13:35:26.867Z |
| database-snapshots | `2026-07-27` | 2 | 1.24 GiB | 2 | 2026-07-27T02:22:08.960Z | 2026-07-27T02:22:19.296Z |
| database-archive | `pm_flow_trades` | 2,605 | 1.17 GiB | 2,605 | 2026-07-26T19:45:04.785Z | 2026-08-03T13:35:29.563Z |
| wal | `crossvenue-kalshi` | 4,128 | 1.05 GiB | 4,128 | 2026-07-26T19:47:31.770Z | 2026-08-03T13:35:24.463Z |
| wal | `crossvenue-poly` | 4,063 | 1.02 GiB | 4,063 | 2026-07-26T19:49:39.315Z | 2026-08-03T13:35:24.227Z |
| wal | `pyth-polymarket-clob` | 3,081 | 937.53 MiB | 3,081 | 2026-07-26T19:43:11.465Z | 2026-08-03T13:35:25.139Z |
| wal | `crossvenue-decisions` | 4,025 | 708.80 MiB | 4,025 | 2026-07-26T19:45:58.097Z | 2026-08-03T13:35:23.359Z |
| wal | `allmarket-clob` | 1,298 | 534.01 MiB | 1,298 | 2026-07-26T19:42:01.608Z | 2026-08-03T13:35:24.147Z |
| wal | `polymarket-rtds-chainlink` | 820 | 293.59 MiB | 820 | 2026-07-26T19:42:25.688Z | 2026-08-03T13:35:25.287Z |
| wal | `options-rtds-chainlink` | 3,448 | 289.86 MiB | 3,448 | 2026-07-26T19:42:08.308Z | 2026-08-03T13:35:24.023Z |
| database-archive | `borg_taker_trades` | 2,138 | 245.53 MiB | 2,138 | 2026-07-26T19:45:03.057Z | 2026-08-03T13:40:02.976Z |
| database-archive | `borg_rtds_ticks` | 2,155 | 199.19 MiB | 2,155 | 2026-07-26T19:45:04.417Z | 2026-08-03T13:40:03.296Z |
| database-archive | `borg_binance_1s` | 2,141 | 41.75 MiB | 2,141 | 2026-07-26T19:45:03.133Z | 2026-08-03T13:40:03.044Z |
| wal | `pyth-equity-rtds` | 2,873 | 13.69 MiB | 2,873 | 2026-07-26T20:46:50.220Z | 2026-08-03T13:19:53.698Z |
| database-archive | `borg_coinbase_1s` | 2,140 | 10.91 MiB | 2,140 | 2026-07-26T19:45:03.169Z | 2026-08-03T13:40:03.092Z |
| wal | `strategy-decisions` | 743 | 6.36 MiB | 743 | 2026-07-26T19:47:34.318Z | 2026-08-03T13:37:55.836Z |
| wal | `polymarket-flow-market-metadata` | 4,564 | 5.69 MiB | 4,564 | 2026-07-26T19:43:17.853Z | 2026-08-03T13:38:32.212Z |
| wal | `polymarket-flow-boundary-intents` | 3,890 | 982.99 KiB | 3,890 | 2026-07-27T13:56:59.948Z | 2026-08-03T13:19:53.754Z |
| wal | `pyth-boundary-decisions` | 2,405 | 934.70 KiB | 2,405 | 2026-07-27T13:56:59.920Z | 2026-08-03T13:19:53.694Z |
| database-archive | `pm_flow_connection_events` | 1,102 | 360.72 KiB | 1,102 | 2026-07-26T19:50:01.663Z | 2026-08-03T13:35:50.223Z |
| wal | `allmarket-decisions` | 577 | 140.33 KiB | 577 | 2026-07-27T13:57:00.304Z | 2026-08-03T13:19:53.710Z |
| wal | `research-control` | 92 | 25.56 KiB | 92 | 2026-07-27T01:41:44.687Z | 2026-08-03T13:19:53.990Z |
| wal | `_recovery` | 1 | 2.31 KiB | 1 | 2026-07-27T18:29:45.461Z | 2026-07-27T18:29:45.461Z |

Receipt: 2026-08-03T13:47:55.635Z; remote check: google-drive-md5-via-rclone-check. The state index records uploader verification; any object selected for research must still be downloaded/staged and SHA-256 checked before use.

## PostgreSQL hot-tier tables

| Table | Family | Tier | Rows | Total size | First timestamp | Last timestamp | Data/execution grade | Defensible replay profiles |
|---|---|---|---:|---:|---|---|---|---|
| `borg_option_shadow_marks_p20260802` | options_surface | normalized_or_derived | 12,368,448 est. | 26.87 GiB | — | — | C/F | 1s, 2s |
| `borg_option_shadow_marks_p20260803` | options_surface | normalized_or_derived | 6,989,250 est. | 15.17 GiB | — | — | C/F | 1s, 2s |
| `pm_flow_trades` | market_making_and_flow | normalized_or_gold | 1,658,522 est. | 3.27 GiB | — | — | B/F | 100ms, 250ms, 500ms, 1s, 2s |
| `borg_structural_candidates` | structural_payoff | gold_fact | 486,074 est. | 2.05 GiB | — | — | D/DERIVED | none |
| `borg_clob_touch_p20260803` | polymarket_clob | normalized_raw | 3,548,551 est. | 1.87 GiB | — | — | C/C | 1s, 2s |
| `cv_terminal_carry_marks` | crossvenue_prediction | normalized_or_gold | 752,308 est. | 1.86 GiB | — | — | C/F | 1s, 2s |
| `borg_deribit_option_touch_p20260802` | options_surface | normalized_or_derived | 2,422,580 est. | 1.46 GiB | 2026-08-02T00:00:25.000Z | 2026-08-02T23:59:55.000Z | B/F | 100ms, 250ms, 500ms, 1s, 2s |
| `borg_structural_evaluations_p20260802` | structural_payoff | gold_fact | 489,758 est. | 1.07 GiB | 2026-08-02T00:01:00.746Z | 2026-08-02T23:59:59.382Z | D/DERIVED | none |
| `borg_deribit_option_touch_p20260803` | options_surface | normalized_or_derived | 1,445,485 est. | 855.83 MiB | — | — | B/F | 100ms, 250ms, 500ms, 1s, 2s |
| `cv_basis_samples_p20260802` | crossvenue_prediction | normalized_or_gold | 210,802 est. | 619.33 MiB | 2026-08-02T00:00:24.174Z | 2026-08-02T23:59:58.232Z | C/F | 1s, 2s |
| `borg_events` | provenance_and_health | control | 802,329 est. | 575.58 MiB | — | — | D/F | none |
| `borg_structural_rule_snapshots` | structural_payoff | gold_fact | 275,082 est. | 561.71 MiB | — | — | D/DERIVED | none |
| `borg_structural_evaluations_p20260803` | structural_payoff | gold_fact | 211,456 est. | 475.63 MiB | 2026-08-03T00:00:02.400Z | 2026-08-03T13:53:56.874Z | D/DERIVED | none |
| `borg_external_book_touch_p20260803` | external_crypto_market | normalized_raw | 1,537,941 est. | 442.00 MiB | — | — | B/C | 100ms, 250ms, 500ms, 1s, 2s |
| `borg_taker_trades` | external_crypto_market | normalized_raw | 267,971 est. | 440.48 MiB | 2026-08-02T13:50:03.000Z | 2026-08-03T13:49:59.000Z | D/F | none |
| `cv_opportunities_p20260803` | crossvenue_prediction | normalized_or_gold | 125,932 est. | 424.32 MiB | 2026-08-03T00:00:00.220Z | 2026-08-03T13:54:01.658Z | C/F | 1s, 2s |
| `borg_clob_events_p20260803` | polymarket_clob | normalized_raw | 532,258 est. | 412.10 MiB | 2026-08-03T00:00:00.249Z | 2026-08-03T13:53:58.468Z | C/C | 1s, 2s |
| `am_order_intents` | market_making_and_flow | normalized_or_gold | 312,723 est. | 406.00 MiB | 2026-07-16T17:34:59.669Z | 2026-07-21T14:04:29.405Z | D/F | none |
| `cv_contract_matches` | crossvenue_prediction | normalized_or_gold | 12,316 est. | 392.38 MiB | 2026-07-16T18:43:46.422Z | 2026-08-03T13:53:15.483Z | D/F | none |
| `borg_rtds_ticks` | resolver_feeds | normalized_raw | 660,275 est. | 389.98 MiB | 2026-08-02T13:50:02.307Z | 2026-08-03T13:54:03.577Z | B/F | 100ms, 250ms, 500ms, 1s, 2s |
| `borg_option_shadow_marks_retained` | options_surface | normalized_or_derived | 148,836 est. | 387.91 MiB | — | — | C/F | 1s, 2s |
| `cv_basis_samples_p20260803` | crossvenue_prediction | normalized_or_gold | 125,926 est. | 369.96 MiB | 2026-08-03T00:00:00.220Z | 2026-08-03T13:54:05.657Z | C/F | 1s, 2s |
| `borg_external_trades_p20260802` | external_crypto_market | normalized_raw | 866,801 est. | 360.35 MiB | 2026-08-02T00:00:36.259Z | 2026-08-02T23:59:59.971Z | B/F | 100ms, 250ms, 500ms, 1s, 2s |
| `pm_flow_markets` | market_making_and_flow | normalized_or_gold | 17,261 est. | 347.02 MiB | 2026-07-16T12:09:06.870Z | 2026-08-03T13:53:31.724Z | D/F | none |
| `borg_book_snaps_p20260802` | polymarket_clob | normalized_raw | 276,972 est. | 334.78 MiB | 2026-08-02T00:00:45.299Z | 2026-08-02T23:59:58.797Z | D/F | none |
| `borg_external_trades_p20260803` | external_crypto_market | normalized_raw | 540,220 est. | 225.86 MiB | 2026-08-03T00:00:00.019Z | 2026-08-03T13:54:08.831Z | B/F | 100ms, 250ms, 500ms, 1s, 2s |
| `borg_markets` | application_or_uncatalogued | application | 44,577 est. | 190.43 MiB | 2026-07-11T01:05:00.000Z | 2026-08-06T16:00:00.000Z | D/F | none |
| `pm_flow_touches` | polymarket_clob | normalized_raw | 65,694 est. | 188.02 MiB | 2026-08-03T07:52:36.011Z | 2026-08-03T13:54:11.824Z | B/C | 100ms, 250ms, 500ms, 1s, 2s |
| `borg_book_snaps_p20260803` | polymarket_clob | normalized_raw | 141,849 est. | 182.01 MiB | 2026-08-03T00:00:00.840Z | 2026-08-03T13:54:07.043Z | D/F | none |
| `borg_shadow_orders` | strategy_evidence | gold_fact | 86,421 est. | 167.12 MiB | 2026-07-15T19:26:37.243Z | 2026-08-03T13:53:16.751Z | D/DERIVED | none |
| `cv_book_snapshots_p20260803` | crossvenue_prediction | normalized_or_gold | 68,029 est. | 152.96 MiB | 2026-08-03T00:00:00.220Z | 2026-08-03T13:54:05.657Z | C/F | 1s, 2s |
| `pm_flow_scores` | market_making_and_flow | normalized_or_gold | 91,911 est. | 143.80 MiB | 2026-07-16T12:06:49.859Z | 2026-07-21T07:44:38.985Z | D/F | none |
| `pm_flow_signals` | market_making_and_flow | normalized_or_gold | 91,911 est. | 141.35 MiB | 2026-07-16T12:06:49.868Z | 2026-07-21T14:04:28.748Z | D/F | none |
| `am_execution_scores` | market_making_and_flow | normalized_or_gold | 216,745 est. | 106.74 MiB | 2026-07-16T17:35:29.909Z | 2026-07-21T14:04:29.405Z | D/F | none |
| `borg_pyth_ticks` | resolver_feeds | normalized_raw | 0 est. | 98.98 MiB | — | — | B/F | 100ms, 250ms, 500ms, 1s, 2s |
| `signals` | legacy_bot_evidence | derived_legacy | 178,461 est. | 65.21 MiB | — | — | D/F | none |
| `george_signals` | legacy_bot_evidence | derived_legacy | 226,954 est. | 64.23 MiB | 2026-07-10T14:37:54.610Z | 2026-08-03T13:53:40.393Z | D/F | none |
| `am_book_touches` | polymarket_clob | normalized_raw | 7,146 est. | 59.80 MiB | 2026-08-03T07:53:05.458Z | 2026-08-03T13:54:16.281Z | B/C | 100ms, 250ms, 500ms, 1s, 2s |
| `borg_binance_1s` | external_crypto_market | normalized_raw | 250,311 est. | 55.44 MiB | 2026-08-02T13:50:03.000Z | 2026-08-03T13:54:12.000Z | D/C | none |
| `borg_shadow_scores` | strategy_evidence | gold_fact | 86,272 est. | 50.71 MiB | 2026-07-11T13:49:06.350Z | 2026-08-03T13:45:25.179Z | D/DERIVED | none |
| `am_markets` | market_making_and_flow | normalized_or_gold | 36,064 est. | 36.31 MiB | 2025-10-31T00:00:00.000Z | 2029-01-19T23:59:00.000Z | D/F | none |
| `cv_rule_snapshots` | crossvenue_prediction | normalized_or_gold | 21,702 est. | 33.25 MiB | 2026-07-18T20:07:26.123Z | 2026-08-03T08:33:19.829Z | D/F | none |
| `borg_evidence_health_samples` | provenance_and_health | control | 17,568 est. | 29.11 MiB | 2026-07-21T15:45:37.944Z | 2026-08-03T13:53:17.178Z | D/F | none |
| `borg_coinbase_1s` | external_crypto_market | normalized_raw | 149,802 est. | 25.80 MiB | 2026-08-02T13:50:03.000Z | 2026-08-03T13:54:13.000Z | D/C | none |
| `cv_maker_episodes` | crossvenue_prediction | normalized_or_gold | 20,579 est. | 25.37 MiB | 2026-07-19T18:24:30.933Z | 2026-08-03T13:53:05.306Z | D/F | none |
| `pmm_pair_observations` | market_making_and_flow | normalized_or_gold | 0 est. | 22.97 MiB | — | — | C/F | 1s, 2s |
| `cv_runtime` | crossvenue_prediction | normalized_or_gold | 34,993 est. | 20.59 MiB | 2026-07-16T18:44:49.720Z | 2026-08-03T13:54:11.917Z | D/F | none |
| `skipped_signals` | legacy_bot_evidence | derived_legacy | 56,458 est. | 19.30 MiB | 2026-07-12T02:22:59.438Z | 2026-08-03T13:53:49.844Z | D/F | none |
| `borg_options_runtime` | options_surface | normalized_or_derived | 6,101 est. | 18.68 MiB | 2026-07-18T18:38:19.972Z | 2026-08-03T13:54:16.890Z | D/F | none |
| `borg_collector_runs` | provenance_and_health | control | 34,483 est. | 16.38 MiB | 2026-07-15T23:32:33.732Z | 2026-08-03T13:20:22.791Z | D/F | none |
| `am_runtime` | market_making_and_flow | normalized_or_gold | 7,411 est. | 15.60 MiB | 2026-07-16T17:37:10.504Z | 2026-08-03T13:54:15.634Z | D/F | none |
| `pmm_events` | market_making_and_flow | normalized_or_gold | 22,423 est. | 15.42 MiB | 2026-07-17T08:42:05.128Z | 2026-07-21T14:04:29.412Z | C/F | 1s, 2s |
| `cv_basis_samples_retained` | crossvenue_prediction | normalized_or_gold | 12,289 est. | 13.92 MiB | 2026-07-16T22:09:19.280Z | 2026-07-30T12:10:31.934Z | C/F | 1s, 2s |
| `borg_shadow_latency_scores` | strategy_evidence | gold_fact | 24,678 est. | 12.09 MiB | 2026-07-21T15:44:18.539Z | 2026-08-03T13:45:25.178Z | D/DERIVED | none |
| `pmm_runtime` | market_making_and_flow | normalized_or_gold | 5,204 est. | 11.56 MiB | 2026-07-17T08:47:39.632Z | 2026-07-21T14:04:29.487Z | D/F | none |
| `pmm_cycles` | market_making_and_flow | normalized_or_gold | 1,323 est. | 9.44 MiB | 2026-07-17T08:42:05.128Z | 2026-07-21T14:04:00.223Z | D/F | none |
| `borg_deribit_instruments` | options_surface | normalized_or_derived | 697 est. | 7.98 MiB | 2026-07-19T08:00:00.000Z | 2026-08-14T08:00:00.000Z | D/F | none |
| `borg_pyth_markets` | application_or_uncatalogued | application | 341 est. | 6.77 MiB | 2026-07-20T20:00:00.000Z | 2026-08-03T21:00:00.000Z | D/F | none |
| `borg_strategy_runtime` | strategy_evidence | gold_fact | 3,200 est. | 3.71 MiB | 2026-07-15T23:45:18.720Z | 2026-08-03T13:53:27.716Z | D/DERIVED | none |
| `borg_pyth_arrivals` | resolver_feeds | normalized_raw | 2,892 est. | 3.11 MiB | 2026-07-20T02:00:28.481Z | 2026-07-30T11:49:29.882Z | C/F | 1s, 2s |
| `borg_structural_passive_quotes` | structural_payoff | gold_fact | 1,176 est. | 2.28 MiB | 2026-07-27T13:44:35.943Z | 2026-08-03T12:26:16.273Z | D/DERIVED | none |
| `cv_settlements` | crossvenue_prediction | normalized_or_gold | 3,324 est. | 1.58 MiB | 2026-07-19T16:26:25.177Z | 2026-08-03T08:07:07.313Z | D/F | none |
| `pm_flow_connection_events` | market_making_and_flow | normalized_or_gold | 64 est. | 1.48 MiB | 2026-08-02T14:01:36.963Z | 2026-08-03T13:46:23.855Z | C/F | 1s, 2s |
| `borg_pyth_rule_snapshots` | application_or_uncatalogued | application | 430 est. | 1.25 MiB | 2026-07-18T20:07:32.154Z | 2026-08-01T02:19:07.844Z | D/F | none |
| `borg_trial_ledger` | strategy_evidence | gold_fact | 191 est. | 1.05 MiB | 2026-07-15T19:24:01.177Z | 2026-08-03T13:16:31.529Z | D/DERIVED | none |
| `borg_pyth_signals` | application_or_uncatalogued | application | 931 est. | 1008.00 KiB | 2026-07-20T02:00:28.450Z | 2026-07-30T11:49:29.349Z | B/F | 100ms, 250ms, 500ms, 1s, 2s |
| `system_heartbeats` | provenance_and_health | control | 13 est. | 1008.00 KiB | 2026-07-21T14:04:29.486Z | 2026-08-03T13:54:20.342Z | D/F | none |
| `borg_pyth_markouts` | application_or_uncatalogued | application | 750 est. | 608.00 KiB | 2026-07-21T19:58:01.402Z | 2026-07-29T19:59:30.852Z | C/F | 1s, 2s |
| `pmm_markets` | market_making_and_flow | normalized_or_gold | 427 est. | 520.00 KiB | 2026-07-17T13:00:00.000Z | 2027-04-30T23:59:00.000Z | D/F | none |
| `h53_live_orders` | application_or_uncatalogued | application | 902 est. | 488.00 KiB | 2026-07-18T20:50:14.817Z | 2026-07-19T16:20:01.731Z | D/F | none |
| `borg_pyth_runtime` | provenance_and_health | control | 78 est. | 480.00 KiB | 2026-07-19T02:45:14.337Z | 2026-08-03T13:54:15.866Z | D/F | none |
| `gla_live_orders` | application_or_uncatalogued | application | 46 est. | 464.00 KiB | 2026-07-13T17:13:48.522Z | 2026-07-20T09:49:54.860Z | D/F | none |
| `trades` | legacy_bot_evidence | derived_legacy | 0 est. | 304.00 KiB | 2026-07-10T14:46:31.623Z | 2026-07-16T08:57:00.804Z | D/F | none |
| `am_panel_memberships` | market_making_and_flow | normalized_or_gold | 280 est. | 288.00 KiB | 2026-07-21T22:17:11.606Z | 2026-08-03T13:20:53.140Z | D/F | none |
| `borg_experiments` | strategy_evidence | gold_fact | 33 est. | 256.00 KiB | 2026-07-15T00:00:00.000Z | 2026-08-03T12:40:00.000Z | D/DERIVED | none |
| `borg_pyth_terminal_scores` | application_or_uncatalogued | application | 250 est. | 240.00 KiB | 2026-07-21T20:06:59.277Z | 2026-07-29T20:06:44.601Z | D/F | none |
| `claude_analyses` | application_or_uncatalogued | application | 1 est. | 216.00 KiB | 2026-07-09T17:26:10.676Z | 2026-08-01T13:40:43.674Z | D/F | none |
| `cv_opportunities_retained` | crossvenue_prediction | normalized_or_gold | 30 est. | 184.00 KiB | 2026-07-28T03:08:40.666Z | 2026-07-30T12:10:31.934Z | C/F | 1s, 2s |
| `borg_chainlink_rounds` | resolver_feeds | normalized_raw | 591 est. | 168.00 KiB | 2026-07-11T01:00:55.110Z | 2026-08-03T13:49:32.863Z | D/F | none |
| `am_inventory` | market_making_and_flow | normalized_or_gold | 29 est. | 144.00 KiB | 2026-07-16T17:40:15.891Z | 2026-07-21T06:51:09.455Z | D/F | none |
| `borg_experiment_strategies` | strategy_evidence | gold_fact | 56 est. | 120.00 KiB | — | — | D/DERIVED | none |
| `cv_relation_episodes` | crossvenue_prediction | normalized_or_gold | 16 est. | 120.00 KiB | 2026-07-19T22:21:36.968Z | 2026-08-03T13:16:39.118Z | D/F | none |
| `george_trades` | legacy_bot_evidence | derived_legacy | 0 est. | 120.00 KiB | 2026-07-10T15:15:15.884Z | 2026-07-16T05:15:28.557Z | D/F | none |
| `pm_flow_boundary_intents` | market_making_and_flow | normalized_or_gold | 4 est. | 112.00 KiB | 2026-07-18T18:54:58.456Z | 2026-07-21T06:54:55.117Z | D/F | none |
| `borg_collection_epochs` | provenance_and_health | control | 22 est. | 96.00 KiB | 2026-07-15T22:26:55.888Z | 2026-08-03T13:20:03.780Z | D/F | none |
| `borg_structural_evaluations_p20260804` | structural_payoff | gold_fact | 0 est. | 96.00 KiB | — | — | D/DERIVED | none |
| `borg_structural_evaluations_p20260805` | structural_payoff | gold_fact | 0 est. | 96.00 KiB | — | — | D/DERIVED | none |
| `borg_structural_evaluations_p20260806` | structural_payoff | gold_fact | 0 est. | 96.00 KiB | — | — | D/DERIVED | none |
| `borg_structural_evaluations_p20260807` | structural_payoff | gold_fact | 0 est. | 96.00 KiB | — | — | D/DERIVED | none |
| `borg_structural_evaluations_p20260808` | structural_payoff | gold_fact | 0 est. | 96.00 KiB | — | — | D/DERIVED | none |
| `borg_structural_evaluations_p20260809` | structural_payoff | gold_fact | 0 est. | 96.00 KiB | — | — | D/DERIVED | none |
| `borg_structural_evaluations_p20260810` | structural_payoff | gold_fact | 0 est. | 96.00 KiB | — | — | D/DERIVED | none |
| `borg_deribit_option_touch_p20260804` | options_surface | normalized_or_derived | 0 est. | 80.00 KiB | — | — | B/F | 100ms, 250ms, 500ms, 1s, 2s |
| `borg_deribit_option_touch_p20260805` | options_surface | normalized_or_derived | 0 est. | 80.00 KiB | — | — | B/F | 100ms, 250ms, 500ms, 1s, 2s |
| `borg_deribit_option_touch_p20260806` | options_surface | normalized_or_derived | 0 est. | 80.00 KiB | — | — | B/F | 100ms, 250ms, 500ms, 1s, 2s |
| `borg_deribit_option_touch_p20260807` | options_surface | normalized_or_derived | 0 est. | 80.00 KiB | — | — | B/F | 100ms, 250ms, 500ms, 1s, 2s |
| `borg_deribit_option_touch_p20260808` | options_surface | normalized_or_derived | 0 est. | 80.00 KiB | — | — | B/F | 100ms, 250ms, 500ms, 1s, 2s |
| `borg_deribit_option_touch_p20260809` | options_surface | normalized_or_derived | 0 est. | 80.00 KiB | — | — | B/F | 100ms, 250ms, 500ms, 1s, 2s |
| `borg_deribit_option_touch_p20260810` | options_surface | normalized_or_derived | 0 est. | 80.00 KiB | — | — | B/F | 100ms, 250ms, 500ms, 1s, 2s |
| `borg_external_trades_p20260804` | external_crypto_market | normalized_raw | 0 est. | 80.00 KiB | — | — | B/F | 100ms, 250ms, 500ms, 1s, 2s |
| `borg_external_trades_p20260805` | external_crypto_market | normalized_raw | 0 est. | 80.00 KiB | — | — | B/F | 100ms, 250ms, 500ms, 1s, 2s |
| `borg_external_trades_p20260806` | external_crypto_market | normalized_raw | 0 est. | 80.00 KiB | — | — | B/F | 100ms, 250ms, 500ms, 1s, 2s |
| `borg_external_trades_p20260807` | external_crypto_market | normalized_raw | 0 est. | 80.00 KiB | — | — | B/F | 100ms, 250ms, 500ms, 1s, 2s |
| `borg_external_trades_p20260808` | external_crypto_market | normalized_raw | 0 est. | 80.00 KiB | — | — | B/F | 100ms, 250ms, 500ms, 1s, 2s |
| `borg_external_trades_p20260809` | external_crypto_market | normalized_raw | 0 est. | 80.00 KiB | — | — | B/F | 100ms, 250ms, 500ms, 1s, 2s |
| `borg_external_trades_p20260810` | external_crypto_market | normalized_raw | 0 est. | 80.00 KiB | — | — | B/F | 100ms, 250ms, 500ms, 1s, 2s |
| `trading_sessions` | legacy_bot_evidence | derived_legacy | 196 est. | 80.00 KiB | — | — | D/F | none |
| `borg_book_snaps_p20260804` | polymarket_clob | normalized_raw | 0 est. | 72.00 KiB | — | — | D/F | none |
| `borg_book_snaps_p20260805` | polymarket_clob | normalized_raw | 0 est. | 72.00 KiB | — | — | D/F | none |
| `borg_book_snaps_p20260806` | polymarket_clob | normalized_raw | 0 est. | 72.00 KiB | — | — | D/F | none |
| `borg_book_snaps_p20260807` | polymarket_clob | normalized_raw | 0 est. | 72.00 KiB | — | — | D/F | none |
| `borg_book_snaps_p20260808` | polymarket_clob | normalized_raw | 0 est. | 72.00 KiB | — | — | D/F | none |
| `borg_book_snaps_p20260809` | polymarket_clob | normalized_raw | 0 est. | 72.00 KiB | — | — | D/F | none |
| `borg_book_snaps_p20260810` | polymarket_clob | normalized_raw | 0 est. | 72.00 KiB | — | — | D/F | none |
| `borg_clob_touch_p20260804` | polymarket_clob | normalized_raw | 0 est. | 72.00 KiB | — | — | C/C | 1s, 2s |
| `borg_clob_touch_p20260805` | polymarket_clob | normalized_raw | 0 est. | 72.00 KiB | — | — | C/C | 1s, 2s |
| `borg_clob_touch_p20260806` | polymarket_clob | normalized_raw | 0 est. | 72.00 KiB | — | — | C/C | 1s, 2s |
| `borg_clob_touch_p20260807` | polymarket_clob | normalized_raw | 0 est. | 72.00 KiB | — | — | C/C | 1s, 2s |
| `borg_clob_touch_p20260808` | polymarket_clob | normalized_raw | 0 est. | 72.00 KiB | — | — | C/C | 1s, 2s |
| `borg_clob_touch_p20260809` | polymarket_clob | normalized_raw | 0 est. | 72.00 KiB | — | — | C/C | 1s, 2s |
| `borg_clob_touch_p20260810` | polymarket_clob | normalized_raw | 0 est. | 72.00 KiB | — | — | C/C | 1s, 2s |
| `borg_external_book_touch_p20260804` | external_crypto_market | normalized_raw | 0 est. | 72.00 KiB | — | — | B/C | 100ms, 250ms, 500ms, 1s, 2s |
| `borg_external_book_touch_p20260805` | external_crypto_market | normalized_raw | 0 est. | 72.00 KiB | — | — | B/C | 100ms, 250ms, 500ms, 1s, 2s |
| `borg_external_book_touch_p20260806` | external_crypto_market | normalized_raw | 0 est. | 72.00 KiB | — | — | B/C | 100ms, 250ms, 500ms, 1s, 2s |
| `borg_external_book_touch_p20260807` | external_crypto_market | normalized_raw | 0 est. | 72.00 KiB | — | — | B/C | 100ms, 250ms, 500ms, 1s, 2s |
| `borg_external_book_touch_p20260808` | external_crypto_market | normalized_raw | 0 est. | 72.00 KiB | — | — | B/C | 100ms, 250ms, 500ms, 1s, 2s |
| `borg_external_book_touch_p20260809` | external_crypto_market | normalized_raw | 0 est. | 72.00 KiB | — | — | B/C | 100ms, 250ms, 500ms, 1s, 2s |
| `borg_external_book_touch_p20260810` | external_crypto_market | normalized_raw | 0 est. | 72.00 KiB | — | — | B/C | 100ms, 250ms, 500ms, 1s, 2s |
| `eth_g_late_live_orders` | application_or_uncatalogued | application | 8 est. | 72.00 KiB | — | — | D/F | none |
| `flow_boundary_canary_orders` | application_or_uncatalogued | application | 3 est. | 64.00 KiB | — | — | D/F | none |
| `borg_option_shadow_marks_p20260804` | options_surface | normalized_or_derived | 0 est. | 48.00 KiB | — | — | C/F | 1s, 2s |
| `borg_option_shadow_marks_p20260805` | options_surface | normalized_or_derived | 0 est. | 48.00 KiB | — | — | C/F | 1s, 2s |
| `borg_option_shadow_marks_p20260806` | options_surface | normalized_or_derived | 0 est. | 48.00 KiB | — | — | C/F | 1s, 2s |
| `borg_option_shadow_marks_p20260807` | options_surface | normalized_or_derived | 0 est. | 48.00 KiB | — | — | C/F | 1s, 2s |
| `borg_option_shadow_marks_p20260808` | options_surface | normalized_or_derived | 0 est. | 48.00 KiB | — | — | C/F | 1s, 2s |
| `borg_option_shadow_marks_p20260809` | options_surface | normalized_or_derived | 0 est. | 48.00 KiB | — | — | C/F | 1s, 2s |
| `borg_option_shadow_marks_p20260810` | options_surface | normalized_or_derived | 0 est. | 48.00 KiB | — | — | C/F | 1s, 2s |
| `bot_settings` | application_or_uncatalogued | application | 1 est. | 48.00 KiB | — | — | D/F | none |
| `cv_basis_samples_p20260804` | crossvenue_prediction | normalized_or_gold | 0 est. | 48.00 KiB | — | — | C/F | 1s, 2s |
| `cv_basis_samples_p20260805` | crossvenue_prediction | normalized_or_gold | 0 est. | 48.00 KiB | — | — | C/F | 1s, 2s |
| `cv_basis_samples_p20260806` | crossvenue_prediction | normalized_or_gold | 0 est. | 48.00 KiB | — | — | C/F | 1s, 2s |
| `cv_basis_samples_p20260807` | crossvenue_prediction | normalized_or_gold | 0 est. | 48.00 KiB | — | — | C/F | 1s, 2s |
| `cv_basis_samples_p20260808` | crossvenue_prediction | normalized_or_gold | 0 est. | 48.00 KiB | — | — | C/F | 1s, 2s |
| `cv_basis_samples_p20260809` | crossvenue_prediction | normalized_or_gold | 0 est. | 48.00 KiB | — | — | C/F | 1s, 2s |
| `cv_basis_samples_p20260810` | crossvenue_prediction | normalized_or_gold | 0 est. | 48.00 KiB | — | — | C/F | 1s, 2s |
| `cv_opportunities_p20260804` | crossvenue_prediction | normalized_or_gold | 0 est. | 48.00 KiB | — | — | C/F | 1s, 2s |
| `cv_opportunities_p20260805` | crossvenue_prediction | normalized_or_gold | 0 est. | 48.00 KiB | — | — | C/F | 1s, 2s |
| `cv_opportunities_p20260806` | crossvenue_prediction | normalized_or_gold | 0 est. | 48.00 KiB | — | — | C/F | 1s, 2s |
| `cv_opportunities_p20260807` | crossvenue_prediction | normalized_or_gold | 0 est. | 48.00 KiB | — | — | C/F | 1s, 2s |
| `cv_opportunities_p20260808` | crossvenue_prediction | normalized_or_gold | 0 est. | 48.00 KiB | — | — | C/F | 1s, 2s |
| `cv_opportunities_p20260809` | crossvenue_prediction | normalized_or_gold | 0 est. | 48.00 KiB | — | — | C/F | 1s, 2s |
| `cv_opportunities_p20260810` | crossvenue_prediction | normalized_or_gold | 0 est. | 48.00 KiB | — | — | C/F | 1s, 2s |
| `dup_archive` | application_or_uncatalogued | application | 0 est. | 48.00 KiB | — | — | D/F | none |
| `refresh_tokens` | application_or_uncatalogued | application | 1 est. | 48.00 KiB | — | — | D/F | none |
| `users` | application_or_uncatalogued | application | 0 est. | 48.00 KiB | — | — | D/F | none |
| `cv_depth_replays` | crossvenue_prediction | normalized_or_gold | 0 est. | 40.00 KiB | — | — | C/F | 1s, 2s |
| `health_probe` | provenance_and_health | control | 1 est. | 40.00 KiB | — | — | D/F | none |
| `asset_config` | application_or_uncatalogued | application | 0 est. | 32.00 KiB | — | — | D/F | none |
| `borg_adapter_checkpoints` | application_or_uncatalogued | application | 0 est. | 32.00 KiB | — | — | D/F | none |
| `cv_book_snapshots_p20260804` | crossvenue_prediction | normalized_or_gold | 0 est. | 32.00 KiB | — | — | C/F | 1s, 2s |
| `cv_book_snapshots_p20260805` | crossvenue_prediction | normalized_or_gold | 0 est. | 32.00 KiB | — | — | C/F | 1s, 2s |
| `cv_book_snapshots_p20260806` | crossvenue_prediction | normalized_or_gold | 0 est. | 32.00 KiB | — | — | C/F | 1s, 2s |
| `cv_book_snapshots_p20260807` | crossvenue_prediction | normalized_or_gold | 0 est. | 32.00 KiB | — | — | C/F | 1s, 2s |
| `cv_book_snapshots_p20260808` | crossvenue_prediction | normalized_or_gold | 0 est. | 32.00 KiB | — | — | C/F | 1s, 2s |
| `cv_book_snapshots_p20260809` | crossvenue_prediction | normalized_or_gold | 0 est. | 32.00 KiB | — | — | C/F | 1s, 2s |
| `cv_book_snapshots_p20260810` | crossvenue_prediction | normalized_or_gold | 0 est. | 32.00 KiB | — | — | C/F | 1s, 2s |
| `redeem_log` | application_or_uncatalogued | application | 0 est. | 32.00 KiB | — | — | D/F | none |
| `relaunch_baseline` | application_or_uncatalogued | application | 0 est. | 32.00 KiB | — | — | D/F | none |
| `whale_performance` | application_or_uncatalogued | application | 0 est. | 32.00 KiB | — | — | D/F | none |
| `borg_clob_events_p20260804` | polymarket_clob | normalized_raw | 0 est. | 24.00 KiB | — | — | C/C | 1s, 2s |
| `borg_clob_events_p20260805` | polymarket_clob | normalized_raw | 0 est. | 24.00 KiB | — | — | C/C | 1s, 2s |
| `borg_clob_events_p20260806` | polymarket_clob | normalized_raw | 0 est. | 24.00 KiB | — | — | C/C | 1s, 2s |
| `borg_clob_events_p20260807` | polymarket_clob | normalized_raw | 0 est. | 24.00 KiB | — | — | C/C | 1s, 2s |
| `borg_clob_events_p20260808` | polymarket_clob | normalized_raw | 0 est. | 24.00 KiB | — | — | C/C | 1s, 2s |
| `borg_clob_events_p20260809` | polymarket_clob | normalized_raw | 0 est. | 24.00 KiB | — | — | C/C | 1s, 2s |
| `borg_clob_events_p20260810` | polymarket_clob | normalized_raw | 0 est. | 24.00 KiB | — | — | C/C | 1s, 2s |
| `admin_logs` | application_or_uncatalogued | application | 0 est. | 16.00 KiB | — | — | D/F | none |
| `borg_experiment_runs` | strategy_evidence | gold_fact | 0 est. | 16.00 KiB | — | — | D/DERIVED | none |
| `borg_structural_evaluations_retained` | structural_payoff | gold_fact | 0 est. | 16.00 KiB | — | — | D/DERIVED | none |
| `copy_targets` | application_or_uncatalogued | application | 0 est. | 16.00 KiB | — | — | D/F | none |
| `copy_trades` | application_or_uncatalogued | application | 0 est. | 16.00 KiB | — | — | D/F | none |
| `borg_book_snaps` | polymarket_clob | normalized_raw | 0 est. | 0 B | — | — | D/F | none |
| `borg_clob_events` | polymarket_clob | normalized_raw | 0 est. | 0 B | — | — | C/C | 1s, 2s |
| `borg_clob_touch` | polymarket_clob | normalized_raw | 0 est. | 0 B | — | — | C/C | 1s, 2s |
| `borg_deribit_option_touch` | options_surface | normalized_or_derived | 0 est. | 0 B | — | — | B/F | 100ms, 250ms, 500ms, 1s, 2s |
| `borg_external_book_touch` | external_crypto_market | normalized_raw | 0 est. | 0 B | — | — | B/C | 100ms, 250ms, 500ms, 1s, 2s |
| `borg_external_trades` | external_crypto_market | normalized_raw | 0 est. | 0 B | — | — | B/F | 100ms, 250ms, 500ms, 1s, 2s |
| `borg_option_shadow_marks` | options_surface | normalized_or_derived | 0 est. | 0 B | — | — | C/F | 1s, 2s |
| `borg_structural_evaluations` | structural_payoff | gold_fact | 0 est. | 0 B | — | — | D/DERIVED | none |
| `cv_basis_samples` | crossvenue_prediction | normalized_or_gold | 0 est. | 0 B | — | — | C/F | 1s, 2s |
| `cv_book_snapshots` | crossvenue_prediction | normalized_or_gold | 0 est. | 0 B | — | — | C/F | 1s, 2s |
| `cv_opportunities` | crossvenue_prediction | normalized_or_gold | 0 est. | 0 B | — | — | C/F | 1s, 2s |

## Causal interpretation

- Grade A data requires source time, local receive time, monotonic time, sequence and run/connection identity. Grade B is usable for slower replay with a stated clock limitation. Grade C is coarse diagnostic evidence only.
- Execution grade A additionally requires full contemporaneous depth and effective fee data. Public books never prove authenticated queue position, cancellation acknowledgement or private fills.
- `20–50 ms` replay is a software counterfactual only when event source/receive clocks are complete. It does not retroactively improve a slow or missing source feed.
- Derived strategy rows are gold facts for governance and P&L attribution, not a substitute for raw event reconstruction.
- Current raw storage can test prediction-market and four-asset crypto hypotheses. It cannot honestly backtest news/social, sportsbook or DEX execution strategies until dedicated causal collectors exist.

