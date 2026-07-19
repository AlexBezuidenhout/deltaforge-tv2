#!/bin/bash
# BORG recon — deploy to the launchd runtime mirror and (re)start.
#
# WHY A MIRROR: launchd agents cannot read ~/Desktop (macOS TCC — verified
# 2026-07-11: "Operation not permitted"; the job died with EX_CONFIG / a
# silently hung node). The collector therefore RUNS from ~/.borg-runtime.
# This script — run from a normal user shell, which DOES have Desktop
# access — syncs the code there and restarts the launchd job.
#
# ⚠️ Edits to borg/recon/*.js do NOT take effect until you run this script.
#
# Usage:   bash borg/recon/deploy.sh
# Status:  launchctl print gui/$UID/com.borg.recon | head -20
# Log:     tail -f ~/Library/Logs/borg-recon.log
# Stop:    launchctl bootout gui/$UID/com.borg.recon
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
RT="$HOME/.borg-runtime"
PLIST="$HOME/Library/LaunchAgents/com.borg.recon.plist"

mkdir -p "$RT/borg"
rsync -a --delete --exclude collector.log "$REPO/borg/recon" "$RT/borg/"
rsync -a --delete "$REPO/borg/shadow" "$RT/borg/"
rsync -a --delete "$REPO/borg/research" "$RT/borg/"
rsync -a --delete "$REPO/borg/experiments" "$RT/borg/"
cp "$REPO/.env" "$RT/.env"

# minimal deps, pinned to the versions the repo actually uses
cd "$RT"
if [ ! -f package.json ]; then
  echo '{"name":"borg-runtime","private":true,"description":"launchd runtime mirror for borg/recon — see deploy.sh"}' > package.json
fi
DEPS="pg ws dotenv ethers"
REQS="require('pg');require('ws');require('dotenv');require('ethers')"
if ! node -e "$REQS" 2>/dev/null; then
  SPECS=""
  for d in $DEPS; do
    SPECS="$SPECS $d@$(node -p "require('$REPO/node_modules/$d/package.json').version")"
  done
  npm install --silent $SPECS
fi

restart_job() { # label plist
  launchctl bootout "gui/$(id -u)/$1" 2>/dev/null || true
  # bootout is asynchronous — bootstrap races it and fails with EIO if the
  # old job hasn't finished tearing down; retry briefly
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if launchctl bootstrap "gui/$(id -u)" "$2" 2>/dev/null; then return 0; fi
    [ "$i" = 10 ] && { echo "[deploy.sh] bootstrap $1 failed after retries" >&2; exit 1; }
    sleep 1
  done
}
restart_job com.borg.recon "$PLIST"
SCORE_PLIST="$HOME/Library/LaunchAgents/com.borg.score.plist"
[ -f "$SCORE_PLIST" ] && restart_job com.borg.score "$SCORE_PLIST"
echo "[deploy.sh] synced recon + shadow + research + frozen experiments -> $RT; restarted com.borg.recon (+ com.borg.score if present)"
echo "[deploy.sh] logs: ~/Library/Logs/borg-recon.log, borg-score.log"
