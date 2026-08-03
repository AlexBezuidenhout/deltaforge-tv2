'use strict';

/**
 * Fail-closed rule and event-time helpers for the R07 timestamp-precision lane.
 *
 * An ISO endDate proves only the application's nominal market boundary. It
 * does not prove which resolver report belongs to that boundary. R07 therefore
 * requires the rule text to state the source timestamp precision and the exact
 * terminal-report selection policy. Generic phrases such as "price at the
 * end" and "closing price" remain UNKNOWN.
 */

const crypto = require('node:crypto');

const AUDIT_VERSION = 'resolver-timestamp-precision-audit-v1';
const RULE_STATUS = Object.freeze({
  CERTIFIED: 'CERTIFIED',
  UNKNOWN: 'UNKNOWN',
  CONFLICT: 'CONFLICT',
  NOT_RELEVANT: 'NOT_RELEVANT',
});

const TICK_POLICIES = Object.freeze({
  LAST_AT_OR_BEFORE: 'LAST_SOURCE_TICK_AT_OR_BEFORE',
  LAST_BEFORE: 'LAST_SOURCE_TICK_BEFORE',
  FIRST_AT_OR_AFTER: 'FIRST_SOURCE_TICK_AT_OR_AFTER',
  FIRST_AFTER: 'FIRST_SOURCE_TICK_AFTER',
  EXACT: 'SOURCE_TICK_AT_EXACT_TIMESTAMP',
  NEAREST: 'NEAREST_SOURCE_TICK',
  PRECEDING_60S_AVERAGE: 'SIMPLE_AVERAGE_PRECEDING_60_SECONDS',
  ONE_MINUTE_CANDLE_CLOSE: 'ONE_MINUTE_CANDLE_CLOSE',
  ONE_HOUR_CANDLE_CLOSE: 'ONE_HOUR_CANDLE_CLOSE',
  OFFICIAL_FIXING: 'OFFICIAL_PUBLISHED_FIXING',
});

function normalize(value) {
  return String(value || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9.:/+_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function precisionCandidates(text) {
  const value = normalize(text);
  const found = [];
  if (/\b(?:microsecond|microseconds|us precision)\b/.test(value)) found.push('microsecond');
  if (/\b(?:millisecond|milliseconds|ms precision)\b/.test(value)) found.push('millisecond');
  if (/\b(?:second precision|to the second|whole second|second level timestamp)\b/.test(value)) found.push('second');
  if (/\b(?:minute precision|to the minute|whole minute)\b/.test(value)) found.push('minute');
  return unique(found);
}

function tickPolicyCandidates(text) {
  const value = normalize(text);
  const found = [];
  if (/\b(?:last|latest) (?:price|value|report|tick).*\bat or before\b/.test(value)
    || /\b(?:price|value|report|tick).*\bwith (?:a )?(?:source )?timestamp (?:at or before|less than or equal to)\b/.test(value)) {
    found.push(TICK_POLICIES.LAST_AT_OR_BEFORE);
  }
  if (/\b(?:last|latest) (?:price|value|report|tick).*\bbefore\b/.test(value)
    && !/\bat or before\b/.test(value)) found.push(TICK_POLICIES.LAST_BEFORE);
  if (/\b(?:first|earliest) (?:price|value|report|tick).*\bat or after\b/.test(value)
    || /\b(?:price|value|report|tick).*\bwith (?:a )?(?:source )?timestamp (?:at or after|greater than or equal to)\b/.test(value)) {
    found.push(TICK_POLICIES.FIRST_AT_OR_AFTER);
  }
  if (/\b(?:first|earliest) (?:price|value|report|tick).*\bafter\b/.test(value)
    && !/\bat or after\b/.test(value)) found.push(TICK_POLICIES.FIRST_AFTER);
  if (/\b(?:price|value|report|tick).*\b(?:with (?:a )?(?:source )?timestamp (?:equal to|exactly)|at the exact timestamp)\b/.test(value)) {
    found.push(TICK_POLICIES.EXACT);
  }
  if (/\b(?:nearest|closest) (?:price|value|report|tick)\b/.test(value)) found.push(TICK_POLICIES.NEAREST);
  if (/\b(?:simple )?average\b.*\b(?:preceding|previous|before)\b.*\b(?:60 seconds|sixty seconds|one minute)\b/.test(value)
    || /\b(?:60 second|sixty second) average\b/.test(value)) {
    found.push(TICK_POLICIES.PRECEDING_60S_AVERAGE);
  }
  if (/\b(?:one|1) minute candle (?:close|closing value)\b/.test(value)) {
    found.push(TICK_POLICIES.ONE_MINUTE_CANDLE_CLOSE);
  }
  if (/\b(?:one|1) hour candle (?:close|closing value)\b/.test(value)) {
    found.push(TICK_POLICIES.ONE_HOUR_CANDLE_CLOSE);
  }
  if (/\bofficial (?:published )?(?:fixing|settlement value|closing value)\b/.test(value)) {
    found.push(TICK_POLICIES.OFFICIAL_FIXING);
  }
  return unique(found);
}

function cutoffPolicyForTickPolicy(policy) {
  return ({
    [TICK_POLICIES.LAST_AT_OR_BEFORE]: 'AT_OR_BEFORE_INCLUSIVE',
    [TICK_POLICIES.LAST_BEFORE]: 'BEFORE_EXCLUSIVE',
    [TICK_POLICIES.FIRST_AT_OR_AFTER]: 'AT_OR_AFTER_INCLUSIVE',
    [TICK_POLICIES.FIRST_AFTER]: 'AFTER_EXCLUSIVE',
    [TICK_POLICIES.EXACT]: 'EXACT_TIMESTAMP',
    [TICK_POLICIES.NEAREST]: 'NEAREST_EITHER_SIDE',
    [TICK_POLICIES.PRECEDING_60S_AVERAGE]: 'PRECEDING_WINDOW_END_INCLUSIVE',
    [TICK_POLICIES.ONE_MINUTE_CANDLE_CLOSE]: 'CANDLE_CLOSE',
    [TICK_POLICIES.ONE_HOUR_CANDLE_CLOSE]: 'CANDLE_CLOSE',
    [TICK_POLICIES.OFFICIAL_FIXING]: 'SOURCE_DEFINED_FIXING',
  })[policy] || null;
}

function timestampPrecision(text) {
  const values = precisionCandidates(text);
  return values.length === 1 ? values[0] : null;
}

function terminalTickPolicy(text) {
  const values = tickPolicyCandidates(text);
  return values.length === 1 ? values[0] : null;
}

function terminalTimeSemantics(text) {
  const precisions = precisionCandidates(text);
  const policies = tickPolicyCandidates(text);
  const conflicts = [];
  if (precisions.length > 1) conflicts.push('CONFLICTING_SOURCE_TIMESTAMP_PRECISION');
  if (policies.length > 1) conflicts.push('CONFLICTING_TERMINAL_TICK_POLICY');
  const precision = precisions.length === 1 ? precisions[0] : null;
  const tickPolicy = policies.length === 1 ? policies[0] : null;
  const missing = [];
  if (!precision) missing.push('SOURCE_TIMESTAMP_PRECISION');
  if (!tickPolicy) missing.push('TERMINAL_TICK_POLICY');
  const cutoffPolicy = cutoffPolicyForTickPolicy(tickPolicy);
  if (!cutoffPolicy) missing.push('CUTOFF_INCLUSIVITY');
  return {
    timestampPrecision: precision,
    terminalTickPolicy: tickPolicy,
    cutoffPolicy,
    conflicts,
    missing,
    certified: conflicts.length === 0 && missing.length === 0,
  };
}

function ruleEnvelope(document = {}) {
  if (document.schema === 'polymarket-rule-document-v1') {
    const market = document.market || {};
    const event = document.event || {};
    return {
      venue: 'POLYMARKET',
      contractId: market.conditionId || market.id || null,
      question: market.question || event.title || null,
      ruleText: [market.question, market.description, market.resolutionSource,
        event.description, event.resolutionSource].filter(Boolean).join('\n'),
      observationAt: market.endDate || event.endDate || null,
      raw: document,
    };
  }
  if (document.schema === 'crossvenue-polymarket-rule-v1') {
    return {
      venue: 'POLYMARKET', contractId: document.conditionId || document.gammaId || null,
      question: document.question || document.eventTitle || null,
      ruleText: [document.question, document.description, document.resolutionSource].filter(Boolean).join('\n'),
      observationAt: document.endDate || null, raw: document,
    };
  }
  if (document.schema === 'crossvenue-kalshi-rule-v1') {
    return {
      venue: 'KALSHI', contractId: document.ticker || null,
      question: document.title || document.yesSubTitle || null,
      ruleText: [document.title, document.yesSubTitle, document.rulesPrimary,
        document.rulesSecondary].filter(Boolean).join('\n'),
      observationAt: document.expectedExpirationTime || document.closeTime || null,
      raw: document,
    };
  }
  return {
    venue: document.venue || null,
    contractId: document.contractId || null,
    question: document.question || document.title || null,
    ruleText: [document.question, document.title, document.description,
      document.rulesPrimary, document.rulesSecondary, document.resolutionSource]
      .filter(Boolean).join('\n'),
    observationAt: document.observationAt || document.endDate || null,
    raw: document,
  };
}

function resolverCandidates(text) {
  const value = normalize(text);
  const found = [];
  if (/\bchainlink\b|data.chain.link/.test(value)) found.push('chainlink');
  if (/\bpyth\b|pyth.network/.test(value)) found.push('pyth');
  if (/\bcf benchmarks\b|\bbrti\b|cfbenchmarks.com/.test(value)) found.push('cf_benchmarks');
  if (/\bbinance\b|binance.com/.test(value)) found.push('binance');
  if (/\bcoinbase\b|coinbase.com/.test(value)) found.push('coinbase');
  if (/\bderibit\b|deribit.com/.test(value)) found.push('deribit');
  return unique(found);
}

function explicitTimezone(text) {
  const value = normalize(text);
  if (/\b(?:et|est|edt|eastern time)\b/.test(value)) return 'America/New_York';
  if (/\b(?:ct|cst|cdt|central time)\b/.test(value)) return 'America/Chicago';
  if (/\b(?:pt|pst|pdt|pacific time)\b/.test(value)) return 'America/Los_Angeles';
  if (/\b(?:utc|gmt)\b/.test(value)) return 'UTC';
  return null;
}

function isPriceRule(text) {
  const value = normalize(text);
  return /\b(?:price|value|report|tick|index|fixing|data stream|candle)\b/.test(value);
}

function classifyRuleDocument(document, metadata = {}) {
  const envelope = ruleEnvelope(document);
  const ruleText = envelope.ruleText;
  const resolvers = resolverCandidates(ruleText);
  const relevant = isPriceRule(ruleText) && resolvers.length > 0;
  const timing = terminalTimeSemantics(ruleText);
  const observationMs = Date.parse(envelope.observationAt || '');
  const timezone = explicitTimezone(ruleText);
  const missing = [...timing.missing];
  const conflicts = [...timing.conflicts];
  if (resolvers.length !== 1) {
    if (resolvers.length === 0) missing.push('RESOLVER_SOURCE');
    else conflicts.push('AMBIGUOUS_RESOLVER_SOURCE');
  }
  if (!Number.isFinite(observationMs)) missing.push('OBSERVATION_TIMESTAMP');
  if (!timezone) missing.push('OBSERVATION_TIMEZONE');
  const status = !relevant ? RULE_STATUS.NOT_RELEVANT
    : conflicts.length ? RULE_STATUS.CONFLICT
      : missing.length ? RULE_STATUS.UNKNOWN : RULE_STATUS.CERTIFIED;
  const identity = {
    venue: metadata.venue || envelope.venue,
    contractId: metadata.contractId || envelope.contractId,
    ruleHash: metadata.ruleHash || null,
    resolver: resolvers.length === 1 ? resolvers[0] : null,
    observationAt: Number.isFinite(observationMs) ? new Date(observationMs).toISOString() : null,
    timezone,
    timestampPrecision: timing.timestampPrecision,
    terminalTickPolicy: timing.terminalTickPolicy,
    cutoffPolicy: timing.cutoffPolicy,
  };
  return {
    auditVersion: AUDIT_VERSION,
    ...identity,
    question: envelope.question,
    relevant,
    status,
    missing: unique(missing).sort(),
    conflicts: unique(conflicts).sort(),
    independentUnitKey: status === RULE_STATUS.CERTIFIED
      ? `r07:${sha256(JSON.stringify(identity))}` : null,
  };
}

function finiteTime(value) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function tickHasProvenance(tick) {
  const monotonic = tick?.receiveMonotonicNs ?? tick?.receive_monotonic_ns;
  const epoch = tick?.connectionEpoch ?? tick?.connection_epoch;
  const sequence = tick?.eventSequence ?? tick?.event_sequence;
  return finiteTime(tick?.sourceTs ?? tick?.source_ts) != null
    && finiteTime(tick?.receivedAt ?? tick?.received_at) != null
    && monotonic != null && Number.isFinite(Number(monotonic))
    && epoch != null && Number.isFinite(Number(epoch))
    && sequence != null && Number.isFinite(Number(sequence));
}

function alignsWithPrecision(sourceMs, precision) {
  if (precision === 'second') return sourceMs % 1000 === 0;
  if (precision === 'minute') return sourceMs % 60000 === 0;
  // JavaScript timestamps cannot validate microseconds, but retaining a
  // millisecond value does not invent sub-millisecond precision.
  return precision === 'millisecond';
}

function selectTerminalTick(ticks, certification, decisionAt) {
  if (certification?.status !== RULE_STATUS.CERTIFIED) {
    return { selected: null, reason: 'RULE_TIME_SEMANTICS_NOT_CERTIFIED' };
  }
  const cutoffMs = finiteTime(certification.observationAt);
  const decisionMs = finiteTime(decisionAt);
  if (cutoffMs == null || decisionMs == null || decisionMs < cutoffMs) {
    return { selected: null, reason: 'CUTOFF_NOT_CAUSALLY_AVAILABLE' };
  }
  const causal = (Array.isArray(ticks) ? ticks : []).filter((tick) => {
    if (!tickHasProvenance(tick)) return false;
    const receivedMs = finiteTime(tick.receivedAt ?? tick.received_at);
    const sourceMs = finiteTime(tick.sourceTs ?? tick.source_ts);
    return receivedMs <= decisionMs
      && alignsWithPrecision(sourceMs, certification.timestampPrecision);
  }).map((tick) => ({
    tick,
    sourceMs: finiteTime(tick.sourceTs ?? tick.source_ts),
    receivedMs: finiteTime(tick.receivedAt ?? tick.received_at),
  })).sort((left, right) => left.sourceMs - right.sourceMs || left.receivedMs - right.receivedMs);
  const policy = certification.terminalTickPolicy;
  let selected = null;
  if (policy === TICK_POLICIES.LAST_AT_OR_BEFORE) {
    selected = [...causal].reverse().find((row) => row.sourceMs <= cutoffMs) || null;
  } else if (policy === TICK_POLICIES.LAST_BEFORE) {
    selected = [...causal].reverse().find((row) => row.sourceMs < cutoffMs) || null;
  } else if (policy === TICK_POLICIES.FIRST_AT_OR_AFTER) {
    selected = causal.find((row) => row.sourceMs >= cutoffMs) || null;
  } else if (policy === TICK_POLICIES.FIRST_AFTER) {
    selected = causal.find((row) => row.sourceMs > cutoffMs) || null;
  } else if (policy === TICK_POLICIES.EXACT) {
    selected = causal.find((row) => row.sourceMs === cutoffMs) || null;
  } else if (policy === TICK_POLICIES.NEAREST) {
    selected = causal.reduce((best, row) => !best
      || Math.abs(row.sourceMs - cutoffMs) < Math.abs(best.sourceMs - cutoffMs) ? row : best, null);
  } else {
    return { selected: null, reason: 'AGGREGATED_OR_FIXING_POLICY_REQUIRES_SPECIALIZED_REPLAY' };
  }
  if (!selected) return { selected: null, reason: 'NO_CAUSALLY_AVAILABLE_TERMINAL_TICK' };
  return {
    selected: selected.tick,
    reason: 'CERTIFIED_TERMINAL_TICK',
    sourceOffsetMs: selected.sourceMs - cutoffMs,
    receiveDelayFromCutoffMs: selected.receivedMs - cutoffMs,
  };
}

function summarizeAudit(rows, feedCoverage = [], options = {}) {
  const classified = rows.map((row) => classifyRuleDocument(
    row.rule_document || row.ruleDocument || row.document || {},
    { venue: row.venue, contractId: row.contract_id, ruleHash: row.rule_hash },
  ));
  const relevant = classified.filter((row) => row.relevant);
  const counts = Object.fromEntries(Object.values(RULE_STATUS).map((status) => [status, 0]));
  const missing = {};
  const conflicts = {};
  for (const row of classified) {
    counts[row.status] = (counts[row.status] || 0) + 1;
    for (const field of row.missing) missing[field] = (missing[field] || 0) + 1;
    for (const field of row.conflicts) conflicts[field] = (conflicts[field] || 0) + 1;
  }
  const certified = relevant.filter((row) => row.status === RULE_STATUS.CERTIFIED);
  const independent = new Set(certified.map((row) => row.independentUnitKey));
  const feedRows = feedCoverage.map((row) => {
    const observations = Number.parseInt(row.observations ?? row.n, 10) || 0;
    const withSourceTs = Number.parseInt(row.with_source_ts ?? row.source_ts_n, 10) || 0;
    const withMonotonic = Number.parseInt(row.with_monotonic ?? row.mono_n, 10) || 0;
    const withSequence = Number.parseInt(row.with_sequence ?? row.seq_n, 10) || 0;
    return {
      source: row.source, asset: row.asset, observations,
      sourceTimestampCoverage: observations ? withSourceTs / observations : 0,
      monotonicCoverage: observations ? withMonotonic / observations : 0,
      sequenceCoverage: observations ? withSequence / observations : 0,
      first: row.first || null, latest: row.latest || null,
    };
  });
  const statewiseProved = Number(options.statewiseProved || 0);
  const positiveDoubledCost = Number(options.positiveDoubledCost || 0);
  return {
    format: AUDIT_VERSION,
    generatedAt: options.generatedAt || new Date().toISOString(),
    boundedDays: Number(options.days || 30),
    scannedRuleDocuments: classified.length,
    relevantPriceResolverRules: relevant.length,
    statusCounts: counts,
    certifiedIndependentRuleCutoffSourceUnits: independent.size,
    missingDimensions: Object.fromEntries(Object.entries(missing).sort((a, b) => b[1] - a[1])),
    conflicts: Object.fromEntries(Object.entries(conflicts).sort((a, b) => b[1] - a[1])),
    feedCoverage: feedRows,
    statewiseProvedEpisodes: statewiseProved,
    positiveDoubledCostEpisodes: positiveDoubledCost,
    executableCapacityUsd: Number(options.executableCapacityUsd || 0),
    verdict: positiveDoubledCost > 0 ? 'CANDIDATES_REQUIRE_INDEPENDENT_REPLAY'
      : certified.length ? 'TIMING_RULES_EXIST_BUT_NO_STATEWISE_POSITIVE_ECONOMICS'
        : 'NO_MACHINE_CERTIFIED_TERMINAL_TICK_SEMANTICS',
    sampleCertified: certified.slice(0, 20),
    disclosure: 'An ISO endDate and a generic phrase such as price at the end do not certify resolver tick inclusion. Unknown semantics are excluded, not inferred.',
  };
}

module.exports = {
  AUDIT_VERSION,
  RULE_STATUS,
  TICK_POLICIES,
  classifyRuleDocument,
  cutoffPolicyForTickPolicy,
  explicitTimezone,
  precisionCandidates,
  resolverCandidates,
  ruleEnvelope,
  selectTerminalTick,
  summarizeAudit,
  terminalTickPolicy,
  terminalTimeSemantics,
  timestampPrecision,
  tickHasProvenance,
  tickPolicyCandidates,
};
