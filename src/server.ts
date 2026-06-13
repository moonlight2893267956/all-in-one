import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { tools } from "./tools/index.js";

function createMcpServer(): Server {
  const server = new Server(
    {
      name: "mcp-all-in-one",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request) => {
      const tool = tools.find((t) => t.name === request.params.name);
      if (!tool) {
        throw new Error(`Unknown tool: ${request.params.name}`);
      }

      try {
        const text = await tool.handler(
          (request.params.arguments ?? {}) as Record<string, unknown>
        );
        return {
          content: [{ type: "text" as const, text }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}

export async function runStdioServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP server running on stdio");
}

export interface HttpServerOptions {
  port: number;
  host: string;
  authToken?: string;
  endpoint?: string;
}

export async function runHttpServer(options: HttpServerOptions): Promise<void> {
  const server = createMcpServer();
  const endpoint = options.endpoint ?? "/mcp";

  // 状态模式：每个 session 一个 transport，会话内可继续 SSE/通知
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  await server.connect(transport);

  const httpServer = createServer((req, res) => {
    void handleHttpRequest(req, res, transport, options, endpoint);
  });

  httpServer.listen(options.port, options.host, () => {
    console.error(
      `MCP server running on http://${options.host}:${options.port}${endpoint}`
    );
  });

  const shutdown = async (): Promise<void> => {
    console.error("Shutting down HTTP server...");
    httpServer.close();
    await transport.close();
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  transport: StreamableHTTPServerTransport,
  options: HttpServerOptions,
  endpoint: string
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // CORS preflight (Claude 远程客户端偶尔会发)
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return;
  }

  // 健康检查端点（不需要鉴权，方便监控）
  if (url.pathname === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version: "1.0.0" }));
    return;
  }

  // MCP 端点
  if (url.pathname === endpoint) {
    if (options.authToken) {
      const auth = req.headers.authorization;
      const expected = `Bearer ${options.authToken}`;
      if (auth !== expected) {
        res.writeHead(401, {
          "Content-Type": "application/json",
          "WWW-Authenticate": 'Bearer realm="mcp-all-in-one"',
          "Access-Control-Allow-Origin": "*",
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Unauthorized" },
            id: null,
          })
        );
        return;
      }
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    await transport.handleRequest(req, res);
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not Found" }));
}
