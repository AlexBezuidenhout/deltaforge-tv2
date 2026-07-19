/**
 * Cross-venue settlement capture and venue-scoring.
 *
 * Capture (default): seed cv_settlements from every cv_contract_matches row
 * that has basis samples and a passed close time, then poll both venues'
 * public endpoints for final outcomes (Kalshi market `result`, Polymarket
 * Gamma `outcomePrices` using the same >=0.99 collapse rule as borg_markets
 * resolution). Idempotent; safe under cron.
 *
 * --score: for every settled match, replay cv_book_snapshots mids against
 * the realized outcome and report per-venue Brier plus the pre-registered
 * predictive test — does the cross-venue mid gap at observation time point
 * toward the realized outcome? Read-only; prints a report, writes nothing.
 */
'use strict';

const { Pool } = require('pg');

const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const GAMMA = 'https://gamma-api.polymarket.com';
const SLEEP_MS = 150;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

async function capture(pool) {
  const seeded = await pool.query(`
    INSERT INTO cv_settlements (match_id, kalshi_ticker, poly_condition_id, poly_gamma_id)
    SELECT m.match_id, m.kalshi_ticker, m.poly_condition_id, m.poly_gamma_id
    FROM cv_contract_matches m
    WHERE EXISTS (SELECT 1 FROM cv_basis_samples b WHERE b.match_id = m.match_id)
      AND least(
        coalesce((m.metadata->'kalshi'->>'expectedExpirationTime')::timestamptz,
                 (m.metadata->'kalshi'->>'closeTime')::timestamptz, now()),
        coalesce((m.metadata->'poly'->>'endDate')::timestamptz, now())) < now()
    ON CONFLICT (match_id) DO NOTHING`);
  const { rows } = await pool.query(`
    SELECT match_id, kalshi_ticker, poly_gamma_id, kalshi_result, poly_outcome
    FROM cv_settlements
    WHERE kalshi_result IS NULL OR poly_outcome IS NULL
    ORDER BY last_checked_at LIMIT 200`);
  let settled = 0;
  for (const row of rows) {
    const update = { kalshi: null, kalshiAt: null, poly: null, polyAt: null };
    if (!row.kalshi_result) {
      try {
        const { market } = await fetchJson(`${KALSHI}/markets/${row.kalshi_ticker}`);
        // result is '' until settlement; only yes/no are terminal outcomes.
        if (market?.result === 'yes' || market?.result === 'no') {
          update.kalshi = market.result;
          update.kalshiAt = market.settled_time || market.close_time || null;
        }
      } catch (error) { console.error(`kalshi ${row.kalshi_ticker}: ${error.message}`); }
      await sleep(SLEEP_MS);
    }
    if (!row.poly_outcome && row.poly_gamma_id) {
      try {
        const market = await fetchJson(`${GAMMA}/markets/${row.poly_gamma_id}`);
        let prices = market?.outcomePrices;
        if (typeof prices === 'string') { try { prices = JSON.parse(prices); } catch { prices = null; } }
        let outcomes = market?.outcomes;
        if (typeof outcomes === 'string') { try { outcomes = JSON.parse(outcomes); } catch { outcomes = null; } }
        if (Array.isArray(prices) && Array.isArray(outcomes)) {
          const yesIndex = outcomes.findIndex((label) => String(label).toUpperCase() === 'YES');
          const noIndex = outcomes.findIndex((label) => String(label).toUpperCase() === 'NO');
          if (yesIndex >= 0 && noIndex >= 0) {
            const yes = parseFloat(prices[yesIndex]);
            const no = parseFloat(prices[noIndex]);
            if (yes >= 0.99 && no <= 0.01) update.poly = 'yes';
            else if (yes <= 0.01 && no >= 0.99) update.poly = 'no';
            if (update.poly) update.polyAt = market.closedTime || market.endDate || null;
          }
        }
      } catch (error) { console.error(`gamma ${row.poly_gamma_id}: ${error.message}`); }
      await sleep(SLEEP_MS);
    }
    const result = await pool.query(`
      UPDATE cv_settlements SET
        kalshi_result = coalesce($2, kalshi_result),
        kalshi_settled_at = coalesce($3::timestamptz, kalshi_settled_at),
        poly_outcome = coalesce($4, poly_outcome),
        poly_resolved_at = coalesce($5::timestamptz, poly_resolved_at),
        last_checked_at = now(), checks = checks + 1
      WHERE match_id = $1
      RETURNING kalshi_result, poly_outcome`, [
      row.match_id, update.kalshi, update.kalshiAt, update.poly, update.polyAt,
    ]);
    const final = result.rows[0];
    if (final?.kalshi_result && final?.poly_outcome) settled += 1;
  }
  console.log(`seeded ${seeded.rowCount} new; polled ${rows.length}; fully settled this pass: ${settled}`);
  const { rows: [tally] } = await pool.query(`
    SELECT count(*) AS total,
      count(*) FILTER (WHERE kalshi_result IS NOT NULL AND poly_outcome IS NOT NULL) AS both,
      count(*) FILTER (WHERE kalshi_result IS NOT NULL AND poly_outcome IS NOT NULL
        AND kalshi_result <> poly_outcome) AS disagreements
    FROM cv_settlements`);
  console.log(`cv_settlements: ${tally.total} tracked, ${tally.both} settled on both venues, `
    + `${tally.disagreements} OUTCOME DISAGREEMENTS`);
  if (Number(tally.disagreements) > 0) {
    const { rows: bad } = await pool.query(`
      SELECT match_id, kalshi_result, poly_outcome FROM cv_settlements
      WHERE kalshi_result IS NOT NULL AND poly_outcome IS NOT NULL AND kalshi_result <> poly_outcome`);
    for (const row of bad) {
      console.log(`  DISAGREEMENT ${row.match_id}: kalshi=${row.kalshi_result} poly=${row.poly_outcome}`);
    }
  }
}

async function score(pool) {
  // One prediction per (match, venue, snapshot); mids need both sides quoted.
  const { rows } = await pool.query(`
    SELECT s.match_id,
      m.kalshi_title,
      st.kalshi_result,
      st.poly_outcome,
      count(*) AS snaps,
      avg(power((s.poly_yes_bid + s.poly_yes_ask) / 2
        - (st.poly_outcome = 'yes')::int, 2)) AS poly_brier,
      avg(power((s.kalshi_yes_bid + s.kalshi_yes_ask) / 2
        - (st.kalshi_result = 'yes')::int, 2)) AS kalshi_brier,
      avg(CASE WHEN sign((s.kalshi_yes_bid + s.kalshi_yes_ask)
        - (s.poly_yes_bid + s.poly_yes_ask)) <> 0 THEN
        (sign((s.kalshi_yes_bid + s.kalshi_yes_ask) - (s.poly_yes_bid + s.poly_yes_ask))
          = CASE WHEN st.kalshi_result = 'yes' THEN 1 ELSE -1 END)::int::float END)
        AS kalshi_points_right
    FROM cv_book_snapshots s
    JOIN cv_settlements st USING (match_id)
    JOIN cv_contract_matches m USING (match_id)
    WHERE st.kalshi_result IN ('yes','no') AND st.poly_outcome IN ('yes','no')
      AND st.kalshi_result = st.poly_outcome
      AND s.poly_yes_bid > 0 AND s.poly_yes_ask > 0 AND s.poly_yes_ask < 1
      AND s.kalshi_yes_bid > 0 AND s.kalshi_yes_ask > 0 AND s.kalshi_yes_ask < 1
    GROUP BY 1, 2, 3, 4 ORDER BY snaps DESC`);
  if (!rows.length) {
    console.log('no settled matches with two-sided synchronized books yet');
    return;
  }
  console.log('match | outcome | snaps | poly_brier | kalshi_brier | kalshi_gap_points_right');
  let polySum = 0; let kalshiSum = 0; let snapSum = 0;
  for (const row of rows) {
    polySum += row.poly_brier * row.snaps;
    kalshiSum += row.kalshi_brier * row.snaps;
    snapSum += Number(row.snaps);
    console.log([
      row.match_id.slice(0, 70), row.kalshi_result, row.snaps,
      Number(row.poly_brier).toFixed(4), Number(row.kalshi_brier).toFixed(4),
      row.kalshi_points_right == null ? 'n/a' : Number(row.kalshi_points_right).toFixed(3),
    ].join(' | '));
  }
  console.log(`\nPOOLED (${rows.length} matches, ${snapSum} snapshots): `
    + `poly Brier ${(polySum / snapSum).toFixed(4)} vs kalshi Brier ${(kalshiSum / snapSum).toFixed(4)}`);
  console.log('Matches where the venues disagreed on the outcome itself are EXCLUDED above; '
    + 'they are identity failures, not scoring rows.');
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    if (process.argv.includes('--score')) await score(pool);
    else await capture(pool);
  } finally { await pool.end(); }
}

main().catch((error) => { console.error(error); process.exit(1); });
