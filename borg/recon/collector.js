/**
 * BORG recon collector — orchestrator. MULTI-ASSET (2026-07-12): one
 * updown-5m market per configured asset per window (asset_config,
 * enabled_borg) — btc, eth, sol, doge, xrp, bnb via Binance WS; hype via
 * Hyperliquid mids.
 *
 * Records, at 1s resolution per active market: order books (both tokens),
 * CLOB tape, per-asset 1s bars, mainnet Chainlink rounds (BTC control
 * series), Gamma prices, window boundaries, and resolutions. NO trading
 * logic, NO order code — this process cannot place an order by construction.
 *
 * Run: node borg/recon/collector.js   (launchd com.borg.recon in production)
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const {
  migrate, insertRows, logEvent, pool,
  registerCollectionEpoch, startCollectorRun, finishCollectorRun, upsertStrategyRuntime,
} = require('./db');
const Feeds = require('./feeds');
const ChainlinkRecon = require('./chainlink');
const MarketsRecon = require('./markets');
const ClobMultiplex = require('./clob-multiplex');
const RtdsRecon = require('./rtds');
const RawWal = require('./wal');
const ShadowEngine = require('../shadow/engine');
const makeStrategies = require('../shadow/strategies');
const { syncExperimentRegistry } = require('../research/experiment-registry');
const { loadActiveStrategies } = require('../research/strategy-policy');
const { createCapturePolicy } = require('./capture-policy');
const { LegacyPaperAdapter } = require('../shadow/legacy-paper-adapter');
const { loadPerformanceRows } = require('../research/meta-champion-performance');

// Standard normal CDF (Abramowitz–Stegun; prior art PhiModel.js)
function phiCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  let p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  if (x > 0) p = 1 - p;
  return p;
}

const state = {
  snapBuf: [],
  counters: { snaps: 0, bars: 0, clobEvents: 0, prints: 0 },
  startedAt: Date.now(),
};

function readBenchmark(file) {
  if (!file) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function collectionContext() {
  const host = os.hostname();
  const epochId = process.env.BORG_COLLECTION_EPOCH_ID || `unconfigured-${host}`;
  const epochStartedAt = process.env.BORG_COLLECTION_EPOCH_START || '1970-01-01T00:00:00.000Z';
  const runStartedAt = new Date();
  return {
    epochId,
    epochStartedAt,
    location: process.env.BORG_COLLECTION_LOCATION || 'unconfigured',
    host,
    epochCodeVersion: process.env.BORG_COLLECTION_CODE_VERSION
      || process.env.BORG_CODE_VERSION || 'unversioned',
    runCodeVersion: process.env.BORG_CODE_VERSION || 'unversioned',
    dataContractVersion: 'borg-event-wal-v2',
    reason: process.env.BORG_COLLECTION_EPOCH_REASON
      || 'Unconfigured collector cohort; set BORG_COLLECTION_EPOCH_* in production.',
    benchmark: readBenchmark(process.env.BORG_COLLECTION_BENCHMARK_FILE),
    runStartedAt,
    runId: `${epochId}:${runStartedAt.toISOString()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`,
  };
}

async function main() {
  const collection = collectionContext();
  process.env.BORG_COLLECTOR_RUN_ID = collection.runId;
  await migrate();
  await registerCollectionEpoch({
    epochId: collection.epochId,
    startedAt: collection.epochStartedAt,
    location: collection.location,
    host: collection.host,
    codeVersion: collection.epochCodeVersion,
    dataContractVersion: collection.dataContractVersion,
    reason: collection.reason,
    benchmark: collection.benchmark,
    metadata: {
      paperOnly: true,
      rawWal: process.env.BORG_RAW_WAL !== '0',
      startingBankrollUsd: 500,
    },
  });
  // Resolve and persist the exact active strategy contract before declaring a
  // collector run RUNNING. Health checks consume this immutable run metadata
  // instead of reconstructing policy from a different systemd environment.
  const experimentRegistry = await syncExperimentRegistry(pool);
  const strategyPolicy = await loadActiveStrategies(pool, makeStrategies());
  await startCollectorRun({
    runId: collection.runId,
    epochId: collection.epochId,
    startedAt: collection.runStartedAt,
    pid: process.pid,
    host: collection.host,
    codeVersion: collection.runCodeVersion,
    metadata: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      activeStrategies: strategyPolicy.active.map((strategy) => strategy.name).sort(),
      parkedStrategies: strategyPolicy.parked,
    },
  });

  const capturePolicy = createCapturePolicy(process.env);
  const { rows: configuredAssets } = await pool.query(
    'SELECT * FROM asset_config WHERE enabled_borg = true ORDER BY asset');
  const assets = capturePolicy.filterAssets(configuredAssets);
  if (!assets.length) throw new Error('BORG capture policy selected zero enabled assets');
  await logEvent('INFO', 'collector', 'BORG recon collector starting', {
    pid: process.pid, assets: assets.map((a) => a.asset),
    configuredAssets: configuredAssets.map((a) => a.asset),
    capturePolicy: capturePolicy.describe(),
    collectionEpochId: collection.epochId,
    collectionEpochStart: collection.epochStartedAt,
    collectorRunId: collection.runId,
    collectionLocation: collection.location,
    dataContractVersion: collection.dataContractVersion,
  });

  // Append-before-process capture is enabled by default. Setting
  // BORG_WAL_MIRROR_DIR to an off-host mounted path makes sealed, verified
  // segments durable beyond this machine without changing the hot path.
  const walOptions = {
    collectionEpochId: collection.epochId,
    collectorRunId: collection.runId,
  };
  const wals = process.env.BORG_RAW_WAL === '0' ? {} : {
    binance: new RawWal('binance', walOptions),
    coinbase: new RawWal('coinbase', walOptions),
    hyper: new RawWal('hyperliquid', walOptions),
    clob: new RawWal('polymarket-clob', walOptions),
    rtds: new RawWal('polymarket-rtds-chainlink', walOptions),
    decisions: new RawWal('strategy-decisions', walOptions),
    control: new RawWal('research-control', walOptions),
  };
  if (wals.control) {
    wals.control.append(JSON.stringify({
      type: 'collector_run_start',
      collection_epoch_id: collection.epochId,
      collection_epoch_start: collection.epochStartedAt,
      collector_run_id: collection.runId,
      location: collection.location,
      host: collection.host,
      code_version: collection.runCodeVersion,
      data_contract_version: collection.dataContractVersion,
    }), { channel: 'control' });
  }
  let enqueueEventEvaluation = () => {};
  const feeds = new Feeds((src, msg) => logEvent('WARN', src, msg), assets, {
    binanceWal: wals.binance,
    coinbaseWal: wals.coinbase,
    hyperWal: wals.hyper,
    onMarketEvent: (event) => enqueueEventEvaluation(event),
  });
  const chainlink = new ChainlinkRecon();
  const rtds = new RtdsRecon((src, msg) => logEvent('WARN', src, msg), {
    wal: wals.rtds,
    assets: assets.map((a) => a.asset),
    onMarketEvent: (event) => enqueueEventEvaluation(event),
  });
  const markets = new MarketsRecon(feeds, chainlink, assets, rtds);
  const evaluationMarkets = () => capturePolicy.filterMarkets(markets.evaluationAll());
  const sqlTouchMinIntervalMs = Math.max(0,
    Number(process.env.BORG_CLOB_SQL_TOUCH_MIN_INTERVAL_MS || 0) || 0);
  const clob = new ClobMultiplex((assetId) => {
    for (const rec of markets.bySlug.values()) {
      if (rec.up_token_id === assetId || rec.down_token_id === assetId) return rec.id;
    }
    return null;
  }, {
    wal: wals.clob,
    sqlTouchMinIntervalMs,
    onMarketEvent: (event) => enqueueEventEvaluation(event),
  });

  // Shadow engine (EVAL_PROTOCOL §1): logs intended orders only — this
  // process still has no execution path. Disable with BORG_SHADOW=0.
  const shadow = process.env.BORG_SHADOW === '0'
    ? null
    : new ShadowEngine({
      clob, insertRows, logEvent, strategies: strategyPolicy.active, experimentRegistry,
      decisionWal: wals.decisions || null,
      collectionEpochId: collection.epochId,
      collectorRunId: collection.runId,
    });
  if (shadow) await logEvent('INFO', 'shadow', 'shadow engine enabled', {
    strategies: shadow.strategies.map((s) => s.name),
    parkedStrategies: strategyPolicy.parked,
    includeParkedControls: process.env.BORG_INCLUDE_PARKED_CONTROLS === 'true',
  });
  const metaStrategies = shadow?.strategies
    .filter((strategy) => typeof strategy.updatePerformanceRows === 'function') || [];
  const activeStrategyNames = new Set(shadow?.strategies.map((strategy) => strategy.name) || []);
  const metaPerformanceHealth = {
    lastSuccessAt: null,
    lastError: null,
    sourceRows: 0,
  };
  const refreshMetaPerformance = async () => {
    if (!metaStrategies.length) return 0;
    const sourceStrategies = [...new Set(metaStrategies.flatMap((strategy) =>
      strategy.sourceStrategies.filter((name) => activeStrategyNames.has(name))))];
    const asOf = new Date();
    const rows = await loadPerformanceRows(pool, {
      sourceStrategies,
      epochId: collection.epochId,
      epochStartedAt: collection.epochStartedAt,
      asOf,
    });
    const loadedAtMs = Date.now();
    for (const strategy of metaStrategies) {
      strategy.updatePerformanceRows(rows, {
        asOfMs: asOf.getTime(),
        loadedAtMs,
      });
    }
    metaPerformanceHealth.lastSuccessAt = loadedAtMs;
    metaPerformanceHealth.lastError = null;
    metaPerformanceHealth.sourceRows = rows.length;
    return rows.length;
  };
  if (metaStrategies.length) {
    try {
      const sourceRows = await refreshMetaPerformance();
      await logEvent('INFO', 'shadow', 'meta-strategy performance snapshot loaded', {
        strategies: metaStrategies.map((strategy) => strategy.name),
        sourceRows,
        currentEpochOnly: collection.epochId,
        dataAndExecutionGrades: ['A', 'B'],
      });
    } catch (error) {
      metaPerformanceHealth.lastError = error.message;
      await logEvent('WARN', 'shadow',
        `meta-strategy performance snapshot unavailable: ${error.message}`);
    }
  }
  // Four-hour state models remain in memory on the hot path, but a routine
  // process restart must not create a four-hour blind spot. Warm them once
  // from complete, locally persisted minute bars. Binance persistence is
  // event-bar sparse (quiet seconds are not manufactured), so completeness is
  // certified by an uninterrupted feed-health log plus at least one observed
  // trade in every retained minute; model code still rejects minute gaps.
  const minuteStrategies = shadow?.strategies
    .filter((strategy) => typeof strategy.hydrateMinuteTape === 'function') || [];
  if (minuteStrategies.length) {
    try {
      const symbols = assets
        .filter((asset) => asset.binance_symbol)
        .map((asset) => asset.binance_symbol);
      const assetByHydrationSymbol = new Map(assets
        .filter((asset) => asset.binance_symbol)
        .map((asset) => [asset.binance_symbol, asset.asset]));
      const feedFaults = await pool.query(`
        SELECT COUNT(*)::int failures
          FROM borg_events
         WHERE ts >= NOW() - INTERVAL '260 minutes'
           AND level IN ('WARN','ERROR')
           AND (source='binance' OR message ILIKE '%binance%')
      `);
      if (Number(feedFaults.rows[0]?.failures || 0) > 0) {
        throw new Error('Binance feed warning/error exists inside hydration window');
      }
      const { rows } = await pool.query(`
        SELECT symbol,date_trunc('minute',ts) AS minute_ts,
               (array_agg(close ORDER BY ts DESC))[1] close,
               SUM(buy_vol) buy_vol,SUM(sell_vol) sell_vol,
               SUM(n_trades) n_trades,COUNT(*) observed_seconds
          FROM borg_binance_1s
         WHERE symbol = ANY($1::text[])
           AND ts >= NOW() - INTERVAL '260 minutes'
           AND ts < date_trunc('minute',NOW())
         GROUP BY symbol,date_trunc('minute',ts)
        HAVING SUM(n_trades) > 0
         ORDER BY minute_ts,symbol
      `, [symbols]);
      const hydrationRows = rows.map((row) => ({
        ...row,
        asset: assetByHydrationSymbol.get(row.symbol) || null,
        minute: row.minute_ts,
      }));
      const accepted = Object.fromEntries(minuteStrategies.map((strategy) => [
        strategy.name,
        strategy.hydrateMinuteTape(hydrationRows),
      ]));
      await logEvent('INFO', 'shadow', 'minute-state strategies hydrated from local hot tier', {
        eligibleMinuteRows: hydrationRows.length,
        accepted,
        binanceFeedFaults: 0,
        minimumObservedTradesPerMinute: 1,
      });
    } catch (error) {
      // Missing or incomplete history means a causal in-memory warm-up, never
      // a fabricated backfill or a collector boot failure.
      await logEvent('WARN', 'shadow',
        `minute-state hydration unavailable; causal warm-up required: ${error.message}`);
    }
  }
  const persistStrategyRuntime = async () => {
    if (!shadow) return 0;
    return upsertStrategyRuntime(collection.epochId, collection.runId, shadow.runtimeStatus());
  };
  await persistStrategyRuntime();
  const paperAdapter = shadow && process.env.BORG_LEGACY_PAPER_ADAPTER !== '0'
    ? new LegacyPaperAdapter({ pool, insertRows, logEvent, experimentRegistry })
    : null;

  const assetBySymbol = new Map(assets
    .filter((asset) => asset.binance_symbol)
    .map((asset) => [asset.binance_symbol, asset.asset]));
  const contextFor = (act, now, triggerEvent = null) => {
    const tte = (act.window_end.getTime() - now) / 1000;
    const upBook = clob.getBook(act.up_token_id);
    const downBook = clob.getBook(act.down_token_id);
    const bb = upBook?.bids?.[0]?.[0] ?? null;
    const ba = upBook?.asks?.[0]?.[0] ?? null;
    const mid = bb != null && ba != null ? (bb + ba) / 2 : null;
    const sigma = feeds.getSigma5m(act.asset);
    const px = feeds.getPrice(act.asset);
    const marketType = act.market_type || 'direction_5m';
    const ref = marketType.startsWith('direction_') ? parseFloat(act.binance_open) : null;
    const strike = act.strike == null ? null : parseFloat(act.strike);
    const lowerBound = act.lower_bound == null ? null : parseFloat(act.lower_bound);
    const upperBound = act.upper_bound == null ? null : parseFloat(act.upper_bound);
    let phiFair = null;
    const aboveFair = (boundary) => {
      if (!(px > 0) || !(boundary > 0) || !(sigma > 1e-6) || !(tte > 0)) return null;
      const sigmaRem = boundary * sigma * Math.sqrt(tte / 300);
      return sigmaRem > 0 ? phiCdf((px - boundary) / sigmaRem) : null;
    };
    if (Number.isFinite(ref)) {
      phiFair = aboveFair(ref);
    } else if (marketType === 'threshold_daily' && tte <= 3600 && Number.isFinite(strike)) {
      // The live sigma has only a ten-minute causal memory. It is permitted for
      // the last hour as a provisional execution feature, never as a daily-vol
      // estimate; H28 applies a much tighter final-five-minute band.
      phiFair = aboveFair(strike);
    } else if (marketType === 'range_daily' && tte <= 3600) {
      const pAboveLower = lowerBound == null ? 1 : aboveFair(lowerBound);
      const pAboveUpper = upperBound == null ? 0 : aboveFair(upperBound);
      if (pAboveLower != null && pAboveUpper != null) phiFair = pAboveLower - pAboveUpper;
    }
    if (phiFair != null) {
      phiFair = Math.min(0.999999, Math.max(0.000001, Number(phiFair.toFixed(6))));
    }
    const rtdsChainlink = rtds.getPrice(act.asset, 10000);
    const rtdsChainlinkAgeMs = rtds.getAgeMs(act.asset, 'chainlink');
    const resolverDivergence = rtds.getDivergence(act.asset, px, 10000);
    const rtdsBinance = rtds.getBinancePrice(act.asset, 10000);
    const resolverRefTrusted = act.chainlink_open_src === 'chainlink_rtds_nearest_3s';
    return {
      now, market: act, tteSec: tte, upBook, downBook, upMid: mid,
      phiFair, modelFairPositive: phiFair, sigma, btc: px, ref,
      resolverRef: resolverRefTrusted && act.chainlink_open != null
        ? parseFloat(act.chainlink_open) : null,
      resolverRefSource: act.chainlink_open_src || null,
      cexRef: act.binance_open == null ? null : parseFloat(act.binance_open),
      marketType, strike, lowerBound, upperBound,
      gammaUp: markets.gammaPositive(act),
      volatility: feeds.getVolatilityProfile(act.asset, 120),
      micro10: feeds.getMicro(act.asset, 10),
      micro30: feeds.getMicro(act.asset, 30),
      // Complete-minute research arms sample this causal rolling minute into
      // their own four-hour tapes. It is deliberately separate from the
      // second-scale execution features above.
      micro60: feeds.getWallClockMicro(act.asset, 60),
      oraclePrice: act.asset === 'btc' ? chainlink.price : null,
      oracleRef: act.asset === 'btc' ? parseFloat(act.chainlink_open) : null,
      rtdsChainlink, rtdsChainlinkAgeMs, resolverDivergence,
      rtdsChainlink10: rtds.getMicro(act.asset, 'chainlink', 10),
      rtdsChainlink30: rtds.getMicro(act.asset, 'chainlink', 30),
      rtdsBinance,
      rtdsBinance10: rtds.getMicro(act.asset, 'binance', 10),
      rtdsBinance30: rtds.getMicro(act.asset, 'binance', 30),
      rtdsBinanceAgeMs: rtds.getAgeMs(act.asset, 'binance'),
      venuePrice: feeds.getReferencePrice(act.asset),
      venue10: feeds.getReferenceMicro(act.asset, 10),
      venue30: feeds.getReferenceMicro(act.asset, 30),
      venueStale: feeds.referenceStale(act.asset, 10000),
      hyperPrice: feeds.getHyperliquidPrice(act.asset),
      hyper10: feeds.getHyperliquidMicro(act.asset, 10),
      hyper30: feeds.getHyperliquidMicro(act.asset, 30),
      hyperStale: feeds.hyperliquidStale(act.asset, 10000),
      feedStale: feeds.assetStale(act.asset, 10000),
      prints: (assetId, sinceMs) => clob.printsSince(assetId, sinceMs),
      upTokenId: act.up_token_id,
      downTokenId: act.down_token_id,
      triggerEvent,
    };
  };

  // Coalesce bursts per asset for 25ms. This bounds CPU/DB amplification while
  // retaining event-time decisions more than an order of magnitude faster
  // than the sampled arm. The queue delay is logged as part of each decision.
  const eventTimers = new Map();
  const pendingEvents = new Map();
  enqueueEventEvaluation = (event) => {
    if (!shadow) return;
    let asset = event.asset || assetBySymbol.get(event.symbol) || null;
    let eventMarket = null;
    if (!asset && event.assetId) {
      eventMarket = markets.marketForToken(event.assetId);
      asset = eventMarket?.asset || null;
    } else if (event.assetId) {
      eventMarket = markets.marketForToken(event.assetId);
    }
    if (!asset) return;
    pendingEvents.set(asset, { ...event, marketId: eventMarket?.id ?? null });
    if (eventTimers.has(asset)) return;
    const timer = setTimeout(() => {
      eventTimers.delete(asset);
      const trigger = pendingEvents.get(asset);
      pendingEvents.delete(asset);
      if (!trigger) return;
      const targets = capturePolicy.filterMarkets(trigger.marketId != null
        ? markets.evaluationForAsset(asset).filter((market) => market.id === trigger.marketId)
        : markets.evaluationForAsset(asset));
      if (!targets.length) return;
      try {
        const decisionAt = Date.now();
        for (const act of targets) shadow.tick(contextFor(act, decisionAt, trigger), 'event');
        state.counters.eventTicks = (state.counters.eventTicks || 0) + targets.length;
      } catch (err) {
        logEvent('ERROR', 'shadow', `event tick failed [${asset}]: ${err.message}`);
      }
    }, 25);
    eventTimers.set(asset, timer);
  };

  await feeds.connect();
  await rtds.connect().catch((e) => logEvent('ERROR', 'rtds', `initial ws connect failed: ${e.message}`));
  await chainlink.poll();
  await markets.discover();
  await clob.connect().catch((e) => logEvent('ERROR', 'clob', `initial ws connect failed: ${e.message}`));

  const subscribeActive = () => {
    // Pass full desired state; ClobRecon diffs it into documented dynamic
    // subscribe/unsubscribe operations on an established socket. Keep the
    // next window warm only near its boundary: subscribing every upcoming
    // token for the full five minutes doubled normal traffic/WAL volume and
    // correlated with abnormal 1006 closes, without adding usable strategy
    // observations. The 20 s lead spans two 10 s discovery cycles.
    const ids = [];
    const nowMs = Date.now();
    const warmUpcoming = capturePolicy.filterMarkets(markets.upcomingAll()).filter((rec) => {
      const startMs = rec?.window_start instanceof Date
        ? rec.window_start.getTime()
        : new Date(rec?.window_start).getTime();
      return Number.isFinite(startMs) && startMs - nowMs <= 20000;
    });
    const warmResearch = capturePolicy.filterMarkets(markets.upcomingResearch()).filter((rec) => {
      const startMs = rec?.window_start instanceof Date
        ? rec.window_start.getTime()
        : new Date(rec?.window_start).getTime();
      return Number.isFinite(startMs) && startMs - nowMs <= 30000;
    });
    for (const rec of [...evaluationMarkets(), ...warmUpcoming, ...warmResearch]) {
      if (rec) ids.push(rec.up_token_id, rec.down_token_id);
    }
    if (ids.length) clob.subscribe(ids.filter(Boolean));
  };
  subscribeActive();

  // ── timers ──────────────────────────────────────────────────────────────
  const timers = [];
  if (paperAdapter) {
    await paperAdapter.poll();
    timers.push(setInterval(() => paperAdapter.poll().catch(() => {}), 5000));
  }
  if (metaStrategies.length) {
    timers.push(setInterval(() => {
      refreshMetaPerformance().catch((error) => {
        metaPerformanceHealth.lastError = error.message;
        logEvent('ERROR', 'shadow',
          `meta-strategy performance refresh failed: ${error.message}`);
      });
    }, 60000));
  }
  timers.push(setInterval(() => markets.discover().then(subscribeActive).catch(() => {}), 10000));
  timers.push(setInterval(() => chainlink.poll().catch(() => {}), 15000));
  timers.push(setInterval(() => clob.checkStale(), 30000));
  timers.push(setInterval(() => rtds.checkStale(15000), 15000));
  // Feed silent-socket watchdog (binance escalates to process restart)
  timers.push(setInterval(() => feeds.checkStale(30000), 30000));
  markets.backfillResolutions().catch(() => {});
  timers.push(setInterval(() => markets.backfillResolutions().catch(() => {}), 600000));
  timers.push(setInterval(() => markets.pollGamma().catch(() => {}), 5000));
  // Fair round-robin REST backup. A burst over every token always consumed the
  // per-shard in-flight slots on the first few active markets, so quiet daily
  // contracts could wait ~60s for validation despite healthy sockets. Four
  // tokens/second covers the bounded 32-token active panel in ~8s; pollBook's
  // own 15s/token floor and 3/shard concurrency remain the rate-limit guard.
  let backupBookCursor = 0;
  timers.push(setInterval(() => {
    const ids = evaluationMarkets()
      .flatMap((act) => [act.up_token_id, act.down_token_id])
      .filter(Boolean);
    if (!ids.length) return;
    const batch = Math.min(4, ids.length);
    for (let offset = 0; offset < batch; offset += 1) {
      const assetId = ids[(backupBookCursor + offset) % ids.length];
      clob.pollBook(assetId).catch(() => {});
    }
    backupBookCursor = (backupBookCursor + batch) % ids.length;
  }, 1000));
  // Pace validation at one token every 5s. Normal book state is entirely
  // event-driven; REST is only gap recovery and low-rate hash reconciliation.
  timers.push(setInterval(() => clob.validateNextBook().catch(() => {}), 5000));
  timers.push(setInterval(() => {
    // taker prints: active + just-ended market per asset (prints land late)
    for (const a of assets) {
      const act = markets.active(a.asset);
      const prev = markets.bySlug.get(`${a.slug_prefix}-${markets.windowEpoch(-1)}`);
      if (act) clob.pollTakerTrades(act.condition_id).catch(() => {});
      if (prev) clob.pollTakerTrades(prev.condition_id).catch(() => {});
    }
  }, 30000));

  const bookSnapshotMs = Math.max(1000, Number(process.env.BORG_BOOK_SNAPSHOT_MS || 1000));
  const lastBookSnapshotAt = new Map();
  // ── 1s strategy tick + independently paced derived SQL snapshots ────────
  timers.push(setInterval(async () => {
    try {
      await markets.captureBoundaries();
      const now = Date.now();
      for (const act of evaluationMarkets()) {
        const ctx = contextFor(act, now);
        const { tteSec: tte, upBook, downBook, upMid: mid, sigma, btc: px, ref,
          phiFair, gammaUp, rtdsChainlink, resolverDivergence } = ctx;
        const top = (levels, n = 10) => (levels || []).slice(0, n);
        const upBids = top(upBook?.bids), upAsks = top(upBook?.asks);
        const bb = upBids[0]?.[0] ?? null, ba = upAsks[0]?.[0] ?? null;
        const depthUsd = (levels, ref) => {
          if (!levels || ref == null) return null;
          let usd = 0;
          for (const [p, s] of levels) if (Math.abs(p - ref) <= 0.05) usd += p * s;
          return usd;
        };
        if (now - (lastBookSnapshotAt.get(act.id) || 0) >= bookSnapshotMs) {
          state.snapBuf.push([
            new Date(now), act.id, tte,
            JSON.stringify(upBids), JSON.stringify(upAsks),
            JSON.stringify(top(downBook?.bids)), JSON.stringify(top(downBook?.asks)),
            bb, ba, mid, bb != null && ba != null ? ba - bb : null,
            downBook?.bids?.[0]?.[0] ?? null, downBook?.asks?.[0]?.[0] ?? null,
            depthUsd(upBook?.bids, mid), depthUsd(upBook?.asks, mid),
            upBook ? (now - upBook.at < 3000 ? upBook.src : `${upBook.src}_stale`) : null,
            gammaUp,
            px, ref, sigma, phiFair, act.asset === 'btc' ? chainlink.price : null,
            rtdsChainlink, resolverDivergence?.absBps ?? null,
          ]);
          lastBookSnapshotAt.set(act.id, now);
          if (lastBookSnapshotAt.size > 5000) {
            lastBookSnapshotAt.delete(lastBookSnapshotAt.keys().next().value);
          }
        }
        // Strategy decisions remain on the 1s cadence. Canonical feed events
        // and decisions are in the WAL; SQL snapshots are a sampled query tier.
        if (shadow) {
          try {
            shadow.tick(ctx, 'sampled');
          } catch (err) {
            await logEvent('ERROR', 'shadow', `tick failed [${act.asset}]: ${err.message}`);
          }
        }
      }
    } catch (err) {
      await logEvent('ERROR', 'collector', `tick failed: ${err.message}`);
    }
  }, 1000));

  // ── 5s flush: snapshots, bars, clob events, chainlink rounds ────────────
  timers.push(setInterval(async () => {
    const snaps = state.snapBuf.splice(0);
    if (snaps.length) {
      try {
        state.counters.snaps += await insertRows('borg_book_snaps', [
          'ts', 'market_id', 'tte_sec',
          'up_bids', 'up_asks', 'down_bids', 'down_asks',
          'up_best_bid', 'up_best_ask', 'up_mid', 'up_spread',
          'down_best_bid', 'down_best_ask',
          'bid_depth_usd', 'ask_depth_usd', 'book_src', 'gamma_up',
          'btc_price', 'btc_ref', 'sigma5m_ewma', 'phi_fair', 'cl_mainnet',
          'rtds_chainlink', 'rtds_divergence_bps',
        ], snaps);
      } catch (err) {
        await logEvent('ERROR', 'collector', `snap flush failed (${snaps.length} dropped): ${err.message}`);
      }
    }
    const bars = feeds.drainBars();
    if (bars.length) {
      try {
        state.counters.bars += await insertRows('borg_binance_1s',
          ['symbol', 'ts', 'open', 'high', 'low', 'close', 'n_trades', 'buy_vol', 'sell_vol', 'best_bid', 'best_ask', 'depth_imb'],
          bars.map((b) => [b.symbol, new Date(b.sec * 1000), b.open, b.high, b.low, b.close, b.n, b.buyVol, b.sellVol,
            b.bestBid ?? null, b.bestAsk ?? null, b.depthImb ?? null]),
          'ON CONFLICT (symbol, ts) DO NOTHING');
      } catch (err) {
        await logEvent('ERROR', 'collector', `bar flush failed (${bars.length} dropped): ${err.message}`);
      }
    }
    const referenceRows = feeds.drainReferenceRows();
    if (referenceRows.length) {
      try {
        await insertRows('borg_coinbase_1s',
          ['product', 'asset', 'ts', 'price', 'best_bid', 'best_ask'],
          referenceRows.map((r) => [r.product, r.asset, new Date(r.sec * 1000), r.price, r.bestBid, r.bestAsk]),
          'ON CONFLICT (product, ts) DO NOTHING');
      } catch (err) {
        await logEvent('ERROR', 'collector', `coinbase flush failed (${referenceRows.length} dropped): ${err.message}`);
      }
    }
    const externalRows = feeds.drainExternalRows();
    if (externalRows.touches.length) {
      try {
        state.counters.externalTouches = (state.counters.externalTouches || 0)
          + await insertRows('borg_external_book_touch', [
            'source', 'product', 'asset', 'source_ts', 'received_at',
            'receive_monotonic_ns', 'best_bid', 'bid_size', 'best_ask', 'ask_size',
            'connection_epoch', 'event_sequence', 'wal_event_id',
          ], externalRows.touches.map((row) => [
            row.source, row.product, row.asset,
            row.sourceMs ? new Date(row.sourceMs) : null, new Date(row.receivedAt),
            row.receiveMonoNs, row.bestBid, row.bidSize, row.bestAsk, row.askSize,
            row.connectionEpoch, row.eventSequence, row.walEventId,
          ]));
      } catch (err) {
        await logEvent('ERROR', 'collector', `external touch flush failed (${externalRows.touches.length}; raw WAL retained): ${err.message}`);
      }
    }
    if (externalRows.trades.length) {
      try {
        state.counters.externalTrades = (state.counters.externalTrades || 0)
          + await insertRows('borg_external_trades', [
            'dedup_key', 'source', 'product', 'asset', 'source_ts', 'received_at',
            'receive_monotonic_ns', 'price', 'size', 'side',
            'connection_epoch', 'event_sequence', 'wal_event_id',
          ], externalRows.trades.map((row) => [
            row.dedupKey, row.source, row.product, row.asset,
            row.sourceMs ? new Date(row.sourceMs) : null, new Date(row.receivedAt),
            row.receiveMonoNs, row.price, row.size, row.side,
            row.connectionEpoch, row.eventSequence, row.walEventId,
          ]), 'ON CONFLICT (dedup_key,received_at) DO NOTHING');
      } catch (err) {
        await logEvent('ERROR', 'collector', `external trade flush failed (${externalRows.trades.length}; raw WAL retained): ${err.message}`);
      }
    }
    const rtdsRows = rtds.drainRows();
    if (rtdsRows.length) {
      try {
        await insertRows('borg_rtds_ticks', [
          'source', 'symbol', 'asset', 'source_ts', 'received_at', 'receive_monotonic_ns',
          'value', 'connection_epoch', 'event_sequence', 'wal_event_id', 'raw',
        ], rtdsRows.map((r) => [
          r.source, r.symbol, r.asset, r.sourceMs ? new Date(r.sourceMs) : null,
          new Date(r.receiveWallMs), r.receiveMonoNs, r.value, r.connectionEpoch,
          r.eventSequence, r.walEventId, JSON.stringify(r.raw),
        ]));
      } catch (err) {
        rtds.restoreRows(rtdsRows);
        await logEvent('ERROR', 'rtds', `tick flush failed (${rtdsRows.length} retained): ${err.message}`);
      }
    }
    state.counters.clobEvents += await clob.flushEvents();
    if (shadow) state.counters.shadowOrders = (state.counters.shadowOrders || 0) + await shadow.flush();
    const rounds = chainlink.drainNewRounds();
    if (rounds.length) {
      try {
        await insertRows('borg_chainlink_rounds',
          ['round_id', 'answer', 'oracle_updated_at', 'btc_at_receipt'],
          rounds.map((r) => [r.roundId, r.price, new Date(r.updatedAtMs), feeds.getPrice('btc')]),
          'ON CONFLICT (round_id) DO NOTHING');
      } catch (err) {
        await logEvent('ERROR', 'collector', `round flush failed: ${err.message}`);
      }
    }
  }, 5000));

  // ── heartbeat + staleness summary (60s) ─────────────────────────────────
  timers.push(setInterval(async () => {
    const stale = [];
    const fs = feeds.feedStatus();
    if (fs !== 'ok') stale.push(fs.replace('STALE: ', ''));
    if (Date.now() - clob.lastWsMsgAt > 60000) stale.push('clob_ws>60s');
    if (rtds.checkStale(15000)) stale.push('rtds_chainlink>15s');
    if (metaStrategies.length
        && (!metaPerformanceHealth.lastSuccessAt
          || Date.now() - metaPerformanceHealth.lastSuccessAt > 180000)) {
      stale.push('meta_performance_snapshot>180s');
    }
    await persistStrategyRuntime().catch((err) => {
      stale.push('strategy_runtime_write');
      logEvent('ERROR', 'shadow', `runtime heartbeat write failed: ${err.message}`);
    });
    const strategyRuntime = shadow?.runtimeStatus() || [];
    const walHealth = {
      enabled: process.env.BORG_RAW_WAL !== '0',
      checkedAt: new Date().toISOString(),
      collectionEpochId: collection.epochId,
      collectorRunId: collection.runId,
      sources: Object.fromEntries(Object.values(wals).map((wal) => [wal.source, wal.health()])),
    };
    await logEvent(stale.length ? 'WARN' : 'INFO', 'heartbeat',
      stale.length ? `STALE: ${stale.join(', ')}` : 'ok',
      { ...state.counters, uptimeMin: Math.round((Date.now() - state.startedAt) / 60000),
        collectionEpochId: collection.epochId,
        collectorRunId: collection.runId,
        registeredStrategies: strategyRuntime.length,
        evaluatingStrategies: strategyRuntime.filter((row) => row.evaluations > 0).length,
        strategyErrors: strategyRuntime.reduce((sum, row) => sum + row.errors, 0),
        strategyDiagnostics: Object.fromEntries(strategyRuntime
          .filter((row) => row.diagnostics != null)
          .map((row) => [row.strategy, row.diagnostics])),
        metaPerformance: {
          lastSuccessAt: metaPerformanceHealth.lastSuccessAt
            ? new Date(metaPerformanceHealth.lastSuccessAt).toISOString()
            : null,
          lastError: metaPerformanceHealth.lastError,
          sourceRows: metaPerformanceHealth.sourceRows,
        },
        wal: walHealth,
        active: evaluationMarkets().map((m) => `${m.asset}:${m.market_type || 'direction_5m'}`).join(',') || null,
        capturePolicy: capturePolicy.describe(),
        sqlTouchMinIntervalMs,
        bookSnapshotMs,
        researchSelection: markets.researchSelectionMeta });
  }, 60000));

  const shutdown = async (sig) => {
    await logEvent('INFO', 'collector', `shutdown on ${sig}`, state.counters);
    for (const t of timers) clearInterval(t);
    for (const timer of eventTimers.values()) clearTimeout(timer);
    feeds.stop();
    clob.close();
    rtds.close();
    await clob.flushEvents().catch(() => {});
    await persistStrategyRuntime().catch(() => {});
    await finishCollectorRun(collection.runId, 'STOPPED', { signal: sig, counters: state.counters }).catch(() => {});
    await Promise.all(Object.values(wals).map((wal) => wal.close().catch((err) =>
      logEvent('ERROR', 'wal', `seal failed [${wal.source}]: ${err.message}`))));
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => logEvent('ERROR', 'collector', `unhandledRejection: ${err?.message || err}`));
  process.on('uncaughtException', async (err) => {
    await logEvent('ERROR', 'collector', `uncaughtException: ${err.message}`, { stack: err.stack?.slice(0, 800) });
    process.exit(1); // supervisor restarts us
  });
}

main().catch(async (err) => {
  await logEvent('ERROR', 'collector', `fatal boot error: ${err.message}`, { stack: err.stack?.slice(0, 800) });
  process.exit(1);
});
