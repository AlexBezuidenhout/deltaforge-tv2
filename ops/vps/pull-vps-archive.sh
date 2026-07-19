#!/bin/bash
# Append-only pull of immutable, closed VPS datasets into iCloud Drive.
# There is deliberately no --delete: a VPS deletion can never remove history.
set -euo pipefail

REMOTE="${DELTAFORGE_VPS_HOST:-deltaforge-vps}"
DEST="${DELTAFORGE_ICLOUD_ARCHIVE:-$HOME/Library/Mobile Documents/com~apple~CloudDocs/DeltaForge/Dublin-VPS}"
LOCK="${TMPDIR:-/tmp}/deltaforge-vps-archive.lock"
RECEIPT=""

if ! mkdir "$LOCK" 2>/dev/null; then
  exit 0
fi
started_epoch=$(date +%s)
# Files older than this existed before every rsync traversal began. The five-
# minute cushion absorbs small host-clock uncertainty.
source_cutoff_epoch=$((started_epoch - 300))
cleanup() {
  [ -z "$RECEIPT" ] || rm -f "$RECEIPT"
  rmdir "$LOCK"
}
trap cleanup EXIT

mkdir -p "$DEST/wal" "$DEST/database-archive" "$DEST/database-snapshots"

# Keep interrupted transfers outside their final path. Combining a final-path
# partial with --ignore-existing would make the next run preserve a truncated
# file instead of resuming it.
RSYNC=(/usr/bin/rsync -a --ignore-existing --partial-dir='.rsync-partial' \
  --exclude='.rsync-partial/' --exclude='*.open' --exclude='*.tmp' --exclude='*.ndjson')
pull_immutable() {
  set +e
  "${RSYNC[@]}" "$1" "$2"
  status=$?
  set -e
  # A rotating .ndjson can produce exit 24 despite the exclusion. Retry once;
  # only a clean traversal may issue a deletion-authorizing receipt.
  if [ "$status" -eq 24 ]; then
    "${RSYNC[@]}" "$1" "$2"
    status=$?
  fi
  [ "$status" -eq 0 ]
}
pull_immutable "$REMOTE:/var/lib/deltaforge/db-snapshots/" "$DEST/database-snapshots/"
pull_immutable "$REMOTE:/var/lib/deltaforge/wal/borg/" "$DEST/wal/"
pull_immutable "$REMOTE:/var/lib/deltaforge/archive/borg-raw/" "$DEST/database-archive/"
# Parquet is a reproducible derivative of the immutable WAL/archive. Do not
# mirror the current uncompressed local derivative into iCloud: it duplicates
# tens of gigabytes, can fill both hosts, and delays the irreplaceable sources.

latest=$(/usr/bin/find "$DEST" -type f \( -name '*.ndjson.gz' -o -name '*.parquet' -o -name '*.dump' \) -print0 \
  | /usr/bin/xargs -0 stat -f '%m|%z|%N' 2>/dev/null | /usr/bin/sort -t '|' -nr | /usr/bin/head -1 || true)
completed_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
RECEIPT=$(mktemp "${TMPDIR:-/tmp}/deltaforge-offhost-receipt.XXXXXX")
if [ -n "$latest" ]; then
  remainder=${latest#*|}
  size=${remainder%%|*}
  file=${remainder#*|}
  sha256=$(/usr/bin/shasum -a 256 "$file" | /usr/bin/awk '{print $1}')
  printf 'format=deltaforge-offhost-receipt-v1\ncompleted_at=%s\nsource_cutoff_epoch=%s\ndestination=icloud-drive\nlatest_file=%s\nlatest_size=%s\nlatest_sha256=%s\n' \
    "$completed_at" "$source_cutoff_epoch" "$file" "$size" "$sha256" > "$RECEIPT"
else
  printf 'format=deltaforge-offhost-receipt-v1\ncompleted_at=%s\nsource_cutoff_epoch=%s\ndestination=icloud-drive\nlatest_file=none\n' \
    "$completed_at" "$source_cutoff_epoch" > "$RECEIPT"
fi
icloud_receipt="$DEST/.LAST_SUCCESS.$$.tmp"
/bin/cp "$RECEIPT" "$icloud_receipt"
/bin/mv -f "$icloud_receipt" "$DEST/LAST_SUCCESS.txt"
remote_receipt="/tmp/deltaforge-offhost-receipt.$$.tmp"
/usr/bin/scp -q "$RECEIPT" "$REMOTE:$remote_receipt"
/usr/bin/ssh "$REMOTE" "sudo install -o deltaforge -g deltaforge -m 0644 '$remote_receipt' /var/lib/deltaforge/offhost-archive.receipt && rm -f '$remote_receipt'"
