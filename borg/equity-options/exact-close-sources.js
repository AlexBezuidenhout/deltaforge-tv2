'use strict';

const {
  QUALIFYING_PYTH_KIND, QUALIFYING_UNDERLYING_SOURCE,
} = require('./basis');

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function endpoint(template, symbol, tradeDate) {
  if (!template) return null;
  const value = String(template)
    .replaceAll('{symbol}', encodeURIComponent(symbol))
    .replaceAll('{date}', encodeURIComponent(tradeDate));
  const url = new URL(value);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('exact-close source must use HTTPS (except localhost)');
  }
  return url.toString();
}

function normalizePythClose(raw, expected = {}) {
  const symbol = String(raw?.symbol || '').toUpperCase();
  const tradeDate = String(raw?.trade_date || raw?.tradeDate || '');
  const sourceKind = String(raw?.source_kind || raw?.sourceKind || '');
  const close = finite(raw?.close);
  const sourceTs = Date.parse(raw?.source_ts || raw?.sourceTs);
  const valid = symbol === expected.symbol && tradeDate === expected.tradeDate
    && sourceKind === QUALIFYING_PYTH_KIND
    && String(raw?.pyth_feed_symbol || raw?.pythFeedSymbol || '') === expected.pythFeedSymbol
    && close > 0 && Number.isFinite(sourceTs) && Boolean(raw?.evidence_id || raw?.evidenceId);
  return {
    valid, symbol, tradeDate, sourceKind, close,
    sourceTs: Number.isFinite(sourceTs) ? new Date(sourceTs).toISOString() : null,
    evidenceId: raw?.evidence_id || raw?.evidenceId || null,
    pythFeedSymbol: raw?.pyth_feed_symbol || raw?.pythFeedSymbol || null,
    raw,
  };
}

function normalizeOfficialClose(raw, expected = {}) {
  const symbol = String(raw?.symbol || '').toUpperCase();
  const tradeDate = String(raw?.trade_date || raw?.tradeDate || '');
  const source = String(raw?.source || '');
  const close = finite(raw?.close);
  const sourceTs = Date.parse(raw?.source_ts || raw?.sourceTs);
  const valid = symbol === expected.symbol && tradeDate === expected.tradeDate
    && source === QUALIFYING_UNDERLYING_SOURCE && close > 0
    && Number.isFinite(sourceTs) && Boolean(raw?.evidence_id || raw?.evidenceId);
  return {
    valid, symbol, tradeDate, source, close,
    sourceTs: Number.isFinite(sourceTs) ? new Date(sourceTs).toISOString() : null,
    evidenceId: raw?.evidence_id || raw?.evidenceId || null, raw,
  };
}

class ExactCloseSources {
  constructor(options = {}) {
    this.pythTemplate = options.pythTemplate
      || process.env.EQOPT_PYTH_FINAL_CLOSE_URL_TEMPLATE || '';
    this.officialTemplate = options.officialTemplate
      || process.env.EQOPT_PRIMARY_CLOSE_URL_TEMPLATE || '';
    this.bearerToken = options.bearerToken
      || process.env.EQOPT_EXACT_CLOSE_BEARER_TOKEN || '';
    this.fetchImpl = options.fetchImpl || fetch;
    this.onRaw = options.onRaw || (() => {});
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs || 10_000));
  }

  configured() { return Boolean(this.pythTemplate && this.officialTemplate); }

  async get(url, source) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { headers: {
        Accept: 'application/json',
        ...(this.bearerToken ? { Authorization: `Bearer ${this.bearerToken}` } : {}),
      }, signal: controller.signal });
      const body = await response.text();
      this.onRaw({ source, url, status: response.status, body, receivedAt: Date.now() });
      if (!response.ok) throw new Error(`${source} HTTP ${response.status}: ${body.slice(0, 160)}`);
      return JSON.parse(body);
    } finally { clearTimeout(timer); }
  }

  async dailyPair({ symbol, tradeDate, pythFeedSymbol }) {
    if (!this.configured()) return { ready: false, reason: 'EXACT_CLOSE_SOURCES_NOT_CONFIGURED' };
    const expected = { symbol: String(symbol).toUpperCase(), tradeDate, pythFeedSymbol };
    const [pythRaw, officialRaw] = await Promise.all([
      this.get(endpoint(this.pythTemplate, expected.symbol, tradeDate), 'pyth-final-close'),
      this.get(endpoint(this.officialTemplate, expected.symbol, tradeDate), 'official-primary-close'),
    ]);
    const pyth = normalizePythClose(pythRaw, expected);
    const official = normalizeOfficialClose(officialRaw, expected);
    return {
      ready: pyth.valid && official.valid,
      reason: pyth.valid && official.valid ? null : 'EXACT_CLOSE_RESPONSE_FAILED_CERTIFICATION',
      pyth, official,
    };
  }
}

module.exports = {
  ExactCloseSources, endpoint, normalizeOfficialClose, normalizePythClose,
};
