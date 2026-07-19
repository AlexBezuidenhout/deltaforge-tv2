# Lesson: verify reference-data alignment before trusting derived features

**Summary:** `binance_open/close` for direction_1h markets disagreed with the
true resolution sign in 33–41% of :15/:30/:45-offset windows (vs ~1% on :00
windows) because the kline fetch floor-aligned startTime to the calendar hour.
Outcomes were unaffected (Gamma-sourced); every Binance-derived displacement/σ
feature on 1h markets was silently wrong until 2026-07-18.

**Actionable rule:** any market universe whose windows are not aligned to the
reference candle interval must be anchored on exact 1m candles
(open = open of 1m candle at window_start; close = close of 1m candle at
window_end − 60s). Fixed in `borg/recon/markets.js`; backfill via
`scripts/repair-1h-klines.js` (stamps `*_src='repair_1m_kline'`).

**Detection heuristic that caught it:** cross-check
`sign(close−open)` vs recorded outcome grouped by
`extract(minute from window_start)` — misalignment shows up as a
minute-of-hour-dependent mismatch rate.
