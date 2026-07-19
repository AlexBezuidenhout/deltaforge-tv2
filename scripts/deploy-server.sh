#!/bin/bash
# deltaforge server — deploy to the launchd runtime mirror and (re)start.
#
# WHY A MIRROR: launchd agents cannot read ~/Desktop (macOS TCC). The server
# therefore RUNS from ~/.deltaforge-runtime under launchd job
# com.deltaforge.server (KeepAlive + RunAtLoad — survives crashes, network
# outages, logout, and reboot). This script — run from a normal user shell,
# which DOES have Desktop access — syncs the code there and restarts the job.
#
# ⚠️ Edits under src/ or public/ do NOT take effect until you run this script.
#    (public/index.html included — the dashboard is served from the mirror.)
#
# Usage:   bash scripts/deploy-server.sh
# Status:  launchctl print gui/$UID/com.deltaforge.server | head -20
# Log:     tail -f ~/Library/Logs/deltaforge-server.log
# Stop:    launchctl bootout gui/$UID/com.deltaforge.server
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
RT="$HOME/.deltaforge-runtime"
PLIST="$HOME/Library/LaunchAgents/com.deltaforge.server.plist"

mkdir -p "$RT"
rsync -a --delete "$REPO/src" "$RT/"
rsync -a --delete "$REPO/public" "$RT/"
rsync -a --delete "$REPO/scripts" "$RT/"
# borg/ carries the live executor + verdict stamp; the KILL switch lives at
# ~/.deltaforge-live/KILL precisely so this --delete can never resurrect a
# killed executor.
rsync -a --delete "$REPO/borg" "$RT/"
rsync -a --delete "$REPO/node_modules" "$RT/"
cp "$REPO/package.json" "$RT/package.json"
cp "$REPO/.env" "$RT/.env"

# Any manually-started server (nohup / terminal) must die first: it would
# hold :3004 and crash-loop the launchd job on EADDRINUSE. The pg advisory
# lock protects the bots either way; the port is the real conflict.
pkill -TERM -f "node src/index.js" 2>/dev/null || true
for i in $(seq 1 15); do pgrep -f "node src/index.js" >/dev/null || break; sleep 1; done

restart_job() { # label plist
  launchctl bootout "gui/$(id -u)/$1" 2>/dev/null || true
  for i in $(seq 1 10); do
    if launchctl bootstrap "gui/$(id -u)" "$2" 2>/dev/null; then return 0; fi
    [ "$i" = 10 ] && { echo "[deploy-server] bootstrap $1 failed after retries" >&2; exit 1; }
    sleep 1
  done
}
restart_job com.deltaforge.server "$PLIST"
echo "[deploy-server] synced -> $RT and restarted com.deltaforge.server"
echo "[deploy-server] log: ~/Library/Logs/deltaforge-server.log"
