/**
 * BTCIndicators — Wilder's ATR / RSI / ADX + classical MACD / Bollinger / VWAP
 * computed from OHLCV candles (oldest first).
 *
 * All functions return the latest value or `null` if there aren't enough candles.
 * They are deliberately stateless: callers (BinanceFeed) push a fresh array of
 * the last N candles each tick. No internal accumulators to keep in sync.
 */

function trueRange(candle, prevClose) {
  if (!candle) return null;
  if (prevClose == null) return Math.max(0, candle.high - candle.low);
  const a = candle.high - candle.low;
  const b = Math.abs(candle.high - prevClose);
  const c = Math.abs(candle.low - prevClose);
  return Math.max(a, b, c);
}

function wilder(prev, current, period) {
  return (prev * (period - 1) + current) / period;
}

/** Wilder ATR — absolute USD. */
function atr(candles, period = 5) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  let atrPrev = null;
  for (let i = 1; i < candles.length; i++) {
    const tr = trueRange(candles[i], candles[i - 1].close);
    if (i <= period) {
      atrPrev = atrPrev == null ? tr : atrPrev + tr;
      if (i === period) atrPrev = atrPrev / period;
    } else {
      atrPrev = wilder(atrPrev, tr, period);
    }
  }
  return atrPrev;
}

/** Wilder RSI 0–100. */
function rsi(candles, period = 5) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff >= 0) gains += diff;
    else losses += -diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = wilder(avgGain, gain, period);
    avgLoss = wilder(avgLoss, loss, period);
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Wilder ADX with +DI/-DI; needs ≥ 2·period + 1 candles. */
function adx(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < 2 * period + 1) return null;
  const trs = [];
  const plusDMs = [];
  const minusDMs = [];

  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    const upMove = cur.high - prev.high;
    const downMove = prev.low - cur.low;
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trs.push(trueRange(cur, prev.close));
  }
  if (trs.length < period) return null;

  let trSum = 0, plusSum = 0, minusSum = 0;
  for (let i = 0; i < period; i++) {
    trSum += trs[i];
    plusSum += plusDMs[i];
    minusSum += minusDMs[i];
  }
  const dxValues = [];
  for (let i = period; i < trs.length; i++) {
    trSum = trSum - trSum / period + trs[i];
    plusSum = plusSum - plusSum / period + plusDMs[i];
    minusSum = minusSum - minusSum / period + minusDMs[i];
    if (trSum <= 0) { dxValues.push(0); continue; }
    const plusDI = 100 * (plusSum / trSum);
    const minusDI = 100 * (minusSum / trSum);
    const sumDI = plusDI + minusDI;
    const dx = sumDI === 0 ? 0 : 100 * (Math.abs(plusDI - minusDI) / sumDI);
    dxValues.push(dx);
  }
  if (dxValues.length < period) return null;
  let adxVal = dxValues.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxValues.length; i++) {
    adxVal = wilder(adxVal, dxValues[i], period);
  }

  // Compute final +DI/-DI from final smoothed sums.
  const plusDI = trSum > 0 ? 100 * (plusSum / trSum) : 0;
  const minusDI = trSum > 0 ? 100 * (minusSum / trSum) : 0;
  return { adx: adxVal, plusDI, minusDI };
}

/** Annualised log-return stdev over `lookback` candles. Returns null until full window available. */
function realizedVol(candles, lookback = 20, secondsPerCandle = 60) {
  if (!Array.isArray(candles) || candles.length < lookback + 1) return null;
  const slice = candles.slice(-lookback - 1);
  const returns = [];
  for (let i = 1; i < slice.length; i++) {
    const a = slice[i - 1].close;
    const b = slice[i].close;
    if (a > 0 && b > 0) returns.push(Math.log(b / a));
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);
  const secondsPerYear = 365.25 * 24 * 60 * 60;
  return stdDev * Math.sqrt(secondsPerYear / secondsPerCandle);
}

/** EMA helper for MACD. */
function ema(values, period) {
  if (!values || values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

/** MACD(fast, slow, signal). Returns { macd, signal, histogram }. */
function macd(candles, fast = 12, slow = 26, signalPeriod = 9) {
  if (!Array.isArray(candles) || candles.length < slow + signalPeriod) return null;
  const closes = candles.map((c) => c.close);
  const macdLine = [];
  for (let i = slow - 1; i < closes.length; i++) {
    const window = closes.slice(0, i + 1);
    const emaFast = ema(window, fast);
    const emaSlow = ema(window, slow);
    if (emaFast == null || emaSlow == null) continue;
    macdLine.push(emaFast - emaSlow);
  }
  if (macdLine.length < signalPeriod) return null;
  const signal = ema(macdLine, signalPeriod);
  const last = macdLine[macdLine.length - 1];
  if (signal == null) return null;
  return { macd: last, signal, histogram: last - signal };
}

/** Bollinger Bands (SMA ± k·σ). */
function bollinger(candles, period = 20, stdDev = 2) {
  if (!Array.isArray(candles) || candles.length < period) return null;
  const closes = candles.slice(-period).map((c) => c.close);
  const mean = closes.reduce((s, c) => s + c, 0) / period;
  const variance = closes.reduce((s, c) => s + (c - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  const upper = mean + stdDev * std;
  const lower = mean - stdDev * std;
  return { middle: mean, upper, lower, bandWidthPct: mean > 0 ? ((upper - lower) / mean) * 100 : null };
}

/** Volume spike: current candle volume / mean(last `lookback` candles, excluding current). */
function volumeSpike(candles, lookback = 5) {
  if (!Array.isArray(candles) || candles.length < lookback + 1) return null;
  const tail = candles.slice(-lookback - 1);
  const current = tail[tail.length - 1].volume;
  const past = tail.slice(0, -1).map((c) => c.volume).filter((v) => Number.isFinite(v) && v > 0);
  if (past.length < 2 || !Number.isFinite(current)) return null;
  const avg = past.reduce((s, v) => s + v, 0) / past.length;
  if (avg <= 0) return null;
  return { ratio: current / avg, current, avg };
}

/**
 * Composite regime label: TREND_UP / TREND_DOWN / CHOP / EXPANSION / NORMAL.
 * Derived from ADX + ATR%. Trend direction comes from +DI vs -DI.
 */
function composite(candles, { atrPeriod = 5, rsiPeriod = 5, adxPeriod = 14, volPeriod = 20 } = {}) {
  const a = atr(candles, atrPeriod);
  const r = rsi(candles, rsiPeriod);
  const adxRes = adx(candles, adxPeriod);
  const vol = realizedVol(candles, volPeriod, 60);

  const last = candles && candles.length ? candles[candles.length - 1] : null;
  const atrPct = a != null && last && last.close > 0 ? a / last.close : null;

  const adxVal = adxRes && Number.isFinite(adxRes.adx) ? adxRes.adx : null;
  const plusDI = adxRes ? adxRes.plusDI : null;
  const minusDI = adxRes ? adxRes.minusDI : null;

  let trend = 'SIDEWAYS';
  if (plusDI != null && minusDI != null) {
    if (adxVal != null && adxVal < 20) trend = 'SIDEWAYS';
    else if (plusDI > minusDI) trend = 'UP';
    else if (minusDI > plusDI) trend = 'DOWN';
  }

  let regime = 'NORMAL';
  if (adxVal != null && atrPct != null) {
    if (adxVal < 20 && atrPct < 0.0008) regime = 'CHOP';
    else if (adxVal >= 25 && trend === 'UP') regime = 'TREND_UP';
    else if (adxVal >= 25 && trend === 'DOWN') regime = 'TREND_DOWN';
    else if (atrPct > 0.0020) regime = 'EXPANSION';
  }

  return {
    atr: a,
    atrPct,
    rsi: r,
    adx: adxVal,
    plusDI,
    minusDI,
    trend,
    regime,
    realizedVol: vol,
  };
}

module.exports = {
  atr,
  rsi,
  adx,
  realizedVol,
  macd,
  bollinger,
  volumeSpike,
  composite,
  trueRange,
};
