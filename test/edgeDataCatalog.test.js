'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  aggregateOffhostState,
  aggregateParquetLakeState,
  catalogWarnings,
  causalReplayGrade,
  classifyTable,
  fieldCoverage,
  quoteIdentifier,
} = require('../borg/research/edge-data-catalog');

test('table classifier keeps exact-rule and structural evidence distinct', () => {
  assert.equal(classifyTable('cv_contract_matches').family, 'crossvenue_prediction');
  assert.equal(classifyTable('borg_structural_evaluations').family, 'structural_payoff');
  assert.equal(classifyTable('borg_option_shadow_marks').family, 'options_surface');
  assert.equal(classifyTable('borg_shadow_orders').family, 'strategy_evidence');
  assert.equal(classifyTable('borg_clob_touch_p20260803').family, 'polymarket_clob');
  assert.equal(classifyTable('borg_clob_touch_p20260803').partitionOf, 'borg_clob_touch');
  assert.equal(classifyTable('users').family, 'application_or_uncatalogued');
});

test('causal replay grade requires the complete clock/provenance contract', () => {
  const columns = [
    'source_timestamp', 'received_at', 'receive_monotonic_ns', 'sequence_id',
    'connection_epoch', 'collection_epoch_id', 'bids', 'asks', 'fee_rate',
  ].map((column_name) => ({ column_name, null_frac: 0 }));
  const table = {
    tier: 'normalized_raw',
    fieldCoverage: fieldCoverage(columns),
  };
  assert.deepEqual(causalReplayGrade(table), {
    dataGrade: 'A',
    executionGrade: 'A',
    replayProfiles: ['20ms', '50ms', '100ms', '250ms', '500ms', '1s', '2s'],
    caveat: 'Public executable state only; authenticated order lifecycle is a separate grade.',
  });
});

test('off-host aggregation accepts only verified objects with SHA-256 metadata', () => {
  const state = {
    format: 'deltaforge-google-drive-state-v1',
    updatedAt: '2026-08-03T12:00:00Z',
    objects: {
      good: {
        namespace: 'wal', relative: 'binance/2026-08-03/a.ndjson.gz',
        size: 100, mtimeMs: Date.parse('2026-08-03T11:00:00Z'),
        sha256: 'a'.repeat(64), verified: true,
      },
      bad: {
        namespace: 'wal', relative: 'binance/2026-08-03/b.ndjson.gz',
        size: 50, mtimeMs: Date.parse('2026-08-03T11:01:00Z'),
        sha256: '', verified: true,
      },
    },
  };
  const summary = aggregateOffhostState(state);
  assert.equal(summary.files, 2);
  assert.equal(summary.bytes, 150);
  assert.equal(summary.verified, 1);
  assert.equal(summary.invalidChecksums, 1);
  assert.equal(summary.destination, 'Google Drive/VPS Data');
});

test('Parquet lake aggregation counts only verified ZSTD batch outputs as valid', () => {
  const summary = aggregateParquetLakeState({
    format: 'deltaforge-parquet-lake-state-v1',
    updatedAt: '2026-08-03T14:00:00Z',
    sources: { one: {}, two: {} },
    batches: {
      good: {
        verified: true,
        outputs: [{
          relative: 'event-envelope-v1/source=binance/date=2026-08-03/hour=14/part-a.parquet',
          source: 'binance', date: '2026-08-03', rows: 100, bytes: 200,
          sha256: 'a'.repeat(64), compression: 'ZSTD', verified: true,
        }],
      },
      bad: {
        verified: true,
        outputs: [{
          relative: 'event-envelope-v1/source=binance/date=2026-08-04/hour=14/part-b.parquet',
          source: 'binance', date: '2026-08-04', rows: 50, bytes: 100,
          sha256: '', compression: 'GZIP', verified: true,
        }],
      },
    },
  });
  assert.equal(summary.sourceFiles, 2);
  assert.equal(summary.files, 2);
  assert.equal(summary.rows, 150);
  assert.equal(summary.invalidOutputs, 1);
  assert.equal(summary.groups[0].firstDate, '2026-08-03');
  assert.equal(summary.groups[0].lastDate, '2026-08-04');
});

test('PostgreSQL identifier quoting rejects injected identifiers', () => {
  assert.equal(quoteIdentifier('borg_book_snaps'), '"borg_book_snaps"');
  assert.throws(() => quoteIdentifier('borg_book_snaps; DROP TABLE users'));
});

test('catalog warning routes analytics away from hot ingestion once Parquet exists', () => {
  const warnings = catalogWarnings({
    database: { bytes: 64 * 1024 ** 3 },
    storage: {
      parquetLake: { files: 10, invalidOutputs: 0 },
      offhost: { invalidChecksums: 0 },
      disk: { freeBytes: 40 * 1024 ** 3 },
    },
  });
  assert.match(warnings[0], /verified Parquet lake/);
  assert.doesNotMatch(warnings[0], /until Parquet/);
});
