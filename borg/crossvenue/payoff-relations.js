'use strict';

const { RELATION_TYPES, compilePayoffProof } = require('../research/payoff-proof');

const POLY_PREDICATE = 'POLY_YES';
const KALSHI_PREDICATE = 'KALSHI_YES';

const CROSSVENUE_RELATION_TYPES = Object.freeze({
  EQUIVALENT: 'EQUIVALENT',
  POLY_IMPLIES_KALSHI: 'POLY_IMPLIES_KALSHI',
  KALSHI_IMPLIES_POLY: 'KALSHI_IMPLIES_POLY',
  MUTUALLY_EXCLUSIVE: 'MUTUALLY_EXCLUSIVE',
  EXHAUSTIVE: 'EXHAUSTIVE',
});

function relationSpec(type) {
  if (type === CROSSVENUE_RELATION_TYPES.EQUIVALENT) {
    return { relationType: RELATION_TYPES.EQUIVALENT, variables: [POLY_PREDICATE, KALSHI_PREDICATE] };
  }
  if (type === CROSSVENUE_RELATION_TYPES.POLY_IMPLIES_KALSHI) {
    return { relationType: RELATION_TYPES.IMPLIES, variables: [POLY_PREDICATE, KALSHI_PREDICATE] };
  }
  if (type === CROSSVENUE_RELATION_TYPES.KALSHI_IMPLIES_POLY) {
    return { relationType: RELATION_TYPES.IMPLIES, variables: [KALSHI_PREDICATE, POLY_PREDICATE] };
  }
  if (type === CROSSVENUE_RELATION_TYPES.MUTUALLY_EXCLUSIVE) {
    return { relationType: RELATION_TYPES.MUTUALLY_EXCLUSIVE, variables: [POLY_PREDICATE, KALSHI_PREDICATE] };
  }
  if (type === CROSSVENUE_RELATION_TYPES.EXHAUSTIVE) {
    return { relationType: RELATION_TYPES.EXHAUSTIVE, variables: [POLY_PREDICATE, KALSHI_PREDICATE] };
  }
  throw new Error(`unsupported cross-venue relation type: ${type}`);
}

function validateStateRequirement(requirement, relationId) {
  if (!requirement?.id) throw new Error(`relation ${relationId} has a state requirement without an id`);
  if (requirement.satisfied === true) {
    if (!Number.isFinite(Date.parse(requirement.observedAt))) {
      throw new Error(`relation ${relationId} satisfied state ${requirement.id} requires observedAt`);
    }
    if (!requirement.source) {
      throw new Error(`relation ${relationId} satisfied state ${requirement.id} requires a source`);
    }
  }
}

function validateManualRelation(review) {
  if (!review?.id || !review.polyConditionId || !review.kalshiTicker) {
    throw new Error('cross-venue payoff relations require id, polyConditionId and kalshiTicker');
  }
  relationSpec(review.relationType);
  if (review.approved === true && review.reviewed !== true) {
    throw new Error(`relation ${review.id} cannot be approved before reviewed=true`);
  }
  if (review.approved === true && !review.resolutionAudit?.rationale) {
    throw new Error(`relation ${review.id} approval requires a resolutionAudit rationale`);
  }
  for (const requirement of review.stateRequirements || []) {
    validateStateRequirement(requirement, review.id);
  }
  return review;
}

function stateEvidenceStatus(requirements, nowMs) {
  const rows = (requirements || []).map((requirement) => {
    const observedMs = Date.parse(requirement.observedAt);
    const validUntilMs = requirement.validUntil ? Date.parse(requirement.validUntil) : null;
    const active = requirement.satisfied === true
      && Number.isFinite(observedMs) && observedMs <= nowMs
      && (!Number.isFinite(validUntilMs) || nowMs <= validUntilMs);
    return { ...requirement, active };
  });
  const observedTimes = rows.map((row) => Date.parse(row.observedAt)).filter(Number.isFinite);
  return {
    rows,
    satisfied: rows.every((row) => row.active),
    activeFrom: observedTimes.length === rows.length && rows.length
      ? new Date(Math.max(...observedTimes)).toISOString()
      : null,
  };
}

function compileCrossVenueRelation(review, options = {}) {
  validateManualRelation(review);
  const nowMs = Number(options.nowMs ?? Date.now());
  const spec = relationSpec(review.relationType);
  const bundleProofs = [];
  for (const polyOutcome of ['YES', 'NO']) {
    for (const kalshiOutcome of ['YES', 'NO']) {
      const payoffProof = compilePayoffProof({
        ...spec,
        legs: [
          { predicateId: POLY_PREDICATE, outcome: polyOutcome },
          { predicateId: KALSHI_PREDICATE, outcome: kalshiOutcome },
        ],
      });
      bundleProofs.push({
        polyOutcome, kalshiOutcome,
        direction: `POLY_${polyOutcome}+KALSHI_${kalshiOutcome}`,
        guaranteedMinPayoutPerShare: payoffProof.guaranteedMinPayout,
        payoffProof,
      });
    }
  }
  const validBundles = bundleProofs.filter((bundle) => bundle.guaranteedMinPayoutPerShare > 0);
  const stateEvidence = stateEvidenceStatus(review.stateRequirements, nowMs);
  const relationApproved = review.reviewed === true && review.approved === true
    && stateEvidence.satisfied && validBundles.length > 0;
  return {
    id: review.id,
    relationType: review.relationType,
    reviewed: review.reviewed === true,
    configuredApproval: review.approved === true,
    relationApproved,
    relationStatus: relationApproved ? 'MANUALLY_APPROVED'
      : review.approved === true && !stateEvidence.satisfied ? 'PENDING_STATE'
        : review.reviewed === true ? 'MANUALLY_REJECTED' : 'PENDING_REVIEW',
    activeFrom: stateEvidence.activeFrom,
    stateEvidence,
    resolutionAudit: review.resolutionAudit || null,
    validBundles,
    rejectedBundles: bundleProofs.filter((bundle) => bundle.guaranteedMinPayoutPerShare <= 0),
  };
}

function exactIdentityRelation(matchId, resolutionAudit = null) {
  return compileCrossVenueRelation({
    id: `identity:${matchId}`,
    polyConditionId: String(matchId),
    kalshiTicker: String(matchId),
    relationType: CROSSVENUE_RELATION_TYPES.EQUIVALENT,
    reviewed: true,
    approved: true,
    stateRequirements: [],
    resolutionAudit: resolutionAudit || { rationale: 'Frozen manual audit approved exact payoff equivalence.' },
  });
}

module.exports = {
  CROSSVENUE_RELATION_TYPES, KALSHI_PREDICATE, POLY_PREDICATE,
  compileCrossVenueRelation, exactIdentityRelation, validateManualRelation,
};
