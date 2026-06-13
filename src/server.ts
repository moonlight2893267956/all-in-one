import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { randomUUID } from "node:crypto";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
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

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }

    try {
      const text = await tool.handler(
        (request.params.arguments ?? {}) as Record<string, unknown>
      );
      return { content: [{ type: "text" as const, text }] };
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
  });

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
  sseEndpoint?: string;
  messageEndpoint?: string;
}

export async function runHttpServer(options: HttpServerOptions): Promise<void> {
  const endpoint = options.endpoint ?? "/mcp";
  const sseEndpoint = options.sseEndpoint ?? "/sse";
  const messageEndpoint = options.messageEndpoint ?? "/messages";

  // Streamable HTTP (2025-03) transport. State kept per session.
  // NOTE: the MCP Server instance can only be connected to ONE transport
  // at a time, so Streamable HTTP and legacy SSE need separate Server
  // instances.
  const streamableTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  const streamableServer = createMcpServer();
  await streamableServer.connect(streamableTransport);

  // Legacy SSE (2024-11). One Server per session, since SSE binds the
  // Server's lifetime to the HTTP response stream.
  interface SseSession {
    server: Server;
    transport: SSEServerTransport;
  }
  const sseSessions = new Map<string, SseSession>();

  const httpServer = createServer((req, res) => {
    void handleHttpRequest(req, res, options, {
      endpoint,
      sseEndpoint,
      messageEndpoint,
      streamableTransport,
      sseSessions,
    });
  });

  httpServer.listen(options.port, options.host, () => {
    console.error(
      `MCP server running on http://${options.host}:${options.port}\n` +
        `  Streamable HTTP: POST ${endpoint} (and GET ${endpoint} with session id)\n` +
        `  Legacy SSE:      GET  ${sseEndpoint}  -> POST ${messageEndpoint}?sessionId=...`
    );
  });

  const shutdown = async (): Promise<void> => {
    console.error("Shutting down HTTP server...");
    httpServer.close();
    await streamableTransport.close();
    await streamableServer.close();
    for (const { server, transport } of sseSessions.values()) {
      await transport.close();
      await server.close();
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

interface HandleContext {
  endpoint: string;
  sseEndpoint: string;
  messageEndpoint: string;
  streamableTransport: StreamableHTTPServerTransport;
  sseSessions: Map<string, { server: Server; transport: SSEServerTransport }>;
}

function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, DELETE, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

function checkAuth(
  req: IncomingMessage,
  res: ServerResponse,
  authToken: string | undefined
): boolean {
  if (!authToken) return true;
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${authToken}`) {
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
    return false;
  }
  return true;
}

async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: HttpServerOptions,
  ctx: HandleContext
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // CORS preflight
  if (req.method === "OPTIONS") {
    setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check (no auth)
  if (url.pathname === "/health" && req.method === "GET") {
    setCors(res);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version: "1.0.0" }));
    return;
  }

  // ----- Streamable HTTP (2025-03): POST/GET/DELETE on /mcp -----
  if (url.pathname === ctx.endpoint) {
    if (!checkAuth(req, res, options.authToken)) return;
    setCors(res);
    await ctx.streamableTransport.handleRequest(req, res);
    return;
  }

  // ----- Legacy SSE (2024-11): GET /sse -----
  if (url.pathname === ctx.sseEndpoint && req.method === "GET") {
    if (!checkAuth(req, res, options.authToken)) return;
    setCors(res);

    const server = createMcpServer();
    const transport = new SSEServerTransport(ctx.messageEndpoint, res);
    await server.connect(transport);
    ctx.sseSessions.set(transport.sessionId, { server, transport });

    transport.onclose = () => {
      const session = ctx.sseSessions.get(transport.sessionId);
      if (session) {
        ctx.sseSessions.delete(transport.sessionId);
        void session.server.close();
      }
    };

    return;
  }

  // ----- Legacy SSE: POST /messages?sessionId=... -----
  if (url.pathname === ctx.messageEndpoint && req.method === "POST") {
    if (!checkAuth(req, res, options.authToken)) return;
    setCors(res);

    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing sessionId query param" }));
      return;
    }
    const session = ctx.sseSessions.get(sessionId);
    if (!session) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unknown or expired sessionId" }));
      return;
    }
    await session.transport.handlePostMessage(req, res);
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not Found" }));
}
