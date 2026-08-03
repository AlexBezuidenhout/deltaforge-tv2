# Flow Lab: public taker-sweep scalp experiment

## Honest interpretation of the video

The video describes seeing an unlimited market order, buying ahead of it, and
selling to that same buyer. That mechanism is not available from Polymarket's
public interfaces. Polymarket orders are signed limit orders (a "market order"
is an immediately executable limit order), matched off-chain by the operator,
and settled on-chain later. The public market channel publishes books, price
changes and completed trade prices; it does not broadcast another user's order
submission before matching. Watching the later settlement transaction therefore
cannot insert this bot into an already matched trade.

The video also supplies no reproducible code, order acknowledgements, wallet
ledger, fee accounting, or independently verifiable 87% win-rate sample. Its
`$468 in 4.5 minutes` claim is not treated as evidence or as a performance target.

Relevant venue contracts:

- <https://docs.polymarket.com/concepts/order-lifecycle>
- <https://docs.polymarket.com/market-data/websocket/market-channel>
- <https://docs.polymarket.com/trading/orderbook>
- <https://docs.polymarket.com/trading/fees>

## Testable mechanism

Flow Lab begins only after a completed `last_trade_price` event is publicly
observable. It defines a displayed-touch sweep mechanically: reported aggressor
notional is at least the frozen $10 research stake, its price touches or crosses
the pre-event opposing best level, and its reported size is at least the displayed
size at that level.

It then creates two paper arms:

- `continuation`: BUY sweep buys the same token; SELL sweep buys its complement.
- `fade_control`: BUY sweep buys the complement; SELL sweep buys the same token.

Both arms use identical execution assumptions. A decision-time ask becomes a
limit; a fill occurs only if the recorded arrival-time ask survives. Intended
size is the lesser of $10/price and 20% of displayed ask size. A markout is valid
only when the recorded top bid can exit the full paper position. Both entry and
exit pay the token's current coefficient from the CLOB `/fee-rate` endpoint using
`shares × fee_rate × price × (1-price)`.

### V1 result, V2 omission and V3 forward challenger

The first live Dublin read rejected blind post-print entry. At review, V1 had
2,183 independent sweeps and every continuation/fade latency cell had negative
five-second net markout. Fade was materially worse. This is not a collector
failure: buying after a completed public print crosses the spread after the
information has become public, then crosses it again to exit.

V1 rows are retained as a negative control but new V1 signals are disabled by
default (`FLOW_V1_CONTROL_ENABLED=true` can re-enable them). They never count as
V2 evidence. The frozen V2 challenger schedules a
new decision at 100, 250 and 500 ms and fills only when the causal arrival book
shows all of the following:

- the target executable bid improved by at least one token tick;
- displayed bid size is at least displayed ask size; and
- the public sweep's per-share displacement covers the contemporaneous spread
  plus exact entry and exit taker fees.

The arrival ask and capacity determine size at that timestamp; the challenger does not
pretend the decision-time quote survived. Both continuation and absorption-
reversal arms start with zero evidence.

The venue audit then found that V2 modeled only a $1 notional floor while active
CLOB metadata published `minimum_order_size=5` shares. V2 remains immutable.
`public-flow-cost-confirmed-v3` resets the evidence clock and persists/enforces
the published minimum at confirmation and delayed arrival. This is a venue-rule
correction, not a threshold selected from PnL. Its immutable registration is
`borg/flow/experiments/public-flow-cost-confirmed-v3.json`.

Only A/B-grade fills enter headline PnL and win-rate calculations. F-grade
rows remain available in the recent-signal ledger for diagnosis but contribute
neither a fill nor PnL to the research result.

The retired V1 control used latency profiles of 25, 100, 250, 500, 1,000 and
2,000 ms. V3 keeps the forward matrix at 100, 250 and 500 ms;
these are information-to-decision profiles, not promises of venue execution.
Exit markouts remain fixed at 1, 2, 5 and 10 seconds; no take-profit or stop-loss was fit
to historical trades.

## Collection scope

The service has two capture planes:

1. A two-second, non-overlapping Data API sampler reads one offset-zero snapshot
   of the latest completed public trades, then advances a cursor in API source
   time. Offset pagination is not used for live coverage because concurrent
   inserts shift later pages. When the ordinary snapshot cannot reach the prior
   cursor, the sampler requests two concurrent documented offset pages with a
   1,000-row overlap. Their common page size rotates deterministically from
   9,900 to 9,999 once per five-minute cache bucket. Polymarket caches each exact
   Data API URL for 300 seconds and may briefly serve an older generation, so the
   rotation makes both rescue URLs origin-fresh together.
   The collector accepts the joined rescue only when at least 100 immutable trade
   identities overlap and the tail reaches the prior source cursor. Cache skew,
   offset drift, or insufficient depth increments `globalCoverageGaps`; those rows
   remain D-grade and invalidate the evidence epoch. It stores newly observed rows
   in the raw WAL and `pm_flow_trades`. The API still exposes no global time cursor,
   so this plane remains a bounded discovery sample rather than a guaranteed
   complete all-market tape.
2. Two market-channel sockets capture full raw frames plus compact event-time
   touches for the four most actively traded binary markets in the final 90
   seconds of the bounded API sample, anchored to that sample's newest source
   timestamp and reselected every minute. This source-relative anchor matters
   because the global Data API can trail wall time by minutes; its measured lag
   is logged and it never supplies causal execution timestamps. The CLOB market endpoint verifies that
   each market is still active, accepting orders and has exactly two tokens.
   The four-market cap avoids duplicating BORG's heavy socket load across an
   unbounded token universe. Only this bounded
   real-time panel can create scalp signals. Subscribing every token at full-book
   frequency would overload the public socket/data path and would not reveal
   pending orders anyway.

Every market-channel frame is appended to the durable WAL before parsing. The
global REST adapter preserves exact newly observed trade objects in WAL batches;
it intentionally does not archive the repeatedly overlapping HTTP page, which
would duplicate the same completed trades on every poll. Every scheduled task
has a re-entrancy guard, so a slow API or PostgreSQL response cannot create a
request stampede. Queryable
rolling tables are `pm_flow_markets`, `pm_flow_trades`, `pm_flow_touches`,
`pm_flow_connection_events`, `pm_flow_signals`, and `pm_flow_scores`.

For the provisional late-boundary evaluation, every 500 ms absorption score now
persists the causal arrival book at an additional 50, 100, 250 and 500 ms in
`pm_flow_scores.markouts.order_latency`. Each state records book age, displayed
ask capacity, fee, fill/rejection reason, authoritative crypto-window boundary,
and whether a relevant socket gap occurred before arrival. An arrival at or
after the boundary is never credited. This instrumentation began at
`2026-07-18T13:36:24.615Z` under
V2. The venue-minimum correction resets forward evidence at
`2026-07-18T16:43:31.757Z` under `flow-late-absorption-boundary-v3`; all V1/V2
rows remain discovery/history.

V3 also creates `pm_flow_boundary_intents` in real time rather than discovering
an eligible signal 12 seconds later during scoring. Source and arrival states
are appended to a dedicated WAL before asynchronous database persistence. The
separate canary consumes PostgreSQL `LISTEN/NOTIFY`; it is a dry observer unless
wallet, environment, database and KILL gates all pass. See
`borg/live/FLOW_BOUNDARY_RUNBOOK.md`.

## Safety and interface decision

The collector remains paper-only by construction: it imports no wallet, signer, private
channel or order client, and has no live-order method. It lives in TV2's Flow Lab
because TV2 is the research/evidence platform. DF2 remains a directional bot;
making DF2 the catch-all for non-crypto markets would mix execution ledgers and
weaken auditability. Flow Lab is a separate process and schema so scalp markouts
cannot contaminate BORG's terminal-resolution P&L. Any separately armed canary
order is capped, ledgered outside paper scores and never counts as forward
evidence.

## Evaluation

Pilot rows validate machinery and are not evidence. Do not sum arms or latency
profiles: each reuses the same trigger, capital and liquidity. The prospective
primary read is net five-second P&L per independent sweep, clustered by trigger
transaction and UTC day.

Before considering a frozen evaluation cohort, collect at least 300 independent
sweeps per V2 arm/latency and 30 calendar days. Continuation must beat the
reversal control and retain a
positive clustered lower confidence bound after exact round-trip fees at measured
latency. Multiple-testing correction must include both arms, three latency profiles,
four horizons and all other BORG hypotheses. A null or negative result means the
video's proposed edge is absent in the measured public data; parameters must not
be tuned on the same pilot cohort to manufacture a win.

Run locally with:

```sh
npm run flow:collect
```

On the VPS the supervised unit is `polymarket-flow.service`.
