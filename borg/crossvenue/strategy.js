'use strict';

const {
  feeForFills: kalshiFeeForFills,
  roundUpCenticent,
} = require('./kalshi-fees');

/**
 * Pure helpers for the Polymarket/Kalshi cross-venue laboratory.
 *
 * Prices are binary-contract dollars on [0,1] and sizes are contracts/shares.
 * This module has no wallet, exchange client, database, or network dependency.
 */

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'at', 'be', 'before', 'by', 'contract', 'during',
  'event', 'for', 'from', 'in', 'is', 'it', 'market', 'no', 'of', 'on', 'or',
  'the', 'this', 'to', 'will', 'win', 'yes',
]);

const IDENTITY_FEATURE_CACHE = {
  poly: new WeakMap(),
  kalshi: new WeakMap(),
};

function finite(value, fallback = null) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9.%$]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function tokens(value) {
  return [...new Set(normalizeText(value).split(' ')
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token) && !/^\d+$/.test(token)))];
}

function numericSignature(value) {
  const matches = normalizeText(value).match(/\$?\d[\d,.]*(?:\.\d+)?%?/g) || [];
  return [...new Set(matches.map((raw) => {
    const percentage = raw.endsWith('%');
    const parsed = parseFloat(raw.replace(/[$,%]/g, ''));
    return Number.isFinite(parsed) ? `${percentage ? 'pct:' : 'num:'}${parsed}` : null;
  }).filter(Boolean))].sort();
}

function domains(value) {
  const found = [];
  const regex = /https?:\/\/([^\s/)]+)/gi;
  let match;
  while ((match = regex.exec(String(value || '')))) {
    found.push(match[1].toLowerCase().replace(/^www\./, ''));
  }
  return [...new Set(found)].sort();
}

function jaccard(left, right) {
  const a = new Set(left); const b = new Set(right);
  const union = new Set([...a, ...b]);
  if (!union.size) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / union.size;
}

function sameSet(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function predicateSignature(value) {
  const text = normalizeText(value);
  if (/\bexact score\b/.test(text)) return 'exact_score';
  if (/\bfirst song\b|\bsong (?:is )?played first\b/.test(text)) return 'first_song';
  if (/\bwill .* vote to confirm\b|\bindividual vote\b/.test(text)) return 'individual_vote';
  if (/\bannouncers? say\b|\bmentioned during\b/.test(text)) return 'spoken_mention';
  if (/\bgo to extra time\b|\breach extra time\b/.test(text)) return 'go_to_extra_time';
  if (/\bwin in extra time\b|\bwin in (?:a )?penalty shootout\b/.test(text)) return 'extra_time_winner';
  if (/\bend in a draw\b|\bmatch (?:ends? in a )?draw\b|\btied after\b/.test(text)) return 'draw';
  if (/\bfirst 5 innings\b|\bfirst five innings\b|\bafter 5 innings\b/.test(text)) return 'first_five_result';
  if (/\bhalf ?time\b|\bleading at halftime\b/.test(text)) return 'halftime_result';
  if (/\bsecond half\b/.test(text)) return 'second_half_result';
  if (/\bscore first\b|\bfirst team to score\b|\bneither team to score first\b/.test(text)) return 'first_to_score';
  if (/\badvance(?:s|d)?\b|\bto advance\b/.test(text)) return 'advancement';
  if (/\bstarts? for\b|\bstarting lineup\b/.test(text)) return 'starter';
  const playerStat = text.match(/\b(shots?|goals?|assists?|tackles?|saves?|passes|touches|rebounds?|points|strikeouts?|hits?|runs?)\b/);
  if (playerStat && /\b\d+\b|\bat least\b|\bmore than\b/.test(text)) {
    return `player_stat:${playerStat[1].replace(/s$/, '')}`;
  }
  if (/\bperform(?:s|ed)?\b|\bhalftime show\b/.test(text)) return 'performance';
  if (/\battend(?:s|ed|ance)?\b|\bin physical attendance\b/.test(text)) return 'attendance';
  if (/\b#?2\b.*\bnetflix\b|\brunner ?up\b.*\bnetflix\b|\bnetflix\b.*\b#?2\b/.test(text)) return 'rank:2';
  if (/\b#?1\b.*\bnetflix\b|\btop (?:us |global )?netflix\b|\bnetflix\b.*\b#?1\b/.test(text)) return 'rank:1';
  if (/\bat least\b|\bat most\b|\babove\b|\bbelow\b|\bgreater than\b|\bless than\b|\bor longer\b/.test(text)) return 'threshold';
  const top = text.match(/\b(?:finish(?:es|ed)?\s+)?(?:in\s+the\s+)?top\s+(\d+)\b/);
  if (top) return `finish_top:${parseInt(top[1], 10)}`;
  if (/\bmake(?:s| the)? cut\b/.test(text)) return 'make_cut';
  if (/\bfirst inning run\b|\brun scored in the first inning\b/.test(text)) return 'first_inning_run';
  if (/\bround leader\b|\blead(?:er)? after round\b/.test(text)) return 'round_leader';
  if (/\bhead to head\b|\bh2h\b/.test(text)) return 'head_to_head';
  if (/\bwin(?:s|ner)?\b|\bchampion\b/.test(text)) return 'winner';
  return null;
}

function thresholdOperator(value) {
  const text = normalizeText(value);
  if (/\bat least\b|\bgreater than or equal\b|\bnot less than\b/.test(text)) return 'gte';
  if (/\bat most\b|\bless than or equal\b|\bnot more than\b/.test(text)) return 'lte';
  if (/\babove\b|\bgreater than\b|\bmore than\b/.test(text)) return 'gt';
  if (/\bbelow\b|\bless than\b|\bfewer than\b/.test(text)) return 'lt';
  return null;
}

function sportSignature(value) {
  const text = normalizeText(value);
  if (/\bbaseball\b|\bmlb\b/.test(text)) return 'baseball';
  if (/\bsoccer\b|\bfootball\b|\bnwsl\b|nwslsoccer|\bmls\b|\bliga mx\b|\bpremier league\b|\buefa\b/.test(text)) return 'soccer';
  if (/\bgolf\b|\bpga\b/.test(text)) return 'golf';
  if (/\btennis\b|\batp\b|\bwta\b/.test(text)) return 'tennis';
  if (/\bbasketball\b|\bnba\b|\bwnba\b/.test(text)) return 'basketball';
  if (/\bhockey\b|\bnhl\b/.test(text)) return 'hockey';
  if (/\bcricket\b/.test(text)) return 'cricket';
  return null;
}

function netflixDimensions(value) {
  const text = normalizeText(value);
  if (!/\bnetflix\b/.test(text)) return null;
  return {
    region: /\bglobal\b/.test(text) ? 'global'
      : /\bunited states\b|\bus netflix\b|\bnetflix top 10 us\b/.test(text) ? 'us' : null,
    media: /\bmovies?\b/.test(text) ? 'movie' : /\bshows?\b|\btv\b/.test(text) ? 'show' : null,
  };
}

const OUTCOME_BOILERPLATE = new Set([
  'above', 'advance', 'advances', 'first', 'five', 'inning', 'innings', 'reg',
  'regular', 'start', 'starts', 'time', 'win', 'winner', 'winning', 'wins',
]);

function outcomeEntityTokens(value) {
  const normalized = normalizeText(value);
  if (!normalized || /^(?:tie|draw|other|above|below)\b/.test(normalized)) return [];
  const withoutSuffix = normalized
    .replace(/\bstarts? for\b.*$/, '')
    .replace(/\bwins? (?:the )?first (?:5|five) innings?\b.*$/, '')
    .replace(/\badvance(?:s|d)?\b.*$/, '')
    .replace(/^reg(?:ular)? time\s+/, '');
  return tokens(withoutSuffix).filter((token) => !OUTCOME_BOILERPLATE.has(token));
}

function outcomeParticipantMatches(poly, kalshi, polyFeatures = null, kalshiFeatures = null) {
  const yes = kalshiFeatures?.yesNormalized ?? normalizeText(kalshi.yesSubTitle);
  if (!yes) return true;
  const polyQuestion = polyFeatures?.questionNormalized ?? normalizeText(poly.question);
  if (/^(?:tie|draw)\b/.test(yes)) return /\btie(?:d)?\b|\bdraw\b/.test(polyQuestion);
  if (/^(?:above|below)\b/.test(yes)) return true;
  const entity = kalshiFeatures?.outcomeEntity ?? outcomeEntityTokens(kalshi.yesSubTitle);
  if (!entity.length) return true;
  const question = polyFeatures?.questionTokens ?? new Set(tokens(poly.question));
  const overlap = entity.filter((token) => question.has(token)).length;
  if (entity.length === 1) return overlap === 1;
  if (entity.length === 2) return overlap === 2;
  return overlap >= 2 && overlap / entity.length >= 0.5;
}

function explicitRuleMismatchesNormalized(p, k) {
  const mismatches = [];
  const polyPostponedBinary = /postponed.*remain open/.test(p)
    && /cancel(?:led|ed) entirely.*resolve (?:to )?no/.test(p);
  const kalshiFairCancellation = /cancel(?:led|ed).*rescheduled.*over two weeks.*fair price/.test(k);
  const polyNonFairCancellation = /cancel(?:led|ed)/.test(p) && !/fair (?:market )?price/.test(p);
  if ((polyPostponedBinary || polyNonFairCancellation) && kalshiFairCancellation) {
    mismatches.push('CANCELLATION_RESCHEDULE_RULE_MISMATCH');
  }
  if (/no make up game.*resolve 50 50/.test(p) && !/no make up game.*50 50/.test(k)) {
    mismatches.push('CANCELLATION_PAYOUT_MISMATCH');
  }
  if (/update does not occur by/.test(p) && !/update does not occur by/.test(k)) {
    mismatches.push('PUBLICATION_FAILURE_DEADLINE_MISMATCH');
  }
  if (/no winner is announced by/.test(p) && /resolve to other/.test(p)
    && !/no winner is announced by/.test(k)) {
    mismatches.push('NO_RESULT_DEADLINE_MISMATCH');
  }
  if (/no .* is announced.*resolve to other/.test(p) && !/no .* is announced.*resolve to other/.test(k)) {
    mismatches.push('NO_ANNOUNCEMENT_DEADLINE_MISMATCH');
  }
  if (/multiple winners.*alphabet/.test(p) && !/multiple winners.*alphabet/.test(k)) {
    mismatches.push('MULTIPLE_WINNER_RULE_MISMATCH');
  }
  if (/tie for winner.*alphabet|cancellation or a tie.*alphabet/.test(p)
    && !/tie for winner.*alphabet|cancellation or a tie.*alphabet/.test(k)) {
    mismatches.push('TIE_OR_CANCELLATION_RULE_MISMATCH');
  }
  if (/if no nominee is announced by/.test(p) && !/if no nominee is announced by/.test(k)) {
    mismatches.push('NO_NOMINEE_DEADLINE_MISMATCH');
  }
  return [...new Set(mismatches)];
}

function explicitRuleMismatches(polyText, kalshiText) {
  return explicitRuleMismatchesNormalized(normalizeText(polyText), normalizeText(kalshiText));
}

function contractText(market, venue) {
  if (venue === 'poly') {
    return [market.question, market.eventTitle, market.description, market.resolutionSource]
      .filter(Boolean).join(' ');
  }
  return [market.title, market.eventTitle, market.eventSubTitle, market.subtitle,
    market.yesSubTitle, market.rulesPrimary, market.rulesSecondary,
    ...(market.settlementSources || []).map((row) => typeof row === 'string'
      ? row : row?.url || row?.name || '')].filter(Boolean).join(' ');
}

function identityFeatures(market, venue) {
  const cache = IDENTITY_FEATURE_CACHE[venue];
  if (market && typeof market === 'object' && cache.has(market)) return cache.get(market);
  const title = venue === 'poly'
    ? [market.question, market.eventTitle].filter(Boolean).join(' ')
    : [market.title, market.eventTitle, market.eventSubTitle,
      market.subtitle, market.yesSubTitle].filter(Boolean).join(' ');
  const fullText = contractText(market, venue);
  const predicateInput = venue === 'poly' ? title
    : [market.rulesPrimary, market.title, market.yesSubTitle].filter(Boolean).join(' ');
  let predicate = predicateSignature(predicateInput);
  const yesNormalized = venue === 'kalshi' ? normalizeText(market.yesSubTitle) : null;
  if (venue === 'kalshi' && /^(?:tie|draw)\b/.test(yesNormalized)) predicate = 'draw';
  const features = {
    title,
    titleTokens: tokens(title),
    numbers: numericSignature(title),
    endMs: Date.parse(venue === 'poly' ? market.endDate
      : market.expectedExpirationTime || market.closeTime),
    fullText,
    fullNormalized: normalizeText(fullText),
    domains: domains(fullText),
    predicate,
    operator: thresholdOperator(venue === 'poly' ? market.question
      : [market.rulesPrimary, market.yesSubTitle].filter(Boolean).join(' ')),
    sport: sportSignature(fullText),
    netflix: netflixDimensions(fullText),
    cancellationMention: /\b(cancel|cancelled|canceled|postpone|void|reschedul)/i.test(fullText),
    questionNormalized: venue === 'poly' ? normalizeText(market.question) : null,
    questionTokens: venue === 'poly' ? new Set(tokens(market.question)) : null,
    yesNormalized,
    outcomeEntity: venue === 'kalshi' ? outcomeEntityTokens(market.yesSubTitle) : null,
  };
  if (market && typeof market === 'object') cache.set(market, features);
  return features;
}

/**
 * Candidate discovery is intentionally permissive; approval is not. No score
 * can promote a pair to resolution-equivalent without a frozen manual audit.
 */
function compareContracts(poly, kalshi) {
  const polyFeatures = identityFeatures(poly, 'poly');
  const kalshiFeatures = identityFeatures(kalshi, 'kalshi');
  const titleSimilarity = jaccard(polyFeatures.titleTokens, kalshiFeatures.titleTokens);
  // Compare outcome-defining numbers in labels, not incidental section/date
  // numbers buried in long rule text.
  const polyNumbers = polyFeatures.numbers;
  const kalshiNumbers = kalshiFeatures.numbers;
  const numbersComparable = polyNumbers.length > 0 && kalshiNumbers.length > 0;
  const numbersMatch = !numbersComparable || sameSet(polyNumbers, kalshiNumbers);
  const polyEnd = polyFeatures.endMs;
  const kalshiEnd = kalshiFeatures.endMs;
  const endDeltaHours = Number.isFinite(polyEnd) && Number.isFinite(kalshiEnd)
    ? Math.abs(polyEnd - kalshiEnd) / 3_600_000 : null;
  const timeScore = endDeltaHours == null ? 0.35
    : endDeltaHours <= 1 ? 1 : endDeltaHours <= 6 ? 0.75 : endDeltaHours <= 24 ? 0.4 : 0;
  const polyDomains = polyFeatures.domains;
  const kalshiDomains = kalshiFeatures.domains;
  const sourcesComparable = polyDomains.length > 0 && kalshiDomains.length > 0;
  const sourceOverlap = !sourcesComparable || polyDomains.some((domain) => kalshiDomains.includes(domain));
  const polyPredicate = polyFeatures.predicate;
  const kalshiPredicate = kalshiFeatures.predicate;
  const predicateMatch = !(polyPredicate && kalshiPredicate) || polyPredicate === kalshiPredicate;
  const participantMatch = outcomeParticipantMatches(poly, kalshi, polyFeatures, kalshiFeatures);
  const polyOperator = polyFeatures.operator;
  const kalshiOperator = kalshiFeatures.operator;
  const operatorMatch = !(polyOperator && kalshiOperator) || polyOperator === kalshiOperator;
  const polySport = polyFeatures.sport;
  const kalshiSport = kalshiFeatures.sport;
  const sportMatch = !(polySport && kalshiSport) || polySport === kalshiSport;
  const polyNetflix = polyFeatures.netflix;
  const kalshiNetflix = kalshiFeatures.netflix;
  const dimensionMatch = !(polyNetflix && kalshiNetflix)
    || ((!polyNetflix.region || !kalshiNetflix.region || polyNetflix.region === kalshiNetflix.region)
      && (!polyNetflix.media || !kalshiNetflix.media || polyNetflix.media === kalshiNetflix.media));
  const ruleMismatches = explicitRuleMismatchesNormalized(
    polyFeatures.fullNormalized, kalshiFeatures.fullNormalized,
  );
  const score = 0.75 * titleSimilarity + 0.15 * (numbersMatch ? 1 : 0) + 0.10 * timeScore;
  const mismatches = [];
  if (!numbersMatch) mismatches.push('NUMERIC_OR_THRESHOLD_MISMATCH');
  if (endDeltaHours != null && endDeltaHours > 24) mismatches.push('OBSERVATION_TIME_MISMATCH');
  if (!sourceOverlap) mismatches.push('RESOLUTION_SOURCE_MISMATCH');
  if (!predicateMatch) mismatches.push('OUTCOME_PREDICATE_MISMATCH');
  if (!participantMatch) mismatches.push('OUTCOME_PARTICIPANT_MISMATCH');
  if (!operatorMatch) mismatches.push('THRESHOLD_OPERATOR_MISMATCH');
  if (!sportMatch) mismatches.push('SPORT_MISMATCH');
  if (!dimensionMatch) mismatches.push('MARKET_DIMENSION_MISMATCH');
  mismatches.push(...ruleMismatches);
  if (polyFeatures.cancellationMention || kalshiFeatures.cancellationMention) {
    mismatches.push('CANCELLATION_RULES_REQUIRE_MANUAL_REVIEW');
  }
  let identityStatus = 'UNMATCHED';
  if (score >= 0.45) identityStatus = score >= 0.75 && !mismatches.length ? 'STRONG_CANDIDATE' : 'CANDIDATE';
  const hardMismatch = !participantMatch || !operatorMatch || !sportMatch || !dimensionMatch
    || !predicateMatch || ruleMismatches.length > 0;
  if (hardMismatch || (titleSimilarity >= 0.35 && (!numbersMatch || !sourceOverlap
    || (endDeltaHours != null && endDeltaHours > 72)))) {
    identityStatus = 'REJECTED';
  }
  return {
    score: +score.toFixed(6), titleSimilarity: +titleSimilarity.toFixed(6),
    identityStatus, mismatches, polyNumbers, kalshiNumbers,
    polyDomains, kalshiDomains, polyPredicate, kalshiPredicate, participantMatch,
    polyOperator, kalshiOperator, polySport, kalshiSport, polyNetflix, kalshiNetflix,
    endDeltaHours,
  };
}

function normalizeLevels(levels, descending = false) {
  return (Array.isArray(levels) ? levels : []).map((level) => {
    const price = finite(level?.[0] ?? level?.price);
    const size = finite(level?.[1] ?? level?.size);
    return price > 0 && price < 1 && size > 0 ? [price, size] : null;
  }).filter(Boolean).sort((left, right) => descending ? right[0] - left[0] : left[0] - right[0]);
}

/** Kalshi publishes YES and NO bids. Opposite bids imply executable asks. */
function normalizeKalshiBook(payload) {
  const raw = payload?.orderbook_fp || payload?.orderbook || payload || {};
  const yesBids = normalizeLevels(raw.yes_dollars || raw.yes || [], true);
  const noBids = normalizeLevels(raw.no_dollars || raw.no || [], true);
  return {
    YES: {
      bids: yesBids,
      asks: noBids.map(([price, size]) => [1 - price, size]).sort((a, b) => a[0] - b[0]),
    },
    NO: {
      bids: noBids,
      asks: yesBids.map(([price, size]) => [1 - price, size]).sort((a, b) => a[0] - b[0]),
    },
  };
}

function walk(levels, quantity) {
  let remaining = finite(quantity);
  if (!(remaining > 0)) return null;
  const fills = []; let cost = 0;
  for (const level of Array.isArray(levels) ? levels : []) {
    const price = finite(level?.[0]); const available = finite(level?.[1]);
    if (!(price > 0 && price < 1 && available > 0)) continue;
    const size = Math.min(remaining, available);
    fills.push({ price, size }); cost += price * size; remaining -= size;
    if (remaining <= 1e-9) break;
  }
  if (remaining > 1e-9) return null;
  return { quantity, cost, vwap: cost / quantity, fills };
}

function kalshiTakerFee(fills, scheduleOrMultiplier = 1, cashflow = 'buy') {
  return kalshiFeeForFills(fills, scheduleOrMultiplier, 'taker', cashflow);
}

function polymarketTakerFee(fills, rate = 0, exponent = 1) {
  const feeRate = Math.max(0, finite(rate, 0));
  const feeExponent = Math.max(0, finite(exponent, 1));
  return (fills || []).reduce((sum, fill) =>
    sum + fill.size * feeRate * Math.pow(fill.price * (1 - fill.price), feeExponent), 0);
}

function immediateUnwind(book, quantity, feeForFills) {
  const fill = walk(book?.bids, quantity);
  if (!fill) return { fullDepth: false, grossProceeds: null, fee: null, netProceeds: null };
  const fee = feeForFills(fill.fills);
  if (!Number.isFinite(fee)) {
    return {
      fullDepth: false,
      grossProceeds: fill.cost,
      fee: null,
      netProceeds: null,
      reason: 'FEE_SCHEDULE_UNKNOWN',
    };
  }
  return {
    fullDepth: true,
    grossProceeds: fill.cost,
    fee,
    netProceeds: fill.cost - fee,
  };
}

function evaluateCombination({
  polyOutcome, kalshiOutcome, quantity, polyBook, kalshiBook,
  polyFeeRate = 0, polyFeeExponent = 1, kalshiFeeMultiplier = 1,
  kalshiFeeSchedule = undefined,
  polyTick = 0.01, kalshiTick = 0.01, identityApproved = false,
  paperEvalApproved = false,
  relationApproved = false, relationType = 'UNREVIEWED',
  guaranteedMinPayoutPerShare = null, payoffProofHash = null,
  booksFresh = false, totalCapitalUsd = null, polyCapitalUsd = null,
  kalshiCapitalUsd = null,
}) {
  const polyFill = walk(polyBook?.asks, quantity);
  const kalshiFill = walk(kalshiBook?.asks, quantity);
  if (!polyFill || !kalshiFill) return null;
  const polyFee = polymarketTakerFee(polyFill.fills, polyFeeRate, polyFeeExponent);
  const kalshiFeeInput = kalshiFeeSchedule === undefined
    ? kalshiFeeMultiplier : kalshiFeeSchedule;
  const kalshiFee = kalshiTakerFee(kalshiFill.fills, kalshiFeeInput);
  if (!Number.isFinite(kalshiFee)) return null;
  const polyCashRequired = polyFill.cost + polyFee;
  const kalshiCashRequired = kalshiFill.cost + kalshiFee;
  const totalCost = polyCashRequired + kalshiCashRequired;
  const payoffApproved = relationApproved === true || identityApproved === true;
  // Unreviewed pairs retain a $1 parity control solely so title-matching and
  // capacity diagnostics remain measurable. It is never labelled economic.
  const payoutPerShare = payoffApproved
    ? finite(guaranteedMinPayoutPerShare, 1) : 1;
  const terminalMinimumPayout = quantity * payoutPerShare;
  const lockedProfitAfterBothFills = terminalMinimumPayout - totalCost;
  // Frozen stress: charge fees a second time and one adverse tick per leg.
  // This is a mechanism hurdle, not a threshold fitted to observed PnL.
  const stressedProfit = lockedProfitAfterBothFills - polyFee - kalshiFee
    - quantity * (Math.max(0, finite(polyTick, 0.01)) + Math.max(0, finite(kalshiTick, 0.01)));
  const totalLimit = finite(totalCapitalUsd);
  const polyLimit = finite(polyCapitalUsd);
  const kalshiLimit = finite(kalshiCapitalUsd);
  const budgetFeasible = (totalLimit == null || totalCost <= totalLimit + 1e-9)
    && (polyLimit == null || polyCashRequired <= polyLimit + 1e-9)
    && (kalshiLimit == null || kalshiCashRequired <= kalshiLimit + 1e-9);
  const rawRoiPct = totalCost > 0 ? 100 * lockedProfitAfterBothFills / totalCost : null;
  const stressedRoiPct = totalCost > 0 ? 100 * stressedProfit / totalCost : null;
  const polyUnwind = immediateUnwind(polyBook, quantity,
    (fills) => polymarketTakerFee(fills, polyFeeRate, polyFeeExponent));
  const kalshiUnwind = immediateUnwind(kalshiBook, quantity,
    (fills) => kalshiTakerFee(fills, kalshiFeeInput, 'sell'));
  const polyOnlyImmediateUnwindPnl = polyUnwind.fullDepth
    ? polyUnwind.netProceeds - polyCashRequired : null;
  const kalshiOnlyImmediateUnwindPnl = kalshiUnwind.fullDepth
    ? kalshiUnwind.netProceeds - kalshiCashRequired : null;
  const worstImmediateOrphanUnwindPnl = polyOnlyImmediateUnwindPnl == null
    || kalshiOnlyImmediateUnwindPnl == null ? null
    : Math.min(polyOnlyImmediateUnwindPnl, kalshiOnlyImmediateUnwindPnl);
  const indicativeEconomic = lockedProfitAfterBothFills > 0;
  const economic = payoffApproved && booksFresh && budgetFeasible && indicativeEconomic;
  const lockableAfterBothFills = economic
    && stressedProfit > 0;
  // A score-approved paper pair is allowed to simulate the parity thesis, but
  // remains explicitly outside proved economics. Require the frozen 2x-fee +
  // one-tick-per-leg stress before recording a paper trade candidate.
  const paperTradeEligible = paperEvalApproved === true && !payoffApproved
    && booksFresh && budgetFeasible && stressedProfit > 0;
  return {
    direction: `POLY_${polyOutcome}+KALSHI_${kalshiOutcome}`,
    polyOutcome, kalshiOutcome, quantity,
    polyVwap: polyFill.vwap, kalshiVwap: kalshiFill.vwap,
    polyCost: polyFill.cost, kalshiCost: kalshiFill.cost,
    polyFee, kalshiFee, polyCashRequired, kalshiCashRequired, totalCost,
    terminalMinimumPayout, guaranteedMinPayoutPerShare: payoffApproved ? payoutPerShare : null,
    payoutAssumption: payoffApproved ? 'DETERMINISTIC_PAYOFF_PROOF' : 'UNPROVEN_PARITY_CONTROL',
    lockedProfitAfterBothFills, stressedProfit,
    rawRoiPct, stressedRoiPct, budgetFeasible,
    maxUnhedgedLossUsd: Math.max(polyCashRequired, kalshiCashRequired),
    polyOnlyImmediateUnwindPnl, kalshiOnlyImmediateUnwindPnl,
    worstImmediateOrphanUnwindPnl,
    immediateOrphanUnwindAvailable: polyUnwind.fullDepth && kalshiUnwind.fullDepth,
    terminalEdgeHeadroomPerShare: lockedProfitAfterBothFills / quantity,
    indicativeEconomic, economic, paperEvalApproved, paperTradeEligible, identityApproved,
    relationApproved: payoffApproved, relationType, payoffProofHash, booksFresh,
    lockableAfterBothFills,
    atomic: false,
    status: !budgetFeasible ? 'OVER_BUDGET'
      : lockableAfterBothFills ? 'LOCKABLE_NONATOMIC'
      : paperTradeEligible ? 'PAPER_ASSUMED_PARITY_STRESSED_EDGE'
      : !payoffApproved && indicativeEconomic ? 'UNPROVEN_PAYOFF_CONTROL'
        : economic ? 'PROVEN_RAW_EDGE_FAILED_STRESS' : 'NO_EDGE',
    fills: { polymarket: polyFill.fills, kalshi: kalshiFill.fills },
    orphanUnwinds: { polymarket: polyUnwind, kalshi: kalshiUnwind },
  };
}

function bundleChoices(options) {
  const relation = options.payoffRelation;
  if (relation?.relationApproved && Array.isArray(relation.validBundles)
    && relation.validBundles.length) {
    return relation.validBundles.map((bundle) => ({
      polyOutcome: bundle.polyOutcome,
      kalshiOutcome: bundle.kalshiOutcome,
      relationApproved: true,
      relationType: relation.relationType,
      guaranteedMinPayoutPerShare: bundle.guaranteedMinPayoutPerShare,
      payoffProofHash: bundle.payoffProof?.proofHash || null,
    }));
  }
  return [['YES', 'NO'], ['NO', 'YES']].map(([polyOutcome, kalshiOutcome]) => ({
    polyOutcome, kalshiOutcome,
    relationApproved: options.identityApproved === true,
    relationType: options.identityApproved === true ? 'EQUIVALENT' : 'UNREVIEWED',
    guaranteedMinPayoutPerShare: options.identityApproved === true ? 1 : null,
    payoffProofHash: null,
  }));
}

function evaluatePair(options) {
  const quantities = [...new Set((options.quantities || [1, 5, 10, 25, 50, 100])
    .map((value) => finite(value)).filter((value) => value > 0))].sort((a, b) => a - b);
  const combinations = [];
  for (const quantity of quantities) {
    for (const bundle of bundleChoices(options)) {
      const { polyOutcome, kalshiOutcome } = bundle;
      const result = evaluateCombination({
        ...options, ...bundle, quantity,
        polyBook: options.polyBooks?.[polyOutcome],
        kalshiBook: options.kalshiBooks?.[kalshiOutcome],
      });
      if (result) combinations.push(result);
    }
  }
  return combinations;
}

function depthBreakpoints(levels) {
  const output = []; let cumulative = 0;
  for (const level of Array.isArray(levels) ? levels : []) {
    const price = finite(level?.[0]); const size = finite(level?.[1]);
    if (!(price > 0 && price < 1 && size > 0)) continue;
    cumulative += size; output.push(cumulative);
  }
  return output;
}

function roundDown(value, decimals = 4) {
  const scale = 10 ** decimals;
  return Math.floor((finite(value, 0) + 1e-12) * scale) / scale;
}

/**
 * Size equal payout shares at executable depth breakpoints. The two cash
 * stakes are deliberately unequal when prices differ; equal share quantity is
 * what makes the terminal payout identical in both outcomes.
 */
function optimizeCombination(options) {
  const polyBook = options.polyBook;
  const kalshiBook = options.kalshiBook;
  const minimum = Math.max(0.0001, finite(options.minQuantity, 1));
  const maximum = Math.max(minimum, finite(options.maxQuantity, 10_000));
  const polyBreakpoints = depthBreakpoints(polyBook?.asks);
  const kalshiBreakpoints = depthBreakpoints(kalshiBook?.asks);
  if (!polyBreakpoints.length || !kalshiBreakpoints.length) return null;
  const polyDepth = polyBreakpoints.at(-1);
  const kalshiDepth = kalshiBreakpoints.at(-1);
  const depthCapacity = Math.min(polyDepth, kalshiDepth, maximum);
  if (depthCapacity + 1e-9 < minimum) return null;

  const evaluate = (quantity) => evaluateCombination({ ...options, quantity });
  let low = 0; let high = depthCapacity;
  for (let iteration = 0; iteration < 48; iteration += 1) {
    const middle = (low + high) / 2;
    const row = evaluate(middle);
    if (row?.budgetFeasible) low = middle; else high = middle;
  }
  const affordableCapacity = roundDown(low);
  if (affordableCapacity + 1e-9 < minimum) return null;

  const candidateSet = new Set();
  const addCandidate = (value) => {
    const quantity = roundDown(Math.min(affordableCapacity, finite(value, 0)));
    if (quantity + 1e-9 >= minimum) candidateSet.add(quantity);
  };
  addCandidate(minimum);
  addCandidate(affordableCapacity);
  for (const value of options.quantities || []) addCandidate(value);
  for (const value of [...polyBreakpoints, ...kalshiBreakpoints]) addCandidate(value);

  const rows = [...candidateSet].sort((a, b) => a - b)
    .map(evaluate).filter((row) => row?.budgetFeasible);
  if (!rows.length) return null;
  const robust = rows.filter((row) => (row.relationApproved || row.paperEvalApproved)
    && row.stressedProfit > 0)
    .sort((left, right) => right.stressedProfit - left.stressedProfit
      || right.lockedProfitAfterBothFills - left.lockedProfitAfterBothFills
      || right.quantity - left.quantity);
  const controls = [...rows].sort((left, right) =>
    right.lockedProfitAfterBothFills - left.lockedProfitAfterBothFills
    || left.quantity - right.quantity);
  const best = robust[0] || controls[0];
  let capacityLimitedBy = 'BOTH_BOOKS';
  if (affordableCapacity < depthCapacity - 0.0001) capacityLimitedBy = 'BANKROLL';
  else if (maximum <= Math.min(polyDepth, kalshiDepth) + 0.0001) capacityLimitedBy = 'MAX_QUANTITY';
  else if (polyDepth < kalshiDepth - 0.0001) capacityLimitedBy = 'POLYMARKET_DEPTH';
  else if (kalshiDepth < polyDepth - 0.0001) capacityLimitedBy = 'KALSHI_DEPTH';
  return {
    ...best,
    sizingMethod: 'EQUAL_PAYOUT_DEPTH_BANKROLL_OPTIMIZED',
    optimizationObjective: robust[0] ? 'MAX_STRESSED_PROFIT' : 'BEST_RAW_CONTROL',
    candidateQuantityCount: rows.length,
    availableDepthShares: depthCapacity,
    affordableCapacityShares: affordableCapacity,
    capacityLimitedBy,
  };
}

function optimizePair(options) {
  return bundleChoices(options).map((bundle) => {
    const { polyOutcome, kalshiOutcome } = bundle;
    return (
    optimizeCombination({
      ...options, ...bundle,
      polyBook: options.polyBooks?.[polyOutcome],
      kalshiBook: options.kalshiBooks?.[kalshiOutcome],
    }));
  }).filter(Boolean);
}

/**
 * Fixed-size four-leg basis sample. Entry pays both executable asks; an early
 * exit sells both positions into executable bids. This is deliberately
 * separate from terminal-lock economics because early capital release pays a
 * second pair of fees and crosses a second pair of spreads.
 */
function evaluateBasisCombination({
  polyOutcome, kalshiOutcome, quantity, polyBook, kalshiBook,
  polyFeeRate = 0, polyFeeExponent = 1, kalshiFeeMultiplier = 1,
  kalshiFeeSchedule = undefined,
  polyTick = 0.01, kalshiTick = 0.01,
  identityApproved = false, relationApproved = false,
  paperEvalApproved = false,
  relationType = 'UNREVIEWED', guaranteedMinPayoutPerShare = null,
  payoffProofHash = null, booksFresh = false,
}) {
  const polyEntry = walk(polyBook?.asks, quantity);
  const kalshiEntry = walk(kalshiBook?.asks, quantity);
  const polyExit = walk(polyBook?.bids, quantity);
  const kalshiExit = walk(kalshiBook?.bids, quantity);
  if (!polyEntry || !kalshiEntry) return null;

  const polyEntryFee = polymarketTakerFee(polyEntry.fills, polyFeeRate, polyFeeExponent);
  const kalshiFeeInput = kalshiFeeSchedule === undefined
    ? kalshiFeeMultiplier : kalshiFeeSchedule;
  const kalshiEntryFee = kalshiTakerFee(kalshiEntry.fills, kalshiFeeInput);
  if (!Number.isFinite(kalshiEntryFee)) return null;
  const polyExitFee = polyExit ? polymarketTakerFee(polyExit.fills, polyFeeRate, polyFeeExponent) : null;
  const kalshiExitFee = kalshiExit
    ? kalshiTakerFee(kalshiExit.fills, kalshiFeeInput, 'sell') : null;
  const kalshiExitDepthUsable = Boolean(kalshiExit && Number.isFinite(kalshiExitFee));
  const fullExitDepth = Boolean(polyExit && kalshiExitDepthUsable);
  const entryTotalCost = polyEntry.cost + kalshiEntry.cost + polyEntryFee + kalshiEntryFee;
  const grossLiquidationProceeds = fullExitDepth ? polyExit.cost + kalshiExit.cost : null;
  const netLiquidationProceeds = fullExitDepth
    ? grossLiquidationProceeds - polyExitFee - kalshiExitFee : null;
  const payoffApproved = relationApproved === true || identityApproved === true;
  const payoutPerShare = payoffApproved ? finite(guaranteedMinPayoutPerShare, 1) : 1;
  const terminalMinimumPayout = quantity * payoutPerShare;
  const terminalLockedProfit = terminalMinimumPayout - entryTotalCost;
  const immediateRoundTripPnl = fullExitDepth ? netLiquidationProceeds - entryTotalCost : null;
  const paperStressProfit = terminalLockedProfit - polyEntryFee - kalshiEntryFee
    - quantity * (Math.max(0, finite(polyTick, 0.01)) + Math.max(0, finite(kalshiTick, 0.01)));
  const paperEntryEligible = paperEvalApproved === true && !payoffApproved
    && booksFresh && paperStressProfit > 0;

  return {
    direction: `POLY_${polyOutcome}+KALSHI_${kalshiOutcome}`,
    polyOutcome, kalshiOutcome, quantity,
    polyEntryVwap: polyEntry.vwap, kalshiEntryVwap: kalshiEntry.vwap,
    polyExitVwap: polyExit?.vwap ?? null, kalshiExitVwap: kalshiExit?.vwap ?? null,
    polyEntryFee, kalshiEntryFee, polyExitFee, kalshiExitFee,
    entryTotalCost, grossLiquidationProceeds, netLiquidationProceeds,
    terminalMinimumPayout,
    guaranteedMinPayoutPerShare: payoffApproved ? payoutPerShare : null,
    terminalLockedProfit, immediateRoundTripPnl,
    indicativeEntryEconomic: terminalLockedProfit > 0,
    entryEconomic: payoffApproved && booksFresh && terminalLockedProfit > 0,
    paperEvalApproved, paperEntryEligible, paperStressProfit,
    identityApproved, relationApproved: payoffApproved, relationType, payoffProofHash, booksFresh,
    fullEntryDepth: true, fullExitDepth,
    entryFills: { polymarket: polyEntry.fills, kalshi: kalshiEntry.fills },
    exitFills: {
      polymarket: polyExit?.fills || null,
      kalshi: kalshiExit?.fills || null,
    },
  };
}

function evaluateBasisPair(options) {
  const quantity = finite(options.quantity, 10);
  if (!(quantity > 0)) return [];
  return bundleChoices(options).map((bundle) => {
    const { polyOutcome, kalshiOutcome } = bundle;
    return (
    evaluateBasisCombination({
      ...options, ...bundle, quantity,
      polyBook: options.polyBooks?.[polyOutcome],
      kalshiBook: options.kalshiBooks?.[kalshiOutcome],
    }));
  }).filter(Boolean);
}

module.exports = {
  compareContracts, contractText, domains, evaluateBasisCombination,
  evaluateBasisPair, evaluateCombination, evaluatePair,
  finite, jaccard, kalshiTakerFee, normalizeKalshiBook, normalizeLevels,
  normalizeText, numericSignature, optimizeCombination, optimizePair,
  polymarketTakerFee, roundUpCenticent,
  predicateSignature, tokens, walk,
};
