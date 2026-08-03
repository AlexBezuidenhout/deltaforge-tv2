'use strict';

/**
 * Broad mechanism registry for the DeltaForge edge-discovery funnel.
 *
 * This is deliberately not a strategy-parameter registry. Each row describes
 * a materially different economic transfer mechanism and the cheapest honest
 * way to reject it. Only rows which survive this screen may receive a frozen
 * experiment manifest. Scores are priors for engineering allocation, never
 * evidence of profitability.
 */

const RESEARCH_AS_OF = '2026-08-03';

const SOURCE_REGISTRY = Object.freeze({
  polymarketFees: {
    asOf: RESEARCH_AS_OF,
    label: 'Polymarket fee schedule',
    url: 'https://docs.polymarket.com/trading/fees',
  },
  polymarketOrders: {
    asOf: RESEARCH_AS_OF,
    label: 'Polymarket order mechanics',
    url: 'https://docs.polymarket.com/trading/orders/create',
  },
  polymarketBooks: {
    asOf: RESEARCH_AS_OF,
    label: 'Polymarket order books',
    url: 'https://docs.polymarket.com/trading/orderbook',
  },
  polymarketResolution: {
    asOf: RESEARCH_AS_OF,
    label: 'Polymarket resolution',
    url: 'https://docs.polymarket.com/concepts/resolution',
  },
  kalshiOrders: {
    asOf: RESEARCH_AS_OF,
    label: 'Kalshi order API V2',
    url: 'https://docs.kalshi.com/api-reference/orders/create-order-v2',
  },
  kalshiFees: {
    asOf: RESEARCH_AS_OF,
    label: 'Kalshi fee rounding',
    url: 'https://docs.kalshi.com/getting_started/fee_rounding',
  },
  kalshiBooks: {
    asOf: RESEARCH_AS_OF,
    label: 'Kalshi WebSocket order books',
    url: 'https://docs.kalshi.com/websockets/orderbook-updates',
  },
  deribitBooks: {
    asOf: RESEARCH_AS_OF,
    label: 'Deribit sequenced option books',
    url: 'https://docs.deribit.com/subscriptions/orderbook/bookinstrument_nameinterval',
  },
  binanceStreams: {
    asOf: RESEARCH_AS_OF,
    label: 'Binance Spot WebSocket streams',
    url: 'https://developers.binance.com/en/docs/binance-spot-api-docs/web-socket-streams',
  },
  coinbaseStreams: {
    asOf: RESEARCH_AS_OF,
    label: 'Coinbase Advanced Trade WebSocket channels',
    url: 'https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-channels',
  },
  hyperliquidStreams: {
    asOf: RESEARCH_AS_OF,
    label: 'Hyperliquid WebSocket subscriptions',
    url: 'https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions',
  },
  jitoBundles: {
    asOf: RESEARCH_AS_OF,
    label: 'Jito low-latency bundles',
    url: 'https://docs.jito.wtf/lowlatencytxnsend/',
  },
  predictionGraphPaper: {
    asOf: '2016-06-09',
    label: 'Arbitrage-Free Combinatorial Market Making via Integer Programming',
    url: 'https://arxiv.org/abs/1606.02825',
  },
  polymarketArbPaper: {
    asOf: '2025-08-05',
    label: 'Unravelling the Probabilistic Forest',
    url: 'https://arxiv.org/abs/2508.03474',
  },
  ofiPaper: {
    asOf: '2010-11-29',
    label: 'The Price Impact of Order Book Events',
    url: 'https://arxiv.org/abs/1011.6402',
  },
  overfitPaper: {
    asOf: '2014-09-25',
    label: 'Statistical Overfitting and Backtest Performance',
    url: 'https://sdm.lbl.gov/oapapers/ssrn-id2507040-bailey.pdf',
  },
});

const RUBRIC = Object.freeze({
  mechanismStrength: 25,
  dataReadiness: 15,
  bankrollCapacity: 10,
  persistence: 10,
  dublinFit: 5,
  simplicity: 5,
  boundedRisk: 10,
  cheapFalsification: 5,
  independence: 5,
  postCostDollarOpportunity: 10,
});

const DECISIONS = Object.freeze({
  INCUBATE: 'INCUBATE',
  CONTINUE_FROZEN: 'CONTINUE_FROZEN',
  DETERMINISTIC_SCANNER: 'DETERMINISTIC_SCANNER',
  CHEAP_FALSIFICATION: 'CHEAP_FALSIFICATION',
  COLLECT_ONLY: 'COLLECT_ONLY',
  BLOCKED_DATA: 'BLOCKED_DATA',
  REJECTED_EXISTING_EVIDENCE: 'REJECTED_EXISTING_EVIDENCE',
  REJECTED_MECHANISM: 'REJECTED_MECHANISM',
});

const FAMILY_PROFILES = Object.freeze({
  structural: {
    label: 'Prediction-market structural and semantic edge',
    persistence: 'Payoff algebra persists until quotes, rules or displayed depth change; capacity is usually small and fragmented.',
    capacityAndHalfLife: '$1–$100 displayed capacity is plausible; quote half-life ranges from one event to hours, but must be measured.',
    requiredData: ['immutable rule text/hash', 'resolver and fallback', 'full executable books', 'fee schedule', 'finite outcome-state compiler'],
    dataReadiness: 'B — rules/books exist, but relationship certification and passive fills remain incomplete.',
    executionPath: 'Prove every terminal state, walk all legs, reserve worst orphan unwind, then paper FOK or post-only-first/hedge-immediately.',
    latencySensitivity: 'Mostly 100 ms to minutes; economics and rule identity dominate raw reaction latency.',
    costModel: 'Current per-market fees + one tick/leg + walked depth + non-fill + worst orphan reserve + capital duration.',
    legalTermsDependency: 'Exact market wording, resolver, observation instant, rounding, cancellation and fallback clauses are hard gates.',
    independentUnit: 'A unique certified relationship observed in one non-overlapping event window.',
    leakageSelectionRisks: 'AI relation mining, repeated quote observations and selecting only positive bundles create severe multiplicity.',
    infrastructure: 'Condition graph, immutable rule snapshots, deterministic SAT/MILP payoff compiler, synchronized books and FOK simulator.',
    testTimeAndDisk: 'Continuous scanner; 30 days. Derived transitions are small; raw books already captured.',
    notStaleReason: 'It targets messy low-capacity semantic relationships, not the crowded single-market YES+NO identity.',
    sources: ['polymarketFees', 'polymarketOrders', 'polymarketResolution', 'predictionGraphPaper', 'polymarketArbPaper'],
    baseScore: { mechanismStrength: 5, dataReadiness: 3, bankrollCapacity: 4, persistence: 4, dublinFit: 4, simplicity: 2, boundedRisk: 4, cheapFalsification: 5, independence: 4, postCostDollarOpportunity: 3 },
  },
  crossVenue: {
    label: 'Rule-aware prediction/sports cross-venue relationships',
    persistence: 'Venue segmentation and trapped capital can sustain basis for seconds to days; identity errors can persist to settlement as losses.',
    capacityAndHalfLife: '$5–$250 per pair may fit this bankroll; basis half-life and capital-hours must be estimated by typed pair.',
    requiredData: ['both venues full depth', 'source/receive clocks', 'per-market fees', 'immutable rules', 'identity dimensions', 'terminal outcomes'],
    dataReadiness: 'B-/C+ — synchronized feeds exist, but no certified-equal pair and Kalshi rule coverage is sparse.',
    executionPath: 'Pre-fund both venues; synchronize depth; veto UNKNOWN; model sequential legs and emergency unwind. No cross-venue atomicity claim.',
    latencySensitivity: 'Convergence can be seconds to days; 100–500 ms matters for leg risk, not all opportunity creation.',
    costModel: 'Both venue fees and rounding + depth + reject/non-fill + transfer/rebalance + orphan loss + capital duration.',
    legalTermsDependency: 'Venue eligibility, account limits, exact settlement rules and withdrawal/custody constraints must be current.',
    independentUnit: 'Pair-direction-day or one non-overlapping dislocation episode, not each polling observation.',
    leakageSelectionRisks: 'Text similarity is not payoff identity; overlapping episodes and manual approvals can leak future knowledge.',
    infrastructure: 'Typed contract normalizer, hard-mismatch veto, synchronized dual books, two-leg state machine and capital clock.',
    testTimeAndDisk: '30 days and at least 300 pair-days; existing depth capture is reusable.',
    notStaleReason: 'It tests rule friction and capital segmentation rather than a naive midpoint comparison.',
    sources: ['polymarketFees', 'polymarketOrders', 'kalshiOrders', 'kalshiFees', 'kalshiBooks'],
    baseScore: { mechanismStrength: 4, dataReadiness: 2, bankrollCapacity: 3, persistence: 4, dublinFit: 4, simplicity: 2, boundedRisk: 2, cheapFalsification: 4, independence: 4, postCostDollarOpportunity: 3 },
  },
  resolver: {
    label: 'Resolver and observation-boundary transfer',
    persistence: 'Small source-specific residuals can survive near a hard observation boundary because the binary payoff references a particular oracle.',
    capacityAndHalfLife: '$5–$50 per market; half-life is usually seconds and expires at the observation boundary.',
    requiredData: ['authoritative resolver ticks', 'market opening reference', 'source/receive clocks', 'executable token book', 'terminal outcome'],
    dataReadiness: 'B+ for Chainlink; C/D for sources whose sockets are empty or rule mapping is incomplete.',
    executionPath: 'Use market quote as prior, add only a frozen resolver residual, require conservative lower bound above executable ask and doubled cost.',
    latencySensitivity: '20–500 ms can affect fillability near expiry; source correctness and remaining-time tail dominate.',
    costModel: 'Current token fee + one tick + walked depth + latency decay + source outage/fallback reserve.',
    legalTermsDependency: 'Exact resolver, opening/closing timestamp, precision, fallback and dispute process are mandatory.',
    independentUnit: 'One resolved market window.',
    leakageSelectionRisks: 'Tail envelopes trained through the test window, repeated ticks per market and post-hoc asset selection.',
    infrastructure: 'Resolver RTDS/WSS, opening-reference attestation, causal clocks, frozen empirical tail artifact and book replay.',
    testTimeAndDisk: '14+ days and 300 fresh markets; low incremental disk because core feeds already exist.',
    notStaleReason: 'The contract-specific resolver is an operational wrinkle absent from generic CEX momentum.',
    sources: ['polymarketFees', 'polymarketResolution', 'polymarketBooks'],
    baseScore: { mechanismStrength: 4, dataReadiness: 4, bankrollCapacity: 4, persistence: 3, dublinFit: 4, simplicity: 3, boundedRisk: 3, cheapFalsification: 5, independence: 5, postCostDollarOpportunity: 3 },
  },
  options: {
    label: 'Options-implied binary pricing and volatility',
    persistence: 'Segmentation between option and prediction venues may leave small residuals, but risk-neutral probability is not physical probability.',
    capacityAndHalfLife: '$5–$100 prediction leg; hedge capital can dominate. Half-life ranges from seconds to expiry.',
    requiredData: ['sequenced Deribit bid/ask books', 'exact expiry/strike mapping', 'forward/funding curve', 'prediction full depth', 'resolver mapping'],
    dataReadiness: 'C+ — surfaces are captured but current mapped targets are interpolated, not exact-expiry executable evidence.',
    executionPath: 'Construct arbitrage-free bid/ask probability bounds, walk prediction and hedge books, quantify delta/gamma/vega/jump residual.',
    latencySensitivity: '100 ms–minutes depending on surface move; synchronization matters more than sub-2 ms local compute.',
    costModel: 'Prediction fees + option/perp fees + bid/ask + hedge rebalance + funding + residual jump/gamma reserve.',
    legalTermsDependency: 'Expiry instant, index source, exercise convention, contract multiplier and prediction resolver must align.',
    independentUnit: 'One market/expiry event; multiple marks are diagnostics, not independent observations.',
    leakageSelectionRisks: 'Surface smoothing through future quotes, unsupported interpolation and choosing only favorable strikes.',
    infrastructure: 'Sequenced surface builder, no-arbitrage cleaner, digital bound extractor, synchronized hedge simulator.',
    testTimeAndDisk: '30 days; moderate derived storage, raw Deribit books dominate.',
    notStaleReason: 'It uses executable 2026 surfaces and small segmented prediction capacity, not textbook Black–Scholes point estimates.',
    sources: ['deribitBooks', 'polymarketFees', 'polymarketBooks'],
    baseScore: { mechanismStrength: 4, dataReadiness: 2, bankrollCapacity: 2, persistence: 3, dublinFit: 4, simplicity: 1, boundedRisk: 3, cheapFalsification: 3, independence: 4, postCostDollarOpportunity: 3 },
  },
  cex: {
    label: 'Crypto CEX/perpetual relative value',
    persistence: 'Fragmented inventory, funding and venue-specific order flow can create short-lived relative-value effects; most simple signals are crowded.',
    capacityAndHalfLife: '$50–$1,000 nominal capacity, but minimum orders and hedge margin matter; half-life from 100 ms to days.',
    requiredData: ['sequenced CEX books/trades', 'venue fees', 'funding/index/mark series', 'order latency', 'terminal forward returns'],
    dataReadiness: 'B for Binance/Coinbase/Hyperliquid market data; C for funding and authenticated fill fidelity.',
    executionPath: 'Pre-funded inventory, simultaneous IOC/FOK where available, conservative cross-book depth and inventory rebalance.',
    latencySensitivity: '20–500 ms for microstructure; minutes/days for funding and cointegration. Dublin fit must be benchmarked by venue.',
    costModel: 'Maker/taker fees + spread/depth + funding/borrow + liquidation/gap reserve + transfer/rebalance.',
    legalTermsDependency: 'Account jurisdiction, leverage eligibility, index methodology, liquidation and custody terms.',
    independentUnit: 'Non-overlapping episode or venue funding interval; cluster by day and asset state.',
    leakageSelectionRisks: 'Pair/horizon mining, exchange-clock misalignment and survivor bias in symbols/venues.',
    infrastructure: 'Unified event schema, local books, fee/funding versioning, causal replay and pre-funded inventory simulator.',
    testTimeAndDisk: '14–30 days; raw depth is expensive, so preserve deltas and periodic snapshots rather than repeated full books.',
    notStaleReason: 'Only state-conditioned, depth-executable effects survive screening; generic RSI/momentum is a rejected control.',
    sources: ['binanceStreams', 'coinbaseStreams', 'hyperliquidStreams', 'ofiPaper'],
    baseScore: { mechanismStrength: 3, dataReadiness: 3, bankrollCapacity: 3, persistence: 2, dublinFit: 3, simplicity: 3, boundedRisk: 2, cheapFalsification: 4, independence: 4, postCostDollarOpportunity: 3 },
  },
  dex: {
    label: 'DEX/on-chain and cross-network execution',
    persistence: 'Atomic state transitions can create true locks, but public MEV auctions transfer much of the surplus to validators/builders.',
    capacityAndHalfLife: '$10–$1,000 depending on pool depth; half-life is often one block/slot and competition is intense.',
    requiredData: ['full on-chain state', 'mempool/shred/block feed where permitted', 'DEX route quotes', 'gas/priority/tip history', 'CEX books when hedged'],
    dataReadiness: 'D — TV2 does not yet preserve the required causal on-chain state or landing-cost data.',
    executionPath: 'Simulate exact state, submit all-or-none bundle where supported, require post-tip/gas profit and revert protection.',
    latencySensitivity: 'Block/slot competitive; Dublin is directly useful for Jito Dublin but not proof of winning auctions.',
    costModel: 'Pool fees + price impact + gas/priority fee + builder/Jito tip + failed landing opportunity cost + inventory hedge.',
    legalTermsDependency: 'Protocol terms, token restrictions, RPC/provider terms and anti-manipulation rules.',
    independentUnit: 'One distinct block/slot opportunity with one executable state root.',
    leakageSelectionRisks: 'Historical state without competitors, ignoring failed bundles and using end-of-block reserves.',
    infrastructure: 'Archive node/RPC, deterministic simulator, bundle submitter in paper mode, landed-tip and failure recorder.',
    testTimeAndDisk: 'Collector-first; 14–30 days and potentially hundreds of GiB unless universe is tightly bounded.',
    notStaleReason: 'Only atomic, costed opportunities are retained; 2020-style REST reserve polling is explicitly rejected.',
    sources: ['jitoBundles'],
    baseScore: { mechanismStrength: 4, dataReadiness: 1, bankrollCapacity: 2, persistence: 2, dublinFit: 4, simplicity: 1, boundedRisk: 4, cheapFalsification: 2, independence: 4, postCostDollarOpportunity: 3 },
  },
  newsAi: {
    label: 'Public information, semantic and AI-assisted event edge',
    persistence: 'Operational interpretation delays may persist in obscure markets, but major headline reactions are fast and crowded.',
    capacityAndHalfLife: '$5–$100 in obscure markets; seconds to hours depending on source and ambiguity.',
    requiredData: ['official source timestamp', 'local receive/monotonic clock', 'immutable content hash', 'mapped rules', 'pre-event books', 'terminal outcome'],
    dataReadiness: 'D/C — rule text exists; causal official-news and social-source collectors are not yet complete.',
    executionPath: 'Official public source only; parse to a calibrated event claim; deterministic rule match; trade only against executable book after uncertainty reserve.',
    latencySensitivity: 'Seconds for major news, minutes for obscure semantic updates; source timestamps must be auditable.',
    costModel: 'Venue fees/depth + model uncertainty + stale/edited/deleted-post reserve + latency decay.',
    legalTermsDependency: 'Public-data license/API terms, venue rules, embargo/non-public-information restrictions and source authenticity.',
    independentUnit: 'One public information event mapped before outcome to one market cluster.',
    leakageSelectionRisks: 'Using edited content, publication databases with revised timestamps, prompt/model changes and post-hoc market mapping.',
    infrastructure: 'Causal source collectors, content-addressed store, model/prompt registry, deterministic claim-to-rule verifier.',
    testTimeAndDisk: 'Collector-first, 30–90 days; text is small, linked book capture dominates.',
    notStaleReason: 'AI proposes interpretations at scale, but price/execution and deterministic rule checks remain authoritative.',
    sources: ['polymarketResolution', 'overfitPaper'],
    baseScore: { mechanismStrength: 3, dataReadiness: 1, bankrollCapacity: 4, persistence: 3, dublinFit: 3, simplicity: 2, boundedRisk: 2, cheapFalsification: 3, independence: 4, postCostDollarOpportunity: 3 },
  },
  making: {
    label: 'Selective passive liquidity and execution edge',
    persistence: 'Spread/reward income persists only where uninformed flow exceeds adverse selection and queue/cancel losses.',
    capacityAndHalfLife: '$5–$100 inventory per market; quote lifetime milliseconds to hours by category.',
    requiredData: ['full books', 'public and authenticated fills', 'queue-ahead', 'cancel acknowledgements', 'fee/reward schedule', '1/5/30s markouts'],
    dataReadiness: 'C — public flow exists; authenticated queue/fill fidelity is absent and generic controls are strongly negative.',
    executionPath: 'One-sided post-only quote inside a conservative fair-value interval; hedge or cancel on bound violation; inventory-aware.',
    latencySensitivity: '20–100 ms internal reaction is useful; feed quality and cancel acknowledgement dominate CPU micro-optimization.',
    costModel: 'Adverse markout + non-fill/queue + inventory capital + hedge/taker fee − maker rewards/rebates actually earned.',
    legalTermsDependency: 'Post-only, heartbeat, reward eligibility, tick-size and self-trade rules.',
    independentUnit: 'One market-session or one quote episode separated by flat inventory.',
    leakageSelectionRisks: 'Assuming public prints imply own fills, ignoring queue ahead, and filtering toxicity after observing markout.',
    infrastructure: 'Dedicated event process, local books/fair bounds, queue simulator, authenticated user channel only after promotion.',
    testTimeAndDisk: '30 days; event transitions only in SQL, raw books in Parquet.',
    notStaleReason: 'It is conditional and fair-bound-driven; generic two-sided quoting remains a negative control.',
    sources: ['polymarketOrders', 'polymarketBooks', 'polymarketFees', 'ofiPaper'],
    baseScore: { mechanismStrength: 3, dataReadiness: 2, bankrollCapacity: 4, persistence: 3, dublinFit: 4, simplicity: 2, boundedRisk: 3, cheapFalsification: 4, independence: 4, postCostDollarOpportunity: 3 },
  },
  portfolio: {
    label: 'Portfolio/meta allocation and research controls',
    persistence: 'Allocation can improve capital use but cannot manufacture alpha from negative components.',
    capacityAndHalfLife: '$500/$1,000 shared bankroll; rebalance at independent-unit boundaries, not every tick.',
    requiredData: ['frozen strategy identities', 'prequential predictions', 'capital occupancy', 'cross-strategy covariance', 'settled PnL'],
    dataReadiness: 'B — trial ledger and strategy facts exist, but most component edges are unvalidated.',
    executionPath: 'Allocate only among pre-registered eligible arms using information available before each independent unit.',
    latencySensitivity: 'Low; correctness and anti-leakage are more important than sub-second action.',
    costModel: 'Underlying strategy costs + idle/fragmented capital + switching/rebalance costs.',
    legalTermsDependency: 'Inherits every component venue restriction and shared-account exposure limit.',
    independentUnit: 'One next market/event after an allocation decision.',
    leakageSelectionRisks: 'Winner chasing, overlapping strategy returns, using unsettled future labels and repeated model selection.',
    infrastructure: 'Prequential ledger, shared-bankroll simulator, embargoed walk-forward folds and multiplicity accounting.',
    testTimeAndDisk: '30+ days; negligible incremental storage.',
    notStaleReason: 'It is a governance/capital layer and is explicitly forbidden from treating recent streaks as causal alpha.',
    sources: ['overfitPaper'],
    baseScore: { mechanismStrength: 2, dataReadiness: 3, bankrollCapacity: 5, persistence: 2, dublinFit: 2, simplicity: 3, boundedRisk: 4, cheapFalsification: 5, independence: 3, postCostDollarOpportunity: 2 },
  },
});

function seed(id, title, economicMechanism, whoPays, overrides = {}) {
  return { id, title, economicMechanism, whoPays, ...overrides };
}

const FAMILY_SEEDS = Object.freeze({
  structural: [
    seed('S01', 'Complete mutually-exclusive ask bundle', 'Buy one share of every exhaustive outcome only when the walked all-in cost is below the guaranteed unit payout.', 'Stale or fragmented outcome sellers whose aggregate asks violate the simplex.', { decision: DECISIONS.DETERMINISTIC_SCANNER, existingEvidence: 'Scanner exists; current epoch has zero executable positive bundles.', score: { dataReadiness: 4, simplicity: 4, boundedRisk: 5 } }),
    seed('S02', 'Mergeable complement inventory lock', 'Acquire complementary conditional tokens, merge/redeem them only where venue mechanics and inventory make the payout identity executable.', 'Complement sellers pricing inventory below merge value.', { decision: DECISIONS.CHEAP_FALSIFICATION, score: { simplicity: 3 } }),
    seed('S03', 'Ordered-strike YES-low plus NO-high', 'For K_low < K_high, YES(S>K_low)+NO(S>K_high) pays at least one in every state; trade only below guaranteed payout after orphan reserve.', 'Independent quote setters across nested thresholds.', { decision: DECISIONS.DETERMINISTIC_SCANNER, existingEvidence: 'V1 is running; all current candidates fail economics/orphan safety.', score: { dataReadiness: 4, boundedRisk: 5, postCostDollarOpportunity: 4 } }),
    seed('S04', 'Ordered-strike put implication', 'For K_low < K_high, NO(S>K_low) implies NO(S>K_high); compile the corresponding bounded-payoff spread rather than assuming symmetry.', 'Misordered downside threshold books.', { decision: DECISIONS.DETERMINISTIC_SCANNER }),
    seed('S05', 'Disjoint range partition bundle', 'Map non-overlapping ranges covering the outcome space and buy the exhaustive partition below one.', 'Range-market makers maintaining books independently.', { decision: DECISIONS.CHEAP_FALSIFICATION }),
    seed('S06', 'Overlapping range inclusion-exclusion', 'Use deterministic set algebra to identify over/under-priced intersections and unions with statewise bounded payoff.', 'Independent range and composite-event liquidity providers.', { decision: DECISIONS.CHEAP_FALSIFICATION, score: { simplicity: 1 } }),
    seed('S07', 'Nested time-horizon implication', 'A threshold hit by an earlier deadline can imply the same ever-hit condition by a later deadline when rules are identical.', 'Markets segmented by expiry horizon.', { decision: DECISIONS.CHEAP_FALSIFICATION }),
    seed('S08', 'Tournament advancement graph', 'Winning a later tournament round implies advancing through earlier rounds; encode bracket states and prove bundles.', 'Sports markets quoted round-by-round.', { decision: DECISIONS.CHEAP_FALSIFICATION, requiredData: ['bracket structure', 'team identity', 'rules', 'books', 'fees'] }),
    seed('S09', 'Nomination-to-election implication', 'Winning a general election implies being the relevant nominee only where rules and replacement clauses make that implication exact.', 'Political markets separated by event stage.', { decision: DECISIONS.CHEAP_FALSIFICATION, legalTermsDependency: 'Replacement, death/withdrawal and party-rule clauses can break the implication and are automatic vetoes.' }),
    seed('S10', 'Popular-vote/election joint bounds', 'Trade only Fréchet/logical bounds between popular-vote and election outcomes; do not assume one implies the other.', 'Traders overconfident in an informal relationship.', { decision: DECISIONS.CHEAP_FALSIFICATION, boundedRisk: 2 }),
    seed('S11', 'Rate-cut count ladder', 'Counts such as at-least-N cuts form ordered strikes; compile all count states and detect monotonicity violations.', 'Macro contracts quoted as separate thresholds.', { decision: DECISIONS.DETERMINISTIC_SCANNER }),
    seed('S12', 'Inflation threshold ladder', 'CPI/PCE threshold contracts with identical release vintage and rounding must obey ordered-strike monotonicity.', 'Threshold-specific liquidity fragmentation.', { decision: DECISIONS.CHEAP_FALSIFICATION }),
    seed('S13', 'Weather threshold ladder', 'Official-station temperature/rainfall thresholds form ordered events when station, day and precision exactly match.', 'Low-capacity weather quote fragmentation.', { decision: DECISIONS.CHEAP_FALSIFICATION, score: { bankrollCapacity: 5, dublinFit: 5 } }),
    seed('S14', 'Crypto daily threshold graph', 'Exact resolver crypto price-above contracts across strikes share one terminal state and admit ordered-strike payoff proofs.', 'Independent small prediction-market books.', { decision: DECISIONS.DETERMINISTIC_SCANNER, existingEvidence: 'Current ordered-strike trial has candidates but no positive economics.' }),
    seed('S15', 'Mutually exclusive election-state slate', 'Build a complete candidate/state slate only when every residual outcome, replacement and tie state is represented.', 'Long-tail candidate books with inconsistent aggregate prices.', { decision: DECISIONS.CHEAP_FALSIFICATION }),
    seed('S16', 'Conditional-versus-joint probability bounds', 'Enforce P(A∩B)≤P(A), P(A∩B)≤P(B) and union bounds using finite-state payoffs, not probability-point estimates.', 'Composite-event markets quoted independently.', { decision: DECISIONS.CHEAP_FALSIFICATION, score: { simplicity: 1 } }),
    seed('S17', 'Duplicate-contract same-venue identity', 'Hash normalized predicate/resolver/time and detect duplicate listings with crossed executable books.', 'Operationally duplicated market listings.', { decision: DECISIONS.CHEAP_FALSIFICATION, score: { simplicity: 4, dataReadiness: 4 } }),
    seed('S18', 'Rule-ambiguity premium', 'Estimate whether ambiguous fallback/dispute clauses earn a persistent discount after controlling for price and duration; this is risky alpha, not arbitrage.', 'Traders avoiding hard-to-interpret settlement risk.', { decision: DECISIONS.COLLECT_ONLY, score: { mechanismStrength: 2, boundedRisk: 1 } }),
  ],
  crossVenue: [
    seed('X01', 'Certified terminal complement lock', 'Buy YES on one venue and NO on the other only when every identity dimension is certified equal and combined worst-case payout exceeds all costs.', 'Segmented sellers across Polymarket and Kalshi.', { decision: DECISIONS.DETERMINISTIC_SCANNER, existingEvidence: 'No certified-equal pair currently qualifies; UNKNOWN is vetoed.', score: { mechanismStrength: 5, boundedRisk: 3, dataReadiness: 3 } }),
    seed('X02', 'Exact-identity convergence', 'Open offsetting venue positions on a certified identity during a basis dislocation and close both after convergence instead of waiting to resolution.', 'Slow capital movement and venue-specific inventory shocks.', { decision: DECISIONS.CHEAP_FALSIFICATION, score: { mechanismStrength: 4, persistence: 5 } }),
    seed('X03', 'Typed near-identity convergence', 'Model similar but non-identical contracts by mismatch class and demand a reserve for states where they resolve differently.', 'Participants who price semantic similarity inconsistently.', { decision: DECISIONS.CHEAP_FALSIFICATION, existingEvidence: 'Broad polluted cohort was negative after resolver mismatches; clean trial has not produced enough pairs.' }),
    seed('X04', 'Polymarket-leading Kalshi lag', 'Estimate prequentially whether executable Polymarket changes predict Kalshi mid/ask changes after costs for certified pairs.', 'Slower venue-specific makers.', { decision: DECISIONS.COLLECT_ONLY }),
    seed('X05', 'Kalshi-leading Polymarket lag', 'Estimate the reverse directional price-discovery channel by event category and liquidity state.', 'Slower Polymarket books in regulated-news categories.', { decision: DECISIONS.COLLECT_ONLY }),
    seed('X06', 'Post-announcement asynchronous repricing', 'After an official release, trade only the lagging venue in a certified pair while the leading venue supplies a conservative fair bound.', 'Temporarily stale quote providers.', { decision: DECISIONS.BLOCKED_DATA, requiredData: ['causal official-news timestamp', 'both venue books', 'typed rules', 'fees'] }),
    seed('X07', 'Capital-duration terminal carry', 'Rank certified locks by guaranteed profit per dollar-hour rather than raw spread, including venue-specific settlement delay.', 'Capital-constrained participants leaving long-duration basis open.', { decision: DECISIONS.CHEAP_FALSIFICATION, score: { simplicity: 4 } }),
    seed('X08', 'Pre-funded dual-venue inventory rebalance', 'Hold balanced collateral on both venues and treat later transfers as inventory rebalancing, removing transfer latency from each opportunity.', 'Participants unable or unwilling to fragment capital.', { decision: DECISIONS.CHEAP_FALSIFICATION, score: { mechanismStrength: 3, bankrollCapacity: 2 } }),
    seed('X09', 'Cross-venue RFQ price improvement', 'Use venue RFQ/quote mechanisms for the second leg and require a firm response before committing the first where permitted.', 'Liquidity providers willing to price block inventory privately.', { decision: DECISIONS.BLOCKED_DATA, requiredData: ['RFQ responses', 'identity proof', 'both fee schedules', 'response latency'] }),
    seed('X10', 'Sportsbook three-way dutching', 'Remove vig from mutually exclusive home/draw/away books and combine only enforceable account limits and matching settlement rules.', 'Bookmakers/prediction venues with different customer flow.', { decision: DECISIONS.BLOCKED_DATA, legalTermsDependency: 'Bookmaker account eligibility, stake limits, void rules and withdrawal terms are hard constraints.' }),
    seed('X11', 'Exchange-versus-bookmaker lay hedge', 'Pair exchange/prediction YES with a bookmaker opposite outcome only when payout, dead-heat and void clauses are statewise matched.', 'Different bookmaker and exchange customer bases.', { decision: DECISIONS.BLOCKED_DATA }),
    seed('X12', 'Multi-venue exhaustive outcome set', 'Select cheapest executable outcome leg across venues to cover every terminal state below payout.', 'Fragmented outcome liquidity across two or more venues.', { decision: DECISIONS.CHEAP_FALSIFICATION, score: { mechanismStrength: 5, simplicity: 1 } }),
    seed('X13', 'Rule-risk basis portfolio', 'Price mismatch classes as explicit rare loss states and test whether persistent basis compensates them over resolved pairs.', 'Investors demanding a premium for resolver/wording risk.', { decision: DECISIONS.COLLECT_ONLY, score: { boundedRisk: 1 } }),
    seed('X14', 'Settlement-latency discount', 'Test whether otherwise certified contracts with slower payout exhibit a stable capital-duration discount exploitable by patient capital.', 'Impatient capital on slower settlement rails.', { decision: DECISIONS.COLLECT_ONLY, score: { persistence: 5, dublinFit: 2 } }),
  ],
  resolver: [
    seed('R01', 'H43-X Chainlink tail residual', 'Condition the market prior on fresh Chainlink displacement and a frozen pre-cutoff terminal-move envelope near expiry.', 'Makers conservatively pricing residual resolver movement and operational risk.', { decision: DECISIONS.CONTINUE_FROZEN, existingEvidence: 'Fresh v19: 3 fills, +$0.63 at doubled cost; far below promotion minimum.', score: { dataReadiness: 5, simplicity: 4, postCostDollarOpportunity: 4 } }),
    seed('R02', 'Pyth boundary residual', 'Replicate the H43-X architecture only for contracts explicitly settled from Pyth and a non-empty authenticated source feed.', 'Prediction quotes lagging Pyth-specific state.', { decision: DECISIONS.BLOCKED_DATA, existingEvidence: 'Prior Pyth attempts had heartbeats but unusable/empty source evidence.', score: { dataReadiness: 1 } }),
    seed('R03', 'CF Benchmarks boundary residual', 'Map the exact CF index construction and forecast only the bounded difference from liquid constituent venues near observation.', 'Quote setters approximating rather than reproducing the CF index.', { decision: DECISIONS.BLOCKED_DATA, score: { dataReadiness: 1 } }),
    seed('R04', 'Chainlink round-transition state', 'Model whether the active Chainlink round can update again before cutoff using round age and source heartbeat, not directional CEX momentum.', 'Participants ignoring round timing mechanics.', { decision: DECISIONS.CHEAP_FALSIFICATION, requiredData: ['Chainlink round IDs/times', 'market cutoff', 'book', 'outcomes'] }),
    seed('R05', 'Resolver carried-forward barrier', 'Identify contracts whose source may carry the last valid value and price the probability of no fresh update as a separate terminal state.', 'Traders assuming continuous updates during source degradation.', { decision: DECISIONS.COLLECT_ONLY }),
    seed('R06', 'Resolver outage recovery', 'After a source outage, test bounded quote lag when the authoritative stream resumes and stale barriers clear.', 'Quote providers slow to re-enable automated pricing.', { decision: DECISIONS.COLLECT_ONLY }),
    seed('R07', 'Timestamp precision mismatch', 'Exploit only deterministic differences between second/millisecond cutoff semantics where rules make inclusion/exclusion unambiguous.', 'Human traders overlooking boundary precision.', { decision: DECISIONS.CHEAP_FALSIFICATION, score: { mechanismStrength: 5, persistence: 4 } }),
    seed('R08', 'Opening-reference capture error', 'Detect a market opening reference that differs from the authoritative first eligible oracle value and trade only after rule attestation.', 'Frontends or makers using an approximate opening print.', { decision: DECISIONS.CHEAP_FALSIFICATION }),
    seed('R09', 'Cross-source resolver consensus barrier', 'Use Binance/Coinbase agreement only to tighten a conservative bound around the authoritative resolver, never to replace it.', 'Makers applying an overly broad uncertainty reserve.', { decision: DECISIONS.CHEAP_FALSIFICATION }),
    seed('R10', 'Resolver fallback-state portfolio', 'Compile primary source, fallback source, outage and dispute states and trade only when worst-state economics remain positive.', 'Markets priced to a single assumed resolver path.', { decision: DECISIONS.DETERMINISTIC_SCANNER, score: { simplicity: 1, boundedRisk: 5 } }),
  ],
  options: [
    seed('O01', 'Exact-expiry digital probability interval', 'Extract a risk-neutral digital bid/ask probability bound from exact-expiry verticals and compare it with executable prediction asks.', 'Segmented option and prediction-market liquidity.', { decision: DECISIONS.COLLECT_ONLY, existingEvidence: 'Current V4 has zero exact-expiry A-grade mapped targets.', score: { mechanismStrength: 5, dataReadiness: 2, postCostDollarOpportunity: 4 } }),
    seed('O02', 'Vertical-spread no-arbitrage bounds', 'Use executable adjacent strikes to bound a binary payoff without relying on a smooth fitted surface.', 'Prediction quotes outside option-replicable bounds.', { decision: DECISIONS.COLLECT_ONLY, score: { mechanismStrength: 5, boundedRisk: 4 } }),
    seed('O03', 'Butterfly density consistency', 'Detect negative or inconsistent implied probability mass across strikes, then ask whether prediction thresholds offer the cheaper correction.', 'Option/prediction books updated independently.', { decision: DECISIONS.COLLECT_ONLY }),
    seed('O04', 'Calendar probability bounds', 'For compatible ever-hit or terminal events, impose time monotonicity across exact option expiries and prediction horizons.', 'Term-structure quote fragmentation.', { decision: DECISIONS.COLLECT_ONLY }),
    seed('O05', 'Skew-jump residual', 'Condition prediction residuals on executable option skew changes that encode downside/upside jump demand.', 'Prediction makers using stale symmetric volatility assumptions.', { decision: DECISIONS.COLLECT_ONLY }),
    seed('O06', 'Scheduled-event volatility residual', 'Measure whether prediction markets under/overreact to option-implied event variance around known releases without direction guessing.', 'Participants mispricing event jump variance.', { decision: DECISIONS.BLOCKED_DATA, requiredData: ['event calendar', 'exact-expiry surface', 'prediction books', 'hedge costs'] }),
    seed('O07', 'Realized-versus-implied variance carry', 'Trade a hedged variance-risk-premium proxy only where small option positions and funding costs are executable for this bankroll.', 'Option buyers paying persistent insurance premium.', { decision: DECISIONS.BLOCKED_DATA, score: { bankrollCapacity: 1, simplicity: 1 } }),
    seed('O08', 'Delta-hedged prediction residual', 'Hedge local directional delta with a perpetual and attribute remaining P&L to probability residual, gamma, basis and jump risk.', 'Segmentation between binary and linear derivatives.', { decision: DECISIONS.COLLECT_ONLY, score: { boundedRisk: 2 } }),
    seed('O09', 'Cross-asset comparison copula bound', 'Price a company/coin A-above-B binary with conservative joint-distribution bounds rather than pretending stock ownership is a risk-neutral hedge.', 'Thin bespoke comparison markets.', { decision: DECISIONS.BLOCKED_DATA, score: { simplicity: 1, boundedRisk: 1 } }),
    seed('O10', 'Option-book stale-state snipe', 'Trade only after a sequenced option surface update proves the prediction quote is stale for a minimum dwell and executable at stressed latency.', 'Slow prediction-market quote refresh.', { decision: DECISIONS.COLLECT_ONLY }),
    seed('O11', 'Convexity boundary near expiry', 'Use exact verticals to bound very short-dated terminal probability where delta changes nonlinearly and point-IV interpolation is unstable.', 'Makers applying stale linear approximations.', { decision: DECISIONS.COLLECT_ONLY }),
    seed('O12', 'Risk-neutral/physical wedge calibration', 'Treat option probability minus market probability as a feature whose physical-measure wedge is calibrated out of sample, not as arbitrage.', 'Persistent risk-premium differences between participant bases.', { decision: DECISIONS.COLLECT_ONLY, score: { mechanismStrength: 2, boundedRisk: 1 } }),
  ],
  cex: [
    seed('C01', 'Cross-venue spot/perpetual basis', 'Buy cheap spot and short rich perpetual, or reverse where borrow permits, when carry exceeds full round-trip and funding stress.', 'Leveraged traders paying for directional exposure and venue segmentation.', { decision: DECISIONS.BLOCKED_DATA, requiredData: ['spot/perp books', 'funding history', 'fees', 'borrow/transfer costs'], score: { persistence: 4 } }),
    seed('C02', 'Funding-rate dispersion', 'Hold offsetting perpetuals on venues with divergent funding, neutralizing delta while collecting net funding after basis and liquidation reserve.', 'Venue-specific leveraged positioning.', { decision: DECISIONS.BLOCKED_DATA, score: { persistence: 5, latencySensitivity: 'Minutes to hours; latency is secondary to funding/index and liquidation fidelity.' } }),
    seed('C03', 'Fixed-expiry cash-and-carry', 'Lock spot/future basis to expiry where contract size and fees fit the bankroll.', 'Futures traders paying financing convenience.', { decision: DECISIONS.BLOCKED_DATA, score: { boundedRisk: 4, persistence: 5 } }),
    seed('C04', 'Pre-funded cross-exchange price lock', 'Simultaneously buy cheap and sell rich executable books using inventory already resident on both venues.', 'Transient inventory imbalances across exchanges.', { decision: DECISIONS.BLOCKED_DATA, score: { mechanismStrength: 4, persistence: 2 } }),
    seed('C05', 'BTC-to-alt conditional lead-lag', 'Use BTC innovations only when altcoin residual, depth and volatility state imply delayed transmission; freeze lag before forward test.', 'Slower repricing in less liquid related assets.', { decision: DECISIONS.CHEAP_FALSIFICATION, score: { dataReadiness: 4, cheapFalsification: 5 } }),
    seed('C06', 'ETH-to-SOL conditional lead-lag', 'Forecast the residual after contemporaneous beta, activating only in states with historically stable ETH price discovery.', 'Fragmented cross-asset liquidity.', { decision: DECISIONS.CHEAP_FALSIFICATION, score: { dataReadiness: 4 } }),
    seed('C07', 'Multivariate error-correction basket', 'Estimate a frozen state-space/VECM residual among BTC/ETH/SOL/XRP and trade only economically large, cost-surviving deviations.', 'Temporary inventory shocks around a stable common factor.', { decision: DECISIONS.CHEAP_FALSIFICATION, score: { dataReadiness: 4, simplicity: 2 } }),
    seed('C08', 'Cross-asset order-flow imbalance', 'Test whether depth-normalized OFI in the price-discovery asset predicts executable returns in a related lagging asset.', 'Slower market makers reacting to related-asset book events.', { decision: DECISIONS.CHEAP_FALSIFICATION, score: { dataReadiness: 4 } }),
    seed('C09', 'Liquidation-depletion recovery', 'After public liquidation flow consumes multiple levels, distinguish continuation from replenishment using opposite-side depth recovery.', 'Forced liquidators and inventory-constrained makers.', { decision: DECISIONS.COLLECT_ONLY, requiredData: ['liquidation stream', 'full depth', 'trades', 'fees'] }),
    seed('C10', 'Funding-regime conditional momentum', 'Activate short-horizon momentum only after extreme funding and order-flow alignment, with the opposite extreme as a separate frozen arm.', 'Crowded leveraged positions forced to adjust.', { decision: DECISIONS.COLLECT_ONLY }),
    seed('C11', 'Funding-regime reversal', 'Test post-crowding mean reversion after funding extremes and failed price continuation.', 'Late leveraged entrants unwinding.', { decision: DECISIONS.COLLECT_ONLY }),
    seed('C12', 'Session handoff liquidity effect', 'Pre-register UTC/session boundaries and test changes in spread/impact, not arbitrary clock buckets.', 'Predictable regional liquidity handoffs.', { decision: DECISIONS.CHEAP_FALSIFICATION, score: { mechanismStrength: 2, cheapFalsification: 5 } }),
    seed('C13', 'Index constituent lag', 'Compare perpetual index constituents with mark/index updates and trade only when executable venue price departs beyond rebalance cost.', 'Index calculation cadence and fragmented spot books.', { decision: DECISIONS.BLOCKED_DATA }),
    seed('C14', 'Stablecoin basis dislocation', 'Hedge a temporary USDT/USDC venue basis only with redemption/transfer and issuer risk explicitly reserved.', 'Urgent collateral demand and rail fragmentation.', { decision: DECISIONS.BLOCKED_DATA, score: { boundedRisk: 1 } }),
    seed('C15', 'Generic CEX momentum/RSI', 'Unconditional lagging indicators attempt to predict already-efficient liquid crypto returns.', 'No defensible payer after fees.', { decision: DECISIONS.REJECTED_EXISTING_EVIDENCE, existingEvidence: 'MAIN-style momentum/heuristics underperformed the market quote and costs.', score: { mechanismStrength: 0, persistence: 0, postCostDollarOpportunity: 0 } }),
  ],
  dex: [
    seed('D01', 'Same-chain atomic route arbitrage', 'Execute a cyclic swap whose simulated terminal balance exceeds input plus all fees/tip in one atomic bundle.', 'Temporarily inconsistent AMM curves.', { decision: DECISIONS.BLOCKED_DATA, score: { boundedRisk: 5, mechanismStrength: 5 } }),
    seed('D02', 'Solana Jito atomic cross-DEX route', 'Submit a state-asserted multi-DEX route to the Dublin Jito block engine with revert protection and competitive tip.', 'Fragmented Solana pool liquidity.', { decision: DECISIONS.BLOCKED_DATA, score: { dublinFit: 5, mechanismStrength: 5 } }),
    seed('D03', 'CEX-to-DEX pre-funded inventory arb', 'Buy on one rail and sell on the other without waiting for transfer, then rebalance inventory asynchronously.', 'On-chain versus centralized inventory shocks.', { decision: DECISIONS.BLOCKED_DATA, score: { boundedRisk: 2 } }),
    seed('D04', 'Cross-DEX stable-pool imbalance', 'Atomically route between stable pools when amplification curves and fees create a deterministic surplus.', 'Large one-sided stablecoin flow.', { decision: DECISIONS.BLOCKED_DATA }),
    seed('D05', 'AMM oracle-lag liquidation', 'Liquidate undercollateralized positions only when protocol oracle, close factor, gas/tip and auction competition imply positive landed value.', 'Borrowers crossing protocol liquidation thresholds.', { decision: DECISIONS.BLOCKED_DATA }),
    seed('D06', 'Protocol intent-auction residual', 'Respond to public intents only where solver competition and settlement guarantees leave positive quoted surplus.', 'Users paying for immediacy and route convenience.', { decision: DECISIONS.BLOCKED_DATA }),
    seed('D07', 'Cross-chain bridge basis', 'Pre-position inventory on both chains and trade persistent basis without assuming bridge atomicity.', 'Fragmented chain liquidity and slow bridge capital.', { decision: DECISIONS.BLOCKED_DATA, score: { boundedRisk: 1, persistence: 4 } }),
    seed('D08', 'LP loss-versus-rebalancing avoidance', 'Provide liquidity only when fee/reward expectation exceeds adverse selection/LVR under a frozen volatility and flow model.', 'Swap users paying fees; incentives subsidize liquidity.', { decision: DECISIONS.BLOCKED_DATA, score: { mechanismStrength: 3 } }),
    seed('D09', 'Gas-aware batched rebalance', 'Aggregate small inventory imbalances until saved gas exceeds additional basis risk.', 'Repeated small arbitrage profits otherwise consumed by fixed transaction cost.', { decision: DECISIONS.BLOCKED_DATA, score: { mechanismStrength: 2 } }),
    seed('D10', 'New-listing fragmented liquidity', 'Detect the same verified asset across venues and trade only with contract-address and transfer-tax safety checks.', 'Early fragmented price discovery.', { decision: DECISIONS.BLOCKED_DATA, score: { boundedRisk: 1 } }),
    seed('D11', 'Public mempool sandwich/frontrun', 'Attempt to profit by ordering around another user transaction.', 'Victim slippage.', { decision: DECISIONS.REJECTED_MECHANISM, legalTermsDependency: 'Excluded by project mandate: manipulation/prohibited transaction ordering is not built.', score: { mechanismStrength: 0, dataReadiness: 0, boundedRisk: 0, postCostDollarOpportunity: 0 } }),
    seed('D12', '2020-style REST reserve polling arb', 'Poll stale pool reserves and submit after a visible CEX discrepancy.', 'No durable payer in a mature builder/MEV auction.', { decision: DECISIONS.REJECTED_MECHANISM, existingEvidence: 'Mechanism is stale under modern block builders, tips and competition.', score: { mechanismStrength: 0, persistence: 0, dublinFit: 0 } }),
  ],
  newsAi: [
    seed('N01', 'Official social-post contract mapper', 'Parse a public post from a verified official account into deterministic market predicates and trade only unambiguous immediate implications.', 'Slow interpretation in obscure event markets.', { decision: DECISIONS.BLOCKED_DATA }),
    seed('N02', 'SEC filing event residual', 'Use EDGAR acceptance time and filing facts to update only contracts directly resolved by the disclosed event.', 'Prediction-market participants not monitoring structured filings.', { decision: DECISIONS.BLOCKED_DATA, score: { persistence: 4 } }),
    seed('N03', 'Official economic-release residual', 'Parse the first official release payload and compare a rule-matched probability update with executable markets.', 'Manual macro-market participants.', { decision: DECISIONS.BLOCKED_DATA }),
    seed('N04', 'Sports lineup/injury rule mapper', 'Convert official roster status into outcome-probability residuals only with a calibrated sport-specific model.', 'Slower niche-sports repricing.', { decision: DECISIONS.BLOCKED_DATA }),
    seed('N05', 'Court-docket procedural edge', 'Map public docket entries to contracts whose resolution depends on a procedural milestone, preserving filing and receive time.', 'Traders who do not monitor obscure legal workflows.', { decision: DECISIONS.BLOCKED_DATA, score: { persistence: 4 } }),
    seed('N06', 'On-chain governance outcome mapper', 'Decode finalized public governance votes/execution states into matching event contracts.', 'Manual governance-event traders.', { decision: DECISIONS.BLOCKED_DATA }),
    seed('N07', 'Earnings transcript claim residual', 'Use official release/transcript facts only where the contract predicate is directly observed; forecasts require a separately calibrated model.', 'Slow semantic parsing in bespoke company markets.', { decision: DECISIONS.BLOCKED_DATA }),
    seed('N08', 'Official weather nowcast residual', 'Combine official station observations/nowcasts with exact station/time threshold rules and conservative uncertainty.', 'Thin weather-market traders.', { decision: DECISIONS.BLOCKED_DATA, score: { bankrollCapacity: 5 } }),
    seed('N09', 'AI relationship proposal plus deterministic proof', 'Use an LLM only to propose candidate condition-graph edges; a finite-state verifier and human-auditable rule hash decide admissibility.', 'Operational search cost across thousands of obscure contracts.', { decision: DECISIONS.INCUBATE, score: { mechanismStrength: 5, dataReadiness: 3, boundedRisk: 5, postCostDollarOpportunity: 4 } }),
    seed('N10', 'Self-modifying AI trader', 'Continuously alter strategy selection and thresholds from recent P&L.', 'No stable economic payer; apparent edge can be adaptive overfit.', { decision: DECISIONS.REJECTED_MECHANISM, legalTermsDependency: 'Models may propose hypotheses but cannot mutate a live/paper strategy outside a new frozen manifest.', score: { mechanismStrength: 0, independence: 0, boundedRisk: 0 } }),
  ],
  making: [
    seed('M01', 'Fair-bound one-sided passive making', 'Post only on the side whose price lies outside a conservative independent fair interval and cancel when the interval crosses the quote.', 'Impatient retail flow paying spread.', { decision: DECISIONS.COLLECT_ONLY, existingEvidence: 'Staged, not active; authenticated queue/fill evidence is missing.', score: { mechanismStrength: 4, dataReadiness: 3 } }),
    seed('M02', 'Inventory-skewed selective quote', 'Quote one side based on current inventory and terminal state risk rather than maintaining symmetric two-sided exposure.', 'Retail takers demanding immediacy.', { decision: DECISIONS.COLLECT_ONLY }),
    seed('M03', 'Reward-qualified passive quote', 'Quote only when expected earned maker reward exceeds markout, queue and inventory cost at the exact scoring formula.', 'Venue liquidity incentives plus taker spread.', { decision: DECISIONS.COLLECT_ONLY, score: { persistence: 4 } }),
    seed('M04', 'Complete-set paired maker', 'Passively acquire complementary outcomes below merge value while reserving one-leg inventory risk.', 'Two-sided retail flow and complement mispricing.', { decision: DECISIONS.REJECTED_EXISTING_EVIDENCE, existingEvidence: 'Generic paired-maker control is materially negative from adverse selection.', score: { mechanismStrength: 2, dataReadiness: 3, postCostDollarOpportunity: 0 } }),
    seed('M05', 'Low-toxicity category maker', 'Pre-register categories where 1/5/30-second public-flow markouts and spread exceed costs, then forward-test unchanged.', 'Less-informed takers in obscure categories.', { decision: DECISIONS.CHEAP_FALSIFICATION, score: { dataReadiness: 3 } }),
    seed('M06', 'Queue-survival quote filter', 'Enter only where estimated queue ahead and expected trade arrival imply fill before fair-bound expiry.', 'Takers crossing an existing queue.', { decision: DECISIONS.BLOCKED_DATA, requiredData: ['authenticated queue/fills', 'full order events', 'trade arrivals'] }),
    seed('M07', 'Cancel-toxicity barrier', 'Cancel immediately on external fair-bound shocks and score from actual cancel acknowledgement, not request time.', 'Spread income between information shocks.', { decision: DECISIONS.BLOCKED_DATA }),
    seed('M08', 'Time-to-resolution spread curve', 'Model spread income versus binary jump/adverse-selection risk by time-to-resolution and only quote positive lower-bound states.', 'Late-window urgency from takers.', { decision: DECISIONS.CHEAP_FALSIFICATION }),
    seed('M09', 'Odd-lot neglected-capacity maker', 'Target $5–$25 quote capacity too small for institutional desks, with hard concentration and minimum-dollar profit tests.', 'Small retail orders in operationally neglected markets.', { decision: DECISIONS.COLLECT_ONLY, score: { bankrollCapacity: 5, persistence: 4 } }),
    seed('M10', 'Maker-taker optionality switch', 'Post passively while fair value is stable, but cross the hedge only after an actual fill; compare to pure taker under one kernel.', 'Venue maker/taker asymmetry.', { decision: DECISIONS.COLLECT_ONLY }),
    seed('M11', 'Public-flow scalp', 'Follow observed public market orders and immediately take the same direction.', 'Supposed uninformed lagging makers.', { decision: DECISIONS.REJECTED_EXISTING_EVIDENCE, existingEvidence: 'Generic flow strategy was adversely selected and negative.', score: { mechanismStrength: 0, persistence: 0, postCostDollarOpportunity: 0 } }),
    seed('M12', 'Generic symmetric two-sided maker', 'Continuously quote both sides around midpoint without an independent fair-value bound.', 'No defensible payer after toxicity and inventory costs.', { decision: DECISIONS.REJECTED_EXISTING_EVIDENCE, existingEvidence: 'Generic making controls are strongly negative.', score: { mechanismStrength: 0, boundedRisk: 1, postCostDollarOpportunity: 0 } }),
  ],
  portfolio: [
    seed('P01', 'Prequential strategy allocator', 'Allocate the next independent unit among already validated strategies using only lagged, embargoed features and a frozen rule.', 'Better capital utilization; it does not create gross alpha.', { decision: DECISIONS.COLLECT_ONLY, score: { mechanismStrength: 2, dataReadiness: 4 } }),
    seed('P02', 'Profit-per-dollar-hour allocator', 'Rank qualified opportunities by conservative expected dollars divided by venue-fragmented capital-hours.', 'Avoided opportunity cost from slow-settling positions.', { decision: DECISIONS.INCUBATE, score: { mechanismStrength: 4, dataReadiness: 4, simplicity: 4 } }),
    seed('P03', 'Correlated exposure budget', 'Net binary, asset, resolver and event-family exposures so apparently distinct bots cannot multiply the same risk.', 'Reduced concentration loss; no external payer.', { decision: DECISIONS.INCUBATE, score: { boundedRisk: 5, simplicity: 4 } }),
    seed('P04', 'Frozen drawdown kill protocol', 'Stop a strategy only at a pre-registered evidence boundary rather than arbitrary imaginary daily loss rails.', 'Research integrity rather than alpha.', { decision: DECISIONS.INCUBATE, score: { mechanismStrength: 1, boundedRisk: 5 } }),
    seed('P05', 'Contextual bandit experiment router', 'Assign future independent markets to frozen strategy arms with explicit exploration probability and propensity logging.', 'Efficient learning allocation, not direct market profit.', { decision: DECISIONS.COLLECT_ONLY, score: { simplicity: 1, leakageSelectionRisks: 'Adaptive allocation requires inverse-propensity analysis and cannot change arm definitions.' } }),
    seed('P06', 'AI anomaly triage queue', 'Rank scanner candidates for human review by uncertainty and potential dollar economics without changing deterministic admissibility.', 'Reduced manual research cost.', { decision: DECISIONS.INCUBATE, score: { mechanismStrength: 4, dataReadiness: 4, boundedRisk: 5 } }),
    seed('P07', 'Recent winning-streak switcher', 'Turn on whichever shadow strategy has most recently won.', 'No durable payer; streak selection is a multiple-testing artifact.', { decision: DECISIONS.REJECTED_MECHANISM, existingEvidence: 'Recent-strategy chasing was requested previously but cannot turn noise into alpha.', score: { mechanismStrength: 0, persistence: 0, independence: 0, postCostDollarOpportunity: 0 } }),
  ],
});

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`invalid score ${value}`);
  return Math.max(0, Math.min(5, number));
}

function scoreHypothesis(scores) {
  const breakdown = {};
  let total = 0;
  for (const [criterion, weight] of Object.entries(RUBRIC)) {
    const raw = clampScore(scores[criterion]);
    const points = raw / 5 * weight;
    breakdown[criterion] = { raw, weight, points: +points.toFixed(2) };
    total += points;
  }
  return { total: +total.toFixed(2), breakdown };
}

function buildHypotheses() {
  const hypotheses = [];
  for (const [family, seeds] of Object.entries(FAMILY_SEEDS)) {
    const profile = FAMILY_PROFILES[family];
    for (const item of seeds) {
      const scoreInputs = { ...profile.baseScore, ...(item.score || {}) };
      const scored = scoreHypothesis(scoreInputs);
      const hypothesis = {
        id: item.id,
        family,
        familyLabel: profile.label,
        title: item.title,
        decision: item.decision || DECISIONS.CHEAP_FALSIFICATION,
        economicMechanism: item.economicMechanism,
        whoPays: item.whoPays,
        persistence: item.persistence || profile.persistence,
        capacityAndHalfLife: item.capacityAndHalfLife || profile.capacityAndHalfLife,
        requiredData: item.requiredData || profile.requiredData,
        dataReadiness: item.dataReadiness || profile.dataReadiness,
        executionPath: item.executionPath || profile.executionPath,
        latencySensitivity: item.latencySensitivity || profile.latencySensitivity,
        costModel: item.costModel || profile.costModel,
        legalTermsDependency: item.legalTermsDependency || profile.legalTermsDependency,
        cheapestFalsification: item.cheapestFalsification || `Run a bounded causal replay/scanner over the existing ${profile.label.toLowerCase()} data; reject if no positive doubled-cost lower-bound episode exists.`,
        independentUnit: item.independentUnit || profile.independentUnit,
        leakageSelectionRisks: item.leakageSelectionRisks || profile.leakageSelectionRisks,
        infrastructure: item.infrastructure || profile.infrastructure,
        testTimeAndDisk: item.testTimeAndDisk || profile.testTimeAndDisk,
        notStaleReason: item.notStaleReason || profile.notStaleReason,
        existingEvidence: item.existingEvidence || 'No DeltaForge result yet; mechanism prior only.',
        sources: item.sources || profile.sources,
        score: scored,
      };
      hypotheses.push(hypothesis);
    }
  }
  validateHypotheses(hypotheses);
  return hypotheses.sort((left, right) => right.score.total - left.score.total || left.id.localeCompare(right.id));
}

function validateHypotheses(hypotheses) {
  if (hypotheses.length < 100) throw new Error(`at least 100 hypotheses required; found ${hypotheses.length}`);
  const ids = new Set();
  const required = [
    'economicMechanism', 'whoPays', 'persistence', 'capacityAndHalfLife',
    'requiredData', 'dataReadiness', 'executionPath', 'latencySensitivity',
    'costModel', 'legalTermsDependency', 'cheapestFalsification',
    'independentUnit', 'leakageSelectionRisks', 'infrastructure',
    'testTimeAndDisk', 'notStaleReason', 'existingEvidence',
  ];
  for (const hypothesis of hypotheses) {
    if (ids.has(hypothesis.id)) throw new Error(`duplicate hypothesis id ${hypothesis.id}`);
    ids.add(hypothesis.id);
    for (const field of required) {
      const value = hypothesis[field];
      if (value == null || value === '' || (Array.isArray(value) && !value.length)) {
        throw new Error(`${hypothesis.id}: ${field} is required`);
      }
    }
    for (const source of hypothesis.sources) {
      if (!SOURCE_REGISTRY[source]) throw new Error(`${hypothesis.id}: unknown source ${source}`);
    }
  }
  return true;
}

function selectionEligible(hypothesis) {
  return ![
    DECISIONS.REJECTED_EXISTING_EVIDENCE,
    DECISIONS.REJECTED_MECHANISM,
    DECISIONS.BLOCKED_DATA,
  ].includes(hypothesis.decision);
}

function topCandidates(hypotheses, limit = 10) {
  const selected = [];
  const familyCounts = new Map();
  for (const hypothesis of hypotheses) {
    if (!selectionEligible(hypothesis)) continue;
    const count = familyCounts.get(hypothesis.family) || 0;
    if (count >= 2) continue;
    selected.push(hypothesis);
    familyCounts.set(hypothesis.family, count + 1);
    if (selected.length >= limit) break;
  }
  return selected;
}

function markdownTable(headers, rows) {
  const clean = (value) => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
  return [
    `| ${headers.map(clean).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(clean).join(' | ')} |`),
  ].join('\n');
}

function renderMechanismMap(hypotheses, options = {}) {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const top = topCandidates(hypotheses, 10);
  const familyCounts = Object.entries(FAMILY_PROFILES).map(([family, profile]) => [
    profile.label,
    hypotheses.filter((row) => row.family === family).length,
  ]);
  const lines = [
    '# DeltaForge edge mechanism map',
    '',
    `Generated: ${generatedAt}. Research/venue mechanics reviewed through ${RESEARCH_AS_OF}.`,
    '',
    'This registry contains economic hypotheses, not claimed edges. Scores allocate research effort; they are not backtest results. Known failed mechanisms remain visible so they cannot be relaunched under new names. All implementation is paper-only unless separately authorized after promotion.',
    '',
    '## Coverage',
    '',
    markdownTable(['Family', 'Distinct hypotheses'], familyCounts),
    '',
    `Total: **${hypotheses.length} materially distinct hypotheses**.`,
    '',
    '## Fixed 100-point rubric',
    '',
    markdownTable(['Criterion', 'Weight'], Object.entries(RUBRIC).map(([name, weight]) => [name, weight])),
    '',
    '## Highest-priority screen',
    '',
    'The diversity cap allows at most two rows per family. Data-blocked and already-rejected mechanisms cannot enter this list, regardless of raw score.',
    '',
    markdownTable(
      ['Rank', 'ID', 'Mechanism', 'Family', 'Decision', 'Score', 'Current evidence'],
      top.map((row, index) => [index + 1, row.id, row.title, row.familyLabel, row.decision, row.score.total, row.existingEvidence]),
    ),
    '',
    '## Full mechanism registry',
    '',
  ];
  for (const hypothesis of hypotheses) {
    lines.push(
      `### ${hypothesis.id} — ${hypothesis.title}`,
      '',
      `- Family: ${hypothesis.familyLabel}`,
      `- Decision: **${hypothesis.decision}**; research-priority score: **${hypothesis.score.total}/100**.`,
      `- Economic mechanism: ${hypothesis.economicMechanism}`,
      `- Who pays: ${hypothesis.whoPays}`,
      `- Why it may persist: ${hypothesis.persistence}`,
      `- Capacity and half-life: ${hypothesis.capacityAndHalfLife}`,
      `- Required data/readiness: ${hypothesis.requiredData.join('; ')}. ${hypothesis.dataReadiness}`,
      `- Execution/legs: ${hypothesis.executionPath}`,
      `- Latency: ${hypothesis.latencySensitivity}`,
      `- Full cost model: ${hypothesis.costModel}`,
      `- Legal/rule dependency: ${hypothesis.legalTermsDependency}`,
      `- Cheapest falsification: ${hypothesis.cheapestFalsification}`,
      `- Independent unit: ${hypothesis.independentUnit}`,
      `- Leakage/selection risk: ${hypothesis.leakageSelectionRisks}`,
      `- Infrastructure: ${hypothesis.infrastructure}`,
      `- Time/storage: ${hypothesis.testTimeAndDisk}`,
      `- Why this is not stale retail logic: ${hypothesis.notStaleReason}`,
      `- Existing evidence: ${hypothesis.existingEvidence}`,
      `- Source keys: ${hypothesis.sources.join(', ')}`,
      '',
    );
  }
  lines.push('## Primary sources', '');
  for (const [key, source] of Object.entries(SOURCE_REGISTRY)) {
    lines.push(`- ${key}: [${source.label}](${source.url}) (mechanics/research dated ${source.asOf}).`);
  }
  lines.push('');
  return lines.join('\n');
}

const HYPOTHESES = Object.freeze(buildHypotheses());

module.exports = {
  DECISIONS,
  FAMILY_PROFILES,
  HYPOTHESES,
  RESEARCH_AS_OF,
  RUBRIC,
  SOURCE_REGISTRY,
  buildHypotheses,
  renderMechanismMap,
  scoreHypothesis,
  selectionEligible,
  topCandidates,
  validateHypotheses,
};
