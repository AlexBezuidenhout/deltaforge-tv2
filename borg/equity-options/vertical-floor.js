'use strict';

/**
 * Paper-only robust vertical-complement evaluator for Pyth equity thresholds.
 *
 * Prices from Polymarket remain on the 0-1 token scale. Listed-option prices
 * remain dollars per underlying share and are multiplied by the contract
 * multiplier only inside the option leg. Mixing those scales is prohibited.
 */

const crypto = require('node:crypto');
const { walkShares, worstIncompleteFillUnwindPnl } = require('../structural/bregman');

const VERTICAL_FLOOR_VERSION = 'equity-pyth-vertical-floor-v1';

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeOptionQuote(raw) {
  const optionType = String(raw?.optionType ?? raw?.right ?? '').toLowerCase();
  const type = optionType.startsWith('c') ? 'call' : optionType.startsWith('p') ? 'put' : null;
  const quote = {
    instrumentId: String(raw?.instrumentId ?? raw?.conid ?? raw?.symbol ?? ''),
    underlying: String(raw?.underlying ?? raw?.underlyingSymbol ?? '').toUpperCase(),
    optionType: type,
    strike: finite(raw?.strike),
    expiryMs: finite(raw?.expiryMs ?? raw?.expirationMs),
    bid: finite(raw?.bid),
    ask: finite(raw?.ask),
    bidSize: finite(raw?.bidSize ?? raw?.bid_size),
    askSize: finite(raw?.askSize ?? raw?.ask_size),
    multiplier: finite(raw?.multiplier) ?? 100,
    sourceMs: finite(raw?.sourceMs ?? raw?.source_timestamp_ms),
    receiveMs: finite(raw?.receiveMs ?? raw?.receive_timestamp_ms),
    adjusted: raw?.adjusted === true,
    exerciseStyle: String(raw?.exerciseStyle || '').toUpperCase() || null,
    settlementStyle: String(raw?.settlementStyle || '').toUpperCase() || null,
  };
  quote.valid = Boolean(quote.instrumentId && quote.underlying && quote.optionType
    && quote.strike > 0 && Number.isFinite(quote.expiryMs)
    && quote.bid >= 0 && quote.ask >= quote.bid
    && quote.bidSize > 0 && quote.askSize > 0 && quote.multiplier > 0
    && Number.isFinite(quote.sourceMs) && Number.isFinite(quote.receiveMs));
  return quote;
}

function quoteFresh(quote, nowMs, maxAgeMs) {
  return quote.valid && nowMs - quote.receiveMs <= maxAgeMs
    && nowMs - quote.sourceMs <= maxAgeMs
    && quote.receiveMs <= nowMs + 1000 && quote.sourceMs <= nowMs + 1000;
}

function polyBookFresh(book, nowMs, maxAgeMs) {
  const at = finite(book?.at ?? book?.receivedAt ?? book?.receiveMs);
  return at != null && at <= nowMs + 1000 && nowMs - at <= maxAgeMs;
}

function optionLegUnwindPnl({ entryPrice, exitPrice, contracts, multiplier,
  optionFeePerContractPerLeg, feeMultiplier }) {
  return (exitPrice - entryPrice) * contracts * multiplier
    - contracts * optionFeePerContractPerLeg * 2 * feeMultiplier;
}

function verticalIdentity(side, target, lower, upper, basisBoundUsd) {
  if (side === 'NO_CALL') {
    if (lower.optionType !== 'call' || upper.optionType !== 'call'
        || !(lower.strike < upper.strike)
        || !(upper.strike <= target.strike - basisBoundUsd + 1e-9)) return null;
    return {
      side: 'NO', tokenId: target.noToken, optionType: 'call',
      long: lower, short: upper,
      geometry: `upper_call_strike<=K-basis_bound`,
    };
  }
  if (side === 'YES_PUT') {
    if (lower.optionType !== 'put' || upper.optionType !== 'put'
        || !(lower.strike < upper.strike)
        || !(lower.strike >= target.strike + basisBoundUsd - 1e-9)) return null;
    return {
      side: 'YES', tokenId: target.yesToken, optionType: 'put',
      long: upper, short: lower,
      geometry: `lower_put_strike>=K+basis_bound`,
    };
  }
  return null;
}

function evaluateIdentity(identity, target, polyBook, config) {
  const { long, short } = identity;
  const width = upperMinusLower(long, short);
  if (!(width > 0) || long.multiplier !== short.multiplier) return null;
  const multiplier = long.multiplier;
  const sharesPerContract = width * multiplier;
  if (!(sharesPerContract >= target.minimumOrderSize)) return null;
  const polyAsks = Array.isArray(polyBook?.asks) ? polyBook.asks : [];
  const polyBids = Array.isArray(polyBook?.bids) ? polyBook.bids : [];
  const polyDepth = polyAsks.reduce((sum, level) =>
    sum + (finite(level?.size ?? level?.[1]) ?? 0), 0);
  const maxContracts = Math.floor(Math.min(
    long.askSize,
    short.bidSize,
    polyDepth / sharesPerContract,
    config.maxContracts,
  ));
  if (maxContracts < 1) return null;

  const rows = [];
  for (let contracts = 1; contracts <= maxContracts; contracts += 1) {
    const tokenShares = sharesPerContract * contracts;
    const polyEntry = walkShares(polyAsks, tokenShares,
      target.fees.rate, target.fees.exponent, config.feeMultiplier, 'ASK');
    const polyExit = walkShares(polyBids, tokenShares,
      target.fees.rate, target.fees.exponent, config.feeMultiplier, 'BID');
    if (!polyEntry || !polyExit) continue;
    const verticalDebitUsd = Math.max(0,
      (long.ask - short.bid) * multiplier * contracts);
    const optionFeeStressUsd = contracts * 2
      * config.optionFeePerContractPerLeg * config.feeMultiplier;
    const optionTickStressUsd = contracts * multiplier * 2 * config.optionTickSizeUsd;
    const assignmentReserveUsd = contracts * config.assignmentReserveUsdPerContract;
    const stressedCostUsd = polyEntry.gross + polyEntry.fees + verticalDebitUsd
      + optionFeeStressUsd + optionTickStressUsd + assignmentReserveUsd;
    const conditionalGuaranteedPayoutUsd = tokenShares;
    // Before the first valid regular-session print, the contract's explicit
    // no-trading 50/50 state remains possible and the option leg's worst
    // payoff is zero. It must not be advertised as a one-dollar lock.
    const unconditionalGuaranteedPayoutUsd = config.regularSessionTradeObserved
      ? conditionalGuaranteedPayoutUsd : tokenShares * 0.5;
    const stressedProfitUsd = unconditionalGuaranteedPayoutUsd - stressedCostUsd;

    const polyOrphanPnl = polyExit.gross - polyExit.fees
      - polyEntry.gross - polyEntry.fees;
    const longOrphanPnl = optionLegUnwindPnl({
      entryPrice: long.ask, exitPrice: long.bid, contracts, multiplier,
      optionFeePerContractPerLeg: config.optionFeePerContractPerLeg,
      feeMultiplier: config.feeMultiplier,
    });
    // A short option is opened at its bid and bought back at its ask.
    const shortOrphanPnl = optionLegUnwindPnl({
      entryPrice: -short.bid, exitPrice: -short.ask, contracts, multiplier,
      optionFeePerContractPerLeg: config.optionFeePerContractPerLeg,
      feeMultiplier: config.feeMultiplier,
    });
    const worstOrphanUnwindPnl = worstIncompleteFillUnwindPnl([
      polyOrphanPnl, longOrphanPnl, shortOrphanPnl,
    ]);
    const orphanReserveUsd = worstOrphanUnwindPnl == null
      ? null : Math.max(0, -worstOrphanUnwindPnl);
    const orphanSafeProfitUsd = orphanReserveUsd == null
      ? null : stressedProfitUsd - orphanReserveUsd;
    const capitalRequiredUsd = stressedCostUsd + (orphanReserveUsd ?? Infinity);
    rows.push({
      version: VERTICAL_FLOOR_VERSION,
      targetRuleHash: target.ruleHash,
      symbol: target.symbol,
      gammaId: target.gammaId,
      conditionId: target.conditionId,
      strike: target.strike,
      expiryMs: target.expiryMs,
      side: identity.side,
      tokenId: identity.tokenId,
      optionType: identity.optionType,
      longInstrumentId: long.instrumentId,
      shortInstrumentId: short.instrumentId,
      longStrike: long.strike,
      shortStrike: short.strike,
      width,
      multiplier,
      contracts,
      tokenShares,
      basisBoundUsd: config.basisBoundUsd,
      basisEvidenceId: config.basisEvidenceId,
      basisObservationDays: config.basisObservationDays,
      regularSessionTradeObserved: config.regularSessionTradeObserved,
      polyEntry,
      verticalDebitUsd,
      optionFeeStressUsd,
      optionTickStressUsd,
      assignmentReserveUsd,
      conditionalGuaranteedPayoutUsd,
      unconditionalGuaranteedPayoutUsd,
      stressedCostUsd,
      stressedProfitUsd,
      orphanPnls: { polyOrphanPnl, longOrphanPnl, shortOrphanPnl },
      worstOrphanUnwindPnl,
      orphanReserveUsd,
      orphanSafeProfitUsd,
      capitalRequiredUsd,
      qualified: config.regularSessionTradeObserved
        && config.corporateActionClear
        && capitalRequiredUsd <= config.budgetUsd
        && orphanSafeProfitUsd >= config.minProfitUsd,
    });
  }
  return rows;
}

function upperMinusLower(long, short) {
  return Math.abs(long.strike - short.strike);
}

function scanRobustVerticals(input = {}) {
  const nowMs = finite(input.nowMs) ?? Date.now();
  const target = input.target;
  const rawConfig = input.config || {};
  const config = {
    basisBoundUsd: finite(rawConfig.basisBoundUsd),
    basisEvidenceId: String(rawConfig.basisEvidenceId || ''),
    basisObservationDays: finite(rawConfig.basisObservationDays),
    regularSessionTradeObserved: rawConfig.regularSessionTradeObserved === true,
    corporateActionClear: rawConfig.corporateActionClear === true,
    optionFeePerContractPerLeg: finite(rawConfig.optionFeePerContractPerLeg),
    optionTickSizeUsd: finite(rawConfig.optionTickSizeUsd),
    assignmentReserveUsdPerContract: finite(rawConfig.assignmentReserveUsdPerContract),
    feeMultiplier: finite(rawConfig.feeMultiplier) ?? 2,
    budgetUsd: finite(rawConfig.budgetUsd) ?? 500,
    minProfitUsd: finite(rawConfig.minProfitUsd) ?? 1,
    maxContracts: Math.max(1, Math.floor(finite(rawConfig.maxContracts) ?? 5)),
    maxAgeMs: Math.max(1, finite(rawConfig.maxAgeMs) ?? 1000),
  };
  const failures = [];
  if (!target?.certified || !(target.strike > 0) || !Number.isFinite(target.expiryMs)
      || !target.yesToken || !target.noToken || !target.fees?.known
      || !(target.minimumOrderSize > 0)) failures.push('UNCERTIFIED_POLYMARKET_TARGET');
  if (!(config.basisBoundUsd >= 0) || !config.basisEvidenceId
      || !(config.basisObservationDays >= 30)) failures.push('INSUFFICIENT_FROZEN_BASIS_EVIDENCE');
  if (config.optionFeePerContractPerLeg == null || config.optionFeePerContractPerLeg < 0
      || config.optionTickSizeUsd == null || config.optionTickSizeUsd < 0
      || config.assignmentReserveUsdPerContract == null
      || config.assignmentReserveUsdPerContract < 0) failures.push('UNKNOWN_OPTION_COST_OR_ASSIGNMENT_RESERVE');
  if (!(config.feeMultiplier >= 2)) failures.push('FEE_STRESS_BELOW_TWO_TIMES');
  if (!config.corporateActionClear) failures.push('CORPORATE_ACTION_NOT_CLEARED');
  if (!config.regularSessionTradeObserved) failures.push('NO_SESSION_STATE_NOT_ELIMINATED');
  const books = input.polyBooks || {};
  if (!polyBookFresh(books.yes, nowMs, config.maxAgeMs)
      || !polyBookFresh(books.no, nowMs, config.maxAgeMs)) {
    failures.push('POLYMARKET_BOOK_STALE_OR_UNTIMESTAMPED');
  }
  if (failures.length) return {
    version: VERTICAL_FLOOR_VERSION, candidates: [], qualified: [], failures,
  };

  const quotes = (input.optionQuotes || []).map(normalizeOptionQuote)
    .filter((quote) => quoteFresh(quote, nowMs, config.maxAgeMs)
      && quote.underlying === target.symbol && quote.expiryMs === target.expiryMs
      && quote.adjusted === false && quote.exerciseStyle === 'AMERICAN'
      && quote.settlementStyle === 'PHYSICAL');
  if (!quotes.length) return {
    version: VERTICAL_FLOOR_VERSION, candidates: [], qualified: [],
    failures: ['NO_FRESH_EXACT_EXPIRY_OPTION_QUOTES'],
  };
  const candidates = [];
  for (const optionType of ['call', 'put']) {
    const rows = quotes.filter((quote) => quote.optionType === optionType)
      .sort((left, right) => left.strike - right.strike);
    for (let low = 0; low < rows.length - 1; low += 1) {
      for (let high = low + 1; high < rows.length; high += 1) {
        const mode = optionType === 'call' ? 'NO_CALL' : 'YES_PUT';
        const identity = verticalIdentity(mode, target, rows[low], rows[high], config.basisBoundUsd);
        if (!identity) continue;
        const polyBook = identity.side === 'YES' ? books.yes : books.no;
        const evaluations = evaluateIdentity(identity, target, polyBook, config) || [];
        for (const evaluation of evaluations) {
          const idBody = [VERTICAL_FLOOR_VERSION, target.ruleHash, identity.side,
            evaluation.longInstrumentId, evaluation.shortInstrumentId,
            evaluation.contracts, config.basisEvidenceId].join('|');
          evaluation.candidateId = `eqv_${crypto.createHash('sha256')
            .update(idBody).digest('hex').slice(0, 24)}`;
          candidates.push(evaluation);
        }
      }
    }
  }
  candidates.sort((left, right) => (right.orphanSafeProfitUsd ?? -Infinity)
    - (left.orphanSafeProfitUsd ?? -Infinity));
  return {
    version: VERTICAL_FLOOR_VERSION,
    candidates,
    qualified: candidates.filter((candidate) => candidate.qualified),
    failures: candidates.length ? [] : ['NO_ROBUST_VERTICAL_GEOMETRY_AT_DISPLAYED_DEPTH'],
  };
}

module.exports = {
  VERTICAL_FLOOR_VERSION,
  normalizeOptionQuote,
  polyBookFresh,
  quoteFresh,
  scanRobustVerticals,
  verticalIdentity,
};
