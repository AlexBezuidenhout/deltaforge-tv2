'use strict';

/**
 * Kalshi fee schedules are series-specific and time-varying.  This module
 * normalizes the schedule observed during discovery and refuses to price an
 * unsupported fee type.  Historical marks persist the returned object.
 */

const SUPPORTED_TAKER_FEE_TYPES = new Set([
  'quadratic',
  'quadratic_with_maker_fees',
]);

function finite(value, fallback = null) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundUpCenticent(value) {
  return Math.ceil((Math.max(0, finite(value, 0)) - 1e-12) * 10_000) / 10_000;
}

function roundUpTo(value, precision) {
  const step = Math.max(0.0001, finite(precision, 0.0001));
  return Math.ceil((Math.max(0, finite(value, 0)) - 1e-12) / step) * step;
}

function roundDownTo(value, precision) {
  const step = Math.max(0.0001, finite(precision, 0.0001));
  return Math.floor((Math.max(0, finite(value, 0)) + 1e-12) / step) * step;
}

function money(value) {
  return Number(Math.max(0, finite(value, 0)).toFixed(10));
}

function normalizeKalshiFeeSchedule(raw = {}, options = {}) {
  const feeType = String(raw.fee_type ?? raw.feeType ?? '').trim().toLowerCase() || null;
  const feeMultiplier = finite(raw.fee_multiplier ?? raw.feeMultiplier);
  // Kalshi rounds the model fee to $0.0001, but a non-direct member's actual
  // balance is restored to whole-cent precision after each order's fills.
  // Public series metadata does not identify the account's membership class,
  // so paper research deliberately assumes the more expensive retail path.
  const tradeFeePrecisionUsd = Math.max(0.0001, finite(
    options.tradeFeePrecisionUsd
      ?? raw.trade_fee_precision_usd ?? raw.tradeFeePrecisionUsd,
    0.0001,
  ));
  const balancePrecisionUsd = Math.max(tradeFeePrecisionUsd, finite(
    options.balancePrecisionUsd
      ?? raw.balance_precision_usd ?? raw.balancePrecisionUsd,
    0.01,
  ));
  const observedAt = Number.isFinite(Date.parse(options.observedAt || ''))
    ? new Date(options.observedAt).toISOString() : new Date().toISOString();
  const supported = SUPPORTED_TAKER_FEE_TYPES.has(feeType)
    && feeMultiplier != null && feeMultiplier >= 0;
  return {
    version: 'kalshi-series-fee-v2',
    seriesTicker: options.seriesTicker || raw.ticker || null,
    feeType,
    feeMultiplier,
    takerCoefficient: supported ? 0.07 * feeMultiplier : null,
    makerCoefficient: feeType === 'quadratic_with_maker_fees'
      && feeMultiplier != null ? 0.0175 * feeMultiplier : null,
    tradeFeePrecisionUsd,
    balancePrecisionUsd,
    membershipAssumption: options.membershipAssumption
      || raw.membershipAssumption || 'NON_DIRECT_CONSERVATIVE',
    source: options.source || 'kalshi_get_series',
    observedAt,
    supported,
    reason: supported ? 'SUPPORTED'
      : !feeType ? 'MISSING_FEE_TYPE'
        : feeMultiplier == null ? 'MISSING_FEE_MULTIPLIER'
          : `UNSUPPORTED_FEE_TYPE:${feeType}`,
  };
}

function legacyQuadraticSchedule(multiplier = 1) {
  return normalizeKalshiFeeSchedule({
    fee_type: 'quadratic',
    fee_multiplier: finite(multiplier, 1),
  }, {
    source: 'legacy_explicit_multiplier',
    observedAt: '1970-01-01T00:00:00.000Z',
    balancePrecisionUsd: 0.0001,
    membershipAssumption: 'LEGACY_FORMULA_ONLY',
  });
}

function coerceSchedule(scheduleOrMultiplier) {
  if (typeof scheduleOrMultiplier === 'number' || typeof scheduleOrMultiplier === 'string') {
    return legacyQuadraticSchedule(scheduleOrMultiplier);
  }
  if (!scheduleOrMultiplier || typeof scheduleOrMultiplier !== 'object') return null;
  if (scheduleOrMultiplier.version === 'kalshi-series-fee-v2') return scheduleOrMultiplier;
  return normalizeKalshiFeeSchedule(scheduleOrMultiplier, {
    seriesTicker: scheduleOrMultiplier.seriesTicker,
    source: scheduleOrMultiplier.source,
    observedAt: scheduleOrMultiplier.observedAt,
    tradeFeePrecisionUsd: scheduleOrMultiplier.tradeFeePrecisionUsd,
    balancePrecisionUsd: scheduleOrMultiplier.balancePrecisionUsd,
    membershipAssumption: scheduleOrMultiplier.membershipAssumption,
  });
}

function feeForFills(fills, scheduleOrMultiplier, liquidity = 'taker', cashflow = 'buy') {
  const schedule = coerceSchedule(scheduleOrMultiplier);
  if (!schedule?.supported) return null;
  const coefficient = liquidity === 'maker'
    ? schedule.makerCoefficient : schedule.takerCoefficient;
  if (!(coefficient >= 0)) return null;
  const totals = (Array.isArray(fills) ? fills : []).reduce((acc, fill) => {
    const size = finite(fill?.size, 0);
    const price = finite(fill?.price);
    if (!(size > 0 && price > 0 && price < 1)) return acc;
    acc.positionCost += size * price;
    // The exchange rounds each fill's model fee up to a centicent before
    // applying the per-order rounding accumulator.
    acc.tradeFee += roundUpTo(
      coefficient * size * price * (1 - price),
      schedule.tradeFeePrecisionUsd,
    );
    return acc;
  }, { positionCost: 0, tradeFee: 0 });
  if (!(totals.positionCost > 0)) return 0;

  const balancePrecision = schedule.balancePrecisionUsd;
  if (cashflow === 'sell') {
    const credited = roundDownTo(
      Math.max(0, totals.positionCost - totals.tradeFee),
      balancePrecision,
    );
    return money(totals.positionCost - credited);
  }
  const debited = roundUpTo(
    totals.positionCost + totals.tradeFee,
    balancePrecision,
  );
  return money(debited - totals.positionCost);
}

module.exports = {
  SUPPORTED_TAKER_FEE_TYPES,
  coerceSchedule,
  feeForFills,
  legacyQuadraticSchedule,
  normalizeKalshiFeeSchedule,
  roundUpCenticent,
  roundUpTo,
};
