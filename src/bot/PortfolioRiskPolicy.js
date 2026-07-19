/**
 * Shared promotion envelope for the three-bot candidate portfolio.
 *
 * These are capital-preservation limits derived from the frozen $500 paper
 * research bankroll,
 * not fitted alpha parameters. They do not enable live trading. Every caller
 * must still enforce paper/live mode and one-seat-per-market separately.
 */
const DEFAULT_BANKROLL_USDC = 500;

function finiteNumber(value, fallback = 0) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildPortfolioPolicy(bankroll = DEFAULT_BANKROLL_USDC) {
  const capital = Math.max(0, finiteNumber(bankroll, DEFAULT_BANKROLL_USDC));
  return Object.freeze({
    bankrollUsdc: capital,
    riskPerTradePct: 0.02,
    stakeUsd: +(capital * 0.02).toFixed(2),
    maxConcurrentPositions: 3,
    maxGrossExposurePct: 0.06,
    maxGrossExposureUsd: +(capital * 0.06).toFixed(2),
    dailyLossPct: 0.06,
    dailyLossUsd: +(capital * 0.06).toFixed(2),
    hardDrawdownPct: 0.10,
    hardDrawdownUsd: +(capital * 0.10).toFixed(2),
    minimumCashReservePct: 0.80,
    minimumCashReserveUsd: +(capital * 0.80).toFixed(2),
  });
}

function riskWindowFloor(now = Date.now(), cohortAnchor = null) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const rolling24h = safeNow - (24 * 60 * 60 * 1000);
  const anchorMs = cohortAnchor == null ? NaN : new Date(cohortAnchor).getTime();
  return new Date(Number.isFinite(anchorMs) ? Math.max(rolling24h, anchorMs) : rolling24h);
}

function canOpenPortfolioPosition({
  policy = buildPortfolioPolicy(),
  openPositions = 0,
  grossExposureUsd = 0,
  rolling24hPnlUsd = 0,
  drawdownUsd = 0,
  marketAlreadyClaimed = false,
  proposedStakeUsd = policy.stakeUsd,
} = {}) {
  const count = Math.max(0, Math.trunc(finiteNumber(openPositions)));
  const exposure = Math.max(0, finiteNumber(grossExposureUsd));
  const pnl = finiteNumber(rolling24hPnlUsd);
  const drawdown = Math.max(0, finiteNumber(drawdownUsd));
  const proposedStake = Math.max(0, finiteNumber(proposedStakeUsd, policy.stakeUsd));

  if (marketAlreadyClaimed) return { allowed: false, reason: 'market_already_claimed' };
  if (count >= policy.maxConcurrentPositions) return { allowed: false, reason: 'max_concurrent_positions' };
  if (exposure + proposedStake > policy.maxGrossExposureUsd + 1e-9) {
    return { allowed: false, reason: 'max_gross_exposure' };
  }
  if (pnl <= -policy.dailyLossUsd) return { allowed: false, reason: 'daily_loss_halt' };
  if (drawdown >= policy.hardDrawdownUsd) return { allowed: false, reason: 'hard_drawdown_halt' };
  return { allowed: true, reason: 'ok' };
}

module.exports = {
  DEFAULT_BANKROLL_USDC,
  buildPortfolioPolicy,
  canOpenPortfolioPosition,
  riskWindowFloor,
};
