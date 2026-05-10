#!/usr/bin/env bash
#
# Install / update Mehen on a managed server.
#
# Idempotent. Safe to re-run for upgrades — pulls origin/main, rebuilds,
# leaves the existing /etc/abydos-ops.env untouched.
#
# Usage on a new server:
#   curl -fsSL https://raw.githubusercontent.com/chriscase/mehen/main/scripts/install.sh | sudo bash
#
# Or, with the repo already cloned to /srv/ops:
#   cd /srv/ops && git pull && ./scripts/install.sh

set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/srv/ops}"
CONFIG_PATH="${CONFIG_PATH:-/etc/abydos-ops.env}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

if [ -z "$NODE_BIN" ]; then
  echo "ERROR: node not found on PATH. Install Node.js >=20 first." >&2
  exit 1
fi

echo "==> Installing Mehen at $INSTALL_DIR"

if [ ! -d "$INSTALL_DIR/.git" ]; then
  echo "  cloning chriscase/mehen..."
  git clone https://github.com/chriscase/mehen.git "$INSTALL_DIR"
else
  echo "  pulling latest..."
  git -C "$INSTALL_DIR" pull --ff-only origin main
fi

cd "$INSTALL_DIR"

echo "==> Installing dependencies (production only)"
npm ci --omit=dev --silent || npm install --omit=dev --silent

echo "==> Building"
# Need devDeps (typescript) for build; install fully then prune.
npm install --silent
npm run build
npm prune --omit=dev --silent

echo "==> Linking /usr/local/bin/mehen → $INSTALL_DIR/bin/mehen.js"
ln -sf "$INSTALL_DIR/bin/mehen.js" /usr/local/bin/mehen
chmod +x "$INSTALL_DIR/bin/mehen.js"

if [ ! -f "$CONFIG_PATH" ]; then
  echo
  echo "==> No config at $CONFIG_PATH — writing template (mode 600)"
  cat > "$CONFIG_PATH" << 'EOF'
# Mehen agent config. Keep root-owned, mode 600.
# See https://github.com/chriscase/mehen#configuration

MEHEN_BACKEND_URL=https://mehen.abydonian.com
MEHEN_AGENT_KEY_ID=
MEHEN_AGENT_KEY_HASH=
MEHEN_ENTITY_ID=
MEHEN_DEPLOY_HOST=

# Comma-separated DB names for nightly backup
MEHEN_BACKUP_DBS=
MEHEN_BACKUP_DIR=/srv/apps/backups
MEHEN_BACKUP_RETAIN_DAYS=7
# Optional: PG role (peer auth via sudo if unset)
# MEHEN_PG_USER=postgres

# Linode Object Storage (optional — backups stay local-only without these)
MEHEN_S3_ENDPOINT=https://us-iad-10.linodeobjects.com
MEHEN_S3_REGION=us-iad-1
MEHEN_S3_BUCKET=chriscase-server-backups
MEHEN_S3_ACCESS_KEY=
MEHEN_S3_SECRET_KEY=
EOF
  chown root:root "$CONFIG_PATH" 2>/dev/null || true
  chmod 600 "$CONFIG_PATH"
  echo "  template written. Fill in the blanks before running 'mehen backup'."
fi

echo
echo "==> Done. Verify with:"
echo "    mehen --version"
echo "    mehen config"
echo "    mehen backup --dry-run"
echo
echo "When ready, add to root's crontab:"
echo "    0 3 * * * /usr/local/bin/mehen backup >> /var/log/mehen.log 2>&1"
