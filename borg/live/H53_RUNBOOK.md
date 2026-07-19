# H53 accidental 5-minute favorite — live override

`H53_5m_neareven_favorite_live_v1` is the exact H52 v1 rule that accidentally
ran on true five-minute markets, now isolated behind an explicit market-type
guard and a separate live executor. It is **unproven** and was taken live by
operator instruction before the registered 300-window/14-day evidence read.

The live mirror never changes the signal: BTC/ETH/SOL/XRP, final 60–300s,
favorite ask 0.50–0.60, frozen fair 0.675, 2x fee hurdle +1 cent, once per
market, and `min($10/ask, 20% of displayed touch)` sizing. It submits a
price-protected FAK at the exact decision ask and never chases or inflates size.
Signals below the venue's five-share minimum are recorded as
`SKIPPED_VENUE_MINIMUM`.

Immediately before sending, the executor verifies the condition/token mapping,
current market tick, minimum size and fee curve. Independent asset orders in a
window may submit concurrently, with an in-memory collateral reservation across
the batch. The CLOB response's `makingAmount` and `takingAmount` are the fill
receipt; the signed worst price is never used as an average fill. Any actual
overspend or average price above the signed cap halts further H53 submissions
in-process and is exposed in the heartbeat as `executionHaltReason`.
Order intents are fdatasync'd to the local `h53-live-execution` WAL before
submission; acknowledgements are appended before PostgreSQL is updated, so a
transient ledger failure cannot erase the venue receipt.

Independent live gates:

1. `H53_LIVE_ENABLED=1`
2. `H53_LIVE_ACK=I_ACCEPT_UNPROVEN_H53_5M_LIVE`
3. `bot_settings.live_h53_enabled=true`
4. `~/.deltaforge-live/active-account.json` exists with mode `0600`
5. Neither `~/.deltaforge-live/KILL` nor `~/.deltaforge-live/H53_KILL` exists

Emergency stop:

```bash
touch ~/.deltaforge-live/H53_KILL
sudo systemctl restart h53-live.service
```

Durable disable:

```sql
UPDATE bot_settings SET live_h53_enabled=false WHERE user_id=1;
```

Audit ledger: `h53_live_orders`. Runtime heartbeat: `system_heartbeats` row
`h53_live`. H52 v1 rows remain discovery-only and are never pooled into H53.
