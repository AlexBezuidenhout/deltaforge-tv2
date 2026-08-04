'use strict';

const { normalizeInstrument } = require('./surface-universe');

function integer(value) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function summarizeExactExpiryCoverage(input = {}) {
  const now = input.now ? new Date(input.now) : new Date();
  const currencies = [...new Set((input.currencies || ['BTC', 'ETH'])
    .map((value) => String(value).toUpperCase()))];
  const instruments = (input.rawInstruments || []).map(normalizeInstrument).filter(Boolean);
  const records = input.selection?.records || [];
  const rejected = Object.fromEntries(Object.entries(input.selection?.rejected || {})
    .map(([reason, count]) => [reason, integer(count)]));
  const byCurrency = Object.fromEntries(currencies.map((currency) => [currency, {
    listedOptionInstruments: instruments.filter((row) => row.currency === currency).length,
    listedCallExpiries: new Set(instruments.filter((row) => row.currency === currency
      && row.optionType === 'call').map((row) => row.expirationMs)).size,
    exactTargets: records.filter((row) => String(row.asset).toUpperCase() === currency).length,
  }]));
  const targets = records.map((row) => ({
    slug: row.slug,
    asset: row.asset,
    strike: parseFloat(row.strike),
    expiry: row.window_end?.toISOString?.() || new Date(row.window_end).toISOString(),
    resolutionSource: row.resolution_source,
    certificationHash: row.raw?._optionsExactExpiry?.resolverCertification?.proofHash || null,
  }));
  return {
    format: 'deltaforge-options-exact-expiry-coverage-v1',
    generatedAt: now.toISOString(),
    currencies,
    queriedExpiries: (input.listedExpiries || []).map((value) => new Date(value).toISOString()),
    fetchedEvents: (input.events || []).length,
    fetchedMarkets: (input.events || []).reduce((sum, event) =>
      sum + (Array.isArray(event?.markets) ? event.markets.length : 0), 0),
    byCurrency,
    exactTargets: targets,
    exactTargetCount: targets.length,
    rejected,
    discoveryDecision: targets.length ? 'RULE_CERTIFIED_CANDIDATES_FOUND' : 'NO_EXACT_TARGETS',
    armRegistrationEligible: false,
    armRegistrationRule: 'Discovery is necessary but insufficient. A new arm remains blocked until the running collector records an executable EXACT_EXPIRY A/B-fidelity mark after depth, 2x fees, hedge cost, resolver freshness and minimum-size checks.',
    mutatesDatabase: false,
    changesStrategyRules: false,
  };
}

module.exports = { summarizeExactExpiryCoverage };
