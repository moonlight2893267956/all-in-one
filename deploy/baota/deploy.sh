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

echo "==> Ensuring npm cache is writable"
# 宝塔默认把 /www/server/nodejs/cache owner 设为 1004:1005，
# 普通 yunmiao 用户写不进去，会导致 npm ci / npm run build 失败。
# 有 sudo 就修一下；没有就跳过（不影响 git pull，只会让 npm 步骤报错）。
if sudo -n true 2>/dev/null; then
  sudo chown -R 1004:1005 /www/server/nodejs/cache || \
    echo "    (chown failed, continuing — npm 步骤可能会报错)"
else
  echo "    (no passwordless sudo, skipping chown)"
fi

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
