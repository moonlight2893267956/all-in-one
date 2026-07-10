import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  cosUploadFile,
  cosUploadBuffer,
  loadConfig,
} from "./cos-client.js";
import { getUploadDir } from "../config.js";

/**
 * Resolve a caller-supplied local_path against the staging directory
 * (MCP_UPLOAD_DIR). Relative paths land inside it; absolute paths must already
 * be inside it. Rejects any path that escapes the directory (path traversal),
 * so cos_upload can never read arbitrary server files.
 */
function resolveStagedPath(input: string, root: string): string {
  const abs = path.isAbsolute(input)
    ? path.resolve(input)
    : path.resolve(root, input);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `local_path must resolve inside MCP_UPLOAD_DIR (${root}); got: ${input}`
    );
  }
  return abs;
}

const STORAGE_CLASSES = [
  "STANDARD",
  "STANDARD_IA",
  "ARCHIVE",
  "DEEP_ARCHIVE",
  "INTELLIGENT_TIERING",
] as const;

const UploadInput = z.object({
  local_path: z
    .string()
    .optional()
    .describe(
      "Path to a file ON THE SERVER (inside MCP_UPLOAD_DIR). The server is remote, so a path " +
      "from your local machine does NOT exist here. To upload a local file, stage it first:\n" +
      "  scp /local/file.png yunmiao@ts.yunmiao.site:/home/yunmiao/apps/all-in-one/uploads/\n" +
      "then pass local_path='file.png'. Relative paths resolve under MCP_UPLOAD_DIR; absolute " +
      "paths must stay within it (path-traversal guarded). Mutually exclusive with content_base64."
    ),
  content_base64: z
    .string()
    .optional()
    .describe(
      "Base64-encoded file bytes. Use for SMALL files only (base64 < ~30KB, to avoid context " +
      "truncation); larger files should be staged via scp + local_path. Mutually exclusive with local_path."
    ),
  content_text: z
    .string()
    .optional()
    .describe("Plain text content. Use for small text artifacts (logs, JSON, etc.)."),
  cos_key: z
    .string()
    .describe("Object key on COS, e.g. 'reports/2025/12/foo.pdf'"),
  storage_class: z
    .enum(STORAGE_CLASSES)
    .default("STANDARD")
    .describe("Storage class"),
  content_type: z
    .string()
    .optional()
    .describe("MIME type (auto-detected for common extensions if omitted)"),
  acl: z
    .enum(["private", "public-read"])
    .default("public-read")
    .describe(
      "Object ACL. 'public-read' lets anyone fetch the returned URL; 'private' requires a presigned URL."
    ),
});

export const cosUploadTool = {
  name: "cos_upload",
  description:
    "Upload a file / text / blob to Tencent Cloud COS. Returns the ETag, key, and a public URL " +
    "(URL works only if the bucket is public or COS_PUBLIC_HOST is set to a CDN domain).\n\n" +
    "HOW TO UPLOAD A FILE (IMPORTANT): the MCP server runs on a REMOTE host, so `local_path` is " +
    "resolved ON THE SERVER, NOT on your machine. A path from your local computer will NOT exist " +
    "there and fails with ENOENT. To upload a file that lives on your local machine, do ONE of:\n" +
    "  (A) Stage it on the server first via scp, then use local_path (works for ANY size):\n" +
    "        scp /local/path/to/file.png yunmiao@ts.yunmiao.site:/home/yunmiao/apps/all-in-one/uploads/\n" +
    "      then call with local_path='file.png' (relative names resolve inside the server upload dir).\n" +
    "  (B) For SMALL files only (base64 string < ~30KB, to avoid context/window truncation), pass content_base64.\n" +
    "Use content_text for plain-text blobs. Exactly one of local_path / content_base64 / content_text is required.",
  inputSchema: {
    type: "object" as const,
    properties: {
      local_path: {
        type: "string",
        description:
          "Path to a file ON THE SERVER (inside MCP_UPLOAD_DIR). The server is remote, so a local-machine path does not exist here. To upload a local file: scp /local/file.png yunmiao@ts.yunmiao.site:/home/yunmiao/apps/all-in-one/uploads/ then pass local_path='file.png'. Relative paths resolve under MCP_UPLOAD_DIR; absolute paths must stay within it (path-traversal guarded).",
      },
      content_base64: {
        type: "string",
        description:
          "Base64-encoded file bytes. Use for SMALL files only (base64 < ~30KB to avoid context truncation); larger files should be staged via scp + local_path.",
      },
      content_text: {
        type: "string",
        description: "Plain text content.",
      },
      cos_key: { type: "string", description: "Object key on COS" },
      storage_class: {
        type: "string",
        enum: STORAGE_CLASSES as unknown as string[],
        default: "STANDARD",
      },
      content_type: { type: "string", description: "MIME type override" },
      acl: {
        type: "string",
        enum: ["private", "public-read"],
        default: "public-read",
        description: "Object ACL. public-read lets anyone fetch the URL.",
      },
    },
    required: ["cos_key"],
  },
  handler: async (args: Record<string, unknown>) => {
    const parsed = UploadInput.parse(args);
    const sources = [parsed.local_path, parsed.content_base64, parsed.content_text].filter(
      (x) => x !== undefined
    );
    if (sources.length !== 1) {
      throw new Error("Provide exactly one of local_path, content_base64, content_text");
    }

    const config = loadConfig();
    const { buildPublicUrl } = await import("./cos-client.js");

    let etag: string;
    let size: number;
    let versionId: string | undefined;
    let acl: string;
    let contentType = parsed.content_type;

    if (parsed.local_path) {
      const stagedPath = resolveStagedPath(parsed.local_path, getUploadDir());
      if (!contentType) {
        const ext = path.extname(stagedPath).toLowerCase();
        contentType = guessMimeType(ext);
      }
      let r;
      try {
        r = await cosUploadFile(stagedPath, parsed.cos_key, config, {
          acl: parsed.acl,
        });
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
          throw new Error(
            `local_path '${stagedPath}' was not found ON THE SERVER. The MCP server is remote, ` +
            `so a path from your local machine does not exist here. To upload a local file, stage it first:\n` +
            `  scp /local/path/to/file.png yunmiao@ts.yunmiao.site:/home/yunmiao/apps/all-in-one/uploads/\n` +
            `then call with local_path='file.png'. (Or pass content_base64 for small files < ~30KB.)`
          );
        }
        throw err;
      }
      etag = r.etag;
      size = r.size;
      versionId = r.versionId;
      acl = r.acl;
    } else if (parsed.content_base64) {
      const buf = Buffer.from(parsed.content_base64, "base64");
      const r = await cosUploadBuffer(buf, parsed.cos_key, contentType, config, {
        acl: parsed.acl,
      });
      etag = r.etag;
      size = r.size;
      versionId = r.versionId;
      acl = r.acl;
    } else {
      const buf = Buffer.from(parsed.content_text ?? "", "utf8");
      if (!contentType) contentType = "text/plain; charset=utf-8";
      const r = await cosUploadBuffer(buf, parsed.cos_key, contentType, config, {
        acl: parsed.acl,
      });
      etag = r.etag;
      size = r.size;
      versionId = r.versionId;
      acl = r.acl;
    }

    return [
      `OK: uploaded`,
      `Bucket: ${config.bucket}`,
      `Key: ${parsed.cos_key}`,
      `Size: ${size} bytes`,
      `ETag: ${etag}`,
      versionId ? `VersionId: ${versionId}` : null,
      `Content-Type: ${contentType ?? "(default)"}`,
      `ACL: ${acl}`,
      `URL: ${buildPublicUrl(parsed.cos_key, config)}`,
    ]
      .filter(Boolean)
      .join("\n");
  },
};

function guessMimeType(ext: string): string | undefined {
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".json": "application/json",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".xlsx":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".docx":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".zip": "application/zip",
  };
  return map[ext];
}

// ---------------------------------------------------------------------------
// cos_upload_chunked — upload a (possibly large) file via chunked base64, with
// NO scp/SSH. The MCP server is remote, so a local-machine path cannot be used
// and a single huge base64 string gets truncated in the caller's context. The
// caller reads the local file in chunks, base64-encodes each (kept small), and
// calls this tool once per chunk; the server assembles them and uploads to COS.
// ---------------------------------------------------------------------------

interface ChunkSession {
  chunks: (Buffer | undefined)[];
  total: number;
  cosKey: string;
  lastUsed: number;
}

const CHUNK_TTL_MS = 1000 * 60 * 30; // drop idle uploads after 30 min
const MAX_CHUNK_BYTES = 10 * 1024 * 1024; // 10 MB per chunk
const MAX_TOTAL_BYTES = 500 * 1024 * 1024; // 500 MB per upload

const chunkSessions = new Map<string, ChunkSession>();
let chunkCleanupStarted = false;
function ensureChunkCleanup(): void {
  if (chunkCleanupStarted) return;
  chunkCleanupStarted = true;
  setInterval(() => {
    const now = Date.now();
    for (const [id, s] of chunkSessions) {
      if (now - s.lastUsed > CHUNK_TTL_MS) chunkSessions.delete(id);
    }
  }, CHUNK_TTL_MS / 2).unref();
}

const ChunkedInput = z.object({
  cos_key: z
    .string()
    .describe("Final COS object key, e.g. 'shots/2025/foo.png'. Used for content-type detection and the upload destination."),
  content_base64: z
    .string()
    .describe("Base64 of THIS chunk. Keep each chunk small (<= ~20KB base64) to avoid LLM context truncation."),
  sequence: z
    .number()
    .int()
    .min(0)
    .describe("0-based chunk index, in order (0, 1, 2, ...)."),
  final: z
    .boolean()
    .default(false)
    .describe("Set true on the LAST chunk. The server concatenates all chunks in order and uploads to COS, returning the URL."),
  upload_id: z
    .string()
    .optional()
    .describe("Session id returned by the first call. Pass it on every subsequent chunk. Omit on the first call to start a new upload."),
  content_type: z
    .string()
    .optional()
    .describe("MIME type override; auto-detected from the cos_key extension if omitted."),
  acl: z
    .enum(["private", "public-read"])
    .default("public-read")
    .describe("Object ACL. 'public-read' lets anyone fetch the returned URL."),
});

export const cosUploadChunkedTool = {
  name: "cos_upload_chunked",
  description:
    "Upload a (possibly large) file to Tencent Cloud COS via chunked base64 — NO scp/SSH required. " +
    "The MCP server is remote, so a local-machine path cannot be used, and a single huge base64 string " +
    "gets truncated in the caller's context. Instead, read the local file in chunks, base64-encode each " +
    "chunk (keep <= ~20KB base64), and call this tool ONCE PER CHUNK:\n" +
    "  1) First chunk: omit upload_id. The server returns an upload_id.\n" +
    "  2) Subsequent chunks: pass the same upload_id and increasing sequence (0,1,2,...).\n" +
    "  3) Last chunk: set final=true. The server concatenates all chunks in order and uploads to COS, " +
    "     returning the URL/ETag/Size.\n" +
    "Each call stays small, so any file size works. Auth is the MCP AUTH_TOKEN; external callers are " +
    "confined to upload-only and never get shell/SSH or filesystem access.",
  inputSchema: {
    type: "object" as const,
    properties: {
      cos_key: { type: "string", description: "Final COS object key, e.g. 'shots/2025/foo.png'." },
      content_base64: {
        type: "string",
        description: "Base64 of THIS chunk (keep <= ~20KB to avoid context truncation).",
      },
      sequence: { type: "number", description: "0-based chunk index, in order." },
      final: {
        type: "boolean",
        default: false,
        description: "Set true on the last chunk to assemble and upload to COS.",
      },
      upload_id: {
        type: "string",
        description: "Session id from the first call; pass on subsequent chunks. Omit on first call.",
      },
      content_type: { type: "string", description: "MIME type override (auto-detected from cos_key ext if omitted)." },
      acl: {
        type: "string",
        enum: ["private", "public-read"],
        default: "public-read",
        description: "Object ACL.",
      },
    },
    required: ["cos_key", "content_base64", "sequence"],
  },
  handler: async (args: Record<string, unknown>) => {
    ensureChunkCleanup();
    const parsed = ChunkedInput.parse(args);
    const config = loadConfig();
    const { buildPublicUrl } = await import("./cos-client.js");

    let buf: Buffer;
    try {
      buf = Buffer.from(parsed.content_base64, "base64");
    } catch {
      throw new Error("content_base64 is not valid base64");
    }
    if (buf.length === 0) throw new Error("content_base64 decoded to empty bytes");
    if (buf.length > MAX_CHUNK_BYTES) {
      throw new Error(`chunk too large: ${buf.length} bytes (max ${MAX_CHUNK_BYTES})`);
    }

    let session: ChunkSession;
    if (parsed.upload_id) {
      const s = chunkSessions.get(parsed.upload_id);
      if (!s) {
        throw new Error(
          `Unknown or expired upload_id '${parsed.upload_id}'. Start a new upload by omitting upload_id.`
        );
      }
      session = s;
    } else {
      const id = randomUUID();
      session = { chunks: [], total: 0, cosKey: parsed.cos_key, lastUsed: Date.now() };
      chunkSessions.set(id, session);
      parsed.upload_id = id;
    }
    session.cosKey = parsed.cos_key;
    session.lastUsed = Date.now();

    const existing = session.chunks[parsed.sequence];
    session.chunks[parsed.sequence] = buf;
    if (!existing) session.total += buf.length;
    if (session.total > MAX_TOTAL_BYTES) {
      chunkSessions.delete(parsed.upload_id);
      throw new Error(`total size exceeds limit (${MAX_TOTAL_BYTES} bytes)`);
    }

    if (!parsed.final) {
      const received = session.chunks.filter(Boolean).length;
      return [
        `OK: chunk received`,
        `upload_id: ${parsed.upload_id}`,
        `chunks_received: ${received}`,
        `bytes_so_far: ${session.total}`,
        `(send next chunk with the same upload_id, or set final=true on the last chunk)`,
      ].join("\n");
    }

    // Finalize: assemble in order and upload.
    const missing = session.chunks.findIndex((c) => !c);
    if (missing !== -1) {
      const got = session.chunks.filter(Boolean).length;
      chunkSessions.delete(parsed.upload_id);
      throw new Error(
        `cannot finalize: chunk ${missing} is missing (received ${got}/${session.chunks.length}).`
      );
    }
    const full = Buffer.concat(session.chunks as Buffer[]);
    let contentType = parsed.content_type;
    if (!contentType) {
      const ext = path.extname(parsed.cos_key).toLowerCase();
      contentType = guessMimeType(ext);
    }
    const r = await cosUploadBuffer(full, parsed.cos_key, contentType, config, {
      acl: parsed.acl,
    });
    chunkSessions.delete(parsed.upload_id);
    return [
      `OK: uploaded`,
      `Bucket: ${config.bucket}`,
      `Key: ${parsed.cos_key}`,
      `Size: ${r.size} bytes`,
      `ETag: ${r.etag}`,
      r.versionId ? `VersionId: ${r.versionId}` : null,
      `Content-Type: ${contentType ?? "(default)"}`,
      `ACL: ${r.acl}`,
      `URL: ${buildPublicUrl(parsed.cos_key, config)}`,
    ]
      .filter(Boolean)
      .join("\n");
  },
};
