'use strict';

/**
 * Cross-Gamma-event sports payoff identities.
 *
 * Polymarket often represents one physical fixture as several Gamma events
 * (result, exact score, totals, etc.). Title matching is unsafe. This module
 * joins only on the venue fixture id and proves a narrow soccer identity with
 * explicit fractional cancellation payouts:
 *
 *   Exact score 0-0 YES + Total goals Over 0.5
 *
 * A completed match pays exactly 1 share across the two legs. Under the rule
 * template currently observed, cancellation with no make-up pays 1 on the
 * exact-score leg and 0.5 on the total leg. The worst-state payout is thus 1.
 * The scanner still applies live depth, current fee metadata, 2x-cost stress,
 * FOK capacity and non-atomic orphan reserve before qualification.
 */

const crypto = require('node:crypto');
const { compileExplicitPayoffProof } = require('../research/payoff-proof');
const { leg, normalizedMarket } = require('./condition-graph');
const { canonical, normalizeRuleText, sha256 } = require('./rule-certifier');

const PHYSICAL_SPORTS_UNIVERSE_VERSION = 'sports-physical-payoff-graph-v1';
const PHYSICAL_SPORTS_STRUCTURE_TYPE = 'sports_exact00_over05_floor';
const PHYSICAL_CERTIFICATION_VERSION = 'sports-physical-rule-certification-v1';

function physicalFixtureId(event) {
  const value = event?.eventMetadata?.opticOddsFixtureId
    ?? event?.eventMetadata?.gameId
    ?? event?.gameId
    ?? event?.game_id;
  return value == null || String(value).trim() === '' ? null : String(value);
}

function isSportsEvent(event) {
  return (event?.tags || []).some((tag) => String(tag?.id) === '1'
    || String(tag?.slug || '').toLowerCase() === 'sports');
}

function descriptionText(event, market) {
  return normalizeRuleText([market?.description, event?.description]
    .filter(Boolean).join(' '));
}

function fullTimeSoccerScope(text) {
  const scope = normalizeRuleText(text);
  const regulation = /\b90 minutes?\b/.test(scope)
    && /\bstoppage time\b/.test(scope)
    && (/\bextra time.*excluded\b/.test(scope)
      || /\bonly.*(?:first )?90 minutes?.*stoppage time\b/.test(scope));
  return regulation && /\b(?:score|goals?)\b/.test(scope)
    ? 'SOCCER_90M_PLUS_STOPPAGE_EX_ET_PENS' : null;
}

function resolutionPolicy(text) {
  const value = normalizeRuleText(text);
  const fallbackHours = Number(value.match(/within ([0-9]+) hours? after/)?.[1]);
  return {
    primaryOfficialStatistics: /primary resolution source.*official statistics/.test(value)
      && /governing body or event organizers/.test(value),
    consensusFallback: /consensus of credible reporting/.test(value),
    fallbackHours: Number.isFinite(fallbackHours) ? fallbackHours : null,
    finalResultRecognized: /official final (?:result|score).*governing body or event organizers/.test(value),
    revisionsIgnored: /revisions?.*after market resolution.*not be accounted/.test(value),
  };
}

function cancellationPolicy(text) {
  const value = normalizeRuleText(text);
  if (!/cancel(?:ed|led)(?: entirely)?/.test(value) || !/no make-up (?:game|match)/.test(value)) {
    return null;
  }
  if (/resolve(?:s|d)? (?:to )?50(?:[/-]|\s+)50/.test(value)) return 'FIFTY_FIFTY';
  if (/resolve(?:s|d)? (?:to )?0-0/.test(value)) return 'EXACT_SCORE_0_0';
  return null;
}

function postponementPolicy(text) {
  const value = normalizeRuleText(text);
  return /postponed.*remain open until.*completed/.test(value)
    ? 'REMAIN_OPEN_UNTIL_COMPLETED' : null;
}

function physicalSemantic(event, market, base) {
  if (!isSportsEvent(event)) return null;
  const fixtureId = physicalFixtureId(event);
  if (!fixtureId) return null;
  const question = `${event?.title || ''} ${market?.question || ''} ${market?.groupItemTitle || ''}`;
  const marketQuestion = String(market?.question || market?.groupItemTitle || '');
  const description = descriptionText(event, market);
  const scope = fullTimeSoccerScope(description);
  if (!scope) return null;

  let kind = null;
  if (/\bexact score\b/i.test(question) && /\b0\s*-\s*0\b/.test(question)
      && base.literalYesNo) {
    kind = 'EXACT_SCORE_0_0';
  } else if (base.sportsSemantic?.kind === 'sports_total'
      && Math.abs(Number(base.sportsSemantic.threshold) - 0.5) < 1e-9
      // Team totals are not complements of the fixture's 0-0 score. Require
      // the bare match-total label after the colon; a participant name before
      // O/U is an automatic veto.
      && /:\s*(?:o\s*\/\s*u|over\s*\/\s*under)\s*0\.5\s*\??$/i.test(marketQuestion)
      && /^over(?:\s|$)/i.test(base.positiveLabel)
      && /^under(?:\s|$)/i.test(base.negativeLabel)) {
    kind = 'TOTAL_GOALS_OVER_0_5';
  }
  if (!kind) return null;
  return {
    kind,
    fixtureId,
    scope,
    cancellation: cancellationPolicy(description),
    postponement: postponementPolicy(description),
    resolutionPolicy: resolutionPolicy(description),
  };
}

function normalizePhysicalMarket(event, market) {
  const base = normalizedMarket(event, market);
  if (!base?.accepting) return null;
  const semantic = physicalSemantic(event, market, base);
  if (!semantic) return null;
  const ruleDocument = JSON.parse(JSON.stringify(base.ruleDocument));
  ruleDocument.schema = 'polymarket-physical-rule-document-v1';
  ruleDocument.event.physicalFixtureId = semantic.fixtureId;
  ruleDocument.market.physicalSemantic = semantic;
  return {
    ...base,
    physicalFixtureId: semantic.fixtureId,
    physicalSemantic: semantic,
    ruleDocument,
    ruleHash: sha256(ruleDocument),
  };
}

function sameEndDate(markets) {
  const values = markets.map((market) => Date.parse(market.endDate));
  return values.every(Number.isFinite) && new Set(values).size === 1;
}

function certifyPhysicalCandidate(fixtureId, markets, payoffProof) {
  const checks = [];
  const [exact, total] = markets;
  if (!payoffProof?.valid || !payoffProof?.proofHash || payoffProof.guaranteedMinPayout < 1) {
    checks.push('INVALID_EXPLICIT_PAYOFF_PROOF');
  }
  if (markets.length !== 2 || markets.some((market) => !market.ruleHash || !market.ruleDocument)) {
    checks.push('MISSING_RULE_DOCUMENT');
  }
  if (markets.some((market) => !market.gammaId || !market.conditionId)) {
    checks.push('MISSING_MARKET_IDENTITY');
  }
  if (!fixtureId || markets.some((market) => market.physicalFixtureId !== fixtureId)) {
    checks.push('MIXED_PHYSICAL_FIXTURE');
  }
  if (exact?.physicalSemantic?.kind !== 'EXACT_SCORE_0_0'
      || total?.physicalSemantic?.kind !== 'TOTAL_GOALS_OVER_0_5') {
    checks.push('UNTYPED_PHYSICAL_PREDICATE');
  }
  if (!sameEndDate(markets)) checks.push('MIXED_SETTLEMENT_TIME');
  if (new Set(markets.map((market) => market.physicalSemantic?.scope)).size !== 1) {
    checks.push('MIXED_MATCH_SCOPE');
  }
  if (exact?.physicalSemantic?.cancellation !== 'EXACT_SCORE_0_0'
      || total?.physicalSemantic?.cancellation !== 'FIFTY_FIFTY') {
    checks.push('UNSUPPORTED_CANCELLATION_COMBINATION');
  }
  if (markets.some((market) =>
    market.physicalSemantic?.postponement !== 'REMAIN_OPEN_UNTIL_COMPLETED')) {
    checks.push('MIXED_POSTPONEMENT_POLICY');
  }
  const policies = markets.map((market) => market.physicalSemantic?.resolutionPolicy);
  if (!policies.every((policy) => policy?.primaryOfficialStatistics
      && policy?.consensusFallback && policy?.finalResultRecognized
      && policy?.revisionsIgnored && policy?.fallbackHours != null)
      || new Set(policies.map(canonical)).size !== 1) {
    checks.push('MIXED_RESOLUTION_POLICY');
  }
  const body = {
    version: PHYSICAL_CERTIFICATION_VERSION,
    relationType: PHYSICAL_SPORTS_STRUCTURE_TYPE,
    fixtureId,
    relationAst: {
      operator: 'EXPLICIT_WORST_STATE_PAYOFF',
      predicates: markets.map((market) => ({
        id: market.gammaId,
        semantic: market.physicalSemantic,
      })),
    },
    payoffProofHash: payoffProof?.proofHash || null,
    marketRuleHashes: markets.map((market) => market.ruleHash).sort(),
    checks: [...new Set(checks)].sort(),
  };
  return {
    ...body,
    valid: body.checks.length === 0,
    certificationHash: sha256(body),
  };
}

function physicalCandidateId(fixtureId, legs, certificationHash) {
  const identity = `${PHYSICAL_SPORTS_UNIVERSE_VERSION}|${fixtureId}|${certificationHash}|${
    legs.map((entry) => `${entry.gammaId}:${entry.outcome}`).sort().join('|')}`;
  return `sp_${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
}

function buildCandidate(fixtureId, exact, total) {
  const legs = [leg(exact, 'YES'), leg(total, 'YES')];
  for (const entry of legs) entry.semantic = entry.gammaId === exact.gammaId
    ? exact.physicalSemantic : total.physicalSemantic;
  const proof = compileExplicitPayoffProof({
    variables: [exact.gammaId, total.gammaId],
    legs,
    terminalStates: [
      {
        label: 'COMPLETED_0_0',
        outcomePayouts: {
          [exact.gammaId]: { YES: 1, NO: 0 },
          [total.gammaId]: { YES: 0, NO: 1 },
        },
      },
      {
        label: 'COMPLETED_ONE_OR_MORE_GOALS',
        outcomePayouts: {
          [exact.gammaId]: { YES: 0, NO: 1 },
          [total.gammaId]: { YES: 1, NO: 0 },
        },
      },
      {
        label: 'CANCELLED_NO_MAKEUP',
        outcomePayouts: {
          [exact.gammaId]: { YES: 1, NO: 0 },
          [total.gammaId]: { YES: 0.5, NO: 0.5 },
        },
      },
    ],
  });
  const markets = [exact, total];
  const certification = certifyPhysicalCandidate(fixtureId, markets, proof);
  const title = String(exact.eventTitle || total.eventTitle || `Sports fixture ${fixtureId}`)
    .replace(/\s+-\s+Exact Score.*$/i, '');
  return {
    candidateId: physicalCandidateId(fixtureId, legs, certification.certificationHash),
    structureType: PHYSICAL_SPORTS_STRUCTURE_TYPE,
    eventId: `fixture:${fixtureId}`,
    eventSlug: null,
    eventTitle: title,
    endDate: exact.endDate,
    complete: true,
    states: proof.terminalStates.map((state) => state.label),
    payoffVector: proof.payoffVector,
    guaranteedMinPayout: proof.guaranteedMinPayout,
    payoffProof: { ...proof, ruleCertification: certification },
    ruleCertification: certification,
    ruleDocuments: markets.map((market) => ({
      ruleHash: market.ruleHash,
      eventId: market.eventId,
      gammaId: market.gammaId,
      conditionId: market.conditionId,
      document: market.ruleDocument,
    })),
    atomic: false,
    universeId: PHYSICAL_SPORTS_UNIVERSE_VERSION,
    universeClass: 'sports',
    legs,
  };
}

function buildPhysicalSportsCandidates(events) {
  const groups = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const fixtureId = physicalFixtureId(event);
    if (!fixtureId || !isSportsEvent(event)) continue;
    const group = groups.get(fixtureId) || [];
    for (const market of event?.markets || []) {
      const normalized = normalizePhysicalMarket(event, market);
      if (normalized) group.push(normalized);
    }
    if (group.length) groups.set(fixtureId, group);
  }
  const candidates = [];
  for (const [fixtureId, markets] of groups) {
    const exacts = markets.filter((market) =>
      market.physicalSemantic.kind === 'EXACT_SCORE_0_0');
    const totals = markets.filter((market) =>
      market.physicalSemantic.kind === 'TOTAL_GOALS_OVER_0_5');
    for (const exact of exacts) {
      for (const total of totals) candidates.push(buildCandidate(fixtureId, exact, total));
    }
  }
  return [...new Map(candidates.map((candidate) =>
    [candidate.candidateId, candidate])).values()];
}

module.exports = {
  PHYSICAL_CERTIFICATION_VERSION,
  PHYSICAL_SPORTS_STRUCTURE_TYPE,
  PHYSICAL_SPORTS_UNIVERSE_VERSION,
  buildPhysicalSportsCandidates,
  cancellationPolicy,
  fullTimeSoccerScope,
  normalizePhysicalMarket,
  physicalFixtureId,
  resolutionPolicy,
};
