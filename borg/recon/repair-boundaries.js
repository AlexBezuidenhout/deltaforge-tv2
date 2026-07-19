/**
 * BORG recon — one-off boundary repair (2026-07-11 incident).
 *
 * Incident: the Binance WS reconnect chain died ~02:00 UTC (dead retry path,
 * no silent-socket watchdog) and the frozen last price kept being stamped
 * into binance_open (labeled 'live') and binance_close until the machine
 * rebooted at 10:50 UTC. Those boundaries are measurement error, not market
 * data, and they manufactured a ~39% Q3 "disagreement" rate.
 *
 * Repair rule (structural, not outcome-based): a boundary is contaminated iff
 * it was captured 'live' but borg_binance_1s has NO bar within ±10s of that
 * boundary — the feed was provably dead, so the stamped price is the frozen
 * artifact. Contaminated and missing boundaries are re-set from the official
 * Binance 5m kline and labeled 'kline_repair' so analysis can split by source.
 * Every change is logged to borg_events. Idempotent; safe to re-run.
 */
const { pool, migrate, logEvent } = require('./db');

async function kline(startMs) {
  const aligned = Math.floor(startMs / 300000) * 300000;
  const res = await fetch(
    `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=1&startTime=${aligned}`
  );
  if (!res.ok) throw new Error(`kline HTTP ${res.status}`);
  const raw = await res.json();
  const k = raw?.[0];
  if (!k || k[0] !== aligned) return null; // kline must be the exact window
  return { open: parseFloat(k[1]), close: parseFloat(k[4]) };
}

async function main() {
  await migrate();
  const { rows } = await pool.query(`
    SELECT m.id, m.slug, m.window_start, m.window_end, m.outcome,
           m.binance_open,  m.binance_open_src,
           m.binance_close, m.binance_close_src,
           EXISTS(SELECT 1 FROM borg_binance_1s b
                  WHERE b.ts BETWEEN m.window_start - interval '10 seconds'
                                 AND m.window_start + interval '10 seconds') AS open_feed_alive,
           EXISTS(SELECT 1 FROM borg_binance_1s b
                  WHERE b.ts BETWEEN m.window_end - interval '10 seconds'
                                 AND m.window_end + interval '10 seconds') AS close_feed_alive
    FROM borg_markets m
    WHERE m.window_end < now() - interval '30 seconds'
    ORDER BY m.id`);

  let repairedOpen = 0, repairedClose = 0, skipped = 0, failed = 0;
  for (const m of rows) {
    // legacy rows predate binance_close_src: close set + src NULL means 'live' capture
    const closeWasLive = m.binance_close != null && (m.binance_close_src === 'live' || m.binance_close_src == null);
    const openBad = m.binance_open == null || (m.binance_open_src === 'live' && !m.open_feed_alive);
    const closeBad = m.binance_close == null || (closeWasLive && !m.close_feed_alive);
    if (!openBad && !closeBad) { skipped += 1; continue; }
    let k;
    try {
      k = await kline(m.window_start.getTime());
    } catch (err) {
      console.warn(`  kline fetch failed for ${m.slug}: ${err.message}`);
      failed += 1;
      continue;
    }
    if (!k) { failed += 1; continue; }
    const sets = [], params = [];
    if (openBad) {
      params.push(k.open); sets.push(`binance_open=$${params.length}`);
      sets.push(`binance_open_src='kline_repair'`);
      repairedOpen += 1;
    }
    if (closeBad) {
      params.push(k.close); sets.push(`binance_close=$${params.length}`);
      sets.push(`binance_close_src='kline_repair'`);
      repairedClose += 1;
    }
    params.push(m.id);
    await pool.query(`UPDATE borg_markets SET ${sets.join(', ')} WHERE id=$${params.length}`, params);
    console.log(`  ${m.slug}: ${openBad ? `open ${m.binance_open}→${k.open} ` : ''}${closeBad ? `close ${m.binance_close}→${k.close}` : ''}`);
    await new Promise((r) => setTimeout(r, 150)); // stay far under Binance rate limits
  }

  const summary = { markets: rows.length, repairedOpen, repairedClose, untouched: skipped, failed };
  console.log('repair summary:', summary);
  await logEvent('INFO', 'repair', 'boundary repair pass (2026-07-11 stale-feed incident)', summary);

  const { rows: [q3] } = await pool.query(`
    SELECT count(*) FILTER (WHERE outcome IS NOT NULL AND binance_open IS NOT NULL AND binance_close IS NOT NULL) AS scored,
           count(*) FILTER (WHERE outcome IS NOT NULL AND binance_open IS NOT NULL AND binance_close IS NOT NULL
             AND outcome <> CASE WHEN binance_close >= binance_open THEN 'UP' ELSE 'DOWN' END) AS disagree
    FROM borg_markets`);
  console.log(`Q3 after repair: ${q3.disagree}/${q3.scored} outcome-vs-Binance-sign disagreements`);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
