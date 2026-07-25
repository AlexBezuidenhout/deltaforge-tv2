#!/usr/bin/env node
'use strict';

/**
 * Read-only full-universe Polymarket/Kalshi overlap rescan.
 *
 * This deliberately produces discovery candidates, never identity approvals.
 * A title/structure score is not a payoff proof and cannot arm live trading.
 */

const {
  buildCandidates, fetchKalshiEventUniverse, fetchPolyUniverseCompact,
  isRejectedIdentity,
} = require('../borg/crossvenue/universe');

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function countsBy(rows, key) {
  const counts = {};
  for (const row of rows) {
    const value = typeof key === 'function' ? key(row) : row[key];
    counts[value || '(none)'] = (counts[value || '(none)'] || 0) + 1;
  }
  return counts;
}

function ranked(counts, limit = 50) {
  return Object.entries(counts).sort((left, right) => right[1] - left[1]
    || String(left[0]).localeCompare(String(right[0]))).slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function scoreBucket(row) {
  if (row.score >= 0.9) return '0.90-1.00';
  if (row.score > 0.8) return '0.80-0.90';
  if (row.score >= 0.75) return '0.75-0.80';
  if (row.score >= 0.6) return '0.60-0.75';
  return 'below-0.60';
}

function candidateSummary(row) {
  return {
    matchId: row.matchId,
    score: row.score,
    titleSimilarity: row.titleSimilarity,
    identityStatus: row.identityStatus,
    relationApproved: row.relationApproved === true,
    poly: {
      conditionId: row.poly.conditionId,
      question: row.poly.question,
      eventTitle: row.poly.eventTitle,
      category: row.poly.category,
      endDate: row.poly.endDate,
    },
    kalshi: {
      ticker: row.kalshi.ticker,
      eventTicker: row.kalshi.eventTicker,
      seriesTicker: row.kalshi.seriesTicker,
      title: row.kalshi.title,
      eventTitle: row.kalshi.eventTitle,
      yesSubTitle: row.kalshi.yesSubTitle,
      category: row.kalshi.category,
      expectedExpirationTime: row.kalshi.expectedExpirationTime,
    },
    mismatches: row.mismatches,
    structuredEvidence: row.structuredEvidence || null,
  };
}

async function main() {
  const gammaPages = Number(arg('gamma-pages', 20));
  const gammaWindows = Number(arg('gamma-windows', 10));
  const kalshiPages = Number(arg('kalshi-pages', 100));
  const maxCandidates = Number(arg('max-candidates', 10_000));
  const top = Number(arg('top', 100));
  const startedAt = new Date();

  const polyPromise = fetchPolyUniverseCompact({
    maxPages: gammaPages, maxWindows: gammaWindows, concurrency: 6,
  });
  const kalshiPromise = fetchKalshiEventUniverse({
    maxPages: kalshiPages, paceMs: 250,
    onPage: ({ page, events, markets }) => {
      if (page % 10 === 0) process.stderr.write(`Kalshi pages=${page} events=${events} markets=${markets}\n`);
    },
  });
  const [poly, kalshi] = await Promise.all([polyPromise, kalshiPromise]);
  const matchingStartedAt = Date.now();
  const candidates = buildCandidates(poly, kalshi, {
    maxCandidates, nowMs: matchingStartedAt,
  });
  const eligible = candidates.filter((row) => !isRejectedIdentity(row));
  const scoreApprovedShape = eligible.filter((row) => row.score > 0.8);
  const report = {
    generatedAt: new Date().toISOString(),
    elapsedSec: (Date.now() - startedAt.getTime()) / 1000,
    matchingSec: (Date.now() - matchingStartedAt) / 1000,
    semantics: {
      candidate: 'DISCOVERY_ONLY_NOT_PAYOFF_IDENTITY',
      scoreOver80: 'PAPER_REVIEW_PRIORITY_ONLY',
      terminalLock: 'REQUIRES_FROZEN_RULE_HASH_BOUND_PAYOFF_PROOF_AND_TWO_COMPLETE_FILLS',
      convergence: 'FOUR_LEG_EXECUTABLE_EXIT_TEST_WITH_RESIDUAL_BASIS_AND_LIQUIDITY_RISK',
    },
    universe: {
      polymarketBinaryMarkets: poly.length,
      polymarketEvents: poly.scan?.eventCount ?? null,
      polymarketPages: poly.scan?.pageCount ?? null,
      polymarketWindows: poly.scan?.windowCount ?? null,
      polymarketTruncated: poly.scan?.truncated ?? null,
      kalshiOpenBinaryMarkets: kalshi.length,
      kalshiEvents: kalshi.scan?.eventCount ?? null,
      kalshiPages: kalshi.scan?.pageCount ?? null,
      kalshiTruncated: kalshi.scan?.truncated ?? null,
    },
    candidateCounts: {
      retained: candidates.length,
      hitConfiguredCap: candidates.length >= maxCandidates,
      nonRejected: eligible.length,
      scoreStrictlyOver80: scoreApprovedShape.length,
      identityApproved: candidates.filter((row) => row.identityApproved).length,
      relationApproved: candidates.filter((row) => row.relationApproved).length,
      structured: candidates.filter((row) => row.structuredEvidence).length,
    },
    byStatus: ranked(countsBy(candidates, 'identityStatus')),
    byScore: ranked(countsBy(candidates, scoreBucket)),
    byPolyCategory: ranked(countsBy(candidates, (row) => row.poly.category)),
    byKalshiCategory: ranked(countsBy(candidates, (row) => row.kalshi.category)),
    byKalshiSeries: ranked(countsBy(candidates, (row) => row.kalshi.seriesTicker)),
    topCandidates: candidates.filter((row) => !row.structuredEvidence)
      .slice(0, Math.max(1, top)).map(candidateSummary),
    memoryMb: Object.fromEntries(Object.entries(process.memoryUsage())
      .map(([key, value]) => [key, +(value / 1024 / 1024).toFixed(1)])),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
