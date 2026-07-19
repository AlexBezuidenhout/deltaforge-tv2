'use strict';

const { finite } = require('../allmarket/strategy');

function pairedCategory(market) {
  const text = `${market?.question || ''} ${market?.slug || ''} ${market?.eventSlug || ''}`.toLowerCase();
  if (/\b(esports|e-sports|counter[- ]?strike|cs2|dota|lol|league of legends|valorant|rocket league|starcraft|overwatch)\b/.test(text)) {
    return 'esports';
  }
  if (market?.category === 'sports') return 'sports';
  if (/\b(nba|nfl|nhl|mlb|soccer|football|tennis|atp|wta|golf|ufc|mma|cricket|rugby|match|game|cup|league)\b/.test(text)) {
    return 'sports';
  }
  return null;
}

function pairedMarketPhase(market, nowMs = Date.now()) {
  const startMs = Date.parse(market?.gameStartTime);
  if (!Number.isFinite(startMs)) return 'UNKNOWN';
  return nowMs < startMs ? 'PREGAME' : 'LIVE_OR_POST_START';
}

/**
 * PnL-independent panel selection for the paired-maker forward cohort.
 * Near-term liquid markets are preferred because the mechanism needs repeated
 * public prints, not because any category was profitable in discovery data.
 */
function selectPairedPanel(markets, options = {}) {
  const nowMs = Number(options.nowMs || Date.now());
  const maxMarkets = Math.max(1, Number(options.maxMarkets || 3));
  const minTteMs = Math.max(0, Number(options.minTteSec ?? 600)) * 1000;
  const preferredTteMs = Math.max(minTteMs, Number(options.preferredTteDays ?? 14) * 86400_000);
  const targetPairUsd = Math.max(1, Number(options.targetPairUsd || 10));
  const rewardOnly = options.rewardOnly === true;
  const requireKnownGameStart = options.requireKnownGameStart === true;
  const minPairEdge = Math.max(0, Number(options.minPairEdge ?? 0.01));
  const maxReservedUsd = Math.max(1, Number(options.maxReservedUsd || targetPairUsd));
  const eligible = markets.map((market) => {
    const category = pairedCategory(market);
    const endMs = Date.parse(market?.endDate);
    const tteMs = Number.isFinite(endMs) ? endMs - nowMs : Infinity;
    const orderMinSize = finite(market?.orderMinSize) ?? 5;
    const rewardsDailyRate = Math.max(0, finite(market?.rewardsDailyRate) ?? 0);
    const rewardsMinSize = Math.max(0, finite(market?.rewardsMinSize) ?? 0);
    const rewardsMaxSpread = Math.max(0, finite(market?.rewardsMaxSpread) ?? 0);
    const requiredShares = Math.max(orderMinSize, rewardOnly ? rewardsMinSize : 0);
    const estimatedReserveUsd = requiredShares * (1 - minPairEdge);
    const marketPhase = pairedMarketPhase(market, nowMs);
    if (!category || market?.active === false || market?.closed === true || market?.acceptingOrders === false
      || !Array.isArray(market?.tokenIds) || market.tokenIds.length !== 2
      || tteMs < minTteMs || estimatedReserveUsd > maxReservedUsd + 1e-9
      || (rewardOnly && (!(rewardsDailyRate > 0) || !(rewardsMinSize > 0) || !(rewardsMaxSpread > 0)))
      || (requireKnownGameStart && marketPhase === 'UNKNOWN')) return null;
    const volume = Math.max(0, finite(market?.volume24h) ?? 0);
    const liquidity = Math.max(0, finite(market?.liquidity) ?? 0);
    const nearTerm = tteMs <= preferredTteMs;
    const days = Number.isFinite(tteMs) ? tteMs / 86400_000 : 3650;
    const rewardDensity = rewardsDailyRate / Math.max(1, requiredShares);
    const selectionScore = (nearTerm ? 1000 : 0) + 100 * Math.log1p(rewardDensity)
      + 10 * Math.log1p(volume) + 2 * Math.log1p(liquidity)
      - Math.min(days, 3650) / 100;
    return {
      ...market,
      category,
      tteMs,
      marketPhase,
      requiredShares,
      estimatedReserveUsd,
      rewardDensity,
      selectionScore,
      selectionReason: `paired_${category}:phase=${marketPhase}:reward_only=${rewardOnly}:near_term=${nearTerm}:reward_volume_liquidity_rank`,
    };
  }).filter(Boolean).sort((left, right) => right.selectionScore - left.selectionScore
    || right.volume24h - left.volume24h
    || left.conditionId.localeCompare(right.conditionId));

  const categories = ['esports', 'sports'];
  const phases = ['PREGAME', 'LIVE_OR_POST_START', 'UNKNOWN']
    .filter((phase) => eligible.some((row) => row.marketPhase === phase));
  const strata = phases.flatMap((phase) => categories.map((category) => ({ phase, category })));
  const groups = new Map(strata.map(({ phase, category }) => [
    `${phase}:${category}`,
    eligible.filter((row) => row.marketPhase === phase && row.category === category),
  ]));
  const selected = [];
  while (selected.length < maxMarkets) {
    let advanced = false;
    for (const { phase, category } of strata) {
      const next = groups.get(`${phase}:${category}`).shift();
      if (!next) continue;
      selected.push(next);
      advanced = true;
      if (selected.length >= maxMarkets) break;
    }
    if (!advanced) break;
  }
  return selected;
}

module.exports = { pairedCategory, pairedMarketPhase, selectPairedPanel };
