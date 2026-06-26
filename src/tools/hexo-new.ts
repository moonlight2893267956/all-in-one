import { z } from "zod";
import { runHexo, postsDir, getServerDate, getTodayPrefix, parseFilename } from "./hexo.js";

const InputSchema = z.object({
  title: z.string().min(1).max(200).describe("Title for the new post"),
});

export const hexoNewTool = {
  name: "hexo_new",
  description:
    "Create a new blank Hexo post from the scaffold (hexo new <title>). " +
    "Returns the generated filename and path. Does NOT trigger generate. " +
    "After editing the file's content, call hexo_publish (or hexo_rebuild) to make it live.",
  inputSchema: {
    type: "object" as const,
    properties: {
      title: { type: "string", description: "Post title" },
    },
    required: ["title"],
  },
  handler: async (args: Record<string, unknown>): Promise<string> => {
    const parsed = InputSchema.parse(args);
    const safeTitle = parsed.title.replace(/'/g, "'\\''");
    const result = await runHexo(`new '${safeTitle}'`, 20_000);
    if (result.exitCode !== 0) {
      throw new Error(
        `hexo new failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`
      );
    }
    const m = /INFO\s+Created:\s+(.+)$/m.exec(result.stdout);
    const path = m ? m[1].trim() : `${postsDir()}/(unknown)`;
    const filename = path.split("/").pop() ?? path;
    const parts = parseFilename(filename);
    return [
      `Created: ${path}`,
      `Filename: ${filename}`,
      parts ? `Parsed: date=${parts.date}, slug=${parts.slug}` : "Parsed: (unrecognized filename)",
      `Now: ${getServerDate()}  (today prefix: ${getTodayPrefix()})`,
      "Next: edit the file's body, then call hexo_publish (or hexo_rebuild) to publish.",
    ].join("\n");
  },
};
