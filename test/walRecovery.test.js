'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');
const { finalize, inspectSegment, prepare } = require('../scripts/recover-wal-backlog');

function walHeader() {
  return JSON.stringify({
    _borg_wal: {
      format: 'borg-event-wal-v2',
      source: 'test',
      opened_at: new Date().toISOString(),
    },
  });
}

test('large WAL inspection does not split legal Unicode separators', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wal-unicode-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'large.ndjson');
  const event = { event_id: 'unicode', raw: `${'x'.repeat(70 * 1024)}\u2028valid` };
  fs.writeFileSync(file, `${walHeader()}\n${JSON.stringify(event)}\n`);
  const inspected = await inspectSegment(file);
  assert.equal(inspected.rows, 1);
  assert.equal(inspected.invalidLines, 0);
  assert.equal(inspected.truncatedTailBytes, 0);
});

test('WAL recovery bundles header-only restart debris and preserves event segments', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wal-recovery-'));
  const source = path.join(root, 'test', '2026-07-23');
  fs.mkdirSync(source, { recursive: true });
  const headerOnly = path.join(source, 'header-only.ndjson');
  const withEvent = path.join(source, 'with-event.ndjson');
  const truncated = path.join(source, 'truncated.ndjson');
  const interruptedMiddle = path.join(source, 'interrupted-middle.ndjson');
  const orphanOpen = path.join(source, 'orphan.open');
  fs.writeFileSync(headerOnly, `${walHeader()}\n`);
  fs.writeFileSync(withEvent, `${walHeader()}\n${JSON.stringify({ event_id: 'one', raw: '{}' })}\n`);
  fs.writeFileSync(truncated, `${walHeader()}\n{"event_id":"partial`);
  fs.writeFileSync(
    interruptedMiddle,
    `${walHeader()}\n{"event_id":"partial\n${JSON.stringify({ event_id: 'two', raw: '{}' })}\n`,
  );
  fs.writeFileSync(orphanOpen, `${walHeader()}\n`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const prepared = await prepare(root, {
    recoverOpen: true,
    openRecoveryConfirm: 'collectors-drained',
    openMinimumAgeMs: 0,
  });
  assert.equal(prepared.recovered_open_segments.length, 1);
  assert.equal(prepared.plain_segments, 5);
  assert.equal(prepared.header_only_segments, 2);
  assert.equal(prepared.event_segments.length, 3);
  assert.ok(prepared.event_segments.some((row) => row.truncatedTailBytes > 0));
  assert.ok(prepared.event_segments.some((row) => row.invalidLines > 0 && row.rows > 0));
  assert.ok(fs.existsSync(headerOnly), 'prepare must remain non-destructive');
  assert.ok(fs.existsSync(withEvent), 'prepare must remain non-destructive');
  assert.ok(fs.existsSync(truncated), 'prepare must remain non-destructive');
  assert.ok(fs.existsSync(interruptedMiddle), 'prepare must remain non-destructive');
  assert.ok(fs.existsSync(`${withEvent}.gz`));
  assert.ok(fs.existsSync(`${truncated}.gz`));
  assert.ok(fs.existsSync(`${interruptedMiddle}.gz`));
  assert.match(zlib.gunzipSync(fs.readFileSync(`${withEvent}.gz`)).toString(), /"event_id":"one"/);
  assert.ok(fs.existsSync(path.join(root, prepared.header_bundle.file)));
  assert.equal(fs.existsSync(orphanOpen), false);

  const coveredAt = Math.floor(Date.now() / 1000) + 2;
  const receipt = path.join(root, 'receipt');
  fs.writeFileSync(receipt, [
    'format=deltaforge-offhost-receipt-v1',
    'scope=raw-wal-and-db-archive',
    `completed_at=${new Date().toISOString()}`,
    `source_cutoff_epoch=${coveredAt}`,
    'destination=test',
    'latest_file=wal/test.ndjson.gz',
    '',
  ].join('\n'));
  const finished = await finalize(root, receipt);
  assert.equal(finished.removed_segments, 5);
  assert.equal(finished.skipped_segments, 0);
  assert.equal(fs.existsSync(headerOnly), false);
  assert.equal(fs.existsSync(withEvent), false);
  assert.equal(fs.existsSync(truncated), false);
  assert.equal(fs.existsSync(interruptedMiddle), false);
  assert.ok(fs.existsSync(`${withEvent}.gz`));
});
