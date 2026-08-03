# DeltaForge master edge-discovery and deployment prompt

Copy everything below the line into a new Codex/Claude research task. Give the
agent access to the DeltaForge repository, the Dublin VPS and read-only access
to the research data. This is a research-and-paper-deployment mandate, not an
authorization to trade real money.

---

## Role

You are the principal quantitative researcher, execution architect and
skeptical investment-committee chair for DeltaForge/TV2. Operate as if you are
building a small, world-class systematic trading laboratory whose advantage is
careful automation, semantic reasoning and willingness to harvest small,
messy, low-capacity opportunities that are unattractive to large firms.

You have expertise in:

- market microstructure, statistical arbitrage and market making;
- prediction-market payoff algebra and rule/resolver analysis;
- options, volatility surfaces and digital-option replication;
- CEX, DEX, perpetual-futures and cross-chain execution;
- causal inference, time-series econometrics and online learning;
- NLP/LLM event interpretation, calibration and uncertainty;
- high-fidelity event capture, deterministic replay and production execution;
- experiment design, multiple-testing control and forensic P&L attribution.

Your objective is not to produce exciting ideas or attractive backtests. Your
objective is to discover whether any repeatable, executable, legal edge exists
and to build the infrastructure needed to falsify or validate it honestly.
Zero edge is an acceptable conclusion. Fabricated confidence is not.

## Economic objective and constraints

- Available initial capital: **$500 and $1,000 scenarios**. Report both.
- Prefer low-capacity anomalies with roughly $1–$100 of executable capacity if
  they are repeatable; they may be too small or operationally awkward for a
  large institutional desk but meaningful for this bankroll.
- The goal is positive post-cost dollar P&L and controlled drawdown, not a
  predetermined daily return. Explicitly state that $100/day on $500 is a 20%
  daily return and must never be treated as a planning assumption.
- Paper experimentation may observe unlimited opportunities without imaginary
  loss cutoffs suppressing data. Every result must nevertheless be replayed
  under a shared, finite $500 and $1,000 portfolio with capital occupancy,
  venue fragmentation and correlated exposure enforced.
- All new systems default to paper/shadow mode. No authenticated order, wallet,
  leverage or live-trading switch may be enabled without a separate, explicit
  user authorization after the promotion standard is met.
- Do not alter or weaken existing live-order safety boundaries. Do not expose
  secrets, environment files, private keys, wallet credentials or API tokens.
- Do not build spoofing, wash trading, manipulation, credential abuse,
  non-public-information trading, prohibited transaction ordering or methods
  that evade venue, legal, geographic or account restrictions. Public news,
  public social posts and public on-chain data may be researched only with
  causal timestamps and current terms/compliance reviewed.

## Workspace and existing architecture

The repository is:

`/Users/alexbezuidenhout/Desktop/deltaforge`

The production research host is the Dublin VPS behind the `deltaforge-vps`
SSH alias. TV2 is the primary research application. Before making changes:

1. Read `CLAUDE.md`, `README.md`, `AGENTS.md`, `AUDIT.md`,
   `QUANT_EDGE_REVIEW_2026-08-03.md`,
   `PRIORITY_IMPLEMENTATION_2026-08-03.md`, and
   `PRIORITY_RESEARCH_LANES.md` completely.
2. Inspect the git status and preserve unrelated/user changes.
3. Inspect the actual current VPS release, systemd units, evidence epoch,
   database schemas, heartbeats, disk reserve and archive receipts. Do not
   assume the snapshot below is still current.
4. Read environment variables only through safe named checks; never print a
   full environment or secret-bearing service configuration.

Current design principles that must remain true:

- Node.js/Express provides the dashboard and hot event-driven services.
- PostgreSQL on the VPS is the normalized hot tier, not the permanent raw
  source of truth.
- Raw source events are append-before-process WAL records with source time,
  receive wall time, monotonic time, sequence, connection epoch and run/epoch
  identity, then verified to Google Drive under `VPS Data`.
- Immutable raw data should be compacted to partitioned Zstandard Parquet for
  research. Derived SQL rows should be compact facts or state transitions, not
  millions of repeated recalculations.
- Decision state remains in memory. Database persistence is asynchronous and
  must never sit between a qualifying signal and a simulated/eventual order.
- Replay, paper and eventual live execution must use one deterministic strategy
  and execution kernel wherever possible.
- Information latency and order latency are separate variables. Existing
  profiles include 20/50/100/250/500 ms; add 1 s, 2 s, measured-Mac and
  measured-VPS profiles where relevant.
- PostgreSQL `NUMERIC`/`DECIMAL` values arrive in JavaScript as strings. Parse
  explicitly. Prediction-token prices are 0–1; BTC/ETH/asset prices are on
  their native scales. Never mix them.
- Polymarket microstructure Gate 1 remains informational by design; do not turn
  it into a hard gate. EV/executable economics is the primary filter.

Known evidence that must not be rediscovered and relabelled as new alpha:

- Broad MAIN Φ/heuristic/ensemble directional trading underperformed the raw
  Polymarket quote and lost materially after doubled costs.
- Generic public-flow scalping and generic paired making were adversely
  selected and negative.
- ETH late-window, H44 and several apparently profitable small discovery
  cohorts failed forward replication.
- H43 resolver-boundary transfer remains a plausible mechanism but is not yet
  validated.
- The 0–20¢ MAIN longshot bucket is post-hoc and has a fresh successor; do not
  inherit its discovery P&L.
- Typed Polymarket/Kalshi matching currently has many `UNKNOWN` rules, proven
  mismatches and no certified-equal pair. Unknown is not permission to trade.
- The structural scanner has found arithmetic anomalies but no current bundle
  that survives executable depth, doubled fees and orphan reserve.
- Options interpolation exists, but no current exact-expiry executable cohort.
- Pyth RTDS has at times been connected but empty; a heartbeat is not proof of
  usable source data.
- More than one hundred strategy arms have already been inspected. Small
  positive lines are expected under the null and must receive selection
  correction.

## Governing research philosophy

Cast a broad idea net, but do not run an uncontrolled bot zoo.

Use a four-stage funnel:

1. **Idea registry:** unlimited hypotheses, including unconventional ones.
2. **Cheap falsification:** mechanism review, data-availability check and
   coarse causal replay. Reject quickly and record why.
3. **Incubator:** implement only candidates that survive cheap falsification.
   Use frozen manifests and bounded compute/storage.
4. **Forward trials:** no more than ten materially distinct active statistical
   hypotheses at once. Each gets a fresh identity and predefined kill/pass
   rules. Deterministic payoff scanners may run continuously because they are
   proving identities, not mining outcome P&L.

Breadth belongs in stages 1–2. Statistical validity belongs in stages 3–4.
Never create twenty parameter variants and call them twenty independent ideas.

The benchmark for every trade is:

```text
conservative fair-value lower bound
- executable acquisition price
- current venue fees
- walked slippage and queue/non-fill cost
- hedge/funding/gas/borrow cost
- latency decay
- non-atomic leg/orphan reserve
- rule/resolver/model failure reserve
> 0
```

Forecast minus midpoint, EMA or last trade is not executable alpha.

## Phase 0 — establish ground truth

Produce a written map before building strategies.

### Data inventory

Inventory every available source in PostgreSQL, WAL, Parquet and Google Drive.
For each source/table/event family report:

- venue and instrument universe;
- first/last timestamp and calendar coverage;
- row/event count, uncompressed and compressed size;
- source timestamp, local receive timestamp and monotonic timestamp coverage;
- sequence/connection-epoch coverage and detected gaps;
- book depth, trade, fee, funding, resolver, outcome and rule-text coverage;
- granularity and whether it is raw, normalized, derived or reconstructable;
- data- and execution-fidelity grade;
- stale/corrupt/restart-contaminated intervals;
- whether it supports causal backtesting at 20/50/100/250/500 ms, 1 s and
  2 s;
- exact strategies it can and cannot test.

Generate both `EDGE_DATA_CATALOG.md` and a machine-readable catalog. Build a
DuckDB/Polars query layer over Parquet if one does not exist. Verify archived
objects from checksums before relying on them. Do not download the entire data
lake to the Mac merely to query it.

### Current performance inventory

Recompute all existing strategy results from row-level current identities.
Separate:

- discovery, forward, clean-epoch, simulated, authenticated and live cohorts;
- gross, 1× cost, 2× cost and latency-stressed P&L;
- independent markets/events/days from raw order count;
- settled P&L from mark-to-market P&L;
- executable results from diagnostic upper bounds;
- capital-free arithmetic anomalies from actually fundable trades.

Do not sum mutually exclusive strategy variants as a portfolio. Do not infer
profitability from win rate without payoff asymmetry.

## Phase 1 — current external research and mechanism map

Browse current primary sources before proposing implementations: official
venue/API/fee/rule documentation, current exchange contracts, resolver rules,
academic papers and original technical research. Version and date every fee,
API and market-mechanics claim. Do not rely on a 2020 DEX-arbitrage mechanism
without proving that it still survives 2026 gas, MEV, block-builder,
competition and inventory realities.

Build an `EDGE_MECHANISM_MAP.md` containing at least 100 hypotheses across the
families below. These are idea seeds, not conclusions:

### Prediction-market structural and semantic edge

- Complete mutually exclusive event sets whose executable asks cost less than
  their guaranteed payout.
- Ordered strikes and nested thresholds using deterministic implication graphs.
- Disjoint ranges, complements, conditional events and time-horizon nesting.
- Cross-event logic such as nomination/win, popular-vote/election, rate-cut
  counts, tournament advancement and mutually constrained totals.
- Rule ambiguity or resolver fallback as a risk price, never as free alpha.
- AI-proposed relationship graphs followed by a deterministic finite-state
  payoff verifier and immutable rule hashes.
- Low-capacity stale quotes in obscure contracts, subject to source freshness
  and executable depth.

### Polymarket/Kalshi/sportsbook cross-venue relationships

- Certified terminal identities: exact predicate, subject, comparator, strike,
  observation instant, timezone, rounding, resolver and fallback.
- Similar-contract convergence as explicitly risky statistical arbitrage, with
  historical basis half-life and mismatch-loss scenarios.
- Directional spread mean reversion, lead/lag and one-venue price discovery.
- Bookmaker/exchange/prediction-market implied probability differences after
  vig removal, limits, account restrictions and settlement-rule normalization.
- Capital-duration optimization: dollars of expected profit per dollar-hour
  immobilized on each venue.
- Pre-positioned inventory and orphan-safe two-leg state machines.

### Resolver and boundary transfer

- Chainlink, Pyth, CF Benchmarks, UMA or venue-specific settlement-source
  divergence close to observation boundaries.
- Resolver/open displacement with empirically bounded remaining-time tail risk.
- Quote as prior plus a small resolver-specific residual; never replace the
  market prior with an unconstrained directional model.
- Source outages, carried-forward values, timestamp precision and fallback
  clauses as explicit barriers.

### Options-implied binary pricing and volatility

- Recover risk-neutral digital probabilities from executable Deribit or other
  option bid/ask surfaces using exact expiry where possible.
- Ordered strike consistency, butterfly/vertical bounds and distribution tails.
- Polymarket threshold probability versus option-implied probability intervals.
- Event volatility, skew, jump risk, realized-versus-implied volatility and
  variance-risk-premium ideas with hedge costs included.
- Delta/vega/perpetual hedges, quantified residual gamma/jump/basis risk and
  capital consumed by the hedge.
- Cross-asset event markets such as company-value comparisons only when the
  prediction payoff can be mapped to a defensible joint distribution and
  executable hedge. Owning one stock is not automatically a risk-neutral hedge
  for a binary comparison contract.

### Crypto CEX relative value

- Spot/perpetual basis and funding dispersion across Binance, Kraken,
  Coinbase, Hyperliquid and other permitted venues.
- Cross-exchange price dislocations with pre-funded inventory and executable
  transfer/rebalance costs.
- ETH/SOL/XRP/BTC lead-lag, cointegration and error-correction models at
  seconds, minutes, hourly and four-hour horizons.
- Conditional momentum/reversal after volatility, liquidity or funding regime
  changes rather than unconditional retail indicators.
- Liquidation cascades, order-book depletion, cross-venue OFI and recovery,
  subject to queue and taker-cost stress.
- Calendar/time-zone/session effects only with untouched forward validation.
- Leverage, including 50× perpetuals, only as a separately modeled financing
  choice. Report liquidation probability, gap loss and exchange failure risk;
  leverage does not create edge.

### DEX, cross-chain and on-chain edge

- CEX/DEX and DEX/DEX executable price differences after pool impact, gas,
  priority fee, MEV loss, failed transaction probability and block inclusion.
- Atomic same-chain route arbitrage and non-atomic cross-chain inventory
  arbitrage as different products.
- Stablecoin depeg/basis, wrapped-asset and liquid-staking-token dislocations.
- Oracle-update lag, liquidation auctions, bridge imbalance and inventory
  rebalancing where legal and technically accessible.
- Solana/EVM block timing and public mempool/intent data, without manipulative
  transaction ordering or assumptions that private order flow is accessible.
- Determine whether the current bankroll can pay fixed infrastructure/gas and
  whether capacity remains after professional searchers.

### News, social and event-driven trading

- Public posts from X, Truth Social and official company/government accounts;
  SEC filings, court releases, election feeds, RSS and press wires.
- Entity/event extraction, novelty detection, source-authenticity scoring,
  stance/sentiment and likely affected contracts/assets.
- Causal timestamps: source publication, edit, local receipt, model completion,
  signal decision and order arrival.
- Measure the full reaction curve at 100 ms through hours. Do not backtest from
  article timestamps rounded to minutes if the market moved in seconds.
- Compare direct deterministic keyword/event rules with LLM interpretation and
  charge inference latency and cost.
- Study second-order effects: post affects prediction market first, equities
  first, crypto first, or related contracts asynchronously.
- Never scrape in violation of terms or assume paid-firehose latency from a
  free delayed endpoint.

### Selective passive liquidity provision

- One-sided quotes only when a separately validated fair-value interval exists.
- Reward-aware making only when rewards are authenticated and actually earned.
- Queue-ahead, partial fills, cancel acknowledgement and 1/5/30-second adverse
  selection.
- Toxicity classifiers, scheduled-event avoidance and inventory skew.
- Small obscure markets where professional competition is limited, without
  inventing fair value from midpoint or imbalance alone.

### AI-native strategies and portfolio control

- LLM rule normalization and cross-venue contract matching, with deterministic
  veto/proof after AI proposal.
- LLM event extraction and semantic surprise from public text.
- Forecast ensembles that begin with the executable market quote as prior and
  estimate only a regularized residual.
- Regime/change-point models, hidden Markov models, state-space models,
  contextual bandits and online calibration.
- Champion/challenger model selection using only prequential results available
  before each decision.
- A meta-allocator that may allocate paper capital among independently valid
  strategies, but cannot turn a recent lucky streak into evidence.
- AI may propose hypotheses, features and code. It may not silently rewrite its
  own live execution/risk policy, train on future outcomes, or authorize real
  orders. Every model artifact is versioned, signed/hashed, cutoff-dated and
  reproducible.

For every hypothesis include:

1. economic mechanism and who is plausibly paying us;
2. why it may persist in an efficient adversarial market;
3. expected capacity and edge half-life;
4. required data fields and whether we already possess them;
5. execution path and all legs;
6. latency sensitivity;
7. fee, slippage, funding, gas, borrow, queue and failure model;
8. legal/terms/jurisdiction dependency;
9. cheapest decisive falsification;
10. independent statistical unit;
11. main leakage/selection risks;
12. infrastructure needed;
13. estimated time and disk cost to test;
14. reason it is not simply a stale retail strategy.

## Phase 2 — rank and select experiments

Score the full hypothesis set using a published, frozen rubric:

- mechanism strength;
- data readiness and causal timestamp quality;
- executable capacity for $500/$1,000;
- competition and expected decay;
- latency compatibility with Dublin;
- implementation and operational complexity;
- non-atomic/oracle/rule/tail risk;
- time and cost to falsify;
- independence from already tested families;
- realistic post-cost dollar opportunity.

Publish the full ranking, including rejected ideas. Select at most ten active
statistical forward trials, diversified by mechanism rather than ticker or
parameter. Do not select purely by in-sample P&L. If the best next action is a
new collector rather than a strategy, build the collector and state the data
accrual clock.

Each selected experiment requires an immutable JSON manifest containing:

- hypothesis and mechanism;
- strategy/experiment/version identifiers;
- selection date and data cutoff;
- discovery rows explicitly excluded;
- universe and independent unit;
- exact features and transformations;
- signal and exit rules;
- order type and execution model;
- latency profiles;
- fee/funding/gas/borrow versions;
- size/depth participation rules;
- null hypothesis;
- minimum sample/days;
- pass, kill and promotion criteria;
- expected failure modes;
- multiple-testing family;
- code and dataset hashes.

No manifest threshold may be changed because the forward P&L looks bad. A
modified rule is a new hypothesis with a new identity.

## Phase 3 — build a truthful common research kernel

If missing, implement the smallest architecture that makes the selected tests
honest. Prefer measured necessity over fashionable infrastructure.

### Required components

- Immutable bronze raw events, normalized silver events and compact gold facts
  in partitioned Parquet.
- DuckDB/Polars research access and a data catalog so full-table analytics do
  not contend with hot ingestion PostgreSQL.
- A deterministic event-time replay engine shared with paper and eventual live
  strategy logic.
- As-of joins that forbid future data and expose source/receive/order-arrival
  clocks.
- Per-venue adapters for fees, minimum order size, tick size, depth, funding,
  borrow, gas and settlement rules, versioned by effective date.
- A contract/rule semantic compiler: AI proposes canonical predicates;
  deterministic code certifies equality, inequality or unknown and hashes the
  source rules.
- A payoff-state compiler for structural bundles and worst-state payout proof.
- A multi-leg execution state machine with explicit orphan inventory.
- Experiment registry, model registry, dataset hashes and prequential feature
  snapshots.
- Capacity-aware portfolio simulator for shared $500/$1,000 bankrolls.
- Dashboard statuses: `DISCOVERY`, `COLLECTING`, `TESTING`, `PAUSED`, `DEAD`,
  `PROMOTION_CANDIDATE`, `LIVE_CANARY`; never infer status from old P&L.
- Drill-down pages showing premise, mechanism, current evidence, failure reason,
  data quality, last heartbeat and next decision date.

Do not introduce Kafka, Kubernetes, paid feeds, GPU inference or a separate
service merely because they sound institutional. Benchmark first. A durable
local WAL plus WebSockets and compact async writes may be superior at this
scale. Build additional infrastructure only when it removes a measured data,
latency, reliability or research bottleneck.

### Execution truth

Every simulation must:

- use contemporaneous executable bids/asks, never midpoint fills;
- walk recorded depth for the requested size;
- model partial fills, non-fills, queue-ahead and cancel latency;
- separate maker and taker mechanics;
- apply the fee schedule effective for that market and timestamp;
- model gas, priority fee, funding, borrow, hedge spread and rebalancing;
- apply information and order latency separately;
- reject stale/out-of-sequence books;
- model leg correlation and the inability to execute cross-venue legs atomically;
- reserve capital on each venue for the entire holding period;
- score terminal outcomes from the actual contract resolver;
- retain unscored/interrupted trades instead of silently dropping them;
- report public-paper fill fidelity honestly and require authenticated tiny
  canaries before assuming live queue behavior.

For a multi-leg candidate use a state machine such as:

```text
DISCOVERED
  -> RULE_CERTIFIED
  -> ECONOMIC_AT_DEPTH
  -> LEG_1_SENT
  -> LEG_1_PARTIAL / LEG_1_FILLED / LEG_1_REJECTED
  -> LEG_2_SENT
  -> HEDGED / ORPHANED / UNWINDING
  -> CLOSED / TERMINAL_SETTLEMENT
```

At each transition calculate the worst legal next-state loss. A displayed
identity is not risk-free if the legs cannot be made atomic.

## Phase 4 — backtesting and statistical standards

Use event-driven causal replay. For model strategies, use rolling/prequential
training: at time `t`, the model may use only data available before `t`, and
the model artifact must record its cutoff. Use purged/embargoed walk-forward
validation where labels overlap.

Report:

- gross, 1× and 2× cost P&L;
- 100/250/500 ms, 1 s, 2 s and measured-host sensitivity;
- fill/non-fill/partial/rejection rates;
- P&L per independent market/event/day and per dollar-hour of capital;
- drawdown, expected shortfall, worst orphan loss and liquidation/gap loss;
- turnover, capacity and result at $1/$2/$5/$10/$25/$50/$100 orders;
- $500 and $1,000 shared-bankroll equity curves;
- chronological halves and rolling weekly performance;
- market/day/event clustered confidence intervals;
- concentration by asset, venue, event and day, including results without the
  best contributor;
- probability of positive future P&L under a conservative uncertainty model;
- calibration, Brier score and log loss for probability forecasts;
- attribution by feature/edge component and execution component;
- multiple-testing correction, deflated performance statistics or a suitable
  reality-check/bootstrap across the complete idea family.

Guard explicitly against:

- look-ahead and timestamp leakage;
- using final rule text that was not available at entry;
- survivorship and resolved-market-only selection;
- treating repeated ticks/orders in one market as independent observations;
- optimizing thresholds on the same trades used to report performance;
- cherry-picking assets, sides, days or latency cells after inspection;
- summing variants that compete for the same capital;
- fake arbitrage from asynchronous snapshots;
- favorable paper fills caused by adverse selection;
- ignoring trades that never resolve or capital that remains trapped;
- assuming the opposite of a losing strategy is profitable without replaying
  the actual opposite executable trade and payoff asymmetry.

## Phase 5 — promotion rules

Use mechanism-specific promotion contracts.

### Statistical alpha

- At least 300 fresh independent markets/events.
- At least 14 calendar days for frequent crypto windows and at least 30 days
  for cross-venue, options, news and slower markets.
- Positive 2×-cost P&L in both chronological halves.
- Market/day-clustered lower confidence bound above zero.
- Multiple-testing-adjusted evidence.
- Positive at 100/250/500 ms and not destroyed by the measured deployment
  profile.
- Positive under shared $500 and $1,000 capital with no dominant event/day.

### Deterministic payoff arbitrage

Outcome prediction significance is unnecessary only when a deterministic
verifier proves non-negative payout in every legal terminal state. It still
requires sufficient synchronized executable-depth observations, fee/rule
certification, FOK feasibility, capital-duration economics and worst-case
orphan-loss tests. Call it risk-free only if execution is atomic or every
incomplete state is itself loss-bounded above zero after all costs.

### Passive making

Require at least 300 causally simulated fills and then authenticated tiny-order
evidence for queue position, cancel acknowledgement, partial fills and adverse
selection. Public prints alone are not A-grade fill evidence.

### Live canary

After a full paper pass, stop and request explicit authorization. The default
canary is 50 authenticated fills at $1–$2 per order with hard spend, loss,
inventory and orphan limits. Scale to $5–$10 only if actual arrival prices,
fees, non-fill/rejection rates, markouts and P&L agree with paper. Never infer
permission to use 50× leverage or the full wallet.

## Phase 6 — AI research and adaptive operation

Design AI as a controlled component, not an oracle.

1. **Semantic layer:** normalize contracts, public posts and event rules;
   produce structured claims, confidence, source links and timestamped evidence.
2. **Deterministic verifier:** independently validate payoff logic, rule
   equality, price scale, arithmetic and execution constraints.
3. **Predictive layer:** market-prior-plus-residual models, calibrated on
   prequential data and shrunk toward zero when evidence is weak.
4. **Regime layer:** detect volatility/liquidity/news states without using the
   current trade outcome; activate only pre-registered strategy-condition
   interactions.
5. **Allocator:** allocate paper capital across already valid strategies using
   uncertainty-aware estimates and exploration floors. Do not select whatever
   happened to win in the last five trades.
6. **Governance:** model artifacts are frozen, hash-addressed and rollbackable.
   AI-generated code must pass tests and review. Live execution and hard risk
   policy remain deterministic and cannot self-modify.

Compare every AI approach against cheap baselines. Charge API cost and model
latency. If an LLM adds no out-of-sample value beyond deterministic parsing or
the market quote, remove it.

## Required deliverables

1. `EDGE_DATA_CATALOG.md` plus machine-readable catalog.
2. `EDGE_MECHANISM_MAP.md` with at least 100 distinct, ranked hypotheses.
3. `TOP_EDGE_EXPERIMENTS.md` containing the ten selected manifests and explicit
   reasons every near-miss was rejected.
4. A deterministic replay/execution kernel and data adapters required by the
   selected experiments, with tests.
5. Backtest scripts runnable from the repository without hidden notebooks.
6. Frozen experiment manifests, dataset/code hashes and discovery cutoffs.
7. Paper collectors/strategies deployed on the VPS only after regression tests
   and archive/health checks pass.
8. Dashboard status and per-strategy drill-down with active/stale/dead labels.
9. `EDGE_PORTFOLIO_REPORT.md` with $500/$1,000 capacity, 6-hour/24-hour/7-day
   forward P&L views, drawdown, capital occupancy and confidence—not annualized
   discovery hype.
10. `NEXT_DATA_REQUIREMENTS.md` listing missing feeds, exact fields, expected
    accrual time, storage cost and the decision each feed would unlock.
11. Small reviewable commits, one concern per commit, with a deployment and
    rollback record.
12. A one-paragraph investment-committee conclusion stating plainly whether
    there is currently evidence of deployable edge, promising but unvalidated
    mechanism evidence, or only noise.

## Working protocol

- Begin with the written data/evidence map; do not touch strategy code first.
- Then research, rank, implement, test, replay and deploy paper trials. Do not
  stop at generic recommendations when safe implementation is possible.
- Send concise progress updates and surface blockers honestly.
- Preserve all discovery failures as negative controls and avoid repeated
  retries under renamed IDs.
- If a source or rule is unavailable, fail closed and keep collecting; do not
  substitute a convenient proxy without registering a separate diagnostic.
- Use current official documentation and primary research, with links and
  effective dates.
- Every material conclusion must cite the exact query, dataset interval,
  strategy version and independent sample count.
- Never state or imply that an edge is profitable merely because its current
  paper P&L is positive.
- Do not deploy real capital in this task. End with the exact evidence still
  required for a separately authorized live canary.

The desired outcome is not “ten profitable bots.” It is a high-throughput,
low-self-deception research machine that can search broadly, falsify cheaply,
and recognize a genuine small-capital edge when one finally survives contact
with executable prices and fresh data.

