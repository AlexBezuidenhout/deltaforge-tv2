# BORG Mechanism-Diverse Shadow Portfolio

Created: 2026-07-14. Status: **PILOT / MACHINERY VALIDATION ONLY**.

These eight strategies are new forward hypotheses. They are deliberately not
eight parameter variants of `G_late_arb`: each tests a different information or
execution mechanism. They have no wallet, signer, order client or live executor.
Every order is an intended shadow order written by the collector and later
scored against the recorded CLOB tape.

No threshold below was selected to maximize the existing trade history. The
thresholds come from accounting identities, the venue's one-cent tick, the
published fee curve, causal timescale separation or explicit safety buffers.
They are provisional pilot settings. Pilot P&L is not profitability evidence.

## Shared execution policy

- Maximum notional: **$10 per strategy order**, matching 2% of the frozen $500
  research bankroll. H1's $10 is split across the paired position.
- Orders are stamped `research_capital_version=500usd-v1`; earlier $3 pilot
  rows are retained for audit but excluded from the current dashboard cohort.
- One decision per strategy per market. H8 may emit one cancel after its quote.
- New taker hypotheses use `execution_model=latency_1s`: the scorer waits 1.25s,
  then requires recorded ask depth still to exist at or below the original
  limit. Partial fills are capped to surviving depth; vanished quotes are
  non-fills.
- H8 is maker-only and retains strict back-of-queue tape scoring. Maker rebates
  are assigned zero.
- Costs use the crypto curve `shares × 0.07 × p × (1-p)`. Directional hypotheses
  require residual model edge after **2×** that curve. H1 requires the paired
  payout identity itself to remain profitable at 2× costs.
- All component inputs are persisted with each signal: 10s/30s CEX return,
  aggressor-flow imbalance, depth imbalance, Φ, Gamma, books, sigma and the BTC
  control-oracle basis where applicable.

## The eight pilots

| ID | Hypothesis | Assets | Entry mechanism | What would falsify it |
|---|---|---|---|---|
| `H1_pair_arb_2x` | Complement mispricing occasionally exceeds all costs | All | Buy equal UP+DOWN shares only when asks + 2× fees leave ≥1¢ locked per pair | Full-pair fills do not remain positive, or one-leg fill risk consumes the identity edge |
| `H2_cex_impulse_lag` | A ≥4bp 10s CEX shock reaches the underlying before the Polymarket ask | All | Follow CEX direction only with ≥3¢ Φ-vs-ask edge after 2× fees | Surviving fills have non-positive expectancy or missed winners dominate |
| `H3_flow_confirmed` | Signed CEX trades and depth predict a move before price fully reacts | Binance assets | Return, aggressor flow and depth must agree; ≥2¢ stressed edge | Flow-confirmed entries do no better than H2 or lose after costs |
| `H4_btc_leads_alts` | BTC price discovery propagates into a still-flat altcoin with a short delay | ETH, SOL, BNB, DOGE, XRP | BTC moves ≥5bp while target remains ≤2bp over 10s and ≤2.5bp from its own open | Target outcomes remain coin-like or the ask already prices the propagation |
| `H5_vol_expansion` | A volatility-regime break creates continuation underpricing | All | Current sigma ≥1.5× causal 5-minute baseline, directional 30s move, ≥3¢ stressed edge | Expansion entries show reversal/no edge, especially in the second half |
| `H6_phi_overreaction` | Prediction-market traders temporarily overshoot the CEX-implied fair value | All | Market probability differs from Φ by ≥12¢ and CEX has begun retracing; buy toward Φ | Φ is the wrong anchor or the apparent discount is adverse information |
| `H7_btc_oracle_confirm` | Requiring CEX and an independent oracle control to agree reduces BTC basis losses | BTC only | Binance and mainnet Chainlink control move ≥2bp in the same direction with ≤2.5bp gap | Strategy starves, or control-feed agreement does not improve settlement results |
| `H8_informed_maker` | One-sided informed making can avoid symmetric-maker adverse selection | Binance assets | Join the supported side's best bid only when CEX return and flow agree | Back-of-queue fills remain negatively selected, as prior passive makers were |

H7's mainnet Chainlink feed is explicitly a **control series**, not a claim that
it is identical to the market's named Chainlink Data Stream. Starvation is a
valid finding. Current Gamma descriptions identify Data Streams as the
resolution source for all seven five-minute crypto families.

## Promotion protocol

1. Run in `pilot` long enough to verify fields, quote-survival scoring, pair
   grouping and maker cancel behavior. Pilot returns are never pooled forward.
2. Freeze each viable strategy independently in a tagged commit. A strategy
   whose machinery or opportunity rate is broken can be retired without
   changing another strategy.
3. Start a fresh `eval` phase. Require the longer of **500 filled trades or 14
   calendar days**.
4. Primary pass bar: positive 1× expectancy; positive 2× expectancy; both
   chronological halves positive; maximum drawdown within the $15 research
   envelope; and the bootstrap interval adjusted across eight hypotheses
   (α=0.05/8, a 99.375% interval) entirely above zero.
5. Taker studies must report submitted orders, latency-survival fill rate,
   partial fills, and the win rate/P&L of non-fills. H1 is evaluated by group,
   separating complete pairs from single-leg exposure.
6. H8 additionally needs positive 5s/30s adverse-selection marks and positive
   net capture with zero rebate credit.
7. No parameter is changed to rescue an evaluation cohort. A mechanism-driven
   redesign receives a new strategy/version and starts again at zero.

An honest terminal result is that all eight edges are approximately zero or
negative after execution. The research design exists to make that conclusion
visible rather than tune it away.

## Venue references

- Fees: <https://docs.polymarket.com/trading/fees>
- Public CLOB market stream: <https://docs.polymarket.com/market-data/websocket/market-channel>
- Public market metadata: <https://docs.polymarket.com/market-data/overview>
