'use strict';

const { clusteredBootstrap } = require('./statistics');

const EXPERIMENTS = Object.freeze({
  h43: 'research-h43-forward-v1',
  pyth: 'pyth-resolver-boundary-transfer-v4-frozen-observation-window',
  chainlink: 'chainlink-resolver-boundary-residual-v1',
  cf: 'cf-resolver-boundary-residual-v1',
});

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function summarizeLane(rows, { minimumMarkets, minimumDays }) {
  const ordered = [...rows].sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
  const promotable = ordered.filter((row) => row.promotionEligible !== false);
  const scored = promotable.filter((row) => finite(row.pnl2x) != null);
  const split = Math.floor(scored.length / 2);
  const halves = [scored.slice(0, split), scored.slice(split)]
    .map((half) => half.reduce((sum, row) => sum + row.pnl2x, 0));
  const pnl2x = scored.reduce((sum, row) => sum + row.pnl2x, 0);
  const marketCi = clusteredBootstrap(scored, 'marketKey', 'pnl2x', { iterations: 2000 });
  const dayCi = clusteredBootstrap(scored, 'dayKey', 'pnl2x', { iterations: 2000 });
  const days = new Set(ordered.map((row) => row.dayKey)).size;
  const independentMarkets = new Set(ordered.map((row) => row.marketKey)).size;
  return {
    attempts: ordered.length,
    promotionEligibleAttempts: promotable.length,
    blockedObservations: ordered.length - promotable.length,
    independentMarkets,
    calendarDays: days,
    executable: ordered.filter((row) => row.executable).length,
    terminalScored: scored.length,
    wins: scored.filter((row) => row.won).length,
    pnl2x,
    chronologicalHalvesPnl2x: halves,
    marketClusteredMeanPnl2x: marketCi,
    dayClusteredMeanPnl2x: dayCi,
    minimumRead: { independentMarkets: minimumMarkets, calendarDays: minimumDays },
    passesMechanicalRead: independentMarkets >= minimumMarkets && days >= minimumDays
      && scored.length >= minimumMarkets && pnl2x > 0
      && halves.length === 2 && halves.every((value) => value > 0)
      && finite(marketCi.ci?.[0]) > 0 && finite(dayCi.ci?.[0]) > 0,
  };
}

function blockedLane(experimentId, reason) {
  return {
    experimentId,
    status: 'BLOCKED_SOURCE_CONTRACT',
    reason,
    attempts: 0,
    promotionEligibleAttempts: 0,
    passesMechanicalRead: false,
  };
}

async function buildResolverBoundaryPortfolio(pool) {
  const [h43Result, pythResult] = await Promise.all([
    pool.query(`
      SELECT DISTINCT ON (o.market_id)
             o.market_id::text market_key,o.ts observed_at,
             COALESCE(s.filled,false) executable,
             CASE WHEN s.filled AND s.outcome IS NOT NULL
                  THEN upper(s.outcome)=upper(o.token) END won,
             s.pnl_2x
        FROM borg_shadow_orders o
        LEFT JOIN borg_shadow_scores s ON s.order_id=o.id
       WHERE o.experiment_id=$1 AND o.strategy='H43_resolution_boundary_buffer'
         AND o.action='place'
       ORDER BY o.market_id,o.ts,o.id`, [EXPERIMENTS.h43]),
    pool.query(`
      WITH first_attempt AS (
        SELECT DISTINCT ON (s.condition_id)
               s.condition_id market_key,a.arrival_id,a.observed_at,a.executable,a.entry_fee,
               COALESCE((a.detail->>'promotionEligible')::boolean,false) promotion_eligible
          FROM borg_pyth_signals s
          JOIN borg_pyth_arrivals a USING (signal_id)
         WHERE s.experiment_id=$1 AND a.experiment_id=$1
           AND s.valid=true AND a.latency_ms=250
         ORDER BY s.condition_id,s.observed_at,s.signal_id
      )
      SELECT f.*,t.won,
             CASE WHEN t.pnl IS NOT NULL THEN t.pnl-COALESCE(f.entry_fee,0) END pnl_2x
        FROM first_attempt f
        LEFT JOIN borg_pyth_terminal_scores t ON t.arrival_id=f.arrival_id`, [EXPERIMENTS.pyth]),
  ]);

  const normalize = (rows) => rows.map((row) => {
    const observedAt = new Date(row.observed_at).toISOString();
    return {
      marketKey: String(row.market_key), observedAt,
      dayKey: observedAt.slice(0, 10), executable: row.executable === true,
      won: row.won === true, pnl2x: finite(row.pnl_2x),
      promotionEligible: row.promotion_eligible !== false,
    };
  });
  return {
    format: 'resolver-boundary-portfolio-v4',
    generatedAt: new Date().toISOString(),
    paperOnly: true,
    additivePortfolioPnl: null,
    warning: 'Lanes retain separate evidence identities and may share resolver/window exposure. Their PnLs must not be added. Calibration probes and blocked source contracts contribute no promotion PnL.',
    lanes: {
      h43: { experimentId: EXPERIMENTS.h43,
        ...summarizeLane(normalize(h43Result.rows), { minimumMarkets: 300, minimumDays: 14 }) },
      pythTransfer: { experimentId: EXPERIMENTS.pyth,
        ...summarizeLane(normalize(pythResult.rows), { minimumMarkets: 300, minimumDays: 14 }) },
      chainlinkResidual: blockedLane(EXPERIMENTS.chainlink,
        'Exact Chainlink Data Streams price-to-beat contract is not available; push-feed proxies are forbidden.'),
      cfResidual: blockedLane(EXPERIMENTS.cf,
        'No authoritative official CF resolver stream is configured; CEX proxies are forbidden.'),
    },
  };
}

module.exports = {
  EXPERIMENTS, blockedLane, buildResolverBoundaryPortfolio, finite, summarizeLane,
};
