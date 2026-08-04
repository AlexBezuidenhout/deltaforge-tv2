'use strict';

/**
 * Lane-scoped evidence health. Global evidence remains fail-closed, but an
 * unrelated public-flow outage must not erase a clean resolver-boundary tape.
 * Each lane lists only its causal feed/process dependencies; storage is a
 * shared dependency applied later by the epoch assessor.
 */

const FAST_MAX_AGE_SEC = 120;
const SLOW_MAX_AGE_SEC = 15 * 60;

const LANE_DEFINITIONS = Object.freeze({
  resolver_boundary: {
    label: 'Resolver-boundary transfer',
    components: [['borg_scorer', SLOW_MAX_AGE_SEC]],
    eventSources: ['heartbeat'],
  },
  execution_replay: {
    label: 'WAL execution replay',
    components: [['borg_scorer', SLOW_MAX_AGE_SEC]],
    eventSources: ['heartbeat'],
  },
  public_flow: {
    label: 'Public-flow research',
    components: [],
    eventSources: ['flow_heartbeat'],
  },
  structural: {
    label: 'Certified payoff graph',
    components: [['allmarket_lab', FAST_MAX_AGE_SEC], ['structural_scanner', FAST_MAX_AGE_SEC]],
    eventSources: [],
  },
  crossvenue: {
    label: 'Rule-aware cross-venue',
    components: [['crossvenue_lab', FAST_MAX_AGE_SEC]],
    eventSources: [],
  },
  options: {
    label: 'Options-implied residual',
    components: [['options_surface', FAST_MAX_AGE_SEC]],
    eventSources: [],
  },
  pyth: {
    label: 'Pyth resolver-boundary',
    components: [['pyth_boundary', FAST_MAX_AGE_SEC]],
    eventSources: [],
  },
  storage: {
    label: 'Durable evidence storage',
    components: [
      ['raw_archiver', SLOW_MAX_AGE_SEC],
      ['hot_partition_manager', SLOW_MAX_AGE_SEC],
    ],
    eventSources: [],
  },
});

const COMPONENT_LANES = Object.freeze({
  allmarket_lab: ['structural'],
  crossvenue_lab: ['crossvenue'],
  options_surface: ['options'],
  pyth_boundary: ['pyth'],
  structural_scanner: ['structural'],
  raw_archiver: ['storage'],
  hot_partition_manager: ['storage'],
  borg_scorer: ['resolver_boundary', 'execution_replay'],
  heartbeat: ['resolver_boundary', 'execution_replay'],
  flow_heartbeat: ['public_flow'],
});

function finite(value, fallback = null) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function ageSeconds(value, nowMs) {
  const parsed = value == null ? NaN : new Date(value).getTime();
  return Number.isFinite(parsed) ? Math.max(0, (nowMs - parsed) / 1000) : null;
}

function atOrAfter(value, boundary) {
  const parsed = value == null ? NaN : new Date(value).getTime();
  const start = boundary == null ? NaN : new Date(boundary).getTime();
  return Number.isFinite(parsed) && Number.isFinite(start) && parsed >= start;
}

function sourceLanes(source) {
  const value = String(source || '').toLowerCase();
  if (/flow/.test(value)) return ['public_flow'];
  if (/cross.?venue|kalshi/.test(value)) return ['crossvenue'];
  if (/option|deribit/.test(value)) return ['options'];
  if (/pyth|hermes/.test(value)) return ['pyth'];
  if (/structural|allmarket|payoff/.test(value)) return ['structural'];
  if (/archive|parquet|partition|storage/.test(value)) return ['storage'];
  if (/heartbeat|shadow|recon|clob|rtds|binance|chainlink|scor/.test(value)) {
    return ['resolver_boundary', 'execution_replay'];
  }
  return [];
}

function blankLanes() {
  return Object.fromEntries(Object.entries(LANE_DEFINITIONS).map(([id, definition]) => [id, {
    id,
    label: definition.label,
    healthy: true,
    status: 'PASS',
    blockers: [],
    warnings: [],
    dependencies: {
      components: definition.components.map(([component]) => component),
      eventSources: [...definition.eventSources],
      sharedStorage: id !== 'storage',
    },
  }]));
}

function addBlocker(lanes, ids, message) {
  for (const id of ids) {
    if (!lanes[id] || lanes[id].blockers.includes(message)) continue;
    lanes[id].blockers.push(message);
  }
}

function addWarning(lanes, ids, message) {
  for (const id of ids) {
    if (!lanes[id] || lanes[id].warnings.includes(message)) continue;
    lanes[id].warnings.push(message);
  }
}

function systemComponentChecks(lanes, components, epochStart, nowMs) {
  for (const [laneId, definition] of Object.entries(LANE_DEFINITIONS)) {
    for (const [component, maxAgeSec] of definition.components) {
      const row = components[component];
      const age = ageSeconds(row?.beat_at, nowMs);
      if (!atOrAfter(row?.beat_at, epochStart)) {
        addBlocker(lanes, [laneId], `${component}: no heartbeat in this epoch`);
      } else if (age == null || age > maxAgeSec) {
        addBlocker(lanes, [laneId], `${component}: heartbeat ${age == null ? 'missing' : `${Math.round(age)}s old`}`);
      }
      if (/^(?:DEGRADED|ERROR|FAILED)$/i.test(String(row?.meta?.status || ''))) {
        addBlocker(lanes, [laneId], `${component}: reported ${row.meta.status}`);
      }
    }
  }
}

function eventHeartbeatChecks(lanes, eventHeartbeats, epochStart, nowMs) {
  for (const [laneId, definition] of Object.entries(LANE_DEFINITIONS)) {
    for (const source of definition.eventSources) {
      const row = eventHeartbeats[source];
      const age = ageSeconds(row?.ts, nowMs);
      if (!atOrAfter(row?.ts, epochStart)) {
        addBlocker(lanes, [laneId], `${source}: no heartbeat in this epoch`);
      } else if (age == null || age > FAST_MAX_AGE_SEC) {
        addBlocker(lanes, [laneId], `${source}: heartbeat ${age == null ? 'missing' : `${Math.round(age)}s old`}`);
      }
    }
  }
}

function checkCoverage(lanes, input) {
  const primaryClob = input.primaryClob;
  if (primaryClob?.routingMode === 'redundant-explicit') {
    const expected = finite(primaryClob.expectedAssets);
    const covered = finite(primaryClob.coveredAssets);
    if (!(expected > 0) || covered == null || covered < expected) {
      addBlocker(lanes, ['resolver_boundary', 'execution_replay'],
        `primary CLOB coverage ${covered ?? 'missing'}/${expected ?? 'missing'}`);
    }
  } else {
    const expected = finite(primaryClob?.expectedSockets);
    const active = finite(primaryClob?.activeSockets);
    if (!(expected > 0) || active == null || active < expected) {
      addBlocker(lanes, ['resolver_boundary', 'execution_replay'],
        `primary CLOB sockets ${active ?? 'missing'}/${expected ?? 'missing'}`);
    }
  }
  const expectedRtds = finite(input.primaryRtds?.expectedAssets);
  const coveredRtds = finite(input.primaryRtds?.coveredAssets);
  if (!(expectedRtds > 0) || coveredRtds == null || coveredRtds < expectedRtds) {
    addBlocker(lanes, ['resolver_boundary'],
      `primary RTDS coverage ${coveredRtds ?? 'missing'}/${expectedRtds ?? 'missing'}`);
  }

  const flow = input.flowHeartbeat || {};
  if (flow.collectionEpochId !== input.epochId) {
    addBlocker(lanes, ['public_flow'], 'public-flow heartbeat belongs to another epoch');
  }
  const flowStartedAt = flow.processStartedAt || flow.startedAt;
  const flowUptime = ageSeconds(flowStartedAt, input.nowMs);
  if (!atOrAfter(flowStartedAt, input.epochStart) || flowUptime == null || flowUptime < 60) {
    addBlocker(lanes, ['public_flow'], 'public-flow process is warming, stale or restarting');
  }
  const queue = finite(flow.globalDbQueue);
  const queueAge = finite(flow.globalDbQueueOldestAgeMs);
  if (queue == null || queueAge == null || queue > 5000 || queueAge > 120_000) {
    addBlocker(lanes, ['public_flow'],
      `public-flow SQL queue ${queue ?? 'missing'} rows / ${queueAge ?? 'missing'}ms oldest`);
  }
  if (!(finite(flow.selectedMarkets, 0) > 0)) {
    addBlocker(lanes, ['public_flow'], 'public-flow has no selected markets');
  }

  const allmarket = input.components.allmarket_lab?.meta || {};
  if (!(finite(allmarket.selectedMarkets, 0) > 0)) {
    addBlocker(lanes, ['structural'], 'all-market collector has no selected markets');
  }
  const crossvenue = input.components.crossvenue_lab?.meta || {};
  if (!(finite(crossvenue.monitoredMatches, 0) > 0)) {
    addBlocker(lanes, ['crossvenue'], 'cross-venue collector has no monitored matches');
  }

  const pyth = input.components.pyth_boundary?.meta || {};
  if (pyth.experimentId !== 'pyth-resolver-boundary-transfer-v4-frozen-observation-window') {
    addBlocker(lanes, ['pyth'], 'Pyth collector is not on the frozen exact-feed arm');
  }
  if (pyth.transportConnected !== true || !(finite(pyth.symbols, 0) > 0)) {
    addBlocker(lanes, ['pyth'], 'Pyth Hermes transport/feed set unavailable');
  }
  if (finite(pyth.marketsInWindow, 0) > 0) {
    const expected = finite(pyth.expectedWindowFeeds);
    const covered = finite(pyth.coveredWindowFeeds);
    if (pyth.feedState !== 'LIVE' || !(expected > 0) || covered == null || covered < expected) {
      addBlocker(lanes, ['pyth'],
        `Pyth in-window coverage ${covered ?? 'missing'}/${expected ?? 'missing'} (${pyth.feedState || 'UNKNOWN'})`);
    }
  } else {
    addWarning(lanes, ['pyth'], 'No certified market is currently inside the final 300-second window');
  }
}

function applyOwnedFailures(lanes, input) {
  for (const row of input.errorEvents || []) {
    const count = finite(row.n, 0);
    if (!(count > 0)) continue;
    addBlocker(lanes, sourceLanes(row.source), `${row.source}: ${count} error event(s)`);
  }
  for (const row of input.staleHeartbeatSources || []) {
    const count = finite(row.n, 0);
    if (!(count > 0)) continue;
    const ids = COMPONENT_LANES[row.source] || sourceLanes(row.source);
    addBlocker(lanes, ids, `${row.source}: ${count} transient stale heartbeat(s)`);
  }
  for (const row of [...(input.sequenceCounters || []), ...(input.errorCounters || [])]) {
    const ids = COMPONENT_LANES[row.owner] || sourceLanes(row.owner);
    addBlocker(lanes, ids, `${row.owner}.${row.path}=${row.value}`);
  }
}

function applyStorageHealth(lanes, input) {
  const minimumFreeGiB = finite(input.minimumFreeGiB, 30);
  const freeGiB = finite(input.disk?.freeGiB);
  if (freeGiB == null || freeGiB < minimumFreeGiB) {
    addBlocker(lanes, ['storage'],
      `capture disk ${freeGiB == null ? 'unknown' : `${freeGiB.toFixed(2)} GiB free`}`);
  }
  if (!input.archive) addBlocker(lanes, ['storage'], 'verified raw-archive state missing');
  else if (Array.isArray(input.archive.errors) && input.archive.errors.length) {
    addBlocker(lanes, ['storage'], `raw archiver has ${input.archive.errors.length} error(s)`);
  }
  if (input.offhostFailure) addBlocker(lanes, ['storage'], input.offhostFailure);
  if (input.offhostReceiptValid !== true) {
    addBlocker(lanes, ['storage'], 'off-host immutable receipt missing or invalid');
  } else if (input.offhostAgeSec == null || input.offhostAgeSec > input.maxOffhostAgeSec) {
    addBlocker(lanes, ['storage'], 'off-host immutable receipt is stale');
  }
  if (input.parquet?.healthy !== true) {
    addBlocker(lanes, ['storage'], input.parquet?.critical?.[0]
      || 'verified Parquet recurrence is unhealthy');
  }
  const backlogAgeSec = finite(input.offhostReport?.rawBacklog?.oldestPendingAgeSec, 0);
  const backlogFiles = finite(input.offhostReport?.rawBacklog?.pendingFiles, 0);
  if (backlogFiles > 0 && backlogAgeSec > 6 * 3600) {
    addWarning(lanes, ['storage'],
      `${backlogFiles} raw archive file(s) pending; oldest ${Math.round(backlogAgeSec)}s`);
  }
}

function buildLaneEvidenceSnapshot(input) {
  const lanes = blankLanes();
  systemComponentChecks(lanes, input.components || {}, input.epochStart, input.nowMs);
  eventHeartbeatChecks(lanes, input.eventHeartbeats || {}, input.epochStart, input.nowMs);
  checkCoverage(lanes, input);
  applyOwnedFailures(lanes, input);
  applyStorageHealth(lanes, input);
  for (const lane of Object.values(lanes)) {
    lane.healthy = lane.blockers.length === 0;
    lane.status = lane.healthy ? 'PASS' : 'FAIL';
  }
  return lanes;
}

module.exports = {
  COMPONENT_LANES,
  LANE_DEFINITIONS,
  addBlocker,
  ageSeconds,
  buildLaneEvidenceSnapshot,
  sourceLanes,
};
