'use strict';

/**
 * Fail-closed semantic key for the prospective cross-venue convergence trial.
 *
 * Similar titles are useful for discovery, but they are not evidence that two
 * contracts observe the same event.  A pair is eligible only when every
 * outcome-defining dimension can be extracted on both venues and agrees.
 */

const crypto = require('node:crypto');
const {
  contractText, domains, normalizeText, numericSignature, predicateSignature,
} = require('./strategy');

const NOT_APPLICABLE = 'n/a';

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalSubject(market, venue, structuredEvidence = null) {
  if (structuredEvidence?.version === 'crossvenue-crypto-structured-v1') {
    return [
      'crypto',
      structuredEvidence.asset,
      structuredEvidence.form,
    ].map(normalizeText).join(':');
  }
  if (structuredEvidence?.version === 'crossvenue-sports-structured-v1') {
    return [
      'sports',
      structuredEvidence.league,
      structuredEvidence.date,
      [...(structuredEvidence.teams || [])].map(normalizeText).sort().join('+'),
      structuredEvidence.leg,
      structuredEvidence.form,
    ].map(normalizeText).join(':');
  }
  const title = venue === 'poly'
    ? market?.question
    : market?.title || market?.eventTitle;
  return normalizeText(title);
}

function comparator(text, market = null, venue = null) {
  if (venue === 'kalshi') {
    const strikeType = String(market?.strikeType || '').toLowerCase();
    if (['greater_or_equal', 'greater_than_or_equal'].includes(strikeType)) return 'gte';
    if (['less_or_equal', 'less_than_or_equal'].includes(strikeType)) return 'lte';
    if (strikeType === 'greater') return 'gt';
    if (strikeType === 'less') return 'lt';
  }
  const normalized = normalizeText(text);
  if (/\bat least\b|\bat or above\b|\bor above\b|\bgreater than or equal\b|\bnot less than\b/.test(normalized)) return 'gte';
  if (/\bat most\b|\bat or below\b|\bor below\b|\bless than or equal\b|\bnot more than\b/.test(normalized)) return 'lte';
  if (/\babove\b|\bhigher than\b|\bgreater than\b|\bmore than\b/.test(normalized)) return 'gt';
  if (/\bbelow\b|\blower than\b|\bless than\b|\bfewer than\b/.test(normalized)) return 'lt';
  return null;
}

function numberValues(text) {
  return numericSignature(text)
    .filter((value) => !value.startsWith('pct:'))
    .map((value) => Number(value.slice(4)))
    .filter(Number.isFinite);
}

function thresholdStrike(market, venue, structuredEvidence = null) {
  const structured = venue === 'poly'
    ? structuredEvidence?.polyParsed : structuredEvidence?.kalshiParsed;
  if (venue === 'kalshi' && Number.isFinite(Number(market?.floorStrike))) {
    // Preserve the literal rule boundary. A 99.99 exclusive boundary is not
    // proved equivalent to an inclusive 100.00 boundary unless resolver
    // decimal precision is itself certified.
    return Number(market.floorStrike);
  }
  if (Number.isFinite(Number(structured?.strike))) return Number(structured.strike);
  const text = venue === 'poly'
    ? market?.question
    : [market?.yesSubTitle, market?.title, market?.rulesPrimary].filter(Boolean).join(' ');
  const normalized = String(text || '').replace(/,/g, '');
  const keywordStrike = normalized.match(
    /(?:above|below|at least|at most|greater than|less than|more than|fewer than)\s*\$?(\d+(?:\.\d+)?)/i,
  ) || normalized.match(
    /\$?(\d+(?:\.\d+)?)\s*(?:or above|or below|and above|and below)/i,
  );
  if (keywordStrike && Number.isFinite(Number(keywordStrike[1]))) {
    return Number(keywordStrike[1]);
  }
  const values = numberValues(text);
  // A threshold contract must expose one unambiguous strike. Dates are
  // removed when they look like years; anything else fails closed.
  const candidates = [...new Set(values.filter((value) => value < 1900 || value > 2100))];
  return candidates.length === 1 ? candidates[0] : null;
}

function timezone(text) {
  const normalized = ` ${normalizeText(text)} `;
  if (/\b(?:et|est|edt|eastern time)\b/.test(normalized)) return 'America/New_York';
  if (/\b(?:ct|cst|cdt|central time)\b/.test(normalized)) return 'America/Chicago';
  if (/\b(?:mt|mst|mdt|mountain time)\b/.test(normalized)) return 'America/Denver';
  if (/\b(?:pt|pst|pdt|pacific time)\b/.test(normalized)) return 'America/Los_Angeles';
  if (/\b(?:utc|gmt)\b/.test(normalized)) return 'UTC';
  return null;
}

function canonicalResolverLabels(value) {
  const normalized = normalizeText(value);
  const labels = [];
  if (/\bchainlink\b|chain\.link/.test(normalized)) labels.push('oracle:chainlink');
  if (/\bpyth\b|pyth\.network/.test(normalized)) labels.push('oracle:pyth');
  if (/\bcf benchmarks\b|\bbrti\b|\bethusd rr\b|\bbtcusd rr\b|cfbenchmarks\.com/.test(normalized)) {
    labels.push('index:cf_benchmarks');
  }
  if (/\bbinance\b|binance\.com/.test(normalized)) labels.push('exchange:binance');
  if (/\bcoinbase\b|coinbase\.com/.test(normalized)) labels.push('exchange:coinbase');
  if (/\bderibit\b|deribit\.com/.test(normalized)) labels.push('exchange:deribit');
  if (/\bassociated press\b|\bthe ap\b|apnews\.com/.test(normalized)) {
    labels.push('media:associated_press');
  }
  if (/\bcredible reporting\b|\bconsensus of credible\b/.test(normalized)) {
    labels.push('media:credible_consensus');
  }
  return [...new Set(labels)];
}

function canonicalResolverLabel(value) {
  const labels = canonicalResolverLabels(value);
  return labels.length === 1 ? labels[0] : null;
}

function sourceCandidates(market, venue) {
  const full = contractText(market, venue);
  const values = new Set();
  for (const label of canonicalResolverLabels(full)) values.add(label);
  for (const domain of domains(full)) {
    values.add(canonicalResolverLabel(domain) || `domain:${domain}`);
  }
  const settlementSources = Array.isArray(market?.settlementSources)
    ? market.settlementSources : [];
  for (const source of settlementSources) {
    for (const domain of domains(source?.url || '')) {
      values.add(canonicalResolverLabel(domain) || `domain:${domain}`);
    }
    const sourceName = normalizeText(source?.name);
    if (sourceName) values.add(canonicalResolverLabel(sourceName) || `name:${sourceName}`);
  }
  return [...values].sort();
}

function fallbackPolicy(text) {
  const normalized = normalizeText(text);
  if (/\bresolve(?:s|d)? (?:to )?(?:50 50|0 5)\b/.test(normalized)) return 'split_50_50';
  if (/\bfair (?:market )?price\b/.test(normalized)) return 'fair_price';
  if (/\bresolve(?:s|d)? (?:to )?other\b/.test(normalized)) return 'other';
  if (/\bresolve(?:s|d)? (?:to )?no\b/.test(normalized)) return 'no';
  if (/\bresolve(?:s|d)? (?:to )?yes\b/.test(normalized)) return 'yes';
  if (/\bvoid\b|\brefund\b/.test(normalized)) return 'void_or_refund';
  return null;
}

function settlementPrecision(text, predicate) {
  const normalized = normalizeText(text);
  if (/\bsimple average\b.*\bsixty seconds\b|\b60 second average\b/.test(normalized)) {
    return 'sixty_second_average';
  }
  if (/\bone minute candle\b|\b1 minute candle\b/.test(normalized)) {
    return 'one_minute_candle_close';
  }
  if (/\bone hour candle\b|\b1 hour candle\b/.test(normalized)) return 'one_hour_candle_close';
  if (/\bclosing price\b|\bclose price\b|\bclose value\b/.test(normalized)) return 'closing_value';
  if (predicate && predicate !== 'threshold') return 'binary_event';
  return null;
}

function observationAt(market, venue) {
  const raw = venue === 'poly'
    ? market?.endDate
    : market?.expectedExpirationTime || market?.closeTime;
  const parsed = Date.parse(raw || '');
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function buildVenueRuleKey(market, venue, structuredEvidence = null) {
  const fullText = contractText(market, venue);
  const title = canonicalSubject(market, venue, structuredEvidence);
  const predicate = predicateSignature(venue === 'poly'
    ? market?.question
    : [market?.rulesPrimary, market?.title, market?.yesSubTitle].filter(Boolean).join(' '));
  const threshold = predicate === 'threshold';
  const cmp = threshold ? comparator(venue === 'poly'
    ? market?.question
    : [market?.rulesPrimary, market?.yesSubTitle, market?.title].filter(Boolean).join(' '),
  market, venue)
    : NOT_APPLICABLE;
  const strike = threshold ? thresholdStrike(market, venue, structuredEvidence) : NOT_APPLICABLE;
  const sources = sourceCandidates(market, venue);
  const explicitTimezone = timezone(fullText);
  const observedAt = observationAt(market, venue);
  const fallback = fallbackPolicy(fullText);
  const precision = settlementPrecision(fullText, predicate);
  const key = {
    subject: title || null,
    predicate,
    comparator: cmp,
    strike,
    resolver: sources.length === 1 ? sources[0] : null,
    observationAt: observedAt,
    timezone: explicitTimezone,
    fallback,
    settlementPrecision: precision,
  };
  const missing = Object.entries(key)
    .filter(([, value]) => value == null || value === '')
    .map(([name]) => name);
  return {
    key,
    complete: missing.length === 0,
    missing,
    resolverCandidates: sources,
  };
}

function equalValue(left, right) {
  if (typeof left === 'number' || typeof right === 'number') {
    return Number.isFinite(Number(left)) && Number.isFinite(Number(right))
      && Math.abs(Number(left) - Number(right)) <= 1e-9;
  }
  return left === right;
}

function compareExactRuleKeys(poly, kalshi, structuredEvidence = null) {
  const polyRule = buildVenueRuleKey(poly, 'poly', structuredEvidence);
  const kalshiRule = buildVenueRuleKey(kalshi, 'kalshi', structuredEvidence);
  const hardMismatchReasons = [];
  for (const field of polyRule.missing) hardMismatchReasons.push(`POLY_MISSING_${field.toUpperCase()}`);
  for (const field of kalshiRule.missing) hardMismatchReasons.push(`KALSHI_MISSING_${field.toUpperCase()}`);

  const dimensions = Object.keys(polyRule.key);
  for (const field of dimensions) {
    const left = polyRule.key[field];
    const right = kalshiRule.key[field];
    if (left == null || right == null) continue;
    if (!equalValue(left, right)) hardMismatchReasons.push(`${field.toUpperCase()}_MISMATCH`);
  }

  // Website/name aliases are canonicalized before this comparison. Exactly
  // one resolver must remain on each side; silently ignoring a venue's extra
  // fallback source would turn a rule difference into false equivalence.
  const resolverOverlap = polyRule.resolverCandidates
    .filter((source) => kalshiRule.resolverCandidates.includes(source));
  if (polyRule.resolverCandidates.length === 1
    && kalshiRule.resolverCandidates.length === 1
    && resolverOverlap.length === 1) {
    polyRule.key.resolver = resolverOverlap[0];
    kalshiRule.key.resolver = resolverOverlap[0];
    const missingResolver = /_MISSING_RESOLVER$/;
    for (let index = hardMismatchReasons.length - 1; index >= 0; index -= 1) {
      if (missingResolver.test(hardMismatchReasons[index])) hardMismatchReasons.splice(index, 1);
    }
  } else if (!resolverOverlap.length
    && polyRule.resolverCandidates.length && kalshiRule.resolverCandidates.length) {
    hardMismatchReasons.push('RESOLVER_MISMATCH');
  } else if (polyRule.resolverCandidates.length > 1
    || kalshiRule.resolverCandidates.length > 1) {
    hardMismatchReasons.push('RESOLVER_AMBIGUOUS');
  }

  const uniqueReasons = [...new Set(hardMismatchReasons)].sort();
  const exactRuleEligible = uniqueReasons.length === 0
    && canonicalJson(polyRule.key) === canonicalJson(kalshiRule.key);
  const candidateKey = exactRuleEligible ? `cv-rule:${hash(polyRule.key)}` : null;
  return {
    version: 'crossvenue-exact-rule-key-v1',
    exactRuleEligible,
    hardMismatch: !exactRuleEligible,
    hardMismatchReasons: uniqueReasons,
    candidateKey,
    polyRule,
    kalshiRule,
  };
}

module.exports = {
  NOT_APPLICABLE,
  buildVenueRuleKey,
  canonicalSubject,
  canonicalJson,
  compareExactRuleKeys,
  comparator,
  fallbackPolicy,
  settlementPrecision,
  sourceCandidates,
  thresholdStrike,
  timezone,
};
