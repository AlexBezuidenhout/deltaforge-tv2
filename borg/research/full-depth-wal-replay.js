'use strict';

/**
 * Deterministic L4 execution replay over the append-before-process CLOB WAL.
 *
 * The replay consumes only frames received at or before hypothetical venue
 * arrival.  Each connection shard is reconstructed independently from a full
 * `book` frame plus subsequent `price_change` deltas.  Missing sequence,
 * connection-epoch changes, stale transports and disagreeing redundant paths
 * fail closed; they are never converted into fills or genuine non-fills.
 */

const { binaryPnl } = require('./execution-kernel');

const FULL_DEPTH_REPLAY_VERSION = 'borg-wal-full-depth-v2';
const DEFAULT_TRANSPORT_FRESH_MS = 10_000;
const A_GRADE_TRANSPORT_FRESH_MS = 2_000;
const EPSILON = 1e-9;

function finite(value, fallback = null) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function epochMs(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveToken(order = {}) {
  const token = String(order.token || '').toUpperCase();
  const positive = String(order.positive_label || '').toUpperCase();
  return token === 'UP' || token === 'YES' || Boolean(positive && token === positive);
}

function orderAssetId(order = {}) {
  return String((positiveToken(order) ? order.up_token_id : order.down_token_id) || '');
}

function normalizeLevels(levels, descending = false) {
  if (!Array.isArray(levels)) return [];
  const byPrice = new Map();
  for (const level of levels) {
    const price = finite(Array.isArray(level) ? level[0] : level?.price);
    const size = finite(Array.isArray(level) ? level[1] : level?.size);
    if (!(price > 0 && price < 1) || !(size > 0)) continue;
    byPrice.set(price, size);
  }
  return [...byPrice.entries()].sort((left, right) =>
    descending ? right[0] - left[0] : left[0] - right[0]);
}

function inferTickSize(state) {
  const explicit = finite(state?.tickSize);
  if (explicit > 0 && explicit < 1) return explicit;
  const prices = [...(state?.bids || []), ...(state?.asks || [])]
    .map((row) => finite(row[0]))
    .filter((value) => value > 0 && value < 1)
    .sort((a, b) => a - b);
  let smallest = Infinity;
  for (let index = 1; index < prices.length; index += 1) {
    const difference = +(prices[index] - prices[index - 1]).toFixed(6);
    if (difference > EPSILON) smallest = Math.min(smallest, difference);
  }
  // Sparse books can only establish an upper bound on one tick. Using the
  // smallest displayed spacing is pessimistic and therefore suitable for the
  // stress arm; no spacing means the stress result remains unavailable.
  return Number.isFinite(smallest) && smallest <= 0.1 ? smallest : null;
}

function walkDepth(order, state, options = {}) {
  const side = String(order.side || 'BUY').toUpperCase();
  const limit = finite(order.price);
  const requested = finite(order.size);
  const tickSize = finite(options.tickSize, 0);
  if (!(limit > 0 && limit < 1) || !(requested > 0)) {
    return { valid: false, reason: 'INVALID_ORDER', filled: false, fillSize: 0 };
  }
  const source = side === 'SELL' ? state.bids : state.asks;
  let fillSize = 0;
  let notional = 0;
  let availableSize = 0;
  let levelsConsumed = 0;
  for (const [rawPrice, rawSize] of source || []) {
    const bookPrice = finite(rawPrice);
    const size = finite(rawSize);
    if (!(bookPrice > 0 && bookPrice < 1) || !(size > 0)) continue;
    const price = side === 'SELL'
      ? Math.max(0.001, bookPrice - tickSize)
      : Math.min(0.999, bookPrice + tickSize);
    const executable = side === 'SELL'
      ? price + EPSILON >= limit
      : price <= limit + EPSILON;
    if (!executable) break;
    availableSize += size;
    if (fillSize + EPSILON >= requested) continue;
    const take = Math.min(size, requested - fillSize);
    if (!(take > 0)) continue;
    fillSize += take;
    notional += take * price;
    levelsConsumed += 1;
  }
  return {
    valid: true,
    filled: fillSize > EPSILON,
    full: fillSize + EPSILON >= requested,
    partial: fillSize > EPSILON && fillSize + EPSILON < requested,
    fillPrice: fillSize > EPSILON ? notional / fillSize : null,
    fillSize,
    fillNotional: notional,
    requestedSize: requested,
    availableSize,
    levelsConsumed,
    limitPrice: limit,
    tickStress: tickSize,
  };
}

/**
 * Apply an adverse execution-price stress to the quantity that actually
 * filled. Re-walking the original limit after shifting the book can reduce
 * the filled quantity and make a losing trade look better. That is a useful
 * quote-survival counterfactual, but it is not a conservative P&L stress.
 */
function adverseFillStress(order, exact, tickSize) {
  const tick = finite(tickSize);
  const exactPrice = finite(exact?.fillPrice);
  const exactSize = finite(exact?.fillSize);
  if (!exact?.filled || !(tick > 0) || !(exactPrice > 0 && exactPrice < 1)
      || !(exactSize > 0)) return null;
  const side = String(order.side || 'BUY').toUpperCase();
  const fillPrice = side === 'SELL'
    ? Math.max(0.001, exactPrice - tick)
    : Math.min(0.999, exactPrice + tick);
  return {
    ...exact,
    filled: true,
    fillPrice,
    fillSize: exactSize,
    fillNotional: fillPrice * exactSize,
    tickStress: tick,
    stressBasis: 'fixed_executed_quantity',
    originalFillPrice: exactPrice,
  };
}

function fillsAgree(left, right) {
  if (left.filled !== right.filled || left.full !== right.full
      || left.partial !== right.partial) return false;
  if (!left.filled) return true;
  return Math.abs(left.fillSize - right.fillSize) <= EPSILON
    && Math.abs(left.fillPrice - right.fillPrice) <= EPSILON;
}

function shardKey(shard, assetId) {
  return `${shard}:${assetId}`;
}

class FullDepthWalReconstructor {
  constructor(options = {}) {
    this.maxTransportSilenceMs = Math.max(1,
      finite(options.maxTransportSilenceMs, DEFAULT_TRANSPORT_FRESH_MS));
    this.books = new Map();
    this.transport = new Map();
    this.connectionEpochs = new Map();
    this.lastCollectorRunId = null;
    this.lastSequence = null;
    this.sequenceGaps = 0;
    this.lastGap = null;
    this.frames = 0;
    this.parseErrors = 0;
  }

  clearAll(reason, detail = {}) {
    this.books.clear();
    this.transport.clear();
    this.connectionEpochs.clear();
    if (reason) this.lastGap = { reason, ...detail };
  }

  clearShard(shard) {
    for (const key of this.books.keys()) {
      if (key.startsWith(`${shard}:`)) this.books.delete(key);
    }
    this.transport.delete(shard);
  }

  beginSelectionWindow() {
    // A bounded replay intentionally omits the hours between target windows.
    // Reset without recording a source-data gap: the next window must rebuild
    // from a fresh full book, while genuine sequence gaps inside a selected
    // window continue to fail closed and increment `sequenceGaps`.
    this.clearAll();
    this.lastCollectorRunId = null;
    this.lastSequence = null;
  }

  applyEnvelope(envelope) {
    if (!envelope || typeof envelope !== 'object' || envelope._borg_wal) return false;
    const receivedAt = finite(envelope.receive_wall_timestamp_ms);
    const sequence = Number.parseInt(envelope.event_sequence, 10);
    const collectorRunId = String(envelope.collector_run_id || 'unknown');
    const shard = Number.isInteger(envelope.connection_shard)
      ? envelope.connection_shard : Number.parseInt(envelope.connection_shard, 10) || 0;
    const connectionEpoch = Number.parseInt(envelope.connection_epoch, 10) || 0;
    if (!Number.isFinite(receivedAt)) return false;

    if (this.lastCollectorRunId && collectorRunId !== this.lastCollectorRunId) {
      this.clearAll('COLLECTOR_RUN_CHANGED', {
        previous: this.lastCollectorRunId, next: collectorRunId,
      });
      this.lastSequence = null;
    }
    this.lastCollectorRunId = collectorRunId;
    if (Number.isSafeInteger(sequence) && this.lastSequence != null
        && sequence !== this.lastSequence + 1) {
      this.sequenceGaps += 1;
      this.clearAll('RAW_WAL_SEQUENCE_GAP', {
        expected: this.lastSequence + 1, observed: sequence, at: receivedAt,
      });
    }
    if (Number.isSafeInteger(sequence)) this.lastSequence = sequence;

    const previousEpoch = this.connectionEpochs.get(shard);
    if (previousEpoch != null && previousEpoch !== connectionEpoch) {
      this.clearShard(shard);
    }
    this.connectionEpochs.set(shard, connectionEpoch);
    this.transport.set(shard, {
      receivedAt, connectionEpoch, eventId: envelope.event_id || null,
      receiveMonotonicNs: envelope.receive_monotonic_ns == null
        ? null : String(envelope.receive_monotonic_ns),
    });
    this.frames += 1;

    const raw = String(envelope.raw ?? '');
    if (!raw || raw === 'PONG' || raw === 'PING') return true;
    let decoded;
    try {
      decoded = JSON.parse(raw);
    } catch (_) {
      this.parseErrors += 1;
      return false;
    }
    for (const event of Array.isArray(decoded) ? decoded : [decoded]) {
      this.applyMarketEvent(event, {
        receivedAt, shard, connectionEpoch, collectorRunId,
        eventId: envelope.event_id || null,
        eventSequence: Number.isSafeInteger(sequence) ? sequence : null,
        receiveMonotonicNs: envelope.receive_monotonic_ns == null
          ? null : String(envelope.receive_monotonic_ns),
      });
    }
    return true;
  }

  applyMarketEvent(event, provenance) {
    if (!event || typeof event !== 'object') return;
    const type = event.event_type || event.type;
    if (type === 'book') {
      const assetId = String(event.asset_id || '');
      if (!assetId) return;
      this.books.set(shardKey(provenance.shard, assetId), {
        assetId,
        bids: normalizeLevels(event.bids || event.buys, true),
        asks: normalizeLevels(event.asks || event.sells, false),
        tickSize: finite(event.tick_size ?? event.minimum_tick_size),
        sourceAt: epochMs(event.timestamp),
        lastEventAt: provenance.receivedAt,
        baseSnapshotAt: provenance.receivedAt,
        hash: event.hash || null,
        ...provenance,
      });
      return;
    }
    if (type === 'price_change') {
      const changes = Array.isArray(event.price_changes)
        ? event.price_changes : Array.isArray(event.changes) ? event.changes : [event];
      for (const change of changes) {
        const assetId = String(change.asset_id || event.asset_id || '');
        const state = this.books.get(shardKey(provenance.shard, assetId));
        if (!state || state.connectionEpoch !== provenance.connectionEpoch) continue;
        const price = finite(change.price);
        const size = finite(change.size);
        const side = /buy|bid/i.test(String(change.side || '')) ? 'bids'
          : /sell|ask/i.test(String(change.side || '')) ? 'asks' : null;
        if (!side || !(price > 0 && price < 1) || !(size >= 0)) continue;
        const levels = new Map(state[side]);
        if (size > 0) levels.set(price, size);
        else levels.delete(price);
        state[side] = [...levels.entries()].sort((left, right) =>
          side === 'bids' ? right[0] - left[0] : left[0] - right[0]);
        state.lastEventAt = provenance.receivedAt;
        state.sourceAt = epochMs(event.timestamp ?? change.timestamp) ?? state.sourceAt;
        state.hash = event.hash ?? change.hash ?? state.hash;
        state.eventId = provenance.eventId;
        state.eventSequence = provenance.eventSequence;
        state.receiveMonotonicNs = provenance.receiveMonotonicNs;
      }
      return;
    }
    if (type === 'tick_size_change') {
      const assetId = String(event.asset_id || '');
      const state = this.books.get(shardKey(provenance.shard, assetId));
      const tickSize = finite(event.new_tick_size ?? event.tick_size);
      if (state && tickSize > 0 && tickSize < 1) {
        state.tickSize = tickSize;
        state.lastEventAt = provenance.receivedAt;
      }
    }
  }

  replay(order, arrival) {
    const arrivalMs = epochMs(arrival);
    const assetId = orderAssetId(order);
    if (!Number.isFinite(arrivalMs) || !assetId) {
      return this.unscoreable('UNSCOREABLE_ORDER_IDENTITY', arrivalMs, assetId);
    }
    const paths = [];
    const rejectedPaths = [];
    for (const [shard, transport] of this.transport.entries()) {
      const state = this.books.get(shardKey(shard, assetId));
      const transportAgeMs = arrivalMs - transport.receivedAt;
      if (!state) {
        rejectedPaths.push({ shard, reason: 'NO_FULL_BOOK_BASE', transportAgeMs });
        continue;
      }
      if (state.connectionEpoch !== transport.connectionEpoch) {
        rejectedPaths.push({ shard, reason: 'CONNECTION_EPOCH_MISMATCH', transportAgeMs });
        continue;
      }
      if (!(transportAgeMs >= 0 && transportAgeMs <= this.maxTransportSilenceMs)) {
        rejectedPaths.push({ shard, reason: 'TRANSPORT_STALE', transportAgeMs });
        continue;
      }
      const tickSize = inferTickSize(state);
      const explicitTickSize = finite(state.tickSize);
      const exact = walkDepth(order, state);
      const stressed = tickSize == null ? null : adverseFillStress(order, exact, tickSize);
      paths.push({
        shard, exact, stressed, tickSize,
        tickSizeBasis: explicitTickSize > 0
          ? 'venue_event' : tickSize == null ? 'unavailable' : 'displayed_minimum_spacing_upper_bound',
        transportAgeMs,
        stateAgeMs: arrivalMs - state.lastEventAt,
        baseSnapshotAt: new Date(state.baseSnapshotAt).toISOString(),
        stateAt: new Date(state.lastEventAt).toISOString(),
        sourceAt: state.sourceAt == null ? null : new Date(state.sourceAt).toISOString(),
        eventId: state.eventId || null,
        eventSequence: state.eventSequence ?? null,
        connectionEpoch: state.connectionEpoch,
        bookHash: state.hash || null,
      });
    }
    if (!paths.length) {
      return this.unscoreable('UNSCOREABLE_FULL_DEPTH_BOOK', arrivalMs, assetId, {
        rejected_paths: rejectedPaths,
      });
    }
    const reference = paths[0];
    if (paths.some((path) => !fillsAgree(reference.exact, path.exact)
        || (reference.stressed && path.stressed
          && !fillsAgree(reference.stressed, path.stressed))
        || Boolean(reference.stressed) !== Boolean(path.stressed))) {
      return this.unscoreable('INVALID_REDUNDANT_PATH_DIVERGENCE', arrivalMs, assetId, {
        paths, rejected_paths: rejectedPaths,
      });
    }
    const maximumTransportAgeMs = Math.max(...paths.map((path) => path.transportAgeMs));
    const dataQualityGrade = paths.length >= 2
      && maximumTransportAgeMs <= A_GRADE_TRANSPORT_FRESH_MS ? 'A' : 'B';
    const executionFidelityGrade = dataQualityGrade;
    const exact = reference.exact;
    const result = {
      replayVersion: FULL_DEPTH_REPLAY_VERSION,
      arrivalMs,
      filled: exact.filled,
      fillTs: exact.filled ? new Date(arrivalMs) : null,
      fillPrice: exact.fillPrice,
      fillSize: exact.fillSize,
      executionState: exact.filled ? 'ELIGIBLE_FILL' : 'PROVEN_NONFILL',
      dataQualityGrade,
      executionFidelityGrade,
      fidelityLevel: 'L4',
      stateTs: paths.map((path) => path.stateAt).sort().at(-1) || null,
      stateSource: 'raw_wal_full_depth',
      detail: {
        replay_version: FULL_DEPTH_REPLAY_VERSION,
        immutable_raw_wal: true,
        causal_receive_clock: true,
        full_depth: true,
        asset_id: assetId,
        partial: exact.partial,
        full: exact.full,
        requested_size: exact.requestedSize,
        capacity_at_arrival: exact.availableSize,
        levels_consumed: exact.levelsConsumed,
        path_count: paths.length,
        maximum_transport_age_ms: maximumTransportAgeMs,
        paths,
        rejected_paths: rejectedPaths,
        one_tick_stress: reference.stressed,
        tick_size: reference.tickSize,
        tick_size_basis: reference.tickSizeBasis,
        tick_stress_available: Boolean(reference.stressed),
      },
    };
    return result;
  }

  unscoreable(reason, arrivalMs, assetId, detail = {}) {
    return {
      replayVersion: FULL_DEPTH_REPLAY_VERSION,
      arrivalMs,
      filled: false,
      fillTs: null,
      fillPrice: null,
      fillSize: 0,
      executionState: reason,
      dataQualityGrade: 'F',
      executionFidelityGrade: 'F',
      fidelityLevel: 'L4',
      stateTs: null,
      stateSource: 'raw_wal_full_depth',
      detail: {
        replay_version: FULL_DEPTH_REPLAY_VERSION,
        immutable_raw_wal: true,
        causal_receive_clock: true,
        asset_id: assetId || null,
        sequence_gaps_seen: this.sequenceGaps,
        last_gap: this.lastGap,
        ...detail,
      },
    };
  }
}

function attachPnl(order, replay) {
  if (!replay.filled) {
    return { ...replay, gross: 0, pnl1x: 0, pnl2x: 0, pnl2xOneTick: 0 };
  }
  const token = String(order.token || '').toUpperCase();
  const outcome = String(order.outcome || '').toUpperCase();
  const one = binaryPnl({
    side: order.side, token, outcome,
    fillPrice: replay.fillPrice, fillSize: replay.fillSize,
    orderKind: order.order_kind, feeMultiplier: 1,
  });
  const two = binaryPnl({
    side: order.side, token, outcome,
    fillPrice: replay.fillPrice, fillSize: replay.fillSize,
    orderKind: order.order_kind, feeMultiplier: 2,
  });
  const stressed = replay.detail?.one_tick_stress;
  const stressedPnl = stressed?.filled ? binaryPnl({
    side: order.side, token, outcome,
    fillPrice: stressed.fillPrice, fillSize: stressed.fillSize,
    orderKind: order.order_kind, feeMultiplier: 2,
  }).net : 0;
  if (stressed?.filled) {
    if (Math.abs(finite(stressed.fillSize, 0) - finite(replay.fillSize, 0)) > EPSILON) {
      throw new Error('One-tick stress changed the executed quantity');
    }
    if (stressedPnl > two.net + EPSILON) {
      throw new Error('One-tick stress improved doubled-cost P&L');
    }
  }
  return {
    ...replay,
    gross: one.gross,
    pnl1x: one.net,
    pnl2x: two.net,
    pnl2xOneTick: stressedPnl,
  };
}

function summarizeFullDepthReplays(rows, profiles = [100, 250, 500]) {
  return profiles.map((latencyMs) => {
    const selected = rows.filter((row) => row.latencyMs === latencyMs);
    const eligible = selected.filter((row) => row.executionState === 'ELIGIBLE_FILL');
    const scored = selected.filter((row) => ['ELIGIBLE_FILL', 'PROVEN_NONFILL']
      .includes(row.executionState));
    const full = eligible.filter((row) => row.detail?.full === true);
    const partial = eligible.filter((row) => row.detail?.partial === true);
    const tickStressed = eligible.filter((row) => row.detail?.tick_stress_available === true);
    return {
      latencyMs,
      intents: selected.length,
      independentMarkets: new Set(selected.map((row) => row.marketId).filter(Boolean)).size,
      scoreable: scored.length,
      coveragePct: selected.length ? 100 * scored.length / selected.length : 0,
      fullFills: full.length,
      partialFills: partial.length,
      provenNonfills: scored.filter((row) => row.executionState === 'PROVEN_NONFILL').length,
      unscoreable: selected.length - scored.length,
      pathDivergence: selected.filter((row) =>
        row.executionState === 'INVALID_REDUNDANT_PATH_DIVERGENCE').length,
      aGrade: selected.filter((row) => row.dataQualityGrade === 'A').length,
      bGrade: selected.filter((row) => row.dataQualityGrade === 'B').length,
      tickStressCovered: tickStressed.length,
      filledNotionalUsd: eligible.reduce((sum, row) =>
        sum + finite(row.fillPrice, 0) * finite(row.fillSize, 0), 0),
      pnl1x: eligible.reduce((sum, row) => sum + finite(row.pnl1x, 0), 0),
      pnl2x: eligible.reduce((sum, row) => sum + finite(row.pnl2x, 0), 0),
      pnl2xOneTick: tickStressed.reduce((sum, row) =>
        sum + finite(row.pnl2xOneTick, 0), 0),
      wins: eligible.filter((row) => finite(row.gross, 0) > 0).length,
      losses: eligible.filter((row) => finite(row.gross, 0) < 0).length,
      rejectionReasons: Object.fromEntries([...selected.reduce((map, row) => {
        if (['ELIGIBLE_FILL', 'PROVEN_NONFILL'].includes(row.executionState)) return map;
        map.set(row.executionState, (map.get(row.executionState) || 0) + 1);
        return map;
      }, new Map()).entries()].sort()),
    };
  });
}

module.exports = {
  A_GRADE_TRANSPORT_FRESH_MS,
  adverseFillStress,
  DEFAULT_TRANSPORT_FRESH_MS,
  FULL_DEPTH_REPLAY_VERSION,
  FullDepthWalReconstructor,
  attachPnl,
  epochMs,
  fillsAgree,
  finite,
  inferTickSize,
  normalizeLevels,
  orderAssetId,
  positiveToken,
  summarizeFullDepthReplays,
  walkDepth,
};
