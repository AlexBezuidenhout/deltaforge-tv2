#!/bin/bash
# Immutable local-Postgres snapshot. The hourly Mac archive pull copies these
# off-host with --ignore-existing; no running service waits for this job.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
DEST="${DELTAFORGE_DB_SNAPSHOT_DIR:-/var/lib/deltaforge/db-snapshots}"
STAMP=$(date -u '+%Y-%m-%dT%H-%M-%SZ')
DAY=${STAMP:0:10}
mkdir -p "$DEST/$DAY"
TMP="$DEST/$DAY/deltaforge-$STAMP.dump.tmp"
FINAL="${TMP%.tmp}"

cleanup() { rm -f "$TMP"; }
trap cleanup EXIT
pg_dump --dbname="$DATABASE_URL" --format=custom --compress=9 --no-owner --no-acl --file="$TMP"
pg_restore --list "$TMP" >/dev/null
mv "$TMP" "$FINAL"
BASE=$(basename "$FINAL")
(cd "$DEST/$DAY" && sha256sum "$BASE" > "$BASE.sha256")
chmod 0600 "$FINAL" "$FINAL.sha256"
