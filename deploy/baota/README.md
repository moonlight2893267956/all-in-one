# 宝塔面板 (BT Panel) 部署步骤
#
# 假设你已经在宝塔里：
#   1) 装了 Node.js 版本管理器（>= Node 18）
#   2) 申请并部署了 npm.yunmiao.site 的证书
#   3) 有 sudo 权限的 yunmiao 用户
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
#   npm ci --omit=dev
#   npm run build
#
# ===== 2. 创建环境变量文件 =====
#
#   sudo mkdir -p /etc/mcp-all-in-one
#   sudo cp /opt/mcp-all-in-one/deploy/baota/mcp-all-in-one.env.example \
#           /etc/mcp-all-in-one/mcp-all-in-one.env
#   sudo vim /etc/mcp-all-in-one/mcp-all-in-one.env   # 填 AUTH_TOKEN 和 TAVILY_API_KEY
#   sudo chmod 600 /etc/mcp-all-in-one/mcp-all-in-one.env
#   sudo chown root:root /etc/mcp-all-in-one/mcp-all-in-one.env
#
# ===== 3. 宝塔添加 Node 项目 =====
#
#   宝塔面板 -> 网站 -> 添加 Node 项目
#     - 项目名称:  mcp-all-in-one
#     - 路径:      /opt/mcp-all-in-one
#     - 启动文件:  build/index.js
#     - 启动选项:  http
#     - 端口:      3000
#     - 运行环境:  production
#
#   ⚠️ 关键：宝塔 Node 项目管理器的「启动选项」是拼到启动命令后面的，
#            命令实际是 `node build/index.js http`。
#            端口、host、auth token 走环境变量，不在启动选项里。
#
#   宝塔里把「环境变量」字段填上：
#     PORT=3000
#     HOST=127.0.0.1
#     AUTH_TOKEN=<你的 token>
#     TAVILY_API_KEY=tvly-xxx
#
#   或者更简单：把环境变量写进 /etc/mcp-all-in-one/mcp-all-in-one.env，
#   启动命令改成：
#     bash -c 'set -a; source /etc/mcp-all-in-one/mcp-all-in-one.env; set +a; node build/index.js http'
#
# ===== 4. 配置 Nginx vhost =====
#
#   宝塔 -> 网站 -> npm.yunmiao.site -> 配置文件
#   把 deploy/baota/mcp-all-in-one.nginx.conf 的内容追加进去（或替换 location / 部分）
#   宝塔自带重载 Nginx 按钮即可。
#
# ===== 5. 验证 =====
#
#   curl https://npm.yunmiao.site/health
#   # {"status":"ok","version":"1.0.0"}
#
#   curl -X POST https://npm.yunmiao.site/mcp \
#     -H "Authorization: Bearer $AUTH_TOKEN" \
#     -H "Content-Type: application/json" \
#     -H "Accept: application/json, text/event-stream" \
#     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"check","version":"0"}}}'
#
# ===== 6. 后续更新 =====
#
#   ssh yunmiao@81.70.216.46
#   cd /opt/mcp-all-in-one
#   git pull --rebase
#   npm ci --omit=dev && npm run build
#   # 宝塔 Node 项目管理器点「重启」
