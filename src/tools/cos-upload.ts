import { z } from "zod";
import {
  cosUploadFile,
  cosUploadBuffer,
  loadConfig,
} from "./cos-client.js";

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
    .describe("Absolute path on the server. Mutually exclusive with content_base64."),
  content_base64: z
    .string()
    .optional()
    .describe("Base64-encoded content. Use when uploading bytes not on disk."),
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
});

export const cosUploadTool = {
  name: "cos_upload",
  description:
    "Upload a file (or text/blob) to Tencent Cloud COS. Returns the ETag, key, and a public URL " +
    "(URL works only if the bucket is public or COS_PUBLIC_HOST is set to a CDN domain).",
  inputSchema: {
    type: "object" as const,
    properties: {
      local_path: {
        type: "string",
        description: "Absolute path on the server. Mutually exclusive with content_base64.",
      },
      content_base64: {
        type: "string",
        description: "Base64-encoded content.",
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
    let contentType = parsed.content_type;

    if (parsed.local_path) {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      if (!contentType) {
        const ext = path.extname(parsed.local_path).toLowerCase();
        contentType = guessMimeType(ext);
      }
      const r = await cosUploadFile(parsed.local_path, parsed.cos_key, config);
      etag = r.etag;
      size = r.size;
      versionId = r.versionId;
    } else if (parsed.content_base64) {
      const buf = Buffer.from(parsed.content_base64, "base64");
      const r = await cosUploadBuffer(buf, parsed.cos_key, contentType, config);
      etag = r.etag;
      size = r.size;
      versionId = r.versionId;
    } else {
      const buf = Buffer.from(parsed.content_text ?? "", "utf8");
      if (!contentType) contentType = "text/plain; charset=utf-8";
      const r = await cosUploadBuffer(buf, parsed.cos_key, contentType, config);
      etag = r.etag;
      size = r.size;
      versionId = r.versionId;
    }

    return [
      `OK: uploaded`,
      `Bucket: ${config.bucket}`,
      `Key: ${parsed.cos_key}`,
      `Size: ${size} bytes`,
      `ETag: ${etag}`,
      versionId ? `VersionId: ${versionId}` : null,
      `Content-Type: ${contentType ?? "(default)"}`,
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
