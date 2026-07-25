# Polymarket/Kalshi risky-convergence audit

Evidence freeze: 25 July 2026, 19:16 UTC. This report concerns statistical
convergence and resolver-risk carry. It does not describe the positions as
risk-free arbitrage.

## Verdict

The current data does **not** prove a profitable risky-convergence strategy.
One optimistic one-hour replay is positive before promotion stress, but every
tested exit rule and horizon is negative after duplicated observed fees and
one adverse tick on every execution leg. Moreover, 116 of the 121 eligible
entry-days contain a hard payoff mismatch, so their PnL is evidence about
directional bets between different derivatives, not convergence between
equivalent contracts.

Bankable expected PnL from this evidence is therefore **$0/day**. The raw
terminal-control line earned $7.71 over roughly 40.6 hours, but lost $8.47
under the frozen 2x-fee-plus-tick stress. It must not be annualized or scaled
to a $500 bankroll.

## Replay design

- Current experiment only: `crossvenue-rule-aware-convergence-v5`.
- 121 first eligible match-direction-UTC-day entries across 116 pairs.
- Actual data coverage: 24 July 00:04 UTC to 25 July 16:41 UTC.
- Fixed displayed quantity: five equal shares on each venue.
- Entry walks both executable ask books.
- Early exit walks both executable bid books.
- All four observed taker fees are included in ordinary round-trip PnL.
- Books must be synchronized, fresh, full-depth and A/B data quality.
- Unresolved positions without an executable exit are right-censored, never
  counted as zero-PnL wins.
- If the executable tape disappears but both venues settle, the actual joint
  terminal payoff is used.
- Promotion stress charges every observed fee a second time and moves every
  entry/exit leg one adverse tick.
- Cross-venue fills are still assumed simultaneous. The replay does not erase
  non-atomic leg risk.

Polymarket's current documentation specifies per-market dynamic taker fees,
and Kalshi's February 2026 general schedule charges takers using
`round-up-to-cent($0.07 × contracts × price × (1-price))`; some Kalshi products may have
different schedules. The collector reads Polymarket's market fee metadata but
currently applies Kalshi's general multiplier, so unusual Kalshi schedules
remain an additional downside risk.

## Results

All figures below are dollars over the complete cohort of 116 hard-mismatch
entries.

| Exit policy | Ordinary PnL | 2x fees | 2x fees + ticks | Chronological stress halves |
|---|---:|---:|---:|---:|
| Five-minute timeout | -31.72 | -47.75 | **-62.62** | -29.15 / -33.47 |
| Thirty-minute, take 1% else timeout/settlement | -5.88 | -18.87 | **-32.49** | -17.33 / -15.16 |
| One-hour/terminal hold | +7.71 | -0.79 | **-8.47** | -7.33 / -1.14 |
| One-hour, take 1% else settlement | +7.01 | -3.98 | **-16.57** | -12.41 / -4.16 |

The superficially attractive one-hour 1% rule produced 114 positive trades
and two negative trades, but its worst trade lost $4.81 while its median
trade gained only $0.09. After stress, only 44 of 116 entries remained
positive. A high win rate is therefore not a profitable payoff distribution.

The least-bad exploratory initial-edge bucket was 1–3%: +$3.88 ordinary,
+$2.45 with duplicated fees, and -$0.46 after adverse ticks. Both stressed
chronological halves were negative. Selecting that bucket now would be an
in-sample choice and must be treated as a provisional new hypothesis, not a
finding.

The direction `POLY_NO+KALSHI_YES` supplied +$6.94 of the raw one-hour 1%
line, but lost $16.00 under full stress. Reversing or retaining that direction
after seeing this sample would be post-hoc selection.

## Contract-comparability audit

Of the 121 eligible entry-days:

- 116 had at least one hard payoff mismatch.
- Five had no recorded hard mismatch, representing only three pairs.
- The dominant hard mismatches were different numeric thresholds/strike
  forms, resolver differences and participant/predicate differences.

Examples include a Polymarket contract for “Bitcoin above $65,000 at 9 PM”
paired with a broad Kalshi Bitcoin-price event containing a different
strike/range payoff. Their probabilities need not converge because they are
not the same random variable.

The five cleaner observations were J.B. Pritzker, Rahm Emanuel and Andy
Beshear 2028 Democratic nominee pairs. None had an executable bid-side exit
at five minutes, 30 minutes or one hour, and none is settled. Even if their
rules prove equivalent, roughly $4.90 was tied up to seek only $0.07–$0.12
before long-dated rule, funding and venue risk. They do not establish a
profitable convergence rate.

The separately frozen resolver-risk terminal-carry V2 arm has one settled
entry: -$0.33 ordinary, -$0.42 at 2x cost and -$0.56 after its full orphan
reserve. One observation is not a conclusion, but it provides no positive
support yet.

## What remains worth testing

### 1. Exact-rule, short-duration convergence

Build the candidate key from venue, underlying, predicate, comparator, strike,
observation timestamp/timezone, resolver, fallback rule and settlement
precision. A hard mismatch must veto eligibility regardless of text score.
Only short-duration, executable pairs should enter the convergence trial.

Freeze one early-release rule before collecting outcomes: five equal shares,
1% net target, one-hour maximum, terminal fallback only when rules are
certified. The 1% level is provisional because the present grid inspected it.
Require 300 fresh pair-direction-days and 30 days.

### 2. Ordered-strike payoff graph

Different strikes should not be title-matched as equivalents. They should be
represented as logical implications. For two “above” contracts with
`K1 < K2`, the verifier knows `X > K2` implies `X > K1` and can enumerate all
valid terminal states. Only trade a bundle whose minimum state payoff exceeds
the executable cost after 2x fees, ticks and orphan reserve. This converts a
matching defect into a potentially certifiable structural-arbitrage search.

### 3. Resolver-risk carry

Continue V2 unchanged. It explicitly models same-risk-class historical venue
agreement, a conservative lower bound, duplicated costs, unresolved capital
and an orphan reserve. Split Chainlink, CF Benchmarks and other resolver
classes; never pool them. The arm remains paper-only until 300 fresh units,
30 days and both chronological halves are positive under the full hurdle.

### 4. Passive-entry exact pairs

Once exact short-duration pairs exist, test a separate queue-aware arm that
rests one post-only leg and crosses the hedge only after an authenticated
fill. This may reduce fee drag, but it introduces adverse selection and leg
risk. Score partial fills, cancel acknowledgement and forced unwind; do not
reuse the taker replay as evidence for it.

### 5. Provisional middle-residual successor

The 1–3% entry bucket was the only cohort close to breakeven under full stress.
There is a mechanism for a band: tiny gaps cannot cover four executions,
while very large gaps often indicate rule mismatch rather than free money.
If tested, register the band prospectively, retain both directions, require
hard-mismatch-free rules and do not combine its results with this discovery
sample.

## Required fixes before interpreting more data

1. Make every hard payoff mismatch an automatic paper-entry veto. A title
   score above 80% is useful for review priority, not trade eligibility.
2. Fetch and persist the exact Kalshi fee schedule applicable to each market
   instead of assuming the general multiplier.
3. Add displayed-depth replays at 5, 10 and 25 shares. The fixed five-share
   tape cannot support claims about $50/$100 orders or $500 scaling.
4. Report capital-duration return, event/day concentration and worst orphan
   loss beside win rate.
5. Keep the certified terminal-identity lane separate from risky statistical
   convergence in the dashboard and database.

## Reproducible artifacts

- Replay: `node scripts/crossvenue-risky-convergence-pnl.js --days=30 --json`
- VPS result:
  `/var/lib/deltaforge/reports/crossvenue-risky-convergence-2026-07-25-v3.json`
- Terminal carry: `node scripts/crossvenue-terminal-carry-report.js --json`

The replay tool and tests are in commit `ce1e439`. The complete test suite
passes 447/447.
