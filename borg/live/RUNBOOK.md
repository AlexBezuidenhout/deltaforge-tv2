# G_late_arb — Live Trading Runbook

**Status: INFRASTRUCTURE READY, LIVE DISABLED.** The executor exists but is
structurally inert: five independent gates must all open, and three of them
are deliberate operator actions that Claude cannot and will not perform
(supplying a wallet key, funding it, flipping the env/DB switches).

## What this is

`borg/live/executor.js` is a **mirror executor**: it contains zero strategy
logic. It watches the frozen G_late_arb shadow pilot's order stream
(`borg_shadow_orders`) and replays fresh orders (≤5s old) as real Polymarket
FOK taker orders at the recorded ask +1 tick. Live therefore trades exactly
the strategy the n=300 verdict judged — same signals, same prices — and the
shadow scoring keeps running as the control group to detect live/shadow
divergence (real fills worse than tape-scored fills = execution decay).

## The five gates (all must hold)

| # | Gate | Who opens it | How |
|---|------|--------------|-----|
| 1 | `borg/live/VERDICT_CONFIRMED` stamp | The data | `node scripts/g-verdict.js --stamp` — writes the file ONLY if the frozen n=300 core read prints CONFIRM. Cannot be stamped early. |
| 2 | `LIVE_TRADING_ENABLED=1` env | Operator | Set in the shell/plist that starts the executor. Absent → DRY-RUN. |
| 3 | `POLYMARKET_PRIVATE_KEY` env | Operator | Wallet private key. Never commit it; never put it in `.env` in the repo dir — pass it in the launch environment only. Optional `POLYMARKET_FUNDER_ADDRESS` for proxy wallets. |
| 4 | `bot_settings.live_gla_enabled = true` | Operator | `node scripts/q.js "UPDATE bot_settings SET live_gla_enabled = true WHERE user_id = 1"` |
| 5 | No `borg/live/KILL` file | — | `touch borg/live/KILL` halts the executor within 1s. This is the kill switch. |

## Hardcoded risk rails (changing them requires editing code, on purpose)

- $10 stake per leg (identical to the scored pilot — the 2x marginal-size
  check was NEGATIVE, so never size up without a new pre-registered read)
- Max 30 live orders/day; max $300 notional/day
- FOK only (no resting orders, no inventory risk)
- Signals older than 5s are skipped and logged `SKIPPED_STALE`

## Which wallet? (three options)

**A — Your existing Polymarket account (RECOMMENDED — CONFIGURED 2026-07-13).**
The operator's account is already set up at
`~/.deltaforge-live/polymarket-account.json` (chmod 600) and the executor
auto-loads it — no env vars needed:
- signer `0x788fF5bD03f6c06543f5217bfa5A6914fbF23a35` (derived+verified from
  the exported key; never send funds to it)
- funder/proxy `0x1aD383070ed81e7D3A32E4e6f85e25C5e8dDf90C` — **this is where
  funds live; deposit via the Polymarket UI as normal**
- signature type `POLY_1271` (email deposit-flow account)
- verified: profile API maps signer→proxy; `deriveApiKey` OK;
  `PolymarketFeed.initialize()` OK (full authenticated CLOB client)
The executor places orders through the repo's own `PolymarketFeed.placeOrder`
(v2 SDK, tick snapping, 5-token min, POLY_1271 failover, geo-relay support).
Keep only a modest balance in the account while a bot has key access — the
exported key cannot be rotated, so the account IS the key.
For a different account: same file format, or env
`POLYMARKET_PRIVATE_KEY` / `POLYMARKET_SIGNATURE_TYPE` (EOA | POLY_1271 |
POLY_PROXY | GNOSIS_SAFE) / `POLYMARKET_FUNDER_ADDRESS`.

**B — Fresh dedicated wallet (cleanest isolation).**
`node borg/live/make-wallet.js` — generates a Polygon EOA, stores the key at
`~/.deltaforge-live/wallet.json` (chmod 600, outside the repo, never printed),
prints only the address. The executor auto-loads that file, so no key ever
appears in shell history; signature type 0 is automatic. Fund it with USDC.e
**on Polygon** plus ~2 POL for gas, then set allowances by logging into
polymarket.com once with that wallet and making any tiny deposit/trade —
or just deposit from it into a Polymarket account and use option A.
Back the file up in a password manager.

**C — Revolut: NOT usable as the trading wallet** — Revolut is custodial and
never exposes private keys, so it cannot sign orders. Use it only to LOAD
funds: buy USDC in Revolut → withdraw → pick **Polygon** as the network →
paste your option-A deposit address or option-B wallet address. If Revolut
doesn't offer the Polygon network for USDC, do not send on another network —
send to a Polymarket deposit address type that matches, or use an exchange
that supports Polygon withdrawals. **Always send a small test amount ($5)
first.**

## Operator setup for real money (in order)

1. Wait for `node scripts/g-verdict.js` to print **CONFIRM** (fires at 300
   core fills; ~267 as of 2026-07-13). If it prints CONTINUE or KILL, stop —
   do not proceed, the infrastructure stays parked.
2. `node scripts/g-verdict.js --stamp`
3. Pick a wallet from the section above and fund it. **Only what you can
   lose — suggest $100–200 to start.**
4. Dry-run first (no env keys set):
   `LIVE_TRADING_ENABLED= node borg/live/executor.js` — watch it log
   `DRY-RUN would place: …` against real signals for a few windows; check
   rows in `gla_live_orders`. (Note: if the key file exists the executor
   loads it, but stays DRY-RUN unless LIVE_TRADING_ENABLED=1.)
5. Go live: `LIVE_TRADING_ENABLED=1 node borg/live/executor.js` with the
   wallet env from option A, or nothing extra for option B (key file
   auto-loads) — plus the DB switch from gate 4.
6. Watch the first day closely:
   `node scripts/q.js "SELECT status, count(*), sum(price*size) FROM gla_live_orders WHERE NOT dry_run GROUP BY 1"`
   and compare live fill P&L against the shadow control for the same windows.

## Kill / rollback

- Instant: `touch ~/.deltaforge-live/KILL` (stable path, survives deploys; mirror-local borg/live/KILL also works) — or `launchctl bootout gui/501/com.gla.live`
- Durable: `UPDATE bot_settings SET live_gla_enabled = false WHERE user_id=1`
- The main server and the shadow pilot are completely unaffected either way.

## Audit trail

Every mirrored decision (placed, dry-run, stale-skip, error) is a row in
`gla_live_orders` with the source `shadow_order_id`, so live behavior is
always reconcilable 1:1 against the audited shadow stream.
