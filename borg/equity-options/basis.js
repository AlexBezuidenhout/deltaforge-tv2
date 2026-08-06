'use strict';

const crypto = require('node:crypto');

const QUALIFYING_PYTH_KIND = 'PYTH_FINAL_REGULAR_SESSION_1M_CANDLE_CLOSE';
const QUALIFYING_UNDERLYING_SOURCE = 'OFFICIAL_PRIMARY_LISTING_CLOSE';

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function gradeRank(value) {
  return ({ A: 3, B: 2, C: 1, D: 0, F: -1 })[String(value || '').toUpperCase()] ?? -1;
}

/**
 * Build one immutable daily basis observation. RTDS last price and broker
 * consolidated last are useful controls, but they do not impersonate the
 * exact Pyth 1-minute candle close or official primary-listing close.
 */
function buildBasisSample(input = {}) {
  const symbol = String(input.symbol || '').toUpperCase();
  const targetCloseMs = new Date(input.targetCloseAt).getTime();
  const pythClose = finite(input.pythClose);
  const underlyingClose = finite(input.underlyingClose);
  const pythSourceKind = String(input.pythSourceKind || 'UNKNOWN');
  const underlyingSource = String(input.underlyingSource || 'UNKNOWN');
  const sourceGrade = String(input.sourceGrade || 'F').toUpperCase();
  const tradeDate = String(input.tradeDate || new Date(targetCloseMs).toISOString().slice(0, 10));
  const complete = Boolean(symbol && Number.isFinite(targetCloseMs)
    && pythClose > 0 && underlyingClose > 0 && input.pythFeedSymbol);
  const basisUsd = complete ? pythClose - underlyingClose : null;
  const basisBps = complete ? 10_000 * basisUsd / underlyingClose : null;
  const exactSources = pythSourceKind === QUALIFYING_PYTH_KIND
    && underlyingSource === QUALIFYING_UNDERLYING_SOURCE;
  const qualifying = complete && exactSources && gradeRank(sourceGrade) >= gradeRank('A');
  const identity = [
    'equity-pyth-occ-basis-v1', input.experimentId, symbol, tradeDate,
    pythSourceKind, underlyingSource,
  ].join('|');
  return {
    sampleId: `eqb_${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 28)}`,
    experimentId: String(input.experimentId || 'equity-pyth-exact-expiry-v1'),
    symbol,
    tradeDate,
    targetCloseAt: new Date(targetCloseMs).toISOString(),
    pythFeedSymbol: String(input.pythFeedSymbol || ''),
    pythSourceTs: input.pythSourceTs ? new Date(input.pythSourceTs).toISOString() : null,
    pythClose,
    pythSourceKind,
    underlyingSource,
    underlyingSourceTs: input.underlyingSourceTs
      ? new Date(input.underlyingSourceTs).toISOString() : null,
    underlyingClose,
    basisUsd,
    basisBps,
    sourceGrade,
    qualifying,
    ruleHash: input.ruleHash || null,
    detail: {
      exactSources,
      complete,
      diagnosticOnly: !qualifying,
      pythEvidenceId: input.pythEvidenceId || null,
      underlyingEvidenceId: input.underlyingEvidenceId || null,
      warning: qualifying ? null
        : 'Control prices are retained, but only the exact Pyth final one-minute candle and official primary-listing close qualify for a frozen settlement-basis bound.',
    },
  };
}

function frozenBasisBound(samples, options = {}) {
  const minDays = Math.max(30, Math.trunc(finite(options.minDays) ?? 30));
  const alpha = finite(options.alpha) ?? 0.01;
  const qualifying = (samples || []).filter((row) => row?.qualifying === true
    && finite(row.basisUsd) != null)
    .sort((left, right) => String(left.tradeDate).localeCompare(String(right.tradeDate)));
  const days = new Set(qualifying.map((row) => `${row.symbol}:${row.tradeDate}`));
  if (days.size < minDays) return {
    ready: false, observationDays: days.size, minDays, boundUsd: null,
    evidenceId: null, reason: 'INSUFFICIENT_UNTOUCHED_EXACT_SOURCE_DAYS',
  };
  const absolute = qualifying.map((row) => Math.abs(finite(row.basisUsd)))
    .sort((a, b) => a - b);
  // Conservative empirical upper quantile plus the maximum observed value.
  // With only 30 days a nonparametric 99% quantile is the maximum; no normal
  // tail extrapolation is permitted.
  const index = Math.min(absolute.length - 1,
    Math.max(0, Math.ceil((1 - alpha) * absolute.length) - 1));
  const boundUsd = Math.max(absolute[index], absolute.at(-1));
  const identity = qualifying.map((row) => [row.sampleId, row.basisUsd]);
  return {
    ready: true,
    observationDays: days.size,
    minDays,
    alpha,
    boundUsd,
    firstTradeDate: qualifying[0].tradeDate,
    lastTradeDate: qualifying.at(-1).tradeDate,
    evidenceId: `eqbb_${crypto.createHash('sha256')
      .update(JSON.stringify(identity)).digest('hex').slice(0, 28)}`,
    reason: null,
  };
}

module.exports = {
  QUALIFYING_PYTH_KIND,
  QUALIFYING_UNDERLYING_SOURCE,
  buildBasisSample,
  frozenBasisBound,
};
