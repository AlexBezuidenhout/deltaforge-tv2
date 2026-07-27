'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  MIGRATION_CONFIRM, SPECS, partitionName, verifyMigrationAuthority,
  retainedColumnDefinition, retainedCopySql, retentionAuthorityState,
  verifyRetentionAuthority,
} = require('../scripts/hot-tier-partitions');

test('high-rate tables partition by UTC day and retain conflict uniqueness with the time key', () => {
  const optionMarks = SPECS.find((spec) => spec.table === 'borg_option_shadow_marks');
  const cross = SPECS.find((spec) => spec.table === 'cv_opportunities');
  assert.equal(
    partitionName(optionMarks, Date.UTC(2026, 6, 23)),
    'borg_option_shadow_marks_p20260723',
  );
  assert.match(optionMarks.parentUnique[0][1], /dedup_key,observed_at/);
  assert.match(cross.parentUnique[0][1], /opportunity_id,observed_at/);
  assert.equal(cross.retain.predicate, 'economic');
  assert.equal(
    SPECS.find((spec) => spec.table === 'cv_basis_samples').retain.predicate,
    'entry_economic',
  );
  assert.equal(
    SPECS.find((spec) => spec.table === 'borg_structural_evaluations').retain.predicate,
    'qualified',
  );
  assert.equal(SPECS.find((spec) => spec.table === 'borg_clob_touch').keepDays, 0);
  assert.equal(optionMarks.keepDays, 1);
});

test('retained projections evolve additively and copy by explicit column name', () => {
  assert.equal(retainedColumnDefinition({
    column_name: 'exact_rule_eligible',
    data_type: 'boolean',
    default_expression: 'false',
    not_null: true,
    identity_kind: '',
    generated_kind: '',
  }), '"exact_rule_eligible" boolean DEFAULT false NOT NULL');
  const cross = SPECS.find((spec) => spec.table === 'cv_opportunities');
  const sql = retainedCopySql(cross, 'cv_opportunities_p20260726', [
    'opportunity_id', 'observed_at', 'exact_rule_eligible',
  ]);
  assert.match(sql, /INSERT INTO "cv_opportunities_retained" \("opportunity_id","observed_at","exact_rule_eligible"\)/);
  assert.match(sql, /SELECT "opportunity_id","observed_at","exact_rule_eligible"/);
  assert.doesNotMatch(sql, /SELECT\s+\*/);
});

test('destructive migration requires a fresh off-host receipt matching the latest snapshot', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'df-partitions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const snapshot = path.join(root, 'latest.dump');
  const sha = 'a'.repeat(64);
  fs.writeFileSync(snapshot, 'verified-by-snapshot-service');
  fs.writeFileSync(`${snapshot}.sha256`, `${sha}  latest.dump\n`);
  const snapshotReceipt = path.join(root, 'snapshot.receipt');
  fs.writeFileSync(snapshotReceipt, [
    'format=deltaforge-offhost-receipt-v1',
    'scope=database-snapshots',
    `completed_at=${new Date().toISOString()}`,
    `latest_sha256=${sha}`,
    '',
  ].join('\n'));
  const previous = process.env.DELTAFORGE_PARTITION_MIGRATION_CONFIRM;
  process.env.DELTAFORGE_PARTITION_MIGRATION_CONFIRM = MIGRATION_CONFIRM;
  t.after(() => {
    if (previous == null) delete process.env.DELTAFORGE_PARTITION_MIGRATION_CONFIRM;
    else process.env.DELTAFORGE_PARTITION_MIGRATION_CONFIRM = previous;
  });
  const authority = verifyMigrationAuthority({
    snapshotReceipt, snapshotRoot: root,
  });
  assert.equal(authority.sha256, sha);
});

test('bounded migration snapshot also requires a covering raw-WAL receipt', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'df-bounded-partitions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const snapshot = path.join(root, 'deltaforge-bounded-2026-07-23T16-30-00Z.dump');
  const sha = 'b'.repeat(64);
  const requiredRawCutoff = Math.floor(Date.now() / 1000) - 600;
  fs.writeFileSync(snapshot, 'bounded-query-tier-snapshot');
  fs.writeFileSync(`${snapshot}.sha256`, `${sha}  ${path.basename(snapshot)}\n`);
  fs.writeFileSync(`${snapshot}.profile`, [
    'format=deltaforge-db-snapshot-profile-v1',
    'profile=replayable-hot-tier-excluded-v1',
    `required_raw_source_cutoff_epoch=${requiredRawCutoff}`,
    '',
  ].join('\n'));
  const snapshotReceipt = path.join(root, 'snapshot.receipt');
  fs.writeFileSync(snapshotReceipt, [
    'format=deltaforge-offhost-receipt-v1',
    'scope=database-snapshots',
    `completed_at=${new Date().toISOString()}`,
    `latest_sha256=${sha}`,
    '',
  ].join('\n'));
  const archiveReceipt = path.join(root, 'archive.receipt');
  fs.writeFileSync(archiveReceipt, [
    'format=deltaforge-offhost-receipt-v1',
    'scope=raw-wal-and-db-archive',
    `completed_at=${new Date().toISOString()}`,
    `source_cutoff_epoch=${requiredRawCutoff}`,
    'latest_file=wal/covered.ndjson.gz',
    '',
  ].join('\n'));
  const previous = process.env.DELTAFORGE_PARTITION_MIGRATION_CONFIRM;
  process.env.DELTAFORGE_PARTITION_MIGRATION_CONFIRM = MIGRATION_CONFIRM;
  t.after(() => {
    if (previous == null) delete process.env.DELTAFORGE_PARTITION_MIGRATION_CONFIRM;
    else process.env.DELTAFORGE_PARTITION_MIGRATION_CONFIRM = previous;
  });
  const authority = verifyMigrationAuthority({
    snapshotReceipt, snapshotRoot: root, archiveReceipt,
  });
  assert.equal(authority.profile.profile, 'replayable-hot-tier-excluded-v1');
  assert.equal(authority.rawAuthority.sourceCutoffEpoch, requiredRawCutoff);
});

test('partition retention fails closed without a real immutable archive object', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'df-retention-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archiveReceipt = path.join(root, 'archive.receipt');
  fs.writeFileSync(archiveReceipt, [
    'format=deltaforge-offhost-receipt-v1',
    'scope=raw-wal-and-db-archive',
    `completed_at=${new Date().toISOString()}`,
    `source_cutoff_epoch=${Math.floor(Date.now() / 1000) - 300}`,
    'latest_file=none',
    '',
  ].join('\n'));
  assert.throws(
    () => verifyRetentionAuthority({ archiveReceipt }),
    /contains no immutable object/,
  );
});

test('stale retention authority is reported as blocked instead of aborting safe upkeep', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'df-retention-blocked-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archiveReceipt = path.join(root, 'archive.receipt');
  fs.writeFileSync(archiveReceipt, [
    'format=deltaforge-offhost-receipt-v1',
    'scope=raw-wal-and-db-archive',
    'completed_at=2026-01-01T00:00:00Z',
    'source_cutoff_epoch=1767225300',
    'latest_file=wal/verified.ndjson.gz',
    '',
  ].join('\n'));

  const state = retentionAuthorityState(true, { archiveReceipt });
  assert.equal(state.status, 'BLOCKED');
  assert.equal(state.authority, null);
  assert.match(state.error.message, /receipt is stale/);
});
