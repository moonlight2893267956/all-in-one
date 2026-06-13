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
[Claude Desktop]  ──HTTPS──>  [Nginx :443]  ──>  [mcp-all-in-one :3000 (127.0.0.1)]
                                                  (systemd)
```

### 1. Server prerequisites

- Node.js ≥ 18
- Nginx
- (optional) Certbot for Let's Encrypt

### 2. Install the app

```bash
sudo mkdir -p /opt/mcp-all-in-one
sudo chown -R $USER:$USER /opt/mcp-all-in-one
cd /opt/mcp-all-in-one
git clone git@github.com:moonlight2893267956/all-in-one.git .
npm ci --omit=dev
npm run build
```

### 3. Configure environment

```bash
sudo mkdir -p /etc/mcp-all-in-one
sudo cp deploy/systemd/mcp-all-in-one.env.example /etc/mcp-all-in-one/mcp-all-in-one.env
sudo vim /etc/mcp-all-in-one/mcp-all-in-one.env   # fill in AUTH_TOKEN, TAVILY_API_KEY
```

Generate a strong token:

```bash
openssl rand -hex 32
```

Lock down the file:

```bash
sudo chmod 600 /etc/mcp-all-in-one/mcp-all-in-one.env
sudo chown root:www-data /etc/mcp-all-in-one/mcp-all-in-one.env
```

### 4. Install the systemd service

```bash
sudo cp deploy/systemd/mcp-all-in-one.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mcp-all-in-one
sudo systemctl status mcp-all-in-one
sudo journalctl -u mcp-all-in-one -f
```

### 5. Install Nginx + TLS

```bash
# Issue cert first
sudo certbot --nginx -d npm.yunmiao.site

# Then install the vhost
sudo cp deploy/nginx/mcp-all-in-one.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/mcp-all-in-one.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 6. Verify

```bash
# Health check (no auth)
curl https://npm.yunmiao.site/health
# {"status":"ok","version":"1.0.0"}

# MCP initialize (with auth)
curl -X POST https://npm.yunmiao.site/mcp \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0.0.1"}}}'
```

### 7. Update / re-deploy

From the server:

```bash
bash /opt/mcp-all-in-one/deploy/scripts/deploy.sh
```

Or from local:

```bash
ssh user@host 'bash -s' < deploy/scripts/deploy.sh
```

## Client config (remote HTTP)

Replace `stdio` config with HTTP:

```json
{
  "mcpServers": {
    "mcp-all-in-one": {
      "url": "https://npm.yunmiao.site/mcp",
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
| `PORT` | `3000` | HTTP transport |
| `MCP_ENDPOINT` | `/mcp` | HTTP transport |
| `AUTH_TOKEN` | _(unset)_ | HTTP transport — required in production |
| `TAVILY_API_KEY` | _(unset)_ | `tavily_search` tool |

## License

MIT
