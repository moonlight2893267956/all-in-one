#!/usr/bin/env bash
# Deploy / update mcp-all-in-one on the remote server.
# Run from local: ssh user@host 'bash -s' < deploy/scripts/deploy.sh
# Or run on the server directly.

set -euo pipefail

APP_DIR="/opt/mcp-all-in-one"
SERVICE_NAME="mcp-all-in-one"

cd "$APP_DIR"

echo "==> Pulling latest code"
git pull --rebase --autostash

echo "==> Installing deps"
npm ci --omit=dev

echo "==> Building"
npm run build

echo "==> Fixing ownership"
sudo chown -R www-data:www-data "$APP_DIR"

echo "==> Restarting service"
sudo systemctl restart "$SERVICE_NAME"
sleep 2
sudo systemctl status "$SERVICE_NAME" --no-pager

echo "==> Health check"
curl -fsS http://127.0.0.1:3000/health && echo
