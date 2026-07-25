# Polymarket × Kalshi full-universe rescan — 19 July 2026

Snapshot generated at 2026-07-19 22:13 UTC. Venue universes are dynamic, so
counts will move as contracts open and close.

## Finding

The prior Kalshi discovery path was incomplete. It stopped at 20 pages of the
`/markets` endpoint and therefore exposed about 20,000 contracts, not the whole
open venue. The replacement walks cursor-paginated open events with nested
markets and retains the event title, category and settlement sources used by
the contract matcher.

| Measure | Prior runtime | Full rescan |
|---|---:|---:|
| Polymarket active binary markets | 37,461 | 37,362 |
| Kalshi active open binary markets | 20,057 | 66,460 |
| Kalshi open events | not measured | 7,658 |
| Retained overlap candidates | 97 | 978 |
| Non-rejected discovery candidates | 94 | 951 |
| Score strictly above 80% | 84 | 141 |
| Strong text candidates | not separated | 62 |
| Structured crypto/sports candidates | included | 74 |

The full Kalshi scan completed 39 pages and did not hit its configured cap.
The retained-candidate cap of 10,000 was also not hit. Candidate composition
was 531 sports, 253 other, 148 politics, 25 finance and 21 crypto by the
Polymarket classifier. Exact-looking families include the 2026 Vancouver,
Toronto and Ottawa mayoral elections and the 2028 presidential nomination
slates. These are high-priority rule-review families, not certified identities.

The number 27 was not the number of overlapping contracts. In this snapshot it
was the number of previously frozen manually rejected pairs that remained in
the discovery set. The old page cap was the main coverage defect.

## Correct economics

For equal quantities `q` of genuinely identical binary contracts, direction 1
has terminal economics:

```text
cost = q × (Polymarket YES executable ask + Kalshi NO executable ask)
       + both entry fees
payout = q
locked PnL = payout - cost
```

Direction 2 replaces the outcomes with Polymarket NO and Kalshi YES. A positive
locked PnL is a terminal lock after both non-atomic legs fill. It does not need
prices to reconverge.

In the example where one venue's executable YES/NO asks are approximately
58/42 and the other's are 35/65, buying the 42-cent NO and the 35-cent YES costs
77 cents before fees. If and only if the contracts have the same payoff in
every terminal state, that is approximately 23 cents of gross terminal value
per equal share. Midpoints, last trades and displayed probabilities are not
enough: the test must use synchronized asks, walk available depth, include both
fees, and obtain both fills.

If the cross-complement cost is at least the guaranteed payout, it is not a
terminal arbitrage. An early convergence trade then has four-leg economics:

```text
early-exit PnL = both executable bid proceeds
                 - both executable entry asks
                 - two entry fees - two exit fees
```

That trade carries basis-widening, time-to-convergence and exit-liquidity risk.
It can remain disconnected until resolution, converge only after capital has
been tied up for months, or fail because the two rulebooks do not actually
describe the same event.

## What the paper cohort means

All non-rejected matches with score strictly above 80% are enrolled in the
paper-only assumed-parity cohort. The score is a retrieval confidence measure,
not an 80% probability of payoff equivalence. It can never set
`identity_approved`, `relation_approved`, `economic`, or
`lockable_after_both_fills`.

A certified lock still requires an exact condition-id/ticker review covering:

- resolution source and source hierarchy;
- observation timestamp, timezone and correction window;
- outcome predicate, participant, strike and inequality operator;
- postponement, cancellation, early-close, void and no-result treatment;
- a content-addressed frozen rule snapshot;
- equal-share executable depth and two complete fills.

Cross-venue orders are not atomic. The collector therefore records the worst
immediate bid-depth unwind if either venue fills first and the other leg
vanishes. Venue, collateral, withdrawal, jurisdiction and rule-change risks
remain outside the mathematical payoff identity.

## Forward decision rule

Do not infer profitability from 978 candidates or 141 paper subscriptions.
The relevant evidence is independent executable episodes after identity/rule
review. Report terminal locks separately from convergence trades. For the
latter, measure Kaplan–Meier time to profitable four-leg liquidation, capital
days, right-censored episodes, worst orphan unwind and return per locked-dollar
day. Require at least 300 fresh independent relation episodes, 14 calendar
days, both chronological halves positive under doubled costs, and a clustered
lower confidence bound above zero before considering capital.

Run a new read-only audit with:

```bash
node scripts/crossvenue-universe-rescan.js --max-candidates=10000 --top=100
```

## Deployment and first forward read

The Dublin deployment completed a non-truncated refresh at 22:40 UTC with
37,001 Polymarket binaries, 66,311 Kalshi binaries across 7,639 events, 953
current overlap candidates, 141 score-approved paper pairs and two previously
certified relations. All 141 paper pairs were monitored; overflow was zero.
The authenticated Kalshi WebSocket held 147 tickers with zero sequence gaps or
parse errors. Full discovery now runs in a worker so the live collector kept a
3–9 second heartbeat and continued evaluating books throughout the refresh.

The corrected convergence report had only 1.11 days of coverage. The certified
cohort contained one economic episode: its best raw upper bound was +$0.041 at
6.8 shares, but the frozen 2×-cost/one-tick stress was -$0.122, so there were
zero lockable episodes and zero profitable early exits.

The score-approved assumed-parity cohort produced 30 basis episodes across six
pairs and eight observed profitable exits. This is not 30 independent market
tests. All eight exits came from two hourly BTC strike pairs; a third BTC strike
had no profitable exit, and three long-dated 2028 nomination pairs were briefly
right-censored. The successful-exit median was about 319 seconds, but the BTC
contracts resolve from different sources (Binance one-hour close versus the
60-second CF Benchmarks BRTI average). They are a resolver-basis hypothesis,
not a risk-free payoff identity. This is useful forward-discovery evidence but
far below the pre-registered 300 independent-event threshold and supports $0
of bankable expected PnL today.
