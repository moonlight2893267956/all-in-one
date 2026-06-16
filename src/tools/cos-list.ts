import { z } from "zod";
import { cosListObjects, loadConfig } from "./cos-client.js";

const InputSchema = z.object({
  prefix: z
    .string()
    .default("")
    .describe("Key prefix to filter by, e.g. 'reports/2025/'"),
  max_keys: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(100)
    .describe("Max keys to return per request (COS max is 1000)"),
});

export const cosListTool = {
  name: "cos_list",
  description:
    "List objects in the configured COS bucket. Supports prefix filtering and pagination.",
  inputSchema: {
    type: "object" as const,
    properties: {
      prefix: { type: "string", default: "" },
      max_keys: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
    },
    required: [],
  },
  handler: async (args: Record<string, unknown>) => {
    const parsed = InputSchema.parse(args);
    const config = loadConfig();
    const files = await cosListObjects(parsed.prefix, parsed.max_keys, config);

    if (files.length === 0) {
      return `No objects found (prefix=${JSON.stringify(parsed.prefix)})`;
    }
    const lines: string[] = [
      `Bucket: ${config.bucket}`,
      `Prefix: ${JSON.stringify(parsed.prefix)}`,
      `Count: ${files.length}`,
      "",
    ];
    for (const f of files) {
      lines.push(
        `${f.Key}  ${String(f.Size).padStart(12)}  ${f.LastModified}  ${f.ETag}`
      );
    }
    return lines.join("\n");
  },
};
