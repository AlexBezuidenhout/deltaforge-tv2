#!/bin/bash
# Remove only sealed hot-tier files that have already passed through a recent,
# successful off-host pull. Open WAL segments and current database rows are not
# touched. If the receipt is missing/stale, deletion fails closed.
set -euo pipefail

RECEIPT="${DELTAFORGE_OFFHOST_RECEIPT:-/var/lib/deltaforge/offhost-archive.receipt}"
SNAPSHOT_RECEIPT="${DELTAFORGE_OFFHOST_SNAPSHOT_RECEIPT:-/var/lib/deltaforge/offhost-snapshot.receipt}"
RAW_KEEP_HOURS="${DELTAFORGE_VPS_RAW_RETENTION_HOURS:-6}"
PARQUET_KEEP_MINUTES="${DELTAFORGE_VPS_PARQUET_RETENTION_MINUTES:-60}"
MAX_RECEIPT_AGE_SEC="${DELTAFORGE_MAX_RECEIPT_AGE_SEC:-10800}"

# Atomic WAL compression keeps the plain segment until the final gzip has
# passed decompression-hash verification. A `.tmp` is therefore never the
# authoritative copy. Remove abandoned compressor scratch files after an hour;
# the age bound is far beyond normal 64 MB segment compression and cannot touch
# an active writer's current output.
find /var/lib/deltaforge/wal/borg -type f -name '*.tmp' -mmin +60 -delete \
  2>/dev/null || true

# Parquet is a local, reproducible derivative. The immutable WAL/archive is the
# source of truth, so do not let duplicate Parquet exhaust the capture disk.
if [ -d /var/lib/deltaforge/wal/borg ] || [ -d /var/lib/deltaforge/archive/borg-raw ]; then
  find /var/lib/deltaforge/parquet -type f \
    \( -name '*.parquet' -o -name '*.manifest.json' \) \
    -mmin "+$PARQUET_KEEP_MINUTES" -delete 2>/dev/null || true
fi

if [ ! -s "$RECEIPT" ]; then
  echo "retention refused: off-host receipt missing"
  exit 1
fi
now=$(date +%s)
# The stable receipt path is a systemd-tmpfiles symlink into the uploader's
# private state directory. Follow it: the link itself is intentionally created
# once, while the atomically replaced target carries the successful-upload
# timestamp.
receipt_mtime=$(stat -Lc '%Y' "$RECEIPT")
if [ $((now - receipt_mtime)) -gt "$MAX_RECEIPT_AGE_SEC" ]; then
  echo "retention refused: off-host receipt is stale"
  exit 1
fi
grep -q '^format=deltaforge-offhost-receipt-v1$' "$RECEIPT"
grep -q '^scope=raw-wal-and-db-archive$' "$RECEIPT"
grep -q '^latest_file=' "$RECEIPT"
if grep -q '^latest_file=none$' "$RECEIPT"; then
  echo "retention refused: off-host receipt contains no archived file"
  exit 1
fi

source_cutoff=$(awk -F= '$1 == "source_cutoff_epoch" { print $2 }' "$RECEIPT")
if ! [[ "$source_cutoff" =~ ^[0-9]+$ ]]; then
  echo "raw retention skipped: receipt predates source-cutoff attestations"
  exit 0
fi

find /var/lib/deltaforge/wal/borg /var/lib/deltaforge/archive/borg-raw \
  -type f \( -name '*.ndjson.gz' -o -name '*.tar.gz' -o -name '*.manifest.json' \) \
  -mmin "+$((RAW_KEEP_HOURS * 60))" ! -newermt "@$source_cutoff" -delete

if [ ! -s "$SNAPSHOT_RECEIPT" ]; then
  echo "snapshot retention skipped: independent off-host snapshot receipt missing"
  exit 0
fi
snapshot_receipt_mtime=$(stat -Lc '%Y' "$SNAPSHOT_RECEIPT")
if [ $((now - snapshot_receipt_mtime)) -gt "$MAX_RECEIPT_AGE_SEC" ]; then
  echo "snapshot retention skipped: independent off-host snapshot receipt is stale"
  exit 0
fi
grep -q '^format=deltaforge-offhost-receipt-v1$' "$SNAPSHOT_RECEIPT"
grep -q '^scope=database-snapshots$' "$SNAPSHOT_RECEIPT"
grep -q '^latest_file=' "$SNAPSHOT_RECEIPT"
if grep -q '^latest_file=none$' "$SNAPSHOT_RECEIPT"; then
  echo "snapshot retention skipped: independent receipt contains no snapshot"
  exit 0
fi
snapshot_cutoff=$(awk -F= '$1 == "source_cutoff_epoch" { print $2 }' "$SNAPSHOT_RECEIPT")
if ! [[ "$snapshot_cutoff" =~ ^[0-9]+$ ]]; then
  echo "snapshot retention skipped: receipt has no valid source cutoff"
  exit 0
fi

# A database dump is a staging artifact, not the permanent archive. Once the
# independent snapshot receipt proves that the off-host traversal completed,
# retaining another 4--5 GiB copy on the 100 GiB capture disk only threatens
# the irreplaceable WAL. Files newer than the attested source cutoff remain
# fail-closed for the next pull.
find /var/lib/deltaforge/db-snapshots -type f \
  \( -name '*.dump' -o -name '*.dump.sha256' -o -name '*.dump.profile' \) \
  ! -newermt "@$snapshot_cutoff" -delete
