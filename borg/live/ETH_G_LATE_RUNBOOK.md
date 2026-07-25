# ETH G-late exact-rule canary

`ETH_G_late_exact_forward_v1` is the exact original G late-window rule restricted
to ETH. ETH was selected after inspecting the historical asset table, so the
historical profit is discovery evidence only. The separately named forward
paper arm remains the promotion experiment and is not pooled with live fills.

The live canary is an explicit operator override, not a claim that the discovery
estimate of roughly $22/day will persist. It mirrors only a fresh shadow intent
whose strategy ID, experiment ID, manifest hash, strategy version, ETH market
type, TTE, Phi threshold, edge, ask, websocket book and resolver contract all
match the frozen manifest.

## Execution contract

- venue-minimum shares only, with a hard $5 notional cap;
- exact captured ask as the FAK worst price;
- no price chase, no resting order and no size inflation to the $10 paper stake;
- one live order per market;
- at most five submissions and $25 requested notional per UTC day;
- halt after -$10 resolved PnL in a UTC day;
- at most 50 pilot submissions in total;
- current market metadata and fee curve must be no worse than the frozen model;
- an append-before-send local execution WAL is mandatory;
- Polymarket's official geoblock result must explicitly be `blocked=false`.

The authenticated wallet minimum can exceed the intended $1–$2 pilot notional:
five shares cost $2.75–$4.80 across the frozen 0.55–0.96 ask band. The canary
therefore uses the smallest venue-feasible order instead of pretending a
sub-minimum order can execute.

## Independent live gates

1. `ETH_G_LATE_LIVE_ENABLED=1`
2. `ETH_G_LATE_LIVE_ACK=I_ACCEPT_UNPROVEN_POSTHOC_ETH_G_LATE_LIVE`
3. `bot_settings.live_eth_g_late_enabled=true`
4. `/home/deltaforge/.deltaforge-live/active-account.json` exists with mode 0600
5. Neither the global nor ETH-specific KILL file exists
6. The official geoblock endpoint explicitly allows the execution IP

The committed systemd service is a dry observer by default. `paper_trading`
remains true and no existing MAIN, G, H53 or Flow live-order call site is
changed.

```bash
bash scripts/eth-g-late-canary-control.sh status
bash scripts/eth-g-late-canary-control.sh arm --i-accept-unproven-edge
bash scripts/eth-g-late-canary-control.sh disarm
bash scripts/eth-g-late-canary-control.sh kill
```

The arm command fails closed when the geoblock response is blocked, missing or
malformed. Do not add a relay or proxy to bypass that result.

## Evidence interpretation

Live fills are recorded in `eth_g_late_live_orders`; paper evidence remains in
`borg_shadow_orders`, `borg_shadow_scores` and latency scores. A live fill does
not validate the model. Promotion still requires the frozen fresh-forward
sample, both chronological halves, doubled-cost profitability, clustered lower
bounds and latency robustness. The possible honest result is zero or negative
edge.
