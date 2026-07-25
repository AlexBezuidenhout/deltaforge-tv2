# TV2 profitability report — 25 July 2026

Evidence cut: 25 July 2026, 15:58 UTC. Money figures are USD. Unless stated
otherwise, paper PnL is based on causal executable depth and the strategy's
modeled fee/slippage schedule. BORG's displayed evidence uses only rows with
both data-quality and execution-fidelity grades A/B. Strategy arms overlap in
markets, tape and hypothetical bankroll; their PnL must never be added.

## Executive verdict

TV2 has found several candidate effects and two small structural pricing
anomalies, but no strategy has yet demonstrated a statistically credible,
live-deployable edge. The strongest current forward BORG strategy, H43, is
negative after doubled costs. H24, H40 and H44 are legitimate positive
historical paper cohorts worth freezing unchanged as new hypotheses, but they
contain only 25–67 independent markets, cover three days, were observed after
their prior governance decisions, and have Holm-adjusted p-values of 1.00.
They are leads, not proof.

This is not the same as finding nothing. The platform has found:

- positive historical BORG cohorts that require untouched replication;
- cross-venue dislocations that often revert, but are not contract identities;
- two payoff-graph anomalies with positive displayed economics but excessive
  non-atomic orphan risk;
- one options-implied executable event, which lost money;
- a resolver-boundary mechanism that remains plausible but is currently
  negative in the clean epoch.

The honest bankable estimate from the evidence today is **$0/day**. That is a
measurement conclusion, not a claim that all future edge is impossible.

## Comparable profitability windows

The 6-hour, 24-hour and 3-day columns are entry-time cohorts. A zero means no
eligible trade entered in that interval, not necessarily that the collector
was offline. Current structural, cross-venue and options collectors often
produce observations without an executable or settled trade.

| Programme | 6h | 24h | 3d | Longer evidence | Read |
|---|---:|---:|---:|---:|---|
| MAIN honest executable cohort | $0.00 (0) | $0.00 (0) | $0.00 (0) | −$110.02, 82 closed | Rejected control |
| GEORGE resurrection cohort | $0.00 (0) | $0.00 (0) | $0.00 (0) | −$56.58, 19 closed | Rejected control |
| H53 real-money pilot | $0.00 (0) | $0.00 (0) | $0.00 (0) | −$32.61, 27 fills | Do not resume |
| H43 clean-epoch forward trial, 1× | $0.00 (0) | +$0.49 (1) | −$0.70 (7) | −$0.70, 7 markets | Collecting; no positive edge yet |
| H43 clean-epoch forward trial, 2× | $0.00 (0) | +$0.46 (1) | −$1.23 (7) | −$1.23, 7 markets | Both halves +$7.03 / −$8.25 |
| ETH late-window exact forward | $0.00 (0) | $0.00 (0) | $0.00 (0) | No primary scored fills | No evidence; latency replay was negative |
| Flow late-window V3, 250 ms | $0.00 (0) | $0.00 (0) | $0.00 (0) | −$18.90 1× / −$19.39 2×, 5 fills | Fails frozen rule |
| All-market passive maker | $0.00 (0) | $0.00 (0) | $0.00 (0) | −$1.87, 19 fills | Negative control |
| Reward passive maker | $0.00 (0) | $0.00 (0) | $0.00 (0) | −$24.00, 156 fills | Negative control |
| Paired maker, live-repair arm | $0.00 (0) | $0.00 (0) | $0.00 (0) | −$2,913.72; −$3,400.42 at 2× | Decisively negative |
| Cross-venue certified lock | $0.00 (0) | $0.00 (0) | $0.00 (0) | 0 economic episodes | No lock found |
| Cross-venue terminal carry V2 | $0.00 (0) | $0.00 (0) | $0.00 (0 settled) | 1 open paper entry | Unsettled and not deterministic |
| Certified payoff graph | $0.00 | $0.00 | $0.00 | 2 economic anomalies; 0 orphan-safe | Mechanism valid, execution unsafe |
| Options-implied exact-expiry residual, 2× | $0.00 | $0.00 | −$57.34 (1) | −$57.34, 1 market | Insufficient and negative |
| Pyth resolver-boundary probes | Not additive | Not additive | Not additive | Calibration probes only | No frozen fair-value trade rule |

The legacy MAIN database total of approximately +$696 is excluded: it mixes
older optimistic execution assumptions and is not the honest executable-fill
cohort.

## BORG: promising headlines versus current evidence

The complete 99 strategy/phase report is reproducible with:

```bash
npm run research:profitability
```

It reports historical diagnostics separately from the exact latest frozen
trial in the active collection epoch. Across the current-capital history,
13 arms are positive and 49 are negative at doubled costs; the remainder have
zero eligible fills. None survives family-wise multiple-testing correction.

| Strategy | Historical A/B n | Historical 1× | Historical 2× | Why it is not validated |
|---|---:|---:|---:|---|
| H44 hourly mid-window reversal | 29 | +$106.06 | +$99.08 | Three days; +$113.14 of 2× PnL came from one day; no clean-epoch replication |
| H24 hourly flow breakout | 67 / 66 markets | +$105.25 | +$93.19 | Three days; small family-adjusted sample; no untouched successor |
| H52 hourly near-even favorite V1 | 65 | +$66.18 | +$55.34 | One day; first half −$4.18; accidental market routing; rejected successor |
| H40 directional entropy breakout | 25 | +$49.04 | +$45.24 | Only 25 markets and three days; protocol-completion status |
| H38 passive flow divergence | 46 | +$34.01 | +$27.95 | Second half −$2.68 |
| H15 jump-adjusted sigma | 96 | +$26.39 | +$16.40 | Second half −$3.94 |
| H43 resolver boundary | 24 historical | +$14.95 | +$13.35 | Clean epoch reverses to −$0.70 / −$1.23 |
| H52 15-minute successor V2 | 127 | +$23.07 | +$6.55 | Raw/frozen cohort failed its predefined early-kill and fidelity rules |

The current clean epoch contains eligible PnL only for H43: seven fills in
seven markets over two UTC days. Its 85.7% win rate is misleading because one
BTC loss outweighs several small wins; the Wilson 95% win-rate interval is
48.7%–97.4%, the market- and day-clustered PnL intervals include zero, and the
largest-asset removal test fails.

The largest well-sampled BORG negatives include:

| Strategy | Eligible n | Historical 2× PnL |
|---|---:|---:|
| MAIN V3 robust source envelope | 2,098 | −$1,579.20 |
| MAIN V4 temporal consensus | 1,457 | −$1,092.79 |
| MAIN V2 resolver quorum | 598 | −$561.20 |
| H47 Binance transport arb | 611 | −$502.85 |
| H19 CLOB jump fade | 825 | −$502.03 |
| H33 signed semivariance | 755 | −$471.27 |
| H14 robust volscore | 912 | −$468.44 |
| G_late_arb | 642 | −$301.17 |

Signal inversion is not a valid shortcut for these rows. Entry and exit
spreads, favorite/underdog payoff asymmetry, non-fills, capacity and adverse
selection are not sign-symmetric.

## Cross-venue and structural opportunity inventory

### Polymarket/Kalshi

The latest synchronized sample covers 17,977 snapshots across 589 candidate
pairs, with 112 ms mean and 231 ms p95 pair skew. Only two relations have
manual approval, and neither produced an economic certified episode. Their
best stressed economics were −$0.225 and −$0.261, so there was no terminal
lock to execute.

The broader score-over-80 *similar-contract* paper cohort is the strongest
research lead:

- 116 independent pair-direction-days across 113 pairs;
- 85 reached non-negative executable liquidation after four fee legs;
- 31 remained right-censored;
- estimated probability of reaching non-negative liquidation was 14.8% by
  five minutes, 68.0% by 30 minutes and 84.4% by one hour;
- observed median profitable-exit time was approximately 12.7 minutes.

This is not yet a profit result. “Reached zero or better” does not measure the
profit target, the 31 censored positions do not yet carry forced-exit losses,
and rule/resolver mismatches can create terminal loss. The next frozen
backtest must use fixed +$0.05 and +$0.10 per-pair targets, forced exits at
1h/6h/terminal, shared $500 capital and explicit mismatch loss.

### Certified payoff graph

The scanner evaluated roughly 756,000 state/bundle observations. It found two
unique complete-mutually-exclusive anomalies with positive displayed
doubled-cost economics:

- approximately +$0.08, but $9.62 immediate orphan-loss stress;
- approximately +$0.80, but $1.14 immediate orphan-loss stress.

Both fail non-atomic execution safety. This is a genuine discovery of pricing
inconsistency, but not an executable risk-free arbitrage.

### Options-implied residual

About 914,000 option marks produced 7,010 A-grade surface observations and 31
repeated executable marks, but they all reduce to one independent market. The
first frozen executable event lost $57.34 after doubled costs and hedge stress.
Most apparent opportunities failed because the IV interval was incomplete,
the Polymarket book was stale, or no positive depth remained after costs.

## Why extensive testing has not produced a qualified winner

1. **The market quote is a hard benchmark.** On liquid crypto windows, TV2 is
   usually trading against an automated maker's executable ask, not directly
   against an uninformed retail trader.
2. **Execution removes paper alpha.** Fees, two spreads, queue position,
   partial fills and adverse selection erase many midpoint/model anomalies.
3. **Most observations are not independent.** Thousands of five-second rows
   can represent one market and one economic opportunity.
4. **The search itself creates lucky winners.** With 147 registered trials,
   a 5% uncorrected threshold would produce about 7.35 false-positive lines on
   average even if every strategy had zero edge. Positive discovery PnL is
   therefore expected and is not enough.
5. **True arbitrage has operational risk.** Polymarket/Kalshi legs are
   non-atomic; similar wording is not identical payoff; displayed depth can
   disappear between legs.
6. **The current clean epoch is short and degraded.** It has fewer than the
   required 24 uninterrupted healthy hours and a stale off-host archive
   receipt. That does not fabricate PnL, but it blocks promotion claims.

## Decisions and next work

1. Keep every strategy paper-only. Do not resume H53, G_late or ETH late with
   real money from these results.
2. Register **unchanged** clean-epoch successors for H24 and H40. They have the
   best balance of mechanism, both-half historical PnL and manageable
   falsification cost. Their existing rows remain discovery-only.
3. Continue H43 unchanged to 300 independent markets and 14 days. Do not tune
   around the current BTC loss.
4. Finish the cross-venue fixed-target/forced-exit simulator before interpreting
   the 85/116 convergence statistic as PnL.
5. Continue certified payoff-graph scanning, but qualify a bundle only after
   FOK/depth and worst-case orphan stress remain positive.
6. Continue exact-expiry option collection; do not use DVOL or unsupported
   short-horizon extrapolation as evidence.
7. Repair the evidence epoch's archive/health failures, then treat all prior
   positive discovery lines as hypotheses to replicate, not capital to deploy.

Promotion remains: at least 300 fresh independent markets, the required
calendar duration, positive doubled-cost PnL in both chronological halves,
market/day clustered lower bounds above zero, multiple-testing correction,
positive 100/250/500 ms replay, realistic depth/non-fills, no dominant
market/day/asset and positive shared-$500 capacity. A passing strategy should
still begin with a 50-fill authenticated $1–$2 live canary.
