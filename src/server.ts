import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { randomUUID } from "node:crypto";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { tools } from "./tools/index.js";
import { getUploadDir } from "./config.js";

const SESSION_TTL_MS = 1000 * 60 * 30; // 30 min idle

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
  mkdirSync(getUploadDir(), { recursive: true });
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

interface StreamableSession {
  server: Server;
  transport: StreamableHTTPServerTransport;
  lastUsed: number;
}

interface SseSession {
  server: Server;
  transport: SSEServerTransport;
}

export async function runHttpServer(options: HttpServerOptions): Promise<void> {
  mkdirSync(getUploadDir(), { recursive: true });
  const endpoint = options.endpoint ?? "/mcp";
  const sseEndpoint = options.sseEndpoint ?? "/sse";
  const messageEndpoint = options.messageEndpoint ?? "/messages";

  // Per-session Streamable HTTP transport pool. The SDK only allows
  // Server.connect(transport) once, and a transport that has been
  // initialized cannot be re-initialized — so each client session
  // needs its own (Server, transport) pair.
  const streamableSessions = new Map<string, StreamableSession>();

  // Legacy SSE (2024-11). One Server per session, since SSE binds the
  // Server's lifetime to the HTTP response stream.
  const sseSessions = new Map<string, SseSession>();

  function gcStreamableSessions(): void {
    const now = Date.now();
    for (const [sid, sess] of streamableSessions) {
      if (now - sess.lastUsed > SESSION_TTL_MS) {
        streamableSessions.delete(sid);
        void sess.transport.close().catch(() => {});
        void sess.server.close().catch(() => {});
      }
    }
  }
  setInterval(gcStreamableSessions, SESSION_TTL_MS / 2).unref();

  async function getOrCreateStreamableSession(
    sessionId: string | undefined
  ): Promise<{ sessionId: string; session: StreamableSession; created: boolean }> {
    if (sessionId && streamableSessions.has(sessionId)) {
      const session = streamableSessions.get(sessionId)!;
      session.lastUsed = Date.now();
      return { sessionId, session, created: false };
    }
    // Create a new session
    const newId = randomUUID();
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newId,
      onsessioninitialized: (sid) => {
        // The transport assigns its own session id (which is the same as newId
        // in stateful mode). Register it for routing subsequent requests.
        const s = streamableSessions.get(sid);
        if (s) s.lastUsed = Date.now();
      },
    });
    await server.connect(transport);
    const session: StreamableSession = { server, transport, lastUsed: Date.now() };
    streamableSessions.set(newId, session);
    return { sessionId: newId, session, created: true };
  }

  const httpServer = createServer((req, res) => {
    void handleHttpRequest(req, res, options, {
      endpoint,
      sseEndpoint,
      messageEndpoint,
      streamableSessions,
      getOrCreateStreamableSession,
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
    for (const sess of streamableSessions.values()) {
      await sess.transport.close().catch(() => {});
      await sess.server.close().catch(() => {});
    }
    for (const sess of sseSessions.values()) {
      await sess.transport.close().catch(() => {});
      await sess.server.close().catch(() => {});
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
  streamableSessions: Map<string, StreamableSession>;
  getOrCreateStreamableSession: (
    sessionId: string | undefined
  ) => Promise<{ sessionId: string; session: StreamableSession; created: boolean }>;
  sseSessions: Map<string, SseSession>;
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

  if (req.method === "OPTIONS") {
    setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === "/health" && req.method === "GET") {
    setCors(res);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        version: "1.0.0",
        streamableSessions: ctx.streamableSessions.size,
        sseSessions: ctx.sseSessions.size,
      })
    );
    return;
  }

  // ----- Streamable HTTP (2025-03): POST/GET/DELETE on /mcp -----
  if (url.pathname === ctx.endpoint) {
    if (!checkAuth(req, res, options.authToken)) return;
    setCors(res);

    const headerSid = (req.headers["mcp-session-id"] as string | undefined)?.trim();

    let session: StreamableSession;
    if (headerSid) {
      const existing = ctx.streamableSessions.get(headerSid);
      if (!existing) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Unknown or expired sessionId" },
            id: null,
          })
        );
        return;
      }
      existing.lastUsed = Date.now();
      session = existing;
    } else {
      // No session id → assume initialize. The transport will accept it
      // and assign a new session id. Any non-initialize request without a
      // session id is rejected by the SDK with 400.
      const created = await ctx.getOrCreateStreamableSession(undefined);
      session = created.session;
    }

    await session.transport.handleRequest(req, res);
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
      const s = ctx.sseSessions.get(transport.sessionId);
      if (s) {
        ctx.sseSessions.delete(transport.sessionId);
        void s.server.close();
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
