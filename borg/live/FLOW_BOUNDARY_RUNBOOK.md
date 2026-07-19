# Final-10s Flow boundary canary

## Evidence status

This is an execution canary for an **unproven, post-selected** hypothesis. The
old discovery row (+$31.95 over roughly 39 hours) is not a bankable run rate.
`flow-late-absorption-boundary-v3` starts a fresh forward cohort after fixing a
venue-feasibility omission: every paper and canary order must meet the CLOB
market's published `minimum_order_size` as well as the $1 notional floor.

The frozen promotion requirement remains at least 300 independent markets and
30 calendar days, positive doubled-cost PnL in both chronological halves,
market/day clustered lower confidence bounds above zero and multiple-testing
correction. Live canary rows never enter that paper cohort.

## Execution contract

- Completed public CLOB sweep only; no pending-order or mempool claim.
- `absorption_reversal_v2`, 500 ms information delay.
- Strict `0 < TTE <= 10s` using the authoritative `borg_markets.window_end`.
- First qualifying source signal per condition only.
- 250 ms registered order transit.
- Last causal book at or before arrival; connection gaps and stale books fail.
- At most $10 and 20% of displayed arrival ask depth, with the venue minimum.
- Price-protected FAK BUY. Polymarket documents FAK as immediate partial fill
  with remainder cancelled, and the market-order `price` as the worst-price
  slippage guard: https://docs.polymarket.com/trading/orders/create
- Hold any fill to official terminal resolution.

## Default and hard rails

The installed service is a dry observer. It cannot submit unless environment,
database, wallet and KILL gates all independently pass. Live rails are
hardcoded at $10/order, three submissions/$30 gross spend per UTC day, and one
market seat. MAIN/George `paper_trading=true` defaults are untouched.

```bash
# Inspect dry/live state and the canary ledger
bash scripts/flow-boundary-canary-control.sh status

# One-time secure wallet installation; does not arm trading
bash scripts/flow-boundary-canary-control.sh install-key

# Explicit real-money activation
bash scripts/flow-boundary-canary-control.sh arm --i-accept-unproven-edge

# Return immediately to dry observer mode
bash scripts/flow-boundary-canary-control.sh disarm

# Emergency strategy kill (independent of the DB/env switches)
bash scripts/flow-boundary-canary-control.sh kill
```

Before arming, watch at least several `DRY_RUN_READY` intents and confirm their
notification-to-ledger delay is below 750 ms. Because final-ten-second signals
are rare, zero orders for hours is expected and is not itself a stuck bot.
