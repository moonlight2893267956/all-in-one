import { z } from "zod";
import { runHexo, getServerDate } from "./hexo.js";

const InputSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("How many recent posts to list (default 20, max 100)"),
});

export const hexoListTool = {
  name: "hexo_list",
  description:
    "List Hexo blog posts via `hexo list post` (newest first). " +
    "Returns Date | Title | Path | Category | Tags for each post.",
  inputSchema: {
    type: "object" as const,
    properties: {
      limit: { type: "number", description: "Max posts to show (1-100, default 20)" },
    },
    required: [],
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const parsed = InputSchema.parse(args);
    const result = await runHexo(`list post`, 30_000);
    if (result.exitCode !== 0) {
      throw new Error(
        `hexo_list failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`
      );
    }
    const lines = result.stdout.split("\n").filter((l) => l && !l.startsWith("INFO"));
    const headerIdx = lines.findIndex((l) => l.startsWith("Date"));
    if (headerIdx === -1) {
      return "No posts found.";
    }
    const dataLines = lines.slice(headerIdx + 1).slice(0, parsed.limit);
    if (dataLines.length === 0) {
      return "No posts found.";
    }
    return [
      `Recent ${dataLines.length} posts (snapshot at ${getServerDate()}):`,
      lines[headerIdx],
      ...dataLines,
    ].join("\n");
  },
};
