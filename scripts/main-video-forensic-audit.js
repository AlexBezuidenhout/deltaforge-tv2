#!/usr/bin/env node
'use strict';

/**
 * Reproduce the public-market portion of MAIN_VIDEO_FORENSIC_AUDIT_2026-07-27.
 *
 * The video shows adjacent Polymarket activity rows as if each BUY funded the
 * following CLAIM. This script asks the official Gamma API which side actually
 * won each displayed market. It does not infer wallet identity or private bot
 * state.
 */

const OBSERVATIONS = Object.freeze([
  {
    videoTime: '01:55',
    slug: 'btc-updown-5m-1784793000',
    displayedBuy: 'Down',
    displayedShares: 217.4,
    displayedSpendUsd: 100.00,
    adjacentClaimUsd: 215.04,
  },
  {
    videoTime: '01:55',
    slug: 'btc-updown-5m-1784787600',
    displayedBuy: 'Up',
    displayedShares: 181.5,
    displayedSpendUsd: 83.33,
    adjacentClaimUsd: 181.38,
  },
  {
    videoTime: '01:55',
    slug: 'btc-updown-5m-1784787300',
    displayedBuy: 'Up',
    displayedShares: 96.9,
    displayedSpendUsd: 56.69,
    adjacentClaimUsd: 96.79,
  },
]);

async function officialResolution(slug, fetchImpl = fetch) {
  const endpoint = `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`;
  const response = await fetchImpl(endpoint, {
    headers: { accept: 'application/json', 'user-agent': 'deltaforge-video-forensic-audit/1.0' },
  });
  if (!response.ok) throw new Error(`Gamma ${response.status} for ${slug}`);
  const events = await response.json();
  const market = events?.[0]?.markets?.[0];
  if (!market) throw new Error(`No official market returned for ${slug}`);
  const outcomes = JSON.parse(market.outcomes);
  const prices = JSON.parse(market.outcomePrices).map(Number);
  const winnerIndex = prices.findIndex((price) => price === 1);
  return {
    endpoint,
    question: market.question,
    conditionId: market.conditionId,
    outcomes,
    terminalPrices: prices,
    winner: winnerIndex >= 0 ? outcomes[winnerIndex] : null,
    closed: market.closed === true,
    resolutionSource: market.resolutionSource || null,
  };
}

async function auditObservation(observation, fetchImpl = fetch) {
  const official = await officialResolution(observation.slug, fetchImpl);
  return {
    ...observation,
    ...official,
    displayedBuyWon: official.winner === observation.displayedBuy,
    adjacentRowsProveOneTrade: official.winner === observation.displayedBuy,
  };
}

async function main() {
  const rows = [];
  for (const observation of OBSERVATIONS) {
    rows.push(await auditObservation(observation));
  }
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({
      generatedAt: new Date().toISOString(),
      methodology: 'official terminal outcome versus the side shown in the adjacent video BUY row',
      rows,
    }, null, 2)}\n`);
    return;
  }

  console.log('Video market-resolution cross-check');
  console.log('Adjacent activity rows are not assumed to be one round trip.');
  console.table(rows.map((row) => ({
    market: row.question,
    displayed_buy: row.displayedBuy,
    official_winner: row.winner,
    displayed_buy_won: row.displayedBuyWon,
    adjacent_claim_usd: row.adjacentClaimUsd.toFixed(2),
  })));
  const winningRows = rows.filter((row) => row.displayedBuyWon).length;
  console.log(`${winningRows}/${rows.length} displayed BUY rows selected the official winner.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  OBSERVATIONS,
  auditObservation,
  officialResolution,
};
