#!/usr/bin/env bash
# Deploy / update mcp-all-in-one on the remote server (宝塔环境).
# Run from local:  bash deploy/baota/deploy.sh
# Or run on the server directly.

set -euo pipefail

APP_DIR="/opt/mcp-all-in-one"
SERVICE_NAME="mcp-all-in-one"   # 仅作日志标识；宝塔走 Node 项目管理器

cd "$APP_DIR"

echo "==> Pulling latest code"
git pull --rebase --autostash

echo "==> Installing deps"
npm ci --omit=dev

echo "==> Building"
npm run build

echo "==> Done. Now restart the Node project in 宝塔 -> Node 项目管理器."
echo "    Service name: $SERVICE_NAME"
echo
echo "==> Health check"
curl -fsS http://127.0.0.1:3000/health && echo
