'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeExactExpiryCoverage } = require('../borg/options/exact-expiry-coverage');

test('exact-expiry coverage is diagnostic and cannot promote discovery alone', () => {
  const expiry = Date.UTC(2026, 7, 7, 8);
  const report = summarizeExactExpiryCoverage({
    now: '2026-08-04T08:00:00Z', currencies: ['BTC'],
    rawInstruments: [{
      instrument_name: 'BTC-7AUG26-70000-C', base_currency: 'BTC',
      option_type: 'call', strike: '70000', expiration_timestamp: String(expiry),
    }],
    listedExpiries: [expiry],
    events: [{ markets: [{}, {}] }],
    selection: { records: [{
      slug: 'btc-above-70000', asset: 'btc', strike: '70000',
      window_end: new Date(expiry), resolution_source: 'binance_1h_close',
      raw: { _optionsExactExpiry: { resolverCertification: { proofHash: 'proof' } } },
    }], rejected: { NO_LISTED_EXACT_EXPIRY: '2' } },
  });
  assert.equal(report.exactTargetCount, 1);
  assert.equal(report.fetchedMarkets, 2);
  assert.equal(report.rejected.NO_LISTED_EXACT_EXPIRY, 2);
  assert.equal(report.armRegistrationEligible, false);
  assert.match(report.armRegistrationRule, /executable EXACT_EXPIRY A\/B-fidelity/);
});
