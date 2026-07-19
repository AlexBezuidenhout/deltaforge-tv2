# Polymarket–Kalshi relation review

**Review date:** 17 July 2026  
**Scope:** manual semantic review of the original 27 contract pairs, plus the
current 41-pair discovery universe  
**Evidence boundary:** 20,458 synchronized observations from 16–17 July 2026;
no live orders were placed

## Decision

**Opportunity verdict:** the ordinary exact-match/parity bot is not worth
trading from this universe: none of the 27 reviewed pairs is a proved exact
identity. The state-conditioned implication engine is worth pursuing and is the
highest-priority cross-venue research line. It found one credible historical
bundle with $55.59 stressed modeled profit, but has zero forward events and is
not live-ready. Generic “convergence” between similar titles remains a risky
basis trade, not arbitrage.

The 27 pairs contain **zero approved exact identities**, but they are not all useless. One pair contains a credible, state-conditioned payoff implication that would have supported a profitable two-leg trade after the scheduled event began. The current identity-only engine misses this class because it asks whether two contracts are identical rather than whether one event logically implies another after observable state transitions.

The strongest historical case is:

> After Trump's speech began on schedule, a Polymarket contract measuring a shorter speech interval lasting at least 30 minutes implied a Kalshi contract measuring a weakly longer interval lasting at least 30 minutes. Buying **Polymarket NO + Kalshi YES** therefore had a minimum ordinary-state payout of $1 per paired share.

At 2026-07-17 01:27:17 UTC, the recorded full-depth counterfactual bought
318.2843 paired shares for $253.4034 including modeled taker fees. It produced
$64.8809 terminal profit under the base cost model and **$55.5908 under the
frozen 2x-fee-plus-two-ticks stress**, a stressed return of 21.94% on deployed
cash. Both contracts subsequently resolved NO, so this particular bundle would
indeed have paid $318.2843.

This is **not realized bot PnL**. Cross-venue submissions are non-atomic and the collector did not submit either order. It is nevertheless stronger than a phantom-book result:

- The paired books were 1,488 ms apart at the selected timestamp and both passed the collector's freshness check.
- The stored Polymarket depth walk covered seven ask levels from $0.70 through $0.86.
- In the 40-second interval around the candidate, Polymarket's public tape records three NO trades totaling 1,307.24 shares between $0.7638 and $0.87.
- In the same interval, Kalshi's public tape records 86 trades; 45 trades totaling 14,669.14 shares printed with YES at $0.01.
- The outcome was not inferred from price: the official market records now show both legs finalized/resolved NO.

That establishes a credible **missed execution candidate**, not a repeatable expectancy estimate. It is one event, selected after examining the data, and cannot be annualized.

## Payoff logic

For binary events `A` and `B`, if `A => B`, the bundle `NO(A) + YES(B)` pays:

| Allowed state | NO(A) | YES(B) | Bundle payout |
|---|---:|---:|---:|
| A false, B false | 1 | 0 | 1 |
| A false, B true | 1 | 1 | 2 |
| A true, B true | 0 | 1 | 1 |

The forbidden state `A=true, B=false` is the only state in which the bundle pays zero. A relation is therefore tradable only when the rules and the already-observed event state rule out that state. Similar wording is not enough.

## Review of all 27 pairs

| Family | Pairs | Actual logical relationship | Correct candidate bundle | Stored result | Decision |
|---|---:|---|---|---|---|
| Corales same-player winner | 16 | Ordinary event predicates match, but no-result deadline, multiple-winner fallback and resolution-source rules differ | Either opposite-outcome pair only if every rule tail is matched | Small raw anomalies disappeared under stress; Adam Svensson's best stressed result was -$0.0158 | Reject as exact arbitrage; retain only as rule-basis research |
| Niklas Norgaard Top 10/20 vs winner | 2 | `win => Top N` | **Poly YES(Top N) + Kalshi NO(win)** | No executable observation of the correct bundle. The displayed Top-20 profit used the opposite bundle and could pay zero for a Top-20 non-winner | Valid relation, no observed trade |
| People's Sexiest Man, same candidate | 2 | Ordinary predicate match; multiple-honoree and no-announcement tails are not proved identical | Opposite outcomes only after all rule tails are reconciled | Connor Storrie: three snapshots, best stressed upper bound +$0.2011; Hudson Williams negative after stress | Discovery lead only; economically immaterial and not a lock |
| World Cup tournament goal vs final goal-or-assist | 3 | Neither event implies the other: a prior goal can make Poly YES/Kalshi NO; a final assist can make Poly NO/Kalshi YES | None | Apparent positive rows are basis trades with terminal mismatch risk | Reject as arbitrage |
| Trump speech duration >=30 | 1 | Once the speech began on schedule, the shorter Polymarket measurement reaching 30 implied the weakly longer Kalshi measurement reaching 30 | **Poly NO + Kalshi YES** | 48 eligible observations deduplicated to one retrospective episode; best $55.5908 stressed on $253.4034; settlement and public prints support the counterfactual | Highest-priority forward strategy class; still not validated expectancy |
| World Cup own goal vs no goal | 1 | `own goal => a goal occurs` | **Poly NO(own goal) + Kalshi NO(no goal)** | 999 fresh correctly oriented quotes; zero positive. Best stressed residual was -$0.8953/share | Valid relation, no economic opportunity |
| First song overall vs Shakira's first song | 1 | Performer scope and qualifying-song definitions permit contradictory outcomes | None without further event-state constraints | The engine's apparent positive rows are not locked | Reject as current arbitrage |
| Closest Senate race vs largest margin in GA/NC | 1 | Opposite operator and different comparison universe; all four joint states are possible | None | Very large displayed “profit” is entirely a predicate mismatch | Reject |

Counts sum to 27.

## Why the speech case is conditionally valid, not an exact identity

Polymarket measured from Trump's first audible podium speech until he finished the address and excluded continued closing thanks. Kalshi measured from the first audible word through the last audible word and included pauses. In an ordinary completed speech, the Kalshi interval is therefore at least as long as the Polymarket interval.

Before the event began, the contracts still had a deadline mismatch: a speech delayed into the extra day allowed by Polymarket could potentially make Polymarket YES while Kalshi was already outside its event window. Once the speech began on schedule, that dangerous state disappeared. The relationship changed from a rule-basis risk to a state-conditioned implication. A production scanner must represent both the contract rules and event state; a static title matcher cannot find this safely.

## Structural scanner defect found and repaired during review

The prior generic condition graph assumed every increasing number behaved like
a monotone price strike. That is false for dates and mixed inequality
operators. Consequently, its 67,965 rows labelled `economic_candidate` were not
trustworthy evidence.

Two concrete failures:

1. `YES(seen by Sep 30) + NO(seen by Dec 31)` is assigned payoff `[1,2,1]`. If the person is first seen in October, both legs pay zero. The correct temporal implication bundle is `NO(earlier) + YES(later)`.
2. `YES(margin <10%) + NO(margin >30%)` is treated as nested. If the margin exceeds 30%, both legs pay zero.

Those immutable rows remain in the database for provenance, but current APIs
exclude them from evidence. The repaired scanner accepts only typed predicates
with a deterministic finite-state payoff proof. Immediately after deployment,
all 16 active candidates had a valid proof; 65 of 65 new evaluations passed the
proof check, while zero were economic and zero were atomic-qualified. The
previous displayed structural profit was a parser diagnostic, not profit.

## Implementation status

Commit `477f710` implements the repair without adding any live-order path:

- A deterministic finite-state compiler now supports equivalence, implication,
  mutual exclusion, exhaustiveness, ordered thresholds and ordinary binary
  complements. Every proof has an enumerated terminal-state payoff vector and
  a stable hash.
- Temporal values and mixed percentage/margin predicates no longer enter the
  ordered-price graph. Below-threshold ladders now orient their legs correctly.
- Structural economics fail closed unless `pass_proof=true`; legacy rows remain
  auditable but cannot contribute to current evidence totals.
- Cross-venue title similarity is now an indicative control only. Economic
  evaluation requires an approved relation, an active state condition, fresh
  books, full-depth capacity and the relation's proved safe bundle direction.
- The speech implication is frozen as a state-conditioned relation with a
  conservative activation timestamp. Replaying after that timestamp yields 48
  overlapping positive observations, deduplicated to **one** independent
  retrospective event. It creates no forward evidence.
- The forward approved-relation cohort contains zero episodes at deployment,
  which is the correct result because the relation was registered after the
  inspected event.
- The collector remains explicitly `PAPER_ONLY_LIVE_DATA`, reports no wallet
  loaded and contains no live-order route. Cross-venue execution is still
  non-atomic.

The focused relation/structural tests pass 28/28 locally and on the VPS; the
full local suite passes 201/201.

## Required design for the next cross-venue engine

1. **Relationship types:** exact equivalence, implication, mutual exclusion, exhaustiveness, ordered threshold, temporal nesting and relative value must be separate types.
2. **Deterministic payoff proof:** generate every permitted joint terminal state and calculate every proposed leg's payout. LLMs may propose a relationship, but may not certify it.
3. **Dynamic state constraints:** immutable observations such as “event started on schedule” can remove previously possible terminal states. Every state update needs a source and timestamp.
4. **Rule-tail checks:** cancellation, postponement, deadline, tie, missing-data, source and fair-value settlement rules remain explicit states.
5. **Correct executable benchmark:** compare minimum payoff with full-depth executable asks plus venue-specific fees, one adverse tick per leg and a second fee charge under stress.
6. **Non-atomic execution model:** record first-leg fill, second-leg acknowledgement, hedge failure, immediate unwind depth and orphan loss. A terminal identity is not an atomic trade.
7. **Episode deduplication:** the 48 proof-active positive speech observations
   represent one event opportunity, not 48 independent trades.
8. **Forward evidence:** freeze the relation engine before looking at future outcomes; require at least 50 genuine relation episodes for operational conclusions and 300 independent events for an expectancy claim.

## Venue constraint

Kalshi's current Member Agreement lists Ireland and the United Kingdom among restricted jurisdictions. The Dublin VPS must therefore remain a research/data host for Kalshi unless Kalshi confirms in writing that the account and execution location are eligible. Do not route orders through a VPN or otherwise attempt to evade a venue restriction. This is an execution blocker, not a reason to stop collecting lawful public research data.

## Sources

- [Polymarket fee schedule](https://docs.polymarket.com/trading/fees)
- [Kalshi real-time order-book stream](https://docs.kalshi.com/websockets/orderbook-updates)
- [Kalshi public trade endpoint](https://docs.kalshi.com/api-reference/market/get-trades)
- [Kalshi historical data](https://docs.kalshi.com/getting_started/historical_data)
- [Kalshi Member Agreement](https://kalshi.com/docs/kalshi-member-agreement.pdf)
