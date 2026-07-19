const DEFAULT_MIN_MARKET_ENTRY = 0.4;
const DEFAULT_CRYPTO_TAKER_RATE = 0.07;

function isEntryPriceAllowed(entryPrice, minEntryPrice = DEFAULT_MIN_MARKET_ENTRY) {
  return Number.isFinite(entryPrice) && entryPrice >= minEntryPrice;
}

function withDipOutcomePrice(signal, watchedOutcomePrice) {
  const outcomePrice = Number(watchedOutcomePrice);
  if (!Number.isFinite(outcomePrice)) return { ...signal };

  if (signal.direction === 'NO') {
    return {
      ...signal,
      rawPrice: Number((1 - outcomePrice).toFixed(6)),
      rawOutcomePrice: outcomePrice,
    };
  }

  return {
    ...signal,
    rawPrice: outcomePrice,
    rawOutcomePrice: outcomePrice,
  };
}

function getRawOutcomePrice(signal) {
  if (Number.isFinite(signal?.rawOutcomePrice)) {
    return signal.rawOutcomePrice;
  }

  const rawYesPrice = signal?.rawPrice ?? signal?.yesPrice;
  if (!Number.isFinite(rawYesPrice)) return null;

  return signal?.direction === 'NO'
    ? 1 - rawYesPrice
    : rawYesPrice;
}

function calculateSlippageTicks(fillPrice, referencePrice, tickSize = 0.01) {
  if (
    !Number.isFinite(fillPrice) ||
    !Number.isFinite(referencePrice) ||
    !Number.isFinite(tickSize) ||
    tickSize <= 0
  ) {
    return null;
  }

  return Number(((fillPrice - referencePrice) / tickSize).toFixed(2));
}

/**
 * Polymarket crypto taker fee in dollars for a matched token quantity.
 * The venue curve is shares × rate × price × (1-price). Keeping this in one
 * helper prevents the old "2% of profitable PnL" approximation from leaking
 * into execution decisions.
 */
function calculateCryptoTakerFeeUsd(
  shares,
  price,
  rate = DEFAULT_CRYPTO_TAKER_RATE
) {
  if (
    !Number.isFinite(shares) || shares <= 0 ||
    !Number.isFinite(price) || price <= 0 || price >= 1 ||
    !Number.isFinite(rate) || rate < 0
  ) return 0;
  return shares * rate * price * (1 - price);
}

/**
 * Expected edge at the price that can actually be bought, in percentage
 * points per share (the same unit EVEngine uses). The ask/depth-walk price
 * already contains spread and slippage; subtracting either again would
 * double-count execution cost.
 */
function calculateExecutionAdjustedEV({
  modelProb,
  direction,
  fillPrice,
  takerRate = DEFAULT_CRYPTO_TAKER_RATE,
}) {
  if (
    !Number.isFinite(modelProb) || modelProb <= 0 || modelProb >= 1 ||
    !Number.isFinite(fillPrice) || fillPrice <= 0 || fillPrice >= 1 ||
    !['YES', 'NO'].includes(direction)
  ) return null;
  const outcomeProb = direction === 'YES' ? modelProb : 1 - modelProb;
  const feePerShare = calculateCryptoTakerFeeUsd(1, fillPrice, takerRate);
  return (outcomeProb - fillPrice - feePerShare) * 100;
}

function shouldTriggerTrailingStop({
  peakPnlPct,
  pnlPct,
  marketEndSec,
  activationPct = 35,
  givebackPct = 15,
  maxRemainingPnlPct = 10,
  minRemainingSec = 60,
}) {
  if (!Number.isFinite(peakPnlPct) || !Number.isFinite(pnlPct)) return false;
  if (!Number.isFinite(marketEndSec) || marketEndSec <= minRemainingSec) return false;
  if (peakPnlPct < activationPct) return false;

  const giveback = peakPnlPct - pnlPct;
  if (giveback < givebackPct) return false;

  return pnlPct <= maxRemainingPnlPct;
}

module.exports = {
  calculateCryptoTakerFeeUsd,
  calculateExecutionAdjustedEV,
  calculateSlippageTicks,
  DEFAULT_CRYPTO_TAKER_RATE,
  DEFAULT_MIN_MARKET_ENTRY,
  getRawOutcomePrice,
  isEntryPriceAllowed,
  shouldTriggerTrailingStop,
  withDipOutcomePrice,
};
