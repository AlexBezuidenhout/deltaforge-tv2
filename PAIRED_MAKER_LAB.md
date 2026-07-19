# Paired Complete-Set Maker Lab

## Purpose

This is a paper-only forward experiment inspired by the economically credible
part of the public activity of wallet
`0x2c335066fe58fe9237c3d3dc7b275c2a034a0563`: passive buying on both outcomes,
netting complementary inventory, and carrying or rebalancing the residual. It
is not a copy-trader, does not watch pending transactions, and contains no
wallet, signer, authenticated user channel, or exchange-order dependency.

The wallet audit did **not** reveal a risk-free high-win-rate strategy. Profit
was heavy-tailed and concentrated in sports/esports; incentives were material;
and a representative unmatched residual lost roughly $270k at resolution. The
mechanism worth testing is therefore complete-set spread capture **after** the
cost of orphan inventory, not the wallet's headline PnL or public fills.

## Forward specification

The active immutable manifest is
`borg/experiments/paired-complete-set-maker-v3-rewards.json`. V1 and V2 remain
immutable. V2 established an important negative result: one-cent spread capture
was overwhelmed by unmatched-leg losses, and the selected panel had no reward
revenue. V3 changes the mechanism rather than tuning a PnL threshold. It selects
only sports/esports markets with a current reward pool, known game start, venue
minimum size and maximum spread. Each arm is an independent $500 paper account,
may reserve at most $250, and may have one market open at a time. Arms reuse the
same public tape and must never be summed:

- `reward_pregame_repair_60s`: quote before the game start and allow 60 seconds
  to complete an unmatched pair.
- `reward_pregame_repair_300s`: identical entry mechanism with a five-minute
  repair window.
- `reward_live_repair_60s_control`: quote only after the scheduled start as a
  pre-registered catalyst-toxicity control.

Every arm still requires at least $0.01 of complete-set edge per share. Order
size is the greater of the venue minimum, reward minimum, and $25 target—not a
value selected from prior PnL. If the reward minimum would reserve more than
$250, the market is ineligible.

## Execution and accounting contract

1. Subscribe to both outcome books through one public event-driven CLOB socket.
2. Require fresh, synchronized books; join both displayed best bids for equal
   shares. Never improve a quote in a way that spends the frozen pair edge. Rest
   the initial quote for up to 15 minutes so queue priority can actually accrue.
3. A paper maker fill occurs only after public prints at or through the bid
   consume the displayed queue plus one venue-minimum order. Cancellations do
   not advance queue position.
4. After the first partial fill, request cancellation of both initial quotes.
   Prints during the fixed 50ms cancel-ack interval remain fill-eligible.
5. Net equal complementary shares at exactly $1 and report that locked PnL.
6. If shares remain unmatched, quote only the complement and never at a price
   that reduces the arm's minimum edge. A residual smaller than the venue's
   minimum order is not rounded up.
7. At repair timeout, cancel the repair quote and liquidate the orphan through
   actual displayed bid depth. The simulated exit worsens full-depth VWAP by
   one tick and charges the configured taker fee. Insufficient or stale depth
   leaves `EXIT_PENDING`; it never creates a fictional fill.
8. If displayed depth cannot support an orphan exit, the position remains open.
   Once the public CLOB market exposes a winning token, the orphan is scored at
   its actual $0/$1 payout; it is never closed at a fabricated midpoint.
9. The public-L2 reward model applies Polymarket's quadratic distance score,
   requires both quotes to meet minimum size and maximum spread, and treats the
   minimum aggregate side score as a conservative competitor upper bound. The
   estimate is persisted as `modeled_reward_accrual`, never `total_pnl`.
10. Public books do not identify makers or reconstruct minute sampling and
    account eligibility. Therefore modeled rewards cannot support promotion.
    Maker rebates remain $0 until account-level fills and rebate cash can be
    reconciled.

Raw CLOB frames and paper decisions are appended to separate local WAL streams
before asynchronous database persistence. The dashboard reads local PostgreSQL;
the database is not in the reaction path.

## What would count as evidence

Do not promote an arm from this pilot until it has at least 300 independent
filled conditions and 30 UTC days. Evaluate closed-cycle total PnL after orphan
exits, clustered by condition and day. Both chronological halves must be
positive, 2x cost stress must remain positive, and the market-clustered lower
confidence bound must exceed zero. Report merge rate, time-to-complement,
locked PnL, orphan PnL, exit-pending inventory, interruptions, capacity, and
category concentration separately.

Run the prospective report with:

```bash
npm run research:pairedmaker
npm run research:wallet
```

The paired report parses every PostgreSQL numeric field before arithmetic,
doubles charged maker/taker fees and applies an extra adverse tick to orphan
exits for its 2x stress read. It reports realized execution PnL separately from
modeled incentive revenue. The wallet report uses public leaderboard, activity
and trade data and labels fill-pairing across time as a non-synchronous hindsight
upper bound, not executable arbitrage.

## Reference-wallet audit, 17 July 2026

The public leaderboard confirms that the named wallet is genuinely profitable
over long horizons but not consistently profitable: approximately +$6.64m on
$743.4m all-time volume and +$1.60m over the latest month, versus approximately
-$272.9k over the latest week. Its public activity includes thousands of merges
and redemptions, roughly $594.7k of maker rebates and only about $26.2k of
liquidity rewards. This supports a high-turnover maker/inventory mechanism;
rewards alone do not explain the PnL.

The public position value was roughly $1.66m—more than 3,000 times this lab's
$500 bankroll—and the closed-position tail contains seven-figure wins and
losses. Rebate share, queue priority, inventory diversification and drawdown
tolerance are nonlinear, so scaling its leaderboard return down to $500 is not
a defensible projection. V3 tests one narrow mechanism suggested by the wallet;
it is not a clone and remains paper-only.

The likely null result is economically important: one cent of gross complete-
set spread may be too small to pay for non-atomic fill risk. If orphan losses
consume locked PnL, this mechanism does not work at a $500 scale without a
category-specific fair-value model or independently verifiable incentive edge.
