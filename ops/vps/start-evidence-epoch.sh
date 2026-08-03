#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "start-evidence-epoch.sh must run as root" >&2
  exit 1
fi

epoch_id="${1:-backlog-forward-$(date -u +%Y-%m-%d)-v13}"
if [[ ! "${epoch_id}" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "epoch id may contain only letters, numbers, dot, underscore and dash" >&2
  exit 1
fi

minimum_free_gib="${BORG_EPOCH_MIN_FREE_GIB:-30}"
warmup_timeout_sec="${BORG_EPOCH_WARMUP_TIMEOUT_SEC:-240}"
deployed_release="$(basename "$(readlink -f /opt/deltaforge/tv2/current)")"
# Default to the immutable release identifier. A human cohort label can still
# be supplied explicitly, but a forgotten override must never stamp a new
# evidence epoch with an obsolete hard-coded code version.
code_version="${BORG_EPOCH_CODE_VERSION:-${deployed_release}}"
epoch_reason="${BORG_EPOCH_REASON:-exact-rule-structural-options-forward-after-runtime-repair}"
maintenance_timers_drained=false
tmp_file=""
preflight_report=""

restore_maintenance_timers() {
  if [[ "${maintenance_timers_drained}" == true ]]; then
    systemctl enable --now \
      deltaforge-google-drive-archive.timer \
      deltaforge-parquet-lake.timer >/dev/null 2>&1 || true
    maintenance_timers_drained=false
  fi
}

cleanup() {
  status=$?
  trap - EXIT
  [[ -z "${tmp_file}" ]] || rm -f "${tmp_file}"
  [[ -z "${preflight_report}" ]] || rm -f "${preflight_report}"
  if (( status != 0 )); then restore_maintenance_timers; fi
  exit "${status}"
}
trap cleanup EXIT

# An immutable code release is not runnable evidence unless its lockfile-
# matched native dependency set is installed. In particular, a missing DuckDB
# binding previously left the Parquet timer failed while an old receipt still
# looked fresh. Refuse the epoch before any collector is stopped or relabelled.
if ! runuser -u deltaforge -- bash -lc \
    "cd '/var/lib/deltaforge/research-tools/current' && /usr/local/bin/node -e \"require.resolve('@duckdb/node-api')\""; then
  echo "refusing to start evidence epoch: release dependencies are incomplete" >&2
  exit 1
fi

# Freeze timer dispatch before checking the oneshot services. This closes the
# check-then-stop race where Parquet began after a green preflight and was then
# killed by the cohort drain, leaving systemd failed but an old report green.
maintenance_timers_drained=true
systemctl stop \
  deltaforge-google-drive-archive.timer \
  deltaforge-parquet-lake.timer

for maintenance_unit in \
    deltaforge-google-drive-archive.service \
    deltaforge-parquet-lake.service; do
  if systemctl is-failed --quiet "${maintenance_unit}"; then
    echo "refusing to start evidence epoch: ${maintenance_unit} is failed" >&2
    exit 1
  fi
  if systemctl is-active --quiet "${maintenance_unit}"; then
    echo "refusing to start evidence epoch: ${maintenance_unit} is still running" >&2
    exit 1
  fi
done

for failure_report in \
    /var/lib/deltaforge/google-drive-archive/last-report.json \
    /var/lib/deltaforge/parquet-lake/last-report.json; do
  if [[ ! -f "${failure_report}" ]] \
      || ! grep -Eq '"status"[[:space:]]*:[[:space:]]*"verified"' "${failure_report}"; then
    echo "refusing to start evidence epoch: unverified maintenance report ${failure_report}" >&2
    exit 1
  fi
done

available_kib="$(df --output=avail /var/lib/postgresql | tail -1 | tr -d ' ')"
required_kib="$((minimum_free_gib * 1024 * 1024))"
if (( available_kib < required_kib )); then
  echo "refusing to start evidence epoch: less than ${minimum_free_gib} GiB free" >&2
  exit 1
fi

# Drain every cohort-producing process before setting the timestamp. Otherwise
# a timer or an old collector can finish shutting down after the new timestamp
# and leak its final heartbeat/error into the successor trial.
systemctl stop \
  deltaforge-evidence-health.timer deltaforge-evidence-health.service \
  borg-score.timer borg-score.service \
  deltaforge-raw-archive.timer deltaforge-raw-archive.service \
  deltaforge-hot-partitions.timer deltaforge-hot-partitions.service \
  deltaforge-hot-db-prune.timer deltaforge-hot-db-prune.service \
  deltaforge-hot-retention.timer deltaforge-hot-retention.service \
  deltaforge-cv-settle.timer deltaforge-cv-settle.service \
  deltaforge-db-snapshot.timer deltaforge-db-snapshot.service \
  deltaforge-health.timer deltaforge-health.service \
  deltaforge-tv2.service \
  borg-collector.service \
  borg-allmarket.service \
  borg-crossvenue.service \
  borg-options-surface.service \
  borg-pyth-boundary.service \
  borg-structural-scanner.service \
  polymarket-flow.service \
  eth-g-late-canary.service

epoch_start="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
tmp_file="$(mktemp /etc/deltaforge/evidence-epoch.env.XXXXXX)"

{
  printf 'BORG_COLLECTION_EPOCH_ID=%s\n' "${epoch_id}"
  printf 'BORG_COLLECTION_EPOCH_START=%s\n' "${epoch_start}"
  printf 'BORG_COLLECTION_LOCATION=dublin-ie\n'
  printf 'BORG_COLLECTION_CODE_VERSION=%s\n' "${code_version}"
  printf 'BORG_COLLECTION_EPOCH_REASON=%s\n' "${epoch_reason}"
  printf 'BORG_INCLUDE_PARKED_CONTROLS=false\n'
} >"${tmp_file}"

chmod 0600 "${tmp_file}"
chown root:root "${tmp_file}"
mv -f "${tmp_file}" /etc/deltaforge/evidence-epoch.env
tmp_file=""

# Seed partition and verified archive state while the high-rate writers are
# still drained. Both jobs are receipt-gated and must fail closed before a
# candidate epoch is allowed to start.
systemctl start deltaforge-hot-partitions.service
systemctl start deltaforge-raw-archive.service

systemctl disable --now \
  borg-paired-maker.service \
  flow-boundary-canary.service \
  gla-paper.service \
  h53-live.service \
  eth-g-late-canary.service \
  deltaforge-parquet.timer >/dev/null 2>&1 || true

systemctl enable \
  deltaforge-tv2.service \
  borg-collector.service \
  borg-allmarket.service \
  borg-crossvenue.service \
  borg-options-surface.service \
  borg-pyth-boundary.service \
  borg-structural-scanner.service \
  polymarket-flow.service

systemctl start \
  deltaforge-tv2.service \
  borg-collector.service \
  borg-allmarket.service \
  borg-crossvenue.service \
  borg-options-surface.service \
  borg-pyth-boundary.service \
  borg-structural-scanner.service \
  polymarket-flow.service

systemctl enable --now \
  borg-score.timer \
  deltaforge-raw-archive.timer \
  deltaforge-hot-partitions.timer \
  deltaforge-hot-db-prune.timer \
  deltaforge-hot-retention.timer \
  deltaforge-cv-settle.timer \
  deltaforge-db-snapshot.timer

# Do not make cohort validity depend on where startup lands within a five-minute
# timer bucket. The archive heartbeat was seeded before the hot writers; score
# now that the primary collector has registered the new run.
systemctl start borg-score.service

preflight_report="$(mktemp /tmp/deltaforge-evidence-preflight.XXXXXX)"
deadline="$(( $(date +%s) + warmup_timeout_sec ))"
attempt=0
preflight_ready=false
while (( $(date +%s) < deadline )); do
  attempt="$((attempt + 1))"
  preflight_unit="deltaforge-evidence-preflight-$$-${attempt}"
  if systemd-run --wait --collect --pipe --quiet \
      --unit="${preflight_unit}" \
      -p User=deltaforge \
      -p Group=deltaforge \
      -p WorkingDirectory=/opt/deltaforge/tv2/current \
      -p EnvironmentFile=/etc/deltaforge/tv2.env \
      /usr/local/bin/node scripts/evidence-epoch-status.js \
      >"${preflight_report}" 2>&1 \
      && grep -q '"status": "PENDING_24H"' "${preflight_report}"; then
    preflight_ready=true
    break
  fi
  sleep 5
done

if [[ "${preflight_ready}" != true ]]; then
  echo "evidence epoch preflight did not become healthy within ${warmup_timeout_sec}s" >&2
  tail -80 "${preflight_report}" >&2 || true
  rm -f "${preflight_report}"
  # A rejected epoch is still an operational collector run. Restore every
  # maintenance/health timer drained above and persist one terminal failed
  # sample; otherwise a correct fail-closed launch would leave archiving and
  # liveness monitoring silently disabled until a human noticed.
  systemctl enable --now \
    deltaforge-google-drive-archive.timer \
    deltaforge-parquet-lake.timer \
    deltaforge-health.timer
  maintenance_timers_drained=false
  systemctl reset-failed \
    deltaforge-health.service deltaforge-evidence-health.service >/dev/null 2>&1 || true
  systemctl start deltaforge-health.service || true
  systemctl start deltaforge-evidence-health.service || true
  systemctl enable --now deltaforge-evidence-health.timer
  exit 1
fi
rm -f "${preflight_report}"

# Off-host upload and Parquet projection are deliberately restarted only after
# the database archive seed and high-rate collector warmup. They are durable
# maintenance lanes, not prerequisites that may contend with cohort startup.
systemctl enable --now \
  deltaforge-google-drive-archive.timer \
  deltaforge-parquet-lake.timer
maintenance_timers_drained=false

# The persistent generic timer may be overdue after a maintenance drain. Enable
# it only after same-epoch collectors have passed their warmup, otherwise a
# correct 60-second startup window is recorded as a platform failure.
systemctl reset-failed deltaforge-health.service >/dev/null 2>&1 || true
systemctl start deltaforge-health.service
systemctl enable --now deltaforge-health.timer

# Record the first sample only after the unrecorded preflight is green. The
# timer may then become immediately due without contaminating the cohort.
systemctl start deltaforge-evidence-health.service
systemctl enable --now deltaforge-evidence-health.timer

echo "started evidence epoch ${epoch_id} at ${epoch_start}"
