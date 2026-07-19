'use strict';

/**
 * One durable row per approved relation event and safe bundle direction.
 * Quote observations may overlap or flicker; they update this lifecycle row
 * instead of manufacturing independent sample size. This module is pure and
 * has no exchange, database, wallet, or order dependency.
 */

const crypto = require('node:crypto');

function finite(value, fallback = null) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function timestamp(value) {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function relationEpisodeId({ matchId, relationId, direction, activeFrom, experimentId = 'legacy' }) {
  if (!matchId || !relationId || !direction) throw new Error('relation episode requires matchId, relationId and direction');
  const identity = [experimentId, matchId, relationId, direction,
    timestamp(activeFrom) || 'always-active'].join('|');
  return `cvrel_${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 28)}`;
}

function initialEpisode(observation) {
  const observedAt = timestamp(observation.observedAt);
  if (!observedAt) throw new Error('relation episode observation requires a valid observedAt');
  const episodeId = observation.episodeId || relationEpisodeId(observation);
  return {
    episodeId,
    experimentId: observation.experimentId || 'legacy',
    matchId: observation.matchId,
    relationId: observation.relationId,
    direction: observation.direction,
    payoffProofHash: observation.payoffProofHash || null,
    stateActiveFrom: timestamp(observation.activeFrom),
    firstObservedAt: observedAt,
    lastObservedAt: observedAt,
    firstEconomicAt: null,
    lastEconomicAt: null,
    disappearedAt: null,
    closedAt: null,
    lifecycleStatus: 'OBSERVED_NO_EDGE',
    observations: 0,
    economicObservations: 0,
    disappearances: 0,
    reappearances: 0,
    maxQuantity: null,
    maxTotalCost: null,
    maxRawProfit: null,
    maxStressedProfit: null,
    worstOrphanUnwindPnl: null,
    orphanStressLossObservations: 0,
    orphanUnwindUnavailableObservations: 0,
    firstOpportunityId: null,
    lastOpportunityId: null,
    lastDataQualityGrade: null,
    lastExecutionFidelityGrade: null,
    detail: {},
  };
}

function maxNullable(left, right) {
  const values = [finite(left), finite(right)].filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

function minNullable(left, right) {
  const values = [finite(left), finite(right)].filter(Number.isFinite);
  return values.length ? Math.min(...values) : null;
}

function updateRelationEpisode(previous, observation) {
  if (observation.relationApproved !== true) return null;
  const next = previous ? { ...previous, detail: { ...(previous.detail || {}) } }
    : initialEpisode(observation);
  const observedAt = timestamp(observation.observedAt);
  if (!observedAt) throw new Error('relation episode observation requires a valid observedAt');
  const wasEconomic = next.economicObservations > 0;
  const wasOpenEconomic = next.lifecycleStatus === 'OPEN_ECONOMIC';
  const economic = observation.economic === true;

  next.lastObservedAt = observedAt;
  next.observations += 1;
  next.lastDataQualityGrade = observation.dataQualityGrade || next.lastDataQualityGrade;
  next.lastExecutionFidelityGrade = observation.executionFidelityGrade || next.lastExecutionFidelityGrade;
  next.detail = {
    ...next.detail,
    latestReason: observation.reason || null,
    latestStatus: observation.status || null,
    latestBookSignature: observation.bookSignature || null,
    latestTriggerVenue: observation.triggerVenue || null,
  };

  if (economic) {
    if (wasEconomic && !wasOpenEconomic) next.reappearances += 1;
    next.lifecycleStatus = 'OPEN_ECONOMIC';
    next.firstEconomicAt ||= observedAt;
    next.lastEconomicAt = observedAt;
    next.disappearedAt = null;
    next.economicObservations += 1;
    next.maxQuantity = maxNullable(next.maxQuantity, observation.quantity);
    next.maxTotalCost = maxNullable(next.maxTotalCost, observation.totalCost);
    next.maxRawProfit = maxNullable(next.maxRawProfit, observation.rawProfit);
    next.maxStressedProfit = maxNullable(next.maxStressedProfit, observation.stressedProfit);
    next.worstOrphanUnwindPnl = minNullable(next.worstOrphanUnwindPnl,
      observation.worstOrphanUnwindPnl);
    if (finite(observation.worstOrphanUnwindPnl) < 0) next.orphanStressLossObservations += 1;
    if (observation.orphanUnwindAvailable === false) next.orphanUnwindUnavailableObservations += 1;
    if (observation.opportunityId) {
      next.firstOpportunityId ||= observation.opportunityId;
      next.lastOpportunityId = observation.opportunityId;
    }
  } else if (wasOpenEconomic) {
    next.lifecycleStatus = 'DISAPPEARED';
    next.disappearedAt = observedAt;
    next.disappearances += 1;
  } else if (!wasEconomic) {
    next.lifecycleStatus = 'OBSERVED_NO_EDGE';
  }
  return next;
}

function closeRelationEpisode(previous, closedAt, reason = 'RELATION_INACTIVE') {
  if (!previous) return null;
  const at = timestamp(closedAt);
  if (!at) throw new Error('relation episode close requires a valid timestamp');
  return {
    ...previous,
    lastObservedAt: at,
    closedAt: at,
    lifecycleStatus: previous.economicObservations > 0 ? 'CLOSED_AFTER_OPPORTUNITY' : 'CLOSED_NO_EDGE',
    detail: { ...(previous.detail || {}), closeReason: reason },
  };
}

module.exports = {
  closeRelationEpisode,
  finite,
  initialEpisode,
  relationEpisodeId,
  updateRelationEpisode,
};
