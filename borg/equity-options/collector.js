#!/usr/bin/env node
'use strict';

/**
 * Exact-expiry equity/options paper collector.
 *
 * Licensed IBKR/OPRA quotes, Pyth equity RTDS, and Polymarket L2 are captured
 * on separate clocks. The process contains no order endpoint or account-side
 * operation. Missing entitlement, exact-source basis evidence, costs, or
 * metadata produces a visible blocker while collection continues.
 */

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const ClobMultiplex = require('../recon/clob-multiplex');
const RawWal = require('../recon/wal');
const { insertRows, logEvent, migrateEdgeExecution, pool } = require('../recon/db');
const { PythRtds } = require('../pyth/rtds');
const {
  attributionEvent, attributionRow,
} = require('../research/execution-attribution');
const { buildBasisSample, frozenBasisBound } = require('./basis');
const { IbkrReadOnlyClient } = require('./ibkr-opra');
const { ExactCloseSources } = require('./exact-close-sources');
const { scanRobustVerticals } = require('./vertical-floor');
const {
  EQUITY_OPTION_UNIVERSE_VERSION, fetchCurrentEquityEvents, selectEquityThresholds,
} = require('./universe');

const RUN_ID = `eqopt:${os.hostname()}:${Date.now()}:${process.pid}`;
const STARTED_AT = new Date().toISOString();
const SYMBOLS = String(process.env.EQOPT_SYMBOLS || 'SPY,EWY')
  .split(',').map((value) => value.trim().toUpperCase()).filter(Boolean);
const REFRESH_MS = Math.max(60_000, Number(process.env.EQOPT_REFRESH_MS || 300_000));
const QUOTE_POLL_MS = Math.max(500, Number(process.env.EQOPT_QUOTE_POLL_MS || 1000));
const EVALUATION_MS = Math.max(1000, Number(process.env.EQOPT_EVALUATION_MS || 5000));
const DB_TOUCH_SAMPLE_MS = Math.max(500, Number(process.env.EQOPT_DB_TOUCH_SAMPLE_MS || 5000));
const MAX_CONTRACTS = Math.max(2, Number(process.env.EQOPT_MAX_CONTRACTS || 80));
const STRIKE_PAD_USD = Math.max(1, Number(process.env.EQOPT_STRIKE_PAD_USD || 10));
const OPTION_FEE_PER_CONTRACT = Number(process.env.EQOPT_OPTION_FEE_PER_CONTRACT || 0.65);
const OPTION_TICK_USD = Number(process.env.EQOPT_OPTION_TICK_USD || 0.01);
const ASSIGNMENT_RESERVE_USD = Number(process.env.EQOPT_ASSIGNMENT_RESERVE_USD || 5);
const MAX_AGE_MS = Math.max(500, Number(process.env.EQOPT_MAX_AGE_MS || 2000));
const CORPORATE_ACTION_CLEAR = String(process.env.EQOPT_CORPORATE_ACTION_CLEAR || 'false')
  .toLowerCase() === 'true';

function finite(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function chunks(rows, size) {
  const out = [];
  for (let index = 0; index < rows.length; index += size) out.push(rows.slice(index, index + size));
  return out;
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function targetRows(targets) {
  return targets.map((target) => [
    target.conditionId, EQUITY_OPTION_UNIVERSE_VERSION, target.eventId, target.gammaId,
    target.slug, target.question, target.symbol, target.pythFeedSymbol,
    target.strike, new Date(target.expiryMs), target.yesToken, target.noToken,
    target.minimumOrderSize, target.fees.enabled, target.fees.rate,
    target.fees.exponent, target.ruleHash, JSON.stringify(target.ruleDocument), true,
    new Date(),
  ]);
}

async function persistTargets(targets) {
  if (targets.length) {
    await insertRows('borg_eqopt_targets', [
      'condition_id', 'experiment_id', 'event_id', 'gamma_id', 'slug', 'question',
      'symbol', 'pyth_feed_symbol', 'strike', 'expiry_at', 'yes_token_id',
      'no_token_id', 'minimum_order_size', 'fees_enabled', 'fee_rate',
      'fee_exponent', 'rule_hash', 'rule_document', 'active', 'refreshed_at',
    ], targetRows(targets), `ON CONFLICT (condition_id) DO UPDATE SET
      active=true,slug=EXCLUDED.slug,question=EXCLUDED.question,
      minimum_order_size=EXCLUDED.minimum_order_size,fees_enabled=EXCLUDED.fees_enabled,
      fee_rate=EXCLUDED.fee_rate,fee_exponent=EXCLUDED.fee_exponent,
      rule_hash=EXCLUDED.rule_hash,rule_document=EXCLUDED.rule_document,
      refreshed_at=EXCLUDED.refreshed_at`);
  }
  await pool.query(`UPDATE borg_eqopt_targets SET active=false
    WHERE active=true AND NOT (condition_id=ANY($1::text[]))`, [targets.map((row) => row.conditionId)]);
}

async function discoverContracts(client, targets) {
  const contracts = [];
  const underlyings = new Map();
  for (const symbol of [...new Set(targets.map((target) => target.symbol))]) {
    const found = await client.searchUnderlying(symbol);
    if (!found?.conid) continue;
    underlyings.set(symbol, { conid: found.conid, symbol, raw: found.raw });
  }
  const groups = new Map();
  for (const target of targets) {
    const key = `${target.symbol}:${target.expiryMs}`;
    const group = groups.get(key) || [];
    group.push(target); groups.set(key, group);
  }
  for (const group of groups.values()) {
    const sample = group[0];
    const underlying = underlyings.get(sample.symbol);
    if (!underlying) continue;
    const available = await client.strikes(underlying.conid, sample.expiryMs);
    const minimum = Math.min(...group.map((target) => target.strike)) - STRIKE_PAD_USD;
    const maximum = Math.max(...group.map((target) => target.strike)) + STRIKE_PAD_USD;
    for (const optionType of ['call', 'put']) {
      const selected = (available[optionType] || [])
        .filter((strike) => strike >= minimum && strike <= maximum)
        .sort((left, right) => left - right);
      for (const strike of selected) {
        const rows = await client.optionInfo({
          underlying: sample.symbol, underlyingConid: underlying.conid,
          expiryMs: sample.expiryMs, strike, optionType,
        });
        contracts.push(...rows);
        if (contracts.length >= MAX_CONTRACTS) break;
        await wait(110); // stay below the documented 10 requests/second pacing limit
      }
      if (contracts.length >= MAX_CONTRACTS) break;
    }
    if (contracts.length >= MAX_CONTRACTS) break;
  }
  return {
    contracts: [...new Map(contracts.map((row) => [row.conid, row])).values()],
    underlyings,
  };
}

function contractRows(contracts) {
  return contracts.map((row) => [
    row.conid, row.instrumentId, row.underlying, row.underlyingConid,
    row.optionType, row.strike, new Date(row.expiryMs), row.multiplier,
    row.tradingClass, row.exchange, row.exerciseStyle, row.settlementStyle,
    row.adjusted, row.metadataGrade, JSON.stringify(row.raw), new Date(),
  ]);
}

function optionTouchRow(quote) {
  return [
    new Date(quote.receiveMs), new Date(quote.sourceMs), new Date(quote.receiveMs),
    quote.receiveMonoNs, quote.conid, quote.instrumentId, quote.underlying,
    quote.optionType, quote.strike, new Date(quote.expiryMs), quote.bid, quote.ask,
    quote.bidSize, quote.askSize, quote.last, quote.availability, quote.liveEntitled,
    quote.connectionEpoch, quote.eventSequence, quote.walEventId || null,
    quote.dataQualityGrade,
  ];
}

function underlyingTouchRow(quote, symbol) {
  return [
    new Date(quote.receiveMs), new Date(quote.sourceMs), new Date(quote.receiveMs),
    quote.receiveMonoNs, quote.conid, symbol, quote.bid, quote.ask,
    quote.bidSize, quote.askSize, quote.last, quote.availability,
    quote.liveEntitled, quote.dataQualityGrade,
  ];
}

function evaluationBarrier({ clientConfigured, authReady, contracts, liveQuotes, basis }) {
  if (!clientConfigured) return 'BLOCKED_NO_LICENSED_OPRA_ENDPOINT';
  if (!authReady) return 'BLOCKED_IBKR_SESSION_OR_ENTITLEMENT';
  if (!contracts) return 'BLOCKED_NO_EXACT_EXPIRY_CONTRACTS';
  if (!liveQuotes) return 'BLOCKED_NO_LIVE_ENTITLED_SYNCHRONIZED_QUOTES';
  if (!basis?.ready) return 'BLOCKED_INSUFFICIENT_EXACT_SOURCE_BASIS_DAYS';
  if (!CORPORATE_ACTION_CLEAR) return 'BLOCKED_CORPORATE_ACTION_CLEARANCE';
  return null;
}

async function main() {
  await migrateEdgeExecution();
  const optionWal = new RawWal('equity-options-opra', {
    root: process.env.BORG_WAL_DIR, minFreeGb: Number(process.env.BORG_WAL_MIN_FREE_GB || 20),
  });
  const pythWal = new RawWal('equity-options-pyth', {
    root: process.env.BORG_WAL_DIR, minFreeGb: Number(process.env.BORG_WAL_MIN_FREE_GB || 20),
  });
  const clobWal = new RawWal('equity-options-clob', {
    root: process.env.BORG_WAL_DIR, minFreeGb: Number(process.env.BORG_WAL_MIN_FREE_GB || 20),
  });
  const decisionWal = new RawWal('equity-options-decisions', {
    root: process.env.BORG_WAL_DIR, minFreeGb: Number(process.env.BORG_WAL_MIN_FREE_GB || 20),
  });
  const client = new IbkrReadOnlyClient({
    onRaw: (event) => optionWal.append(JSON.stringify(event), {
      channel: 'ibkr-read-only', sourceMs: event.receivedAt,
    }),
  });
  const exactCloseSources = new ExactCloseSources({
    onRaw: (event) => optionWal.append(JSON.stringify(event), {
      channel: 'exact-daily-close', sourceMs: event.receivedAt,
    }),
  });
  let targets = [];
  let contracts = [];
  let underlyings = new Map();
  let tokenMarket = new Map();
  let auth = { ready: false };
  let blocker = client.configured() ? 'STARTING' : 'BLOCKED_NO_LICENSED_OPRA_ENDPOINT';
  let lastContractError = null;
  let lastOptionAt = null;
  let lastBasisAt = null;
  let optionTouches = 0;
  let basisSamples = 0;
  let exactBasisErrors = 0;
  let evaluations = 0;
  let lastTouchStored = new Map();
  let latestQuotes = new Map();
  let latestUnderlying = new Map();
  let pythRows = [];
  let stopping = false;
  let evaluating = false;
  let quoting = false;

  const pyth = new PythRtds({
    symbols: SYMBOLS,
    wal: pythWal,
    onTick: (tick) => {
      if (tick.historical) return;
      pythRows.push([
        EQUITY_OPTION_UNIVERSE_VERSION, tick.symbol,
        tick.sourceMs == null ? null : new Date(tick.sourceMs),
        tick.providerReceivedMs == null ? null : new Date(tick.providerReceivedMs),
        new Date(tick.receiveWallMs), tick.receiveMonoNs, tick.value,
        tick.carriedForward, tick.historical, tick.connectionEpoch,
        tick.eventSequence, tick.walEventId, JSON.stringify(tick.raw),
      ]);
      if (pythRows.length > 20_000) pythRows.shift();
    },
  });
  const clob = new ClobMultiplex((token) => tokenMarket.get(String(token)) || null, {
    shardCount: Number(process.env.EQOPT_CLOB_SHARDS || 2), wal: clobWal,
  });

  await pool.query(`INSERT INTO borg_eqopt_runtime (
    run_id,experiment_id,started_at,host,pid,status,blocker
  ) VALUES ($1,$2,$3,$4,$5,'STARTING',$6)
  ON CONFLICT (run_id) DO NOTHING`, [
    RUN_ID, EQUITY_OPTION_UNIVERSE_VERSION, STARTED_AT, os.hostname(), process.pid, blocker,
  ]);

  const refresh = async () => {
    const events = await fetchCurrentEquityEvents();
    targets = selectEquityThresholds(events, { symbols: SYMBOLS, nowMs: Date.now() }).records;
    await persistTargets(targets);
    tokenMarket = new Map(targets.flatMap((target) => [
      [target.yesToken, Number(target.gammaId)], [target.noToken, Number(target.gammaId)],
    ]));
    clob.subscribe([...tokenMarket.keys()]);
    pyth.setSymbols([...new Set(targets.map((target) => target.symbol))]);
    if (!client.configured()) {
      blocker = 'BLOCKED_NO_LICENSED_OPRA_ENDPOINT';
      return;
    }
    try {
      auth = await client.authStatus();
      if (!auth.ready) {
        blocker = 'BLOCKED_IBKR_SESSION_OR_ENTITLEMENT';
        return;
      }
      const discovered = await discoverContracts(client, targets);
      contracts = discovered.contracts;
      underlyings = discovered.underlyings;
      if (contracts.length) {
        await insertRows('borg_eqopt_contracts', [
          'conid', 'instrument_id', 'underlying', 'underlying_conid', 'option_type',
          'strike', 'expiry_at', 'multiplier', 'trading_class', 'exchange',
          'exercise_style', 'settlement_style', 'adjusted', 'metadata_grade',
          'raw', 'refreshed_at',
        ], contractRows(contracts), `ON CONFLICT (conid) DO UPDATE SET
          raw=EXCLUDED.raw,metadata_grade=EXCLUDED.metadata_grade,
          adjusted=EXCLUDED.adjusted,refreshed_at=EXCLUDED.refreshed_at`);
      }
      blocker = contracts.length ? 'COLLECTING_BASIS' : 'BLOCKED_NO_EXACT_EXPIRY_CONTRACTS';
      lastContractError = null;
    } catch (error) {
      auth = { ready: false };
      blocker = 'BLOCKED_IBKR_SESSION_OR_ENTITLEMENT';
      lastContractError = error.message;
      await logEvent('WARN', 'equity_options', `licensed adapter unavailable: ${error.message}`);
    }
  };

  const quote = async () => {
    if (quoting || stopping || !auth.ready || !contracts.length) return;
    quoting = true;
    try {
      const contractMap = new Map(contracts.map((row) => [String(row.conid), row]));
      for (const row of underlyings.values()) contractMap.set(String(row.conid), {
        instrumentId: row.symbol, underlying: row.symbol,
      });
      const ids = [...contracts.map((row) => row.conid),
        ...[...underlyings.values()].map((row) => row.conid)];
      const rows = [];
      for (const batch of chunks(ids, 50)) rows.push(...await client.snapshot(batch, contractMap));
      const now = Date.now();
      const optionRows = [];
      const underlyingRows = [];
      for (const row of rows) {
        const contract = contractMap.get(String(row.conid));
        if (!row.sourceMs) continue;
        if (contract?.optionType) {
          latestQuotes.set(row.conid, { ...row, adjusted: contract.adjusted,
            exerciseStyle: contract.exerciseStyle, settlementStyle: contract.settlementStyle });
          if (now - (lastTouchStored.get(`o:${row.conid}`) || 0) >= DB_TOUCH_SAMPLE_MS) {
            optionRows.push(optionTouchRow(row)); lastTouchStored.set(`o:${row.conid}`, now);
          }
        } else if (contract?.underlying) {
          latestUnderlying.set(contract.underlying, row);
          if (now - (lastTouchStored.get(`u:${row.conid}`) || 0) >= DB_TOUCH_SAMPLE_MS) {
            underlyingRows.push(underlyingTouchRow(row, contract.underlying));
            lastTouchStored.set(`u:${row.conid}`, now);
          }
        }
      }
      if (optionRows.length) {
        await insertRows('borg_eqopt_option_touches', [
          'observed_at', 'source_ts', 'received_at', 'receive_monotonic_ns',
          'conid', 'instrument_id', 'underlying', 'option_type', 'strike',
          'expiry_at', 'bid', 'ask', 'bid_size', 'ask_size', 'last_price',
          'market_data_availability', 'live_entitled', 'connection_epoch',
          'event_sequence', 'wal_event_id', 'data_quality_grade',
        ], optionRows, 'ON CONFLICT (conid,observed_at) DO NOTHING');
        optionTouches += optionRows.length;
      }
      if (underlyingRows.length) await insertRows('borg_eqopt_underlying_touches', [
        'observed_at', 'source_ts', 'received_at', 'receive_monotonic_ns', 'conid',
        'symbol', 'bid', 'ask', 'bid_size', 'ask_size', 'last_price',
        'market_data_availability', 'live_entitled', 'data_quality_grade',
      ], underlyingRows, 'ON CONFLICT (conid,observed_at) DO NOTHING');
      if (rows.length) lastOptionAt = new Date().toISOString();
    } finally { quoting = false; }
  };

  const recordDiagnosticBasis = async () => {
    for (const target of targets.filter((row) => row.expiryMs <= Date.now()
      && row.expiryMs > Date.now() - 24 * 3600_000)) {
      const { rows: pythTicks } = await pool.query(`
        SELECT source_ts,value,wal_event_id FROM borg_pyth_ticks
         WHERE experiment_id=$1 AND symbol=$2 AND historical=false
           AND carried_forward=false
           AND source_ts BETWEEN $3::timestamptz-interval '60 seconds' AND $3::timestamptz
         ORDER BY source_ts DESC LIMIT 1`, [
        EQUITY_OPTION_UNIVERSE_VERSION, target.symbol, new Date(target.expiryMs),
      ]);
      const { rows: underlyingTicks } = await pool.query(`
        SELECT source_ts,last_price,id FROM borg_eqopt_underlying_touches
         WHERE symbol=$1 AND live_entitled=true
           AND source_ts BETWEEN $2::timestamptz-interval '60 seconds' AND $2::timestamptz
           AND last_price IS NOT NULL ORDER BY source_ts DESC LIMIT 1`, [
        target.symbol, new Date(target.expiryMs),
      ]);
      const pythTick = pythTicks[0]; const underlyingTick = underlyingTicks[0];
      if (!pythTick || !underlyingTick) continue;
      const sample = buildBasisSample({
        experimentId: EQUITY_OPTION_UNIVERSE_VERSION, symbol: target.symbol,
        targetCloseAt: target.expiryMs, pythFeedSymbol: target.pythFeedSymbol,
        pythSourceTs: pythTick.source_ts, pythClose: pythTick.value,
        pythSourceKind: 'PYTH_RTDS_LAST_TICK_CONTROL',
        underlyingSource: 'IBKR_CONSOLIDATED_LAST_CONTROL',
        underlyingSourceTs: underlyingTick.source_ts,
        underlyingClose: underlyingTick.last_price, sourceGrade: 'B',
        ruleHash: target.ruleHash, pythEvidenceId: pythTick.wal_event_id,
        underlyingEvidenceId: `borg_eqopt_underlying_touches:${underlyingTick.id}`,
      });
      const inserted = await pool.query(`INSERT INTO borg_eqopt_basis_samples (
        sample_id,experiment_id,symbol,trade_date,target_close_at,pyth_feed_symbol,
        pyth_source_ts,pyth_close,pyth_source_kind,underlying_source,
        underlying_source_ts,underlying_close,basis_usd,basis_bps,source_grade,
        qualifying,rule_hash,detail
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)
      ON CONFLICT (experiment_id,symbol,trade_date,pyth_source_kind,underlying_source)
      DO NOTHING`, [
        sample.sampleId, sample.experimentId, sample.symbol, sample.tradeDate,
        sample.targetCloseAt, sample.pythFeedSymbol, sample.pythSourceTs,
        sample.pythClose, sample.pythSourceKind, sample.underlyingSource,
        sample.underlyingSourceTs, sample.underlyingClose, sample.basisUsd,
        sample.basisBps, sample.sourceGrade, sample.qualifying, sample.ruleHash,
        JSON.stringify(sample.detail),
      ]);
      if (inserted.rowCount) { basisSamples += 1; lastBasisAt = new Date().toISOString(); }
    }
  };

  const recordExactBasis = async () => {
    if (!exactCloseSources.configured()) return;
    const { rows: completedRows } = await pool.query(`
      SELECT DISTINCT ON (symbol,(expiry_at AT TIME ZONE 'UTC')::date)
             symbol,pyth_feed_symbol,expiry_at,rule_hash
        FROM borg_eqopt_targets
       WHERE expiry_at<=now() AND expiry_at>now()-interval '7 days'
       ORDER BY symbol,(expiry_at AT TIME ZONE 'UTC')::date,refreshed_at DESC`);
    const completed = completedRows.map((row) => ({
      symbol: String(row.symbol), pythFeedSymbol: String(row.pyth_feed_symbol),
      expiryMs: new Date(row.expiry_at).getTime(), ruleHash: String(row.rule_hash),
    }));
    for (const target of completed) {
      const tradeDate = new Date(target.expiryMs).toISOString().slice(0, 10);
      try {
        const pair = await exactCloseSources.dailyPair({ symbol: target.symbol,
          tradeDate, pythFeedSymbol: target.pythFeedSymbol });
        if (!pair.ready) { exactBasisErrors += 1; continue; }
        const sample = buildBasisSample({
          experimentId: EQUITY_OPTION_UNIVERSE_VERSION, symbol: target.symbol,
          tradeDate, targetCloseAt: target.expiryMs, pythFeedSymbol: target.pythFeedSymbol,
          pythSourceTs: pair.pyth.sourceTs, pythClose: pair.pyth.close,
          pythSourceKind: pair.pyth.sourceKind,
          underlyingSource: pair.official.source,
          underlyingSourceTs: pair.official.sourceTs,
          underlyingClose: pair.official.close, sourceGrade: 'A', ruleHash: target.ruleHash,
          pythEvidenceId: pair.pyth.evidenceId,
          underlyingEvidenceId: pair.official.evidenceId,
        });
        const inserted = await pool.query(`INSERT INTO borg_eqopt_basis_samples (
          sample_id,experiment_id,symbol,trade_date,target_close_at,pyth_feed_symbol,
          pyth_source_ts,pyth_close,pyth_source_kind,underlying_source,
          underlying_source_ts,underlying_close,basis_usd,basis_bps,source_grade,
          qualifying,rule_hash,detail
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)
        ON CONFLICT (experiment_id,symbol,trade_date,pyth_source_kind,underlying_source)
        DO NOTHING`, [
          sample.sampleId, sample.experimentId, sample.symbol, sample.tradeDate,
          sample.targetCloseAt, sample.pythFeedSymbol, sample.pythSourceTs,
          sample.pythClose, sample.pythSourceKind, sample.underlyingSource,
          sample.underlyingSourceTs, sample.underlyingClose, sample.basisUsd,
          sample.basisBps, sample.sourceGrade, sample.qualifying, sample.ruleHash,
          JSON.stringify(sample.detail),
        ]);
        if (inserted.rowCount) { basisSamples += 1; lastBasisAt = new Date().toISOString(); }
      } catch (error) {
        exactBasisErrors += 1;
        await logEvent('WARN', 'equity_options', `exact close basis unavailable: ${error.message}`);
      }
    }
  };

  const evaluate = async () => {
    if (evaluating || stopping) return;
    evaluating = true;
    try {
      const { rows: basisRows } = await pool.query(`
        SELECT sample_id,symbol,trade_date,basis_usd,qualifying
          FROM borg_eqopt_basis_samples WHERE experiment_id=$1 AND qualifying=true
         ORDER BY trade_date`, [EQUITY_OPTION_UNIVERSE_VERSION]);
      const basisBySymbol = new Map(SYMBOLS.map((symbol) => [symbol,
        frozenBasisBound(basisRows.filter((row) => row.symbol === symbol))]));
      const now = Date.now();
      const attribution = [];
      for (const target of targets.filter((row) => row.expiryMs > now)) {
        const relevant = [...latestQuotes.values()].filter((quote) =>
          quote.underlying === target.symbol && quote.expiryMs === target.expiryMs);
        const liveRelevant = relevant.filter((quote) => quote.liveEntitled
          && now - quote.sourceMs <= MAX_AGE_MS && now - quote.receiveMs <= MAX_AGE_MS);
        const basis = basisBySymbol.get(target.symbol);
        const barrier = evaluationBarrier({
          clientConfigured: client.configured(), authReady: auth.ready,
          contracts: relevant.length, liveQuotes: liveRelevant.length, basis,
        });
        const common = {
          conditionId: target.conditionId, symbol: target.symbol, strike: target.strike,
          expiryAt: new Date(target.expiryMs), observedAt: new Date(),
        };
        if (barrier) {
          const evaluationId = `eqe_${crypto.createHash('sha256')
            .update(`${target.conditionId}|${Math.floor(now / REFRESH_MS)}|${barrier}`).digest('hex').slice(0, 28)}`;
          await pool.query(`INSERT INTO borg_eqopt_evaluations (
            evaluation_id,experiment_id,observed_at,condition_id,symbol,strike,
            expiry_at,synchronized,live_entitled,basis_ready,costs_known,
            displayed_depth_supported,orphan_safe,qualified,barrier,
            data_quality_grade,execution_fidelity_grade,detail
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,false,$8,$9,$10,false,false,false,$11,$12,'F',$13::jsonb)
          ON CONFLICT (evaluation_id) DO NOTHING`, [
            evaluationId, EQUITY_OPTION_UNIVERSE_VERSION, common.observedAt,
            common.conditionId, common.symbol, common.strike, common.expiryAt,
            liveRelevant.length > 0, basis?.ready === true,
            OPTION_FEE_PER_CONTRACT >= 0 && OPTION_TICK_USD >= 0
              && ASSIGNMENT_RESERVE_USD >= 0,
            barrier, liveRelevant.length ? 'B' : 'F', JSON.stringify({
              basis, relevantQuotes: relevant.length, liveQuotes: liveRelevant.length,
              paperOnly: true,
            }),
          ]);
          attribution.push(attributionEvent({
            experimentId: EQUITY_OPTION_UNIVERSE_VERSION,
            opportunityId: target.conditionId, observedAt: common.observedAt,
            stage: 'DETECTED', dataQualityGrade: liveRelevant.length ? 'B' : 'F',
            executionFidelityGrade: 'F', detailIdentity: evaluationId,
            detail: { barrier, paperOnly: true },
          }));
          continue;
        }
        const polyBooks = {
          yes: clob.getBook(target.yesToken), no: clob.getBook(target.noToken),
        };
        const optionQuotes = liveRelevant.map((quote) => ({
          ...quote, adjusted: false, exerciseStyle: 'AMERICAN', settlementStyle: 'PHYSICAL',
        }));
        const result = scanRobustVerticals({
          nowMs: now, target, optionQuotes, polyBooks,
          config: {
            basisBoundUsd: basis.boundUsd, basisEvidenceId: basis.evidenceId,
            basisObservationDays: basis.observationDays,
            regularSessionTradeObserved: [...latestUnderlying.values()].some((quote) =>
              quote.underlying === target.symbol && quote.liveEntitled && quote.last > 0),
            corporateActionClear: CORPORATE_ACTION_CLEAR,
            optionFeePerContractPerLeg: OPTION_FEE_PER_CONTRACT,
            optionTickSizeUsd: OPTION_TICK_USD,
            assignmentReserveUsdPerContract: ASSIGNMENT_RESERVE_USD,
            feeMultiplier: 2, budgetUsd: 500, minProfitUsd: 1,
            maxContracts: 5, maxAgeMs: MAX_AGE_MS,
          },
        });
        for (const candidate of result.candidates.slice(0, 10)) {
          const evaluationId = `eqe_${crypto.createHash('sha256')
            .update(`${candidate.candidateId}|${Math.floor(now / EVALUATION_MS)}`).digest('hex').slice(0, 28)}`;
          const synchronized = liveRelevant.every((quote) =>
            Math.abs(quote.sourceMs - liveRelevant[0].sourceMs) <= MAX_AGE_MS);
          await pool.query(`INSERT INTO borg_eqopt_evaluations (
            evaluation_id,experiment_id,observed_at,condition_id,symbol,strike,
            expiry_at,side,contracts,token_shares,synchronized,live_entitled,
            basis_ready,costs_known,displayed_depth_supported,orphan_safe,
            qualified,stressed_profit_usd,orphan_safe_profit_usd,
            capital_required_usd,barrier,data_quality_grade,
            execution_fidelity_grade,detail
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,true,true,$12,$13,$14,
            $15,$16,$17,$18,$19,$20,$21::jsonb)
          ON CONFLICT (evaluation_id) DO NOTHING`, [
            evaluationId, EQUITY_OPTION_UNIVERSE_VERSION, new Date(), target.conditionId,
            target.symbol, target.strike, new Date(target.expiryMs), candidate.side,
            candidate.contracts, candidate.tokenShares, synchronized,
            candidate.polyEntry?.shares >= candidate.tokenShares,
            candidate.orphanReserveUsd != null, candidate.qualified,
            candidate.stressedProfitUsd, candidate.orphanSafeProfitUsd,
            candidate.capitalRequiredUsd, candidate.qualified ? null : 'NO_ORPHAN_SAFE_PROFIT',
            synchronized ? 'A' : 'C', candidate.qualified ? 'B' : 'C',
            JSON.stringify(candidate),
          ]);
          attribution.push(attributionEvent({
            experimentId: EQUITY_OPTION_UNIVERSE_VERSION,
            opportunityId: candidate.candidateId, instrumentGroupId: target.conditionId,
            observedAt: now, stage: candidate.qualified ? 'QUALIFIED'
              : candidate.orphanReserveUsd != null ? 'ORPHAN_SAFE'
                : 'SIMULTANEOUS_EXECUTABLE',
            quantity: candidate.tokenShares,
            conservativePnlUsd: candidate.orphanSafeProfitUsd,
            dataQualityGrade: synchronized ? 'A' : 'C',
            executionFidelityGrade: candidate.qualified ? 'B' : 'C',
            detailIdentity: evaluationId, detail: { evaluationId, paperOnly: true },
          }));
          evaluations += 1;
        }
      }
      if (attribution.length) decisionWal.append(JSON.stringify({
        type: 'equity_options_attribution_batch', observedAt: new Date().toISOString(),
        rows: attribution,
      }), { channel: 'paper-execution-attribution' });
      if (attribution.length) await insertRows('borg_execution_attribution', [
        'attribution_id', 'experiment_id', 'opportunity_id', 'instrument_group_id',
        'observed_at', 'stage', 'latency_ms', 'quantity', 'conservative_pnl_usd',
        'data_quality_grade', 'execution_fidelity_grade', 'paper_only', 'detail',
      ], attribution.map(attributionRow), 'ON CONFLICT (attribution_id) DO NOTHING');
      blocker = evaluationBarrier({
        clientConfigured: client.configured(), authReady: auth.ready,
        contracts: contracts.length,
        liveQuotes: [...latestQuotes.values()].filter((row) => row.liveEntitled).length,
        basis: [...basisBySymbol.values()].find((row) => row.ready),
      }) || 'READY_PAPER_EVALUATION';
    } finally { evaluating = false; }
  };

  const flushPyth = async () => {
    const rows = pythRows.splice(0, 5000);
    if (!rows.length) return;
    try {
      await insertRows('borg_pyth_ticks', [
        'experiment_id', 'symbol', 'source_ts', 'provider_received_at', 'received_at',
        'receive_monotonic_ns', 'value', 'carried_forward', 'historical',
        'connection_epoch', 'event_sequence', 'wal_event_id', 'raw',
      ], rows, 'ON CONFLICT (wal_event_id) DO NOTHING');
    } catch (error) { pythRows.unshift(...rows); throw error; }
  };

  const heartbeat = async () => {
    const liveEntitledContracts = [...latestQuotes.values()].filter((row) => row.liveEntitled).length;
    const meta = {
      pid: process.pid, host: os.hostname(), runId: RUN_ID,
      processStartedAt: STARTED_AT,
      collectionEpochId: process.env.BORG_COLLECTION_EPOCH_ID || 'equity-options-unmarked',
      experimentId: EQUITY_OPTION_UNIVERSE_VERSION,
      paperOnly: true, walletLoaded: false, liveOrderPath: false,
      targets: targets.length, contracts: contracts.length, liveEntitledContracts,
      optionTouches, basisSamples, evaluations, blocker,
      exactCloseSourcesConfigured: exactCloseSources.configured(), exactBasisErrors,
      lastOptionAt, lastBasisAt, lastContractError,
      pyth: pyth.health(), clob: clob.health(),
      licensedEndpointConfigured: client.configured(), authReady: auth.ready === true,
      credentialsPrinted: false,
    };
    await pool.query(`UPDATE borg_eqopt_runtime SET
      status=$2,targets=$3,contracts=$4,live_entitled_contracts=$5,
      option_touches=$6,basis_samples=$7,evaluations=$8,last_option_at=$9,
      last_basis_at=$10,blocker=$11,metrics=$12::jsonb,updated_at=now()
      WHERE run_id=$1`, [
      RUN_ID, blocker.startsWith('BLOCKED') ? 'BLOCKED' : 'RUNNING', targets.length,
      contracts.length, liveEntitledContracts, optionTouches, basisSamples,
      evaluations, lastOptionAt, lastBasisAt, blocker, JSON.stringify(meta),
    ]);
    await pool.query(`INSERT INTO system_heartbeats (component,beat_at,meta)
      VALUES ('equity_options_lab',now(),$1::jsonb)
      ON CONFLICT (component) DO UPDATE SET beat_at=now(),meta=EXCLUDED.meta`, [JSON.stringify(meta)]);
  };

  await refresh();
  clob.subscribe([...tokenMarket.keys()]);
  await Promise.all([clob.connect(), pyth.connect()]);
  const timers = [
    setInterval(() => refresh().catch((error) => logEvent('ERROR', 'equity_options', error.message)), REFRESH_MS),
    setInterval(() => quote().catch((error) => logEvent('WARN', 'equity_options', error.message)), QUOTE_POLL_MS),
    setInterval(() => evaluate().catch((error) => logEvent('ERROR', 'equity_options', error.message)), EVALUATION_MS),
    setInterval(() => recordDiagnosticBasis().catch((error) => logEvent('ERROR', 'equity_options', error.message)), 60_000),
    setInterval(() => recordExactBasis().catch((error) => logEvent('ERROR', 'equity_options', error.message)), 60_000),
    setInterval(() => flushPyth().catch((error) => logEvent('ERROR', 'equity_options', error.message)), 1000),
    setInterval(() => clob.flushEvents().catch(() => {}), 5000),
    setInterval(() => heartbeat().catch(() => {}), 10_000),
  ];
  timers.forEach((timer) => timer.unref?.());
  await heartbeat();

  const shutdown = async (signal) => {
    if (stopping) return; stopping = true;
    timers.forEach(clearInterval); clob.close(); pyth.close();
    await Promise.allSettled([flushPyth(), clob.flushEvents(), heartbeat()]);
    await pool.query(`UPDATE borg_eqopt_runtime SET status='STOPPED',stopped_at=now(),updated_at=now()
      WHERE run_id=$1`, [RUN_ID]).catch(() => {});
    await Promise.allSettled([optionWal.close(), pythWal.close(), clobWal.close(), decisionWal.close()]);
    await pool.end().catch(() => {});
    console.log(`[equity-options] stopped by ${signal}`); process.exit(0);
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) main().catch(async (error) => {
  console.error(error.stack || error.message); await pool.end().catch(() => {}); process.exit(1);
});

module.exports = {
  discoverContracts, evaluationBarrier, optionTouchRow, persistTargets,
};
