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
| `shell_exec` | Run a shell command on the MCP server host. **Opt-in** — set `ENABLE_SHELL_EXEC=true` to enable. See [shell_exec safety notes](#shell_exec-safety) |

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
| `ENABLE_SHELL_EXEC` | `false` | `shell_exec` tool (must be `"true"` to enable) |
| `SHELL_EXEC_LOG` | `/var/log/mcp-shell-exec.log` | `shell_exec` audit log path |
| `SHELL_EXEC_PASSTHROUGH_ENVS` | _(unset)_ | `shell_exec` extra env keys to forward to child |

## License

MIT

## shell_exec safety

`shell_exec` runs a shell command on the MCP server host via `/bin/bash -c`.
The command runs as the same user the MCP process runs under (typically
`yunmiao` on the recommended 宝塔 deployment; prefix with `sudo` to elevate).

**Disabled by default.** To enable, set `ENABLE_SHELL_EXEC=true` in the MCP
process environment, then restart. While disabled, the tool is still listed
(in `tools/list`) but the handler returns an error explaining the flag.

### Safeguards (always on when enabled)

1. **Hard blacklist (cannot be overridden).** Refused unconditionally:
   - `rm -rf /` and `rm /` patterns
   - `mkfs.*`, `fdisk`, `parted`
   - `dd ... of=/dev/...`
   - Fork bomb `:(){ :|:& };:`
   - `chmod 777 /`, `chmod -R ... /`
   - `curl|sh`, `curl|bash`, `wget|sh`
   - Output redirect to `/dev/sd[a-z]`
   - `mv xxx /`
   - `shutdown`, `reboot`, `poweroff`, `halt`, `init 0|6`

2. **Soft-destructive list (requires `confirm: true`).** Without the flag, the
   tool returns an error listing the verb:
   `rm`, `mv`, `chmod`, `chown`, `killall`, `pkill`, `drop`, `truncate`,
   `systemctl stop|disable|mask|restart`, `pm2 delete|stop|reload|reset|kill`.

3. **Working-directory guard.** `cwd` must be an absolute path. Refused if it
   resolves to `/`, `/etc`, or `/boot`. Default `/tmp`.

4. **Timeout.** Default 30 s, max 5 min. On timeout, child gets `SIGTERM`,
   then `SIGKILL` after a 5-second grace period.

5. **Output cap.** stdout and stderr are each truncated at 5 MB to avoid OOM.

6. **Environment sanitization.** The child process does NOT inherit the MCP
   process's environment. It only sees `PATH`, `LANG`, `LC_*`, `HOME`, `TZ`,
   `TERM`, plus any keys listed in `SHELL_EXEC_PASSTHROUGH_ENVS` (comma-separated).
   This prevents accidental leakage of `NEWAPI_API_KEY`, `DASHSCOPE_API_KEY`,
   `COS_*`, `TAVILY_API_KEY`, etc. to spawned processes.

7. **Audit log.** Every invocation appends one line to
   `SHELL_EXEC_LOG` (default `/var/log/mcp-shell-exec.log`):
   ```
   <ISO ts>  uid=<n>  cwd=<path>  exit=<code>  signal=<sig>  timed_out=<bool>  duration_ms=<n>  bytes_out=<n>  bytes_err=<n>  cmd=<json-quoted-cmd>
   ```
   Log writes are best-effort; a write failure does not fail the call.

### Example

```json
{
  "name": "shell_exec",
  "arguments": {
    "command": "pm2 list && tail -n 50 /tmp/mcp-err.log",
    "cwd": "/opt/mcp-all-in-one",
    "timeout_ms": 15000
  }
}
```

Destructive example (refused without `confirm`):

```json
{
  "name": "shell_exec",
  "arguments": {
    "command": "rm -f /tmp/junk.txt",
    "confirm": true
  }
}
```
