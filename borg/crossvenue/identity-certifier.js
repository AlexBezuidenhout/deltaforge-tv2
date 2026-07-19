'use strict';

const crypto = require('node:crypto');

const IDENTITY_CERTIFICATION_VERSION = 'crossvenue-rule-binding-v1';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function canonical(value) { return JSON.stringify(stable(value)); }
function hash(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }
function text(value) { return value == null ? null : String(value); }

function ruleDocuments(poly, kalshi) {
  const polymarket = {
    schema: 'crossvenue-polymarket-rule-v1',
    conditionId: text(poly?.conditionId), gammaId: text(poly?.gammaId),
    question: text(poly?.question), eventTitle: text(poly?.eventTitle),
    description: text(poly?.description), resolutionSource: text(poly?.resolutionSource),
    resolvedBy: text(poly?.resolvedBy), endDate: text(poly?.endDate),
    category: text(poly?.category),
  };
  const kalshiMarket = {
    schema: 'crossvenue-kalshi-rule-v1',
    ticker: text(kalshi?.ticker), eventTicker: text(kalshi?.eventTicker),
    seriesTicker: text(kalshi?.seriesTicker), title: text(kalshi?.title),
    subtitle: text(kalshi?.subtitle), yesSubTitle: text(kalshi?.yesSubTitle),
    noSubTitle: text(kalshi?.noSubTitle), rulesPrimary: text(kalshi?.rulesPrimary),
    rulesSecondary: text(kalshi?.rulesSecondary), closeTime: text(kalshi?.closeTime),
    expectedExpirationTime: text(kalshi?.expectedExpirationTime),
    latestExpirationTime: text(kalshi?.latestExpirationTime),
    canCloseEarly: kalshi?.canCloseEarly === true,
    provisional: kalshi?.provisional === true,
  };
  const polyRuleHash = hash(polymarket);
  const kalshiRuleHash = hash(kalshiMarket);
  const snapshotHash = hash({ version: IDENTITY_CERTIFICATION_VERSION, polyRuleHash, kalshiRuleHash });
  return { polymarket, kalshi: kalshiMarket, polyRuleHash, kalshiRuleHash, snapshotHash };
}

function expectedBinding(review) {
  const binding = review?.ruleBinding || review?.identityBinding || {};
  return {
    snapshotHash: review?.identitySnapshotHash || binding.snapshotHash || null,
    polyRuleHash: binding.polyRuleHash || null,
    kalshiRuleHash: binding.kalshiRuleHash || null,
  };
}

function certifyIdentityBinding(poly, kalshi, review = null) {
  const rules = ruleDocuments(poly, kalshi);
  const expected = expectedBinding(review);
  const reasons = [];
  const reviewedAt = review?.reviewedAt || review?.resolutionAudit?.reviewedAt || null;
  if (!review || review.reviewed !== true || review.approved !== true) reasons.push('NOT_MANUALLY_APPROVED');
  if (!Number.isFinite(Date.parse(reviewedAt))) reasons.push('MISSING_REVIEW_TIMESTAMP');
  const hasSnapshot = Boolean(expected.snapshotHash);
  const hasLegHashes = Boolean(expected.polyRuleHash && expected.kalshiRuleHash);
  if (!hasSnapshot && !hasLegHashes) reasons.push('REVIEW_NOT_BOUND_TO_RULE_HASHES');
  if (hasSnapshot && expected.snapshotHash !== rules.snapshotHash) reasons.push('IDENTITY_SNAPSHOT_HASH_MISMATCH');
  if (hasLegHashes && (expected.polyRuleHash !== rules.polyRuleHash
    || expected.kalshiRuleHash !== rules.kalshiRuleHash)) reasons.push('VENUE_RULE_HASH_MISMATCH');
  return {
    version: IDENTITY_CERTIFICATION_VERSION,
    valid: reasons.length === 0,
    reasons,
    activeFrom: Number.isFinite(Date.parse(reviewedAt)) ? new Date(reviewedAt).toISOString() : null,
    expected,
    ...rules,
  };
}

module.exports = {
  IDENTITY_CERTIFICATION_VERSION, canonical, certifyIdentityBinding, hash, ruleDocuments,
};
