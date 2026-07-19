'use strict';

/**
 * Immutable rule certification for structural payoff identities.
 *
 * This module proves only that the *declared relation* is supported by the
 * venue metadata captured at discovery time. It does not claim the bundle is
 * executable; depth, fees, latency and orphan risk are separate gates.
 */

const crypto = require('node:crypto');

const CERTIFICATION_VERSION = 'payoff-rule-certification-v1';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function canonical(value) {
  return JSON.stringify(stable(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
}

function explicitTrue(value) {
  return value === true || String(value).toLowerCase() === 'true';
}

function text(value) {
  return value == null ? null : String(value);
}

function jsonArray(value) {
  if (Array.isArray(value)) return value.map(text);
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(text) : [];
  } catch (_) { return []; }
}

function normalizeRuleText(value) {
  return String(value || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9.+/:%$<>-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function createRuleDocument(event, market) {
  const document = {
    schema: 'polymarket-rule-document-v1',
    event: {
      id: text(event?.id), slug: text(event?.slug), title: text(event?.title),
      description: text(event?.description), resolutionSource: text(event?.resolutionSource),
      startDate: text(event?.startDate), endDate: text(event?.endDate),
      negRisk: explicitTrue(event?.negRisk), enableNegRisk: explicitTrue(event?.enableNegRisk),
      negRiskAugmented: explicitTrue(event?.negRiskAugmented),
    },
    market: {
      id: text(market?.id), conditionId: text(market?.conditionId),
      question: text(market?.question), groupItemTitle: text(market?.groupItemTitle),
      description: text(market?.description), resolutionSource: text(market?.resolutionSource),
      resolvedBy: text(market?.resolvedBy), startDate: text(market?.startDate),
      endDate: text(market?.endDate), outcomes: jsonArray(market?.outcomes),
      negRisk: explicitTrue(market?.negRisk), negRiskOther: explicitTrue(market?.negRiskOther),
      active: market?.active !== false, closed: market?.closed === true,
      acceptingOrders: market?.acceptingOrders !== false,
    },
  };
  return { document, ruleHash: sha256(document) };
}

function same(values) {
  return new Set(values.map((value) => canonical(value))).size <= 1;
}

function relationAst(type, markets) {
  if (type === 'binary_complement') {
    return { operator: 'COMPLEMENT', predicate: markets[0]?.gammaId || null };
  }
  if (type === 'nested_threshold') {
    return {
      operator: 'ORDERED_IMPLICATION',
      predicates: markets.map((market) => ({
        id: market.gammaId, strike: market.strike,
        thresholdOperator: market.thresholdOperator,
        thresholdDirection: market.thresholdDirection,
      })),
    };
  }
  if (type === 'disjoint_ranges') {
    return { operator: 'MUTUALLY_EXCLUSIVE', predicates: markets.map((market) => ({
      id: market.gammaId, range: market.range,
    })) };
  }
  if (type === 'sports_total_ladder' || type === 'sports_spread_ladder') {
    return { operator: 'ORDERED_IMPLICATION', semantic: type, predicates: markets.map((market) => ({
      id: market.gammaId, semantic: market.sportsSemantic,
    })) };
  }
  if (type === 'complete_mutually_exclusive_set') {
    return { operator: 'EXACTLY_ONE', predicates: markets.map((market) => market.gammaId).sort() };
  }
  return { operator: 'UNSUPPORTED', type };
}

function resolutionScope(market) {
  const document = market?.ruleDocument || {};
  return {
    eventId: document.event?.id || market?.eventId || null,
    eventSlug: document.event?.slug || market?.eventSlug || null,
    eventResolutionSource: normalizeRuleText(document.event?.resolutionSource),
    marketResolutionSource: normalizeRuleText(document.market?.resolutionSource),
    resolvedBy: normalizeRuleText(document.market?.resolvedBy),
    endDate: document.market?.endDate || document.event?.endDate || market?.endDate || null,
  };
}

function certifyStructuralRelation({ type, event, markets, payoffProof }) {
  const reasons = [];
  const rows = Array.isArray(markets) ? markets : [];
  if (!payoffProof?.valid || !payoffProof?.proofHash) reasons.push('INVALID_PAYOFF_PROOF');
  if (!rows.length || rows.some((market) => !market?.ruleHash || !market?.ruleDocument)) {
    reasons.push('MISSING_RULE_DOCUMENT');
  }
  if (rows.some((market) => !market?.conditionId || !market?.gammaId)) reasons.push('MISSING_MARKET_IDENTITY');

  if (type === 'binary_complement') {
    if (rows.length !== 1 || rows[0]?.yesToken === rows[0]?.noToken) reasons.push('INVALID_BINARY_COMPLEMENT');
  } else if (type === 'nested_threshold') {
    if (rows.length !== 2 || rows.some((market) => market?.strike == null || !market?.thresholdDirection)) {
      reasons.push('UNTYPED_THRESHOLD');
    }
    if (rows.length === 2 && rows[0].thresholdDirection !== rows[1].thresholdDirection) {
      reasons.push('MIXED_THRESHOLD_DIRECTION');
    }
    if (rows.length === 2 && !(rows[0].strike !== rows[1].strike)) reasons.push('NON_ORDERED_THRESHOLD');
    if (!same(rows.map(resolutionScope))) reasons.push('MIXED_RESOLUTION_SCOPE');
  } else if (type === 'disjoint_ranges') {
    if (rows.length !== 2 || rows.some((market) => !market?.range)) reasons.push('UNTYPED_RANGE');
    if (!same(rows.map(resolutionScope))) reasons.push('MIXED_RESOLUTION_SCOPE');
  } else if (type === 'sports_total_ladder' || type === 'sports_spread_ladder') {
    if (rows.length !== 2 || rows.some((market) => !market?.sportsSemantic?.rulesKey)) {
      reasons.push('UNTYPED_SPORTS_RULE');
    }
    if (!same(rows.map((market) => ({
      kind: market?.sportsSemantic?.kind,
      scopeKey: market?.sportsSemantic?.scopeKey,
      rulesKey: market?.sportsSemantic?.rulesKey,
    })))) reasons.push('MIXED_SPORTS_SCOPE');
  } else if (type === 'complete_mutually_exclusive_set') {
    const allEventMarkets = Array.isArray(event?.markets) ? event.markets : [];
    if (!explicitTrue(event?.negRisk) || rows.some((market) => !market?.negRisk || !market?.literalYesNo)) {
      reasons.push('NOT_EXPLICIT_NEGRISK_SET');
    }
    if (explicitTrue(event?.negRiskAugmented)) reasons.push('AUGMENTED_NEGRISK_NOT_EXHAUSTIVE');
    if (rows.some((market) => market?.negRiskOther)) reasons.push('NEGRISK_OTHER_PLACEHOLDER');
    if (rows.length < 2 || rows.length !== allEventMarkets.length) reasons.push('INCOMPLETE_EVENT_SET');
  } else {
    reasons.push('UNSUPPORTED_RELATION_TYPE');
  }

  const ast = relationAst(type, rows);
  const body = {
    version: CERTIFICATION_VERSION,
    relationType: type,
    eventId: text(event?.id ?? event?.slug),
    relationAst: ast,
    payoffProofHash: payoffProof?.proofHash || null,
    marketRuleHashes: rows.map((market) => market.ruleHash).filter(Boolean).sort(),
    checks: [...new Set(reasons)].sort(),
  };
  return {
    ...body,
    valid: body.checks.length === 0,
    certificationHash: sha256(body),
  };
}

module.exports = {
  CERTIFICATION_VERSION, canonical, certifyStructuralRelation,
  createRuleDocument, normalizeRuleText, resolutionScope, sha256,
};
