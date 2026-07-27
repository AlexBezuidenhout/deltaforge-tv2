# MAIN promotional-video forensic audit — 27 July 2026

## Verdict

The video does not establish that the purchased MAIN bot achieved the displayed
92.3% win rate or `$5,226.91` net PnL. I found no need to allege composited or
fabricated pixels: the stronger and reproducible finding is that the video
mixes three different things that are not causally linked:

1. a real-looking Polymarket portfolio/activity panel;
2. an internal DeltaForge signal/PnL database;
3. promotional narration attributing the first two to the purchased strategy.

The visible Polymarket activity is not a matched trade ledger. Two of the three
displayed BUY rows at `01:55` bought the side that officially lost, while an
adjacent CLAIM row redeemed the winning side held elsewhere in the wallet. The
video presentation therefore hides complementary inventory and makes losing
buys look like direct winners. Its headline performance is not admissible
evidence for MAIN.

## Reproducible frame check

Video: [This BTC 5-Min Polymarket Bot Finds Profitable Trading Signals](https://youtu.be/zrLkToKcKlo)

At approximately `01:55`, the Polymarket history and dashboard are shown at the
same time. The dashboard reports 130 trades, 120 wins, 10 losses, 92.3% win
rate and `$5,226.91` net PnL. The visible activity rows imply the following:

| Market shown | Adjacent BUY shown | Adjacent CLAIM | Official terminal winner | Can that BUY fund that CLAIM? |
|---|---:|---:|---:|---:|
| 23 Jul, 03:50–03:55 ET | Down, 217.4 shares, `$100.00` | `$215.04` | **Up** | **No** |
| 23 Jul, 02:20–02:25 ET | Up, 181.5 shares, `$83.33` | `$181.38` | **Down** | **No** |
| 23 Jul, 02:15–02:20 ET | Up, 96.9 shares, `$56.69` | `$96.79` | **Up** | Yes |

The official event records are:

- [03:50–03:55 ET](https://gamma-api.polymarket.com/events?slug=btc-updown-5m-1784793000)
- [02:20–02:25 ET](https://gamma-api.polymarket.com/events?slug=btc-updown-5m-1784787600)
- [02:15–02:20 ET](https://gamma-api.polymarket.com/events?slug=btc-updown-5m-1784787300)

Run `node scripts/main-video-forensic-audit.js` to repeat the comparison against
the official Gamma API. It deliberately makes no assumption about wallet
identity: a CLAIM proves that the wallet possessed winning shares, not that the
adjacent BUY row acquired those shares.

At `04:10–05:10`, the video also shows a `$100` UP position moving from roughly
`+$16` to `-$28` and back to `+$12`, while the dashboard repeatedly emits TRADE
signals. A signal row is not an exchange order or fill. The edited sequence
does not provide an order ID, transaction hash, matched fill, fee, or complete
round-trip cash flow.

## Untouched purchased archive

Both downloaded RAR files are byte-identical:

`f6ef11278fb9bb864bc998c45d666ce073587f8916415dfee48edfd59f57e734`

The source was extracted read-only to `/tmp/deltaforge-vendor-original.jqz7IS`
for this audit. Material discrepancies follow.

### Advertised resting orders versus actual execution

The UI says orders rest as GTC limits at `lastTradePrice + 1 tick` and that
paper fills are stochastic. The actual paper branch immediately records a
synthetic fill at an adjusted price; it has no pending-order queue or
non-fill. The actual live branch uses an immediate FAK marketable order, not
the advertised resting GTC mechanism.

### Boot-time settings overwrite the visible settings

The database migration ends with an unconditional
`UPDATE bot_settings ... WHERE true`. It forces values including a `0.80%`
Gate 2 floor, `0.005%` minimum BTC delta and `0.150` minimum confidence on each
boot. The video visibly presents a `2.0%` Gate 2 floor, `0.015%` flat threshold
and `0.050%` Gate 3 threshold. Earlier migrations that set other values are
silently overwritten.

### Claimed EV is structurally manufactured

The heuristic defines:

`pHeuristic = currentMarketPrice ± btcEdge ± microEdge`

It then calls `pHeuristic - currentMarketPrice` model edge. A larger BTC move
therefore creates claimed divergence mechanically, without first establishing
that the market price is wrong. Blending this with the Phi model does not
remove the circular component.

### Costs and fills are not live-equivalent

The signal model hardcodes zero spread, `0.5%` slippage and `0.2%` fees. Paper
resolution charges a fixed 2% fee only to positive profit. Polymarket's crypto
taker fee is price-dependent, and the delivered paper path neither walks the
real book at execution nor models queueing/non-fills as advertised.

### Dashboard fields do not prove persisted computation

The purchased package persists `gate3_score` from `gate3.emaEdge`, while the
current Gate 3 object stores `btcDelta`. This explains the all-zero Gate 3
history and shows that the displayed analytics were not a reliable
reconstruction of the strategy's actual decision state.

## Current MAIN evidence

The current TV2 code already repairs the major correctness and simulation
problems rather than replacing it with the older purchased archive. Legacy
MAIN has 552 closed simulated trades, but the positive history is dominated by
pre-repair optimistic fills. After the honest-simulation anchor, 82 trades
produced a 40.2% win rate and approximately `-$110.02`. That is evidence
against deploying the legacy strategy, not a reason to restore its old fill
model.

## Implemented falsification experiment

Two new frozen, paper-only arms preserve the visible/purchased signal recipe:

- `MAIN_VIDEO_PARITY_V1__taker250`
- `MAIN_VIDEO_PARITY_V1__postonly`

They retain the 60/40 Phi/heuristic blend, five-second decision cadence,
informational Gate 1 at `0.45`, Gate 2 at `2%`, `3-cent` spread cap and
`0.050%` strong-direction threshold. They differ only in execution:

- the taker arm uses the real ask, 250 ms event-tape quote survival, at most
  20% of displayed touch, doubled dynamic taker fees and one tick of stress;
- the post-only arm uses a non-crossing one-tick-improved bid and the existing
  public-print queue/partial-fill model.

Both use a `$500` research bankroll, `$10` target stake, one intent per market,
a 45-second entry guard and terminal resolution instead of interim hard stops.
Neither can access a wallet or a live-order path. The experiment is
**PROVISIONAL** until each arm has at least 300 fresh independent markets and
14 days, with positive doubled-cost PnL in both chronological halves,
market/day-clustered confidence bounds above zero and multiple-testing
correction.

Resetting MAIN means resetting only its paper ledger to `$500`. It does not
reset or alter the real Polymarket wallet.
