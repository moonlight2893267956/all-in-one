# mcp-all-in-one

Multi-tool MCP (Model Context Protocol) server. Unified service framework that
exposes a growing collection of tools to MCP-compatible clients (Claude
Desktop, Cursor, Cline, opencode, etc.).

Supports two transports:

- **stdio** — local use, launched as a subprocess by the client
- **Streamable HTTP** — remote deployment, exposed via HTTPS behind Nginx

## Tools

| Name | Description |
| --- | --- |
| `tavily_search` | Web search via the Tavily API (basic / advanced depth, optional AI summary) |
| `current_date` | Returns the current date / time / timestamp in a configurable IANA timezone |
| `image_understand` | Vision-language understanding of an image (DashScope qwen3-vl-flash / qwen-vl-plus / qwen-vl-max) |
| `image_generate` | Text-to-image generation (NewAPI gpt-image-2 default; DashScope qwen-image/wan2.7 fallback) |
| `cos_upload` | Upload a file, base64, or text blob to Tencent Cloud COS |
| `cos_download` | Download a COS object to the server filesystem |
| `cos_list` | List objects in a COS bucket (with prefix filter) |
| `cos_delete` | Delete one or more COS objects |
| `hexo_list` | List recent Hexo blog posts (newest first, with parsed date + slug) |
| `hexo_publish` | Publish or update a Hexo post; auto-builds front matter and runs `hexo generate` |
| `hexo_delete` | Delete a Hexo post by filename (requires `confirm: true`) and regenerate |
| `hexo_rebuild` | Full clean + regenerate the entire blog (use after theme/config edits) |

## Quick start (local, stdio)

```bash
npm install
npm run build

TAVILY_API_KEY=tvly-... node build/index.js
```

### Client config (stdio)

```json
{
  "mcpServers": {
    "mcp-all-in-one": {
      "command": "node",
      "args": ["/abs/path/to/mcp-all-in-one/build/index.js"],
      "env": {
        "TAVILY_API_KEY": "tvly-..."
      }
    }
  }
}
```

## Remote deployment (Streamable HTTP)

Architecture:

```
[Claude Desktop]  ──HTTPS──>  [宝塔 Nginx :443]  ──>  [mcp-all-in-one :3000 (127.0.0.1)]
                                                  (宝塔 Node 项目管理器)
```

### 宝塔面板部署

完整步骤见 [`deploy/baota/README.md`](deploy/baota/README.md)。简要版：

```bash
# 1. 上传 / 克隆代码
ssh yunmiao@81.70.216.46
sudo mkdir -p /opt/mcp-all-in-one && sudo chown $USER:$USER /opt/mcp-all-in-one
cd /opt/mcp-all-in-one
git clone git@github.com:moonlight2893267956/all-in-one.git .
npm ci --omit=dev && npm run build

# 2. 环境变量
sudo cp deploy/baota/mcp-all-in-one.env.example /etc/mcp-all-in-one/mcp-all-in-one.env
sudo vim /etc/mcp-all-in-one/mcp-all-in-one.env   # 填 AUTH_TOKEN / TAVILY_API_KEY
sudo chmod 600 /etc/mcp-all-in-one/mcp-all-in-one.env

# 3. 宝塔面板 -> 网站 -> 添加 Node 项目
#    路径: /opt/mcp-all-in-one  启动文件: build/index.js
#    启动选项: http   端口: 3000
#    「环境变量」字段直接贴 /etc/mcp-all-in-one/mcp-all-in-one.env 的内容
#    或者启动命令改为：
#      bash -c 'set -a; source /etc/mcp-all-in-one/mcp-all-in-one.env; set +a; \
#               exec node build/index.js http'

# 4. 宝塔 -> 网站 -> nps.yunmiao.site -> 配置文件
#    把 deploy/baota/mcp-all-in-one.nginx.conf 里的 location /mcp 和 /health 追加进去

# 5. 验证
curl https://nps.yunmiao.site/health
```

### 非宝塔 / 裸机部署

如果服务器没有宝塔，用 `deploy/alt/systemd/` 里的 systemd unit + `deploy/alt/systemd/` 旁边的 nginx 模板。

## Client config (remote HTTP)

Replace `stdio` config with HTTP:

```json
{
  "mcpServers": {
    "mcp-all-in-one": {
      "url": "https://nps.yunmiao.site/mcp",
      "headers": {
        "Authorization": "Bearer <AUTH_TOKEN>"
      }
    }
  }
}
```

> Most MCP clients (Claude Desktop ≥ 1.0, Cursor, Cline) now support the
> `url` + `headers` form. For older clients, use an MCP proxy such as
> `mcp-remote` to bridge stdio <-> HTTP.

## Project layout

```
src/
  index.ts           # CLI entry, transport selection
  server.ts          # MCP server factory + stdio / HTTP runners
  config.ts          # env helper
  tools/
    index.ts         # tool registry
    tavily-search.ts
    current-date.ts
deploy/
  systemd/           # systemd unit + env example
  nginx/             # nginx vhost
  scripts/           # deploy.sh
```

## Environment variables

| Var | Default | Used in |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP transport |
| `PORT` | `3030` | HTTP transport |
| `MCP_ENDPOINT` | `/mcp` | HTTP transport |
| `AUTH_TOKEN` | _(unset)_ | HTTP transport — required in production |
| `TAVILY_API_KEY` | _(unset)_ | `tavily_search` tool |
| `DASHSCOPE_API_KEY` (or `QWEN_API_KEY`) | _(unset)_ | `image_understand`, `image_generate` (fallback) |
| `DASHSCOPE_IMAGE_MODEL` | `qwen-image-2.0-pro` | `image_generate` (provider=dashscope) |
| `NEWAPI_API_KEY` | _(unset)_ | `image_generate` (provider=newapi, default) |
| `NEWAPI_BASE_URL` | `https://ai.centos.hk/v1` | `image_generate` (provider=newapi) |
| `NEWAPI_IMAGE_MODEL` | `gpt-image-2` | `image_generate` (provider=newapi) |
| `COS_SECRET_ID` / `COS_SECRET_KEY` | _(unset)_ | all 4 `cos_*` tools |
| `COS_BUCKET` | _(unset)_ | all 4 `cos_*` tools |
| `COS_REGION` | _(unset)_ | all 4 `cos_*` tools |
| `COS_PUBLIC_HOST` | _(unset)_ | public URL returned by `cos_upload` / `image_generate` |
| `HEXO_SOURCE_DIR` | `/home/yunmiao/apps/hexo-source` | `hexo_*` tools — Hexo source root |
| `HEXO_NVM_PATH` | `/home/yunmiao/.nvm/nvm.sh` | `hexo_*` tools — nvm.sh path to load before `npx hexo` |

## License

MIT
