'use strict';

/**
 * Read-only Interactive Brokers OPRA adapter.
 *
 * This module exposes only authentication status, contract discovery, and
 * market-data reads. It intentionally has no account, what-if, order, cancel,
 * or position endpoint. Delayed/frozen market data is retained diagnostically
 * but can never be marked live-entitled execution evidence.
 */

const SNAPSHOT_FIELDS = Object.freeze(['31', '84', '85', '86', '88', '6509']);

function finite(value) {
  if (value == null || value === '') return null;
  const normalized = String(value).replace(/,/g, '').trim();
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(normalized)) return null;
  const parsed = parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function epochMs(value) {
  const parsed = finite(value);
  if (parsed != null) return parsed < 1e12 ? parsed * 1000 : parsed;
  const date = Date.parse(value);
  return Number.isFinite(date) ? date : null;
}

function isLiveAvailability(value) {
  const code = String(value || '').trim().toUpperCase();
  // IBKR's real-time examples use availability codes beginning with R (for
  // example RpB). D/F states are delayed or frozen and are never executable
  // evidence even when bid/ask fields are populated.
  return /^R/.test(code) && !/[DF]/.test(code);
}

function parseMarketDataRow(raw, contract = {}, envelope = {}) {
  const conid = Math.trunc(finite(raw?.conid ?? raw?.conidEx) ?? 0);
  const sourceMs = epochMs(raw?._updated);
  const bid = finite(raw?.['84']);
  const ask = finite(raw?.['86']);
  const bidSize = finite(raw?.['88']);
  const askSize = finite(raw?.['85']);
  const availability = String(raw?.['6509'] || '');
  const liveEntitled = isLiveAvailability(availability);
  const completeBook = bid != null && ask != null && ask >= bid
    && bidSize > 0 && askSize > 0;
  return {
    conid: conid > 0 ? conid : null,
    instrumentId: String(contract.instrumentId || contract.localSymbol || conid || ''),
    underlying: String(contract.underlying || '').toUpperCase(),
    optionType: contract.optionType || null,
    strike: finite(contract.strike),
    expiryMs: epochMs(contract.expiryMs ?? contract.expiryAt),
    multiplier: finite(contract.multiplier),
    bid,
    ask,
    bidSize,
    askSize,
    last: finite(raw?.['31']),
    availability,
    liveEntitled,
    sourceMs,
    receiveMs: finite(envelope.receiveMs) ?? Date.now(),
    receiveMonoNs: envelope.receiveMonoNs == null
      ? process.hrtime.bigint().toString() : String(envelope.receiveMonoNs),
    connectionEpoch: Math.trunc(finite(envelope.connectionEpoch) ?? 0),
    eventSequence: Math.trunc(finite(envelope.eventSequence) ?? 0),
    completeBook,
    dataQualityGrade: liveEntitled && completeBook && sourceMs != null ? 'A'
      : completeBook && sourceMs != null ? 'D' : 'F',
    raw,
  };
}

function parseExpiry(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!/^\d{8}$/.test(digits)) return null;
  const year = digits.slice(0, 4);
  const month = digits.slice(4, 6);
  const day = digits.slice(6, 8);
  // IBKR contract metadata is a calendar expiry, not a timestamp. Do not
  // manufacture a 20:00 UTC close: New York regular-session close changes by
  // an hour across DST. The certified Polymarket target supplies the exact
  // settlement timestamp after the calendar dates are matched.
  const parsed = Date.parse(`${year}-${month}-${day}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeOptionContract(raw, context = {}) {
  const conid = Math.trunc(finite(raw?.conid ?? raw?.conidEx) ?? 0);
  const underlying = String(context.underlying || raw?.underlyingSymbol
    || raw?.symbol || '').toUpperCase();
  const rightText = String(raw?.right || raw?.optionRight || raw?.putOrCall || '').toUpperCase();
  const optionType = rightText.startsWith('C') ? 'call'
    : rightText.startsWith('P') ? 'put' : null;
  const expiryMs = parseExpiry(raw?.maturityDate ?? raw?.expirationDate
    ?? raw?.lastTradeDateOrContractMonth);
  const tradingClass = String(raw?.tradingClass || raw?.symbol || '').toUpperCase();
  const multiplier = finite(raw?.multiplier);
  const strike = finite(raw?.strike);
  const adjusted = raw?.adjusted === true || (tradingClass && underlying
    ? tradingClass !== underlying : true);
  const standard = conid > 0 && underlying && optionType && expiryMs != null
    && strike > 0 && multiplier === 100 && !adjusted;
  return {
    conid: conid > 0 ? conid : null,
    instrumentId: String(raw?.localSymbol || raw?.symbol || conid || ''),
    localSymbol: raw?.localSymbol || null,
    underlying,
    underlyingConid: Math.trunc(finite(context.underlyingConid) ?? 0) || null,
    optionType,
    strike,
    expiryMs,
    expiryDate: expiryMs == null ? null : new Date(expiryMs).toISOString().slice(0, 10),
    multiplier,
    tradingClass: tradingClass || null,
    exchange: String(raw?.exchange || raw?.listingExchange || context.exchange || 'SMART'),
    exerciseStyle: standard ? 'AMERICAN' : null,
    settlementStyle: standard ? 'PHYSICAL' : null,
    adjusted,
    metadataGrade: standard ? 'A' : 'F',
    valid: Boolean(standard && context.underlyingConid),
    raw,
  };
}

function monthCode(expiryMs) {
  const date = new Date(Number(expiryMs));
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase()}${String(date.getUTCFullYear()).slice(-2)}`;
}

class IbkrReadOnlyClient {
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || process.env.IBKR_CLIENT_PORTAL_URL || '')
      .replace(/\/$/, '');
    this.bearerToken = options.bearerToken || process.env.IBKR_WEBAPI_BEARER_TOKEN || null;
    this.cookie = options.cookie || process.env.IBKR_CLIENT_PORTAL_COOKIE || null;
    this.fetchImpl = options.fetchImpl || fetch;
    this.onRaw = options.onRaw || (() => {});
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs || 10_000));
    this.connectionEpoch = 1;
    this.eventSequence = 0;
  }

  configured() { return Boolean(this.baseUrl); }

  async request(path, options = {}) {
    if (!this.configured()) throw Object.assign(new Error('IBKR read-only endpoint is not configured'), {
      code: 'IBKR_NOT_CONFIGURED',
    });
    if (!String(path).startsWith('/iserver/')) {
      throw new Error(`IBKR adapter refuses non-market-data path: ${path}`);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: options.method || 'GET',
        headers: {
          Accept: 'application/json',
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(this.bearerToken ? { Authorization: `Bearer ${this.bearerToken}` } : {}),
          ...(this.cookie ? { Cookie: this.cookie } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      this.onRaw({ path, method: options.method || 'GET', status: response.status,
        body: text, receivedAt: Date.now() });
      if (!response.ok) {
        throw Object.assign(new Error(`IBKR HTTP ${response.status}: ${text.slice(0, 160)}`), {
          status: response.status,
        });
      }
      return text ? JSON.parse(text) : null;
    } finally { clearTimeout(timeout); }
  }

  async authStatus() {
    const row = await this.request('/iserver/auth/status');
    return {
      authenticated: row?.authenticated === true,
      connected: row?.connected === true,
      competing: row?.competing === true,
      ready: row?.authenticated === true && row?.connected === true
        && row?.competing !== true,
    };
  }

  async searchUnderlying(symbol) {
    const rows = await this.request('/iserver/secdef/search', {
      method: 'POST', body: { symbol: String(symbol).toUpperCase(), secType: 'STK' },
    });
    const exact = (Array.isArray(rows) ? rows : []).filter((row) =>
      String(row?.symbol || '').toUpperCase() === String(symbol).toUpperCase());
    if (exact.length !== 1) return null;
    return { conid: Math.trunc(finite(exact[0].conid) ?? 0) || null, raw: exact[0] };
  }

  async strikes(underlyingConid, expiryMs) {
    const month = monthCode(expiryMs);
    if (!month) return { call: [], put: [] };
    const params = new URLSearchParams({
      conid: String(underlyingConid), sectype: 'OPT', month, exchange: 'SMART',
    });
    const row = await this.request(`/iserver/secdef/strikes?${params}`);
    return {
      call: (row?.call || []).map(finite).filter((value) => value > 0),
      put: (row?.put || []).map(finite).filter((value) => value > 0),
    };
  }

  async optionInfo({ underlying, underlyingConid, expiryMs, strike, optionType }) {
    const month = monthCode(expiryMs);
    const right = optionType === 'call' ? 'C' : optionType === 'put' ? 'P' : null;
    if (!month || !right || !(finite(strike) > 0)) return [];
    const params = new URLSearchParams({
      conid: String(underlyingConid), sectype: 'OPT', month,
      strike: String(strike), right, exchange: 'SMART',
    });
    const rows = await this.request(`/iserver/secdef/info?${params}`);
    const targetDate = new Date(Number(expiryMs)).toISOString().slice(0, 10);
    return (Array.isArray(rows) ? rows : []).map((row) => normalizeOptionContract(row, {
      underlying, underlyingConid, exchange: 'SMART',
    })).filter((contract) => contract.valid && contract.expiryDate === targetDate)
      .map((contract) => ({
        ...contract,
        contractExpiryDate: contract.expiryDate,
        // Exact target timestamp, including its DST-aware close, is now the
        // shared synchronization key used by the evaluator and SQL surface.
        expiryMs: Number(expiryMs),
      }));
  }

  async snapshot(conids, contracts = new Map()) {
    const ids = [...new Set((conids || []).map((value) => Math.trunc(finite(value) ?? 0))
      .filter((value) => value > 0))];
    if (!ids.length) return [];
    const params = new URLSearchParams({
      conids: ids.join(','), fields: SNAPSHOT_FIELDS.join(','),
    });
    const receiveMs = Date.now();
    const receiveMonoNs = process.hrtime.bigint().toString();
    const rows = await this.request(`/iserver/marketdata/snapshot?${params}`);
    return (Array.isArray(rows) ? rows : []).map((row) => {
      this.eventSequence += 1;
      return parseMarketDataRow(row, contracts.get(String(row.conid))
        || contracts.get(Number(row.conid)) || {}, {
        receiveMs, receiveMonoNs, connectionEpoch: this.connectionEpoch,
        eventSequence: this.eventSequence,
      });
    });
  }

  async primedSnapshot(conids, contracts = new Map(), waitMs = 550) {
    await this.snapshot(conids, contracts);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, waitMs)));
    return this.snapshot(conids, contracts);
  }
}

module.exports = {
  IbkrReadOnlyClient,
  SNAPSHOT_FIELDS,
  finite,
  isLiveAvailability,
  monthCode,
  normalizeOptionContract,
  parseMarketDataRow,
};
