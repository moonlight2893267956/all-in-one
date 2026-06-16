import { z } from "zod";
import { cosDeleteObject, loadConfig } from "./cos-client.js";

const InputSchema = z.object({
  cos_keys: z
    .array(z.string().min(1))
    .min(1)
    .describe("List of object keys to delete (1 or more)"),
});

export const cosDeleteTool = {
  name: "cos_delete",
  description:
    "Delete one or more objects from Tencent Cloud COS. This is irreversible. " +
    "Confirm with the user before calling.",
  inputSchema: {
    type: "object" as const,
    properties: {
      cos_keys: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
    },
    required: ["cos_keys"],
  },
  handler: async (args: Record<string, unknown>) => {
    const parsed = InputSchema.parse(args);
    const config = loadConfig();

    const results: string[] = [
      `Bucket: ${config.bucket}`,
      `Requested: ${parsed.cos_keys.length}`,
    ];
    let ok = 0;
    let failed = 0;
    for (const key of parsed.cos_keys) {
      try {
        await cosDeleteObject(key, config);
        results.push(`  OK   ${key}`);
        ok += 1;
      } catch (e) {
        results.push(
          `  FAIL ${key}  ${e instanceof Error ? e.message : String(e)}`
        );
        failed += 1;
      }
    }
    results.unshift(`Deleted: ${ok}  Failed: ${failed}`);
    return results.join("\n");
  },
};
