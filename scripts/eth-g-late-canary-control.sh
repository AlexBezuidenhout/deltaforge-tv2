#!/bin/bash
set -euo pipefail

HOST="${DELTAFORGE_VPS_HOST:-deltaforge-vps}"
ACTION="${1:-status}"
ACK_ARG="${2:-}"
REMOTE_KEY="/home/deltaforge/.deltaforge-live/active-account.json"
ACK="I_ACCEPT_UNPROVEN_POSTHOC_ETH_G_LATE_LIVE"

case "$ACTION" in
  status)
    ssh "$HOST" "systemctl --no-pager --full status eth-g-late-canary.service | sed -n '1,26p'; \
      sudo -n -u postgres psql -d deltaforge -Atqc \"SELECT 'db_gate='||COALESCE(live_eth_g_late_enabled,false) FROM bot_settings WHERE user_id=1\"; \
      sudo -n -u postgres psql -d deltaforge -P pager=off -c \"SELECT dry_run,status,count(*) n,round(COALESCE(sum(requested_notional),0),2) requested,round(COALESCE(sum(realized_pnl),0),2) realized FROM eth_g_late_live_orders GROUP BY 1,2 ORDER BY 1,2\"; \
      curl -fsS --max-time 10 https://polymarket.com/api/geoblock"
    ;;
  arm)
    test "$ACK_ARG" = "--i-accept-unproven-edge" || {
      echo "Refusing. Use: $0 arm --i-accept-unproven-edge" >&2
      exit 2
    }
    geo="$(ssh "$HOST" "curl -fsS --max-time 10 https://polymarket.com/api/geoblock")"
    GEO="$geo" node -e '
      const value = JSON.parse(process.env.GEO);
      if (value.blocked !== false) {
        console.error(`Refusing: Polymarket geoblock is not explicitly clear (country=${value.country || "unknown"}).`);
        process.exit(3);
      }
    '
    ssh "$HOST" "test -f '$REMOTE_KEY' && test ! -e /home/deltaforge/.deltaforge-live/KILL && test ! -e /home/deltaforge/.deltaforge-live/ETH_G_LATE_KILL"
    ssh "$HOST" "sudo -n bash -c 'umask 077; cat > /etc/deltaforge/eth-g-late-live.env <<EOF
ETH_G_LATE_LIVE_ENABLED=1
ETH_G_LATE_LIVE_ACK=$ACK
POLYMARKET_KEY_FILE=$REMOTE_KEY
EOF
chown root:deltaforge /etc/deltaforge/eth-g-late-live.env
chmod 640 /etc/deltaforge/eth-g-late-live.env
sudo -u postgres psql -d deltaforge -v ON_ERROR_STOP=1 -c \"UPDATE bot_settings SET live_eth_g_late_enabled=true WHERE user_id=1\"
systemctl restart eth-g-late-canary.service'"
    echo "Armed. This is an unproven venue-minimum canary, not a \$22/day forecast."
    ;;
  disarm)
    ssh "$HOST" "sudo -n bash -c 'umask 077; cat > /etc/deltaforge/eth-g-late-live.env <<EOF
ETH_G_LATE_LIVE_ENABLED=0
EOF
chown root:deltaforge /etc/deltaforge/eth-g-late-live.env
chmod 640 /etc/deltaforge/eth-g-late-live.env
sudo -u postgres psql -d deltaforge -v ON_ERROR_STOP=1 -c \"UPDATE bot_settings SET live_eth_g_late_enabled=false WHERE user_id=1\"
systemctl restart eth-g-late-canary.service'"
    echo "Disarmed; the service remains a live-market dry observer."
    ;;
  kill)
    ssh "$HOST" "install -d -m 700 -o deltaforge -g deltaforge /home/deltaforge/.deltaforge-live && \
      sudo -u deltaforge touch /home/deltaforge/.deltaforge-live/ETH_G_LATE_KILL && \
      sudo -n systemctl restart eth-g-late-canary.service"
    echo "ETH G-late KILL set."
    ;;
  clear-kill)
    ssh "$HOST" "rm -f /home/deltaforge/.deltaforge-live/ETH_G_LATE_KILL"
    echo "Strategy KILL removed; this does not arm either live gate."
    ;;
  *)
    echo "Usage: $0 {status|arm --i-accept-unproven-edge|disarm|kill|clear-kill}" >&2
    exit 2
    ;;
esac
