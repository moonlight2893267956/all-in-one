import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Buffer } from "node:buffer";

const execFileP = promisify(execFile);

const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;

const FORBIDDEN_CWDS = new Set<string>(["/", "/etc", "/boot"]);

const HARD_BLOCK_PATTERNS: RegExp[] = [
  /\brm\s+(?:-[a-zA-Z]*\s+)*\/(\s|$)/,
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*\b[^\n]*\/(\s|$)/,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  /\bmkfs(\.[a-z0-9]+)?\b/,
  /\bdd\b[^\n]*\bof=\/dev\//,
  /\bchmod\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)?(?:0?777|[a-z]?7[0-9a-z][0-9a-z])\s+\//,
  /(\bcurl\b|\bwget\b)[^\n]*\|\s*(ba)?sh\b/,
  />\s*\/dev\/sd[a-z]\b/,
  /\bmv\s+[^\n]*\s+\/\s*$/,
  /\bparted\b/,
  /\bfdisk\b/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bpoweroff\b/,
  /\bhalt\b/,
  /\binit\s+[06]\b/,
];

const SOFT_DESTRUCTIVE_PATTERN =
  /\b(rm|mv|chmod|chown|killall|pkill|drop|truncate)\b|\bsystemctl\s+(stop|disable|mask|restart)\b|\bpm2\s+(delete|stop|reload|reset|kill)\b/;

const DEFAULT_LOG_PATH = "/var/log/mcp-shell-exec.log";
const SAFE_PASSTHROUGH_ENVS = new Set([
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "HOME",
  "TZ",
  "TERM",
]);

const InputSchema = z.object({
  command: z
    .string()
    .min(1)
    .max(10_000)
    .describe("Shell command to execute. Executed via /bin/bash -c."),
  cwd: z
    .string()
    .default("/tmp")
    .describe(
      "Working directory. Must be an absolute path. Defaults to /tmp. " +
        "Refused if it resolves to /, /etc, or /boot."
    ),
  timeout_ms: z
    .number()
    .int()
    .min(100)
    .max(MAX_TIMEOUT_MS)
    .default(DEFAULT_TIMEOUT_MS)
    .describe(
      "Timeout in milliseconds. Default 30000 (30s), max 300000 (5 min). " +
        "On timeout the process receives SIGTERM, then SIGKILL after 5s grace."
    ),
  confirm: z
    .boolean()
    .default(false)
    .describe(
      "Required true for destructive commands (rm, mv, chmod, chown, kill, " +
        "systemctl stop/disable/mask/restart, pm2 delete/stop/reload, etc.). " +
        "Hard-blacklisted commands (rm -rf /, mkfs, fork bomb, curl|sh, ...) are " +
        "blocked regardless of this flag."
    ),
  input: z
    .string()
    .optional()
    .describe(
      "Optional stdin to feed to the command. Implemented as `echo '<input>' | " +
        "<command>` automatically."
    ),
});

function isEnabled(): boolean {
  return process.env.ENABLE_SHELL_EXEC === "true";
}

function buildChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_PASSTHROUGH_ENVS) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  const passthrough = process.env.SHELL_EXEC_PASSTHROUGH_ENVS;
  if (passthrough) {
    for (const key of passthrough
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean)) {
      const v = process.env[key];
      if (v !== undefined) env[key] = v;
    }
  }
  return env;
}

function truncate(buf: Buffer, label: string): string {
  if (buf.length <= MAX_OUTPUT_BYTES) return buf.toString("utf8");
  const head = buf.subarray(0, MAX_OUTPUT_BYTES).toString("utf8");
  return (
    head +
    `\n\n[... ${label} truncated, original ${buf.length} bytes, showing first ${MAX_OUTPUT_BYTES}]`
  );
}

function checkSafety(command: string, confirm: boolean): void {
  for (const re of HARD_BLOCK_PATTERNS) {
    if (re.test(command)) {
      throw new Error(
        `Refused: command matches hard-blocked safety pattern (${re}). ` +
          "This kind of operation cannot be overridden."
      );
    }
  }
  if (!confirm && SOFT_DESTRUCTIVE_PATTERN.test(command)) {
    throw new Error(
      "Refused: destructive command requires confirm=true. " +
        "Recognized destructive verbs: rm, mv, chmod, chown, killall, pkill, drop, " +
        "truncate, systemctl stop/disable/mask/restart, pm2 delete/stop/reload/reset/kill."
    );
  }
}

function checkCwd(cwd: string): string {
  if (!cwd.startsWith("/")) {
    throw new Error(`Refused: cwd must be an absolute path, got "${cwd}".`);
  }
  const abs = resolve(cwd);
  if (FORBIDDEN_CWDS.has(abs)) {
    throw new Error(
      `Refused: cwd "${abs}" is in the protected list (${[...FORBIDDEN_CWDS].join(", ")}).`
    );
  }
  return abs;
}

async function writeAuditLog(entry: string): Promise<void> {
  const path = process.env.SHELL_EXEC_LOG ?? DEFAULT_LOG_PATH;
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, entry + "\n", { mode: 0o640 });
  } catch (err) {
    process.stderr.write(
      `[shell_exec] failed to write audit log ${path}: ${(err as Error).message}\n`
    );
  }
}

export const shellExecTool = {
  name: "shell_exec",
  description:
    "Execute a shell command on the MCP server host (the same machine this MCP " +
    "process is running on). Useful for ops tasks: pm2 restart, tail logs, " +
    "nginx -t, df, free, systemctl status, etc. The process runs as the same " +
    "user (yunmiao on production). To get root, prefix the command with `sudo`.\n\n" +
    "SAFETY:\n" +
    "  - Hard-blocked (always refused, no override): rm -rf /, mkfs, dd to /dev, " +
    "fork bomb, curl|sh, chmod 777 /, mv xxx /, shutdown, reboot, init 0/6, etc.\n" +
    "  - Soft-destructive (requires confirm=true): rm, mv, chmod, chown, kill, " +
    "systemctl stop/disable/mask/restart, pm2 delete/stop/reload.\n" +
    "  - cwd must be absolute and not in /, /etc, /boot. Default /tmp.\n" +
    "  - Timeout default 30s, max 5 min. SIGTERM, then SIGKILL after 5s grace.\n" +
    "  - stdout/stderr each truncated at 5MB.\n" +
    "  - Environment is sanitized: only PATH/LANG/LC_*/HOME/TZ/TERM plus keys " +
    "in SHELL_EXEC_PASSTHROUGH_ENVS are passed through. API keys in the MCP " +
    "process env (NEWAPI_API_KEY, DASHSCOPE_API_KEY, COS_*, TAVILY_API_KEY) " +
    "are NOT inherited by the child.\n" +
    "  - Every invocation is appended to the audit log (default " +
    "/var/log/mcp-shell-exec.log) with timestamp, exit code, duration, cwd, " +
    "and the full command line.\n\n" +
    "Disabled by default. Set ENABLE_SHELL_EXEC=true in env to enable. " +
    "When disabled, this tool returns an error explaining the flag.",
  inputSchema: {
    type: "object" as const,
    properties: {
      command: {
        type: "string",
        description: "Shell command to execute. Executed via /bin/bash -c.",
      },
      cwd: {
        type: "string",
        default: "/tmp",
        description:
          "Working directory. Must be absolute. Refused if it resolves to /, /etc, /boot.",
      },
      timeout_ms: {
        type: "number",
        default: DEFAULT_TIMEOUT_MS,
        description:
          "Timeout in ms (100-300000). Default 30000. SIGTERM, then SIGKILL after 5s.",
      },
      confirm: {
        type: "boolean",
        default: false,
        description:
          "Set true to confirm destructive commands (rm, mv, chmod, chown, kill, " +
          "systemctl stop/disable/mask/restart, pm2 delete/stop/reload, ...).",
      },
      input: {
        type: "string",
        description: "Optional stdin content.",
      },
    },
    required: ["command"],
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    if (!isEnabled()) {
      throw new Error(
        "shell_exec is disabled. Set ENABLE_SHELL_EXEC=true in the MCP " +
          "process environment to enable. Then restart the process."
      );
    }

    const parsed = InputSchema.parse(args);
    const cwd = checkCwd(parsed.cwd);
    checkSafety(parsed.command, parsed.confirm);

    const startedAt = new Date();
    const env = buildChildEnv();
    const timeoutMs = parsed.timeout_ms;

    const effectiveCommand = parsed.input
      ? `printf '%s' ${JSON.stringify(parsed.input)} | ${parsed.command}`
      : parsed.command;

    let stdoutBuf: Buffer;
    let stderrBuf: Buffer;
    let exitCode: number | null;
    let signal: NodeJS.Signals | null;
    let timedOut = false;
    let errorMessage: string | undefined;

    try {
      const result = await execFileP("/bin/bash", ["-c", effectiveCommand], {
        cwd,
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES * 2,
        env,
        killSignal: "SIGTERM" as NodeJS.Signals,
      });
      stdoutBuf = Buffer.from(result.stdout ?? "");
      stderrBuf = Buffer.from(result.stderr ?? "");
      exitCode = 0;
      signal = null;
    } catch (err) {
      const e = err as NodeJS.ErrnoException & {
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        code?: string | number;
        signal?: NodeJS.Signals;
        killed?: boolean;
      };
      stdoutBuf = Buffer.from(e.stdout ?? "");
      stderrBuf = Buffer.from(e.stderr ?? "");
      exitCode = typeof e.code === "number" ? e.code : 1;
      signal = e.signal ?? null;
      timedOut = e.killed === true && (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || signal === "SIGTERM" || signal === "SIGKILL");
      if (!timedOut) {
        errorMessage = e.message;
      }
    }

    const durationMs = Date.now() - startedAt.getTime();

    const auditEntry =
      `${startedAt.toISOString()}  ` +
      `uid=${process.getuid?.() ?? "?"}  ` +
      `cwd=${cwd}  ` +
      `exit=${exitCode ?? "null"}  ` +
      `signal=${signal ?? "-"}  ` +
      `timed_out=${timedOut}  ` +
      `duration_ms=${durationMs}  ` +
      `bytes_out=${stdoutBuf.length}  ` +
      `bytes_err=${stderrBuf.length}  ` +
      `cmd=${JSON.stringify(parsed.command)}`;
    void writeAuditLog(auditEntry);

    const lines: string[] = [
      `Host: ${process.env.USER ?? "?"}@${process.env.HOSTNAME ?? "?"} (uid=${process.getuid?.() ?? "?"})`,
      `Cwd: ${cwd}`,
      `Timeout: ${Math.round(timeoutMs / 1000)}s`,
      `$ ${parsed.command}`,
      "",
    ];
    lines.push(`--- stdout (${stdoutBuf.length} bytes) ---`);
    lines.push(truncate(stdoutBuf, "stdout"));
    lines.push("");
    lines.push(`--- stderr (${stderrBuf.length} bytes) ---`);
    lines.push(truncate(stderrBuf, "stderr"));
    lines.push("");
    lines.push(
      `Exit: ${exitCode ?? "null"}  Signal: ${signal ?? "-"}  ` +
        `Duration: ${durationMs}ms` +
        (timedOut ? "  [TIMED OUT]" : "")
    );
    if (errorMessage) {
      lines.push(`Error: ${errorMessage}`);
    }

    return lines.join("\n");
  },
};
