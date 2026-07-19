'use strict';

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeInstrument(raw) {
  const name = String(raw?.instrument_name || raw?.instrumentName || '');
  const currency = String(raw?.base_currency || raw?.currency || '').toUpperCase();
  const strike = finite(raw?.strike);
  const expirationMs = finite(raw?.expiration_timestamp ?? raw?.expirationMs);
  const optionType = String(raw?.option_type || raw?.optionType || '').toLowerCase();
  if (!name || !currency || !(strike > 0) || !(expirationMs > 0)
    || !['call', 'put'].includes(optionType)) return null;
  return {
    instrumentName: name,
    currency,
    strike,
    expirationMs,
    optionType,
    tickSize: finite(raw?.tick_size),
    contractSize: finite(raw?.contract_size),
    makerCommission: finite(raw?.maker_commission),
    takerCommission: finite(raw?.taker_commission),
    settlementPeriod: raw?.settlement_period || null,
    raw,
  };
}

function expiryAnchors(expiries, targetMs) {
  const ordered = [...new Set(expiries)].sort((left, right) => left - right);
  if (!ordered.length) return [];
  const lower = ordered.filter((expiry) => expiry <= targetMs).at(-1);
  const upper = ordered.find((expiry) => expiry >= targetMs);
  const selected = new Set([lower, upper].filter(Number.isFinite));
  // Outside the listed term structure, retain two adjacent expiries so the
  // extrapolation can be diagnosed rather than pretending one tenor is exact.
  if (selected.size < 2 && ordered.length > 1) {
    if (targetMs < ordered[0]) selected.add(ordered[1]);
    else if (targetMs > ordered.at(-1)) selected.add(ordered.at(-2));
    else {
      const anchor = [...selected][0];
      const index = ordered.indexOf(anchor);
      selected.add(ordered[index + 1] ?? ordered[index - 1]);
    }
  }
  return [...selected].sort((left, right) => left - right);
}

function strikeAnchors(rows, targetStrike, perSide = 2) {
  const ordered = [...rows].sort((left, right) => left.strike - right.strike);
  const below = ordered.filter((row) => row.strike <= targetStrike).slice(-perSide);
  const above = ordered.filter((row) => row.strike >= targetStrike).slice(0, perSide);
  return [...new Map([...below, ...above].map((row) => [row.instrumentName, row])).values()];
}

/**
 * Frozen, PnL-independent archive anchors. They keep a compact ATM term
 * structure subscribed even when Polymarket has no matching threshold open.
 * These rows are collection targets only and can never create a shadow mark.
 */
function buildArchiveTargets(indexPrices, currencies, options = {}) {
  const nowMs = finite(options.nowMs) ?? Date.now();
  const horizonsHours = (options.horizonsHours || [24, 168])
    .map(finite).filter((value) => value > 0);
  const source = indexPrices instanceof Map ? indexPrices : new Map(Object.entries(indexPrices || {}));
  return [...new Set((currencies || []).map((value) => String(value).toUpperCase()))]
    .flatMap((currency) => {
      const strike = finite(source.get(currency) ?? source.get(currency.toLowerCase()));
      if (!(strike > 0)) return [];
      return horizonsHours.map((hours) => ({
        id: `archive:${currency}:${hours}h`, currency, strike,
        targetExpiryMs: nowMs + hours * 3_600_000, archiveOnly: true,
      }));
    });
}

/**
 * Select only call instruments needed to interpolate each active Polymarket
 * threshold. Put/call duplicate strikes are deliberately excluded: Deribit
 * ticker IV is the input, while executable call-spread checks are a separate
 * validation and must not silently mix settlement numeraires.
 */
function selectSurfaceInstruments(rawInstruments, rawTargets, options = {}) {
  const perSide = Math.max(1, parseInt(options.strikesPerSide ?? 2, 10));
  const maxInstruments = Math.max(4, parseInt(options.maxInstruments ?? 160, 10));
  const nowMs = finite(options.nowMs) ?? Date.now();
  const instruments = (Array.isArray(rawInstruments) ? rawInstruments : [])
    .map(normalizeInstrument).filter((row) => row && row.optionType === 'call'
      && row.expirationMs > nowMs);
  const targets = (Array.isArray(rawTargets) ? rawTargets : []).map((target) => ({
    ...target,
    currency: String(target.currency || target.asset || '').toUpperCase(),
    strike: finite(target.strike),
    targetExpiryMs: finite(target.targetExpiryMs ?? target.expiryMs ?? target.windowEndMs),
  })).filter((target) => target.currency && target.strike > 0 && target.targetExpiryMs > nowMs);
  const selected = new Map();
  const coverage = [];
  for (const target of targets) {
    const currencyRows = instruments.filter((row) => row.currency === target.currency);
    const expiries = expiryAnchors(currencyRows.map((row) => row.expirationMs), target.targetExpiryMs);
    const names = [];
    for (const expiry of expiries) {
      const anchors = strikeAnchors(currencyRows.filter((row) => row.expirationMs === expiry),
        target.strike, perSide);
      for (const row of anchors) {
        const expiryDistance = Math.abs(row.expirationMs - target.targetExpiryMs) / 86_400_000;
        const strikeDistance = Math.abs(Math.log(row.strike / target.strike));
        const score = expiryDistance + 30 * strikeDistance;
        const previous = selected.get(row.instrumentName);
        if (!previous || score < previous.score) selected.set(row.instrumentName, { ...row, score });
        names.push(row.instrumentName);
      }
    }
    coverage.push({
      targetId: target.id ?? target.marketId ?? target.conditionId ?? null,
      currency: target.currency,
      strike: target.strike,
      targetExpiryMs: target.targetExpiryMs,
      anchorExpiriesMs: expiries,
      instrumentNames: [...new Set(names)],
      covered: expiries.length > 0 && names.length >= 2,
    });
  }
  const bounded = [...selected.values()]
    .sort((left, right) => left.score - right.score
      || left.expirationMs - right.expirationMs || left.strike - right.strike)
    .slice(0, maxInstruments);
  const retained = new Set(bounded.map((row) => row.instrumentName));
  return {
    instruments: bounded.map(({ score, ...row }) => row),
    coverage: coverage.map((row) => ({
      ...row,
      retainedInstrumentNames: row.instrumentNames.filter((name) => retained.has(name)),
      retained: row.instrumentNames.filter((name) => retained.has(name)).length >= 2,
    })),
    targets: targets.length,
    eligibleInstruments: instruments.length,
    truncated: selected.size > bounded.length,
  };
}

module.exports = {
  buildArchiveTargets,
  expiryAnchors,
  normalizeInstrument,
  selectSurfaceInstruments,
  strikeAnchors,
};
