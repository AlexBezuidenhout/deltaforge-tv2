#!/usr/bin/env node
'use strict';

/**
 * Public, paper-only Pyth resolver-boundary observer.
 *
 * There is deliberately no wallet, signer, private API, authenticated user
 * channel, or order method in this process. It records what a fixed $10 taker
 * probe could have bought at several simulated information/order latencies,
 * then scores executable bid markouts and eventual terminal payouts.
 */

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const ClobMultiplex = require('../recon/clob-multiplex');
const RawWal = require('../recon/wal');
const { insertRows, logEvent, migratePyth, pool } = require('../recon/db');
const { HermesPythStream, extractExactPythFeedSymbol } = require('./hermes');
const { PythRtds, isSupportedMarketSymbol } = require('./rtds');
const {
  checkpointCrossings, executableMarkout, finite, inResolverObservationWindow,
  resolverSide, sizePaperEntry,
} = require('./strategy');
const { discoverPythUniverse, fetchJson, parseArray } = require('./universe');

const EXPERIMENT_ID = 'pyth-resolver-boundary-transfer-v4-frozen-observation-window';
const CHECKPOINTS = Object.freeze([300, 120, 60, 30, 10]);
const OBSERVATION_WINDOW_SEC = Math.max(...CHECKPOINTS);
const LATENCY_PROFILES_MS = Object.freeze([100, 250, 500]);
const MARKOUT_HORIZONS_SEC = Object.freeze([1, 5, 30]);
const REFRESH_MS = Math.max(60_000, Number(process.env.PYTH_UNIVERSE_REFRESH_MS || 300_000));
// Full-rate ticks are immutable in the WAL. PostgreSQL is deliberately a
// compact dashboard tier; exact signal rows retain their triggering clocks.
const TICK_DB_SAMPLE_MS = Math.max(100, Number(process.env.PYTH_TICK_DB_SAMPLE_MS || 1000));
const BOOK_MAX_AGE_MS = Math.max(50, Number(process.env.PYTH_BOOK_MAX_AGE_MS || 500));
const SOURCE_MAX_AGE_MS = Math.max(250, Number(process.env.PYTH_SOURCE_MAX_AGE_MS || 2000));
const TARGET_BUDGET_USD = Math.max(1, Number(process.env.PYTH_TARGET_BUDGET_USD || 10));
const SETTLEMENT_COST_USD = Math.max(0, Number(process.env.PYTH_SETTLEMENT_COST_USD || 0.10));
const MAX_MARKETS = Math.max(1, Number(process.env.PYTH_MAX_MARKETS || 24));

function hashId(...values) {
  return crypto.createHash('sha256').update(values.map((value) => String(value ?? '')).join('|')).digest('hex');
}

function timestamp(value) {
  const ms = Number(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function displayedShares(levels) {
  if (!Array.isArray(levels)) return 0;
  return levels.reduce((sum, level) => sum + Math.max(0, finite(Array.isArray(level) ? level[1] : level?.size, 0)), 0);
}

function terminalOutcome(raw) {
  const outcomes = parseArray(raw?.outcomes);
  const prices = parseArray(raw?.outcomePrices).map((value) => finite(value));
  if (outcomes.length !== 2 || prices.length !== 2) return null;
  const index = prices.findIndex((value) => value != null && value >= 0.99);
  if (index < 0) return null;
  const outcome = String(outcomes[index]).toUpperCase();
  return outcome === 'UP' || outcome === 'DOWN' ? outcome : null;
}

class PythBoundaryObserver {
  constructor() {
    this.runId = `pyth_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;
    this.startedAt = new Date();
    const walOptions = {
      root: process.env.BORG_WAL_DIR,
      mirrorRoot: process.env.BORG_WAL_MIRROR_DIR || null,
      minFreeGb: Number(process.env.BORG_WAL_MIN_FREE_GB || 20),
      collectorRunId: this.runId,
    };
    this.pythWal = new RawWal('pyth-equity-rtds', walOptions);
    this.hermesWal = new RawWal('pyth-hermes-sse', walOptions);
    this.clobWal = new RawWal('pyth-polymarket-clob', walOptions);
    this.decisionWal = new RawWal('pyth-boundary-decisions', walOptions);
    this.markets = new Map();
    this.targetByToken = new Map();
    this.state = new Map();
    this.tickBuffer = new Map();
    this.signalBuffer = new Map();
    this.arrivalBuffer = new Map();
    this.markoutBuffer = new Map();
    this.terminalBuffer = new Map();
    this.pendingTimers = new Set();
    this.closed = false;
    this.lastTickAt = 0;
    this.lastUsableTickAt = 0;
    this.lastSignalAt = 0;
    this.deferredFeedSymbols = [];
    this.metrics = {
      ticks: 0, liveTicks: 0, historicalTicks: 0, carriedForward: 0,
      diagnosticRtdsTicks: 0,
      signals: 0, arrivals: 0, executableArrivals: 0, markouts: 0,
      scoredMarkouts: 0, terminalScores: 0, refreshErrors: 0,
    };
    this.clob = new ClobMultiplex((token) => this.targetByToken.get(String(token))?.conditionId || null, {
      shardCount: Number(process.env.PYTH_CLOB_SHARDS || 2),
      wal: this.clobWal,
      persistDerivedEvents: false,
    });
    this.rtds = new PythRtds({
      wal: this.pythWal,
      onTick: (tick) => this.onTick({ ...tick, transportSource: 'polymarket-rtds' }, false),
      onStatus: (status, detail) => logEvent('INFO', 'pyth', `RTDS ${status}`, detail),
    });
    this.hermes = new HermesPythStream({
      wal: this.hermesWal,
      onTick: (tick) => this.onTick(tick, true),
      onStatus: (status, detail) => logEvent(
        status === 'OPEN' ? 'INFO' : 'WARN', 'pyth', `Hermes ${status}`, detail,
      ),
    });
  }

  schedule(fn, delayMs) {
    const timer = setTimeout(async () => {
      this.pendingTimers.delete(timer);
      if (this.closed) return;
      try { await fn(); } catch (error) { await logEvent('ERROR', 'pyth', error.message); }
    }, Math.max(0, delayMs));
    this.pendingTimers.add(timer);
    return timer;
  }

  async persistUniverse(rows) {
    for (const row of rows) {
      await pool.query(`
        INSERT INTO borg_pyth_rule_snapshots (
          rule_hash,experiment_id,event_id,gamma_id,condition_id,rule_document)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (rule_hash) DO NOTHING
      `, [row.ruleHash, EXPERIMENT_ID, row.eventId, row.gammaId, row.conditionId,
        JSON.stringify(row.ruleDocument)]);
      await pool.query(`
        INSERT INTO borg_pyth_markets (
          condition_id,experiment_id,event_id,gamma_id,slug,question,symbol,price_to_beat,
          window_start,window_end,up_token_id,down_token_id,minimum_order_size,
          fees_enabled,fee_rate,fee_exponent,rule_hash,rule_certified,active,
          accepting_orders,raw,refreshed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,true,true,true,$18::jsonb,now())
        ON CONFLICT (condition_id) DO UPDATE SET
          experiment_id=EXCLUDED.experiment_id,event_id=EXCLUDED.event_id,
          gamma_id=EXCLUDED.gamma_id,slug=EXCLUDED.slug,question=EXCLUDED.question,
          symbol=EXCLUDED.symbol,price_to_beat=EXCLUDED.price_to_beat,
          window_start=EXCLUDED.window_start,window_end=EXCLUDED.window_end,
          up_token_id=EXCLUDED.up_token_id,down_token_id=EXCLUDED.down_token_id,
          minimum_order_size=EXCLUDED.minimum_order_size,fees_enabled=EXCLUDED.fees_enabled,
          fee_rate=EXCLUDED.fee_rate,fee_exponent=EXCLUDED.fee_exponent,
          rule_hash=EXCLUDED.rule_hash,rule_certified=true,active=true,
          accepting_orders=true,raw=EXCLUDED.raw,refreshed_at=now()
      `, [
        row.conditionId, EXPERIMENT_ID, row.eventId, row.gammaId, row.slug, row.question,
        row.symbol, row.boundary, new Date(row.startMs), new Date(row.endMs), row.upToken,
        row.downToken, row.minimumOrderSize, row.fees.enabled, row.fees.rate,
        row.fees.exponent, row.ruleHash, JSON.stringify(row.raw),
      ]);
    }
    const ids = rows.map((row) => row.conditionId);
    await pool.query(`UPDATE borg_pyth_markets SET active=false,accepting_orders=false,refreshed_at=now()
       WHERE experiment_id=$1 AND NOT (condition_id=ANY($2::text[])) AND terminal_outcome IS NULL`,
    [EXPERIMENT_ID, ids]);
  }

  async refreshTerminalOutcomes() {
    for (const market of this.markets.values()) {
      // Wait through every registered markout horizon plus persistence slack so
      // the final arrival cannot be omitted merely because refresh hit at T=0.
      if (market.endMs + 60_000 > Date.now() || market.terminalOutcome) continue;
      let raw;
      try { raw = await fetchJson(`https://gamma-api.polymarket.com/markets/${encodeURIComponent(market.gammaId)}`); }
      catch (_) { continue; }
      const outcome = terminalOutcome(raw);
      if (!outcome) continue;
      market.terminalOutcome = outcome;
      await pool.query(`UPDATE borg_pyth_markets SET terminal_outcome=$2,
        terminal_observed_at=now(),active=false,accepting_orders=false,raw=raw||$3::jsonb
        WHERE condition_id=$1`, [market.conditionId, outcome, JSON.stringify({ terminal: raw })]);
      await this.scoreTerminal(market, outcome);
    }
  }

  async loadPersistedMarkets() {
    const { rows } = await pool.query(`
      SELECT condition_id,event_id,gamma_id,slug,question,symbol,price_to_beat,
             window_start,window_end,up_token_id,down_token_id,minimum_order_size,
             fees_enabled,fee_rate,fee_exponent,rule_hash,rule_certified,active,
             terminal_outcome,raw
        FROM borg_pyth_markets WHERE experiment_id=$1 AND terminal_outcome IS NULL
    `, [EXPERIMENT_ID]);
    for (const row of rows) {
      this.markets.set(row.condition_id, {
        conditionId: row.condition_id, eventId: row.event_id, gammaId: row.gamma_id,
        slug: row.slug, question: row.question, symbol: row.symbol,
        pythFeedSymbol: row.raw?.pythFeedSymbol || extractExactPythFeedSymbol([
          row.raw?.event?.resolutionSource,
          row.raw?.event?.description,
          row.raw?.event?.markets?.[0]?.resolutionSource,
          row.raw?.event?.markets?.[0]?.description,
        ].filter(Boolean).join('\n')),
        boundary: finite(row.price_to_beat), startMs: new Date(row.window_start).getTime(),
        endMs: new Date(row.window_end).getTime(), upToken: row.up_token_id,
        downToken: row.down_token_id, minimumOrderSize: finite(row.minimum_order_size),
        fees: { enabled: row.fees_enabled, rate: finite(row.fee_rate),
          exponent: finite(row.fee_exponent), known: true },
        ruleHash: row.rule_hash, certified: row.rule_certified === true,
        active: row.active === true, terminalOutcome: row.terminal_outcome,
        raw: row.raw,
      });
    }
  }

  async refreshUniverse() {
    await this.refreshTerminalOutcomes();
    const certifiedUniverse = (await discoverPythUniverse())
      .sort((left, right) => left.endMs - right.endMs
        || left.conditionId.localeCompare(right.conditionId));
    const discovered = certifiedUniverse.slice(0, MAX_MARKETS);
    await this.persistUniverse(discovered);
    for (const market of discovered) this.markets.set(market.conditionId, market);
    const now = Date.now();
    for (const [id, market] of this.markets) {
      market.active = discovered.some((row) => row.conditionId === id) && market.endMs > now;
    }
    const active = [...this.markets.values()].filter((market) => market.active);
    const allFeedActive = active.filter((market) => market.pythFeedSymbol);
    // The RTDS socket has an observed 15-subscription ceiling. Put markets in
    // their resolver window first, then the nearest upcoming windows; PythRtds
    // applies the hard bound before opening a clean subscription.
    const prioritizedFeeds = [...allFeedActive].sort((left, right) => {
      const leftOpen = left.startMs <= now && left.endMs > now ? 0 : 1;
      const rightOpen = right.startMs <= now && right.endMs > now ? 0 : 1;
      return leftOpen - rightOpen
        || Math.abs(left.startMs - now) - Math.abs(right.startMs - now)
        || left.endMs - right.endMs
        || left.symbol.localeCompare(right.symbol);
    });
    // Resolve the complete currently certified rule universe, not merely the
    // bounded CLOB panel. The panel rotates as markets expire; a stable feed
    // superset prevents that expected metadata rotation from interrupting an
    // in-window resolver tape.
    const selectedFeeds = [...new Map(certifiedUniverse.map((market) => [market.pythFeedSymbol, {
      symbol: market.symbol, feedSymbol: market.pythFeedSymbol,
    }])).values()];
    const hermesSelection = await this.hermes.setFeeds(selectedFeeds);
    const enrolledFeedSymbols = new Set(
      [...this.hermes.feedById.values()].map((row) => row.feedSymbol),
    );
    this.deferredFeedSymbols = [...new Set(hermesSelection.deferred || [])].sort();
    const feedActive = allFeedActive
      .filter((market) => enrolledFeedSymbols.has(market.pythFeedSymbol));
    this.targetByToken = new Map(feedActive.flatMap((market) => [
      [market.upToken, market], [market.downToken, market],
    ]));
    this.rtds.setSymbols([...new Set(prioritizedFeeds
      .filter((market) => isSupportedMarketSymbol(market.symbol))
      .map((market) => market.symbol))]);
    this.clob.subscribe([...this.targetByToken.keys()]);
    await logEvent('INFO', 'pyth', `certified universe: ${active.length} CLOB markets, ${hermesSelection.resolved} exact Hermes feeds`, {
      runId: this.runId, experimentId: EXPERIMENT_ID,
      certifiedRuleMarkets: certifiedUniverse.length,
      unresolvedExactFeeds: hermesSelection.unresolved,
      deferredExactFeeds: this.deferredFeedSymbols,
      feedCohortFrozenAt: hermesSelection.frozenAt,
      diagnosticRtdsSymbols: this.rtds.symbols.size,
    });
  }

  onTick(tick, triggerEligible = true) {
    const tickId = `${tick.walEventId || this.runId}:${tick.symbol}:${tick.sourceMs || tick.receiveWallMs}`;
    const bucket = tick.historical ? tick.sourceMs || tick.receiveWallMs
      : Math.floor(tick.receiveWallMs / TICK_DB_SAMPLE_MS) * TICK_DB_SAMPLE_MS;
    const source = tick.transportSource || 'unknown';
    this.tickBuffer.set(`${source}:${tick.symbol}:${bucket}:${tick.historical}`, { ...tick, tickId });
    if (!triggerEligible) {
      this.metrics.diagnosticRtdsTicks += 1;
      return;
    }
    this.metrics.ticks += 1;
    if (tick.historical) { this.metrics.historicalTicks += 1; return; }
    this.metrics.liveTicks += 1;
    this.lastTickAt = tick.receiveWallMs;
    if (tick.carriedForward) { this.metrics.carriedForward += 1; return; }
    const sourceAgeMs = tick.sourceMs == null ? Infinity
      : Math.max(0, tick.receiveWallMs - tick.sourceMs);
    if (!Number.isFinite(sourceAgeMs) || sourceAgeMs > SOURCE_MAX_AGE_MS) {
      this.hermes.metrics.staleSourceTicks += 1;
      return;
    }
    this.lastUsableTickAt = tick.receiveWallMs;
    for (const market of this.markets.values()) {
      if (!market.active || market.symbol !== tick.symbol) continue;
      if (tick.receiveWallMs < market.startMs || tick.receiveWallMs > market.endMs) continue;
      this.evaluateTick(market, tick);
    }
  }

  evaluateTick(market, tick) {
    const tteSec = Math.max(0, (market.endMs - tick.receiveWallMs) / 1000);
    const side = resolverSide(tick.value, market.boundary);
    const current = this.state.get(market.conditionId) || {
      previousTteSec: null, priorSide: null, firedCheckpoints: new Set(),
    };
    const triggers = [];
    const inObservationWindow = inResolverObservationWindow(
      market, tick.receiveWallMs, OBSERVATION_WINDOW_SEC,
    );
    if (inObservationWindow
        && (current.priorSide === 'UP' || current.priorSide === 'DOWN')
        && (side === 'UP' || side === 'DOWN') && side !== current.priorSide) {
      triggers.push({ kind: 'SIGN_FLIP', checkpointSec: null });
    }
    for (const checkpointSec of inObservationWindow
      ? checkpointCrossings(current.previousTteSec, tteSec, CHECKPOINTS) : []) {
      if (!current.firedCheckpoints.has(checkpointSec)) {
        current.firedCheckpoints.add(checkpointSec);
        triggers.push({ kind: 'TTE_CHECKPOINT', checkpointSec });
      }
    }
    for (const trigger of triggers) this.createSignal(market, tick, side, current.priorSide, tteSec, trigger);
    current.previousTteSec = tteSec;
    if (side === 'UP' || side === 'DOWN') current.priorSide = side;
    this.state.set(market.conditionId, current);
  }

  createSignal(market, tick, side, priorSide, tteSec, trigger) {
    const sourceAgeMs = tick.sourceMs == null ? null : Math.max(0, tick.receiveWallMs - tick.sourceMs);
    const valid = (side === 'UP' || side === 'DOWN') && market.certified
      && !tick.historical && !tick.carriedForward && sourceAgeMs != null
      && sourceAgeMs <= SOURCE_MAX_AGE_MS;
    const signalId = hashId(EXPERIMENT_ID, market.conditionId, trigger.kind,
      trigger.checkpointSec, tick.walEventId, tick.eventSequence, side);
    if (this.signalBuffer.has(signalId)) return;
    const invalidReason = valid ? null : side === 'TIE' ? 'RESOLVER_PRICE_EQUALS_BOUNDARY'
      : tick.historical ? 'HISTORICAL_SNAPSHOT' : tick.carriedForward ? 'CARRIED_FORWARD'
        : !market.certified ? 'RULE_NOT_CERTIFIED' : sourceAgeMs == null ? 'MISSING_SOURCE_CLOCK'
          : sourceAgeMs > SOURCE_MAX_AGE_MS ? 'STALE_PYTH_SOURCE_TICK' : 'INVALID_SIGNAL';
    const signal = {
      signalId, experimentId: EXPERIMENT_ID, conditionId: market.conditionId,
      observedAt: tick.receiveWallMs, triggerKind: trigger.kind,
      checkpointSec: trigger.checkpointSec, side, resolverPrice: tick.value,
      priceToBeat: market.boundary, distanceBps: 10_000 * (tick.value / market.boundary - 1),
      tteSec, priorSide, sourceMs: tick.sourceMs,
      providerReceivedMs: tick.providerReceivedMs, receiveMonoNs: tick.receiveMonoNs,
      connectionEpoch: tick.connectionEpoch, eventSequence: tick.eventSequence,
      walEventId: tick.walEventId, carriedForward: !!tick.carriedForward,
      historical: !!tick.historical, valid, invalidReason, ruleHash: market.ruleHash,
      detail: { sourceAgeMs, providerToLocalMs: tick.providerReceivedMs == null ? null
        : tick.receiveWallMs - tick.providerReceivedMs,
        policy: 'MARKET_PRIOR_RESIDUAL_CALIBRATION_PROBE',
        fairLowerBound: null, promotionEligible: false,
        ineligibleReason: 'NO_FROZEN_OUT_OF_SAMPLE_FAIR_LOWER_BOUND' },
    };
    this.decisionWal.append(JSON.stringify({ type: 'pyth_signal', ...signal }), {
      channel: 'paper-signal', receiveWallMs: tick.receiveWallMs,
    });
    this.signalBuffer.set(signalId, signal);
    this.metrics.signals += 1;
    this.lastSignalAt = tick.receiveWallMs;
    if (!valid) return;
    for (const latencyMs of LATENCY_PROFILES_MS) {
      this.schedule(() => this.evaluateArrival(signal, market, latencyMs), latencyMs);
    }
  }

  evaluateArrival(signal, market, latencyMs) {
    const now = Date.now();
    const intended = signal.observedAt + latencyMs;
    const token = signal.side === 'UP' ? market.upToken : market.downToken;
    const book = this.clob.getBook(token);
    const bookAgeMs = book?.at == null ? null : Math.max(0, now - book.at);
    let result = { executable: false, reason: 'BOOK_UNAVAILABLE' };
    if (book && bookAgeMs <= BOOK_MAX_AGE_MS && signal.detail.sourceAgeMs <= SOURCE_MAX_AGE_MS) {
      result = sizePaperEntry({
        asks: book.asks, budgetUsd: TARGET_BUDGET_USD,
        minimumOrderSize: finite(book.minOrderSize) ?? market.minimumOrderSize,
        feeRate: market.fees.rate, feeExponent: market.fees.exponent,
      });
    } else if (book && bookAgeMs > BOOK_MAX_AGE_MS) result.reason = 'STALE_CLOB_BOOK';
    else if (signal.detail.sourceAgeMs > SOURCE_MAX_AGE_MS) result.reason = 'STALE_PYTH_SOURCE_TICK';
    const arrivalId = hashId(signal.signalId, latencyMs);
    const quality = result.executable ? 'A' : 'F';
    const row = {
      arrivalId, signalId: signal.signalId, experimentId: EXPERIMENT_ID, latencyMs,
      intendedArrivalAt: intended, observedAt: now, tokenId: token, side: signal.side,
      bookReceivedAt: book?.at || null, bookAgeMs, executable: !!result.executable,
      reason: result.reason, shares: result.shares ?? null, entryVwap: result.vwap ?? null,
      entryGross: result.gross ?? null, entryFee: result.fee ?? null,
      entryTotal: result.total ?? null, displayedAskShares: displayedShares(book?.asks),
      dataQualityGrade: quality, executionFidelityGrade: result.executable ? 'B' : 'F',
      detail: {
        intendedDelayMs: latencyMs, actualDelayMs: now - signal.observedAt,
        schedulingSlippageMs: now - intended, fills: result.fills || [],
        budgetUsd: TARGET_BUDGET_USD, atomic: false, orderSubmitted: false,
        marketPrior: book ? {
          bestBid: finite(book.bids?.[0]?.[0]),
          bestAsk: finite(book.asks?.[0]?.[0]),
          midpoint: finite(book.bids?.[0]?.[0]) != null && finite(book.asks?.[0]?.[0]) != null
            ? (finite(book.bids[0][0]) + finite(book.asks[0][0])) / 2 : null,
        } : null,
        fairLowerBound: null,
        promotionEligible: false,
        ineligibleReason: 'NO_FROZEN_OUT_OF_SAMPLE_FAIR_LOWER_BOUND',
      },
    };
    this.decisionWal.append(JSON.stringify({ type: 'pyth_arrival', ...row }), {
      channel: 'paper-arrival', receiveWallMs: now,
    });
    this.arrivalBuffer.set(arrivalId, row);
    this.metrics.arrivals += 1;
    if (!row.executable) return;
    this.metrics.executableArrivals += 1;
    for (const horizonSec of MARKOUT_HORIZONS_SEC) {
      this.schedule(() => this.evaluateMarkout(row, market, horizonSec), horizonSec * 1000);
    }
  }

  evaluateMarkout(arrival, market, horizonSec) {
    const now = Date.now();
    const book = this.clob.getBook(arrival.tokenId);
    const bookAgeMs = book?.at == null ? null : Math.max(0, now - book.at);
    let result = { scored: false, reason: 'BOOK_UNAVAILABLE' };
    if (book && bookAgeMs <= BOOK_MAX_AGE_MS) {
      result = executableMarkout({
        bids: book.bids, shares: arrival.shares, entryTotal: arrival.entryTotal,
        feeRate: market.fees.rate, feeExponent: market.fees.exponent,
      });
    } else if (book && bookAgeMs > BOOK_MAX_AGE_MS) result.reason = 'STALE_CLOB_BOOK';
    const markoutId = hashId(arrival.arrivalId, horizonSec);
    const row = {
      markoutId, arrivalId: arrival.arrivalId, experimentId: EXPERIMENT_ID,
      horizonSec, dueAt: arrival.observedAt + horizonSec * 1000, observedAt: now,
      bookReceivedAt: book?.at || null, bookAgeMs, scored: !!result.scored,
      reason: result.reason, exitVwap: result.vwap ?? null,
      exitGross: result.grossProceeds ?? null, exitFee: result.exitFee ?? null,
      netProceeds: result.netProceeds ?? null, pnl: result.pnl ?? null,
      dataQualityGrade: result.scored ? 'A' : 'F',
      executionFidelityGrade: result.scored ? 'B' : 'F',
      detail: { schedulingSlippageMs: now - (arrival.observedAt + horizonSec * 1000),
        fills: result.fills || [], orderSubmitted: false },
    };
    this.decisionWal.append(JSON.stringify({ type: 'pyth_markout', ...row }), {
      channel: 'paper-markout', receiveWallMs: now,
    });
    this.markoutBuffer.set(markoutId, row);
    this.metrics.markouts += 1;
    if (row.scored) this.metrics.scoredMarkouts += 1;
  }

  async scoreTerminal(market, outcome) {
    const { rows } = await pool.query(`
      SELECT a.arrival_id,a.side,a.shares,a.entry_total
        FROM borg_pyth_arrivals a JOIN borg_pyth_signals s USING (signal_id)
       WHERE s.condition_id=$1 AND a.executable=true
         AND NOT EXISTS (SELECT 1 FROM borg_pyth_terminal_scores t WHERE t.arrival_id=a.arrival_id)
    `, [market.conditionId]);
    for (const entry of rows) {
      const shares = finite(entry.shares, 0);
      const won = entry.side === outcome;
      const gross = won ? shares : 0;
      const pnl = gross - finite(entry.entry_total, 0) - SETTLEMENT_COST_USD;
      const row = {
        scoreId: hashId(entry.arrival_id, outcome), arrivalId: entry.arrival_id,
        experimentId: EXPERIMENT_ID, conditionId: market.conditionId, scoredAt: Date.now(),
        terminalOutcome: outcome, won, grossPayout: gross, pnl,
        detail: { settlementCostUsd: SETTLEMENT_COST_USD, observationNotPortfolioTrade: true },
      };
      this.decisionWal.append(JSON.stringify({ type: 'pyth_terminal_score', ...row }), {
        channel: 'terminal-score', receiveWallMs: row.scoredAt,
      });
      this.terminalBuffer.set(row.scoreId, row);
      this.metrics.terminalScores += 1;
    }
  }

  async recoverPendingMarkouts() {
    const { rows } = await pool.query(`
      SELECT a.*,s.condition_id,m.fee_rate,m.fee_exponent FROM borg_pyth_arrivals a
      JOIN borg_pyth_signals s USING (signal_id)
      JOIN borg_pyth_markets m ON m.condition_id=s.condition_id
      WHERE a.experiment_id=$1 AND a.executable=true AND a.observed_at>now()-interval '40 seconds'
    `, [EXPERIMENT_ID]);
    for (const row of rows) {
      const market = this.markets.get(row.condition_id) || {
        fees: { rate: finite(row.fee_rate), exponent: finite(row.fee_exponent) },
      };
      const arrival = {
        arrivalId: row.arrival_id, tokenId: row.token_id, observedAt: new Date(row.observed_at).getTime(),
        shares: finite(row.shares), entryTotal: finite(row.entry_total),
      };
      for (const horizonSec of MARKOUT_HORIZONS_SEC) {
        const { rowCount } = await pool.query(`SELECT 1 FROM borg_pyth_markouts
          WHERE arrival_id=$1 AND horizon_sec=$2`, [arrival.arrivalId, horizonSec]);
        if (rowCount) continue;
        const due = arrival.observedAt + horizonSec * 1000;
        this.schedule(() => this.evaluateMarkout(arrival, market, horizonSec), Math.max(0, due - Date.now()));
      }
    }
  }

  async flush() {
    const ticks = [...this.tickBuffer.values()];
    const signals = [...this.signalBuffer.values()];
    const arrivals = [...this.arrivalBuffer.values()];
    const markouts = [...this.markoutBuffer.values()];
    const terminals = [...this.terminalBuffer.values()];
    this.tickBuffer.clear(); this.signalBuffer.clear(); this.arrivalBuffer.clear();
    this.markoutBuffer.clear(); this.terminalBuffer.clear();
    try {
      if (ticks.length) await insertRows('borg_pyth_ticks', [
        'experiment_id','symbol','source_ts','provider_received_at','received_at',
        'receive_monotonic_ns','value','carried_forward','historical','connection_epoch',
        'event_sequence','wal_event_id','raw',
      ], ticks.map((row) => [
        EXPERIMENT_ID,row.symbol,timestamp(row.sourceMs),timestamp(row.providerReceivedMs),
        new Date(row.receiveWallMs),row.receiveMonoNs,row.value,!!row.carriedForward,
        !!row.historical,row.connectionEpoch,row.eventSequence,row.tickId,JSON.stringify({
          transportSource: row.transportSource || null,
          feedSymbol: row.feedSymbol || null,
          feedId: row.feedId || null,
          confidence: row.confidence ?? null,
          payload: row.raw,
        }),
      ]), 'ON CONFLICT (wal_event_id) DO NOTHING');
      if (signals.length) await insertRows('borg_pyth_signals', [
        'signal_id','experiment_id','condition_id','observed_at','trigger_kind','checkpoint_sec',
        'side','resolver_price','price_to_beat','distance_bps','tte_sec','prior_side','source_ts',
        'provider_received_at','receive_monotonic_ns','connection_epoch','event_sequence',
        'wal_event_id','carried_forward','historical','valid','invalid_reason','rule_hash','detail',
      ], signals.map((row) => [
        row.signalId,row.experimentId,row.conditionId,new Date(row.observedAt),row.triggerKind,
        row.checkpointSec,row.side,row.resolverPrice,row.priceToBeat,row.distanceBps,row.tteSec,
        row.priorSide,timestamp(row.sourceMs),timestamp(row.providerReceivedMs),row.receiveMonoNs,
        row.connectionEpoch,row.eventSequence,row.walEventId,row.carriedForward,row.historical,
        row.valid,row.invalidReason,row.ruleHash,JSON.stringify(row.detail),
      ]), 'ON CONFLICT (signal_id) DO NOTHING');
      if (arrivals.length) await insertRows('borg_pyth_arrivals', [
        'arrival_id','signal_id','experiment_id','latency_ms','intended_arrival_at','observed_at',
        'token_id','side','book_received_at','book_age_ms','executable','reason','shares',
        'entry_vwap','entry_gross','entry_fee','entry_total','displayed_ask_shares',
        'data_quality_grade','execution_fidelity_grade','detail',
      ], arrivals.map((row) => [
        row.arrivalId,row.signalId,row.experimentId,row.latencyMs,new Date(row.intendedArrivalAt),
        new Date(row.observedAt),row.tokenId,row.side,timestamp(row.bookReceivedAt),row.bookAgeMs,
        row.executable,row.reason,row.shares,row.entryVwap,row.entryGross,row.entryFee,row.entryTotal,
        row.displayedAskShares,row.dataQualityGrade,row.executionFidelityGrade,JSON.stringify(row.detail),
      ]), 'ON CONFLICT (arrival_id) DO NOTHING');
      if (markouts.length) await insertRows('borg_pyth_markouts', [
        'markout_id','arrival_id','experiment_id','horizon_sec','due_at','observed_at',
        'book_received_at','book_age_ms','scored','reason','exit_vwap','exit_gross','exit_fee',
        'net_proceeds','pnl','data_quality_grade','execution_fidelity_grade','detail',
      ], markouts.map((row) => [
        row.markoutId,row.arrivalId,row.experimentId,row.horizonSec,new Date(row.dueAt),
        new Date(row.observedAt),timestamp(row.bookReceivedAt),row.bookAgeMs,row.scored,row.reason,
        row.exitVwap,row.exitGross,row.exitFee,row.netProceeds,row.pnl,row.dataQualityGrade,
        row.executionFidelityGrade,JSON.stringify(row.detail),
      ]), 'ON CONFLICT (markout_id) DO NOTHING');
      if (terminals.length) await insertRows('borg_pyth_terminal_scores', [
        'score_id','arrival_id','experiment_id','condition_id','scored_at','terminal_outcome',
        'won','gross_payout','pnl','detail',
      ], terminals.map((row) => [
        row.scoreId,row.arrivalId,row.experimentId,row.conditionId,new Date(row.scoredAt),
        row.terminalOutcome,row.won,row.grossPayout,row.pnl,JSON.stringify(row.detail),
      ]), 'ON CONFLICT (score_id) DO NOTHING');
    } catch (error) {
      ticks.forEach((row) => this.tickBuffer.set(`${row.symbol}:${row.tickId}`, row));
      signals.forEach((row) => this.signalBuffer.set(row.signalId, row));
      arrivals.forEach((row) => this.arrivalBuffer.set(row.arrivalId, row));
      markouts.forEach((row) => this.markoutBuffer.set(row.markoutId, row));
      terminals.forEach((row) => this.terminalBuffer.set(row.scoreId, row));
      throw error;
    }
  }

  async heartbeat() {
    const active = [...this.markets.values()].filter((market) => market.active);
    const enrolledFeedSymbols = new Set(
      [...this.hermes.feedById.values()].map((row) => row.feedSymbol),
    );
    const supported = active.filter((market) =>
      market.pythFeedSymbol && enrolledFeedSymbols.has(market.pythFeedSymbol));
    const unsupportedSymbols = [...new Set(active
      .filter((market) => !market.pythFeedSymbol).map((market) => market.symbol))];
    const now = Date.now();
    const inWindow = supported.filter((market) =>
      inResolverObservationWindow(market, now, OBSERVATION_WINDOW_SEC));
    const deferredInWindow = active.filter((market) =>
      market.pythFeedSymbol && !enrolledFeedSymbols.has(market.pythFeedSymbol)
      && inResolverObservationWindow(market, now, OBSERVATION_WINDOW_SEC));
    const inWindowSymbols = [...new Set(inWindow.map((market) => market.symbol))];
    const freshWindowSymbols = inWindowSymbols.filter((symbol) => {
      const tick = this.hermes.latest.get(symbol);
      const maxAgeMs = Math.max(10_000, SOURCE_MAX_AGE_MS * 5);
      return tick && now - tick.receiveWallMs <= maxAgeMs
        && tick.sourceMs != null && now - tick.sourceMs <= maxAgeMs;
    });
    const lastExpectedTickAt = inWindow.reduce((latest, market) => {
      const tick = this.hermes.latest.get(market.symbol);
      return !tick?.carriedForward ? Math.max(latest, tick?.receiveWallMs || 0) : latest;
    }, 0);
    const nextWindowStartAt = supported.reduce((next, market) => {
      const observationStart = market.endMs - OBSERVATION_WINDOW_SEC * 1000;
      return observationStart > now ? Math.min(next, observationStart) : next;
    }, Infinity);
    const transport = this.hermes.health(now);
    const diagnosticRtds = this.rtds.health();
    const feedState = !transport.connected ? 'DISCONNECTED'
      : !inWindow.length ? 'AWAITING_WINDOW'
        : freshWindowSymbols.length === inWindowSymbols.length
          ? 'LIVE' : 'CONNECTED_NO_RECENT_TICK';
    const metrics = {
      ...this.metrics, checkpointsSec: CHECKPOINTS, latencyProfilesMs: LATENCY_PROFILES_MS,
      markoutHorizonsSec: MARKOUT_HORIZONS_SEC, targetBudgetUsd: TARGET_BUDGET_USD,
      settlementCostUsd: SETTLEMENT_COST_USD, bookMaxAgeMs: BOOK_MAX_AGE_MS,
      sourceMaxAgeMs: SOURCE_MAX_AGE_MS, hermes: transport, diagnosticRtds,
      feedState, supportedMarkets: supported.length, marketsInWindow: inWindow.length,
      activeContractMarkets: active.length, observationWindowSec: OBSERVATION_WINDOW_SEC,
      deferredWindowMarkets: deferredInWindow.length,
      expectedWindowFeeds: inWindowSymbols.length, coveredWindowFeeds: freshWindowSymbols.length,
      unsupportedSymbols, deferredFeedSymbols: this.deferredFeedSymbols,
      lastExpectedTickAt: lastExpectedTickAt || null,
      nextWindowStartAt: Number.isFinite(nextWindowStartAt) ? nextWindowStartAt : null,
      pythWal: this.pythWal.health(), hermesWal: this.hermesWal.health(), clobWal: this.clobWal.health(),
      decisionWal: this.decisionWal.health(),
    };
    const queue = this.tickBuffer.size + this.signalBuffer.size + this.arrivalBuffer.size
      + this.markoutBuffer.size + this.terminalBuffer.size;
    await pool.query(`
      INSERT INTO borg_pyth_runtime (
        run_id,experiment_id,started_at,host,pid,paper_only,wallet_loaded,live_order_path,
        status,markets,symbols,subscribed_tokens,raw_frames,ticks,signals,arrivals,markouts,
        terminal_scores,persistence_queue,last_tick_at,last_signal_at,metrics)
      VALUES ($1,$2,$3,$4,$5,true,false,false,'RUNNING',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)
      ON CONFLICT (run_id) DO UPDATE SET status='RUNNING',markets=EXCLUDED.markets,
        symbols=EXCLUDED.symbols,subscribed_tokens=EXCLUDED.subscribed_tokens,
        raw_frames=EXCLUDED.raw_frames,ticks=EXCLUDED.ticks,signals=EXCLUDED.signals,
        arrivals=EXCLUDED.arrivals,markouts=EXCLUDED.markouts,
        terminal_scores=EXCLUDED.terminal_scores,persistence_queue=EXCLUDED.persistence_queue,
        last_tick_at=EXCLUDED.last_tick_at,last_signal_at=EXCLUDED.last_signal_at,
        metrics=EXCLUDED.metrics,updated_at=now()
    `, [this.runId,EXPERIMENT_ID,this.startedAt,os.hostname(),process.pid,active.length,
      this.hermes.feedById.size,this.targetByToken.size,this.hermes.metrics.rawEvents,
      this.metrics.ticks,this.metrics.signals,this.metrics.arrivals,this.metrics.markouts,
      this.metrics.terminalScores,queue,timestamp(this.lastTickAt),timestamp(this.lastSignalAt),
      JSON.stringify(metrics)]);
    await pool.query(`INSERT INTO system_heartbeats (component,beat_at,meta)
      VALUES ('pyth_boundary',now(),$1::jsonb)
      ON CONFLICT (component) DO UPDATE SET beat_at=now(),meta=EXCLUDED.meta`, [JSON.stringify({
      runId: this.runId, experimentId: EXPERIMENT_ID, paperOnly: true,
      collectionEpochId: process.env.BORG_COLLECTION_EPOCH_ID || 'pyth-unmarked',
      processStartedAt: this.startedAt.toISOString(),
      walletLoaded: false, liveOrderPath: false, markets: active.length,
      symbols: this.hermes.feedById.size, polyTokens: this.targetByToken.size,
      lastTickAt: this.lastTickAt || null, lastUsableTickAt: this.lastUsableTickAt || null,
      signals: this.metrics.signals, refreshErrors: this.metrics.refreshErrors,
      feedState, marketsInWindow: inWindow.length,
      activeContractMarkets: active.length, observationWindowSec: OBSERVATION_WINDOW_SEC,
      deferredWindowMarkets: deferredInWindow.length,
      expectedWindowFeeds: inWindowSymbols.length, coveredWindowFeeds: freshWindowSymbols.length,
      nextWindowStartAt: Number.isFinite(nextWindowStartAt) ? nextWindowStartAt : null,
      unsupportedSymbols, deferredFeedSymbols: this.deferredFeedSymbols,
      transportConnected: transport.connected,
      hermes: transport, diagnosticRtds,
      wal: {
        pythRtds: this.pythWal.health(), pythHermes: this.hermesWal.health(),
        polymarket: this.clobWal.health(),
        decisions: this.decisionWal.health(),
      },
    })]);
  }

  async start() {
    await migratePyth();
    await this.loadPersistedMarkets();
    await this.refreshUniverse();
    const [, , hermesConnected] = await Promise.all([
      this.clob.connect(), this.rtds.connect(), this.hermes.connect(),
    ]);
    if (!hermesConnected) throw new Error('exact-feed Pyth Hermes stream did not connect');
    await this.recoverPendingMarkouts();
    await this.heartbeat();
    this.timers = [
      setInterval(() => this.flush().catch((error) => logEvent('ERROR', 'pyth', `flush: ${error.message}`)), 1000),
      setInterval(() => this.refreshUniverse().catch((error) => {
        this.metrics.refreshErrors += 1;
        return logEvent('ERROR', 'pyth', `refresh: ${error.message}`);
      }), REFRESH_MS),
      setInterval(() => this.heartbeat().catch((error) => logEvent('ERROR', 'pyth', `heartbeat: ${error.message}`)), 10_000),
      setInterval(() => {
        this.clob.checkStale();
        this.rtds.checkStale();
        const now = Date.now();
        const expectedLive = [...this.markets.values()].some((market) =>
          market.active && market.pythFeedSymbol
          && inResolverObservationWindow(market, now, OBSERVATION_WINDOW_SEC));
        this.hermes.checkStale(expectedLive);
      }, 10_000),
    ];
    await logEvent('INFO', 'pyth', `paper resolver-boundary observer running as ${this.runId}`, {
      experimentId: EXPERIMENT_ID, ordersSubmitted: false,
    });
  }

  async stop(signal) {
    if (this.closed) return;
    this.closed = true;
    (this.timers || []).forEach(clearInterval);
    this.pendingTimers.forEach(clearTimeout);
    this.pendingTimers.clear();
    this.clob.close(); this.rtds.close(); this.hermes.close();
    await this.flush().catch(() => {});
    await pool.query(`UPDATE borg_pyth_runtime SET status='STOPPED',stopped_at=now(),updated_at=now()
      WHERE run_id=$1`, [this.runId]).catch(() => {});
    await Promise.all([
      this.pythWal.close(), this.hermesWal.close(), this.clobWal.close(), this.decisionWal.close(),
    ]).catch(() => {});
    await pool.end().catch(() => {});
    console.log(`[pyth] stopped by ${signal}`);
  }
}

async function main() {
  const observer = new PythBoundaryObserver();
  process.once('SIGTERM', () => observer.stop('SIGTERM').then(() => process.exit(0)));
  process.once('SIGINT', () => observer.stop('SIGINT').then(() => process.exit(0)));
  await observer.start();
}

if (require.main === module) main().catch(async (error) => {
  console.error(error.stack || error.message);
  await pool.end().catch(() => {});
  process.exit(1);
});

module.exports = {
  CHECKPOINTS, EXPERIMENT_ID, LATENCY_PROFILES_MS, MARKOUT_HORIZONS_SEC,
  OBSERVATION_WINDOW_SEC,
  PythBoundaryObserver, terminalOutcome,
};
