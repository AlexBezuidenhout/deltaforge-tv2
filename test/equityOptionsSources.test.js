'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  IbkrReadOnlyClient, isLiveAvailability, normalizeOptionContract, parseMarketDataRow,
} = require('../borg/equity-options/ibkr-opra');
const {
  buildBasisSample, frozenBasisBound,
} = require('../borg/equity-options/basis');

test('OPRA parser fails closed on delayed or incomplete books', () => {
  assert.equal(isLiveAvailability('RpB'), true);
  assert.equal(isLiveAvailability('DpB'), false);
  const live = parseMarketDataRow({ conid: 1, 84: '1.20', 86: '1.25', 88: '5',
    85: '7', 6509: 'RpB', _updated: '1786123456000' }, {
    instrumentId: 'SPY TEST', underlying: 'SPY', optionType: 'call', strike: 700,
    expiryMs: Date.parse('2026-08-07T20:00:00Z'), multiplier: 100,
  }, { receiveMs: 1786123456010 });
  assert.equal(live.liveEntitled, true);
  assert.equal(live.completeBook, true);
  assert.equal(live.dataQualityGrade, 'A');
  assert.equal(parseMarketDataRow({ ...live.raw, 6509: 'D' }, {}).liveEntitled, false);
});

test('IBKR calendar expiry is mapped to the target DST-aware close timestamp', async () => {
  const normalized = normalizeOptionContract({
    conid: 42, localSymbol: 'SPY  260807C00700000', symbol: 'SPY',
    right: 'C', maturityDate: '20260807', strike: '700', multiplier: '100',
    tradingClass: 'SPY', exchange: 'SMART',
  }, { underlying: 'SPY', underlyingConid: 756733 });
  assert.equal(normalized.expiryDate, '2026-08-07');
  assert.equal(new Date(normalized.expiryMs).toISOString(), '2026-08-07T00:00:00.000Z');

  const targetExpiry = Date.parse('2026-08-07T20:00:00.000Z');
  const client = new IbkrReadOnlyClient({ baseUrl: 'https://read-only.test',
    fetchImpl: async () => ({ ok: true, status: 200,
      text: async () => JSON.stringify([normalized.raw]) }) });
  const [contract] = await client.optionInfo({ underlying: 'SPY', underlyingConid: 756733,
    expiryMs: targetExpiry, strike: 700, optionType: 'call' });
  assert.equal(contract.expiryMs, targetExpiry);
  assert.equal(contract.contractExpiryDate, '2026-08-07');
});

test('only exact Pyth candle and primary-listing closes build the 30-day basis bound', () => {
  const diagnostic = buildBasisSample({ experimentId: 'x', symbol: 'SPY',
    targetCloseAt: '2026-07-01T20:00:00Z', pythFeedSymbol: 'Equity.US.SPY/USD',
    pythClose: 620, underlyingClose: 619.9, pythSourceKind: 'PYTH_RTDS_LAST_TICK_CONTROL',
    underlyingSource: 'IBKR_CONSOLIDATED_LAST_CONTROL', sourceGrade: 'A' });
  assert.equal(diagnostic.qualifying, false);

  const samples = Array.from({ length: 30 }, (_, index) => buildBasisSample({
    experimentId: 'x', symbol: 'SPY',
    tradeDate: `2026-07-${String(index + 1).padStart(2, '0')}`,
    targetCloseAt: `2026-07-${String(index + 1).padStart(2, '0')}T20:00:00Z`,
    pythFeedSymbol: 'Equity.US.SPY/USD', pythClose: 620 + index,
    underlyingClose: 619.5 + index,
    pythSourceKind: 'PYTH_FINAL_REGULAR_SESSION_1M_CANDLE_CLOSE',
    underlyingSource: 'OFFICIAL_PRIMARY_LISTING_CLOSE', sourceGrade: 'A',
  }));
  assert.equal(frozenBasisBound(samples.slice(0, 29)).ready, false);
  const bound = frozenBasisBound(samples);
  assert.equal(bound.ready, true);
  assert.equal(bound.observationDays, 30);
  assert.equal(bound.boundUsd, 0.5);
});
