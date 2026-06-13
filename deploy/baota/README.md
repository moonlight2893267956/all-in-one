# 宝塔面板 (BT Panel) 部署步骤
#
# 假设你已经在宝塔里：
#   1) 装了 Node.js 版本管理器（>= Node 18，建议 v20 LTS）
#   2) 申请并部署了 nps.yunmiao.site（或任意域名）的证书
#   3) 有 sudo 权限的 yunmiao 用户
#
# ===== 0. 选端口 =====
#
# 默认 3000。可以用 ss/netstat/lsof 看看是否被占：
#   ss -ltn | grep :3000
# 3000 被占就把下面的 3000 换成 3030 之类。
#
# ===== 1. 上传代码 =====
#
# 方式 A：宝塔文件管理器上传 zip 后解压到 /opt/mcp-all-in-one
# 方式 B：SSH 上去 git clone（推荐）
#
#   ssh yunmiao@81.70.216.46
#   sudo mkdir -p /opt/mcp-all-in-one
#   sudo chown $USER:$USER /opt/mcp-all-in-one
#   cd /opt/mcp-all-in-one
#   git clone git@github.com:moonlight2893267956/all-in-one.git .
#   npm ci --omit=dev && npm run build
#
# ===== 2. 创建环境变量文件 =====
#
#   sudo mkdir -p /etc/mcp-all-in-one
#   sudo cp /opt/mcp-all-in-one/deploy/baota/mcp-all-in-one.env.example \
#           /etc/mcp-all-in-one/mcp-all-in-one.env
#   sudo vim /etc/mcp-all-in-one/mcp-all-in-one.env   # 填 AUTH_TOKEN 和 TAVILY_API_KEY，注意 PORT
#   sudo chown root:yunmiao /etc/mcp-all-in-one/mcp-all-in-one.env
#   sudo chmod 640 /etc/mcp-all-in-one/mcp-all-in-one.env
#
# ===== 3. 用 PM2 启动（宝塔自带 pm2）======
#
#   export PATH=$PATH:/www/server/nodejs/v20.11.1/bin
#   pm2 start /opt/mcp-all-in-one/ecosystem.config.cjs
#   pm2 save
#   pm2 startup systemd -u yunmiao --hp /home/yunmiao
#   # 上一步会打印 systemctl enable pm2-yunmiao，按提示执行一次
#
# 验证：
#   pm2 list                          # mcp-all-in-one 应为 online
#   curl http://127.0.0.1:3030/health
#
# ===== 4. 配置 Nginx vhost =====
#
#   ⚠️ 如果域名（如 nps.yunmiao.site）已被占用、不要替换原 `location /`，
#   只在原 `location /` 之前插入 mcp 的精确匹配 location 块。
#
#   手动 patch（参考 deploy/baota/nps.yunmiao.site.patch.py）：
#   1) 备份 vhost：sudo cp .../nps.yunmiao.site.conf{,.bak-$(date +%Y%m%d)}
#   2) 在 `location / { ... }` 之前插入 deploy/baota/mcp-location-block.conf
#   3) sudo nginx -t && sudo nginx -s reload
#
# ===== 5. 验证 =====
#
#   curl https://nps.yunmiao.site/health
#   # {"status":"ok","version":"1.0.0"}
#
#   TOKEN=$(grep ^AUTH_TOKEN= /etc/mcp-all-in-one/mcp-all-in-one.env | cut -d= -f2)
#   curl -X POST https://nps.yunmiao.site/mcp \
#     -H "Authorization: Bearer $TOKEN" \
#     -H "Content-Type: application/json" \
#     -H "Accept: application/json, text/event-stream" \
#     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"check","version":"0"}}}'
#
# ===== 6. 后续更新 =====
#
#   ssh yunmiao@81.70.216.46
#   cd /opt/mcp-all-in-one
#   export PATH=$PATH:/www/server/nodejs/v20.11.1/bin
#   git pull --rebase
#   npm ci --omit=dev && npm run build
#   pm2 restart mcp-all-in-one
