#!/usr/bin/env bash
# ============================================================
# mcp-all-in-one — 新服务器一次性初始化（迁移 / 重装用）
# ------------------------------------------------------------
# 之后每次 push 到 main，GitHub Actions (cd.yml) 会自动：
#   git pull -> npm ci -> build -> pm2 restart
# 本脚本只需在换机器 / 重装宝塔时跑一次。
#
# 用法：
#   ssh yunmiao@<新服务器>
#   bash -s < deploy/bootstrap.sh        # 或从仓库 clone 后本地执行
# ============================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/mcp-all-in-one}"
ENV_FILE="/etc/mcp-all-in-one/mcp-all-in-one.env"
REPO="git@github.com:moonlight2893267956/all-in-one.git"

echo "==> [0/4] GitHub 拉取权限（deploy key）"
echo "    cd.yml 部署时会执行 'git pull'，服务器必须能自行拉取 GitHub 代码。"
echo "    请生成一把只读 deploy key 并加到仓库："
echo "      Settings -> Deploy keys -> Add (勾选 Allow write? 不勾)"
echo
if [ ! -f ~/.ssh/mcp_deploy ]; then
  ssh-keygen -t ed25519 -f ~/.ssh/mcp_deploy -N "" -C "mcp-all-in-one-deploy@$(hostname)"
fi
echo "    ↓↓↓ 把下面这段公钥粘贴到 GitHub 仓库的 Deploy keys ↓↓↓"
cat ~/.ssh/mcp_deploy.pub
echo "    ↑↑↑"
echo "    然后在 ~/.ssh/config 增加（让 git@github.com 走这把 key）："
echo "      Host github.com"
echo "        IdentityFile ~/.ssh/mcp_deploy"
echo
read -r -p "    已添加 deploy key 并配置好 ~/.ssh/config ? (y/N) " ok
[ "${ok:-N}" = "y" ] || { echo "    先完成 deploy key 配置再继续。"; exit 1; }

echo "==> [1/4] clone 代码到 $APP_DIR"
sudo mkdir -p "$APP_DIR"
sudo chown "$USER:$USER" "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  echo "    已存在 clone，跳过。"
else
  git clone "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"

echo "==> [2/4] 安装依赖 + 构建"
# 兼容 nvm 与宝塔 node
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  source "$HOME/.nvm/nvm.sh"
elif [ -d /www/server/nodejs ]; then
  export PATH="$(ls -d /www/server/nodejs/*/bin | head -1):$PATH"
fi
node -v; npm -v
npm ci --omit=dev
npm run build

echo "==> [3/4] 环境变量文件"
sudo mkdir -p /etc/mcp-all-in-one
if [ ! -f "$ENV_FILE" ]; then
  sudo cp deploy/baota/mcp-all-in-one.env.example "$ENV_FILE"
  sudo chown "root:$USER" "$ENV_FILE"
  sudo chmod 640 "$ENV_FILE"
  echo "    已生成模板 $ENV_FILE，请编辑填写：AUTH_TOKEN / TAVILY_API_KEY / PORT 等"
  echo "    sudo vim $ENV_FILE"
else
  echo "    $ENV_FILE 已存在，保留。"
fi

echo "==> [4/4] pm2 启动"
if pm2 describe mcp-all-in-one >/dev/null 2>&1; then
  pm2 restart mcp-all-in-one
else
  pm2 start ecosystem.config.cjs
  pm2 save
  pm2 startup systemd -u "$USER" --hp "$HOME"
  echo "    上面若打印了 systemctl enable 命令，请按提示执行一次，保证开机自启。"
fi

echo
echo "==> 验证"
curl -fsS "http://127.0.0.1:${PORT:-3030}/health" && echo
echo "==> 别忘了在宝塔面板配置 Nginx 反代（复用 deploy/baota/mcp-location-block.conf）。"
