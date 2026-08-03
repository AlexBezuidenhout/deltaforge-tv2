# DeltaForge edge mechanism map

Generated: 2026-08-03T14:11:26.962Z. Research/venue mechanics reviewed through 2026-08-03.

This registry contains economic hypotheses, not claimed edges. Scores allocate research effort; they are not backtest results. Known failed mechanisms remain visible so they cannot be relaunched under new names. All implementation is paper-only unless separately authorized after promotion.

## Coverage

| Family | Distinct hypotheses |
| --- | --- |
| Prediction-market structural and semantic edge | 18 |
| Rule-aware prediction/sports cross-venue relationships | 14 |
| Resolver and observation-boundary transfer | 10 |
| Options-implied binary pricing and volatility | 12 |
| Crypto CEX/perpetual relative value | 15 |
| DEX/on-chain and cross-network execution | 12 |
| Public information, semantic and AI-assisted event edge | 10 |
| Selective passive liquidity and execution edge | 12 |
| Portfolio/meta allocation and research controls | 7 |

Total: **110 materially distinct hypotheses**.

## Fixed 100-point rubric

| Criterion | Weight |
| --- | --- |
| mechanismStrength | 25 |
| dataReadiness | 15 |
| bankrollCapacity | 10 |
| persistence | 10 |
| dublinFit | 5 |
| simplicity | 5 |
| boundedRisk | 10 |
| cheapFalsification | 5 |
| independence | 5 |
| postCostDollarOpportunity | 10 |

## Highest-priority screen

The diversity cap allows at most two rows per family. Data-blocked and already-rejected mechanisms cannot enter this list, regardless of raw score.

| Rank | ID | Mechanism | Family | Decision | Score | Current evidence |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | S01 | Complete mutually-exclusive ask bundle | Prediction-market structural and semantic edge | DETERMINISTIC_SCANNER | 86 | Scanner exists; current epoch has zero executable positive bundles. |
| 2 | S03 | Ordered-strike YES-low plus NO-high | Prediction-market structural and semantic edge | DETERMINISTIC_SCANNER | 86 | V1 is running; all current candidates fail economics/orphan safety. |
| 3 | R07 | Timestamp precision mismatch | Resolver and observation-boundary transfer | CHEAP_FALSIFICATION | 82 | No DeltaForge result yet; mechanism prior only. |
| 4 | R01 | H43-X Chainlink tail residual | Resolver and observation-boundary transfer | CONTINUE_FROZEN | 81 | Fresh v19: 3 fills, +$0.63 at doubled cost; far below promotion minimum. |
| 5 | N09 | AI relationship proposal plus deterministic proof | Public information, semantic and AI-assisted event edge | INCUBATE | 78 | No DeltaForge result yet; mechanism prior only. |
| 6 | X01 | Certified terminal complement lock | Rule-aware prediction/sports cross-venue relationships | DETERMINISTIC_SCANNER | 74 | No certified-equal pair currently qualifies; UNKNOWN is vetoed. |
| 7 | P06 | AI anomaly triage queue | Portfolio/meta allocation and research controls | INCUBATE | 73 | No DeltaForge result yet; mechanism prior only. |
| 8 | P02 | Profit-per-dollar-hour allocator | Portfolio/meta allocation and research controls | INCUBATE | 72 | No DeltaForge result yet; mechanism prior only. |
| 9 | M01 | Fair-bound one-sided passive making | Selective passive liquidity and execution edge | COLLECT_ONLY | 69 | Staged, not active; authenticated queue/fill evidence is missing. |
| 10 | X12 | Multi-venue exhaustive outcome set | Rule-aware prediction/sports cross-venue relationships | CHEAP_FALSIFICATION | 68 | No DeltaForge result yet; mechanism prior only. |

## Full mechanism registry

### S01 — Complete mutually-exclusive ask bundle

- Family: Prediction-market structural and semantic edge
- Decision: **DETERMINISTIC_SCANNER**; research-priority score: **86/100**.
- Economic mechanism: Buy one share of every exhaustive outcome only when the walked all-in cost is below the guaranteed unit payout.
- Who pays: Stale or fragmented outcome sellers whose aggregate asks violate the simplex.
- Why it may persist: Payoff algebra persists until quotes, rules or displayed depth change; capacity is usually small and fragmented.
- Capacity and half-life: $1–$100 displayed capacity is plausible; quote half-life ranges from one event to hours, but must be measured.
- Required data/readiness: immutable rule text/hash; resolver and fallback; full executable books; fee schedule; finite outcome-state compiler. B — rules/books exist, but relationship certification and passive fills remain incomplete.
- Execution/legs: Prove every terminal state, walk all legs, reserve worst orphan unwind, then paper FOK or post-only-first/hedge-immediately.
- Latency: Mostly 100 ms to minutes; economics and rule identity dominate raw reaction latency.
- Full cost model: Current per-market fees + one tick/leg + walked depth + non-fill + worst orphan reserve + capital duration.
- Legal/rule dependency: Exact market wording, resolver, observation instant, rounding, cancellation and fallback clauses are hard gates.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing prediction-market structural and semantic edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: A unique certified relationship observed in one non-overlapping event window.
- Leakage/selection risk: AI relation mining, repeated quote observations and selecting only positive bundles create severe multiplicity.
- Infrastructure: Condition graph, immutable rule snapshots, deterministic SAT/MILP payoff compiler, synchronized books and FOK simulator.
- Time/storage: Continuous scanner; 30 days. Derived transitions are small; raw books already captured.
- Why this is not stale retail logic: It targets messy low-capacity semantic relationships, not the crowded single-market YES+NO identity.
- Existing evidence: Scanner exists; current epoch has zero executable positive bundles.
- Source keys: polymarketFees, polymarketOrders, polymarketResolution, predictionGraphPaper, polymarketArbPaper

### S03 — Ordered-strike YES-low plus NO-high

- Family: Prediction-market structural and semantic edge
- Decision: **DETERMINISTIC_SCANNER**; research-priority score: **86/100**.
- Economic mechanism: For K_low < K_high, YES(S>K_low)+NO(S>K_high) pays at least one in every state; trade only below guaranteed payout after orphan reserve.
- Who pays: Independent quote setters across nested thresholds.
- Why it may persist: Payoff algebra persists until quotes, rules or displayed depth change; capacity is usually small and fragmented.
- Capacity and half-life: $1–$100 displayed capacity is plausible; quote half-life ranges from one event to hours, but must be measured.
- Required data/readiness: immutable rule text/hash; resolver and fallback; full executable books; fee schedule; finite outcome-state compiler. B — rules/books exist, but relationship certification and passive fills remain incomplete.
- Execution/legs: Prove every terminal state, walk all legs, reserve worst orphan unwind, then paper FOK or post-only-first/hedge-immediately.
- Latency: Mostly 100 ms to minutes; economics and rule identity dominate raw reaction latency.
- Full cost model: Current per-market fees + one tick/leg + walked depth + non-fill + worst orphan reserve + capital duration.
- Legal/rule dependency: Exact market wording, resolver, observation instant, rounding, cancellation and fallback clauses are hard gates.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing prediction-market structural and semantic edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: A unique certified relationship observed in one non-overlapping event window.
- Leakage/selection risk: AI relation mining, repeated quote observations and selecting only positive bundles create severe multiplicity.
- Infrastructure: Condition graph, immutable rule snapshots, deterministic SAT/MILP payoff compiler, synchronized books and FOK simulator.
- Time/storage: Continuous scanner; 30 days. Derived transitions are small; raw books already captured.
- Why this is not stale retail logic: It targets messy low-capacity semantic relationships, not the crowded single-market YES+NO identity.
- Existing evidence: V1 is running; all current candidates fail economics/orphan safety.
- Source keys: polymarketFees, polymarketOrders, polymarketResolution, predictionGraphPaper, polymarketArbPaper

### S17 — Duplicate-contract same-venue identity

- Family: Prediction-market structural and semantic edge
- Decision: **CHEAP_FALSIFICATION**; research-priority score: **84/100**.
- Economic mechanism: Hash normalized predicate/resolver/time and detect duplicate listings with crossed executable books.
- Who pays: Operationally duplicated market listings.
- Why it may persist: Payoff algebra persists until quotes, rules or displayed depth change; capacity is usually small and fragmented.
- Capacity and half-life: $1–$100 displayed capacity is plausible; quote half-life ranges from one event to hours, but must be measured.
- Required data/readiness: immutable rule text/hash; resolver and fallback; full executable books; fee schedule; finite outcome-state compiler. B — rules/books exist, but relationship certification and passive fills remain incomplete.
- Execution/legs: Prove every terminal state, walk all legs, reserve worst orphan unwind, then paper FOK or post-only-first/hedge-immediately.
- Latency: Mostly 100 ms to minutes; economics and rule identity dominate raw reaction latency.
- Full cost model: Current per-market fees + one tick/leg + walked depth + non-fill + worst orphan reserve + capital duration.
- Legal/rule dependency: Exact market wording, resolver, observation instant, rounding, cancellation and fallback clauses are hard gates.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing prediction-market structural and semantic edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: A unique certified relationship observed in one non-overlapping event window.
- Leakage/selection risk: AI relation mining, repeated quote observations and selecting only positive bundles create severe multiplicity.
- Infrastructure: Condition graph, immutable rule snapshots, deterministic SAT/MILP payoff compiler, synchronized books and FOK simulator.
- Time/storage: Continuous scanner; 30 days. Derived transitions are small; raw books already captured.
- Why this is not stale retail logic: It targets messy low-capacity semantic relationships, not the crowded single-market YES+NO identity.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketFees, polymarketOrders, polymarketResolution, predictionGraphPaper, polymarketArbPaper

### R07 — Timestamp precision mismatch

- Family: Resolver and observation-boundary transfer
- Decision: **CHEAP_FALSIFICATION**; research-priority score: **82/100**.
- Economic mechanism: Exploit only deterministic differences between second/millisecond cutoff semantics where rules make inclusion/exclusion unambiguous.
- Who pays: Human traders overlooking boundary precision.
- Why it may persist: Small source-specific residuals can survive near a hard observation boundary because the binary payoff references a particular oracle.
- Capacity and half-life: $5–$50 per market; half-life is usually seconds and expires at the observation boundary.
- Required data/readiness: authoritative resolver ticks; market opening reference; source/receive clocks; executable token book; terminal outcome. B+ for Chainlink; C/D for sources whose sockets are empty or rule mapping is incomplete.
- Execution/legs: Use market quote as prior, add only a frozen resolver residual, require conservative lower bound above executable ask and doubled cost.
- Latency: 20–500 ms can affect fillability near expiry; source correctness and remaining-time tail dominate.
- Full cost model: Current token fee + one tick + walked depth + latency decay + source outage/fallback reserve.
- Legal/rule dependency: Exact resolver, opening/closing timestamp, precision, fallback and dispute process are mandatory.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing resolver and observation-boundary transfer data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One resolved market window.
- Leakage/selection risk: Tail envelopes trained through the test window, repeated ticks per market and post-hoc asset selection.
- Infrastructure: Resolver RTDS/WSS, opening-reference attestation, causal clocks, frozen empirical tail artifact and book replay.
- Time/storage: 14+ days and 300 fresh markets; low incremental disk because core feeds already exist.
- Why this is not stale retail logic: The contract-specific resolver is an operational wrinkle absent from generic CEX momentum.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketFees, polymarketResolution, polymarketBooks

### S13 — Weather threshold ladder

- Family: Prediction-market structural and semantic edge
- Decision: **CHEAP_FALSIFICATION**; research-priority score: **82/100**.
- Economic mechanism: Official-station temperature/rainfall thresholds form ordered events when station, day and precision exactly match.
- Who pays: Low-capacity weather quote fragmentation.
- Why it may persist: Payoff algebra persists until quotes, rules or displayed depth change; capacity is usually small and fragmented.
- Capacity and half-life: $1–$100 displayed capacity is plausible; quote half-life ranges from one event to hours, but must be measured.
- Required data/readiness: immutable rule text/hash; resolver and fallback; full executable books; fee schedule; finite outcome-state compiler. B — rules/books exist, but relationship certification and passive fills remain incomplete.
- Execution/legs: Prove every terminal state, walk all legs, reserve worst orphan unwind, then paper FOK or post-only-first/hedge-immediately.
- Latency: Mostly 100 ms to minutes; economics and rule identity dominate raw reaction latency.
- Full cost model: Current per-market fees + one tick/leg + walked depth + non-fill + worst orphan reserve + capital duration.
- Legal/rule dependency: Exact market wording, resolver, observation instant, rounding, cancellation and fallback clauses are hard gates.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing prediction-market structural and semantic edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: A unique certified relationship observed in one non-overlapping event window.
- Leakage/selection risk: AI relation mining, repeated quote observations and selecting only positive bundles create severe multiplicity.
- Infrastructure: Condition graph, immutable rule snapshots, deterministic SAT/MILP payoff compiler, synchronized books and FOK simulator.
- Time/storage: Continuous scanner; 30 days. Derived transitions are small; raw books already captured.
- Why this is not stale retail logic: It targets messy low-capacity semantic relationships, not the crowded single-market YES+NO identity.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketFees, polymarketOrders, polymarketResolution, predictionGraphPaper, polymarketArbPaper

### R01 — H43-X Chainlink tail residual

- Family: Resolver and observation-boundary transfer
- Decision: **CONTINUE_FROZEN**; research-priority score: **81/100**.
- Economic mechanism: Condition the market prior on fresh Chainlink displacement and a frozen pre-cutoff terminal-move envelope near expiry.
- Who pays: Makers conservatively pricing residual resolver movement and operational risk.
- Why it may persist: Small source-specific residuals can survive near a hard observation boundary because the binary payoff references a particular oracle.
- Capacity and half-life: $5–$50 per market; half-life is usually seconds and expires at the observation boundary.
- Required data/readiness: authoritative resolver ticks; market opening reference; source/receive clocks; executable token book; terminal outcome. B+ for Chainlink; C/D for sources whose sockets are empty or rule mapping is incomplete.
- Execution/legs: Use market quote as prior, add only a frozen resolver residual, require conservative lower bound above executable ask and doubled cost.
- Latency: 20–500 ms can affect fillability near expiry; source correctness and remaining-time tail dominate.
- Full cost model: Current token fee + one tick + walked depth + latency decay + source outage/fallback reserve.
- Legal/rule dependency: Exact resolver, opening/closing timestamp, precision, fallback and dispute process are mandatory.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing resolver and observation-boundary transfer data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One resolved market window.
- Leakage/selection risk: Tail envelopes trained through the test window, repeated ticks per market and post-hoc asset selection.
- Infrastructure: Resolver RTDS/WSS, opening-reference attestation, causal clocks, frozen empirical tail artifact and book replay.
- Time/storage: 14+ days and 300 fresh markets; low incremental disk because core feeds already exist.
- Why this is not stale retail logic: The contract-specific resolver is an operational wrinkle absent from generic CEX momentum.
- Existing evidence: Fresh v19: 3 fills, +$0.63 at doubled cost; far below promotion minimum.
- Source keys: polymarketFees, polymarketResolution, polymarketBooks

### S02 — Mergeable complement inventory lock

- Family: Prediction-market structural and semantic edge
- Decision: **CHEAP_FALSIFICATION**; research-priority score: **80/100**.
- Economic mechanism: Acquire complementary conditional tokens, merge/redeem them only where venue mechanics and inventory make the payout identity executable.
- Who pays: Complement sellers pricing inventory below merge value.
- Why it may persist: Payoff algebra persists until quotes, rules or displayed depth change; capacity is usually small and fragmented.
- Capacity and half-life: $1–$100 displayed capacity is plausible; quote half-life ranges from one event to hours, but must be measured.
- Required data/readiness: immutable rule text/hash; resolver and fallback; full executable books; fee schedule; finite outcome-state compiler. B — rules/books exist, but relationship certification and passive fills remain incomplete.
- Execution/legs: Prove every terminal state, walk all legs, reserve worst orphan unwind, then paper FOK or post-only-first/hedge-immediately.
- Latency: Mostly 100 ms to minutes; economics and rule identity dominate raw reaction latency.
- Full cost model: Current per-market fees + one tick/leg + walked depth + non-fill + worst orphan reserve + capital duration.
- Legal/rule dependency: Exact market wording, resolver, observation instant, rounding, cancellation and fallback clauses are hard gates.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing prediction-market structural and semantic edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: A unique certified relationship observed in one non-overlapping event window.
- Leakage/selection risk: AI relation mining, repeated quote observations and selecting only positive bundles create severe multiplicity.
- Infrastructure: Condition graph, immutable rule snapshots, deterministic SAT/MILP payoff compiler, synchronized books and FOK simulator.
- Time/storage: Continuous scanner; 30 days. Derived transitions are small; raw books already captured.
- Why this is not stale retail logic: It targets messy low-capacity semantic relationships, not the crowded single-market YES+NO identity.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketFees, polymarketOrders, polymarketResolution, predictionGraphPaper, polymarketArbPaper

### S04 — Ordered-strike put implication

- Family: Prediction-market structural and semantic edge
- Decision: **DETERMINISTIC_SCANNER**; research-priority score: **79/100**.
- Economic mechanism: For K_low < K_high, NO(S>K_low) implies NO(S>K_high); compile the corresponding bounded-payoff spread rather than assuming symmetry.
- Who pays: Misordered downside threshold books.
- Why it may persist: Payoff algebra persists until quotes, rules or displayed depth change; capacity is usually small and fragmented.
- Capacity and half-life: $1–$100 displayed capacity is plausible; quote half-life ranges from one event to hours, but must be measured.
- Required data/readiness: immutable rule text/hash; resolver and fallback; full executable books; fee schedule; finite outcome-state compiler. B — rules/books exist, but relationship certification and passive fills remain incomplete.
- Execution/legs: Prove every terminal state, walk all legs, reserve worst orphan unwind, then paper FOK or post-only-first/hedge-immediately.
- Latency: Mostly 100 ms to minutes; economics and rule identity dominate raw reaction latency.
- Full cost model: Current per-market fees + one tick/leg + walked depth + non-fill + worst orphan reserve + capital duration.
- Legal/rule dependency: Exact market wording, resolver, observation instant, rounding, cancellation and fallback clauses are hard gates.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing prediction-market structural and semantic edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: A unique certified relationship observed in one non-overlapping event window.
- Leakage/selection risk: AI relation mining, repeated quote observations and selecting only positive bundles create severe multiplicity.
- Infrastructure: Condition graph, immutable rule snapshots, deterministic SAT/MILP payoff compiler, synchronized books and FOK simulator.
- Time/storage: Continuous scanner; 30 days. Derived transitions are small; raw books already captured.
- Why this is not stale retail logic: It targets messy low-capacity semantic relationships, not the crowded single-market YES+NO identity.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketFees, polymarketOrders, polymarketResolution, predictionGraphPaper, polymarketArbPaper

### S05 — Disjoint range partition bundle

- Family: Prediction-market structural and semantic edge
- Decision: **CHEAP_FALSIFICATION**; research-priority score: **79/100**.
- Economic mechanism: Map non-overlapping ranges covering the outcome space and buy the exhaustive partition below one.
- Who pays: Range-market makers maintaining books independently.
- Why it may persist: Payoff algebra persists until quotes, rules or displayed depth change; capacity is usually small and fragmented.
- Capacity and half-life: $1–$100 displayed capacity is plausible; quote half-life ranges from one event to hours, but must be measured.
- Required data/readiness: immutable rule text/hash; resolver and fallback; full executable books; fee schedule; finite outcome-state compiler. B — rules/books exist, but relationship certification and passive fills remain incomplete.
- Execution/legs: Prove every terminal state, walk all legs, reserve worst orphan unwind, then paper FOK or post-only-first/hedge-immediately.
- Latency: Mostly 100 ms to minutes; economics and rule identity dominate raw reaction latency.
- Full cost model: Current per-market fees + one tick/leg + walked depth + non-fill + worst orphan reserve + capital duration.
- Legal/rule dependency: Exact market wording, resolver, observation instant, rounding, cancellation and fallback clauses are hard gates.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing prediction-market structural and semantic edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: A unique certified relationship observed in one non-overlapping event window.
- Leakage/selection risk: AI relation mining, repeated quote observations and selecting only positive bundles create severe multiplicity.
- Infrastructure: Condition graph, immutable rule snapshots, deterministic SAT/MILP payoff compiler, synchronized books and FOK simulator.
- Time/storage: Continuous scanner; 30 days. Derived transitions are small; raw books already captured.
- Why this is not stale retail logic: It targets messy low-capacity semantic relationships, not the crowded single-market YES+NO identity.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketFees, polymarketOrders, polymarketResolution, predictionGraphPaper, polymarketArbPaper

### S07 — Nested time-horizon implication

- Family: Prediction-market structural and semantic edge
- Decision: **CHEAP_FALSIFICATION**; research-priority score: **79/100**.
- Economic mechanism: A threshold hit by an earlier deadline can imply the same ever-hit condition by a later deadline when rules are identical.
- Who pays: Markets segmented by expiry horizon.
- Why it may persist: Payoff algebra persists until quotes, rules or displayed depth change; capacity is usually small and fragmented.
- Capacity and half-life: $1–$100 displayed capacity is plausible; quote half-life ranges from one event to hours, but must be measured.
- Required data/readiness: immutable rule text/hash; resolver and fallback; full executable books; fee schedule; finite outcome-state compiler. B — rules/books exist, but relationship certification and passive fills remain incomplete.
- Execution/legs: Prove every terminal state, walk all legs, reserve worst orphan unwind, then paper FOK or post-only-first/hedge-immediately.
- Latency: Mostly 100 ms to minutes; economics and rule identity dominate raw reaction latency.
- Full cost model: Current per-market fees + one tick/leg + walked depth + non-fill + worst orphan reserve + capital duration.
- Legal/rule dependency: Exact market wording, resolver, observation instant, rounding, cancellation and fallback clauses are hard gates.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing prediction-market structural and semantic edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: A unique certified relationship observed in one non-overlapping event window.
- Leakage/selection risk: AI relation mining, repeated quote observations and selecting only positive bundles create severe multiplicity.
- Infrastructure: Condition graph, immutable rule snapshots, deterministic SAT/MILP payoff compiler, synchronized books and FOK simulator.
- Time/storage: Continuous scanner; 30 days. Derived transitions are small; raw books already captured.
- Why this is not stale retail logic: It targets messy low-capacity semantic relationships, not the crowded single-market YES+NO identity.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketFees, polymarketOrders, polymarketResolution, predictionGraphPaper, polymarketArbPaper

### S08 — Tournament advancement graph

- Family: Prediction-market structural and semantic edge
- Decision: **CHEAP_FALSIFICATION**; research-priority score: **79/100**.
- Economic mechanism: Winning a later tournament round implies advancing through earlier rounds; encode bracket states and prove bundles.
- Who pays: Sports markets quoted round-by-round.
- Why it may persist: Payoff algebra persists until quotes, rules or displayed depth change; capacity is usually small and fragmented.
- Capacity and half-life: $1–$100 displayed capacity is plausible; quote half-life ranges from one event to hours, but must be measured.
- Required data/readiness: bracket structure; team identity; rules; books; fees. B — rules/books exist, but relationship certification and passive fills remain incomplete.
- Execution/legs: Prove every terminal state, walk all legs, reserve worst orphan unwind, then paper FOK or post-only-first/hedge-immediately.
- Latency: Mostly 100 ms to minutes; economics and rule identity dominate raw reaction latency.
- Full cost model: Current per-market fees + one tick/leg + walked depth + non-fill + worst orphan reserve + capital duration.
- Legal/rule dependency: Exact market wording, resolver, observation instant, rounding, cancellation and fallback clauses are hard gates.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing prediction-market structural and semantic edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: A unique certified relationship observed in one non-overlapping event window.
- Leakage/selection risk: AI relation mining, repeated quote observations and selecting only positive bundles create severe multiplicity.
- Infrastructure: Condition graph, immutable rule snapshots, deterministic SAT/MILP payoff compiler, synchronized books and FOK simulator.
- Time/storage: Continuous scanner; 30 days. Derived transitions are small; raw books already captured.
- Why this is not stale retail logic: It targets messy low-capacity semantic relationships, not the crowded single-market YES+NO identity.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketFees, polymarketOrders, polymarketResolution, predictionGraphPaper, polymarketArbPaper

### S09 — Nomination-to-election implication

- Family: Prediction-market structural and semantic edge
- Decision: **CHEAP_FALSIFICATION**; research-priority score: **79/100**.
- Economic mechanism: Winning a general election implies being the relevant nominee only where rules and replacement clauses make that implication exact.
- Who pays: Political markets separated by event stage.
- Why it may persist: Payoff algebra persists until quotes, rules or displayed depth change; capacity is usually small and fragmented.
- Capacity and half-life: $1–$100 displayed capacity is plausible; quote half-life ranges from one event to hours, but must be measured.
- Required data/readiness: immutable rule text/hash; resolver and fallback; full executable books; fee schedule; finite outcome-state compiler. B — rules/books exist, but relationship certification and passive fills remain incomplete.
- Execution/legs: Prove every terminal state, walk all legs, reserve worst orphan unwind, then paper FOK or post-only-first/hedge-immediately.
- Latency: Mostly 100 ms to minutes; economics and rule identity dominate raw reaction latency.
- Full cost model: Current per-market fees + one tick/leg + walked depth + non-fill + worst orphan reserve + capital duration.
- Legal/rule dependency: Replacement, death/withdrawal and party-rule clauses can break the implication and are automatic vetoes.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing prediction-market structural and semantic edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: A unique certified relationship observed in one non-overlapping event window.
- Leakage/selection risk: AI relation mining, repeated quote observations and selecting only positive bundles create severe multiplicity.
- Infrastructure: Condition graph, immutable rule snapshots, deterministic SAT/MILP payoff compiler, synchronized books and FOK simulator.
- Time/storage: Continuous scanner; 30 days. Derived transitions are small; raw books already captured.
- Why this is not stale retail logic: It targets messy low-capacity semantic relationships, not the crowded single-market YES+NO identity.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketFees, polymarketOrders, polymarketResolution, predictionGraphPaper, polymarketArbPaper

### S10 — Popular-vote/election joint bounds

- Family: Prediction-market structural and semantic edge
- Decision: **CHEAP_FALSIFICATION**; research-priority score: **79/100**.
- Economic mechanism: Trade only Fréchet/logical bounds between popular-vote and election outcomes; do not assume one implies the other.
- Who pays: Traders overconfident in an informal relationship.
- Why it may persist: Payoff algebra persists until quotes, rules or displayed depth change; capacity is usually small and fragmented.
- Capacity and half-life: $1–$100 displayed capacity is plausible; quote half-life ranges from one event to hours, but must be measured.
- Required data/readiness: immutable rule text/hash; resolver and fallback; full executable books; fee schedule; finite outcome-state compiler. B — rules/books exist, but relationship certification and passive fills remain incomplete.
- Execution/legs: Prove every terminal state, walk all legs, reserve worst orphan unwind, then paper FOK or post-only-first/hedge-immediately.
- Latency: Mostly 100 ms to minutes; economics and rule identity dominate raw reaction latency.
- Full cost model: Current per-market fees + one tick/leg + walked depth + non-fill + worst orphan reserve + capital duration.
- Legal/rule dependency: Exact market wording, resolver, observation instant, rounding, cancellation and fallback clauses are hard gates.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing prediction-market structural and semantic edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: A unique certified relationship observed in one non-overlapping event window.
- Leakage/selection risk: AI relation mining, repeated quote observations and selecting only positive bundles create severe multiplicity.
- Infrastructure: Condition graph, immutable rule snapshots, deterministic SAT/MILP payoff compiler, synchronized books and FOK simulator.
- Time/storage: Continuous scanner; 30 days. Derived transitions are small; raw books already captured.
- Why this is not stale retail logic: It targets messy low-capacity semantic relationships, not the crowded single-market YES+NO identity.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketFees, polymarketOrders, polymarketResolution, predictionGraphPaper, polymarketArbPaper

### S11 — Rate-cut count ladder

- Family: Prediction-market structural and semantic edge
- Decision: **DETERMINISTIC_SCANNER**; research-priority score: **79/100**.
- Economic mechanism: Counts such as at-least-N cuts form ordered strikes; compile all count states and detect monotonicity violations.
- Who pays: Macro contracts quoted as separate thresholds.
- Why it may persist: Payoff algebra persists until quotes, rules or displayed depth change; capacity is usually small and fragmented.
- Capacity and half-life: $1–$100 displayed capacity is plausible; quote half-life ranges from one event to hours, but must be measured.
- Required data/readiness: immutable rule text/hash; resolver and fallback; full executable books; fee schedule; finite outcome-state compiler. B — rules/books exist, but relationship certification and passive fills remain incomplete.
- Execution/legs: Prove every terminal state, walk all legs, reserve worst orphan unwind, then paper FOK or post-only-first/hedge-immediately.
- Latency: Mostly 100 ms to minutes; economics and rule identity dominate raw reaction latency.
- Full cost model: Current per-market fees + one tick/leg + walked depth + non-fill + worst orphan reserve + capital duration.
- Legal/rule dependency: Exact market wording, resolver, observation instant, rounding, cancellation and fallback clauses are hard gates.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing prediction-market structural and semantic edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: A unique certified relationship observed in one non-overlapping event window.
- Leakage/selection risk: AI relation mining, repeated quote observations and selecting only positive bundles create severe multiplicity.
- Infrastructure: Condition graph, immutable rule snapshots, deterministic SAT/MILP payoff compiler, synchronized books and FOK simulator.
- Time/storage: Continuous scanner; 30 days. Derived transitions are small; raw books already captured.
- Why this is not stale retail logic: It targets messy low-capacity semantic relationships, not the crowded single-market YES+NO identity.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketFees, polymarketOrders, polymarketResolution, predictionGraphPaper, polymarketArbPaper

### S12 — Inflation threshold ladder

- Family: Prediction-market structural and semantic edge
- Decision: **CHEAP_FALSIFICATION**; research-priority score: **79/100**.
- Economic mechanism: CPI/PCE threshold contracts with identical release vintage and rounding must obey ordered-strike monotonicity.
- Who pays: Threshold-specific liquidity fragmentation.
- Why it may persist: Payoff algebra persists until quotes, rules or displayed depth change; capacity is usually small and fragmented.
- Capacity and half-life: $1–$100 displayed capacity is plausible; quote half-life ranges from one event to hours, but must be measured.
- Required data/readiness: immutable rule text/hash; resolver and fallback; full executable books; fee schedule; finite outcome-state compiler. B — rules/books exist, but relationship certification and passive fills remain incomplete.
- Execution/legs: Prove every terminal state, walk all legs, reserve worst orphan unwind, then paper FOK or post-only-first/hedge-immediately.
- Latency: Mostly 100 ms to minutes; economics and rule identity dominate raw reaction latency.
- Full cost model: Current per-market fees + one tick/leg + walked depth + non-fill + worst orphan reserve + capital duration.
- Legal/rule dependency: Exact market wording, resolver, observation instant, rounding, cancellation and fallback clauses are hard gates.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing prediction-market structural and semantic edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: A unique certified relationship observed in one non-overlapping event window.
- Leakage/selection risk: AI relation mining, repeated quote observations and selecting only positive bundles create severe multiplicity.
- Infrastructure: Condition graph, immutable rule snapshots, deterministic SAT/MILP payoff compiler, synchronized books and FOK simulator.
- Time/storage: Continuous scanner; 30 days. Derived transitions are small; raw books already captured.
- Why this is not stale retail logic: It targets messy low-capacity semantic relationships, not the crowded single-market YES+NO identity.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketFees, polymarketOrders, polymarketResolution, predictionGraphPaper, polymarketArbPaper

### S14 — Crypto daily threshold graph

- Family: Prediction-market structural and semantic edge
- Decision: **DETERMINISTIC_SCANNER**; research-priority score: **79/100**.
- Economic mechanism: Exact resolver crypto price-above contracts across strikes share one terminal state and admit ordered-strike payoff proofs.
- Who pays: Independent small prediction-market books.
- Why it may persist: Payoff algebra persists until quotes, rules or displayed depth change; capacity is usually small and fragmented.
- Capacity and half-life: $1–$100 displayed capacity is plausible; quote half-life ranges from one event to hours, but must be measured.
- Required data/readiness: immutable rule text/hash; resolver and fallback; full executable books; fee schedule; finite outcome-state compiler. B — rules/books exist, but relationship certification and passive fills remain incomplete.
- Execution/legs: Prove every terminal state, walk all legs, reserve worst orphan unwind, then paper FOK or post-only-first/hedge-immediately.
- Latency: Mostly 100 ms to minutes; economics and rule identity dominate raw reaction latency.
- Full cost model: Current per-market fees + one tick/leg + walked depth + non-fill + worst orphan reserve + capital duration.
- Legal/rule dependency: Exact market wording, resolver, observation instant, rounding, cancellation and fallback clauses are hard gates.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing prediction-market structural and semantic edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: A unique certified relationship observed in one non-overlapping event window.
- Leakage/selection risk: AI relation mining, repeated quote observations and selecting only positive bundles create severe multiplicity.
- Infrastructure: Condition graph, immutable rule snapshots, deterministic SAT/MILP payoff compiler, synchronized books and FOK simulator.
- Time/storage: Continuous scanner; 30 days. Derived transitions are small; raw books already captured.
- Why this is not stale retail logic: It targets messy low-capacity semantic relationships, not the crowded single-market YES+NO identity.
- Existing evidence: Current ordered-strike trial has candidates but no positive economics.
- Source keys: polymarketFees, polymarketOrders, polymarketResolution, predictionGraphPaper, polymarketArbPaper

### S15 — Mutually exclusive election-state slate

- Family: Prediction-market structural and semantic edge
- Decision: **CHEAP_FALSIFICATION**; research-priority score: **79/100**.
- Economic mechanism: Build a complete candidate/state slate only when every residual outcome, replacement and tie state is represented.
- Who pays: Long-tail candidate books with inconsistent aggregate prices.
- Why it may persist: Payoff algebra persists until quotes, rules or displayed depth change; capacity is usually small and fragmented.
- Capacity and half-life: $1–$100 displayed capacity is plausible; quote half-life ranges from one event to hours, but must be measured.
- Required data/readiness: immutable rule text/hash; resolver and fallback; full executable books; fee schedule; finite outcome-state compiler. B — rules/books exist, but relationship certification and passive fills remain incomplete.
- Execution/legs: Prove every terminal state, walk all legs, reserve worst orphan unwind, then paper FOK or post-only-first/hedge-immediately.
- Latency: Mostly 100 ms to minutes; economics and rule identity dominate raw reaction latency.
- Full cost model: Current per-market fees + one tick/leg + walked depth + non-fill + worst orphan reserve + capital duration.
- Legal/rule dependency: Exact market wording, resolver, observation instant, rounding, cancellation and fallback clauses are hard gates.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing prediction-market structural and semantic edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: A unique certified relationship observed in one non-overlapping event window.
- Leakage/selection risk: AI relation mining, repeated quote observations and selecting only positive bundles create severe multiplicity.
- Infrastructure: Condition graph, immutable rule snapshots, deterministic SAT/MILP payoff compiler, synchronized books and FOK simulator.
- Time/storage: Continuous scanner; 30 days. Derived transitions are small; raw books already captured.
- Why this is not stale retail logic: It targets messy low-capacity semantic relationships, not the crowded single-market YES+NO identity.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketFees, polymarketOrders, polymarketResolution, predictionGraphPaper, polymarketArbPaper

### N09 — AI relationship proposal plus deterministic proof

- Family: Public information, semantic and AI-assisted event edge
- Decision: **INCUBATE**; research-priority score: **78/100**.
- Economic mechanism: Use an LLM only to propose candidate condition-graph edges; a finite-state verifier and human-auditable rule hash decide admissibility.
- Who pays: Operational search cost across thousands of obscure contracts.
- Why it may persist: Operational interpretation delays may persist in obscure markets, but major headline reactions are fast and crowded.
- Capacity and half-life: $5–$100 in obscure markets; seconds to hours depending on source and ambiguity.
- Required data/readiness: official source timestamp; local receive/monotonic clock; immutable content hash; mapped rules; pre-event books; terminal outcome. D/C — rule text exists; causal official-news and social-source collectors are not yet complete.
- Execution/legs: Official public source only; parse to a calibrated event claim; deterministic rule match; trade only against executable book after uncertainty reserve.
- Latency: Seconds for major news, minutes for obscure semantic updates; source timestamps must be auditable.
- Full cost model: Venue fees/depth + model uncertainty + stale/edited/deleted-post reserve + latency decay.
- Legal/rule dependency: Public-data license/API terms, venue rules, embargo/non-public-information restrictions and source authenticity.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing public information, semantic and ai-assisted event edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One public information event mapped before outcome to one market cluster.
- Leakage/selection risk: Using edited content, publication databases with revised timestamps, prompt/model changes and post-hoc market mapping.
- Infrastructure: Causal source collectors, content-addressed store, model/prompt registry, deterministic claim-to-rule verifier.
- Time/storage: Collector-first, 30–90 days; text is small, linked book capture dominates.
- Why this is not stale retail logic: AI proposes interpretations at scale, but price/execution and deterministic rule checks remain authoritative.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketResolution, overfitPaper

### S06 — Overlapping range inclusion-exclusion

- Family: Prediction-market structural and semantic edge
- Decision: **CHEAP_FALSIFICATION**; research-priority score: **78/100**.
- Economic mechanism: Use deterministic set algebra to identify over/under-priced intersections and unions with statewise bounded payoff.
- Who pays: Independent range and composite-event liquidity providers.
- Why it may persist: Payoff algebra persists until quotes, rules or displayed depth change; capacity is usually small and fragmented.
- Capacity and half-life: $1–$100 displayed capacity is plausible; quote half-life ranges from one event to hours, but must be measured.
- Required data/readiness: immutable rule text/hash; resolver and fallback; full executable books; fee schedule; finite outcome-state compiler. B — rules/books exist, but relationship certification and passive fills remain incomplete.
- Execution/legs: Prove every terminal state, walk all legs, reserve worst orphan unwind, then paper FOK or post-only-first/hedge-immediately.
- Latency: Mostly 100 ms to minutes; economics and rule identity dominate raw reaction latency.
- Full cost model: Current per-market fees + one tick/leg + walked depth + non-fill + worst orphan reserve + capital duration.
- Legal/rule dependency: Exact market wording, resolver, observation instant, rounding, cancellation and fallback clauses are hard gates.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing prediction-market structural and semantic edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: A unique certified relationship observed in one non-overlapping event window.
- Leakage/selection risk: AI relation mining, repeated quote observations and selecting only positive bundles create severe multiplicity.
- Infrastructure: Condition graph, immutable rule snapshots, deterministic SAT/MILP payoff compiler, synchronized books and FOK simulator.
- Time/storage: Continuous scanner; 30 days. Derived transitions are small; raw books already captured.
- Why this is not stale retail logic: It targets messy low-capacity semantic relationships, not the crowded single-market YES+NO identity.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketFees, polymarketOrders, polymarketResolution, predictionGraphPaper, polymarketArbPaper

### S16 — Conditional-versus-joint probability bounds

- Family: Prediction-market structural and semantic edge
- Decision: **CHEAP_FALSIFICATION**; research-priority score: **78/100**.
- Economic mechanism: Enforce P(A∩B)≤P(A), P(A∩B)≤P(B) and union bounds using finite-state payoffs, not probability-point estimates.
- Who pays: Composite-event markets quoted independently.
- Why it may persist: Payoff algebra persists until quotes, rules or displayed depth change; capacity is usually small and fragmented.
- Capacity and half-life: $1–$100 displayed capacity is plausible; quote half-life ranges from one event to hours, but must be measured.
- Required data/readiness: immutable rule text/hash; resolver and fallback; full executable books; fee schedule; finite outcome-state compiler. B — rules/books exist, but relationship certification and passive fills remain incomplete.
- Execution/legs: Prove every terminal state, walk all legs, reserve worst orphan unwind, then paper FOK or post-only-first/hedge-immediately.
- Latency: Mostly 100 ms to minutes; economics and rule identity dominate raw reaction latency.
- Full cost model: Current per-market fees + one tick/leg + walked depth + non-fill + worst orphan reserve + capital duration.
- Legal/rule dependency: Exact market wording, resolver, observation instant, rounding, cancellation and fallback clauses are hard gates.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing prediction-market structural and semantic edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: A unique certified relationship observed in one non-overlapping event window.
- Leakage/selection risk: AI relation mining, repeated quote observations and selecting only positive bundles create severe multiplicity.
- Infrastructure: Condition graph, immutable rule snapshots, deterministic SAT/MILP payoff compiler, synchronized books and FOK simulator.
- Time/storage: Continuous scanner; 30 days. Derived transitions are small; raw books already captured.
- Why this is not stale retail logic: It targets messy low-capacity semantic relationships, not the crowded single-market YES+NO identity.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketFees, polymarketOrders, polymarketResolution, predictionGraphPaper, polymarketArbPaper

### R10 — Resolver fallback-state portfolio

- Family: Resolver and observation-boundary transfer
- Decision: **DETERMINISTIC_SCANNER**; research-priority score: **77/100**.
- Economic mechanism: Compile primary source, fallback source, outage and dispute states and trade only when worst-state economics remain positive.
- Who pays: Markets priced to a single assumed resolver path.
- Why it may persist: Small source-specific residuals can survive near a hard observation boundary because the binary payoff references a particular oracle.
- Capacity and half-life: $5–$50 per market; half-life is usually seconds and expires at the observation boundary.
- Required data/readiness: authoritative resolver ticks; market opening reference; source/receive clocks; executable token book; terminal outcome. B+ for Chainlink; C/D for sources whose sockets are empty or rule mapping is incomplete.
- Execution/legs: Use market quote as prior, add only a frozen resolver residual, require conservative lower bound above executable ask and doubled cost.
- Latency: 20–500 ms can affect fillability near expiry; source correctness and remaining-time tail dominate.
- Full cost model: Current token fee + one tick + walked depth + latency decay + source outage/fallback reserve.
- Legal/rule dependency: Exact resolver, opening/closing timestamp, precision, fallback and dispute process are mandatory.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing resolver and observation-boundary transfer data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One resolved market window.
- Leakage/selection risk: Tail envelopes trained through the test window, repeated ticks per market and post-hoc asset selection.
- Infrastructure: Resolver RTDS/WSS, opening-reference attestation, causal clocks, frozen empirical tail artifact and book replay.
- Time/storage: 14+ days and 300 fresh markets; low incremental disk because core feeds already exist.
- Why this is not stale retail logic: The contract-specific resolver is an operational wrinkle absent from generic CEX momentum.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketFees, polymarketResolution, polymarketBooks

### R04 — Chainlink round-transition state

- Family: Resolver and observation-boundary transfer
- Decision: **CHEAP_FALSIFICATION**; research-priority score: **75/100**.
- Economic mechanism: Model whether the active Chainlink round can update again before cutoff using round age and source heartbeat, not directional CEX momentum.
- Who pays: Participants ignoring round timing mechanics.
- Why it may persist: Small source-specific residuals can survive near a hard observation boundary because the binary payoff references a particular oracle.
- Capacity and half-life: $5–$50 per market; half-life is usually seconds and expires at the observation boundary.
- Required data/readiness: Chainlink round IDs/times; market cutoff; book; outcomes. B+ for Chainlink; C/D for sources whose sockets are empty or rule mapping is incomplete.
- Execution/legs: Use market quote as prior, add only a frozen resolver residual, require conservative lower bound above executable ask and doubled cost.
- Latency: 20–500 ms can affect fillability near expiry; source correctness and remaining-time tail dominate.
- Full cost model: Current token fee + one tick + walked depth + latency decay + source outage/fallback reserve.
- Legal/rule dependency: Exact resolver, opening/closing timestamp, precision, fallback and dispute process are mandatory.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing resolver and observation-boundary transfer data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One resolved market window.
- Leakage/selection risk: Tail envelopes trained through the test window, repeated ticks per market and post-hoc asset selection.
- Infrastructure: Resolver RTDS/WSS, opening-reference attestation, causal clocks, frozen empirical tail artifact and book replay.
- Time/storage: 14+ days and 300 fresh markets; low incremental disk because core feeds already exist.
- Why this is not stale retail logic: The contract-specific resolver is an operational wrinkle absent from generic CEX momentum.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketFees, polymarketResolution, polymarketBooks

### R05 — Resolver carried-forward barrier

- Family: Resolver and observation-boundary transfer
- Decision: **COLLECT_ONLY**; research-priority score: **75/100**.
- Economic mechanism: Identify contracts whose source may carry the last valid value and price the probability of no fresh update as a separate terminal state.
- Who pays: Traders assuming continuous updates during source degradation.
- Why it may persist: Small source-specific residuals can survive near a hard observation boundary because the binary payoff references a particular oracle.
- Capacity and half-life: $5–$50 per market; half-life is usually seconds and expires at the observation boundary.
- Required data/readiness: authoritative resolver ticks; market opening reference; source/receive clocks; executable token book; terminal outcome. B+ for Chainlink; C/D for sources whose sockets are empty or rule mapping is incomplete.
- Execution/legs: Use market quote as prior, add only a frozen resolver residual, require conservative lower bound above executable ask and doubled cost.
- Latency: 20–500 ms can affect fillability near expiry; source correctness and remaining-time tail dominate.
- Full cost model: Current token fee + one tick + walked depth + latency decay + source outage/fallback reserve.
- Legal/rule dependency: Exact resolver, opening/closing timestamp, precision, fallback and dispute process are mandatory.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing resolver and observation-boundary transfer data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One resolved market window.
- Leakage/selection risk: Tail envelopes trained through the test window, repeated ticks per market and post-hoc asset selection.
- Infrastructure: Resolver RTDS/WSS, opening-reference attestation, causal clocks, frozen empirical tail artifact and book replay.
- Time/storage: 14+ days and 300 fresh markets; low incremental disk because core feeds already exist.
- Why this is not stale retail logic: The contract-specific resolver is an operational wrinkle absent from generic CEX momentum.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketFees, polymarketResolution, polymarketBooks

### R06 — Resolver outage recovery

- Family: Resolver and observation-boundary transfer
- Decision: **COLLECT_ONLY**; research-priority score: **75/100**.
- Economic mechanism: After a source outage, test bounded quote lag when the authoritative stream resumes and stale barriers clear.
- Who pays: Quote providers slow to re-enable automated pricing.
- Why it may persist: Small source-specific residuals can survive near a hard observation boundary because the binary payoff references a particular oracle.
- Capacity and half-life: $5–$50 per market; half-life is usually seconds and expires at the observation boundary.
- Required data/readiness: authoritative resolver ticks; market opening reference; source/receive clocks; executable token book; terminal outcome. B+ for Chainlink; C/D for sources whose sockets are empty or rule mapping is incomplete.
- Execution/legs: Use market quote as prior, add only a frozen resolver residual, require conservative lower bound above executable ask and doubled cost.
- Latency: 20–500 ms can affect fillability near expiry; source correctness and remaining-time tail dominate.
- Full cost model: Current token fee + one tick + walked depth + latency decay + source outage/fallback reserve.
- Legal/rule dependency: Exact resolver, opening/closing timestamp, precision, fallback and dispute process are mandatory.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing resolver and observation-boundary transfer data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One resolved market window.
- Leakage/selection risk: Tail envelopes trained through the test window, repeated ticks per market and post-hoc asset selection.
- Infrastructure: Resolver RTDS/WSS, opening-reference attestation, causal clocks, frozen empirical tail artifact and book replay.
- Time/storage: 14+ days and 300 fresh markets; low incremental disk because core feeds already exist.
- Why this is not stale retail logic: The contract-specific resolver is an operational wrinkle absent from generic CEX momentum.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketFees, polymarketResolution, polymarketBooks

### R08 — Opening-reference capture error

- Family: Resolver and observation-boundary transfer
- Decision: **CHEAP_FALSIFICATION**; research-priority score: **75/100**.
- Economic mechanism: Detect a market opening reference that differs from the authoritative first eligible oracle value and trade only after rule attestation.
- Who pays: Frontends or makers using an approximate opening print.
- Why it may persist: Small source-specific residuals can survive near a hard observation boundary because the binary payoff references a particular oracle.
- Capacity and half-life: $5–$50 per market; half-life is usually seconds and expires at the observation boundary.
- Required data/readiness: authoritative resolver ticks; market opening reference; source/receive clocks; executable token book; terminal outcome. B+ for Chainlink; C/D for sources whose sockets are empty or rule mapping is incomplete.
- Execution/legs: Use market quote as prior, add only a frozen resolver residual, require conservative lower bound above executable ask and doubled cost.
- Latency: 20–500 ms can affect fillability near expiry; source correctness and remaining-time tail dominate.
- Full cost model: Current token fee + one tick + walked depth + latency decay + source outage/fallback reserve.
- Legal/rule dependency: Exact resolver, opening/closing timestamp, precision, fallback and dispute process are mandatory.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing resolver and observation-boundary transfer data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One resolved market window.
- Leakage/selection risk: Tail envelopes trained through the test window, repeated ticks per market and post-hoc asset selection.
- Infrastructure: Resolver RTDS/WSS, opening-reference attestation, causal clocks, frozen empirical tail artifact and book replay.
- Time/storage: 14+ days and 300 fresh markets; low incremental disk because core feeds already exist.
- Why this is not stale retail logic: The contract-specific resolver is an operational wrinkle absent from generic CEX momentum.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketFees, polymarketResolution, polymarketBooks

### R09 — Cross-source resolver consensus barrier

- Family: Resolver and observation-boundary transfer
- Decision: **CHEAP_FALSIFICATION**; research-priority score: **75/100**.
- Economic mechanism: Use Binance/Coinbase agreement only to tighten a conservative bound around the authoritative resolver, never to replace it.
- Who pays: Makers applying an overly broad uncertainty reserve.
- Why it may persist: Small source-specific residuals can survive near a hard observation boundary because the binary payoff references a particular oracle.
- Capacity and half-life: $5–$50 per market; half-life is usually seconds and expires at the observation boundary.
- Required data/readiness: authoritative resolver ticks; market opening reference; source/receive clocks; executable token book; terminal outcome. B+ for Chainlink; C/D for sources whose sockets are empty or rule mapping is incomplete.
- Execution/legs: Use market quote as prior, add only a frozen resolver residual, require conservative lower bound above executable ask and doubled cost.
- Latency: 20–500 ms can affect fillability near expiry; source correctness and remaining-time tail dominate.
- Full cost model: Current token fee + one tick + walked depth + latency decay + source outage/fallback reserve.
- Legal/rule dependency: Exact resolver, opening/closing timestamp, precision, fallback and dispute process are mandatory.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing resolver and observation-boundary transfer data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One resolved market window.
- Leakage/selection risk: Tail envelopes trained through the test window, repeated ticks per market and post-hoc asset selection.
- Infrastructure: Resolver RTDS/WSS, opening-reference attestation, causal clocks, frozen empirical tail artifact and book replay.
- Time/storage: 14+ days and 300 fresh markets; low incremental disk because core feeds already exist.
- Why this is not stale retail logic: The contract-specific resolver is an operational wrinkle absent from generic CEX momentum.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketFees, polymarketResolution, polymarketBooks

### X01 — Certified terminal complement lock

- Family: Rule-aware prediction/sports cross-venue relationships
- Decision: **DETERMINISTIC_SCANNER**; research-priority score: **74/100**.
- Economic mechanism: Buy YES on one venue and NO on the other only when every identity dimension is certified equal and combined worst-case payout exceeds all costs.
- Who pays: Segmented sellers across Polymarket and Kalshi.
- Why it may persist: Venue segmentation and trapped capital can sustain basis for seconds to days; identity errors can persist to settlement as losses.
- Capacity and half-life: $5–$250 per pair may fit this bankroll; basis half-life and capital-hours must be estimated by typed pair.
- Required data/readiness: both venues full depth; source/receive clocks; per-market fees; immutable rules; identity dimensions; terminal outcomes. B-/C+ — synchronized feeds exist, but no certified-equal pair and Kalshi rule coverage is sparse.
- Execution/legs: Pre-fund both venues; synchronize depth; veto UNKNOWN; model sequential legs and emergency unwind. No cross-venue atomicity claim.
- Latency: Convergence can be seconds to days; 100–500 ms matters for leg risk, not all opportunity creation.
- Full cost model: Both venue fees and rounding + depth + reject/non-fill + transfer/rebalance + orphan loss + capital duration.
- Legal/rule dependency: Venue eligibility, account limits, exact settlement rules and withdrawal/custody constraints must be current.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing rule-aware prediction/sports cross-venue relationships data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: Pair-direction-day or one non-overlapping dislocation episode, not each polling observation.
- Leakage/selection risk: Text similarity is not payoff identity; overlapping episodes and manual approvals can leak future knowledge.
- Infrastructure: Typed contract normalizer, hard-mismatch veto, synchronized dual books, two-leg state machine and capital clock.
- Time/storage: 30 days and at least 300 pair-days; existing depth capture is reusable.
- Why this is not stale retail logic: It tests rule friction and capital segmentation rather than a naive midpoint comparison.
- Existing evidence: No certified-equal pair currently qualifies; UNKNOWN is vetoed.
- Source keys: polymarketFees, polymarketOrders, kalshiOrders, kalshiFees, kalshiBooks

### P06 — AI anomaly triage queue

- Family: Portfolio/meta allocation and research controls
- Decision: **INCUBATE**; research-priority score: **73/100**.
- Economic mechanism: Rank scanner candidates for human review by uncertainty and potential dollar economics without changing deterministic admissibility.
- Who pays: Reduced manual research cost.
- Why it may persist: Allocation can improve capital use but cannot manufacture alpha from negative components.
- Capacity and half-life: $500/$1,000 shared bankroll; rebalance at independent-unit boundaries, not every tick.
- Required data/readiness: frozen strategy identities; prequential predictions; capital occupancy; cross-strategy covariance; settled PnL. B — trial ledger and strategy facts exist, but most component edges are unvalidated.
- Execution/legs: Allocate only among pre-registered eligible arms using information available before each independent unit.
- Latency: Low; correctness and anti-leakage are more important than sub-second action.
- Full cost model: Underlying strategy costs + idle/fragmented capital + switching/rebalance costs.
- Legal/rule dependency: Inherits every component venue restriction and shared-account exposure limit.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing portfolio/meta allocation and research controls data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One next market/event after an allocation decision.
- Leakage/selection risk: Winner chasing, overlapping strategy returns, using unsettled future labels and repeated model selection.
- Infrastructure: Prequential ledger, shared-bankroll simulator, embargoed walk-forward folds and multiplicity accounting.
- Time/storage: 30+ days; negligible incremental storage.
- Why this is not stale retail logic: It is a governance/capital layer and is explicitly forbidden from treating recent streaks as causal alpha.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: overfitPaper

### P02 — Profit-per-dollar-hour allocator

- Family: Portfolio/meta allocation and research controls
- Decision: **INCUBATE**; research-priority score: **72/100**.
- Economic mechanism: Rank qualified opportunities by conservative expected dollars divided by venue-fragmented capital-hours.
- Who pays: Avoided opportunity cost from slow-settling positions.
- Why it may persist: Allocation can improve capital use but cannot manufacture alpha from negative components.
- Capacity and half-life: $500/$1,000 shared bankroll; rebalance at independent-unit boundaries, not every tick.
- Required data/readiness: frozen strategy identities; prequential predictions; capital occupancy; cross-strategy covariance; settled PnL. B — trial ledger and strategy facts exist, but most component edges are unvalidated.
- Execution/legs: Allocate only among pre-registered eligible arms using information available before each independent unit.
- Latency: Low; correctness and anti-leakage are more important than sub-second action.
- Full cost model: Underlying strategy costs + idle/fragmented capital + switching/rebalance costs.
- Legal/rule dependency: Inherits every component venue restriction and shared-account exposure limit.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing portfolio/meta allocation and research controls data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One next market/event after an allocation decision.
- Leakage/selection risk: Winner chasing, overlapping strategy returns, using unsettled future labels and repeated model selection.
- Infrastructure: Prequential ledger, shared-bankroll simulator, embargoed walk-forward folds and multiplicity accounting.
- Time/storage: 30+ days; negligible incremental storage.
- Why this is not stale retail logic: It is a governance/capital layer and is explicitly forbidden from treating recent streaks as causal alpha.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: overfitPaper

### M01 — Fair-bound one-sided passive making

- Family: Selective passive liquidity and execution edge
- Decision: **COLLECT_ONLY**; research-priority score: **69/100**.
- Economic mechanism: Post only on the side whose price lies outside a conservative independent fair interval and cancel when the interval crosses the quote.
- Who pays: Impatient retail flow paying spread.
- Why it may persist: Spread/reward income persists only where uninformed flow exceeds adverse selection and queue/cancel losses.
- Capacity and half-life: $5–$100 inventory per market; quote lifetime milliseconds to hours by category.
- Required data/readiness: full books; public and authenticated fills; queue-ahead; cancel acknowledgements; fee/reward schedule; 1/5/30s markouts. C — public flow exists; authenticated queue/fill fidelity is absent and generic controls are strongly negative.
- Execution/legs: One-sided post-only quote inside a conservative fair-value interval; hedge or cancel on bound violation; inventory-aware.
- Latency: 20–100 ms internal reaction is useful; feed quality and cancel acknowledgement dominate CPU micro-optimization.
- Full cost model: Adverse markout + non-fill/queue + inventory capital + hedge/taker fee − maker rewards/rebates actually earned.
- Legal/rule dependency: Post-only, heartbeat, reward eligibility, tick-size and self-trade rules.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing selective passive liquidity and execution edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One market-session or one quote episode separated by flat inventory.
- Leakage/selection risk: Assuming public prints imply own fills, ignoring queue ahead, and filtering toxicity after observing markout.
- Infrastructure: Dedicated event process, local books/fair bounds, queue simulator, authenticated user channel only after promotion.
- Time/storage: 30 days; event transitions only in SQL, raw books in Parquet.
- Why this is not stale retail logic: It is conditional and fair-bound-driven; generic two-sided quoting remains a negative control.
- Existing evidence: Staged, not active; authenticated queue/fill evidence is missing.
- Source keys: polymarketOrders, polymarketBooks, polymarketFees, ofiPaper

### C03 — Fixed-expiry cash-and-carry

- Family: Crypto CEX/perpetual relative value
- Decision: **BLOCKED_DATA**; research-priority score: **68/100**.
- Economic mechanism: Lock spot/future basis to expiry where contract size and fees fit the bankroll.
- Who pays: Futures traders paying financing convenience.
- Why it may persist: Fragmented inventory, funding and venue-specific order flow can create short-lived relative-value effects; most simple signals are crowded.
- Capacity and half-life: $50–$1,000 nominal capacity, but minimum orders and hedge margin matter; half-life from 100 ms to days.
- Required data/readiness: sequenced CEX books/trades; venue fees; funding/index/mark series; order latency; terminal forward returns. B for Binance/Coinbase/Hyperliquid market data; C for funding and authenticated fill fidelity.
- Execution/legs: Pre-funded inventory, simultaneous IOC/FOK where available, conservative cross-book depth and inventory rebalance.
- Latency: 20–500 ms for microstructure; minutes/days for funding and cointegration. Dublin fit must be benchmarked by venue.
- Full cost model: Maker/taker fees + spread/depth + funding/borrow + liquidation/gap reserve + transfer/rebalance.
- Legal/rule dependency: Account jurisdiction, leverage eligibility, index methodology, liquidation and custody terms.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing crypto cex/perpetual relative value data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: Non-overlapping episode or venue funding interval; cluster by day and asset state.
- Leakage/selection risk: Pair/horizon mining, exchange-clock misalignment and survivor bias in symbols/venues.
- Infrastructure: Unified event schema, local books, fee/funding versioning, causal replay and pre-funded inventory simulator.
- Time/storage: 14–30 days; raw depth is expensive, so preserve deltas and periodic snapshots rather than repeated full books.
- Why this is not stale retail logic: Only state-conditioned, depth-executable effects survive screening; generic RSI/momentum is a rejected control.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: binanceStreams, coinbaseStreams, hyperliquidStreams, ofiPaper

### X12 — Multi-venue exhaustive outcome set

- Family: Rule-aware prediction/sports cross-venue relationships
- Decision: **CHEAP_FALSIFICATION**; research-priority score: **68/100**.
- Economic mechanism: Select cheapest executable outcome leg across venues to cover every terminal state below payout.
- Who pays: Fragmented outcome liquidity across two or more venues.
- Why it may persist: Venue segmentation and trapped capital can sustain basis for seconds to days; identity errors can persist to settlement as losses.
- Capacity and half-life: $5–$250 per pair may fit this bankroll; basis half-life and capital-hours must be estimated by typed pair.
- Required data/readiness: both venues full depth; source/receive clocks; per-market fees; immutable rules; identity dimensions; terminal outcomes. B-/C+ — synchronized feeds exist, but no certified-equal pair and Kalshi rule coverage is sparse.
- Execution/legs: Pre-fund both venues; synchronize depth; veto UNKNOWN; model sequential legs and emergency unwind. No cross-venue atomicity claim.
- Latency: Convergence can be seconds to days; 100–500 ms matters for leg risk, not all opportunity creation.
- Full cost model: Both venue fees and rounding + depth + reject/non-fill + transfer/rebalance + orphan loss + capital duration.
- Legal/rule dependency: Venue eligibility, account limits, exact settlement rules and withdrawal/custody constraints must be current.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing rule-aware prediction/sports cross-venue relationships data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: Pair-direction-day or one non-overlapping dislocation episode, not each polling observation.
- Leakage/selection risk: Text similarity is not payoff identity; overlapping episodes and manual approvals can leak future knowledge.
- Infrastructure: Typed contract normalizer, hard-mismatch veto, synchronized dual books, two-leg state machine and capital clock.
- Time/storage: 30 days and at least 300 pair-days; existing depth capture is reusable.
- Why this is not stale retail logic: It tests rule friction and capital segmentation rather than a naive midpoint comparison.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketFees, polymarketOrders, kalshiOrders, kalshiFees, kalshiBooks

### O01 — Exact-expiry digital probability interval

- Family: Options-implied binary pricing and volatility
- Decision: **COLLECT_ONLY**; research-priority score: **67/100**.
- Economic mechanism: Extract a risk-neutral digital bid/ask probability bound from exact-expiry verticals and compare it with executable prediction asks.
- Who pays: Segmented option and prediction-market liquidity.
- Why it may persist: Segmentation between option and prediction venues may leave small residuals, but risk-neutral probability is not physical probability.
- Capacity and half-life: $5–$100 prediction leg; hedge capital can dominate. Half-life ranges from seconds to expiry.
- Required data/readiness: sequenced Deribit bid/ask books; exact expiry/strike mapping; forward/funding curve; prediction full depth; resolver mapping. C+ — surfaces are captured but current mapped targets are interpolated, not exact-expiry executable evidence.
- Execution/legs: Construct arbitrage-free bid/ask probability bounds, walk prediction and hedge books, quantify delta/gamma/vega/jump residual.
- Latency: 100 ms–minutes depending on surface move; synchronization matters more than sub-2 ms local compute.
- Full cost model: Prediction fees + option/perp fees + bid/ask + hedge rebalance + funding + residual jump/gamma reserve.
- Legal/rule dependency: Expiry instant, index source, exercise convention, contract multiplier and prediction resolver must align.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing options-implied binary pricing and volatility data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One market/expiry event; multiple marks are diagnostics, not independent observations.
- Leakage/selection risk: Surface smoothing through future quotes, unsupported interpolation and choosing only favorable strikes.
- Infrastructure: Sequenced surface builder, no-arbitrage cleaner, digital bound extractor, synchronized hedge simulator.
- Time/storage: 30 days; moderate derived storage, raw Deribit books dominate.
- Why this is not stale retail logic: It uses executable 2026 surfaces and small segmented prediction capacity, not textbook Black–Scholes point estimates.
- Existing evidence: Current V4 has zero exact-expiry A-grade mapped targets.
- Source keys: deribitBooks, polymarketFees, polymarketBooks

### O02 — Vertical-spread no-arbitrage bounds

- Family: Options-implied binary pricing and volatility
- Decision: **COLLECT_ONLY**; research-priority score: **67/100**.
- Economic mechanism: Use executable adjacent strikes to bound a binary payoff without relying on a smooth fitted surface.
- Who pays: Prediction quotes outside option-replicable bounds.
- Why it may persist: Segmentation between option and prediction venues may leave small residuals, but risk-neutral probability is not physical probability.
- Capacity and half-life: $5–$100 prediction leg; hedge capital can dominate. Half-life ranges from seconds to expiry.
- Required data/readiness: sequenced Deribit bid/ask books; exact expiry/strike mapping; forward/funding curve; prediction full depth; resolver mapping. C+ — surfaces are captured but current mapped targets are interpolated, not exact-expiry executable evidence.
- Execution/legs: Construct arbitrage-free bid/ask probability bounds, walk prediction and hedge books, quantify delta/gamma/vega/jump residual.
- Latency: 100 ms–minutes depending on surface move; synchronization matters more than sub-2 ms local compute.
- Full cost model: Prediction fees + option/perp fees + bid/ask + hedge rebalance + funding + residual jump/gamma reserve.
- Legal/rule dependency: Expiry instant, index source, exercise convention, contract multiplier and prediction resolver must align.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing options-implied binary pricing and volatility data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One market/expiry event; multiple marks are diagnostics, not independent observations.
- Leakage/selection risk: Surface smoothing through future quotes, unsupported interpolation and choosing only favorable strikes.
- Infrastructure: Sequenced surface builder, no-arbitrage cleaner, digital bound extractor, synchronized hedge simulator.
- Time/storage: 30 days; moderate derived storage, raw Deribit books dominate.
- Why this is not stale retail logic: It uses executable 2026 surfaces and small segmented prediction capacity, not textbook Black–Scholes point estimates.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: deribitBooks, polymarketFees, polymarketBooks

### R02 — Pyth boundary residual

- Family: Resolver and observation-boundary transfer
- Decision: **BLOCKED_DATA**; research-priority score: **66/100**.
- Economic mechanism: Replicate the H43-X architecture only for contracts explicitly settled from Pyth and a non-empty authenticated source feed.
- Who pays: Prediction quotes lagging Pyth-specific state.
- Why it may persist: Small source-specific residuals can survive near a hard observation boundary because the binary payoff references a particular oracle.
- Capacity and half-life: $5–$50 per market; half-life is usually seconds and expires at the observation boundary.
- Required data/readiness: authoritative resolver ticks; market opening reference; source/receive clocks; executable token book; terminal outcome. B+ for Chainlink; C/D for sources whose sockets are empty or rule mapping is incomplete.
- Execution/legs: Use market quote as prior, add only a frozen resolver residual, require conservative lower bound above executable ask and doubled cost.
- Latency: 20–500 ms can affect fillability near expiry; source correctness and remaining-time tail dominate.
- Full cost model: Current token fee + one tick + walked depth + latency decay + source outage/fallback reserve.
- Legal/rule dependency: Exact resolver, opening/closing timestamp, precision, fallback and dispute process are mandatory.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing resolver and observation-boundary transfer data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One resolved market window.
- Leakage/selection risk: Tail envelopes trained through the test window, repeated ticks per market and post-hoc asset selection.
- Infrastructure: Resolver RTDS/WSS, opening-reference attestation, causal clocks, frozen empirical tail artifact and book replay.
- Time/storage: 14+ days and 300 fresh markets; low incremental disk because core feeds already exist.
- Why this is not stale retail logic: The contract-specific resolver is an operational wrinkle absent from generic CEX momentum.
- Existing evidence: Prior Pyth attempts had heartbeats but unusable/empty source evidence.
- Source keys: polymarketFees, polymarketResolution, polymarketBooks

### R03 — CF Benchmarks boundary residual

- Family: Resolver and observation-boundary transfer
- Decision: **BLOCKED_DATA**; research-priority score: **66/100**.
- Economic mechanism: Map the exact CF index construction and forecast only the bounded difference from liquid constituent venues near observation.
- Who pays: Quote setters approximating rather than reproducing the CF index.
- Why it may persist: Small source-specific residuals can survive near a hard observation boundary because the binary payoff references a particular oracle.
- Capacity and half-life: $5–$50 per market; half-life is usually seconds and expires at the observation boundary.
- Required data/readiness: authoritative resolver ticks; market opening reference; source/receive clocks; executable token book; terminal outcome. B+ for Chainlink; C/D for sources whose sockets are empty or rule mapping is incomplete.
- Execution/legs: Use market quote as prior, add only a frozen resolver residual, require conservative lower bound above executable ask and doubled cost.
- Latency: 20–500 ms can affect fillability near expiry; source correctness and remaining-time tail dominate.
- Full cost model: Current token fee + one tick + walked depth + latency decay + source outage/fallback reserve.
- Legal/rule dependency: Exact resolver, opening/closing timestamp, precision, fallback and dispute process are mandatory.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing resolver and observation-boundary transfer data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One resolved market window.
- Leakage/selection risk: Tail envelopes trained through the test window, repeated ticks per market and post-hoc asset selection.
- Infrastructure: Resolver RTDS/WSS, opening-reference attestation, causal clocks, frozen empirical tail artifact and book replay.
- Time/storage: 14+ days and 300 fresh markets; low incremental disk because core feeds already exist.
- Why this is not stale retail logic: The contract-specific resolver is an operational wrinkle absent from generic CEX momentum.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketFees, polymarketResolution, polymarketBooks

### X02 — Exact-identity convergence

- Family: Rule-aware prediction/sports cross-venue relationships
- Decision: **CHEAP_FALSIFICATION**; research-priority score: **66/100**.
- Economic mechanism: Open offsetting venue positions on a certified identity during a basis dislocation and close both after convergence instead of waiting to resolution.
- Who pays: Slow capital movement and venue-specific inventory shocks.
- Why it may persist: Venue segmentation and trapped capital can sustain basis for seconds to days; identity errors can persist to settlement as losses.
- Capacity and half-life: $5–$250 per pair may fit this bankroll; basis half-life and capital-hours must be estimated by typed pair.
- Required data/readiness: both venues full depth; source/receive clocks; per-market fees; immutable rules; identity dimensions; terminal outcomes. B-/C+ — synchronized feeds exist, but no certified-equal pair and Kalshi rule coverage is sparse.
- Execution/legs: Pre-fund both venues; synchronize depth; veto UNKNOWN; model sequential legs and emergency unwind. No cross-venue atomicity claim.
- Latency: Convergence can be seconds to days; 100–500 ms matters for leg risk, not all opportunity creation.
- Full cost model: Both venue fees and rounding + depth + reject/non-fill + transfer/rebalance + orphan loss + capital duration.
- Legal/rule dependency: Venue eligibility, account limits, exact settlement rules and withdrawal/custody constraints must be current.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing rule-aware prediction/sports cross-venue relationships data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: Pair-direction-day or one non-overlapping dislocation episode, not each polling observation.
- Leakage/selection risk: Text similarity is not payoff identity; overlapping episodes and manual approvals can leak future knowledge.
- Infrastructure: Typed contract normalizer, hard-mismatch veto, synchronized dual books, two-leg state machine and capital clock.
- Time/storage: 30 days and at least 300 pair-days; existing depth capture is reusable.
- Why this is not stale retail logic: It tests rule friction and capital segmentation rather than a naive midpoint comparison.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketFees, polymarketOrders, kalshiOrders, kalshiFees, kalshiBooks

### X07 — Capital-duration terminal carry

- Family: Rule-aware prediction/sports cross-venue relationships
- Decision: **CHEAP_FALSIFICATION**; research-priority score: **66/100**.
- Economic mechanism: Rank certified locks by guaranteed profit per dollar-hour rather than raw spread, including venue-specific settlement delay.
- Who pays: Capital-constrained participants leaving long-duration basis open.
- Why it may persist: Venue segmentation and trapped capital can sustain basis for seconds to days; identity errors can persist to settlement as losses.
- Capacity and half-life: $5–$250 per pair may fit this bankroll; basis half-life and capital-hours must be estimated by typed pair.
- Required data/readiness: both venues full depth; source/receive clocks; per-market fees; immutable rules; identity dimensions; terminal outcomes. B-/C+ — synchronized feeds exist, but no certified-equal pair and Kalshi rule coverage is sparse.
- Execution/legs: Pre-fund both venues; synchronize depth; veto UNKNOWN; model sequential legs and emergency unwind. No cross-venue atomicity claim.
- Latency: Convergence can be seconds to days; 100–500 ms matters for leg risk, not all opportunity creation.
- Full cost model: Both venue fees and rounding + depth + reject/non-fill + transfer/rebalance + orphan loss + capital duration.
- Legal/rule dependency: Venue eligibility, account limits, exact settlement rules and withdrawal/custody constraints must be current.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing rule-aware prediction/sports cross-venue relationships data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: Pair-direction-day or one non-overlapping dislocation episode, not each polling observation.
- Leakage/selection risk: Text similarity is not payoff identity; overlapping episodes and manual approvals can leak future knowledge.
- Infrastructure: Typed contract normalizer, hard-mismatch veto, synchronized dual books, two-leg state machine and capital clock.
- Time/storage: 30 days and at least 300 pair-days; existing depth capture is reusable.
- Why this is not stale retail logic: It tests rule friction and capital segmentation rather than a naive midpoint comparison.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketFees, polymarketOrders, kalshiOrders, kalshiFees, kalshiBooks

### M09 — Odd-lot neglected-capacity maker

- Family: Selective passive liquidity and execution edge
- Decision: **COLLECT_ONLY**; research-priority score: **65/100**.
- Economic mechanism: Target $5–$25 quote capacity too small for institutional desks, with hard concentration and minimum-dollar profit tests.
- Who pays: Small retail orders in operationally neglected markets.
- Why it may persist: Spread/reward income persists only where uninformed flow exceeds adverse selection and queue/cancel losses.
- Capacity and half-life: $5–$100 inventory per market; quote lifetime milliseconds to hours by category.
- Required data/readiness: full books; public and authenticated fills; queue-ahead; cancel acknowledgements; fee/reward schedule; 1/5/30s markouts. C — public flow exists; authenticated queue/fill fidelity is absent and generic controls are strongly negative.
- Execution/legs: One-sided post-only quote inside a conservative fair-value interval; hedge or cancel on bound violation; inventory-aware.
- Latency: 20–100 ms internal reaction is useful; feed quality and cancel acknowledgement dominate CPU micro-optimization.
- Full cost model: Adverse markout + non-fill/queue + inventory capital + hedge/taker fee − maker rewards/rebates actually earned.
- Legal/rule dependency: Post-only, heartbeat, reward eligibility, tick-size and self-trade rules.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing selective passive liquidity and execution edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One market-session or one quote episode separated by flat inventory.
- Leakage/selection risk: Assuming public prints imply own fills, ignoring queue ahead, and filtering toxicity after observing markout.
- Infrastructure: Dedicated event process, local books/fair bounds, queue simulator, authenticated user channel only after promotion.
- Time/storage: 30 days; event transitions only in SQL, raw books in Parquet.
- Why this is not stale retail logic: It is conditional and fair-bound-driven; generic two-sided quoting remains a negative control.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketOrders, polymarketBooks, polymarketFees, ofiPaper

### C02 — Funding-rate dispersion

- Family: Crypto CEX/perpetual relative value
- Decision: **BLOCKED_DATA**; research-priority score: **64/100**.
- Economic mechanism: Hold offsetting perpetuals on venues with divergent funding, neutralizing delta while collecting net funding after basis and liquidation reserve.
- Who pays: Venue-specific leveraged positioning.
- Why it may persist: Fragmented inventory, funding and venue-specific order flow can create short-lived relative-value effects; most simple signals are crowded.
- Capacity and half-life: $50–$1,000 nominal capacity, but minimum orders and hedge margin matter; half-life from 100 ms to days.
- Required data/readiness: sequenced CEX books/trades; venue fees; funding/index/mark series; order latency; terminal forward returns. B for Binance/Coinbase/Hyperliquid market data; C for funding and authenticated fill fidelity.
- Execution/legs: Pre-funded inventory, simultaneous IOC/FOK where available, conservative cross-book depth and inventory rebalance.
- Latency: 20–500 ms for microstructure; minutes/days for funding and cointegration. Dublin fit must be benchmarked by venue.
- Full cost model: Maker/taker fees + spread/depth + funding/borrow + liquidation/gap reserve + transfer/rebalance.
- Legal/rule dependency: Account jurisdiction, leverage eligibility, index methodology, liquidation and custody terms.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing crypto cex/perpetual relative value data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: Non-overlapping episode or venue funding interval; cluster by day and asset state.
- Leakage/selection risk: Pair/horizon mining, exchange-clock misalignment and survivor bias in symbols/venues.
- Infrastructure: Unified event schema, local books, fee/funding versioning, causal replay and pre-funded inventory simulator.
- Time/storage: 14–30 days; raw depth is expensive, so preserve deltas and periodic snapshots rather than repeated full books.
- Why this is not stale retail logic: Only state-conditioned, depth-executable effects survive screening; generic RSI/momentum is a rejected control.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: binanceStreams, coinbaseStreams, hyperliquidStreams, ofiPaper

### M05 — Low-toxicity category maker

- Family: Selective passive liquidity and execution edge
- Decision: **CHEAP_FALSIFICATION**; research-priority score: **64/100**.
- Economic mechanism: Pre-register categories where 1/5/30-second public-flow markouts and spread exceed costs, then forward-test unchanged.
- Who pays: Less-informed takers in obscure categories.
- Why it may persist: Spread/reward income persists only where uninformed flow exceeds adverse selection and queue/cancel losses.
- Capacity and half-life: $5–$100 inventory per market; quote lifetime milliseconds to hours by category.
- Required data/readiness: full books; public and authenticated fills; queue-ahead; cancel acknowledgements; fee/reward schedule; 1/5/30s markouts. C — public flow exists; authenticated queue/fill fidelity is absent and generic controls are strongly negative.
- Execution/legs: One-sided post-only quote inside a conservative fair-value interval; hedge or cancel on bound violation; inventory-aware.
- Latency: 20–100 ms internal reaction is useful; feed quality and cancel acknowledgement dominate CPU micro-optimization.
- Full cost model: Adverse markout + non-fill/queue + inventory capital + hedge/taker fee − maker rewards/rebates actually earned.
- Legal/rule dependency: Post-only, heartbeat, reward eligibility, tick-size and self-trade rules.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing selective passive liquidity and execution edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One market-session or one quote episode separated by flat inventory.
- Leakage/selection risk: Assuming public prints imply own fills, ignoring queue ahead, and filtering toxicity after observing markout.
- Infrastructure: Dedicated event process, local books/fair bounds, queue simulator, authenticated user channel only after promotion.
- Time/storage: 30 days; event transitions only in SQL, raw books in Parquet.
- Why this is not stale retail logic: It is conditional and fair-bound-driven; generic two-sided quoting remains a negative control.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketOrders, polymarketBooks, polymarketFees, ofiPaper

### X03 — Typed near-identity convergence

- Family: Rule-aware prediction/sports cross-venue relationships
- Decision: **CHEAP_FALSIFICATION**; research-priority score: **64/100**.
- Economic mechanism: Model similar but non-identical contracts by mismatch class and demand a reserve for states where they resolve differently.
- Who pays: Participants who price semantic similarity inconsistently.
- Why it may persist: Venue segmentation and trapped capital can sustain basis for seconds to days; identity errors can persist to settlement as losses.
- Capacity and half-life: $5–$250 per pair may fit this bankroll; basis half-life and capital-hours must be estimated by typed pair.
- Required data/readiness: both venues full depth; source/receive clocks; per-market fees; immutable rules; identity dimensions; terminal outcomes. B-/C+ — synchronized feeds exist, but no certified-equal pair and Kalshi rule coverage is sparse.
- Execution/legs: Pre-fund both venues; synchronize depth; veto UNKNOWN; model sequential legs and emergency unwind. No cross-venue atomicity claim.
- Latency: Convergence can be seconds to days; 100–500 ms matters for leg risk, not all opportunity creation.
- Full cost model: Both venue fees and rounding + depth + reject/non-fill + transfer/rebalance + orphan loss + capital duration.
- Legal/rule dependency: Venue eligibility, account limits, exact settlement rules and withdrawal/custody constraints must be current.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing rule-aware prediction/sports cross-venue relationships data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: Pair-direction-day or one non-overlapping dislocation episode, not each polling observation.
- Leakage/selection risk: Text similarity is not payoff identity; overlapping episodes and manual approvals can leak future knowledge.
- Infrastructure: Typed contract normalizer, hard-mismatch veto, synchronized dual books, two-leg state machine and capital clock.
- Time/storage: 30 days and at least 300 pair-days; existing depth capture is reusable.
- Why this is not stale retail logic: It tests rule friction and capital segmentation rather than a naive midpoint comparison.
- Existing evidence: Broad polluted cohort was negative after resolver mismatches; clean trial has not produced enough pairs.
- Source keys: polymarketFees, polymarketOrders, kalshiOrders, kalshiFees, kalshiBooks

### X04 — Polymarket-leading Kalshi lag

- Family: Rule-aware prediction/sports cross-venue relationships
- Decision: **COLLECT_ONLY**; research-priority score: **64/100**.
- Economic mechanism: Estimate prequentially whether executable Polymarket changes predict Kalshi mid/ask changes after costs for certified pairs.
- Who pays: Slower venue-specific makers.
- Why it may persist: Venue segmentation and trapped capital can sustain basis for seconds to days; identity errors can persist to settlement as losses.
- Capacity and half-life: $5–$250 per pair may fit this bankroll; basis half-life and capital-hours must be estimated by typed pair.
- Required data/readiness: both venues full depth; source/receive clocks; per-market fees; immutable rules; identity dimensions; terminal outcomes. B-/C+ — synchronized feeds exist, but no certified-equal pair and Kalshi rule coverage is sparse.
- Execution/legs: Pre-fund both venues; synchronize depth; veto UNKNOWN; model sequential legs and emergency unwind. No cross-venue atomicity claim.
- Latency: Convergence can be seconds to days; 100–500 ms matters for leg risk, not all opportunity creation.
- Full cost model: Both venue fees and rounding + depth + reject/non-fill + transfer/rebalance + orphan loss + capital duration.
- Legal/rule dependency: Venue eligibility, account limits, exact settlement rules and withdrawal/custody constraints must be current.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing rule-aware prediction/sports cross-venue relationships data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: Pair-direction-day or one non-overlapping dislocation episode, not each polling observation.
- Leakage/selection risk: Text similarity is not payoff identity; overlapping episodes and manual approvals can leak future knowledge.
- Infrastructure: Typed contract normalizer, hard-mismatch veto, synchronized dual books, two-leg state machine and capital clock.
- Time/storage: 30 days and at least 300 pair-days; existing depth capture is reusable.
- Why this is not stale retail logic: It tests rule friction and capital segmentation rather than a naive midpoint comparison.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketFees, polymarketOrders, kalshiOrders, kalshiFees, kalshiBooks

### X05 — Kalshi-leading Polymarket lag

- Family: Rule-aware prediction/sports cross-venue relationships
- Decision: **COLLECT_ONLY**; research-priority score: **64/100**.
- Economic mechanism: Estimate the reverse directional price-discovery channel by event category and liquidity state.
- Who pays: Slower Polymarket books in regulated-news categories.
- Why it may persist: Venue segmentation and trapped capital can sustain basis for seconds to days; identity errors can persist to settlement as losses.
- Capacity and half-life: $5–$250 per pair may fit this bankroll; basis half-life and capital-hours must be estimated by typed pair.
- Required data/readiness: both venues full depth; source/receive clocks; per-market fees; immutable rules; identity dimensions; terminal outcomes. B-/C+ — synchronized feeds exist, but no certified-equal pair and Kalshi rule coverage is sparse.
- Execution/legs: Pre-fund both venues; synchronize depth; veto UNKNOWN; model sequential legs and emergency unwind. No cross-venue atomicity claim.
- Latency: Convergence can be seconds to days; 100–500 ms matters for leg risk, not all opportunity creation.
- Full cost model: Both venue fees and rounding + depth + reject/non-fill + transfer/rebalance + orphan loss + capital duration.
- Legal/rule dependency: Venue eligibility, account limits, exact settlement rules and withdrawal/custody constraints must be current.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing rule-aware prediction/sports cross-venue relationships data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: Pair-direction-day or one non-overlapping dislocation episode, not each polling observation.
- Leakage/selection risk: Text similarity is not payoff identity; overlapping episodes and manual approvals can leak future knowledge.
- Infrastructure: Typed contract normalizer, hard-mismatch veto, synchronized dual books, two-leg state machine and capital clock.
- Time/storage: 30 days and at least 300 pair-days; existing depth capture is reusable.
- Why this is not stale retail logic: It tests rule friction and capital segmentation rather than a naive midpoint comparison.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketFees, polymarketOrders, kalshiOrders, kalshiFees, kalshiBooks

### X06 — Post-announcement asynchronous repricing

- Family: Rule-aware prediction/sports cross-venue relationships
- Decision: **BLOCKED_DATA**; research-priority score: **64/100**.
- Economic mechanism: After an official release, trade only the lagging venue in a certified pair while the leading venue supplies a conservative fair bound.
- Who pays: Temporarily stale quote providers.
- Why it may persist: Venue segmentation and trapped capital can sustain basis for seconds to days; identity errors can persist to settlement as losses.
- Capacity and half-life: $5–$250 per pair may fit this bankroll; basis half-life and capital-hours must be estimated by typed pair.
- Required data/readiness: causal official-news timestamp; both venue books; typed rules; fees. B-/C+ — synchronized feeds exist, but no certified-equal pair and Kalshi rule coverage is sparse.
- Execution/legs: Pre-fund both venues; synchronize depth; veto UNKNOWN; model sequential legs and emergency unwind. No cross-venue atomicity claim.
- Latency: Convergence can be seconds to days; 100–500 ms matters for leg risk, not all opportunity creation.
- Full cost model: Both venue fees and rounding + depth + reject/non-fill + transfer/rebalance + orphan loss + capital duration.
- Legal/rule dependency: Venue eligibility, account limits, exact settlement rules and withdrawal/custody constraints must be current.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing rule-aware prediction/sports cross-venue relationships data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: Pair-direction-day or one non-overlapping dislocation episode, not each polling observation.
- Leakage/selection risk: Text similarity is not payoff identity; overlapping episodes and manual approvals can leak future knowledge.
- Infrastructure: Typed contract normalizer, hard-mismatch veto, synchronized dual books, two-leg state machine and capital clock.
- Time/storage: 30 days and at least 300 pair-days; existing depth capture is reusable.
- Why this is not stale retail logic: It tests rule friction and capital segmentation rather than a naive midpoint comparison.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketFees, polymarketOrders, kalshiOrders, kalshiFees, kalshiBooks

### X09 — Cross-venue RFQ price improvement

- Family: Rule-aware prediction/sports cross-venue relationships
- Decision: **BLOCKED_DATA**; research-priority score: **64/100**.
- Economic mechanism: Use venue RFQ/quote mechanisms for the second leg and require a firm response before committing the first where permitted.
- Who pays: Liquidity providers willing to price block inventory privately.
- Why it may persist: Venue segmentation and trapped capital can sustain basis for seconds to days; identity errors can persist to settlement as losses.
- Capacity and half-life: $5–$250 per pair may fit this bankroll; basis half-life and capital-hours must be estimated by typed pair.
- Required data/readiness: RFQ responses; identity proof; both fee schedules; response latency. B-/C+ — synchronized feeds exist, but no certified-equal pair and Kalshi rule coverage is sparse.
- Execution/legs: Pre-fund both venues; synchronize depth; veto UNKNOWN; model sequential legs and emergency unwind. No cross-venue atomicity claim.
- Latency: Convergence can be seconds to days; 100–500 ms matters for leg risk, not all opportunity creation.
- Full cost model: Both venue fees and rounding + depth + reject/non-fill + transfer/rebalance + orphan loss + capital duration.
- Legal/rule dependency: Venue eligibility, account limits, exact settlement rules and withdrawal/custody constraints must be current.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing rule-aware prediction/sports cross-venue relationships data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: Pair-direction-day or one non-overlapping dislocation episode, not each polling observation.
- Leakage/selection risk: Text similarity is not payoff identity; overlapping episodes and manual approvals can leak future knowledge.
- Infrastructure: Typed contract normalizer, hard-mismatch veto, synchronized dual books, two-leg state machine and capital clock.
- Time/storage: 30 days and at least 300 pair-days; existing depth capture is reusable.
- Why this is not stale retail logic: It tests rule friction and capital segmentation rather than a naive midpoint comparison.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketFees, polymarketOrders, kalshiOrders, kalshiFees, kalshiBooks

### X10 — Sportsbook three-way dutching

- Family: Rule-aware prediction/sports cross-venue relationships
- Decision: **BLOCKED_DATA**; research-priority score: **64/100**.
- Economic mechanism: Remove vig from mutually exclusive home/draw/away books and combine only enforceable account limits and matching settlement rules.
- Who pays: Bookmakers/prediction venues with different customer flow.
- Why it may persist: Venue segmentation and trapped capital can sustain basis for seconds to days; identity errors can persist to settlement as losses.
- Capacity and half-life: $5–$250 per pair may fit this bankroll; basis half-life and capital-hours must be estimated by typed pair.
- Required data/readiness: both venues full depth; source/receive clocks; per-market fees; immutable rules; identity dimensions; terminal outcomes. B-/C+ — synchronized feeds exist, but no certified-equal pair and Kalshi rule coverage is sparse.
- Execution/legs: Pre-fund both venues; synchronize depth; veto UNKNOWN; model sequential legs and emergency unwind. No cross-venue atomicity claim.
- Latency: Convergence can be seconds to days; 100–500 ms matters for leg risk, not all opportunity creation.
- Full cost model: Both venue fees and rounding + depth + reject/non-fill + transfer/rebalance + orphan loss + capital duration.
- Legal/rule dependency: Bookmaker account eligibility, stake limits, void rules and withdrawal terms are hard constraints.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing rule-aware prediction/sports cross-venue relationships data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: Pair-direction-day or one non-overlapping dislocation episode, not each polling observation.
- Leakage/selection risk: Text similarity is not payoff identity; overlapping episodes and manual approvals can leak future knowledge.
- Infrastructure: Typed contract normalizer, hard-mismatch veto, synchronized dual books, two-leg state machine and capital clock.
- Time/storage: 30 days and at least 300 pair-days; existing depth capture is reusable.
- Why this is not stale retail logic: It tests rule friction and capital segmentation rather than a naive midpoint comparison.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketFees, polymarketOrders, kalshiOrders, kalshiFees, kalshiBooks

### X11 — Exchange-versus-bookmaker lay hedge

- Family: Rule-aware prediction/sports cross-venue relationships
- Decision: **BLOCKED_DATA**; research-priority score: **64/100**.
- Economic mechanism: Pair exchange/prediction YES with a bookmaker opposite outcome only when payout, dead-heat and void clauses are statewise matched.
- Who pays: Different bookmaker and exchange customer bases.
- Why it may persist: Venue segmentation and trapped capital can sustain basis for seconds to days; identity errors can persist to settlement as losses.
- Capacity and half-life: $5–$250 per pair may fit this bankroll; basis half-life and capital-hours must be estimated by typed pair.
- Required data/readiness: both venues full depth; source/receive clocks; per-market fees; immutable rules; identity dimensions; terminal outcomes. B-/C+ — synchronized feeds exist, but no certified-equal pair and Kalshi rule coverage is sparse.
- Execution/legs: Pre-fund both venues; synchronize depth; veto UNKNOWN; model sequential legs and emergency unwind. No cross-venue atomicity claim.
- Latency: Convergence can be seconds to days; 100–500 ms matters for leg risk, not all opportunity creation.
- Full cost model: Both venue fees and rounding + depth + reject/non-fill + transfer/rebalance + orphan loss + capital duration.
- Legal/rule dependency: Venue eligibility, account limits, exact settlement rules and withdrawal/custody constraints must be current.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing rule-aware prediction/sports cross-venue relationships data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: Pair-direction-day or one non-overlapping dislocation episode, not each polling observation.
- Leakage/selection risk: Text similarity is not payoff identity; overlapping episodes and manual approvals can leak future knowledge.
- Infrastructure: Typed contract normalizer, hard-mismatch veto, synchronized dual books, two-leg state machine and capital clock.
- Time/storage: 30 days and at least 300 pair-days; existing depth capture is reusable.
- Why this is not stale retail logic: It tests rule friction and capital segmentation rather than a naive midpoint comparison.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketFees, polymarketOrders, kalshiOrders, kalshiFees, kalshiBooks

### X14 — Settlement-latency discount

- Family: Rule-aware prediction/sports cross-venue relationships
- Decision: **COLLECT_ONLY**; research-priority score: **64/100**.
- Economic mechanism: Test whether otherwise certified contracts with slower payout exhibit a stable capital-duration discount exploitable by patient capital.
- Who pays: Impatient capital on slower settlement rails.
- Why it may persist: Venue segmentation and trapped capital can sustain basis for seconds to days; identity errors can persist to settlement as losses.
- Capacity and half-life: $5–$250 per pair may fit this bankroll; basis half-life and capital-hours must be estimated by typed pair.
- Required data/readiness: both venues full depth; source/receive clocks; per-market fees; immutable rules; identity dimensions; terminal outcomes. B-/C+ — synchronized feeds exist, but no certified-equal pair and Kalshi rule coverage is sparse.
- Execution/legs: Pre-fund both venues; synchronize depth; veto UNKNOWN; model sequential legs and emergency unwind. No cross-venue atomicity claim.
- Latency: Convergence can be seconds to days; 100–500 ms matters for leg risk, not all opportunity creation.
- Full cost model: Both venue fees and rounding + depth + reject/non-fill + transfer/rebalance + orphan loss + capital duration.
- Legal/rule dependency: Venue eligibility, account limits, exact settlement rules and withdrawal/custody constraints must be current.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing rule-aware prediction/sports cross-venue relationships data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: Pair-direction-day or one non-overlapping dislocation episode, not each polling observation.
- Leakage/selection risk: Text similarity is not payoff identity; overlapping episodes and manual approvals can leak future knowledge.
- Infrastructure: Typed contract normalizer, hard-mismatch veto, synchronized dual books, two-leg state machine and capital clock.
- Time/storage: 30 days and at least 300 pair-days; existing depth capture is reusable.
- Why this is not stale retail logic: It tests rule friction and capital segmentation rather than a naive midpoint comparison.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketFees, polymarketOrders, kalshiOrders, kalshiFees, kalshiBooks

### C04 — Pre-funded cross-exchange price lock

- Family: Crypto CEX/perpetual relative value
- Decision: **BLOCKED_DATA**; research-priority score: **63/100**.
- Economic mechanism: Simultaneously buy cheap and sell rich executable books using inventory already resident on both venues.
- Who pays: Transient inventory imbalances across exchanges.
- Why it may persist: Fragmented inventory, funding and venue-specific order flow can create short-lived relative-value effects; most simple signals are crowded.
- Capacity and half-life: $50–$1,000 nominal capacity, but minimum orders and hedge margin matter; half-life from 100 ms to days.
- Required data/readiness: sequenced CEX books/trades; venue fees; funding/index/mark series; order latency; terminal forward returns. B for Binance/Coinbase/Hyperliquid market data; C for funding and authenticated fill fidelity.
- Execution/legs: Pre-funded inventory, simultaneous IOC/FOK where available, conservative cross-book depth and inventory rebalance.
- Latency: 20–500 ms for microstructure; minutes/days for funding and cointegration. Dublin fit must be benchmarked by venue.
- Full cost model: Maker/taker fees + spread/depth + funding/borrow + liquidation/gap reserve + transfer/rebalance.
- Legal/rule dependency: Account jurisdiction, leverage eligibility, index methodology, liquidation and custody terms.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing crypto cex/perpetual relative value data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: Non-overlapping episode or venue funding interval; cluster by day and asset state.
- Leakage/selection risk: Pair/horizon mining, exchange-clock misalignment and survivor bias in symbols/venues.
- Infrastructure: Unified event schema, local books, fee/funding versioning, causal replay and pre-funded inventory simulator.
- Time/storage: 14–30 days; raw depth is expensive, so preserve deltas and periodic snapshots rather than repeated full books.
- Why this is not stale retail logic: Only state-conditioned, depth-executable effects survive screening; generic RSI/momentum is a rejected control.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: binanceStreams, coinbaseStreams, hyperliquidStreams, ofiPaper

### D01 — Same-chain atomic route arbitrage

- Family: DEX/on-chain and cross-network execution
- Decision: **BLOCKED_DATA**; research-priority score: **63/100**.
- Economic mechanism: Execute a cyclic swap whose simulated terminal balance exceeds input plus all fees/tip in one atomic bundle.
- Who pays: Temporarily inconsistent AMM curves.
- Why it may persist: Atomic state transitions can create true locks, but public MEV auctions transfer much of the surplus to validators/builders.
- Capacity and half-life: $10–$1,000 depending on pool depth; half-life is often one block/slot and competition is intense.
- Required data/readiness: full on-chain state; mempool/shred/block feed where permitted; DEX route quotes; gas/priority/tip history; CEX books when hedged. D — TV2 does not yet preserve the required causal on-chain state or landing-cost data.
- Execution/legs: Simulate exact state, submit all-or-none bundle where supported, require post-tip/gas profit and revert protection.
- Latency: Block/slot competitive; Dublin is directly useful for Jito Dublin but not proof of winning auctions.
- Full cost model: Pool fees + price impact + gas/priority fee + builder/Jito tip + failed landing opportunity cost + inventory hedge.
- Legal/rule dependency: Protocol terms, token restrictions, RPC/provider terms and anti-manipulation rules.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing dex/on-chain and cross-network execution data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One distinct block/slot opportunity with one executable state root.
- Leakage/selection risk: Historical state without competitors, ignoring failed bundles and using end-of-block reserves.
- Infrastructure: Archive node/RPC, deterministic simulator, bundle submitter in paper mode, landed-tip and failure recorder.
- Time/storage: Collector-first; 14–30 days and potentially hundreds of GiB unless universe is tightly bounded.
- Why this is not stale retail logic: Only atomic, costed opportunities are retained; 2020-style REST reserve polling is explicitly rejected.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: jitoBundles

### M03 — Reward-qualified passive quote

- Family: Selective passive liquidity and execution edge
- Decision: **COLLECT_ONLY**; research-priority score: **63/100**.
- Economic mechanism: Quote only when expected earned maker reward exceeds markout, queue and inventory cost at the exact scoring formula.
- Who pays: Venue liquidity incentives plus taker spread.
- Why it may persist: Spread/reward income persists only where uninformed flow exceeds adverse selection and queue/cancel losses.
- Capacity and half-life: $5–$100 inventory per market; quote lifetime milliseconds to hours by category.
- Required data/readiness: full books; public and authenticated fills; queue-ahead; cancel acknowledgements; fee/reward schedule; 1/5/30s markouts. C — public flow exists; authenticated queue/fill fidelity is absent and generic controls are strongly negative.
- Execution/legs: One-sided post-only quote inside a conservative fair-value interval; hedge or cancel on bound violation; inventory-aware.
- Latency: 20–100 ms internal reaction is useful; feed quality and cancel acknowledgement dominate CPU micro-optimization.
- Full cost model: Adverse markout + non-fill/queue + inventory capital + hedge/taker fee − maker rewards/rebates actually earned.
- Legal/rule dependency: Post-only, heartbeat, reward eligibility, tick-size and self-trade rules.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing selective passive liquidity and execution edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One market-session or one quote episode separated by flat inventory.
- Leakage/selection risk: Assuming public prints imply own fills, ignoring queue ahead, and filtering toxicity after observing markout.
- Infrastructure: Dedicated event process, local books/fair bounds, queue simulator, authenticated user channel only after promotion.
- Time/storage: 30 days; event transitions only in SQL, raw books in Parquet.
- Why this is not stale retail logic: It is conditional and fair-bound-driven; generic two-sided quoting remains a negative control.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketOrders, polymarketBooks, polymarketFees, ofiPaper

### C01 — Cross-venue spot/perpetual basis

- Family: Crypto CEX/perpetual relative value
- Decision: **BLOCKED_DATA**; research-priority score: **62/100**.
- Economic mechanism: Buy cheap spot and short rich perpetual, or reverse where borrow permits, when carry exceeds full round-trip and funding stress.
- Who pays: Leveraged traders paying for directional exposure and venue segmentation.
- Why it may persist: Fragmented inventory, funding and venue-specific order flow can create short-lived relative-value effects; most simple signals are crowded.
- Capacity and half-life: $50–$1,000 nominal capacity, but minimum orders and hedge margin matter; half-life from 100 ms to days.
- Required data/readiness: spot/perp books; funding history; fees; borrow/transfer costs. B for Binance/Coinbase/Hyperliquid market data; C for funding and authenticated fill fidelity.
- Execution/legs: Pre-funded inventory, simultaneous IOC/FOK where available, conservative cross-book depth and inventory rebalance.
- Latency: 20–500 ms for microstructure; minutes/days for funding and cointegration. Dublin fit must be benchmarked by venue.
- Full cost model: Maker/taker fees + spread/depth + funding/borrow + liquidation/gap reserve + transfer/rebalance.
- Legal/rule dependency: Account jurisdiction, leverage eligibility, index methodology, liquidation and custody terms.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing crypto cex/perpetual relative value data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: Non-overlapping episode or venue funding interval; cluster by day and asset state.
- Leakage/selection risk: Pair/horizon mining, exchange-clock misalignment and survivor bias in symbols/venues.
- Infrastructure: Unified event schema, local books, fee/funding versioning, causal replay and pre-funded inventory simulator.
- Time/storage: 14–30 days; raw depth is expensive, so preserve deltas and periodic snapshots rather than repeated full books.
- Why this is not stale retail logic: Only state-conditioned, depth-executable effects survive screening; generic RSI/momentum is a rejected control.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: binanceStreams, coinbaseStreams, hyperliquidStreams, ofiPaper

### C05 — BTC-to-alt conditional lead-lag

- Family: Crypto CEX/perpetual relative value
- Decision: **CHEAP_FALSIFICATION**; research-priority score: **62/100**.
- Economic mechanism: Use BTC innovations only when altcoin residual, depth and volatility state imply delayed transmission; freeze lag before forward test.
- Who pays: Slower repricing in less liquid related assets.
- Why it may persist: Fragmented inventory, funding and venue-specific order flow can create short-lived relative-value effects; most simple signals are crowded.
- Capacity and half-life: $50–$1,000 nominal capacity, but minimum orders and hedge margin matter; half-life from 100 ms to days.
- Required data/readiness: sequenced CEX books/trades; venue fees; funding/index/mark series; order latency; terminal forward returns. B for Binance/Coinbase/Hyperliquid market data; C for funding and authenticated fill fidelity.
- Execution/legs: Pre-funded inventory, simultaneous IOC/FOK where available, conservative cross-book depth and inventory rebalance.
- Latency: 20–500 ms for microstructure; minutes/days for funding and cointegration. Dublin fit must be benchmarked by venue.
- Full cost model: Maker/taker fees + spread/depth + funding/borrow + liquidation/gap reserve + transfer/rebalance.
- Legal/rule dependency: Account jurisdiction, leverage eligibility, index methodology, liquidation and custody terms.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing crypto cex/perpetual relative value data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: Non-overlapping episode or venue funding interval; cluster by day and asset state.
- Leakage/selection risk: Pair/horizon mining, exchange-clock misalignment and survivor bias in symbols/venues.
- Infrastructure: Unified event schema, local books, fee/funding versioning, causal replay and pre-funded inventory simulator.
- Time/storage: 14–30 days; raw depth is expensive, so preserve deltas and periodic snapshots rather than repeated full books.
- Why this is not stale retail logic: Only state-conditioned, depth-executable effects survive screening; generic RSI/momentum is a rejected control.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: binanceStreams, coinbaseStreams, hyperliquidStreams, ofiPaper

### D02 — Solana Jito atomic cross-DEX route

- Family: DEX/on-chain and cross-network execution
- Decision: **BLOCKED_DATA**; research-priority score: **62/100**.
- Economic mechanism: Submit a state-asserted multi-DEX route to the Dublin Jito block engine with revert protection and competitive tip.
- Who pays: Fragmented Solana pool liquidity.
- Why it may persist: Atomic state transitions can create true locks, but public MEV auctions transfer much of the surplus to validators/builders.
- Capacity and half-life: $10–$1,000 depending on pool depth; half-life is often one block/slot and competition is intense.
- Required data/readiness: full on-chain state; mempool/shred/block feed where permitted; DEX route quotes; gas/priority/tip history; CEX books when hedged. D — TV2 does not yet preserve the required causal on-chain state or landing-cost data.
- Execution/legs: Simulate exact state, submit all-or-none bundle where supported, require post-tip/gas profit and revert protection.
- Latency: Block/slot competitive; Dublin is directly useful for Jito Dublin but not proof of winning auctions.
- Full cost model: Pool fees + price impact + gas/priority fee + builder/Jito tip + failed landing opportunity cost + inventory hedge.
- Legal/rule dependency: Protocol terms, token restrictions, RPC/provider terms and anti-manipulation rules.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing dex/on-chain and cross-network execution data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One distinct block/slot opportunity with one executable state root.
- Leakage/selection risk: Historical state without competitors, ignoring failed bundles and using end-of-block reserves.
- Infrastructure: Archive node/RPC, deterministic simulator, bundle submitter in paper mode, landed-tip and failure recorder.
- Time/storage: Collector-first; 14–30 days and potentially hundreds of GiB unless universe is tightly bounded.
- Why this is not stale retail logic: Only atomic, costed opportunities are retained; 2020-style REST reserve polling is explicitly rejected.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: jitoBundles

### X13 — Rule-risk basis portfolio

- Family: Rule-aware prediction/sports cross-venue relationships
- Decision: **COLLECT_ONLY**; research-priority score: **62/100**.
- Economic mechanism: Price mismatch classes as explicit rare loss states and test whether persistent basis compensates them over resolved pairs.
- Who pays: Investors demanding a premium for resolver/wording risk.
- Why it may persist: Venue segmentation and trapped capital can sustain basis for seconds to days; identity errors can persist to settlement as losses.
- Capacity and half-life: $5–$250 per pair may fit this bankroll; basis half-life and capital-hours must be estimated by typed pair.
- Required data/readiness: both venues full depth; source/receive clocks; per-market fees; immutable rules; identity dimensions; terminal outcomes. B-/C+ — synchronized feeds exist, but no certified-equal pair and Kalshi rule coverage is sparse.
- Execution/legs: Pre-fund both venues; synchronize depth; veto UNKNOWN; model sequential legs and emergency unwind. No cross-venue atomicity claim.
- Latency: Convergence can be seconds to days; 100–500 ms matters for leg risk, not all opportunity creation.
- Full cost model: Both venue fees and rounding + depth + reject/non-fill + transfer/rebalance + orphan loss + capital duration.
- Legal/rule dependency: Venue eligibility, account limits, exact settlement rules and withdrawal/custody constraints must be current.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing rule-aware prediction/sports cross-venue relationships data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: Pair-direction-day or one non-overlapping dislocation episode, not each polling observation.
- Leakage/selection risk: Text similarity is not payoff identity; overlapping episodes and manual approvals can leak future knowledge.
- Infrastructure: Typed contract normalizer, hard-mismatch veto, synchronized dual books, two-leg state machine and capital clock.
- Time/storage: 30 days and at least 300 pair-days; existing depth capture is reusable.
- Why this is not stale retail logic: It tests rule friction and capital segmentation rather than a naive midpoint comparison.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketFees, polymarketOrders, kalshiOrders, kalshiFees, kalshiBooks

### C06 — ETH-to-SOL conditional lead-lag

- Family: Crypto CEX/perpetual relative value
- Decision: **CHEAP_FALSIFICATION**; research-priority score: **61/100**.
- Economic mechanism: Forecast the residual after contemporaneous beta, activating only in states with historically stable ETH price discovery.
- Who pays: Fragmented cross-asset liquidity.
- Why it may persist: Fragmented inventory, funding and venue-specific order flow can create short-lived relative-value effects; most simple signals are crowded.
- Capacity and half-life: $50–$1,000 nominal capacity, but minimum orders and hedge margin matter; half-life from 100 ms to days.
- Required data/readiness: sequenced CEX books/trades; venue fees; funding/index/mark series; order latency; terminal forward returns. B for Binance/Coinbase/Hyperliquid market data; C for funding and authenticated fill fidelity.
- Execution/legs: Pre-funded inventory, simultaneous IOC/FOK where available, conservative cross-book depth and inventory rebalance.
- Latency: 20–500 ms for microstructure; minutes/days for funding and cointegration. Dublin fit must be benchmarked by venue.
- Full cost model: Maker/taker fees + spread/depth + funding/borrow + liquidation/gap reserve + transfer/rebalance.
- Legal/rule dependency: Account jurisdiction, leverage eligibility, index methodology, liquidation and custody terms.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing crypto cex/perpetual relative value data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: Non-overlapping episode or venue funding interval; cluster by day and asset state.
- Leakage/selection risk: Pair/horizon mining, exchange-clock misalignment and survivor bias in symbols/venues.
- Infrastructure: Unified event schema, local books, fee/funding versioning, causal replay and pre-funded inventory simulator.
- Time/storage: 14–30 days; raw depth is expensive, so preserve deltas and periodic snapshots rather than repeated full books.
- Why this is not stale retail logic: Only state-conditioned, depth-executable effects survive screening; generic RSI/momentum is a rejected control.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: binanceStreams, coinbaseStreams, hyperliquidStreams, ofiPaper

### C08 — Cross-asset order-flow imbalance

- Family: Crypto CEX/perpetual relative value
- Decision: **CHEAP_FALSIFICATION**; research-priority score: **61/100**.
- Economic mechanism: Test whether depth-normalized OFI in the price-discovery asset predicts executable returns in a related lagging asset.
- Who pays: Slower market makers reacting to related-asset book events.
- Why it may persist: Fragmented inventory, funding and venue-specific order flow can create short-lived relative-value effects; most simple signals are crowded.
- Capacity and half-life: $50–$1,000 nominal capacity, but minimum orders and hedge margin matter; half-life from 100 ms to days.
- Required data/readiness: sequenced CEX books/trades; venue fees; funding/index/mark series; order latency; terminal forward returns. B for Binance/Coinbase/Hyperliquid market data; C for funding and authenticated fill fidelity.
- Execution/legs: Pre-funded inventory, simultaneous IOC/FOK where available, conservative cross-book depth and inventory rebalance.
- Latency: 20–500 ms for microstructure; minutes/days for funding and cointegration. Dublin fit must be benchmarked by venue.
- Full cost model: Maker/taker fees + spread/depth + funding/borrow + liquidation/gap reserve + transfer/rebalance.
- Legal/rule dependency: Account jurisdiction, leverage eligibility, index methodology, liquidation and custody terms.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing crypto cex/perpetual relative value data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: Non-overlapping episode or venue funding interval; cluster by day and asset state.
- Leakage/selection risk: Pair/horizon mining, exchange-clock misalignment and survivor bias in symbols/venues.
- Infrastructure: Unified event schema, local books, fee/funding versioning, causal replay and pre-funded inventory simulator.
- Time/storage: 14–30 days; raw depth is expensive, so preserve deltas and periodic snapshots rather than repeated full books.
- Why this is not stale retail logic: Only state-conditioned, depth-executable effects survive screening; generic RSI/momentum is a rejected control.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: binanceStreams, coinbaseStreams, hyperliquidStreams, ofiPaper

### M02 — Inventory-skewed selective quote

- Family: Selective passive liquidity and execution edge
- Decision: **COLLECT_ONLY**; research-priority score: **61/100**.
- Economic mechanism: Quote one side based on current inventory and terminal state risk rather than maintaining symmetric two-sided exposure.
- Who pays: Retail takers demanding immediacy.
- Why it may persist: Spread/reward income persists only where uninformed flow exceeds adverse selection and queue/cancel losses.
- Capacity and half-life: $5–$100 inventory per market; quote lifetime milliseconds to hours by category.
- Required data/readiness: full books; public and authenticated fills; queue-ahead; cancel acknowledgements; fee/reward schedule; 1/5/30s markouts. C — public flow exists; authenticated queue/fill fidelity is absent and generic controls are strongly negative.
- Execution/legs: One-sided post-only quote inside a conservative fair-value interval; hedge or cancel on bound violation; inventory-aware.
- Latency: 20–100 ms internal reaction is useful; feed quality and cancel acknowledgement dominate CPU micro-optimization.
- Full cost model: Adverse markout + non-fill/queue + inventory capital + hedge/taker fee − maker rewards/rebates actually earned.
- Legal/rule dependency: Post-only, heartbeat, reward eligibility, tick-size and self-trade rules.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing selective passive liquidity and execution edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One market-session or one quote episode separated by flat inventory.
- Leakage/selection risk: Assuming public prints imply own fills, ignoring queue ahead, and filtering toxicity after observing markout.
- Infrastructure: Dedicated event process, local books/fair bounds, queue simulator, authenticated user channel only after promotion.
- Time/storage: 30 days; event transitions only in SQL, raw books in Parquet.
- Why this is not stale retail logic: It is conditional and fair-bound-driven; generic two-sided quoting remains a negative control.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketOrders, polymarketBooks, polymarketFees, ofiPaper

### M06 — Queue-survival quote filter

- Family: Selective passive liquidity and execution edge
- Decision: **BLOCKED_DATA**; research-priority score: **61/100**.
- Economic mechanism: Enter only where estimated queue ahead and expected trade arrival imply fill before fair-bound expiry.
- Who pays: Takers crossing an existing queue.
- Why it may persist: Spread/reward income persists only where uninformed flow exceeds adverse selection and queue/cancel losses.
- Capacity and half-life: $5–$100 inventory per market; quote lifetime milliseconds to hours by category.
- Required data/readiness: authenticated queue/fills; full order events; trade arrivals. C — public flow exists; authenticated queue/fill fidelity is absent and generic controls are strongly negative.
- Execution/legs: One-sided post-only quote inside a conservative fair-value interval; hedge or cancel on bound violation; inventory-aware.
- Latency: 20–100 ms internal reaction is useful; feed quality and cancel acknowledgement dominate CPU micro-optimization.
- Full cost model: Adverse markout + non-fill/queue + inventory capital + hedge/taker fee − maker rewards/rebates actually earned.
- Legal/rule dependency: Post-only, heartbeat, reward eligibility, tick-size and self-trade rules.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing selective passive liquidity and execution edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One market-session or one quote episode separated by flat inventory.
- Leakage/selection risk: Assuming public prints imply own fills, ignoring queue ahead, and filtering toxicity after observing markout.
- Infrastructure: Dedicated event process, local books/fair bounds, queue simulator, authenticated user channel only after promotion.
- Time/storage: 30 days; event transitions only in SQL, raw books in Parquet.
- Why this is not stale retail logic: It is conditional and fair-bound-driven; generic two-sided quoting remains a negative control.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketOrders, polymarketBooks, polymarketFees, ofiPaper

### M07 — Cancel-toxicity barrier

- Family: Selective passive liquidity and execution edge
- Decision: **BLOCKED_DATA**; research-priority score: **61/100**.
- Economic mechanism: Cancel immediately on external fair-bound shocks and score from actual cancel acknowledgement, not request time.
- Who pays: Spread income between information shocks.
- Why it may persist: Spread/reward income persists only where uninformed flow exceeds adverse selection and queue/cancel losses.
- Capacity and half-life: $5–$100 inventory per market; quote lifetime milliseconds to hours by category.
- Required data/readiness: full books; public and authenticated fills; queue-ahead; cancel acknowledgements; fee/reward schedule; 1/5/30s markouts. C — public flow exists; authenticated queue/fill fidelity is absent and generic controls are strongly negative.
- Execution/legs: One-sided post-only quote inside a conservative fair-value interval; hedge or cancel on bound violation; inventory-aware.
- Latency: 20–100 ms internal reaction is useful; feed quality and cancel acknowledgement dominate CPU micro-optimization.
- Full cost model: Adverse markout + non-fill/queue + inventory capital + hedge/taker fee − maker rewards/rebates actually earned.
- Legal/rule dependency: Post-only, heartbeat, reward eligibility, tick-size and self-trade rules.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing selective passive liquidity and execution edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One market-session or one quote episode separated by flat inventory.
- Leakage/selection risk: Assuming public prints imply own fills, ignoring queue ahead, and filtering toxicity after observing markout.
- Infrastructure: Dedicated event process, local books/fair bounds, queue simulator, authenticated user channel only after promotion.
- Time/storage: 30 days; event transitions only in SQL, raw books in Parquet.
- Why this is not stale retail logic: It is conditional and fair-bound-driven; generic two-sided quoting remains a negative control.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketOrders, polymarketBooks, polymarketFees, ofiPaper

### M08 — Time-to-resolution spread curve

- Family: Selective passive liquidity and execution edge
- Decision: **CHEAP_FALSIFICATION**; research-priority score: **61/100**.
- Economic mechanism: Model spread income versus binary jump/adverse-selection risk by time-to-resolution and only quote positive lower-bound states.
- Who pays: Late-window urgency from takers.
- Why it may persist: Spread/reward income persists only where uninformed flow exceeds adverse selection and queue/cancel losses.
- Capacity and half-life: $5–$100 inventory per market; quote lifetime milliseconds to hours by category.
- Required data/readiness: full books; public and authenticated fills; queue-ahead; cancel acknowledgements; fee/reward schedule; 1/5/30s markouts. C — public flow exists; authenticated queue/fill fidelity is absent and generic controls are strongly negative.
- Execution/legs: One-sided post-only quote inside a conservative fair-value interval; hedge or cancel on bound violation; inventory-aware.
- Latency: 20–100 ms internal reaction is useful; feed quality and cancel acknowledgement dominate CPU micro-optimization.
- Full cost model: Adverse markout + non-fill/queue + inventory capital + hedge/taker fee − maker rewards/rebates actually earned.
- Legal/rule dependency: Post-only, heartbeat, reward eligibility, tick-size and self-trade rules.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing selective passive liquidity and execution edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One market-session or one quote episode separated by flat inventory.
- Leakage/selection risk: Assuming public prints imply own fills, ignoring queue ahead, and filtering toxicity after observing markout.
- Infrastructure: Dedicated event process, local books/fair bounds, queue simulator, authenticated user channel only after promotion.
- Time/storage: 30 days; event transitions only in SQL, raw books in Parquet.
- Why this is not stale retail logic: It is conditional and fair-bound-driven; generic two-sided quoting remains a negative control.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketOrders, polymarketBooks, polymarketFees, ofiPaper

### M10 — Maker-taker optionality switch

- Family: Selective passive liquidity and execution edge
- Decision: **COLLECT_ONLY**; research-priority score: **61/100**.
- Economic mechanism: Post passively while fair value is stable, but cross the hedge only after an actual fill; compare to pure taker under one kernel.
- Who pays: Venue maker/taker asymmetry.
- Why it may persist: Spread/reward income persists only where uninformed flow exceeds adverse selection and queue/cancel losses.
- Capacity and half-life: $5–$100 inventory per market; quote lifetime milliseconds to hours by category.
- Required data/readiness: full books; public and authenticated fills; queue-ahead; cancel acknowledgements; fee/reward schedule; 1/5/30s markouts. C — public flow exists; authenticated queue/fill fidelity is absent and generic controls are strongly negative.
- Execution/legs: One-sided post-only quote inside a conservative fair-value interval; hedge or cancel on bound violation; inventory-aware.
- Latency: 20–100 ms internal reaction is useful; feed quality and cancel acknowledgement dominate CPU micro-optimization.
- Full cost model: Adverse markout + non-fill/queue + inventory capital + hedge/taker fee − maker rewards/rebates actually earned.
- Legal/rule dependency: Post-only, heartbeat, reward eligibility, tick-size and self-trade rules.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing selective passive liquidity and execution edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One market-session or one quote episode separated by flat inventory.
- Leakage/selection risk: Assuming public prints imply own fills, ignoring queue ahead, and filtering toxicity after observing markout.
- Infrastructure: Dedicated event process, local books/fair bounds, queue simulator, authenticated user channel only after promotion.
- Time/storage: 30 days; event transitions only in SQL, raw books in Parquet.
- Why this is not stale retail logic: It is conditional and fair-bound-driven; generic two-sided quoting remains a negative control.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketOrders, polymarketBooks, polymarketFees, ofiPaper

### P01 — Prequential strategy allocator

- Family: Portfolio/meta allocation and research controls
- Decision: **COLLECT_ONLY**; research-priority score: **61/100**.
- Economic mechanism: Allocate the next independent unit among already validated strategies using only lagged, embargoed features and a frozen rule.
- Who pays: Better capital utilization; it does not create gross alpha.
- Why it may persist: Allocation can improve capital use but cannot manufacture alpha from negative components.
- Capacity and half-life: $500/$1,000 shared bankroll; rebalance at independent-unit boundaries, not every tick.
- Required data/readiness: frozen strategy identities; prequential predictions; capital occupancy; cross-strategy covariance; settled PnL. B — trial ledger and strategy facts exist, but most component edges are unvalidated.
- Execution/legs: Allocate only among pre-registered eligible arms using information available before each independent unit.
- Latency: Low; correctness and anti-leakage are more important than sub-second action.
- Full cost model: Underlying strategy costs + idle/fragmented capital + switching/rebalance costs.
- Legal/rule dependency: Inherits every component venue restriction and shared-account exposure limit.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing portfolio/meta allocation and research controls data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One next market/event after an allocation decision.
- Leakage/selection risk: Winner chasing, overlapping strategy returns, using unsettled future labels and repeated model selection.
- Infrastructure: Prequential ledger, shared-bankroll simulator, embargoed walk-forward folds and multiplicity accounting.
- Time/storage: 30+ days; negligible incremental storage.
- Why this is not stale retail logic: It is a governance/capital layer and is explicitly forbidden from treating recent streaks as causal alpha.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: overfitPaper

### P03 — Correlated exposure budget

- Family: Portfolio/meta allocation and research controls
- Decision: **INCUBATE**; research-priority score: **61/100**.
- Economic mechanism: Net binary, asset, resolver and event-family exposures so apparently distinct bots cannot multiply the same risk.
- Who pays: Reduced concentration loss; no external payer.
- Why it may persist: Allocation can improve capital use but cannot manufacture alpha from negative components.
- Capacity and half-life: $500/$1,000 shared bankroll; rebalance at independent-unit boundaries, not every tick.
- Required data/readiness: frozen strategy identities; prequential predictions; capital occupancy; cross-strategy covariance; settled PnL. B — trial ledger and strategy facts exist, but most component edges are unvalidated.
- Execution/legs: Allocate only among pre-registered eligible arms using information available before each independent unit.
- Latency: Low; correctness and anti-leakage are more important than sub-second action.
- Full cost model: Underlying strategy costs + idle/fragmented capital + switching/rebalance costs.
- Legal/rule dependency: Inherits every component venue restriction and shared-account exposure limit.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing portfolio/meta allocation and research controls data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One next market/event after an allocation decision.
- Leakage/selection risk: Winner chasing, overlapping strategy returns, using unsettled future labels and repeated model selection.
- Infrastructure: Prequential ledger, shared-bankroll simulator, embargoed walk-forward folds and multiplicity accounting.
- Time/storage: 30+ days; negligible incremental storage.
- Why this is not stale retail logic: It is a governance/capital layer and is explicitly forbidden from treating recent streaks as causal alpha.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: overfitPaper

### C07 — Multivariate error-correction basket

- Family: Crypto CEX/perpetual relative value
- Decision: **CHEAP_FALSIFICATION**; research-priority score: **60/100**.
- Economic mechanism: Estimate a frozen state-space/VECM residual among BTC/ETH/SOL/XRP and trade only economically large, cost-surviving deviations.
- Who pays: Temporary inventory shocks around a stable common factor.
- Why it may persist: Fragmented inventory, funding and venue-specific order flow can create short-lived relative-value effects; most simple signals are crowded.
- Capacity and half-life: $50–$1,000 nominal capacity, but minimum orders and hedge margin matter; half-life from 100 ms to days.
- Required data/readiness: sequenced CEX books/trades; venue fees; funding/index/mark series; order latency; terminal forward returns. B for Binance/Coinbase/Hyperliquid market data; C for funding and authenticated fill fidelity.
- Execution/legs: Pre-funded inventory, simultaneous IOC/FOK where available, conservative cross-book depth and inventory rebalance.
- Latency: 20–500 ms for microstructure; minutes/days for funding and cointegration. Dublin fit must be benchmarked by venue.
- Full cost model: Maker/taker fees + spread/depth + funding/borrow + liquidation/gap reserve + transfer/rebalance.
- Legal/rule dependency: Account jurisdiction, leverage eligibility, index methodology, liquidation and custody terms.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing crypto cex/perpetual relative value data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: Non-overlapping episode or venue funding interval; cluster by day and asset state.
- Leakage/selection risk: Pair/horizon mining, exchange-clock misalignment and survivor bias in symbols/venues.
- Infrastructure: Unified event schema, local books, fee/funding versioning, causal replay and pre-funded inventory simulator.
- Time/storage: 14–30 days; raw depth is expensive, so preserve deltas and periodic snapshots rather than repeated full books.
- Why this is not stale retail logic: Only state-conditioned, depth-executable effects survive screening; generic RSI/momentum is a rejected control.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: binanceStreams, coinbaseStreams, hyperliquidStreams, ofiPaper

### O03 — Butterfly density consistency

- Family: Options-implied binary pricing and volatility
- Decision: **COLLECT_ONLY**; research-priority score: **60/100**.
- Economic mechanism: Detect negative or inconsistent implied probability mass across strikes, then ask whether prediction thresholds offer the cheaper correction.
- Who pays: Option/prediction books updated independently.
- Why it may persist: Segmentation between option and prediction venues may leave small residuals, but risk-neutral probability is not physical probability.
- Capacity and half-life: $5–$100 prediction leg; hedge capital can dominate. Half-life ranges from seconds to expiry.
- Required data/readiness: sequenced Deribit bid/ask books; exact expiry/strike mapping; forward/funding curve; prediction full depth; resolver mapping. C+ — surfaces are captured but current mapped targets are interpolated, not exact-expiry executable evidence.
- Execution/legs: Construct arbitrage-free bid/ask probability bounds, walk prediction and hedge books, quantify delta/gamma/vega/jump residual.
- Latency: 100 ms–minutes depending on surface move; synchronization matters more than sub-2 ms local compute.
- Full cost model: Prediction fees + option/perp fees + bid/ask + hedge rebalance + funding + residual jump/gamma reserve.
- Legal/rule dependency: Expiry instant, index source, exercise convention, contract multiplier and prediction resolver must align.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing options-implied binary pricing and volatility data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One market/expiry event; multiple marks are diagnostics, not independent observations.
- Leakage/selection risk: Surface smoothing through future quotes, unsupported interpolation and choosing only favorable strikes.
- Infrastructure: Sequenced surface builder, no-arbitrage cleaner, digital bound extractor, synchronized hedge simulator.
- Time/storage: 30 days; moderate derived storage, raw Deribit books dominate.
- Why this is not stale retail logic: It uses executable 2026 surfaces and small segmented prediction capacity, not textbook Black–Scholes point estimates.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: deribitBooks, polymarketFees, polymarketBooks

### O04 — Calendar probability bounds

- Family: Options-implied binary pricing and volatility
- Decision: **COLLECT_ONLY**; research-priority score: **60/100**.
- Economic mechanism: For compatible ever-hit or terminal events, impose time monotonicity across exact option expiries and prediction horizons.
- Who pays: Term-structure quote fragmentation.
- Why it may persist: Segmentation between option and prediction venues may leave small residuals, but risk-neutral probability is not physical probability.
- Capacity and half-life: $5–$100 prediction leg; hedge capital can dominate. Half-life ranges from seconds to expiry.
- Required data/readiness: sequenced Deribit bid/ask books; exact expiry/strike mapping; forward/funding curve; prediction full depth; resolver mapping. C+ — surfaces are captured but current mapped targets are interpolated, not exact-expiry executable evidence.
- Execution/legs: Construct arbitrage-free bid/ask probability bounds, walk prediction and hedge books, quantify delta/gamma/vega/jump residual.
- Latency: 100 ms–minutes depending on surface move; synchronization matters more than sub-2 ms local compute.
- Full cost model: Prediction fees + option/perp fees + bid/ask + hedge rebalance + funding + residual jump/gamma reserve.
- Legal/rule dependency: Expiry instant, index source, exercise convention, contract multiplier and prediction resolver must align.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing options-implied binary pricing and volatility data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One market/expiry event; multiple marks are diagnostics, not independent observations.
- Leakage/selection risk: Surface smoothing through future quotes, unsupported interpolation and choosing only favorable strikes.
- Infrastructure: Sequenced surface builder, no-arbitrage cleaner, digital bound extractor, synchronized hedge simulator.
- Time/storage: 30 days; moderate derived storage, raw Deribit books dominate.
- Why this is not stale retail logic: It uses executable 2026 surfaces and small segmented prediction capacity, not textbook Black–Scholes point estimates.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: deribitBooks, polymarketFees, polymarketBooks

### O05 — Skew-jump residual

- Family: Options-implied binary pricing and volatility
- Decision: **COLLECT_ONLY**; research-priority score: **60/100**.
- Economic mechanism: Condition prediction residuals on executable option skew changes that encode downside/upside jump demand.
- Who pays: Prediction makers using stale symmetric volatility assumptions.
- Why it may persist: Segmentation between option and prediction venues may leave small residuals, but risk-neutral probability is not physical probability.
- Capacity and half-life: $5–$100 prediction leg; hedge capital can dominate. Half-life ranges from seconds to expiry.
- Required data/readiness: sequenced Deribit bid/ask books; exact expiry/strike mapping; forward/funding curve; prediction full depth; resolver mapping. C+ — surfaces are captured but current mapped targets are interpolated, not exact-expiry executable evidence.
- Execution/legs: Construct arbitrage-free bid/ask probability bounds, walk prediction and hedge books, quantify delta/gamma/vega/jump residual.
- Latency: 100 ms–minutes depending on surface move; synchronization matters more than sub-2 ms local compute.
- Full cost model: Prediction fees + option/perp fees + bid/ask + hedge rebalance + funding + residual jump/gamma reserve.
- Legal/rule dependency: Expiry instant, index source, exercise convention, contract multiplier and prediction resolver must align.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing options-implied binary pricing and volatility data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One market/expiry event; multiple marks are diagnostics, not independent observations.
- Leakage/selection risk: Surface smoothing through future quotes, unsupported interpolation and choosing only favorable strikes.
- Infrastructure: Sequenced surface builder, no-arbitrage cleaner, digital bound extractor, synchronized hedge simulator.
- Time/storage: 30 days; moderate derived storage, raw Deribit books dominate.
- Why this is not stale retail logic: It uses executable 2026 surfaces and small segmented prediction capacity, not textbook Black–Scholes point estimates.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: deribitBooks, polymarketFees, polymarketBooks

### O06 — Scheduled-event volatility residual

- Family: Options-implied binary pricing and volatility
- Decision: **BLOCKED_DATA**; research-priority score: **60/100**.
- Economic mechanism: Measure whether prediction markets under/overreact to option-implied event variance around known releases without direction guessing.
- Who pays: Participants mispricing event jump variance.
- Why it may persist: Segmentation between option and prediction venues may leave small residuals, but risk-neutral probability is not physical probability.
- Capacity and half-life: $5–$100 prediction leg; hedge capital can dominate. Half-life ranges from seconds to expiry.
- Required data/readiness: event calendar; exact-expiry surface; prediction books; hedge costs. C+ — surfaces are captured but current mapped targets are interpolated, not exact-expiry executable evidence.
- Execution/legs: Construct arbitrage-free bid/ask probability bounds, walk prediction and hedge books, quantify delta/gamma/vega/jump residual.
- Latency: 100 ms–minutes depending on surface move; synchronization matters more than sub-2 ms local compute.
- Full cost model: Prediction fees + option/perp fees + bid/ask + hedge rebalance + funding + residual jump/gamma reserve.
- Legal/rule dependency: Expiry instant, index source, exercise convention, contract multiplier and prediction resolver must align.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing options-implied binary pricing and volatility data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One market/expiry event; multiple marks are diagnostics, not independent observations.
- Leakage/selection risk: Surface smoothing through future quotes, unsupported interpolation and choosing only favorable strikes.
- Infrastructure: Sequenced surface builder, no-arbitrage cleaner, digital bound extractor, synchronized hedge simulator.
- Time/storage: 30 days; moderate derived storage, raw Deribit books dominate.
- Why this is not stale retail logic: It uses executable 2026 surfaces and small segmented prediction capacity, not textbook Black–Scholes point estimates.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: deribitBooks, polymarketFees, polymarketBooks

### O10 — Option-book stale-state snipe

- Family: Options-implied binary pricing and volatility
- Decision: **COLLECT_ONLY**; research-priority score: **60/100**.
- Economic mechanism: Trade only after a sequenced option surface update proves the prediction quote is stale for a minimum dwell and executable at stressed latency.
- Who pays: Slow prediction-market quote refresh.
- Why it may persist: Segmentation between option and prediction venues may leave small residuals, but risk-neutral probability is not physical probability.
- Capacity and half-life: $5–$100 prediction leg; hedge capital can dominate. Half-life ranges from seconds to expiry.
- Required data/readiness: sequenced Deribit bid/ask books; exact expiry/strike mapping; forward/funding curve; prediction full depth; resolver mapping. C+ — surfaces are captured but current mapped targets are interpolated, not exact-expiry executable evidence.
- Execution/legs: Construct arbitrage-free bid/ask probability bounds, walk prediction and hedge books, quantify delta/gamma/vega/jump residual.
- Latency: 100 ms–minutes depending on surface move; synchronization matters more than sub-2 ms local compute.
- Full cost model: Prediction fees + option/perp fees + bid/ask + hedge rebalance + funding + residual jump/gamma reserve.
- Legal/rule dependency: Expiry instant, index source, exercise convention, contract multiplier and prediction resolver must align.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing options-implied binary pricing and volatility data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One market/expiry event; multiple marks are diagnostics, not independent observations.
- Leakage/selection risk: Surface smoothing through future quotes, unsupported interpolation and choosing only favorable strikes.
- Infrastructure: Sequenced surface builder, no-arbitrage cleaner, digital bound extractor, synchronized hedge simulator.
- Time/storage: 30 days; moderate derived storage, raw Deribit books dominate.
- Why this is not stale retail logic: It uses executable 2026 surfaces and small segmented prediction capacity, not textbook Black–Scholes point estimates.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: deribitBooks, polymarketFees, polymarketBooks

### O11 — Convexity boundary near expiry

- Family: Options-implied binary pricing and volatility
- Decision: **COLLECT_ONLY**; research-priority score: **60/100**.
- Economic mechanism: Use exact verticals to bound very short-dated terminal probability where delta changes nonlinearly and point-IV interpolation is unstable.
- Who pays: Makers applying stale linear approximations.
- Why it may persist: Segmentation between option and prediction venues may leave small residuals, but risk-neutral probability is not physical probability.
- Capacity and half-life: $5–$100 prediction leg; hedge capital can dominate. Half-life ranges from seconds to expiry.
- Required data/readiness: sequenced Deribit bid/ask books; exact expiry/strike mapping; forward/funding curve; prediction full depth; resolver mapping. C+ — surfaces are captured but current mapped targets are interpolated, not exact-expiry executable evidence.
- Execution/legs: Construct arbitrage-free bid/ask probability bounds, walk prediction and hedge books, quantify delta/gamma/vega/jump residual.
- Latency: 100 ms–minutes depending on surface move; synchronization matters more than sub-2 ms local compute.
- Full cost model: Prediction fees + option/perp fees + bid/ask + hedge rebalance + funding + residual jump/gamma reserve.
- Legal/rule dependency: Expiry instant, index source, exercise convention, contract multiplier and prediction resolver must align.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing options-implied binary pricing and volatility data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One market/expiry event; multiple marks are diagnostics, not independent observations.
- Leakage/selection risk: Surface smoothing through future quotes, unsupported interpolation and choosing only favorable strikes.
- Infrastructure: Sequenced surface builder, no-arbitrage cleaner, digital bound extractor, synchronized hedge simulator.
- Time/storage: 30 days; moderate derived storage, raw Deribit books dominate.
- Why this is not stale retail logic: It uses executable 2026 surfaces and small segmented prediction capacity, not textbook Black–Scholes point estimates.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: deribitBooks, polymarketFees, polymarketBooks

### C09 — Liquidation-depletion recovery

- Family: Crypto CEX/perpetual relative value
- Decision: **COLLECT_ONLY**; research-priority score: **58/100**.
- Economic mechanism: After public liquidation flow consumes multiple levels, distinguish continuation from replenishment using opposite-side depth recovery.
- Who pays: Forced liquidators and inventory-constrained makers.
- Why it may persist: Fragmented inventory, funding and venue-specific order flow can create short-lived relative-value effects; most simple signals are crowded.
- Capacity and half-life: $50–$1,000 nominal capacity, but minimum orders and hedge margin matter; half-life from 100 ms to days.
- Required data/readiness: liquidation stream; full depth; trades; fees. B for Binance/Coinbase/Hyperliquid market data; C for funding and authenticated fill fidelity.
- Execution/legs: Pre-funded inventory, simultaneous IOC/FOK where available, conservative cross-book depth and inventory rebalance.
- Latency: 20–500 ms for microstructure; minutes/days for funding and cointegration. Dublin fit must be benchmarked by venue.
- Full cost model: Maker/taker fees + spread/depth + funding/borrow + liquidation/gap reserve + transfer/rebalance.
- Legal/rule dependency: Account jurisdiction, leverage eligibility, index methodology, liquidation and custody terms.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing crypto cex/perpetual relative value data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: Non-overlapping episode or venue funding interval; cluster by day and asset state.
- Leakage/selection risk: Pair/horizon mining, exchange-clock misalignment and survivor bias in symbols/venues.
- Infrastructure: Unified event schema, local books, fee/funding versioning, causal replay and pre-funded inventory simulator.
- Time/storage: 14–30 days; raw depth is expensive, so preserve deltas and periodic snapshots rather than repeated full books.
- Why this is not stale retail logic: Only state-conditioned, depth-executable effects survive screening; generic RSI/momentum is a rejected control.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: binanceStreams, coinbaseStreams, hyperliquidStreams, ofiPaper

### C10 — Funding-regime conditional momentum

- Family: Crypto CEX/perpetual relative value
- Decision: **COLLECT_ONLY**; research-priority score: **58/100**.
- Economic mechanism: Activate short-horizon momentum only after extreme funding and order-flow alignment, with the opposite extreme as a separate frozen arm.
- Who pays: Crowded leveraged positions forced to adjust.
- Why it may persist: Fragmented inventory, funding and venue-specific order flow can create short-lived relative-value effects; most simple signals are crowded.
- Capacity and half-life: $50–$1,000 nominal capacity, but minimum orders and hedge margin matter; half-life from 100 ms to days.
- Required data/readiness: sequenced CEX books/trades; venue fees; funding/index/mark series; order latency; terminal forward returns. B for Binance/Coinbase/Hyperliquid market data; C for funding and authenticated fill fidelity.
- Execution/legs: Pre-funded inventory, simultaneous IOC/FOK where available, conservative cross-book depth and inventory rebalance.
- Latency: 20–500 ms for microstructure; minutes/days for funding and cointegration. Dublin fit must be benchmarked by venue.
- Full cost model: Maker/taker fees + spread/depth + funding/borrow + liquidation/gap reserve + transfer/rebalance.
- Legal/rule dependency: Account jurisdiction, leverage eligibility, index methodology, liquidation and custody terms.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing crypto cex/perpetual relative value data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: Non-overlapping episode or venue funding interval; cluster by day and asset state.
- Leakage/selection risk: Pair/horizon mining, exchange-clock misalignment and survivor bias in symbols/venues.
- Infrastructure: Unified event schema, local books, fee/funding versioning, causal replay and pre-funded inventory simulator.
- Time/storage: 14–30 days; raw depth is expensive, so preserve deltas and periodic snapshots rather than repeated full books.
- Why this is not stale retail logic: Only state-conditioned, depth-executable effects survive screening; generic RSI/momentum is a rejected control.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: binanceStreams, coinbaseStreams, hyperliquidStreams, ofiPaper

### C11 — Funding-regime reversal

- Family: Crypto CEX/perpetual relative value
- Decision: **COLLECT_ONLY**; research-priority score: **58/100**.
- Economic mechanism: Test post-crowding mean reversion after funding extremes and failed price continuation.
- Who pays: Late leveraged entrants unwinding.
- Why it may persist: Fragmented inventory, funding and venue-specific order flow can create short-lived relative-value effects; most simple signals are crowded.
- Capacity and half-life: $50–$1,000 nominal capacity, but minimum orders and hedge margin matter; half-life from 100 ms to days.
- Required data/readiness: sequenced CEX books/trades; venue fees; funding/index/mark series; order latency; terminal forward returns. B for Binance/Coinbase/Hyperliquid market data; C for funding and authenticated fill fidelity.
- Execution/legs: Pre-funded inventory, simultaneous IOC/FOK where available, conservative cross-book depth and inventory rebalance.
- Latency: 20–500 ms for microstructure; minutes/days for funding and cointegration. Dublin fit must be benchmarked by venue.
- Full cost model: Maker/taker fees + spread/depth + funding/borrow + liquidation/gap reserve + transfer/rebalance.
- Legal/rule dependency: Account jurisdiction, leverage eligibility, index methodology, liquidation and custody terms.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing crypto cex/perpetual relative value data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: Non-overlapping episode or venue funding interval; cluster by day and asset state.
- Leakage/selection risk: Pair/horizon mining, exchange-clock misalignment and survivor bias in symbols/venues.
- Infrastructure: Unified event schema, local books, fee/funding versioning, causal replay and pre-funded inventory simulator.
- Time/storage: 14–30 days; raw depth is expensive, so preserve deltas and periodic snapshots rather than repeated full books.
- Why this is not stale retail logic: Only state-conditioned, depth-executable effects survive screening; generic RSI/momentum is a rejected control.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: binanceStreams, coinbaseStreams, hyperliquidStreams, ofiPaper

### C13 — Index constituent lag

- Family: Crypto CEX/perpetual relative value
- Decision: **BLOCKED_DATA**; research-priority score: **58/100**.
- Economic mechanism: Compare perpetual index constituents with mark/index updates and trade only when executable venue price departs beyond rebalance cost.
- Who pays: Index calculation cadence and fragmented spot books.
- Why it may persist: Fragmented inventory, funding and venue-specific order flow can create short-lived relative-value effects; most simple signals are crowded.
- Capacity and half-life: $50–$1,000 nominal capacity, but minimum orders and hedge margin matter; half-life from 100 ms to days.
- Required data/readiness: sequenced CEX books/trades; venue fees; funding/index/mark series; order latency; terminal forward returns. B for Binance/Coinbase/Hyperliquid market data; C for funding and authenticated fill fidelity.
- Execution/legs: Pre-funded inventory, simultaneous IOC/FOK where available, conservative cross-book depth and inventory rebalance.
- Latency: 20–500 ms for microstructure; minutes/days for funding and cointegration. Dublin fit must be benchmarked by venue.
- Full cost model: Maker/taker fees + spread/depth + funding/borrow + liquidation/gap reserve + transfer/rebalance.
- Legal/rule dependency: Account jurisdiction, leverage eligibility, index methodology, liquidation and custody terms.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing crypto cex/perpetual relative value data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: Non-overlapping episode or venue funding interval; cluster by day and asset state.
- Leakage/selection risk: Pair/horizon mining, exchange-clock misalignment and survivor bias in symbols/venues.
- Infrastructure: Unified event schema, local books, fee/funding versioning, causal replay and pre-funded inventory simulator.
- Time/storage: 14–30 days; raw depth is expensive, so preserve deltas and periodic snapshots rather than repeated full books.
- Why this is not stale retail logic: Only state-conditioned, depth-executable effects survive screening; generic RSI/momentum is a rejected control.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: binanceStreams, coinbaseStreams, hyperliquidStreams, ofiPaper

### O07 — Realized-versus-implied variance carry

- Family: Options-implied binary pricing and volatility
- Decision: **BLOCKED_DATA**; research-priority score: **58/100**.
- Economic mechanism: Trade a hedged variance-risk-premium proxy only where small option positions and funding costs are executable for this bankroll.
- Who pays: Option buyers paying persistent insurance premium.
- Why it may persist: Segmentation between option and prediction venues may leave small residuals, but risk-neutral probability is not physical probability.
- Capacity and half-life: $5–$100 prediction leg; hedge capital can dominate. Half-life ranges from seconds to expiry.
- Required data/readiness: sequenced Deribit bid/ask books; exact expiry/strike mapping; forward/funding curve; prediction full depth; resolver mapping. C+ — surfaces are captured but current mapped targets are interpolated, not exact-expiry executable evidence.
- Execution/legs: Construct arbitrage-free bid/ask probability bounds, walk prediction and hedge books, quantify delta/gamma/vega/jump residual.
- Latency: 100 ms–minutes depending on surface move; synchronization matters more than sub-2 ms local compute.
- Full cost model: Prediction fees + option/perp fees + bid/ask + hedge rebalance + funding + residual jump/gamma reserve.
- Legal/rule dependency: Expiry instant, index source, exercise convention, contract multiplier and prediction resolver must align.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing options-implied binary pricing and volatility data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One market/expiry event; multiple marks are diagnostics, not independent observations.
- Leakage/selection risk: Surface smoothing through future quotes, unsupported interpolation and choosing only favorable strikes.
- Infrastructure: Sequenced surface builder, no-arbitrage cleaner, digital bound extractor, synchronized hedge simulator.
- Time/storage: 30 days; moderate derived storage, raw Deribit books dominate.
- Why this is not stale retail logic: It uses executable 2026 surfaces and small segmented prediction capacity, not textbook Black–Scholes point estimates.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: deribitBooks, polymarketFees, polymarketBooks

### O08 — Delta-hedged prediction residual

- Family: Options-implied binary pricing and volatility
- Decision: **COLLECT_ONLY**; research-priority score: **58/100**.
- Economic mechanism: Hedge local directional delta with a perpetual and attribute remaining P&L to probability residual, gamma, basis and jump risk.
- Who pays: Segmentation between binary and linear derivatives.
- Why it may persist: Segmentation between option and prediction venues may leave small residuals, but risk-neutral probability is not physical probability.
- Capacity and half-life: $5–$100 prediction leg; hedge capital can dominate. Half-life ranges from seconds to expiry.
- Required data/readiness: sequenced Deribit bid/ask books; exact expiry/strike mapping; forward/funding curve; prediction full depth; resolver mapping. C+ — surfaces are captured but current mapped targets are interpolated, not exact-expiry executable evidence.
- Execution/legs: Construct arbitrage-free bid/ask probability bounds, walk prediction and hedge books, quantify delta/gamma/vega/jump residual.
- Latency: 100 ms–minutes depending on surface move; synchronization matters more than sub-2 ms local compute.
- Full cost model: Prediction fees + option/perp fees + bid/ask + hedge rebalance + funding + residual jump/gamma reserve.
- Legal/rule dependency: Expiry instant, index source, exercise convention, contract multiplier and prediction resolver must align.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing options-implied binary pricing and volatility data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One market/expiry event; multiple marks are diagnostics, not independent observations.
- Leakage/selection risk: Surface smoothing through future quotes, unsupported interpolation and choosing only favorable strikes.
- Infrastructure: Sequenced surface builder, no-arbitrage cleaner, digital bound extractor, synchronized hedge simulator.
- Time/storage: 30 days; moderate derived storage, raw Deribit books dominate.
- Why this is not stale retail logic: It uses executable 2026 surfaces and small segmented prediction capacity, not textbook Black–Scholes point estimates.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: deribitBooks, polymarketFees, polymarketBooks

### S18 — Rule-ambiguity premium

- Family: Prediction-market structural and semantic edge
- Decision: **COLLECT_ONLY**; research-priority score: **58/100**.
- Economic mechanism: Estimate whether ambiguous fallback/dispute clauses earn a persistent discount after controlling for price and duration; this is risky alpha, not arbitrage.
- Who pays: Traders avoiding hard-to-interpret settlement risk.
- Why it may persist: Payoff algebra persists until quotes, rules or displayed depth change; capacity is usually small and fragmented.
- Capacity and half-life: $1–$100 displayed capacity is plausible; quote half-life ranges from one event to hours, but must be measured.
- Required data/readiness: immutable rule text/hash; resolver and fallback; full executable books; fee schedule; finite outcome-state compiler. B — rules/books exist, but relationship certification and passive fills remain incomplete.
- Execution/legs: Prove every terminal state, walk all legs, reserve worst orphan unwind, then paper FOK or post-only-first/hedge-immediately.
- Latency: Mostly 100 ms to minutes; economics and rule identity dominate raw reaction latency.
- Full cost model: Current per-market fees + one tick/leg + walked depth + non-fill + worst orphan reserve + capital duration.
- Legal/rule dependency: Exact market wording, resolver, observation instant, rounding, cancellation and fallback clauses are hard gates.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing prediction-market structural and semantic edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: A unique certified relationship observed in one non-overlapping event window.
- Leakage/selection risk: AI relation mining, repeated quote observations and selecting only positive bundles create severe multiplicity.
- Infrastructure: Condition graph, immutable rule snapshots, deterministic SAT/MILP payoff compiler, synchronized books and FOK simulator.
- Time/storage: Continuous scanner; 30 days. Derived transitions are small; raw books already captured.
- Why this is not stale retail logic: It targets messy low-capacity semantic relationships, not the crowded single-market YES+NO identity.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketFees, polymarketOrders, polymarketResolution, predictionGraphPaper, polymarketArbPaper

### X08 — Pre-funded dual-venue inventory rebalance

- Family: Rule-aware prediction/sports cross-venue relationships
- Decision: **CHEAP_FALSIFICATION**; research-priority score: **57/100**.
- Economic mechanism: Hold balanced collateral on both venues and treat later transfers as inventory rebalancing, removing transfer latency from each opportunity.
- Who pays: Participants unable or unwilling to fragment capital.
- Why it may persist: Venue segmentation and trapped capital can sustain basis for seconds to days; identity errors can persist to settlement as losses.
- Capacity and half-life: $5–$250 per pair may fit this bankroll; basis half-life and capital-hours must be estimated by typed pair.
- Required data/readiness: both venues full depth; source/receive clocks; per-market fees; immutable rules; identity dimensions; terminal outcomes. B-/C+ — synchronized feeds exist, but no certified-equal pair and Kalshi rule coverage is sparse.
- Execution/legs: Pre-fund both venues; synchronize depth; veto UNKNOWN; model sequential legs and emergency unwind. No cross-venue atomicity claim.
- Latency: Convergence can be seconds to days; 100–500 ms matters for leg risk, not all opportunity creation.
- Full cost model: Both venue fees and rounding + depth + reject/non-fill + transfer/rebalance + orphan loss + capital duration.
- Legal/rule dependency: Venue eligibility, account limits, exact settlement rules and withdrawal/custody constraints must be current.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing rule-aware prediction/sports cross-venue relationships data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: Pair-direction-day or one non-overlapping dislocation episode, not each polling observation.
- Leakage/selection risk: Text similarity is not payoff identity; overlapping episodes and manual approvals can leak future knowledge.
- Infrastructure: Typed contract normalizer, hard-mismatch veto, synchronized dual books, two-leg state machine and capital clock.
- Time/storage: 30 days and at least 300 pair-days; existing depth capture is reusable.
- Why this is not stale retail logic: It tests rule friction and capital segmentation rather than a naive midpoint comparison.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketFees, polymarketOrders, kalshiOrders, kalshiFees, kalshiBooks

### C14 — Stablecoin basis dislocation

- Family: Crypto CEX/perpetual relative value
- Decision: **BLOCKED_DATA**; research-priority score: **56/100**.
- Economic mechanism: Hedge a temporary USDT/USDC venue basis only with redemption/transfer and issuer risk explicitly reserved.
- Who pays: Urgent collateral demand and rail fragmentation.
- Why it may persist: Fragmented inventory, funding and venue-specific order flow can create short-lived relative-value effects; most simple signals are crowded.
- Capacity and half-life: $50–$1,000 nominal capacity, but minimum orders and hedge margin matter; half-life from 100 ms to days.
- Required data/readiness: sequenced CEX books/trades; venue fees; funding/index/mark series; order latency; terminal forward returns. B for Binance/Coinbase/Hyperliquid market data; C for funding and authenticated fill fidelity.
- Execution/legs: Pre-funded inventory, simultaneous IOC/FOK where available, conservative cross-book depth and inventory rebalance.
- Latency: 20–500 ms for microstructure; minutes/days for funding and cointegration. Dublin fit must be benchmarked by venue.
- Full cost model: Maker/taker fees + spread/depth + funding/borrow + liquidation/gap reserve + transfer/rebalance.
- Legal/rule dependency: Account jurisdiction, leverage eligibility, index methodology, liquidation and custody terms.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing crypto cex/perpetual relative value data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: Non-overlapping episode or venue funding interval; cluster by day and asset state.
- Leakage/selection risk: Pair/horizon mining, exchange-clock misalignment and survivor bias in symbols/venues.
- Infrastructure: Unified event schema, local books, fee/funding versioning, causal replay and pre-funded inventory simulator.
- Time/storage: 14–30 days; raw depth is expensive, so preserve deltas and periodic snapshots rather than repeated full books.
- Why this is not stale retail logic: Only state-conditioned, depth-executable effects survive screening; generic RSI/momentum is a rejected control.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: binanceStreams, coinbaseStreams, hyperliquidStreams, ofiPaper

### D04 — Cross-DEX stable-pool imbalance

- Family: DEX/on-chain and cross-network execution
- Decision: **BLOCKED_DATA**; research-priority score: **56/100**.
- Economic mechanism: Atomically route between stable pools when amplification curves and fees create a deterministic surplus.
- Who pays: Large one-sided stablecoin flow.
- Why it may persist: Atomic state transitions can create true locks, but public MEV auctions transfer much of the surplus to validators/builders.
- Capacity and half-life: $10–$1,000 depending on pool depth; half-life is often one block/slot and competition is intense.
- Required data/readiness: full on-chain state; mempool/shred/block feed where permitted; DEX route quotes; gas/priority/tip history; CEX books when hedged. D — TV2 does not yet preserve the required causal on-chain state or landing-cost data.
- Execution/legs: Simulate exact state, submit all-or-none bundle where supported, require post-tip/gas profit and revert protection.
- Latency: Block/slot competitive; Dublin is directly useful for Jito Dublin but not proof of winning auctions.
- Full cost model: Pool fees + price impact + gas/priority fee + builder/Jito tip + failed landing opportunity cost + inventory hedge.
- Legal/rule dependency: Protocol terms, token restrictions, RPC/provider terms and anti-manipulation rules.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing dex/on-chain and cross-network execution data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One distinct block/slot opportunity with one executable state root.
- Leakage/selection risk: Historical state without competitors, ignoring failed bundles and using end-of-block reserves.
- Infrastructure: Archive node/RPC, deterministic simulator, bundle submitter in paper mode, landed-tip and failure recorder.
- Time/storage: Collector-first; 14–30 days and potentially hundreds of GiB unless universe is tightly bounded.
- Why this is not stale retail logic: Only atomic, costed opportunities are retained; 2020-style REST reserve polling is explicitly rejected.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: jitoBundles

### D05 — AMM oracle-lag liquidation

- Family: DEX/on-chain and cross-network execution
- Decision: **BLOCKED_DATA**; research-priority score: **56/100**.
- Economic mechanism: Liquidate undercollateralized positions only when protocol oracle, close factor, gas/tip and auction competition imply positive landed value.
- Who pays: Borrowers crossing protocol liquidation thresholds.
- Why it may persist: Atomic state transitions can create true locks, but public MEV auctions transfer much of the surplus to validators/builders.
- Capacity and half-life: $10–$1,000 depending on pool depth; half-life is often one block/slot and competition is intense.
- Required data/readiness: full on-chain state; mempool/shred/block feed where permitted; DEX route quotes; gas/priority/tip history; CEX books when hedged. D — TV2 does not yet preserve the required causal on-chain state or landing-cost data.
- Execution/legs: Simulate exact state, submit all-or-none bundle where supported, require post-tip/gas profit and revert protection.
- Latency: Block/slot competitive; Dublin is directly useful for Jito Dublin but not proof of winning auctions.
- Full cost model: Pool fees + price impact + gas/priority fee + builder/Jito tip + failed landing opportunity cost + inventory hedge.
- Legal/rule dependency: Protocol terms, token restrictions, RPC/provider terms and anti-manipulation rules.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing dex/on-chain and cross-network execution data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One distinct block/slot opportunity with one executable state root.
- Leakage/selection risk: Historical state without competitors, ignoring failed bundles and using end-of-block reserves.
- Infrastructure: Archive node/RPC, deterministic simulator, bundle submitter in paper mode, landed-tip and failure recorder.
- Time/storage: Collector-first; 14–30 days and potentially hundreds of GiB unless universe is tightly bounded.
- Why this is not stale retail logic: Only atomic, costed opportunities are retained; 2020-style REST reserve polling is explicitly rejected.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: jitoBundles

### D06 — Protocol intent-auction residual

- Family: DEX/on-chain and cross-network execution
- Decision: **BLOCKED_DATA**; research-priority score: **56/100**.
- Economic mechanism: Respond to public intents only where solver competition and settlement guarantees leave positive quoted surplus.
- Who pays: Users paying for immediacy and route convenience.
- Why it may persist: Atomic state transitions can create true locks, but public MEV auctions transfer much of the surplus to validators/builders.
- Capacity and half-life: $10–$1,000 depending on pool depth; half-life is often one block/slot and competition is intense.
- Required data/readiness: full on-chain state; mempool/shred/block feed where permitted; DEX route quotes; gas/priority/tip history; CEX books when hedged. D — TV2 does not yet preserve the required causal on-chain state or landing-cost data.
- Execution/legs: Simulate exact state, submit all-or-none bundle where supported, require post-tip/gas profit and revert protection.
- Latency: Block/slot competitive; Dublin is directly useful for Jito Dublin but not proof of winning auctions.
- Full cost model: Pool fees + price impact + gas/priority fee + builder/Jito tip + failed landing opportunity cost + inventory hedge.
- Legal/rule dependency: Protocol terms, token restrictions, RPC/provider terms and anti-manipulation rules.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing dex/on-chain and cross-network execution data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One distinct block/slot opportunity with one executable state root.
- Leakage/selection risk: Historical state without competitors, ignoring failed bundles and using end-of-block reserves.
- Infrastructure: Archive node/RPC, deterministic simulator, bundle submitter in paper mode, landed-tip and failure recorder.
- Time/storage: Collector-first; 14–30 days and potentially hundreds of GiB unless universe is tightly bounded.
- Why this is not stale retail logic: Only atomic, costed opportunities are retained; 2020-style REST reserve polling is explicitly rejected.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: jitoBundles

### N02 — SEC filing event residual

- Family: Public information, semantic and AI-assisted event edge
- Decision: **BLOCKED_DATA**; research-priority score: **56/100**.
- Economic mechanism: Use EDGAR acceptance time and filing facts to update only contracts directly resolved by the disclosed event.
- Who pays: Prediction-market participants not monitoring structured filings.
- Why it may persist: Operational interpretation delays may persist in obscure markets, but major headline reactions are fast and crowded.
- Capacity and half-life: $5–$100 in obscure markets; seconds to hours depending on source and ambiguity.
- Required data/readiness: official source timestamp; local receive/monotonic clock; immutable content hash; mapped rules; pre-event books; terminal outcome. D/C — rule text exists; causal official-news and social-source collectors are not yet complete.
- Execution/legs: Official public source only; parse to a calibrated event claim; deterministic rule match; trade only against executable book after uncertainty reserve.
- Latency: Seconds for major news, minutes for obscure semantic updates; source timestamps must be auditable.
- Full cost model: Venue fees/depth + model uncertainty + stale/edited/deleted-post reserve + latency decay.
- Legal/rule dependency: Public-data license/API terms, venue rules, embargo/non-public-information restrictions and source authenticity.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing public information, semantic and ai-assisted event edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One public information event mapped before outcome to one market cluster.
- Leakage/selection risk: Using edited content, publication databases with revised timestamps, prompt/model changes and post-hoc market mapping.
- Infrastructure: Causal source collectors, content-addressed store, model/prompt registry, deterministic claim-to-rule verifier.
- Time/storage: Collector-first, 30–90 days; text is small, linked book capture dominates.
- Why this is not stale retail logic: AI proposes interpretations at scale, but price/execution and deterministic rule checks remain authoritative.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketResolution, overfitPaper

### N05 — Court-docket procedural edge

- Family: Public information, semantic and AI-assisted event edge
- Decision: **BLOCKED_DATA**; research-priority score: **56/100**.
- Economic mechanism: Map public docket entries to contracts whose resolution depends on a procedural milestone, preserving filing and receive time.
- Who pays: Traders who do not monitor obscure legal workflows.
- Why it may persist: Operational interpretation delays may persist in obscure markets, but major headline reactions are fast and crowded.
- Capacity and half-life: $5–$100 in obscure markets; seconds to hours depending on source and ambiguity.
- Required data/readiness: official source timestamp; local receive/monotonic clock; immutable content hash; mapped rules; pre-event books; terminal outcome. D/C — rule text exists; causal official-news and social-source collectors are not yet complete.
- Execution/legs: Official public source only; parse to a calibrated event claim; deterministic rule match; trade only against executable book after uncertainty reserve.
- Latency: Seconds for major news, minutes for obscure semantic updates; source timestamps must be auditable.
- Full cost model: Venue fees/depth + model uncertainty + stale/edited/deleted-post reserve + latency decay.
- Legal/rule dependency: Public-data license/API terms, venue rules, embargo/non-public-information restrictions and source authenticity.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing public information, semantic and ai-assisted event edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One public information event mapped before outcome to one market cluster.
- Leakage/selection risk: Using edited content, publication databases with revised timestamps, prompt/model changes and post-hoc market mapping.
- Infrastructure: Causal source collectors, content-addressed store, model/prompt registry, deterministic claim-to-rule verifier.
- Time/storage: Collector-first, 30–90 days; text is small, linked book capture dominates.
- Why this is not stale retail logic: AI proposes interpretations at scale, but price/execution and deterministic rule checks remain authoritative.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketResolution, overfitPaper

### N08 — Official weather nowcast residual

- Family: Public information, semantic and AI-assisted event edge
- Decision: **BLOCKED_DATA**; research-priority score: **56/100**.
- Economic mechanism: Combine official station observations/nowcasts with exact station/time threshold rules and conservative uncertainty.
- Who pays: Thin weather-market traders.
- Why it may persist: Operational interpretation delays may persist in obscure markets, but major headline reactions are fast and crowded.
- Capacity and half-life: $5–$100 in obscure markets; seconds to hours depending on source and ambiguity.
- Required data/readiness: official source timestamp; local receive/monotonic clock; immutable content hash; mapped rules; pre-event books; terminal outcome. D/C — rule text exists; causal official-news and social-source collectors are not yet complete.
- Execution/legs: Official public source only; parse to a calibrated event claim; deterministic rule match; trade only against executable book after uncertainty reserve.
- Latency: Seconds for major news, minutes for obscure semantic updates; source timestamps must be auditable.
- Full cost model: Venue fees/depth + model uncertainty + stale/edited/deleted-post reserve + latency decay.
- Legal/rule dependency: Public-data license/API terms, venue rules, embargo/non-public-information restrictions and source authenticity.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing public information, semantic and ai-assisted event edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One public information event mapped before outcome to one market cluster.
- Leakage/selection risk: Using edited content, publication databases with revised timestamps, prompt/model changes and post-hoc market mapping.
- Infrastructure: Causal source collectors, content-addressed store, model/prompt registry, deterministic claim-to-rule verifier.
- Time/storage: Collector-first, 30–90 days; text is small, linked book capture dominates.
- Why this is not stale retail logic: AI proposes interpretations at scale, but price/execution and deterministic rule checks remain authoritative.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketResolution, overfitPaper

### O09 — Cross-asset comparison copula bound

- Family: Options-implied binary pricing and volatility
- Decision: **BLOCKED_DATA**; research-priority score: **56/100**.
- Economic mechanism: Price a company/coin A-above-B binary with conservative joint-distribution bounds rather than pretending stock ownership is a risk-neutral hedge.
- Who pays: Thin bespoke comparison markets.
- Why it may persist: Segmentation between option and prediction venues may leave small residuals, but risk-neutral probability is not physical probability.
- Capacity and half-life: $5–$100 prediction leg; hedge capital can dominate. Half-life ranges from seconds to expiry.
- Required data/readiness: sequenced Deribit bid/ask books; exact expiry/strike mapping; forward/funding curve; prediction full depth; resolver mapping. C+ — surfaces are captured but current mapped targets are interpolated, not exact-expiry executable evidence.
- Execution/legs: Construct arbitrage-free bid/ask probability bounds, walk prediction and hedge books, quantify delta/gamma/vega/jump residual.
- Latency: 100 ms–minutes depending on surface move; synchronization matters more than sub-2 ms local compute.
- Full cost model: Prediction fees + option/perp fees + bid/ask + hedge rebalance + funding + residual jump/gamma reserve.
- Legal/rule dependency: Expiry instant, index source, exercise convention, contract multiplier and prediction resolver must align.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing options-implied binary pricing and volatility data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One market/expiry event; multiple marks are diagnostics, not independent observations.
- Leakage/selection risk: Surface smoothing through future quotes, unsupported interpolation and choosing only favorable strikes.
- Infrastructure: Sequenced surface builder, no-arbitrage cleaner, digital bound extractor, synchronized hedge simulator.
- Time/storage: 30 days; moderate derived storage, raw Deribit books dominate.
- Why this is not stale retail logic: It uses executable 2026 surfaces and small segmented prediction capacity, not textbook Black–Scholes point estimates.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: deribitBooks, polymarketFees, polymarketBooks

### P05 — Contextual bandit experiment router

- Family: Portfolio/meta allocation and research controls
- Decision: **COLLECT_ONLY**; research-priority score: **56/100**.
- Economic mechanism: Assign future independent markets to frozen strategy arms with explicit exploration probability and propensity logging.
- Who pays: Efficient learning allocation, not direct market profit.
- Why it may persist: Allocation can improve capital use but cannot manufacture alpha from negative components.
- Capacity and half-life: $500/$1,000 shared bankroll; rebalance at independent-unit boundaries, not every tick.
- Required data/readiness: frozen strategy identities; prequential predictions; capital occupancy; cross-strategy covariance; settled PnL. B — trial ledger and strategy facts exist, but most component edges are unvalidated.
- Execution/legs: Allocate only among pre-registered eligible arms using information available before each independent unit.
- Latency: Low; correctness and anti-leakage are more important than sub-second action.
- Full cost model: Underlying strategy costs + idle/fragmented capital + switching/rebalance costs.
- Legal/rule dependency: Inherits every component venue restriction and shared-account exposure limit.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing portfolio/meta allocation and research controls data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One next market/event after an allocation decision.
- Leakage/selection risk: Winner chasing, overlapping strategy returns, using unsettled future labels and repeated model selection.
- Infrastructure: Prequential ledger, shared-bankroll simulator, embargoed walk-forward folds and multiplicity accounting.
- Time/storage: 30+ days; negligible incremental storage.
- Why this is not stale retail logic: It is a governance/capital layer and is explicitly forbidden from treating recent streaks as causal alpha.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: overfitPaper

### P04 — Frozen drawdown kill protocol

- Family: Portfolio/meta allocation and research controls
- Decision: **INCUBATE**; research-priority score: **55/100**.
- Economic mechanism: Stop a strategy only at a pre-registered evidence boundary rather than arbitrary imaginary daily loss rails.
- Who pays: Research integrity rather than alpha.
- Why it may persist: Allocation can improve capital use but cannot manufacture alpha from negative components.
- Capacity and half-life: $500/$1,000 shared bankroll; rebalance at independent-unit boundaries, not every tick.
- Required data/readiness: frozen strategy identities; prequential predictions; capital occupancy; cross-strategy covariance; settled PnL. B — trial ledger and strategy facts exist, but most component edges are unvalidated.
- Execution/legs: Allocate only among pre-registered eligible arms using information available before each independent unit.
- Latency: Low; correctness and anti-leakage are more important than sub-second action.
- Full cost model: Underlying strategy costs + idle/fragmented capital + switching/rebalance costs.
- Legal/rule dependency: Inherits every component venue restriction and shared-account exposure limit.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing portfolio/meta allocation and research controls data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One next market/event after an allocation decision.
- Leakage/selection risk: Winner chasing, overlapping strategy returns, using unsettled future labels and repeated model selection.
- Infrastructure: Prequential ledger, shared-bankroll simulator, embargoed walk-forward folds and multiplicity accounting.
- Time/storage: 30+ days; negligible incremental storage.
- Why this is not stale retail logic: It is a governance/capital layer and is explicitly forbidden from treating recent streaks as causal alpha.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: overfitPaper

### C12 — Session handoff liquidity effect

- Family: Crypto CEX/perpetual relative value
- Decision: **CHEAP_FALSIFICATION**; research-priority score: **54/100**.
- Economic mechanism: Pre-register UTC/session boundaries and test changes in spread/impact, not arbitrary clock buckets.
- Who pays: Predictable regional liquidity handoffs.
- Why it may persist: Fragmented inventory, funding and venue-specific order flow can create short-lived relative-value effects; most simple signals are crowded.
- Capacity and half-life: $50–$1,000 nominal capacity, but minimum orders and hedge margin matter; half-life from 100 ms to days.
- Required data/readiness: sequenced CEX books/trades; venue fees; funding/index/mark series; order latency; terminal forward returns. B for Binance/Coinbase/Hyperliquid market data; C for funding and authenticated fill fidelity.
- Execution/legs: Pre-funded inventory, simultaneous IOC/FOK where available, conservative cross-book depth and inventory rebalance.
- Latency: 20–500 ms for microstructure; minutes/days for funding and cointegration. Dublin fit must be benchmarked by venue.
- Full cost model: Maker/taker fees + spread/depth + funding/borrow + liquidation/gap reserve + transfer/rebalance.
- Legal/rule dependency: Account jurisdiction, leverage eligibility, index methodology, liquidation and custody terms.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing crypto cex/perpetual relative value data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: Non-overlapping episode or venue funding interval; cluster by day and asset state.
- Leakage/selection risk: Pair/horizon mining, exchange-clock misalignment and survivor bias in symbols/venues.
- Infrastructure: Unified event schema, local books, fee/funding versioning, causal replay and pre-funded inventory simulator.
- Time/storage: 14–30 days; raw depth is expensive, so preserve deltas and periodic snapshots rather than repeated full books.
- Why this is not stale retail logic: Only state-conditioned, depth-executable effects survive screening; generic RSI/momentum is a rejected control.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: binanceStreams, coinbaseStreams, hyperliquidStreams, ofiPaper

### D07 — Cross-chain bridge basis

- Family: DEX/on-chain and cross-network execution
- Decision: **BLOCKED_DATA**; research-priority score: **54/100**.
- Economic mechanism: Pre-position inventory on both chains and trade persistent basis without assuming bridge atomicity.
- Who pays: Fragmented chain liquidity and slow bridge capital.
- Why it may persist: Atomic state transitions can create true locks, but public MEV auctions transfer much of the surplus to validators/builders.
- Capacity and half-life: $10–$1,000 depending on pool depth; half-life is often one block/slot and competition is intense.
- Required data/readiness: full on-chain state; mempool/shred/block feed where permitted; DEX route quotes; gas/priority/tip history; CEX books when hedged. D — TV2 does not yet preserve the required causal on-chain state or landing-cost data.
- Execution/legs: Simulate exact state, submit all-or-none bundle where supported, require post-tip/gas profit and revert protection.
- Latency: Block/slot competitive; Dublin is directly useful for Jito Dublin but not proof of winning auctions.
- Full cost model: Pool fees + price impact + gas/priority fee + builder/Jito tip + failed landing opportunity cost + inventory hedge.
- Legal/rule dependency: Protocol terms, token restrictions, RPC/provider terms and anti-manipulation rules.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing dex/on-chain and cross-network execution data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One distinct block/slot opportunity with one executable state root.
- Leakage/selection risk: Historical state without competitors, ignoring failed bundles and using end-of-block reserves.
- Infrastructure: Archive node/RPC, deterministic simulator, bundle submitter in paper mode, landed-tip and failure recorder.
- Time/storage: Collector-first; 14–30 days and potentially hundreds of GiB unless universe is tightly bounded.
- Why this is not stale retail logic: Only atomic, costed opportunities are retained; 2020-style REST reserve polling is explicitly rejected.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: jitoBundles

### N01 — Official social-post contract mapper

- Family: Public information, semantic and AI-assisted event edge
- Decision: **BLOCKED_DATA**; research-priority score: **54/100**.
- Economic mechanism: Parse a public post from a verified official account into deterministic market predicates and trade only unambiguous immediate implications.
- Who pays: Slow interpretation in obscure event markets.
- Why it may persist: Operational interpretation delays may persist in obscure markets, but major headline reactions are fast and crowded.
- Capacity and half-life: $5–$100 in obscure markets; seconds to hours depending on source and ambiguity.
- Required data/readiness: official source timestamp; local receive/monotonic clock; immutable content hash; mapped rules; pre-event books; terminal outcome. D/C — rule text exists; causal official-news and social-source collectors are not yet complete.
- Execution/legs: Official public source only; parse to a calibrated event claim; deterministic rule match; trade only against executable book after uncertainty reserve.
- Latency: Seconds for major news, minutes for obscure semantic updates; source timestamps must be auditable.
- Full cost model: Venue fees/depth + model uncertainty + stale/edited/deleted-post reserve + latency decay.
- Legal/rule dependency: Public-data license/API terms, venue rules, embargo/non-public-information restrictions and source authenticity.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing public information, semantic and ai-assisted event edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One public information event mapped before outcome to one market cluster.
- Leakage/selection risk: Using edited content, publication databases with revised timestamps, prompt/model changes and post-hoc market mapping.
- Infrastructure: Causal source collectors, content-addressed store, model/prompt registry, deterministic claim-to-rule verifier.
- Time/storage: Collector-first, 30–90 days; text is small, linked book capture dominates.
- Why this is not stale retail logic: AI proposes interpretations at scale, but price/execution and deterministic rule checks remain authoritative.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketResolution, overfitPaper

### N03 — Official economic-release residual

- Family: Public information, semantic and AI-assisted event edge
- Decision: **BLOCKED_DATA**; research-priority score: **54/100**.
- Economic mechanism: Parse the first official release payload and compare a rule-matched probability update with executable markets.
- Who pays: Manual macro-market participants.
- Why it may persist: Operational interpretation delays may persist in obscure markets, but major headline reactions are fast and crowded.
- Capacity and half-life: $5–$100 in obscure markets; seconds to hours depending on source and ambiguity.
- Required data/readiness: official source timestamp; local receive/monotonic clock; immutable content hash; mapped rules; pre-event books; terminal outcome. D/C — rule text exists; causal official-news and social-source collectors are not yet complete.
- Execution/legs: Official public source only; parse to a calibrated event claim; deterministic rule match; trade only against executable book after uncertainty reserve.
- Latency: Seconds for major news, minutes for obscure semantic updates; source timestamps must be auditable.
- Full cost model: Venue fees/depth + model uncertainty + stale/edited/deleted-post reserve + latency decay.
- Legal/rule dependency: Public-data license/API terms, venue rules, embargo/non-public-information restrictions and source authenticity.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing public information, semantic and ai-assisted event edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One public information event mapped before outcome to one market cluster.
- Leakage/selection risk: Using edited content, publication databases with revised timestamps, prompt/model changes and post-hoc market mapping.
- Infrastructure: Causal source collectors, content-addressed store, model/prompt registry, deterministic claim-to-rule verifier.
- Time/storage: Collector-first, 30–90 days; text is small, linked book capture dominates.
- Why this is not stale retail logic: AI proposes interpretations at scale, but price/execution and deterministic rule checks remain authoritative.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketResolution, overfitPaper

### N04 — Sports lineup/injury rule mapper

- Family: Public information, semantic and AI-assisted event edge
- Decision: **BLOCKED_DATA**; research-priority score: **54/100**.
- Economic mechanism: Convert official roster status into outcome-probability residuals only with a calibrated sport-specific model.
- Who pays: Slower niche-sports repricing.
- Why it may persist: Operational interpretation delays may persist in obscure markets, but major headline reactions are fast and crowded.
- Capacity and half-life: $5–$100 in obscure markets; seconds to hours depending on source and ambiguity.
- Required data/readiness: official source timestamp; local receive/monotonic clock; immutable content hash; mapped rules; pre-event books; terminal outcome. D/C — rule text exists; causal official-news and social-source collectors are not yet complete.
- Execution/legs: Official public source only; parse to a calibrated event claim; deterministic rule match; trade only against executable book after uncertainty reserve.
- Latency: Seconds for major news, minutes for obscure semantic updates; source timestamps must be auditable.
- Full cost model: Venue fees/depth + model uncertainty + stale/edited/deleted-post reserve + latency decay.
- Legal/rule dependency: Public-data license/API terms, venue rules, embargo/non-public-information restrictions and source authenticity.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing public information, semantic and ai-assisted event edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One public information event mapped before outcome to one market cluster.
- Leakage/selection risk: Using edited content, publication databases with revised timestamps, prompt/model changes and post-hoc market mapping.
- Infrastructure: Causal source collectors, content-addressed store, model/prompt registry, deterministic claim-to-rule verifier.
- Time/storage: Collector-first, 30–90 days; text is small, linked book capture dominates.
- Why this is not stale retail logic: AI proposes interpretations at scale, but price/execution and deterministic rule checks remain authoritative.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketResolution, overfitPaper

### N06 — On-chain governance outcome mapper

- Family: Public information, semantic and AI-assisted event edge
- Decision: **BLOCKED_DATA**; research-priority score: **54/100**.
- Economic mechanism: Decode finalized public governance votes/execution states into matching event contracts.
- Who pays: Manual governance-event traders.
- Why it may persist: Operational interpretation delays may persist in obscure markets, but major headline reactions are fast and crowded.
- Capacity and half-life: $5–$100 in obscure markets; seconds to hours depending on source and ambiguity.
- Required data/readiness: official source timestamp; local receive/monotonic clock; immutable content hash; mapped rules; pre-event books; terminal outcome. D/C — rule text exists; causal official-news and social-source collectors are not yet complete.
- Execution/legs: Official public source only; parse to a calibrated event claim; deterministic rule match; trade only against executable book after uncertainty reserve.
- Latency: Seconds for major news, minutes for obscure semantic updates; source timestamps must be auditable.
- Full cost model: Venue fees/depth + model uncertainty + stale/edited/deleted-post reserve + latency decay.
- Legal/rule dependency: Public-data license/API terms, venue rules, embargo/non-public-information restrictions and source authenticity.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing public information, semantic and ai-assisted event edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One public information event mapped before outcome to one market cluster.
- Leakage/selection risk: Using edited content, publication databases with revised timestamps, prompt/model changes and post-hoc market mapping.
- Infrastructure: Causal source collectors, content-addressed store, model/prompt registry, deterministic claim-to-rule verifier.
- Time/storage: Collector-first, 30–90 days; text is small, linked book capture dominates.
- Why this is not stale retail logic: AI proposes interpretations at scale, but price/execution and deterministic rule checks remain authoritative.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketResolution, overfitPaper

### N07 — Earnings transcript claim residual

- Family: Public information, semantic and AI-assisted event edge
- Decision: **BLOCKED_DATA**; research-priority score: **54/100**.
- Economic mechanism: Use official release/transcript facts only where the contract predicate is directly observed; forecasts require a separately calibrated model.
- Who pays: Slow semantic parsing in bespoke company markets.
- Why it may persist: Operational interpretation delays may persist in obscure markets, but major headline reactions are fast and crowded.
- Capacity and half-life: $5–$100 in obscure markets; seconds to hours depending on source and ambiguity.
- Required data/readiness: official source timestamp; local receive/monotonic clock; immutable content hash; mapped rules; pre-event books; terminal outcome. D/C — rule text exists; causal official-news and social-source collectors are not yet complete.
- Execution/legs: Official public source only; parse to a calibrated event claim; deterministic rule match; trade only against executable book after uncertainty reserve.
- Latency: Seconds for major news, minutes for obscure semantic updates; source timestamps must be auditable.
- Full cost model: Venue fees/depth + model uncertainty + stale/edited/deleted-post reserve + latency decay.
- Legal/rule dependency: Public-data license/API terms, venue rules, embargo/non-public-information restrictions and source authenticity.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing public information, semantic and ai-assisted event edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One public information event mapped before outcome to one market cluster.
- Leakage/selection risk: Using edited content, publication databases with revised timestamps, prompt/model changes and post-hoc market mapping.
- Infrastructure: Causal source collectors, content-addressed store, model/prompt registry, deterministic claim-to-rule verifier.
- Time/storage: Collector-first, 30–90 days; text is small, linked book capture dominates.
- Why this is not stale retail logic: AI proposes interpretations at scale, but price/execution and deterministic rule checks remain authoritative.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketResolution, overfitPaper

### M04 — Complete-set paired maker

- Family: Selective passive liquidity and execution edge
- Decision: **REJECTED_EXISTING_EVIDENCE**; research-priority score: **53/100**.
- Economic mechanism: Passively acquire complementary outcomes below merge value while reserving one-leg inventory risk.
- Who pays: Two-sided retail flow and complement mispricing.
- Why it may persist: Spread/reward income persists only where uninformed flow exceeds adverse selection and queue/cancel losses.
- Capacity and half-life: $5–$100 inventory per market; quote lifetime milliseconds to hours by category.
- Required data/readiness: full books; public and authenticated fills; queue-ahead; cancel acknowledgements; fee/reward schedule; 1/5/30s markouts. C — public flow exists; authenticated queue/fill fidelity is absent and generic controls are strongly negative.
- Execution/legs: One-sided post-only quote inside a conservative fair-value interval; hedge or cancel on bound violation; inventory-aware.
- Latency: 20–100 ms internal reaction is useful; feed quality and cancel acknowledgement dominate CPU micro-optimization.
- Full cost model: Adverse markout + non-fill/queue + inventory capital + hedge/taker fee − maker rewards/rebates actually earned.
- Legal/rule dependency: Post-only, heartbeat, reward eligibility, tick-size and self-trade rules.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing selective passive liquidity and execution edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One market-session or one quote episode separated by flat inventory.
- Leakage/selection risk: Assuming public prints imply own fills, ignoring queue ahead, and filtering toxicity after observing markout.
- Infrastructure: Dedicated event process, local books/fair bounds, queue simulator, authenticated user channel only after promotion.
- Time/storage: 30 days; event transitions only in SQL, raw books in Parquet.
- Why this is not stale retail logic: It is conditional and fair-bound-driven; generic two-sided quoting remains a negative control.
- Existing evidence: Generic paired-maker control is materially negative from adverse selection.
- Source keys: polymarketOrders, polymarketBooks, polymarketFees, ofiPaper

### D03 — CEX-to-DEX pre-funded inventory arb

- Family: DEX/on-chain and cross-network execution
- Decision: **BLOCKED_DATA**; research-priority score: **52/100**.
- Economic mechanism: Buy on one rail and sell on the other without waiting for transfer, then rebalance inventory asynchronously.
- Who pays: On-chain versus centralized inventory shocks.
- Why it may persist: Atomic state transitions can create true locks, but public MEV auctions transfer much of the surplus to validators/builders.
- Capacity and half-life: $10–$1,000 depending on pool depth; half-life is often one block/slot and competition is intense.
- Required data/readiness: full on-chain state; mempool/shred/block feed where permitted; DEX route quotes; gas/priority/tip history; CEX books when hedged. D — TV2 does not yet preserve the required causal on-chain state or landing-cost data.
- Execution/legs: Simulate exact state, submit all-or-none bundle where supported, require post-tip/gas profit and revert protection.
- Latency: Block/slot competitive; Dublin is directly useful for Jito Dublin but not proof of winning auctions.
- Full cost model: Pool fees + price impact + gas/priority fee + builder/Jito tip + failed landing opportunity cost + inventory hedge.
- Legal/rule dependency: Protocol terms, token restrictions, RPC/provider terms and anti-manipulation rules.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing dex/on-chain and cross-network execution data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One distinct block/slot opportunity with one executable state root.
- Leakage/selection risk: Historical state without competitors, ignoring failed bundles and using end-of-block reserves.
- Infrastructure: Archive node/RPC, deterministic simulator, bundle submitter in paper mode, landed-tip and failure recorder.
- Time/storage: Collector-first; 14–30 days and potentially hundreds of GiB unless universe is tightly bounded.
- Why this is not stale retail logic: Only atomic, costed opportunities are retained; 2020-style REST reserve polling is explicitly rejected.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: jitoBundles

### D08 — LP loss-versus-rebalancing avoidance

- Family: DEX/on-chain and cross-network execution
- Decision: **BLOCKED_DATA**; research-priority score: **51/100**.
- Economic mechanism: Provide liquidity only when fee/reward expectation exceeds adverse selection/LVR under a frozen volatility and flow model.
- Who pays: Swap users paying fees; incentives subsidize liquidity.
- Why it may persist: Atomic state transitions can create true locks, but public MEV auctions transfer much of the surplus to validators/builders.
- Capacity and half-life: $10–$1,000 depending on pool depth; half-life is often one block/slot and competition is intense.
- Required data/readiness: full on-chain state; mempool/shred/block feed where permitted; DEX route quotes; gas/priority/tip history; CEX books when hedged. D — TV2 does not yet preserve the required causal on-chain state or landing-cost data.
- Execution/legs: Simulate exact state, submit all-or-none bundle where supported, require post-tip/gas profit and revert protection.
- Latency: Block/slot competitive; Dublin is directly useful for Jito Dublin but not proof of winning auctions.
- Full cost model: Pool fees + price impact + gas/priority fee + builder/Jito tip + failed landing opportunity cost + inventory hedge.
- Legal/rule dependency: Protocol terms, token restrictions, RPC/provider terms and anti-manipulation rules.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing dex/on-chain and cross-network execution data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One distinct block/slot opportunity with one executable state root.
- Leakage/selection risk: Historical state without competitors, ignoring failed bundles and using end-of-block reserves.
- Infrastructure: Archive node/RPC, deterministic simulator, bundle submitter in paper mode, landed-tip and failure recorder.
- Time/storage: Collector-first; 14–30 days and potentially hundreds of GiB unless universe is tightly bounded.
- Why this is not stale retail logic: Only atomic, costed opportunities are retained; 2020-style REST reserve polling is explicitly rejected.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: jitoBundles

### D10 — New-listing fragmented liquidity

- Family: DEX/on-chain and cross-network execution
- Decision: **BLOCKED_DATA**; research-priority score: **50/100**.
- Economic mechanism: Detect the same verified asset across venues and trade only with contract-address and transfer-tax safety checks.
- Who pays: Early fragmented price discovery.
- Why it may persist: Atomic state transitions can create true locks, but public MEV auctions transfer much of the surplus to validators/builders.
- Capacity and half-life: $10–$1,000 depending on pool depth; half-life is often one block/slot and competition is intense.
- Required data/readiness: full on-chain state; mempool/shred/block feed where permitted; DEX route quotes; gas/priority/tip history; CEX books when hedged. D — TV2 does not yet preserve the required causal on-chain state or landing-cost data.
- Execution/legs: Simulate exact state, submit all-or-none bundle where supported, require post-tip/gas profit and revert protection.
- Latency: Block/slot competitive; Dublin is directly useful for Jito Dublin but not proof of winning auctions.
- Full cost model: Pool fees + price impact + gas/priority fee + builder/Jito tip + failed landing opportunity cost + inventory hedge.
- Legal/rule dependency: Protocol terms, token restrictions, RPC/provider terms and anti-manipulation rules.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing dex/on-chain and cross-network execution data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One distinct block/slot opportunity with one executable state root.
- Leakage/selection risk: Historical state without competitors, ignoring failed bundles and using end-of-block reserves.
- Infrastructure: Archive node/RPC, deterministic simulator, bundle submitter in paper mode, landed-tip and failure recorder.
- Time/storage: Collector-first; 14–30 days and potentially hundreds of GiB unless universe is tightly bounded.
- Why this is not stale retail logic: Only atomic, costed opportunities are retained; 2020-style REST reserve polling is explicitly rejected.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: jitoBundles

### D09 — Gas-aware batched rebalance

- Family: DEX/on-chain and cross-network execution
- Decision: **BLOCKED_DATA**; research-priority score: **46/100**.
- Economic mechanism: Aggregate small inventory imbalances until saved gas exceeds additional basis risk.
- Who pays: Repeated small arbitrage profits otherwise consumed by fixed transaction cost.
- Why it may persist: Atomic state transitions can create true locks, but public MEV auctions transfer much of the surplus to validators/builders.
- Capacity and half-life: $10–$1,000 depending on pool depth; half-life is often one block/slot and competition is intense.
- Required data/readiness: full on-chain state; mempool/shred/block feed where permitted; DEX route quotes; gas/priority/tip history; CEX books when hedged. D — TV2 does not yet preserve the required causal on-chain state or landing-cost data.
- Execution/legs: Simulate exact state, submit all-or-none bundle where supported, require post-tip/gas profit and revert protection.
- Latency: Block/slot competitive; Dublin is directly useful for Jito Dublin but not proof of winning auctions.
- Full cost model: Pool fees + price impact + gas/priority fee + builder/Jito tip + failed landing opportunity cost + inventory hedge.
- Legal/rule dependency: Protocol terms, token restrictions, RPC/provider terms and anti-manipulation rules.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing dex/on-chain and cross-network execution data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One distinct block/slot opportunity with one executable state root.
- Leakage/selection risk: Historical state without competitors, ignoring failed bundles and using end-of-block reserves.
- Infrastructure: Archive node/RPC, deterministic simulator, bundle submitter in paper mode, landed-tip and failure recorder.
- Time/storage: Collector-first; 14–30 days and potentially hundreds of GiB unless universe is tightly bounded.
- Why this is not stale retail logic: Only atomic, costed opportunities are retained; 2020-style REST reserve polling is explicitly rejected.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: jitoBundles

### O12 — Risk-neutral/physical wedge calibration

- Family: Options-implied binary pricing and volatility
- Decision: **COLLECT_ONLY**; research-priority score: **46/100**.
- Economic mechanism: Treat option probability minus market probability as a feature whose physical-measure wedge is calibrated out of sample, not as arbitrage.
- Who pays: Persistent risk-premium differences between participant bases.
- Why it may persist: Segmentation between option and prediction venues may leave small residuals, but risk-neutral probability is not physical probability.
- Capacity and half-life: $5–$100 prediction leg; hedge capital can dominate. Half-life ranges from seconds to expiry.
- Required data/readiness: sequenced Deribit bid/ask books; exact expiry/strike mapping; forward/funding curve; prediction full depth; resolver mapping. C+ — surfaces are captured but current mapped targets are interpolated, not exact-expiry executable evidence.
- Execution/legs: Construct arbitrage-free bid/ask probability bounds, walk prediction and hedge books, quantify delta/gamma/vega/jump residual.
- Latency: 100 ms–minutes depending on surface move; synchronization matters more than sub-2 ms local compute.
- Full cost model: Prediction fees + option/perp fees + bid/ask + hedge rebalance + funding + residual jump/gamma reserve.
- Legal/rule dependency: Expiry instant, index source, exercise convention, contract multiplier and prediction resolver must align.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing options-implied binary pricing and volatility data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One market/expiry event; multiple marks are diagnostics, not independent observations.
- Leakage/selection risk: Surface smoothing through future quotes, unsupported interpolation and choosing only favorable strikes.
- Infrastructure: Sequenced surface builder, no-arbitrage cleaner, digital bound extractor, synchronized hedge simulator.
- Time/storage: 30 days; moderate derived storage, raw Deribit books dominate.
- Why this is not stale retail logic: It uses executable 2026 surfaces and small segmented prediction capacity, not textbook Black–Scholes point estimates.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: deribitBooks, polymarketFees, polymarketBooks

### P07 — Recent winning-streak switcher

- Family: Portfolio/meta allocation and research controls
- Decision: **REJECTED_MECHANISM**; research-priority score: **37/100**.
- Economic mechanism: Turn on whichever shadow strategy has most recently won.
- Who pays: No durable payer; streak selection is a multiple-testing artifact.
- Why it may persist: Allocation can improve capital use but cannot manufacture alpha from negative components.
- Capacity and half-life: $500/$1,000 shared bankroll; rebalance at independent-unit boundaries, not every tick.
- Required data/readiness: frozen strategy identities; prequential predictions; capital occupancy; cross-strategy covariance; settled PnL. B — trial ledger and strategy facts exist, but most component edges are unvalidated.
- Execution/legs: Allocate only among pre-registered eligible arms using information available before each independent unit.
- Latency: Low; correctness and anti-leakage are more important than sub-second action.
- Full cost model: Underlying strategy costs + idle/fragmented capital + switching/rebalance costs.
- Legal/rule dependency: Inherits every component venue restriction and shared-account exposure limit.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing portfolio/meta allocation and research controls data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One next market/event after an allocation decision.
- Leakage/selection risk: Winner chasing, overlapping strategy returns, using unsettled future labels and repeated model selection.
- Infrastructure: Prequential ledger, shared-bankroll simulator, embargoed walk-forward folds and multiplicity accounting.
- Time/storage: 30+ days; negligible incremental storage.
- Why this is not stale retail logic: It is a governance/capital layer and is explicitly forbidden from treating recent streaks as causal alpha.
- Existing evidence: Recent-strategy chasing was requested previously but cannot turn noise into alpha.
- Source keys: overfitPaper

### M12 — Generic symmetric two-sided maker

- Family: Selective passive liquidity and execution edge
- Decision: **REJECTED_EXISTING_EVIDENCE**; research-priority score: **36/100**.
- Economic mechanism: Continuously quote both sides around midpoint without an independent fair-value bound.
- Who pays: No defensible payer after toxicity and inventory costs.
- Why it may persist: Spread/reward income persists only where uninformed flow exceeds adverse selection and queue/cancel losses.
- Capacity and half-life: $5–$100 inventory per market; quote lifetime milliseconds to hours by category.
- Required data/readiness: full books; public and authenticated fills; queue-ahead; cancel acknowledgements; fee/reward schedule; 1/5/30s markouts. C — public flow exists; authenticated queue/fill fidelity is absent and generic controls are strongly negative.
- Execution/legs: One-sided post-only quote inside a conservative fair-value interval; hedge or cancel on bound violation; inventory-aware.
- Latency: 20–100 ms internal reaction is useful; feed quality and cancel acknowledgement dominate CPU micro-optimization.
- Full cost model: Adverse markout + non-fill/queue + inventory capital + hedge/taker fee − maker rewards/rebates actually earned.
- Legal/rule dependency: Post-only, heartbeat, reward eligibility, tick-size and self-trade rules.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing selective passive liquidity and execution edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One market-session or one quote episode separated by flat inventory.
- Leakage/selection risk: Assuming public prints imply own fills, ignoring queue ahead, and filtering toxicity after observing markout.
- Infrastructure: Dedicated event process, local books/fair bounds, queue simulator, authenticated user channel only after promotion.
- Time/storage: 30 days; event transitions only in SQL, raw books in Parquet.
- Why this is not stale retail logic: It is conditional and fair-bound-driven; generic two-sided quoting remains a negative control.
- Existing evidence: Generic making controls are strongly negative.
- Source keys: polymarketOrders, polymarketBooks, polymarketFees, ofiPaper

### M11 — Public-flow scalp

- Family: Selective passive liquidity and execution edge
- Decision: **REJECTED_EXISTING_EVIDENCE**; research-priority score: **34/100**.
- Economic mechanism: Follow observed public market orders and immediately take the same direction.
- Who pays: Supposed uninformed lagging makers.
- Why it may persist: Spread/reward income persists only where uninformed flow exceeds adverse selection and queue/cancel losses.
- Capacity and half-life: $5–$100 inventory per market; quote lifetime milliseconds to hours by category.
- Required data/readiness: full books; public and authenticated fills; queue-ahead; cancel acknowledgements; fee/reward schedule; 1/5/30s markouts. C — public flow exists; authenticated queue/fill fidelity is absent and generic controls are strongly negative.
- Execution/legs: One-sided post-only quote inside a conservative fair-value interval; hedge or cancel on bound violation; inventory-aware.
- Latency: 20–100 ms internal reaction is useful; feed quality and cancel acknowledgement dominate CPU micro-optimization.
- Full cost model: Adverse markout + non-fill/queue + inventory capital + hedge/taker fee − maker rewards/rebates actually earned.
- Legal/rule dependency: Post-only, heartbeat, reward eligibility, tick-size and self-trade rules.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing selective passive liquidity and execution edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One market-session or one quote episode separated by flat inventory.
- Leakage/selection risk: Assuming public prints imply own fills, ignoring queue ahead, and filtering toxicity after observing markout.
- Infrastructure: Dedicated event process, local books/fair bounds, queue simulator, authenticated user channel only after promotion.
- Time/storage: 30 days; event transitions only in SQL, raw books in Parquet.
- Why this is not stale retail logic: It is conditional and fair-bound-driven; generic two-sided quoting remains a negative control.
- Existing evidence: Generic flow strategy was adversely selected and negative.
- Source keys: polymarketOrders, polymarketBooks, polymarketFees, ofiPaper

### C15 — Generic CEX momentum/RSI

- Family: Crypto CEX/perpetual relative value
- Decision: **REJECTED_EXISTING_EVIDENCE**; research-priority score: **33/100**.
- Economic mechanism: Unconditional lagging indicators attempt to predict already-efficient liquid crypto returns.
- Who pays: No defensible payer after fees.
- Why it may persist: Fragmented inventory, funding and venue-specific order flow can create short-lived relative-value effects; most simple signals are crowded.
- Capacity and half-life: $50–$1,000 nominal capacity, but minimum orders and hedge margin matter; half-life from 100 ms to days.
- Required data/readiness: sequenced CEX books/trades; venue fees; funding/index/mark series; order latency; terminal forward returns. B for Binance/Coinbase/Hyperliquid market data; C for funding and authenticated fill fidelity.
- Execution/legs: Pre-funded inventory, simultaneous IOC/FOK where available, conservative cross-book depth and inventory rebalance.
- Latency: 20–500 ms for microstructure; minutes/days for funding and cointegration. Dublin fit must be benchmarked by venue.
- Full cost model: Maker/taker fees + spread/depth + funding/borrow + liquidation/gap reserve + transfer/rebalance.
- Legal/rule dependency: Account jurisdiction, leverage eligibility, index methodology, liquidation and custody terms.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing crypto cex/perpetual relative value data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: Non-overlapping episode or venue funding interval; cluster by day and asset state.
- Leakage/selection risk: Pair/horizon mining, exchange-clock misalignment and survivor bias in symbols/venues.
- Infrastructure: Unified event schema, local books, fee/funding versioning, causal replay and pre-funded inventory simulator.
- Time/storage: 14–30 days; raw depth is expensive, so preserve deltas and periodic snapshots rather than repeated full books.
- Why this is not stale retail logic: Only state-conditioned, depth-executable effects survive screening; generic RSI/momentum is a rejected control.
- Existing evidence: MAIN-style momentum/heuristics underperformed the market quote and costs.
- Source keys: binanceStreams, coinbaseStreams, hyperliquidStreams, ofiPaper

### N10 — Self-modifying AI trader

- Family: Public information, semantic and AI-assisted event edge
- Decision: **REJECTED_MECHANISM**; research-priority score: **31/100**.
- Economic mechanism: Continuously alter strategy selection and thresholds from recent P&L.
- Who pays: No stable economic payer; apparent edge can be adaptive overfit.
- Why it may persist: Operational interpretation delays may persist in obscure markets, but major headline reactions are fast and crowded.
- Capacity and half-life: $5–$100 in obscure markets; seconds to hours depending on source and ambiguity.
- Required data/readiness: official source timestamp; local receive/monotonic clock; immutable content hash; mapped rules; pre-event books; terminal outcome. D/C — rule text exists; causal official-news and social-source collectors are not yet complete.
- Execution/legs: Official public source only; parse to a calibrated event claim; deterministic rule match; trade only against executable book after uncertainty reserve.
- Latency: Seconds for major news, minutes for obscure semantic updates; source timestamps must be auditable.
- Full cost model: Venue fees/depth + model uncertainty + stale/edited/deleted-post reserve + latency decay.
- Legal/rule dependency: Models may propose hypotheses but cannot mutate a live/paper strategy outside a new frozen manifest.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing public information, semantic and ai-assisted event edge data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One public information event mapped before outcome to one market cluster.
- Leakage/selection risk: Using edited content, publication databases with revised timestamps, prompt/model changes and post-hoc market mapping.
- Infrastructure: Causal source collectors, content-addressed store, model/prompt registry, deterministic claim-to-rule verifier.
- Time/storage: Collector-first, 30–90 days; text is small, linked book capture dominates.
- Why this is not stale retail logic: AI proposes interpretations at scale, but price/execution and deterministic rule checks remain authoritative.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: polymarketResolution, overfitPaper

### D12 — 2020-style REST reserve polling arb

- Family: DEX/on-chain and cross-network execution
- Decision: **REJECTED_MECHANISM**; research-priority score: **28/100**.
- Economic mechanism: Poll stale pool reserves and submit after a visible CEX discrepancy.
- Who pays: No durable payer in a mature builder/MEV auction.
- Why it may persist: Atomic state transitions can create true locks, but public MEV auctions transfer much of the surplus to validators/builders.
- Capacity and half-life: $10–$1,000 depending on pool depth; half-life is often one block/slot and competition is intense.
- Required data/readiness: full on-chain state; mempool/shred/block feed where permitted; DEX route quotes; gas/priority/tip history; CEX books when hedged. D — TV2 does not yet preserve the required causal on-chain state or landing-cost data.
- Execution/legs: Simulate exact state, submit all-or-none bundle where supported, require post-tip/gas profit and revert protection.
- Latency: Block/slot competitive; Dublin is directly useful for Jito Dublin but not proof of winning auctions.
- Full cost model: Pool fees + price impact + gas/priority fee + builder/Jito tip + failed landing opportunity cost + inventory hedge.
- Legal/rule dependency: Protocol terms, token restrictions, RPC/provider terms and anti-manipulation rules.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing dex/on-chain and cross-network execution data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One distinct block/slot opportunity with one executable state root.
- Leakage/selection risk: Historical state without competitors, ignoring failed bundles and using end-of-block reserves.
- Infrastructure: Archive node/RPC, deterministic simulator, bundle submitter in paper mode, landed-tip and failure recorder.
- Time/storage: Collector-first; 14–30 days and potentially hundreds of GiB unless universe is tightly bounded.
- Why this is not stale retail logic: Only atomic, costed opportunities are retained; 2020-style REST reserve polling is explicitly rejected.
- Existing evidence: Mechanism is stale under modern block builders, tips and competition.
- Source keys: jitoBundles

### D11 — Public mempool sandwich/frontrun

- Family: DEX/on-chain and cross-network execution
- Decision: **REJECTED_MECHANISM**; research-priority score: **19/100**.
- Economic mechanism: Attempt to profit by ordering around another user transaction.
- Who pays: Victim slippage.
- Why it may persist: Atomic state transitions can create true locks, but public MEV auctions transfer much of the surplus to validators/builders.
- Capacity and half-life: $10–$1,000 depending on pool depth; half-life is often one block/slot and competition is intense.
- Required data/readiness: full on-chain state; mempool/shred/block feed where permitted; DEX route quotes; gas/priority/tip history; CEX books when hedged. D — TV2 does not yet preserve the required causal on-chain state or landing-cost data.
- Execution/legs: Simulate exact state, submit all-or-none bundle where supported, require post-tip/gas profit and revert protection.
- Latency: Block/slot competitive; Dublin is directly useful for Jito Dublin but not proof of winning auctions.
- Full cost model: Pool fees + price impact + gas/priority fee + builder/Jito tip + failed landing opportunity cost + inventory hedge.
- Legal/rule dependency: Excluded by project mandate: manipulation/prohibited transaction ordering is not built.
- Cheapest falsification: Run a bounded causal replay/scanner over the existing dex/on-chain and cross-network execution data; reject if no positive doubled-cost lower-bound episode exists.
- Independent unit: One distinct block/slot opportunity with one executable state root.
- Leakage/selection risk: Historical state without competitors, ignoring failed bundles and using end-of-block reserves.
- Infrastructure: Archive node/RPC, deterministic simulator, bundle submitter in paper mode, landed-tip and failure recorder.
- Time/storage: Collector-first; 14–30 days and potentially hundreds of GiB unless universe is tightly bounded.
- Why this is not stale retail logic: Only atomic, costed opportunities are retained; 2020-style REST reserve polling is explicitly rejected.
- Existing evidence: No DeltaForge result yet; mechanism prior only.
- Source keys: jitoBundles

## Primary sources

- polymarketFees: [Polymarket fee schedule](https://docs.polymarket.com/trading/fees) (mechanics/research dated 2026-08-03).
- polymarketOrders: [Polymarket order mechanics](https://docs.polymarket.com/trading/orders/create) (mechanics/research dated 2026-08-03).
- polymarketBooks: [Polymarket order books](https://docs.polymarket.com/trading/orderbook) (mechanics/research dated 2026-08-03).
- polymarketResolution: [Polymarket resolution](https://docs.polymarket.com/concepts/resolution) (mechanics/research dated 2026-08-03).
- kalshiOrders: [Kalshi order API V2](https://docs.kalshi.com/api-reference/orders/create-order-v2) (mechanics/research dated 2026-08-03).
- kalshiFees: [Kalshi fee rounding](https://docs.kalshi.com/getting_started/fee_rounding) (mechanics/research dated 2026-08-03).
- kalshiBooks: [Kalshi WebSocket order books](https://docs.kalshi.com/websockets/orderbook-updates) (mechanics/research dated 2026-08-03).
- deribitBooks: [Deribit sequenced option books](https://docs.deribit.com/subscriptions/orderbook/bookinstrument_nameinterval) (mechanics/research dated 2026-08-03).
- binanceStreams: [Binance Spot WebSocket streams](https://developers.binance.com/en/docs/binance-spot-api-docs/web-socket-streams) (mechanics/research dated 2026-08-03).
- coinbaseStreams: [Coinbase Advanced Trade WebSocket channels](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-channels) (mechanics/research dated 2026-08-03).
- hyperliquidStreams: [Hyperliquid WebSocket subscriptions](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions) (mechanics/research dated 2026-08-03).
- jitoBundles: [Jito low-latency bundles](https://docs.jito.wtf/lowlatencytxnsend/) (mechanics/research dated 2026-08-03).
- predictionGraphPaper: [Arbitrage-Free Combinatorial Market Making via Integer Programming](https://arxiv.org/abs/1606.02825) (mechanics/research dated 2016-06-09).
- polymarketArbPaper: [Unravelling the Probabilistic Forest](https://arxiv.org/abs/2508.03474) (mechanics/research dated 2025-08-05).
- ofiPaper: [The Price Impact of Order Book Events](https://arxiv.org/abs/1011.6402) (mechanics/research dated 2010-11-29).
- overfitPaper: [Statistical Overfitting and Backtest Performance](https://sdm.lbl.gov/oapapers/ssrn-id2507040-bailey.pdf) (mechanics/research dated 2014-09-25).

