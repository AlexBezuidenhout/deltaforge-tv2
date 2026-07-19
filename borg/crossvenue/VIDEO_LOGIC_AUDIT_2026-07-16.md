# Polymarket × Kalshi video-logic audit — 2026-07-16

## Source reviewed

- [Juiced Bets video, “I Found an Arbitrage Tool for Prediction Markets”](https://www.youtube.com/watch?v=PaQjSUCZVb0), published 2026-07-08.
- [Arbs.xyz public product page](https://www.arbs.xyz/).
- [Arbs.xyz risk disclosure](https://www.arbs.xyz/risk-disclosure) and [terminal disclosure](https://www.arbs.xyz/terminal-trading).

The video is an affiliate promotion for a $997/year product. It presents user
testimonials and profit claims, but no independently auditable order IDs,
complete trade ledger, fee reconciliation, losing-leg history or
market-clustered confidence interval. It is a useful product specification,
not proof of an exploitable edge.

## Actual strategy shown

For a genuinely identical binary proposition, buy equal payout quantities of
opposite outcomes:

```text
q Polymarket YES + q Kalshi NO, or
q Polymarket NO  + q Kalshi YES
```

If the two executable entry costs plus fees are below `q × $1`, the terminal
payoff is locked after both legs fill. The dollar stakes differ because the
prices differ; the share quantities must match. The video then proposes an
optional early exit when both positions can be sold profitably, releasing
capital before resolution.

The demonstrated product also claims to:

- scan comparable markets continuously and refresh every 2–3 seconds;
- rank by spread, profit dollars, liquidity/volume, volatility and end date;
- size both legs from bankroll and available liquidity;
- alert when both positions can be sold profitably;
- help re-hedge if only one leg fills.

## Corrections required for an honest implementation

1. **ROI denominator.** Spending $0.95 for a $1 payout produces $0.05 profit,
   which is `0.05 / 0.95 = 5.263%` return on deployed cash, not 5%.
2. **Executable prices.** Entry must walk both asks. Early exit must walk both
   bids. Midpoints, last trades and plotted line crossings are not fills.
3. **All fees.** Entry pays both taker fees; early liquidation pays both fees
   again. [Polymarket's current fee formula](https://docs.polymarket.com/trading/fees)
   is market-specific. [Kalshi's general schedule](https://kalshi.com/docs/kalshi-fee-schedule.pdf)
   uses the quadratic taker formula, with special products potentially having
   different schedules.
4. **Identity, not title similarity.** Source, observation time, threshold,
   correction, cancellation, postponement, early-close, scalar and void rules
   must imply the same payoff. The vendor's own disclosure identifies adverse
   resolution as its most significant strategy-specific risk.
5. **No cross-venue atomicity.** “One click” still sends two separate orders to
   two matching engines. A second-leg move can turn a lock into a guaranteed
   loss; changing the hedge quantity cannot generally restore a no-loss payoff
   in both outcomes.
6. **Capacity.** Profit is bounded by common displayed depth and prefunded cash
   on each venue. A large percentage on five shares is not a scalable trade.
7. **Convergence is optional, not guaranteed.** A terminal lock may exist even
   if prices never reconverge before resolution. Historical midpoint crossing
   frequency is not an executable exit probability.

## DeltaForge implementation

The paper-only Cross-Venue Lab now implements the useful video mechanics as a
strict superset:

- both complementary directions;
- synchronized Polymarket WebSocket and batched Kalshi REST books;
- full-depth VWAPs and current fee formulas;
- equal-payout sizing optimized over depth breakpoints under a frozen $500
  bankroll and $250 per-venue funding;
- raw and stressed cash ROI, profit dollars and displayed capacity;
- one-tick-per-leg plus second-fee stress;
- immediate single-leg unwind loss and maximum unhedged capital at risk;
- fixed-size executable convergence tracking with four fees and right
  censoring;
- a hard manual contract-identity approval before any row can be labelled
  lockable;
- no wallet, signer, API trading credential or live-order path.

When no identity-approved pairs exist, up to four reviewed mismatches continue
as diagnostic controls. They exercise collection and show how much apparent
profit a title-only scanner would fabricate, but are never evidence and can
never be marked lockable.

## Current evidence verdict

At implementation time the live universe contained roughly 34,500 Polymarket
binary markets and 20,000 Kalshi markets, but the frozen rules audit had zero
approved identical pairs. Previously observed positive rows came from
unapproved or subsequently rejected mappings. They are not proof of arbitrage.

Promotion requires at least 300 fresh independent, identity-approved episodes
over 30 calendar days, positive stressed economics, full displayed depth,
measured orphan-leg outcomes and positive results in both time halves. Until
then this remains a discovery and execution-fidelity lab, not a live strategy.
