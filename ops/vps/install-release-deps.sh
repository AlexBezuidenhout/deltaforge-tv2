#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "install-release-deps.sh must run as root" >&2
  exit 1
fi

release="${1:-$(basename "$(readlink -f /opt/deltaforge/tv2/current)")}"
if [[ ! "${release}" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "release may contain only letters, numbers, dot, underscore and dash" >&2
  exit 1
fi

app="/opt/deltaforge/tv2/releases/${release}"
research="/var/lib/deltaforge/research-tools/${release}"
for root in "${app}" "${research}"; do
  if [[ ! -f "${root}/package.json" || ! -f "${root}/package-lock.json" ]]; then
    echo "release dependency manifest is missing under ${root}" >&2
    exit 1
  fi
done

lock_hash="$(sha256sum "${app}/package-lock.json" | cut -d' ' -f1)"
dependency_id="${lock_hash:0:16}"
dependency_root="/opt/deltaforge/tv2/deps/${dependency_id}"

if [[ ! -d "${dependency_root}/node_modules" ]]; then
  stage="$(mktemp -d "/opt/deltaforge/tv2/deps/.${dependency_id}.XXXXXX")"
  trap 'rm -rf "${stage}"' EXIT
  install -o deltaforge -g deltaforge -m 0644 "${app}/package.json" "${stage}/package.json"
  install -o deltaforge -g deltaforge -m 0644 "${app}/package-lock.json" "${stage}/package-lock.json"
  runuser -u deltaforge -- npm ci --omit=dev --no-audit --no-fund --prefix "${stage}"
  mv "${stage}" "${dependency_root}"
  trap - EXIT
fi

for root in "${app}" "${research}"; do
  ln -sfn "${dependency_root}/node_modules" "${root}/node_modules"
  chown -h deltaforge:deltaforge "${root}/node_modules"
done

runuser -u deltaforge -- bash -lc \
  "cd '${research}' && /usr/local/bin/node -e \"require.resolve('@duckdb/node-api')\""

echo "installed dependency set ${dependency_id} for release ${release}"
