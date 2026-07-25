'use strict';

const crypto = require('node:crypto');
const { RELATION_TYPES, compilePayoffProof } = require('../research/payoff-proof');
const {
  optimizeEqualShareBundle, projectMarginalsFrankWolfe,
} = require('./bregman');
const {
  certifyStructuralRelation, createRuleDocument,
} = require('./rule-certifier');

const STRUCTURAL_UNIVERSE_VERSION = 'structural-certified-payoff-graph-v4-capacity';

function jsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) { return []; }
}

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numericLabel(value) {
  const normalized = String(value || '').toLowerCase().replace(/[$,]/g, '').replace(/pt/g, '.');
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  return match ? finite(match[0]) : null;
}

function rangeLabel(value) {
  const normalized = String(value || '').toLowerCase().replace(/[$,]/g, '').replace(/pt/g, '.');
  const values = (normalized.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  if (/^(?:under|below|<)/.test(normalized.trim()) && values.length) return { lower: null, upper: values[0] };
  if (/^(?:over|above|>)/.test(normalized.trim()) && values.length) return { lower: values[0], upper: null };
  return values.length >= 2 ? { lower: values[0], upper: values[1] } : null;
}

function thresholdOperator(value) {
  const normalized = String(value || '').toLowerCase();
  if (/\bat least\b|greater than or equal|\bnot less than\b|>=/.test(normalized)) return 'gte';
  if (/\bat most\b|less than or equal|\bnot more than\b|<=/.test(normalized)) return 'lte';
  if (/\babove\b|\bover\b|\bgreater than\b|\bmore than\b|>/.test(normalized)) return 'gt';
  if (/\bbelow\b|\bunder\b|\bless than\b|\bfewer than\b|</.test(normalized)) return 'lt';
  return null;
}

function priceSemantic(event, market, label) {
  const context = [event?.title, event?.description, market?.question, label]
    .filter(Boolean).join(' ').toLowerCase();
  const labelText = String(label || '').toLowerCase();
  const hasCurrency = /\$|\busd\b|\busdt\b/.test(context);
  const hasPriceNoun = /\b(price|closing price|close price|market cap|fdv)\b/.test(context);
  const hasCryptoAsset = /\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|doge|bnb|hype)\b/.test(context);
  const explicitlyNonPrice = /\b(margin|vote share|percent|percentage|minutes?|hours?|days?|seen by|announced by|released by|before|after)\b/.test(context)
    || /%/.test(labelText);
  // Semantic exclusions take precedence over incidental currency strings in
  // generic settlement prose (for example, "$1 if Yes"). The previous order
  // allowed date ladders and election-margin bands to masquerade as price
  // thresholds whenever their descriptions mentioned the $1 payout.
  if (explicitlyNonPrice) return false;
  // A currency-labelled threshold is sufficient only after the exclusions.
  // Otherwise require both a known crypto asset and an explicit price noun.
  return hasCurrency || (hasCryptoAsset && hasPriceNoun);
}

function thresholdSemantic(event, market, label) {
  const value = numericLabel(label);
  if (value == null || !priceSemantic(event, market, label)) return null;
  const operator = thresholdOperator(`${market?.question || ''} ${event?.title || ''} ${label || ''}`);
  if (!operator) return null;
  return {
    kind: 'price_threshold', value, operator,
    direction: ['gt', 'gte'].includes(operator) ? 'ABOVE' : 'BELOW',
  };
}

function rangeSemantic(event, market, label) {
  if (!priceSemantic(event, market, label)) return null;
  const range = rangeLabel(label);
  return range ? { kind: 'price_range', ...range } : null;
}

function explicitTrue(value) {
  return value === true || String(value).toLowerCase() === 'true';
}

function normalizeSemanticText(value) {
  return String(value || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9.+/-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function isSportsEvent(event) {
  return (event?.tags || []).some((tag) => String(tag?.id) === '1'
    || String(tag?.slug || '').toLowerCase() === 'sports');
}

function rulesFingerprint(market) {
  const description = normalizeSemanticText(market?.description || market?.rules || '');
  if (!description) return null;
  return description
    .replace(/[+-]?\d+(?:\.\d+)?/g, '#')
    .replace(/\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/g, 'month');
}

function sportsTotalSemantic(event, market, outcomes) {
  if (!isSportsEvent(event)) return null;
  const overIndex = outcomes.findIndex((outcome) => /^over(?:\s|$)/i.test(String(outcome)));
  const underIndex = outcomes.findIndex((outcome) => /^under(?:\s|$)/i.test(String(outcome)));
  if (overIndex < 0 || underIndex < 0) return null;
  const text = String(market?.question || market?.groupItemTitle || '');
  const threshold = finite(text.match(/(?:o\s*\/\s*u|over\s*\/\s*under)\s*([0-9]+(?:\.\d+)?)/i)?.[1]
    || outcomes.map((outcome) => String(outcome).match(/(?:over|under)\s*([0-9]+(?:\.\d+)?)/i)?.[1]).find(Boolean));
  if (!(threshold > 0)) return null;
  const scope = normalizeSemanticText(text)
    .replace(/(?:o\s*\/\s*u|over\s*\/\s*under)\s*[0-9]+(?:\.[0-9]+)?/g, 'o/u #')
    .replace(/\b(over|under)\s*[0-9]+(?:\.[0-9]+)?\b/g, '$1 #');
  return {
    kind: 'sports_total', threshold, scopeKey: scope,
    positiveIndex: overIndex, negativeIndex: underIndex,
    positiveLabel: String(outcomes[overIndex]), negativeLabel: String(outcomes[underIndex]),
    rulesKey: rulesFingerprint(market),
  };
}

function sportsSpreadSemantic(event, market, outcomes) {
  if (!isSportsEvent(event)) return null;
  const text = String(market?.question || market?.groupItemTitle || '');
  if (!/\b(?:spread|handicap)\b/i.test(text)) return null;
  const handicapMatch = /\(([+-]\d+(?:\.\d+)?)\)/.exec(text);
  if (!handicapMatch) return null;
  const handicap = finite(handicapMatch[1]);
  if (handicap == null) return null;
  const before = normalizeSemanticText(text.slice(0, handicapMatch.index));
  const normalizedOutcomes = outcomes.map(normalizeSemanticText);
  // The participant immediately preceding the first signed handicap must
  // identify one and only one outcome. Ambiguous abbreviations fail closed.
  const matches = normalizedOutcomes.map((outcome, index) => ({ outcome, index }))
    .filter(({ outcome }) => outcome && (before.endsWith(outcome) || before.includes(` ${outcome} `)));
  if (matches.length !== 1) return null;
  const positiveIndex = matches[0].index;
  const negativeIndex = positiveIndex === 0 ? 1 : 0;
  const participant = normalizedOutcomes[positiveIndex];
  const metricScope = before.replace(participant, '').replace(/\s+/g, ' ').trim();
  if (!metricScope) return null;
  return {
    kind: 'sports_spread', handicap,
    scopeKey: `${metricScope}|participant:${participant}`,
    metricScope, participant,
    positiveIndex, negativeIndex,
    positiveLabel: String(outcomes[positiveIndex]), negativeLabel: String(outcomes[negativeIndex]),
    rulesKey: rulesFingerprint(market),
  };
}

function normalizedMarket(event, market) {
  const outcomes = jsonArray(market?.outcomes);
  const tokenIds = jsonArray(market?.clobTokenIds);
  if (outcomes.length !== 2 || tokenIds.length !== outcomes.length) return null;
  const literalYes = outcomes.findIndex((value) => /^yes$/i.test(String(value)));
  const literalNo = outcomes.findIndex((value) => /^no$/i.test(String(value)));
  const total = sportsTotalSemantic(event, market, outcomes);
  const spread = total ? null : sportsSpreadSemantic(event, market, outcomes);
  const sportsSemantic = total || spread;
  const yes = sportsSemantic?.positiveIndex ?? (literalYes >= 0 ? literalYes : 0);
  const no = sportsSemantic?.negativeIndex ?? (literalNo >= 0 ? literalNo : (yes === 0 ? 1 : 0));
  if (yes === no || !tokenIds[yes] || !tokenIds[no]) return null;
  const label = market.groupItemTitle || market.question || '';
  const threshold = sportsSemantic ? null : thresholdSemantic(event, market, label);
  const priceRange = threshold ? null : rangeSemantic(event, market, label);
  const feesEnabled = market?.feesEnabled === true || market?.fees_enabled === true;
  const scheduledFeeRate = finite(market?.feeSchedule?.rate ?? market?.fee_schedule?.rate
    ?? market?.fee_rate);
  const scheduledFeeExponent = finite(market?.feeSchedule?.exponent
    ?? market?.fee_schedule?.exponent);
  const rule = createRuleDocument(event, market);
  return {
    eventId: String(event?.id ?? event?.slug ?? ''),
    eventSlug: event?.slug || null,
    eventTitle: event?.title || null,
    gammaId: String(market?.id ?? ''),
    conditionId: market?.conditionId || null,
    question: market?.question || null,
    endDate: market?.endDate || event?.endDate || null,
    yesToken: String(tokenIds[yes]),
    noToken: String(tokenIds[no]),
    positiveLabel: String(outcomes[yes]),
    negativeLabel: String(outcomes[no]),
    literalYesNo: literalYes >= 0 && literalNo >= 0,
    strike: threshold?.value ?? null,
    thresholdOperator: threshold?.operator ?? null,
    thresholdDirection: threshold?.direction ?? null,
    range: priceRange ? { lower: priceRange.lower, upper: priceRange.upper } : null,
    sportsSemantic,
    universeClass: isSportsEvent(event) ? 'sports' : (threshold || priceRange ? 'crypto_ordered' : 'general_binary'),
    negRisk: explicitTrue(event?.negRisk) || explicitTrue(market?.negRisk),
    negRiskAugmented: explicitTrue(event?.negRiskAugmented),
    negRiskOther: explicitTrue(market?.negRiskOther),
    accepting: market?.active !== false && market?.closed !== true && market?.acceptingOrders !== false,
    feesEnabled,
    // Fee schedules are market metadata and may change. A fee-enabled market
    // with absent metadata must fail closed; a remembered category constant is
    // not an executable fee quote.
    feeRate: feesEnabled ? scheduledFeeRate : 0,
    feeExponent: feesEnabled ? scheduledFeeExponent : 1,
    feeScheduleKnown: !feesEnabled || (scheduledFeeRate != null && scheduledFeeRate >= 0
      && scheduledFeeExponent != null && scheduledFeeExponent > 0),
    feeSource: feesEnabled ? 'gamma_fee_schedule' : 'fee_free',
    orderMinSize: finite(market?.orderMinSize) ?? finite(market?.minimum_order_size)
      ?? finite(market?.min_order_size),
    ruleHash: rule.ruleHash,
    ruleDocument: rule.document,
  };
}

function candidateId(type, eventId, legs, certificationHash) {
  // Include the frozen universe version so historical evaluations can never
  // be silently relabelled by an upsert after parser or proof changes.
  const identity = `${STRUCTURAL_UNIVERSE_VERSION}|${type}|${eventId}|${certificationHash}|${legs.map((entry) => `${entry.gammaId}:${entry.outcome}`).sort().join('|')}`;
  return `sg_${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
}

function makeCandidate(type, event, markets, legs, payoffProof, complete = true) {
  if (!payoffProof?.valid) throw new Error(`candidate ${type} is missing a valid payoff proof`);
  const certification = certifyStructuralRelation({ type, event, markets, payoffProof });
  const certifiedProof = { ...payoffProof, ruleCertification: certification };
  return {
    candidateId: candidateId(type, String(event?.id ?? event?.slug ?? ''), legs,
      certification.certificationHash),
    structureType: type,
    eventId: String(event?.id ?? event?.slug ?? ''),
    eventSlug: event?.slug || null,
    eventTitle: event?.title || null,
    endDate: event?.endDate || legs[0]?.endDate || null,
    complete,
    states: payoffProof.terminalStates.map((state) => state.label),
    payoffVector: payoffProof.payoffVector,
    guaranteedMinPayout: payoffProof.guaranteedMinPayout,
    payoffProof: certifiedProof,
    ruleCertification: certification,
    ruleDocuments: markets.map((market) => ({
      ruleHash: market.ruleHash, eventId: market.eventId, gammaId: market.gammaId,
      conditionId: market.conditionId, document: market.ruleDocument,
    })),
    atomic: false,
    universeId: STRUCTURAL_UNIVERSE_VERSION,
    universeClass: legs.some((entry) => entry.universeClass === 'sports')
      ? 'sports' : legs[0]?.universeClass || 'general_binary',
    legs,
  };
}

function leg(market, outcome) {
  return {
    predicateId: market.gammaId,
    gammaId: market.gammaId,
    conditionId: market.conditionId,
    question: market.question,
    outcome,
    tokenId: outcome === 'YES' ? market.yesToken : market.noToken,
    outcomeLabel: outcome === 'YES' ? market.positiveLabel : market.negativeLabel,
    universeClass: market.universeClass,
    semantic: market.sportsSemantic || null,
    feeRate: market.feeRate,
    feeExponent: market.feeExponent,
    feeScheduleKnown: market.feeScheduleKnown,
    feeSource: market.feeSource,
    orderMinSize: market.orderMinSize,
    ruleHash: market.ruleHash,
  };
}

function disjoint(left, right) {
  return (left?.upper != null && right?.lower != null && left.upper <= right.lower)
    || (right?.upper != null && left?.lower != null && right.upper <= left.lower);
}

function buildConditionGraph(events) {
  const candidates = [];
  for (const event of Array.isArray(events) ? events : []) {
    const markets = (event?.markets || []).map((market) => normalizedMarket(event, market))
      .filter((market) => market?.accepting);
    if (!markets.length) continue;

    // Every binary market supplies the exact YES+NO=1 identity. Recording it
    // across the broad crypto universe provides a capacity/latency control.
    for (const market of markets) {
      const legs = [leg(market, 'YES'), leg(market, 'NO')];
      const proof = compilePayoffProof({
        relationType: RELATION_TYPES.UNCONSTRAINED_BINARY,
        variables: [market.gammaId], legs,
      });
      candidates.push(makeCandidate('binary_complement', event,
        [market], legs, proof));
    }

    const thresholds = markets.filter((market) => market.strike != null && market.range == null)
      .sort((left, right) => left.strike - right.strike);
    for (let low = 0; low < thresholds.length - 1; low += 1) {
      for (let high = low + 1; high < thresholds.length; high += 1) {
        if (!(thresholds[low].strike < thresholds[high].strike)) continue;
        if (thresholds[low].thresholdDirection !== thresholds[high].thresholdDirection) continue;
        let legs; let variables;
        if (thresholds[low].thresholdDirection === 'ABOVE') {
          // YES(high) implies YES(low), so YES(low)+NO(high) pays at least 1.
          legs = [leg(thresholds[low], 'YES'), leg(thresholds[high], 'NO')];
          variables = [thresholds[high].gammaId, thresholds[low].gammaId];
        } else {
          // YES(low) implies YES(high), so NO(low)+YES(high) pays at least 1.
          legs = [leg(thresholds[low], 'NO'), leg(thresholds[high], 'YES')];
          variables = [thresholds[low].gammaId, thresholds[high].gammaId];
        }
        const proof = compilePayoffProof({
          relationType: RELATION_TYPES.IMPLIES, variables, legs,
        });
        candidates.push(makeCandidate('nested_threshold', event,
          [thresholds[low], thresholds[high]], legs, proof));
      }
    }

    const ranges = markets.filter((market) => market.range != null);
    for (let left = 0; left < ranges.length - 1; left += 1) {
      for (let right = left + 1; right < ranges.length; right += 1) {
        if (!disjoint(ranges[left].range, ranges[right].range)) continue;
        const legs = [leg(ranges[left], 'NO'), leg(ranges[right], 'NO')];
        const proof = compilePayoffProof({
          relationType: RELATION_TYPES.MUTUALLY_EXCLUSIVE,
          variables: [ranges[left].gammaId, ranges[right].gammaId], legs,
        });
        candidates.push(makeCandidate('disjoint_ranges', event,
          [ranges[left], ranges[right]], legs, proof));
      }
    }

    const orderedSportsGroups = new Map();
    for (const market of markets.filter((entry) => entry.sportsSemantic?.rulesKey)) {
      const semantic = market.sportsSemantic;
      const key = `${semantic.kind}|${semantic.scopeKey}|${semantic.rulesKey}`;
      const group = orderedSportsGroups.get(key) || [];
      group.push(market); orderedSportsGroups.set(key, group);
    }
    for (const group of orderedSportsGroups.values()) {
      if (group.length < 2) continue;
      const kind = group[0].sportsSemantic.kind;
      if (kind === 'sports_total') {
        const ladder = group.sort((left, right) =>
          left.sportsSemantic.threshold - right.sportsSemantic.threshold);
        for (let low = 0; low < ladder.length - 1; low += 1) {
          for (let high = low + 1; high < ladder.length; high += 1) {
            if (!(ladder[low].sportsSemantic.threshold < ladder[high].sportsSemantic.threshold)) continue;
            // Over(high) implies Over(low): buy Over(low) + Under(high).
            const legs = [leg(ladder[low], 'YES'), leg(ladder[high], 'NO')];
            const proof = compilePayoffProof({
              relationType: RELATION_TYPES.IMPLIES,
              variables: [ladder[high].gammaId, ladder[low].gammaId], legs,
            });
            candidates.push(makeCandidate('sports_total_ladder', event,
              [ladder[low], ladder[high]], legs, proof));
          }
        }
      } else if (kind === 'sports_spread') {
        // For the same participant/statistic, covering the lower handicap is
        // stricter: P(h_strict) => P(h_lenient) when h_strict < h_lenient.
        const ladder = group.sort((left, right) =>
          left.sportsSemantic.handicap - right.sportsSemantic.handicap);
        for (let strict = 0; strict < ladder.length - 1; strict += 1) {
          for (let lenient = strict + 1; lenient < ladder.length; lenient += 1) {
            if (!(ladder[strict].sportsSemantic.handicap < ladder[lenient].sportsSemantic.handicap)) continue;
            const legs = [leg(ladder[lenient], 'YES'), leg(ladder[strict], 'NO')];
            const proof = compilePayoffProof({
              relationType: RELATION_TYPES.IMPLIES,
              variables: [ladder[strict].gammaId, ladder[lenient].gammaId], legs,
            });
            candidates.push(makeCandidate('sports_spread_ladder', event,
              [ladder[lenient], ladder[strict]], legs, proof));
          }
        }
      }
    }

    // negRisk is the venue's explicit mutually-exclusive event mechanism. Do
    // not infer exhaustiveness from titles or a hand-built market subset.
    const explicitlyComplete = markets.length === (event?.markets || []).length
      && markets.length >= 2 && markets.every((market) => market.negRisk && market.literalYesNo);
    if (explicitlyComplete) {
      const legs = markets.map((market) => leg(market, 'YES'));
      const proof = compilePayoffProof({
        relationType: RELATION_TYPES.EXACTLY_ONE,
        variables: markets.map((market) => market.gammaId), legs,
      });
      candidates.push(makeCandidate('complete_mutually_exclusive_set', event,
        markets, legs, proof, true));
    }
  }
  return [...new Map(candidates.map((candidate) => [candidate.candidateId, candidate])).values()];
}

function feePerShare(price, multiplier = 2, feeRate = null, feeExponent = null) {
  const p = finite(price);
  const m = finite(multiplier);
  const r = finite(feeRate);
  const e = finite(feeExponent);
  if (!(p > 0 && p < 1) || !(m >= 0) || !(r >= 0) || !(e > 0)) return null;
  return m * r * Math.pow(p * (1 - p), e);
}

function evaluateCandidate(candidate, books, nowMs, options = {}) {
  const staleMs = Number(options.staleMs ?? 2000);
  const targetNotionalUsd = Number(options.targetNotionalUsd ?? 10);
  const minCapacityProfitUsd = Number(options.minCapacityProfitUsd ?? 0.05);
  const legStates = candidate.legs.map((candidateLeg) => {
    const book = books.get(candidateLeg.tokenId);
    return {
      ...candidateLeg,
      ask: finite(book?.asks?.[0]?.[0]),
      askSize: finite(book?.asks?.[0]?.[1]),
      bid: finite(book?.bids?.[0]?.[0]),
      bidSize: finite(book?.bids?.[0]?.[1]),
      asks: Array.isArray(book?.asks) ? book.asks : [],
      bids: Array.isArray(book?.bids) ? book.bids : [],
      minimumOrderSize: finite(book?.minOrderSize) ?? finite(candidateLeg.orderMinSize),
      bookAt: finite(book?.at),
      bookSource: book?.src || null,
    };
  });
  const passRuleCertification = candidate.ruleCertification?.valid === true
    && Boolean(candidate.ruleCertification?.certificationHash);
  const passProof = candidate.payoffProof?.valid === true
    && Boolean(candidate.payoffProof?.proofHash)
    && finite(candidate.guaranteedMinPayout) > 0
    && passRuleCertification;
  const passStale = legStates.every((entry) => entry.bookAt != null && nowMs - entry.bookAt <= staleMs);
  const passQuotes = legStates.every((entry) => entry.ask > 0.001 && entry.ask < 0.999 && entry.askSize > 0);
  const passFeeSchedule = legStates.every((entry) => entry.feeScheduleKnown === true
    && entry.feeRate != null && entry.feeRate >= 0
    && entry.feeExponent != null && entry.feeExponent > 0);
  const passVenueMinimum = legStates.every((entry) => entry.minimumOrderSize != null
    && entry.minimumOrderSize > 0);
  const costPerBundle = passQuotes ? legStates.reduce((sum, entry) => sum + entry.ask, 0) : null;
  const fees2xPerBundle = passQuotes && passFeeSchedule ? legStates.reduce((sum, entry) => sum
    + feePerShare(entry.ask, 2, entry.feeRate, entry.feeExponent), 0) : null;
  const residual2xPerBundle = passQuotes && passFeeSchedule
    ? candidate.guaranteedMinPayout - costPerBundle - fees2xPerBundle : null;
  const passFees2x = passProof && residual2xPerBundle != null && residual2xPerBundle > 0;
  const optimized = passQuotes && passFeeSchedule && passVenueMinimum ? optimizeEqualShareBundle({
    legs: legStates.map((entry) => ({
      asks: entry.asks, bids: entry.bids,
      feeRate: entry.feeRate, feeExponent: entry.feeExponent,
      minOrderSize: entry.minimumOrderSize,
    })),
    guaranteedMinPayout: candidate.guaranteedMinPayout,
    budgetUsd: targetNotionalUsd,
    feeMultiplier: 2,
  }) : null;
  const displayedBundleShares = optimized?.shares || 0;
  const displayedNotionalUsd = optimized?.cashRequired || 0;
  const displayedProfit2xUsd = Math.max(0, optimized?.guaranteedProfit || 0);
  const targetShares = optimized?.shares || 0;
  const passFok = optimized != null;
  const passCapacity = displayedProfit2xUsd >= minCapacityProfitUsd;
  const fallbackOrphanLoss = passQuotes && passFeeSchedule && targetShares > 0
    ? Math.max(...legStates.map((entry) => targetShares * (entry.ask
      + feePerShare(entry.ask, 2, entry.feeRate, entry.feeExponent)))) : null;
  const orphanLossStressUsd = optimized?.worstOrphanUnwindPnl != null
    ? Math.max(0, -optimized.worstOrphanUnwindPnl) : fallbackOrphanLoss;
  let bregman = null;
  if (passQuotes && legStates.every((entry) => entry.bid > 0 && entry.bid < 1)
    && candidate.payoffProof?.terminalStates?.length) {
    try {
      const statePayoffs = candidate.payoffProof.terminalStates.map((state) =>
        candidate.legs.map((entry) => {
          const truth = state.values?.[entry.predicateId];
          return entry.outcome === 'YES' ? (truth ? 1 : 0) : (truth ? 0 : 1);
        }));
      const quotedMarginals = legStates.map((entry) => (entry.bid + entry.ask) / 2);
      bregman = projectMarginalsFrankWolfe({ statePayoffs, quotedMarginals });
    } catch (_) { bregman = null; }
  }
  const passOrphanRisk = candidate.atomic === true;
  return {
    candidateId: candidate.candidateId,
    evaluatedAt: new Date(nowMs).toISOString(),
    structureType: candidate.structureType,
    guaranteedMinPayout: candidate.guaranteedMinPayout,
    costPerBundle,
    fees2xPerBundle,
    residual2xPerBundle,
    targetNotionalUsd,
    targetShares,
    displayedBundleShares,
    displayedNotionalUsd,
    displayedProfit2xUsd,
    passStale,
    passProof,
    passRuleCertification: Boolean(passRuleCertification),
    ruleCertificationHash: candidate.ruleCertification?.certificationHash || null,
    ruleCertificationChecks: candidate.ruleCertification?.checks || ['MISSING_RULE_CERTIFICATION'],
    payoffProofHash: candidate.payoffProof?.proofHash || null,
    payoffRelationType: candidate.payoffProof?.relationType || null,
    passQuotes,
    passFeeSchedule,
    passVenueMinimum,
    passFees2x,
    passFok,
    passCapacity,
    passOrphanRisk,
    orphanLossStressUsd,
    atomic: candidate.atomic,
    qualified: passProof && passStale && passQuotes && passFeeSchedule && passVenueMinimum
      && passFees2x && passFok && passCapacity && passOrphanRisk,
    economicCandidate: passProof && passStale && passQuotes && passFeeSchedule && passVenueMinimum
      && passFees2x && passFok && passCapacity,
    executionOptimization: optimized,
    bregman,
    legs: legStates,
  };
}

module.exports = {
  buildConditionGraph, evaluateCandidate, feePerShare, jsonArray, numericLabel,
  rangeLabel, rulesFingerprint, sportsSpreadSemantic, sportsTotalSemantic,
  thresholdOperator, thresholdSemantic, STRUCTURAL_UNIVERSE_VERSION,
};
