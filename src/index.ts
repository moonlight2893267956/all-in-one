#!/usr/bin/env node
import { config as loadDotenv } from "dotenv";
import { runStdioServer, runHttpServer } from "./server.js";

const TRANSPORT_HELP = `
Usage: mcp-all-in-one [transport] [options]

Transports:
  stdio                   Run over stdio (default, for local MCP clients)
  http                    Run over Streamable HTTP (for remote deployment)

HTTP Options (env vars also supported):
  --port <number>         Port to listen on              [env: PORT, default: 3000]
  --host <string>         Host to bind                   [env: HOST, default: 127.0.0.1]
  --auth-token <string>   Required Bearer token          [env: AUTH_TOKEN]
  --endpoint <string>     MCP endpoint path              [env: MCP_ENDPOINT, default: /mcp]

Examples:
  mcp-all-in-one
  mcp-all-in-one http --port 3000 --auth-token secret123
  PORT=3000 AUTH_TOKEN=secret123 mcp-all-in-one http
`;

interface CliOptions {
  transport: "stdio" | "http";
  port: number;
  host: string;
  authToken?: string;
  endpoint: string;
}

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);
  const transport: "stdio" | "http" = args[0] === "http" ? "http" : "stdio";
  const flags = transport === "http" ? args.slice(1) : args;

  const getFlag = (name: string): string | undefined => {
    const idx = flags.indexOf(`--${name}`);
    if (idx === -1) return undefined;
    return flags[idx + 1];
  };

  const port = Number(getFlag("port") ?? process.env.PORT ?? 3000);
  const host = getFlag("host") ?? process.env.HOST ?? "127.0.0.1";
  const authToken = getFlag("auth-token") ?? process.env.AUTH_TOKEN;
  const endpoint = getFlag("endpoint") ?? process.env.MCP_ENDPOINT ?? "/mcp";

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }

  return { transport, port, host, authToken, endpoint };
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stderr.write(TRANSPORT_HELP + "\n");
    return;
  }

  loadDotenv();

  const opts = parseArgs(process.argv);

  if (opts.transport === "http") {
    if (!opts.authToken) {
      console.error(
        "WARNING: AUTH_TOKEN is not set. The server will accept any request. " +
        "Set AUTH_TOKEN env var or --auth-token flag for production use."
      );
    }
    await runHttpServer({
      port: opts.port,
      host: opts.host,
      authToken: opts.authToken,
      endpoint: opts.endpoint,
    });
  } else {
    await runStdioServer();
  }
}

main().catch((error: Error) => {
  console.error("Fatal error:", error.message);
  process.exit(1);
});
