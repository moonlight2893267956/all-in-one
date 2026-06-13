#!/usr/bin/env bash
# Deploy / update mcp-all-in-one on the remote server (宝塔环境).
# Run from local:  bash deploy/baota/deploy.sh
# Or run on the server directly.
#
# 默认端口 3000。如果被占，可以传参：PORT=3030 bash deploy/baota/deploy.sh

set -euo pipefail

APP_DIR="/opt/mcp-all-in-one"
SERVICE_NAME="mcp-all-in-one"   # 仅作日志标识；宝塔走 Node 项目管理器
PORT="${PORT:-3000}"

cd "$APP_DIR"

echo "==> Pulling latest code"
git pull --rebase --autostash

echo "==> Installing deps"
npm ci --omit=dev

echo "==> Building"
npm run build

echo "==> Done. Now restart the Node project in 宝塔 -> Node 项目管理器."
echo "    Service name: $SERVICE_NAME"
echo "    Listening on port: $PORT"
echo
echo "==> Health check (after restart)"
curl -fsS "http://127.0.0.1:${PORT}/health" && echo
