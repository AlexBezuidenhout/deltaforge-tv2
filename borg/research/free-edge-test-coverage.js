'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STATUSES = Object.freeze({
  SCREENED_NEGATIVE: 'SCREENED_NEGATIVE',
  SCREENED_ZERO_UNIT: 'SCREENED_ZERO_UNIT',
  PROMISING_UNVALIDATED: 'PROMISING_UNVALIDATED',
  FORWARD_COLLECTING: 'FORWARD_COLLECTING',
  BLOCKED_CURRENT_DATA: 'BLOCKED_CURRENT_DATA',
  FREE_COLLECTOR_REQUIRED: 'FREE_COLLECTOR_REQUIRED',
  REJECTED_MECHANISM: 'REJECTED_MECHANISM',
  NON_ALPHA_INFRASTRUCTURE: 'NON_ALPHA_INFRASTRUCTURE',
});

const EVIDENCE = Object.freeze({
  structuralLead: 'Fresh V34 scanner: one five-leg complete-set relationship produced one approximately 1.2-second orphan-safe episode; maximum displayed 2x profit $1.1245 on $9.9355, maximum after full orphan reserve $0.1365. One expired event and one day; not promotion evidence.',
  orderedStrike: 'Ordered-strike V1: 34 independent candidates per latency arm over two days; zero arithmetic-economic or orphan-safe qualified observations. Passive arm: 247 quotes, 187 closed, zero simulated fills.',
  structuralZero: 'Current same-event condition graph and synchronized depth scanner produced no independent orphan-safe unit for this relation family after proof, rule, 2x-fee, depth and orphan gates.',
  semanticZero: 'Semantic proposer scanned 23,041 rule rows and 21,910 typed nodes, proposed 1,224 abstract relations, but produced zero cross-event proposals, zero deterministic rule certifications and zero executable units.',
  duplicateZero: '309,605 structural rule snapshots contained 309,605 distinct content-addressed rule hashes; no exact hash duplicate across condition IDs. Canonical semantic duplicate detection remains a separate prerequisite.',
  resolverNegative: 'Current H43-X forward cohort is negative after doubled costs: 45 independent markets, approximately -$24.99 in the broad current audit; the stricter V34 read was also negative in both chronological halves. No multiple-testing-adjusted edge.',
  resolverPrecision: 'Resolver precision audit scanned 72,123 relevant rule documents: zero machine-certified terminal-tick semantics, zero statewise episodes and zero executable capacity.',
  pythCollecting: 'Pyth/Hermes collector is connected and preserves exact feed ticks, but no current in-window independent market cohort can establish post-cost edge. Continue source-specific paper collection only.',
  crossExactZero: 'Exact-rule Polymarket/Kalshi V7: zero complete exact-rule entries, zero pair-direction-days and zero realized PnL. Unknown or mismatched rules are hard vetoes.',
  crossTerminalFail: 'Terminal-carry V2: four settled entries over three days; +$1.09 at doubled fees but -$21.05 at the full hurdle, opposite-sign chronological halves, lower confidence bound far below zero and 95% positive-cluster concentration.',
  optionsZero: 'Current surface lane: 1,524 listed BTC/ETH option instruments in the live free-source probe, 36 fetched threshold markets and zero exact-expiry rule-certified targets. Runtime has zero executable marks; interpolation remains diagnostic.',
  mainNegative: 'Current MAIN longshot successor and broad probability models do not beat executable market prices after cost. The fresh successor is negative overall and the market quote remains the stronger calibration baseline.',
  broadPredictionNegative: 'Existing market/day-level profitability and calibration audits show no stable doubled-cost residual across current directional, favorite/longshot, time-state or local-volatility families after forward and multiplicity controls.',
  xtrackerCollecting: 'XTracker historical screen: 36 windows, 2,807 posts and 210 priced irreversible boundaries; one +$0.13 stressed midpoint proxy without historical depth, aggregate diagnostic -$20.96. Forward L2 paper collector is healthy; zero intents so far.',
  cexLeadLagNegative: 'Free Binance causal screens: contemporaneous crypto correlation is high but lag correlation is near zero. The exact lead/lag rules barely fire; the 180-day hourly C05 test produced one losing BTC->ETH episode and C06 produced zero episodes.',
  cexResidualNegative: 'Free Binance 180-day common-factor residual replay: SOL 85 signals, -$144.17 doubled-cost PnL; XRP 69 signals, -$44.31, both chronological halves negative at a $500 bankroll.',
  fundingNegative: 'Free Binance/Hyperliquid 180-day funding-dispersion replay at $500: causal walk-forward BTC -$11.78, ETH +$0.21 before stress but -$8.01 stressed, SOL -$11.44. Funding-only HYPE carry is a low-dollar diagnostic, not synchronized basis proof.',
  fundingRegimeNegative: 'Free Binance 180-day extreme-funding momentum/reversal replay: every populated asset arm fails doubled-cost/both-halves criteria; the only positive line is SOL momentum +$0.50 over four signals with a negative second half and wide interval.',
  sessionNoTrade: 'Fixed 00/08/16 UTC handoffs show small mean hourly returns, all materially below the frozen 24 bp round-trip cost and without a pre-registered directional payer. No executable alpha is established.',
  makingNegative: 'Generic public-flow, paired complete-set making and symmetric making controls are materially negative from adverse selection. Current fair-bound lane is capture-only with zero decisions/fills because no independent fair interval exists.',
  blocked: 'The required causal source, exact contract mapping, synchronized executable books or authenticated execution state is absent. A backtest now would substitute a proxy and fabricate fidelity.',
  freeCollector: 'The public source is free and technically collectible, but TV2 lacks a causal source-to-rule-to-pre-event-book history. Build a bounded source collector and exact mapper before any PnL test.',
  rejected: 'Rejected at mechanism review or by existing negative-control evidence; renaming, inverting or parameter-mining it is not a new economic mechanism.',
  infrastructure: 'This improves search, allocation or research governance but has no external payer and cannot create gross alpha before a base strategy is validated.',
});

function registry(repoRoot) {
  const file = path.join(repoRoot, 'EDGE_MECHANISM_MAP.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')).hypotheses;
}

function buildAssignments() {
  const rows = new Map();
  const add = (ids, status, screen, evidence, nextAction) => {
    for (const id of ids.split(/\s+/).filter(Boolean)) {
      if (rows.has(id)) throw new Error(`duplicate free-test assignment ${id}`);
      rows.set(id, { status, screen, evidence, nextAction });
    }
  };

  add('S01', STATUSES.PROMISING_UNVALIDATED, 'certified payoff graph', EVIDENCE.structuralLead,
    'Keep the deterministic scanner running; require new events, synchronized FOK feasibility and authenticated tiny execution only after repeated orphan-safe episodes.');
  add('S03 S04', STATUSES.SCREENED_NEGATIVE, 'ordered-strike orphan-safe replay', EVIDENCE.orderedStrike,
    'Do not relax proof/cost/orphan gates; await genuinely new ordered-strike markets.');
  add('S02 S05 S07 S11 S12 S13 S14 S15', STATUSES.SCREENED_ZERO_UNIT,
    'same-event condition graph', EVIDENCE.structuralZero,
    'Continue deterministic scanning; zero current units is a valid result.');
  add('S06 S08 S09 S10 S16', STATUSES.SCREENED_ZERO_UNIT,
    'cross-event semantic prerequisite', EVIDENCE.semanticZero,
    'Build canonical cross-event predicates before economics; AI proposals cannot bypass proof.');
  add('S17', STATUSES.SCREENED_ZERO_UNIT, 'duplicate rule-hash prerequisite', EVIDENCE.duplicateZero,
    'Add canonical predicate hashing that excludes venue/event identifiers, then rerun.');
  add('S18', STATUSES.BLOCKED_CURRENT_DATA, 'rule-risk premium', EVIDENCE.blocked,
    'First define a causal ambiguity label and settlement-loss model; do not price ambiguity from hindsight.');

  add('R01', STATUSES.FORWARD_COLLECTING, 'H43-X resolver boundary', EVIDENCE.resolverNegative,
    'Preserve the frozen rule to its decision boundary; do not retune the negative cohort.');
  add('R07 R08 R10', STATUSES.SCREENED_ZERO_UNIT, 'resolver rule certification', EVIDENCE.resolverPrecision,
    'Collect explicit source precision, cutoff inclusivity, fallback and terminal-tick semantics; fail closed.');
  add('R02 R04 R05 R06', STATUSES.FORWARD_COLLECTING, 'resolver source collectors', EVIDENCE.pythCollecting,
    'Accrue independent resolver windows; score only exact source-mapped A/B executable books.');
  add('R03 R09', STATUSES.BLOCKED_CURRENT_DATA, 'resolver source coverage', EVIDENCE.blocked,
    'Obtain the exact CF/multi-source feed and rule mapping before replay.');

  add('X01 X02 X12', STATUSES.SCREENED_ZERO_UNIT, 'exact-rule cross-venue identity', EVIDENCE.crossExactZero,
    'Continue exact normalization and hard mismatch veto; do not trade text similarity.');
  add('X03 X07 X13', STATUSES.SCREENED_NEGATIVE, 'risky convergence/terminal carry', EVIDENCE.crossTerminalFail,
    'Retain as negative/rule-risk controls; new tests require a distinct certified mapping mechanism.');
  add('X04 X05 X14', STATUSES.FORWARD_COLLECTING, 'synchronized cross-venue basis capture', EVIDENCE.crossExactZero,
    'Accrue complete typed pairs and right-censored basis half-lives; no eligible pair exists now.');
  add('X06 X08 X09 X10 X11', STATUSES.BLOCKED_CURRENT_DATA, 'cross-venue execution prerequisites', EVIDENCE.blocked,
    'Add the missing synchronized venue/RFQ/bookmaker tape and exact settlement identity.');

  add('O01 O02 O03 O04 O05 O08 O10 O11 O12', STATUSES.SCREENED_ZERO_UNIT,
    'exact-expiry options prerequisite', EVIDENCE.optionsZero,
    'Keep surface collection; no signal can be scored until an exact-expiry A/B target exists.');
  add('O06 O07 O09', STATUSES.BLOCKED_CURRENT_DATA, 'options hedge/reference prerequisite', EVIDENCE.blocked,
    'Acquire the exact event-volatility, variance or joint-distribution inputs and executable hedge tape.');

  add('Q01 Q03 Q04 Q07', STATUSES.SCREENED_NEGATIVE, 'prediction calibration/profitability audit', EVIDENCE.broadPredictionNegative,
    'Do not mine categories, price buckets or time bands on the same outcomes.');
  add('Q02', STATUSES.FORWARD_COLLECTING, 'frozen MAIN longshot successor', EVIDENCE.mainNegative,
    'Continue unchanged only as a negative-control forward read; current PnL does not justify promotion.');
  add('Q05 Q06', STATUSES.BLOCKED_CURRENT_DATA, 'source/rule-conditioned residual', EVIDENCE.blocked,
    'Require a causal official source or pre-registered ambiguity label linked to pre-event executable books.');
  add('Q08', STATUSES.REJECTED_MECHANISM, 'wallet imitation review', EVIDENCE.rejected,
    'Wallet behavior may propose mechanisms, but cannot be copied as a causal signal.');

  add('C02', STATUSES.SCREENED_NEGATIVE, 'cross-venue funding replay', EVIDENCE.fundingNegative,
    'Continue low-cost funding collection; do not deploy without synchronized basis and positive stressed economics.');
  add('C05 C06 C08', STATUSES.SCREENED_NEGATIVE, 'causal crypto lead/lag', EVIDENCE.cexLeadLagNegative,
    'Reject generic lag; a new test needs a distinct observable transmission mechanism.');
  add('C07', STATUSES.SCREENED_NEGATIVE, 'common-factor residual mean reversion', EVIDENCE.cexResidualNegative,
    'Retain as a negative control; do not optimize the z-score or horizon on this output.');
  add('C10 C11', STATUSES.SCREENED_NEGATIVE, 'extreme-funding regime replay', EVIDENCE.fundingRegimeNegative,
    'No forward arm is justified; do not select the four-signal SOL line.');
  add('C12', STATUSES.SCREENED_ZERO_UNIT, 'fixed UTC session handoff', EVIDENCE.sessionNoTrade,
    'A future test must identify a payer and executable direction before registration.');
  add('C01 C03 C04 C13 C14', STATUSES.BLOCKED_CURRENT_DATA, 'CEX execution/basis prerequisite', EVIDENCE.blocked,
    'Capture synchronized pre-funded books, basis/index state and real venue costs first.');
  add('C09', STATUSES.FREE_COLLECTOR_REQUIRED, 'liquidation/depletion source', EVIDENCE.freeCollector,
    'Add a bounded public liquidation plus full-depth transition collector; no historical fill claim.');
  add('C15', STATUSES.REJECTED_MECHANISM, 'generic momentum negative control', EVIDENCE.rejected,
    'Keep as negative control.');

  add('N01', STATUSES.FORWARD_COLLECTING, 'XTracker resolver-state lane', EVIDENCE.xtrackerCollecting,
    'Continue rare-tail L2 paper collection; direct Truth Social automation remains prohibited.');
  add('N02 N03 N05 N06 N08', STATUSES.FREE_COLLECTOR_REQUIRED, 'official public event source', EVIDENCE.freeCollector,
    'Build only bounded official-source collectors with exact active-contract mapping and pre-event books.');
  add('N04 N07', STATUSES.BLOCKED_CURRENT_DATA, 'licensed/calibrated event model', EVIDENCE.blocked,
    'Official facts alone do not price an outcome; require sport/company-specific calibrated models and source rights.');
  add('N09', STATUSES.SCREENED_ZERO_UNIT, 'semantic relationship proposer', EVIDENCE.semanticZero,
    'Improve canonical predicates and human review, while retaining deterministic veto.');
  add('N10', STATUSES.REJECTED_MECHANISM, 'self-modifying strategy review', EVIDENCE.rejected,
    'AI may propose new frozen hypotheses, never mutate an active policy from recent PnL.');

  add('M01 M02 M03 M05 M08 M09 M10', STATUSES.FORWARD_COLLECTING,
    'fair-bound/passive capture prerequisite', EVIDENCE.makingNegative,
    'Keep capture-only until an independent fair lower bound exists; public prints are not authenticated fills.');
  add('M06 M07', STATUSES.BLOCKED_CURRENT_DATA, 'authenticated queue/cancel prerequisite', EVIDENCE.blocked,
    'Obtain tiny authenticated paper/live-canary queue and cancel evidence only after a fair-bound strategy qualifies.');
  add('M04 M11 M12', STATUSES.SCREENED_NEGATIVE, 'making/flow negative controls', EVIDENCE.makingNegative,
    'Do not invert or rename these controls.');

  add('D01 D02 D03 D04 D05 D06 D07 D08 D09 D10', STATUSES.BLOCKED_CURRENT_DATA,
    'on-chain causal execution prerequisite', EVIDENCE.blocked,
    'Do not backtest from end-of-block reserves; add bounded state-root, gas/tip, landing and competitor data first.');
  add('D11 D12', STATUSES.REJECTED_MECHANISM, 'DEX mechanism review', EVIDENCE.rejected,
    'Do not build prohibited transaction ordering or stale REST-reserve polling.');

  add('P01 P02 P03 P04 P05 P06', STATUSES.NON_ALPHA_INFRASTRUCTURE,
    'portfolio/research-control review', EVIDENCE.infrastructure,
    'Use only after a base strategy passes; measure research efficiency separately from trading PnL.');
  add('P07', STATUSES.REJECTED_MECHANISM, 'winning-streak allocator review', EVIDENCE.rejected,
    'Do not chase recent winners.');
  return rows;
}

function buildCoverage(repoRoot) {
  const hypotheses = registry(repoRoot);
  const assignments = buildAssignments();
  const missing = hypotheses.filter((row) => !assignments.has(row.id)).map((row) => row.id);
  const unknown = [...assignments.keys()].filter((id) => !hypotheses.some((row) => row.id === id));
  if (missing.length || unknown.length) {
    throw new Error(`free-test coverage mismatch; missing=${missing.join(',')} unknown=${unknown.join(',')}`);
  }
  const rows = hypotheses.map((hypothesis) => ({ ...hypothesis, ...assignments.get(hypothesis.id) }));
  const statusCounts = Object.fromEntries(Object.values(STATUSES).map((status) => [status,
    rows.filter((row) => row.status === status).length]));
  return {
    format: 'deltaforge-free-edge-test-coverage-v1',
    generatedAt: new Date().toISOString(),
    evidenceAsOf: '2026-08-05T16:43:04Z',
    hypothesisCount: rows.length,
    statusCounts,
    rows,
  };
}

module.exports = { EVIDENCE, STATUSES, buildAssignments, buildCoverage };
