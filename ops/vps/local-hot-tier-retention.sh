#!/bin/bash
# Remove only sealed hot-tier files that have already passed through a recent,
# successful off-host pull. Open WAL segments and current database rows are not
# touched. If the receipt is missing/stale, deletion fails closed.
set -euo pipefail

RECEIPT="${DELTAFORGE_OFFHOST_RECEIPT:-/var/lib/deltaforge/offhost-archive.receipt}"
KEEP_DAYS="${DELTAFORGE_VPS_HOT_RETENTION_DAYS:-3}"
RAW_KEEP_HOURS="${DELTAFORGE_VPS_RAW_RETENTION_HOURS:-6}"
PARQUET_KEEP_MINUTES="${DELTAFORGE_VPS_PARQUET_RETENTION_MINUTES:-60}"
MAX_RECEIPT_AGE_SEC="${DELTAFORGE_MAX_RECEIPT_AGE_SEC:-10800}"

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
receipt_mtime=$(stat -c '%Y' "$RECEIPT")
if [ $((now - receipt_mtime)) -gt "$MAX_RECEIPT_AGE_SEC" ]; then
  echo "retention refused: off-host receipt is stale"
  exit 1
fi
grep -q '^format=deltaforge-offhost-receipt-v1$' "$RECEIPT"
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
  -type f \( -name '*.ndjson.gz' -o -name '*.manifest.json' \) \
  -mmin "+$((RAW_KEEP_HOURS * 60))" ! -newermt "@$source_cutoff" -delete

find /var/lib/deltaforge/db-snapshots -type f \
  \( -name '*.dump' -o -name '*.dump.sha256' \) \
  -mtime "+$KEEP_DAYS" ! -newermt "@$source_cutoff" -delete
