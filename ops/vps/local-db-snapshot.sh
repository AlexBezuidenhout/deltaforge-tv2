#!/bin/bash
# Immutable local-Postgres snapshot. The direct off-host archive transport
# checksum-verifies and copies completed snapshots; no running service waits
# for this job.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
DEST="${DELTAFORGE_DB_SNAPSHOT_DIR:-/var/lib/deltaforge/db-snapshots}"
PROFILE="${DELTAFORGE_DB_SNAPSHOT_PROFILE:-full}"
BOUNDED_CONFIRM="verified-wal-backed-replayable-hot-tier"
RAW_RECEIPT="${DELTAFORGE_OFFHOST_RECEIPT:-/var/lib/deltaforge/offhost-archive.receipt}"
STAMP=$(date -u '+%Y-%m-%dT%H-%M-%SZ')
DAY=${STAMP:0:10}
mkdir -p "$DEST/$DAY"
prefix="deltaforge"
if [ "$PROFILE" = "bounded" ]; then
  prefix="deltaforge-bounded"
elif [ "$PROFILE" != "full" ]; then
  echo "unknown snapshot profile: $PROFILE" >&2
  exit 1
fi
TMP="$DEST/$DAY/$prefix-$STAMP.dump.tmp"
FINAL="${TMP%.tmp}"
PROFILE_TMP="$FINAL.profile.tmp"
HOT_TABLES=(
  borg_clob_touch
  borg_clob_events
  borg_book_snaps
  borg_external_book_touch
  borg_external_trades
  borg_structural_evaluations
  borg_deribit_option_touch
  borg_option_shadow_marks
  cv_book_snapshots
  cv_opportunities
  cv_basis_samples
)

cleanup() { rm -f "$TMP" "$PROFILE_TMP"; }
trap cleanup EXIT

dump_args=(
  --dbname="$DATABASE_URL"
  --format=custom
  --compress=9
  --no-owner
  --no-acl
  --file="$TMP"
)
required_raw_cutoff=0
raw_completed_at=""
if [ "$PROFILE" = "bounded" ]; then
  if [ "${DELTAFORGE_BOUNDED_SNAPSHOT_CONFIRM:-}" != "$BOUNDED_CONFIRM" ]; then
    echo "bounded snapshot refused: missing explicit WAL-backed confirmation" >&2
    exit 1
  fi
  if [ ! -s "$RAW_RECEIPT" ]; then
    echo "bounded snapshot refused: raw off-host receipt missing" >&2
    exit 1
  fi
  now_epoch=$(date +%s)
  # The public receipt is a stable symlink to an atomically replaced target.
  # Follow the link so freshness reflects the latest verified upload.
  receipt_mtime=$(stat -Lc '%Y' "$RAW_RECEIPT")
  if (( now_epoch - receipt_mtime > 10800 )); then
    echo "bounded snapshot refused: raw off-host receipt is stale" >&2
    exit 1
  fi
  grep -q '^format=deltaforge-offhost-receipt-v1$' "$RAW_RECEIPT"
  grep -q '^scope=raw-wal-and-db-archive$' "$RAW_RECEIPT"
  if grep -q '^latest_file=none$' "$RAW_RECEIPT"; then
    echo "bounded snapshot refused: raw receipt has no immutable object" >&2
    exit 1
  fi
  raw_source_cutoff=$(awk -F= '$1 == "source_cutoff_epoch" { print $2 }' "$RAW_RECEIPT")
  raw_completed_at=$(awk -F= '$1 == "completed_at" { print $2 }' "$RAW_RECEIPT")
  if ! [[ "$raw_source_cutoff" =~ ^[0-9]+$ ]]; then
    echo "bounded snapshot refused: raw receipt has no valid source cutoff" >&2
    exit 1
  fi
  if find "${BORG_WAL_DIR:-/var/lib/deltaforge/wal/borg}" -type f -name '*.open' \
      -print -quit | grep -q .; then
    echo "bounded snapshot refused: open WAL segments remain" >&2
    exit 1
  fi
  for unit in \
    deltaforge-tv2.service borg-collector.service borg-allmarket.service \
    borg-crossvenue.service borg-options-surface.service \
    borg-pyth-boundary.service borg-structural-scanner.service \
    polymarket-flow.service deltaforge-cv-settle.service; do
    if systemctl is-active --quiet "$unit"; then
      echo "bounded snapshot refused: $unit is still active" >&2
      exit 1
    fi
  done

  required_raw_cutoff=$(psql "$DATABASE_URL" -X -Atc "
    SELECT COALESCE(ceil(extract(epoch FROM max(latest))),0)::bigint
      FROM (
        SELECT max(ts) latest FROM borg_clob_touch
        UNION ALL SELECT max(ts) FROM borg_clob_events
        UNION ALL SELECT max(ts) FROM borg_book_snaps
        UNION ALL SELECT max(received_at) FROM borg_external_book_touch
        UNION ALL SELECT max(received_at) FROM borg_external_trades
        UNION ALL SELECT max(evaluated_at) FROM borg_structural_evaluations
        UNION ALL SELECT max(sample_at) FROM borg_deribit_option_touch
        UNION ALL SELECT max(observed_at) FROM borg_option_shadow_marks
        UNION ALL SELECT max(observed_at) FROM cv_book_snapshots
        UNION ALL SELECT max(observed_at) FROM cv_opportunities
        UNION ALL SELECT max(observed_at) FROM cv_basis_samples
      ) hot")
  if ! [[ "$required_raw_cutoff" =~ ^[0-9]+$ ]]; then
    echo "bounded snapshot refused: could not derive hot-tier cutoff" >&2
    exit 1
  fi
  if (( raw_source_cutoff < required_raw_cutoff )); then
    echo "bounded snapshot refused: raw receipt does not cover the excluded query tier" >&2
    exit 1
  fi
  for table in "${HOT_TABLES[@]}"; do
    dump_args+=(--exclude-table-data="public.$table")
  done
fi

pg_dump "${dump_args[@]}"
pg_restore --list "$TMP" >/dev/null
mv "$TMP" "$FINAL"
BASE=$(basename "$FINAL")
(cd "$DEST/$DAY" && sha256sum "$BASE" > "$BASE.sha256")
if [ "$PROFILE" = "bounded" ]; then
  {
    printf 'format=deltaforge-db-snapshot-profile-v1\n'
    printf 'profile=replayable-hot-tier-excluded-v1\n'
    printf 'created_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf 'required_raw_source_cutoff_epoch=%s\n' "$required_raw_cutoff"
    printf 'raw_receipt_completed_at=%s\n' "$raw_completed_at"
    printf 'excluded_tables=%s\n' "$(IFS=,; echo "${HOT_TABLES[*]}")"
  } >"$PROFILE_TMP"
  mv "$PROFILE_TMP" "$FINAL.profile"
  chmod 0600 "$FINAL.profile"
fi
chmod 0600 "$FINAL" "$FINAL.sha256"
