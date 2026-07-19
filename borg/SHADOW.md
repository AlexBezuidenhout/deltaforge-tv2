# BORG — Shadow Execution (Phase 3 harness)

**STATUS: PILOT.** The shadow engine went live 2026-07-11 inside the recon
collector. Everything it logs is stamped `phase='pilot'` and is, per
EVAL_PROTOCOL.md §3, **machinery-tuning data — not evidence**. The evaluation
clock starts only when, after recon adjudication (RECON.md), the fair-value
model and strategy parameters are frozen in a tagged commit and `PHASE` in
`shadow/engine.js` is flipped to `'eval'`.

## What it is

Per EVAL_PROTOCOL.md §1: strategies log the exact order they would place —
side, price, size, timestamp, displayed size already at that level
(`queue_ahead`), and the full feature vector — into `borg_shadow_orders`.
No order is ever sent: the process has no keys, no signing code, no
execution path. `borg/shadow/score.js` replays the recorded tape offline:

- **maker fills at back-of-queue** — a shadow quote fills only when tape
  volume through its level exceeds what was displayed there when it was
  "placed" (§4);
- **taker fills** at the logged ask, capped at displayed size;
- **costs**: the current Polymarket crypto taker curve
  (`shares × 0.07 × price × (1-price)`) on taker legs and zero maker fee,
  reported on the 0.5×/1×/2× stress grid; maker rebates are deliberately
  excluded;
- **adverse selection**: Φ-fair 5s/30s after each fill (online `phi_fair`
  convenience series — see the Q2 σ caveat in RECON.md; good enough for
  pilots, the frozen σ estimator replaces it for evaluation);
- **PnL to resolution**, bootstrap 95% CI per strategy.

After scoring, raw rows older than the guarded two-hour DB window are written
to `~/.deltaforge-archive/borg-raw` by `archive.js`. Each gzip NDJSON batch is
atomically written and checksum-verified before its exact rows are pruned from
Postgres; archive failure therefore cannot silently destroy the tape.

## Pilot strategies (parameters in `shadow/strategies.js`, NOT frozen)

The active mechanism-diverse research portfolio is specified in
`HYPOTHESIS_PORTFOLIO.md`: H1 fee-safe pair arbitrage, H2 CEX impulse lag, H3
flow confirmation, H4 BTC-to-alt lead/lag, H5 volatility expansion, H6 Φ
overreaction, H7 BTC oracle-control confirmation and H8 informed one-sided
making. All active pilots are paper/shadow-only and use a $10 maximum intended
notional (2% of the frozen $500 research bankroll). They do
not count toward evaluation until individually frozen and phase-stamped `eval`.

The second provisional portfolio is specified in
`HYPOTHESIS_PORTFOLIO_V2.md`: H9 dual-book microprice, H10 theta lag, H11
liquidity vacuum, H12 Binance/Coinbase consensus, and H13 idiosyncratic
cross-sectional impulse. These are also pilot-only. They use capacity sizing
of $1–$10 capped at 20% of displayed touch; this is an execution/capacity test,
not a profitability claim.

The third forward-only portfolio is specified in
`HYPOTHESIS_PORTFOLIO_V3.md`: H14 robust VolScore, H15 jump-adjusted sigma,
H16 cross-asset VolScore, H17 opening-basis consensus, H18 adaptive BTC beta
lag, H19 CLOB-only jump fade, H20 cross-venue basis reversion, and H21
complement desynchronization. H14-H16 test the transferable measurement ideas
from Barclays' implied-versus-adjusted-realized volatility research; they do
not assume an equity volatility premium carries into five-minute binaries.
All eight use the same $1-$10/20%-of-touch capacity policy and 1.25-second
quote-survival scorer as H9-H13.

The fourth forward-only portfolio is specified in
`HYPOTHESIS_PORTFOLIO_V4.md`: H22-H31 use a bounded set of Binance-resolved
hourly direction contracts and rotating daily threshold/range events. Legacy
H1-H21 are explicitly routed only to five-minute direction markets, so wider
market collection cannot silently change their tested population.

The fifth forward-only portfolio is specified in
`HYPOTHESIS_PORTFOLIO_V5.md`: H32-H46 add fifteen mechanism-diverse pilots,
while H47-H51 are event-driven cross-network resolver/transport-dislocation
tests. Hyperliquid reference capture is an event-driven public `allMids`
stream for all tracked assets; RTDS Chainlink and RTDS Binance are retained as
separate observations. All twenty are pilots and none has a live path.

| Module | Thesis | Sketch |
|---|---|---|
| `A_maker` | A | UP-token bid/ask at Φ-fair ± 2¢, 20 tokens/side, tte 240→60s, re-quote on 1¢ fair moves (≥5s apart), pull quotes at tte<60 |
| `D_consistency` | D | ask_UP + ask_DOWN ≤ 0.99 ⇒ shadow-buy both legs at displayed size (≤$25/leg), 30s cooldown |
| `F_yield` | F | tte 60→20s, Φ-fair ≥ 0.995, favored ask in [0.90, 0.985] ⇒ $10 buy, hold to resolution — registered to be **attacked** by its own calibration |

Theses B (Q3 calibration question), C (pre-registered dead) and E (folds
into A's event analysis) log no shadow orders.

## Halt rule (§7)

Binance stale >10s or active book stale >15s ⇒ strategies pause, maker
quotes are cancelled with `note='halt'`, and the pause is logged in
`borg_events` (`source='shadow'`) so scored windows can be excluded.

## Ops

The engine runs inside the collector (launchd job `com.borg.recon`, code
deployed to `~/.borg-runtime` via `borg/recon/deploy.sh` — edits do nothing
until you deploy). Disable the engine with `BORG_SHADOW=0` in the
environment. Check activity: `node borg/recon/status.js` (shadow section);
score + scoreboard: `node borg/shadow/score.js`.

## Path to evaluation (do not skip)

1. Recon adjudication (RECON.md verdicts) after 24–48h of *clean* data.
2. σ estimator calibrated on recon data, frozen (tagged commit).
3. Strategy parameters frozen; `PHASE` → `'eval'`; pilot rows discarded
   from all results (they remain in the table, labeled).
4. ≥500 scored shadow trades or 14 days, whichever is longer; pass bar per
   EVAL_PROTOCOL §6 (bootstrap CI excluding zero at Bonferroni-adjusted α,
   survives 2× costs, both-halves sign check).
