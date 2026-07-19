#!/bin/bash
set -euo pipefail

HOST="${DELTAFORGE_VPS_HOST:-deltaforge-vps}"
ACTION="${1:-status}"
ACK_ARG="${2:-}"
LOCAL_KEY="${FLOW_BOUNDARY_LOCAL_KEY:-$HOME/.deltaforge-live/active-account.json}"
REMOTE_KEY="/home/deltaforge/.deltaforge-live/active-account.json"
ACK="I_ACCEPT_UNPROVEN_FLOW_CANARY"

case "$ACTION" in
  status)
    ssh "$HOST" "systemctl --no-pager --full status flow-boundary-canary.service | sed -n '1,24p'; \
      sudo -n -u postgres psql -d deltaforge -Atqc \"SELECT 'db_gate='||COALESCE(live_flow_boundary_enabled,false) FROM bot_settings WHERE user_id=1\"; \
      sudo -n -u postgres psql -d deltaforge -P pager=off -c \"SELECT dry_run,status,count(*) n,round(COALESCE(sum(requested_notional),0),2) notional FROM flow_boundary_canary_orders GROUP BY 1,2 ORDER BY 1,2\""
    ;;
  install-key)
    test -f "$LOCAL_KEY" || { echo "Missing local key: $LOCAL_KEY" >&2; exit 1; }
    test "$(stat -f '%Lp' "$LOCAL_KEY")" = "600" || { echo "Local key must be chmod 600" >&2; exit 1; }
    ssh "$HOST" "install -d -m 700 /home/deltaforge/.deltaforge-live"
    scp -q "$LOCAL_KEY" "$HOST:$REMOTE_KEY.new"
    ssh "$HOST" "chmod 600 '$REMOTE_KEY.new' && mv '$REMOTE_KEY.new' '$REMOTE_KEY'"
    echo "Installed key at $HOST:$REMOTE_KEY (mode 600). The canary is still disabled."
    ;;
  arm)
    test "$ACK_ARG" = "--i-accept-unproven-edge" || {
      echo "Refusing. Use: $0 arm --i-accept-unproven-edge" >&2
      exit 2
    }
    ssh "$HOST" "test -f '$REMOTE_KEY' && test ! -e /home/deltaforge/.deltaforge-live/KILL && test ! -e /home/deltaforge/.deltaforge-live/FLOW_BOUNDARY_KILL"
    ssh "$HOST" "sudo -n bash -c 'umask 077; cat > /etc/deltaforge/flow-boundary-live.env <<EOF
FLOW_BOUNDARY_LIVE_ENABLED=1
FLOW_BOUNDARY_LIVE_ACK=$ACK
POLYMARKET_KEY_FILE=$REMOTE_KEY
EOF
chown root:deltaforge /etc/deltaforge/flow-boundary-live.env
chmod 640 /etc/deltaforge/flow-boundary-live.env
sudo -u postgres psql -d deltaforge -v ON_ERROR_STOP=1 -c \"UPDATE bot_settings SET live_flow_boundary_enabled=true WHERE user_id=1\"
systemctl restart flow-boundary-canary.service'"
    echo "Armed. Hard rails remain: <=\$10/order, <=3 orders and <=\$30 gross spend per UTC day."
    ;;
  disarm)
    ssh "$HOST" "sudo -n bash -c 'umask 077; cat > /etc/deltaforge/flow-boundary-live.env <<EOF
FLOW_BOUNDARY_LIVE_ENABLED=0
EOF
chown root:deltaforge /etc/deltaforge/flow-boundary-live.env
chmod 640 /etc/deltaforge/flow-boundary-live.env
sudo -u postgres psql -d deltaforge -v ON_ERROR_STOP=1 -c \"UPDATE bot_settings SET live_flow_boundary_enabled=false WHERE user_id=1\"
systemctl restart flow-boundary-canary.service'"
    echo "Disarmed; the service remains a live-market dry observer."
    ;;
  kill)
    ssh "$HOST" "install -d -m 700 /home/deltaforge/.deltaforge-live && touch /home/deltaforge/.deltaforge-live/FLOW_BOUNDARY_KILL; sudo -n systemctl restart flow-boundary-canary.service"
    echo "KILL set."
    ;;
  clear-kill)
    ssh "$HOST" "rm -f /home/deltaforge/.deltaforge-live/FLOW_BOUNDARY_KILL"
    echo "Strategy KILL removed; this does not arm either live gate."
    ;;
  *)
    echo "Usage: $0 {status|install-key|arm --i-accept-unproven-edge|disarm|kill|clear-kill}" >&2
    exit 2
    ;;
esac
