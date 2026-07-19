# Cross-market and reference-wallet viability review

Generated 17 July 2026. Every bot discussed here remains paper/shadow only.
Displayed opportunity dollars are not portfolio PnL unless the report says
otherwise.

## Bottom line

The named Polymarket wallet is genuinely profitable at very large scale. The
evidence does **not** show a small, risk-free recipe that can be copied with
$500. Its public footprint is consistent with a high-turnover sports/esports
maker and inventory operation: roughly 62% of the latest day's public trade
notional is maker-classified, it repeatedly buys both outcomes, merges complete
sets, redeems, and receives material maker rebates. It also lost approximately
$272,890 over the latest week and carries seven-figure outcome tails.

The current Polymarket/Kalshi laboratory has **$0 deployable PnL**. It has no
manually approved identical contracts. The large dashboard opportunity numbers
belong to known rule-mismatched diagnostic controls and must not be interpreted
as arbitrage. Cross-venue payoff identity remains worth monitoring, but there is
no current evidence that it can produce $100–$200/day from $500.

The prior paired-maker experiment is negative in every arm. V3 is a newly
frozen reward-aware mechanism test, not a claimed fix: it must produce at least
300 fresh independent markets and 30 days of actual execution PnL before any
profitability conclusion.

## 1. Polymarket × Kalshi

The 30-day forward replay currently contains 17,710 synchronized snapshots over
27 candidate pairs and two collection days. Contract review has approved zero
pairs. The engine observed 5,098 economic episodes in diagnostic pairs, but
none are lockable because the payout rules differ. The largest displayed
figures—approximately $196 raw / $174 stressed—are therefore examples of the
profit a bad title match can manufacture, not money the bot could safely earn.

The convergence diagnostic is similarly non-deployable: 11 of 57 unapproved
episodes eventually reached a profitable four-leg executable exit, with an
estimated 32.6% probability by 24 hours. Since the contracts are not payoff
identical, this is an uncontrolled relative-value trade, not risk-neutral
arbitrage. The approved cohort contains zero episodes.

The correct lock remains:

```text
equal shares × (Polymarket opposite-outcome ask
              + Kalshi opposite-outcome ask
              + both entry fees) < equal terminal payout
```

Both venue legs are non-atomic. A production candidate must also survive stale
leg checks, full-depth FOK capacity, doubled fees, one-tick stress, and the
immediate loss from unwinding whichever leg fills alone.

### Change implemented

The collector now supports Kalshi's authenticated **read-only** order-book
WebSocket. Raw snapshots/deltas enter the local WAL before book mutation;
exchange time, receive time and sequence are retained; sequence gaps discard the
book and force a clean snapshot. Public batched REST remains an automatic
fallback. Kalshi requires authentication even for the order-book stream, so the
VPS remains on REST until `KALSHI_READONLY_KEY_ID` and
`KALSHI_READONLY_KEY_PATH` are installed. The adapter exposes no order method.

This improves measurement fidelity and should reduce the existing mean/p95
cross-venue timestamp skew of roughly 24.6/85.3 seconds. It cannot create
contract identity or economic edge. The Dublin host remains research-only for
Kalshi because of the jurisdiction restriction already documented in the app.

Official references: [Kalshi WebSocket authentication](https://docs.kalshi.com/getting_started/quick_start_websockets),
[Kalshi order-book snapshots and deltas](https://docs.kalshi.com/websockets/orderbook-updates).

## 2. Reference wallet

Public Data API snapshot for
`0x2c335066fe58fe9237c3d3dc7b275c2a034a0563`:

| Period | Official PnL | Volume | PnL / volume |
|---|---:|---:|---:|
| Day | +$184,043.58 | $1.58m | 11.63% |
| Week | **-$272,889.88** | $57.78m | -0.47% |
| Month | +$1,602,807.93 | $262.42m | 0.61% |
| All time | +$6,637,011.96 | $743.42m | 0.89% |

Its public open-position value was approximately $1.66m and it had traded 5,130
markets. Sports supplied approximately $4.87m of all-time PnL and esports
$1.51m. Crypto supplied only about $27.6k all time despite a strong recent
week, so this is not primarily a crypto-direction bot.

Mechanism evidence:

| Public activity | Day | Month | All time |
|---|---:|---:|---:|
| Merge value | $530,531 | $147.19m | $206.33m |
| Split value | $0 | $49.86m | $60.77m |
| Redeem value | $1.66m | $184.11m | $267.27m |
| Liquidity rewards | $112 | $13,482 | $26,248 |
| Maker rebates | $2,792 | $401,952 | $594,675 |

The latest day contains about $2.63m of public fills; approximately $1.62m, or
61.75%, is maker-classified by excluding transactions present in the taker-only
tape. That classification is approximate. Maker rebates are economically
material—about 9% of all-time leaderboard PnL and 25% of latest-month PnL—but
liquidity rewards alone are less than 0.4% of all-time PnL. Period activity and
leaderboard PnL explain mechanism and are not additive accounting lines.

A hindsight pairing of the latest day's BUY fills finds roughly 548k shares
that can be matched across outcomes and a +$24.5k gross arithmetic residual.
The maker-only approximation is +$9.85k. These are **not executable PnL**:
fills occurred at different times, sales are ignored, losing pair costs are
netted with winners, and no simultaneous capacity constraint is enforced. The
diagnostic supports dynamic two-sided inventory management, not a standing
sub-$1 arbitrage.

Use `npm run research:wallet` to regenerate this report from public endpoints.
The underlying APIs are documented by Polymarket for
[leaderboards](https://docs.polymarket.com/api-reference/core/get-trader-leaderboard-rankings),
[activity](https://docs.polymarket.com/api-reference/core/get-user-activity),
and [trades](https://docs.polymarket.com/api-reference/core/get-trades-for-a-user-or-markets).

## 3. Paired complete-set maker

V2 actual paper results:

| Arm | Filled cycles | Independent markets | Realized PnL |
|---|---:|---:|---:|
| One-cent / 60-second repair | 62 | 3 | -$22.45 |
| One-cent / 300-second repair | 32 | 3 | -$17.77 |
| Two-cent / 300-second control | 24 | 3 | -$21.66 |

Do not sum the arms; each is a separate $500 counterfactual on the same tape.
All three are negative, all use only three markets, and V2 selected markets
whose reward revenue was zero. The result rejects naive spread capture but does
not test the wallet's incentive-aware mechanism.

V3 now:

- selects only reward-funded sports/esports with known game start;
- sizes to the venue reward minimum, capped at $250 reserved per independent
  $500 arm and one open market per arm;
- separates pre-game arms from a live catalyst-toxicity control;
- applies the published quadratic distance score to both resting quotes;
- estimates competitor share conservatively from aggregate public L2;
- records that estimate separately from actual PnL and does not credit rebates;
- resolves an untradeable orphan at the public winning token rather than a
  fabricated midpoint.

Polymarket normalizes maker scores against competitors and samples books every
minute. Aggregate public L2 does not reveal maker identities or account
eligibility, so the V3 reward line is explicitly modeled and cannot support
promotion. See [liquidity reward mechanics](https://docs.polymarket.com/market-makers/liquidity-rewards)
and [maker rebates](https://docs.polymarket.com/market-makers/maker-rebates).

## 4. $500 earning capacity

The user's $100–$200/day target requires 20%–40% daily return on starting
capital. No current TV2 cross-market cohort supports that projection.

Even a deliberately generous scaling illustration is far lower: applying the
wallet's latest-month PnL/volume ratio of 0.61% to five full $500 bankroll turns
per day gives about **$15/day before** nonlinear loss of rebate share, worse
queue position, concentration, variance and orphan risk. This is not a forecast;
it shows the turnover required. Reaching $100/day at that ratio would require
over 32 complete bankroll turns every day with the large wallet's execution
quality and no capacity degradation.

The honest current ranges are therefore:

- Polymarket/Kalshi approved arbitrage: $0 observed; upside unquantified until
  exact identities exist.
- V2 paired maker: negative.
- V3 reward-aware paired maker: unknown and provisional; no PnL projection.
- Reference-wallet clone: not established and not linearly scalable to $500.

The most credible next evidence is boring but decisive: 300+ fresh markets per
V3 arm, account-reconciled incentives, 30 days, positive actual 2x-cost PnL in
both halves, and a clustered lower confidence bound above zero. For cross venue,
the clock starts only after at least one exact contract identity is approved.
