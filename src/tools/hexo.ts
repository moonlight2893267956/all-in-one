import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Buffer } from "node:buffer";

const execFileP = promisify(execFile);

const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;

const DEFAULT_HEXO_DIR = "/home/yunmiao/apps/hexo-source";
const DEFAULT_NVM_PATH = "/home/yunmiao/.nvm/nvm.sh";
const HEXO_CONFIG = "_config.yml,_config.server.yml";

export function hexoSourceDir(): string {
  return (process.env.HEXO_SOURCE_DIR ?? DEFAULT_HEXO_DIR).replace(/\/+$/, "");
}

function nvmPath(): string {
  return process.env.HEXO_NVM_PATH ?? DEFAULT_NVM_PATH;
}

export function postsDir(): string {
  return `${hexoSourceDir()}/source/_posts`;
}

function buildBashCommand(hexoArgs: string): string {
  return `. ${nvmPath()} >/dev/null 2>&1; cd ${hexoSourceDir()} && npx hexo --config ${HEXO_CONFIG} ${hexoArgs}`;
}

export interface HexoRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
  durationMs: number;
  timedOut: boolean;
}

export async function runHexo(
  hexoArgs: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<HexoRunResult> {
  const t0 = Date.now();
  const cmd = buildBashCommand(hexoArgs);
  let stdoutBuf = Buffer.alloc(0);
  let stderrBuf = Buffer.alloc(0);
  let exitCode = 0;
  let signal: NodeJS.Signals | null = null;
  let timedOut = false;

  try {
    const r = await execFileP("/bin/bash", ["-c", cmd], {
      timeout: Math.min(timeoutMs, MAX_TIMEOUT_MS),
      maxBuffer: MAX_OUTPUT_BYTES * 2,
      killSignal: "SIGTERM" as NodeJS.Signals,
    });
    stdoutBuf = Buffer.from(r.stdout ?? "");
    stderrBuf = Buffer.from(r.stderr ?? "");
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
    if (e.killed && (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || signal === "SIGTERM" || signal === "SIGKILL")) {
      timedOut = true;
    }
  }

  return {
    stdout: truncate(stdoutBuf, "stdout"),
    stderr: truncate(stderrBuf, "stderr"),
    exitCode,
    signal,
    durationMs: Date.now() - t0,
    timedOut,
  };
}

function truncate(buf: Buffer, label: string): string {
  if (buf.length <= MAX_OUTPUT_BYTES) return buf.toString("utf8");
  const head = buf.subarray(0, MAX_OUTPUT_BYTES).toString("utf8");
  return (
    head +
    `\n\n[... ${label} truncated, original ${buf.length} bytes, showing first ${MAX_OUTPUT_BYTES}]`
  );
}

export function getServerDate(d: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

export function getTodayPrefix(d: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const FILENAME_RE = /^(\d{4}-\d{2}-\d{2})-([a-z0-9][a-z0-9-]{0,78})\.md$/;

export interface FilenameParts {
  date: string;
  slug: string;
  full: string;
}

export function parseFilename(name: string): FilenameParts | null {
  const m = FILENAME_RE.exec(name);
  if (!m) return null;
  return { date: m[1], slug: m[2], full: name };
}

export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fff-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "post";
}

export interface FrontMatterFields {
  title: string;
  date: string;
  tags: string[];
  categories: string[];
}

export function buildFrontMatter(fm: FrontMatterFields): string {
  const lines: string[] = ["---"];
  lines.push(`title: ${fm.title}`);
  lines.push(`date: ${fm.date}`);
  if (fm.tags.length > 0) {
    lines.push("tags:");
    for (const t of fm.tags) lines.push(`  - ${t}`);
  }
  if (fm.categories.length > 0) {
    lines.push("categories:");
    for (const c of fm.categories) lines.push(`  - ${c}`);
  }
  lines.push("---");
  return lines.join("\n");
}

export function buildFrontMatterWithSlug(args: {
  title: string;
  date: string;
  tags: string[];
  categories: string[];
  slug: string;
}): string {
  const lines: string[] = ["---"];
  lines.push(`title: ${args.title}`);
  lines.push(`date: ${args.date}`);
  if (args.tags.length > 0) {
    lines.push("tags:");
    for (const t of args.tags) lines.push(`  - ${t}`);
  }
  if (args.categories.length > 0) {
    lines.push("categories:");
    for (const c of args.categories) lines.push(`  - ${c}`);
  }
  // The `slug` field is consumed by hexo when the permalink template uses
  // `:slug`. Without it, hexo falls back to slugifying the title (which
  // breaks for Chinese / special-character titles and produces URLs that
  // don't match the file slug).
  lines.push(`slug: ${args.slug}`);
  lines.push("---");
  return lines.join("\n");
}

export function ensureFilename(datePrefix: string, slug: string): string {
  if (!FILENAME_RE.test(`${datePrefix}-${slug}.md`)) {
    throw new Error(
      `Invalid filename pattern: ${datePrefix}-${slug}.md ` +
        "(expected YYYY-MM-DD-slug.md, slug in [a-z0-9-], max 80 chars)"
    );
  }
  return `${datePrefix}-${slug}.md`;
}

export function ensureDatePrefix(prefix: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(prefix)) {
    throw new Error(`Invalid date prefix "${prefix}", expected YYYY-MM-DD`);
  }
  return prefix;
}
