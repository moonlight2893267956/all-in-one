import { z } from "zod";
import { runHexo, getServerDate, parseFilename } from "./hexo.js";

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
    "<HEXO_SOURCE_DIR>/source/_posts/ directly via `ls -lt` (sorted by " +
    "modification time, newest first). Shows filename, size, mtime, and the " +
    "parsed date prefix + slug for each. More reliable than `hexo list post` " +
    "which reads from the cached db.json.",
  inputSchema: {
    type: "object" as const,
    properties: {
      limit: { type: "number", description: "Max posts to show (1-100, default 20)" },
    },
    required: [],
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const parsed = InputSchema.parse(args);
    const hexoArgs = `list page >/dev/null 2>&1; ls -lt --time-style=long-iso source/_posts | head -n ${parsed.limit + 1}`;
    const result = await runHexo(hexoArgs, 10_000);
    if (result.exitCode !== 0) {
      throw new Error(
        `hexo_list failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`
      );
    }
    const lines = result.stdout.split("\n").filter(Boolean);
    // First line is "total <N>"; rest are entries: perms links owner group size date filename
    const entries = lines.slice(1);
    const rows: string[] = [];
    for (const line of entries) {
      const m = /^\S+\s+\S+\s+\S+\s+\S+\s+(\S+)\s+(\S+\s+\S+)\s+(\S+)$/.exec(line);
      if (!m) continue;
      const [, size, mtime, filename] = m;
      const parts = parseFilename(filename);
      rows.push(
        `  ${filename.padEnd(64)} ${size.padStart(8)}  ${mtime}` +
          (parts ? `  [date=${parts.date}, slug=${parts.slug}]` : "  [unrecognized]")
      );
    }
    return [
      `Recent ${rows.length} posts (snapshot at ${getServerDate()}):`,
      ...rows,
    ].join("\n");
  },
};
