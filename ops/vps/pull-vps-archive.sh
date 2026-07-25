#!/bin/bash
# Append-only pull of immutable, closed VPS datasets into iCloud Drive.
# There is deliberately no --delete: a VPS deletion can never remove history.
set -euo pipefail

REMOTE="${DELTAFORGE_VPS_HOST:-deltaforge-vps}"
DEST="${DELTAFORGE_ICLOUD_ARCHIVE:-$HOME/Library/Mobile Documents/com~apple~CloudDocs/DeltaForge/Dublin-VPS}"
SNAPSHOT_STAGE="${DELTAFORGE_SNAPSHOT_STAGE:-$HOME/.deltaforge-vps/staging/database-snapshots}"
IMMUTABLE_STAGE="${DELTAFORGE_IMMUTABLE_STAGE:-$HOME/.deltaforge-vps/staging/immutable}"
PARQUET_DEST="${DELTAFORGE_ICLOUD_PARQUET:-$DEST/parquet}"
PARQUET_MAX_FILES="${DELTAFORGE_PARQUET_MAX_FILES_PER_PULL:-1000}"
PARQUET_SCRIPT="${DELTAFORGE_PARQUET_SCRIPT:-$HOME/.deltaforge-runtime/scripts/parquet-mirror.js}"
NODE_BIN="${DELTAFORGE_NODE_BIN:-}"
LOCK="${TMPDIR:-/tmp}/deltaforge-vps-archive.lock"
RECEIPT=""
PULL_INDEX=""
PARQUET_INPUTS=""
PARQUET_SOURCE_STAGE=""
PARQUET_OUTPUT_STAGE=""
SNAPSHOT_SOURCE_PRESENT=false
PUBLISHER_PID=""

if [ -z "$NODE_BIN" ]; then
  for candidate in \
    "$(command -v node 2>/dev/null || true)" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi

if ! mkdir "$LOCK" 2>/dev/null; then
  exit 0
fi
PULL_INDEX=$(mktemp "${TMPDIR:-/tmp}/deltaforge-published-objects.XXXXXX")
PARQUET_INPUTS=$(mktemp "${TMPDIR:-/tmp}/deltaforge-parquet-inputs.XXXXXX")
PARQUET_SOURCE_STAGE=$(mktemp -d "${TMPDIR:-/tmp}/deltaforge-parquet-source.XXXXXX")
PARQUET_OUTPUT_STAGE=$(mktemp -d "${TMPDIR:-/tmp}/deltaforge-parquet-output.XXXXXX")
started_epoch=$(date +%s)
# Files older than this existed before every rsync traversal began. The five-
# minute cushion absorbs small host-clock uncertainty.
source_cutoff_epoch=$((started_epoch - 300))
cleanup() {
  if [ -n "$PUBLISHER_PID" ]; then
    /bin/kill "$PUBLISHER_PID" 2>/dev/null || true
    wait "$PUBLISHER_PID" 2>/dev/null || true
  fi
  [ -z "$RECEIPT" ] || rm -f "$RECEIPT"
  [ -z "$PULL_INDEX" ] || rm -f "$PULL_INDEX"
  [ -z "$PARQUET_INPUTS" ] || rm -f "$PARQUET_INPUTS"
  [ -z "$PARQUET_SOURCE_STAGE" ] || rm -rf "$PARQUET_SOURCE_STAGE"
  [ -z "$PARQUET_OUTPUT_STAGE" ] || rm -rf "$PARQUET_OUTPUT_STAGE"
  rmdir "$LOCK"
}

publish_parquet_stage() {
  local staged relative target incoming
  local published=0 existing=0
  while IFS= read -r -d '' staged; do
    relative=${staged#"$PARQUET_OUTPUT_STAGE/"}
    target="$PARQUET_DEST/$relative"
    mkdir -p "${target%/*}"
    if [ -e "$target" ]; then
      /bin/rm -f "$staged"
      existing=$((existing + 1))
      continue
    fi
    incoming="${target}.incoming.$$"
    /bin/rm -f "$incoming"
    /bin/mv "$staged" "$incoming"
    /bin/mv "$incoming" "$target"
    published=$((published + 1))
  done < <(/usr/bin/find "$PARQUET_OUTPUT_STAGE" -type f \
    \( -name '*.parquet' -o -name '*.manifest.json' -o -name '*.invalid.json' \) -print0)
  printf '%s parquet publish: %s new object(s), %s already present\n' \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$published" "$existing" \
    >> "$HOME/Library/Logs/deltaforge-parquet-mirror.log"
}
trap cleanup EXIT

mkdir -p \
  "$DEST/wal" "$DEST/database-archive" "$DEST/database-snapshots" "$DEST/manifests" \
  "$SNAPSHOT_STAGE" "$IMMUTABLE_STAGE/wal" "$IMMUTABLE_STAGE/database-archive"

# Keep interrupted transfers outside their final path. Size comparison also
# repairs any truncated final-path files left by the pre-2026-07-20 copier;
# immutable source objects with matching sizes are not transferred again. Use
# recursive content copy rather than archive mode: iCloud does not preserve
# Unix ownership/permissions usefully, and reconciling their metadata across
# thousands of already-complete objects can prevent a traversal from finishing.
# The objects are already compressed and immutable, so always replace a bad-size
# destination whole. This also prevents rsync from reading an evicted iCloud
# placeholder as a delta basis (macOS returns EDEADLK for that operation).
RSYNC=(/usr/bin/rsync -r --size-only --whole-file --timeout=180 --partial-dir='.rsync-partial' \
  --exclude='.rsync-partial/' --exclude='archive-state.json' \
  --exclude='*.open' --exclude='*.tmp' --exclude='*.ndjson')

publish_staged_files() {
  local stage="${1%/}"
  local destination="${2%/}"
  local transfer_manifest="$3"
  local staged relative target incoming size sha parquet_source parquet_namespace
  while IFS= read -r -d '' staged; do
    relative=${staged#"$stage/"}
    target="$destination/$relative"
    case "$staged" in
      *.ndjson.gz)
        parquet_namespace=${destination#"$DEST/"}
        parquet_source="$PARQUET_SOURCE_STAGE/$parquet_namespace/$relative"
        mkdir -p "${parquet_source%/*}"
        # Keep a local APFS link while the canonical raw object moves into
        # iCloud, so conversion never depends on File Provider hydration.
        /bin/ln "$staged" "$parquet_source" 2>/dev/null \
          || /bin/cp "$staged" "$parquet_source"
        ;;
    esac
    mkdir -p "${target%/*}"
    size=$(stat -f '%z' "$staged")
    sha=$(/usr/bin/shasum -a 256 "$staged" | /usr/bin/awk '{print $1}')
    incoming="${target}.incoming.$$"
    /bin/rm -f "$incoming"
    /bin/mv "$staged" "$incoming"
    /bin/mv -f "$incoming" "$target"
    [ "$(stat -f '%z' "$target")" = "$size" ]
    printf '%s  %s  %s\n' "$sha" "$size" "$relative" >>"$transfer_manifest"
    case "$target" in
      *.ndjson.gz)
        printf '%s\t%s\t%s\n' "$sha" "$size" "$target" >>"$PULL_INDEX"
        printf '%s\n' "$parquet_source" >>"$PARQUET_INPUTS"
        ;;
      *.tar.gz)
        printf '%s\t%s\t%s\n' "$sha" "$size" "$target" >>"$PULL_INDEX"
        ;;
    esac
  done < <(/usr/bin/find "$stage" -type f ! -path '*/.rsync-partial/*' \
    \( -name '*.ndjson.gz' -o -name '*.tar.gz' -o -name '*.manifest.json' \) -print0)
}

streamed_rsync_attempt() {
  local source="$1"
  local destination="$2"
  local stage="$3"
  local transfer_manifest="$4"
  local done_marker publisher_pid rsync_status publisher_status
  done_marker=$(mktemp "${TMPDIR:-/tmp}/deltaforge-publisher-done.XXXXXX")
  /bin/rm -f "$done_marker"

  # rsync writes each object under a temporary dot-name and renames it only
  # after completion. The publisher therefore sees complete immutable objects
  # only, and continuously moves them out of staging while the remaining file
  # list is still being traversed. This bounds APFS staging to transfer
  # throughput rather than the entire multi-day outage backlog.
  (
    while [ ! -e "$done_marker" ]; do
      publish_staged_files "$stage" "$destination" "$transfer_manifest"
      sleep 1
    done
    publish_staged_files "$stage" "$destination" "$transfer_manifest"
  ) &
  publisher_pid=$!
  PUBLISHER_PID=$publisher_pid

  set +e
  "${RSYNC[@]}" --compare-dest="$destination" "$source" "$stage/"
  rsync_status=$?
  if ! /usr/bin/touch "$done_marker"; then
    /bin/kill "$publisher_pid" 2>/dev/null || true
  fi
  wait "$publisher_pid"
  publisher_status=$?
  PUBLISHER_PID=""
  set -e
  /bin/rm -f "$done_marker"
  [ "$publisher_status" -eq 0 ] || return "$publisher_status"
  return "$rsync_status"
}

pull_immutable() {
  local source="$1"
  local destination="${2%/}"
  local stage="${3%/}"
  local scope="$4"
  local status published_manifest
  local transfer_manifest

  printf '%s pull %s: traversing immutable source\n' \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$scope"
  mkdir -p "$destination" "$stage"
  transfer_manifest=$(mktemp "${TMPDIR:-/tmp}/deltaforge-${scope}-manifest.XXXXXX")
  set +e
  streamed_rsync_attempt "$source" "$destination" "$stage" "$transfer_manifest"
  status=$?
  set -e
  # A rotating .ndjson can produce exit 24 despite the exclusion. Retry once;
  # only a clean traversal may issue a deletion-authorizing receipt.
  if [ "$status" -eq 24 ]; then
    set +e
    streamed_rsync_attempt "$source" "$destination" "$stage" "$transfer_manifest"
    status=$?
    set -e
  fi
  if [ "$status" -ne 0 ]; then
    /bin/rm -f "$transfer_manifest"
    return "$status"
  fi

  # Writing rsync output directly into iCloud can fail with EDEADLK when an
  # existing object is an evicted File Provider placeholder. Download onto
  # ordinary APFS storage, hash it there, then atomically publish it into the
  # iCloud namespace. A per-pull manifest makes every newly transferred object
  # independently auditable without hydrating old cloud placeholders.
  if [ -s "$transfer_manifest" ]; then
    published_manifest="$DEST/manifests/$(date -u '+%Y-%m-%dT%H-%M-%SZ')-${scope}.sha256"
    /bin/mv "$transfer_manifest" "$published_manifest"
    printf '%s pull %s: published %s\n' \
      "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$scope" "$published_manifest"
  else
    /bin/rm -f "$transfer_manifest"
    printf '%s pull %s: source already complete\n' \
      "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$scope"
  fi
  /usr/bin/find "$stage" -depth -type d -empty -delete 2>/dev/null || true
}
pull_snapshots() {
  printf '%s pull snapshots: traversing verified dumps\n' \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  # Only the newest independently validated dump is useful migration
  # authority. Copying every superseded multi-gigabyte daily dump delayed the
  # safety-critical receipt for hours and consumed the Mac's bounded staging
  # disk without adding a distinct recovery point.
  local latest_relative relative_dir filename source object destination status
  latest_relative=$(/usr/bin/ssh "$REMOTE" \
    "find /var/lib/deltaforge/db-snapshots -type f -name '*.dump' -printf '%T@|%P\\n' \
      | sort -t '|' -nr | head -1 | cut -d '|' -f2-")
  if [ -z "$latest_relative" ]; then
    printf '%s pull snapshots: no new local dump; retaining verified off-host copy\n' \
      "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    return 0
  fi
  if [[ ! "$latest_relative" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}/deltaforge-(bounded-)?[0-9TZ-]+\.dump$ ]]; then
    printf 'invalid or missing latest remote snapshot path: %s\n' "$latest_relative" >&2
    return 1
  fi
  relative_dir="${latest_relative%/*}"
  filename="${latest_relative##*/}"
  SNAPSHOT_SOURCE_PRESENT=true
  mkdir -p "$SNAPSHOT_STAGE/$relative_dir" "$DEST/database-snapshots/$relative_dir"

  # Resume multi-gigabyte dumps on ordinary APFS storage. Reading an evicted
  # iCloud partial as rsync's basis can fail with EDEADLK, whereas the staging
  # partial remains local and safely resumable across network interruptions.
  local snapshot_rsync=(/usr/bin/rsync --size-only --timeout=180 \
    --partial-dir='.rsync-partial' \
    --exclude='.rsync-partial/' --exclude='*.open' --exclude='*.tmp')
  snapshot_rsync+=(--compare-dest="$DEST/database-snapshots/$relative_dir")
  local snapshot_objects=("$filename.sha256")
  if [[ "$filename" == deltaforge-bounded-* ]]; then
    snapshot_objects+=("$filename.profile")
  fi
  snapshot_objects+=("$filename")
  for object in "${snapshot_objects[@]}"; do
    source="$REMOTE:/var/lib/deltaforge/db-snapshots/$relative_dir/$object"
    destination="$SNAPSHOT_STAGE/$relative_dir/"
    set +e
    "${snapshot_rsync[@]}" "$source" "$destination"
    status=$?
    set -e
    if [ "$status" -eq 24 ]; then
      "${snapshot_rsync[@]}" "$source" "$destination"
      status=$?
    fi
    [ "$status" -eq 0 ] || return 1
  done

  # Validate every newly transferred dump while it is still resident on
  # ordinary APFS storage. Source mtimes predate this pull, so selecting
  # destination files by mtime would silently skip exactly the dump we need to
  # attest. A source sidecar may have matched compare-dest and therefore remain
  # only in iCloud; accept either location but require one.
  while IFS= read -r -d '' snapshot; do
    relative=${snapshot#"$SNAPSHOT_STAGE/"}
    checksum="${snapshot}.sha256"
    [ -f "$checksum" ] || checksum="$DEST/database-snapshots/${relative}.sha256"
    [ -f "$checksum" ]
    expected=$(/usr/bin/awk '{print $1}' "$checksum")
    [[ "$expected" =~ ^[a-fA-F0-9]{64}$ ]]
    # The VPS snapshot producer already requires pg_restore --list before
    # publishing the source object. Repeat that catalog check when the Mac has
    # PostgreSQL client tools, while the mandatory source/local SHA comparison
    # remains portable on a stock Mac.
    if command -v pg_restore >/dev/null 2>&1; then
      pg_restore --list "$snapshot" >/dev/null
    fi
    actual=$(/usr/bin/shasum -a 256 "$snapshot" | /usr/bin/awk '{print $1}')
    expected=$(printf '%s' "$expected" | /usr/bin/tr '[:upper:]' '[:lower:]')
    actual=$(printf '%s' "$actual" | /usr/bin/tr '[:upper:]' '[:lower:]')
    [ "$expected" = "$actual" ]
  done < <(/usr/bin/find "$SNAPSHOT_STAGE/$relative_dir" -maxdepth 1 \
    -type f -name "$filename" \
    ! -path '*/.rsync-partial/*' -print0)

  # The stage and iCloud Drive live on the same APFS volume, so this is an
  # atomic rename rather than a second multi-gigabyte network copy.
  while IFS= read -r -d '' staged; do
    relative=${staged#"$SNAPSHOT_STAGE/"}
    target="$DEST/database-snapshots/$relative"
    mkdir -p "${target%/*}"
    /bin/mv -f "$staged" "$target"
  done < <(/usr/bin/find "$SNAPSHOT_STAGE/$relative_dir" -maxdepth 1 -type f \
    \( -name "$filename" -o -name "$filename.sha256" -o -name "$filename.profile" \) \
    ! -path '*/.rsync-partial/*' -print0)
}
publish_receipt() {
  local local_name="$1"
  local remote_path="$2"
  local scope="$3"
  shift 3
  local latest completed_at remainder size file relative sha256 icloud_receipt remote_receipt
  local prior prior_file prior_size prior_sha

  if [ "$scope" = "database-snapshots" ]; then
    # Snapshot source names carry sortable UTC dates. Use that immutable name,
    # not a File Provider hydration mtime, to select migration authority.
    latest=$(/usr/bin/find "$@" -type f ! -path '*/.rsync-partial/*' \
      -name '*.dump' -print0 \
      | /usr/bin/xargs -0 stat -f '%m|%z|%N' 2>/dev/null \
      | /usr/bin/sort -t '|' -k3,3r | /usr/bin/head -1 || true)
  elif [ -s "$PULL_INDEX" ]; then
    # Hashes in this index were computed on ordinary APFS storage before each
    # immutable object was atomically renamed into iCloud. Using the index
    # avoids hydrating/statting hundreds of thousands of File Provider
    # placeholders merely to refresh a liveness receipt.
    latest=$(/usr/bin/tail -1 "$PULL_INDEX")
  elif [ -f "$DEST/$local_name" ]; then
    prior="$DEST/$local_name"
    prior_file=$(/usr/bin/awk -F= '$1 == "latest_file" { print substr($0, index($0, "=") + 1) }' "$prior")
    prior_size=$(/usr/bin/awk -F= '$1 == "latest_size" { print $2 }' "$prior")
    prior_sha=$(/usr/bin/awk -F= '$1 == "latest_sha256" { print $2 }' "$prior")
    if [ -n "$prior_file" ] && [ "$prior_file" != "none" ] \
        && [[ "$prior_size" =~ ^[0-9]+$ ]] \
        && [[ "$prior_sha" =~ ^[a-fA-F0-9]{64}$ ]] \
        && [ -e "$DEST/$prior_file" ]; then
      latest="${prior_sha}"$'\t'"${prior_size}"$'\t'"$DEST/$prior_file"
    else
      latest=""
    fi
  else
    # One-time bootstrap fallback. Normal pulls use either their APFS
    # publication index or the preceding verified receipt.
    latest=$(/usr/bin/find "$@" -type f ! -path '*/.rsync-partial/*' \
      \( -name '*.ndjson.gz' -o -name '*.tar.gz' -o -name '*.parquet' \) -print0 \
      | /usr/bin/xargs -0 stat -f '%m|%z|%N' 2>/dev/null \
      | /usr/bin/sort -t '|' -nr | /usr/bin/head -1 || true)
  fi
  if [ "$scope" != "database-snapshots" ] && [ -z "$latest" ]; then
    latest=$(/usr/bin/find "$@" -type f ! -path '*/.rsync-partial/*' \
      \( -name '*.ndjson.gz' -o -name '*.tar.gz' -o -name '*.parquet' \) -print0 \
      | /usr/bin/xargs -0 stat -f '%m|%z|%N' 2>/dev/null \
      | /usr/bin/sort -t '|' -nr | /usr/bin/head -1 || true)
  fi
  completed_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  RECEIPT=$(mktemp "${TMPDIR:-/tmp}/deltaforge-offhost-receipt.XXXXXX")
  if [ -n "$latest" ]; then
    if [[ "$latest" == *$'\t'* ]]; then
      sha256=${latest%%$'\t'*}
      remainder=${latest#*$'\t'}
      size=${remainder%%$'\t'*}
      file=${remainder#*$'\t'}
    else
      remainder=${latest#*|}
      size=${remainder%%|*}
      file=${remainder#*|}
      sha256=""
    fi
    relative=${file#"$DEST/"}
    if [ "$scope" = "database-snapshots" ] && [ -f "${file}.sha256" ]; then
      # The dump was independently hashed when first copied. Reuse its tiny
      # sidecar on later 15-minute traversals instead of rehydrating a 3–5 GiB
      # iCloud placeholder merely to refresh the liveness receipt.
      sha256=$(/usr/bin/awk '{print $1}' "${file}.sha256")
    elif [ -z "$sha256" ]; then
      sha256=$(/usr/bin/shasum -a 256 "$file" | /usr/bin/awk '{print $1}')
    fi
    printf 'format=deltaforge-offhost-receipt-v1\nscope=%s\ncompleted_at=%s\nsource_cutoff_epoch=%s\ndestination=icloud-drive\nlatest_file=%s\nlatest_size=%s\nlatest_sha256=%s\n' \
      "$scope" "$completed_at" "$source_cutoff_epoch" "$relative" "$size" "$sha256" > "$RECEIPT"
  else
    printf 'format=deltaforge-offhost-receipt-v1\nscope=%s\ncompleted_at=%s\nsource_cutoff_epoch=%s\ndestination=icloud-drive\nlatest_file=none\n' \
      "$scope" "$completed_at" "$source_cutoff_epoch" > "$RECEIPT"
  fi

  icloud_receipt="$DEST/.${local_name}.$$.tmp"
  /bin/cp "$RECEIPT" "$icloud_receipt"
  /bin/mv -f "$icloud_receipt" "$DEST/$local_name"
  remote_receipt="/tmp/deltaforge-offhost-receipt.$$.tmp"
  /usr/bin/scp -q "$RECEIPT" "$REMOTE:$remote_receipt"
  /usr/bin/ssh "$REMOTE" "sudo install -o deltaforge -g deltaforge -m 0644 '$remote_receipt' '$remote_path' && rm -f '$remote_receipt'"
  printf '%s receipt %s: published through source cutoff %s\n' \
    "$completed_at" "$scope" "$source_cutoff_epoch"
  /bin/rm -f "$RECEIPT"
  RECEIPT=""
}
# Preserve the non-reconstructable source streams first. A multi-gigabyte
# database snapshot must never starve the WAL/archive mirror on a slow link.
# Snapshots remain last-resort recovery artifacts and are copied only after a
# clean traversal of both raw-data tiers.
pull_immutable "$REMOTE:/var/lib/deltaforge/wal/borg/" \
  "$DEST/wal/" "$IMMUTABLE_STAGE/wal" "wal"
pull_immutable "$REMOTE:/var/lib/deltaforge/archive/borg-raw/" \
  "$DEST/database-archive/" "$IMMUTABLE_STAGE/database-archive" "database-archive"
publish_receipt "LAST_SUCCESS.txt" "/var/lib/deltaforge/offhost-archive.receipt" \
  "raw-wal-and-db-archive" "$DEST/wal" "$DEST/database-archive"

# Parquet is a reproducible research projection, so a conversion failure must
# never revoke a successful raw-data receipt or block the capture host. Convert
# newly mirrored APFS links immediately and bound each pass; publish the
# verified outputs atomically only after conversion. The backlog remains
# reproducible from raw data and never competes with the live collector.
if [ -s "$PARQUET_INPUTS" ] && [ -x "$NODE_BIN" ] && [ -f "$PARQUET_SCRIPT" ] \
    && [ -d "$(dirname "$PARQUET_SCRIPT")/../node_modules/@dsnp/parquetjs" ]; then
  mkdir -p "$PARQUET_DEST"
  set +e
  BORG_ARCHIVE_DIR="$PARQUET_SOURCE_STAGE/database-archive" \
  BORG_WAL_DIR="$PARQUET_SOURCE_STAGE/wal" \
  BORG_PARQUET_MIRROR_DIR="$PARQUET_OUTPUT_STAGE" \
  BORG_PARQUET_CANONICAL_BASE="$DEST" \
  BORG_PARQUET_MAX_FILES="$PARQUET_MAX_FILES" \
  BORG_PARQUET_INPUT_LIST="$PARQUET_INPUTS" \
    "$NODE_BIN" "$PARQUET_SCRIPT" \
      >> "$HOME/Library/Logs/deltaforge-parquet-mirror.log" 2>&1
  parquet_status=$?
  set -e
  if [ "$parquet_status" -ne 0 ]; then
    printf '%s parquet mirror exited %s; raw archive remains authoritative\n' \
      "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$parquet_status" \
      >> "$HOME/Library/Logs/deltaforge-parquet-mirror.log"
  else
    publish_parquet_stage
  fi
fi
pull_snapshots
if [ "$SNAPSHOT_SOURCE_PRESENT" = true ]; then
  publish_receipt "SNAPSHOT_LAST_SUCCESS.txt" "/var/lib/deltaforge/offhost-snapshot.receipt" \
    "database-snapshots" "$DEST/database-snapshots"
fi
# Parquet is a reproducible derivative of the immutable WAL/archive. Do not
# mirror the current uncompressed local derivative into iCloud: it duplicates
# tens of gigabytes, can fill both hosts, and delays the irreplaceable sources.
