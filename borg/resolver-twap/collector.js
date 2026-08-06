#!/usr/bin/env node
'use strict';

/** Dedicated, capture-only ZEC Chainlink TWAP observer. */

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const ClobMultiplex = require('../recon/clob-multiplex');
const RawWal = require('../recon/wal');
const {
  insertRows, logEvent, migrate, migrateEdgeExecution, pool,
} = require('../recon/db');
const TwapMultiplex = require('./multiplex');
const { economicAgeMs } = require('./rtds');
const {
  ZEC_TWAP_UNIVERSE, discoverZecTwapMarkets,
} = require('./universe');

const RUN_ID = `twap:${os.hostname()}:${Date.now()}:${process.pid}`;
const STARTED_AT = new Date().toISOString();
const REFRESH_MS = Math.max(30_000, Number(process.env.TWAP_MARKET_REFRESH_MS || 60_000));
const SOURCE_MAX_AGE_MS = Math.max(1000, Number(process.env.TWAP_SOURCE_MAX_AGE_MS || 5000));
const BOUNDARY_TOLERANCE_MS = Math.max(500,
  Number(process.env.TWAP_BOUNDARY_TOLERANCE_MS || 3000));

function marketValues(row) {
  return [
    row.slug, row.asset, row.gammaId, row.conditionId, row.question,
    row.windowStart, row.windowEnd, row.upToken, row.downToken,
    row.marketType, row.timeframeSec, row.upIndex, row.downIndex,
    row.resolutionSource, JSON.stringify({ ...row.raw, _twapCapture: {
      universeId: ZEC_TWAP_UNIVERSE, twapWindowSeconds: row.twapWindowSeconds,
      fees: row.fees, minimumOrderSize: row.minimumOrderSize,
    } }),
  ];
}

async function persistMarkets(markets) {
  const persisted = [];
  for (const row of markets) {
    const { rows } = await pool.query(`INSERT INTO borg_markets (
      slug,asset,gamma_id,condition_id,question,window_start,window_end,
      up_token_id,down_token_id,market_type,timeframe_sec,
      positive_outcome_index,negative_outcome_index,resolution_source,
      accepting_orders,raw,positive_label,negative_label
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,$15,'UP','DOWN')
    ON CONFLICT (slug) DO UPDATE SET
      asset=EXCLUDED.asset,gamma_id=EXCLUDED.gamma_id,condition_id=EXCLUDED.condition_id,
      question=EXCLUDED.question,window_start=EXCLUDED.window_start,
      window_end=EXCLUDED.window_end,up_token_id=EXCLUDED.up_token_id,
      down_token_id=EXCLUDED.down_token_id,resolution_source=EXCLUDED.resolution_source,
      accepting_orders=true,raw=EXCLUDED.raw
    RETURNING id`, marketValues(row));
    persisted.push({ ...row, id: parseInt(rows[0].id, 10) });
  }
  return persisted;
}

function tickRow(tick) {
  return [
    ZEC_TWAP_UNIVERSE, tick.source, tick.symbol, tick.asset, tick.windowSeconds,
    tick.exactValue, new Date(tick.sourceMs),
    tick.publisherMs == null ? null : new Date(tick.publisherMs),
    new Date(tick.receiveWallMs), tick.receiveMonoNs, tick.transportPath,
    tick.connectionEpoch, tick.eventSequence, tick.walEventId, JSON.stringify(tick.raw),
  ];
}

function nearestTick(history, targetMs, windowSeconds, toleranceMs) {
  return history.filter((tick) => tick.windowSeconds === windowSeconds)
    .map((tick) => ({ tick, distanceMs: Math.abs(tick.sourceMs - targetMs) }))
    .filter((row) => row.distanceMs <= toleranceMs)
    .sort((left, right) => left.distanceMs - right.distanceMs
      || right.tick.sourceMs - left.tick.sourceMs)[0] || null;
}

function boundaryRecord(market, kind, tickMatch, observedAt = Date.now()) {
  const targetMs = kind === 'OPEN' ? market.windowStart.getTime() : market.windowEnd.getTime();
  const eligible = Boolean(tickMatch && economicAgeMs(tickMatch.tick, observedAt)
    <= Math.max(SOURCE_MAX_AGE_MS, Math.abs(observedAt - targetMs) + BOUNDARY_TOLERANCE_MS));
  const reason = eligible ? 'EXACT_CHAINLINK_TWAP_NEAREST_BOUNDARY'
    : tickMatch ? 'SOURCE_OR_RECEIPT_STALE' : 'NO_EXACT_TWAP_WITHIN_TOLERANCE';
  const identity = `${ZEC_TWAP_UNIVERSE}|${market.conditionId}|${kind}`;
  return {
    boundaryId: `twb_${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 28)}`,
    marketId: market.id, conditionId: market.conditionId, slug: market.slug,
    kind, targetAt: new Date(targetMs), observedAt: new Date(observedAt),
    sourceAt: tickMatch ? new Date(tickMatch.tick.sourceMs) : null,
    exactValue: tickMatch?.tick.exactValue || null,
    distanceMs: tickMatch?.distanceMs ?? null, eligible, reason,
    walEventId: tickMatch?.tick.walEventId || null,
    detail: {
      resolutionSource: market.resolutionSource,
      twapWindowSeconds: market.twapWindowSeconds,
      source: tickMatch?.tick.source || null,
      publisherMs: tickMatch?.tick.publisherMs || null,
      receiveWallMs: tickMatch?.tick.receiveWallMs || null,
      connectionEpoch: tickMatch?.tick.connectionEpoch || null,
      transportPath: tickMatch?.tick.transportPath ?? null,
      noSpotSubstitution: true,
    },
  };
}

async function main() {
  await migrate(); await migrateEdgeExecution();
  const twapWal = new RawWal('zec-chainlink-twap', {
    root: process.env.BORG_WAL_DIR, minFreeGb: Number(process.env.BORG_WAL_MIN_FREE_GB || 20),
  });
  const clobWal = new RawWal('zec-twap-clob', {
    root: process.env.BORG_WAL_DIR, minFreeGb: Number(process.env.BORG_WAL_MIN_FREE_GB || 20),
  });
  let markets = [];
  let tokenMarket = new Map();
  let tickBuffer = [];
  let history = [];
  let ticks = 0;
  let boundaries = 0;
  let lastTickAt = null;
  let blocker = 'STARTING';
  let stopping = false;
  let clobStarted = false;

  const twap = new TwapMultiplex({
    symbols: ['zec/usd'], windows: [30, 60], pathCount: 2,
    coverageMaxAgeMs: SOURCE_MAX_AGE_MS, wal: twapWal,
    onTick: (tick) => {
      tickBuffer.push(tickRow(tick)); history.push(tick); ticks += 1;
      lastTickAt = new Date().toISOString();
      const cutoff = Date.now() - 180_000;
      history = history.filter((row) => row.sourceMs >= cutoff);
      if (tickBuffer.length > 20_000) tickBuffer.shift();
    },
  });
  const clob = new ClobMultiplex((token) => tokenMarket.get(String(token)) || null, {
    shardCount: 2, wal: clobWal,
    shardIndexesForAsset: () => [0, 1], coverageMaxAgeMs: 3000,
  });

  await pool.query(`INSERT INTO borg_twap_runtime (
    run_id,universe_id,started_at,host,pid,status,blocker
  ) VALUES ($1,$2,$3,$4,$5,'STARTING',$6) ON CONFLICT (run_id) DO NOTHING`, [
    RUN_ID, ZEC_TWAP_UNIVERSE, STARTED_AT, os.hostname(), process.pid, blocker,
  ]);

  const refresh = async () => {
    const discovered = await discoverZecTwapMarkets();
    markets = await persistMarkets(discovered);
    tokenMarket = new Map(markets.flatMap((market) => [
      [market.upToken, market.id], [market.downToken, market.id],
    ]));
    clob.subscribe([...tokenMarket.keys()]);
    if (markets.length && !clobStarted) {
      // The resolver feed is useful even between listings. Do not open empty
      // CLOB sockets: Polymarket requires a market subscription to be the
      // first application frame, and no executable book exists to preserve.
      clobStarted = true;
      const connected = await clob.connect();
      if (!connected) await logEvent('WARN', 'zec_twap', 'initial CLOB connection is incomplete');
    }
    blocker = markets.length ? 'COLLECTING' : 'NO_CURRENT_CERTIFIED_ZEC_TWAP_MARKETS';
  };

  const flushTicks = async () => {
    const rows = tickBuffer.splice(0, 5000);
    if (!rows.length) return;
    try {
      await insertRows('borg_twap_ticks', [
        'universe_id', 'source', 'symbol', 'asset', 'window_seconds', 'exact_value',
        'source_ts', 'publisher_ts', 'received_at', 'receive_monotonic_ns',
        'transport_path', 'connection_epoch', 'event_sequence', 'wal_event_id', 'raw',
      ], rows, `ON CONFLICT (source,symbol,window_seconds,source_ts,exact_value)
        DO NOTHING`);
    } catch (error) { tickBuffer.unshift(...rows); throw error; }
  };

  const captureBoundaries = async () => {
    const now = Date.now();
    for (const market of markets) {
      for (const kind of ['OPEN', 'CLOSE']) {
        const targetMs = kind === 'OPEN' ? market.windowStart.getTime() : market.windowEnd.getTime();
        if (now < targetMs + BOUNDARY_TOLERANCE_MS) continue;
        const match = nearestTick(history, targetMs, market.twapWindowSeconds,
          BOUNDARY_TOLERANCE_MS);
        const record = boundaryRecord(market, kind, match, now);
        const result = await pool.query(`INSERT INTO borg_twap_boundaries (
          boundary_id,universe_id,market_id,condition_id,slug,boundary_kind,
          target_at,observed_at,source_ts,exact_value,distance_ms,eligible,reason,
          wal_event_id,detail
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
        ON CONFLICT (condition_id,boundary_kind) DO UPDATE SET
          observed_at=EXCLUDED.observed_at,source_ts=EXCLUDED.source_ts,
          exact_value=EXCLUDED.exact_value,distance_ms=EXCLUDED.distance_ms,
          eligible=EXCLUDED.eligible,reason=EXCLUDED.reason,
          wal_event_id=EXCLUDED.wal_event_id,detail=EXCLUDED.detail
        WHERE borg_twap_boundaries.eligible=false AND EXCLUDED.eligible=true`, [
          record.boundaryId, ZEC_TWAP_UNIVERSE, record.marketId, record.conditionId,
          record.slug, record.kind, record.targetAt, record.observedAt, record.sourceAt,
          record.exactValue, record.distanceMs, record.eligible, record.reason,
          record.walEventId, JSON.stringify(record.detail),
        ]);
        if (!result.rowCount) continue;
        boundaries += 1;
        twapWal.append(JSON.stringify({ type: 'zec_twap_boundary', ...record }), {
          channel: 'twap-boundary', sourceMs: record.sourceAt?.getTime?.() || null,
        });
        if (kind === 'OPEN' && record.eligible) {
          await pool.query(`UPDATE borg_markets SET chainlink_open=$1,
            chainlink_open_src=$2 WHERE id=$3`, [
            record.exactValue, `chainlink_twap_${market.twapWindowSeconds}s_nearest_3s`,
            market.id,
          ]);
        }
      }
    }
  };

  const heartbeat = async () => {
    const feed = twap.health(); const book = clob.health();
    const fresh = Object.values(feed.coverage).every((row) => row.freshPaths > 0);
    const statusBlocker = !fresh ? 'TWAP_ECONOMIC_COVERAGE_STALE' : blocker;
    const meta = {
      pid: process.pid, host: os.hostname(), runId: RUN_ID,
      processStartedAt: STARTED_AT,
      collectionEpochId: process.env.BORG_COLLECTION_EPOCH_ID || 'zec-twap-unmarked',
      universeId: ZEC_TWAP_UNIVERSE,
      paperOnly: true, walletLoaded: false, liveOrderPath: false,
      captureOnly: true, noSpotSubstitution: true,
      markets: markets.length, ticks, boundaries, lastTickAt,
      blocker: statusBlocker, feed, clob: book,
    };
    await pool.query(`UPDATE borg_twap_runtime SET
      status=$2,markets=$3,ticks=$4,boundaries=$5,last_tick_at=$6,
      blocker=$7,metrics=$8::jsonb,updated_at=now() WHERE run_id=$1`, [
      RUN_ID, fresh ? 'RUNNING' : 'DEGRADED', markets.length, ticks, boundaries,
      lastTickAt, statusBlocker, JSON.stringify(meta),
    ]);
    await pool.query(`INSERT INTO system_heartbeats (component,beat_at,meta)
      VALUES ('zec_twap_collector',now(),$1::jsonb)
      ON CONFLICT (component) DO UPDATE SET beat_at=now(),meta=EXCLUDED.meta`, [JSON.stringify(meta)]);
  };

  await refresh();
  await twap.connect();
  const timers = [
    setInterval(() => refresh().catch((error) => logEvent('ERROR', 'zec_twap', error.message)), REFRESH_MS),
    setInterval(() => flushTicks().catch((error) => logEvent('ERROR', 'zec_twap', error.message)), 1000),
    setInterval(() => captureBoundaries().catch((error) => logEvent('ERROR', 'zec_twap', error.message)), 250),
    setInterval(() => clob.flushEvents().catch(() => {}), 5000),
    setInterval(() => { twap.checkStale(SOURCE_MAX_AGE_MS); clob.checkStale(); }, 5000),
    setInterval(() => heartbeat().catch(() => {}), 10_000),
  ];
  timers.forEach((timer) => timer.unref?.()); await heartbeat();

  const shutdown = async (signal) => {
    if (stopping) return; stopping = true; timers.forEach(clearInterval);
    twap.close(); clob.close();
    await Promise.allSettled([flushTicks(), clob.flushEvents(), heartbeat()]);
    await pool.query(`UPDATE borg_twap_runtime SET status='STOPPED',stopped_at=now(),updated_at=now()
      WHERE run_id=$1`, [RUN_ID]).catch(() => {});
    await Promise.allSettled([twapWal.close(), clobWal.close()]);
    await pool.end().catch(() => {});
    console.log(`[zec-twap] stopped by ${signal}`); process.exit(0);
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) main().catch(async (error) => {
  console.error(error.stack || error.message); await pool.end().catch(() => {}); process.exit(1);
});

module.exports = { boundaryRecord, nearestTick, persistMarkets, tickRow };
