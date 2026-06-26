import { z } from "zod";
import { runHexo, getServerDate, getTodayPrefix, parseFilename } from "./hexo.js";

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
    "List recent Hexo blog posts on the server. Reads " +
    "<HEXO_SOURCE_DIR>/source/_posts/ sorted by modification time (newest first) " +
    "and shows filename, size, mtime, and parsed date+slug for each.",
  inputSchema: {
    type: "object" as const,
    properties: {
      limit: { type: "number", description: "Max posts to show (1-100, default 20)" },
    },
    required: [],
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const parsed = InputSchema.parse(args);
    const result = await runHexo(
      `list source/_posts --format "%p|%s|%TY-%Tm-%Td %TH:%TM" 2>/dev/null | head -n ${parsed.limit + 1}`,
      15_000
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `hexo_list failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`
      );
    }
    const lines = result.stdout.split("\n").filter(Boolean);
    const rows: string[] = [];
    for (const line of lines) {
      const [path, size, mtime] = line.split("|");
      if (!path) continue;
      const filename = path.split("/").pop() ?? path;
      const parsed2 = parseFilename(filename);
      rows.push(
        `  ${filename.padEnd(56)} ${size.padStart(7)}  ${mtime}` +
          (parsed2 ? `  [date=${parsed2.date}, slug=${parsed2.slug}]` : "  [unrecognized]")
      );
    }
    return [
      `Recent ${rows.length} posts (from ${getServerDate()}):`,
      ...rows,
    ].join("\n");
  },
};
