#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "start-evidence-epoch.sh must run as root" >&2
  exit 1
fi

epoch_id="${1:-money-finding-$(date -u +%Y-%m-%d)-v11}"
if [[ ! "${epoch_id}" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "epoch id may contain only letters, numbers, dot, underscore and dash" >&2
  exit 1
fi

minimum_free_gib="${BORG_EPOCH_MIN_FREE_GIB:-30}"
warmup_timeout_sec="${BORG_EPOCH_WARMUP_TIMEOUT_SEC:-240}"
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
  polymarket-flow.service

epoch_start="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
tmp_file="$(mktemp /etc/deltaforge/evidence-epoch.env.XXXXXX)"
trap 'rm -f "${tmp_file}"' EXIT

{
  printf 'BORG_COLLECTION_EPOCH_ID=%s\n' "${epoch_id}"
  printf 'BORG_COLLECTION_EPOCH_START=%s\n' "${epoch_start}"
  printf 'BORG_COLLECTION_LOCATION=dublin-ie\n'
  printf 'BORG_COLLECTION_CODE_VERSION=storage-partitioned-priority-lanes-v11\n'
  printf 'BORG_COLLECTION_EPOCH_REASON=post-storage-repair-frozen-five-lane-forward-epoch\n'
  printf 'BORG_INCLUDE_PARKED_CONTROLS=false\n'
} >"${tmp_file}"

chmod 0600 "${tmp_file}"
chown root:root "${tmp_file}"
mv -f "${tmp_file}" /etc/deltaforge/evidence-epoch.env
trap - EXIT

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
  exit 1
fi
rm -f "${preflight_report}"

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
