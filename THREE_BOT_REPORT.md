# Three-Bot Candidate Portfolio — Evidence and Promotion Report

Report frozen: 2026-07-14 13:48 UTC. Starting capital assumption: **$150 USDC**.

## Executive conclusion

There is evidence that MAIN's heuristic contains directional information and a
small, post-hoc sample suggesting that ETH late-window continuation may be
profitable. There is **not** yet evidence strong enough to call any of the three
candidates ready for real money. MAIN's attractive recent paper P&L is materially
contaminated by non-executable synthetic entry quotes; its claimed EV does not
rank realized returns. The ETH result is only 17 actual fills after applying the
45-second safety guard, and its confidence interval includes zero. The correct
status is therefore **engineering-ready for fresh paper validation, live-locked**.
An honest outcome after the next 500 fills per arm may still be that the
exploitable edge is approximately zero.

## What happened to the apparently profitable MAIN bot?

The probability model is not worthless. On one observation per resolved market:

| Estimator | n | Brier | Log-loss | Reference |
|---|---:|---:|---:|---:|
| Φ alone | 2,231 | 0.2706 | 1.3422 | base-rate Brier 0.2495 |
| Heuristic alone | 2,231 | 0.2171 | 0.6254 | base-rate Brier 0.2495 |
| Ensemble | 2,107 | **0.2137** | **0.6180** | base-rate Brier 0.2497 |
| Executed-trade probabilities | 408 | 0.2311 | 0.6541 | selected-cohort base-rate Brier **0.2214** |

The broad signal discriminates direction; Φ is actively harmful and remains at
zero ensemble weight. But the executed subset is not calibrated better than its
own base rate, and claimed `EV_adj` has only **0.027 Pearson correlation** with
realized ROI (OLS slope 0.266 instead of approximately 1). Edge magnitude cannot
currently justify Kelly differentiation.

The paper P&L is a separate problem. Since 2026-07-12, the legacy paper cohort
shows 317 closes, 62.1% wins and +$727.39. Matching recent entries to the recorded
CLOB found an average **10.1-cent absolute gap** between paper entry and actual
ask. The cause was a synthetic WS/Gamma `mid ± 1¢` object being exposed as the
execution book. Examples included paper paying 0.52 while the actual ask was
0.96. Only three matched historical entries survive the corrected ask/fee rule;
three observations support no dollar projection.

MAIN stays in the suite because the signal-level result is real enough to test.
Its new cohort starts only after the executable-book migration anchor is created
on restart; no legacy P&L counts toward promotion.

## The three frozen candidates

### 1. MAIN · EXEC-HONEST

**Mechanism thesis:** centralized-exchange momentum and microstructure can reach
the Polymarket book with a short delay. The heuristic has out-of-sample directional
discrimination at signal level, but must prove that the advantage survives the
spread, depth and taker fee.

**Execution changes:**

- the venue's side-specific CLOB ask is the execution source; a model/Gamma quote
  is never treated as a book;
- Gate 2 is recomputed at the executable ask and again after paper depth walk plus
  one latency tick;
- the current crypto taker curve is charged in EV and P&L;
- raw probability is shrunk toward 0.5 before Kelly, then stake is capped at $3;
- no new MAIN entry with less than the configured 60 seconds remaining;
- maximum entry price remains 0.65; Gate 1 remains informational.

**Main risk:** a globally predictive probability can still be untradeable once
the ask and fees are paid. This is precisely what the fresh cohort measures.

### 2. ETH_late_taker

**Mechanism thesis:** when ETH is already far from the five-minute reference and
Φ certainty is at least 0.88, the final 45–75 seconds can retain continuation
value that has not fully reached the executable ask. The taker arm buys immediacy
and therefore requires at least five cents of model-vs-ask edge.

Frozen policy: ETH only; 45–75 seconds remaining; `phiCert >= 0.88`; ask 0.55–0.85;
edge at ask at least 0.05; actual displayed ask/depth; $3 maximum stake; one entry
per market. The 45-second floor is a binary-jump safety argument, not a threshold
fit to this sample.

**Main risk:** the model is Binance-based while settlement is oracle-based, and
the taker fee plus adverse selection can consume the apparent continuation edge.

### 3. ETH_late_maker

**Mechanism thesis:** test whether the same ETH information can be monetized by
avoiding the taker fee and capturing one tick rather than paying the ask. It joins
the best bid post-only, records displayed queue ahead, and counts a fill only when
subsequent tape volume trades through that queue.

It uses the same frozen signal and $3 cap as the taker arm. A stable hash assigns
each ETH market to exactly one arm, preventing duplicate exposure and making the
forward comparison honest. Quotes cancel if certainty disappears or the side
flips. Maker rebates are assigned zero.

**Main risk:** historical maker-role fills are not an exact backtest of this new
join-the-bid implementation. Non-fills and adverse selection are likely. This arm
has to earn its evidence entirely in the forward cohort.

## Historical execution replay at $3

These are actual CLOB fills from the existing G evaluation cohort, normalized to
a $3 cost basis and charged the current taker curve. They are context for the
new ETH hypothesis, not training data for parameter changes.

| Candidate-compatible sample | n | Wins | P&L at $3 | Mean/fill | Bootstrap 95% mean CI | Max DD |
|---|---:|---:|---:|---:|---:|---:|
| ETH taker role, TTE ≥45s | 13 | 11 | +$2.68 | +$0.206 | **[-$0.671, +$0.883]** | -$3.04 |
| ETH maker role, TTE ≥45s | 4 | 4 | +$2.43 | +$0.607 | [$0.360, $0.826] | $0.00 |
| Combined | 17 | 15 | +$5.11 | +$0.300 | **[-$0.379, +$0.821]** | -$3.04 |

The six-asset multiple-testing-adjusted 99.17% interval is **[-$0.636, +$0.917]
per fill**. The unguarded inherited ETH sample was 28 fills, 26 wins and +$14.32,
but it includes entries inside 45 seconds and is not the candidate policy. The
maker row's apparently positive interval is not decision-grade: n=4 is tiny and
the new order-placement rule differs.

### Why ETH, and why this is still post-hoc

At the cutoff the frozen all-asset `G_late_arb` shadow evaluation was effectively
flat/negative: **246 fills, -$6.06** under its stored 1× cost model. Its asset
attribution was BNB -$1.18 (n=32), BTC -$18.41 (n=104), ETH **+$44.11**
(n=49), HYPE -$5.89 (n=55), SOL -$9.92 (n=2), and XRP -$14.76 (n=4).
ETH is the only substantial positive cell, and the actual-wallet ETH replay also
points the same way. That is a sensible hypothesis generator, but selecting the
winner after looking at six assets is exactly why none of those 49 shadow fills
count toward the two new strategy names. The forward hash split starts from zero.

## Projection scenarios

These are arithmetic scenarios per 100 fresh ETH fills, **not forecasts**:

| Scenario | P&L after 100 fills | Ending equity from $150 |
|---|---:|---:|
| True edge is zero | $0.00 | $150.00 |
| 50% of observed guarded expectancy persists | +$15.02 | $165.02 |
| Guarded historical expectancy repeats | +$30.05 | $180.05 |

MAIN has no defensible dollar projection yet. The historical replay that survives
its corrected execution rule has n=3.

## Shared $150 risk envelope

This is one paper-validation portfolio, not three separate bankrolls:

- $3 maximum stake per position (2% of starting capital);
- three concurrent positions and $9 gross exposure maximum;
- $9 rolling 24-hour realized-plus-unrealized loss halt;
- $15 hard portfolio drawdown breaker;
- $120 minimum reserve target;
- one seat per market and deterministic ETH maker/taker assignment.

`paper_trading` remains true by default. The new portfolio rails are deliberately
enabled only in paper mode; no live-order call site was changed and neither ETH
arm has been connected to a live executor. A separate reviewed shared-wallet
rail is therefore also a mandatory promotion task, not an assumption.

At the report cutoff, the existing `G_late_arb` real-money executor was enabled
and heartbeating. It is **not** one of these three candidates and still operates
under its existing independent live rails. It can consume the same wallet, so no
candidate should be promoted while that conflict is unresolved. This audit did
not disable or modify that live executor.

## Promotion protocol — next 500+ fresh fills per candidate

Promotion requires all of the following, after at least 14 calendar days:

1. At least 500 fresh, correctly versioned/scored fills for that candidate.
2. Positive mean P&L after the current fee model and at a 2× fee/slippage stress.
3. Bootstrap 95% expectancy interval above zero; also report the six-hypothesis
   adjusted interval, without hiding it if it crosses zero.
4. MAIN: model Brier below contemporaneous executable-price baseline and positive
   monotonic relationship between claimed EV and realized return.
5. Taker: no high-divergence or last-seconds loss cluster; acceptable depth and
   non-fill/slippage distribution.
6. Maker: back-of-queue fill rate, P&L conditional on fill, and 5s/30s adverse
   selection all positive after assigning zero rebate.
7. Portfolio max drawdown remains within the $15 envelope under 2× costs.

Failure is an expected research result. If the intervals include zero or costs
erase expectancy, the bot stays paper-only or is retired; thresholds are not
retuned on the same cohort.

## Reproduction

```bash
node scripts/calibration.js
node scripts/ev-autopsy.js
node scripts/portfolio-backtest.js
node --test test/*.test.js
```

Fee and execution assumptions follow Polymarket's current documentation:
[fees](https://docs.polymarket.com/trading/fees),
[order types](https://docs.polymarket.com/trading/orders/create), and
[prices/orderbook](https://docs.polymarket.com/concepts/prices-orderbook).
