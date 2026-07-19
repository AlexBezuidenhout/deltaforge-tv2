# BORG H9–H13 Research Portfolio

Created: 2026-07-15. Status: **PROVISIONAL PILOT / NOT PROFITABILITY EVIDENCE**.

These are five new shadow experiments, not five bots ready for real capital.
They have no wallet, signer, order client, or live execution path. A strategy
can be “world-class” only in the quality of its causal hypothesis, execution
model, and falsification standard; profitability is unknown until a fresh
forward cohort clears the registered bar.

## Evidence used before launch

The final pre-launch developmental replay used 247,616 unique one-second book
snapshots across 833 resolved five-minute markets from 2026-07-14 15:04 UTC
through 2026-07-15 00:59 UTC. It combined the checksum-verified local archive with the current
Postgres rolling window. A taker fill was granted only if depth at or below
the original limit still existed 1.25 seconds later. PnL includes Polymarket's
crypto fee curve `shares × 0.07 × p × (1-p)` and a 2× fee stress.

This replay is **in-sample machinery development**, because the ideas were
inspected against the same data family. It can kill impossible mechanics, but
it cannot confirm edge. Run it with:

```bash
npm run research:v2
```

The first breadth-propagation design was rejected before deployment: 15
latency-surviving fills lost $26.82 and its second half deteriorated. H13 was
replaced, under a new name and thesis, by the idiosyncratic-residual test below;
the rejected rows can never be pooled with H13.

## Shared execution and sizing

- Shadow only; no live path exists.
- Takers use `execution_model=latency_1s`: wait 1.25 seconds, then walk only
  recorded surviving depth at or below the submitted limit.
- Intended notional is capacity-sized: at most **$10**, no
  more than **20% of displayed touch**, and no dust order below $1. This tests
  plausible capacity while bounding one-fill loss at 2% of the frozen
  $500 research bankroll.
- Orders are stamped `research_capital_version=500usd-v1`; pre-version rows
  remain immutable historical development data and are not pooled forward.
- Every directional order must show at least 2 cents of Φ-vs-ask residual
  after **2×** the current published crypto taker fee.
- H9–H11 use the collector's empirically justified ≥5bp move-from-open guard.
  HYPE is excluded because that Binance-vs-resolution finding does not apply to
  its Hyperliquid-only source. This is mechanism scope, not a PnL-fitted asset
  exclusion.
- All thresholds are provisional. None may be changed inside an evaluation
  cohort. A redesign gets a new name/version and starts at zero.

## The five hypotheses

| ID | Mechanism | Entry test | Principal failure mode |
|---|---|---|---|
| `H9_dual_book_microprice` | Queue imbalance predicts the next quote move; complementary UP and DOWN books provide two independent confirmations | Both token-book microprices point to the same outcome, underlying is ≥5bp from open, and terminal edge clears 2× fees | Displayed queues are spoofable or only predict one tick, not resolution |
| `H10_theta_lag` | A digital probability converges toward 0/1 as time expires even with spot unchanged | Over 10s, spot ≤1.5bp and sigma changes ≤10%, Φ moves ≥4 ticks, token follows by ≥3 ticks less | Online sigma changes masquerade as theta; market price is the better probability |
| `H11_liquidity_vacuum` | Ask cancellations can precede upward repricing when same-side demand remains | ≥60% near-touch ask depth vanishes in 5s, bid depth retains ≥80%, ask has moved ≤1 tick, CEX and Φ agree | Cancellations are spoofing/noise and vanished ask means the submitted order will not fill |
| `H12_cross_venue_consensus` | A broad move on independent venues is closer to an aggregated resolver input than Binance alone | Binance and Coinbase 10s returns are each ≥3bp, same sign, within 2bp, fresh, and terminal edge clears costs | Two venues still do not reproduce Chainlink Data Streams; opportunity disappears before execution |
| `H13_idiosyncratic_impulse` | Asset-specific information should lead generic beta already visible across crypto | Target 10s return minus median of ≥4 fresh peers is ≥4bp, peer median remains within 1.5bp, and move from open is resolver-safe | “Idiosyncratic” move is transient noise or Polymarket already prices it |

## Developmental replay read

The replay did **not** establish a profitable strategy:

| Pilot | Orders | Latency-surviving fills | Win rate | PnL 1× | PnL 2× | 95% mean-PnL CI | Read |
|---|---:|---:|---:|---:|---:|---:|---|
| H9 | 106 | 30 | 76.7% | +$16.67 | +$13.08 | [-$0.81, +$1.77] | Positive, but interval crosses zero |
| H10 | 31 | 14 | 78.6% | +$5.66 | +$3.79 | [-$2.15, +$2.50] | Tiny and highly uncertain |
| H11 | 7 | 1 | 100% | +$3.16 | +$2.98 | unavailable | One fill is not evidence |
| H12 | 0 | 0 | — | $0.00 | $0.00 | unavailable | Independent venue tape did not yet exist |
| H13 | 12 | 3 | 66.7% | -$7.80 | -$8.10 | [-$9.26, +$0.88] | Tiny negative sample |

- H9 was positive after 1× and 2× costs, but its uncertainty interval included
  zero and its fill rate was low. It is a forward hypothesis, not a finding.
- H10 was close to flat in the pooled data; it needs forward falsification and
  sigma-attribution telemetry.
- H11 produced too few fills to interpret. The low survival rate is itself a
  warning that liquidity withdrawal may remove the opportunity.
- H12 correctly produced zero historical orders because Coinbase was not
  collected. Substituting Binance twice would be fabricated confirmation.
- H13's replacement design also has only a tiny developmental sample and no
  positive claim. The predecessor's loss is permanently reported above.

## Research basis

- Stoikov, *The Micro-Price* — book imbalance adjusts the mid and can improve
  short-horizon price prediction: <https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2970694>
- Cont, Kukanov & Stoikov, *The Price Impact of Order Book Events* — short-run
  price changes relate more robustly to order-flow imbalance, including limit
  and cancellation events, than trade volume alone:
  <https://arxiv.org/abs/1011.6402>
- Gould & Bonart, *Queue Imbalance as a One-Tick-Ahead Price Predictor* —
  significant out-of-sample queue-imbalance predictability, stronger in
  large-tick books: <https://arxiv.org/abs/1512.03492>
- Wolfers & Zitzewitz, *Interpreting Prediction Market Prices as
  Probabilities* — market prices are often close to mean beliefs, setting a
  high prior against easy model-vs-market alpha:
  <https://www.nber.org/papers/w12200>
- Chainlink Data Streams — low-latency, liquidity-aware aggregated market data:
  <https://chain.link/data-streams>
- Coinbase public ticker feed — independent real-time trades and BBO control:
  <https://docs.cdp.coinbase.com/exchange/websocket-feed/channels>
- Polymarket fee formula and category rates:
  <https://docs.polymarket.com/trading/fees>

The papers concern other venues and horizons; they motivate mechanisms, not
profit projections for Polymarket binaries.

## Forward evaluation

1. Pilot until feed, feature, quote-survival, partial-fill and sizing machinery
   are demonstrably correct. Dashboard pilot counts are activity only.
2. Retire starved or mechanically invalid hypotheses. Freeze each survivor in
   its own commit and change only that strategy to `phase='eval'`.
3. Start from **0/500 fresh fills** and run for the longer of 500 fills or 14
   calendar days. Pilot rows are never pooled forward.
4. Require positive 1× and 2× expectancy, both chronological halves positive,
   acceptable drawdown/capacity, and the five-test-adjusted 99% bootstrap
   interval entirely above zero.
5. Report non-fills and their outcomes. A strategy that “wins” only when its
   stale quote is assumed filled fails.
6. Compare H12 calibration and PnL when venues agree versus disagree; compare
   H10 changes attributable to time decay versus sigma drift.

The expected honest outcome may be that all five effects are consumed by
fees, latency, adverse selection, or an already-efficient prediction market.
Measured edge near zero is a valid final result.
