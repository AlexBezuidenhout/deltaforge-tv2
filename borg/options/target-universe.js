'use strict';

/**
 * Expand the option lane only where a Polymarket threshold boundary exactly
 * matches a listed Deribit expiration. This is a collection rule, not a PnL
 * filter: every strike in the certified event is retained and the valuation
 * layer still fails closed unless executable A/B surface data clears costs.
 */

const crypto = require('node:crypto');
const {
  eventType, marketRecord,
} = require('../recon/research-universe');
const { normalizeInstrument } = require('./surface-universe');

const TARGET_UNIVERSE_VERSION = 'options-exact-expiry-targets-v2';

function normalizedText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function certifyResolverRule(event, market, record) {
  const text = normalizedText([
    event?.title, event?.description, event?.resolutionSource,
    market?.question, market?.description, market?.resolutionSource,
  ].filter(Boolean).join(' '));
  const assetPair = record.asset === 'btc' ? /\bbtc\s*\/\s*usdt\b/
    : record.asset === 'eth' ? /\beth\s*\/\s*usdt\b/ : /$a/;
  const checks = {
    binaryAbovePredicate: /\babove\b/.test(normalizedText(market?.question)),
    closePrice: /\bclose\b/.test(text),
    exactHourlyCandle: /\b1\s*(?:hour|hr)\b/.test(text) && /\bcandle\b/.test(text),
    recognizedResolver: record.resolution_source === 'binance_1h_close',
    resolverPair: /\bbinance\b/.test(text) && assetPair.test(text),
    timestampPresent: Number.isFinite(record.window_end?.getTime()),
    twoTokens: Boolean(record.up_token_id && record.down_token_id
      && record.up_token_id !== record.down_token_id),
  };
  const failures = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
  const body = {
    version: TARGET_UNIVERSE_VERSION,
    eventId: String(event?.id || event?.slug || ''),
    gammaId: String(market?.id || ''),
    conditionId: market?.conditionId || null,
    expiry: record.window_end?.toISOString?.() || null,
    asset: record.asset,
    resolutionSource: record.resolution_source,
    checks,
  };
  return {
    valid: failures.length === 0,
    failures,
    proofHash: sha256(JSON.stringify(body)),
    body,
  };
}

function selectExactExpiryThresholds(events, rawInstruments, options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const minTteMs = Math.max(0, Number(options.minTteMs || 0));
  const maxTteMs = Math.max(minTteMs, Number(options.maxTteMs || 7 * 86_400_000));
  const currencies = new Set((options.currencies || ['BTC', 'ETH'])
    .map((value) => String(value).toUpperCase()));
  const expiries = new Map();
  for (const raw of Array.isArray(rawInstruments) ? rawInstruments : []) {
    const instrument = normalizeInstrument(raw);
    if (!instrument || instrument.optionType !== 'call'
        || !currencies.has(instrument.currency)) continue;
    const set = expiries.get(instrument.currency) || new Set();
    set.add(instrument.expirationMs);
    expiries.set(instrument.currency, set);
  }

  const selected = [];
  const rejected = {};
  for (const event of Array.isArray(events) ? events : []) {
    if (eventType(event) !== 'threshold_daily') continue;
    for (const market of event?.markets || []) {
      const record = marketRecord(event, market, 'threshold_daily');
      if (!record || !record.accepting_orders || !(record.strike > 1)) continue;
      const currency = record.asset.toUpperCase();
      if (!currencies.has(currency)) continue;
      const expiryMs = record.window_end.getTime();
      if (expiryMs - nowMs < minTteMs || expiryMs - nowMs > maxTteMs) continue;
      if (!expiries.get(currency)?.has(expiryMs)) {
        rejected.NO_LISTED_EXACT_EXPIRY = (rejected.NO_LISTED_EXACT_EXPIRY || 0) + 1;
        continue;
      }
      const certification = certifyResolverRule(event, market, record);
      if (!certification.valid) {
        for (const failure of certification.failures) {
          rejected[`RULE_${failure}`] = (rejected[`RULE_${failure}`] || 0) + 1;
        }
        continue;
      }
      selected.push({
        ...record,
        window_start: new Date(expiryMs - 3_600_000),
        timeframe_sec: 3600,
        resolution_source: 'binance_1h_close',
        raw: {
          ...record.raw,
          _optionsExactExpiry: {
            universeVersion: TARGET_UNIVERSE_VERSION,
            resolverCertification: certification,
            deribitExpiryMs: expiryMs,
          },
        },
      });
    }
  }
  return {
    records: [...new Map(selected.map((record) => [record.slug, record])).values()],
    rejected,
    listedExpiries: Object.fromEntries([...expiries]
      .map(([currency, values]) => [currency, [...values].sort((a, b) => a - b)])),
    universeVersion: TARGET_UNIVERSE_VERSION,
  };
}

module.exports = {
  TARGET_UNIVERSE_VERSION,
  certifyResolverRule,
  selectExactExpiryThresholds,
};
