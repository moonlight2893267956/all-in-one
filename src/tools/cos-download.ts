import { z } from "zod";
import { cosDownloadToFile, loadConfig } from "./cos-client.js";

const InputSchema = z.object({
  cos_key: z.string().describe("Object key on COS"),
  local_path: z
    .string()
    .describe("Absolute path on the server to write the downloaded file"),
});

export const cosDownloadTool = {
  name: "cos_download",
  description:
    "Download an object from Tencent Cloud COS to the server filesystem.",
  inputSchema: {
    type: "object" as const,
    properties: {
      cos_key: { type: "string" },
      local_path: { type: "string" },
    },
    required: ["cos_key", "local_path"],
  },
  handler: async (args: Record<string, unknown>) => {
    const parsed = InputSchema.parse(args);
    const config = loadConfig();
    const r = await cosDownloadToFile(parsed.cos_key, parsed.local_path, config);
    return [
      `OK: downloaded`,
      `Bucket: ${config.bucket}`,
      `Key: ${parsed.cos_key}`,
      `Local path: ${parsed.local_path}`,
      `Size: ${r.size} bytes`,
      r.contentType ? `Content-Type: ${r.contentType}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  },
};
