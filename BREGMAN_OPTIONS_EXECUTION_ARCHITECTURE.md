# TV2 logical-arbitrage, option-surface and multi-leg execution specification

Frozen implementation date: 2026-07-18. Runtime scope: TV2/BORG. Every new
component in this specification is paper/shadow only and has no wallet, signer,
authenticated order channel or live-order method.

## 1. Logical state model

For one connected component of logically dependent contracts, let

- `Omega = {omega_1,...,omega_m}` be every settlement state permitted by the
  certified contract rules;
- `A[omega,j] in {0,1}` be the payout of one share of token `j` in state
  `omega`;
- `pi in Delta_m` be a distribution over permitted terminal states; and
- `mu = A^T pi` be a coherent vector of token marginals.

The no-arbitrage marginal polytope is

```text
M = { mu : mu = A^T pi, pi >= 0, 1^T pi = 1 } = conv{A[omega,:]}.
```

For a genuinely mutually-exclusive and exhaustive state-price vector, the
requested simplex divergence is used directly:

```text
D_KL(mu || theta) = sum_i mu_i log(mu_i / theta_i),
sum_i mu_i = sum_i theta_i = 1.
```

Arbitrary prediction-market event marginals overlap and do not sum to one.
Normalizing them would change their meaning. Their projection therefore uses
the separable Bernoulli Bregman divergence

```text
D_B(mu || theta) = sum_j w_j [
    mu_j log(mu_j/theta_j)
  + (1-mu_j) log((1-mu_j)/(1-theta_j))
].
```

The corresponding gradient is

```text
g_j = w_j [logit(mu_j) - logit(theta_j)].
```

`theta` is a fresh midpoint used to rank logical incoherence. It is never the
execution benchmark. The execution benchmark is the complete ask depth for a
buy and complete bid depth for an unwind.

### Pairwise Frank-Wolfe projection

The implementation in `borg/structural/bregman.js` uses the following
pairwise Frank-Wolfe iteration:

```text
input: permitted payoff rows A[omega,:], quoted marginals theta
pi <- uniform over Omega
mu <- A^T pi

repeat:
    g <- logit(mu) - logit(theta)
    s <- argmin_{omega in Omega} <A[omega,:], g>       // LMO
    v <- argmax_{omega: pi_omega > 0} <A[omega,:], g> // away atom
    gap <- <mu - A[s,:], g>
    if gap <= tolerance: stop
    d <- A[s,:] - A[v,:]
    gamma <- argmin_{0 <= x <= pi_v} D_B(mu + x*d || theta)
    pi_s <- pi_s + gamma
    pi_v <- pi_v - gamma
    mu <- mu + gamma*d

output: coherent mu, pi, D_B, residual theta-mu, dual gap
```

The line search is an exact one-dimensional convex bisection on the directional
derivative. The current payoff compiler enumerates terminal states and fails
closed above 12 predicates. A production scanner over larger connected graphs
must replace enumeration with a SAT/MILP linear-minimization oracle:

```text
minimize    sum_j g_j A_j(x)
subject to  x satisfies every certified logical clause
            x_j in {0,1}.
```

The Frank-Wolfe residual is a candidate-ranking statistic, not an arbitrage
profit estimate.

## 2. Executable payoff optimization

Each token leg `l` has ask slices `(p_lk, d_lk)`, a dynamic fee

```text
f_l(p) = rate_l * [p(1-p)]^exponent_l,
```

and a published minimum share quantity. For buy quantities `x_lk`, the exact
displayed-book maximin program is

```text
maximize    z

subject to  sum_l A[omega,l] * sum_k x_lk
            - sum_lk [p_lk + c*f_l(p_lk)] x_lk >= z  for every omega

            0 <= x_lk <= d_lk
            sum_lk [p_lk + c*f_l(p_lk)] x_lk <= budget
            per-leg venue minimum or zero
```

where `c=2` is the frozen fee stress. Venue-minimum disjunctions make the fully
general program a MILP. Certified equal-share identities reduce it to a
one-dimensional problem: enumerate every depth breakpoint and the budget
boundary, walk all legs, and choose the quantity with maximum guaranteed dollar
profit. That exact reduction is implemented now.

```text
for q in {all cumulative leg-depth breakpoints, budget boundary}:
    if q < max(venue minimums): continue
    fills <- walk every ask book to q shares
    cash  <- sum(fill notional + 2x dynamic fee)
    payout_min <- q * certified minimum payout per bundle
    profit <- payout_min - cash
choose q with maximum profit
```

For each possible orphan leg, the scanner separately walks that token's current
bid depth and records

```text
orphan_unwind_pnl_l = bid_proceeds_l - exit_fee_l
                      - entry_notional_l - entry_fee_l.
```

Because separate Polymarket FOK orders are not one atomic transaction, an
economically positive bundle remains `qualified=false` until a separately
reviewed execution study demonstrates acceptable orphan behavior.

## 3. Options-implied binary value

Let `S` be the resolver-consistent spot estimate, `F` the matched-maturity
forward, `K` the Polymarket threshold, `sigma(K,T)` the Deribit implied
volatility, and `T` years to resolution. The lognormal cash-digital value is

```text
d2 = [ln(F/K) - 0.5*sigma^2*T] / [sigma*sqrt(T)]
d1 = d2 + sigma*sqrt(T)
V_yes = exp(-rT) N(d2)
V_no  = exp(-rT) - V_yes.
```

The model Greeks per one YES token are

```text
Delta = exp(-rT) phi(d2) / [S*sigma*sqrt(T)]
Gamma = -exp(-rT) phi(d2) / [S^2*sigma*sqrt(T)]
        * [1 + d2/(sigma*sqrt(T))]
Vega  = -exp(-rT) phi(d2) d1 / sigma.
```

The surface observer subscribes only to calls around each active BTC/ETH
Polymarket threshold:

1. choose Deribit expiries bracketing the Polymarket resolution;
2. choose two strikes below and two above `K` per expiry;
3. interpolate IV linearly in log strike;
4. interpolate total variance `w=sigma^2*T` linearly across expiry;
5. evaluate the digital at Deribit bid, mark and ask IV; and
6. repeat at both ends of a live resolver-basis interval.

If only mark IV exists, the observation is retained with fidelity `D` and can
never be an executable shadow signal. Exact-expiry full IV envelopes are grade
`A`; term-interpolated full envelopes are grade `B`; extrapolations are grade
`C`.

The resolver-basis interval is live, not a constant:

```text
b = 10,000 * (Chainlink_RTDS / Deribit_underlying - 1)
S_interval = Deribit_underlying * [1 + (b-3bp)/10,000,
                                   1 + (b+3bp)/10,000].
```

For a YES buy, conservative edge is

```text
edge_yes = min_surface_basis(V_yes) - executable_ask_yes
           - 2*f_yes(ask) - stressed_hedge_cost_per_share.
```

For a NO buy,

```text
edge_no = [1 - max_surface_basis(V_yes)] - executable_ask_no
          - 2*f_no(ask) - stressed_hedge_cost_per_share.
```

The complete ask is walked, the venue minimum is enforced, and dollar expected
profit—not percentage win rate—is maximized under the frozen $10 research
budget.

### Executable call-spread check

For option premiums already expressed in the strike quote currency, adjacent
call quotes provide the average-digital interval

```text
lower = [C_bid(K1) - C_ask(K2)] / (K2-K1)
upper = [C_ask(K1) - C_bid(K2)] / (K2-K1).
```

Deribit inverse option premiums are expressed in the base asset. The code
requires an explicit base-to-quote multiplier and will not divide BTC premium
by a USD strike width. Because inverse settlement introduces numeraire effects,
this converted call-spread value is a validation envelope, not a claim of an
exact static USD-digital arbitrage.

## 4. Delta hedge and quantified residual risk

For `n` binary tokens and digital delta `Delta`, the target base-asset hedge is

```text
q_raw = -n * Delta                 for YES
q_raw = +n * Delta                 for NO
q_hedge = round(q_raw / lot_step) * lot_step.
```

The intended instrument is a liquid Binance spot or perpetual contract in the
same base asset. A live implementation would add the current executable hedge
book, taker fee, funding through resolution and contract multiplier. V1 charges
a pre-registered 5 bp hedge-notional stress because historical hedge L2 has not
yet been joined to the new surface cohort.

Delta neutrality is local. It does not remove binary gamma, volatility risk,
resolver basis, jumps through the strike, funding, liquidation risk or
non-atomic token/hedge execution. Every candidate therefore stores scenario
PnL

```text
PnL(shock) = n[V_binary(S',sigma',basis') - V_binary(S,sigma,basis)]
             + q_hedge(S'-S) - fees - slippage - funding
```

over spot shocks `{-200,-100,-50,+50,+100,+200}` bp, volatility shocks
`{-20,0,+20}` points and basis shocks `{-10,0,+10}` bp. Worst loss and the mean
worst 5% loss are persisted. They are diagnostics in unlimited paper research,
not hidden by calling the hedge risk-neutral.

## 5. Multi-leg execution state machine

The deterministic reducer in `borg/research/multileg-state-machine.js` uses

```text
IDLE -> VALIDATED -> SUBMITTING -> PARTIAL -> HEDGED -> COMPLETE
                                      |          
                                      +-> UNWINDING -> COMPLETE
                                      +-> HELD_TO_RESOLUTION -> COMPLETE
```

`ABORTED` is legal only before inventory exists. A partial fill can never be
deleted or relabelled as an abort.

For two legs, define Markov states

```text
[N, L0, L1, H, U, R, F]
= [no fill, only leg 0, only leg 1, hedged, unwound, held, failed].
```

With next-interval fill probabilities `p0,p1` and a WAIT policy for both orphan
states, the transition matrix is

```text
P = [
 [(1-p0)(1-p1), p0(1-p1), (1-p0)p1, p0p1, 0, 0, 0],
 [0,             1-p1,      0,          p1,   0, 0, 0],
 [0,             0,         1-p0,       p0,   0, 0, 0],
 [0,             0,         0,          1,    0, 0, 0],
 [0,             0,         0,          0,    1, 0, 0],
 [0,             0,         0,          0,    0, 1, 0],
 [0,             0,         0,          0,    0, 0, 1]
].
```

For an UNWIND policy with executable-unwind probability `u`, replace the
corresponding orphan row by `[0,0,0,0,u,0,1-u]`. For HOLD, replace it by
`[0,0,0,0,0,1,0]`.

The orphan action is selected from executable values:

```text
V_wait   = p_hedge * locked_profit
           + (1-p_hedge) * V_orphan_next
           - inventory_penalty - wait_cost
V_unwind = executable_bid_proceeds - entry_cost - all fees
V_hold   = posterior_terminal_value - entry_cost - hedge/funding cost
           - residual-risk penalty

action = argmax{V_wait, V_unwind, V_hold}.
```

Paper mode records every action value and may evaluate policies without an
imaginary bankroll cutoff. Any later live canary must pre-register a finite
orphan-loss/CVaR limit and cannot inherit a paper-only unlimited-risk setting.

### Submission pseudocode

```text
snapshot <- immutable books, fee schedules, source clocks, clock uncertainty
proof    <- compile settlement states and verify minimum payoff
plan     <- solve depth/capacity program
if proof invalid or plan.profit_2x <= 0: reject
if any snapshot stale or sequence-gapped: reject

state <- VALIDATED(plan)
append intent to durable local WAL

// Same-venue structural bundle
submit one batch containing per-leg FOK orders when supported
// batching reduces transit skew but is not atomic

state <- SUBMITTING
for each authenticated fill/ack event:
    append event to WAL
    state <- reduce(state,event)
    if state == PARTIAL:
        cancel every unfilled stale leg
        values <- Bellman orphan action using current executable books
        state <- reduce(state, CHOOSE_ORPHAN(argmax(values)))

// Option-implied directional trade
after token fill:
    submit rounded hedge immediately at protected executable limit
    if hedge rejects or partially fills:
        treat unhedged delta as an orphan state; never assume the hedge exists

persist asynchronously; PostgreSQL is not on the submission path
```

Polymarket FOK is all-or-none per order, FAK may partially fill then cancel,
and post-only is restricted to GTC/GTD. A batch can reduce skew but does not
create cross-order atomicity. A cross-venue Polymarket/Kalshi/Deribit/Binance
bundle is necessarily non-atomic.

## 6. Event and persistence architecture

```text
Deribit 100ms ticker WS ----+
Polymarket market WS -------+--> append-before-parse WAL --> in-memory books/surface
Chainlink RTDS WS -----------+                                |
Binance hedge WS (next arm)-+                                v
                                               deterministic valuation/proof
                                                            |
                                     +----------------------+----------------+
                                     |                                       |
                              shadow marks/state                    future reviewed order FSM
                                     |                                       |
                              async local PostgreSQL                 authenticated fill channel
                                     |
                           Parquet compaction + off-host archive
```

Every event retains source time, receive wall time, monotonic receive time,
connection epoch, event sequence and WAL event ID. Full-rate raw events are the
replay source; PostgreSQL stores compact one-second option touches and shadow
marks. Information delay and order delay must be replayed independently at
20/50/100/250/500 ms.

## 7. What the current evidence permits

The prior flat-DVOL threshold proxy produced 31 wins from 34 selected trades,
but lost `$31.870707` after doubled fees on `$339.828` turnover. Its two halves
were `+$0.224770` and `-$32.095477`; the event-clustered 95% interval was
`[-$3.009163, +$0.015143]`. This rejects the tempting interpretation of the
91.2% hit rate as a profitable strategy.

The prior structural scanner's 69,184 apparently economic rows were entirely
generated by three invalid pairs: a September/December public-appearance date
pair, an election-margin pair and a September/December territorial-capture date
pair. Generic `$1 if Yes` settlement text was incorrectly allowed to turn those
labels into crypto price ladders. Those rows are not evidence and are excluded
by the versioned V2 manifest.

The database did not historically collect full Deribit strike/expiry surfaces,
so a retrospective full-surface backtest cannot be manufactured from DVOL.
Forward evaluation begins only after the new raw surface collector. Both V2
structural coherence and V1 option-surface strategies require at least 300
fresh independent markets, both chronological halves positive under doubled
costs, and market/day-clustered lower confidence bounds above zero. Zero edge
is an explicitly valid result.
