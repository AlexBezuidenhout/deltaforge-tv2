# Exploitable-edge territory map

Evidence cutoff: **18 July 2026, 19:05 UTC**. This is a research-priority map,
not a return forecast or an authorization to trade. Numerical edge ranges below
are explicitly labelled either observed TV2 evidence or pre-test mechanism
priors. A prior is a hurdle for deciding whether to build a test; it is not a
backtest result.

## Decision in one page

The highest-value research territory is not faster generic prediction. It is a
**rule-certified payoff graph** that can prove what every terminal state pays,
then price the proof against executable, arrival-time depth. The next two lanes
are **rule-aware cross-venue convergence** and **resolver-source boundary
transfer**. All three exploit work that is genuinely awkward—semantic
certification, fragmented capital and settlement mechanics—and all can be
falsified using infrastructure TV2 mostly has already.

The strongest HFT-sounding alternative, CEX liquidation leader-lag, is rejected
as a primary project. TV2's Dublin benchmark measured Polymarket CLOB HTTP RTT
at about **20.1 ms p50**, versus **45.4 ms** from the Mac; Binance HTTP RTT was
about **226 ms**, and authenticated order acknowledgement has not been
measured ([Dublin benchmark](./borg/benchmarks/dublin-vps-2026-07-15.json),
[Mac benchmark](./borg/benchmarks/mac-guernsey-2026-07-15-final.json)). The
current host is useful, but it is not a 1–2 ms host to every venue
and it is nowhere near a professional microsecond stack. The VPS cannot create
alpha that expires before it receives the leader event.

The current evidence also imposes hard priors:

- generic five-minute direction, broad public-flow scalping, generic passive
  making and paired complete-set making are negative after realistic costs;
- same-event crypto strike ladders produced no executable locks in 24,486
  tested pairs;
- the corrected structural scanner has 583 fresh evaluations across 16
  candidates, with **zero economic and zero qualified** bundles;
- the full options-surface trial is collecting, but has **zero executable A/B
  fidelity forward trades**; and
- the Polymarket/Kalshi tape shows persistent per-pair basis, but no forward
  approved episode and inadequate synchronized depth.

These are not reasons to stop. They are reasons to stop rebuilding the same
dead mechanism under a new bot name. Counts and strategy results are traced in
the current [quant edge review](./QUANT_EDGE_REVIEW_2026-07-18.md); the existing
payoff, option and execution mathematics are specified in the
[Bregman/options architecture](./BREGMAN_OPTIONS_EXECUTION_ARCHITECTURE.md).

## First-principles decision frame

Every candidate must fit at least one root:

- **R1 — information propagation:** one executable venue learns before another;
- **R2 — forced flow:** somebody trades because rules, leverage, expiry or
  mandate require it;
- **R3 — segmented capital:** KYC, jurisdiction, chain, collateral or account
  architecture prevents instant arbitrage;
- **R4 — retail-dominant microstructure:** marginal flow is less informed than
  the available professional liquidity;
- **R5 — complexity/attention:** the correct payoff or fair value is costly to
  compute; or
- **R6 — mechanism incentives:** legal fees, rebates, rewards or auctions pay
  for economically useful behavior.

For a directional or convergence trade, the only useful edge is

```text
EV(q, tau) = E[terminal or exit proceeds]
             - executable arrival cost(q, tau)
             - entry and exit fees
             - hedge, borrow and carry costs
             - expected incomplete-fill loss
             - expected venue/oracle/rule loss.
```

For a claimed arbitrage, expectation is not enough. Let `A[omega,l]` be the
payout of leg `l` in permitted state `omega`. A bundle is a lock only if

```text
z(q) = min_omega sum_l A[omega,l] q_l
       - full arrival-book cost(q)
       - 2x fees
       - executable completion/orphan reserve > 0.
```

Midpoints, last trades, EMA prices and independently observed venue snapshots
cannot establish `z(q)>0`.

Latency enters through quote survival, not a VPS label:

```text
net_edge(tau) = gross_edge * P(all required quotes survive to tau)
                - costs - expected orphan loss(tau).
```

The retained-edge percentages in this report are **pre-registered priors to
test**, not measurements. “Tier V” means an actually measured 1–2 ms path to
the relevant venue, not merely a server sold as a trading VPS. Polymarket
documents its primary servers in `eu-west-2` and a nearby eligible region in
`eu-west-1`; its own [geographic eligibility endpoint and restriction
list](https://docs.polymarket.com/api-reference/geoblock) must be obeyed. A VPS
must never be used to evade account, residence or IP restrictions.

## Ranking method

`F` is falsification cost from 1 (cheap) to 5 (expensive), `M` is mechanism
strength from 1 to 5, and `E` is plausible edge at an achievable tier from 1 to
5. Research priority is `(6-F) × M × E`. The score ranks experiments, not
expected return.

| Rank | Territory | Roots | Status | Minimum tier | F | M | E | Score | Current verdict |
|---:|---|---|---|---|---:|---:|---:|---:|---|
| 1 | Certified multi-market payoff graph | R3/R5 | LIVE-CHECKABLE + BUILDABLE | H | 1 | 5 | 4 | **100** | Build/test first; no current lock |
| 2 | Rule-aware cross-venue convergence | R3/R5 | LIVE-CHECKABLE | H | 2 | 5 | 4 | **80** | Persistent basis observed; no proof |
| 3 | Resolver-source boundary transfer | R1/R5 | LIVE-CHECKABLE + CYCLICAL | H | 1 | 4 | 4 | **80** | Best TV2 discovery lead; provisional |
| 4 | Options-implied event binaries | R1/R5 | BUILDABLE/collecting | H | 2 | 4 | 4 | **64** | Correct collector live; n=0 usable |
| 5 | Sports joint-state consistency | R3/R4/R5 | LIVE-CHECKABLE + BUILDABLE | H | 3 | 4 | 3 | **36** | Strong model territory; access cost |
| 6 | Cross-chain stablecoin inventory basis | R2/R3 | CYCLICAL | H | 2 | 4 | 2 | **32** | Real mechanism; small at £1k capital |
| 7 | Intent-auction solver residuals | R5/R6 | BUILDABLE moonshot | V | 4 | 5 | 3 | **30** | Strong mechanism, hard competition |
| 8 | Category-fair, reward-aware prediction making | R4/R6 | CYCLICAL | V | 2 | 3 | 2 | **24** | Generic version rejected; narrow test only |
| 9 | Long-tail protocol liquidation auctions | R2/R3/R5 | CYCLICAL | V | 3 | 4 | 2 | **24** | Main venues crowded; niche only |
| 10 | GPU/compute spot-market relative value | R3/R5/R6 | BUILDABLE | H | 3 | 3 | 2 | **18** | Operational business, not liquid trading |
| 11 | Niche ETF rebalance/closing-auction residual | R2/R5 | CYCLICAL | H | 4 | 4 | 2 | **16** | Testable, but data/access heavy |
| — | CEX liquidation leader-lag HFT | R1/R2 | CYCLICAL | **P** | 4 | 3 | 1 | 6 | **Discard: Tier P in disguise** |

## 1. Certified multi-market payoff graph

**Mechanism — R3/R5.** Human-authored event contracts create logical
relationships: mutually exclusive outcomes, nested thresholds, disjoint ranges,
conditional events and implications across dates. A rule compiler can enumerate
every legally permitted terminal state and map token payoffs into a marginal
polytope. The other side is fragmented retail flow and market makers who price
one book at a time. Money can remain because semantic certification, mutable
clarifications, thin depth and multi-leg execution are expensive relative to
the small capacity. Polymarket's negative-risk adapter makes some multi-outcome
conversions atomic after the tokens are held, including converting one NO into
YES positions on the other outcomes, but augmented events can rename
placeholders and change the scope of “Other”; the official [negative-risk
rules](https://docs.polymarket.com/advanced/neg-risk) therefore become part of
the proof. On 18 July, the first 100 open Gamma events returned 1,239 markets,
956 attached to negative-risk events—a large public graph corpus, not evidence
of mispricing.

**Status — LIVE-CHECKABLE + BUILDABLE.** Gamma supplies event/rule metadata and
the CLOB supplies public books; Kalshi supplies live WebSocket order-book deltas
and a separate [historical market/trade tier](https://docs.kalshi.com/getting_started/historical_data).
TV2 already has a condition graph, payoff proof, Bregman projection, depth walk
and multi-leg state machine. The corrected forward scanner currently reports
583 observations, zero economic candidates and zero qualified candidates. The
mechanism is worth testing because the search space is large and falsification
is cheap—not because a lock exists today.

**Tier and latency.** Minimum **Tier H**. Retained-edge prior: H **70–95%**, V
**85–100%**, P approximately **100%**. Candidate discovery is seconds-to-hours;
completion is the sensitive stage. At 30 ms, simple same-venue FOK bundles may
survive, while cross-venue legs need 100 ms–seconds of explicit stress. At 2 ms,
quote survival improves but non-atomicity remains. Professional colocation adds
little to rule parsing. Run the scanner where CLOB freshness is best; use
separate regional adapters if a Kalshi leg is involved rather than assuming
Dublin is optimal for a US venue.

**Economics.** Pre-test mechanism prior: rare gross residuals of **1–10 cents
per complete bundle**, with a required net hurdle of at least **2 cents per
bundle and $5 displayed worst-case profit** after doubled fees. Likely capacity
is **$10–$2,000 per event**, with most long-tail books near the bottom. Variance
is near zero only after every leg and conversion completes; otherwise the tail
is a naked binary position, semantic mismatch, rule clarification, token
minimum, stale leg or venue outage. Edge decays as makers adopt condition-graph
pricing. Early warnings are a falling candidate rate, residuals disappearing at
the first arrival-delay profile, or profits concentrated in unreviewed/augmented
“Other” outcomes.

**Build cost.** **2–4 weeks** for a strong solo developer because most execution
primitives already exist. Add a versioned rule AST, immutable source/rule hashes,
SAT/MILP state generation for graphs above 12 predicates, and a human
certification queue. The hardest problem is not Frank–Wolfe; it is proving that
the compiled payoff matrix matches the contract rules throughout their life.

**Falsification.** Freeze one manifest before inspecting PnL. Scan at least 300
independent event graphs over 30 days, record the first candidate per graph,
walk all legs at 20/50/100/250/500/1,000 ms, enforce venue minimums and doubled
fees, and score every orphan state. Primary metric: total worst-case executable
PnL at 250 ms; secondary: candidate and capacity rate per 1,000 graph-hours.
Kill the commercial lane if 300 graphs and 30 days produce no bundle with at
least $5 stressed displayed profit, or if semantic/proof failures exceed 1%.
Even a detected lock does not authorize live execution until at least 50
multi-leg canary cycles establish completion and orphan behavior.

## 2. Rule-aware cross-venue convergence

**Mechanism — R3/R5.** Economically similar contracts can trade at different
probabilities because users, collateral and jurisdiction are segmented across
Polymarket, Kalshi and sports exchanges. The trade is not automatically an
arbitrage: titles that sound identical can differ on source, deadline, voiding,
rounding, revisions or edge cases. For certified equivalents, buy the cheap
outcome and the opposite expensive outcome only when either terminal payoffs
lock a profit or a pre-registered convergence exit has positive EV. The other
side is venue-specific retail/hedging flow. The basis can persist because
capital must be prefunded on both venues and legs cannot be submitted atomically.

**Status — LIVE-CHECKABLE.** Kalshi's current WebSocket exposes order books,
trades, fills and market status through its [official streaming
API](https://docs.kalshi.com/getting_started/quick_start_websockets); Polymarket
exposes public books and market metadata. TV2 has observed per-match median
bases around 1–16 cents and p90 basis episodes around 16 minutes, but the tape
had about 41.9 seconds mean observation skew, only one approved relation and
zero forward approved episodes. That is evidence of a capture/matching problem,
not profitable execution.

**Tier and latency.** Minimum **Tier H** for multi-minute convergence. Retained
edge prior: H **80–100%**, V **90–100%**, P no material gain. A 30 ms versus
2 ms reaction is irrelevant when a basis persists for minutes; it matters when
the second leg is exposed. Stress information and order delay separately at
30 ms, 250 ms, 1 s, 5 s and 30 s. Kalshi's matching path should be measured from
a US region and compared with Dublin. The correct topology may be two regional
order adapters behind one deterministic coordinator.

**Economics.** Pre-test prior: **0.5–5 cents net per matched contract** after
current venue fees, with **$25–$2,000 per side** of accessible capacity and
holding periods from seconds to days. Kalshi's published general taker formula
is `0.07*C*P*(1-P)` rounded up, with maker fees on designated markets in its
[current fee schedule](https://kalshi.com/docs/kalshi-fee-schedule.pdf);
Polymarket fees must be read from each market's live fee schedule, not a fixed
constant. Variance is low only for certified payoff identities; convergence
trades retain basis and mark-to-market risk. Tails are semantic disagreement,
one venue suspending, capital trapped to resolution and one leg filling alone.
Edge decays when professional cross-venue market makers enter. Warning tells:
shorter dwell, basis dominated by one stale venue, and realized exits occurring
only at resolution rather than convergence.

**Build cost.** **2–4 weeks**. Upgrade the existing matcher from text similarity
to a rule ontology with effective date, source, timezone, revision and void
clauses; ingest synchronized depth; and add a two-venue execution state machine.
The hardest problem is adjudicating “equivalent enough” without allowing an LLM
to approve economic identity.

**Falsification.** Manually certify 100 pairs before seeing their forward PnL.
For 30 days, record first basis entry per pair/day, both arrival books, full fees,
capacity, convergence time and resolution. Primary metric: PnL from a frozen
maximum-holding exit, clustered by event; report true payoff locks separately.
Kill if 50 resolved certified pairs do not produce positive doubled-cost PnL in
both halves, if median capital lock exceeds the registered horizon, or if more
than 1 in 200 manual audits reveals a material settlement mismatch.

## 3. Resolver-source boundary transfer

**Mechanism — R1/R5.** A market settles against an explicit external source,
but participants watch proxies, UI prices or the wrong timestamp. The fair
state immediately before a boundary is therefore the resolver-consistent source
relative to the fixed opening/strike value, including update cadence, carry
forward and tie rules. The other side is stale passive liquidity or directional
holders who price the narrative rather than the exact resolver. The edge is
left at retail-accessible size because every market family has different rules,
capacity is thin and the profitable window may be only seconds. Polymarket's
[RTDS](https://docs.polymarket.com/market-data/websocket/rtds) now streams
Chainlink crypto plus Pyth-sourced equities, ETFs, FX, metals and commodities,
and publishes price-to-beat endpoints; the rules—not the title—still determine
resolution through the [UMA process](https://docs.polymarket.com/concepts/resolution).

**Status — LIVE-CHECKABLE + CYCLICAL.** TV2's final-ten-second absorbed-flow
discovery showed +$31.95 after doubled entry fees across only 18 markets, but
the rule was selected after inspecting the data and its confidence bound did
not clear break-even. H43 is also small and concentrated. These are leads, not
proof. The equity/commodity transfer has no forward history yet.

**Tier and latency.** Minimum **Tier H** for boundaries that remain stale for
hundreds of milliseconds or seconds. Retained-edge prior: H **20–70%**, V
**60–95%**, P **80–100%**. The exact window is empirical: replay source receipt,
decision and order arrival at 2/20/30/50/100/250/500 ms. The existing discovery
subset remained positive at 250 ms but had incomplete replay coverage, so it
argues against a pure microsecond race without proving fillability. Dublin's
measured 20 ms Polymarket RTT is useful here; the relevant source feed may still
arrive elsewhere first.

**Economics.** Observed discovery capacity was about **$10 per market** and a
post-selected rate near **$20/day**, which must be treated as an upper-bound
observation. The broader pre-test prior is **1–10 cents/share after costs** with
**$5–$250 per boundary** in long-tail capacity. Return variance is negatively
skewed: many small wins can be erased by one wrong source timestamp, revision,
tie or stale-book fill. Other tails are oracle outage, late update, rejected
post-boundary order and rule clarification. Edge decays when makers subscribe to
the same resolver feed. Warning tells are faster CLOB repricing, lower quote
survival and PnL concentrated in one asset/source.

**Build cost.** **2–3 weeks** to generalize the existing boundary manifest into
a resolver registry for Chainlink/Pyth/official macro and weather sources. The
hardest problem is exact time semantics: publication time, source observation
time, local receipt, carried-forward values and revisions must never be
collapsed.

**Falsification.** Maintain the current frozen crypto arm and start a separate
Pyth arm with no borrowed ten-second threshold. First causal signal per market,
one position per boundary, doubled fees, executable arrival depth and terminal
outcome. Require 300 independent markets, 30 days, both halves positive,
market/day-clustered lower bounds above zero and at least 90% reconstructable
250 ms arrival states. Kill if the lower bound remains non-positive or more
than half of apparent edge disappears by 250 ms.

## 4. Options-implied event binaries

**Mechanism — R1/R5.** A threshold prediction token is a cash-or-nothing binary
option. A complete CEX option surface contains an externally traded distribution
over terminal price, while event traders often reason from spot direction. A
resolver-consistent digital value derived from bid/ask IV, term interpolation,
skew and source basis can expose a prediction ask outside a conservative value
envelope. The other side is directional retail flow. Money can remain because
digital tails are model-sensitive, expiries rarely align and delta hedging a
near-expiry binary is discontinuous. Deribit provides bid, ask and mark IV plus
the options underlying through its [public ticker API](https://docs.deribit.com/api-reference/market-data/public-ticker).

**Status — BUILDABLE/collecting.** TV2's full-surface collector is running with
Deribit, Polymarket and RTDS WALs. At the evidence cutoff it had zero executable
A/B-fidelity forward signals; the many superficially positive C/D extrapolated
marks are commissioning data, not evidence. The prior flat-DVOL proxy backtest
was negative after stressed costs.

**Tier and latency.** Minimum **Tier H** for hourly/daily expiries. Retained-edge
prior: H **40–80%**, V **70–95%**, P **85–100%**. In quiet markets the residual
can persist seconds; during volatility shocks it may disappear in 50–500 ms.
The relevant host must jointly minimize Deribit surface freshness and Polymarket
order arrival. A 2 ms Polymarket path is useless if the options surface is 200 ms
old.

**Economics.** Pre-test prior: **1–5 cents/share conservative edge** and
**$10–$500** per market, with most hourly books at the bottom. Costs include the
executable prediction ask, dynamic fee, option/perpetual hedge spread, funding,
rebalance and resolver basis. Variance is short-convexity-like around the strike;
tails are smile extrapolation, jump risk, wrong numeraire, hedge slippage and
nonmatching settlement. Edge decays as prediction makers use option surfaces.
Warning tells are profits confined to C/D fidelity, far-tail strikes or one
volatility regime.

**Build cost.** **2–4 additional weeks**. The current model and collector exist;
the missing work is exact/bracketing maturity coverage, executable option
envelopes, causal hedge lifecycle and a resolver-basis archive. The hardest
problem is conservative distribution inference when the prediction expiry lies
inside or outside listed option maturities.

**Falsification.** Keep the frozen `options-implied-binary-v1` trial: first
executable A/B signal per independent market, no hindsight replacement, 300
markets and 30 days. Primary metric is fully hedged PnL after doubled costs;
report token-only and missing-close rows separately. Kill if no A/B signals
appear after the universe spans suitable expiries, or if both-half/clustered
lower bounds are non-positive.

## 5. Sports joint-state consistency

**Mechanism — R3/R4/R5.** One latent score distribution jointly determines
moneyline, draw, totals, both-teams-to-score, team totals, handicaps and many
props. Fit a sport-specific generative model, map each contract's exact rules
onto score states, then compare all executable books simultaneously. The other
side is recreational, team-biased and parlay-oriented flow across separate
venues. Simple arbitrage is not the thesis: Betfair already cross-matches
equivalent positions, including “virtual” prices. The residual must survive
that mechanism and venue commission. The official API notes that virtual prices
can lag non-virtual prices by about 150 ms and explains [cross-matched virtual
bets](https://support.developer.betfair.com/hc/en-us/articles/115003878512-Why-are-the-prices-displayed-on-the-website-different-from-what-I-see-in-my-API-application).

**Status — LIVE-CHECKABLE + BUILDABLE.** Betfair sells timestamped [historical
exchange prices and settlements](https://developer.betfair.com/historical-data-services-api/);
Polymarket publishes sports resolution metadata and Kalshi publishes historical
candles/trades. The public Betfair live API currently requires account approval
and a **£499 activation fee**, according to its [official onboarding
page](https://support.developer.betfair.com/hc/en-us/articles/115003864651-How-do-I-get-started).

**Tier and latency.** Minimum **Tier H** for pregame models. Retained-edge prior:
pregame H **80–100%**, V **90–100%**, P no material gain; in-play H **10–40%**,
V **50–90%**, P **80–100%**. Start pregame. A Dublin host may be useful for
Betfair, while Kalshi may require a US adapter. In-play suspensions and feed
licensing—not raw CPU—become binding.

**Economics.** Pre-test prior: **0.5–3% net ROI on selected pregame positions**
after exchange commission, with **£50–£5,000/event** in liquid leagues and much
less in niche props. Betfair charges commission on net market winnings, so cost
is path- and account-dependent rather than a per-leg constant. Variance is
ordinary sports outcome risk unless a complete payoff bundle locks all states.
Tails include void-rule differences, lineup/news jumps, data-feed errors and
correlated positions masquerading as diversification. Edge decays when models
and books converge. Warning tells: positive results only in thin leagues,
negative closing-line value, or disappearance after league/day clustering.

**Build cost.** **4–8 weeks** plus data/API cost. Build a rule-normalized event
matcher, score-state model, commission-aware portfolio optimizer and exchange
depth simulator. The hardest problem is mapping subtly different handicap,
overtime, abandonment and void rules into the same state space.

**Falsification.** Buy the smallest useful historical sample first. Freeze
leagues, contract families and model before a final season/time holdout. Require
at least 1,000 independent matches, executable back/lay depth, account-specific
commission and both-half performance. Primary metric: post-commission return
versus the closing exchange price; kill if out-of-sample closing-line value is
non-positive or any PnL disappears under rule/void reconciliation.

## 6. Cross-chain stablecoin inventory basis

**Mechanism — R2/R3.** Stablecoin prices diverge across chains when urgent swap,
liquidation or withdrawal flow meets inventory that cannot move instantly.
Pre-positioned inventory can buy cheap on the stressed chain and sell rich on
another, then rebalance through canonical transfer infrastructure. The other
side pays for immediacy. Money remains because bridge finality, chain risk,
inventory financing and operational limits prevent frictionless capital
movement. Circle's CCTP publishes route-specific fees; fast transfer currently
ranges from **0–14 bps**, while standard transfer is generally free but slower,
per the [official fee documentation](https://developers.circle.com/cctp/concepts/fees).

**Status — CYCLICAL.** Quotes, DEX depth, gas, bridge fee and finality are public
and can be shadowed without capital. The mechanism appears during chain stress,
large launches, bridge outages and liquidations; ordinary periods should show
no trade.

**Tier and latency.** Minimum **Tier H**. Retained-edge prior: H **80–100%**, V
**85–100%**, P no meaningful gain. Opportunity half-lives are usually blocks to
minutes. A 2 ms VPS does not win a priority-fee auction; reliable RPCs, private
submission, correct gas bidding and pre-positioned inventory matter.

**Economics.** Pre-test prior: **5–50 bps net** on **$1,000–$100,000** during
normal dislocations; with only £1,000 the dollar return is usually pennies to a
few dollars. Tails dominate: stablecoin depeg, bridge exploit, chain halt,
reorg, destination inventory exhaustion and adverse gas. Edge decays as solver
and bridge liquidity improves. Warning tells are lower net spread after actual
route quotes, longer rebalance time and rising concentration on one bridge.

**Build cost.** **2–4 weeks** for a read-only scanner, 6–10 weeks for hardened
execution. Build per-chain executable quote walkers, inventory ledger,
canonical/fast bridge state and transaction simulator. The hardest problem is
valuing inventory and failure risk during the same stress that creates the
spread.

**Falsification.** Collect every block for 30 days across a fixed set of USDC
routes. Primary metric: maximum simultaneous sell-minus-buy value after DEX
impact, gas, CCTP fee and a registered inventory carry charge. Count only
opportunities lasting long enough for the chosen execution method. Kill if
events above **30 bps net** occur fewer than twice per week or if 95% expected
shortfall from bridge/depeg stress exceeds one year's expected edge.

## 7. Intent-auction solver residuals — BUILDABLE moonshot

**Mechanism — R5/R6.** Intent protocols batch user orders and ask solvers to
construct feasible settlements across AMMs, private liquidity and coincidences
of wants. A solver earns only by producing more user surplus after gas than
competitors. The other side is not an uninformed trader; it is the current
winning optimization stack. An edge could be built by modeling newly deployed
pools, gas-aware route interactions, partial fills and cross-order netting that
baseline solvers miss. CoW describes itself as a permissionless combinatorial
batch-auction protocol, while its current [competition rules](https://docs.cow.fi/cow-protocol/reference/core/auctions/competition-rules)
make winning score and valid settlement explicit. Public APIs expose current
auctions and past solver competitions through the [CoW API](https://api.cow.fi/docs/).

**Status — BUILDABLE, EXPENSIVE-TO-VERIFY.** The data and auction outputs are
public; serious participation requires solver onboarding, bonding/whitelisting,
reliable settlement and competitive optimization. This is the moonshot because
the edge would be the model and optimizer itself, not a known price pattern.

**Tier and latency.** Minimum **Tier V**, but not because 2 ms wins. Retained
edge prior: H **50–80%**, V **70–95%**, P **80–100%**. Auction deadlines are
seconds; route search, simulation throughput, Ethereum state freshness and
builder inclusion dominate. Put compute near Ethereum RPC/builder endpoints and
measure bid submission, not ICMP ping.

**Economics.** Pre-test prior: common auctions likely offer **sub-$1 to a few
dollars** of attainable surplus after gas; rare complex batches may offer
**$10–$100+**. Inventory can be low, but bond, gas and failure capital may be
**$5,000–$50,000**, beyond the current research bankroll. Variance is winner-
take-most: many zero-revenue bids, occasional wins, and slashing/revert tails.
Edge decays as other solvers copy routes. Warning tells are zero score improvement
on recent auctions or all apparent gains disappearing in final-state simulation.

**Build cost.** **8–12 weeks** for a credible baseline, longer for production.
Build an auction replayer, liquidity graph, MILP/min-cost-flow router, gas model,
fork simulator and bidding policy. The hardest problem is finding improvements
within the deadline that remain valid at execution state.

**Falsification.** Replay at least 100,000 public auctions without submitting a
transaction. Compare a frozen solver against the recorded winning score using
the same state and gas assumptions. Primary metric: fraction and dollar surplus
of auctions where the candidate beats the winner after doubled gas. Kill if it
never improves the winner by at least 10 bps and $5, or if improvements cannot
be reproduced on a fork. Only then investigate onboarding.

## 8. Category-fair, reward-aware prediction making

**Mechanism — R4/R6.** A maker can earn spread, taker-funded rebates and explicit
liquidity rewards, but only if a category-specific fair-value feed lets it avoid
toxic fills. The other side is urgency-driven retail flow. The money is not
“maker fees are zero”; it is `spread + actual reward - adverse selection -
inventory/orphan loss`. Polymarket currently pays makers a category-dependent
share of taker fees and documents fee-curve-weighted [maker
rebates](https://docs.polymarket.com/market-makers/maker-rebates); separate
[liquidity rewards](https://docs.polymarket.com/market-makers/liquidity-rewards)
favor balanced, tight, persistent quotes.

**Status — CYCLICAL.** TV2's generic paired maker lost about $710 before
unverified rewards, and Book Lab markouts were negative. Therefore the broad
strategy is rejected. A narrow test is justified only where an independent fair
feed exists—sports exchange odds, official scheduled data, options surfaces—or
where measured rewards alone exceed stressed toxicity.

**Tier and latency.** Minimum **Tier V**. Retained-edge prior: H **0–30%**, V
**50–90%**, P **80–100%**. Quote cancellation needs event-driven books and user
fills; 20–200 ms matters around news. Current Dublin may be adequate for slow
pregame markets but not for globally informed crypto. No database wait belongs
in quote/cancel paths.

**Economics.** Pre-test prior: **5–50 bps of filled notional** after actual
rewards in carefully selected long-tail markets, with **$100–$5,000** inventory.
Variance is strongly negatively skewed because one stale fill can consume days
of spread/reward. Tails are cancel races, event suspension, inventory imbalance
and rewards changing. Edge decays as reward-seeking makers enter. Warning tells:
reward share falls, 1/5/30-second markouts worsen, and profit relies on modeled
rather than credited rewards.

**Build cost.** **3–5 weeks** for one category. Use persistent post-only quotes,
authenticated lifecycle capture, queue-ahead simulation, inventory skew and a
fair-value adapter. The hardest problem is estimating fill toxicity, not quote
placement.

**Falsification.** Select markets before seeing fills; shadow back-of-queue and
record actual public reward configuration and wallet-level credits where
available. Require 300 independent fills and 10,000 quote-minutes. Primary
metric: realized spread + credited reward − 2× adverse markout − orphan cost.
Kill if the market-clustered lower bound is non-positive or if modeled rewards
exceed actual credits by more than 10%.

## 9. Long-tail protocol liquidation auctions

**Mechanism — R2/R3/R5.** An undercollateralized borrower creates forced flow.
The protocol offers collateral at a bonus or through a reverse-Dutch process;
the liquidator wins only if seized collateral minus debt repayment, swap impact,
gas and priority payment is positive. Mainnet Aave is explicitly described as
highly competitive in its [liquidation documentation](https://aave.com/help/borrowing/liquidations),
so the candidate is not “run an Aave bot.” It is a cross-protocol state engine
for new chains, new collateral and dynamic auctions where complexity and
capital segmentation may temporarily exceed searcher coverage.

**Status — CYCLICAL.** All relevant chain state is public and historical blocks
can be simulated. Opportunities cluster during volatility and protocol launches.
The legal activity is protocol-sanctioned liquidation/backstop execution—not
sandwiching ordinary users or abusing private information.

**Tier and latency.** Minimum **Tier V** with a reliable archival/full node or
premium RPC and private bundle path. Retained-edge prior: H **10–40%**, V
**40–80%**, P/private order flow **70–100%**. A 2 ms VPS alone buys little; block
building, priority fees, simulation speed and private order flow decide
inclusion.

**Economics.** Gross bonuses may be several percent, but competitive net edge is
often near zero. Pre-test niche prior: **$5–$500 net per event**, rare larger
events, with flash liquidity or **$5,000–$100,000** working capital. Variance has
fat code/revert/oracle tails. Edge decays immediately as searchers add the
protocol. Warning tells are identical winning addresses, rising builder tips and
bonuses fully consumed by swap impact.

**Build cost.** **6–10 weeks per protocol family**. Build state indexing,
health-factor forecasts, exact liquidation math, DEX route simulation, private
bundle submission and reorg handling. The hardest problem is atomic profitable
execution under the actual block builder's state.

**Falsification.** Replay six months of blocks for two niche protocols. At every
eligibility transition, simulate the best debt/collateral pair, route, gas and a
historical builder-tip stress. Primary metric: residual net profit not captured
by the observed winner. Kill if 99.9% of events are non-positive after doubled
gas/tips or if the same professional searchers capture virtually all positive
events within one block.

## 10. GPU/compute spot-market relative value

**Mechanism — R3/R5/R6.** GPU listings are not homogeneous: nominal GPU model,
memory, PCIe/NVLink, CPU bottleneck, bandwidth, reliability, interruption and
region determine useful work per dollar. A provider or compute buyer with a
live benchmark/SLA model can bid on mispriced capacity rather than compare
sticker prices. The other side is providers using coarse pricing scripts and
buyers screening on GPU name. Vast exposes authorized offer search including
on-demand, reserved and interruptible bids through its [offer
API](https://docs.vast.ai/api-reference/search/search-offers); Akash providers
compete through bids that usually arrive over **30–120 seconds**, according to
its [marketplace documentation](https://akash.network/docs/learn/core-concepts/providers-leases/).

**Status — BUILDABLE.** This is an operational marketplace edge, not a liquid
financial arbitrage. It requires owned hardware, permitted subleasing or a real
internal compute workload. Do not assume capacity can be re-sold across services
without explicit terms and technical permission.

**Tier and latency.** Minimum **Tier H**. Retained edge H/V/P: approximately
**100%/100%/100%**; milliseconds are irrelevant. Data quality, automated
benchmarking and uptime matter.

**Economics.** Pre-test provider target: **15–30% contribution margin** after
power, depreciation, platform fees and downtime, with **$2,000–$50,000** hardware
capital. A compute buyer may save 10–40% versus its own baseline but does not
create cash PnL without a workload/customer. Tails are hardware failure,
chargebacks, token/settlement volatility, poor occupancy and benchmark gaming.
Edge decays when providers adopt workload-aware pricing. Warning tells are
occupancy below 50%, maintenance costs above model and price compression within
hardware cohorts.

**Build cost.** **4–8 weeks** for a data/benchmark engine; hardware operations
are ongoing. The hardest problem is a portable benchmark that predicts customer
throughput and failure probability rather than synthetic headline speed.

**Falsification.** Collect authorized offer/bid snapshots for 30 days, rent a
small stratified sample under a capped **$200** research budget, and benchmark
real workloads. Primary metric: out-of-sample useful compute per all-in dollar
and simulated provider margin at observed occupancy. Kill if the model cannot
predict throughput within 10% or risk-adjusted provider margin is below 15%.

## 11. Niche ETF rebalance and closing-auction residual

**Mechanism — R2/R5.** Passive funds and ETFs must execute creations,
redemptions, index changes and rebalances even when the closing auction is
temporarily expensive. Broad Russell/MSCI reconstitution is professional and
crowded; the plausible retail-accessible territory is smaller custom/thematic
ETFs, closures, corporate-action substitutions and low-attention names where
public portfolio changes imply a meaningful fraction of auction volume. The
other side is forced passive flow. Nasdaq disseminates the Net Order Imbalance
Indicator from 15:50 to 16:00 ET for its [closing
cross](https://www.nasdaqtrader.com/Trader.aspx?id=OpenClose), while US ETF rules
generally require free daily portfolio disclosure under [SEC Rule
6c-11](https://www.sec.gov/rules/final/2019/33-10695.pdf).

**Status — CYCLICAL, EXPENSIVE-TO-VERIFY.** Daily holdings are public issuer by
issuer; reliable historical holdings, corporate actions, borrow and auction
imbalance data are fragmented or paid. Brokerage, short-sale, market-data and
jurisdiction eligibility must be confirmed before any trading test.

**Tier and latency.** Minimum **Tier H** for day-ahead flow forecasts. Retained
edge prior: H **70–100%**, Dublin V **70–100%**, NJ professional **90–100%**.
The slow thesis submits LOC/MOC intelligently; reacting to the final 5-second
NOII updates is Tier P and should not be attempted from Dublin.

**Economics.** Pre-test prior: **5–30 bps net** in selected small names with
**$5,000–$100,000** capacity, too capital-intensive for the current £1,000
research bankroll. Variance includes overnight/news risk, borrow recall, auction
impact reversal and a rebalance estimate being wrong. Edge decays through
crowding and fund growth. Warning tells are increasing pre-close anticipation,
lower residual imbalance after public disclosure and edge confined to
unshortable names.

**Build cost.** **6–10 weeks** plus market-data/broker costs. Build daily ETF
holding normalization, creation-basket diffs, corporate-action adjustment,
auction feed capture and a realistic LOC/MOC simulator. The hardest problem is
reconstructing what was knowable before the close, not fitting post-close
returns.

**Falsification.** Observe 60 sessions without capital across a frozen universe
of niche ETFs. Predict signed auction demand before NOII, then score arrival-time
LOC/MOC fills and 5-minute/next-open exits after spread, fees and borrow. Kill if
out-of-sample net edge is below 5 bps, if it is absent in both chronological
halves, or if it survives only using final NOII information unavailable to the
order.

## Discarded HFT territory: CEX liquidation leader-lag

**Mechanism — R1/R2.** A liquidation burst on a price-leading perpetual venue
can force a second venue to reprice. The other side would be stale makers on the
lagger. Binance's official connector exposes the `forceOrder` liquidation
snapshot stream, while Hyperliquid exposes trades, books, funding and account
liquidation events through its [official WebSocket
API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions);
the event is real.

**Status — CYCLICAL; discarded.** On major pairs, the competitor set includes colocated
market makers with direct/SBE/FIX feeds and microsecond stacks. Public Binance
liquidation snapshots can aggregate or publish only the latest event in a time
window, making them confirmation rather than an earliest signal.

**Tier and latency.** Minimum **Tier P**. At 30 ms, the obvious move is generally
complete. An actually measured 1–2 ms path might
retain **0–10%** of gross edge on obscure lagging venues; TV2's measured Dublin
path to Binance is far slower, and Polymarket is about 20 ms rather than 2 ms.
On-chain variants are builder/priority auctions, not network-ping races.

**Economics.** Pre-test economics are sub-basis-point after taker fees, perhaps
**$100–$10,000** of fleeting displayed capacity, with severe adverse selection,
outage and liquidation-cascade risk. Faster competitors and direct feeds crowd
it out; a falling opportunity half-life is the early warning.

**Build cost.** **Four weeks** for a dual-venue timestamp/capture study; a real
Tier-P execution stack would be materially more expensive and is out of scope.
The hardest problem is establishing causal source receipt and comparable
arrival books rather than comparing exchange timestamps with different clocks.

**Falsification.** Reconstruct lagger arrival books at 2/5/10/20/30 ms after
leader receipt. Kill—and expect to kill—if median opportunity half-life is under
5 ms or net depth is zero at 2 ms. Do not build execution first.

## Top three to pursue with the current VPS and engineering base

1. **Certified payoff graph.** It has the strongest mechanism, the cheapest
   falsification and the best reuse of TV2. It can discover true locks without
   pretending to forecast.
2. **Rule-aware cross-venue convergence.** Existing basis dwell is measured in
   seconds to minutes, so lack of microsecond colocation is not fatal. The next
   bottleneck is identity and synchronized depth.
3. **Resolver-source boundary transfer.** It has the only encouraging TV2
   discovery cohort and a large new Pyth universe, but must pass a fresh frozen
   trial.

Continue the options-surface collector as a fourth parallel data lane because
the marginal collection cost is low. Do not divert core engineering into HFT,
generic making or a funded DEX liquidator before the top three are falsified.

## 30-day plan for rank 1

### Days 1–3 — freeze the legal payoff universe

- Register `condition-graph-v3` with source commit, rule schema, fee version,
  arrival profiles and a 30-day evidence clock.
- Select four predeclared families: standard negative-risk events, ordered
  thresholds, disjoint/exhaustive ranges and manually approved cross-venue
  identities.
- Archive every rule text, resolution source, clarification and metadata change
  with content hash and effective time.
- Exclude augmented placeholders and “Other” until separately certified.

### Days 4–7 — prove payoffs before pricing

- Compile rules into predicates and terminal states; use SAT/MILP once state
  enumeration exceeds 12 predicates.
- Generate a machine-checkable payoff matrix and a human review diff.
- Unit-test each identity with adversarial states: ties, postponements, voids,
  revisions, unnamed outcomes and source failure.
- Fail closed on ambiguity. An LLM may propose a relation but cannot approve it.

### Days 8–14 — executable market plane

- Subscribe only through healthy event-driven venue feeds; preserve source,
  receive and monotonic times plus connection epoch and gaps.
- Walk every leg's full depth at 20/50/100/250/500/1,000 ms.
- Apply live per-market fees, venue minimums, FOK/post-only rules, capital lock
  and every orphan unwind.
- Persist Bregman/KL residual as a ranking feature, never as claimed profit.

### Days 15–21 — blind shadow execution

- Take the first qualified candidate per independent event; no best-in-hindsight
  replacement and no threshold changes.
- Run the multi-leg state machine through ACK, partial fill, cancel and unwind.
- Manually review every qualifying relation without exposing forward PnL to the
  reviewer.
- Publish capacity curves and rejection reasons, including zero-opportunity days.

### Days 22–30 — decide, do not tune

- Primary result: worst-case PnL after doubled fees at the 250 ms profile.
- Report independent graphs, qualified episodes, completion rate, orphan CVaR,
  both chronological halves, market/day clusters and semantic audit failures.
- **Pass to tiny canary research only if:** at least 300 independent graphs and
  50 qualified shadow cycles; positive stressed PnL in both halves; no payoff
  proof failure; at least 99% state-machine completion or bounded orphan CVaR;
  and at least $5 median displayed profit per qualified episode.
- **Kill/commercially deprioritize if:** no qualified bundle after 300 graphs and
  30 days, all residuals disappear at 250 ms, or semantic/orphan loss consumes
  the lock.

If sample requirements are not reached by day 30, the result is
`INSUFFICIENT_EVIDENCE`, not a pass and not a reason to loosen thresholds.

## Best pick at Tier H only

**Rule-aware cross-venue convergence** is the best home-tier project. The
observed basis episodes can last minutes, so 30–50 ms networking preserves most
of the hypothesized edge. Contract identity, exit horizon, fees and capital
segmentation dominate. The certified same-venue payoff graph is a close second;
resolver-boundary trading loses more opportunity as latency rises.

## Famous-sounding ideas deliberately excluded

| Idea | Kill reason |
|---|---|
| Simple YES + NO below $1 | Widely scanned; arrival depth, fees and non-atomic legs erase displayed midpoint identities. |
| Basic Polymarket/Binance 5-minute lag | Current TV2 direction cohorts are negative and professional makers observe the same public spot move. |
| Flip every losing bot signal | Costs and selection are not antisymmetric; reversing a bad taker often creates another bad taker. |
| Copy a profitable wallet | Public fills arrive after its decision and omit inventory, hedges, maker queue and capital history. |
| Public-mempool sandwich/front-run | Harmful/legally and ethically unsuitable, builder-auction crowded, and often blocked by private order flow. |
| CEX triangular arbitrage | Major venues internalize it at microsecond scale; retail fees and queue priority dominate. |
| Screenshot funding carry | Funding can flip, basis and borrow matter, and current TV2 evidence supports only small annual carry. |
| Generic passive market making | TV2 measured adverse selection and orphan loss far larger than spread/reward. |
| Broad index-reconstitution trade | Large events are intensely forecast and pre-positioned; only the niche fund implementation lane remains testable. |
| Reinforcement learning on five days of tape | Flexible policy plus tiny dependent sample is a selection engine, not evidence. |
| “AI reads news first” | Public LLM inference is slower and less reliable than primary feeds; settlement-rule parsing is the useful AI role. |
| NFT/game-item arbitrage | Withdrawal locks, transfer restrictions, platform ToS and account risk usually dominate headline spreads. |

## Which candidates I expect to die

The **CEX liquidation leader-lag** should die first because the achievable host
is on the wrong side of the information race. The narrow **reward-aware maker**
also has a poor prior because TV2 already measured toxic fills; it survives only
if a category-specific fair feed changes selection materially. The **niche ETF
close** may die economically because data/access cost and required capital are
large relative to a £1,000 account. The certified payoff graph may simply find
zero trades—that is an acceptable and useful result, not a model failure.

## Data and jurisdiction notes

- Public research data is not trading eligibility. Polymarket publishes an IP
  geoblock endpoint and rejects orders from blocked regions. Kalshi allows many
  international accounts subject to its [member eligibility
  rules](https://help.kalshi.com/en/articles/14026044-can-i-trade-on-kalshi-from-outside-the-united-states),
  but product and reward eligibility differ. Betfair APIs are also region- and
  account-dependent.
- Never route through a VPS to evade residence, KYC, sanctions or venue
  restrictions.
- For all external venues, use dedicated accounts/keys, read-only collection
  first, exact fee schedules and immutable rule snapshots.
- No candidate should enter live capital because of this ranking. Promotion
  requires its own frozen forward evidence and a separate operational canary.

## Bottom line

Plausible edge exists where **payoff semantics, resolver mechanics, capital
segmentation or auction optimization** create work that is expensive relative
to small retail-accessible capacity. It does not plausibly exist merely because
the VPS is faster than a laptop. TV2's best use is to become a proof-and-
falsification engine for the top three territories. If those frozen tests fail,
the honest conclusion is not that thresholds need tuning; it is that the
available edge at this capital and infrastructure tier is approximately zero.
