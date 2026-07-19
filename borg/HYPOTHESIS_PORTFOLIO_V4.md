# BORG H22-H31 Multi-Horizon Crypto Research Portfolio

## Honest status

H22-H31 are **new forward-only shadow pilots**, not profitable bots and not
backtested strategies. Before this change, TV2 did not collect the hourly,
daily-threshold, or daily-range CLOB tape required to test them. Any historical
PnL number for these exact strategies would therefore be fabricated. Collection
starts at deployment; pilot rows validate discovery, labels, fills, fees, and
group accounting only. A later parameter-freeze creates a fresh evaluation
cohort.

Every strategy is paper/shadow only. There is no wallet, signer, CLOB order
client, or live-order call in the v4 module.

## Contract audit and universe

The current Polymarket contracts were read from the public Gamma API and their
stored descriptions remain in `borg_markets.raw`:

- Hourly Up/Down resolves **Up** when the named Binance USDT one-hour candle's
  final close is greater than or equal to its open; otherwise Down.
- Daily threshold markets resolve from the final close of the named Binance
  USDT one-minute candle at noon ET.
- Daily range events use the same Binance one-minute close and mutually
  exclusive buckets; an exact shared boundary belongs to the higher bucket.

Market discovery uses Polymarket's documented Gamma event workflow, while book
state uses the documented CLOB market WebSocket rather than millisecond REST
polling: [fetching markets](https://docs.polymarket.com/market-data/fetching-markets),
[market channel](https://docs.polymarket.com/market-data/websocket/market-channel),
[API overview](https://docs.polymarket.com/api-reference/introduction).

To protect the existing five-minute tape, the selected panel is deliberately
bounded and deterministic:

- current hourly BTC, ETH, SOL, and XRP;
- the next hourly contract is discovered but subscribed only 30 seconds before
  opening;
- five near-spot daily thresholds plus four near-spot disjoint buckets for each
  configured daily asset: BTC, ETH, SOL, and XRP;
- discovery looks ahead seven days and selects only from a fresh resolver spot;
  missing spot means no daily selection rather than guessed moneyness.

The wider daily panel is capture-only and was registered as a new pilot
identity; its counts are socket-budget choices, not fitted trade thresholds.
`BORG_RESEARCH_HOURLY_ASSETS`, `BORG_RESEARCH_DAILY_ASSETS`, and
`BORG_RESEARCH_DAILY_ASSET` can alter research coverage, but doing so after a
freeze creates another experiment identity.

## Pre-registered hypotheses

| Strategy | Root | Tier | Mechanism | Primary falsification |
|---|---|---:|---|---|
| `H22_hourly_resolver_dislocation` | R1 | V | The named Binance resolver moves materially from the hour open while the executable token lags | Edge disappears with 1.25 s quote survival, or is negative after 2× fees |
| `H23_hourly_crossvenue_confirmation` | R1/R4 | V | Coinbase confirmation filters Binance-specific bad ticks while Binance remains the resolver | Confirmation does not improve clustered expectancy relative to H22 |
| `H24_hourly_flow_breakout` | R2 | V | Opening-range displacement plus aggressor flow and depth continuation carries into the terminal candle | Returns reverse after entry or fill-conditioned PnL is non-positive |
| `H25_horizon_vol_surface` | R4 | H/V | Five-minute and hourly digitals imply inconsistent sigma after converting both to a five-minute scale | Apparent term-structure outliers are explained by stale books or the short-memory sigma model |
| `H26_nested_threshold_bundle` | R5 | P/V | For `Klow < Khigh`, equal shares of YES(`S>Klow`) + NO(`S>Khigh`) pay at least one dollar in every state | No complete bundle survives 2× fees and latency, or orphan-leg losses consume the gross lock |
| `H27_disjoint_bucket_bundle` | R5 | P/V | Equal shares of NO on two mutually exclusive buckets pay at least one dollar in every state | Executable prices remove the lock, definitions overlap, or non-atomic legging dominates |
| `H28_threshold_resolver_close` | R1 | H | In the final five minutes, direct Binance spot plus remaining variance may update before a threshold token | Last-minute jump/adverse-selection losses eliminate the model edge |
| `H29_range_resolver_close` | R1 | H | The same direct-resolver mechanism applied to a bounded terminal interval | Bucket-boundary jump risk and spread overwhelm post-fee expectancy |
| `H30_threshold_ladder_residual` | R1/R5 | V | One strike reprices more slowly than neighbouring strikes in the same event | Residuals are model-shape errors, not temporary stale-leg errors |
| `H31_hourly_crossasset_residual` | R2/R4 | V | One asset's hourly token lags a broad, same-sign crypto move after peer residuals are removed | Cross-sectional residual has no out-of-sample relation to resolution PnL |

R1-R6 and H/V/P are used as defined in the principal-research mandate. Here,
R1 is information flow, R2 microstructure/flow, R4 model/measurement, and R5 a
structural payoff identity. Tier H means plausible on the current host, V means
VPS/location-sensitive, and P means professional execution may be required.

## Economics and execution honesty

- Virtual starting bankroll: **$500**.
- Maximum stake: **$10 per single trade or per whole multi-leg bundle**, not
  $10 per leg.
- Capacity: no more than 20% of displayed touch.
- Entry hurdle: at least $0.02/share after **2×** the crypto taker fee curve.
- Fill model: recorded quote must survive the current 1.25-second pipeline;
  displayed depth is walked and partial fills are retained.
- Structural bundles are non-atomic in the simulator. Each leg is independently
  scored, and orphan groups are losses/risks rather than being deleted. Run
  `node scripts/research-v4-report.js` to see complete and orphan groups.
- `UP/DOWN` and `YES/NO` labels are persisted explicitly. Legacy database
  columns named `up_*` and `down_*` are only positive/negative token slots.
- PostgreSQL NUMERIC/DECIMAL values are parsed before arithmetic.

H26 and H27 have payoff identities, but that does **not** make them deployable
arbitrage. Cross-market atomicity is absent, displayed size can vanish, taker
fees apply per leg, and the current Mac-to-venue path may be too slow. Their
economic verdict must use complete-group PnL **and** orphan-leg PnL.

## Implementation map

- `borg/recon/research-universe.js`: pure classification, strike/range parsing,
  and deterministic all-asset daily selection around fresh resolver spot.
- `borg/recon/markets.js`: generic persistence, one-hour/one-minute Binance
  boundary capture, label-aware resolution, and Gamma price polling.
- `borg/recon/collector.js`: generic fair probabilities, snapshots, book
  subscriptions, and multi-market-per-asset evaluation.
- `borg/shadow/engine.js`: market-type routing prevents H1-H21 from silently
  trading a new population; multi-contract actions can carry an explicit leg
  market ID.
- `borg/shadow/score.js`: YES/NO-aware book and token selection.
- `borg/shadow/research-v4.js`: the ten paper-only hypotheses.
- `borg/experiments/research-v4-h22-h31-v1.json`: frozen pilot manifest.
- `borg/experiments/research-daily-structural-universe-v2.json`: wider
  capture-only pilot for H26-H30 and H45-H46; legacy rows are not reused.
- `scripts/research-v4-report.js`: forward-only coverage, PnL, 2×-cost, and
  bundle-leg report.

## Evaluation protocol

1. Confirm at least seven uninterrupted days of healthy generic CLOB capture,
   correct Binance opens/closes, and label-aware resolutions before freezing.
2. Freeze parameters and universe in a new manifest/commit. Discard all current
   `phase='pilot'` rows as evidence.
3. Collect at least **300 independent Polymarket events** and 14 calendar days
   per hypothesis. Multiple contracts or legs from one event are one cluster.
4. Report 1× and 2× costs, quote-survival fill rate, partial fills, orphan bundle
   rate, adverse selection, asset/day concentration, drawdown, and clustered
   confidence intervals.
5. Correct for the entire H1-H31 search family and discarded variants. Ten new
   cards are ten simultaneous tests, not ten independent chances to declare a
   winner.
6. Replay any survivor under measured Mac, 100/250/500 ms, 1/2 s, and measured
   VPS latency profiles. A VPS case requires incremental post-fee PnL, not a
   lower ping screenshot.
7. BUILD only when the lower clustered confidence bound remains positive after
   2× costs and no single asset, event, or day supplies the result. Otherwise
   the correct verdict is KILL or INCONCLUSIVE.

It is entirely possible—and statistically acceptable—that all ten measured
edges are approximately zero after costs. The purpose of these pilots is to
find that out without spending the wallet or manufacturing a backtest.
