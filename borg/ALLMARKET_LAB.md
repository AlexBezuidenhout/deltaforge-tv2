# All-Market Book Lab

## Scope and safety boundary

`borg/allmarket/collector.js` is a dedicated public-data research process. It
is paper/shadow only and deliberately has no wallet, signer, authenticated user
channel, CLOB order client, or order-posting method. It does not modify MAIN,
George, BORG scoring, DF2, or any `createAndPostOrder` call site.

The current service can therefore validate signal and execution hypotheses,
but it cannot validate authenticated order acknowledgements or real queue
position. Adding a user-channel observer later must remain read-only until a
separate reviewed live-execution project is explicitly authorized.

## Architecture

1. The entire current CLOB rewards directory and every paginated active Gamma
   binary market are scanned every five minutes.
2. A deterministic, category-balanced panel is selected by expected reward per
   qualifying share, required capital, volume, and observed 5-second toxicity.
   Selection does not use positive PnL.
3. Two public CLOB WebSockets keep full books in memory. Raw frames are written
   to the local append-before-parse WAL.
4. Book changes synchronously update fair value, quote state, queue position,
   inventory and paper intents. PostgreSQL is not awaited in this path.
5. Decisions and execution scores are written to a second local WAL and then
   persisted to local PostgreSQL in asynchronous batches.
6. The dashboard reads the local database through the Book Lab tab. The VPS
   hot tier is mirrored and compacted by the existing archive pipeline.

The realtime process does not poll REST books. Socket silence forces a clean
reconnect and fresh snapshot; REST is reserved for offline universe metadata.

The internal reaction target is 20–50 ms. The dashboard reports the rolling
p95 of A/B-grade incremental events; initial full-book bootstrap frames and
stale events are retained but do not masquerade as steady-state reaction time.
Optimization stops there until a forward strategy demonstrates that lower
latency changes post-fee PnL.

## Frozen forward arms

- `AM_passive_maker_v1`: post-only bid simulation across selected markets.
- `AM_reward_passive_maker_v1`: the same mechanics where the quote also meets
  the published minimum-size and maximum-spread reward constraints.
- `AM_L2_predictor_control_v1`: diagnostic imbalance/microprice triggers at
  20/50/100/250/500 ms. This intentionally records whether raw L2 movement
  survives full-depth entry, one pessimistic tick, exit depth and exact fees.
- `AM_L2_cost_confirmed_taker_v1`: executes in paper only when the forecast
  exceeds executable spread, two fee legs and one tick. Zero executions are a
  valid result; a microprice displacement that cannot pay the spread is not
  alpha.

The predictor defaults are mechanism-based and **PROVISIONAL**, not fitted to
historical PnL: absolute top-level imbalance 0.60, microprice displacement 0.25
tick, and maximum spread four ticks.

## Execution fidelity

Passive quotes join or improve the bid without crossing. The queue model puts
the displayed size plus one minimum qualifying order ahead of the simulated
quote. Cancellations never advance queue position; only completed public prints
at or through the bid do. Partial fills are retained. A quote is canceled or
replaced when its price changes, its data becomes invalid, its 30-second GTD
expires, or its frozen $500 capacity allocation is consumed.

Taker controls walk every displayed ask level and reject insufficient depth.
The fill is then worsened by one tick. Every 1/5/30-second exit walks displayed
bid depth for the full filled size; unsupported exits are missing, not filled at
midpoint. Per-market Gamma fee rate and exponent are applied to taker entry and
exit legs; a fee-enabled market missing that metadata receives a conservative
0.07 fallback, never a zero-fee assumption. Reward and maker-rebate dollars are deliberately `NULL`: published
pool size is not the bot's competitive allocation and must not be manufactured
as profit.

The authenticated user channel, real exchange queue IDs, partial-fill events,
cancel acknowledgement and order acknowledgement cannot be observed by this
paper process. Those are explicit remaining fidelity gaps.

## Structural scanner

`borg/structural/scanner.js` now searches broad active-event panels plus an
explicit Sports-tag panel. It builds binary-complement, nested-threshold,
disjoint-range, ordered sports-total, ordered sports-spread and explicitly
complete negative-risk payoff identities. Sports relations fail closed unless
the event, participant/statistic, period and normalized resolution-rule
fingerprint agree. Generic two-outcome conditions no longer have to be named
YES/NO to qualify as a within-condition complement; a complete multi-market
negative-risk set still requires literal YES/NO predicates.

The scanner persists the full bounded, deterministically proved catalog for
research while subscribing only to a family-balanced realtime panel. This
separates opportunity-rate measurement from the socket budget: an unselected
candidate remains visible in the catalog but does not acquire fabricated book
economics. Active candidates are re-evaluated at the same
20/50/100/250/500 ms latency profiles.

Each bundle separately checks stale legs, published asks, per-leg fee schedules,
2× fee stress, full displayed FOK capacity and orphan-leg stress. Polymarket
legs are not atomic, so `qualified` remains false even where an economic
residual is displayed. Such rows are leads for execution research, not locked
arbitrage or realized PnL.

## Configuration

- `ALLMARKET_MAX_MARKETS` (default `10`)
- `ALLMARKET_GAMMA_PAGES` (default `20` for both direct-market and active-event pages; Gamma currently caps each page at 100 and rejects offsets above 2,000)
- `ALLMARKET_GAMMA_WINDOWS` (default `10`; advances the active-event scan by end-date cursor when a 2,000-event window is full)
- `ALLMARKET_PERSIST_MARKETS` (default `5000`; every discovered row is ranked in memory, while only the deterministic research leaders and selected panel enter the hot SQL tier)
- `ALLMARKET_CLOB_SHARDS` (default `2`)
- `ALLMARKET_LATENCY_PROFILES_MS` (default `20,50,100,250,500`)
- `ALLMARKET_MAX_CAPITAL_PER_MARKET` (default `$50`)
- `ALLMARKET_CATALYST_GUARD_HOURS` (default `6`)
- `ALLMARKET_NO_FAIR_FEED_GUARD_HOURS` (default `24` for sports, politics, finance and weather)
- `ALLMARKET_FAIR_FEED_CATEGORIES` (empty by default; no category is falsely claimed to have a fair-value feed)
- `ALLMARKET_STALE_MS` (default `750`)
- `ALLMARKET_MAKER_QUOTE_LIFETIME_MS` (default `30000`)
- `STRUCTURAL_EVENT_PAGES` (default `20` 100-row pages each by near end date and all-horizon volume, matching Gamma's offset ceiling)
- `STRUCTURAL_SPORTS_EVENT_PAGES` (default `5` 100-row Sports-tag pages each by near end date and volume)
- `STRUCTURAL_CATALOG_CAP` (default `20000` deterministically proved candidates retained in the hot catalog)
- `STRUCTURAL_MAX_CANDIDATES` (default `24` family-balanced realtime candidates)
- `STRUCTURAL_MAX_TOKENS` (default `96` realtime token subscription cap)
- `STRUCTURAL_LATENCY_PROFILES_MS` (default `20,50,100,250,500`)

The catalyst guard is currently end-time based because no category-specific
fair-value feed exists. Catalyst-prone categories therefore use a 24-hour
guard, but this is still not a complete news calendar; market/category toxicity
and adverse selection must remain visible in the report.

## Evaluation over the next 300+ markets

Do not tune this cohort. The frozen sports/structural pilot requires at least
300 independent events and 14 calendar days before a later unchanged
evaluation identity can be judged. The broader passive-maker lab retains its
more conservative 30-day horizon. Cluster uncertainty by condition/event and
UTC day, correct for the complete family of tested arms, and require:

- positive fee-adjusted 5-second markout in both chronological halves;
- a market-clustered lower confidence bound above zero;
- survival under 2× cost stress and worse latency;
- no single condition, category or day supplying most profit;
- stable queue-fill and adverse-selection behavior at 1/5/30 seconds;
- enough displayed capacity to matter for a $500 account.

The correct conclusion may be that the apparent edge is approximately zero.
No arm in this lab is ready for live capital merely because its early dashboard
PnL is positive.
