'use strict';

/**
 * Expanded cross-event soccer payoff graph.
 *
 * An exact score deterministically fixes match result and BTTS, and sometimes
 * fixes first scorer. We buy NO on that exact-score predicate plus the token
 * representing the implied state. This has a completed-match payout floor of
 * one share. Cancellation is an explicit extra terminal state; no relation is
 * certified when its cancellation floor, resolver policy, scope, fixture id,
 * or settlement timestamp differs.
 */

const crypto = require('node:crypto');
const { compileExplicitPayoffProof } = require('../research/payoff-proof');
const { leg, normalizedMarket } = require('./condition-graph');
const { canonical, normalizeRuleText, sha256 } = require('./rule-certifier');
const {
  physicalFixtureId, resolutionPolicy,
} = require('./physical-event-graph');

const PHYSICAL_GRAPH_V2_UNIVERSE = 'sports-physical-payoff-graph-v2';
const PHYSICAL_GRAPH_V2_CERTIFICATION = 'sports-physical-rule-certification-v2';
const STRUCTURE_TYPES = Object.freeze({
  MATCH_RESULT: 'sports_exact_score_match_result_floor',
  BTTS: 'sports_exact_score_btts_floor',
  FIRST_SCORER: 'sports_exact_score_first_scorer_floor',
});

function semanticText(value) {
  return normalizeRuleText(value).replace(/\bfc\b/g, '').replace(/\s+/g, ' ').trim();
}

function eventParticipants(events) {
  for (const event of events) {
    const base = String(event?.title || '').split(/\s+-\s+/)[0];
    const sides = base.split(/\s+vs\.?\s+/i).map((value) => value.trim()).filter(Boolean);
    if (sides.length === 2) return {
      home: sides[0], away: sides[1],
      homeKey: semanticText(sides[0]), awayKey: semanticText(sides[1]),
    };
  }
  return null;
}

function scopePolicy(text) {
  const value = normalizeRuleText(text);
  const regulation = /\b90 minutes?\b/.test(value) && /\bstoppage time\b/.test(value);
  const excludesExtra = /\bextra time.*excluded\b/.test(value)
    || /\bonly.*(?:first )?90 minutes?.*stoppage time\b/.test(value);
  return regulation && excludesExtra ? 'SOCCER_90M_PLUS_STOPPAGE_EX_ET_PENS' : null;
}

function postponePolicy(text) {
  return /postponed.*remain open until.*completed/.test(normalizeRuleText(text))
    ? 'REMAIN_OPEN_UNTIL_COMPLETED' : null;
}

function settlement(yes) { return { YES: yes ? 1 : 0, NO: yes ? 0 : 1 }; }

function cancellationSettlement(kind, data, text) {
  const value = normalizeRuleText(text);
  if (!/cancel(?:ed|led)(?: entirely)?.*no make-up (?:game|match)/.test(value)) return null;
  if (kind === 'EXACT_SCORE') {
    if (!/resolv(?:e|es|ed).*0-0/.test(value)) return null;
    return settlement(data.homeGoals === 0 && data.awayGoals === 0);
  }
  if (kind === 'BTTS') {
    return /resolv(?:e|es|ed).*50(?:-|\s)50/.test(value)
      ? { YES: 0.5, NO: 0.5 } : null;
  }
  if (kind === 'FIRST_SCORER') {
    if (!/resolv(?:e|es|ed) to neither/.test(value)) return null;
    return settlement(data.role === 'NEITHER');
  }
  if (kind === 'MATCH_RESULT') {
    const expected = data.role === 'DRAW' ? 'yes' : 'no';
    return new RegExp(`resolv(?:e|es|ed)(?: to)? ${expected}`).test(value)
      ? settlement(data.role === 'DRAW') : null;
  }
  return null;
}

function scoreFromSlug(slug) {
  const match = /-exact-score-(\d+)-(\d+)$/.exec(String(slug || '').toLowerCase());
  return match ? { homeGoals: parseInt(match[1], 10), awayGoals: parseInt(match[2], 10) } : null;
}

function semanticFor(event, market, participants) {
  const slug = String(market?.slug || '').toLowerCase();
  const text = [market?.description, event?.description].filter(Boolean).join(' ');
  const base = normalizedMarket(event, market);
  if (!base?.accepting || !base.literalYesNo || !participants) return null;
  let kind; let data;
  const score = scoreFromSlug(slug);
  const first = /-first-to-score-(home|away|neither)$/.exec(slug)?.[1];
  if (score) {
    kind = 'EXACT_SCORE'; data = score;
  } else if (first) {
    kind = 'FIRST_SCORER'; data = { role: first.toUpperCase() };
  } else if (/-btts$/.test(slug)
      && /both teams to score/i.test(`${market?.question || ''} ${market?.groupItemTitle || ''}`)) {
    kind = 'BTTS'; data = {};
  } else {
    const label = semanticText(market?.groupItemTitle || '');
    const normalized = normalizeRuleText(text);
    if (/if the game ends in a draw.*resolve(?:s|d)? to yes/.test(normalized)
        && /draw/.test(label)) {
      kind = 'MATCH_RESULT'; data = { role: 'DRAW' };
    } else if (label && label === participants.homeKey
        && /if .* wins.*resolve(?:s|d)? to yes/.test(normalized)) {
      kind = 'MATCH_RESULT'; data = { role: 'HOME' };
    } else if (label && label === participants.awayKey
        && /if .* wins.*resolve(?:s|d)? to yes/.test(normalized)) {
      kind = 'MATCH_RESULT'; data = { role: 'AWAY' };
    } else return null;
  }
  const semantic = {
    kind, ...data, fixtureId: physicalFixtureId(event),
    scope: scopePolicy(text), postponement: postponePolicy(text),
    resolutionPolicy: resolutionPolicy(text),
  };
  semantic.cancellation = cancellationSettlement(kind, data, text);
  const ruleDocument = JSON.parse(JSON.stringify(base.ruleDocument));
  ruleDocument.schema = 'polymarket-physical-rule-document-v2';
  ruleDocument.event.physicalFixtureId = semantic.fixtureId;
  ruleDocument.market.physicalSemantic = semantic;
  return {
    ...base, physicalFixtureId: semantic.fixtureId, physicalSemantic: semantic,
    ruleDocument, ruleHash: sha256(ruleDocument),
  };
}

function impliedTruth(score, target) {
  const { homeGoals: home, awayGoals: away } = score.physicalSemantic;
  const semantic = target.physicalSemantic;
  if (semantic.kind === 'MATCH_RESULT') {
    const role = home > away ? 'HOME' : home < away ? 'AWAY' : 'DRAW';
    return semantic.role === role;
  }
  if (semantic.kind === 'BTTS') return home > 0 && away > 0;
  if (semantic.kind === 'FIRST_SCORER') {
    if (home === 0 && away === 0) return semantic.role === 'NEITHER';
    if (home > 0 && away === 0) return semantic.role === 'HOME';
    if (away > 0 && home === 0) return semantic.role === 'AWAY';
    // If both teams score, only the proposition "Neither scores first" is
    // logically false; which team scored first is not encoded by final score.
    return semantic.role === 'NEITHER' ? false : null;
  }
  return null;
}

function sameEnd(markets) {
  const values = markets.map((market) => Date.parse(market.endDate));
  return values.every(Number.isFinite) && new Set(values).size === 1;
}

function certify(fixtureId, markets, proof, structureType) {
  const checks = [];
  if (!proof?.valid || !proof?.proofHash || proof.guaranteedMinPayout < 1) {
    checks.push('INVALID_WORST_STATE_PAYOFF_FLOOR');
  }
  if (markets.length !== 2 || markets.some((market) => !market.ruleHash
      || !market.conditionId || !market.gammaId)) checks.push('MISSING_RULE_OR_MARKET_IDENTITY');
  if (!fixtureId || markets.some((market) => market.physicalFixtureId !== fixtureId)) {
    checks.push('MIXED_PHYSICAL_FIXTURE');
  }
  if (!sameEnd(markets)) checks.push('MIXED_SETTLEMENT_TIME');
  if (markets.some((market) => !market.physicalSemantic.scope)
      || new Set(markets.map((market) => market.physicalSemantic.scope)).size !== 1) {
    checks.push('MIXED_MATCH_SCOPE');
  }
  if (markets.some((market) => !market.physicalSemantic.cancellation)) {
    checks.push('UNSUPPORTED_CANCELLATION_SETTLEMENT');
  }
  if (markets.some((market) =>
    market.physicalSemantic.postponement !== 'REMAIN_OPEN_UNTIL_COMPLETED')) {
    checks.push('MIXED_POSTPONEMENT_POLICY');
  }
  const policies = markets.map((market) => market.physicalSemantic.resolutionPolicy);
  if (!policies.every((policy) => policy?.primaryOfficialStatistics
      && policy?.consensusFallback && policy?.finalResultRecognized
      && policy?.revisionsIgnored && policy?.fallbackHours != null)
      || new Set(policies.map(canonical)).size !== 1) checks.push('MIXED_RESOLUTION_POLICY');
  const body = {
    version: PHYSICAL_GRAPH_V2_CERTIFICATION, relationType: structureType,
    fixtureId, relationAst: {
      operator: 'EXACT_SCORE_IMPLIES_TYPED_FIXTURE_STATE',
      predicates: markets.map((market) => ({
        id: market.gammaId, semantic: market.physicalSemantic,
      })),
    },
    payoffProofHash: proof?.proofHash || null,
    marketRuleHashes: markets.map((market) => market.ruleHash).sort(),
    checks: [...new Set(checks)].sort(),
  };
  return { ...body, valid: body.checks.length === 0, certificationHash: sha256(body) };
}

function structureType(target) {
  return target.physicalSemantic.kind === 'MATCH_RESULT' ? STRUCTURE_TYPES.MATCH_RESULT
    : target.physicalSemantic.kind === 'BTTS' ? STRUCTURE_TYPES.BTTS
      : STRUCTURE_TYPES.FIRST_SCORER;
}

function candidateId(fixtureId, legs, certificationHash) {
  const identity = `${PHYSICAL_GRAPH_V2_UNIVERSE}|${fixtureId}|${certificationHash}|${legs
    .map((entry) => `${entry.gammaId}:${entry.outcome}`).sort().join('|')}`;
  return `sp2_${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
}

function makeImplication(fixtureId, score, target, targetTruth) {
  const targetOutcome = targetTruth ? 'YES' : 'NO';
  const legs = [leg(score, 'NO'), leg(target, targetOutcome)];
  legs[0].semantic = score.physicalSemantic; legs[1].semantic = target.physicalSemantic;
  const normal = (truth) => settlement(truth);
  const proof = compileExplicitPayoffProof({
    variables: [score.gammaId, target.gammaId], legs,
    terminalStates: [
      { label: 'COMPLETED_EXACT_SCORE', outcomePayouts: {
        [score.gammaId]: normal(true), [target.gammaId]: normal(targetTruth),
      } },
      { label: 'COMPLETED_OTHER_SCORE_IMPLIED_STATE', outcomePayouts: {
        [score.gammaId]: normal(false), [target.gammaId]: normal(targetTruth),
      } },
      { label: 'COMPLETED_OTHER_SCORE_OPPOSITE_STATE', outcomePayouts: {
        [score.gammaId]: normal(false), [target.gammaId]: normal(!targetTruth),
      } },
      { label: 'CANCELLED_NO_MAKEUP', outcomePayouts: {
        [score.gammaId]: score.physicalSemantic.cancellation || normal(false),
        [target.gammaId]: target.physicalSemantic.cancellation || { YES: 0.5, NO: 0.5 },
      } },
    ],
  });
  const type = structureType(target); const markets = [score, target];
  const certification = certify(fixtureId, markets, proof, type);
  return {
    candidateId: candidateId(fixtureId, legs, certification.certificationHash),
    structureType: type, eventId: `fixture:${fixtureId}`, eventSlug: null,
    eventTitle: String(score.eventTitle || target.eventTitle || `Sports fixture ${fixtureId}`)
      .replace(/\s+-\s+(?:Exact Score|First Team to Score|More Markets).*$/i, ''),
    endDate: score.endDate, complete: true,
    states: proof.terminalStates.map((state) => state.label),
    payoffVector: proof.payoffVector, guaranteedMinPayout: proof.guaranteedMinPayout,
    payoffProof: { ...proof, ruleCertification: certification },
    ruleCertification: certification,
    ruleDocuments: markets.map((market) => ({
      ruleHash: market.ruleHash, eventId: market.eventId, gammaId: market.gammaId,
      conditionId: market.conditionId, document: market.ruleDocument,
    })),
    atomic: false, universeId: PHYSICAL_GRAPH_V2_UNIVERSE,
    universeClass: 'sports', legs,
  };
}

function buildExpandedPhysicalCandidates(events) {
  const eventGroups = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const fixtureId = physicalFixtureId(event);
    if (!fixtureId) continue;
    const rows = eventGroups.get(fixtureId) || [];
    rows.push(event); eventGroups.set(fixtureId, rows);
  }
  const candidates = [];
  for (const [fixtureId, fixtureEvents] of eventGroups) {
    const participants = eventParticipants(fixtureEvents);
    const markets = fixtureEvents.flatMap((event) => (event.markets || [])
      .map((market) => semanticFor(event, market, participants)).filter(Boolean));
    const scores = markets.filter((market) => market.physicalSemantic.kind === 'EXACT_SCORE');
    const targets = markets.filter((market) => market.physicalSemantic.kind !== 'EXACT_SCORE');
    for (const score of scores) for (const target of targets) {
      const truth = impliedTruth(score, target);
      if (truth == null) continue;
      candidates.push(makeImplication(fixtureId, score, target, truth));
    }
  }
  return [...new Map(candidates.map((candidate) => [candidate.candidateId, candidate])).values()];
}

module.exports = {
  PHYSICAL_GRAPH_V2_CERTIFICATION, PHYSICAL_GRAPH_V2_UNIVERSE, STRUCTURE_TYPES,
  buildExpandedPhysicalCandidates, cancellationSettlement, eventParticipants,
  impliedTruth, scopePolicy, semanticFor,
};
