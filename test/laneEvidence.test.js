'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildLaneEvidenceSnapshot, sourceLanes } = require('../borg/research/lane-evidence');

function healthyInput() {
  const nowMs = Date.parse('2026-08-04T12:10:00Z');
  const beat = '2026-08-04T12:09:30Z';
  const component = (meta = {}) => ({ beat_at: beat, meta: { status: 'PASS', ...meta } });
  return {
    nowMs,
    epochId: 'v34',
    epochStart: new Date('2026-08-04T12:00:00Z'),
    components: {
      borg_scorer: component(), raw_archiver: component(), hot_partition_manager: component(),
      allmarket_lab: component({ selectedMarkets: 10 }), structural_scanner: component(),
      crossvenue_lab: component({ monitoredMatches: 5 }), options_surface: component(),
      pyth_boundary: component({
        experimentId: 'pyth-resolver-boundary-transfer-v4-frozen-observation-window',
        transportConnected: true, symbols: 3, marketsInWindow: 0,
      }),
    },
    eventHeartbeats: {
      heartbeat: { ts: beat, data: {} },
      flow_heartbeat: { ts: beat, data: {} },
    },
    flowHeartbeat: {
      collectionEpochId: 'v34', processStartedAt: '2026-08-04T12:00:01Z',
      globalDbQueue: '0', globalDbQueueOldestAgeMs: '0', selectedMarkets: '20',
    },
    primaryClob: { routingMode: 'redundant-explicit', expectedAssets: '8', coveredAssets: '8' },
    primaryRtds: { expectedAssets: '4', coveredAssets: '4' },
    errorEvents: [], staleHeartbeatSources: [], sequenceCounters: [], errorCounters: [],
    disk: { freeGiB: 60 }, minimumFreeGiB: 30,
    archive: { status: 'PASS', errors: [] }, offhostFailure: null,
    offhostReceiptValid: true, offhostAgeSec: 60, maxOffhostAgeSec: 10800,
    parquet: { healthy: true, critical: [] },
  };
}

test('a public-flow error invalidates flow without poisoning resolver evidence', () => {
  const input = healthyInput();
  input.errorEvents = [{ source: 'flow', n: '1' }];
  const lanes = buildLaneEvidenceSnapshot(input);
  assert.equal(lanes.public_flow.healthy, false);
  assert.equal(lanes.resolver_boundary.healthy, true);
  assert.equal(lanes.execution_replay.healthy, true);
  assert.deepEqual(sourceLanes('flow'), ['public_flow']);
});

test('primary CLOB and RTDS failures are scoped to their causal lanes', () => {
  const input = healthyInput();
  input.primaryClob.coveredAssets = '7';
  input.primaryRtds.coveredAssets = '3';
  const lanes = buildLaneEvidenceSnapshot(input);
  assert.equal(lanes.resolver_boundary.healthy, false);
  assert.equal(lanes.execution_replay.healthy, false);
  assert.equal(lanes.crossvenue.healthy, true);
  assert.equal(lanes.options.healthy, true);
});

test('storage failure is explicit and does not rewrite each lane current state', () => {
  const input = healthyInput();
  input.parquet = { healthy: false, critical: ['checksum failed'] };
  const lanes = buildLaneEvidenceSnapshot(input);
  assert.equal(lanes.storage.healthy, false);
  assert.equal(lanes.resolver_boundary.healthy, true);
  assert.match(lanes.storage.blockers.join(' | '), /checksum failed/);
});
