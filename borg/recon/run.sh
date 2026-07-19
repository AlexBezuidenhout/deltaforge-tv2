#!/bin/bash
# BORG recon collector — MANUAL supervised launch (dev/debug only).
#
# ⚠️ Production supervision moved to launchd on 2026-07-11 after a reboot
# killed the nohup'd supervisor: ~/Library/LaunchAgents/com.borg.recon.plist
# (KeepAlive + RunAtLoad — survives crashes, logout, and reboot).
#   status : launchctl print gui/$UID/com.borg.recon
#   stop   : launchctl bootout gui/$UID/com.borg.recon
#   start  : launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.borg.recon.plist
# Do NOT run this script while the launchd job is loaded — double collection.
#
# Restarts on crash (5s backoff); caffeinate keeps the Mac from idle-sleeping
# while the collector runs. Log: borg/recon/collector.log
cd "$(dirname "$0")"
echo "[run.sh] supervisor starting $(date -u +%FT%TZ)" >> collector.log
while true; do
  caffeinate -i node collector.js >> collector.log 2>&1
  code=$?
  echo "[run.sh] collector exited code=$code — restarting in 5s ($(date -u +%FT%TZ))" >> collector.log
  sleep 5
done
