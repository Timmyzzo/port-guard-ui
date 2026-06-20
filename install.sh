#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${PORT_GUARD_BASE_URL:-https://raw.githubusercontent.com/Timmyzzo/port-guard-ui/refs/heads/main}"
APP_DIR="/opt/port-guard-ui"
CONFIG_DIR="/etc/port-guard-ui"
BACKUP_DIR="/var/backups/port-guard-ui"
ENV_FILE="/etc/port-guard-ui.env"
SERVICE_FILE="/etc/systemd/system/port-guard-ui.service"
PORT="${PORT_GUARD_PORT:-8787}"
SSH_PORT="${PORT_GUARD_SSH_PORT:-22}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run with root privileges, for example: curl -fsSL ... | sudo bash"
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This installer supports Debian/Ubuntu only."
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd is required."
  exit 1
fi

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates curl python3 iptables ipset iproute2
DEBIAN_FRONTEND=noninteractive apt-get install -y netfilter-persistent || true

python3 - <<'PY'
import sys
if sys.version_info < (3, 10):
    raise SystemExit("Python 3.10 or newer is required.")
PY

install -d -m 0755 "$APP_DIR" "$APP_DIR/static" "$CONFIG_DIR" "$BACKUP_DIR"
curl -fsSL "$BASE_URL/server.py" -o "$APP_DIR/server.py"
curl -fsSL "$BASE_URL/static/index.html" -o "$APP_DIR/static/index.html"
curl -fsSL "$BASE_URL/static/app.js" -o "$APP_DIR/static/app.js"
curl -fsSL "$BASE_URL/static/styles.css" -o "$APP_DIR/static/styles.css"
curl -fsSL "$BASE_URL/examples/port-guard-ui.service" -o "$SERVICE_FILE"

SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"

cat > "$ENV_FILE" <<ENV
PORT_GUARD_HOME=$APP_DIR
PORT_GUARD_CONFIG_DIR=$CONFIG_DIR
PORT_GUARD_BACKUP_DIR=$BACKUP_DIR
PORT_GUARD_BIND=0.0.0.0
PORT_GUARD_PORT=$PORT
PORT_GUARD_SECRET=$SECRET
PORT_GUARD_DEFAULT_PASSWORD=admin
PORT_GUARD_SAFE_INPUT_PORTS=$SSH_PORT
PORT_GUARD_INIT_OPEN_LISTENING=1
ENV
chmod 600 "$ENV_FILE"

systemctl daemon-reload
systemctl enable port-guard-ui
systemctl restart port-guard-ui

SERVER_IP="$(curl -fsS --max-time 4 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"

echo
echo "Port Guard UI installed."
echo "URL: http://${SERVER_IP:-YOUR_SERVER_IP}:$PORT"
echo "Default password: admin"
echo "Change the password in Settings after login."
